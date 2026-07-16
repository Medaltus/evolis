/**
 * api/cron/sync-sqp-process.js
 * Step 2 of 2 — reads the reportId stored by sync-sqp-request.js, polls
 * until DONE, downloads, and writes the full report to the
 * search_query_performance tab of sheets.searchQueryPerformance.
 *
 * Runs twice daily across days 8-20 (see vercel.json) — Brand Analytics
 * monthly reports can take longer to generate than the daily Business
 * Report, so a single invocation's poll window (mirrors
 * sync-business-report-process.js: 60s timeout, 4s interval) may not
 * always catch DONE on the first check. If it times out, this just exits
 * without marking anything PROCESSED, so the next scheduled run picks up
 * the same still-pending reportId and checks again — no state is lost
 * between runs.
 *
 * Debug mode — logs the raw TSV header row instead of writing to the
 * sheet, so real Amazon column names can be confirmed before trusting the
 * parse. Same defensive pattern as sync-business-report-process.js
 * (?debug=true) — doubly worth using here since this is a brand-new report
 * type; the column names below are my best documentation-based guess, not
 * yet verified against a real response:
 *   GET /api/cron/sync-sqp-process?debug=true
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Force re-process even if already marked PROCESSED:
 *   GET /api/cron/sync-sqp-process?force=true
 */

const zlib                                 = require('zlib');
const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];
const DATA_TAB      = 'search_query_performance';

