/**
 * api/cron/dedup-orders.js
 * One-time cleanup — deduplicates all brand tabs in the amazon-orders sheet.
 * Keeps the row with the latest last_updated for each order_id.
 * Safe to run multiple times.
 *
 * GET /api/cron/dedup-orders
 * Authorization: Bearer <CRON_SECRET>
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'skus', 'brand', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token    = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const allRows  = await readRows(sheets.orders, brand.tabName);

      if (allRows.length === 0) {
        console.log(`[dedup-orders] ${brand.id} — 0 rows, skipping`);
        results.push({ brand: brand.id, before: 0, after: 0, removed: 0 });
        continue;
      }

      // Dedup: keep latest last_updated per order_id
      const orderMap = {};
      for (const row of allRows) {
        const id = row.order_id;
        if (!id) continue;
        if (!orderMap[id] || row.last_updated > orderMap[id].last_updated) {
          orderMap[id] = row;
        }
      }

      const dedupedRows = Object.values(orderMap);

      // Sort by date ascending, then order_id for consistency
      dedupedRows.sort((a, b) => {
        const dateCompare = (a.date || '').localeCompare(b.date || '');
        if (dateCompare !== 0) return dateCompare;
        return (a.order_id || '').localeCompare(b.order_id || '');
      });

      const before  = allRows.length;
      const after   = dedupedRows.length;
      const removed = before - after;

      // Convert back to arrays in HEADERS order
      const rowArrays = dedupedRows.map(row =>
        HEADERS.map(h => row[h] !== undefined ? row[h] : '')
      );

      await replaceRows(sheets.orders, brand.tabName, HEADERS, rowArrays, token);

      console.log(`[dedup-orders] ${brand.id} — ${before} → ${after} rows (removed ${removed} duplicates)`);
      results.push({ brand: brand.id, before, after, removed });

    } catch (err) {
      console.error(`[dedup-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const totalRemoved = results.reduce((s, r) => s + (r.removed || 0), 0);

  res.status(200).json({
    results,
    totalRemoved,
    timestamp: new Date().toISOString(),
  });
};
