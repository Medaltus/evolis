/**
 * api/cron/clean-business-report-vine.js
 * Runs once daily, chained AFTER sync-business-report-process.js (which
 * runs at 5:50 UTC — this runs at 6:50 UTC, confirmed against the real
 * vercel.json rather than trusted as-is; FIXED 2026-09-10, this comment
 * previously said "5:15 UTC... schedule a few minutes later, e.g. 5:30
 * UTC" — stale on both counts, same class of drift already found and
 * fixed in sync-business-report-process.js's own header comment).
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
 * ADDED 2026-09-10 per Jaclyn — a SEPARATE, genuinely independent
 * problem from Vine, found after this file was already in production:
 * Amazon's Business Report also counts CANCELLED orders as real unit
 * sales. This is NOT the same mechanism as Vine contamination — a
 * cancelled order isn't tied to any enrollment window or per-ASIN
 * budget, it can happen to any ASIN in any month — so it needed its own,
 * independent deduction rather than being folded into the Vine logic
 * above. Computed directly from the orders sheet's own cancelled rows
 * (their real dollar amount is already right there in item_price), not
 * an inferred delta the way Vine's deduction has to be. Two more columns
 * appended: CANCELLED_UNITS_DEDUCTED, CANCELLED_SALES_DEDUCTED — and the
 * existing UNITS_ORDERED_CLEAN / ORDERED_PRODUCT_SALES_CLEAN columns now
 * subtract BOTH Vine and cancelled deductions, so the dashboard-facing
 * "_CLEAN" columns don't need to change meaning or the dashboard doesn't
 * need a second follow-up once the one above is done.
 *
 * Manual:
 *   GET /api/cron/clean-business-report-vine?dryRun=true             — report only
 *   GET /api/cron/clean-business-report-vine?dryRun=true&debug=true   — report + exact ASIN/month/amount for every deduction
 *   GET /api/cron/clean-business-report-vine                          — actually write
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
  // FIXED 2026-09-10 per Jaclyn — LAST_UPDATED added here, matching the
  // exact same position sync-business-report-process.js already uses.
  // Real, confirmed bug: this cron's own HEADERS array never had this
  // column, and its replaceRows() call below only ever writes fields
  // this array lists — meaning every time this cron ran (scheduled to
  // run AFTER sync-business-report-process.js sets LAST_UPDATED), it
  // would silently drop that value from the output entirely, undoing
  // the other cron's own write on every single run. Both files' HEADERS
  // arrays write to the exact same physical sheet/tab and MUST be kept
  // in sync with each other whenever either one changes — there's no
  // shared constant between them, so this has to be checked by hand.
  'LAST_UPDATED',
  'VINE_UNITS_DEDUCTED', 'VINE_SALES_DEDUCTED', 'UNITS_ORDERED_CLEAN', 'ORDERED_PRODUCT_SALES_CLEAN',
  // ADDED 2026-09-10 per Jaclyn — cancelled-order deduction, a separate
  // problem from Vine (see fetchOrderDataByAsinMonth's own comment for
  // why). Appended at the end, never inserted, same standing
  // rule as every other schema change in this codebase.
  'CANCELLED_UNITS_DEDUCTED', 'CANCELLED_SALES_DEDUCTED',
];

const META_TAB = '_meta';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dryRun === 'true';
  const debugMode = req.query.debug === 'true';

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
  // FIXED 2026-08-14, second pass — a real miss: this loop does up to 4
  // Sheets calls per brand (ensureTab, business report read, the internal
  // orders-sheet read inside fetchOrderUnitsByAsinMonth, and the final
  // write) across every active brand with zero pacing between them. Same
  // 429 RESOURCE_EXHAUSTED quota pattern already found and fixed in
  // several other files today (sync-revenue-process.js,
  // sync-returns-process.js, sync-walmart-revenue.js, etc.) — this file
  // should have gotten the same fix when it was built, not after a real
  // production failure (confirmed: evolis hit exactly this 429 in
  // production).
  const BRAND_READ_STAGGER_MS = 3500;
  let brandIndex = 0;

  for (const brand of brands.filter(b => b.active)) {
    if (brandIndex > 0) await sleep(BRAND_READ_STAGGER_MS);
    brandIndex++;

    try {
      const token   = await ensureTab(sheets.businessReport, brand.tabName, HEADERS);
      const rawRows = await readRows(sheets.businessReport, brand.tabName);

      // Vine-clean organic units, AND cancelled-order units/dollars, both
      // per ASIN per month — one single read of the orders sheet for
      // both (see fetchOrderDataByAsinMonth's own comment for why this
      // is combined rather than two separate reads). This sheet can be
      // large (thousands of rows for busy brands), same read-once-per-
      // brand pattern used elsewhere in this codebase.
      const { organicUnitsMap: orderUnitsByAsinMonth, cancelledMap: cancelledByAsinMonth } = await fetchOrderDataByAsinMonth(brand.tabName, targetMonths);

      let deductionsApplied = 0;
      let cancelledDeductionsApplied = 0;
      const deductionDetails = [];
      // CORRECTED 2026-08-14, second pass — per Jaclyn: a single Vine
      // ENROLLMENT allocates up to 30 UNITS (not 1) — each of up to 30
      // Vine reviewers claims exactly 1 unit, and claims trickle in over
      // up to 60 days. Capping at 1 unit (the previous fix) was ALSO
      // wrong — it would silently under-correct any enrollment where
      // more than 1 reviewer had already claimed by report time, which
      // is the normal case. The real constraint is a CUMULATIVE budget of
      // 30 units total, ever, per ASIN's single enrollment — tracked here
      // per ASIN across however many months this run touches, so the
      // total deducted for one ASIN can never exceed 30 even if claims
      // land across 2-3 separate months in the same run.
      const remainingVineBudgetByAsin = new Map(); // asin -> units still available to deduct this run (starts at 30)

      // NOTE: relies on rawRows being in ascending (year, month) order so
      // earlier months are processed before later ones, and the budget is
      // drawn down in chronological order. Holds today because
      // sync-business-report-process.js explicitly sorts by
      // (year, month, asin) before every write — if that sort is ever
      // removed, this would need to sort rawRows itself first.
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
          // WIDENED 2026-08-14 — was [enrollment, +1 month], now
          // [enrollment, +1, +2] to cover the full ~60-day claim window
          // Jaclyn described. Combined with this cron running daily
          // against a rolling 2-month target_months window, this
          // correctly catches the whole trickle-in period as long as the
          // cron doesn't go an extended stretch without running — see
          // this file's header comment for the month-by-month timeline
          // that confirms this.
          const eligibleForVine = vineInfo?.enrollmentMonth && [
            vineInfo.enrollmentMonth,
            addOneMonth(vineInfo.enrollmentMonth),
            addOneMonth(addOneMonth(vineInfo.enrollmentMonth)),
          ].includes(month);

          if (eligibleForVine) {
            if (!remainingVineBudgetByAsin.has(asin)) remainingVineBudgetByAsin.set(asin, 30);
            const remainingBudget = remainingVineBudgetByAsin.get(asin);

            if (remainingBudget > 0) {
              const orderUnits = orderUnitsByAsinMonth.get(`${asin}||${month}`) ?? 0;
              const delta = rawUnits - orderUnits;
              if (delta > 0) {
                // Deduct whatever this month's delta claims, but never
                // more than what's left of this ASIN's 30-unit budget —
                // protects against trusting an implausibly large delta
                // (e.g. an unrelated orders-sheet data gap) as if it were
                // all Vine, the same failure mode that produced the
                // 24-30 unit over-deductions caught in testing.
                const unitsThisMonth = Math.min(delta, remainingBudget);
                vineUnitsDeducted = unitsThisMonth;
                vineSalesDeducted = round2(vineInfo.price * unitsThisMonth);
                remainingVineBudgetByAsin.set(asin, remainingBudget - unitsThisMonth);
                deductionsApplied++;
                if (debugMode) {
                  deductionDetails.push({
                    asin, sku: r.SKU || '', month,
                    type: 'vine',
                    enrollmentMonth: vineInfo.enrollmentMonth,
                    rawUnits, orderUnits, delta,
                    unitsDeducted: unitsThisMonth,
                    remainingBudgetAfter: remainingBudget - unitsThisMonth,
                    price: vineInfo.price, salesDeducted: vineSalesDeducted,
                    note: delta > unitsThisMonth ? `delta was ${delta}, only ${unitsThisMonth} deducted — remainder of this ASIN's 30-unit Vine budget already used up in an earlier month this run, OR delta itself exceeds what Vine could ever explain` : undefined,
                  });
                }
              }
            }
          }
        }

        r.VINE_UNITS_DEDUCTED         = vineUnitsDeducted;
        r.VINE_SALES_DEDUCTED         = vineSalesDeducted;

        // ADDED 2026-09-10 per Jaclyn — cancelled-order deduction. Unlike
        // Vine, this is NOT tied to any eligibility window or per-ASIN
        // budget — a cancelled order is a cancelled order, in whatever
        // real month it happened, full stop. Direct lookup from the
        // orders sheet's own cancelled rows (summed in
        // fetchOrderDataByAsinMonth above), not an inferred delta.
        let cancelledUnitsDeducted = 0;
        let cancelledSalesDeducted = 0;
        if (asin && month) {
          const cancelled = cancelledByAsinMonth.get(`${asin}||${month}`);
          if (cancelled && (cancelled.units > 0 || cancelled.sales > 0)) {
            cancelledUnitsDeducted = cancelled.units;
            cancelledSalesDeducted = round2(cancelled.sales);
            cancelledDeductionsApplied++;
            if (debugMode) {
              deductionDetails.push({
                asin, sku: r.SKU || '', month,
                type: 'cancelled',
                rawUnits, unitsDeducted: cancelledUnitsDeducted, salesDeducted: cancelledSalesDeducted,
              });
            }
          }
        }
        r.CANCELLED_UNITS_DEDUCTED = cancelledUnitsDeducted;
        r.CANCELLED_SALES_DEDUCTED = cancelledSalesDeducted;

        // _CLEAN columns now reflect BOTH corrections — Vine and
        // cancelled — computed fresh from raw sources every run, same
        // "never subtract from a previously-corrected value" safety
        // property this file's header comment already establishes for
        // Vine alone. Fully safe to re-run any number of times.
        r.UNITS_ORDERED_CLEAN         = rawUnits - vineUnitsDeducted - cancelledUnitsDeducted;
        r.ORDERED_PRODUCT_SALES_CLEAN = round2(rawSales - vineSalesDeducted - cancelledSalesDeducted);

        return HEADERS.map(h => r[h] ?? '');
      });

      // Same fix as sync-business-report-process.js — USER_ENTERED so the
      // new VINE_* / *_CLEAN columns are stored as real numbers, not
      // forced text, consistent with the rest of this sheet.
      if (!dryRun) {
        await replaceRows(sheets.businessReport, brand.tabName, HEADERS, outRows, token, 'USER_ENTERED');
      }

      results.push({
        brand: brand.id, status: 'ok', totalRows: outRows.length,
        vineDeductionsApplied: deductionsApplied,
        cancelledDeductionsApplied,
        ...(debugMode ? { deductionDetails } : {}),
      });
      console.log(`[clean-business-report-vine] ${brand.id} — ${deductionsApplied} Vine deduction(s), ${cancelledDeductionsApplied} cancelled-order deduction(s) applied across ${targetMonths.join(', ')}`);
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

function addOneMonth(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(n => parseInt(n, 10));
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Single read of the orders sheet, returning BOTH maps this cron needs:
// (1) Vine-clean organic units per ASIN/month (cancelled excluded, same
// as before) for the existing Vine cross-reference, and (2) cancelled
// units/dollars per ASIN/month (added 2026-09-10) for the new deduction
// below. Combined into one function/one readRows() call deliberately —
// two separate functions each independently reading this same,
// potentially large sheet would double the read volume for no reason,
// re-risking the exact 429 RESOURCE_EXHAUSTED issue already found and
// fixed once in this file (see the brand-stagger comment above).
async function fetchOrderDataByAsinMonth(brandTabName, targetMonths) {
  const rows = await readRows(sheets.orders, brandTabName).catch(err => {
    console.warn(`[clean-business-report-vine] ${brandTabName} — orders sheet read failed (Vine cross-reference will find 0 organic units, and no cancelled-order deduction will apply, this run — safer than guessing): ${err.message}`);
    return [];
  });
  const organicUnitsMap = new Map(); // "ASIN||month" -> units, cancelled excluded
  const cancelledMap = new Map();    // "ASIN||month" -> { units, sales }, cancelled ONLY
  (rows || []).forEach(r => {
    const status = (r.status || '').toLowerCase();
    const asin = (r.asin || '').trim().toUpperCase();
    const month = (r.date || '').slice(0, 7);
    if (!asin || !targetMonths.includes(month)) return;
    const key = `${asin}||${month}`;
    if (status === 'cancelled') {
      // ADDED 2026-09-10 per Jaclyn — separate, genuinely independent
      // problem from Vine: Amazon's Business Report (Sales & Traffic)
      // counts CANCELLED orders as real unit sales, same root-cause
      // CLASS as Vine contamination but a different mechanism —
      // cancelled orders aren't tied to any enrollment window or
      // 30-unit budget, they can happen to any ASIN in any month. This
      // is a DIRECT sum from the orders sheet's own cancelled rows
      // (their real dollar amount is already sitting right there in
      // item_price), not a delta-inference the way Vine's deduction has
      // to be, since Vine units are never directly visible as their own
      // rows anywhere. item_price is this sheet's LINE-ITEM total
      // already (confirmed from sync-orders-process.js's own write
      // schema) — summed directly, not re-multiplied by unit_count,
      // which would double-count.
      const existing = cancelledMap.get(key) || { units: 0, sales: 0 };
      existing.units += parseInt(r.unit_count, 10) || 0;
      existing.sales += parseFloat(String(r.item_price || 0).replace(/[$,]/g, '')) || 0;
      cancelledMap.set(key, existing);
    } else {
      organicUnitsMap.set(key, (organicUnitsMap.get(key) || 0) + (parseInt(r.unit_count, 10) || 0));
    }
  });
  return { organicUnitsMap, cancelledMap };
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
