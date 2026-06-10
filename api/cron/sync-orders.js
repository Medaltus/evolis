/**
 * api/cron/sync-orders.js
 * Runs every 2 hours — pulls orders from the last 2.5 hours for ALL brands.
 * Writes to the rolling current-month sheet (amazon-orders).
 * Small batches, never times out.
 *
 * Modes (via ?mode=):
 *   rolling   — last 2.5 hours (default, used by cron)
 *   yesterday — full yesterday
 *   week      — explicit ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Sheet: amazon-orders  |  One tab per brand, auto-created on first run.
 */

const { spRequest }                                              = require('../_spauth');
const { ensureTab, appendRows, replaceRows, readRows }          = require('../config/_sheets_client');
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

  // Fetch all orders in the time window once — then split by brand
  // This is more efficient than fetching per brand
  const dateRanges  = getDateRanges(mode, req);
  const allOrders   = [];

  for (const range of dateRanges) {
    const batch = await paginateOrders(range.start, range.end);
    allOrders.push(...batch);
    await sleep(500);
  }

  console.log(`[sync-orders] ${allOrders.length} total orders across all brands`);

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

  // Now split by brand and write to sheet
  const now = new Date().toISOString();

  for (const brand of brands.filter(b => b.active)) {
    try {
      const rows = [];

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

        rows.push([
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

      if (rows.length > 0) {
        const token = await ensureTab(sheets.orders, brand.tabName, HEADERS);
        await appendRows(sheets.orders, brand.tabName, rows, token);
        console.log(`[sync-orders] ${brand.id} — ${rows.length} rows written`);
      } else {
        console.log(`[sync-orders] ${brand.id} — 0 rows (no orders in window)`);
      }

      results.push({ brand: brand.id, status: 'ok', rows: rows.length, mode });
    } catch (err) {
      console.error(`[sync-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, totalOrders: allOrders.length, timestamp: new Date().toISOString() });
};

// ── Date ranges ───────────────────────────────────────────────────────────────

function getDateRanges(mode, req) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');

  if (mode === 'rolling') {
    const hours = parseFloat(req?.query?.hours || 2.5);
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
    const end   = new Date(now.getTime() - 5 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
    return [{ start, end }];
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
    return [{ start: `${start}T00:00:00Z`, end: `${end}T23:59:59Z` }];
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
