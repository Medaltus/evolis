/**
 * api/cron/qa-business-report.js
 * Runs once daily, chained AFTER clean-business-report-vine.js (which runs
 * at 6:50 UTC) — schedule this a few minutes later, e.g. 7:05 UTC.
 *
 * THE PROBLEM (per Jaclyn, 2026-09-03): Amazon's Sales and Traffic
 * (Business Report) API captures order data AT THE MOMENT the order is
 * placed. If an order is later cancelled before fulfillment, Amazon's own
 * numbers get retroactively corrected over time — but there is no field
 * on this report that ever flags a cancellation directly (confirmed
 * against Amazon's own SP-API schema for GET_SALES_AND_TRAFFIC_REPORT —
 * salesByAsin/trafficByAsin have no per-order breakdown at all, only
 * pre-aggregated totals), so there's no way to filter cancelled orders
 * out of this report on our end. clean-business-report-vine.js already
 * cross-references sheets.orders (which DOES have real per-order status,
 * and already excludes cancelled orders from every total computed off it
 * — see fetchOrderUnitsByAsinMonth below, same convention) — but it only
 * uses that cross-reference to catch Vine contamination, and only within
 * an ASIN's narrow Vine-eligible window (enrollment month + up to 2
 * months after). Outside that window, ANY gap between Amazon's raw
 * figures and the orders sheet's real totals — including one caused by a
 * cancellation Amazon hasn't retroactively corrected yet — passes
 * straight through into UNITS_ORDERED_CLEAN / ORDERED_PRODUCT_SALES_CLEAN
 * completely unexamined.
 *
 * WHAT THIS CRON DOES, AND DELIBERATELY DOES NOT DO:
 *   This is a QA/reconciliation cron, not an auto-correction one. For
 *   every ASIN/month, it computes (Business Report CLEAN units/sales) −
 *   (orders sheet units/sales) and writes the gap as new columns. It does
 *   NOT subtract that gap into UNITS_ORDERED_CLEAN the way
 *   clean-business-report-vine.js subtracts Vine — a gap here could be a
 *   cancellation, a genuine report-cutoff timing difference between two
 *   independently-generated Amazon reports, or something else, and this
 *   codebase's own house rule (see clean-business-report-vine.js's header
 *   comment on why it rejected its first design) is to not auto-attribute
 *   a delta to a specific cause without strong evidence. The FLAG column
 *   below is a worklist for a human to look at, not a verdict.
 *
 * Compares against the *_CLEAN columns (not raw UNITS_ORDERED /
 * ORDERED_PRODUCT_SALES) since this runs after clean-business-report-vine.js
 * — a known, already-explained Vine gap shouldn't also show up here as an
 * "unexplained" one. Falls back to the raw columns if _CLEAN is blank
 * (e.g. this cron ever runs before clean-business-report-vine.js on a
 * given day).
 *
 * Orders-sheet-implied sales are estimated the SAME way
 * clean-business-report-vine.js estimates Vine sales — units × the Master
 * SKU List's price column — since sheets.orders doesn't have a confirmed
 * per-order dollar figure this codebase already relies on elsewhere. If
 * sheets.orders turns out to have its own reliable revenue column, switch
 * to that instead of this price-lookup estimate.
 *
 * Only ASIN/months within the CURRENT target_months window get freshly
 * recomputed — older rows keep whatever a past run already computed for
 * them (same non-destructive-on-old-data principle as
 * clean-business-report-vine.js's _CLEAN columns), rather than getting
 * wiped blank every time the rolling 2-month window moves past them. This
 * is what makes the QA columns a permanent, accumulating audit trail
 * instead of a snapshot that only ever covers the last 2 months.
 *
 * New columns appended to clean-business-report-vine.js's own 13:
 * ORDERS_SHEET_UNITS, ORDERS_SHEET_SALES_EST, UNEXPLAINED_UNITS_GAP,
 * UNEXPLAINED_SALES_GAP_EST, FLAG.
 *
 * FLAG_THRESHOLD_UNITS / FLAG_THRESHOLD_SALES below are a starting-point
 * guess, not independently confirmed against real gap sizes yet — watch
 * the first few real runs (use ?debug=true) and adjust if everything, or
 * nothing, ends up flagged.
 *
 * Manual:
 *   GET /api/cron/qa-business-report?dryRun=true              — compute + log, don't write
 *   GET /api/cron/qa-business-report?dryRun=true&debug=true    — + exact ASIN/month/gap for every flagged row
 *   GET /api/cron/qa-business-report                           — actually write
 *   Authorization: Bearer <CRON_SECRET>
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand, E=price, F=date enrolled in Vine

// clean-business-report-vine.js's own 13 columns, plus this cron's 5.
const HEADERS = [
  'MONTH', 'YEAR', 'ASIN', 'SKU', 'SESSIONS', 'PAGE_VIEWS', 'UNITS_ORDERED', 'ORDERED_PRODUCT_SALES', 'CONVERSION_RATE',
  'VINE_UNITS_DEDUCTED', 'VINE_SALES_DEDUCTED', 'UNITS_ORDERED_CLEAN', 'ORDERED_PRODUCT_SALES_CLEAN',
  'ORDERS_SHEET_UNITS', 'ORDERS_SHEET_SALES_EST', 'UNEXPLAINED_UNITS_GAP', 'UNEXPLAINED_SALES_GAP_EST', 'FLAG',
];

const META_TAB = '_meta';

// Starting-point thresholds — see header comment.
const FLAG_THRESHOLD_UNITS = 3;
const FLAG_THRESHOLD_SALES = 25;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun    = req.query.dryRun === 'true';
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
    await sendCronFailureAlert('qa-business-report', err.message, { Stage: 'reading target_months from _meta' });
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  let priceByAsin;
  try {
    priceByAsin = await fetchPriceByAsin();
  } catch (err) {
    await sendCronFailureAlert('qa-business-report', err.message, { Stage: 'reading master ASIN/SKU list' });
    return res.status(500).json({ error: 'Failed to read master ASIN/SKU list', detail: err.message });
  }

  const results = [];
  // Same 429-avoidance pattern as clean-business-report-vine.js (see its
  // header comment, 2026-08-14 second pass) — this loop does the same
  // shape of multi-call-per-brand work (ensureTab, business report read,
  // orders-sheet read, final write), so it gets the stagger from the
  // start instead of waiting for a real production 429 to add it.
  const BRAND_READ_STAGGER_MS = 3500;
  let brandIndex = 0;

  for (const brand of brands.filter(b => b.active)) {
    if (brandIndex > 0) await sleep(BRAND_READ_STAGGER_MS);
    brandIndex++;

    try {
      const token   = await ensureTab(sheets.businessReport, brand.tabName, HEADERS);
      const rawRows = await readRows(sheets.businessReport, brand.tabName);

      // Same cancelled-order-excluded aggregation clean-business-report-vine.js
      // already uses — real, ground-truth per-ASIN per-month unit counts.
      const orderUnitsByAsinMonth = await fetchOrderUnitsByAsinMonth(brand.tabName, targetMonths);

      let flaggedCount = 0;
      const flaggedDetails = [];

      const outRows = (rawRows || []).map(r => {
        const asin  = (r.ASIN || '').toUpperCase();
        const month = (r.MONTH != null && r.YEAR != null) ? `${r.YEAR}-${String(r.MONTH).padStart(2, '0')}` : '';

        // Preserve whatever a past run already computed for months outside
        // the current rolling window — see header comment. Only recomputed
        // below when this row's month IS in targetMonths.
        let ordersSheetUnits    = r.ORDERS_SHEET_UNITS         ?? '';
        let ordersSheetSalesEst = r.ORDERS_SHEET_SALES_EST     ?? '';
        let unitsGap            = r.UNEXPLAINED_UNITS_GAP      ?? '';
        let salesGap            = r.UNEXPLAINED_SALES_GAP_EST  ?? '';
        let flag                = r.FLAG                       ?? '';

        if (asin && month && targetMonths.includes(month)) {
          // Prefer CLEAN (Vine-adjusted) figures; fall back to raw if this
          // ever runs before clean-business-report-vine.js on a given day.
          const cleanUnits = (r.UNITS_ORDERED_CLEAN !== '' && r.UNITS_ORDERED_CLEAN != null)
            ? parseFloat(r.UNITS_ORDERED_CLEAN) : (parseFloat(r.UNITS_ORDERED) || 0);
          const cleanSales = (r.ORDERED_PRODUCT_SALES_CLEAN !== '' && r.ORDERED_PRODUCT_SALES_CLEAN != null)
            ? parseFloat(r.ORDERED_PRODUCT_SALES_CLEAN) : (parseFloat(r.ORDERED_PRODUCT_SALES) || 0);

          const realUnits    = orderUnitsByAsinMonth.get(`${asin}||${month}`) ?? 0;
          const price        = priceByAsin.get(asin) ?? 0;
          const realSalesEst = round2(realUnits * price);

          ordersSheetUnits    = realUnits;
          ordersSheetSalesEst = realSalesEst;
          unitsGap            = round2(cleanUnits - realUnits);
          salesGap            = round2(cleanSales - realSalesEst);
          flag                = '';

          if (Math.abs(unitsGap) >= FLAG_THRESHOLD_UNITS || Math.abs(salesGap) >= FLAG_THRESHOLD_SALES) {
            flag = 'REVIEW';
            flaggedCount++;
            if (debugMode) {
              flaggedDetails.push({
                asin, sku: r.SKU || '', month,
                cleanUnits, ordersSheetUnits, unitsGap,
                cleanSales, ordersSheetSalesEst, salesGap,
              });
            }
          }
        }

        return {
          ...r,
          ORDERS_SHEET_UNITS: ordersSheetUnits,
          ORDERS_SHEET_SALES_EST: ordersSheetSalesEst,
          UNEXPLAINED_UNITS_GAP: unitsGap,
          UNEXPLAINED_SALES_GAP_EST: salesGap,
          FLAG: flag,
        };
      });

      const outArrays = outRows.map(r => HEADERS.map(h => r[h] ?? ''));

      if (!dryRun) {
        await replaceRows(sheets.businessReport, brand.tabName, HEADERS, outArrays, token, 'USER_ENTERED');
      }

      results.push({
        brand: brand.id, status: 'ok', totalRows: outArrays.length, flagged: flaggedCount,
        ...(debugMode ? { flaggedDetails } : {}),
      });
      console.log(`[qa-business-report] ${brand.id} — ${flaggedCount} row(s) flagged for review across ${targetMonths.join(', ')}`);
    } catch (err) {
      console.error(`[qa-business-report] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'qa-business-report',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ dryRun, targetMonths, results });
};

function round2(n) { return Math.round((n || 0) * 100) / 100; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Identical convention to clean-business-report-vine.js's
// fetchOrderUnitsByAsinMonth — cancelled orders excluded.
async function fetchOrderUnitsByAsinMonth(brandTabName, targetMonths) {
  const rows = await readRows(sheets.orders, brandTabName).catch(err => {
    console.warn(`[qa-business-report] ${brandTabName} — orders sheet read failed (comparison will show 0 real units this run): ${err.message}`);
    return [];
  });
  const map = new Map();
  (rows || []).forEach(r => {
    const status = (r.status || '').toLowerCase();
    if (status === 'cancelled') return;
    const asin  = (r.asin || '').trim().toUpperCase();
    const month = (r.date || '').slice(0, 7);
    if (!asin || !targetMonths.includes(month)) return;
    const key = `${asin}||${month}`;
    map.set(key, (map.get(key) || 0) + (parseInt(r.unit_count, 10) || 0));
  });
  return map;
}

// Same Master SKU List price lookup clean-business-report-vine.js uses for
// its Vine sales estimate — reused here for the same reason (sheets.orders
// has no confirmed per-order dollar figure).
async function fetchPriceByAsin() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master ASIN sheet: ${resp.status}`);
  const csv = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  const result = new Map();
  for (const line of lines) {
    const cols  = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const asin  = (cols[0] || '').toUpperCase();
    const price = parseFloat((cols[4] || '').replace(/[$,]/g, '')) || 0;
    if (asin) result.set(asin, price);
  }
  return result;
}
