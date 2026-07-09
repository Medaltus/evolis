/**
 * api/cron/sync-orders-request.js
 * Step 1 of 2 — requests a single flat file report covering a rolling
 * 15-day window (all brands) and stores the reportId + range in the
 * orders sheet's _meta tab. sync-orders-process.js picks it up 25 min later.
 *
 * Why a 15-day window instead of a narrow rolling window:
 *   Order status (pending → shipped/cancelled) can take days to settle.
 *   Re-pulling the same 30 days every run means every recent order gets
 *   checked against Amazon's current data on every run, not just once when
 *   it first appears — sync-orders-process.js overwrites a row when Amazon's
 *   data for it has actually changed. This is what replaces the separate
 *   reconcile-orders cron: there's no longer a case where an order sits in
 *   the sheet as "pending" forever because nothing ever re-checked it.
 *
 * Why split into request/process at all:
 *   This step does almost nothing — one API call, one sheet write — so it
 *   can't time out. All the slow work (polling for the report, downloading,
 *   pricing every new/changed line item) lives in sync-orders-process.js,
 *   which runs on its own schedule with room to actually finish.
 *
 * Runs every 4 hours, on the hour. sync-orders-process.js runs 25 min later.
 *
 * Manual / backfill:
 *   GET /api/cron/sync-orders-request?days=30            — wider window
 *   GET /api/cron/sync-orders-request?start=...&end=...  — explicit range
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');

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

  // Amazon won't reliably have data for the last few minutes yet — same
  // 10-minute safety buffer the revenue sync uses.
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

  console.log(`[sync-orders-request] requesting report: ${start} → ${end}`);

  // ── Request the report (fire-and-store, no polling here) ──────────────────
  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime:  start,
      dataEndTime:    end,
    });
    reportId = createResp.reportId;
    console.log(`[sync-orders-request] report requested: ${reportId}`);
  } catch (err) {
    console.error('[sync-orders-request] failed to request report:', err.message);
    return res.status(500).json({ error: 'Failed to request report', detail: err.message });
  }

  // ── Store reportId + range in _meta for the process step to pick up ───────
  try {
    const token   = await ensureTab(sheets.orders, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.orders, META_TAB);
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
    await replaceRows(sheets.orders, META_TAB, META_HEADERS, metaRows, token);
    console.log('[sync-orders-request] meta written');
  } catch (err) {
    console.error('[sync-orders-request] failed to write meta:', err.message);
    return res.status(500).json({ error: 'Failed to write meta', detail: err.message });
  }

  res.status(200).json({ reportId, start, end });
};
