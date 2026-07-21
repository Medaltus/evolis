/**
 * api/cron/sync-fulfillment-daily-shipments.js
 * One row per brand, per day, into that brand's own tab — attribution is
 * a direct &storeId= filter on /shipments (see _fulfillment_brands.js
 * for why this is simpler and more reliable than SKU matching).
 *
 * Sheet: SHEET_FULFILLMENT_DAILY_SHIPMENTS, one tab per brand (the 8
 * confirmed brands in _fulfillment_brands.js only).
 * Columns: date, orders_shipped, last_updated
 *
 * Manual / backfill:
 *   GET /api/cron/sync-fulfillment-daily-shipments?date=YYYY-MM-DD
 */

const { ssFetch } = require('../_ss');
const { FULFILLMENT_BRANDS } = require('../_fulfillment_brands');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets = require('../config/sheets');

const HEADERS = ['date', 'orders_shipped', 'last_updated'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.fulfillmentDailyShipments) return res.status(500).json({ error: 'sheets.fulfillmentDailyShipments is not configured in config/sheets.js' });

  try {
    let dateStr;
    if (req.query.date) {
      dateStr = req.query.date;
    } else {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      dateStr = `${p.year}-${p.month}-${p.day}`;
    }
    const dateParam = `${dateStr.slice(5,7)}/${dateStr.slice(8,10)}/${dateStr.slice(0,4)}`;
    const nowLabel = new Date().toISOString();

    const results = [];

    for (const brand of FULFILLMENT_BRANDS) {
      try {
        let count = 0, page = 1, hasMore = true;
        while (hasMore) {
          const data = await ssFetch(`/shipments?storeId=${brand.storeId}&shipDateStart=${encodeURIComponent(dateParam)}&shipDateEnd=${encodeURIComponent(dateParam)}&shipmentStatus=shipped&pageSize=500&page=${page}`);
          count += (data.shipments || []).length;
          hasMore = page < (data.pages || 1);
          page++;
          if (page > 200) break; // safety net against a runaway loop, not a real ceiling
          if (hasMore) await sleep(300);
        }

        const token = await ensureTab(sheets.fulfillmentDailyShipments, brand.tabName, HEADERS);
        const existing = await readRows(sheets.fulfillmentDailyShipments, brand.tabName);

        const idx = existing.findIndex(r => r.date === dateStr);
        const rows = existing.map(r => [r.date, r.orders_shipped, r.last_updated]);
        const newRow = [dateStr, count, nowLabel];
        if (idx >= 0) rows[idx] = newRow; else rows.push(newRow);

        await replaceRows(sheets.fulfillmentDailyShipments, brand.tabName, HEADERS, rows, token);
        results.push({ brand: brand.id, ordersShipped: count });
        await sleep(300); // stagger between brands, same courtesy as within-brand pagination
      } catch (err) {
        console.error(`[sync-fulfillment-daily-shipments] ${brand.id} failed:`, err.message);
        results.push({ brand: brand.id, status: 'error', error: err.message });
      }
    }

    console.log(`[sync-fulfillment-daily-shipments] ${dateStr} — ${JSON.stringify(results)}`);
    res.status(200).json({ date: dateStr, results });
  } catch (err) {
    console.error('[sync-fulfillment-daily-shipments]', err.message);
    res.status(500).json({ error: err.message });
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
