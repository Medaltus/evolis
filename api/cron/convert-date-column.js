/**
 * api/cron/convert-date-column.js
 * ONE-OFF fix — NOT wired into vercel.json, run manually.
 *
 * sheets.orders' `date` column is stored as forced TEXT — every write to
 * this sheet uses valueInputOption=RAW (sync-orders-process.js,
 * fees-estimate.js, sale-promotions.js, dedupe-orders.js), which never
 * lets Sheets interpret anything as a real date. That's why the formula
 * bar shows a leading apostrophe on every date cell (Sheets' own "this is
 * forced text" indicator — it is NOT a character actually stored in the
 * value, confirmed via direct cell-type inspection) and why native
 * date-aware sort/filter doesn't work on this column.
 *
 * This script touches ONLY column B (`date`) on each brand tab, via a
 * narrow-range write (updateRange, NOT replaceRows — nothing outside that
 * one column is read or written). It writes with
 * valueInputOption=USER_ENTERED, so Sheets parses "2026-05-14" into a
 * genuine date. No other column is ever in scope, so there's no risk of
 * sku/order_id/promotion_ids being reinterpreted as numbers.
 *
 * Run dedupe-orders.js BEFORE this if you haven't already — this script
 * assumes column B is already clean 10-char YYYY-MM-DD strings. It will
 * still re-slice any leftover malformed values defensively, but a
 * genuinely blank/malformed date will just fail to parse as a date and
 * Sheets will leave that specific cell as whatever it already was.
 *
 * KNOWN SIDE EFFECT: once converted to a real date type, Sheets displays
 * the column using the spreadsheet's default date format (often
 * M/D/YYYY, not YYYY-MM-DD) unless you set an explicit number format.
 * This script does NOT set one — sorting/filtering will work correctly
 * either way, but if you want the ISO-style *display* preserved, select
 * column B afterward and use Format → Number → Date, or a custom format
 * of yyyy-mm-dd.
 *
 * Manual:
 *   GET /api/cron/convert-date-column?dryRun=true              — report only
 *   GET /api/cron/convert-date-column?dryRun=true&brand=evolis  — single brand
 *   GET /api/cron/convert-date-column&brand=evolis               — actually write, single brand first, recommended
 *   GET /api/cron/convert-date-column                            — actually write, all brands
 *   Authorization: Bearer <CRON_SECRET>
 */

const { readRows, updateRange, ensureTab } = require('../config/_sheets_client');
const brandsConfig                         = require('../config/brands');
const sheets                               = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
  'Amazon Estimated fees',
  'Amazon Sale Promotions',
  'marketplace',
  'channel',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun    = req.query.dryRun === 'true';
  const onlyBrand = req.query.brand || null;
  const activeBrands = brandsConfig.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));

  const results = [];

  for (const brand of activeBrands) {
    try {
      // ensureTab first — guarantees the tab/token exist without touching
      // any data (we already know these tabs exist, this is just for the
      // auth token updateRange needs).
      const token = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.orders, brand.tabName);

      if (!existingRows || existingRows.length === 0) {
        results.push({ brand: brand.id, status: 'ok', totalRows: 0, wrote: false });
        continue;
      }

      const dateValues = existingRows.map(r => [normalizeDate(r.date)]);
      const range = `${brand.tabName}!B2:B${existingRows.length + 1}`;

      if (!dryRun) {
        await updateRange(sheets.orders, range, dateValues, token, 'USER_ENTERED');
      }

      results.push({
        brand: brand.id, status: 'ok',
        totalRows: existingRows.length, range, wrote: !dryRun,
      });
      console.log(`[convert-date-column] ${brand.id} — ${existingRows.length} date cells ${dryRun ? '(dry run — not written)' : 'converted'}`);
    } catch (err) {
      console.error(`[convert-date-column] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'convert-date-column',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': `${failedBrands.length} of ${activeBrands.length}` }
    );
  }

  res.status(200).json({ dryRun, results });
};

function normalizeDate(v) {
  return String(v ?? '').slice(0, 10);
}
