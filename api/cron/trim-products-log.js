/**
 * api/cron/trim-products-log.js
 * Daily — drops rows from SHEET_PRODUCTS older than 2 years, so the
 * daily inventory/listing log (sync-products.js) doesn't grow forever.
 *
 * At current column count (27) and realistic daily SKU volume across all
 * brands, 2 years of history sits comfortably under Google Sheets' 10M
 * cell ceiling for the whole spreadsheet — see the math worked through
 * with Jaclyn on 2026-07-09. Adjust RETENTION_DAYS if that changes.
 *
 * Mirrors trim-orders.js's approach: read each brand tab, keep only rows
 * within the retention window, replaceRows.
 *
 * Runs once daily, after sync-products.js's window would reasonably be
 * complete for the day.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');

const RETENTION_DAYS = 730; // 2 years

const HEADERS = [
  'date', 'sku', 'asin',
  'fulfillable_quantity', 'reserved_quantity', 'inbound_working_quantity',
  'inbound_shipped_quantity', 'inbound_receiving_quantity',
  'unfulfillable_quantity', 'total_quantity',
  'name', 'status', 'sales_ranks', 'title', 'item_highlights',
  'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5',
  'description', 'backend_keywords', 'ingredients', 'item_type_keyword',
  'offers', 'issues', 'last_synced',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token = await ensureTab(sheets.products, brand.tabName, HEADERS);
      const rows  = await readRows(sheets.products, brand.tabName);

      const before = rows.length;
      const kept   = rows.filter(r => (r.date || '') >= cutoffStr);
      const after  = kept.length;

      if (after < before) {
        const rowArrays = kept.map(r => HEADERS.map(h => r[h] ?? ''));
        await replaceRows(sheets.products, brand.tabName, HEADERS, rowArrays, token);
        console.log(`[trim-products-log] ${brand.id} — trimmed ${before - after} rows (${before} → ${after})`);
      }

      results.push({ brand: brand.id, before, after, trimmed: before - after });
    } catch (err) {
      console.error(`[trim-products-log] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ results, cutoffDate: cutoffStr, timestamp: new Date().toISOString() });
};
