/**
 * api/cron/sync-revenue-process.js
 * Step 2 of 2 — reads the reportId stored by sync-revenue-request.js,
 * polls Amazon until DONE, downloads the flat file, aggregates revenue
 * per brand per month, and writes to the revenue history sheet.
 *
 * Runs at 5:15 UTC daily (15 min after sync-revenue-request).
 * Safe to re-run manually if the first attempt timed out.
 *
 * Also callable manually for backfill:
 *   GET /api/cron/sync-revenue-process?month=YYYY-MM
 *   Authorization: Bearer <CRON_SECRET>
 *   (backfill mode requests its own report, doesn't use _meta)
 */

const zlib                                 = require('zlib');
const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');

const HEADERS      = ['MONTH', 'YEAR', 'REVENUE', 'ORDERS', 'UNITS SOLD', 'FBA UNITS', 'FBM UNITS'];
const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// Short poll — report should already be ready after 15 min
const REPORT_POLL_TIMEOUT_MS  = 60_000;
const REPORT_POLL_INTERVAL_MS = 4_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = now.toISOString();

  let reportId, targetMonths, start, end;
  let backfillMode = false;

  // ── Backfill mode: ?month=YYYY-MM ─────────────────────────────────────────
  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    backfillMode = true;
    targetMonths = [req.query.month];
    const [y, m] = req.query.month.split('-');
    const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
    start = `${req.query.month}-01T00:00:00Z`;
    end   = `${req.query.month}-${pad(lastDay)}T23:59:59Z`;

    console.log(`[sync-revenue-process] backfill mode — requesting own report for ${req.query.month}`);

    try {
      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  start,
        dataEndTime:    end,
      });
      reportId = createResp.reportId;
      console.log(`[sync-revenue-process] backfill report requested: ${reportId}`);
    } catch (err) {
      console.error('[sync-revenue-process] failed to request backfill report:', err.message);
      return res.status(500).json({ error: 'Failed to request report', detail: err.message });
    }

  // ── Normal mode: read reportId from _meta tab ──────────────────────────────
  } else {
    try {
      const rawMeta = await readRows(sheets.revenue, META_TAB);
      const metaMap = {};
      for (const r of (rawMeta || [])) {
        if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
      }

      reportId     = metaMap['report_id'];
      targetMonths = (metaMap['target_months'] || '').split(',').filter(Boolean);
      start        = metaMap['start'];
      end          = metaMap['end'];

      if (!reportId) {
        return res.status(400).json({ error: 'No reportId found in _meta — did sync-revenue-request run?' });
      }

      if (metaMap['report_status'] === 'PROCESSED') {
        return res.status(200).json({ message: 'Already processed today', reportId });
      }

      console.log(`[sync-revenue-process] resuming reportId=${reportId} targets=${targetMonths.join(', ')}`);
    } catch (err) {
      console.error('[sync-revenue-process] failed to read _meta:', err.message);
      return res.status(500).json({ error: 'Failed to read _meta tab', detail: err.message });
    }
  }

  // ── Poll until DONE ────────────────────────────────────────────────────────
  let documentId = null;
  const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    try {
      const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      const status     = statusResp.processingStatus;
      console.log(`[sync-revenue-process] report ${reportId} status: ${status}`);

      if (status === 'DONE') {
        documentId = statusResp.reportDocumentId;
        break;
      }
      if (status === 'FATAL' || status === 'CANCELLED') {
        return res.status(500).json({ error: `Report ${status}`, reportId });
      }
    } catch (err) {
      console.warn(`[sync-revenue-process] poll error (will retry): ${err.message}`);
    }
  }

  if (!documentId) {
    return res.status(202).json({
      message: 'Report not ready yet — try again in a few minutes',
      reportId,
    });
  }

  // ── Download & decompress ──────────────────────────────────────────────────
  let rawTsv;
  try {
    const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
    const fileResp = await fetch(docResp.url);
    if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    rawTsv = await new Promise((resolve) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) {
          console.log('[sync-revenue-process] not gzipped, reading as plain text');
          resolve(buffer.toString('utf8'));
        } else {
          resolve(result.toString('utf8'));
        }
      });
    });
  } catch (err) {
    console.error('[sync-revenue-process] failed to download/decompress:', err.message);
    return res.status(500).json({ error: 'Failed to download report', detail: err.message });
  }

  // ── Parse TSV ──────────────────────────────────────────────────────────────
  const lines      = rawTsv.split('\n').filter(l => l.trim());
  const tsvHeaders = lines[0].split('\t').map(h => h.trim());
  const rows       = lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(tsvHeaders.map((h, i) => [h, (vals[i] || '').trim()]));
  });

  console.log(`[sync-revenue-process] flat file headers: ${tsvHeaders.slice(0, 10).join(' | ')}`);
  console.log(`[sync-revenue-process] flat file rows: ${rows.length}`);

  // ── Per-brand aggregation & sheet write ────────────────────────────────────
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

      console.log(`[sync-revenue-process] ${brand.id} — ${brandRows.length} matching rows`);

      // Aggregate by order_id per month
      const monthMap = {};

      for (const row of brandRows) {
        const orderId = row['amazon-order-id'] || row['order-id'] || '';
        const dateRaw = (row['purchase-date'] || '').slice(0, 7); // "YYYY-MM"
        if (!orderId || !dateRaw) continue;
        if (!targetMonths.includes(dateRaw)) continue;

        if (!monthMap[dateRaw])          monthMap[dateRaw]          = {};
        if (!monthMap[dateRaw][orderId]) monthMap[dateRaw][orderId] = { revenue: 0, units: 0, fbaUnits: 0, fbmUnits: 0 };

        const entry = monthMap[dateRaw][orderId];
        const qty   = parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10);
        const price = parseFloat(row['item-price'] || '0');
        const isFba = (row['fulfillment-channel'] || '').toUpperCase() === 'AFN';

        entry.revenue  = round2(entry.revenue + price);
        entry.units   += qty;
        if (isFba) { entry.fbaUnits += qty; } else { entry.fbmUnits += qty; }
      }

      // Read existing rows, preserve all historical data
      const token       = await ensureTab(sheets.revenue, brand.tabName, HEADERS);
      const rawExisting = await readRows(sheets.revenue, brand.tabName);

      // Normalize to plain arrays, preserving raw string values for historical rows
      const existingArrays = (rawExisting || []).map(r =>
        Array.isArray(r)
          ? r
          : [
              r['MONTH']      ?? '',
              r['YEAR']       ?? '',
              r['REVENUE']    ?? '',
              r['ORDERS']     ?? '',
              r['UNITS SOLD'] ?? '',
              r['FBA UNITS']  ?? '',
              r['FBM UNITS']  ?? '',
            ]
      );

      let workingRows = [...existingArrays];

      const brandResults = [];

      for (const targetMonth of targetMonths) {
        const [tYear, tMonth] = targetMonth.split('-');
        const tMonthNum = parseInt(tMonth, 10);
        const tYearNum  = parseInt(tYear,  10);

        const orderData = monthMap[targetMonth] || {};
        const orders    = Object.keys(orderData).length;
        const revenue   = round2(Object.values(orderData).reduce((s, o) => s + o.revenue, 0));
        const unitsSold = Object.values(orderData).reduce((s, o) => s + o.units, 0);
        const fbaUnits  = Object.values(orderData).reduce((s, o) => s + o.fbaUnits, 0);
        const fbmUnits  = Object.values(orderData).reduce((s, o) => s + o.fbmUnits, 0);

        console.log(`[sync-revenue-process] ${brand.id} ${targetMonth} — orders=${orders} revenue=${revenue} units=${unitsSold} fba=${fbaUnits} fbm=${fbmUnits}`);

        const newRow = [tMonthNum, tYearNum, revenue, orders, unitsSold, fbaUnits, fbmUnits];

        const idx = workingRows.findIndex(r =>
          parseInt(r[0], 10) === tMonthNum &&
          parseInt(r[1], 10) === tYearNum
        );

        if (idx >= 0) {
          workingRows[idx] = newRow;
          console.log(`[sync-revenue-process] ${brand.id} — overwrote ${targetMonth}`);
        } else {
          workingRows.push(newRow);
          console.log(`[sync-revenue-process] ${brand.id} — appended ${targetMonth}`);
        }

        brandResults.push({ month: targetMonth, orders, revenue, units: unitsSold });
      }

      // Sort by YEAR then MONTH — blank MONTH rows (historical) sort to top as 0
      workingRows.sort((a, b) => {
        const ay = parseInt(a[1], 10) || 0;
        const by = parseInt(b[1], 10) || 0;
        const am = parseInt(a[0], 10) || 0;
        const bm = parseInt(b[0], 10) || 0;
        return ay !== by ? ay - by : am - bm;
      });

      await replaceRows(sheets.revenue, brand.tabName, HEADERS, workingRows, token);
      results.push({ brand: brand.id, status: 'ok', months: brandResults });

    } catch (err) {
      console.error(`[sync-revenue-process] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  // ── Mark as processed in _meta ─────────────────────────────────────────────
  if (!backfillMode) {
    try {
      const token   = await ensureTab(sheets.revenue, META_TAB, META_HEADERS);
      const rawMeta = await readRows(sheets.revenue, META_TAB);
      const metaMap = {};
      for (const r of (rawMeta || [])) {
        if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
      }
      metaMap['report_status']    = 'PROCESSED';
      metaMap['last_processed_at'] = ts;
      const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
      await replaceRows(sheets.revenue, META_TAB, META_HEADERS, metaRows, token);
    } catch (err) {
      console.warn('[sync-revenue-process] failed to update _meta status:', err.message);
    }
  }

  res.status(200).json({ synced: results, reportId });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
