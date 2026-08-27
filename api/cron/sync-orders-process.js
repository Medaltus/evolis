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
  'Amazon Estimated fees',   // column P — owned by api/cron/fees-estimate.js — preserved here, never computed
  'Amazon Sale Promotions',  // column Q — owned by api/cron/sale-promotions.js — preserved here, never computed
  'marketplace',             // column R — ADDED 2026-08-12 per Jaclyn
  'channel',                 // column S — ADDED 2026-08-12 per Jaclyn
  'selling_account',         // column T — ADDED 2026-08-21 per Jaclyn. Hardcoded 'Newderm'
                              // for every row this cron writes — SP-API credentials are
                              // tied to one specific seller account by design, so there's
                              // no need to look up a seller-id field from the report at
                              // all; every row THIS cron ever produces is, by definition,
                              // from the same known account. Exists to distinguish these
                              // rows from Cosmette's manually-added historical rows (a
                              // different, pre-partnership selling account) sitting in the
                              // same sheet — those keep whatever value Jaclyn sets for them
                              // herself, preserved here the same way Amazon Estimated
                              // Fees / Sale Promotions already are, never overwritten.
];

// ADDED 2026-08-13 — backstop signal for the skinuva/skinuva-ca channel
// split below, alongside the report's own sales-channel field. Confirmed
// via migrate-skinuva-ca.js's cleanup run that a "-CA"/"-CA-SF"/".1-CA"
// SKU suffix reliably marks Amazon.ca orders, including historical rows
// written before sales-channel existed on this sheet at all. Same pattern
// as that migration script, kept identical for consistency.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

