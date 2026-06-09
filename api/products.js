/**
 * api/products.js
 * GET /api/products?brand=evolis&year=2026&month=5&limit=10
 * Reads from Google Sheets (amazon-products) — no live SP-API calls.
 */

const { readRows } = require('./config/_sheets_client');
const sheets       = require('./config/sheets');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const brand = req.query.brand || 'evolis';
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);
    const limit = parseInt(req.query.limit || 10);

    const allRows = await readRows(sheets.products, brand);

    const products = allRows
      .filter(r => parseInt(r.year) === year && parseInt(r.month) === month)
      .sort((a, b) => parseInt(a.rank) - parseInt(b.rank))
      .slice(0, limit)
      .map(r => ({
        rank:           parseInt(r.rank),
        asin:           r.asin,
        sku:            r.sku,
        name:           r.name,
        unitsSold:      parseInt(r.units_sold   || 0),
        revenue:        parseFloat(r.revenue    || 0),
        conversionRate: r.conversion_rate ? parseFloat(r.conversion_rate) : null,
        lastUpdated:    r.last_updated,
      }));

    const reportDate = products[0]?.lastUpdated?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    res.status(200).json({ products, reportDate, source: 'google-sheets' });
  } catch (err) {
    console.error('[api/products]', err);
    res.status(500).json({ error: err.message });
  }
};
