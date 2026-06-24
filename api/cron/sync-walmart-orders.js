/**
 * api/cron/sync-walmart-orders.js
 * Runs every 2 hours — pulls orders from Walmart Marketplace API.
 * Writes one row per line item (one SKU per row) to the rolling sheet.
 * Deduplicates on purchaseOrderId + sku — safe to re-run.
 *
 * Row structure mirrors amazon-orders for dashboard compatibility:
 *   order_id, date, status, order_total, promotion_ids, is_premium_order,
 *   promotion_discount, item_price, quantity_ordered, quantity_shipped,
 *   unit_count, sku, brand, last_updated
 *
 * Modes:
 *   rolling   — last 2.5 hours (default, used by cron)
 *   day       — today from midnight UTC to now
 *   yesterday — full yesterday
 *   week      — ?start=YYYY-MM-DD&end=YYYY-MM-DD (with optional startTime/endTime)
 *
 * Sheet: Newderm - Walmart Orders Cache (WALMART_ORDERS_SHEET)
 * One tab per brand, auto-created on first run.
 */

const https = require('https');
const { ensureTab, appendRows, readRows } = require('../config/_sheets_client');
const brands = require('../config/brands');

const WM_HOST       = 'marketplace.walmartapis.com';
const WM_TOKEN_PATH = '/v3/token';
const WM_PAGE_LIMIT = 100;

const SHEET_ID = process.env.WALMART_ORDERS_SHEET;

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'brand', 'last_updated',
];

// SKU prefix → brand mapping (same as Amazon)
const SKU_PREFIX_MAP = {};
brands.filter(b => b.active).forEach(b => {
  SKU_PREFIX_MAP[b.skuPrefix.toUpperCase()] = b;
});

function identifyBrand(sku) {
  const upper = (sku || '').toUpperCase();
  return brands.find(b => b.active && upper.startsWith(b.skuPrefix.toUpperCase())) || null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SHEET_ID) return res.status(500).json({ error: 'WALMART_ORDERS_SHEET env var not set' });

  const mode = req.query.mode || 'rolling';
  const { startDate, endDate } = getDateRange(mode, req);

  console.log(`[sync-walmart-orders] mode=${mode} start=${startDate} end=${endDate}`);

  const now = new Date().toISOString();

  try {
    // ── 1. Get token ──────────────────────────────────────────────────────────
    const tokenData = await getWalmartToken();
    const token     = tokenData.access_token;
    if (!token) throw new Error('No access_token returned');
    console.log('[sync-walmart-orders] token obtained');

    // ── 2. Fetch all orders in date range (paginated) ─────────────────────────
    const allOrders = [];
    let   nextCursor = null;
    let   page       = 0;

    do {
      page++;
      const path = buildOrdersPath(startDate, endDate, nextCursor);
      console.log(`[sync-walmart-orders] fetching page ${page}: ${path.slice(0, 80)}...`);
      const data = await wmRequest('GET', path, token);

      const orders = data?.list?.elements?.order || [];
      allOrders.push(...orders);

      const meta = data?.list?.meta;
      nextCursor = meta?.nextCursor || null;

      console.log(`[sync-walmart-orders] page ${page}: ${orders.length} orders (total so far: ${allOrders.length})`);

      // Safety cap — avoid runaway pagination
      if (page >= 50) { console.warn('[sync-walmart-orders] hit page cap'); break; }
    } while (nextCursor);

    console.log(`[sync-walmart-orders] total orders fetched: ${allOrders.length}`);

    if (allOrders.length === 0) {
      return res.status(200).json({ message: 'No orders in range', mode, startDate, endDate });
    }

    // ── 3. Flatten to line items ──────────────────────────────────────────────
    const lineItems = [];
    for (const order of allOrders) {
      const orderId   = order.purchaseOrderId || '';
      const orderDate = order.orderDate
        ? new Date(order.orderDate).toISOString().slice(0, 10)
        : '';

      const lines = order.orderLines?.orderLine || [];
      for (const line of lines) {
        const sku      = line.item?.sku || '';
        const qty      = parseInt(line.orderLineQuantity?.amount || '1', 10);
        const status   = line.orderLineStatuses?.orderLineStatus?.[0]?.status || '';
        const qtyShip  = parseInt(line.orderLineStatuses?.orderLineStatus?.[0]?.statusQuantity?.amount || '0', 10);

        // Sum PRODUCT charges only
        const charges  = line.charges?.charge || [];
        const itemPrice = charges
          .filter(c => c.chargeType === 'PRODUCT')
          .reduce((sum, c) => sum + (c.chargeAmount?.amount || 0), 0);

        lineItems.push({
          order_id:           orderId,
          date:               orderDate,
          status,
          order_total:        round2(itemPrice),
          promotion_ids:      '',
          is_premium_order:   'FALSE',
          promotion_discount: 0,
          item_price:         round2(itemPrice),
          quantity_ordered:   qty,
          quantity_shipped:   qtyShip,
          unit_count:         qty,
          sku,
          brand_obj:          identifyBrand(sku),
          last_updated:       now,
        });
      }
    }

    console.log(`[sync-walmart-orders] total line items: ${lineItems.length}`);

    // ── 4. Per-brand write ────────────────────────────────────────────────────
    // Group line items by brand
    const byBrand = {};
    const unmatched = [];

    for (const item of lineItems) {
      if (item.brand_obj) {
        const key = item.brand_obj.tabName;
        if (!byBrand[key]) byBrand[key] = { brand: item.brand_obj, items: [] };
        byBrand[key].items.push(item);
      } else {
        unmatched.push(item);
      }
    }

    if (unmatched.length > 0) {
      console.warn(`[sync-walmart-orders] ${unmatched.length} line items with unrecognized SKU prefix`);
      unmatched.slice(0, 5).forEach(i => console.warn(`  SKU: ${i.sku}`));
    }

    const results = [];

    for (const [tabName, { brand, items }] of Object.entries(byBrand)) {
      try {
        const token2       = await ensureTab(SHEET_ID, tabName, HEADERS);
        const existingRows = await readRows(SHEET_ID, tabName);
        const existingKeys = new Set(
          existingRows
            .map(r => `${r.order_id}||${r.sku}`)
            .filter(k => k !== '||')
        );

        const newRows = items
          .filter(item => !existingKeys.has(`${item.order_id}||${item.sku}`))
          .map(item => [
            item.order_id, item.date, item.status, item.order_total,
            item.promotion_ids, item.is_premium_order, item.promotion_discount,
            item.item_price, item.quantity_ordered, item.quantity_shipped,
            item.unit_count, item.sku, brand.id, item.last_updated,
          ]);

        const dupCount = items.length - newRows.length;
        if (dupCount > 0) console.log(`[sync-walmart-orders] ${tabName} — skipped ${dupCount} duplicates`);

        if (newRows.length > 0) {
          await appendRows(SHEET_ID, tabName, newRows, token2);
          console.log(`[sync-walmart-orders] ${tabName} — wrote ${newRows.length} rows`);
        } else {
          console.log(`[sync-walmart-orders] ${tabName} — 0 new rows`);
        }

        results.push({ brand: brand.id, rows: newRows.length, skipped: dupCount });
      } catch (err) {
        console.error(`[sync-walmart-orders] ${tabName} failed:`, err.message);
        results.push({ brand: brand.id, status: 'error', error: err.message });
      }
    }

    return res.status(200).json({ synced: results, totalOrders: allOrders.length, mode, startDate, endDate, timestamp: now });

  } catch (err) {
    console.error('[sync-walmart-orders] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Date range helpers ────────────────────────────────────────────────────────
function getDateRange(mode, req) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => d.toISOString().slice(0, 19) + 'Z';
  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000);

  if (mode === 'rolling') {
    const hours = parseFloat(req?.query?.hours || 2.5);
    return {
      startDate: fmt(new Date(now.getTime() - hours * 60 * 60 * 1000)),
      endDate:   fmt(safeBefore),
    };
  }

  if (mode === 'day') {
    const y = now.getUTCFullYear(), m = pad(now.getUTCMonth()+1), d = pad(now.getUTCDate());
    return { startDate: `${y}-${m}-${d}T00:00:00Z`, endDate: fmt(safeBefore) };
  }

  if (mode === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    const y = d.getFullYear(), m = pad(d.getMonth()+1), day = pad(d.getDate());
    return { startDate: `${y}-${m}-${day}T00:00:00Z`, endDate: `${y}-${m}-${day}T23:59:59Z` };
  }

  if (mode === 'week') {
    const start     = req?.query?.start;
    const end       = req?.query?.end;
    const startTime = req?.query?.startTime || '00:00:00';
    const endTime   = req?.query?.endTime   || '23:59:59';
    if (!start || !end) throw new Error('mode=week requires ?start=YYYY-MM-DD&end=YYYY-MM-DD');
    const endTs = new Date(`${end}T${endTime}Z`);
    return {
      startDate: `${start}T${startTime}Z`,
      endDate:   endTs > now ? fmt(safeBefore) : `${end}T${endTime}Z`,
    };
  }

  throw new Error(`Unknown mode: ${mode}`);
}

