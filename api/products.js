/**
 * api/products.js
 * GET /api/products?brand=evolis&year=2026&month=5&limit=10
 *
 * Reads from amazon-orders-historical sheet, explodes the comma-separated
 * `skus` column per order, aggregates units and revenue by SKU, and returns
 * ranked top products for the requested month.
 *
 * Response shape:
 * {
 *   products: [
 *     { rank, sku, asin, name, unitsSold, revenue, conversionRate }
 *   ],
 *   source: "orders-sheet",
 *   reportDate: "2026-05-31"
 * }
 *
 * Notes:
 * - Each order row has `skus` (comma list) and `quantity_ordered` / `order_total`.
 *   When an order has multiple SKUs we split units/revenue evenly across SKUs
 *   since the flat file doesn't provide per-SKU breakdown within an order.
 * - conversionRate is null — not available from order data alone.
 */
const { readRows } = require('./config/_sheets_client');
const sheets       = require('./config/sheets');

// Optional: map known SKU prefixes/patterns to display names.
// Extend this or replace with a lookup sheet as catalog grows.
const SKU_NAME_MAP = {};  // e.g. { 'EVO0011': 'Reverse Shampoo' }

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const brand = req.query.brand || 'evolis';
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);
    const limit = parseInt(req.query.limit || 10);

    const allRows = await readRows(sheets.ordersHistorical, brand);

    // Filter to requested month, exclude cancelled
    const filtered = allRows.filter(r => {
      const d = r.date || '';
      return (
        parseInt(d.slice(0, 4)) === year &&
        parseInt(d.slice(5, 7)) === month &&
        (r.status || '').toLowerCase() !== 'cancelled'
      );
    });

    // Build per-SKU aggregation
    const skuMap = {};

    for (const row of filtered) {
      const skuList  = (row.skus  || '').split(',').map(s => s.trim()).filter(Boolean);
      const asinList = (row.asin  || '').split(',').map(s => s.trim()).filter(Boolean);
      const units    = parseInt(row.quantity_ordered) || 0;
      const revenue  = parseFloat(row.order_total)    || 0;

      if (skuList.length === 0) continue;

      // Split evenly across SKUs in this order
      const unitsPerSku   = units   / skuList.length;
      const revenuePerSku = revenue / skuList.length;

      skuList.forEach((sku, idx) => {
        if (!skuMap[sku]) {
          skuMap[sku] = {
            sku,
            asin:      asinList[idx] || '',
            unitsSold: 0,
            revenue:   0,
            orders:    0,
          };
        }
        skuMap[sku].unitsSold += unitsPerSku;
        skuMap[sku].revenue   += revenuePerSku;
        skuMap[sku].orders    += 1;
      });
    }

    // Sort by units descending
    const sorted = Object.values(skuMap)
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .slice(0, limit);

    const products = sorted.map((p, i) => ({
      rank:           i + 1,
      sku:            p.sku,
      asin:           p.asin || null,
      name:           SKU_NAME_MAP[p.sku] || p.sku,  // use SKU until name map populated
      unitsSold:      Math.round(p.unitsSold),
      revenue:        round2(p.revenue),
      conversionRate: null,   // not available from order data
    }));

    // Last day of the month as reportDate
    const lastDay   = new Date(year, month, 0).getDate();
    const reportDate = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

    res.status(200).json({
      products,
      source:     'orders-sheet',
      reportDate,
      brand,
      year,
      month,
      totalSkus: Object.keys(skuMap).length,
    });
  } catch (err) {
    console.error('[api/products]', err);
    res.status(500).json({ error: err.message });
  }
};

const round2 = n => Math.round(n * 100) / 100;
