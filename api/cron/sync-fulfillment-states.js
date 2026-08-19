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
 * FIXED 2026-08-14 — three changes:
 *   1. Skips any brand with a null storeId (e.g. skinuva-ca's current
 *      placeholder entry in _fulfillment_brands.js) before making any
 *      ShipStation API call — same reasoning as the other two
 *      fulfillment crons' identical fix today.
 *   2. replaceRows now specifies valueInputOption=USER_ENTERED (was
 *      defaulting to RAW) so 'orders' writes as a real number instead of
 *      forced text.
 *   3. 'state' (2-letter US state code) is protected with a leading
 *      apostrophe as cheap defensive insurance — no confirmed risk, but
 *      costs nothing given today's Shopify-revenue formatting lesson,
 *      and this cron writes to this sheet unconditionally every run.
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
const { sendCronFailureAlert } = require('../_alerts');

const HEADERS = ['state', 'orders', 'refreshed_at', 'range'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.fulfillmentStates) {
    await sendCronFailureAlert('sync-fulfillment-states', 'sheets.fulfillmentStates is not configured in config/sheets.js');
    return res.status(500).json({ error: 'sheets.fulfillmentStates is not configured in config/sheets.js' });
  }

  const range = req.query.range || '30d';
  const { since, until } = rangeParams(range);
  const refreshedAt = toEstIso(new Date()); // FIXED 2026-08-19 -- was UTC
  const results = [];

  for (const brand of FULFILLMENT_BRANDS) {
    // ADDED 2026-08-14 — see file header. Never build a ShipStation call
    // for a brand with no confirmed store yet.
    // FIXED 2026-08-14, second pass — see sync-fulfillment-kpis.js for
    // the full explanation: !"null" (string) is false, so the original
    // guard could be bypassed if storeId ended up as a string rather
    // than the actual JS null value. This catches both forms.
    if (!brand.storeId || brand.storeId === 'null') {
      results.push({ brand: brand.id, status: 'skipped', reason: 'no storeId configured yet' });
      continue;
    }

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

      const rows = Object.entries(byState).sort((a, b) => b[1] - a[1]).map(([state, orders]) => [`'${state}`, orders, refreshedAt, range]);

      const token = await ensureTab(sheets.fulfillmentStates, brand.tabName, HEADERS);
      await replaceRows(sheets.fulfillmentStates, brand.tabName, HEADERS, rows, token, 'USER_ENTERED');

      console.log(`[sync-fulfillment-states] ${brand.id} — ${fetched} orders, ${Object.keys(byState).length} states`);
      results.push({ brand: brand.id, total: fetched, states: Object.keys(byState).length });
      await sleep(300);
    } catch (err) {
      console.error(`[sync-fulfillment-states] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-fulfillment-states',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': `${failedBrands.length} of ${FULFILLMENT_BRANDS.length}` }
    );
  }

  res.status(200).json({ range, refreshed_at: refreshedAt, results });
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Same helper already proven in sync-fbm-returns-process.js /
// sync-returns-process.js — formats Eastern wall-clock time as an
// ISO-shaped string ending in "Z", so it displays consistently with
// every other Eastern-anchored timestamp in this project rather than
// UTC. Not a literal UTC timestamp despite the "Z" suffix — a
// deliberate, consistent convention used throughout this codebase.
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
