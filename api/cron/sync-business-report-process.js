/**
 * api/cron/sync-business-report-process.js
 * Step 2 of 2 — reads the reportIds stored by sync-business-report-request.js,
 * polls each until DONE, downloads, aggregates by brand, and writes to
 * SHEET_BUSINESS_REPORT — one tab per brand, one row per month.
 *
 * Runs at 5:15 UTC daily (15 min after sync-business-report-request).
 * Safe to re-run manually if the first attempt failed.
 *
 * Backfill a single month:
 *   GET /api/cron/sync-business-report-process?month=YYYY-MM
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Debug mode — logs the raw report structure for one month instead of
 * writing to the sheet, so you can confirm Amazon's field names before
 * trusting the aggregation (same defensive pattern used elsewhere in this
 * codebase, e.g. sync-listings.js?debug=SKU):
 *   GET /api/cron/sync-business-report-process?debug=true&month=YYYY-MM
 *   Authorization: Bearer <CRON_SECRET>
 *
 * IMPORTANT — unlike sync-revenue-process.js, this report is JSON, not a
 * TSV flat file, and it's already scoped to exactly one month per report
 * (see sync-business-report-request.js comment header for why). That means
 * no per-order-line date filtering here — we just sum sessions/units by
 * SKU prefix straight from `salesAndTrafficByAsin`. The field names below
 * (sku, sessions, unitsOrdered, pageViews, orderedProductSales) are per
 * Amazon's documented schema — VERIFY with ?debug=true before relying on
 * this in production, in case Amazon's actual response differs.
 */

const zlib                                 = require('zlib');
const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');

