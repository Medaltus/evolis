/**
 * api/cron/sync-walmart-revenue.js
 * Runs daily at 4 AM UTC.
 * Reads Walmart rolling orders sheet (all brand tabs), aggregates revenue
 * by brand + year + month, and upserts into the Walmart revenue history sheet.
 *
 * Revenue = sum of order_total per unique order_id per month.
 * Excludes Cancelled orders.
 *
 * Sheet structure (one tab per brand):
 *   MONTH | YEAR | REVENUE | ORDERS | UNITS | last_updated
 *
 * WALMART_ORDERS_SHEET  = rolling orders (source)
 * WALMART_REVENUE_SHEET = revenue history (destination)
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands = require('../config/brands');

const ORDERS_SHEET_ID  = process.env.WALMART_ORDERS_SHEET;
const REVENUE_SHEET_ID = process.env.WALMART_REVENUE_SHEET;

const REVENUE_HEADERS = ['MONTH', 'YEAR', 'REVENUE', 'ORDERS', 'UNITS', 'last_updated'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!ORDERS_SHEET_ID)  return res.status(500).json({ error: 'WALMART_ORDERS_SHEET not set' });
  if (!REVENUE_SHEET_ID) return res.status(500).json({ error: 'WALMART_REVENUE_SHEET not set' });

  const now = new Date().toISOString();
  const activeBrands = brands.filter(b => b.active);
  const results = [];

  for (const brand of activeBrands) {
    try {
      // ── 1. Read rolling orders for this brand ─────────────────────────────
      let orderRows = [];
      try {
        orderRows = await readRows(ORDERS_SHEET_ID, brand.tabName);
      } catch (e) {
        // Tab doesn't exist yet for this brand — skip silently
        console.log(`[sync-walmart-revenue] ${brand.id} — no orders tab, skipping`);
        continue;
      }

      if (!orderRows.length) {
        console.log(`[sync-walmart-revenue] ${brand.id} — 0 rows, skipping`);
        continue;
      }

      // ── 2. Aggregate by year-month ────────────────────────────────────────
      // Filter out cancelled orders
      const validRows = orderRows.filter(r => {
        const status = (r.status || '').toLowerCase().trim();
        return status !== 'cancelled' && status !== 'canceled';
      });

      // Group by year-month
      const monthMap = {}; // key: "YYYY-MM" → { revenue, orderIds, units }

      for (const row of validRows) {
        const date = normalizeDate(row.date);
        if (!date) continue;
        const key = date.substring(0, 7); // "YYYY-MM"
        if (!key.match(/^\d{4}-\d{2}$/)) continue;

        if (!monthMap[key]) {
          monthMap[key] = { orderIds: new Set(), revenue: 0, units: 0 };
        }

        const orderId = (row.order_id || '').trim();
        const total   = parseFloat((row.order_total || '0').replace(/[$,]/g, '')) || 0;
        const units   = parseInt(row.unit_count, 10) || 0;

        // Sum order_total once per unique order_id (avoid double-counting multi-line orders)
        if (orderId && !monthMap[key].orderIds.has(orderId)) {
          monthMap[key].orderIds.add(orderId);
          monthMap[key].revenue += total;
        }
        monthMap[key].units += units;
      }

      if (!Object.keys(monthMap).length) {
        console.log(`[sync-walmart-revenue] ${brand.id} — no valid month data`);
        continue;
      }

      // ── 3. Read existing revenue rows for this brand ──────────────────────
      const tok = await ensureTab(REVENUE_SHEET_ID, brand.tabName, REVENUE_HEADERS);
      let existingRows = [];
      try {
        existingRows = await readRows(REVENUE_SHEET_ID, brand.tabName);
      } catch (e) { /* new tab, no rows yet */ }

      // Build existing map: "YYYY-MM" → row index
      const existingMap = {};
      existingRows.forEach(r => {
        const yr = String(r.YEAR  || r.year  || '').trim();
        const mo = String(r.MONTH || r.month || '').trim().padStart(2, '0');
        if (yr && mo) existingMap[`${yr}-${mo}`] = r;
      });

      // ── 4. Upsert — merge new aggregates into existing rows ───────────────
      // Start with all existing rows, then overwrite/add months we computed
      const mergedMap = { ...existingMap };
      for (const [key, data] of Object.entries(monthMap)) {
        const [yr, mo] = key.split('-');
        mergedMap[key] = {
          MONTH: parseInt(mo, 10),
          YEAR:  parseInt(yr, 10),
          REVENUE: Math.round(data.revenue * 100) / 100,
          ORDERS:  data.orderIds.size,
          UNITS:   data.units,
          last_updated: now,
        };
      }

      // Sort by year-month ascending
      const sortedKeys = Object.keys(mergedMap).sort();
      const newRows = sortedKeys.map(key => {
        const r = mergedMap[key];
        return [
          r.MONTH || r.month,
          r.YEAR  || r.year,
          r.REVENUE || r.revenue || 0,
          r.ORDERS  || r.orders  || 0,
          r.UNITS   || r.units   || 0,
          r.last_updated || now,
        ];
      });

      await replaceRows(REVENUE_SHEET_ID, brand.tabName, REVENUE_HEADERS, newRows, tok);
      console.log(`[sync-walmart-revenue] ${brand.id} — wrote ${newRows.length} months`);
      results.push({ brand: brand.id, months: newRows.length });

    } catch (err) {
      console.error(`[sync-walmart-revenue] ${brand.id} error:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  return res.status(200).json({ synced: results, timestamp: now });
};

// Normalize date to YYYY-MM-DD
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
