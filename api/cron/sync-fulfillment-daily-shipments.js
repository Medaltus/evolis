/**
 * api/cron/sync-fulfillment-daily-shipments.js
 * Runs once daily, after the day's shipping activity is effectively done.
 * Writes today's final shipped-order count as a permanent row — one row
 * per date, historical rows are never overwritten (matches the reference
 * pattern from shipments-chart-sync.js, a working cron from the VB
 * Cosmetics project). This is what lets the Fulfillment page's "Orders
 * shipped by date" chart read from a sheet instead of hitting ShipStation
 * live on every page load.
 *
 * UNLIKE the VBC reference: no per-store breakdown (DTC/PRO/VVSC/
 * Employee) — that's VBC's own internal store segmentation
 * (config/_ss.js's STORE_ID_MAP), specific to their ShipStation account,
 * not something Newderm's account has an equivalent of. This just tracks
 * one total per day.
 *
 * Sheet: SHEET_FULFILLMENT_DAILY_SHIPMENTS, tab "daily-counts".
 * Columns: date, orders_shipped, last_updated
 *
 * Manual / backfill:
 *   GET /api/cron/sync-fulfillment-daily-shipments?date=YYYY-MM-DD
 */

const { ssFetch }                          = require('../_ss');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                                = require('../config/sheets');

const DATA_TAB = 'daily-counts';
const HEADERS  = ['date', 'orders_shipped', 'last_updated'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.fulfillmentDailyShipments) return res.status(500).json({ error: 'sheets.fulfillmentDailyShipments is not configured in config/sheets.js' });

  try {
    // Support ?date=YYYY-MM-DD for backfill, otherwise use today (Eastern)
    let dateStr;
    if (req.query.date) {
      dateStr = req.query.date;
    } else {
      dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
      const [mm, dd, yyyy] = dateStr.split('/');
      dateStr = `${yyyy}-${mm}-${dd}`;
    }
    const dateParam = `${dateStr.slice(5,7)}/${dateStr.slice(8,10)}/${dateStr.slice(0,4)}`; // MM/DD/YYYY, what ShipStation's date params expect

    let total = 0, page = 1, hasMore = true;
    while (hasMore) {
      const data = await ssFetch(`/shipments?shipDateStart=${encodeURIComponent(dateParam)}&shipDateEnd=${encodeURIComponent(dateParam)}&shipmentStatus=shipped&pageSize=500&page=${page}`);
      total += (data.shipments || []).length;
      hasMore = page < (data.pages || 1);
      page++;
      if (page > 200) break; // safety net against a runaway loop, not a real ceiling
      if (hasMore) await sleep(300);
    }

    const nowLabel = new Date().toISOString();
    const token = await ensureTab(sheets.fulfillmentDailyShipments, DATA_TAB, HEADERS);
    const existing = await readRows(sheets.fulfillmentDailyShipments, DATA_TAB);

    const idx = existing.findIndex(r => r.date === dateStr);
    const rows = existing.map(r => [r.date, r.orders_shipped, r.last_updated]);
    const newRow = [dateStr, total, nowLabel];
    if (idx >= 0) rows[idx] = newRow; else rows.push(newRow);

    await replaceRows(sheets.fulfillmentDailyShipments, DATA_TAB, HEADERS, rows, token);

    console.log(`[sync-fulfillment-daily-shipments] ${dateStr} — ${total} orders shipped`);
    res.status(200).json({ date: dateStr, ordersShipped: total, ...(idx >= 0 ? { updated: true } : { appended: true }) });
  } catch (err) {
    console.error('[sync-fulfillment-daily-shipments]', err.message);
    res.status(500).json({ error: err.message });
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
