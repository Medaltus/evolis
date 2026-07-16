/**
 * api/cron/sync-sqp-process.js
 * Step 2 of 2 — for every active brand with pending reportIds in _meta,
 * polls until DONE, downloads, merges all of that brand's batches, and
 * writes the full report to a PER-BRAND tab in
 * sheets.searchQueryPerformance (brand.tabName — same convention as
 * sync-business-report-process.js), rather than one shared tab.
 *
 * Runs twice daily across days 8-20 (see vercel.json). One brand's
 * FATAL/timeout does not block any other brand — each is wrapped in its
 * own try/catch and reported independently in the results array, same
 * defensive pattern as sync-business-report-process.js's per-brand loop.
 *
 * Debug mode — logs real column headers/row counts per brand instead of
 * writing, so real Amazon field names can be confirmed before trusting the
 * parse (this is still a brand-new report type):
 *   GET /api/cron/sync-sqp-process?debug=true
 * Force re-process a brand already marked PROCESSED:
 *   GET /api/cron/sync-sqp-process?force=true
 */

const zlib                                 = require('zlib');
const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');
const brands                               = require('../config/brands');

const HEADERS       = ['MONTH', 'ASIN', 'START_DATE', 'END_DATE',
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
  'TOTAL_SAME_DAY_SHIPPING_PURCHASE_COUNT', 'TOTAL_ONE_DAY_SHIPPING_PURCHASE_COUNT', 'TOTAL_TWO_DAY_SHIPPING_PURCHASE_COUNT'];
