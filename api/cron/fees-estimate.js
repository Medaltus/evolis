/**
 * api/cron/fees-estimate.js
 * Independently-scheduled job — computes "Amazon Estimated fees" for any
 * row that's missing it, across every active brand. Runs completely
 * separately from sync-orders-process.js: a problem here can never block
 * basic order data from syncing, and a problem in order sync can never
 * block this from catching up on fees once it's healthy again.
 *
 * Bounded on TWO shared budgets per invocation, split across however many
 * brands it gets through before running out:
 *   - feeCallBudget  — max Product Fees API calls (default 100, ~1.1s apart)
 *   - skuLookupBudget — max Orders API getOrderItems calls for resolving
 *                       blank SKUs (default 60, ~2s apart — conservative
 *                       guess, tighten/loosen once we see real rate-limit
 *                       behavior)
 *
 * Progress persists per-brand in the shared _meta tab as
 * `fees_cursor_<brandId>` (the row index to resume scanning from). Once a
 * brand's tab is fully scanned, its cursor wraps back to 0 so newly-added
 * blank rows (new orders) get picked up on a future pass rather than the
 * brand being permanently marked "done."
 *
 * Manual:
 *   GET /api/cron/fees-estimate?feeCallBudget=100&skuLookupBudget=60
 *   Authorization: Bearer <CRON_SECRET>
 *   &brand=evolis   — restrict to one brand (skips cursor persistence for others)
 *   &dryRun=true    — report what WOULD be updated without writing anything
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brandsConfig                         = require('../config/brands');
const sheets                               = require('../config/sheets');

// Must match sync-orders-process.js's HEADERS exactly — same tab, same shape.
const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
  'Amazon Estimated fees',
  'Amazon Sale Promotions',
];

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

const DEFAULT_FEE_CALL_BUDGET  = 100;
const DEFAULT_SKU_LOOKUP_BUDGET = 60;
const FEE_CALL_DELAY_MS   = 1100; // Product Fees API pacing
const SKU_LOOKUP_DELAY_MS = 2000; // Orders API pacing — conservative guess, see header note

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun          = req.query.dryRun === 'true';
  const onlyBrand        = req.query.brand || null;
  let feeCallBudget      = parseInt(req.query.feeCallBudget, 10)  || DEFAULT_FEE_CALL_BUDGET;
  let skuLookupBudget    = parseInt(req.query.skuLookupBudget, 10) || DEFAULT_SKU_LOOKUP_BUDGET;

  // ── Read per-brand cursors from _meta ────────────────────────────────────
  let metaToken, metaMap = {};
  try {
    metaToken     = await ensureTab(sheets.orders, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.orders, META_TAB);
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
  } catch (err) {
    console.error('[fees-estimate] failed to read _meta:', err.message);
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  const activeBrands = brandsConfig.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));
  const results = [];
  const feesCache       = new Map();
  const orderItemsCache = new Map();
  const metaUpdates      = {};

  for (const brand of activeBrands) {
    if (feeCallBudget <= 0 || skuLookupBudget <= 0) {
      results.push({ brand: brand.id, status: 'skipped', reason: 'budget exhausted this run' });
      continue;
    }

    const cursorKey = `fees_cursor_${brand.id}`;
    const startRow  = parseInt(metaMap[cursorKey], 10) || 0;

    try {
      const outcome = await processBrandFees({
        brand, startRow,
        feeCallBudget, skuLookupBudget,
        feesCache, orderItemsCache, dryRun,
      });

      feeCallBudget   -= outcome.apiCallsMade;
      skuLookupBudget -= outcome.skuLookupsMade;

      // Wrap around to 0 once a brand's tab is fully scanned, so future
      // runs re-check for newly-added blank rows instead of stopping forever.
      metaUpdates[cursorKey] = outcome.done ? '0' : String(outcome.nextStartRow);

      results.push({ brand: brand.id, status: 'ok', ...outcome });
    } catch (err) {
      console.error(`[fees-estimate] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  // ── Persist cursors ───────────────────────────────────────────────────────
  if (!dryRun && Object.keys(metaUpdates).length > 0) {
    try {
      const nowIso = new Date().toISOString();
      Object.assign(metaMap, metaUpdates);
      metaMap['fees_last_run_at'] = nowIso;
      const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, nowIso]);
      await replaceRows(sheets.orders, META_TAB, META_HEADERS, metaRows, metaToken);
    } catch (err) {
      console.warn('[fees-estimate] failed to persist cursors:', err.message);
    }
  }

  res.status(200).json({ dryRun, results });
};

// ── Per-brand core logic (same as the one-off backfill script) ──────────────

async function processBrandFees({ brand, startRow, feeCallBudget, skuLookupBudget, feesCache, orderItemsCache, dryRun }) {
  const token           = await ensureTab(sheets.orders, brand.tabName, HEADERS);
  const existingRowsRaw = await readRows(sheets.orders, brand.tabName);
  const existingRowsObj = (existingRowsRaw || []).map(normalizeRow);
  const workingRows      = existingRowsObj.map(r => HEADERS.map(h => r[h] ?? ''));

  let callsMade         = 0;
  let skuLookupsMade      = 0;
  let filledCount         = 0;
  let skuResolvedCount    = 0;
  let skippedCount        = 0;
  let scannedTo           = existingRowsObj.length;

  for (let i = startRow; i < existingRowsObj.length; i++) {
    if (callsMade >= feeCallBudget || skuLookupsMade >= skuLookupBudget) {
      scannedTo = i;
      break;
    }

    const row = existingRowsObj[i];
    const storedFee = row['Amazon Estimated fees'];
    if (storedFee !== '' && storedFee != null) continue; // already filled — free to skip

    const asin    = row.asin || '';
    const orderId = row.order_id || '';
    const price   = parseFloat(row.item_price || '0');
    const qty     = parseInt(row.unit_count || row.quantity_ordered || '0', 10);
    let   sku     = row.sku || '';

    if (!asin || !price || price <= 0 || !qty || qty <= 0) {
      skippedCount++;
      continue;
    }

    let resolvedThisRow = false;
    if (!sku && orderId && skuLookupsMade < skuLookupBudget) {
      const lookedUp = await getOrderItemSku(orderItemsCache, orderId, asin, () => skuLookupsMade++);
      if (lookedUp) {
        sku = lookedUp;
        resolvedThisRow = true;
        skuResolvedCount++;
      } else {
        console.warn(`[fees-estimate] could not resolve SKU for order=${orderId} asin=${asin} — assuming FBA`);
      }
    }

    const unitPrice         = round2(price / qty);
    const isAmazonFulfilled = !sku.toUpperCase().endsWith('-SF');

    callsMade++;
    const feePerUnit = await getFeesEstimate(feesCache, asin, unitPrice, isAmazonFulfilled);

    if (!dryRun) {
      if (feePerUnit != null) {
        workingRows[i][HEADERS.indexOf('Amazon Estimated fees')] = round2(feePerUnit * qty);
        filledCount++;
      }
      if (resolvedThisRow) {
        workingRows[i][HEADERS.indexOf('sku')] = sku;
      }
    } else if (feePerUnit != null) {
      filledCount++;
    }
  }

  const done = scannedTo >= existingRowsObj.length;

  if (!dryRun && (filledCount > 0 || skuResolvedCount > 0)) {
    await replaceRows(sheets.orders, brand.tabName, HEADERS, workingRows, token);
  }

  return {
    startRow, nextStartRow: done ? existingRowsObj.length : scannedTo, done,
    apiCallsMade: callsMade, skuLookupsMade,
    filled: filledCount, skuResolved: skuResolvedCount,
    skippedNoData: skippedCount, totalRows: existingRowsObj.length,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeRow(r) {
  if (Array.isArray(r)) {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  }
  return r;
}

const round2 = n => Math.round(n * 100) / 100;
const sleep  = ms => new Promise(r => setTimeout(r, ms));

async function getOrderItemSku(orderItemsCache, orderId, asin, onNewCall) {
  let items;
  if (orderItemsCache.has(orderId)) {
    items = orderItemsCache.get(orderId);
  } else {
    onNewCall();
    try {
      const resp = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`);
      items = resp?.payload?.OrderItems || null;
      orderItemsCache.set(orderId, items);
      await sleep(SKU_LOOKUP_DELAY_MS);
    } catch (err) {
      console.warn(`[fees-estimate] order items lookup failed for ${orderId}: ${err.message}`);
      orderItemsCache.set(orderId, null);
      return null;
    }
  }

  if (!items) return null;
  const match = items.find(it => it.ASIN === asin);
  return match?.SellerSKU || null;
}

async function getFeesEstimate(feesCache, asin, unitPrice, isAmazonFulfilled) {
  if (!asin || !unitPrice || unitPrice <= 0) return null;

  const cacheKey = `${asin}|${unitPrice}|${isAmazonFulfilled}`;
  if (feesCache.has(cacheKey)) return feesCache.get(cacheKey);

  try {
    const body = {
      FeesEstimateRequest: {
        MarketplaceId: process.env.SP_MARKETPLACE_ID,
        IsAmazonFulfilled: isAmazonFulfilled,
        PriceToEstimateFees: {
          ListingPrice: { CurrencyCode: 'USD', Amount: unitPrice },
          Shipping:     { CurrencyCode: 'USD', Amount: 0 },
        },
        Identifier: cacheKey.slice(0, 40),
      },
    };

    const resp   = await spRequest('POST', `/products/fees/v0/items/${asin}/feesEstimate`, {}, body);
    const result = resp?.payload?.FeesEstimateResult;

    if (result?.Status !== 'Success' || !result?.FeesEstimate) {
      console.warn(`[fees-estimate] not available for ${asin} @ $${unitPrice} (isAmazonFulfilled=${isAmazonFulfilled}): ${result?.Status || 'no result'} — ${JSON.stringify(result?.Error || {})}`);
      feesCache.set(cacheKey, null);
      return null;
    }

    const feePerUnit = result.FeesEstimate.TotalFeesEstimate?.Amount ?? null;
    feesCache.set(cacheKey, feePerUnit);
    await sleep(FEE_CALL_DELAY_MS);
    return feePerUnit;
  } catch (err) {
    console.warn(`[fees-estimate] failed for ${asin} @ $${unitPrice} (isAmazonFulfilled=${isAmazonFulfilled}): ${err.message}`);
    feesCache.set(cacheKey, null);
    return null;
  }
}
