/** 
 * api/cron/sync-orders.js
 * Runs every 2 hours — pulls orders from the flat file report for ALL brands.
 * Uses GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL (GZIP TSV).
 * Writes to the rolling sheet (amazon-orders). Deduplicates on order_id + sku.
 *
 * Why flat file instead of Orders API:
 *   The Orders API only returns FBA orders reliably. The flat file report
 *   covers FBA + FBM and is Amazon's source of truth for reconciliation.
 *
 * Row granularity — ONE ROW PER LINE ITEM:
 *   The flat file has one row per line item (one SKU per row). We write that
 *   directly — no aggregation. This allows the dashboard to compute accurate
 *   per-SKU unit counts and per-ASIN quantities on multi-item orders.
 *   Dedup key is order_id + sku (composite) to handle re-runs safely.
 *
 * Brand determination:
 *   Brand is assigned by SKU prefix only — never from the Amazon brand field.
 *   SKU is read from the flat file, used to match brand, and written to the
 *   sheet for traceability. ASIN is written to column L (index 12).
 *
 * Modes (via ?mode=):
 *   rolling   — last 2.5 hours (default, used by cron)
 *   day       — today from midnight UTC to now-10min
 *   yesterday — full yesterday
 *   week      — explicit ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Sheet: amazon-orders  |  One tab per brand, auto-created on first run.
 */

const zlib                                    = require('zlib');
const { spRequest }                           = require('../_spauth');
const { ensureTab, appendRows, readRows }     = require('../config/_sheets_client');
const brands                                  = require('../config/brands');
const sheets                                  = require('../config/sheets');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
  'estimated_fees', // Amazon Product Fees API estimate, line-item total (see getFeesEstimate below)
];

