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
const { sendCronFailureAlert }             = require('../_alerts');

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

// Amazon's own error (confirmed via a real multi-brand run): the burst
// allowance for createReport is small — 5 successful calls (evolis's 2
// batches + skinuva's 1 + dearcloud's first 2) succeeded, then EVERY
// subsequent call failed instantly with QuotaExceeded. That's a small
// burst bucket with a slow refill, not an occasional throttle — retrying
// the exact same call 5 times with exponential backoff (my first attempt
// at this fix) just burns the function's entire time budget waiting on a
// bucket that isn't going to refill fast enough to matter, which is why
// the function then timed out outright. The real fix is architectural,
// not a bigger backoff number: stop trying to force all 15 brands through
// in one invocation. Fail fast on QuotaExceeded, stop the ENTIRE run
// immediately (every brand after the first throttled one will hit the
// exact same wall — no point burning time cycling through the rest), and
// let the next scheduled run (much more frequent now — see vercel.json)
// pick up wherever this one stopped, via the existing per-brand skip
// logic. Confirmed 2026-07-16.
const STAGGER_MS = 2000;
let lastRequestAt = 0;

async function requestReport(dataStartTime, dataEndTime, asinBatch, label) {
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
    console.log(`[sync-sqp-request] ${label}: ${createResp.reportId}`);
    return { reportId: createResp.reportId };
  }

  const isThrottled = createResp?.errors?.[0]?.code === 'QuotaExceeded';
  if (isThrottled) {
    console.warn(`[sync-sqp-request] ${label} — quota exhausted, stopping this entire run (next scheduled run continues from here)`);
    return { error: createResp, quotaExhausted: true };
  }

  console.error(`[sync-sqp-request] ${label} failed:`, JSON.stringify(createResp));
  return { error: createResp };
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
  if (asinsByBrand.size === 0) {
    await sendCronFailureAlert('sync-sqp-request', 'Master SKU List returned 0 usable rows — every brand will be skipped this run. Check sheets.masterSkuList / MASTER_SKU_TAB.');
  }
  const activeBrands = brands.filter(b => b.active);
  const results = [];

  // Hard cap on NEW report-creation calls in this single invocation.
  // 2 brands succeeded, then 11 hit QuotaExceeded on their FIRST attempt —
  // that's a small burst limit already exhausted, not a stagger-timing
  // problem. If the real refill rate is as slow as ~1/60s (common for
  // SP-API report quotas), getting through the remaining ~20 batches would
  // take 20+ minutes — no maxDuration setting fixes that. Capping how much
  // NEW work happens per run and letting the existing daily schedule (see
  // vercel.json) spread the rest across subsequent invocations is the
  // actual fix, not a longer timeout. Progress is saved per-brand as it
  // happens, so whatever wasn't reached this run is exactly what the next
  // scheduled run will attempt first. Confirmed 2026-07-16.
  const MAX_NEW_REQUESTS_PER_RUN = 3;
  let requestsThisRun = 0;
  const hardErrors = []; // genuine failures only — quota/cap-reached is expected, self-throttling behavior, not alerted on

  for (const brand of activeBrands) {
    const brandAsins = asinsByBrand.get(brand.id) || [];
    if (!brandAsins.length) {
      console.warn(`[sync-sqp-request] ${brand.id} — no ASINs matched via SKU prefix, skipping`);
      results.push({ brand: brand.id, status: 'no-asins' });
      continue;
    }

    const batches = chunkAsinsByCharLimit(brandAsins);
    const expectedBatchCount = batches.length;

    // report_batch_count now means TOTAL EXPECTED batches (set up front),
    // not "how many succeeded" — resuming correctly requires knowing how
    // many are still missing, not just whether the brand was ever attempted.
    const storedBatchCount = parseInt(metaMap[`report_batch_count_${brand.id}_${targetMonth}`] || '0', 10);
    if (storedBatchCount && storedBatchCount !== expectedBatchCount && !req.query.force) {
      console.warn(`[sync-sqp-request] ${brand.id} ${targetMonth} — stored batch count (${storedBatchCount}) doesn't match current ASIN-derived count (${expectedBatchCount}), catalog may have changed since the last attempt. Pass ?force=true to restart this brand cleanly.`);
    }
    metaMap[`report_batch_count_${brand.id}_${targetMonth}`] = String(expectedBatchCount);

    if (metaMap[`report_status_${brand.id}`] === 'REQUESTED' && !req.query.force) {
      console.log(`[sync-sqp-request] ${brand.id} ${targetMonth} already fully requested — skipping. Pass ?force=true to request fresh ones anyway.`);
      results.push({ brand: brand.id, status: 'skipped' });
      continue;
    }

    let batchesDoneThisRun = 0;
    let quotaExhausted = false;
    let hardError = null;

    for (let i = 0; i < expectedBatchCount; i++) {
      // Resume support: a batch already recorded (from this run's earlier
      // brands, or a PRIOR run that got partway through this same brand)
      // is never re-requested — this is what makes a large brand like
      // dearcloud (6 batches, more than one run's quota capacity) able to
      // actually finish over several runs instead of restarting from
      // batch 0 forever. Confirmed 2026-07-16.
      if (metaMap[`report_id_${brand.id}_${targetMonth}_b${i}`] && !req.query.force) continue;

      if (requestsThisRun >= MAX_NEW_REQUESTS_PER_RUN) {
        console.log(`[sync-sqp-request] reached per-run cap of ${MAX_NEW_REQUESTS_PER_RUN} new request(s) — ${brand.id} batch ${i} and everything after it will be picked up by the next scheduled run`);
        quotaExhausted = true; // treat the same as quota exhaustion: stop the WHOLE run, not just this brand — every subsequent call would hit the same cap/wall
        break;
      }

      const label = `${brand.id} ${targetMonth} batch ${i} (${batches[i].length} ASINs)`;
      let result;
      try {
        result = await requestReport(dataStartTime, dataEndTime, batches[i], label);
      } catch (err) {
        hardError = err.message;
        break;
      }
      requestsThisRun++;

      if (!result.reportId) {
        if (result.quotaExhausted) { quotaExhausted = true; break; }
        hardError = JSON.stringify(result.error);
        break;
      }

      // Write THIS ONE batch immediately — not accumulated with the rest
      // of the brand's batches. This is what actually fixes the
      // dearcloud problem: previously, if batch 5 of 6 failed, batches
      // 0-4's already-successful reportIds were discarded along with it.
      metaMap[`report_id_${brand.id}_${targetMonth}_b${i}`] = result.reportId;
      batchesDoneThisRun++;
      try {
        const token = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
        const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
        await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, token);
      } catch (err) {
        console.error(`[sync-sqp-request] ${brand.id} batch ${i} succeeded with Amazon but failed to write meta:`, err.message);
      }
    }

    // Is this brand now fully done (every batch index 0..expectedBatchCount-1 has a reportId)?
    const allBatchesPresent = Array.from({ length: expectedBatchCount }, (_, i) => !!metaMap[`report_id_${brand.id}_${targetMonth}_b${i}`]).every(Boolean);
    if (allBatchesPresent) {
      metaMap[`report_status_${brand.id}`]     = 'REQUESTED';
      metaMap[`last_requested_at_${brand.id}`] = ts;
      try {
        const token = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
        const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
        await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, token);
      } catch (err) { /* best-effort — individual batches were already saved above */ }
      results.push({ brand: brand.id, status: 'requested', batchCount: expectedBatchCount, newBatchesThisRun: batchesDoneThisRun });
    } else {
      results.push({ brand: brand.id, status: 'partial', batchesDoneThisRun, totalBatches: expectedBatchCount, reason: hardError || (quotaExhausted ? 'quota/cap reached' : 'in progress') });
      if (hardError) hardErrors.push(`${brand.id}: ${hardError}`);
    }

    if (quotaExhausted) {
      console.warn(`[sync-sqp-request] stopping run early at ${brand.id} — quota/cap reached, remaining work will be picked up next scheduled run`);
      if (hardErrors.length > 0) {
        await sendCronFailureAlert('sync-sqp-request', hardErrors.join('\n'), { 'Brands with real errors': String(hardErrors.length) });
      }
      return res.status(200).json({ ok: true, targetMonth, results, stoppedEarly: true, reason: 'quota exhausted' });
    }
  }

  if (hardErrors.length > 0) {
    await sendCronFailureAlert('sync-sqp-request', hardErrors.join('\n'), { 'Brands with real errors': String(hardErrors.length) });
  }

  res.status(200).json({ ok: true, targetMonth, results });
};
