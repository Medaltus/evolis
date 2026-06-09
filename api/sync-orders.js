/**
 * api/cron/sync-orders.js
 * Nightly cron — syncs Amazon orders to Google Sheets.
 * Runs at 2:00 AM UTC. One tab per brand, auto-created on first run.
 *
 * Sheet: amazon-orders
 * Columns: order_id, date, status, total_revenue, unit_count,
 *          is_ad_order, skus, brand, last_updated
 */

const { spRequest }                              = require('../_spauth');
const { ensureTab, replaceRows, getSheetsToken } = require('../config/_sheets_client');
const brands                                     = require('../config/brands');
const sheets                                     = require('../config/sheets');

const HEADERS = [
  'order_id', 'date', 'status', 'total_revenue',
  'unit_count', 'is_ad_order', 'skus', 'brand', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Verify cron secret so endpoint can't be triggered by anyone else
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      console.log(`[sync-orders] starting ${brand.id}`);
      const rows = await fetchOrderRows(brand);
      const token = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      await replaceRows(sheets.orders, brand.tabName, HEADERS, rows, token);
      results.push({ brand: brand.id, status: 'ok', rows: rows.length });
      console.log(`[sync-orders] ${brand.id} — ${rows.length} rows written`);
    } catch (err) {
      console.error(`[sync-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: new Date().toISOString() });
};

async function fetchOrderRows(brand) {
  // Sync rolling 13 months so we always have a full year + current month
  const rows   = [];
  const months = rollingMonths(13);

  for (const { start, end } of months) {
    const orders = await paginateOrders(start, end);
    const now    = new Date().toISOString();

    for (const order of orders) {
      // Fetch line items to get SKUs and unit count
      let items = [];
      try {
        const resp = await spRequest('GET', `/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
        items = resp.payload?.OrderItems || [];
      } catch (e) {
        console.warn(`[sync-orders] items fetch failed for ${order.AmazonOrderId}`);
      }

      // Filter to this brand's SKU prefix
      const brandItems = items.filter(item =>
        (item.SellerSKU || '').toUpperCase().startsWith(brand.skuPrefix.toUpperCase())
      );

      // Skip orders with no items for this brand
      if (brandItems.length === 0) continue;

      const unitCount  = brandItems.reduce((s, i) => s + (i.QuantityOrdered || 0), 0);
      const skuList    = [...new Set(brandItems.map(i => i.SellerSKU))].join(', ');
      const revenue    = parseFloat(order.OrderTotal?.Amount || 0);
      const isAd       = Array.isArray(order.PromotionIds) && order.PromotionIds.length > 0;

      rows.push([
        order.AmazonOrderId,
        order.PurchaseDate?.slice(0, 10) || '',
        order.OrderStatus || '',
        round2(revenue),
        unitCount,
        isAd ? 'TRUE' : 'FALSE',
        skuList,
        brand.id,
        now,
      ]);

      await sleep(200); // stay under order items rate limit
    }

    await sleep(1000); // pause between months
  }

  return rows;
}

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
        };

    const response = await spRequest('GET', '/orders/v0/orders', query);
    orders.push(...(response.payload?.Orders || []));
    nextToken = response.payload?.NextToken || null;
    if (nextToken) await sleep(2000);
  } while (nextToken);

  return orders.filter(o => o.OrderStatus !== 'Canceled');
}

function rollingMonths(n) {
  const months = [];
  const now    = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d       = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year    = d.getFullYear();
    const month   = d.getMonth() + 1;
    const pad     = x => String(x).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    months.push({
      start: `${year}-${pad(month)}-01T00:00:00Z`,
      end:   `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z`,
    });
  }
  return months;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
