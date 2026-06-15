/**
 * api/cron/sync-revenue.js
 * Runs daily — pulls orders for the prior full month AND current month
 * in a single flat file request, then writes/overwrites one summary row
 * per brand per month to the revenue history sheet.
 *
 * Why both months:
 *   - Prior month: pending → shipped transitions can trickle in until ~15th
 *   - Current month: live running total as orders ship throughout the month
 *
 * Why flat file: covers FBA + FBM, Amazon's source of truth for reconciliation.
 *
 * Sheet: amazon-revenue  |  One tab per brand (matches brand.tabName).
 * Columns: MONTH | YEAR | REVENUE | ORDERS | UNITS SOLD | FBA UNITS | FBM UNITS
 *
 * Safe to re-run — overwrites the row for each target month if it already exists.
 *
 * Trigger manually for backfill:
 *   GET /api/cron/sync-revenue?month=YYYY-MM
 *   Authorization: Bearer <CRON_SECRET>
 */

const zlib                                 = require('zlib');
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

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');

  // ── Determine target months ────────────────────────────────────────────────
  // Manual override: ?month=YYYY-MM runs only that one month (for backfill)
  // Default: prior month + current month in one report request
  let targetMonths;
  let start, end;

  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    // Backfill mode — single month
    targetMonths = [req.query.month];
    const [y, m] = req.query.month.split('-');
    const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
    start = `${req.query.month}-01T00:00:00Z`;
    end   = `${req.query.month}-${pad(lastDay)}T23:59:59Z`;
  } else {
    // Default mode — prior month through now
    const prior  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const pYear  = prior.getFullYear();
    const pMonth = pad(prior.getMonth() + 1);
    const cYear  = now.getFullYear();
    const cMonth = pad(now.getMonth() + 1);

    targetMonths = [`${pYear}-${pMonth}`, `${cYear}-${cMonth}`];
    start = `${pYear}-${pMonth}-01T00:00:00Z`;
    end   = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
  }

  console.log(`[sync-revenue] targets=${targetMonths.join(', ')} start=${start} end=${end}`);

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
  const lines      = rawTsv.split('\n').filter(l => l.trim());
  const tsvHeaders = lines[0].split('\t').map(h => h.trim());
  const rows       = lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(tsvHeaders.map((h, i) => [h, (vals[i] || '').trim()]));
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

      // Aggregate by order_id per month
      // monthMap: { "YYYY-MM": { orderId: { revenue, units, fbaUnits, fbmUnits } } }
      const monthMap = {};

      for (const row of brandRows) {
        const orderId = row['amazon-order-id'] || row['order-id'] || '';
        const dateRaw = (row['purchase-date'] || '').slice(0, 7); // "YYYY-MM"
        if (!orderId || !dateRaw) continue;

        // Only process months we care about
        if (!targetMonths.includes(dateRaw)) continue;

        if (!monthMap[dateRaw])          monthMap[dateRaw]          = {};
        if (!monthMap[dateRaw][orderId]) monthMap[dateRaw][orderId] = { revenue: 0, units: 0, fbaUnits: 0, fbmUnits: 0 };

        const entry = monthMap[dateRaw][orderId];
        const qty   = parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10);
        const price = parseFloat(row['item-price'] || '0');
        // AFN = Fulfilled by Amazon (FBA), MFN = Merchant Fulfilled (FBM)
        const isFba = (row['fulfillment-channel'] || '').toUpperCase() === 'AFN';

        entry.revenue  = round2(entry.revenue + price);
        entry.units   += qty;
        if (isFba) { entry.fbaUnits += qty; } else { entry.fbmUnits += qty; }
      }

      // ── Read existing sheet rows once per brand ──────────────────────────
      await ensureTab(sheets.revenue, brand.tabName, HEADERS);
      const rawExisting = await readRows(sheets.revenue, brand.tabName);

      // Normalize existing rows to plain arrays — handles empty tab (new brands)
      // and object rows returned by readRows equally
      const existingArrays = (rawExisting || []).map(r =>
        Array.isArray(r)
          ? r
          : [
              parseInt(r['MONTH']      || 0, 10),
              parseInt(r['YEAR']       || 0, 10),
              parseFloat(r['REVENUE']  || 0),
              parseInt(r['ORDERS']     || 0, 10),
              parseInt(r['UNITS SOLD'] || 0, 10),
              parseInt(r['FBA UNITS']  || 0, 10),
              parseInt(r['FBM UNITS']  || 0, 10),
            ]
      );

      // Work with a mutable copy
      let workingRows = [...existingArrays];

      // ── Upsert each target month ─────────────────────────────────────────
      const brandResults = [];

      for (const targetMonth of targetMonths) {
        const [tYear, tMonth] = targetMonth.split('-');
        const orderData = monthMap[targetMonth] || {};
        const orders    = Object.keys(orderData).length;
        const revenue   = round2(Object.values(orderData).reduce((s, o) => s + o.revenue, 0));
        const unitsSold = Object.values(orderData).reduce((s, o) => s + o.units, 0);
        const fbaUnits  = Object.values(orderData).reduce((s, o) => s + o.fbaUnits, 0);
        const fbmUnits  = Object.values(orderData).reduce((s, o) => s + o.fbmUnits, 0);

        console.log(`[sync-revenue] ${brand.id} ${targetMonth} — orders=${orders} revenue=${revenue} units=${unitsSold} fba=${fbaUnits} fbm=${fbmUnits}`);

        const newRow = [
          parseInt(tMonth, 10),
          parseInt(tYear,  10),
          revenue,
          orders,
          unitsSold,
          fbaUnits,
          fbmUnits,
        ];

        // Match on MONTH (index 0) + YEAR (index 1)
        const idx = workingRows.findIndex(
          r => r[0] === parseInt(tMonth, 10) && r[1] === parseInt(tYear, 10)
        );

        if (idx >= 0) {
          workingRows[idx] = newRow;
          console.log(`[sync-revenue] ${brand.id} — overwrote ${targetMonth}`);
        } else {
          workingRows.push(newRow);
          console.log(`[sync-revenue] ${brand.id} — appended ${targetMonth}`);
        }

        brandResults.push({ month: targetMonth, orders, revenue, units: unitsSold });
      }

      // Sort by YEAR then MONTH before writing
      workingRows.sort((a, b) => a[1] !== b[1] ? a[1] - b[1] : a[0] - b[0]);

      await replaceRows(sheets.revenue, brand.tabName, workingRows);
      results.push({ brand: brand.id, status: 'ok', months: brandResults });

    } catch (err) {
      console.error(`[sync-revenue] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, reportId });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
