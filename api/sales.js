/**
 * api/sales.js
 * GET /api/sales?brand=evolis&year=2026&month=6
 *
 * Data sources:
 *   sheets.orders           — rolling 90 days  → current month + MOM
 *   sheets.ordersHistorical — 18 months        → YOY (same month last year)
 *
 * Response shape:
 * {
 *   current:  { year, month, totalOrders, totalUnits, totalRevenue, avgOrder, organicOrders, adOrders, organicUnits, adUnits }
 *   previous: { ...same, year/month = prior month }
 *   yoy:      { ...same, year/month = same month last year } | null
 *   mom:      { units, orders, revenue, avgOrder } | null   (% change current vs previous)
 *   yoyChange:{ units, orders, revenue, avgOrder } | null   (% change current vs yoy)
 *   monthly:  [ { label, year, month, revenue, orders, units } ]  (last 12 months)
 * }
 *
 * Column names written by sync-orders.js:
 *   order_id, date, status, order_total, promotion_ids, is_premium_order,
 *   promotion_discount, item_price, quantity_ordered, quantity_shipped,
 *   unit_count, skus, brand, last_updated
 */

const { readRows } = require('./config/_sheets_client');
const sheets       = require('./config/sheets');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const brand = req.query.brand || 'evolis';
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);

    // Read both sheets in parallel
    const [rollingRows, historicalRows] = await Promise.all([
      readRows(sheets.orders, brand),
      readRows(sheets.ordersHistorical, brand).catch(() => []), // graceful fallback if sheet missing
    ]);

    // Current month — from rolling sheet
    const current = aggregateMonth(rollingRows, year, month);

    // Prior month — from rolling sheet (within 90-day window)
    const [py, pm] = prevMonth(year, month);
    const previous = aggregateMonth(rollingRows, py, pm);

    // Same month last year — from historical sheet
    const yoy = aggregateMonth(historicalRows, year - 1, month);

    // MOM % change (current vs previous)
    const mom = computeChange(current, previous);

    // YOY % change (current vs same month last year)
    const yoyChange = yoy && yoy.totalOrders > 0 ? computeChange(current, yoy) : null;

    // 12-month revenue trend — blend rolling + historical
    const monthly = buildMonthlyTrend(rollingRows, historicalRows, year, month);

    res.status(200).json({ current, previous, yoy, mom, yoyChange, monthly });
  } catch (err) {
    console.error('[api/sales]', err);
    res.status(500).json({ error: err.message });
  }
};

// ── Aggregation ───────────────────────────────────────────────────────────────

function aggregateMonth(rows, year, month) {
  const filtered = rows.filter(r => {
    const d = r.date || '';
    return (
      parseInt(d.slice(0, 4)) === year &&
      parseInt(d.slice(5, 7)) === month &&
      (r.status || '').toLowerCase() !== 'cancelled'
    );
  });

  if (filtered.length === 0) return emptyMetrics(year, month);

  const totalOrders  = filtered.length;
  const totalUnits   = filtered.reduce((s, r) => s + (parseInt(r.quantity_ordered)  || 0), 0);
  const totalRevenue = filtered.reduce((s, r) => s + (parseFloat(r.order_total)     || 0), 0);
  const avgOrder     = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  // Ad proxy: orders with any promotion_ids (Subscribe & Save, coupons, etc.)
  const adOrders      = filtered.filter(r => (r.promotion_ids || '').trim() !== '').length;
  const organicOrders = totalOrders - adOrders;

  // Apportion units proportionally
  const adUnits      = Math.round(totalUnits * (adOrders / Math.max(totalOrders, 1)));
  const organicUnits = totalUnits - adUnits;

  return {
    year,
    month,
    totalOrders,
    totalUnits,
    totalRevenue:   round2(totalRevenue),
    avgOrder:       round2(avgOrder),
    adOrders,
    organicOrders,
    adUnits,
    organicUnits,
  };
}

// ── Monthly trend (last 12 months) ───────────────────────────────────────────
// Blends rolling sheet (recent months) with historical sheet (older months).
// Rolling sheet takes precedence when both have data for the same month.

function buildMonthlyTrend(rollingRows, historicalRows, currentYear, currentMonth) {
  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const trend  = [];

  for (let i = 11; i >= 0; i--) {
    const [y, m] = prevMonthN(currentYear, currentMonth, i);

    const fromRolling    = aggregateMonth(rollingRows,    y, m);
    const fromHistorical = aggregateMonth(historicalRows, y, m);

    // Rolling takes precedence; fall back to historical for older months
    const agg = fromRolling.totalOrders > 0 ? fromRolling : fromHistorical;

    trend.push({
      label:   labels[m - 1],
      year:    y,
      month:   m,
      revenue: agg.totalRevenue,
      orders:  agg.totalOrders,
      units:   agg.totalUnits,
    });
  }

  return trend;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prevMonth(year, month) {
  return month === 1 ? [year - 1, 12] : [year, month - 1];
}

function prevMonthN(year, month, n) {
  let y = year, m = month;
  for (let i = 0; i < n; i++) [y, m] = prevMonth(y, m);
  return [y, m];
}

function computeChange(cur, prev) {
  if (!prev || prev.totalOrders === 0) return null;
  const pct = (a, b) => b === 0 ? null : round2(((a - b) / b) * 100);
  return {
    units:    pct(cur.totalUnits,    prev.totalUnits),
    orders:   pct(cur.totalOrders,   prev.totalOrders),
    revenue:  pct(cur.totalRevenue,  prev.totalRevenue),
    avgOrder: pct(cur.avgOrder,      prev.avgOrder),
  };
}

function emptyMetrics(year, month) {
  return {
    year, month,
    totalOrders: 0, totalUnits: 0, totalRevenue: 0, avgOrder: 0,
    adOrders: 0, organicOrders: 0, adUnits: 0, organicUnits: 0,
  };
}

const round2 = n => Math.round(n * 100) / 100;
