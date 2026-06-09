/**
 * api/products.js
 * GET /api/products?year=2026&month=5&limit=10
 */

const { spRequest } = require('./_spauth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);
    const limit = parseInt(req.query.limit || 10);

    const result = await fetchViaOrders(year, month, limit);
    res.status(200).json(result);
  } catch (err) {
    console.error('[api/products]', err);
    res.status(500).json({ error: err.message });
  }
};

async function fetchViaOrders(year, month, limit) {
  const { start, end } = monthRange(year, month);
  const orders = await paginateOrders(start, end);

  if (orders.length === 0) {
    return { products: [], reportDate: end.slice(0, 10), source: 'order-aggregation' };
  }

  console.log(`[products] fetching items for ${orders.length} orders`);

  // Fetch items in small batches with delays to respect SP-API rate limits
  const asinMap = {};

  for (let i = 0; i < orders.length; i += 5) {
    const batch = orders.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (order) => {
        try {
          const resp = await spRequest('GET', `/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
          return resp.payload?.OrderItems || [];
        } catch (e) {
          console.warn(`[products] items fetch failed for ${order.AmazonOrderId}:`, e.message);
          return [];
        }
      })
    );

    results.flat().forEach(item => {
      const asin = item.ASIN;
      if (!asin) return;
      if (!asinMap[asin]) {
        asinMap[asin] = {
          asin,
          name:       item.Title || asin,
          unitsSold:  0,
          revenue:    0,
          sessions:   null,
          conversionRate: null,
        };
      }
      asinMap[asin].unitsSold += item.QuantityOrdered || 0;
      asinMap[asin].revenue    = round2(
        asinMap[asin].revenue + parseFloat(item.ItemPrice?.Amount || 0) * (item.QuantityOrdered || 1)
      );
    });

    // Pause between batches to stay under rate limits
    if (i + 5 < orders.length) await sleep(2000);
  }

  const products = Object.values(asinMap)
    .filter(p => p.unitsSold > 0)
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, ...p }));

  return { products, reportDate: end.slice(0, 10), source: 'order-aggregation' };
}

async function paginateOrders(start, end) {
  const orders  = [];
  let nextToken = null;

  do {
    const query = nextToken
      ? { NextToken: nextToken }
      : {
          MarketplaceIds:    process.env.SP_MARKETPLACE_ID,
          CreatedAfter:      start,
          CreatedBefore:     end,
          MaxResultsPerPage: '100',
        };

    const response = await spRequest('GET', '/orders/v0/orders', query);
    const batch    = response.payload?.Orders || [];
    orders.push(...batch);
    nextToken = response.payload?.NextToken || null;
    if (nextToken) await sleep(2000);
  } while (nextToken);

  return orders.filter(o => o.OrderStatus !== 'Canceled');
}

function monthRange(year, month) {
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return { start: `${year}-${pad(month)}-01T00:00:00Z`, end: `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z` };
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
