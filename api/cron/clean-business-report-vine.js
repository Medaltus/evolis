/**
 * api/cron/clean-business-report-vine.js
 * Runs once daily, chained AFTER sync-business-report-process.js (which
 * runs at 5:15 UTC — schedule this a few minutes later, e.g. 5:30 UTC).
 *
 * THE PROBLEM (per Jaclyn, 2026-08-14): sync-orders-process.js's flat-file
 * order report already excludes Vine orders entirely (filtered out by
 * promotion-id, same as sale-promotions.js relies on) — but Amazon's
 * Sales & Traffic (Business Report) API has no such exclusion, and per
 * Amazon's own seller forums, Vine orders now show up there as a FULL,
 * non-discounted unit sale (this changed at some point — Vine units used
 * to report as $0 revenue, they no longer do). That means
 * UNITS_ORDERED and ORDERED_PRODUCT_SALES in SHEET_BUSINESS_REPORT are
 * both inflated by exactly one phantom "sale" for every Vine-enrolled
 * ASIN, in whichever month Amazon happens to attribute it to.
 *
 * FIRST DESIGN, REJECTED DURING TESTING: originally tried checking each
 * of the two candidate months (enrollment month, and the month after —
 * Amazon may attribute the lone Vine unit to either, per Jaclyn) and
 * deducting from whichever one showed "at least 1 unit ordered." Testing
 * caught this immediately: almost any actively-selling ASIN has ≥1 real
 * organic unit most months regardless of Vine, so that check isn't
 * diagnostic of anything — it just always picked the first candidate
 * month, whether or not the phantom unit was actually there.
 *
 * ACTUAL FIX: cross-reference against sheets.orders, which is ALREADY
 * Vine-clean (sync-orders-process.js filters Vine orders out by
 * promotion-id — same exclusion sale-promotions.js relies on). For a
 * given ASIN and month, (Business Report units) − (orders-sheet units)
 * IS the Vine contamination for that specific month — self-diagnosing,
 * no guessing between candidate months required. The enrollment date
 * (Master SKU List column F) is then used as a SAFETY FILTER, not the
 * primary mechanism: a nonzero delta is only trusted as genuinely
 * Vine-related if the ASIN has an eligible enrollment date (that month or
 * the month after) — protecting against unrelated discrepancies (returns
 * timing, report-cutoff differences between two independently-generated
 * Amazon reports) being misattributed as Vine.
 *
 * WHY NEW COLUMNS, NOT IN-PLACE SUBTRACTION: sync-business-report-process.js
 * does a full recompute-and-overwrite of UNITS_ORDERED/ORDERED_PRODUCT_SALES
 * from Amazon's raw numbers EVERY single day. If this cron subtracted
 * directly from those columns, the very next day's refresh would silently
 * wipe the correction, and if this cron were ever run twice before that
 * refresh, it would double-subtract. Instead: Amazon's raw numbers are
 * left completely untouched (useful for reconciling against Amazon's own
 * dashboard), and four new columns hold the Vine-adjusted figures,
 * always recomputed fresh from (raw + orders-sheet cross-reference) —
 * never from a previously-corrected value. Fully safe to re-run any
 * number of times, in any order, with zero double-counting risk.
 *
 * New columns appended to HEADERS: VINE_UNITS_DEDUCTED,
 * VINE_SALES_DEDUCTED, UNITS_ORDERED_CLEAN, ORDERED_PRODUCT_SALES_CLEAN.
 * FOLLOW-UP NEEDED: the dashboard currently reads UNITS_ORDERED /
 * ORDERED_PRODUCT_SALES directly wherever it displays Business Report
 * data — it needs to be updated to read the new _CLEAN columns instead,
 * or this fix has no visible effect. Not done as part of this file.
 *
 * Manual:
 *   GET /api/cron/clean-business-report-vine?dryRun=true   — report only
 *   GET /api/cron/clean-business-report-vine                — actually write
 *   Authorization: Bearer <CRON_SECRET>
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand, E=price, F=date enrolled in Vine

const HEADERS = [
  'MONTH', 'YEAR', 'ASIN', 'SKU', 'SESSIONS', 'PAGE_VIEWS', 'UNITS_ORDERED', 'ORDERED_PRODUCT_SALES', 'CONVERSION_RATE',
  'VINE_UNITS_DEDUCTED', 'VINE_SALES_DEDUCTED', 'UNITS_ORDERED_CLEAN', 'ORDERED_PRODUCT_SALES_CLEAN',
];

const META_TAB = '_meta';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dryRun === 'true';

  let targetMonths;
  try {
    const rawMeta = await readRows(sheets.businessReport, META_TAB);
    const metaMap = {};
    (rawMeta || []).forEach(r => { if (r.KEY) metaMap[r.KEY] = r.VALUE; });
    targetMonths = (metaMap['target_months'] || '').split(',').filter(Boolean);
    if (!targetMonths.length) {
      return res.status(400).json({ error: 'No target_months in _meta — did sync-business-report-process run first?' });
    }
  } catch (err) {
    await sendCronFailureAlert('clean-business-report-vine', err.message, { Stage: 'reading target_months from _meta' });
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  let vineInfoByAsin;
  try {
    vineInfoByAsin = await fetchVineInfoByAsin();
  } catch (err) {
    await sendCronFailureAlert('clean-business-report-vine', err.message, { Stage: 'reading master ASIN/SKU list' });
    return res.status(500).json({ error: 'Failed to read master ASIN/SKU list', detail: err.message });
  }

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token   = await ensureTab(sheets.businessReport, brand.tabName, HEADERS);
      const rawRows = await readRows(sheets.businessReport, brand.tabName);

      // Vine-clean organic units per ASIN per month, from the orders sheet
      // sync-orders-process.js already excludes Vine from. Only fetched
      // once per brand per run — this sheet can be large (thousands of
      // rows for busy brands), same read-once-per-brand pattern used
      // elsewhere in this codebase.
      const orderUnitsByAsinMonth = await fetchOrderUnitsByAsinMonth(brand.tabName, targetMonths);

      let deductionsApplied = 0;

      const outRows = (rawRows || []).map(r => {
        const asin = (r.ASIN || '').toUpperCase();
        const y = parseInt(r.YEAR, 10);
        const m = parseInt(r.MONTH, 10);
        const month = (y && m) ? `${y}-${String(m).padStart(2, '0')}` : null;
        const rawUnits = parseInt(r.UNITS_ORDERED, 10) || 0;
        const rawSales = parseFloat(r.ORDERED_PRODUCT_SALES) || 0;

        let vineUnitsDeducted = 0;
        let vineSalesDeducted = 0;

        if (asin && month) {
          const vineInfo = vineInfoByAsin.get(asin);
          const eligibleForVine = vineInfo?.enrollmentMonth && [vineInfo.enrollmentMonth, addOneMonth(vineInfo.enrollmentMonth)].includes(month);

          if (eligibleForVine) {
            const orderUnits = orderUnitsByAsinMonth.get(`${asin}||${month}`) ?? 0;
            const delta = rawUnits - orderUnits;
            // Only trust a POSITIVE delta (business report shows MORE units
            // than the Vine-clean orders sheet) as genuine Vine
            // contamination. A zero or negative delta means this month's
            // numbers already agree (or the orders sheet just hasn't
            // caught up yet) — nothing to correct, don't guess.
            if (delta > 0) {
              vineUnitsDeducted = delta;
              vineSalesDeducted = round2(vineInfo.price * delta);
              deductionsApplied++;
            }
          }
        }

        r.VINE_UNITS_DEDUCTED         = vineUnitsDeducted;
        r.VINE_SALES_DEDUCTED         = vineSalesDeducted;
        r.UNITS_ORDERED_CLEAN         = rawUnits - vineUnitsDeducted;
        r.ORDERED_PRODUCT_SALES_CLEAN = round2(rawSales - vineSalesDeducted);

        return HEADERS.map(h => r[h] ?? '');
      });

      if (!dryRun) {
        await replaceRows(sheets.businessReport, brand.tabName, HEADERS, outRows, token);
      }

      results.push({ brand: brand.id, status: 'ok', totalRows: outRows.length, deductionsApplied });
      console.log(`[clean-business-report-vine] ${brand.id} — ${deductionsApplied} Vine deduction(s) applied across ${targetMonths.join(', ')}`);
    } catch (err) {
      console.error(`[clean-business-report-vine] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'clean-business-report-vine',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ dryRun, targetMonths, results });
};

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function addOneMonth(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(n => parseInt(n, 10));
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Aggregates unit_count per ASIN per target month from this brand's
// already-Vine-clean orders tab. Cancelled orders excluded, same
// convention as every other cron that reads this sheet.
async function fetchOrderUnitsByAsinMonth(brandTabName, targetMonths) {
  const rows = await readRows(sheets.orders, brandTabName).catch(err => {
    console.warn(`[clean-business-report-vine] ${brandTabName} — orders sheet read failed (Vine cross-reference will find 0 organic units this run, so no deductions will apply — safer than guessing): ${err.message}`);
    return [];
  });
  const map = new Map();
  (rows || []).forEach(r => {
    const status = (r.status || '').toLowerCase();
    if (status === 'cancelled') return;
    const asin = (r.asin || '').trim().toUpperCase();
    const month = (r.date || '').slice(0, 7);
    if (!asin || !targetMonths.includes(month)) return;
    const key = `${asin}||${month}`;
    map.set(key, (map.get(key) || 0) + (parseInt(r.unit_count, 10) || 0));
  });
  return map;
}

async function fetchVineInfoByAsin() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master ASIN sheet: ${resp.status}`);
  const csv = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  const result = new Map();
  for (const line of lines) {
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const asin    = (cols[0] || '').toUpperCase();
    const price   = parseFloat((cols[4] || '').replace(/[$,]/g, '')) || 0;
    const rawDate = (cols[5] || '').trim();
    if (!asin) continue;

    let enrollmentMonth = null;
    if (rawDate) {
      let yy, mm;
      if (/^\d{4,5}$/.test(rawDate)) {
        const d = new Date(Date.UTC(1899, 11, 30) + parseInt(rawDate, 10) * 86400000);
        yy = String(d.getUTCFullYear());
        mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      } else if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
        yy = rawDate.slice(0, 4);
        mm = rawDate.slice(5, 7);
      } else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(rawDate)) {
        const parts = rawDate.split('/');
        mm = parts[0].padStart(2, '0');
        yy = parts[2].trim().length === 2 ? '20' + parts[2].trim() : parts[2].trim();
      }
      if (yy && mm) enrollmentMonth = `${yy}-${mm}`;
    }

    result.set(asin, { price, enrollmentMonth });
  }
  return result;
}