const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// Same poll budget as sync-business-report-process.js.
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
      return res.status(200).json({ ok: true, message: '_meta tab does not exist yet — run sync-sqp-request first' });
    }
    console.error('[sync-sqp-process] failed to read _meta:', err.message);
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  const targetMonth = metaMap['target_month'];
  if (!targetMonth) {
    return res.status(400).json({ error: 'No target_month in _meta — did sync-sqp-request run and succeed?', meta: metaMap });
  }

  const activeBrands = brands.filter(b => b.active);
  const results = [];
  const debugResults = [];

  // Time budget, not a brand-count cap — brands have varying batch counts
  // (evolis needed 2 batches, others need 1), so a fixed "N brands per run"
  // cap doesn't actually bound worst-case time the way it looks like it
  // does. Checking elapsed time before starting each brand's poll/download
  // work directly prevents the same class of unbounded-per-invocation
  // timeout sync-sqp-request.js hit — with 15 brands and up to 60s of
  // polling per batch, this file had no cap at all before this fix.
  // Confirmed 2026-07-16.
  const FUNCTION_TIME_BUDGET_MS = 4 * 60 * 1000; // leaves margin under a 5-min maxDuration
  const startTime = Date.now();

  for (const brand of activeBrands) {
    if (Date.now() - startTime > FUNCTION_TIME_BUDGET_MS) {
      console.log(`[sync-sqp-process] time budget reached — ${brand.id} and any remaining brands will be picked up by the next scheduled run`);
      results.push({ brand: brand.id, status: 'deferred-to-next-run' });
      continue;
    }
    try {
      if (metaMap[`report_status_${brand.id}`] === 'PROCESSED' && !req.query.force && !debugMode) {
        results.push({ brand: brand.id, status: 'already-processed' });
        continue;
      }

      const batchCount = parseInt(metaMap[`report_batch_count_${brand.id}_${targetMonth}`] || '0', 10);
      if (!batchCount) {
        results.push({ brand: brand.id, status: 'no-pending-request' });
        continue;
      }

      const batchReportIds = [];
      for (let i = 0; i < batchCount; i++) {
        const id = metaMap[`report_id_${brand.id}_${targetMonth}_b${i}`];
        if (!id) { results.push({ brand: brand.id, status: 'error', reason: `missing report_id_${brand.id}_${targetMonth}_b${i}` }); batchReportIds.length = 0; break; }
        batchReportIds.push(id);
      }
      if (!batchReportIds.length) continue;

      console.log(`[sync-sqp-process] ${brand.id} ${targetMonth} — ${batchCount} batch(es): ${batchReportIds.join(', ')}`);

      let allEntries = [];
      let brandStopped = false;

      for (let i = 0; i < batchReportIds.length; i++) {
        const reportId = batchReportIds[i];
        const result = await pollReportUntilDone(reportId, brand.id, targetMonth, i);

        if (result.status === 'FATAL' || result.status === 'CANCELLED') {
          const errorDocumentContent = await tryDownloadDocument(result.statusBody?.reportDocumentId);
          metaMap[`report_status_${brand.id}`] = result.status;
          results.push({ brand: brand.id, status: result.status, batchIndex: i, reportId, errorDocumentContent });
          brandStopped = true;
          break;
        }
        if (result.status !== 'DONE') {
          console.warn(`[sync-sqp-process] ${brand.id} ${targetMonth} batch ${i} not ready yet — will check again next scheduled run`);
          results.push({ brand: brand.id, status: 'not-ready-yet', batchIndex: i, lastKnownStatus: result.status });
          brandStopped = true;
          break;
        }

        const jsonText = await downloadReportJson(result.documentId);
        if (jsonText === null) {
          results.push({ brand: brand.id, status: 'error', batchIndex: i, reason: 'download failed' });
          brandStopped = true;
          break;
        }
        let parsed;
        try { parsed = JSON.parse(jsonText); } catch (e) { parsed = {}; }
        allEntries = allEntries.concat(parsed.dataByAsin || []);
      }
      if (brandStopped) continue;

      console.log(`[sync-sqp-process] ${brand.id} ${targetMonth} — all ${batchCount} batch(es) DONE, ${allEntries.length} total entries`);
      const flatRows = flattenEntries(allEntries, targetMonth);

      if (debugMode) {
        debugResults.push({
          brand: brand.id,
          columnHeaders: HEADERS,
          rowCount: flatRows.length,
          firstRow: flatRows[0] || [],
        });
        continue; // debug mode never writes, for any brand
      }

      const token = await ensureTab(sheets.searchQueryPerformance, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.searchQueryPerformance, brand.tabName).catch(() => []);
      // Idempotent re-run safety: drop any prior write of THIS month for
      // this brand, keep every other month already in this brand's tab.
      const otherMonthsRows = (existingRows || [])
        .filter(r => r['MONTH'] !== targetMonth)
        .map(r => HEADERS.map(h => r[h] ?? ''));

      await replaceRows(sheets.searchQueryPerformance, brand.tabName, HEADERS, [...otherMonthsRows, ...flatRows], token);
      console.log(`[sync-sqp-process] ${brand.id} ${targetMonth} — wrote ${flatRows.length} rows to tab "${brand.tabName}"`);

      metaMap[`report_status_${brand.id}`]     = 'PROCESSED';
      metaMap[`last_processed_at_${brand.id}`] = ts;
      results.push({ brand: brand.id, status: 'ok', rowsWritten: flatRows.length });

    } catch (err) {
      console.error(`[sync-sqp-process] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', reason: err.message });
    }
  }

  if (debugMode) {
    return res.status(200).json({ debug: true, targetMonth, results: debugResults });
  }

  // ── Persist updated per-brand statuses ───────────────────────────────────
  try {
    const metaToken = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, metaToken);
  } catch (err) {
    console.warn('[sync-sqp-process] failed to update _meta statuses:', err.message);
  }

  res.status(200).json({ ok: true, targetMonth, results });
};

// ── Helpers ───────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollReportUntilDone(reportId, brandId, targetMonth, batchIndex) {
  let statusBody = null;
  let status = null;
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    try {
      const resp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      status = resp.processingStatus;
      statusBody = resp;
      console.log(`[sync-sqp-process] ${brandId} ${targetMonth} batch ${batchIndex} report ${reportId} status: ${status}`);
      if (status === 'DONE') return { status, documentId: resp.reportDocumentId, statusBody };
      if (status === 'FATAL' || status === 'CANCELLED') {
        console.error(`[sync-sqp-process] ${brandId} ${targetMonth} batch ${batchIndex} report ${status} — full response:`, JSON.stringify(resp));
        return { status, documentId: null, statusBody };
      }
    } catch (err) {
      console.warn(`[sync-sqp-process] ${brandId} batch ${batchIndex} poll error (will retry): ${err.message}`);
    }
  }
  return { status: status || 'TIMEOUT', documentId: null, statusBody };
}

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

async function tryDownloadDocument(documentId) {
  if (!documentId) return null;
  const content = await downloadReportJson(documentId);
  if (content) console.error('[sync-sqp-process] FATAL error document content:', content.slice(0, 2000));
  return content;
}

// "Full report" per the original ask — every field Amazon returns is
// included. Structure confirmed against a real successful response
// (2026-07-16). Several fields (asinCartAddShare, totalMedianCartAddPrice,
// etc.) come back null when there's zero volume for that metric — the
// .amount access below is null-safe for exactly that reason.
function flattenEntries(entries, targetMonth) {
  const price = p => (p && p.amount != null) ? p.amount : '';

  return (entries || []).map(e => {
    const sq = e.searchQueryData || {};
    const imp = e.impressionData || {};
    const clk = e.clickData || {};
    const cart = e.cartAddData || {};
    const pur = e.purchaseData || {};
    return [
      targetMonth, e.asin ?? '', e.startDate ?? '', e.endDate ?? '',
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
}
