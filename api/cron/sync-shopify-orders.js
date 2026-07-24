/**
 * api/cron/sync-shopify-orders.js
 * Runs daily — pulls orders from Shopify GraphQL Admin API and writes
 * one row per line item to the Shopify orders Google Sheet.
 * Deduplicates on order_id + sku — safe to re-run.
 *
 * Authentication: client_credentials grant (Dev Dashboard app).
 * Token is short-lived (~24hrs) — requested fresh each run.
 *
 * Modes (via ?mode=):
 *   day       — today from midnight UTC to now (default, used by cron)
 *   yesterday — full yesterday
 *   week      — ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Sheet: SHOPIFY_ORDERS_SHEET (single tab, gid=0)
 * Schedule: daily at 7AM UTC ("0 7 * * *")
 */

const { ensureTab, appendRows, readRows } = require('../config/_sheets_client');
const { sendCronFailureAlert }            = require('../_alerts');

const STORE_DOMAIN  = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHEET_ID      = process.env.SHOPIFY_ORDERS_SHEET;
const TAB_NAME      = 'orders';
const API_VERSION   = '2025-01';

const HEADERS = [
  'order_id', 'date', 'status', 'financial_status',
  'order_total', 'discount_codes', 'is_subscription', 'is_b2b',
  'promotion_discount', 'item_price', 'quantity_ordered',
  'quantity_shipped', 'unit_count', 'sku', 'brand', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!STORE_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
    await sendCronFailureAlert('sync-shopify-orders', 'Shopify env vars not set');
    return res.status(500).json({ error: 'Shopify env vars not set' });
  }
  if (!SHEET_ID) {
    await sendCronFailureAlert('sync-shopify-orders', 'SHOPIFY_ORDERS_SHEET not set');
    return res.status(500).json({ error: 'SHOPIFY_ORDERS_SHEET not set' });
  }

  const mode = req.query.mode || 'day';
  const { startDate, endDate } = getDateRange(mode, req);
  const nowEst = toEstIso(new Date());

  console.log(`[sync-shopify-orders] mode=${mode} start=${startDate} end=${endDate}`);

  // ── 1. Get access token ───────────────────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getShopifyToken();
    console.log('[sync-shopify-orders] token obtained');
  } catch (err) {
    console.error('[sync-shopify-orders] token failed:', err.message);
    await sendCronFailureAlert('sync-shopify-orders', err.message, { Stage: 'Shopify token request' });
    return res.status(500).json({ error: 'Token request failed', detail: err.message });
  }

  // ── 2. Fetch all orders in date range via GraphQL pagination ──────────────
  const allOrders = [];
  let cursor = null;
  let page   = 0;

  const query = `
    query GetOrders($first: Int!, $after: String, $filter: String!) {
      orders(first: $first, after: $after, query: $filter, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            displayFulfillmentStatus
            displayFinancialStatus
            tags
            discountCodes
            totalPriceSet      { shopMoney { amount } }
            totalDiscountsSet  { shopMoney { amount } }
            lineItems(first: 20) {
              edges {
                node {
                  title
                  sku
                  quantity
                  originalUnitPriceSet  { shopMoney { amount } }
                  discountedUnitPriceSet { shopMoney { amount } }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  const filter = `created_at:>='${startDate}' created_at:<='${endDate}'`;

  do {
    page++;
    const variables = { first: 50, after: cursor, filter };

    try {
      const resp = await shopifyGraphQL(accessToken, query, variables);
      const edges = resp?.orders?.edges || [];

      for (const edge of edges) {
        allOrders.push(edge.node);
        cursor = edge.cursor;
      }

      const hasNextPage = resp?.orders?.pageInfo?.hasNextPage;
      console.log(`[sync-shopify-orders] page ${page}: ${edges.length} orders (total: ${allOrders.length})`);

      if (!hasNextPage) break;
      if (page >= 100) { console.warn('[sync-shopify-orders] hit page cap'); break; }
    } catch (err) {
      console.error(`[sync-shopify-orders] page ${page} failed:`, err.message);
      await sendCronFailureAlert('sync-shopify-orders', err.message, { Stage: `GraphQL fetch, page ${page}` });
      return res.status(500).json({ error: 'GraphQL fetch failed', detail: err.message });
    }
  } while (true);

  console.log(`[sync-shopify-orders] total orders fetched: ${allOrders.length}`);

  if (allOrders.length === 0) {
    return res.status(200).json({ message: 'No orders in range', mode, startDate, endDate });
  }

  // ── 3. Flatten to line items ──────────────────────────────────────────────
  const lineItems = [];

  for (const order of allOrders) {
    const orderId     = order.name || '';
    const date        = (order.createdAt || '').slice(0, 10);
    const status      = order.displayFulfillmentStatus || '';
    const finStatus   = order.displayFinancialStatus || '';
    const orderTotal  = round2(parseFloat(order.totalPriceSet?.shopMoney?.amount || '0'));
    const discount    = round2(parseFloat(order.totalDiscountsSet?.shopMoney?.amount || '0'));
    const tags        = order.tags || [];
    const discCodes   = (order.discountCodes || []).join(', ');
    const isSub       = tags.some(t => t.toLowerCase() === 'subscription') ? 'TRUE' : 'FALSE';
    const isB2B       = tags.some(t => t.toLowerCase() === 'b2b') ? 'TRUE' : 'FALSE';
    const isFulfilled = status === 'FULFILLED';

    for (const edge of order.lineItems?.edges || []) {
      const li       = edge.node;
      const sku      = li.sku || '';
      const qty      = parseInt(li.quantity, 10) || 0;
      const unitPrice = round2(parseFloat(li.discountedUnitPriceSet?.shopMoney?.amount || '0'));
      const itemPrice = round2(unitPrice * qty);

      lineItems.push({
        order_id:          orderId,
        date,
        status,
        financial_status:  finStatus,
        order_total:       orderTotal,
        discount_codes:    discCodes,
        is_subscription:   isSub,
        is_b2b:            isB2B,
        promotion_discount: discount,
        item_price:        itemPrice,
        quantity_ordered:  qty,
        quantity_shipped:  isFulfilled ? qty : 0,
        unit_count:        qty,
        sku,
        brand:             'evolis',
        last_updated:      nowEst,
      });
    }
  }

  console.log(`[sync-shopify-orders] total line items: ${lineItems.length}`);

  // ── 4. Dedup and write ────────────────────────────────────────────────────
  const token        = await ensureTab(SHEET_ID, TAB_NAME, HEADERS);
  const existingRows = await readRows(SHEET_ID, TAB_NAME);
  const existingKeys = new Set(
    existingRows
      .map(r => `${r.order_id}||${r.sku}`)
      .filter(k => k !== '||')
  );

  const newRows = lineItems
    .filter(item => !existingKeys.has(`${item.order_id}||${item.sku}`))
    .map(item => HEADERS.map(h => item[h] ?? ''));

  const dupCount = lineItems.length - newRows.length;
  if (dupCount > 0) {
    console.log(`[sync-shopify-orders] skipped ${dupCount} duplicate order+sku rows`);
  }

  if (newRows.length > 0) {
    await appendRows(SHEET_ID, TAB_NAME, newRows, token);
    console.log(`[sync-shopify-orders] wrote ${newRows.length} rows`);
  } else {
    console.log('[sync-shopify-orders] 0 new rows (all duplicates)');
  }

  return res.status(200).json({
    rows:      newRows.length,
    skipped:   dupCount,
    orders:    allOrders.length,
    mode,
    startDate,
    endDate,
    timestamp: nowEst,
  });
};

// ── Shopify auth ──────────────────────────────────────────────────────────────

async function getShopifyToken() {
  const resp = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`Token request failed: ${resp.status}`);
  const { access_token } = await resp.json();
  if (!access_token) throw new Error('No access_token in response');
  return access_token;
}

// ── Shopify GraphQL ───────────────────────────────────────────────────────────

async function shopifyGraphQL(token, query, variables = {}) {
  const resp = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!resp.ok) throw new Error(`GraphQL request failed: ${resp.status}`);
  const { data, errors } = await resp.json();
  if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

// ── Date range ────────────────────────────────────────────────────────────────

function getDateRange(mode, req) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => d.toISOString().slice(0, 19) + 'Z';
  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000);

  if (mode === 'day') {
    const y = now.getUTCFullYear(), m = pad(now.getUTCMonth() + 1), d = pad(now.getUTCDate());
    return { startDate: `${y}-${m}-${d}T00:00:00Z`, endDate: fmt(safeBefore) };
  }

  if (mode === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    const y = d.getFullYear(), m = pad(d.getMonth() + 1), day = pad(d.getDate());
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}

const round2 = n => Math.round(n * 100) / 100;