// Same poll budget as sync-business-report-process.js — if this SPECIFIC
// invocation's window isn't enough, the next scheduled run (see vercel.json)
// tries again; nothing is lost by giving up after this timeout.
const REPORT_POLL_TIMEOUT_MS  = 60_000;
const REPORT_POLL_INTERVAL_MS = 4_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const ts  = now.toISOString();
  const debugMode = req.query.debug === 'true';

  // ── Read _meta to find the pending reportId ─────────────────────────────
  // A missing _meta tab (Sheets API returns "Unable to parse range") means
  // sync-sqp-request.js hasn't successfully run yet on this sheet — that's
  // an expected state on a brand-new sheet, not a real failure, so this
  // reads as "nothing to process" rather than a 500.
  let metaMap = {};
  try {
    const rawMeta = await readRows(sheets.searchQueryPerformance, META_TAB);
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
  } catch (err) {
    const tabMissing = /unable to parse range/i.test(err.message) || /Sheets GET failed \(400\)/i.test(err.message);
    if (tabMissing) {
      console.log('[sync-sqp-process] _meta tab does not exist yet — sync-sqp-request has not successfully run on this sheet yet');
      return res.status(200).json({ ok: true, message: '_meta tab does not exist yet — run sync-sqp-request first', detail: err.message });
    }
    console.error('[sync-sqp-process] failed to read _meta:', err.message);
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  if (metaMap['report_status'] === 'PROCESSED' && !req.query.force && !debugMode) {
    return res.status(200).json({ message: 'Already processed. Pass ?force=true to re-run anyway.', meta: metaMap });
  }

  const targetMonth = metaMap['target_month'];
  const batchCount = targetMonth ? parseInt(metaMap[`report_batch_count_${targetMonth}`] || '0', 10) : 0;
  if (!targetMonth || !batchCount) {
    return res.status(400).json({ error: 'No pending target_month/batches in _meta — did sync-sqp-request run and succeed?', meta: metaMap });
  }
  const batchReportIds = [];
  for (let i = 0; i < batchCount; i++) {
    const id = metaMap[`report_id_${targetMonth}_b${i}`];
    if (!id) return res.status(400).json({ error: `Missing report_id_${targetMonth}_b${i} in _meta — _meta may be corrupted, try re-running sync-sqp-request with ?force=true` });
    batchReportIds.push(id);
  }
  console.log(`[sync-sqp-process] ${targetMonth} — ${batchCount} batch(es): ${batchReportIds.join(', ')}`);

  // ── Poll + download every batch (re-checked every invocation — cheap,
  // and avoids needing to persist downloaded content between runs) ───────
  let allEntries = [];
  const batchResults = [];
  for (let i = 0; i < batchReportIds.length; i++) {
    const reportId = batchReportIds[i];
    const result = await pollReportUntilDone(reportId, targetMonth, i);
    batchResults.push({ batchIndex: i, reportId, status: result.status });

    if (result.status === 'FATAL' || result.status === 'CANCELLED') {
      const errorDocumentContent = await tryDownloadDocument(result.statusBody?.reportDocumentId);
      try {
        const token = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
        metaMap['report_status'] = result.status;
        const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
        await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, token);
      } catch (err) { /* best-effort */ }
      return res.status(500).json({ error: `Report ${result.status}`, targetMonth, batchIndex: i, reportId, amazonResponse: result.statusBody, errorDocumentContent });
    }

    if (result.status !== 'DONE') {
      // Still IN_QUEUE/IN_PROGRESS after this invocation's poll window —
      // stop here, next scheduled run re-checks ALL batches (including any
      // already DONE ones, which will just resolve quickly this time).
      console.warn(`[sync-sqp-process] ${targetMonth} batch ${i} not ready yet within this invocation's poll window — will check again next scheduled run`);
      return res.status(200).json({ ok: true, notReadyYet: true, targetMonth, batchResults, lastKnownStatus: result.status });
    }

    const jsonText = await downloadReportJson(result.documentId);
    if (jsonText === null) {
      return res.status(500).json({ error: 'Failed to download report document', targetMonth, batchIndex: i, reportId });
    }
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch (e) { parsed = {}; }
    allEntries = allEntries.concat(parsed.dataByAsin || []);
  }

  console.log(`[sync-sqp-process] ${targetMonth} — all ${batchCount} batch(es) DONE, ${allEntries.length} total entries`);
  const { headers: dataHeaders, rows: dataRows } = flattenEntries(allEntries);

  if (debugMode) {
    console.log(`[sync-sqp-process][DEBUG] ${targetMonth} — column headers: ${dataHeaders.join(' | ')}`);
    console.log(`[sync-sqp-process][DEBUG] ${targetMonth} — row count: ${dataRows.length}`);
    console.log(`[sync-sqp-process][DEBUG] ${targetMonth} — first row: ${JSON.stringify(dataRows[0] || [])}`);
    return res.status(200).json({
      debug: true,
      targetMonth,
      batchCount,
      columnHeaders: dataHeaders,
      rowCount: dataRows.length,
      firstRow: dataRows[0] || [],
    });
  }

  // ── Write to sheet ───────────────────────────────────────────────────────
  try {
    const taggedHeaders = ['MONTH', ...dataHeaders];
    const existingRows  = await readRows(sheets.searchQueryPerformance, DATA_TAB).catch(() => []);
    // Idempotent re-run safety: drop any prior write of THIS month, keep every other month already in the tab.
    const otherMonthsRows = (existingRows || [])
      .filter(r => r['MONTH'] !== targetMonth)
      .map(r => taggedHeaders.map(h => r[h] ?? ''));
    const newRows = dataRows.map(r => [targetMonth, ...r]);

    const token = await ensureTab(sheets.searchQueryPerformance, DATA_TAB, taggedHeaders);
    await replaceRows(sheets.searchQueryPerformance, DATA_TAB, taggedHeaders, [...otherMonthsRows, ...newRows], token);
    console.log(`[sync-sqp-process] ${targetMonth} — wrote ${newRows.length} rows`);

    // Mark processed
    const metaToken = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
    metaMap['report_status']     = 'PROCESSED';
    metaMap['last_processed_at'] = ts;
    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, metaToken);

    res.status(200).json({ ok: true, targetMonth, rowsWritten: newRows.length });
  } catch (err) {
    console.error(`[sync-sqp-process] failed to write ${targetMonth} to sheet:`, err.message);
    res.status(500).json({ error: 'Failed to write report to sheet', detail: err.message, targetMonth });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Polls one batch's reportId until DONE/FATAL/CANCELLED, or gives up after
// REPORT_POLL_TIMEOUT_MS (same budget as sync-business-report-process.js).
async function pollReportUntilDone(reportId, targetMonth, batchIndex) {
  let statusBody = null;
  let status = null;
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    try {
      const resp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      status = resp.processingStatus;
      statusBody = resp;
      console.log(`[sync-sqp-process] ${targetMonth} batch ${batchIndex} report ${reportId} status: ${status}`);
      if (status === 'DONE') return { status, documentId: resp.reportDocumentId, statusBody };
      if (status === 'FATAL' || status === 'CANCELLED') {
        console.error(`[sync-sqp-process] ${targetMonth} batch ${batchIndex} report ${status} — full response:`, JSON.stringify(resp));
        return { status, documentId: null, statusBody };
      }
    } catch (err) {
      console.warn(`[sync-sqp-process] batch ${batchIndex} poll error (will retry): ${err.message}`);
    }
  }
  return { status: status || 'TIMEOUT', documentId: null, statusBody };
}

// Downloads and decompresses a report document, returning null on any
// failure rather than throwing — callers decide how to handle that.
async function downloadReportJson(documentId) {
  if (!documentId) return null;
  try {
    const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    const fileResp = await fetch(docResp.url); // pre-signed S3 url — no SP-API auth headers here
    if (!fileResp.ok) return null;
    const buffer = Buffer.from(await fileResp.arrayBuffer());
    return await new Promise((resolve) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) resolve(buffer.toString('utf8'));
        else resolve(result.toString('utf8'));
      });
    });
  } catch (err) {
    console.warn('[sync-sqp-process] downloadReportJson failed:', err.message);
    return null;
  }
}

// Best-effort download used only for FATAL error-detail documents — never
// throws, returns null if anything goes wrong (this is diagnostic-only).
async function tryDownloadDocument(documentId) {
  if (!documentId) return null;
  const content = await downloadReportJson(documentId);
  if (content) console.error('[sync-sqp-process] FATAL error document content:', content.slice(0, 2000));
  return content;
}

