/**
 * api/cron/sync-orders.js
 * Runs every 2 hours — pulls orders from the last 2.5 hours for ALL brands.
 * Writes to the rolling current-month sheet (amazon-orders).
 * Deduplicates on order_id before writing — safe to re-run.
 *
 * Modes (via ?mode=):
 *   rolling   — last 2.5 hours (default, used by cron)
 *   day       — today from midnight UTC to now-10min (safe CreatedBefore)
 *   yesterday — full yesterday
 *   week      — explicit ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *               end date is capped to now-10min if it would be in the future
 *
 * Sheet: amazon-orders  |  One tab per brand, auto-created on first run.
 */

const { spRequest }                                              = require('../_spauth');
const { ensureTab, appendRows, readRows }                        = require('../config/_sheets_client');
const brands                                                     = require('../config/brands');
const sheets                                                     = require('../config/sheets');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'skus', 'brand', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mode    = req.query.mode || 'rolling';
  const results = [];

  const dateRanges = getDateRanges(mode, req);
  const allOrders  = [];

  for (const range of dateRanges) {
    const batch = await paginateOrders(range.start, range.end);
    allOrders.push(...batch);
    await sleep(500);
  }

  console.log(`[sync-orders] ${allOrders.length} total orders across all brands`);

  if (allOrders.length === 0) {
    return res.status(200).json({
      synced: brands.filter(b => b.active).map(b => ({ brand: b.id, status: 'ok', rows: 0, mode })),
      totalOrders: 0,
      timestamp: new Date().toISOString(),
    });
  }

  // Fetch items for all orders in batches of 5
  const orderItems = {};
  for (let i = 0; i < allOrders.length; i += 5) {
    const batch = allOrders.slice(i, i + 5);
    await Promise.all(batch.map(async order => {
      try {
        const resp = await spRequest('GET', `/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
        orderItems[order.AmazonOrderId] = resp.payload?.OrderItems || [];
      } catch (e) {
        console.warn(`[sync-orders] items failed for ${order.AmazonOrderId}`);
        orderItems[order.AmazonOrderId] = [];
      }
    }));
    if (i + 5 < allOrders.length) await sleep(500);
  }

  const now = new Date().toISOString();

  for (const brand of brands.filter(b => b.active)) {
    try {
      // Build new rows for this brand
      const newRows = [];

      for (const order of allOrders) {
        const items      = orderItems[order.AmazonOrderId] || [];
        const brandItems = items.filter(item =>
          (item.SellerSKU || '').toUpperCase().startsWith(brand.skuPrefix.toUpperCase())
        );
        if (brandItems.length === 0) continue;

        const quantityOrdered   = brandItems.reduce((s, i) => s + (i.QuantityOrdered  || 0), 0);
        const quantityShipped   = brandItems.reduce((s, i) => s + (i.QuantityShipped  || 0), 0);
        const itemPrice         = round2(brandItems.reduce((s, i) =>
          s + parseFloat(i.ItemPrice?.Amount || 0) * (i.QuantityOrdered || 1), 0));
        const promotionDiscount = round2(brandItems.reduce((s, i) =>
          s + parseFloat(i.PromotionDiscount?.Amount || 0), 0));
        const skus              = [...new Set(brandItems.map(i => i.SellerSKU))].join(', ');
        const orderTotal        = round2(parseFloat(order.OrderTotal?.Amount || 0));
        const promotionIds      = (order.PromotionIds || []).join(', ');
        const isPremium         = order.IsPremiumOrder === true || order.IsPremiumOrder === 'true'
          ? 'TRUE' : 'FALSE';

        newRows.push([
          order.AmazonOrderId,
          order.PurchaseDate?.slice(0, 10) || '',
          order.OrderStatus || '',
          orderTotal,
          promotionIds,
          isPremium,
          promotionDiscount,
          itemPrice,
          quantityOrdered,
          quantityShipped,
          quantityOrdered,
          skus,
          brand.id,
          now,
        ]);
      }

      if (newRows.length === 0) {
        console.log(`[sync-orders] ${brand.id} — 0 rows (no orders in window)`);
        results.push({ brand: brand.id, status: 'ok', rows: 0, mode });
        continue;
      }

      // Dedup — read existing order_ids and skip any already present
      const token        = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.orders, brand.tabName);
      const existingIds  = new Set(existingRows.map(r => r.order_id).filter(Boolean));

      const dedupedRows = newRows.filter(row => !existingIds.has(row[0]));
      const dupCount    = newRows.length - dedupedRows.length;

      if (dupCount > 0) {
        console.log(`[sync-orders] ${brand.id} — skipped ${dupCount} duplicate order_ids`);
      }

      if (dedupedRows.length > 0) {
        await appendRows(sheets.orders, brand.tabName, dedupedRows, token);
        console.log(`[sync-orders] ${brand.id} — ${dedupedRows.length} rows written`);
      } else {
        console.log(`[sync-orders] ${brand.id} — 0 new rows (all duplicates)`);
      }

      results.push({ brand: brand.id, status: 'ok', rows: dedupedRows.length, skipped: dupCount, mode });
    } catch (err) {
      console.error(`[sync-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({
    synced: results,
    totalOrders: allOrders.length,
    timestamp: new Date().toISOString(),
  });
};

// ── Date ranges ───────────────────────────────────────────────────────────────

function getDateRanges(mode, req) {
  const now    = new Date();
  const pad    = n => String(n).padStart(2, '0');
  // Safe CreatedBefore — always at least 10 minutes in the past
  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  if (mode === 'rolling') {
    const hours = parseFloat(req?.query?.hours || 2.5);
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
    return [{ start, end: safeBefore }];
  }

  if (mode === 'day') {
    // Today from midnight UTC to now-10min — safe for backfilling today
    const y = now.getUTCFullYear(), m = pad(now.getUTCMonth() + 1), d = pad(now.getUTCDate());
    return [{ start: `${y}-${m}-${d}T00:00:00Z`, end: safeBefore }];
  }

  if (mode === 'yesterday') {
    const d   = new Date(now); d.setDate(d.getDate() - 1);
    const y   = d.getFullYear(), m = pad(d.getMonth() + 1), day = pad(d.getDate());
    return [{ start: `${y}-${m}-${day}T00:00:00Z`, end: `${y}-${m}-${day}T23:59:59Z` }];
  }

  if (mode === 'week') {
    const start = req?.query?.start;
    const end   = req?.query?.end;
    if (!start || !end) throw new Error('mode=week requires ?start=YYYY-MM-DD&end=YYYY-MM-DD');
    // Cap end to safeBefore if it would be today or in the future
    const endTs  = new Date(`${end}T23:59:59Z`);
    const endStr = endTs > now ? safeBefore : `${end}T23:59:59Z`;
    return [{ start: `${start}T00:00:00Z`, end: endStr }];
  }

  return [];
}

// ── SP-API pagination ─────────────────────────────────────────────────────────

async function paginateOrders(start, end) {
  const orders  = [];
  let nextToken = null;
  do {
    const query = nextToken
      ? { NextToken: nextToken }
      : {
          MarketplaceIds:    process.env.SP_MARKETPLACE_ID,
          CreatedAfter:      start,
          CreatedBefore:     end,
          MaxResultsPerPage: '100',
          OrderStatuses:     'Pending,Unshipped,PartiallyShipped,Shipped,InvoiceUnconfirmed,Unfulfillable',
        };
    const response = await spRequest('GET', '/orders/v0/orders', query);
    orders.push(...(response.payload?.Orders || []));
    nextToken = response.payload?.NextToken || null;
    if (nextToken) await sleep(2000);
  } while (nextToken);
  return orders;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
