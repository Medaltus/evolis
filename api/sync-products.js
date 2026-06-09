/**
 * api/cron/sync-products.js
 * Nightly cron — syncs Amazon top products to Google Sheets.
 * Runs at 2:30 AM UTC.
 *
 * Sheet: amazon-products
 * Columns: year, month, rank, asin, sku, name,
 *          units_sold, revenue, brand, last_updated
 */

const { spRequest }                              = require('../_spauth');
const { ensureTab, replaceRows, getSheetsToken } = require('../config/_sheets_client');
const brands                                     = require('../config/brands');
const sheets                                     = require('../config/sheets');

const HEADERS = [
  'year', 'month', 'rank', 'asin', 'sku', 'name',
  'units_sold', 'revenue', 'brand', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      console.log(`[sync-products] starting ${brand.id}`);
      const rows  = await fetchProductRows(brand);
      const token = await ensureTab(sheets.products, brand.tabName, HEADERS);
      await replaceRows(sheets.products, brand.tabName, HEADERS, rows, token);
      results.push({ brand: brand.id, status: 'ok', rows: rows.length });
      console.log(`[sync-products] ${brand.id} — ${rows.length} rows written`);
    } catch (err) {
      console.error(`[sync-products] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: new Date().toISOString() });
};

async function fetchProductRows(brand) {
  const rows   = [];
  const months = rollingMonths(13);
  const now    = new Date().toISOString();

  for (const { year, month, start, end } of months) {
    const orders = await paginateOrders(start, end);
    if (orders.length === 0) continue;

    // Aggregate by ASIN across all orders for this month
    const asinMap = {};

    for (let i = 0; i < orders.length; i += 5) {
      const batch = orders.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async order => {
          try {
            const resp = await spRequest('GET', `/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
            return resp.payload?.OrderItems || [];
          } catch {
            return [];
          }
        })
      );

      results.flat()
        .filter(item => (item.SellerSKU || '').toUpperCase().startsWith(brand.skuPrefix.toUpperCase()))
        .forEach(item => {
          const asin = item.ASIN;
          if (!asin) return;
          if (!asinMap[asin]) {
            asinMap[asin] = { asin, sku: item.SellerSKU || '', name: item.Title || asin, units: 0, revenue: 0 };
          }
          asinMap[asin].units   += item.QuantityOrdered || 0;
          asinMap[asin].revenue  = round2(
            asinMap[asin].revenue + parseFloat(item.ItemPrice?.Amount || 0) * (item.QuantityOrdered || 1)
          );
        });

      if (i + 5 < orders.length) await sleep(2000);
    }

    // Sort by units, assign rank
    Object.values(asinMap)
      .filter(p => p.units > 0)
      .sort((a, b) => b.units - a.units)
      .forEach((p, idx) => {
        rows.push([
          year, month, idx + 1, p.asin, p.sku, p.name,
          p.units, p.revenue, brand.id, now,
        ]);
      });

    await sleep(1000);
  }

  return rows;
}

async function paginateOrders(start, end) {
  const orders  = [];
  let nextToken = null;
  do {
    const query = nextToken
      ? { NextToken: nextToken }
      : { MarketplaceIds: process.env.SP_MARKETPLACE_ID, CreatedAfter: start, CreatedBefore: end, MaxResultsPerPage: '100' };
    const response = await spRequest('GET', '/orders/v0/orders', query);
    orders.push(...(response.payload?.Orders || []));
    nextToken = response.payload?.NextToken || null;
    if (nextToken) await sleep(2000);
  } while (nextToken);
  return orders.filter(o => o.OrderStatus !== 'Canceled');
}

function rollingMonths(n) {
  const months = [];
  const now    = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d       = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year    = d.getFullYear();
    const month   = d.getMonth() + 1;
    const pad     = x => String(x).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    months.push({ year, month, start: `${year}-${pad(month)}-01T00:00:00Z`, end: `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z` });
  }
  return months;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
