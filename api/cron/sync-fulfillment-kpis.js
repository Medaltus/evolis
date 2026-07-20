/**
 * api/cron/sync-fulfillment-kpis.js
 * Per-brand version of the three KPI numbers (shipped orders 30d, avg
 * shipping cost 7d, avg processing time 7d) — all brands written into
 * ONE shared "_kpis" tab, rows keyed by (metric, brand), per explicit
 * preference (simpler than one tab per brand for just 3 numbers each).
 *
 * Attribution via &storeId= on both /shipments and /orders — see
 * _fulfillment_brands.js. This removes the need for the shipmentItems/
 * SKU join an earlier version of this file used before storeId-based
 * attribution was confirmed as the right approach.
 *
 * Processing time still needs the /orders join for orderDate specifically
 * (shipments don't carry the original order date, only ShipStation's own
 * createDate/shipDate) — that part of the design is unchanged from
 * before, just now scoped per-brand via storeId rather than account-wide.
 *
 * Debug mode returns per-brand joined sample data instead of writing —
 * use it first, same as before, since the join logic is still real
 * business logic worth eyeballing against live data before trusting.
 *
 * Sheet: SHEET_FULFILLMENT_DAILY_SHIPMENTS, tab "_kpis".
 * Columns: metric, brand, value, updated_at
 *
 * Manual:
 *   GET /api/cron/sync-fulfillment-kpis
 *   GET /api/cron/sync-fulfillment-kpis?debug=true
 */

const { ssFetch } = require('../_ss');
const { FULFILLMENT_BRANDS } = require('../_fulfillment_brands');
const { ensureTab, replaceRows } = require('../config/_sheets_client');
const sheets = require('../config/sheets');

const KPI_TAB = '_kpis';
const HEADERS = ['metric', 'brand', 'value', 'updated_at'];

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

  const debugOut = [];
  const rows = [];
  const nowIso = new Date().toISOString();

  for (const brand of FULFILLMENT_BRANDS) {
    try {
      const shippedCount30d = await countShipments(brand.storeId, fmt(d30), fmt(now));
      const shipments7d = await fetchAllShipments(brand.storeId, fmt(d7), fmt(now));
      const avgShippingCost = shipments7d.length
        ? round2(shipments7d.reduce((s, x) => s + (x.shipmentCost || 0), 0) / shipments7d.length)
        : null;

      const orders = await fetchAllOrders(brand.storeId, fmt(d21), fmt(now));
      const orderDateById = {};
      orders.forEach(o => { orderDateById[o.orderId] = o.orderDate; });

      const joined = shipments7d
        .map(s => ({ orderId: s.orderId, shipDate: s.shipDate, orderDate: orderDateById[s.orderId] || null }))
        .filter(x => x.orderDate);

      const businessDaysList = joined.map(x => businessDaysBetween(new Date(x.orderDate), new Date(x.shipDate)));
      const avgProcessingTime = businessDaysList.length
        ? round2(businessDaysList.reduce((s, v) => s + v, 0) / businessDaysList.length)
        : null;

      if (debug) {
        debugOut.push({
          brand: brand.id,
          shippedCount30d,
          shipments7dCount: shipments7d.length,
          ordersFetchedCount: orders.length,
          joinedCount: joined.length,
          droppedForMissingOrderDate: shipments7d.length - joined.length,
          avgShippingCost,
          avgProcessingTime,
        });
      } else {
        rows.push(['shipped_orders_30d', brand.id, shippedCount30d, nowIso]);
        rows.push(['avg_shipping_cost_7d', brand.id, avgShippingCost ?? '', nowIso]);
        rows.push(['avg_processing_time_7d', brand.id, avgProcessingTime ?? '', nowIso]);
      }

      await sleep(300);
    } catch (err) {
      console.error(`[sync-fulfillment-kpis] ${brand.id} failed:`, err.message);
      if (debug) debugOut.push({ brand: brand.id, error: err.message });
    }
  }

  if (debug) {
    return res.status(200).json({
      debug: true,
      perBrand: debugOut,
      note: 'Check droppedForMissingOrderDate per brand — if it is most/all of shipments7dCount for any brand, the 14-day buffer window is too narrow for that brand, or storeId/orderId matching is failing.',
    });
  }

  try {
    const token = await ensureTab(sheets.fulfillmentDailyShipments, KPI_TAB, HEADERS);
    await replaceRows(sheets.fulfillmentDailyShipments, KPI_TAB, HEADERS, rows, token);
    console.log(`[sync-fulfillment-kpis] wrote ${rows.length} rows across ${FULFILLMENT_BRANDS.length} brands`);
    res.status(200).json({ rowsWritten: rows.length, brands: FULFILLMENT_BRANDS.map(b => b.id) });
  } catch (err) {
    console.error('[sync-fulfillment-kpis] write failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function countShipments(storeId, startParam, endParam) {
  let total = 0, page = 1, hasMore = true, apiTotal = null;
  while (hasMore) {
    const data = await ssFetch(`/shipments?storeId=${storeId}&shipmentStatus=shipped&pageSize=500&page=${page}&shipDateStart=${encodeURIComponent(startParam)}&shipDateEnd=${encodeURIComponent(endParam)}`);
    if (apiTotal === null) apiTotal = data.total || 0;
    total += (data.shipments || []).length;
    hasMore = page < (data.pages || 1);
    page++;
    if (page > 200) break;
    if (hasMore) await sleep(300);
  }
  return total;
}

async function fetchAllShipments(storeId, startParam, endParam) {
  let all = [], page = 1, hasMore = true;
  while (hasMore) {
    const data = await ssFetch(`/shipments?storeId=${storeId}&shipmentStatus=shipped&pageSize=500&page=${page}&shipDateStart=${encodeURIComponent(startParam)}&shipDateEnd=${encodeURIComponent(endParam)}`);
    all = all.concat(data.shipments || []);
    hasMore = page < (data.pages || 1);
    page++;
    if (page > 200) break;
    if (hasMore) await sleep(300);
  }
  return all;
}

async function fetchAllOrders(storeId, startParam, endParam) {
  let all = [], page = 1, hasMore = true;
  while (hasMore) {
    const data = await ssFetch(`/orders?storeId=${storeId}&pageSize=500&page=${page}&orderDateStart=${encodeURIComponent(startParam)}&orderDateEnd=${encodeURIComponent(endParam)}`);
    all = all.concat(data.orders || []);
    hasMore = page < (data.pages || 1);
    page++;
    if (page > 200) break;
    if (hasMore) await sleep(300);
  }
  return all;
}

function businessDaysBetween(start, end) {
  if (isNaN(start) || isNaN(end) || end <= start) return 0;
  let totalMs = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    const dayOfWeek = cursor.getDay();
    const nextMidnight = new Date(cursor); nextMidnight.setHours(24, 0, 0, 0);
    const segmentEnd = nextMidnight < end ? nextMidnight : end;
    if (dayOfWeek !== 0 && dayOfWeek !== 6) totalMs += segmentEnd - cursor;
    cursor.setTime(nextMidnight.getTime());
  }
  return totalMs / 86400000;
}

function round2(n) { return Math.round(n * 100) / 100; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
