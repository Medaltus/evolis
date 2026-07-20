/**
 * api/cron/sync-fulfillment-kpis.js
 * Computes the three data-driven numbers for the Fulfillment page's top
 * KPI row (the other two cards — "Our Fulfillment Promise" and
 * "Inventory Prepped" — are hardcoded/paused, no cron needed for them):
 *   - Shipped orders, last 30 days      → simple count
 *   - Avg shipping cost, last 7 days    → shipmentCost is on the
 *                                          shipment object directly
 *   - Avg processing time, last 7 days  → order date → ship date, in
 *                                          business days (weekends
 *                                          excluded)
 *
 * NOT adapted from any VBC reference file — that project computes these
 * live via its own /api/fulfillment endpoint (source not available, and
 * a live-pull architecture is the opposite of what's wanted here anyway).
 * This is new logic, written from ShipStation's documented API schema.
 *
 * WHY PROCESSING TIME NEEDS TWO ENDPOINTS, NOT ONE: confirmed via
 * ShipStation's own API docs — /shipments returns shipDate and
 * shipmentCost directly, but NOT the original order date (only
 * createDate, which is when the ShipStation shipment record itself was
 * created, not when the customer placed the order). The real order date
 * lives on /orders. So this fetches shipments for the 7-day window, then
 * separately fetches orders for a WIDER window (14 days before the
 * shipment window's start, through its end — buffer for orders that took
 * a few days to ship) and joins the two by orderId.
 *
 * This join is UNVERIFIED against live data — use ?debug=true first
 * (returns the raw joined per-shipment records instead of writing
 * anything) to confirm the numbers look sane before trusting the average.
 *
 * Sheet: SHEET_FULFILLMENT_DAILY_SHIPMENTS, tab "_kpis" (same sheet the
 * daily-shipments cron uses — no new sheet needed for 3 numbers).
 * Columns: metric, value, updated_at
 *
 * Manual:
 *   GET /api/cron/sync-fulfillment-kpis
 *   GET /api/cron/sync-fulfillment-kpis?debug=true
 */

const { ssFetch }                          = require('../_ss');
const { ensureTab, replaceRows }           = require('../config/_sheets_client');
const sheets                                = require('../config/sheets');

