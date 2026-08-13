/**
 * api/cron/sync-90d-units-cache.js
 * Runs once daily. Pre-computes the rolling-90-day units-sold figures that
 * sync-products.js needs for its days_of_inventory formula, so that cron
 * (which runs every 15 minutes, 36x/day) doesn't have to re-read every
 * brand's FULL orders history from scratch on every single invocation
 * just to recompute a number that only meaningfully changes once a day.
 * skinuva alone is ~7,200 rows; creme-shop ~6,800 — that was 36 full
 * reads of each, per day, for a number that barely moves hour to hour.
 *
 * Two independent sources, summed separately — no shared key, since
 * Amazon side is keyed by ASIN and Walmart has no ASIN concept at all:
 *   Amazon:  sheets.orders[brand.tabName]         -> sum unit_count by ASIN
 *   Walmart: SHEET_WALMART_ORDERS[brand.tabName]  -> sum unit_count by SKU
 * Both exclude cancelled orders. Both source sheets are already-maintained
 * rolling ~90-day windows (per their own crons), so no date filtering is
 * needed here beyond that — same assumption sync-products.js's original
 * fetchBrand90dUnits/fetchBrandWalmart90dUnits already made.
 *
 * Output: SHEET_90D_UNITS_CACHE, one tab per brand.
 * Columns: type ('amazon' | 'walmart'), key (ASIN or SKU), units_90d, last_updated
 *
 * sync-products.js reads this cache instead of deriving it live — see
 * fetchBrand90dUnits() / fetchBrandWalmart90dUnits() there, which keep
 * the exact same return shape ({ [asin]: units } / { [sku]: units }) so
 * nothing downstream of those two functions needed to change.
 *
 * Suggested schedule: once daily, after both the Amazon orders rolling
 * window (sync-orders-process, every 2hrs all day) and Walmart orders
 * sync (6:12am UTC per vercel.json) have had at least one fresh pass —
 * e.g. 7:00am UTC.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');

// Same fallback default sync-products.js's own Walmart lookup already used.
const SHEET_WALMART_ORDERS = process.env.SHEET_WALMART_ORDERS || '1oIZDxN0vSf4nRvE_K95lsNyBWQd4Ef2aARm0RUtvE0Y';
const CACHE_SHEET_ID = process.env.SHEET_90D_UNITS_CACHE; // must be created + set before deploying

const HEADERS = ['type', 'key', 'units_90d', 'last_updated'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!CACHE_SHEET_ID) {
    return res.status(500).json({ error: 'SHEET_90D_UNITS_CACHE env var is not set — create the sheet and set this before running.' });
  }

  const now = new Date().toISOString();
  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const [amazonRows, walmartRows] = await Promise.all([
        readRows(sheets.orders, brand.tabName).catch(err => {
          console.warn(`[sync-90d-units-cache] ${brand.id} — Amazon orders read failed (leaving amazon side empty this run): ${err.message}`);
          return [];
        }),
        readRows(SHEET_WALMART_ORDERS, brand.tabName).catch(err => {
          console.warn(`[sync-90d-units-cache] ${brand.id} — Walmart orders read failed (leaving walmart side empty this run): ${err.message}`);
          return [];
        }),
      ]);

      const amazonMap = {};
      (amazonRows || []).forEach(r => {
        const status = (r.status || '').toLowerCase();
        if (status === 'cancelled') return;
        const asin = (r.asin || '').trim().toUpperCase();
        if (!asin) return;
        const units = parseInt(r.unit_count, 10) || 0;
        amazonMap[asin] = (amazonMap[asin] || 0) + units;
      });

      const walmartMap = {};
      (walmartRows || []).forEach(r => {
        const status = (r.status || '').toLowerCase();
        if (status === 'cancelled') return;
        const sku = (r.sku || '').trim().toUpperCase();
        if (!sku) return;
        const units = parseInt(r.unit_count, 10) || 0;
        walmartMap[sku] = (walmartMap[sku] || 0) + units;
      });

      const outRows = [
        ...Object.entries(amazonMap).map(([asin, units]) => ['amazon', asin, units, now]),
        ...Object.entries(walmartMap).map(([sku, units]) => ['walmart', sku, units, now]),
      ];

      const token = await ensureTab(CACHE_SHEET_ID, brand.tabName, HEADERS);
      await replaceRows(CACHE_SHEET_ID, brand.tabName, HEADERS, outRows, token);

      results.push({
        brand: brand.id, status: 'ok',
        amazonKeys: Object.keys(amazonMap).length,
        walmartKeys: Object.keys(walmartMap).length,
      });
      console.log(`[sync-90d-units-cache] ${brand.id} — amazon=${Object.keys(amazonMap).length} walmart=${Object.keys(walmartMap).length}`);
    } catch (err) {
      console.error(`[sync-90d-units-cache] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-90d-units-cache',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ results, timestamp: now });
};
