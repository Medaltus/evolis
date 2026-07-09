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
 * REQUIRES a `returns` entry in config/sheets.js pointing at
 * process.env.SHEET_RETURNS, the same shape as the existing `orders` entry.
 */

const zlib = require('zlib');

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                                = require('../config/sheets');
const brands                                = require('../config/brands');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

const HEADERS = [
  'return_date', 'order_id', 'sku', 'asin', 'fnsku', 'product_name',
  'quantity', 'fulfillment_center_id', 'detailed_disposition', 'reason',
  'status', 'license_plate_number', 'customer_comments', 'brand', 'last_updated',
];

const REPORT_POLL_TIMEOUT_MS  = 60_000;
const REPORT_POLL_INTERVAL_MS = 4_000;

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

  for (const brand of brands.filter(b => b.active)) {
    try {
      const brandRows = rawRows.filter(row => {
        const sku = (row['sku'] || '').toUpperCase();
        return sku.startsWith(brand.skuPrefix.toUpperCase());
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
// change status after the fact (e.g. disposition updates once QA'd).
function returnRowChanged(existingRowObj, candidate) {
  const exQty    = parseInt(existingRowObj.quantity || '0', 10);
  const exDispo  = (existingRowObj.detailed_disposition || '').trim();
  const exReason = (existingRowObj.reason || '').trim();
  const exStatus = (existingRowObj.status || '').trim();

  return (
    exQty    !== candidate.quantity ||
    exDispo  !== candidate.detailed_disposition ||
    exReason !== candidate.reason ||
    exStatus !== candidate.status
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
