/**
 * api/cron/sync-orders-process.js
 * Step 2 of 2 — reads the reportId stored by sync-orders-request.js, polls
 * until DONE, downloads it, and UPSERTS into each brand's tab:
 *
 *   - New order+sku rows are appended.
 *   - Existing rows are overwritten IN PLACE only if Amazon's data actually
 *     changed (status moved pending → shipped/cancelled, quantity_shipped
 *     changed, price changed, etc).
 *   - Rows with no change are left completely untouched — including their
 *     estimated_fees value, so an unchanged row never re-pays for a fee
 *     estimate it already has.
 *   - A changed row only gets a NEW fee estimate if its price changed.
 *     Fees depend on ASIN + unit price, not on status — a pending→shipped
 *     transition shouldn't cost an API call.
 *
 * This is what makes replacing reconcile-orders.js safe: because
 * sync-orders-request.js re-requests the same rolling 15-day window every
 * run, every recent order gets re-checked against Amazon's current data
 * repeatedly until its status stops changing — there's no longer a gap
 * where a "pending" row never gets revisited.
 *
 * trim-orders.js is UNCHANGED — still runs separately to drop rows older
 * than 90 days so the sheet doesn't grow unbounded. This job only ever
 * touches the last 15 days; trim-orders handles the tail end.
 *
 * Runs every 2 hours, ~15 min after sync-orders-request. Safe to re-run
 * manually if a prior attempt timed out waiting on the report — it re-reads
 * the same reportId from _meta rather than requesting a new one.
 *
 * Manual:
 *   POST /api/cron/sync-orders-process
 *   Authorization: Bearer <CRON_SECRET>
 *   (optional ?reportId=... to force a specific report instead of _meta's)
 */

