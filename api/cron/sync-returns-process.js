/**
 * api/cron/sync-returns-process.js
 * Step 2 of 2 — reads the reportId stored by sync-returns-request.js, polls
 * until DONE, downloads it, and UPSERTS into each brand's tab (e.g. `evolis`)
 * in the DEDICATED returns spreadsheet (env var SHEET_RETURNS) — a separate
 * workbook from sync-orders, not a suffixed tab in that one.
 *
 * Amazon's flat file for this report is one row per return line item:
 *   return-date, order-id, sku, asin, fnsku, product-name, quantity,
 *   fulfillment-center-id, detailed-disposition, reason, status,
 *   license-plate-number, customer-comments
 *
 * Brand attribution is by SKU prefix (same as sync-orders-process.js) since
 * this report has no brand field at all.
 *
 * Upsert key: order_id + sku + license_plate_number (falls back to
 * order_id + sku + return_date if Amazon left the LPN blank, which happens
 * for some return types). A single order+SKU can legitimately have more
 * than one return event, so order_id+sku alone isn't unique enough.
 *
 * ORDER_DATE (column P, added 2026-08-04 per Jaclyn) — Amazon's returns
 * report has no order-date field at all (only return-date), so this is
 * resolved separately: order_id from each return row is looked up against
 * the sync-orders sheet (NOT Historical Cache) to find that order's
 * original date. sync-orders alone is sufficient because it retains a
 * 90-day window while Amazon caps how far back a return can be reported
 * at 60 days — any order recent enough to have a matching return is
 * guaranteed to still be in sync-orders' window. Resolved once per run;
 * if an order_id can't be found (e.g. a data gap), order_date is left
 * blank rather than guessed, and a PREVIOUSLY resolved value is never
 * overwritten with a blank on a later run where the lookup happens to
 * miss — see resolveOrderDate()/mergeOrderDate() below.
 *
 * REQUIRES a `returns` entry in config/sheets.js pointing at
 * process.env.SHEET_RETURNS, the same shape as the existing `orders` entry.
 * `sheets.orders` (used below for order_date resolution) is confirmed
 * correct — used successfully across sync-orders-process.js,
 * sync-revenue-process.js, fees-estimate.js, and others.
 */

const zlib = require('zlib');

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                                = require('../config/sheets');
const brands                                = require('../config/brands');
const { sendCronFailureAlert }              = require('../_alerts');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

const HEADERS = [
  'return_date', 'order_id', 'sku', 'asin', 'fnsku', 'product_name',
  'quantity', 'fulfillment_center_id', 'detailed_disposition', 'reason',
  'status', 'license_plate_number', 'customer_comments', 'brand', 'last_updated',
  'order_date', // column P — see file header for how/why this is resolved
];

const REPORT_POLL_TIMEOUT_MS  = 60_000;
const REPORT_POLL_INTERVAL_MS = 4_000;

// ADDED 2026-08-14 — same fix as sync-revenue-process.js: the per-brand
// loop below does multiple real Sheets reads per brand (returns tab,
// orders tab for order_date lookup, and — see channel disambiguation
// below — potentially a second orders tab for shared-prefix brands) with
// zero pacing between brands. Same root cause already found and fixed
// elsewhere (429 RESOURCE_EXHAUSTED on Sheets' per-minute read quota).
const BRAND_READ_STAGGER_MS = 3500;

// ADDED 2026-08-14 — skinuva-ca (config/brands.js) shares skinuva's exact
// SKU prefix on purpose (same physical products, sold through Amazon.ca
// instead of Amazon.com). SKU prefix alone can't tell a shared-prefix
// pair's returns apart, and this returns report has no documented
// marketplace/channel field at all to split on directly. Instead:
// cross-reference each return's order_id against sync-orders-process.js's
// ALREADY-SPLIT output — skinuva vs skinuva-ca are separate tabs on
// sheets.orders, so an order_id appearing in exactly one sibling's orders
// tab reliably tells us which storefront a return belongs to.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

