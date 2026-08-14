/**
 * api/cron/sync-walmart-orders.js
 * Runs every 2 hours — pulls orders from Walmart Marketplace API.
 * Writes one row per line item (one SKU per row) to the rolling sheet.
 *
 * UPSERTS on purchaseOrderId + sku — CHANGED 2026-08-11 per Jaclyn (was
 * append-only + skip-if-key-exists, which meant a line item's status was
 * frozen forever at whatever it was the first time this cron saw it; a
 * real order sitting in Seller Center as Shipped could sit in this sheet
 * showing Acknowledged indefinitely). Every run now overwrites the
 * mutable fields (status, quantity_shipped, item_price, last_updated) on
 * any row already in the sheet with whatever Walmart's API just
 * returned, and adds genuinely new line items alongside them. Rows for
 * orders that have aged out of the current fetch window are left
 * untouched, not deleted — see getDateRange()'s rolling-mode comment for
 * why a 30-day default makes that safe.
 *
 * Row structure mirrors amazon-orders for dashboard compatibility:
 *   order_id, date, status, order_total, promotion_ids, is_premium_order,
 *   promotion_discount, item_price, quantity_ordered, quantity_shipped,
 *   unit_count, sku, brand, last_updated
 *
 * Modes:
 *   rolling   — last 30 days by default (CHANGED 2026-08-11, was 2.5
 *               hours — see getDateRange() below for why that was the
 *               root cause of a real incident: orders confirmed present
 *               in Seller Center were invisible to this cron for days).
 *               Used by the daily cron; ?hours= still overrides for a
 *               one-off backfill reaching further back than 30 days.
 *   day       — today from midnight UTC to now
 *   yesterday — full yesterday
 *   week      — ?start=YYYY-MM-DD&end=YYYY-MM-DD (with optional startTime/endTime)
 *
 * Sheet: Newderm - Walmart Orders Cache (WALMART_ORDERS_SHEET)
 * One tab per brand, auto-created on first run.
 */

const https = require('https');
const { ensureTab, replaceRows, readRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const { sendCronFailureAlert } = require('../_alerts');

const WM_HOST       = 'marketplace.walmartapis.com';
const WM_TOKEN_PATH = '/v3/token';
const WM_PAGE_LIMIT = 100;

const SHEET_ID = process.env.WALMART_ORDERS_SHEET;

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'brand', 'last_updated', 'fulfillment_type',
];

// SKU prefix → brand mapping (same as Amazon)
const SKU_PREFIX_MAP = {};
brands.filter(b => b.active).forEach(b => {
  SKU_PREFIX_MAP[b.skuPrefix.toUpperCase()] = b;
});

// ADDED 2026-08-14 — skinuva-ca (config/brands.js) shares skinuva's exact
// SKU prefix ('SVA') on purpose. Unlike the Amazon crons, there is NO
// marketplace/channel field anywhere in Walmart's order data model to
// fall back on (confirmed — searched this whole file, only WM_HOST
// matches "marketplace" as a substring) — the SKU's own "-CA" suffix is
// the only signal available here. This is likely a no-op in practice —
// nothing so far suggests skinuva-ca has any Walmart presence at all —
// but costs nothing to apply defensively and keeps this file consistent
// with every other brand-matching cron fixed today, in case that ever
// changes.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

