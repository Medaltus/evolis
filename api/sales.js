/**
 * api/sales.js
 * GET /api/sales?year=2026&month=5
 *
 * Returns order-level sales metrics for the requested month and the
 * prior month so the frontend can compute MOM deltas.
 *
 * SP-API endpoints used:
 *   GET /orders/v0/orders               — order list + financial totals
 *   GET /orders/v0/orders/{id}/items    — line items for unit counts
 *
 * Response shape:
 * {
 *   current:  { month, year, totalUnits, totalOrders, totalRevenue, avgOrder, organicUnits, adUnits }
 *   previous: { month, year, totalUnits, totalOrders, totalRevenue, avgOrder, organicUnits, adUnits }
 *   mom: { units, orders, revenue, avgOrder, organicUnits, adUnits }   ← % change, null if no prior data
 *   monthly:  [ { month: 'Jan', revenue: 6800 }, ... ]                 ← last 12 months for chart
 * }
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

// ─── Fetch all orders + items for a given month ───────────────────────────────

async function fetchMonthMetrics(year, month) {
  const { start, end } = monthRange(year, month);

  // Paginate through all orders in the month
  const orders = await paginateOrders(start, end);

  if (orders.length === 0) {
    return emptyMetrics(year, month);
  }

  // Fetch line items in parallel (batches of 10 to avoid rate limits)
  const itemResults = await batchFetch(orders.map(o => o.AmazonOrderId), fetchOrderItems, 10);

  let totalUnits = 0;
  let totalRevenue = 0;
  let adOrders = 0;

  orders.forEach((order, i) => {
    const items = itemResults[i] || [];
    const units = items.reduce((sum, item) => sum + (item.QuantityOrdered || 0), 0);
    totalUnits += units;

    const orderTotal = parseFloat(order.OrderTotal?.Amount || 0);
    totalRevenue += orderTotal;

    // Heuristic: orders with a PromotionIds field or channel = 'Sponsored' are ad-driven.
    // SP-API doesn't expose this directly — we tag based on SalesChannel and BuyerInfo.
    if (isAdOrder(order)) adOrders++;
  });

  const totalOrders = orders.length;
  const avgOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const organicUnits = Math.round(totalUnits * ((totalOrders - adOrders) / totalOrders));
  const adUnits = totalUnits - organicUnits;

  return {
    year, month,
    totalUnits,
    totalOrders,
    totalRevenue: round2(totalRevenue),
    avgOrder: round2(avgOrder),
    organicUnits,
    adUnits,
  };
}

async function paginateOrders(start, end) {
  const orders = [];
  let nextToken = null;

  do {
    const query = nextToken
      ? { NextToken: nextToken }
      : {
          MarketplaceIds: process.env.SP_MARKETPLACE_ID,
          CreatedAfter: start,
          CreatedBefore: end,
          OrderStatuses: 'Shipped,Unshipped,PartiallyShipped,Canceled',
          MaxResultsPerPage: '100',
        };

    const response = await spRequest('GET', '/orders/v0/orders', query);
    const batch = response.payload?.Orders || [];
    orders.push(...batch);
    nextToken = response.payload?.NextToken || null;
  } while (nextToken);

  return orders;
}

async function fetchOrderItems(orderId) {
  const response = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`);
  return response.payload?.OrderItems || [];
}

// ─── 12-month rolling trend for chart ────────────────────────────────────────

async function fetchMonthlyTrend(currentYear, currentMonth) {
  const months = [];
  for (let i = 11; i >= 0; i--) {
    let [y, m] = prevMonthN(currentYear, currentMonth, i);
    months.push({ year: y, month: m });
  }

  // Fetch in parallel — SP-API allows ~10 rps per account
  const results = await Promise.all(
    months.map(({ year, month }) => fetchMonthRevenue(year, month))
  );

  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return results.map((rev, i) => ({
    label: labels[months[i].month - 1],
    year: months[i].year,
    month: months[i].month,
    revenue: rev,
  }));
}

async function fetchMonthRevenue(year, month) {
  const { start, end } = monthRange(year, month);
  const orders = await paginateOrders(start, end);
  return round2(orders.reduce((sum, o) => sum + parseFloat(o.OrderTotal?.Amount || 0), 0));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthRange(year, month) {
  const pad = n => String(n).padStart(2, '0');
  const start = `${year}-${pad(month)}-01T00:00:00Z`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z`;
  return { start, end };
}

function prevMonth(year, month) {
  if (month === 1) return [year - 1, 12];
  return [year, month - 1];
}

function prevMonthN(year, month, n) {
  let y = year, m = month;
  for (let i = 0; i < n; i++) [y, m] = prevMonth(y, m);
  return [y, m];
}

function computeMOM(current, previous) {
  if (!previous || previous.totalOrders === 0) return null;
  const pct = (cur, prev) => prev === 0 ? null : round2(((cur - prev) / prev) * 100);
  return {
    units:        pct(current.totalUnits,    previous.totalUnits),
    orders:       pct(current.totalOrders,   previous.totalOrders),
    revenue:      pct(current.totalRevenue,  previous.totalRevenue),
    avgOrder:     pct(current.avgOrder,      previous.avgOrder),
    organicUnits: pct(current.organicUnits,  previous.organicUnits),
    adUnits:      pct(current.adUnits,       previous.adUnits),
  };
}

function emptyMetrics(year, month) {
  return { year, month, totalUnits: 0, totalOrders: 0, totalRevenue: 0, avgOrder: 0, organicUnits: 0, adUnits: 0 };
}

function isAdOrder(order) {
  // SP-API doesn't expose ad attribution directly on the order object.
  // The most reliable approach is to cross-reference with the Advertising API
  // attribution report. Here we use a lightweight proxy: orders originating
  // from the 'Amazon.com' channel with a non-null PromotionIds field are
  // treated as ad-influenced. Refine this logic once Attribution API is wired in.
  return Array.isArray(order.PromotionIds) && order.PromotionIds.length > 0;
}

async function batchFetch(ids, fetchFn, batchSize) {
  const results = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fetchFn));
    results.push(...batchResults);
    if (i + batchSize < ids.length) await sleep(1000); // respect rate limits
  }
  return results;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;
