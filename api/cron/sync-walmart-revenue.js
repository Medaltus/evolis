/**
 * api/cron/sync-walmart-revenue.js
 * Runs daily at 4AM UTC — reads Walmart rolling orders sheet, aggregates
 * revenue for the current month and last month only, and upserts those two
 * rows into the Walmart revenue history sheet.
 *
 * Historical rows are preserved — only current month + last month are touched.
 * WFS UNITS and FBM UNITS are left blank (fulfillment type not yet tracked
 * in the orders sheet; will be populated once sync-walmart-orders writes it).
 *
 * Sheet structure (one tab per brand):
 *   MONTH | YEAR | REVENUE | ORDERS | UNITS SOLD | WFS UNITS | FBM UNITS | Last Updated
 *
 * WALMART_ORDERS_SHEET  = rolling orders (source)
 * WALMART_REVENUE_SHEET = revenue history (destination)
 *
 * Schedule: daily at 4AM UTC ("0 4 * * *")
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands = require('../config/brands');

const ORDERS_SHEET_ID  = process.env.WALMART_ORDERS_SHEET;
const REVENUE_SHEET_ID = process.env.WALMART_REVENUE_SHEET;

const REVENUE_HEADERS = [
  'MONTH', 'YEAR', 'REVENUE', 'ORDERS', 'UNITS SOLD',
  'WFS UNITS', 'FBM UNITS', 'Last Updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!ORDERS_SHEET_ID)  return res.status(500).json({ error: 'WALMART_ORDERS_SHEET not set' });
  if (!REVENUE_SHEET_ID) return res.status(500).json({ error: 'WALMART_REVENUE_SHEET not set' });

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

  for (const brand of activeBrands) {
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
          monthMap[key] = { orderIds: new Set(), revenue: 0, units: 0 };
        }

        const orderId = (row.order_id || '').trim();
        const total   = parseFloat((row.order_total || '0').replace(/[$,]/g, '')) || 0;
        const units   = parseInt(row.unit_count, 10) || 0;

        // Revenue: sum order_total once per unique order_id (avoid multi-line double count)
        if (orderId && !monthMap[key].orderIds.has(orderId)) {
          monthMap[key].orderIds.add(orderId);
          monthMap[key].revenue += total;
        }
        monthMap[key].units += units;
      }

      if (!Object.keys(monthMap).length) {
        console.log(`[sync-walmart-revenue] ${brand.id} — no data for target months`);
        continue;
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
          'WFS UNITS':    existing['WFS UNITS'] || '',   // preserve if manually set
          'FBM UNITS':    existing['FBM UNITS'] || '',   // preserve if manually set
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

  return res.status(200).json({ synced: results, timestamp: nowEst });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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
