/**
 * api/cleanup-duplicate-product-rows.js
 * ONE-OFF, manually-triggered cleanup — removes duplicate (date, sku)
 * rows from SHEET_PRODUCTS, across every active brand's tab.
 *
 * Root cause (see sync-products.js's 2026-08-31 fix): the resumable
 * cursor (which masterList INDEX to resume from) and the sheet write
 * position (which ROW to write to) are two independent counters that
 * only stay in sync if masterList is identical — same order, same
 * items — across every run within a day. A mid-day code deploy (or a
 * master-sheet edit) can break that assumption, causing some SKUs to
 * get reprocessed and duplicated for the same date. Confirmed live on
 * creme-shop: 1,233 duplicate (date, sku) pairs, 1,478 excess rows,
 * concentrated on 2026-08-04 — the exact date a mid-day deploy happened.
 * sync-products.js itself was fixed the same day to make the write step
 * idempotent going forward. This script is the one-time cleanup for
 * whatever duplicates already exist from before that fix.
 *
 * For each duplicate (date, sku) group, keeps the row with the most
 * recent last_synced timestamp (the freshest data) and removes the
 * rest. Rows with no duplicates are always kept untouched.
 *
 * Writes nothing until dryRun=false is explicitly passed — defaults to
 * a safe preview.
 *
 * Usage:
 *   GET /api/cleanup-duplicate-product-rows?dryRun=true
 *   Authorization: Bearer <CRON_SECRET>
 *   &brand=creme-shop   — restrict to one brand (omit to check every active brand)
 *   &dryRun=false       — actually remove the duplicate rows (default true, preview only)
 */

const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const brandsConfig                         = require('./config/brands');
const sheets                               = require('./config/sheets');

// Must match sync-products.js's real, current header shape exactly —
// duplicated here deliberately rather than imported, matching how every
// other one-off cleanup script in this project keeps its own explicit
// HEADERS constant instead of trying to share one.
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

  const dryRun    = req.query.dryRun !== 'false'; // default true — safe preview
  const onlyBrand = req.query.brand || null;
  const activeBrands = brandsConfig.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));

  const results = [];

  for (const brand of activeBrands) {
    try {
      const token = await ensureTab(sheets.products, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.products, brand.tabName);

      if (!existingRows || existingRows.length === 0) {
        results.push({ brand: brand.id, status: 'ok', totalRows: 0, duplicateGroups: 0, removed: 0 });
        continue;
      }

      // Group rows by (date, sku). Rows with no date or no sku are left
      // completely untouched either way — not this cleanup's concern,
      // and grouping them together under a blank key would risk
      // treating unrelated rows as duplicates of each other.
      const groups = new Map();
      const untouched = [];
      existingRows.forEach(r => {
        const date = (r.date || '').trim();
        const sku  = (r.sku  || '').trim().toUpperCase();
        if (!date || !sku) { untouched.push(r); return; }
        const key = `${date}||${sku}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });

      const kept = [...untouched];
      let duplicateGroups = 0;
      let removedCount = 0;
      const sampleRemovals = [];

      groups.forEach((rowsForKey, key) => {
        if (rowsForKey.length === 1) {
          kept.push(rowsForKey[0]);
          return;
        }
        duplicateGroups++;
        // Keep the row with the most recent last_synced timestamp —
        // freshest data wins. String comparison is safe here since
        // last_synced is written in ISO-shaped YYYY-MM-DDTHH:MM:SS
        // format throughout this project (see toEstIso()).
        const sorted = [...rowsForKey].sort((a, b) => (b.last_synced || '').localeCompare(a.last_synced || ''));
        kept.push(sorted[0]);
        const removed = sorted.slice(1);
        removedCount += removed.length;
        if (sampleRemovals.length < 20) {
          sampleRemovals.push({ key, kept: sorted[0].last_synced, removedCount: removed.length, removedTimestamps: removed.map(r => r.last_synced) });
        }
      });

      if (removedCount > 0 && !dryRun) {
        const outRows = kept.map(r => HEADERS.map(h => r[h] ?? ''));
        await replaceRows(sheets.products, brand.tabName, HEADERS, outRows, token);
      }

      console.log(`[cleanup-duplicate-product-rows] ${brand.id} — ${duplicateGroups} duplicate group(s), ${removedCount} row(s) removed of ${existingRows.length} total${dryRun ? ' [DRY RUN — nothing written]' : ''}`);
      results.push({
        brand: brand.id,
        status: 'ok',
        totalRows: existingRows.length,
        duplicateGroups,
        removed: removedCount,
        sampleRemovals,
      });
    } catch (err) {
      console.error(`[cleanup-duplicate-product-rows] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const totalRemoved = results.reduce((s, r) => s + (r.removed || 0), 0);
  res.status(200).json({ dryRun, totalRemoved, results });
};
