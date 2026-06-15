/**
 * api/cron/sync-revenue-request.js
 * Step 1 of 2 — requests the flat file report from Amazon SP-API
 * and stores the reportId + metadata in the _meta tab of the revenue sheet.
 *
 * Runs at 5:00 UTC daily.
 * sync-revenue-process.js picks up 15 minutes later.
 *
 * _meta tab columns: KEY | VALUE | UPDATED_AT
 * Rows written:
 *   report_id        | 1234567890     | 2026-06-15T05:00:00Z
 *   report_status    | REQUESTED      | 2026-06-15T05:00:00Z
 *   target_months    | 2026-05,2026-06| 2026-06-15T05:00:00Z
 *   start            | 2026-05-01T... | 2026-06-15T05:00:00Z
 *   end              | 2026-06-15T... | 2026-06-15T05:00:00Z
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = now.toISOString();

  // ── Determine target months ────────────────────────────────────────────────
  const prior  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pYear  = prior.getFullYear();
  const pMonth = pad(prior.getMonth() + 1);
  const cYear  = now.getFullYear();
  const cMonth = pad(now.getMonth() + 1);

  const targetMonths = [`${pYear}-${pMonth}`, `${cYear}-${cMonth}`];
  const start        = `${pYear}-${pMonth}-01T00:00:00Z`;
  const end          = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  console.log(`[sync-revenue-request] targets=${targetMonths.join(', ')} start=${start} end=${end}`);

  // ── Request flat file report ───────────────────────────────────────────────
  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime:  start,
      dataEndTime:    end,
    });
    reportId = createResp.reportId;
    console.log(`[sync-revenue-request] report requested: ${reportId}`);
  } catch (err) {
    console.error('[sync-revenue-request] failed to request report:', err.message);
    return res.status(500).json({ error: 'Failed to request report', detail: err.message });
  }

  // ── Write reportId + metadata to _meta tab ─────────────────────────────────
  try {
    const token = await ensureTab(sheets.revenue, META_TAB, META_HEADERS);

    // Read existing meta rows, update matching keys, add new ones
    const rawMeta = await readRows(sheets.revenue, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }

    // Set our keys
    metaMap['report_id']     = reportId;
    metaMap['report_status'] = 'REQUESTED';
    metaMap['target_months'] = targetMonths.join(',');
    metaMap['start']         = start;
    metaMap['end']           = end;

    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.revenue, META_TAB, META_HEADERS, metaRows, token);

    console.log(`[sync-revenue-request] meta written — reportId=${reportId}`);
  } catch (err) {
    console.error('[sync-revenue-request] failed to write meta:', err.message);
    // Don't fail the whole request — reportId was still created
  }

  res.status(200).json({ reportId, targetMonths, start, end });
};
