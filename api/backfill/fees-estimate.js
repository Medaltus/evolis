/**
 * api/backfill/fees-estimate.js
 * One-off backfill — NOT part of the regular cron chain.
 *
 * Purpose: sync-orders-process.js only computes a fee for a row when that
 * row is brand-new or something about it changed (status, price, etc) —
 * that's intentional, it's what keeps the regular cron bounded and fast.
 * But it means historical rows that are sitting unchanged with a blank
 * "Amazon Estimated fees" (e.g. from before the IsAmazonFulfilled fix, or
 * from a run that hit a transient failure) will never get revisited by the
 * regular cron. This script is the one-time sweep to fill those in.
 *
 * Bounded per invocation: stops after `limit` actual API calls (default 40,
 * ~1.1s apart per the Product Fees API rate limit — see getFeesEstimate in
 * sync-orders-process.js — so 40 calls ≈ 45s, safely inside a Vercel
 * timeout even on the Hobby tier). Returns a `nextStartRow` cursor so you
 * can call it again to pick up where it left off. Scanning through
 * already-filled rows is cheap (no API call) — only blank+valid rows count
 * against the limit.
 *
 * Blank SKUs (from old report pulls, per Jaclyn) are resolved via the Orders
 * API's getOrderItems endpoint — looked up once per order_id (cached across
 * that order's other line items within the same run) and written back into
 * the sheet's sku column, not just used transiently for the fee call.
 *
 * Bounded per invocation on TWO separate budgets, since fee-estimate calls
 * and order-item lookups are different endpoints with different rate limits:
 *   - `limit`         — max fee-estimate API calls (default 40, ~1.1s apart)
 *   - `skuLookupLimit`— max NEW order-lookup API calls (default 30, ~2s apart
 *                       — conservative guess since Orders API's actual burst/
 *                       restore rate here hasn't been confirmed; tighten or
 *                       loosen once we see real behavior / 429s)
 * Returns a `nextStartRow` cursor so you can call it again to pick up where
 * it left off. Scanning through already-filled rows is cheap (no API call).
 *
 * Usage:
 *   GET /api/backfill/fees-estimate?brand=evolis&limit=40&skuLookupLimit=30&startRow=0
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Optional:
 *   &dryRun=true   — report what WOULD be updated without writing anything
 *
 * Repeat with the returned nextStartRow until done:true.
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
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

const DEFAULT_LIMIT           = 40;
const DEFAULT_SKU_LOOKUP_LIMIT = 30;
const FEE_CALL_DELAY_MS  = 1100; // matches sync-orders-process.js's rate-limit pacing
const SKU_LOOKUP_DELAY_MS = 2000; // conservative guess for Orders API — see note above

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const brandId        = req.query.brand;
  const limit           = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
  const skuLookupLimit  = parseInt(req.query.skuLookupLimit, 10) || DEFAULT_SKU_LOOKUP_LIMIT;
  const startRow        = parseInt(req.query.startRow, 10) || 0;
  const dryRun           = req.query.dryRun === 'true';

  if (!brandId) {
    return res.status(400).json({ error: 'Provide ?brand=<brand id> (e.g. evolis)' });
  }

  const brand = brands.find(b => b.id === brandId);
  if (!brand) {
    return res.status(400).json({ error: `Unknown brand: ${brandId}` });
  }

  let token, existingRowsRaw;
  try {
    token           = await ensureTab(sheets.orders, brand.tabName, HEADERS);
    existingRowsRaw = await readRows(sheets.orders, brand.tabName);
  } catch (err) {
    console.error(`[backfill/fees-estimate] failed to read ${brand.tabName}:`, err.message);
    return res.status(500).json({ error: 'Failed to read tab', detail: err.message });
  }

  const existingRowsObj = (existingRowsRaw || []).map(normalizeRow);
  const workingRows      = existingRowsObj.map(r => HEADERS.map(h => r[h] ?? ''));

  const feesCache        = new Map();
  const orderItemsCache   = new Map(); // orderId -> array of {SellerSKU, ASIN, ...} | null
  let callsMade          = 0;
  let skuLookupsMade      = 0;
  let filledCount         = 0;
  let skuResolvedCount    = 0;
  let skippedCount        = 0;
  let scannedTo           = existingRowsObj.length;
  const filledRows        = []; // for dryRun reporting

  for (let i = startRow; i < existingRowsObj.length; i++) {
    if (callsMade >= limit || skuLookupsMade >= skuLookupLimit) {
      scannedTo = i;
      break;
    }

    const row = existingRowsObj[i];
    const storedFee = row['Amazon Estimated fees'];
    const hasStoredFee = storedFee !== '' && storedFee != null;
    if (hasStoredFee) continue; // already filled — free to skip, doesn't count against limit

    const asin    = row.asin || '';
    const orderId = row.order_id || '';
    const price   = parseFloat(row.item_price || '0');
    const qty     = parseInt(row.unit_count || row.quantity_ordered || '0', 10);
    let   sku     = row.sku || '';

    if (!asin || !price || price <= 0 || !qty || qty <= 0) {
      // Not enough data to ever compute a fee for this row (e.g. cancelled
      // order with $0 total) — leave it blank, don't burn an API call.
      skippedCount++;
      continue;
    }

    // ── Resolve blank SKU via Orders API, before deciding fulfillment type ──
    let resolvedThisRow = false;
    if (!sku && orderId && skuLookupsMade < skuLookupLimit) {
      const lookedUp = await getOrderItemSku(orderItemsCache, orderId, asin, () => skuLookupsMade++);
      if (lookedUp) {
        sku = lookedUp;
        resolvedThisRow = true;
        skuResolvedCount++;
      } else {
        console.warn(`[backfill/fees-estimate] could not resolve SKU for order=${orderId} asin=${asin} — assuming FBA`);
      }
    }

    const unitPrice         = round2(price / qty);
    const isAmazonFulfilled = !sku.toUpperCase().endsWith('-SF');

    callsMade++;
    const feePerUnit = await getFeesEstimate(feesCache, asin, unitPrice, isAmazonFulfilled);

    if (feePerUnit != null) {
      const fee = round2(feePerUnit * qty);
      filledCount++;
      if (dryRun) {
        filledRows.push({ row: i, orderId, sku: sku || '(unresolved)', skuResolved: resolvedThisRow, asin, unitPrice, fee });
      } else {
        workingRows[i][HEADERS.indexOf('Amazon Estimated fees')] = fee;
        if (resolvedThisRow) {
          workingRows[i][HEADERS.indexOf('sku')] = sku;
        }
      }
    } else if (resolvedThisRow && !dryRun) {
      // Fee call failed this run, but we DID resolve the SKU — write that
      // back anyway so the next backfill pass doesn't have to look it up
      // again, and so isAmazonFulfilled will be correct on the retry.
      workingRows[i][HEADERS.indexOf('sku')] = sku;
    }
    // If fee is null (API failure for this specific row), leave fee blank —
    // it'll be picked up again on a future backfill call since it's still
    // unfilled, and it'll benefit from the now-cached/written SKU.
  }

  if (!dryRun && (filledCount > 0 || skuResolvedCount > 0)) {
    try {
      await replaceRows(sheets.orders, brand.tabName, HEADERS, workingRows, token);
    } catch (err) {
      console.error(`[backfill/fees-estimate] failed to write ${brand.tabName}:`, err.message);
      return res.status(500).json({ error: 'Failed to write tab', detail: err.message });
    }
  }

  const done = scannedTo >= existingRowsObj.length;

  res.status(200).json({
    brand: brandId,
    dryRun,
    startRow,
    nextStartRow: done ? null : scannedTo,
    done,
    apiCallsMade: callsMade,
    skuLookupsMade,
    filled: filledCount,
    skuResolved: skuResolvedCount,
    skippedNoData: skippedCount,
    totalRows: existingRowsObj.length,
    ...(dryRun ? { filledRows } : {}),
  });
};

// ── Helpers (mirrors sync-orders-process.js) ─────────────────────────────────

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

/**
 * Looks up the real SellerSKU for a given order_id + asin via the Orders
 * API's getOrderItems endpoint. Caches the full item list per order_id so
 * an order with multiple blank-SKU line items only costs one API call.
 * onNewCall is invoked only when an actual (non-cached) API call is made,
 * so the caller's skuLookupsMade counter stays accurate.
 */
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
      console.warn(`[backfill/fees-estimate] order items lookup failed for ${orderId}: ${err.message}`);
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
      console.warn(`[backfill/fees-estimate] not available for ${asin} @ $${unitPrice} (isAmazonFulfilled=${isAmazonFulfilled}): ${result?.Status || 'no result'} — ${JSON.stringify(result?.Error || {})}`);
      feesCache.set(cacheKey, null);
      return null;
    }

    const feePerUnit = result.FeesEstimate.TotalFeesEstimate?.Amount ?? null;
    feesCache.set(cacheKey, feePerUnit);
    await sleep(FEE_CALL_DELAY_MS);
    return feePerUnit;
  } catch (err) {
    console.warn(`[backfill/fees-estimate] failed for ${asin} @ $${unitPrice} (isAmazonFulfilled=${isAmazonFulfilled}): ${err.message}`);
    feesCache.set(cacheKey, null);
    return null;
  }
}