// Builds an order_id → order_date lookup from this brand's tab on the
// sync-orders sheet. Only sync-orders is read (NOT Historical Cache) — see
// file header for why the 90-day/60-day window math makes that sufficient
// on its own. A brand with no orders tab yet, or a fetch failure, resolves
// to an empty map rather than throwing — every return row for that brand
// just gets a blank order_date for this run, same as any other "we don't
// know" case in this file, not a hard failure.
async function buildOrderDateMap(brand) {
  const map = {};
  try {
    const orderRows = await readRows(sheets.orders, brand.tabName);
    (orderRows || []).forEach(r => {
      const orderId = r['order_id'] || r['order-id'] || '';
      const date    = r['date'] || '';
      // First occurrence wins — a multi-line-item order has one row per
      // SKU, all sharing the same order date, so any one of them is fine.
      if (orderId && date && !map[orderId]) map[orderId] = date;
    });
  } catch (err) {
    console.warn(`[sync-returns-process] ${brand.id} — failed to read sync-orders for order_date lookup (leaving order_date blank this run):`, err.message);
  }
  return map;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── 1. Read reportId (+ range, for logging) from this sheet's own _meta ───
  let reportId, reportStart, reportEnd;
  try {
    const rawMeta = await readRows(sheets.returns, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
    reportId    = req.query.reportId || metaMap['report_id'];
    reportStart = metaMap['report_start'];
    reportEnd   = metaMap['report_end'];

    if (!reportId) {
      return res.status(400).json({ error: 'No reportId in _meta — did sync-returns-request run?' });
    }
  } catch (err) {
    console.error('[sync-returns-process] failed to read _meta:', err.message);
    await sendCronFailureAlert('sync-returns-process', err.message, { Stage: 'reading _meta tab' });
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  console.log(`[sync-returns-process] processing report ${reportId} (${reportStart} → ${reportEnd})`);

  // ── 2. Poll until DONE ───────────────────────────────────────────────────
  let documentId = null;
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    try {
      const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      const status     = statusResp.processingStatus;
      console.log(`[sync-returns-process] report ${reportId} status: ${status}`);

      if (status === 'DONE') {
        documentId = statusResp.reportDocumentId;
        break;
      }
      if (status === 'FATAL' || status === 'CANCELLED') {
        await sendCronFailureAlert('sync-returns-process', `Report ${status}`, { 'Report ID': reportId });
        return res.status(500).json({ error: `Report ${status}`, reportId });
      }
    } catch (err) {
      console.warn(`[sync-returns-process] poll error (will retry): ${err.message}`);
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
          console.log('[sync-returns-process] not gzipped, reading as plain text');
          resolve(buffer.toString('utf8'));
        } else {
          resolve(result.toString('utf8'));
        }
      });
    });
  } catch (err) {
    console.error('[sync-returns-process] failed to download/decompress report:', err.message);
    await sendCronFailureAlert('sync-returns-process', err.message, { Stage: 'downloading/decompressing report' });
    return res.status(500).json({ error: 'Failed to download report', detail: err.message });
  }

  // ── 4. Parse TSV ───────────────────────────────────────────────────────────
  const lines      = rawTsv.split('\n').filter(l => l.trim());
  const rawHeaders = lines.length ? lines[0].split('\t').map(h => h.trim()) : [];
  const rawRows    = lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(rawHeaders.map((h, i) => [h, (vals[i] || '').trim()]));
  });

  console.log(`[sync-returns-process] flat file rows: ${rawRows.length}`);

  // ── 5. Per-brand upsert ────────────────────────────────────────────────────
  const nowEst  = toEstIso(new Date());
  const results = [];

  // ADDED 2026-08-14 — for shared-prefix brands (skinuva/skinuva-ca),
  // fetch each sibling's orders tab ONCE up front, before the main loop,
  // since disambiguating skinuva's OWN returns requires knowing about
  // skinuva-ca's orders too (and vice versa). Reused below both for the
  // channel membership check AND as this brand's own order_date lookup —
  // no duplicate read of the same sheet for brands that need both.
  const channelBrands = brands.filter(b => b.active && b.salesChannel);
  const orderDateMapsByBrand = {};
  const channelOrderIdSets = {};
  for (const brand of channelBrands) {
    orderDateMapsByBrand[brand.id] = await buildOrderDateMap(brand);
    channelOrderIdSets[brand.id] = new Set(Object.keys(orderDateMapsByBrand[brand.id]));
  }

  let brandIndex = 0;

  for (const brand of brands.filter(b => b.active)) {
    if (brandIndex > 0) await sleep(BRAND_READ_STAGGER_MS);
    brandIndex++;

    try {
      const brandRows = rawRows.filter(row => {
        const sku = (row['sku'] || '').toUpperCase();
        if (!sku.startsWith(brand.skuPrefix.toUpperCase())) return false;

        if (brand.salesChannel) {
          const orderId  = row['order-id'] || '';
          const siblings = channelBrands.filter(b => b.skuPrefix === brand.skuPrefix);
          const inThisBrand  = channelOrderIdSets[brand.id]?.has(orderId);
          const inAnySibling = siblings.some(s => channelOrderIdSets[s.id]?.has(orderId));

          if (inThisBrand) return true;
          if (inAnySibling) return false; // belongs to a different sibling
          // order_id not found in ANY sibling's orders tab (aged past that
          // sheet's retention window, a genuine data gap, or the read
          // above failed) — default to the Amazon.com sibling rather
          // than silently dropping the return from both tabs.
          return brand.salesChannel.toLowerCase() === 'amazon.com';
        }
        return true;
      });

      if (brandRows.length === 0) {
        console.log(`[sync-returns-process] ${brand.id} — 0 return rows in window`);
        results.push({ brand: brand.id, status: 'ok', new: 0, updated: 0, unchanged: 0 });
        continue;
      }

      const tabName          = brand.tabName;
      const token            = await ensureTab(sheets.returns, tabName, HEADERS);
      const existingRowsRaw  = await readRows(sheets.returns, tabName);
      const existingRowsObj  = (existingRowsRaw || []).map(normalizeRow);
      // Reuse the pre-fetched map for shared-prefix brands (already read
      // above, before the main loop) rather than reading sheets.orders
      // for this brand a second time.
      const orderDateMap     = orderDateMapsByBrand[brand.id] || await buildOrderDateMap(brand);

      const existingByKey = new Map();
      existingRowsObj.forEach((r, idx) => {
        const key = returnKey(r);
        if (key) existingByKey.set(key, { row: r, idx });
      });

      const workingRows = existingRowsObj.map(r => HEADERS.map(h => r[h] ?? ''));

      let added = 0, updated = 0, unchanged = 0;

      brandRows.forEach(row => {
        const candidate = {
          return_date:            normalizeReturnDate(row['return-date']),
          order_id:               row['order-id'] || '',
          sku:                    row['sku'] || '',
          asin:                   row['asin'] || '',
          fnsku:                  row['fnsku'] || '',
          product_name:           row['product-name'] || '',
          quantity:                parseInt(row['quantity'], 10) || 0,
          fulfillment_center_id:  row['fulfillment-center-id'] || '',
          detailed_disposition:   row['detailed-disposition'] || '',
          reason:                 row['reason'] || '',
          status:                 row['status'] || '',
          license_plate_number:   row['license-plate-number'] || '',
          customer_comments:      row['customer-comments'] || '',
          brand:                  brand.id,
        };
        const key = returnKey(candidate);
        if (!key) return; // no order_id+sku at all — skip, can't dedupe safely

        const existing = existingByKey.get(key);

        // Resolve order_date fresh from this run's lookup; if that misses
        // (order rolled outside sync-orders' window, or the fetch failed
        // entirely for this brand), fall back to whatever was already
        // stored rather than overwriting a known date with a blank —
        // see file header.
        candidate.order_date = orderDateMap[candidate.order_id] || (existing ? (existing.row.order_date || '') : '');

        if (!existing) {
          workingRows.push(HEADERS.map(h => h === 'last_updated' ? nowEst : (candidate[h] ?? '')));
          existingByKey.set(key, { row: candidate, idx: workingRows.length - 1 });
          added++;
        } else if (returnRowChanged(existing.row, candidate)) {
          workingRows[existing.idx] = HEADERS.map(h => h === 'last_updated' ? nowEst : (candidate[h] ?? ''));
          updated++;
        } else {
          unchanged++;
        }
      });

      await replaceRows(sheets.returns, tabName, HEADERS, workingRows, token);
      console.log(`[sync-returns-process] ${brand.id} — new:${added} updated:${updated} unchanged:${unchanged}`);
      results.push({ brand: brand.id, status: 'ok', new: added, updated, unchanged });
    } catch (err) {
      console.error(`[sync-returns-process] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  // ── Mark processed in _meta ──────────────────────────────────────────────
  try {
    const token   = await ensureTab(sheets.returns, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.returns, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
    metaMap['report_status']     = 'PROCESSED';
    metaMap['last_processed_at'] = nowEst;
    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, nowEst]);
    await replaceRows(sheets.returns, META_TAB, META_HEADERS, metaRows, token);
  } catch (err) {
    console.warn('[sync-returns-process] failed to update _meta status:', err.message);
    await sendCronFailureAlert('sync-returns-process', err.message, { Stage: 'marking report processed in _meta' });
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-returns-process',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ synced: results, reportId, timestamp: nowEst });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeRow(r) {
  if (Array.isArray(r)) {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  }
  return r;
}

// Amazon returns MM/DD/YYYY for return-date on this report — normalize to
// YYYY-MM-DD so it lines up with the same normalizeDate() convention the
// dashboard's front-end already uses for order dates.
function normalizeReturnDate(val) {
  if (!val) return '';
  if (/^\d{4}-\d{2}/.test(val)) return val.slice(0, 10);
  const parts = val.split('/');
  if (parts.length === 3) {
    const m = parts[0].padStart(2, '0');
    const d = parts[1].padStart(2, '0');
    const y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
    return `${y}-${m}-${d}`;
  }
  return val;
}

// order_id + sku + license_plate_number, falling back to order_id + sku +
// return_date if the LPN is blank (happens for some non-FBA-relabeled returns).
function returnKey(r) {
  if (!r.order_id || !r.sku) return null;
  const disambiguator = r.license_plate_number || r.return_date || '';
  return `${r.order_id}||${r.sku}||${disambiguator}`;
}

// True if any substantive field differs from what's stored — a return can
// change status after the fact (e.g. disposition updates once QA'd), and
// order_date can go from blank to resolved if this run's sync-orders
// lookup succeeds where an earlier run's didn't.
function returnRowChanged(existingRowObj, candidate) {
  const exQty       = parseInt(existingRowObj.quantity || '0', 10);
  const exDispo     = (existingRowObj.detailed_disposition || '').trim();
  const exReason    = (existingRowObj.reason || '').trim();
  const exStatus    = (existingRowObj.status || '').trim();
  const exOrderDate = (existingRowObj.order_date || '').trim();

  return (
    exQty       !== candidate.quantity ||
    exDispo     !== candidate.detailed_disposition ||
    exReason    !== candidate.reason ||
    exStatus    !== candidate.status ||
    exOrderDate !== (candidate.order_date || '').trim()
  );
}

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

const sleep = ms => new Promise(r => setTimeout(r, ms));