// ADDED 2026-08-12 per Jaclyn — IMPORTANT, READ BEFORE DEPLOYING: ensureTab()
// only writes a header row into a genuinely BLANK tab; it never corrects an
// existing one (confirmed real-incident behavior, same root cause already
// hit twice on this codebase — ppc_strategy and Stewardship Summary both
// silently drifted this exact way). Every one of these ~15 brand tabs
// already has a live 17-column header (A-Q) — adding marketplace/channel
// to this array alone does NOT make columns R/S exist on the sheet. Before
// this runs for real, manually add "marketplace" to R1 and "channel" to S1
// on EVERY active brand's tab in this sheet, or every field from
// `marketplace` onward will silently land in the wrong column the same way
// headline/bullets did on ppc_strategy.

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
  // ADDED 2026-08-12 per Jaclyn — marketplace/channel field names below
  // (sales-channel, fulfillment-channel) are Amazon's documented flat-file
  // column names for this report type, NOT yet independently confirmed
  // against a real response from this specific report. Logs the actual
  // header list every run so a mismatch is a 5-second console check
  // instead of another silent-drop incident, same practice already
  // established elsewhere in this codebase.
  const salesChannelFieldPresent = rows.length > 0 && headers.includes('sales-channel');
  if (rows.length) {
    console.log('[sync-orders-process][qa] real TSV header list:', headers.join(' | '));
    if (!headers.includes('sales-channel')) console.warn('[sync-orders-process][qa] "sales-channel" not found in this report — marketplace column will be blank for every row this run.');
    if (!headers.includes('fulfillment-channel')) console.warn('[sync-orders-process][qa] "fulfillment-channel" not found in this report — channel column will be blank for every row this run.');
  }

  // ── 5. Per-brand overwrite ───────────────────────────────────────────────
  const nowEst  = toEstIso(new Date());
  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      // Brand is determined by SKU prefix — never by Amazon's brand field.
      // We intentionally do NOT filter out cancelled/pending orders here —
      // catching those transitions is the whole point of this rewrite.
      //
      // ADDED 2026-08-13 per Jaclyn — skinuva sells on both Amazon.com and
      // Amazon.ca under one seller account; skinuva-ca (config/brands.js)
      // shares skinuva's exact SKU prefix on purpose (same physical
      // products, different storefront), so SKU prefix alone can't tell
      // them apart. Brands with an explicit `salesChannel` field also
      // require the flat file's own `sales-channel` column to match —
      // every other brand has no salesChannel field, so this check is
      // always skipped for them, zero behavior change.
      //
      // FALLBACK: if `sales-channel` is ever absent from a report entirely
      // (flagged above as not independently confirmed for this report
      // type), a brand requiring 'Amazon.ca' can never match anything that
      // run — the .ca tab would just silently get 0 rows, easy to miss.
      // Rather than let that happen quietly, or double-count by matching
      // BOTH siblings, the 'Amazon.com' sibling falls back to SKU-prefix-
      // only matching (pre-split behavior) and the '.ca' sibling gets
      // nothing, loudly logged — preserves the higher-volume US data
      // rather than losing everything for that shared prefix.
      const brandRows = rows.filter(row => {
        const sku   = (row['sku'] || row['seller-sku'] || '').toUpperCase();
        const promo = (row['promotion-ids'] || '').toLowerCase();
        if (!sku.startsWith(brand.skuPrefix.toUpperCase()) || promo.includes('vine')) return false;

        if (brand.salesChannel) {
          // SKU-suffix backstop takes priority over the report's own
          // sales-channel field — see CA_SKU_PATTERN comment above. Does
          // NOT replace the sales-channel check below it: some Amazon.ca
          // orders may still use a plain, non-suffixed SKU (e.g.
          // cross-border fulfillment from the same US inventory pool),
          // so a SKU that doesn't match this pattern still falls through
          // to the channel-field check rather than being assumed US.
          if (CA_SKU_PATTERN.test(sku)) {
            return brand.salesChannel.toLowerCase() === 'amazon.ca';
          }
          if (!salesChannelFieldPresent) {
            return brand.salesChannel.toLowerCase() === 'amazon.com';
          }
          const channel = (row['sales-channel'] || '').trim().toLowerCase();
          if (channel !== brand.salesChannel.toLowerCase()) return false;
        }
        return true;
      });

      if (brand.salesChannel && !salesChannelFieldPresent) {
        console.warn(`[sync-orders-process] ${brand.id} — "sales-channel" missing from this report; shared-prefix channel split could not run this pass (see salesChannel fallback above).`);
      }

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

      let newCount = 0, overwrittenCount = 0, skippedNonStandardCount = 0;

      // FIXED 2026-08-27 per Jaclyn — confirmed via direct investigation
      // (clicking through an order_id landed on a Removal Order page) and
      // independently confirmed on an Amazon seller forum: order IDs with
      // a non-numeric prefix like "S01-" are NOT real customer orders —
      // they're removal/liquidation or MCF-related records that Amazon's
      // own orders report includes alongside genuine sales. These showed
      // $0 item_price/order_total but a real quantity_ordered (1), which
      // silently inflates unit-sold counts everywhere a dashboard sums
      // quantity_ordered/unit_count without also checking for a real
      // price — revenue itself was unaffected (price is $0), but units
      // weren't. Standard Amazon retail order IDs always follow
      // XXX-XXXXXXX-XXXXXXX (3 digits, 7 digits, 7 digits, all numeric) —
      // anything that doesn't match this shape is skipped here, before it
      // ever reaches the sheet, rather than filtered downstream on every
      // dashboard that reads this data.
      const STANDARD_ORDER_ID_PATTERN = /^\d{3}-\d{7}-\d{7}$/;

      for (const row of brandRows) {
        const orderId = row['amazon-order-id'] || row['order-id'] || '';
        if (!orderId) continue;
        if (!STANDARD_ORDER_ID_PATTERN.test(orderId)) {
          skippedNonStandardCount++;
          continue;
        }

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
        // ADDED 2026-08-12 per Jaclyn — see the [qa] warning above if either
        // of these real column names turns out wrong for this report.
        const marketplace = row['sales-channel'] || '';
        const channel      = row['fulfillment-channel'] || '';

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
          preservedFee,   // column P, Amazon Estimated Fees — untouched by this job
          preservedPromo, // column Q, Amazon Sale Promotions — untouched by this job
          marketplace,    // column R — NEW 2026-08-12
          channel,        // column S — NEW 2026-08-12
          'Newderm',      // column T, selling_account — NEW 2026-08-21. Hardcoded, not
                          // read from the report — the SP-API credentials themselves are
                          // scoped to this one account, so every row this cron produces
                          // is always Newderm by definition.
        ];

        if (existing) {
          workingRows[existing.idx] = newRow;
          overwrittenCount++;
        } else {
          workingRows.push(newRow);
          newCount++;
        }
      }

      const dateIdx = HEADERS.indexOf('date');
      workingRows.forEach(row => { row[dateIdx] = normalizeDate(row[dateIdx]); });
      const cleanedRows = collapseDuplicates(workingRows, HEADERS, brand.id);

      await replaceRows(sheets.orders, brand.tabName, HEADERS, cleanedRows, token);
      console.log(`[sync-orders-process] ${brand.id} — new=${newCount} overwritten=${overwrittenCount} skippedNonStandardOrderId=${skippedNonStandardCount}`);
      results.push({ brand: brand.id, status: 'ok', new: newCount, overwritten: overwrittenCount, skippedNonStandardOrderId: skippedNonStandardCount });
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