const KPI_TAB = '_kpis';
const HEADERS = ['metric', 'value', 'updated_at'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.fulfillmentDailyShipments) return res.status(500).json({ error: 'sheets.fulfillmentDailyShipments is not configured in config/sheets.js' });

  const debug = req.query.debug === 'true';
  const now = new Date();
  const fmt = d => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

  const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
  const d7  = new Date(now); d7.setDate(d7.getDate() - 7);
  const d21 = new Date(now); d21.setDate(d21.getDate() - 21); // 14-day buffer before the 7-day window's start

  try {
    // ── 1. Shipped orders, last 30 days ──────────────────────────────────
    const shippedCount30d = await countShipments(fmt(d30), fmt(now));

    // ── 2. Shipments in the 7-day window (for cost avg + the join) ──────
    const shipments7d = await fetchAllShipments(fmt(d7), fmt(now));
    const avgShippingCost = shipments7d.length
      ? round2(shipments7d.reduce((s, x) => s + (x.shipmentCost || 0), 0) / shipments7d.length)
      : null;

    // ── 3. Orders in the wider window, for the orderId → orderDate join ─
    const orders = await fetchAllOrders(fmt(d21), fmt(now));
    const orderDateById = {};
    orders.forEach(o => { orderDateById[o.orderId] = o.orderDate; });

    const joined = shipments7d
      .map(s => ({
        orderId: s.orderId,
        shipDate: s.shipDate,
        orderDate: orderDateById[s.orderId] || null,
      }))
      .filter(x => x.orderDate); // drop shipments whose order fell outside the buffered window — see debug output if this drops a lot

    const businessDaysList = joined.map(x => businessDaysBetween(new Date(x.orderDate), new Date(x.shipDate)));
    const avgProcessingTime = businessDaysList.length
      ? round2(businessDaysList.reduce((s, v) => s + v, 0) / businessDaysList.length)
      : null;

    if (debug) {
      return res.status(200).json({
        debug: true,
        shippedCount30d,
        shipments7dCount: shipments7d.length,
        ordersFetchedCount: orders.length,
        joinedCount: joined.length,
        droppedForMissingOrderDate: shipments7d.length - joined.length,
        sampleJoinedRows: joined.slice(0, 10),
        avgShippingCost,
        avgProcessingTime,
        note: 'Check droppedForMissingOrderDate — if it is most/all of shipments7dCount, the 14-day buffer window is too narrow, or orderId matching is failing.',
      });
    }

    const nowIso = new Date().toISOString();
    const rows = [
      ['shipped_orders_30d', shippedCount30d, nowIso],
      ['avg_shipping_cost_7d', avgShippingCost ?? '', nowIso],
      ['avg_processing_time_7d', avgProcessingTime ?? '', nowIso],
    ];

    const token = await ensureTab(sheets.fulfillmentDailyShipments, KPI_TAB, HEADERS);
    await replaceRows(sheets.fulfillmentDailyShipments, KPI_TAB, HEADERS, rows, token);

    console.log(`[sync-fulfillment-kpis] shipped30d=${shippedCount30d} avgCost7d=${avgShippingCost} avgProcTime7d=${avgProcessingTime}`);
    res.status(200).json({ shippedCount30d, avgShippingCost, avgProcessingTime });
  } catch (err) {
    console.error('[sync-fulfillment-kpis]', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function countShipments(startParam, endParam) {
  let total = 0, page = 1, hasMore = true, apiTotal = null;
  while (hasMore) {
    const data = await ssFetch(`/shipments?shipmentStatus=shipped&pageSize=500&page=${page}&shipDateStart=${encodeURIComponent(startParam)}&shipDateEnd=${encodeURIComponent(endParam)}`);
    if (apiTotal === null) apiTotal = data.total || 0;
    total += (data.shipments || []).length;
    hasMore = page < (data.pages || 1);
    page++;
    if (page > 30) break;
    if (hasMore) await sleep(300);
  }
  return total;
}

async function fetchAllShipments(startParam, endParam) {
  let all = [], page = 1, hasMore = true;
  while (hasMore) {
    const data = await ssFetch(`/shipments?shipmentStatus=shipped&pageSize=500&page=${page}&shipDateStart=${encodeURIComponent(startParam)}&shipDateEnd=${encodeURIComponent(endParam)}`);
    all = all.concat(data.shipments || []);
    hasMore = page < (data.pages || 1);
    page++;
    if (page > 30) break;
    if (hasMore) await sleep(300);
  }
  return all;
}

async function fetchAllOrders(startParam, endParam) {
  let all = [], page = 1, hasMore = true;
  while (hasMore) {
    const data = await ssFetch(`/orders?pageSize=500&page=${page}&orderDateStart=${encodeURIComponent(startParam)}&orderDateEnd=${encodeURIComponent(endParam)}`);
    all = all.concat(data.orders || []);
    hasMore = page < (data.pages || 1);
    page++;
    if (page > 30) break;
    if (hasMore) await sleep(300);
  }
  return all;
}

// Business days between two dates, excluding weekends. Fractional-day
// aware (uses the time-of-day difference, not just calendar-day counting)
// so "ordered 4pm Monday, shipped 10am Tuesday" reads as under 1 day, not
// exactly 1.
function businessDaysBetween(start, end) {
  if (isNaN(start) || isNaN(end) || end <= start) return 0;
  let totalMs = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    const dayOfWeek = cursor.getDay(); // 0=Sun, 6=Sat
    const nextMidnight = new Date(cursor); nextMidnight.setHours(24, 0, 0, 0);
    const segmentEnd = nextMidnight < end ? nextMidnight : end;
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      totalMs += segmentEnd - cursor;
    }
    cursor.setTime(nextMidnight.getTime());
  }
  return totalMs / 86400000; // ms -> days
}

function round2(n) { return Math.round(n * 100) / 100; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
