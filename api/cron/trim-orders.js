/**
 * api/cron/trim-orders.js
 * Runs daily — removes rows older than 90 days from all brand tabs
 * in the rolling amazon-orders sheet.
 *
 * Keeps the sheet lean for fast reads while retaining enough history
 * for current month + 2 full prior months (MOM trending).
 * YOY data lives in sheets.ordersHistorical.
 *
 * Schedule: daily at 3AM UTC ("0 3 * * *")
 *
 * GET /api/cron/trim-orders
 * Authorization: Bearer <CRON_SECRET>
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
];

const RETENTION_DAYS = 90;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff    = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  console.log(`[trim-orders] trimming rows before ${cutoffStr}`);

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token   = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const allRows = await readRows(sheets.orders, brand.tabName);

      if (allRows.length === 0) {
        results.push({ brand: brand.id, before: 0, after: 0, trimmed: 0 });
        continue;
      }

      const kept    = allRows.filter(r => (r.date || '') >= cutoffStr);
      const trimmed = allRows.length - kept.length;

      if (trimmed === 0) {
        console.log(`[trim-orders] ${brand.id} — nothing to trim`);
        results.push({ brand: brand.id, before: allRows.length, after: kept.length, trimmed: 0 });
        continue;
      }

      // Sort by date asc, then order_id for consistency
      kept.sort((a, b) => {
        const d = (a.date || '').localeCompare(b.date || '');
        return d !== 0 ? d : (a.order_id || '').localeCompare(b.order_id || '');
      });

      const rowArrays = kept.map(row => HEADERS.map(h => row[h] !== undefined ? row[h] : ''));
      await replaceRows(sheets.orders, brand.tabName, HEADERS, rowArrays, token);

      console.log(`[trim-orders] ${brand.id} — trimmed ${trimmed} rows (${allRows.length} → ${kept.length})`);
      results.push({ brand: brand.id, before: allRows.length, after: kept.length, trimmed });

    } catch (err) {
      console.error(`[trim-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const totalTrimmed = results.reduce((s, r) => s + (r.trimmed || 0), 0);

  res.status(200).json({
    cutoff: cutoffStr,
    results,
    totalTrimmed,
    timestamp: new Date().toISOString(),
  });
};
