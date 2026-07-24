/**
 * api/cron/sync-shopify-returns.js
 * Runs daily — pulls REFUNDS from Shopify GraphQL Admin API and writes one
 * row per (refund, line item) to a new "returns" tab on the same sheet
 * sync-shopify-orders.js already uses. Separate cron entirely from orders,
 * per Jaclyn 2026-07-23 — same reasoning as Amazon's existing separate
 * returns cron pair: a return is an update to something that already
 * happened, not a new order-creation event, so it doesn't fit the
 * append-only "sync what's new by creation date" shape orders use.
 *
 * ROOT CAUSE THIS FIXES: sync-shopify-orders.js queries by created_at only
 * and never requests the refunds field at all — an order refunded days
 * after it was created is invisible to that cron forever, since it only
 * ever looks at orders created *today*. This cron queries by updated_at
 * instead, so a refund shows up on the day it actually happened,
 * regardless of when the original order was placed.
 *
 * Shopify is évolis-only (single store, single hardcoded brand) — same
 * assumption sync-shopify-orders.js already makes, not something new
 * introduced here.
 *
 * Refund object fields confirmed directly against Shopify's real GraphQL
 * Admin API docs (shopify.dev/docs/api/admin-graphql/latest/objects/Refund),
 * not assumed: createdAt, note, refundLineItems (a Connection — needs
 * edges/node, NOT a plain list), totalRefundedSet. RefundLineItem's own
 * price field naming (subtotalSet) matches the same `xSet.shopMoney.amount`
 * convention sync-shopify-orders.js already uses successfully for
 * totalPriceSet/originalUnitPriceSet — consistent enough to build on
 * directly, but worth a first-run sanity check against a known real refund.
 *
 * Dedup key: order_id + sku + refund_id (not just order_id + sku) — the
 * same order can have two separate partial refunds over time for the same
 * SKU, and those need to stay distinct rows, not collapse into one.
 *
 * Sheet: SHOPIFY_ORDERS_SHEET (same sheet sync-shopify-orders.js uses),
 * new tab "returns".
 */

const { ensureTab, appendRows, readRows } = require('../config/_sheets_client');
const { sendCronFailureAlert } = require('../_alerts');

const STORE_DOMAIN  = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHEET_ID      = process.env.SHOPIFY_ORDERS_SHEET;
const TAB_NAME      = 'returns';
const API_VERSION   = '2025-01';

