/**
 * api/cron/sync-orders-process.js
 * Step 2 of 2 — reads the reportId stored by sync-orders-request.js, polls
 * until DONE, downloads it, and writes order data into each brand's tab.
 *
 * This job does ONE thing: keep order data (status, price, qty, promo_ids)
 * accurate for the last 30 days. It does NOT compute fees or sale
 * promotions — those are handled by two separate, independently-scheduled
 * jobs (api/cron/fees-estimate.js and api/cron/sale-promotions.js) so a
 * problem in either of those can never block basic order data from syncing.
 *
 * Every row Amazon returns for the 30-day window is written unconditionally
 * — no change-detection, no diffing. If it's already in the sheet, it's
 * overwritten with Amazon's current data; if it's new, it's appended. This
 * is intentionally simple: the old version skipped rows it thought were
 * "unchanged" specifically to avoid re-paying for a fee/promo calculation
 * that lived in this same file — now that those calculations don't happen
 * here at all, there's no cost to overwriting every row every time, and
 * removing that logic removes an entire class of "why didn't this row
 * update" bugs.
 *
 * The "Amazon Estimated fees" and "Amazon Sale Promotions" columns are
 * explicitly preserved from whatever's already in the sheet on every
 * overwrite — this job never blanks them out, since it's not the job
 * that computes them.
 *
 * trim-orders.js is UNCHANGED — still runs separately to drop rows older
 * than 90 days so the sheet doesn't grow unbounded. This job only ever
 * touches the last 30 days; trim-orders handles the tail end.
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
const { sendCronFailureAlert }             = require('../_alerts');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
  'Amazon Estimated fees',   // owned by api/cron/fees-estimate.js — preserved here, never computed
  'Amazon Sale Promotions',  // owned by api/cron/sale-promotions.js — preserved here, never computed
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
    await sendCronFailureAlert('sync-orders-process', err.message, { Stage: 'reading _meta tab' });
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
        await sendCronFailureAlert('sync-orders-process', `Report ${status}`, { 'Report ID': reportId });
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
    await sendCronFailureAlert('sync-orders-process', err.message, { Stage: 'downloading/decompressing report' });
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

  // ── 5. Per-brand overwrite ───────────────────────────────────────────────
  const nowEst  = toEstIso(new Date());
  const results = [];

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
        results.push({ brand: brand.id, status: 'ok', new: 0, overwritten: 0 });
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

      let newCount = 0, overwrittenCount = 0;

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

        // Never blank these — they belong to the fees-estimate and
        // sale-promotions crons, not this one. Carry forward whatever's
        // already there (blank if this row is brand-new).
        const preservedFee   = existing?.row['Amazon Estimated fees']  ?? '';
        const preservedPromo = existing?.row['Amazon Sale Promotions'] ?? '';

        const newRow = [
          orderId,        // order_id
          date,           // date
          status,         // status
          price,          // order_total (line item total)
          promoIds,       // promotion_ids
          'FALSE',        // is_premium_order (not in flat file)
          disc,           // promotion_discount
          price,          // item_price
          qty,            // quantity_ordered
          qtyShip,        // quantity_shipped
          qty,            // unit_count
          sku,            // sku
          asin,           // asin
          brand.id,       // brand
          nowEst,         // last_updated (EST)
          preservedFee,   // Amazon Estimated Fees — untouched by this job
          preservedPromo, // Amazon Sale Promotions — untouched by this job
        ];

        if (existing) {
          workingRows[existing.idx] = newRow;
          overwrittenCount++;
        } else {
          workingRows.push(newRow);
          newCount++;
        }
      }

      await replaceRows(sheets.orders, brand.tabName, HEADERS, workingRows, token);
      console.log(`[sync-orders-process] ${brand.id} — new=${newCount} overwritten=${overwrittenCount}`);
      results.push({ brand: brand.id, status: 'ok', new: newCount, overwritten: overwrittenCount });
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
    await sendCronFailureAlert('sync-orders-process', err.message, { Stage: 'marking report processed in _meta' });
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-orders-process',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
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
