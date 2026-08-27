/**
 * api/cleanup-non-standard-order-ids.js
 * ONE-OFF, manually-triggered cleanup — removes existing rows whose
 * order_id doesn't match Amazon's standard retail format
 * (XXX-XXXXXXX-XXXXXXX, all numeric) from every active brand's tab in
 * BOTH SHEET_ORDERS and SHEET_ORDERS_HISTORICAL.
 *
 * Confirmed 2026-08-27 per Jaclyn: order IDs with a non-numeric prefix
 * like "S01-" are removal/liquidation or MCF-related records, not real
 * customer orders (confirmed by directly clicking through to a Removal
 * Order page, and independently confirmed on an Amazon seller forum).
 * These showed $0 item_price/order_total but a real quantity_ordered,
 * silently inflating unit-sold counts. sync-orders-process.js and
 * sync-orders-backfill.js were both fixed the same day to stop writing
 * these going forward — this script is the one-time cleanup for
 * whatever they already wrote before that fix existed.
 *
 * Writes nothing until dryRun=false is explicitly passed — defaults to
 * a safe preview.
 *
 * Usage:
 *   GET /api/cleanup-non-standard-order-ids?dryRun=true
 *   Authorization: Bearer <CRON_SECRET>
 *   &brand=skinuva   — restrict to one brand (omit to check every active brand)
 *   &dryRun=false    — actually remove the rows (default true, preview only)
 */

const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const brandsConfig                         = require('./config/brands');
const sheets                               = require('./config/sheets');

const STANDARD_ORDER_ID_PATTERN = /^\d{3}-\d{7}-\d{7}$/;

// Must match each sheet's real, current header shape exactly — see
// sync-orders-process.js / sync-orders-backfill.js for the source of
// truth on each. Getting either of these wrong would corrupt the sheet
// on write, so these are duplicated here deliberately rather than
// inferred, matching how every other cron in this project keeps its own
// explicit HEADERS constant instead of trying to share one.
const ROLLING_HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
  'Amazon Estimated fees', 'Amazon Sale Promotions', 'marketplace', 'channel', 'selling_account',
];

const HISTORICAL_HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'skus', 'asin', 'brand', 'last_updated', 'selling_account',
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
    for (const [sheetLabel, sheetId, HEADERS] of [
      ['rolling', sheets.orders, ROLLING_HEADERS],
      ['historical', sheets.ordersHistorical, HISTORICAL_HEADERS],
    ]) {
      try {
        const token = await ensureTab(sheetId, brand.tabName, HEADERS);
        const existingRows = await readRows(sheetId, brand.tabName);
        if (!existingRows || existingRows.length === 0) {
          results.push({ brand: brand.id, sheet: sheetLabel, status: 'ok', totalRows: 0, removed: 0 });
          continue;
        }

        const kept = [];
        const removed = [];
        existingRows.forEach(r => {
          const orderId = r.order_id || '';
          if (orderId && !STANDARD_ORDER_ID_PATTERN.test(orderId)) {
            removed.push(orderId);
          } else {
            kept.push(r);
          }
        });

        if (removed.length > 0 && !dryRun) {
          const outRows = kept.map(r => HEADERS.map(h => r[h] ?? ''));
          await replaceRows(sheetId, brand.tabName, HEADERS, outRows, token);
        }

        console.log(`[cleanup-non-standard-order-ids] ${brand.id} (${sheetLabel}) — ${removed.length} removed of ${existingRows.length} total${dryRun ? ' [DRY RUN — nothing written]' : ''}`);
        results.push({
          brand: brand.id,
          sheet: sheetLabel,
          status: 'ok',
          totalRows: existingRows.length,
          removed: removed.length,
          removedOrderIds: removed.slice(0, 20), // sample, not the full list — could be large
        });
      } catch (err) {
        console.error(`[cleanup-non-standard-order-ids] ${brand.id} (${sheetLabel}) failed:`, err.message);
        results.push({ brand: brand.id, sheet: sheetLabel, status: 'error', error: err.message });
      }
    }
  }

  const totalRemoved = results.reduce((s, r) => s + (r.removed || 0), 0);
  res.status(200).json({ dryRun, totalRemoved, results });
};
