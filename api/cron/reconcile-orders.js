/**
 * api/cron/reconcile-orders.js
 * Runs daily — reconciles order statuses on the rolling sheet against
 * a fresh flat file pull for the last 14 days.
 *
 * What it does:
 *   1. Pulls a flat file report for the last 14 days (covers realistic
 *      cancellation and return windows without timing out on 90 days).
 *   2. For each brand tab, finds rows on the sheet whose status is
 *      Pending OR Shipped and whose order_id appears in the flat file
 *      with a DIFFERENT status (e.g. Pending→Shipped, Shipped→Cancelled).
 *   3. Patches status and last_updated on those rows in-place.
 *      item_price is patched per-line (not aggregated order total) so
 *      multi-SKU orders are handled correctly.
 *
 * Why 14 days only:
 *   Scanning 90 days of orders against the flat file would time out.
 *   14 days covers the realistic window for a post-capture status change.
 *   Orders older than 14 days that get cancelled/returned are an edge case
 *   handled by a separate monthly reconciliation pass if needed.
 *
 * Note on cancellations at sync time:
 *   sync-orders already filters out status=cancelled rows at write time,
 *   so a cancellation that arrives within the same 2.5h window is never
 *   written. This reconcile cron catches orders that were written as
 *   Shipped/Pending and later flipped to Cancelled or Returned.
 *
 * Schedule: daily at 8AM UTC ("0 8 * * *")
 *
 * GET /api/cron/reconcile-orders
 * Authorization: Bearer <CRON_SECRET>
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
];

// Statuses that are eligible for reconciliation (may have changed)
const RECONCILABLE_STATUSES = new Set(['pending', 'shipped']);

// How far back to look for status changes
const LOOKBACK_DAYS = 14;

const REPORT_POLL_TIMEOUT_MS  = 25_000;
const REPORT_POLL_INTERVAL_MS = 3_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nowEst     = toEstIso(new Date());
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - LOOKBACK_DAYS);
  const cutoffStr  = cutoffDate.toISOString().slice(0, 10);
  const start      = cutoffDate.toISOString().slice(0, 19) + 'Z';
  const safeBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  // ── 1. Request flat file for last 14 days ──────────────────────────────────
  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime:  start,
      dataEndTime:    safeBefore,
    });
    reportId = createResp.reportId;
    console.log(`[reconcile] report requested: ${reportId}`);
  } catch (err) {
    console.error('[reconcile] failed to request report:', err.message);
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
      console.log(`[reconcile] report ${reportId} status: ${status}`);

      if (status === 'DONE') {
        documentId = statusResp.reportDocumentId;
        break;
      }
      if (status === 'FATAL' || status === 'CANCELLED') {
        return res.status(500).json({ error: `Report ${status}`, reportId });
      }
    } catch (err) {
      console.warn(`[reconcile] poll error (will retry): ${err.message}`);
    }
  }

  if (!documentId) {
    return res.status(202).json({
      message: 'Report not ready within timeout — will retry next run',
      reportId,
    });
  }

  // ── 3. Download and decompress ─────────────────────────────────────────────
  let rawTsv;
  try {
    const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    const fileResp = await fetch(docResp.url);
    if (!fileResp.ok) throw new Error(`Download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    rawTsv = await new Promise((resolve) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) {
          console.log('[reconcile] not gzipped, reading as plain text');
          resolve(buffer.toString('utf8'));
        } else {
          resolve(result.toString('utf8'));
        }
      });
    });
  } catch (err) {
    console.error('[reconcile] failed to download report:', err.message);
    return res.status(500).json({ error: 'Failed to download report', detail: err.message });
  }

  // ── 4. Parse TSV into a map keyed by order_id + sku ───────────────────────
  // One entry per line item — matches the per-line-item schema on the sheet.
  // This ensures item_price patches are per-line, not aggregated order totals.
  const lines      = rawTsv.split('\n').filter(l => l.trim());
  const tsvHeaders = lines[0].split('\t').map(h => h.trim());
  const flatRows   = lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(tsvHeaders.map((h, i) => [h, (vals[i] || '').trim()]));
  });

  // flatMap keyed by "order_id||sku" for per-line patching
  const flatMap = {};
  for (const row of flatRows) {
    const orderId = row['amazon-order-id'] || row['order-id'] || '';
    const sku     = row['sku'] || row['seller-sku'] || '';
    if (!orderId || !sku) continue;

    const key = `${orderId}||${sku}`;
    flatMap[key] = {
      status:           row['order-status'] || '',
      item_price:       round2(parseFloat(row['item-price'] || '0')),
      promotion_discount: round2(parseFloat(row['item-promotion-discount'] || row['promotion-discount'] || '0')),
      quantity_ordered: parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10),
      quantity_shipped: parseInt(row['quantity-shipped'] || '0', 10),
    };
  }

  console.log(`[reconcile] flat file line items: ${Object.keys(flatMap).length}`);

  // ── 5. Per-brand reconciliation ────────────────────────────────────────────
  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token   = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const allRows = await readRows(sheets.orders, brand.tabName);

      // Only look at rows within the lookback window with a reconcilable status
      const eligibleRows = allRows.filter(r =>
        RECONCILABLE_STATUSES.has((r.status || '').toLowerCase()) &&
        (r.date || '') >= cutoffStr
      );

      if (eligibleRows.length === 0) {
        console.log(`[reconcile] ${brand.id} — no eligible rows`);
        results.push({ brand: brand.id, eligible: 0, updated: 0 });
        continue;
      }

      console.log(`[reconcile] ${brand.id} — ${eligibleRows.length} eligible rows to check`);

      let updatedCount = 0;

      const patched = allRows.map(row => {
        // Only reconcile rows within window with a reconcilable status
        if (!RECONCILABLE_STATUSES.has((row.status || '').toLowerCase())) return row;
        if ((row.date || '') < cutoffStr) return row;

        const key     = `${row.order_id}||${row.sku}`;
        const fetched = flatMap[key];
        if (!fetched) return row;

        // Normalise both sides for comparison
        const currentStatus = (row.status || '').toLowerCase();
        const newStatus     = (fetched.status || '').toLowerCase();

        // Skip if status hasn't changed
        if (newStatus === currentStatus) return row;

        updatedCount++;
        console.log(`[reconcile] ${brand.id} — ${row.order_id} ${row.sku}: ${row.status} → ${fetched.status}`);

        return {
          ...row,
          status:             fetched.status,
          item_price:         fetched.item_price,
          order_total:        fetched.item_price,   // order_total = item_price for line items
          promotion_discount: fetched.promotion_discount,
          quantity_ordered:   fetched.quantity_ordered,
          quantity_shipped:   fetched.quantity_shipped,
          last_updated:       nowEst,
        };
      });

      if (updatedCount > 0) {
        const rowArrays = patched.map(row => HEADERS.map(h => row[h] ?? ''));
        await replaceRows(sheets.orders, brand.tabName, HEADERS, rowArrays, token);
        console.log(`[reconcile] ${brand.id} — updated ${updatedCount} rows`);
      } else {
        console.log(`[reconcile] ${brand.id} — ${eligibleRows.length} eligible, no changes`);
      }

      results.push({ brand: brand.id, eligible: eligibleRows.length, updated: updatedCount });
    } catch (err) {
      console.error(`[reconcile] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const totalUpdated = results.reduce((s, r) => s + (r.updated || 0), 0);

  res.status(200).json({
    results,
    totalUpdated,
    reportId,
    timestamp: nowEst,
  });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns an ISO-8601 timestamp converted to Eastern Time (ET).
 * Handles EST (UTC-5) and EDT (UTC-4) automatically via Intl.
 * Format: 2026-06-24T15:16:45.000Z  (Z suffix kept by convention —
 * the value reflects ET wall time, not UTC).
 */
function toEstIso(date) {
  const estStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  }).formatToParts(date);

  const p = Object.fromEntries(estStr.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
