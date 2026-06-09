/**
 * api/cron/sync-orders.js
 * Nightly cron — syncs Amazon orders to Google Sheets.
 * Runs at 2:00 AM UTC.
 *
 * ?mode=yesterday   — only yesterday (default, used by nightly cron)
 * ?mode=month       — current month to date
 * ?mode=backfill    — rolling 13 months (one-time seed)
 *
 * Sheet: amazon-orders  |  Tab: {brand}
 * One row per order, line item fields aggregated across all brand SKUs in the order.
 */

const { spRequest }                                        = require('../_spauth');
const { ensureTab, appendRows, replaceRows, readRows, getSheetsToken } = require('../config/_sheets_client');
const brands                                               = require('../config/brands');
const sheets                                               = require('../config/sheets');

const HEADERS = [
  'order_id',
  'date',
  'status',
  'order_total',         // what the customer actually paid (basis for AOV)
  'promotion_ids',       // comma-separated — SS- prefix = Subscribe & Save, Vine = Vine program
  'is_premium_order',    // TRUE/FALSE — Prime order
  'promotion_discount',  // total discount applied across all brand line items
  'item_price',          // sum of item_price across all brand line items
  'quantity_ordered',    // total units ordered across all brand line items
  'quantity_shipped',    // total units shipped across all brand line items
  'unit_count',          // alias of quantity_ordered for backwards compat
  'skus',                // distinct SKUs in this order for this brand
  'brand',
  'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mode  = req.query.mode || 'yesterday';
  const year  = req.query.year  ? parseInt(req.query.year)  : null;
  const month = req.query.month ? parseInt(req.query.month) : null;
  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      console.log(`[sync-orders] ${brand.id} mode=${mode}`);

      const dateRanges = getDateRanges(mode, year, month, req);
      const rows       = await fetchOrderRows(brand, dateRanges);
      const token      = await ensureTab(sheets.orders, brand.tabName, HEADERS);

      if (mode === 'yesterday') {
        // Append only — never wipe existing data
        await appendRows(sheets.orders, brand.tabName, rows, token);
      } else if (mode === 'month') {
        // Delete only rows for this specific month, then append fresh data
        // This preserves all other months' data
        await replaceMonth(sheets.orders, brand.tabName, rows, token, year || new Date().getFullYear(), month || new Date().getMonth() + 1);
      } else {
        // backfill — full replace
        await replaceRows(sheets.orders, brand.tabName, HEADERS, rows, token);
      }

      results.push({ brand: brand.id, status: 'ok', rows: rows.length, mode });
      console.log(`[sync-orders] ${brand.id} — ${rows.length} rows written`);
    } catch (err) {
      console.error(`[sync-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: new Date().toISOString() });
};

// ── Date range builder ────────────────────────────────────────────────────────

function getDateRanges(mode, yearParam, monthParam, req) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');

  if (mode === 'yesterday') {
    const d   = new Date(now);
    d.setDate(d.getDate() - 1);
    const y   = d.getFullYear();
    const m   = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    return [{ start: `${y}-${m}-${day}T00:00:00Z`, end: `${y}-${m}-${day}T23:59:59Z` }];
  }

  if (mode === 'week') {
    // Explicit date range — pass start and end as YYYY-MM-DD
    const startDate = req ? req.query.start : null;
    const endDate   = req ? req.query.end   : null;
    if (!startDate || !endDate) throw new Error('mode=week requires ?start=YYYY-MM-DD&end=YYYY-MM-DD');
    return [{ start: `${startDate}T00:00:00Z`, end: `${endDate}T23:59:59Z` }];
  }

  if (mode === 'month') {
    const y       = yearParam  || now.getFullYear();
    const m       = monthParam || now.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    const isCurrentMonth = (y === now.getFullYear() && m === now.getMonth() + 1);

    // Split month into weekly chunks to avoid timeout on high-volume accounts
    const weeks = [];
    let dayStart = 1;
    while (dayStart <= lastDay) {
      const dayEnd = Math.min(dayStart + 6, lastDay);
      const endIsNow = isCurrentMonth && dayEnd === lastDay;
      weeks.push({
        start: `${y}-${pad(m)}-${pad(dayStart)}T00:00:00Z`,
        end:   endIsNow
          ? new Date(now.getTime() - 5 * 60 * 1000).toISOString().slice(0, 19) + 'Z'
          : `${y}-${pad(m)}-${pad(dayEnd)}T23:59:59Z`,
      });
      dayStart += 7;
    }
    return weeks;
  }

  // backfill — rolling 13 months
  return rollingMonths(13);
}

// ── Main fetch + transform ────────────────────────────────────────────────────

async function fetchOrderRows(brand, dateRanges) {
  const rows = [];
  const now  = new Date().toISOString();

  for (const { start, end } of dateRanges) {
    const orders = await paginateOrders(start, end);
    console.log(`[sync-orders] ${brand.id} — ${orders.length} orders found between ${start.slice(0,10)} and ${end.slice(0,10)}`);

    for (const order of orders) {
      // Fetch line items
      let items = [];
      try {
        const resp = await spRequest('GET', `/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
        items = resp.payload?.OrderItems || [];
      } catch (e) {
        console.warn(`[sync-orders] items failed for ${order.AmazonOrderId}: ${e.message}`);
      }

      // Filter to this brand's SKUs only
      const brandItems = items.filter(item =>
        (item.SellerSKU || '').toUpperCase().startsWith(brand.skuPrefix.toUpperCase())
      );
      if (brandItems.length === 0) continue;

      // ── Aggregate line item fields across all brand SKUs in this order ──
      const quantityOrdered  = brandItems.reduce((s, i) => s + (i.QuantityOrdered  || 0), 0);
      const quantityShipped  = brandItems.reduce((s, i) => s + (i.QuantityShipped  || 0), 0);
      const itemPrice        = round2(brandItems.reduce((s, i) =>
        s + parseFloat(i.ItemPrice?.Amount || 0) * (i.QuantityOrdered || 1), 0));
      const promotionDiscount = round2(brandItems.reduce((s, i) =>
        s + parseFloat(i.PromotionDiscount?.Amount || 0), 0));
      const skus             = [...new Set(brandItems.map(i => i.SellerSKU))].join(', ');

      // ── Order-level fields ──
      const orderTotal   = round2(parseFloat(order.OrderTotal?.Amount || 0));
      const promotionIds = (order.PromotionIds || []).join(', ');
      const isPremium    = order.IsPremiumOrder === true || order.IsPremiumOrder === 'true'
        ? 'TRUE' : 'FALSE';

      rows.push([
        order.AmazonOrderId,
        order.PurchaseDate?.slice(0, 10) || '',
        order.OrderStatus  || '',
        orderTotal,
        promotionIds,
        isPremium,
        promotionDiscount,
        itemPrice,
        quantityOrdered,
        quantityShipped,
        quantityOrdered,   // unit_count mirrors quantity_ordered
        skus,
        brand.id,
        now,
      ]);

      await sleep(200); // respect order items rate limit
    }

    await sleep(1000); // pause between date ranges
  }

  return rows;
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

  return orders; // all statuses explicitly requested above — no client-side filter needed
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Replace only the rows for a specific year/month in the sheet.
 * All other months' rows are preserved.
 */
async function replaceMonth(sheetId, tabName, newRows, token, year, month) {
  const { getSheetsToken, readRows } = require('../config/_sheets_client');

  // Read all existing rows
  const existing = await readRows(sheetId, tabName);

  // Keep rows that are NOT in the target month
  const keepRows = existing.filter(row => {
    const d = row.date || '';
    const rowYear  = parseInt(d.slice(0, 4));
    const rowMonth = parseInt(d.slice(5, 7));
    return !(rowYear === year && rowMonth === month);
  });

  // Convert kept rows back to arrays (in header order)
  const keptArrays = keepRows.map(row => HEADERS.map(h => row[h] ?? ''));

  // Write kept rows + new rows back
  const allRows = [...keptArrays, ...newRows];
  await replaceRows(sheetId, tabName, HEADERS, allRows, token);
  console.log(`[sync-orders] replaceMonth: kept ${keptArrays.length} rows from other months, wrote ${newRows.length} new rows for ${year}-${month}`);
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
