/**
 * api/cron/sync-walmart-returns.js
 * Runs daily — pulls RETURN ORDERS from Walmart's dedicated Returns API
 * (GET /v3/returns) and writes one row per return line item, one tab per
 * brand, to a new dedicated sheet. Separate cron entirely from orders,
 * per Jaclyn 2026-07-23.
 *
 * ROOT CAUSE THIS FIXES: sync-walmart-orders.js only ever calls the
 * Orders API (GET /v3/orders) — Walmart returns/refunds are a completely
 * separate API surface with no overlap, so returns were structurally
 * invisible to that cron regardless of date range or how orderLineStatus
 * was read. This isn't a bug fix to the orders cron, it's building the
 * thing that was actually missing.
 *
 * CONFIRMED directly against Walmart's real API docs and OpenAPI spec
 * (developer.walmart.com/us-marketplace/docs/returns-and-refunds-api-overview,
 * github.com/api-evangelist/walmart openapi spec) — not assumed:
 *   - Endpoint: GET /v3/returns
 *   - Query params include returnLastModifiedStartDate /
 *     returnLastModifiedEndDate (ISO 8601: 'YYYY-MM-DD' or full timestamp)
 *     — used here instead of returnCreationStartDate/EndDate, deliberately,
 *     for the same reason Shopify's cron queries updated_at: a return
 *     progresses through several statuses over time (INITIATED ->
 *     DELIVERED -> COMPLETED/REFUND_ISSUED), and filtering by creation
 *     date alone would miss a return that started days ago and only
 *     reached REFUND_ISSUED today.
 *   - limit max 200
 *   - Response envelope: { meta: { totalCount, limit, nextCursor },
 *     returnOrders: [...] } — nextCursor is a literal query-string
 *     continuation ("?sellerId=...&limit=10&offset=10"), not an opaque
 *     token — same shape sync-walmart-orders.js already handles for the
 *     Orders API's own pagination, reused here directly.
 *   - Each returnOrder has: returnOrderId, customerOrderId, customerEmailId,
 *     customerName, refundMode.
 *   - Return status values (INITIATED/DELIVERED/COMPLETED) and eventTag
 *     values (RETURN_INITIATED, REFUND_ISSUED, RETURN_CANCELLED, etc.)
 *     live in a returnTrackingDetail object per line.
 *
 * NOT CONFIRMED — the exact field names for the per-line-item array
 * within a returnOrder (the actual SKU, quantity, and refund amount per
 * item). Walmart's own docs sample response was truncated before
 * reaching that part, and I could not find a complete real example.
 * Built defensively: tries several plausible field-name variants based
 * on the naming convention sync-walmart-orders.js's own Orders API call
 * already confirmed working (orderLines.orderLine[], item.sku,
 * orderLineQuantity.amount) — Walmart's APIs are internally consistent
 * enough that this is a reasonable starting guess, not a wild one — but
 * this should be verified against a REAL return on first run. The full
 * raw returnOrder object for the first 3 returns each run is logged
 * specifically so the real shape can be confirmed or corrected fast,
 * rather than silently trusting a guess the way an earlier sync-products.js
 * bug did (see that file's history — the exact failure mode being
 * avoided here is "wrong field name -> blank data -> no error, ever").
 *
 * Brand assignment: same identifyBrand()/SKU_PREFIX_MAP pattern as
 * sync-walmart-orders.js.
 *
 * Sheet: SHEET_WALMART_RETURNS (1XxYmX0NT-4bqKh4N96zNAPIAzctXDQaK6Yzp6hVWjJc)
 * One tab per brand, auto-created on first run.
 * Columns: return_order_id, order_id, sku, quantity, refund_amount,
 *   return_status, event_tag, return_date, brand, last_updated
 */

