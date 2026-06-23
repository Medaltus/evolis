/**
 * api/cron/reconcile-orders.js
 * Runs daily — finds Pending orders in the rolling sheet and updates
 * their status, item_price, and last_updated from the flat file report.
 *
 * Uses GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL (same as
 * sync-orders) so FBA + FBM orders are both covered.
 *
 * Schedule: daily at 8AM UTC ("0 8 * * *")
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
  'unit_count', 'sku', 'brand', 'last_updated',
];

const MAX_PENDING_AGE_DAYS    = 14;
const REPORT_POLL_TIMEOUT_MS  = 25_000;
const REPORT_POLL_INTERVAL_MS = 3_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now        = new Date().toISOString();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_PENDING_AGE_DAYS);
  const cutoffStr  = cutoffDate.toISOString().slice(0, 10);
  const safeBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
  const start      = cutoffDate.toISOString().slice(0, 19) + 'Z';

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

  // ── 4. Parse TSV into a map keyed by order_id ──────────────────────────────
  const lines      = rawTsv.split('\n').filter(l => l.trim());
  const tsvHeaders = lines[0].split('\t').map(h => h.trim());
  const flatRows   = lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(tsvHeaders.map((h, i) => [h, (vals[i] || '').trim()]));
  });

  // Aggregate flat file by order_id (one row per line item)
  const flatMap = {};
  for (const row of flatRows) {
    const orderId = row['amazon-order-id'] || row['order-id'] || '';
    if (!orderId) continue;

    const qty   = parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10);
    const price = parseFloat(row['item-price'] || '0');
    const disc  = parseFloat(row['item-promotion-discount'] || row['promotion-discount'] || '0');

    if (!flatMap[orderId]) {
      flatMap[orderId] = {
        status:             row['order-status'] || '',
        item_price:         0,
        promotion_discount: 0,
        quantity_ordered:   0,
        quantity_shipped:   0,
      };
    }

    flatMap[orderId].item_price         = round2(flatMap[orderId].item_price + price);
    flatMap[orderId].promotion_discount = round2(flatMap[orderId].promotion_discount + disc);
    flatMap[orderId].quantity_ordered   += qty;
    flatMap[orderId].quantity_shipped   += parseInt(row['quantity-shipped'] || '0', 10);
  }

  console.log(`[reconcile] flat file order count: ${Object.keys(flatMap).length}`);

  // ── 5. Per-brand reconciliation ────────────────────────────────────────────
  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token   = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const allRows = await readRows(sheets.orders, brand.tabName);

      const pendingRows = allRows.filter(r =>
        (r.status || '').toLowerCase() === 'pending' &&
        (r.date   || '') >= cutoffStr
      );

      if (pendingRows.length === 0) {
        console.log(`[reconcile] ${brand.id} — no pending orders`);
        results.push({ brand: brand.id, pending: 0, updated: 0 });
        continue;
      }

      console.log(`[reconcile] ${brand.id} — ${pendingRows.length} pending orders to check`);

      let updatedCount = 0;
      const patched = allRows.map(row => {
        if ((row.status || '').toLowerCase() !== 'pending') return row;
        const fetched = flatMap[row.order_id];
        if (!fetched) return row;

        const newStatus = fetched.status || row.status;
        if (newStatus === row.status) return row;

        updatedCount++;
        return {
          ...row,
          status:             newStatus,
          item_price:         fetched.item_price,
          order_total:        fetched.item_price,
          promotion_discount: fetched.promotion_discount,
          quantity_ordered:   fetched.quantity_ordered,
          quantity_shipped:   fetched.quantity_shipped,
          last_updated:       now,
        };
      });

      if (updatedCount > 0) {
        const rowArrays = patched.map(row => HEADERS.map(h => row[h] ?? ''));
        await replaceRows(sheets.orders, brand.tabName, HEADERS, rowArrays, token);
        console.log(`[reconcile] ${brand.id} — updated ${updatedCount} orders`);
      } else {
        console.log(`[reconcile] ${brand.id} — ${pendingRows.length} still pending, no changes`);
      }

      results.push({ brand: brand.id, pending: pendingRows.length, updated: updatedCount });
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
    timestamp: now,
  });
};

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
