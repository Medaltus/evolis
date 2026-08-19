/**
 * api/cron/sync-fbm-returns-request.js
 * Step 1 of 2 — fires the MFN (Merchant Fulfilled Network) returns
 * report request and stores the reportId in the SAME sheet as the FBA
 * returns cron (env var SHEET_RETURNS), but under NAMESPACED _meta keys
 * (fbm_report_id, fbm_report_start, etc.) so this never collides with
 * sync-returns-request.js's own un-namespaced keys sitting in the exact
 * same _meta tab.
 *
 * Report type: GET_XML_RETURNS_DATA_BY_RETURN_DATE
 *   Per Amazon's own report-type reference, this sits in the general
 *   "Returns Reports" category — separate from "Fulfillment By Amazon
 *   (FBA) Reports" where GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA (the
 *   existing FBA returns cron) lives. Confirmed via three independent
 *   pieces of evidence before building this (2026-08-18):
 *     1. Amazon's own field list for the explicitly-named
 *        GET_XML_MFN_PRIME_RETURNS_REPORT overlaps closely with this
 *        report's real schema (item_name, asin, return_reason_code,
 *        merchant_sku, in_policy, return_quantity all match).
 *     2. Two of six real sample records carried Medaltus's own "-SF"
 *        seller-fulfilled SKU suffix (SVA0003-SF, DEC0042-SF) —
 *        Medaltus's own naming convention showing up directly in the
 *        data, not just Amazon's documentation.
 *     3. Jaclyn manually confirmed all sample order IDs are genuinely
 *        absent from the existing FBA-only returns sheet (checked
 *        against Cimeosil's specific tab directly).
 *   Format is genuinely XML (confirmed from the reportType name itself
 *   and the real downloaded document) — a first for this codebase,
 *   which has only ever parsed TSV/flat-file or JSON reports before this.
 *
 * REAL DOLLAR AMOUNTS: unlike the FBA returns report (which has no
 * refund_amount field at all — a known, documented limitation), this
 * report DOES carry a real refund_amount per return. This is the field
 * "step 3" (replacing estimated-price return netting with real refund
 * data) will eventually want — but that's still a separate, future task;
 * this cron and its process counterpart only get the data into the
 * sheet, they don't change how sync-revenue-process.js nets returns yet.
 *
 * Window: 30 days by default, matching the existing FBA returns cron's
 * own default — this report supports up to 60 days per request.
 *
 * Runs every 6 hours, same cadence as the FBA returns cron.
 * sync-fbm-returns-process.js runs 20 min later.
 *
 * Manual / backfill:
 *   GET /api/cron/sync-fbm-returns-request?days=60
 *   GET /api/cron/sync-fbm-returns-request?start=...&end=...
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                                = require('../config/sheets');
const { sendCronFailureAlert }              = require('../_alerts');

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

  console.log(`[sync-fbm-returns-request] requesting report: ${start} → ${end}`);

  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_XML_RETURNS_DATA_BY_RETURN_DATE',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime:  start,
      dataEndTime:    end,
    });
    reportId = createResp.reportId;
    console.log(`[sync-fbm-returns-request] report requested: ${reportId}`);
  } catch (err) {
    console.error('[sync-fbm-returns-request] failed to request report:', err.message);
    await sendCronFailureAlert('sync-fbm-returns-request', err.message, { Stage: 'requesting report from SP-API' });
    return res.status(500).json({ error: 'Failed to request report', detail: err.message });
  }

  // ── Store reportId + range under NAMESPACED keys, same _meta tab the
  // FBA returns cron already uses — namespacing (fbm_ prefix) is the
  // whole point here, so the two crons' tracking can never collide.
  try {
    const token   = await ensureTab(sheets.returns, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.returns, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }

    metaMap['fbm_report_id']         = reportId;
    metaMap['fbm_report_start']      = start;
    metaMap['fbm_report_end']        = end;
    metaMap['fbm_report_status']     = 'REQUESTED';
    metaMap['fbm_last_requested_at'] = ts;

    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.returns, META_TAB, META_HEADERS, metaRows, token);
    console.log('[sync-fbm-returns-request] meta written');
  } catch (err) {
    console.error('[sync-fbm-returns-request] failed to write meta:', err.message);
    await sendCronFailureAlert('sync-fbm-returns-request', err.message, { Stage: 'writing reportId to _meta' });
    return res.status(500).json({ error: 'Failed to write meta', detail: err.message });
  }

  res.status(200).json({ reportId, start, end });
};