function buildOrdersPath(startDate, endDate, cursor) {
  if (cursor) {
    // cursor already contains the full query string
    return cursor.startsWith('/') ? cursor : `/v3/orders${cursor.startsWith('?') ? '' : '?'}${cursor}`;
  }
  return `/v3/orders?createdStartDate=${encodeURIComponent(startDate)}&createdEndDate=${encodeURIComponent(endDate)}&limit=${WM_PAGE_LIMIT}&status=Created,Acknowledged,Shipped,Cancelled`;
}

// ── Walmart auth ──────────────────────────────────────────────────────────────
function getWalmartToken() {
  return new Promise((resolve, reject) => {
    const clientId     = process.env.WALMART_CLIENT_ID;
    const clientSecret = process.env.WALMART_CLIENT_SECRET;
    const partnerId    = process.env.WALMART_PARTNER_ID;
    if (!clientId || !clientSecret) return reject(new Error('WALMART credentials not set'));

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body        = 'grant_type=client_credentials';
    const headers = {
      'Authorization':         `Basic ${credentials}`,
      'Content-Type':          'application/x-www-form-urlencoded',
      'Accept':                'application/json',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `token-${Date.now()}`,
      'WM_SVC.VERSION':        '1.0.0',
      'Content-Length':        Buffer.byteLength(body),
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const req = https.request({ hostname: WM_HOST, path: WM_TOKEN_PATH, method: 'POST', headers }, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Token parse error (${httpRes.statusCode}): ${d.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Walmart API request ───────────────────────────────────────────────────────
function wmRequest(method, path, token) {
  return new Promise((resolve, reject) => {
    const clientId  = process.env.WALMART_CLIENT_ID;
    const partnerId = process.env.WALMART_PARTNER_ID;
    const headers = {
      'Authorization':         `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
      'WM_SEC.ACCESS_TOKEN':   token,
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `req-${Date.now()}`,
      'WM_SVC.VERSION':        '1.0.0',
      'Accept':                'application/json',
      'Content-Type':          'application/json',
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const req = https.request({ hostname: WM_HOST, path, method, headers }, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error (${httpRes.statusCode}): ${d.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const round2 = n => Math.round(n * 100) / 100;
