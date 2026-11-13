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
const { normalizeOrderDate } = require('../_dates');                       // ADDED 2026-10-21
const { OFFER_HEADERS, IMAGE_HEADERS = [] } = require('../config/product-offer-columns'); // ADDED 2026-10-21 (+ images 2026-11-13)

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
// ADDED 2026-10-21 — columns after qty_on_hand belong to
// sync-product-offers.js. Included so the header check matches.
const SHEET_HEADERS = [...HEADERS, ...OFFER_HEADERS, ...IMAGE_HEADERS];

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
      // FIXED 2026-10-21 — three problems, caught before this cron's first
      // real trim (rows only age out after 395 days):
      //   1. It rewrote each tab from its own fixed HEADERS list, which would
      //      have erased every column after qty_on_hand (sync-product-
      //      offers.js's alt-seller / Buy Box columns) on every row. Now it
      //      rewrites using the tab's own columns.
      //   2. It read DISPLAYED values and wrote them back as RAW text, which
      //      would have frozen the live formulas (total_quantity,
      //      days_of_inventory) into static numbers and turned every number
      //      into text. Now it reads formulas ('FORMULA') and writes with
      //      USER_ENTERED — same as sync-products.js's own clear step.
      //   3. Dates were compared as raw text, which breaks as soon as a date
      //      reads back as "10/21/2026" instead of "2026-10-21" (the same
      //      bug found in trim-orders.js on 2026-10-06). Dates are now read
      //      in any format; a row whose date can't be read is always KEPT,
      //      and the cron refuses to empty a tab entirely.
      const token = await ensureTab(sheets.products, brand.tabName, SHEET_HEADERS);
      const rows  = await readRows(sheets.products, brand.tabName, 'FORMULA');

      const before = rows.length;
      let unreadable = 0;
      rows.forEach((r, i) => { r.__row = i + 2; }); // original sheet row (readRows keeps one entry per row)
      const kept = rows.filter(r => {
        const iso = normalizeOrderDate(r.date).iso;
        if (!iso) { unreadable++; return true; }
        return iso >= cutoffStr;
      });
      const after = kept.length;

      if (before > 0 && after === 0) {
        throw new Error(`trim would delete all ${before} rows — skipped (check the date column; first date seen: "${rows[0].date}")`);
      }
      if (after < before) {
        const cols = (HEADERS.every(h => h in rows[0]) ? Object.keys(rows[0]) : SHEET_HEADERS).filter(h => h !== '__row');
        // Kept rows move up; renumber each formula's own-row references.
        const rowArrays = kept.map((r, j) => cols.map(h => moveOwnRowRefs(r[h] ?? '', r.__row, j + 2)));
        await replaceRows(sheets.products, brand.tabName, cols, rowArrays, token, 'USER_ENTERED');
        console.log(`[trim-products-log] ${brand.id} — trimmed ${before - after} rows (${before} → ${after})`);
      }

      results.push({ brand: brand.id, before, after, trimmed: before - after, ...(unreadable ? { unreadableDatesKept: unreadable } : {}) });
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

// ADDED 2026-10-21 — sync-products.js writes formulas that reference their
// OWN row by number (e.g. "=D57+E57+J57", "=AE57-E57"). When a rewrite moves
// a row (trimming old rows from the top shifts everything up), those
// numbers must move with it, or every formula ends up adding up some other
// SKU's numbers. Rewrites a formula's references to oldRow so they point at
// newRow; anything else (including numbers like the 90 in "/90") is left alone.
function moveOwnRowRefs(value, oldRow, newRow) {
  if (typeof value !== 'string' || !value.startsWith('=') || oldRow === newRow) return value;
  return value.replace(/(\$?[A-Z]{1,3}\$?)(\d+)(?![\d(])/g, (m, col, num) => (Number(num) === oldRow ? `${col}${newRow}` : m));
}
