/**
 * api/cron/sync-advertising-queue.js
 * ONE-TIME SETUP — seeds the backfill queue in _meta with 18 months of history.
 * Run once, then the process step advances through the queue automatically.
 *
 * Usage (run once after deploying):
 *   curl https://evolis-xi.vercel.app/api/cron/sync-advertising-queue \
 *     -H "Authorization: Bearer r29fu&7S;gq@\$bOw"
 *
 * Then trigger the first request manually:
 *   curl https://evolis-xi.vercel.app/api/cron/sync-advertising-request \
 *     -H "Authorization: Bearer r29fu&7S;gq@\$bOw"
 *
 * After that, sync-advertising-process will auto-advance the queue every 15 min
 * via the temporary cron until all months are done. Remove the 15-min cron from
 * vercel.json once ad_backfill_queue is empty.
 *
 * Queue covers: 18 months back from current month (oldest first so most recent
 * data lands last and overwrites correctly).
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');

const SHEET_AD_SUMMARY = process.env.SHEET_ADVERTISING;
const META_TAB         = '_meta';
const META_HEADERS     = ['KEY', 'VALUE', 'UPDATED_AT'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now    = new Date().toISOString();
  const months = buildQueue(18);

  try {
    const token2   = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    const existing = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const metaMap  = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });

    // Store queue as comma-separated YYYY-MM list, oldest first
    metaMap['ad_backfill_queue']    = ['ad_backfill_queue',    months.join(','), now];
    metaMap['ad_backfill_total']    = ['ad_backfill_total',    String(months.length), now];
    metaMap['ad_backfill_complete'] = ['ad_backfill_complete', 'false', now];

    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);

    return res.status(200).json({
      queued:  months.length,
      months,
      note:    'Now run sync-advertising-request to kick off the first month. Process will auto-advance.',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function buildQueue(n) {
  const months = [];
  const now    = new Date();
  // Start from n months ago, oldest first
  for (let i = n; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}
