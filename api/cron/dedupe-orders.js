/**
 * api/cron/dedupe-orders.js
 * ONE-OFF cleanup tool — NOT wired into vercel.json, run manually.
 *
 * Fixes two confirmed data issues found in sheets.orders on 2026-08-13:
 *   1. `date` values that aren't the clean 10-char YYYY-MM-DD
 *      sync-orders-process.js has always written (e.g. "2026-05-14
 *      0:00:00", 19 chars) — surfaced by the 90→120-day retention bump,
 *      predates the current `.slice(0, 10)` logic.
 *   2. Duplicate (order_id, sku) rows — confirmed via manual export audit:
 *      dearcloud 645 pairs / 648 extra rows, creme-shop 108 pairs, smaller
 *      counts on evolis/skinuva/just-bjorn/cloud-cafe/pbj/hillside/
 *      eraclea/cimeosil, zero on miguard/amala/collagelee/prohibition/
 *      skinside-seoul. Some pairs share an identical last_updated (same
 *      run wrote it twice); others differ (e.g. one row from 2026-07-09,
 *      one from a same-day backfill) — root cause not conclusively
 *      identified, this cleans up the existing damage regardless of cause.
 *      sync-orders-process.js was separately hardened on 2026-08-13 to
 *      collapse duplicates on every future write — this script is for the
 *      rows already sitting in the sheet from before that existed.
 *
 * NOTE: (order_id, sku) duplicates are the target — NOT (order_id) alone.
 * Multiple rows legitimately share one order_id when an order has more
 * than one ASIN/SKU line item (that's the whole point of the per-line-item
 * row design, so index.html can count units per ASIN). Never collapse on
 * order_id by itself.
 *
 * Manual:
 *   GET /api/cron/dedupe-orders?dryRun=true              — all brands, report only
 *   GET /api/cron/dedupe-orders?dryRun=true&brand=evolis  — single brand
 *   GET /api/cron/dedupe-orders?brand=evolis              — actually write (single brand first, recommended)
 *   GET /api/cron/dedupe-orders                           — actually write, all brands
 *   Authorization: Bearer <CRON_SECRET>
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brandsConfig                         = require('../config/brands');
const sheets                               = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');

// Must match sync-orders-process.js's HEADERS exactly — same tab, same shape.
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
      const token           = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const existingRowsRaw = await readRows(sheets.orders, brand.tabName);
      const existingRowsObj = (existingRowsRaw || []).map(normalizeRow);

      if (existingRowsObj.length === 0) {
        results.push({ brand: brand.id, status: 'ok', totalRows: 0, datesFixed: 0, duplicatesRemoved: 0 });
        continue;
      }

      const workingRows = existingRowsObj.map(r => HEADERS.map(h => r[h] ?? ''));
      const dateIdx = HEADERS.indexOf('date');

      let datesFixed = 0;
      workingRows.forEach(row => {
        const cleaned = normalizeDate(row[dateIdx]);
        if (cleaned !== row[dateIdx]) datesFixed++;
        row[dateIdx] = cleaned;
      });

      const before = workingRows.length;
      const cleanedRows = collapseDuplicates(workingRows, HEADERS);
      const duplicatesRemoved = before - cleanedRows.length;

      if (!dryRun && (datesFixed > 0 || duplicatesRemoved > 0)) {
        await replaceRows(sheets.orders, brand.tabName, HEADERS, cleanedRows, token);
      }

      results.push({
        brand: brand.id, status: 'ok',
        totalRows: before, datesFixed, duplicatesRemoved,
        wrote: !dryRun && (datesFixed > 0 || duplicatesRemoved > 0),
      });
      console.log(`[dedupe-orders] ${brand.id} — rows=${before} datesFixed=${datesFixed} duplicatesRemoved=${duplicatesRemoved} ${dryRun ? '(dry run — not written)' : ''}`);
    } catch (err) {
      console.error(`[dedupe-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'dedupe-orders',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': `${failedBrands.length} of ${activeBrands.length}` }
    );
  }

  const totals = results.reduce((acc, r) => ({
    datesFixed: acc.datesFixed + (r.datesFixed || 0),
    duplicatesRemoved: acc.duplicatesRemoved + (r.duplicatesRemoved || 0),
  }), { datesFixed: 0, duplicatesRemoved: 0 });

  res.status(200).json({ dryRun, totals, results });
};

// ── Helpers — same logic as sync-orders-process.js's 2026-08-13 hardening ──

function normalizeRow(r) {
  if (Array.isArray(r)) {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  }
  return r;
}

function normalizeDate(v) {
  const s = String(v ?? '');
  return s.slice(0, 10);
}

function collapseDuplicates(rows, headers) {
  const oidIdx = headers.indexOf('order_id');
  const skuIdx = headers.indexOf('sku');
  const luIdx  = headers.indexOf('last_updated');

  const winners = new Map();
  const untouched = [];

  for (const row of rows) {
    const oid = row[oidIdx];
    const sku = row[skuIdx];
    if (!oid || !sku) { untouched.push(row); continue; }

    const key = `${oid}||${sku}`;
    const existing = winners.get(key);
    if (!existing || String(row[luIdx] || '') > String(existing[luIdx] || '')) {
      winners.set(key, row);
    }
  }

  return [...untouched, ...winners.values()];
}
