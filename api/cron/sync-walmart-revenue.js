/**
 * api/cron/sync-walmart-revenue.js
 * Runs daily at 4AM UTC — reads Walmart rolling orders sheet, aggregates
 * revenue for the current month and last month only, and upserts those two
 * rows into the Walmart revenue history sheet.
 *
 * Historical rows are preserved — only current month + last month are touched.
 * WFS UNITS and FBM UNITS are computed from the fulfillment_type column on the
 * orders sheet (written by sync-walmart-orders). Rows predating that column
 * will show blank WFS/FBM unless manually filled in.
 *
 * Sheet structure (one tab per brand):
 *   MONTH | YEAR | REVENUE | ORDERS | UNITS SOLD | WFS UNITS | FBM UNITS | Last Updated
 *
 * WALMART_ORDERS_SHEET  = rolling orders (source)
 * WALMART_REVENUE_SHEET = revenue history (destination)
 *
 * RETURNS NETTING — added 2026-08-05 per Jaclyn. REVENUE and UNITS SOLD are
 * netted against SHEET_WALMART_RETURNS (one tab per brand, same convention
 * as every other multi-brand sheet in this repo), matched by return_date
 * falling in the target month (current or previous), not the original
 * order's month — same "net this month's real activity" convention used
 * for the Overview page's and Amazon revenue cron's own returns-netting.
 *
 * Unlike Amazon's FBA Returns report, this sheet DOES have a real dollar
 * field (refund_amount) — no price estimation needed here, revenue is
 * netted by direct subtraction.
 *
 * WFS/FBM SPLIT — NOT adjusted for returns. Confirmed field names on
 * SHEET_WALMART_RETURNS are return_date/quantity/refund_amount; there is
 * no confirmed fulfillment-type field on the RETURNS sheet the way
 * Amazon's report is confirmed FBA-only by its report name. Rather than
 * guess which bucket a given return came from, WFS UNITS and FBM UNITS
 * stay exactly as computed from gross orders — meaning after netting,
 * WFS UNITS + FBM UNITS may no longer sum exactly to UNITS SOLD for a
 * month with returns. Flagged here rather than silently assumed away.
 *
 * If SHEET_WALMART_RETURNS isn't set, or a brand's returns tab doesn't
 * exist yet, this fails soft (nets $0/0 units for that brand/run) rather
 * than blocking the whole revenue sync.
 *
 * Schedule: daily at 4AM UTC ("0 4 * * *")
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const { sendCronFailureAlert } = require('../_alerts');

const ORDERS_SHEET_ID  = process.env.WALMART_ORDERS_SHEET;
const REVENUE_SHEET_ID = process.env.WALMART_REVENUE_SHEET;
const RETURNS_SHEET_ID = process.env.SHEET_WALMART_RETURNS;

const REVENUE_HEADERS = [
  'MONTH', 'YEAR', 'REVENUE', 'ORDERS', 'UNITS SOLD',
  'WFS UNITS', 'FBM UNITS', 'Last Updated',
];

// ADDED 2026-08-14 — same fix as sync-revenue-process.js and
// sync-returns-process.js: this loop does up to 5 real Sheets calls per
// brand (orders read, returns read, ensureTab, revenue read, revenue
// write) with zero pacing between brands. Same root cause already found
// and fixed elsewhere today (429 RESOURCE_EXHAUSTED on Sheets' per-minute
// read quota).
const BRAND_READ_STAGGER_MS = 3500;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!ORDERS_SHEET_ID) {
    await sendCronFailureAlert('sync-walmart-revenue', 'WALMART_ORDERS_SHEET not set');
    return res.status(500).json({ error: 'WALMART_ORDERS_SHEET not set' });
  }
  if (!REVENUE_SHEET_ID) {
    await sendCronFailureAlert('sync-walmart-revenue', 'WALMART_REVENUE_SHEET not set');
    return res.status(500).json({ error: 'WALMART_REVENUE_SHEET not set' });
  }
  // Soft check, deliberately not a hard failure — unlike the two sheets
  // above, this cron can still do its core job (compute gross revenue)
  // without returns netting; missing this just means netting is skipped
  // for every brand this run rather than blocking revenue entirely.
  if (!RETURNS_SHEET_ID) {
    console.warn('[sync-walmart-revenue] SHEET_WALMART_RETURNS not set — revenue will NOT be netted against returns this run');
  }

  const nowEst = toEstIso(new Date());

  // Determine current month and last month
  const today = new Date();
  const currYear  = today.getUTCFullYear();
  const currMonth = today.getUTCMonth() + 1; // 1-indexed

  let prevMonth = currMonth - 1;
  let prevYear  = currYear;
  if (prevMonth === 0) { prevMonth = 12; prevYear--; }

  const targetKeys = new Set([
    `${currYear}-${String(currMonth).padStart(2,'0')}`,
    `${prevYear}-${String(prevMonth).padStart(2,'0')}`,
  ]);

  console.log(`[sync-walmart-revenue] updating months: ${[...targetKeys].join(', ')}`);

  const activeBrands = brands.filter(b => b.active);
  const results = [];
  let brandIndex = 0;

  for (const brand of activeBrands) {
    if (brandIndex > 0) await sleep(BRAND_READ_STAGGER_MS);
    brandIndex++;

    try {
      // ── 1. Read rolling orders for this brand ─────────────────────────────
      let orderRows = [];
      try {
        orderRows = await readRows(ORDERS_SHEET_ID, brand.tabName);
      } catch (e) {
        console.log(`[sync-walmart-revenue] ${brand.id} — no orders tab, skipping`);
        continue;
      }

      if (!orderRows.length) {
        console.log(`[sync-walmart-revenue] ${brand.id} — 0 rows, skipping`);
        continue;
      }

      // ── 2. Aggregate current + last month from orders ─────────────────────
      const monthMap = {}; // "YYYY-MM" → { revenue, orderIds, units }

      for (const row of orderRows) {
        const status = (row.status || '').toLowerCase().trim();
        if (status === 'cancelled' || status === 'canceled') continue;

        const date = normalizeDate(row.date);
        if (!date) continue;
        const key = date.substring(0, 7); // "YYYY-MM"
        if (!targetKeys.has(key)) continue; // only process current + last month

        if (!monthMap[key]) {
          monthMap[key] = { orderIds: new Set(), revenue: 0, units: 0, wfsUnits: 0, fbmUnits: 0 };
        }

        const orderId         = (row.order_id || '').trim();
        const total           = parseFloat((row.order_total || '0').replace(/[$,]/g, '')) || 0;
        const units           = parseInt(row.unit_count, 10) || 0;
        const fulfillmentType = (row.fulfillment_type || '').trim().toUpperCase();

        // Revenue: sum order_total once per unique order_id (avoid multi-line double count)
        if (orderId && !monthMap[key].orderIds.has(orderId)) {
          monthMap[key].orderIds.add(orderId);
          monthMap[key].revenue += total;
        }
        monthMap[key].units += units;
        if (fulfillmentType === 'WFS') {
          monthMap[key].wfsUnits += units;
        } else if (fulfillmentType === 'SELLER') {
          monthMap[key].fbmUnits += units;
        }
      }

      if (!Object.keys(monthMap).length) {
        console.log(`[sync-walmart-revenue] ${brand.id} — no data for target months`);
        continue;
      }

      // ── 2b. Net returns into current + previous month ──────────────────────
      const brandReturnRows = await fetchWalmartReturnsForBrand(brand);
      for (const key of Object.keys(monthMap)) {
        const { returnedUnits, returnedRevenue } = sumWalmartReturnsForMonth(brandReturnRows, key);
        if (returnedUnits === 0 && returnedRevenue === 0) continue;

        const data = monthMap[key];
        const grossRevenue = data.revenue;
        const grossUnits   = data.units;
        data.revenue = Math.max(0, Math.round((grossRevenue - returnedRevenue) * 100) / 100);
        data.units   = Math.max(0, grossUnits - returnedUnits);

        console.log(`[sync-walmart-revenue] ${brand.id} ${key} — netted ${returnedUnits} returned units ($${returnedRevenue.toFixed(2)}) against gross revenue=${grossRevenue} units=${grossUnits}`);
        if (grossRevenue - returnedRevenue < 0 || grossUnits - returnedUnits < 0) {
          console.warn(`[sync-walmart-revenue] ${brand.id} ${key} — returns this month exceeded gross this month; floored at 0 rather than writing a negative value`);
        }
      }

      // ── 3. Read existing revenue rows ─────────────────────────────────────
      const tok = await ensureTab(REVENUE_SHEET_ID, brand.tabName, REVENUE_HEADERS);
      let existingRows = [];
      try {
        existingRows = await readRows(REVENUE_SHEET_ID, brand.tabName);
      } catch (e) { /* new tab */ }

      // Build map of all existing rows keyed by "YYYY-MM"
      // Preserve ALL columns including WFS UNITS / FBM UNITS that may be
      // manually populated on historical rows.
      const existingMap = {};
      for (const r of existingRows) {
        const yr = String(r.YEAR  || r.year  || '').trim();
        const mo = String(r.MONTH || r.month || '').trim().padStart(2, '0');
        if (yr && mo) existingMap[`${yr}-${mo}`] = r;
      }

      // ── 4. Upsert only target months ──────────────────────────────────────
      let updatedCount = 0;
      for (const [key, data] of Object.entries(monthMap)) {
        const [yr, mo] = key.split('-');
        const existing = existingMap[key] || {};

        existingMap[key] = {
          MONTH:          parseInt(mo, 10),
          YEAR:           parseInt(yr, 10),
          REVENUE:        Math.round(data.revenue * 100) / 100,
          ORDERS:         data.orderIds.size,
          'UNITS SOLD':   data.units,
          // Use computed values if available; fall back to manually-entered values
          // for rows that predate fulfillment_type tracking in the orders sheet.
          'WFS UNITS':    data.wfsUnits > 0 ? data.wfsUnits : (existing['WFS UNITS'] || ''),
          'FBM UNITS':    data.fbmUnits > 0 ? data.fbmUnits : (existing['FBM UNITS'] || ''),
          'Last Updated': nowEst,
        };
        updatedCount++;
      }

      // ── 5. Write all rows back sorted by year-month ascending ─────────────
      const sortedKeys = Object.keys(existingMap).sort();
      const newRows = sortedKeys.map(key => {
        const r = existingMap[key];
        return [
          r.MONTH       || r.month       || '',
          r.YEAR        || r.year        || '',
          r.REVENUE     || r.revenue     || 0,
          r.ORDERS      || r.orders      || 0,
          r['UNITS SOLD'] || r.units     || 0,
          r['WFS UNITS']  || '',
          r['FBM UNITS']  || '',
          r['Last Updated'] || r.last_updated || '',
        ];
      });

      await replaceRows(REVENUE_SHEET_ID, brand.tabName, REVENUE_HEADERS, newRows, tok);
      console.log(`[sync-walmart-revenue] ${brand.id} — ${updatedCount} months updated, ${newRows.length} total rows written`);
      results.push({ brand: brand.id, monthsUpdated: updatedCount, totalRows: newRows.length });

    } catch (err) {
      console.error(`[sync-walmart-revenue] ${brand.id} error:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-walmart-revenue',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': `${failedBrands.length} of ${activeBrands.length}` }
    );
  }

  return res.status(200).json({ synced: results, timestamp: nowEst });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Reads this brand's tab on SHEET_WALMART_RETURNS. Fails soft — no env var,
// no tab yet for this brand, or a fetch error all just mean $0/0 units
// netted for that brand this run, not a failed sync. Confirmed field
// names: return_date, quantity, refund_amount (unlike Amazon's FBA
// Returns report, this one has a real dollar field — no price estimation
// needed).
async function fetchWalmartReturnsForBrand(brand) {
  if (!RETURNS_SHEET_ID) return [];
  try {
    const rows = await readRows(RETURNS_SHEET_ID, brand.tabName);
    return rows || [];
  } catch (err) {
    console.warn(`[sync-walmart-revenue] ${brand.id} — failed to read returns sheet (revenue will NOT be netted against returns this run):`, err.message);
    return [];
  }
}

// Sums returned quantity + refund_amount for return rows dated (by
// return_date) within the given "YYYY-MM" month — "returns actually
// processed this month," not "returns tied to an order placed this
// month," same convention as the Amazon revenue cron's own netting.
function sumWalmartReturnsForMonth(returnRows, monthKey) {
  let returnedUnits = 0, returnedRevenue = 0;
  returnRows.forEach(r => {
    const date = normalizeDate(r.return_date);
    if (!date || date.substring(0, 7) !== monthKey) return;
    returnedUnits   += parseInt(r.quantity, 10) || 0;
    returnedRevenue += parseFloat((r.refund_amount || '0').toString().replace(/[$,]/g, '')) || 0;
  });
  return { returnedUnits, returnedRevenue: Math.round(returnedRevenue * 100) / 100 };
}

function normalizeDate(val) {
  if (!val) return '';
  if (/^\d{4}-\d{2}/.test(val)) return val.substring(0, 10);
  const parts = val.split('/');
  if (parts.length === 3) {
    const m = parts[0].padStart(2, '0');
    const d = parts[1].padStart(2, '0');
    const y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
    return `${y}-${m}-${d}`;
  }
  return val;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Returns EST wall-time formatted as ISO-8601.
 * Handles EDT (UTC-4) and EST (UTC-5) automatically via Intl.
 */
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