const HEADERS      = ['MONTH', 'YEAR', 'ASIN', 'SKU', 'SESSIONS', 'PAGE_VIEWS', 'UNITS_ORDERED', 'ORDERED_PRODUCT_SALES', 'CONVERSION_RATE'];
const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// Report should be ready after 15 min — short poll per report (same as sync-revenue-process.js)
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
  const debugMode = req.query.debug === 'true';

  // ── Build the list of { month, reportId, start, end } to process ──────────
  let jobs = [];
  let backfillMode = false;

  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    // ── Backfill mode (or debug mode) — request its own report for a single month ──
    backfillMode = true;
    const [y, m]  = req.query.month.split('-');
    const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
    const start   = `${req.query.month}-01T00:00:00Z`;
    const end     = `${req.query.month}-${pad(lastDay)}T23:59:59Z`;

    console.log(`[sync-business-report-process] backfill mode — requesting report for ${req.query.month}`);

    try {
      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  start,
        dataEndTime:    end,
        reportOptions: { dateGranularity: 'MONTH', asinGranularity: 'CHILD' },
      });
      if (!createResp || !createResp.reportId) {
        console.error(`[sync-business-report-process] backfill ${req.query.month} — no reportId in response:`, JSON.stringify(createResp));
        return res.status(500).json({ error: `Amazon returned no reportId for ${req.query.month}`, detail: createResp });
      }
      jobs = [{ month: req.query.month, reportId: createResp.reportId, start, end }];
      console.log(`[sync-business-report-process] backfill report requested: ${createResp.reportId}`);
    } catch (err) {
      console.error('[sync-business-report-process] failed to request backfill report:', err.message);
      return res.status(500).json({ error: 'Failed to request report', detail: err.message });
    }

  } else {
    // ── Normal mode — read reportIds from _meta ───────────────────────────────
    try {
      const rawMeta = await readRows(sheets.businessReport, META_TAB);
      const metaMap = {};
      for (const r of (rawMeta || [])) {
        if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
      }

      if (metaMap['report_status'] === 'PROCESSED' && !req.query.force) {
        return res.status(200).json({ message: 'Already processed today. Pass ?force=true to re-run anyway (e.g. after a bugfix).', meta: metaMap });
      }

      const targetMonths = (metaMap['target_months'] || '').split(',').filter(Boolean);
      if (!targetMonths.length) {
        return res.status(400).json({ error: 'No target_months in _meta — did sync-business-report-request run?' });
      }

      for (const month of targetMonths) {
        const reportId = metaMap[`report_id_${month}`];
        if (!reportId) {
          return res.status(400).json({ error: `No reportId for ${month} in _meta — did sync-business-report-request run?` });
        }
        jobs.push({ month, reportId });
      }

      console.log(`[sync-business-report-process] processing ${jobs.length} reports: ${jobs.map(j => j.month).join(', ')}`);
    } catch (err) {
      console.error('[sync-business-report-process] failed to read _meta:', err.message);
      return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
    }
  }

  // ── Process each month's report ────────────────────────────────────────────
  // monthAsinRows: { "YYYY-MM": [ salesAndTrafficByAsin entries ] }
  const monthAsinRows = {};

  for (const job of jobs) {
    // Poll until DONE
    let documentId = null;
    const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(REPORT_POLL_INTERVAL_MS);
      try {
        const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${job.reportId}`);
        const status     = statusResp.processingStatus;
        console.log(`[sync-business-report-process] ${job.month} report ${job.reportId} status: ${status}`);

        if (status === 'DONE') {
          documentId = statusResp.reportDocumentId;
          break;
        }
        if (status === 'FATAL' || status === 'CANCELLED') {
          console.error(`[sync-business-report-process] ${job.month} report ${status}`);
          break;
        }
      } catch (err) {
        console.warn(`[sync-business-report-process] poll error (will retry): ${err.message}`);
      }
    }

    if (!documentId) {
      console.warn(`[sync-business-report-process] ${job.month} report not ready — skipping`);
      monthAsinRows[job.month] = [];
      continue;
    }

    // Download & decompress — this report is gzip JSON, not TSV
    try {
      const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
      const fileResp = await fetch(docResp.url);
      if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);

      const buffer = Buffer.from(await fileResp.arrayBuffer());
      const rawJson = await new Promise((resolve) => {
        zlib.gunzip(buffer, (err, result) => {
          if (err) resolve(buffer.toString('utf8'));
          else resolve(result.toString('utf8'));
        });
      });

      const parsed  = JSON.parse(rawJson);
      const asinRows = parsed.salesAndTrafficByAsin || [];

      if (debugMode) {
        console.log(`[sync-business-report-process][DEBUG] ${job.month} top-level keys: ${Object.keys(parsed).join(', ')}`);
        console.log(`[sync-business-report-process][DEBUG] ${job.month} salesAndTrafficByAsin count: ${asinRows.length}`);
        console.log(`[sync-business-report-process][DEBUG] ${job.month} first entry: ${JSON.stringify(asinRows[0] || {}, null, 2)}`);
        return res.status(200).json({
          debug: true,
          month: job.month,
          topLevelKeys: Object.keys(parsed),
          asinRowCount: asinRows.length,
          firstEntry: asinRows[0] || null,
        });
      }

      console.log(`[sync-business-report-process] ${job.month} salesAndTrafficByAsin rows: ${asinRows.length}`);
      monthAsinRows[job.month] = asinRows;
    } catch (err) {
      console.error(`[sync-business-report-process] failed to download ${job.month}:`, err.message);
      monthAsinRows[job.month] = [];
    }
  }

  // ── Per-brand aggregation & sheet write ────────────────────────────────────
  // No per-order date filtering needed here (unlike revenue) — each report
  // already scopes to exactly one month, and salesAndTrafficByAsin gives
  // per-SKU totals for that whole scoped range in one shot.
  const targetMonths = jobs.map(j => j.month);
  const results       = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      // Amazon's Sales and Traffic report has NO sku field — only
      // parentAsin/childAsin (confirmed via ?debug=true). Brand matching by
      // SKU prefix (as revenue.js does) doesn't work here for that reason.
      // Instead: since Products Cache already has one tab per brand, an
      // ASIN's presence in THIS brand's tab is itself the brand match — no
      // prefix logic needed. getBrandAsinMap reads only the most recent
      // sync date (this sheet is a daily-snapshot cron, so every ASIN
      // repeats once per sync date) and also gives us the SKU to write.
      const asinMap = await getBrandAsinMap(brand);
      if (asinMap.size === 0) {
        console.warn(`[sync-business-report-process] ${brand.id} — Products Cache tab returned 0 ASINs, check sheets.products / tab name`);
      }

      const token       = await ensureTab(sheets.businessReport, brand.tabName, HEADERS);
      const rawExisting = await readRows(sheets.businessReport, brand.tabName);

      const existingArrays = (rawExisting || []).map(r =>
        Array.isArray(r)
          ? r
          : [
              r['MONTH']                 ?? '',
              r['YEAR']                  ?? '',
              r['ASIN']                  ?? '',
              r['SKU']                   ?? '',
              r['SESSIONS']              ?? '',
              r['PAGE_VIEWS']             ?? '',
              r['UNITS_ORDERED']         ?? '',
              r['ORDERED_PRODUCT_SALES'] ?? '',
              r['CONVERSION_RATE']       ?? '',
            ]
      );

      let workingRows    = [...existingArrays];
      const brandResults = [];

      for (const targetMonth of targetMonths) {
        const [tYear, tMonth] = targetMonth.split('-');
        const tMonthNum = parseInt(tMonth, 10);
        const tYearNum  = parseInt(tYear,  10);

        const asinRows = monthAsinRows[targetMonth] || [];

        // Sum per ASIN (defensive — normally one row per ASIN per report,
        // but sum rather than overwrite in case Amazon ever sends more).
        const perAsin = new Map(); // ASIN -> { sessions, pageViews, unitsOrdered, orderedProductSales }
        for (const row of asinRows) {
          const asin = (row.childAsin || row.parentAsin || '').toUpperCase();
          if (!asinMap.has(asin)) continue; // not this brand's ASIN

          if (!perAsin.has(asin)) perAsin.set(asin, { sessions: 0, pageViews: 0, unitsOrdered: 0, orderedProductSales: 0 });
          const acc = perAsin.get(asin);
          acc.sessions            += parseInt(row.trafficByAsin?.sessions ?? 0, 10) || 0;
          acc.pageViews           += parseInt(row.trafficByAsin?.pageViews ?? 0, 10) || 0;
          acc.unitsOrdered        += parseInt(row.salesByAsin?.unitsOrdered ?? 0, 10) || 0;
          acc.orderedProductSales += parseFloat(row.salesByAsin?.orderedProductSales?.amount ?? 0) || 0;
        }

        // Every ASIN in this brand's catalog gets a row, even if the report
        // had zero traffic for it — otherwise "no row" is ambiguous between
        // "zero sessions" and "not synced yet."
        let brandTotalSessions = 0, brandTotalUnits = 0;
        for (const [asin, sku] of asinMap.entries()) {
          const acc = perAsin.get(asin) || { sessions: 0, pageViews: 0, unitsOrdered: 0, orderedProductSales: 0 };
          const orderedProductSales = round2(acc.orderedProductSales);
          const conversionRate = acc.sessions > 0 ? round2((acc.unitsOrdered / acc.sessions) * 100) : 0;

          brandTotalSessions += acc.sessions;
          brandTotalUnits    += acc.unitsOrdered;

          const newRow = [tMonthNum, tYearNum, asin, sku, acc.sessions, acc.pageViews, acc.unitsOrdered, orderedProductSales, conversionRate];

          const idx = workingRows.findIndex(r =>
            parseInt(r[0], 10) === tMonthNum &&
            parseInt(r[1], 10) === tYearNum &&
            (r[2] || '').toUpperCase() === asin
          );

          if (idx >= 0) {
            workingRows[idx] = newRow;
          } else {
            workingRows.push(newRow);
          }
        }

        console.log(`[sync-business-report-process] ${brand.id} ${targetMonth} — ${asinMap.size} ASIN rows written, sessions=${brandTotalSessions} units=${brandTotalUnits}`);
        brandResults.push({ month: targetMonth, asinCount: asinMap.size, sessions: brandTotalSessions, unitsOrdered: brandTotalUnits });
      }

      workingRows.sort((a, b) => {
        const ay = parseInt(a[1], 10) || 0;
        const by = parseInt(b[1], 10) || 0;
        const am = parseInt(a[0], 10) || 0;
        const bm = parseInt(b[0], 10) || 0;
        if (ay !== by) return ay - by;
        if (am !== bm) return am - bm;
        return (a[2] || '').localeCompare(b[2] || ''); // ASIN, for stable ordering within a month
      });

      await replaceRows(sheets.businessReport, brand.tabName, HEADERS, workingRows, token);
      results.push({ brand: brand.id, status: 'ok', months: brandResults });

    } catch (err) {
      console.error(`[sync-business-report-process] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  // ── Mark as processed in _meta ─────────────────────────────────────────────
  if (!backfillMode) {
    try {
      const token   = await ensureTab(sheets.businessReport, META_TAB, META_HEADERS);
      const rawMeta = await readRows(sheets.businessReport, META_TAB);
      const metaMap = {};
      for (const r of (rawMeta || [])) {
        if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
      }
      metaMap['report_status']     = 'PROCESSED';
      metaMap['last_processed_at'] = ts;
      const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
      await replaceRows(sheets.businessReport, META_TAB, META_HEADERS, metaRows, token);
    } catch (err) {
      console.warn('[sync-business-report-process] failed to update _meta status:', err.message);
    }
  }

  res.status(200).json({ synced: results });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;

// Products Cache is a daily-snapshot cron — every ASIN repeats once per
// sync date, so only the most recent date's rows should count. Column C
// is `asin`, column B is `sku` (confirmed via screenshot, 2026-07-14).
// Returns a Map so we get both the brand-membership check AND the SKU to
// write per row, in one read.
async function getBrandAsinMap(brand) {
  try {
    const rows = await readRows(sheets.products, brand.tabName);
    if (!rows || !rows.length) return new Map();
    const latestDate = rows.reduce((max, r) => ((r['date'] || '') > max ? r['date'] : max), '');
    const latestRows = latestDate ? rows.filter(r => r['date'] === latestDate) : rows;
    const map = new Map();
    latestRows.forEach(r => {
      const asin = (r['asin'] || '').trim().toUpperCase();
      const sku  = (r['sku']  || '').trim();
      if (asin) map.set(asin, sku);
    });
    return map;
  } catch (err) {
    console.warn(`[sync-business-report-process] ${brand.id} — failed to read Products Cache tab:`, err.message);
    return new Map();
  }
}
