/**
 * api/sales.js
 * GET /api/sales?year=2026&month=5
 */

const { spRequest } = require('./_spauth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);

    const [current, previous, monthly] = await Promise.all([
      fetchMonthMetrics(year, month),
      fetchMonthMetrics(...prevMonth(year, month)),
      fetchMonthlyTrend(year, month),
    ]);

    const mom = computeMOM(current, previous);
    res.status(200).json({ current, previous, mom, monthly });
  } catch (err) {
    console.error('[api/sales]', err);
    res.status(500).json({ error: err.message });
  }
};

async function fetchMonthMetrics(year, month) {
  const { start, end } = monthRange(year, month);
  const orders = await paginateOrders(start, end);

  if (orders.length === 0) return emptyMetrics(year, month);

  // Fetch all order items in batches of 5 to stay well under rate limits
  const itemBatches = await batchFetch(
    orders.map(o => o.AmazonOrderId),
    async (orderId) => {
      try {
        const resp = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`);
        return resp.payload?.OrderItems || [];
      } catch (e) {
        console.warn(`[sales] failed to fetch items for ${orderId}:`, e.message);
        return [];
      }
    },
    5
  );

  let totalUnits   = 0;
  let totalRevenue = 0;
  let adOrders     = 0;

  orders.forEach((order, i) => {
    const items = itemBatches[i] || [];

    totalUnits += items.reduce((sum, item) => sum + (item.QuantityOrdered || 0), 0);

    // Revenue: prefer OrderTotal on the order object, fall back to summing line items
    const orderTotal = parseFloat(order.OrderTotal?.Amount || 0);
    if (orderTotal > 0) {
      totalRevenue += orderTotal;
    } else {
      totalRevenue += items.reduce((sum, item) => {
        return sum + parseFloat(item.ItemPrice?.Amount || 0) * (item.QuantityOrdered || 1);
      }, 0);
    }

    if (isAdOrder(order)) adOrders++;
  });

  const totalOrders  = orders.length;
  const avgOrder     = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const organicUnits = Math.round(totalUnits * ((totalOrders - adOrders) / Math.max(totalOrders, 1)));
  const adUnits      = totalUnits - organicUnits;

  return { year, month, totalUnits, totalOrders, totalRevenue: round2(totalRevenue), avgOrder: round2(avgOrder), organicUnits, adUnits };
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
          // No OrderStatuses filter — get all orders, cancel client-side
        };

    const response = await spRequest('GET', '/orders/v0/orders', query);
    const batch    = response.payload?.Orders || [];
    orders.push(...batch);
    nextToken = response.payload?.NextToken || null;
    if (nextToken) await sleep(2000);
  } while (nextToken);

  return orders.filter(o => o.OrderStatus !== 'Canceled');
}

async function fetchMonthlyTrend(currentYear, currentMonth) {
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const [y, m] = prevMonthN(currentYear, currentMonth, i);
    months.push({ year: y, month: m });
  }

  const revenues = [];
  for (const { year, month } of months) {
    try {
      revenues.push(await fetchMonthRevenue(year, month));
    } catch {
      revenues.push(0);
    }
    await sleep(500);
  }

  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months.map(({ year, month }, i) => ({ label: labels[month - 1], year, month, revenue: revenues[i] }));
}

async function fetchMonthRevenue(year, month) {
  const { start, end } = monthRange(year, month);
  const orders = await paginateOrders(start, end);
  return round2(orders.reduce((sum, o) => sum + parseFloat(o.OrderTotal?.Amount || 0), 0));
}

function monthRange(year, month) {
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return { start: `${year}-${pad(month)}-01T00:00:00Z`, end: `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z` };
}
function prevMonth(year, month) { return month === 1 ? [year - 1, 12] : [year, month - 1]; }
function prevMonthN(year, month, n) { let y = year, m = month; for (let i = 0; i < n; i++) [y, m] = prevMonth(y, m); return [y, m]; }
function computeMOM(current, previous) {
  if (!previous || previous.totalOrders === 0) return null;
  const pct = (cur, prev) => prev === 0 ? null : round2(((cur - prev) / prev) * 100);
  return { units: pct(current.totalUnits, previous.totalUnits), orders: pct(current.totalOrders, previous.totalOrders), revenue: pct(current.totalRevenue, previous.totalRevenue), avgOrder: pct(current.avgOrder, previous.avgOrder), organicUnits: pct(current.organicUnits, previous.organicUnits), adUnits: pct(current.adUnits, previous.adUnits) };
}
function emptyMetrics(year, month) { return { year, month, totalUnits: 0, totalOrders: 0, totalRevenue: 0, avgOrder: 0, organicUnits: 0, adUnits: 0 }; }
function isAdOrder(order) { return Array.isArray(order.PromotionIds) && order.PromotionIds.length > 0; }
async function batchFetch(ids, fetchFn, batchSize) {
  const results = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batchResults = await Promise.all(ids.slice(i, i + batchSize).map(fetchFn));
    results.push(...batchResults);
    if (i + batchSize < ids.length) await sleep(2000);
  }
  return results;
}
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