// Flattens an ALREADY-MERGED array of dataByAsin entries (across every
// batch for this month) into flat rows. "Full report" per the original
// ask — every field Amazon returns is included, not a trimmed subset.
// Structure confirmed against a real successful response (2026-07-16):
// { reportSpecification, dataByAsin: [ { startDate, endDate, asin,
// searchQueryData: {...}, impressionData: {...}, clickData: {...},
// cartAddData: {...}, purchaseData: {...} } ] }.
//
// Several fields (asinCartAddShare, totalMedianCartAddPrice, etc.) come
// back as null when there's zero volume for that metric — .amount/
// .currencyCode access below is null-safe for exactly that reason.
const SQP_HEADERS = [
  'ASIN', 'START_DATE', 'END_DATE',
  'SEARCH_QUERY', 'SEARCH_QUERY_SCORE', 'SEARCH_QUERY_VOLUME',
  'TOTAL_QUERY_IMPRESSION_COUNT', 'ASIN_IMPRESSION_COUNT', 'ASIN_IMPRESSION_SHARE',
  'TOTAL_CLICK_COUNT', 'TOTAL_CLICK_RATE', 'ASIN_CLICK_COUNT', 'ASIN_CLICK_SHARE',
  'TOTAL_MEDIAN_CLICK_PRICE', 'ASIN_MEDIAN_CLICK_PRICE',
  'TOTAL_SAME_DAY_SHIPPING_CLICK_COUNT', 'TOTAL_ONE_DAY_SHIPPING_CLICK_COUNT', 'TOTAL_TWO_DAY_SHIPPING_CLICK_COUNT',
  'TOTAL_CART_ADD_COUNT', 'TOTAL_CART_ADD_RATE', 'ASIN_CART_ADD_COUNT', 'ASIN_CART_ADD_SHARE',
  'TOTAL_MEDIAN_CART_ADD_PRICE', 'ASIN_MEDIAN_CART_ADD_PRICE',
  'TOTAL_SAME_DAY_SHIPPING_CART_ADD_COUNT', 'TOTAL_ONE_DAY_SHIPPING_CART_ADD_COUNT', 'TOTAL_TWO_DAY_SHIPPING_CART_ADD_COUNT',
  'TOTAL_PURCHASE_COUNT', 'TOTAL_PURCHASE_RATE', 'ASIN_PURCHASE_COUNT', 'ASIN_PURCHASE_SHARE',
  'TOTAL_MEDIAN_PURCHASE_PRICE', 'ASIN_MEDIAN_PURCHASE_PRICE',
  'TOTAL_SAME_DAY_SHIPPING_PURCHASE_COUNT', 'TOTAL_ONE_DAY_SHIPPING_PURCHASE_COUNT', 'TOTAL_TWO_DAY_SHIPPING_PURCHASE_COUNT',
];

function flattenEntries(entries) {
  const price = p => (p && p.amount != null) ? p.amount : '';

  const rows = (entries || []).map(e => {
    const sq = e.searchQueryData || {};
    const imp = e.impressionData || {};
    const clk = e.clickData || {};
    const cart = e.cartAddData || {};
    const pur = e.purchaseData || {};
    return [
      e.asin ?? '', e.startDate ?? '', e.endDate ?? '',
      sq.searchQuery ?? '', sq.searchQueryScore ?? '', sq.searchQueryVolume ?? '',
      imp.totalQueryImpressionCount ?? '', imp.asinImpressionCount ?? '', imp.asinImpressionShare ?? '',
      clk.totalClickCount ?? '', clk.totalClickRate ?? '', clk.asinClickCount ?? '', clk.asinClickShare ?? '',
      price(clk.totalMedianClickPrice), price(clk.asinMedianClickPrice),
      clk.totalSameDayShippingClickCount ?? '', clk.totalOneDayShippingClickCount ?? '', clk.totalTwoDayShippingClickCount ?? '',
      cart.totalCartAddCount ?? '', cart.totalCartAddRate ?? '', cart.asinCartAddCount ?? '', cart.asinCartAddShare ?? '',
      price(cart.totalMedianCartAddPrice), price(cart.asinMedianCartAddPrice),
      cart.totalSameDayShippingCartAddCount ?? '', cart.totalOneDayShippingCartAddCount ?? '', cart.totalTwoDayShippingCartAddCount ?? '',
      pur.totalPurchaseCount ?? '', pur.totalPurchaseRate ?? '', pur.asinPurchaseCount ?? '', pur.asinPurchaseShare ?? '',
      price(pur.totalMedianPurchasePrice), price(pur.asinMedianPurchasePrice),
      pur.totalSameDayShippingPurchaseCount ?? '', pur.totalOneDayShippingPurchaseCount ?? '', pur.totalTwoDayShippingPurchaseCount ?? '',
    ];
  });

  return { headers: SQP_HEADERS, rows };
}