const REPORT_POLL_TIMEOUT_MS  = 25_000;
const REPORT_POLL_INTERVAL_MS = 3_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mode = req.query.mode || 'rolling';
  const { start, end } = getDateRange(mode, req);

  console.log(`[sync-orders] mode=${mode} start=${start} end=${end}`);

  // ── 1. Request the flat file report ────────────────────────────────────────
  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime:  start,
      dataEndTime:    end,
    });
    reportId = createResp.reportId;
    console.log(`[sync-orders] report requested: ${reportId}`);
  } catch (err) {
    console.error('[sync-orders] failed to request report:', err.message);
    return res.status(500).json({ error: 'Failed to request report', detail: err.message });
  }

  // ── 2. Poll until DONE ─────────────────────────────────────────────────────
  let documentId = null;
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    try {
      const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      const status     = statusResp.processingStatus;
      console.log(`[sync-orders] report ${reportId} status: ${status}`);

      if (status === 'DONE') {
        documentId = statusResp.reportDocumentId;
        break;
      }
      if (status === 'FATAL' || status === 'CANCELLED') {
        return res.status(500).json({ error: `Report ${status}`, reportId });
      }
    } catch (err) {
      console.warn(`[sync-orders] poll error (will retry): ${err.message}`);
    }
  }

  if (!documentId) {
    return res.status(202).json({
      message: 'Report not ready within timeout — will be picked up next run',
      reportId,
    });
  }

  // ── 3. Download and decompress ─────────────────────────────────────────────
  let rawTsv;
  try {
    const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    const fileResp = await fetch(docResp.url);
    if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    rawTsv = await new Promise((resolve) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) {
          console.log('[sync-orders] not gzipped, reading as plain text');
          resolve(buffer.toString('utf8'));
        } else {
          resolve(result.toString('utf8'));
        }
      });
    });
  } catch (err) {
    console.error('[sync-orders] failed to download/decompress report:', err.message);
    return res.status(500).json({ error: 'Failed to download report', detail: err.message });
  }

  // ── 4. Parse TSV ───────────────────────────────────────────────────────────
  const lines   = rawTsv.split('\n').filter(l => l.trim());
  const headers = lines[0].split('\t').map(h => h.trim());
  const rows    = lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').trim()]));
  });

  console.log(`[sync-orders] flat file rows: ${rows.length}`);

  // ── 5. Per-brand processing ────────────────────────────────────────────────
  const nowEst  = toEstIso(new Date());
  const results = [];

  // Fees cache — Product Fees API is priced-per-call (1 call per unique
  // ASIN + unit price combo), so we dedupe across the whole run rather than
  // calling once per line item. Same ASIN at the same price only ever costs
  // one API call no matter how many order rows reference it this run.
  const feesCache = new Map(); // key: `${asin}|${unitPrice}` -> fee per unit (number) or null

  for (const brand of brands.filter(b => b.active)) {
    try {
      // Brand is determined by SKU prefix — never by Amazon's brand field
      // NOTE: we intentionally do NOT filter out cancelled/pending orders here.
      // All orders are captured regardless of status; reconcile-orders.js
      // updates status later as orders move through their lifecycle.
      const brandRows = rows.filter(row => {
        const sku    = (row['sku'] || row['seller-sku'] || '').toUpperCase();
        const promo  = (row['promotion-ids'] || '').toLowerCase();

        return sku.startsWith(brand.skuPrefix.toUpperCase())
          && !promo.includes('vine');
      });

      if (brandRows.length === 0) {
        console.log(`[sync-orders] ${brand.id} — 0 rows after filtering`);
        results.push({ brand: brand.id, status: 'ok', rows: 0, mode });
        continue;
      }

      // Read existing keys FIRST so we skip fee lookups on rows that are
      // duplicates anyway — Product Fees API calls aren't free, no reason to
      // spend them on rows we're about to throw away.
      const token        = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.orders, brand.tabName);
      const existingKeys = new Set(
        existingRows
          .map(r => `${r.order_id}||${r.sku}`)
          .filter(k => k !== '||')
      );

      // Build the base (fee-less) row data first, filtering out dupes
      const candidateRows = brandRows.map(row => {
        const orderId = row['amazon-order-id'] || row['order-id'] || '';
        const sku     = row['sku'] || row['seller-sku'] || '';
        const qty     = parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10);
        const qtyShip = parseInt(row['quantity-shipped'] || '0', 10);
        const price   = parseFloat(row['item-price'] || '0');
        const disc    = parseFloat(row['item-promotion-discount'] || row['promotion-discount'] || '0');
        const asin    = row['asin'] || '';
        const date    = (row['purchase-date'] || '').slice(0, 10);
        const status  = row['order-status'] || '';
        const promoIds = row['promotion-ids'] || '';
        return { orderId, sku, qty, qtyShip, price, disc, asin, date, status, promoIds };
      }).filter(r => r.orderId);

      const dedupedCandidates = candidateRows.filter(r => !existingKeys.has(`${r.orderId}||${r.sku}`));
      const dupCount = candidateRows.length - dedupedCandidates.length;

      if (dupCount > 0) {
        console.log(`[sync-orders] ${brand.id} — skipped ${dupCount} duplicate order+sku rows`);
      }

      // Fetch (or reuse cached) fee estimates for each new row, then assemble
      // the final sheet rows. Sequential — cache hits are instant, and this
      // only makes new API calls for genuinely new, unpriced rows — to stay
      // under Product Fees API rate limits.
      const dedupedRows = [];
      for (const r of dedupedCandidates) {
        const unitPrice     = r.qty > 0 ? round2(r.price / r.qty) : round2(r.price);
        const feePerUnit    = await getFeesEstimate(feesCache, r.asin, unitPrice);
        const estimatedFees = feePerUnit != null ? round2(feePerUnit * r.qty) : '';

        dedupedRows.push([
          r.orderId,                                  // order_id
          r.date,                                      // date
          r.status,                                    // status
          round2(r.price),                             // order_total (line item total)
          r.promoIds,                                  // promotion_ids
          'FALSE',                                     // is_premium_order (not in flat file)
          round2(r.disc),                              // promotion_discount
          round2(r.price),                             // item_price
          r.qty,                                       // quantity_ordered
          r.qtyShip,                                   // quantity_shipped
          r.qty,                                       // unit_count
          r.sku,                                       // sku (used for brand ID; kept for traceability)
          r.asin,                                      // asin (column L)
          brand.id,                                    // brand
          nowEst,                                       // last_updated (EST)
          estimatedFees,                                // estimated_fees (Product Fees API estimate)
        ]);
      }

      if (dedupedRows.length > 0) {
        await appendRows(sheets.orders, brand.tabName, dedupedRows, token);
        console.log(`[sync-orders] ${brand.id} — ${dedupedRows.length} rows written`);
      } else {
        console.log(`[sync-orders] ${brand.id} — 0 new rows (all duplicates)`);
      }

      results.push({ brand: brand.id, status: 'ok', rows: dedupedRows.length, skipped: dupCount, mode });
    } catch (err) {
      console.error(`[sync-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({
    synced:    results,
    reportId,
    timestamp: nowEst,
  });
};

// ── Date range ─────────────────────────────────────────────────────────────────

function getDateRange(mode, req) {
  const now        = new Date();
  const pad        = n => String(n).padStart(2, '0');
  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  if (mode === 'rolling') {
    const hours = parseFloat(req?.query?.hours || 2.5);
    return {
      start: new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z',
      end:   safeBefore,
    };
  }

  if (mode === 'day') {
    const y = now.getUTCFullYear(), m = pad(now.getUTCMonth() + 1), d = pad(now.getUTCDate());
    return { start: `${y}-${m}-${d}T00:00:00Z`, end: safeBefore };
  }

  if (mode === 'yesterday') {
    const d   = new Date(now);
    d.setDate(d.getDate() - 1);
    const y   = d.getFullYear(), m = pad(d.getMonth() + 1), day = pad(d.getDate());
    return { start: `${y}-${m}-${day}T00:00:00Z`, end: `${y}-${m}-${day}T23:59:59Z` };
  }

  if (mode === 'week') {
    const start     = req?.query?.start;
    const end       = req?.query?.end;
    const startTime = req?.query?.startTime || '00:00:00';
    const endTime   = req?.query?.endTime   || '23:59:59';
    if (!start || !end) throw new Error('mode=week requires ?start=YYYY-MM-DD&end=YYYY-MM-DD');
    const endTs  = new Date(`${end}T${endTime}Z`);
    const endStr = endTs > now ? safeBefore : `${end}T${endTime}Z`;
    return { start: `${start}T${startTime}Z`, end: endStr };
  }

  throw new Error(`Unknown mode: ${mode}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns an ISO-8601 timestamp converted to Eastern Time (ET).
 * Handles EST (UTC-5) and EDT (UTC-4) automatically via Intl.
 * Format: 2026-06-24T15:16:45.000Z  (the Z suffix is kept by convention
 * to signal a fixed-format string — the value itself reflects ET wall time).
 */
function toEstIso(date) {
  const estStr = new Intl.DateTimeFormat('en-US', {
    timeZone:  'America/New_York',
    year:      'numeric',
    month:     '2-digit',
    day:       '2-digit',
    hour:      '2-digit',
    minute:    '2-digit',
    second:    '2-digit',
    hour12:    false,
  }).formatToParts(date);

  const p = Object.fromEntries(estStr.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms)); 
const round2 = n  => Math.round(n * 100) / 100;

/**
 * Returns an ESTIMATED per-unit fee for a given ASIN at a given per-unit price,
 * via Amazon's Product Fees API v0 (POST /products/fees/v0/items/{asin}/feesEstimate).
 * This is an ESTIMATE, not an actual charged fee — actual fees only exist in the
 * Finances API (settlement-based, lags by weeks). Estimate is intentionally what
 * we're using here per requirements — it's fast, available immediately per order,
 * and "close enough" for a monthly rollup on the dashboard.
 *
 * Caches by `${asin}|${unitPrice}` for the life of one cron run — the same
 * ASIN at the same price always estimates identically, so we only ever pay
 * for one API call per unique combo per run, no matter how many order rows
 * reference it.
 *
 * Returns null (not 0) on any failure so callers can distinguish "we don't
 * know" from "the fee is actually zero" — a blank cell in the sheet, not a
 * misleading $0.
 */
async function getFeesEstimate(feesCache, asin, unitPrice) {
  if (!asin || !unitPrice || unitPrice <= 0) return null;

  const cacheKey = `${asin}|${unitPrice}`;
  if (feesCache.has(cacheKey)) return feesCache.get(cacheKey);

  try {
    const body = {
      FeesEstimateRequest: {
        MarketplaceId: process.env.SP_MARKETPLACE_ID,
        IsAmazonFulfilled: true,
        PriceToEstimateFees: {
          ListingPrice: { CurrencyCode: 'USD', Amount: unitPrice },
          Shipping:     { CurrencyCode: 'USD', Amount: 0 },
        },
        Identifier: cacheKey,
      },
    };

    const resp = await spRequest('POST', `/products/fees/v0/items/${asin}/feesEstimate`, {}, body);
    const result = resp?.payload?.FeesEstimateResult;

    if (result?.Status !== 'Success' || !result?.FeesEstimate) {
      console.warn(`[sync-orders] fees estimate not available for ${asin} @ $${unitPrice}: ${result?.Status || 'no result'}`);
      feesCache.set(cacheKey, null);
      return null;
    }

    const feePerUnit = result.FeesEstimate.TotalFeesEstimate?.Amount ?? null;
    feesCache.set(cacheKey, feePerUnit);

    // Small delay only on actual (non-cached) API calls, to stay under
    // Product Fees API rate limits without slowing down cache hits.
    await sleep(1100);

    return feePerUnit;
  } catch (err) {
    console.warn(`[sync-orders] fees estimate failed for ${asin} @ $${unitPrice}: ${err.message}`);
    feesCache.set(cacheKey, null);
    return null;
  }
}
