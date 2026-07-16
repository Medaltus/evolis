/**
 * api/cron/sync-sqp-request.js
 * Step 1 of 2 — requests Brand Analytics SEARCH QUERY PERFORMANCE reports
 * from SP-API for EVERY active brand (not just Évolis), one report per
 * ASIN batch per brand, and stores reportIds in sheets.searchQueryPerformance's
 * _meta tab, namespaced per brand.
 *
 * ASINs are grouped by brand via SKU PREFIX from the Master SKU List
 * (Product Short Name tab) — same source and same brand-matching approach
 * requested for this cron specifically, per Jaclyn 2026-07-16. This is
 * DIFFERENT from getBrandAsinMap in sync-business-report-process.js, which
 * matches by ASIN-presence-in-brand-tab because Business Report has no SKU
 * field at all — this report DOES have SKU (via the Master SKU List), so
 * prefix matching is the more direct approach here.
 *
 * NOTE: config/brands.js is assumed to export an array of brand objects
 * with at minimum { id, tabName, active }, matching exactly how
 * sync-business-report-process.js already uses it (brands.filter(b =>
 * b.active), brand.tabName). I don't have that file's contents, so brand
 * matching below falls back to brand.id.toUpperCase() as the SKU prefix
 * unless brand.skuPrefix is explicitly set — VERIFY this matches your
 * actual SKU prefixes (e.g. does 'pbj' really map to SKU prefix 'PBJ'? Does
 * 'skinside-seoul' need an explicit skuPrefix override since it's not a
 * clean prefix itself?).
 *
 * Mirrors sync-business-report-request.js's per-brand _meta pattern where
 * applicable, adapted for the fact that this only ever targets ONE month
 * (last full month) and explicitly SKIPS re-requesting per-brand if that
 * brand+month already has reportIds — because unlike daily business
 * reports, each brand only needs to succeed once per month, and this runs
 * on a schedule that retries daily across days 8-20 (see vercel.json)
 * specifically because Brand Analytics data for the prior month isn't
 * finalized until partway through the current month.
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');
const brands                               = require('../config/brands');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// Master SKU List — Product Short Name tab (gid=164358627), per
// SHEET_MASTER_SKU_LIST in the project's established sheet references.
// NOTE: sheets.masterSkuList needs to be ADDED to config/sheets.js (I don't
// have that file's current contents beyond what's already been shared) —
// point it at 1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA.
const MASTER_SKU_TAB = 'Product Short Name';

// Amazon's own error (confirmed via a real request): the 'asin' report
// option has a 200-CHARACTER limit on the joined string, not a count limit.
// Batches into groups that fit under that limit per brand.
function chunkAsinsByCharLimit(asinList, maxLen = 200) {
  const chunkBatches = [];
  let current = [];
  let currentLen = 0;
  for (const asin of asinList) {
    const addedLen = current.length ? asin.length + 1 : asin.length; // +1 for the joining space
    if (currentLen + addedLen > maxLen && current.length) {
      chunkBatches.push(current);
      current = [asin];
      currentLen = asin.length;
    } else {
      current.push(asin);
      currentLen += addedLen;
    }
  }
  if (current.length) chunkBatches.push(current);
  return chunkBatches;
}

// Amazon's own error (confirmed via a real multi-brand run): looping
// through every brand's batch requests back-to-back with no delay
// exhausted the createReport quota after the first couple of brands,
// cascading QuotaExceeded across every brand after that. Same fix as
// sync-ad-search-terms-request.js already uses for this exact problem —
// stagger every request, and retry with backoff on QuotaExceeded rather
// than giving up on the first hit. Confirmed 2026-07-16.
const STAGGER_MS = 3000;
const MAX_RETRIES = 5;
let lastRequestAt = 0;

async function requestReportWithRetry(dataStartTime, dataEndTime, asinBatch, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const waitMs = STAGGER_MS - (Date.now() - lastRequestAt);
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();

    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime,
      dataEndTime,
      reportOptions: { reportPeriod: 'MONTH', asin: asinBatch.join(' ') },
    });

    if (createResp?.reportId) {
      console.log(`[sync-sqp-request] ${label}: ${createResp.reportId}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return { reportId: createResp.reportId };
    }

    const isThrottled = createResp?.errors?.[0]?.code === 'QuotaExceeded';
    if (isThrottled && attempt < MAX_RETRIES) {
      const backoffSec = 5 * Math.pow(2, attempt - 1); // 5s, 10s, 20s, 40s
      console.warn(`[sync-sqp-request] ${label} throttled (attempt ${attempt}/${MAX_RETRIES}), retrying in ${backoffSec}s`);
      await sleep(backoffSec * 1000);
      continue;
    }

    console.error(`[sync-sqp-request] ${label} failed (attempt ${attempt}/${MAX_RETRIES}):`, JSON.stringify(createResp));
    return { error: createResp };
  }
  return { error: { errors: [{ code: 'MaxRetriesExceeded' }] } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Reads the Master SKU List once and groups ASINs by brand, matching each
// row's SKU prefix (leading letters, e.g. "EVO0001" → "EVO", "EVO0001-SF"
// → "EVO", "PBJ0027" → "PBJ") against each active brand's expected prefix.
// Returns Map<brandId, string[]> (ASINs, deduped).
async function getAsinsByBrand() {
  const rows = await readRows(sheets.masterSkuList, MASTER_SKU_TAB);
  if (!rows || !rows.length) {
    console.error('[sync-sqp-request] Master SKU List returned 0 rows — check sheets.masterSkuList / MASTER_SKU_TAB name');
    return new Map();
  }

  // Column names are a best guess (ASIN, SKU) — same defensive "log loudly
  // if this looks wrong" approach as ensureTab's header-mismatch check,
  // since I haven't seen this tab's actual header row.
  const sampleRow = rows[0];
  if (!('ASIN' in sampleRow) && !('asin' in sampleRow)) {
    console.warn('[sync-sqp-request] Master SKU List rows do not have an ASIN/asin column — actual columns:', Object.keys(sampleRow).join(', '));
  }

  const prefixToBrand = new Map(); // 'EVO' -> brand object
  brands.filter(b => b.active).forEach(b => {
    const prefix = (b.skuPrefix || b.id || '').toUpperCase();
    if (prefix) prefixToBrand.set(prefix, b);
  });

  const asinsByBrand = new Map(); // brandId -> Set<ASIN>
  let unmatchedCount = 0;

  rows.forEach(r => {
    const asin = (r['ASIN'] || r['asin'] || '').trim().toUpperCase();
    const sku  = (r['SKU']  || r['sku']  || '').trim().toUpperCase();
    if (!asin || !sku) return;

    const prefixMatch = sku.match(/^([A-Z]+)/);
    const prefix = prefixMatch ? prefixMatch[1] : '';
    const brand = prefixToBrand.get(prefix);
    if (!brand) { unmatchedCount++; return; }

    if (!asinsByBrand.has(brand.id)) asinsByBrand.set(brand.id, new Set());
    asinsByBrand.get(brand.id).add(asin);
  });

  if (unmatchedCount > 0) {
    console.warn(`[sync-sqp-request] ${unmatchedCount} Master SKU List row(s) did not match any active brand's SKU prefix — check brand.skuPrefix values against real SKUs if this seems high`);
  }

  const result = new Map();
  asinsByBrand.forEach((asinSet, brandId) => result.set(brandId, Array.from(asinSet)));
  return result;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = now.toISOString();

  // ── Last FULL calendar month (same for every brand) ─────────────────────
  const prior    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pYear    = prior.getFullYear();
  const pMonth   = pad(prior.getMonth() + 1);
  const pLastDay = new Date(pYear, prior.getMonth() + 1, 0).getDate();
  const targetMonth = `${pYear}-${pMonth}`;
  const dataStartTime = `${pYear}-${pMonth}-01T00:00:00Z`;
  const dataEndTime   = `${pYear}-${pMonth}-${pad(pLastDay)}T23:59:59Z`;

  console.log(`[sync-sqp-request] target month: ${targetMonth} (${dataStartTime} → ${dataEndTime})`);

  let metaMap = {};
  try {
    const rawMeta = await readRows(sheets.searchQueryPerformance, META_TAB);
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
  } catch (err) {
    console.warn('[sync-sqp-request] could not read _meta (probably first-ever run, tab does not exist yet):', err.message);
  }
  metaMap['target_month'] = targetMonth;

  const asinsByBrand = await getAsinsByBrand();
  const activeBrands = brands.filter(b => b.active);
  const results = [];

  for (const brand of activeBrands) {
    const brandAsins = asinsByBrand.get(brand.id) || [];
    if (!brandAsins.length) {
      console.warn(`[sync-sqp-request] ${brand.id} — no ASINs matched via SKU prefix, skipping`);
      results.push({ brand: brand.id, status: 'no-asins' });
      continue;
    }

    if (metaMap[`report_batch_count_${brand.id}_${targetMonth}`] && !req.query.force) {
      console.log(`[sync-sqp-request] ${brand.id} ${targetMonth} already requested — skipping. Pass ?force=true to request fresh ones anyway.`);
      results.push({ brand: brand.id, status: 'skipped' });
      continue;
    }

    const batches = chunkAsinsByCharLimit(brandAsins);
    console.log(`[sync-sqp-request] ${brand.id} ${targetMonth} — requesting for ${brandAsins.length} ASINs across ${batches.length} batch(es)`);

    const reportIds = [];
    let brandFailed = false;
    for (let i = 0; i < batches.length; i++) {
      try {
        const label = `${brand.id} ${targetMonth} batch ${i} (${batches[i].length} ASINs)`;
        const result = await requestReportWithRetry(dataStartTime, dataEndTime, batches[i], label);
        if (!result.reportId) {
          console.error(`[sync-sqp-request] ${brand.id} ${targetMonth} batch ${i} — no reportId after retries:`, JSON.stringify(result.error));
          results.push({ brand: brand.id, status: 'error', batchIndex: i, detail: result.error });
          brandFailed = true;
          break;
        }
        reportIds.push(result.reportId);
      } catch (err) {
        console.error(`[sync-sqp-request] ${brand.id} ${targetMonth} batch ${i} failed:`, err.message);
        results.push({ brand: brand.id, status: 'error', batchIndex: i, detail: err.message });
        brandFailed = true;
        break;
      }
    }
    if (brandFailed) continue; // this brand's partial reportIds are NOT written to _meta — next run retries this brand cleanly

    reportIds.forEach((id, i) => { metaMap[`report_id_${brand.id}_${targetMonth}_b${i}`] = id; });
    metaMap[`report_batch_count_${brand.id}_${targetMonth}`] = String(reportIds.length);
    metaMap[`report_status_${brand.id}`]      = 'REQUESTED';
    metaMap[`last_requested_at_${brand.id}`]  = ts;
    results.push({ brand: brand.id, status: 'requested', batchCount: reportIds.length });

    // Write immediately after EACH brand succeeds, not accumulated and
    // written once after the whole loop — with retries potentially taking
    // up to ~75s per throttled brand across many brands, a mid-run Vercel
    // timeout would otherwise lose progress for brands that had already
    // succeeded earlier in this same invocation. Confirmed 2026-07-16.
    try {
      const token = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
      const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
      await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, token);
    } catch (err) {
      console.error(`[sync-sqp-request] ${brand.id} — requested successfully but failed to write meta:`, err.message);
      // Report was successfully requested with Amazon at this point — flag
      // it in the results, but keep going with the remaining brands rather
      // than aborting the whole run over one sheet-write hiccup.
      results[results.length - 1] = { brand: brand.id, status: 'requested-but-meta-write-failed', batchCount: reportIds.length, metaWriteError: err.message };
    }
  }

  res.status(200).json({ ok: true, targetMonth, results });
};
