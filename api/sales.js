/**
 * api/sales.js
 * GET /api/sales?brand=evolis&year=2026&month=5
 * Reads from Google Sheets (amazon-orders) — no live SP-API calls.
 */

const { readRows } = require('./config/_sheets_client');
const sheets       = require('./config/sheets');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const brand = req.query.brand || 'evolis';
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);

    const allRows = await readRows(sheets.orders, brand);

    const current  = aggregateMonth(allRows, year, month);
    const [py, pm] = prevMonth(year, month);
    const previous = aggregateMonth(allRows, py, pm);
    const mom      = computeMOM(current, previous);
    const monthly  = buildMonthlyTrend(allRows, year, month);

    res.status(200).json({ current, previous, mom, monthly });
  } catch (err) {
    console.error('[api/sales]', err);
    res.status(500).json({ error: err.message });
  }
};

function aggregateMonth(rows, year, month) {
  const filtered = rows.filter(r =>
    parseInt(r.year || extractYear(r.date))  === year &&
    parseInt(r.month || extractMonth(r.date)) === month
  );

  if (filtered.length === 0) return emptyMetrics(year, month);

  const totalOrders  = filtered.length;
  const totalUnits   = filtered.reduce((s, r) => s + parseInt(r.unit_count  || 0), 0);
  const totalRevenue = filtered.reduce((s, r) => s + parseFloat(r.total_revenue || 0), 0);
  const adOrders     = filtered.filter(r => r.is_ad_order === 'TRUE').length;
  const avgOrder     = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const organicUnits = Math.round(totalUnits * ((totalOrders - adOrders) / Math.max(totalOrders, 1)));
  const adUnits      = totalUnits - organicUnits;

  return { year, month, totalUnits, totalOrders, totalRevenue: round2(totalRevenue), avgOrder: round2(avgOrder), organicUnits, adUnits };
}

function buildMonthlyTrend(rows, currentYear, currentMonth) {
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const [y, m] = prevMonthN(currentYear, currentMonth, i);
    months.push({ year: y, month: m });
  }
  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months.map(({ year, month }) => {
    const agg = aggregateMonth(rows, year, month);
    return { label: labels[month - 1], year, month, revenue: agg.totalRevenue };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractYear(dateStr)  { return dateStr ? parseInt(dateStr.slice(0, 4)) : 0; }
function extractMonth(dateStr) { return dateStr ? parseInt(dateStr.slice(5, 7)) : 0; }
function prevMonth(year, month) { return month === 1 ? [year - 1, 12] : [year, month - 1]; }
function prevMonthN(year, month, n) { let y = year, m = month; for (let i = 0; i < n; i++) [y, m] = prevMonth(y, m); return [y, m]; }
function computeMOM(cur, prev) {
  if (!prev || prev.totalOrders === 0) return null;
  const pct = (a, b) => b === 0 ? null : round2(((a - b) / b) * 100);
  return { units: pct(cur.totalUnits, prev.totalUnits), orders: pct(cur.totalOrders, prev.totalOrders), revenue: pct(cur.totalRevenue, prev.totalRevenue), avgOrder: pct(cur.avgOrder, prev.avgOrder), organicUnits: pct(cur.organicUnits, prev.organicUnits), adUnits: pct(cur.adUnits, prev.adUnits) };
}
function emptyMetrics(year, month) { return { year, month, totalUnits: 0, totalOrders: 0, totalRevenue: 0, avgOrder: 0, organicUnits: 0, adUnits: 0 }; }
const round2 = n => Math.round(n * 100) / 100;
