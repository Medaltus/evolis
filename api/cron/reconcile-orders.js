/**
 * api/cron/reconcile-orders.js
 * Runs daily — finds Pending orders in the rolling sheet and updates
 * their status, order_total, and last_updated from SP-API.
 *
 * Why: the 2-hour rolling sync captures orders when first placed (often
 * Pending). This cron goes back and resolves them to Shipped/Cancelled/etc.
 *
 * Schedule: daily at 8AM UTC ("0 8 * * *")
 *
 * GET /api/cron/reconcile-orders
 * Authorization: Bearer <CRON_SECRET>
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'skus', 'brand', 'last_updated',
];

// Only reconcile orders placed within the last N days — Pending orders
// older than this are likely stuck/edge cases and not worth API calls
const MAX_PENDING_AGE_DAYS = 14;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now        = new Date().toISOString();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_PENDING_AGE_DAYS);
  const cutoffStr  = cutoffDate.toISOString().slice(0, 10);

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token   = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const allRows = await readRows(sheets.orders, brand.tabName);

      // Find Pending rows within the reconciliation window
      const pendingRows = allRows.filter(r =>
        (r.status || '').toLowerCase() === 'pending' &&
        (r.date   || '') >= cutoffStr
      );

      if (pendingRows.length === 0) {
        console.log(`[reconcile] ${brand.id} — no pending orders`);
        results.push({ brand: brand.id, pending: 0, updated: 0 });
        continue;
      }

      console.log(`[reconcile] ${brand.id} — ${pendingRows.length} pending orders to check`);

      // Fetch current status from SP-API in batches of 50
      // (SP-API supports up to 50 order IDs per request)
      const orderIds    = pendingRows.map(r => r.order_id).filter(Boolean);
      const fetchedMap  = {};

      for (let i = 0; i < orderIds.length; i += 50) {
        const batch = orderIds.slice(i, i + 50);
        try {
          const resp = await spRequest('GET', '/orders/v0/orders', {
            MarketplaceIds: process.env.SP_MARKETPLACE_ID,
            OrderIds:       batch.join(','),
          });
          for (const order of (resp.payload?.Orders || [])) {
            fetchedMap[order.AmazonOrderId] = order;
          }
        } catch (e) {
          console.warn(`[reconcile] ${brand.id} batch fetch failed:`, e.message);
        }
        if (i + 50 < orderIds.length) await sleep(500);
      }

      // Patch rows in memory
      let updatedCount = 0;
      const patched = allRows.map(row => {
        if ((row.status || '').toLowerCase() !== 'pending') return row;
        const fetched = fetchedMap[row.order_id];
        if (!fetched) return row; // not found — leave as-is

        const newStatus = fetched.OrderStatus || row.status;
        if (newStatus === row.status) return row; // no change

        updatedCount++;
        return {
          ...row,
          status:        newStatus,
          order_total:   fetched.OrderTotal?.Amount
                           ? round2(parseFloat(fetched.OrderTotal.Amount))
                           : row.order_total,
          last_updated:  now,
        };
      });

      if (updatedCount > 0) {
        const rowArrays = patched.map(row => HEADERS.map(h => row[h] ?? ''));
        await replaceRows(sheets.orders, brand.tabName, HEADERS, rowArrays, token);
        console.log(`[reconcile] ${brand.id} — updated ${updatedCount} orders`);
      } else {
        console.log(`[reconcile] ${brand.id} — ${pendingRows.length} still pending, no changes`);
      }

      results.push({ brand: brand.id, pending: pendingRows.length, updated: updatedCount });
    } catch (err) {
      console.error(`[reconcile] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const totalUpdated = results.reduce((s, r) => s + (r.updated || 0), 0);

  res.status(200).json({
    results,
    totalUpdated,
    timestamp: now,
  });
};

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
