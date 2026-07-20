/**
 * api/cron/sync-fulfillment-states.js
 * Fetches shipped orders for a window (default: last 30 days) and
 * aggregates by ship-to state, for the Fulfillment page's US heatmap +
 * state breakdown table. Adapted from states-refresh.js, a working cron
 * from the VB Cosmetics project — same shipments-endpoint pagination
 * pattern, no VBC-specific store filtering (Newderm has no equivalent to
 * VBC_STORE_IDS, so this pulls all shipments in the window unfiltered by
 * store).
 *
 * Full overwrite each run — this is a current-window snapshot, not an
 * accumulating history (matches the reference cron's own behavior).
 *
 * Sheet: SHEET_FULFILLMENT_STATES, tab "Sheet1".
 * Columns: state, orders, refreshed_at, range
 *
 * Manual:
 *   GET /api/cron/sync-fulfillment-states?range=30d
 *   (7d | 30d | 90d — defaults to 30d)
 */

const { ssFetch, rangeParams } = require('../_ss');
const { ensureTab, replaceRows } = require('../config/_sheets_client');
const sheets = require('../config/sheets');

const DATA_TAB = 'Sheet1';
const HEADERS  = ['state', 'orders', 'refreshed_at', 'range'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.fulfillmentStates) return res.status(500).json({ error: 'sheets.fulfillmentStates is not configured in config/sheets.js' });

  try {
    const range = req.query.range || '30d';
    const { since, until } = rangeParams(range);
    const byState = {};
    let grandTotal = 0;

    let page = 1, fetched = 0, total = null;
    while (true) {
      let path = `/shipments?shipmentStatus=shipped&pageSize=500&page=${page}&shipDateStart=${encodeURIComponent(since + ' 00:00:00')}`;
      if (until) path += `&shipDateEnd=${encodeURIComponent(until + ' 23:59:59')}`;

      let data;
      try {
        data = await ssFetch(path);
      } catch (e) {
        if (e.message.includes('429')) {
          await sleep(10000);
          continue;
        }
        console.error(`[sync-fulfillment-states] page ${page}:`, e.message);
        break;
      }

      if (total === null) total = data.total || 0;
      const shipments = data.shipments || [];
      fetched += shipments.length;
      grandTotal += shipments.length;

      shipments.forEach(s => {
        const st = s.shipTo?.state;
        if (st) byState[st] = (byState[st] || 0) + 1;
      });

      if (shipments.length < 500 || fetched >= total) break;
      page++;
      await sleep(400);
    }

    const refreshedAt = new Date().toISOString();
    const rows = Object.entries(byState).sort((a, b) => b[1] - a[1]).map(([state, orders]) => [state, orders, refreshedAt, range]);

    const token = await ensureTab(sheets.fulfillmentStates, DATA_TAB, HEADERS);
    await replaceRows(sheets.fulfillmentStates, DATA_TAB, HEADERS, rows, token);

    console.log(`[sync-fulfillment-states] ${grandTotal} orders, ${Object.keys(byState).length} states`);
    res.status(200).json({ total: grandTotal, states: Object.keys(byState).length, refreshed_at: refreshedAt });
  } catch (err) {
    console.error('[sync-fulfillment-states]', err.message);
    res.status(500).json({ error: err.message });
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
