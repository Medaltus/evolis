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
  const reportId    = targetMonth ? metaMap[`report_id_${targetMonth}`] : null;
  if (!targetMonth || !reportId) {
    return res.status(400).json({ error: 'No pending target_month/reportId in _meta — did sync-sqp-request run and succeed?', meta: metaMap });
  }

  // ── Poll until DONE ──────────────────────────────────────────────────────
  let documentId = null;
  let finalStatus = null;
  let finalStatusBody = null;
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    try {
      const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      finalStatus = statusResp.processingStatus;
      finalStatusBody = statusResp;
      console.log(`[sync-sqp-process] ${targetMonth} report ${reportId} status: ${finalStatus}`);

      if (finalStatus === 'DONE') {
        documentId = statusResp.reportDocumentId;
        break;
      }
      if (finalStatus === 'FATAL' || finalStatus === 'CANCELLED') {
        console.error(`[sync-sqp-process] ${targetMonth} report ${finalStatus} — full response:`, JSON.stringify(statusResp));
        break;
      }
    } catch (err) {
      console.warn(`[sync-sqp-process] poll error (will retry): ${err.message}`);
    }
  }

  if (finalStatus === 'FATAL' || finalStatus === 'CANCELLED') {
    // Amazon sometimes still attaches a reportDocumentId even on FATAL —
    // when it does, that document is usually an error-detail explanation
    // of the actual failure, not the data report. Worth reading before
    // giving up, since "FATAL" alone tells us nothing actionable.
    let errorDocumentContent = null;
    if (finalStatusBody?.reportDocumentId) {
      try {
        const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${finalStatusBody.reportDocumentId}`);
        const fileResp = await fetch(docResp.url);
        if (fileResp.ok) {
          const buffer = Buffer.from(await fileResp.arrayBuffer());
          errorDocumentContent = await new Promise((resolve) => {
            zlib.gunzip(buffer, (err, result) => {
              if (err) resolve(buffer.toString('utf8'));
              else resolve(result.toString('utf8'));
            });
          });
          console.error(`[sync-sqp-process] ${targetMonth} FATAL error document content:`, errorDocumentContent.slice(0, 2000));
        }
      } catch (err) {
        console.warn(`[sync-sqp-process] could not download FATAL error document:`, err.message);
      }
    }

    try {
      const token = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
      metaMap['report_status'] = finalStatus;
      const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
      await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, token);
    } catch (err) { /* best-effort — the real error already logged above */ }
    return res.status(500).json({ error: `Report ${finalStatus}`, targetMonth, reportId, amazonResponse: finalStatusBody, errorDocumentContent });
  }

  if (!documentId) {
    console.warn(`[sync-sqp-process] ${targetMonth} report not ready yet within this invocation's poll window — will check again next scheduled run`);
    return res.status(200).json({ ok: true, notReadyYet: true, targetMonth, reportId, lastKnownStatus: finalStatus });
  }

  // ── Download & decompress ───────────────────────────────────────────────
  // Confirmed via a real successful test run: this is gzipped JSON, NOT a
  // flat TSV file (that was my wrong initial assumption from documentation
  // — the real shape is { reportSpecification, dataByAsin: [...] }, one
  // entry per ASIN+search-query combination, each with nested
  // searchQueryData/impressionData/clickData/cartAddData/purchaseData
  // objects). Gzip fallback still mirrors sync-business-report-process.js's
  // defensive handling either way.
  let reportJsonText;
  try {
    const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    const fileResp = await fetch(docResp.url); // pre-signed S3 url — no SP-API auth headers here
    if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    reportJsonText = await new Promise((resolve) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) resolve(buffer.toString('utf8'));
        else resolve(result.toString('utf8'));
      });
    });
  } catch (err) {
    console.error(`[sync-sqp-process] failed to download ${targetMonth}:`, err.message);
    return res.status(500).json({ error: 'Failed to download report document', detail: err.message, targetMonth, reportId });
  }

  const { headers: dataHeaders, rows: dataRows } = flattenSqpReport(reportJsonText);

  if (debugMode) {
    console.log(`[sync-sqp-process][DEBUG] ${targetMonth} — column headers: ${dataHeaders.join(' | ')}`);
    console.log(`[sync-sqp-process][DEBUG] ${targetMonth} — row count: ${dataRows.length}`);
    console.log(`[sync-sqp-process][DEBUG] ${targetMonth} — first row: ${JSON.stringify(dataRows[0] || [])}`);
    return res.status(200).json({
      debug: true,
      targetMonth,
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

// Flattens one dataByAsin entry into a flat row. "Full report" per the
// original ask — every field Amazon returns is included, not a trimmed
// subset. Structure confirmed against a real successful response
// (2026-07-16): { reportSpecification, dataByAsin: [ { startDate, endDate,
// asin, searchQueryData: {...}, impressionData: {...}, clickData: {...},
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

function flattenSqpReport(jsonText) {
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (e) { return { headers: SQP_HEADERS, rows: [] }; }

  const entries = parsed.dataByAsin || [];
  const price = p => (p && p.amount != null) ? p.amount : '';

  const rows = entries.map(e => {
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