const HEADERS = [
  'order_id', 'refund_id', 'refund_date', 'sku', 'quantity',
  'refund_amount', 'note', 'brand', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!STORE_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
    await sendCronFailureAlert('sync-shopify-returns', 'Shopify env vars not set');
    return res.status(500).json({ error: 'Shopify env vars not set' });
  }
  if (!SHEET_ID) {
    await sendCronFailureAlert('sync-shopify-returns', 'SHOPIFY_ORDERS_SHEET not set');
    return res.status(500).json({ error: 'SHOPIFY_ORDERS_SHEET not set' });
  }

  const mode = req.query.mode || 'day';
  const { startDate, endDate } = getDateRange(mode, req);
  const nowEst = toEstIso(new Date());

  console.log(`[sync-shopify-returns] mode=${mode} start=${startDate} end=${endDate}`);

  let accessToken;
  try {
    accessToken = await getShopifyToken();
  } catch (err) {
    await sendCronFailureAlert('sync-shopify-returns', `Token request failed: ${err.message}`);
    return res.status(500).json({ error: 'Token request failed', detail: err.message });
  }

  // Query by UPDATED_AT, not CREATED_AT — see file header note. This is
  // the one deliberate difference from sync-shopify-orders.js's query shape.
  const allOrders = [];
  let cursor = null;
  let page = 0;

  const query = `
    query GetOrdersWithRefunds($first: Int!, $after: String, $filter: String!) {
      orders(first: $first, after: $after, query: $filter, sortKey: UPDATED_AT) {
        edges {
          cursor
          node {
            id
            name
            updatedAt
            refunds {
              id
              createdAt
              note
              totalRefundedSet { shopMoney { amount } }
              refundLineItems(first: 20) {
                edges {
                  node {
                    quantity
                    subtotalSet { shopMoney { amount } }
                    lineItem { sku }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  const filter = `updated_at:>='${startDate}' updated_at:<='${endDate}'`;

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
      console.log(`[sync-shopify-returns] page ${page}: ${edges.length} orders (total: ${allOrders.length})`);
      if (!resp?.orders?.pageInfo?.hasNextPage) break;
      if (page >= 100) { console.warn('[sync-shopify-returns] hit page cap'); break; }
    } catch (err) {
      console.error(`[sync-shopify-returns] page ${page} failed:`, err.message);
      await sendCronFailureAlert('sync-shopify-returns', `GraphQL fetch failed on page ${page}: ${err.message}`);
      return res.status(500).json({ error: 'GraphQL fetch failed', detail: err.message });
    }
  } while (true);

  console.log(`[sync-shopify-returns] total orders touched in window: ${allOrders.length}`);

  // ── Flatten: order -> refund -> refund line item = one row each ─────────
  const returnRows = [];
  let noSkuLineItems = 0;

  for (const order of allOrders) {
    const orderId = order.name || '';
    for (const refund of order.refunds || []) {
      const refundId = refund.id || '';
      const refundDate = (refund.createdAt || '').slice(0, 10);
      const note = refund.note || '';

      for (const edge of refund.refundLineItems?.edges || []) {
        const rli = edge.node;
        const sku = rli.lineItem?.sku || '';
        if (!sku) { noSkuLineItems++; continue; } // e.g. shipping-only refund lines — nothing to attribute to a product
        returnRows.push({
          order_id: orderId,
          refund_id: refundId,
          refund_date: refundDate,
          sku,
          quantity: parseInt(rli.quantity, 10) || 0,
          refund_amount: round2(parseFloat(rli.subtotalSet?.shopMoney?.amount || '0')),
          note,
          brand: 'evolis',
          last_updated: nowEst,
        });
      }
    }
  }

  console.log(`[sync-shopify-returns] total refund line items: ${returnRows.length}${noSkuLineItems ? ` (${noSkuLineItems} skipped — no SKU, e.g. shipping-only)` : ''}`);

  if (returnRows.length === 0) {
    return res.status(200).json({ message: 'No refunds in range', mode, startDate, endDate });
  }

  // ── Dedup and write ──────────────────────────────────────────────────────
  const token = await ensureTab(SHEET_ID, TAB_NAME, HEADERS);
  const existingRows = await readRows(SHEET_ID, TAB_NAME);
  const existingKeys = new Set(
    existingRows.map(r => `${r.order_id}||${r.sku}||${r.refund_id}`).filter(k => k !== '||')
  );

  const newRows = returnRows
    .filter(r => !existingKeys.has(`${r.order_id}||${r.sku}||${r.refund_id}`))
    .map(r => HEADERS.map(h => r[h] ?? ''));

  const dupCount = returnRows.length - newRows.length;
  if (dupCount > 0) console.log(`[sync-shopify-returns] skipped ${dupCount} duplicate order+sku+refund rows`);

  if (newRows.length > 0) {
    await appendRows(SHEET_ID, TAB_NAME, newRows, token);
    console.log(`[sync-shopify-returns] wrote ${newRows.length} rows`);
  }

  return res.status(200).json({
    rows: newRows.length,
    skipped: dupCount,
    ordersTouched: allOrders.length,
    mode, startDate, endDate, timestamp: nowEst,
  });
};

// ── Shopify auth / GraphQL — identical to sync-shopify-orders.js ─────────

async function getShopifyToken() {
  const resp = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`Token request failed: ${resp.status}`);
  const { access_token } = await resp.json();
  if (!access_token) throw new Error('No access_token in response');
  return access_token;
}

async function shopifyGraphQL(token, query, variables = {}) {
  const resp = await fetch(`https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`GraphQL request failed: ${resp.status}`);
  const { data, errors } = await resp.json();
  if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

// ── Date range — identical shape to sync-shopify-orders.js, applied to updated_at ──

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
    const start = req?.query?.start;
    const end = req?.query?.end;
    const startTime = req?.query?.startTime || '00:00:00';
    const endTime = req?.query?.endTime || '23:59:59';
    if (!start || !end) throw new Error('mode=week requires ?start=YYYY-MM-DD&end=YYYY-MM-DD');
    const endTs = new Date(`${end}T${endTime}Z`);
    return { startDate: `${start}T${startTime}Z`, endDate: endTs > now ? fmt(safeBefore) : `${end}T${endTime}Z` };
  }
  throw new Error(`Unknown mode: ${mode}`);
}

function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}

const round2 = n => Math.round(n * 100) / 100;
