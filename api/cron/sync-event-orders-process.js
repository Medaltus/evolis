/**
 * api/cron/sync-event-orders-process.js
 * Step 2 of 2 — reads the reportIds stored by sync-event-orders-request.js,
 * polls each until DONE, downloads, and writes ALL brands' order rows
 * (combined, not split) into that event's tab in the ORDERS sheet.
 *
 * Unlike sync-orders-process.js, this is a full REPLACE per tab, not an
 * upsert — each event tab represents one fixed historical date range, so
 * every run is a clean snapshot of "what does Amazon say happened during
 * this event," not a rolling accumulation. brand is derived per-row via
 * SKU prefix (same brands config every other cron uses) so rows from
 * different brands can be told apart even though they share one tab.
 *
 * Runs ~15 min after sync-event-orders-request.js. Safe to re-run — it
 * re-reads the same reportIds from `_meta_events` rather than requesting
 * new ones, and each processed tab is marked so a re-run skips work
 * that's already done (pass ?force=true to reprocess anyway).
 *
 * Manual:
 *   GET /api/cron/sync-event-orders-process
 *   GET /api/cron/sync-event-orders-process?force=true
 *   Authorization: Bearer <CRON_SECRET>
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

const META_TAB     = '_meta_events';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

const REPORT_POLL_TIMEOUT_MS  = 60_000;
const REPORT_POLL_INTERVAL_MS = 4_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const force = req.query.force === 'true';
  const nowEst = toEstIso(new Date());

  // ── 1. Read _meta_events ────────────────────────────────────────────────
  let metaMap;
  try {
    const rawMeta = await readRows(sheets.orders, META_TAB);
    metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
  } catch (err) {
    console.error('[sync-event-orders-process] failed to read _meta_events:', err.message);
    return res.status(500).json({ error: 'Failed to read _meta_events', detail: err.message });
  }

  const targetTabs = (metaMap['target_tabs'] || '').split(',').filter(Boolean);
  if (!targetTabs.length) {
    return res.status(400).json({ error: 'No target_tabs in _meta_events — did sync-event-orders-request run?' });
  }

  const results = [];

  for (const tabName of targetTabs) {
    const reportId = metaMap[`report_id_${tabName}`];
    if (!reportId) { results.push({ tab: tabName, status: 'skipped', reason: 'no reportId' }); continue; }

    if (metaMap[`processed_${tabName}`] === 'true' && !force) {
      results.push({ tab: tabName, status: 'already_processed' });
      continue;
    }

    // ── Poll until DONE ────────────────────────────────────────────────
    let documentId = null;
    const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(REPORT_POLL_INTERVAL_MS);
      try {
        const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
        console.log(`[sync-event-orders-process] ${tabName} report ${reportId} status: ${statusResp.processingStatus}`);
        if (statusResp.processingStatus === 'DONE') { documentId = statusResp.reportDocumentId; break; }
        if (statusResp.processingStatus === 'FATAL' || statusResp.processingStatus === 'CANCELLED') {
          results.push({ tab: tabName, status: 'error', error: `report ${statusResp.processingStatus}` });
          documentId = 'ABORT';
          break;
        }
      } catch (err) {
        console.warn(`[sync-event-orders-process] ${tabName} poll error (will retry): ${err.message}`);
      }
    }
    if (documentId === 'ABORT') continue;
    if (!documentId) { results.push({ tab: tabName, status: 'pending', reason: 'not ready within timeout' }); continue; }

    // ── Download & decompress ─────────────────────────────────────────
    let rows;
    try {
      const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
      const fileResp = await fetch(docResp.url);
      if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);
      const buffer = Buffer.from(await fileResp.arrayBuffer());
      const rawTsv = await new Promise(resolve => {
        zlib.gunzip(buffer, (err, result) => resolve(err ? buffer.toString('utf8') : result.toString('utf8')));
      });
      const lines   = rawTsv.split('\n').filter(l => l.trim());
      const tsvHeaders = lines[0].split('\t').map(h => h.trim());
      rows = lines.slice(1).map(line => {
        const vals = line.split('\t');
        return Object.fromEntries(tsvHeaders.map((h, i) => [h, (vals[i] || '').trim()]));
      });
      console.log(`[sync-event-orders-process] ${tabName} — ${rows.length} raw rows`);
    } catch (err) {
      console.error(`[sync-event-orders-process] ${tabName} failed to download:`, err.message);
      results.push({ tab: tabName, status: 'error', error: err.message });
      continue;
    }

    // ── Tag each row with its brand (SKU prefix), exclude Vine ─────────
    const activeBrands = brands.filter(b => b.active);
    const outRows = [];
    for (const row of rows) {
      const sku   = (row['sku'] || row['seller-sku'] || '').toUpperCase();
      const promo = (row['promotion-ids'] || '').toLowerCase();
      if (promo.includes('vine')) continue;

      const matchedBrand = activeBrands.find(b => sku.startsWith(b.skuPrefix.toUpperCase()));
      const orderId = row['amazon-order-id'] || row['order-id'] || '';
      if (!orderId) continue;

      outRows.push([
        orderId,
        (row['purchase-date'] || '').slice(0, 10),
        row['order-status'] || '',
        round2(parseFloat(row['item-price'] || '0')),
        row['promotion-ids'] || '',
        'FALSE',
        round2(parseFloat(row['item-promotion-discount'] || row['promotion-discount'] || '0')),
        round2(parseFloat(row['item-price'] || '0')),
        parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10),
        parseInt(row['quantity-shipped'] || '0', 10),
        parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10),
        row['sku'] || row['seller-sku'] || '',
        row['asin'] || '',
        matchedBrand ? matchedBrand.id : 'unknown',
        nowEst,
      ]);
    }

    try {
      const token = await ensureTab(sheets.orders, tabName, HEADERS);
      await replaceRows(sheets.orders, tabName, HEADERS, outRows, token);
      console.log(`[sync-event-orders-process] ${tabName} — wrote ${outRows.length} rows (full replace)`);
      results.push({ tab: tabName, status: 'ok', rows: outRows.length });

      metaMap[`processed_${tabName}`] = 'true';
    } catch (err) {
      console.error(`[sync-event-orders-process] ${tabName} failed to write:`, err.message);
      results.push({ tab: tabName, status: 'error', error: err.message });
    }
  }

  // ── Persist processed flags ────────────────────────────────────────────
  try {
    const token = await ensureTab(sheets.orders, META_TAB, META_HEADERS);
    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, nowEst]);
    await replaceRows(sheets.orders, META_TAB, META_HEADERS, metaRows, token);
  } catch (err) {
    console.warn('[sync-event-orders-process] failed to update _meta_events:', err.message);
  }

  res.status(200).json({ synced: results, timestamp: nowEst });
};

// ── Helpers ───────────────────────────────────────────────────────────────
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
