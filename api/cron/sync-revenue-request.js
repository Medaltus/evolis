/**
 * api/cron/sync-revenue-request.js
 * Step 1 of 2 — requests TWO flat file reports from Amazon SP-API:
 *   - one for the prior full month
 *   - one for the current month (1st through now)
 *
 * Stores both reportIds in the _meta tab of the revenue sheet.
 * sync-revenue-process.js picks up 15 minutes later.
 *
 * Runs at 5:00 UTC daily.
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

  // ── Build date ranges — one per month, each max 30 days ───────────────────
  const prior    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pYear    = prior.getFullYear();
  const pMonth   = pad(prior.getMonth() + 1);
  const pLastDay = new Date(pYear, prior.getMonth() + 1, 0).getDate();

  const cYear  = now.getFullYear();
  const cMonth = pad(now.getMonth() + 1);

  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  const ranges = [
    {
      month: `${pYear}-${pMonth}`,
      start: `${pYear}-${pMonth}-01T00:00:00Z`,
      end:   `${pYear}-${pMonth}-${pad(pLastDay)}T23:59:59Z`,
    },
    {
      month: `${cYear}-${cMonth}`,
      start: `${cYear}-${cMonth}-01T00:00:00Z`,
      end:   safeBefore,
    },
  ];

  console.log(`[sync-revenue-request] requesting reports for ${ranges.map(r => r.month).join(', ')}`);

  // ── Request one report per month ───────────────────────────────────────────
  const reportIds = {};

  for (const range of ranges) {
    try {
      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  range.start,
        dataEndTime:    range.end,
      });
      reportIds[range.month] = createResp.reportId;
      console.log(`[sync-revenue-request] ${range.month} report requested: ${createResp.reportId}`);
    } catch (err) {
      console.error(`[sync-revenue-request] failed to request report for ${range.month}:`, err.message);
      return res.status(500).json({ error: `Failed to request report for ${range.month}`, detail: err.message });
    }
  }

  // ── Write metadata to _meta tab ────────────────────────────────────────────
  try {
    const token   = await ensureTab(sheets.revenue, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.revenue, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }

    // Store each month's reportId separately
    for (const [month, reportId] of Object.entries(reportIds)) {
      metaMap[`report_id_${month}`] = reportId;
    }
    metaMap['report_status']  = 'REQUESTED';
    metaMap['target_months']  = Object.keys(reportIds).join(',');
    metaMap['last_requested_at'] = ts;

    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.revenue, META_TAB, META_HEADERS, metaRows, token);
    console.log(`[sync-revenue-request] meta written`);
  } catch (err) {
    console.error('[sync-revenue-request] failed to write meta:', err.message);
  }

  res.status(200).json({ reportIds, targetMonths: Object.keys(reportIds) });
};
