/**
 * api/cron/trim-products-log.js
 * Daily — drops rows from SHEET_PRODUCTS older than 2 years, so the
 * daily inventory/listing log (sync-products.js) doesn't grow forever.
 *
 * At current column count (27) and realistic daily SKU volume across all
 * brands, 2 years of history sits comfortably under Google Sheets' 10M
 * cell ceiling for the whole spreadsheet — see the math worked through
 * with Jaclyn on 2026-07-09. Adjust RETENTION_DAYS if that changes.
 *
 * Mirrors trim-orders.js's approach: read each brand tab, keep only rows
 * within the retention window, replaceRows.
 *
 * Runs once daily, after sync-products.js's window would reasonably be
 * complete for the day.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { sendCronFailureAlert } = require('../_alerts');

const RETENTION_DAYS = 395; // 13 months (365 + 30)
// CHANGED 2026-09-01 per Jaclyn — was 730 days (2 years). Real math worked
// through with Jaclyn: 850 live SKUs (confirmed against the master SKU
// list) x 30 columns x 730 days = 18,615,000 cells — nearly double
// Google's 10M cell ceiling for the WHOLE spreadsheet (shared across every
// brand's tab, not per-tab), not just a creme-shop-specific problem.
// WORTH KNOWING: 395 days is actually ~72,500 cells OVER the 10M limit at
// the current 850-SKU count (850 x 30 x 395 = 10,072,500) — the exact
// cutoff that fits safely is 392 days. Set to 395 anyway per Jaclyn's
// explicit instruction, not decided unilaterally here; in practice this
// is close enough that normal SKU turnover (not every SKU stays live the
// full window) will likely keep the real count under 10M most of the
// time, but this is genuinely right at the edge, not comfortably under
// it — worth monitoring if brand/SKU count grows. Historical
// out-of-stock periods and listing-copy changes that would otherwise be
// lost when a row ages out are now separately preserved indefinitely by
// sync-oos-history.js and sync-listing-change-log.js (added the same
// day) — see those files. Jaclyn may drop this further to 365 days (12
// months) now that those two logs exist to cover the gap.

// FIXED 2026-08-14 — same class of bug found and fixed today in
// trim-orders.js, fees-estimate.js, and sale-promotions.js: this HEADERS
// list was missing the three most recent columns sync-products.js added
// ('purchased_units_90d', 'days_of_inventory', 'qty_on_hand'). Since the
// write here only fires once rows actually age past the 2-year retention
// window, this one likely hasn't triggered yet in practice — sync-
// products.js is a relatively young addition — but would have silently
// wiped those three columns across the entire tab the first time a trim
// actually ran. Fixed proactively before that happens.
const HEADERS = [
  'date', 'sku', 'asin',
  'fulfillable_quantity', 'reserved_quantity', 'inbound_working_quantity',
  'inbound_shipped_quantity', 'inbound_receiving_quantity',
  'unfulfillable_quantity', 'seller_fulfilled_quantity', 'total_quantity',
  'name', 'status', 'sales_ranks', 'title', 'item_highlights',
  'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5',
  'description', 'backend_keywords', 'ingredients', 'item_type_keyword',
  'offers', 'issues', 'last_synced',
  'purchased_units_90d', 'days_of_inventory', 'qty_on_hand',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token = await ensureTab(sheets.products, brand.tabName, HEADERS);
      const rows  = await readRows(sheets.products, brand.tabName);

      const before = rows.length;
      const kept   = rows.filter(r => (r.date || '') >= cutoffStr);
      const after  = kept.length;

      if (after < before) {
        const rowArrays = kept.map(r => HEADERS.map(h => r[h] ?? ''));
        await replaceRows(sheets.products, brand.tabName, HEADERS, rowArrays, token);
        console.log(`[trim-products-log] ${brand.id} — trimmed ${before - after} rows (${before} → ${after})`);
      }

      results.push({ brand: brand.id, before, after, trimmed: before - after });
    } catch (err) {
      console.error(`[trim-products-log] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'trim-products-log',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ results, cutoffDate: cutoffStr, timestamp: new Date().toISOString() });
};
