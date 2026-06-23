/**
 * api/cron/sync-orders.js
 * Runs every 2 hours — pulls orders from the flat file report for ALL brands.
 * Uses GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL (GZIP TSV).
 * Writes to the rolling current-month sheet (amazon-orders).
 * Deduplicates on order_id + sku before writing — safe to re-run.
 *
 * Why flat file instead of Orders API:
 *   The Orders API only returns FBA orders reliably. The flat file report
 *   covers FBA + FBM and is Amazon's source of truth for reconciliation.
 *
 * Row granularity — ONE ROW PER LINE ITEM:
 *   The flat file already has one row per line item (one SKU per row).
 *   We now write that directly to the sheet instead of aggregating by order_id.
 *   This allows the dashboard to compute accurate per-SKU unit counts without
 *   needing to split quantities across SKUs on multi-item orders.
 *   The dedup key is order_id + sku (composite) to handle re-runs safely.
 *
 * Modes (via ?mode=):
 *   rolling   — last 2.5 hours (default, used by cron)
 *   day       — today from midnight UTC to now-10min
 *   yesterday — full yesterday
 *   week      — explicit ?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Sheet: amazon-orders  |  One tab per brand, auto-created on first run.
 */

const zlib                                                       = require('zlib');
const { spRequest }                                              = require('../_spauth');
const { ensureTab, appendRows, readRows }                        = require('../config/_sheets_client');
const brands                                                     = require('../config/brands');
const sheets                                                     = require('../config/sheets');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'brand', 'last_updated',
];

// How long to poll for a report to be ready (ms)
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
      reportType:      'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds:  [process.env.SP_MARKETPLACE_ID],
      dataStartTime:   start,
      dataEndTime:     end,
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

  // ── 3. Download the report document ───────────────────────────────────────
  let rawTsv;
  try {
    const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    const url     = docResp.url;

    const fileResp = await fetch(url);
    if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());

    // Try GZIP first, fall back to plain text
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
  const now     = new Date().toISOString();
  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      // Filter rows for this brand
      const brandRows = rows.filter(row => {
        const sku    = (row['sku'] || row['seller-sku'] || '').toUpperCase();
        const status = (row['order-status'] || '').toLowerCase();
        const promo  = (row['promotion-ids'] || '').toLowerCase();

        const isThisBrand   = sku.startsWith(brand.skuPrefix.toUpperCase());
        const isValidStatus = status !== 'cancelled' && status !== 'pending';
        const isNotVine     = !promo.includes('vine');

        return isThisBrand && isValidStatus && isNotVine;
      });

      if (brandRows.length === 0) {
        console.log(`[sync-orders] ${brand.id} — 0 rows after filtering`);
        results.push({ brand: brand.id, status: 'ok', rows: 0, mode });
        continue;
      }

      // Build one sheet row per flat-file line item (no aggregation).
      // Each flat-file row is already one SKU + its quantity on that order.
      const newRows = brandRows.map(row => {
        const orderId  = row['amazon-order-id'] || row['order-id'] || '';
        const sku      = row['sku'] || row['seller-sku'] || '';
        const qty      = parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10);
        const qtyShip  = parseInt(row['quantity-shipped'] || '0', 10);
        const price    = parseFloat(row['item-price'] || '0');
        const disc     = parseFloat(row['item-promotion-discount'] || row['promotion-discount'] || '0');

        return [
          orderId,
          (row['purchase-date'] || '').slice(0, 10),
          row['order-status'] || '',
          round2(price),                   // order_total = item_price for this line
          row['promotion-ids'] || '',
          'FALSE',                          // is_premium_order (not in flat file)
          round2(disc),                     // promotion_discount
          round2(price),                    // item_price
          qty,                              // quantity_ordered
          qtyShip,                          // quantity_shipped
          qty,                              // unit_count (same as qty for line items)
          sku,                              // single SKU — no more comma-joined sets
          brand.id,
          now,
        ];
      }).filter(row => row[0]);             // drop rows with no order_id

      // Dedup — composite key: order_id + sku
      // This correctly handles re-runs and rolling windows without duplicates.
      const token        = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.orders, brand.tabName);
      const existingKeys = new Set(
        existingRows
          .map(r => `${r.order_id}||${r.sku}`)
          .filter(k => k !== '||')
      );

      const dedupedRows = newRows.filter(row => !existingKeys.has(`${row[0]}||${row[11]}`));
      const dupCount    = newRows.length - dedupedRows.length;

      if (dupCount > 0) {
        console.log(`[sync-orders] ${brand.id} — skipped ${dupCount} duplicate order+sku rows`);
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
    timestamp: now,
  });
};

// ── Date range ────────────────────────────────────────────────────────────────

function getDateRange(mode, req) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
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
    const d = new Date(now); d.setDate(d.getDate() - 1);
    const y = d.getFullYear(), m = pad(d.getMonth() + 1), day = pad(d.getDate());
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

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
