/**
 * api/cron/sync-sqp-request.js
 * Step 1 of 2 — requests the Brand Analytics SEARCH QUERY PERFORMANCE
 * report from SP-API for last full month, and stores the reportId in the
 * _meta tab of sheets.searchQueryPerformance.
 *
 * Mirrors sync-business-report-request.js's _meta pattern (KEY/VALUE/
 * UPDATED_AT, report_id_<month>, report_status, last_requested_at), with
 * one real difference: Business Report requests both prior+current month
 * EVERY day unconditionally. This one only ever targets ONE month (last
 * full month) and explicitly SKIPS re-requesting if that month's reportId
 * already exists — because unlike daily business reports, this only needs
 * to succeed once per month, and it runs on a schedule that retries daily
 * across days 8-20 (see vercel.json) specifically because Brand Analytics
 * data for the prior month isn't finalized until partway through the
 * current month. Re-requesting every day it's already succeeded would
 * just waste SP-API quota for no reason.
 *
 * NOTE: sheets.searchQueryPerformance needs to be ADDED to config/sheets.js
 * — I don't have that file's contents, so I can't add it myself. Point it
 * at the SHEET_SEARCH_QUERY_PERFORMANCE sheet ID
 * (1naEu4kADM0PBjM-lntqUU8IbI7s5ENhRmc72Q7_pVrc), same pattern as the
 * existing sheets.businessReport entry.
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// TODO: confirm the correct brand tab name for Évolis in sheets.products
// (matches getBrandAsinMap's usage in sync-business-report-process.js,
// which reads brand.tabName from config/brands.js — using a plain string
// here since I don't have that brands config file to import from).
const BRAND_TAB_NAME = 'evolis';

// Amazon's own error (confirmed via a real request): the 'asin' report
// option has a 200-CHARACTER limit on the joined string, not a count limit
// — 19 real ASINs (10 chars each + spaces) already exceeds it at 208
// chars. Batches into groups that fit under that limit, so this keeps
// working correctly as the catalog grows rather than silently breaking
// again at some future ASIN count.
function chunkAsinsByCharLimit(asins, maxLen = 200) {
  const batches = [];
  let current = [];
  let currentLen = 0;
  for (const asin of asins) {
    const addedLen = current.length ? asin.length + 1 : asin.length; // +1 for the joining space
    if (currentLen + addedLen > maxLen && current.length) {
      batches.push(current);
      current = [asin];
      currentLen = asin.length;
    } else {
      current.push(asin);
      currentLen += addedLen;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

// Pulling the ASIN list from Products Cache — same source and same
// "latest sync date only" logic as getBrandAsinMap in
// sync-business-report-process.js — rather than hardcoding it, so this
// stays correct as the catalog changes.
async function getBrandAsins() {
  const rows = await readRows(sheets.products, BRAND_TAB_NAME);
  if (!rows || !rows.length) return [];
  const latestDate = rows.reduce((max, r) => ((r['date'] || '') > max ? r['date'] : max), '');
  const latestRows = latestDate ? rows.filter(r => r['date'] === latestDate) : rows;
  const asins = new Set();
  latestRows.forEach(r => {
    const asin = (r['asin'] || '').trim().toUpperCase();
    if (asin) asins.add(asin);
  });
  return Array.from(asins);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = now.toISOString();

  // ── Last FULL calendar month ────────────────────────────────────────────
  const prior    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pYear    = prior.getFullYear();
  const pMonth   = pad(prior.getMonth() + 1);
  const pLastDay = new Date(pYear, prior.getMonth() + 1, 0).getDate();
  const targetMonth = `${pYear}-${pMonth}`;
  const dataStartTime = `${pYear}-${pMonth}-01T00:00:00Z`;
  const dataEndTime   = `${pYear}-${pMonth}-${pad(pLastDay)}T23:59:59Z`;

  console.log(`[sync-sqp-request] target month: ${targetMonth} (${dataStartTime} → ${dataEndTime})`);

  // ── Skip if already requested this month ────────────────────────────────
  let metaMap = {};
  try {
    const rawMeta = await readRows(sheets.searchQueryPerformance, META_TAB);
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
  } catch (err) {
    console.warn('[sync-sqp-request] could not read _meta (probably first-ever run, tab does not exist yet):', err.message);
  }

  if (metaMap[`report_batch_count_${targetMonth}`] && !req.query.force) {
    console.log(`[sync-sqp-request] ${targetMonth} already requested (${metaMap[`report_batch_count_${targetMonth}`]} batch(es), status ${metaMap['report_status'] || 'unknown'}) — skipping. Pass ?force=true to request fresh ones anyway (e.g. after a FATAL report).`);
    return res.status(200).json({ ok: true, skipped: true, targetMonth, batchCount: metaMap[`report_batch_count_${targetMonth}`] });
  }

  // ── Request the report — one per ASIN batch (200-char asin limit) ───────
  const asins = await getBrandAsins();
  if (!asins.length) {
    console.error('[sync-sqp-request] no ASINs found in Products Cache — check BRAND_TAB_NAME / sheets.products');
    return res.status(500).json({ error: 'No ASINs found in Products Cache — cannot request report without the required asin option' });
  }
  const batches = chunkAsinsByCharLimit(asins);
  console.log(`[sync-sqp-request] ${targetMonth} — requesting for ${asins.length} ASINs across ${batches.length} batch(es) (200-char limit on the joined asin string)`);

  const reportIds = [];
  for (let i = 0; i < batches.length; i++) {
    try {
      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime,
        dataEndTime,
        reportOptions: { reportPeriod: 'MONTH', asin: batches[i].join(' ') },
      });

      if (!createResp || !createResp.reportId) {
        console.error(`[sync-sqp-request] ${targetMonth} batch ${i} — no reportId in response:`, JSON.stringify(createResp));
        return res.status(500).json({ error: `Amazon returned no reportId for ${targetMonth} batch ${i}`, detail: createResp, targetMonth, batchIndex: i, batchAsins: batches[i] });
      }
      reportIds.push(createResp.reportId);
      console.log(`[sync-sqp-request] ${targetMonth} batch ${i} (${batches[i].length} ASINs) requested: ${createResp.reportId}`);
    } catch (err) {
      console.error(`[sync-sqp-request] failed to request ${targetMonth} batch ${i}:`, err.message);
      return res.status(500).json({ error: `Failed to request report for ${targetMonth} batch ${i}`, detail: err.message });
    }
  }
  // ── Write metadata ───────────────────────────────────────────────────────
  try {
    const token = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
    reportIds.forEach((id, i) => { metaMap[`report_id_${targetMonth}_b${i}`] = id; });
    metaMap[`report_batch_count_${targetMonth}`] = String(reportIds.length);
    metaMap['report_status']     = 'REQUESTED';
    metaMap['target_month']      = targetMonth;
    metaMap['last_requested_at'] = ts;

    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, token);
    console.log(`[sync-sqp-request] meta written for ${targetMonth} — ${reportIds.length} batch(es)`);
  } catch (err) {
    console.error('[sync-sqp-request] failed to write meta:', err.message);
    // Reports were successfully requested with Amazon at this point — don't
    // waste them, but make the sheet-write failure visible rather than
    // returning a plain 200 that looks fully successful.
    return res.status(207).json({
      warning: 'Reports requested successfully, but failed to write _meta — check sheets.searchQueryPerformance / config/sheets.js',
      metaWriteError: err.message,
      targetMonth,
      reportIds,
    });
  }

  res.status(200).json({ ok: true, targetMonth, reportIds, batchCount: reportIds.length });
};
