/**
 * api/cron/sync-revenue.js
 * Runs daily — pulls the prior full month's orders from the flat file report
 * for ALL active brands and writes/overwrites a single monthly summary row
 * per brand to the revenue history sheet.
 *
 * Why flat file: covers FBA + FBM, Amazon's source of truth for reconciliation.
 * Why prior month only: current month is incomplete; sync-orders handles rolling.
 *
 * Sheet: amazon-revenue  |  One tab per brand (matches brand.tabName).
 * Columns: MONTH | YEAR | REVENUE | ORDERS | UNITS SOLD | FBA UNITS | FBM UNITS
 *
 * Safe to re-run — overwrites the row for the target month if it already exists.
 *
 * Trigger manually for backfill:
 *   GET /api/cron/sync-revenue?month=YYYY-MM
 *   Authorization: Bearer <CRON_SECRET>
 */

const zlib       = require('zlib');
const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');

const HEADERS = ['MONTH', 'YEAR', 'REVENUE', 'ORDERS', 'UNITS SOLD', 'FBA UNITS', 'FBM UNITS'];

const REPORT_POLL_TIMEOUT_MS  = 25_000;
const REPORT_POLL_INTERVAL_MS = 3_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Determine target month ─────────────────────────────────────────────────
  // Default: prior full calendar month.
  // Override: ?month=YYYY-MM for backfill.
  let targetMonth; // "YYYY-MM"
  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    targetMonth = req.query.month;
  } else {
    const now = new Date();
    // Prior month
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    targetMonth = `${y}-${m}`;
  }

  const [tYear, tMonth] = targetMonth.split('-');
  const start = `${targetMonth}-01T00:00:00Z`;
  // Last day of the month
  const lastDay = new Date(parseInt(tYear), parseInt(tMonth), 0).getDate();
  const end     = `${targetMonth}-${String(lastDay).padStart(2, '0')}T23:59:59Z`;

  console.log(`[sync-revenue] target=${targetMonth} start=${start} end=${end}`);

  // ── 1. Request flat file report ────────────────────────────────────────────
  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime:  start,
      dataEndTime:    end,
    });
    reportId = createResp.reportId;
    console.log(`[sync-revenue] report requested: ${reportId}`);
  } catch (err) {
    console.error('[sync-revenue] failed to request report:', err.message);
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
      console.log(`[sync-revenue] report ${reportId} status: ${status}`);

      if (status === 'DONE') {
        documentId = statusResp.reportDocumentId;
        break;
      }
      if (status === 'FATAL' || status === 'CANCELLED') {
        return res.status(500).json({ error: `Report ${status}`, reportId });
      }
    } catch (err) {
      console.warn(`[sync-revenue] poll error (will retry): ${err.message}`);
    }
  }

  if (!documentId) {
    return res.status(202).json({
      message: 'Report not ready within timeout — will be picked up next run',
      reportId,
    });
  }

  // ── 3. Download & decompress ───────────────────────────────────────────────
  let rawTsv;
  try {
    const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    const fileResp = await fetch(docResp.url);
    if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    rawTsv = await new Promise((resolve) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) {
          console.log('[sync-revenue] not gzipped, reading as plain text');
          resolve(buffer.toString('utf8'));
        } else {
          resolve(result.toString('utf8'));
        }
      });
    });
  } catch (err) {
    console.error('[sync-revenue] failed to download/decompress:', err.message);
    return res.status(500).json({ error: 'Failed to download report', detail: err.message });
  }

  // ── 4. Parse TSV ───────────────────────────────────────────────────────────
  const lines   = rawTsv.split('\n').filter(l => l.trim());
  const headers = lines[0].split('\t').map(h => h.trim());
  const rows    = lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').trim()]));
  });

  console.log(`[sync-revenue] flat file rows: ${rows.length}`);

  // ── 5. Per-brand aggregation & sheet write ─────────────────────────────────
  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      // Filter to this brand, valid status, no vine
      const brandRows = rows.filter(row => {
        const sku    = (row['sku'] || row['seller-sku'] || '').toUpperCase();
        const status = (row['order-status'] || '').toLowerCase();
        const promo  = (row['promotion-ids'] || '').toLowerCase();

        return (
          sku.startsWith(brand.skuPrefix.toUpperCase()) &&
          status !== 'cancelled' &&
          status !== 'pending'   &&
          !promo.includes('vine')
        );
      });

      // Aggregate by order_id to avoid double-counting multi-line-item orders
      const orderMap = {};
      for (const row of brandRows) {
        const orderId = row['amazon-order-id'] || row['order-id'] || '';
        if (!orderId) continue;

        const qty     = parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10);
        const price   = parseFloat(row['item-price'] || '0');
        // AFN = Fulfilled by Amazon (FBA), MFN = Merchant Fulfilled (FBM)
        const channel = (row['fulfillment-channel'] || '').toUpperCase();
        const isFba   = channel === 'AFN';

        if (!orderMap[orderId]) {
          orderMap[orderId] = { revenue: 0, units: 0, fbaUnits: 0, fbmUnits: 0 };
        }

        orderMap[orderId].revenue  = round2(orderMap[orderId].revenue + price);
        orderMap[orderId].units   += qty;
        if (isFba) {
          orderMap[orderId].fbaUnits += qty;
        } else {
          orderMap[orderId].fbmUnits += qty;
        }
      }

      const orders    = Object.keys(orderMap).length;
      const revenue   = round2(Object.values(orderMap).reduce((s, o) => s + o.revenue, 0));
      const unitsSold = Object.values(orderMap).reduce((s, o) => s + o.units, 0);
      const fbaUnits  = Object.values(orderMap).reduce((s, o) => s + o.fbaUnits, 0);
      const fbmUnits  = Object.values(orderMap).reduce((s, o) => s + o.fbmUnits, 0);

      console.log(`[sync-revenue] ${brand.id} — orders=${orders} revenue=${revenue} units=${unitsSold} fba=${fbaUnits} fbm=${fbmUnits}`);

      // ── Write to sheet ───────────────────────────────────────────────────
      // Strategy: read existing rows, replace the row for targetMonth if it
      // exists, otherwise append. Then rewrite the full tab.
      await ensureTab(sheets.revenue, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.revenue, brand.tabName);

      const newRow = [
        parseInt(tMonth, 10), // MONTH  (numeric, e.g. 5)
        parseInt(tYear, 10),  // YEAR   (numeric, e.g. 2026)
        revenue,
        orders,
        unitsSold,
        fbaUnits,
        fbmUnits,
      ];

      // Match on MONTH + YEAR columns (indices 0 and 1)
      const idx = existingRows.findIndex(
        r => String(r['MONTH']) === String(parseInt(tMonth, 10)) &&
             String(r['YEAR'])  === String(parseInt(tYear, 10))
      );

      let updatedRows;
      if (idx >= 0) {
        // Overwrite existing row
        updatedRows = existingRows.map((r, i) => {
          if (i !== idx) return Object.values(r);
          return newRow;
        });
        console.log(`[sync-revenue] ${brand.id} — overwrote existing row for ${targetMonth}`);
      } else {
        // Append new row, keep sorted by YEAR then MONTH
        const allAsArrays = existingRows.map(r => [
          parseInt(r['MONTH'], 10),
          parseInt(r['YEAR'],  10),
          parseFloat(r['REVENUE']    || 0),
          parseInt(r['ORDERS']       || 0, 10),
          parseInt(r['UNITS SOLD']   || 0, 10),
          parseInt(r['FBA UNITS']    || 0, 10),
          parseInt(r['FBM UNITS']    || 0, 10),
        ]);
        allAsArrays.push(newRow);
        allAsArrays.sort((a, b) => a[1] !== b[1] ? a[1] - b[1] : a[0] - b[0]);
        updatedRows = allAsArrays;
        console.log(`[sync-revenue] ${brand.id} — appended new row for ${targetMonth}`);
      }

      await replaceRows(sheets.revenue, brand.tabName, updatedRows);
      results.push({ brand: brand.id, status: 'ok', month: targetMonth, orders, revenue });

    } catch (err) {
      console.error(`[sync-revenue] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, reportId, month: targetMonth });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