function identifyBrand(sku) {
  const upper = (sku || '').toUpperCase();
  const candidates = brands.filter(b => b.active && upper.startsWith(b.skuPrefix.toUpperCase()));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const isCa = CA_SKU_PATTERN.test(upper);
  if (isCa) {
    const caBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.ca');
    if (caBrand) return caBrand;
  }
  // No CA suffix, or no matching sibling found — default to the
  // Amazon.com-labeled sibling (or just the first candidate if neither
  // is explicitly labeled), same fallback convention used everywhere else.
  return candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.com') || candidates[0];
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SHEET_ID) {
    await sendCronFailureAlert('sync-walmart-orders', 'WALMART_ORDERS_SHEET env var not set');
    return res.status(500).json({ error: 'WALMART_ORDERS_SHEET env var not set' });
  }

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

    // ── 2a. Fetch seller-fulfilled orders ─────────────────────────────────────
    const allOrders = [];
    let   nextCursor = null;
    let   page       = 0;

    do {
      page++;
      const path = buildOrdersPath(startDate, endDate, nextCursor, 'SellerFulfilled');
      console.log(`[sync-walmart-orders] seller page ${page}: ${path.slice(0, 80)}...`);
      const data = await wmRequest('GET', path, token);

      const orders = data?.list?.elements?.order || [];
      orders.forEach(o => { o._fulfillmentType = 'Seller'; });
      allOrders.push(...orders);

      const meta = data?.list?.meta;
      nextCursor = meta?.nextCursor || null;

      console.log(`[sync-walmart-orders] seller page ${page}: ${orders.length} orders (total so far: ${allOrders.length})`);

      if (page >= 50) { console.warn('[sync-walmart-orders] hit page cap'); break; }
    } while (nextCursor);

    // ── 2b. Fetch WFS-fulfilled orders ────────────────────────────────────────
    let wfsPage = 0;
    let wfsCursor = null;

    do {
      wfsPage++;
      const path = buildOrdersPath(startDate, endDate, wfsCursor, 'WFSFulfilled');
      console.log(`[sync-walmart-orders] WFS page ${wfsPage}: ${path.slice(0, 80)}...`);
      const data = await wmRequest('GET', path, token);

      const orders = data?.list?.elements?.order || [];
      orders.forEach(o => { o._fulfillmentType = 'WFS'; });
      allOrders.push(...orders);

      const meta = data?.list?.meta;
      wfsCursor = meta?.nextCursor || null;

      console.log(`[sync-walmart-orders] WFS page ${wfsPage}: ${orders.length} orders (total so far: ${allOrders.length})`);

      if (wfsPage >= 50) { console.warn('[sync-walmart-orders] hit WFS page cap'); break; }
    } while (wfsCursor);

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
          fulfillment_type:   order._fulfillmentType || '',
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
    // ADDED 2026-08-14 — same fix as sync-walmart-revenue.js and several
    // Amazon-side crons today: this loop does ensureTab+readRows+
    // replaceRows per brand with zero pacing between brands — same
    // quota-risk pattern already found and fixed elsewhere.
    let brandIndex = 0;

    for (const [tabName, { brand, items }] of Object.entries(byBrand)) {
      if (brandIndex > 0) await sleep(3500);
      brandIndex++;

      try {
        const token2       = await ensureTab(SHEET_ID, tabName, HEADERS);
        const existingRows = await readRows(SHEET_ID, tabName);

        // REWRITTEN 2026-08-11 per Jaclyn — this used to be pure append +
        // skip-if-key-already-exists, which meant an order's status was
        // frozen at whatever it was the FIRST time this cron ever saw it.
        // "As stuff moves from acknowledged to shipped to delivered" never
        // got reflected, because a row that already existed was simply
        // never touched again. Now: every row keyed by order_id+sku gets
        // its mutable fields (status, quantity_shipped, item_price,
        // last_updated) overwritten with whatever Walmart's API just
        // returned — since that response is the authoritative current
        // state of that line item, not just "new data to add." Rows for
        // orders that have aged out of the current fetch window (now 30
        // days by default, see getDateRange above) are left completely
        // untouched here — they simply don't appear in `items` this run,
        // so the merge below never modifies them. Nothing is deleted;
        // older orders just stop receiving status refreshes once they're
        // outside the window, which is fine since a Delivered order isn't
        // expected to change status again anyway.
        const merged = new Map();
        existingRows.forEach(r => {
          const key = `${r.order_id}||${r.sku}`;
          if (key !== '||') merged.set(key, r);
        });

        let updatedCount = 0;
        let addedCount = 0;
        items.forEach(item => {
          const key = `${item.order_id}||${item.sku}`;
          if (merged.has(key)) updatedCount++; else addedCount++;
          merged.set(key, {
            order_id: item.order_id,
            date: item.date,
            status: item.status,
            order_total: item.order_total,
            promotion_ids: item.promotion_ids,
            is_premium_order: item.is_premium_order,
            promotion_discount: item.promotion_discount,
            item_price: item.item_price,
            quantity_ordered: item.quantity_ordered,
            quantity_shipped: item.quantity_shipped,
            unit_count: item.unit_count,
            sku: item.sku,
            brand: brand.id,
            last_updated: item.last_updated,
            fulfillment_type: item.fulfillment_type,
          });
        });

        // FIXED 2026-08-14 — was defaulting to valueInputOption=RAW, same
        // forced-text issue found and fixed on the orders sheet and
        // Business Report earlier today. Real numbers (item_price,
        // quantity_ordered, etc.) now write as real numbers, and 'date'
        // as a real date. order_id/sku are protected with a leading
        // apostrophe (Google Sheets' own force-text convention under
        // USER_ENTERED — the apostrophe itself is stripped, only the
        // text-typed value is stored) since Walmart order IDs and some
        // SKUs can look numeric and risk being reinterpreted or losing
        // leading zeros otherwise.
        const TEXT_PROTECTED_COLS = new Set(['order_id', 'sku']);
        const outRows = Array.from(merged.values()).map(r => HEADERS.map(h => {
          const v = r[h] ?? '';
          return TEXT_PROTECTED_COLS.has(h) && v !== '' ? `'${v}` : v;
        }));
        await replaceRows(SHEET_ID, tabName, HEADERS, outRows, token2, 'USER_ENTERED');
        console.log(`[sync-walmart-orders] ${tabName} — ${addedCount} new row(s), ${updatedCount} existing row(s) refreshed, ${outRows.length} total rows written`);

        results.push({ brand: brand.id, added: addedCount, updated: updatedCount, totalRows: outRows.length });
      } catch (err) {
        console.error(`[sync-walmart-orders] ${tabName} failed:`, err.message);
        results.push({ brand: brand.id, status: 'error', error: err.message });
      }
    }

    const failedBrands = results.filter(r => r.status === 'error');
    if (failedBrands.length > 0) {
      await sendCronFailureAlert(
        'sync-walmart-orders',
        failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
        { 'Brands failed': String(failedBrands.length) }
      );
    }

    return res.status(200).json({ synced: results, totalOrders: allOrders.length, mode, startDate, endDate, timestamp: now });

  } catch (err) {
    console.error('[sync-walmart-orders] fatal:', err.message);
    await sendCronFailureAlert('sync-walmart-orders', err.message);
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
    // CHANGED 2026-08-11 per Jaclyn — was defaulting to 2.5 HOURS, which
    // combined with the old append-only/skip-if-exists write logic (see
    // the write step below) meant this cron only ever looked at a ~2.3
    // hour sliver of each day and could never see status changes on
    // anything outside that window — orders genuinely placed and shipped
    // within the same day were confirmed sitting in Seller Center while
    // this cron logged "total orders fetched: 0" for days straight.
    // Default is now a 30-day rolling window, matching Jaclyn's explicit
    // ask: catch orders that were missed, AND keep re-checking recent
    // orders long enough to see them move through Acknowledged → Shipped
    // → Delivered. ?hours= still overrides this for one-off backfills
    // that need to reach further back than 30 days.
    const hours = parseFloat(req?.query?.hours || (24 * 30));
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

function buildOrdersPath(startDate, endDate, cursor, shipNodeType = 'SellerFulfilled') {
  if (cursor) {
    return cursor.startsWith('/') ? cursor : `/v3/orders${cursor.startsWith('?') ? '' : '?'}${cursor}`;
  }
  return `/v3/orders?createdStartDate=${encodeURIComponent(startDate)}&createdEndDate=${encodeURIComponent(endDate)}&limit=${WM_PAGE_LIMIT}&shipNodeType=${shipNodeType}`;
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
