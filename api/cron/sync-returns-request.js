/**
 * api/cron/sync-returns-request.js
 * Step 1 of 2 — fires the FBA Customer Returns flat-file report request and
 * stores the reportId in this sheet's own `_meta` tab.
 *
 * Lives in a DEDICATED spreadsheet (env var SHEET_RETURNS), not a tab bolted
 * onto the sync-orders workbook — so _meta here is fully isolated, no key
 * prefixing needed the way a shared tab would require.
 *
 * Report type: GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA
 *   Amazon's order-status field (used by sync-orders) never reflects a
 *   post-shipment return — an order that gets returned two weeks after
 *   delivery still just says "Shipped" forever. Returns only exist in this
 *   separate feed, keyed by return-date rather than order-date, which is
 *   why it needs its own request/process pair instead of piggybacking on
 *   sync-orders.
 *
 * Why request/process split (same reasoning as sync-orders):
 *   This step is one API call + one sheet write — can't time out.
 *   sync-returns-process.js does the polling/downloading/upserting on its
 *   own schedule, 20 min later.
 *
 * Window: 30 days by default (wider than sync-orders' 15 — returns can be
 * reported by Amazon with more lag than the original order, and re-checking
 * a 30-day rolling window every run catches status changes on returns that
 * were still processing last run).
 *
 * Runs every 6 hours. sync-returns-process.js runs 20 min later.
 *
 * Manual / backfill:
 *   GET /api/cron/sync-returns-request?days=90            — wider window
 *   GET /api/cron/sync-returns-request?start=...&end=...  — explicit range
 *
 * REQUIRES a `returns` entry in config/sheets.js pointing at
 * process.env.SHEET_RETURNS, the same shape as the existing `orders` entry.
 * If config/sheets.js doesn't yet export `returns`, add it there first —
 * this file assumes it exists.
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                                = require('../config/sheets');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];
const DEFAULT_DAYS = 30;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const ts  = now.toISOString();

  // Same 10-minute safety buffer sync-orders-request and the revenue sync use —
  // Amazon won't reliably have return data finalized for the last few minutes yet.
  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  let start, end;
  if (req.query.start && req.query.end) {
    start = req.query.start;
    end   = req.query.end;
  } else {
    const days = parseInt(req.query.days, 10) || DEFAULT_DAYS;
    start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
    end   = safeBefore;
  }

  console.log(`[sync-returns-request] requesting report: ${start} → ${end}`);

  // ── Request the report (fire-and-store, no polling here) ──────────────────
  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime:  start,
      dataEndTime:    end,
    });
    reportId = createResp.reportId;
    console.log(`[sync-returns-request] report requested: ${reportId}`);
  } catch (err) {
    console.error('[sync-returns-request] failed to request report:', err.message);
    return res.status(500).json({ error: 'Failed to request report', detail: err.message });
  }

  // ── Store reportId + range in this sheet's own _meta ───────────────────────
  try {
    const token   = await ensureTab(sheets.returns, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.returns, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }

    metaMap['report_id']         = reportId;
    metaMap['report_start']      = start;
    metaMap['report_end']        = end;
    metaMap['report_status']     = 'REQUESTED';
    metaMap['last_requested_at'] = ts;

    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.returns, META_TAB, META_HEADERS, metaRows, token);
    console.log('[sync-returns-request] meta written');
  } catch (err) {
    console.error('[sync-returns-request] failed to write meta:', err.message);
    return res.status(500).json({ error: 'Failed to write meta', detail: err.message });
  }

  res.status(200).json({ reportId, start, end });
};
