/**
 * api/cron/sync-fulfillment-states.js
 * One tab per brand in SHEET_FULFILLMENT_STATES, each containing that
 * brand's own state breakdown for the window. Attribution via &storeId=
 * on /shipments — see _fulfillment_brands.js.
 *
 * Full overwrite each run per brand tab — current-window snapshot, not
 * an accumulating history (matches the original states-refresh.js
 * reference cron's own behavior).
 *
 * Columns: state, orders, refreshed_at, range
 *
 * Manual:
 *   GET /api/cron/sync-fulfillment-states?range=30d
 */

const { ssFetch, rangeParams } = require('../_ss');
const { FULFILLMENT_BRANDS } = require('../_fulfillment_brands');
const { ensureTab, replaceRows } = require('../config/_sheets_client');
const sheets = require('../config/sheets');

const HEADERS = ['state', 'orders', 'refreshed_at', 'range'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.fulfillmentStates) return res.status(500).json({ error: 'sheets.fulfillmentStates is not configured in config/sheets.js' });

  const range = req.query.range || '30d';
  const { since, until } = rangeParams(range);
  const refreshedAt = new Date().toISOString();
  const results = [];

  for (const brand of FULFILLMENT_BRANDS) {
    try {
      const byState = {};
      let page = 1, fetched = 0, total = null;

      while (true) {
        let path = `/shipments?storeId=${brand.storeId}&shipmentStatus=shipped&pageSize=500&page=${page}&shipDateStart=${encodeURIComponent(since + ' 00:00:00')}`;
        if (until) path += `&shipDateEnd=${encodeURIComponent(until + ' 23:59:59')}`;

        let data;
        try {
          data = await ssFetch(path);
        } catch (e) {
          if (e.message.includes('429')) { await sleep(10000); continue; }
          console.error(`[sync-fulfillment-states] ${brand.id} page ${page}:`, e.message);
          break;
        }

        if (total === null) total = data.total || 0;
        const shipments = data.shipments || [];
        fetched += shipments.length;

        shipments.forEach(s => {
          const st = s.shipTo?.state;
          if (st) byState[st] = (byState[st] || 0) + 1;
        });

        if (shipments.length < 500 || fetched >= total) break;
        page++;
        await sleep(400);
      }

      const rows = Object.entries(byState).sort((a, b) => b[1] - a[1]).map(([state, orders]) => [state, orders, refreshedAt, range]);

      const token = await ensureTab(sheets.fulfillmentStates, brand.tabName, HEADERS);
      await replaceRows(sheets.fulfillmentStates, brand.tabName, HEADERS, rows, token);

      console.log(`[sync-fulfillment-states] ${brand.id} — ${fetched} orders, ${Object.keys(byState).length} states`);
      results.push({ brand: brand.id, total: fetched, states: Object.keys(byState).length });
      await sleep(300);
    } catch (err) {
      console.error(`[sync-fulfillment-states] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ range, refreshed_at: refreshedAt, results });
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
