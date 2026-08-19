/**
 * api/cron/sync-fbm-returns-process.js
 * Step 2 of 2 — reads the fbm_report_id stored by
 * sync-fbm-returns-request.js, polls until DONE, downloads and parses
 * the XML, and UPSERTS into the SAME per-brand tabs in SHEET_RETURNS
 * that sync-returns-process.js (the FBA returns cron) already writes to
 * — never a separate set of tabs. See that file's own recent comments
 * for the full evidence trail confirming this report is genuinely
 * FBM-only, not overlapping with the FBA one.
 *
 * XML PARSING: this is the first report in this whole codebase that's
 * genuinely XML rather than TSV/flat-file or JSON. The structure is
 * flat enough (a repeating <return_details> block, one level of nesting
 * for <item_details>, no tag-name collisions between the two levels —
 * confirmed against real downloaded data 2026-08-18) that a careful
 * regex-based extraction is used here rather than adding a new XML
 * parsing dependency to the project. Free-text fields (item_name) are
 * XML-entity-unescaped, since Amazon escapes special characters (&amp;,
 * &lt;, etc.) in the raw document.
 *
 * NO CHANNEL FIELD FOR CA DISAMBIGUATION: unlike the FBA orders/revenue/
 * returns pipelines, this report has no sales-channel-equivalent field
 * at all (confirmed against the real schema) — skinuva-ca disambiguation
 * here relies solely on the SKU's own "-CA" suffix pattern, with the
 * same Amazon.com-default fallback used everywhere else when a SKU
 * can't be disambiguated any other way.
 *
 * UPSERT KEY: amazon_rma_id — Amazon's own per-return transaction ID,
 * confirmed present on every real sample record. NOT order_id+sku,
 * since real data already showed the SAME order_id+sku appearing twice
 * with different refund_amount/dates (the same return progressing
 * through Amazon's process, not two separate returns) — order_id alone
 * is not a safe key here the way it needed extra disambiguators for the
 * FBA report too.
 *
 * MERGING WITH EXISTING FBA ROWS: each brand's tab may already contain
 * FBA rows written by sync-returns-process.js. This reads the tab's
 * EXISTING rows first and merges FBM rows in by key — it never blindly
 * replaces the whole tab, which would wipe out the sibling cron's data.
 *
 * REAL REFUND AMOUNTS: this report has a genuine refund_amount field,
 * unlike the FBA report (which has none at all — a known, documented
 * limitation). This cron only gets that data into the sheet; using it
 * to replace the ESTIMATED-price return netting in
 * sync-revenue-process.js is a separate, future task ("step 3"), not
 * done here.
 *
 * Runs ~20 min after sync-fbm-returns-request.js.
 *
 * Manual:
 *   GET /api/cron/sync-fbm-returns-process
 *   Authorization: Bearer <CRON_SECRET>
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                                = require('../config/sheets');
const brands                                = require('../config/brands');
const { sendCronFailureAlert }              = require('../_alerts');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// Same 20-column shape as sync-returns-process.js — both crons write to
// the exact same tabs, so the header shape must match exactly.
const HEADERS = [
  'return_date', 'order_id', 'sku', 'asin', 'fnsku', 'product_name',
  'quantity', 'fulfillment_center_id', 'detailed_disposition', 'reason',
  'status', 'license_plate_number', 'customer_comments', 'brand', 'last_updated',
  'order_date',
  'fulfillment_channel', 'refund_amount', 'amazon_rma_id', 'resolution',
];

const REPORT_POLL_TIMEOUT_MS  = 60_000;
const REPORT_POLL_INTERVAL_MS = 4_000;

// Same two-stage disambiguation helper used across every other file in
// this project for the skinuva/skinuva-ca shared-prefix situation — see
// file header for why there's no channel-field fallback available here.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

function matchBrandForSku(sku) {
  const candidates = brands.filter(b => b.active && sku.toUpperCase().startsWith(b.skuPrefix.toUpperCase()));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const isCa = CA_SKU_PATTERN.test(sku);
  if (isCa) {
    const caBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.ca');
    if (caBrand) return caBrand;
  }
  return candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.com') || candidates[0];
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nowEst = toEstIso(new Date());

  // ── 1. Read fbm_report_id from _meta ────────────────────────────────────
  let metaMap;
  try {
    const rawMeta = await readRows(sheets.returns, META_TAB);
    metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
  } catch (err) {
    await sendCronFailureAlert('sync-fbm-returns-process', err.message, { Stage: 'reading _meta' });
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  const reportId = metaMap['fbm_report_id'];
  if (!reportId) {
    return res.status(400).json({ error: 'No fbm_report_id in _meta — did sync-fbm-returns-request run?' });
  }

  // ── 2. Poll until DONE ───────────────────────────────────────────────────
  let documentId = null;
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    try {
      const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      console.log(`[sync-fbm-returns-process] report ${reportId} status: ${statusResp.processingStatus}`);
      if (statusResp.processingStatus === 'DONE') { documentId = statusResp.reportDocumentId; break; }
      if (statusResp.processingStatus === 'FATAL' || statusResp.processingStatus === 'CANCELLED') {
        await sendCronFailureAlert('sync-fbm-returns-process', `report ${statusResp.processingStatus}`, { ReportId: reportId });
        return res.status(500).json({ error: `Report ${statusResp.processingStatus}`, reportId });
      }
    } catch (err) {
      console.warn(`[sync-fbm-returns-process] poll error (will retry): ${err.message}`);
    }
  }
  if (!documentId) {
    return res.status(200).json({ status: 'pending', reason: 'not ready within timeout, try again shortly' });
  }

  // ── 3. Download the XML ──────────────────────────────────────────────────
  let xmlText;
  try {
    const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    xmlText = await downloadText(docResp.url, docResp.compressionAlgorithm);
  } catch (err) {
    await sendCronFailureAlert('sync-fbm-returns-process', err.message, { Stage: 'downloading report document' });
    return res.status(500).json({ error: 'Failed to download report', detail: err.message });
  }

  // ── 4. Parse — regex-based, see file header for why ─────────────────────
  const returnBlocks = xmlText.match(/<return_details>[\s\S]*?<\/return_details>/g) || [];
  console.log(`[sync-fbm-returns-process] ${returnBlocks.length} return record(s) in report`);

  const parsed = returnBlocks.map(block => ({
    return_date:      extractTag(block, 'return_request_date'),
    order_id:         extractTag(block, 'order_id'),
    sku:              extractTag(block, 'merchant_sku'),
    asin:             extractTag(block, 'asin'),
    product_name:     unescapeXml(extractTag(block, 'item_name')),
    quantity:         parseInt(extractTag(block, 'return_quantity'), 10) || 0,
    reason:           extractTag(block, 'return_reason_code'),
    status:           extractTag(block, 'return_request_status'),
    order_date:       extractTag(block, 'order_date'),
    refund_amount:    extractTag(block, 'refund_amount'),
    amazon_rma_id:    extractTag(block, 'amazon_rma_id'),
    resolution:       extractTag(block, 'resolution'),
  })).filter(r => r.order_id && r.sku);

  // ── 5. Attribute brand, group by brand ──────────────────────────────────
  const rowsByBrand = {};
  const unmatchedSkus = new Set();
  parsed.forEach(r => {
    const matched = matchBrandForSku(r.sku);
    if (!matched) { unmatchedSkus.add(r.sku); return; }
    (rowsByBrand[matched.tabName] = rowsByBrand[matched.tabName] || []).push({ ...r, brand: matched.id });
  });

  if (unmatchedSkus.size) {
    console.log(`[sync-fbm-returns-process] ${unmatchedSkus.size} unmatched SKU(s) — likely brands not tracked in config/brands.js: ${[...unmatchedSkus].slice(0, 20).join(', ')}`);
  }

  // ── 6. Per-brand upsert by amazon_rma_id, merging with existing rows ────
  const results = [];
  for (const [tabName, fbmRows] of Object.entries(rowsByBrand)) {
    try {
      const token = await ensureTab(sheets.returns, tabName, HEADERS);
      const existingRaw = await readRows(sheets.returns, tabName);
      const existingRowsObj = (existingRaw || []).map(normalizeRow);

      // Key by amazon_rma_id when present (should be, on every real
      // record) — falls back to order_id+sku+return_date only for the
      // rare case Amazon ever omits it, matching the same
      // never-trust-a-single-field-as-universally-present caution used
      // elsewhere in this project.
      const keyOf = r => r.amazon_rma_id || `${r.order_id}||${r.sku}||${r.return_date}`;

      const merged = new Map();
      existingRowsObj.forEach(r => merged.set(keyOf(r), r));

      let added = 0, updated = 0;
      fbmRows.forEach(r => {
        const key = keyOf(r);
        const candidate = {
          return_date:            r.return_date,
          order_id:                r.order_id,
          sku:                     r.sku,
          asin:                    r.asin,
          fnsku:                   '', // FBA-only concept, not present in this report
          product_name:            r.product_name,
          quantity:                r.quantity,
          fulfillment_center_id:   '', // no Amazon fulfillment center involved in an FBM return
          detailed_disposition:    '', // Amazon never physically inspects an FBM return — no equivalent concept
          reason:                  r.reason,
          status:                  r.status,
          license_plate_number:    '', // FBA-specific inbound-warehouse concept
          customer_comments:       '', // not present in this report
          brand:                   r.brand,
          last_updated:            nowEst,
          order_date:              r.order_date,
          fulfillment_channel:     'FBM',
          refund_amount:           r.refund_amount,
          amazon_rma_id:           r.amazon_rma_id,
          resolution:              r.resolution,
        };
        if (merged.has(key)) updated++; else added++;
        merged.set(key, candidate);
      });

      const outRows = Array.from(merged.values()).map(r => HEADERS.map(h => r[h] ?? ''));
      // Same defensive protection as sync-returns-process.js, applied
      // consistently since both crons write to these same columns.
      const TEXT_PROTECTED_COLS = new Set(['fnsku', 'license_plate_number', 'amazon_rma_id']);
      const protectedRows = outRows.map((row, rowIdx) => row.map((v, i) => {
        const h = HEADERS[i];
        return (TEXT_PROTECTED_COLS.has(h) && v !== '') ? `'${v}` : v;
      }));
      await replaceRows(sheets.returns, tabName, HEADERS, protectedRows, token, 'USER_ENTERED');

      console.log(`[sync-fbm-returns-process] ${tabName} — ${added} new, ${updated} refreshed, ${outRows.length} total rows (FBA + FBM combined)`);
      results.push({ brand: tabName, status: 'ok', added, updated, totalRows: outRows.length });
    } catch (err) {
      console.error(`[sync-fbm-returns-process] ${tabName} failed:`, err.message);
      results.push({ brand: tabName, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-fbm-returns-process',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  // Mark processed in _meta so a re-run doesn't re-fetch the same
  // reportId's status forever if this is ever manually re-triggered.
  try {
    const token = await ensureTab(sheets.returns, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.returns, META_TAB);
    const mm = {};
    (rawMeta || []).forEach(r => { if (r.KEY) mm[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    mm['fbm_report_status'] = ['fbm_report_status', 'PROCESSED', nowEst];
    await replaceRows(sheets.returns, META_TAB, META_HEADERS, Object.values(mm), token);
  } catch (err) {
    console.warn('[sync-fbm-returns-process] failed to update _meta:', err.message);
  }

  res.status(200).json({
    synced: results,
    totalReturnRecordsInReport: returnBlocks.length,
    unmatchedSkuCount: unmatchedSkus.size,
    timestamp: nowEst,
  });
};

// ── Helpers ───────────────────────────────────────────────────────────────

function normalizeRow(r) {
  if (Array.isArray(r)) {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  }
  return r;
}

// Simple single-level tag extraction — safe here because the confirmed
// real schema has no tag-name collisions between item_details and its
// parent return_details block (verified against real downloaded data
// 2026-08-18, not assumed).
function extractTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>(.*?)<\\/${tagName}>`, 's'));
  return match ? match[1].trim() : '';
}

// Amazon escapes special characters in free-text XML fields (item names
// with an ampersand, etc.) — unescape before writing to the sheet so
// "Bath &amp; Body" reads as "Bath & Body", not literally with &amp;.
function unescapeXml(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // must be last, so an already-decoded & isn't re-processed
}

function downloadText(url, compressionAlgorithm) {
  return new Promise((resolve, reject) => {
    require('https').get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (compressionAlgorithm === 'GZIP') {
          require('zlib').gunzip(buf, (err, decoded) => {
            if (err) return reject(err);
            resolve(decoded.toString('utf8'));
          });
        } else {
          resolve(buf.toString('utf8'));
        }
      });
    }).on('error', reject);
  });
}

function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