// ADDED 2026-08-13 — the 120-day retention bump surfaced rows whose `date`
// value isn't the clean 10-char YYYY-MM-DD this cron has always written
// (e.g. "2026-05-14 0:00:00", 19 chars) — something this code's own
// `.slice(0, 10)` mathematically cannot produce, so these predate the
// current logic. Re-normalizing on every write this cron touches means the
// column self-heals over time instead of needing a separate one-time fix
// for legacy rows specifically. Idempotent on already-clean values.
function normalizeDate(v) {
  const s = String(v ?? '');
  return s.slice(0, 10);
}

// ADDED 2026-08-13 — confirmed duplicate (order_id, sku) rows in production
// (dearcloud: 645 pairs / 648 extra rows; creme-shop: 108 pairs; smaller
// counts elsewhere). Some pairs shared an identical last_updated (a single
// run wrote the row twice); others had DIFFERENT last_updated timestamps
// (e.g. one from 2026-07-09, one from today's manual backfill) — meaning
// existingByKey's lookup didn't find the earlier row on that pass and
// appended instead of overwriting. Root cause not conclusively identified
// (no run-level timing data to prove it), so rather than patch one theory,
// this collapses to one row per (order_id, sku) — keeping the one with the
// LATEST last_updated — on every single write this cron makes, regardless
// of how a duplicate got in. Structural safety net, not a one-time fix.
// Rows with a blank order_id or sku are left untouched (never collapsed
// together) — same exclusion existingByKey already uses elsewhere in this
// file, since a blank composite key isn't a meaningful identity to dedupe on.
function collapseDuplicates(rows, headers, label) {
  const oidIdx = headers.indexOf('order_id');
  const skuIdx = headers.indexOf('sku');
  const luIdx  = headers.indexOf('last_updated');

  const winners = new Map(); // key -> row
  const untouched = [];

  for (const row of rows) {
    const oid = row[oidIdx];
    const sku = row[skuIdx];
    if (!oid || !sku) { untouched.push(row); continue; }

    const key = `${oid}||${sku}`;
    const existing = winners.get(key);
    if (!existing || String(row[luIdx] || '') > String(existing[luIdx] || '')) {
      winners.set(key, row);
    }
  }

  const result = [...untouched, ...winners.values()];
  const removed = rows.length - result.length;
  if (removed > 0) {
    console.warn(`[sync-orders-process] ${label} — collapsed ${removed} duplicate (order_id, sku) row(s) before write`);
  }
  return result;
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