const https = require('https');
const { ensureTab, appendRows, readRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { sendCronFailureAlert } = require('../_alerts');

const WM_HOST = 'marketplace.walmartapis.com';
const WM_TOKEN_PATH = '/v3/token';
const WM_PAGE_LIMIT = 200; // max per Walmart's Returns API docs

const HEADERS = [
  'return_order_id', 'order_id', 'sku', 'quantity', 'refund_amount',
  'return_status', 'event_tag', 'return_date', 'brand', 'last_updated',
];

function identifyBrand(sku) {
  const upper = (sku || '').toUpperCase();
  return brands.find(b => b.active && upper.startsWith(b.skuPrefix.toUpperCase())) || null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.walmartReturns) {
    await sendCronFailureAlert('sync-walmart-returns', 'sheets.walmartReturns is not configured in config/sheets.js');
    return res.status(500).json({ error: 'sheets.walmartReturns is not configured in config/sheets.js' });
  }

  const mode = req.query.mode || 'day';
  const { startDate, endDate } = getDateRange(mode, req);
  const now = new Date().toISOString();

  console.log(`[sync-walmart-returns] mode=${mode} start=${startDate} end=${endDate}`);

  try {
    const tokenData = await getWalmartToken();
    const token = tokenData.access_token;
    if (!token) throw new Error('No access_token returned');

    // ── Fetch all return orders in the window, paginated ────────────────
    const allReturns = [];
    let nextPath = buildReturnsPath(startDate, endDate);
    let page = 0;

    do {
      page++;
      console.log(`[sync-walmart-returns] page ${page}: ${nextPath.slice(0, 100)}...`);
      const data = await wmRequest('GET', nextPath, token);
      const returnOrders = data?.returnOrders || [];
      allReturns.push(...returnOrders);

      // Log the first 3 raw return objects THIS RUN, once, for schema
      // verification — see file header note on why field names below
      // are a best-effort guess, not a confirmed fact.
      if (page === 1) {
        returnOrders.slice(0, 3).forEach((ro, i) => {
          console.log(`[sync-walmart-returns][SCHEMA CHECK] raw returnOrder #${i}:`, JSON.stringify(ro));
        });
      }

      const cursor = data?.meta?.nextCursor || null;
      nextPath = cursor ? (cursor.startsWith('/') ? cursor : `/v3/returns${cursor.startsWith('?') ? '' : '?'}${cursor}`) : null;
      console.log(`[sync-walmart-returns] page ${page}: ${returnOrders.length} return orders (total: ${allReturns.length})`);
      if (page >= 50) { console.warn('[sync-walmart-returns] hit page cap'); break; }
    } while (nextPath);

    console.log(`[sync-walmart-returns] total return orders fetched: ${allReturns.length}`);

    if (allReturns.length === 0) {
      return res.status(200).json({ message: 'No returns in range', mode, startDate, endDate });
    }

    // ── Flatten to line items — defensive, see file header note ─────────
    const lineItems = [];
    let unparsedReturnOrders = 0;

    for (const ro of allReturns) {
      const returnOrderId = ro.returnOrderId || '';
      const orderId = ro.customerOrderId || '';
      const lines = extractReturnLines(ro);
      if (!lines.length) { unparsedReturnOrders++; continue; }

      for (const line of lines) {
        const sku = line.sku || '';
        if (!sku) continue;
        lineItems.push({
          return_order_id: returnOrderId,
          order_id: orderId,
          sku,
          quantity: line.quantity,
          refund_amount: round2(line.refundAmount),
          return_status: line.status,
          event_tag: line.eventTag,
          return_date: line.returnDate,
          brand_obj: identifyBrand(sku),
          last_updated: now,
        });
      }
    }

    if (unparsedReturnOrders) {
      console.warn(`[sync-walmart-returns] ${unparsedReturnOrders} return order(s) had no recognizable line-item structure — see [SCHEMA CHECK] log lines above to fix extractReturnLines().`);
    }
    console.log(`[sync-walmart-returns] total return line items: ${lineItems.length}`);

    // ── Per-brand write ───────────────────────────────────────────────────
    const byBrand = {};
    const unmatched = [];
    for (const item of lineItems) {
      if (item.brand_obj) {
        const key = item.brand_obj.tabName;
        (byBrand[key] = byBrand[key] || { brand: item.brand_obj, items: [] }).items.push(item);
      } else {
        unmatched.push(item);
      }
    }
    if (unmatched.length) {
      console.warn(`[sync-walmart-returns] ${unmatched.length} line items with unrecognized SKU prefix:`, unmatched.slice(0, 5).map(i => i.sku).join(', '));
    }

    const results = [];
    for (const [tabName, { brand, items }] of Object.entries(byBrand)) {
      try {
        const token2 = await ensureTab(sheets.walmartReturns, tabName, HEADERS);
        const existingRows = await readRows(sheets.walmartReturns, tabName);
        const existingKeys = new Set(
          existingRows.map(r => `${r.return_order_id}||${r.sku}`).filter(k => k !== '||')
        );

        const newRows = items
          .filter(item => !existingKeys.has(`${item.return_order_id}||${item.sku}`))
          .map(item => [
            item.return_order_id, item.order_id, item.sku, item.quantity,
            item.refund_amount, item.return_status, item.event_tag,
            item.return_date, brand.id, item.last_updated,
          ]);

        const dupCount = items.length - newRows.length;
        if (newRows.length > 0) {
          await appendRows(sheets.walmartReturns, tabName, newRows, token2);
          console.log(`[sync-walmart-returns] ${tabName} — wrote ${newRows.length} rows (${dupCount} duplicates skipped)`);
        }
        results.push({ brand: brand.id, rows: newRows.length, skipped: dupCount });
      } catch (err) {
        console.error(`[sync-walmart-returns] ${tabName} failed:`, err.message);
        results.push({ brand: brand.id, status: 'error', error: err.message });
      }
    }

    const failedBrands = results.filter(r => r.status === 'error');
    if (failedBrands.length > 0) {
      await sendCronFailureAlert(
        'sync-walmart-returns',
        failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
        { 'Brands failed': `${failedBrands.length} of ${Object.keys(byBrand).length}` }
      );
    }

    return res.status(200).json({
      synced: results,
      totalReturnOrders: allReturns.length,
      unparsedReturnOrders,
      mode, startDate, endDate, timestamp: now,
    });
  } catch (err) {
    console.error('[sync-walmart-returns] fatal:', err.message);
    await sendCronFailureAlert('sync-walmart-returns', `Fatal: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
};

// Tries several plausible shapes for the per-return-order line items,
// based on the naming convention already confirmed working in
// sync-walmart-orders.js's Orders API call. Returns [] if none match —
// that return order gets logged as unparsed rather than silently dropped.
function extractReturnLines(ro) {
  const candidates = [
    ro?.returnOrderLines?.returnOrderLine,
    ro?.returnOrderLineList?.returnOrderLine,
    ro?.returnOrderLines,
    ro?.returnLines,
  ].find(c => Array.isArray(c) && c.length);

  if (!candidates) return [];

  return candidates.map(line => {
    const status = line?.returnOrderLineStatus?.status
      || line?.status
      || '';
    const eventTag = line?.returnOrderLineStatus?.returnTrackingDetail?.eventTag
      || line?.returnTrackingDetail?.eventTag
      || '';
    return {
      sku: line?.orderLine?.item?.sku || line?.item?.sku || line?.sku || '',
      quantity: parseInt(
        line?.returnOrderLineQuantity?.amount ?? line?.orderLineQuantity?.amount ?? line?.quantity ?? 0, 10
      ) || 0,
      refundAmount: parseFloat(
        line?.refundableAmount?.amount ?? line?.refundAmount?.amount ?? line?.refundAmount ?? 0
      ) || 0,
      status,
      eventTag,
      returnDate: (line?.returnOrderLineStatus?.statusQuantity?.effectiveDate || ro?.returnOrderDate || '').toString().slice(0, 10),
    };
  });
}

function buildReturnsPath(startDate, endDate) {
  return `/v3/returns?returnLastModifiedStartDate=${encodeURIComponent(startDate)}&returnLastModifiedEndDate=${encodeURIComponent(endDate)}&limit=${WM_PAGE_LIMIT}`;
}

// ── Date range — same shape as sync-walmart-orders.js ────────────────────

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

// ── Walmart auth / request — identical to sync-walmart-orders.js ────────

function getWalmartToken() {
  return new Promise((resolve, reject) => {
    const clientId = process.env.WALMART_CLIENT_ID;
    const clientSecret = process.env.WALMART_CLIENT_SECRET;
    const partnerId = process.env.WALMART_PARTNER_ID;
    if (!clientId || !clientSecret) return reject(new Error('WALMART credentials not set'));

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = 'grant_type=client_credentials';
    const headers = {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `token-${Date.now()}`,
      'WM_SVC.VERSION': '1.0.0',
      'Content-Length': Buffer.byteLength(body),
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const req = https.request({ hostname: WM_HOST, path: WM_TOKEN_PATH, method: 'POST', headers }, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Token parse error (${httpRes.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function wmRequest(method, path, token) {
  return new Promise((resolve, reject) => {
    const clientId = process.env.WALMART_CLIENT_ID;
    const partnerId = process.env.WALMART_PARTNER_ID;
    const headers = {
      'Authorization': `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
      'WM_SEC.ACCESS_TOKEN': token,
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `req-${Date.now()}`,
      'WM_SVC.VERSION': '1.0.0',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const req = https.request({ hostname: WM_HOST, path, method, headers }, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error (${httpRes.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const round2 = n => Math.round((n || 0) * 100) / 100;
