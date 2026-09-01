/**
 * api/cron/sync-listing-change-log.js
 * Runs once daily, after sync-products.js's window would reasonably be
 * complete for the day. Compares TODAY's SHEET_PRODUCTS snapshot against
 * YESTERDAY's, per SKU, across a fixed set of listing-content fields, and
 * logs every real change to a separate, permanent log sheet.
 *
 * ADDED 2026-09-01 per Jaclyn — trim-products-log.js's retention was cut
 * from 2 years to 13 months (see that file's own comment for the real
 * cell-budget math that forced this). A shorter retention window means
 * SHEET_PRODUCTS itself no longer holds a full history of every listing
 * change — this cron exists specifically to preserve that history
 * separately and indefinitely, so cutting SHEET_PRODUCTS' retention
 * doesn't mean losing the ability to see when a title/bullet/description
 * changed and what it changed from/to.
 *
 * Tracked fields (per Jaclyn's exact list): title, item_highlights,
 * bullet_1 through bullet_5, description, backend_keywords, offers
 * (price), ingredients, item_type_keyword. Deliberately NOT tracking
 * inventory/quantity fields, sales_ranks, or issues — those change too
 * often to be a meaningful "listing content changed" signal, and
 * quantity/stock history is sync-oos-history.js's job specifically, not
 * this cron's.
 *
 * One output row per FIELD that changed, not per SKU — a SKU with 3
 * fields changing on the same day produces 3 rows, not 1 row with 3
 * columns. Chosen so the log sheet can be filtered/searched by field
 * type directly (e.g. "show every title change across all brands")
 * without needing to parse a combined cell.
 *
 * Idempotent against being manually re-run on the same day: before
 * appending, checks TODAY's existing log entries (not the whole sheet —
 * only today's slice, to stay cheap) and skips any (sku, field) pair
 * already logged today, rather than risk duplicate rows from a re-run
 * comparing the same two snapshots twice.
 *
 * Sheet: SHEET_LISTING_CHANGE_LOG (must be added to config/sheets.js and
 * set as an env var before deploying — see that file for the pattern).
 * One tab per brand, auto-created on first run, matching the convention
 * every other multi-brand sheet in this repo already uses.
 *
 * Manual:
 *   GET /api/cron/sync-listing-change-log
 *   Authorization: Bearer <CRON_SECRET>
 *   &brand=creme-shop   — restrict to one brand
 */

const { ensureTab, readRows, appendRows } = require('../config/_sheets_client');
const brands                              = require('../config/brands');
const sheets                              = require('../config/sheets');
const { sendCronFailureAlert }            = require('../_alerts');

const LOG_HEADERS = ['date', 'brand', 'sku', 'asin', 'field', 'old_value', 'new_value', 'logged_at'];

// Exact field list per Jaclyn — column names as they actually appear on
// SHEET_PRODUCTS (see sync-products.js's own HEADERS constant, the
// source of truth for these names).
const TRACKED_FIELDS = [
  'title', 'item_highlights',
  'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5',
  'description', 'backend_keywords', 'offers', 'ingredients', 'item_type_keyword',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.listingChangeLog) {
    return res.status(500).json({ error: 'sheets.listingChangeLog is not configured in config/sheets.js — add SHEET_LISTING_CHANGE_LOG' });
  }

  const onlyBrand = req.query.brand || null;
  const activeBrands = brands.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));

  const today = toEstIso(new Date()).slice(0, 10);
  const yesterday = toEstIso(new Date(Date.now() - 24 * 60 * 60 * 1000)).slice(0, 10);
  const loggedAt = toEstIso(new Date());

  const results = [];

  for (const brand of activeBrands) {
    try {
      const productRows = await readRows(sheets.products, brand.tabName);

      const todayBySku = new Map();
      const yesterdayBySku = new Map();
      (productRows || []).forEach(r => {
        const date = (r.date || '').trim();
        const sku  = (r.sku  || '').trim();
        if (!sku) return;
        if (date === today) todayBySku.set(sku, r);
        else if (date === yesterday) yesterdayBySku.set(sku, r);
      });

      if (todayBySku.size === 0) {
        results.push({ brand: brand.id, status: 'skipped', reason: `no rows found for today (${today}) — sync-products.js may not have run yet` });
        continue;
      }
      if (yesterdayBySku.size === 0) {
        results.push({ brand: brand.id, status: 'skipped', reason: `no rows found for yesterday (${yesterday}) — nothing to compare against` });
        continue;
      }

      // Idempotency guard — only today's slice of the log, not the whole
      // sheet, to stay cheap even as this log grows large over time.
      const token = await ensureTab(sheets.listingChangeLog, brand.tabName, LOG_HEADERS);
      const existingLogRows = await readRows(sheets.listingChangeLog, brand.tabName);
      const alreadyLoggedToday = new Set(
        (existingLogRows || [])
          .filter(r => (r.date || '').trim() === today)
          .map(r => `${(r.sku || '').trim()}||${(r.field || '').trim()}`)
      );

      const newLogRows = [];
      todayBySku.forEach((todayRow, sku) => {
        const yesterdayRow = yesterdayBySku.get(sku);
        if (!yesterdayRow) return; // brand-new SKU today, nothing to compare against — not a "change"

        TRACKED_FIELDS.forEach(field => {
          const oldVal = String(yesterdayRow[field] ?? '');
          const newVal = String(todayRow[field] ?? '');
          if (oldVal === newVal) return;

          const dedupeKey = `${sku}||${field}`;
          if (alreadyLoggedToday.has(dedupeKey)) return;

          newLogRows.push([today, brand.id, sku, todayRow.asin || '', field, oldVal, newVal, loggedAt]);
        });
      });

      if (newLogRows.length > 0) {
        await appendRows(sheets.listingChangeLog, brand.tabName, newLogRows, token, 'USER_ENTERED');
      }

      console.log(`[sync-listing-change-log] ${brand.id} — ${newLogRows.length} field change(s) logged (${todayBySku.size} SKUs today, ${yesterdayBySku.size} SKUs yesterday)`);
      results.push({
        brand: brand.id, status: 'ok',
        changesLogged: newLogRows.length,
        skusComparedToday: todayBySku.size,
      });
    } catch (err) {
      console.error(`[sync-listing-change-log] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-listing-change-log',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ today, yesterday, results });
};

// Same helper already proven throughout this project — formats Eastern
// wall-clock time as an ISO-shaped string, consistent with every other
// Eastern-anchored timestamp in this codebase rather than UTC.
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