const zlib                                 = require('zlib');
const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
  'Amazon Estimated fees',   // Amazon Product Fees API estimate — matches sheet column exactly
  'Amazon Sale Promotions',  // seller-funded event discount: (regular_price - item_price) × units
];

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// Generous poll window — this step runs on its own schedule 15 min after
// the report was requested, so it's not racing a single HTTP request like
// the old combined sync-orders.js did.
const REPORT_POLL_TIMEOUT_MS  = 60_000;
const REPORT_POLL_INTERVAL_MS = 4_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── 1. Read reportId (+ range, for logging) from _meta ─────────────────────
  let reportId, reportStart, reportEnd;
  try {
    const rawMeta = await readRows(sheets.orders, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
    reportId    = req.query.reportId || metaMap['report_id'];
    reportStart = metaMap['report_start'];
    reportEnd   = metaMap['report_end'];

    if (!reportId) {
      return res.status(400).json({ error: 'No reportId in _meta — did sync-orders-request run?' });
    }
  } catch (err) {
    console.error('[sync-orders-process] failed to read _meta:', err.message);
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  console.log(`[sync-orders-process] processing report ${reportId} (${reportStart} → ${reportEnd})`);

  // ── 2. Poll until DONE ───────────────────────────────────────────────────
  let documentId = null;
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    try {
      const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      const status     = statusResp.processingStatus;
      console.log(`[sync-orders-process] report ${reportId} status: ${status}`);

      if (status === 'DONE') {
        documentId = statusResp.reportDocumentId;
        break;
      }
      if (status === 'FATAL' || status === 'CANCELLED') {
        return res.status(500).json({ error: `Report ${status}`, reportId });
      }
    } catch (err) {
      console.warn(`[sync-orders-process] poll error (will retry): ${err.message}`);
    }
  }

  if (!documentId) {
    return res.status(202).json({
      message: 'Report not ready within timeout — will be picked up next run',
      reportId,
    });
  }

  // ── 3. Download and decompress ───────────────────────────────────────────
  let rawTsv;
  try {
    const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    const fileResp = await fetch(docResp.url);
    if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    rawTsv = await new Promise((resolve) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) {
          console.log('[sync-orders-process] not gzipped, reading as plain text');
          resolve(buffer.toString('utf8'));
        } else {
          resolve(result.toString('utf8'));
        }
      });
    });
  } catch (err) {
    console.error('[sync-orders-process] failed to download/decompress report:', err.message);
    return res.status(500).json({ error: 'Failed to download report', detail: err.message });
  }

  // ── 4. Parse TSV ───────────────────────────────────────────────────────────
  const lines   = rawTsv.split('\n').filter(l => l.trim());
  const headers = lines[0].split('\t').map(h => h.trim());
  const rows    = lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').trim()]));
  });

  console.log(`[sync-orders-process] flat file rows: ${rows.length}`);

  // ── Load Events + price reference for sale_promos calculation ─────────────
  // Events tab: event_name, start_date, end_date, skus (comma-separated)
  // Product Short Name tab: ASIN, SKU, Product Short Name, Brand, Price
  // Both live in the master SKU/ASIN sheet (SHEET_MASTER_SKU_LIST env var).
  // We load them once here and pass the lookup into the per-row upsert below.
  const PRODUCTS_SHEET_ID = process.env.SHEET_MASTER_SKU_LIST;
  const EVENTS_GID        = '347530381';
  const PROD_NAMES_GID    = '164358627';

  // eventWindows: array of { asinSet: Set, startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
  // priceRef: Map of SKU.toUpperCase() → regular price (number)
  let eventWindows = [];
  let priceRef     = new Map();

  try {
    if (PRODUCTS_SHEET_ID) {
      const [eventsCsv, prodCsv] = await Promise.all([
        fetchCsv(PRODUCTS_SHEET_ID, EVENTS_GID),
        fetchCsv(PRODUCTS_SHEET_ID, PROD_NAMES_GID),
      ]);

      // Parse events — SKUs column is optional. If blank/missing, the event
      // applies to ALL SKUs that have a regular price in the Product Short Name tab.
      // We build the asinSet after priceRef is populated below.
      const evRows = parseTsvRows(eventsCsv, ',');
      const rawEvents = evRows.map(r => ({
        name:      (r['Event Name'] || '').trim(),
        startDate: (r['start_date'] || '').trim(),
        endDate:   (r['end_date']   || '').trim(),
        skuList:   (r['SKUs']       || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
      })).filter(ev => ev.startDate && ev.endDate);

      // Parse regular prices — keyed by ASIN (safer than SKU since each product
      // has two SKUs: FBA e.g. EVO0001 and seller-fulfilled e.g. EVO0001-SF,
      // but only the FBA SKU is listed in Product Short Name. ASIN covers both.)
      const prodRows = parseTsvRows(prodCsv, ',');
      prodRows.forEach(r => {
        const asinKey = (r['ASIN'] || '').trim().toUpperCase();
        const price   = parseFloat((r['Price'] || r['price'] || '').replace(/[$,]/g, '')) || 0;
        if (asinKey && price > 0) priceRef.set(asinKey, price);
      });

      // Build eventWindows — always uses ALL priced ASINs from Product Short Name tab.
      const allPricedAsins = new Set(priceRef.keys());
      rawEvents.forEach(ev => {
        eventWindows.push({ asinSet: allPricedAsins, startDate: ev.startDate, endDate: ev.endDate });
      });

      console.log(`[sync-orders-process] events loaded: ${eventWindows.length}, prices: ${priceRef.size}`);
    }
  } catch (err) {
    console.warn('[sync-orders-process] failed to load events/prices — sale_promos will be blank:', err.message);
  }

  // ── 5. Per-brand upsert ────────────────────────────────────────────────────
  const nowEst  = toEstIso(new Date());
  const results = [];

  // Fees cache — same ASIN + unit price only ever costs one Product Fees API
  // call per run, no matter how many rows reference it this run. Combined
  // with the "reuse existing estimate if price unchanged" logic below, a
  // steady-state run (mostly status changes on already-priced orders) makes
  // very few — often zero — new fee calls at all.
  const feesCache = new Map();

  for (const brand of brands.filter(b => b.active)) {
    try {
      // Brand is determined by SKU prefix — never by Amazon's brand field.
      // We intentionally do NOT filter out cancelled/pending orders here —
      // catching those transitions is the whole point of this rewrite.
      const brandRows = rows.filter(row => {
        const sku   = (row['sku'] || row['seller-sku'] || '').toUpperCase();
        const promo = (row['promotion-ids'] || '').toLowerCase();
        return sku.startsWith(brand.skuPrefix.toUpperCase()) && !promo.includes('vine');
      });

      if (brandRows.length === 0) {
        console.log(`[sync-orders-process] ${brand.id} — 0 rows after filtering`);
        results.push({ brand: brand.id, status: 'ok', new: 0, updated: 0, unchanged: 0 });
        continue;
      }

      const token           = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const existingRowsRaw = await readRows(sheets.orders, brand.tabName);
      const existingRowsObj = (existingRowsRaw || []).map(normalizeRow);

      // Map existing rows by composite key for O(1) lookup + in-place update
      const existingByKey = new Map();
      existingRowsObj.forEach((r, idx) => {
        const key = `${r.order_id}||${r.sku}`;
        if (key !== '||') existingByKey.set(key, { row: r, idx });
      });

      // Working array we mutate in place, then write back whole (replaceRows
      // rewrites the full tab — there's no row-level patch available).
      const workingRows = existingRowsObj.map(r => HEADERS.map(h => r[h] ?? ''));

      let newCount = 0, updatedCount = 0, unchangedCount = 0;

      for (const row of brandRows) {
        const orderId = row['amazon-order-id'] || row['order-id'] || '';
        if (!orderId) continue;

        const sku      = row['sku'] || row['seller-sku'] || '';
        const key      = `${orderId}||${sku}`;
        const qty      = parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10);
        const qtyShip  = parseInt(row['quantity-shipped'] || '0', 10);
        const price    = round2(parseFloat(row['item-price'] || '0'));
        const disc     = round2(parseFloat(row['item-promotion-discount'] || row['promotion-discount'] || '0'));
        const asin     = row['asin'] || '';
        const date     = (row['purchase-date'] || '').slice(0, 10);
        const status   = row['order-status'] || '';
        const promoIds = row['promotion-ids'] || '';

        const existing = existingByKey.get(key);

        // Check if this row needs an Amazon Sale Promotions value written for
        // the first time — treat a blank sale_promos on an event-window row as
        // a change so we don't skip it with the unchanged shortcut below.
        const isInEventWindow = date && asin && eventWindows.some(
          ev => date >= ev.startDate && date <= ev.endDate && ev.asinSet.has(asin.toUpperCase())
        );
        const missingPromos = isInEventWindow &&
          (existing?.row['Amazon Sale Promotions'] == null || existing?.row['Amazon Sale Promotions'] === '');

        const changed  = !existing || missingPromos || rowChanged(existing.row, { date, status, price, disc, qty, qtyShip, promoIds });

        if (existing && !changed) {
          unchangedCount++;
          continue; // leave this row exactly as-is, including its estimated_fees
        }

        // Reuse a stored fee if we already have one — never overwrite with
        // blank, and never re-pay for a fee we already successfully fetched.
        // If we DON'T have one yet (brand-new row, price changed, OR a prior
        // attempt on this row failed/was skipped), always try the API again.
        // This row only got here at all because something about it changed
        // (see the `changed` check above) — unchanged rows never reach this
        // code, so this doesn't reprocess the whole sheet every run, just
        // rows that were already going to be touched for another reason.
        const unitPrice    = qty > 0 ? round2(price / qty) : price;
        const storedFee    = existing?.row['Amazon Estimated fees'];
        const hasStoredFee = storedFee !== '' && storedFee != null;

        // Fees depend on fulfillment channel — FBA vs seller-fulfilled get
        // different fee schedules from Amazon, and passing the wrong flag
        // returns Status: ClientError / InvalidParameterValue every time.
        // Each product has an FBA SKU (e.g. EVO0001) and a seller-fulfilled
        // SKU (e.g. EVO0001-SF); the -SF suffix is the only reliable signal.
        const isAmazonFulfilled = !sku.toUpperCase().endsWith('-SF');

        let estimatedFees;
        if (hasStoredFee) {
          estimatedFees = storedFee;
        } else {
          const feePerUnit = await getFeesEstimate(feesCache, asin, unitPrice, isAmazonFulfilled);
          estimatedFees = feePerUnit != null ? round2(feePerUnit * qty) : '';
        }

        // ── sale_promos: seller-funded event discount ───────────────────────
        let salePromos = '';
        let diagCount  = 0;
        if (date && qty > 0 && asin) {
          for (const ev of eventWindows) {
            if (date >= ev.startDate && date <= ev.endDate && ev.asinSet.has(asin.toUpperCase())) {
              const regularPrice = priceRef.get(asin.toUpperCase());
              if (diagCount++ < 5) {
                console.log(`[sale-promos-diag] asin=${asin} sku=${sku} date=${date} itemPrice=${price} regularPrice=${regularPrice} qty=${qty}`);
              }
              if (regularPrice && regularPrice > price) {
                salePromos = round2((regularPrice - price) * qty);
              }
              break;
            }
          }
        }
        // If this is an unchanged row being skipped, we already continue'd above.
        // For updated rows where sale_promos wasn't recalculated (e.g. status-only
        // change), fall back to stored value so we don't blank out a prior calculation.
        if (salePromos === '' && existing && existing.row['Amazon Sale Promotions'] != null && existing.row['Amazon Sale Promotions'] !== '') {
          salePromos = existing.row['Amazon Sale Promotions'];
        }

        const newRow = [
          orderId,       // order_id
          date,          // date
          status,        // status
          price,         // order_total (line item total)
          promoIds,      // promotion_ids
          'FALSE',       // is_premium_order (not in flat file)
          disc,          // promotion_discount
          price,         // item_price
          qty,           // quantity_ordered
          qtyShip,       // quantity_shipped
          qty,           // unit_count
          sku,           // sku
          asin,          // asin
          brand.id,      // brand
          nowEst,        // last_updated (EST)
          estimatedFees, // Amazon Estimated Fees
          salePromos,    // Amazon Sale Promotions
        ];

        if (existing) {
          workingRows[existing.idx] = newRow;
          updatedCount++;
        } else {
          workingRows.push(newRow);
          newCount++;
        }
      }

      await replaceRows(sheets.orders, brand.tabName, HEADERS, workingRows, token);
      console.log(`[sync-orders-process] ${brand.id} — new=${newCount} updated=${updatedCount} unchanged=${unchangedCount}`);
      results.push({ brand: brand.id, status: 'ok', new: newCount, updated: updatedCount, unchanged: unchangedCount });
    } catch (err) {
      console.error(`[sync-orders-process] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  // ── 6. Mark processed in _meta ──────────────────────────────────────────────
  try {
    const token   = await ensureTab(sheets.orders, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.orders, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
    metaMap['report_status']     = 'PROCESSED';
    metaMap['last_processed_at'] = nowEst;
    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, nowEst]);
    await replaceRows(sheets.orders, META_TAB, META_HEADERS, metaRows, token);
  } catch (err) {
    console.warn('[sync-orders-process] failed to update _meta status:', err.message);
  }

  res.status(200).json({ synced: results, reportId, timestamp: nowEst });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// readRows may return arrays or header-keyed objects depending on the tab —
// normalize to an object so field access is consistent either way.
function normalizeRow(r) {
  if (Array.isArray(r)) {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  }
  return r;
}

// True if any substantive field differs from what's stored. last_updated and
// estimated_fees are intentionally excluded from comparison — they're
// outputs derived from the other fields, not inputs to compare against.
function rowChanged(existingRowObj, candidate) {
  const exStatus  = (existingRowObj.status || '').trim();
  const exDate    = (existingRowObj.date || '').trim();
  const exPrice   = round2(parseFloat(existingRowObj.item_price || '0'));
  const exDisc    = round2(parseFloat(existingRowObj.promotion_discount || '0'));
  const exQty     = parseInt(existingRowObj.quantity_ordered || '0', 10);
  const exQtyShip = parseInt(existingRowObj.quantity_shipped || '0', 10);
  const exPromo   = (existingRowObj.promotion_ids || '').trim();

  return (
    exStatus  !== candidate.status  ||
    exDate    !== candidate.date    ||
    exPrice   !== candidate.price   ||
    exDisc    !== candidate.disc    ||
    exQty     !== candidate.qty     ||
    exQtyShip !== candidate.qtyShip ||
    exPromo   !== candidate.promoIds
  );
}

/**
 * Amazon Product Fees API v0 estimate for a given ASIN at a given per-unit
 * price. ESTIMATE, not an actual charged fee (actual fees only exist in the
 * Finances API, settlement-based, lags by weeks) — intentionally using the
 * estimate here per requirements, since it's available immediately per order.
 *
 * isAmazonFulfilled must match the actual fulfillment channel — passing the
 * wrong value returns Status: ClientError / InvalidParameterValue, not a
 * usable estimate. Caller derives this from the SKU (-SF suffix = seller-
 * fulfilled), since that's the only reliable signal available here.
 *
 * Returns null (not 0) on failure so callers can tell "we don't know" apart
 * from "the fee is actually zero."
 */
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
        Identifier: cacheKey,
      },
    };

    const resp   = await spRequest('POST', `/products/fees/v0/items/${asin}/feesEstimate`, {}, body);
    const result = resp?.payload?.FeesEstimateResult;

    if (result?.Status !== 'Success' || !result?.FeesEstimate) {
      // Log the real reason, not just the Status — this is what was hiding
      // the fulfillment-channel mismatch (Error.Code: InvalidParameterValue).
      console.warn(`[sync-orders-process] fees estimate not available for ${asin} @ $${unitPrice} (isAmazonFulfilled=${isAmazonFulfilled}): ${result?.Status || 'no result'} — ${JSON.stringify(result?.Error || {})}`);
      feesCache.set(cacheKey, null);
      return null;
    }

    const feePerUnit = result.FeesEstimate.TotalFeesEstimate?.Amount ?? null;
    feesCache.set(cacheKey, feePerUnit);

    // Small delay only on actual (non-cached) API calls, to stay under
    // Product Fees API rate limits without slowing down cache/reuse hits.
    await sleep(1100);

    return feePerUnit;
  } catch (err) {
    console.warn(`[sync-orders-process] fees estimate failed for ${asin} @ $${unitPrice} (isAmazonFulfilled=${isAmazonFulfilled}): ${err.message}`);
    feesCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Returns an ISO-8601 timestamp converted to Eastern Time (ET).
 * Handles EST (UTC-5) and EDT (UTC-4) automatically via Intl.
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

// Fetches a Google Sheet tab as CSV text using the export URL.
async function fetchCsv(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetchCsv failed: ${resp.status} ${url}`);
  return resp.text();
}

// Minimal CSV parser for Google Sheets exports (handles quoted fields).
// delimiter is ',' for CSV exports.
function parseTsvRows(text, delimiter = ',') {
  if (!text || !text.trim()) return [];
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0], delimiter).map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = splitLine(line, delimiter);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
    return obj;
  });
}

function splitLine(line, delimiter) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; cur += c; }
    else if (c === delimiter && !inQuote) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}
