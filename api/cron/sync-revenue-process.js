/**
 * api/cron/sync-revenue-process.js
 * Step 2 of 2 — reads the reportIds stored by sync-revenue-request.js,
 * polls each until DONE, downloads, aggregates, and writes to the revenue sheet.
 *
 * Runs at 5:15 UTC daily (15 min after sync-revenue-request).
 * Safe to re-run manually if the first attempt failed.
 *
 * Backfill a single month:
 *   GET /api/cron/sync-revenue-process?month=YYYY-MM
 *   Authorization: Bearer <CRON_SECRET>
 *
 * RETURNS NETTING — added 2026-08-05 per Jaclyn. REVENUE and UNITS SOLD
 * (and FBA UNITS specifically) are now netted against SHEET_RETURNS
 * (config/sheets.js `returns`), matched by RETURN month (return_date),
 * not the original order's month — same "net this month's real activity"
 * convention already used for the Overview page's own returns-netting.
 *
 * TWO REAL CONSTRAINTS ON THIS, NOT WORKAROUNDS FOR A BUG:
 *   1. Amazon's FBA Customer Returns report (what feeds SHEET_RETURNS)
 *      has NO dollar amount field at all — only quantity. There is no
 *      "refund amount" to simply subtract. Revenue impact is therefore
 *      an ESTIMATE: each returned line item's dollar value is priced
 *      using that exact order_id+sku's item_price from the Amazon orders
 *      sheet (config/sheets.js `orders`, same SHEET_ID this dashboard's
 *      Sales page reads — a rolling ~90-day window, deliberately used
 *      over this cron's own 2-month flat-file fetch because a return can
 *      lag its original sale by more than 2 months). Falls back to an
 *      average item_price for that SKU on the SAME orders sheet if the
 *      exact original order isn't found there (e.g. aged out of the
 *      rolling window). If a returned SKU has no price data on that
 *      sheet at all, that return's dollar impact is left at $0 (not
 *      guessed further) and logged — see buildPriceLookup()/
 *      estimateReturnImpact() below. UNCONFIRMED: config/sheets.js
 *      exporting this sheet as `sheets.orders` — wasn't available while
 *      writing this; matches the naming convention `sheets.returns`/
 *      `sheets.revenue` already use in this same file, but not
 *      independently verified.
 *   2. The FBA Customer Returns report is, by its own name
 *      (GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA), FBA-ONLY. Returned
 *      units are subtracted from FBA UNITS specifically, never FBM
 *      UNITS — this feed has no visibility into seller-fulfilled returns
 *      at all, so FBM UNITS stays exactly as computed from gross orders.
 *
 * Everything about how GROSS revenue/units/orders get computed from the
 * SP-API flat file — poll, download, decompress, parse, aggregate — is
 * UNCHANGED from the original version of this file. Returns netting is a
 * layer added on top of that existing output, not a rework of it.
 *
 * ORDERS is deliberately NOT netted against returns — same reasoning as
 * the Overview page: this returns feed is quantity/line-item level, not
 * a "this whole order was cancelled" flag, so there's no safe way to
 * decrement an order count from it.
 *
 * Returns are matched to a target month by return_date falling in that
 * month — "returns actually processed in this month," not "returns tied
 * to an order originally placed in this month."
 *
 * All 3 of revenue/unitsSold/fbaUnits are floored at 0 after netting — if
 * returns dated in a month exceed that month's own gross figures (plausible
 * since returns can be dated well after the original sale), a warning is
 * logged rather than allowing a negative number onto the sheet.
 */

const zlib                                 = require('zlib');
const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');

const HEADERS      = ['MONTH', 'YEAR', 'REVENUE', 'ORDERS', 'UNITS SOLD', 'FBA UNITS', 'FBM UNITS', 'Last Updated'];
const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// ADDED 2026-08-13 — the per-brand loop below does 3 real Sheets reads per
// brand (returns tab, orders tab, revenue tab) with ZERO pacing between
// brands — the only sleep() in this whole file is inside the report-poll
// loop, unrelated. With 15 active brands that's ~45 unpaced reads fired
// back-to-back, tripping Google's "Read requests per minute per user"
// quota (429 RESOURCE_EXHAUSTED) — same root cause already found and
// fixed in sync-advertising-process.js and _sheets_client.js's tab-title
// cache, but this file had no pacing mechanism at all to begin with,
// unlike that one's (insufficient) 1000ms stagger. 3500ms per brand keeps
// ~3 reads/iteration under ~50 reads/min with margin for other crons
// sharing this quota; 15 brands costs ~49s total, comfortably inside the
// 300s function budget. Starting point, not independently confirmed
// against Google's actual per-project quota — watch logs for further
// 429s and adjust if needed.
const BRAND_READ_STAGGER_MS = 3500;

// Report should be ready after 15 min — short poll per report
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

  // ── Build the list of { month, reportId, start, end } to process ──────────
  let jobs = [];
  let backfillMode = false;

  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    // ── Backfill mode — request its own report for a single month ────────────
    backfillMode = true;
    const [y, m]  = req.query.month.split('-');
    const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
    const start   = `${req.query.month}-01T00:00:00Z`;
    const end     = `${req.query.month}-${pad(lastDay)}T23:59:59Z`;

    console.log(`[sync-revenue-process] backfill mode — requesting report for ${req.query.month}`);

    try {
      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  start,
        dataEndTime:    end,
      });
      jobs = [{ month: req.query.month, reportId: createResp.reportId, start, end }];
      console.log(`[sync-revenue-process] backfill report requested: ${createResp.reportId}`);
    } catch (err) {
      console.error('[sync-revenue-process] failed to request backfill report:', err.message);
      await sendCronFailureAlert('sync-revenue-process', err.message, { Stage: 'requesting backfill report', Month: req.query.month });
      return res.status(500).json({ error: 'Failed to request report', detail: err.message });
    }

  } else {
    // ── Normal mode — read reportIds from _meta ───────────────────────────────
    try {
      const rawMeta = await readRows(sheets.revenue, META_TAB);
      const metaMap = {};
      for (const r of (rawMeta || [])) {
        if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
      }

      if (metaMap['report_status'] === 'PROCESSED') {
        return res.status(200).json({ message: 'Already processed today', meta: metaMap });
      }

      const targetMonths = (metaMap['target_months'] || '').split(',').filter(Boolean);
      if (!targetMonths.length) {
        return res.status(400).json({ error: 'No target_months in _meta — did sync-revenue-request run?' });
      }

      for (const month of targetMonths) {
        const reportId = metaMap[`report_id_${month}`];
        if (!reportId) {
          return res.status(400).json({ error: `No reportId for ${month} in _meta — did sync-revenue-request run?` });
        }
        const [y, m]  = month.split('-');
        const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
        jobs.push({
          month,
          reportId,
          start: `${month}-01T00:00:00Z`,
          end:   `${month}-${pad(lastDay)}T23:59:59Z`,
        });
      }

      console.log(`[sync-revenue-process] processing ${jobs.length} reports: ${jobs.map(j => j.month).join(', ')}`);
    } catch (err) {
      console.error('[sync-revenue-process] failed to read _meta:', err.message);
      await sendCronFailureAlert('sync-revenue-process', err.message, { Stage: 'reading _meta tab' });
      return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
    }
  }

  // ── Process each month's report ────────────────────────────────────────────
  // monthRows: { "YYYY-MM": [ flat file row objects ] }
  const monthRows = {};

  for (const job of jobs) {
    // Poll until DONE
    let documentId = null;
    const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(REPORT_POLL_INTERVAL_MS);
      try {
        const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${job.reportId}`);
        const status     = statusResp.processingStatus;
        console.log(`[sync-revenue-process] ${job.month} report ${job.reportId} status: ${status}`);

        if (status === 'DONE') {
          documentId = statusResp.reportDocumentId;
          break;
        }
        if (status === 'FATAL' || status === 'CANCELLED') {
          console.error(`[sync-revenue-process] ${job.month} report ${status}`);
          break;
        }
      } catch (err) {
        console.warn(`[sync-revenue-process] poll error (will retry): ${err.message}`);
      }
    }

    if (!documentId) {
      console.warn(`[sync-revenue-process] ${job.month} report not ready — skipping`);
      monthRows[job.month] = [];
      continue;
    }

    // Download & decompress
    try {
      const docResp  = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`);
      const fileResp = await fetch(docResp.url);
      if (!fileResp.ok) throw new Error(`Document download failed: ${fileResp.status}`);

      const buffer = Buffer.from(await fileResp.arrayBuffer());
      const rawTsv = await new Promise((resolve) => {
        zlib.gunzip(buffer, (err, result) => {
          if (err) resolve(buffer.toString('utf8'));
          else resolve(result.toString('utf8'));
        });
      });

      const lines      = rawTsv.split('\n').filter(l => l.trim());
      const tsvHeaders = lines[0].split('\t').map(h => h.trim());
      const rows       = lines.slice(1).map(line => {
        const vals = line.split('\t');
        return Object.fromEntries(tsvHeaders.map((h, i) => [h, (vals[i] || '').trim()]));
      });

      console.log(`[sync-revenue-process] ${job.month} headers: ${tsvHeaders.slice(0, 8).join(' | ')}`);
      console.log(`[sync-revenue-process] ${job.month} rows: ${rows.length}`);
      monthRows[job.month] = rows;
    } catch (err) {
      console.error(`[sync-revenue-process] failed to download ${job.month}:`, err.message);
      monthRows[job.month] = [];
    }
  }

  // ── Per-brand aggregation & sheet write ────────────────────────────────────
  const targetMonths = jobs.map(j => j.month);
  const results      = [];
  let brandIndex = 0;

  for (const brand of brands.filter(b => b.active)) {
    if (brandIndex > 0) await sleep(BRAND_READ_STAGGER_MS);
    brandIndex++;

    try {
      const brandReturnRows = await fetchReturnsForBrand(brand);
      // Per-brand (not global) — the orders sheet is one tab per brand,
      // unlike the flat-file rows which are shared across all brands
      // pre-filtering. Rebuilt fresh per brand rather than once for the
      // whole run.
      const brandOrderRows = await fetchOrdersForBrand(brand);
      const priceLookup    = buildPriceLookup(brandOrderRows);

      // Aggregate across all months for this brand
      const monthMap = {};

      for (const [month, rows] of Object.entries(monthRows)) {
        // Same shared-prefix disambiguation as sync-orders-process.js —
        // skinuva-ca (config/brands.js) shares skinuva's exact SKU prefix
        // on purpose. Checked per-month since each month is a separately
        // downloaded report; a row object only has this key at all if the
        // TSV header for that download included it (Object.fromEntries
        // above sets every declared header as a key, even if blank).
        const salesChannelFieldPresent = rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], 'sales-channel');

        const brandRows = rows.filter(row => {
          const sku    = (row['sku'] || row['seller-sku'] || '').toUpperCase();
          const status = (row['order-status'] || '').toLowerCase();
          const promo  = (row['promotion-ids'] || '').toLowerCase();

          if (
            !sku.startsWith(brand.skuPrefix.toUpperCase()) ||
            status === 'cancelled' ||
            status === 'pending'   ||
            promo.includes('vine')
          ) return false;

          if (brand.salesChannel) {
            if (!salesChannelFieldPresent) {
              return brand.salesChannel.toLowerCase() === 'amazon.com';
            }
            const channel = (row['sales-channel'] || '').trim().toLowerCase();
            if (channel !== brand.salesChannel.toLowerCase()) return false;
          }
          return true;
        });

        if (brand.salesChannel && !salesChannelFieldPresent) {
          console.warn(`[sync-revenue-process] ${brand.id} ${month} — "sales-channel" missing from this report; shared-prefix channel split could not run this pass (US sibling falls back to all shared-prefix rows, .ca sibling gets none this month).`);
        }

        console.log(`[sync-revenue-process] ${brand.id} ${month} — ${brandRows.length} matching rows`);

        monthMap[month] = {};
        for (const row of brandRows) {
          const orderId = row['amazon-order-id'] || row['order-id'] || '';
          const dateRaw = (row['purchase-date'] || '').slice(0, 7);
          if (!orderId || dateRaw !== month) continue;

          if (!monthMap[month][orderId]) monthMap[month][orderId] = { revenue: 0, units: 0, fbaUnits: 0, fbmUnits: 0 };

          const entry = monthMap[month][orderId];
          const qty   = parseInt(row['quantity'] || row['quantity-purchased'] || '0', 10);
          const price = parseFloat(row['item-price'] || '0');
          const isFba = (row['fulfillment-channel'] || '').toUpperCase() === 'AFN';

          entry.revenue  = round2(entry.revenue + price);
          entry.units   += qty;
          if (isFba) { entry.fbaUnits += qty; } else { entry.fbmUnits += qty; }
        }
      }

      // Read existing sheet rows
      const token       = await ensureTab(sheets.revenue, brand.tabName, HEADERS);
      const rawExisting = await readRows(sheets.revenue, brand.tabName);

      const existingArrays = (rawExisting || []).map(r =>
        Array.isArray(r)
          ? r
          : [
              r['MONTH']         ?? '',
              r['YEAR']          ?? '',
              r['REVENUE']       ?? '',
              r['ORDERS']        ?? '',
              r['UNITS SOLD']    ?? '',
              r['FBA UNITS']     ?? '',
              r['FBM UNITS']     ?? '',
              r['Last Updated']  ?? '',
            ]
      );

      let workingRows    = [...existingArrays];
      const brandResults = [];

      for (const targetMonth of targetMonths) {
        const [tYear, tMonth] = targetMonth.split('-');
        const tMonthNum = parseInt(tMonth, 10);
        const tYearNum  = parseInt(tYear,  10);

        const orderData = monthMap[targetMonth] || {};
        const orders        = Object.keys(orderData).length;
        const grossRevenue  = round2(Object.values(orderData).reduce((s, o) => s + o.revenue, 0));
        const grossUnits    = Object.values(orderData).reduce((s, o) => s + o.units, 0);
        const grossFbaUnits = Object.values(orderData).reduce((s, o) => s + o.fbaUnits, 0);
        const fbmUnits      = Object.values(orderData).reduce((s, o) => s + o.fbmUnits, 0); // never netted — see file header, this returns feed is FBA-only

        // Returns dated (by return_date) in THIS target month, for THIS
        // brand — same "net this month's real activity" convention as
        // the Overview page, not "returns tied to an order placed this
        // month" (a return can be dated well after its original sale).
        const monthReturns = brandReturnRows.filter(r => (r.return_date || '').slice(0, 7) === targetMonth);
        const { returnedUnits, returnedRevenue, unmatchedPriceCount } = estimateReturnImpact(monthReturns, priceLookup);

        const revenue   = Math.max(0, round2(grossRevenue - returnedRevenue));
        const unitsSold = Math.max(0, grossUnits - returnedUnits);
        const fbaUnits  = Math.max(0, grossFbaUnits - returnedUnits); // FBA-only feed — all returned units come off FBA, never FBM

        if (returnedUnits > 0) {
          console.log(`[sync-revenue-process] ${brand.id} ${targetMonth} — netted ${returnedUnits} returned units (\u2248$${returnedRevenue.toFixed(2)} estimated) against gross revenue=${grossRevenue} units=${grossUnits}`);
        }
        if (unmatchedPriceCount > 0) {
          console.warn(`[sync-revenue-process] ${brand.id} ${targetMonth} — ${unmatchedPriceCount} returned line item(s) had no price data on the Amazon orders sheet; their dollar impact was NOT estimated (left at $0), only their unit count was netted`);
        }
        if (grossRevenue - returnedRevenue < 0 || grossUnits - returnedUnits < 0) {
          console.warn(`[sync-revenue-process] ${brand.id} ${targetMonth} — returns this month exceeded gross this month; floored at 0 rather than writing a negative value`);
        }

        console.log(`[sync-revenue-process] ${brand.id} ${targetMonth} — orders=${orders} revenue=${revenue} units=${unitsSold} fba=${fbaUnits} fbm=${fbmUnits}`);

        // Column H (Last Updated) — added 2026-08-05 per Jaclyn, matching a
        // column that already existed on the real sheet but wasn't in this
        // cron's own HEADERS (that mismatch is what caused the "[sheets]
        // HEADER MISMATCH" warning). Uses `ts` (plain ISO-8601 UTC), the
        // same timestamp format every other "last_updated"-style column in
        // this codebase's crons uses. Not verified against whatever format
        // any pre-existing values in this column might already be in — if
        // older rows show a different date format than new ones going
        // forward, that's why.
        const newRow = [tMonthNum, tYearNum, revenue, orders, unitsSold, fbaUnits, fbmUnits, ts];

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
      metaMap['report_status']     = 'PROCESSED';
      metaMap['last_processed_at'] = ts;
      const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
      await replaceRows(sheets.revenue, META_TAB, META_HEADERS, metaRows, token);
    } catch (err) {
      console.warn('[sync-revenue-process] failed to update _meta status:', err.message);
      await sendCronFailureAlert('sync-revenue-process', err.message, { Stage: 'marking report processed in _meta' });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-revenue-process',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ synced: results });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Reads this brand's tab on the Amazon orders sheet (config/sheets.js
// `orders` — SHEET_ID 1SiYu8e2-Pfi14Aiuf6SAFytWVXb4_dtdNFT6wvLFPok per
// Jaclyn 2026-08-05, same sheet the dashboard's Sales page reads).
// Rolling ~90-day window — used here specifically because it reaches
// further back than this cron's own 2-month flat-file fetch, so it can
// price a return whose original sale happened outside that 2-month
// window. Fails soft, same pattern as fetchReturnsForBrand — a missing
// tab or fetch error just means fewer exact-price matches this run, not
// a failed sync.
async function fetchOrdersForBrand(brand) {
  try {
    const rows = await readRows(sheets.orders, brand.tabName);
    return rows || [];
  } catch (err) {
    console.warn(`[sync-revenue-process] ${brand.id} — failed to read orders sheet for return-price lookup (falling back to this run's own flat-file prices only):`, err.message);
    return [];
  }
}

// Builds a price lookup, preferring the wider-window orders sheet over
// this run's own narrower flat-file rows. Four tiers, tried in order:
//   1. Exact order_id+sku match — orders sheet (widest window, most likely
//      to actually contain a return's original order).
//   2. Exact order_id+sku match — this run's flat-file rows (narrower
//      window, but still worth trying if tier 1 misses for some reason).
//   3. Average item_price per SKU — orders sheet.
//   4. Average item_price per SKU — flat-file rows.
// A return whose SKU/order matches none of these is left unpriced
// (caller records it as unmatched and leaves that line item's dollar
// impact at $0 rather than guessing further).
// Simplified 2026-08-05 per Jaclyn — refers to the Amazon orders sheet
// ONLY for return pricing (dropped the flat-file-based fallback tiers
// this originally had). Two tiers, tried in order:
//   1. Exact order_id+sku match — that specific return's real price.
//   2. Average item_price for that SKU across the orders sheet — used
//      when the exact original order isn't on that sheet (e.g. it's
//      aged out of the rolling window).
// A return whose SKU/order matches neither is left unpriced — caller
// records it as unmatched and leaves that line item's dollar impact at
// $0 rather than guessing further.
function buildPriceLookup(orderSheetRows) {
  const exactByOrderSku = new Map();
  const pricesBySku     = new Map();

  (orderSheetRows || []).forEach(row => {
    const sku     = (row['sku'] || '').toUpperCase();
    const orderId = row['order_id'] || '';
    const price   = parseFloat(row['item_price'] || '0');
    if (!sku || !price) return;
    if (orderId && !exactByOrderSku.has(`${orderId}||${sku}`)) exactByOrderSku.set(`${orderId}||${sku}`, price);
    if (!pricesBySku.has(sku)) pricesBySku.set(sku, []);
    pricesBySku.get(sku).push(price);
  });

  const avgBySku = new Map();
  pricesBySku.forEach((prices, sku) => avgBySku.set(sku, prices.reduce((s, v) => s + v, 0) / prices.length));

  return {
    lookup(orderId, sku) {
      const key = `${orderId}||${sku}`;
      if (exactByOrderSku.has(key)) return exactByOrderSku.get(key);
      if (avgBySku.has(sku)) return avgBySku.get(sku);
      return null;
    },
  };
}

// Reads this brand's tab on the Amazon Returns sheet (config/sheets.js
// `returns`, same entry sync-returns-request.js/sync-returns-process.js
// already require). Fails soft — a brand with no returns tab yet, or a
// fetch error, nets $0/0 units for that brand this run rather than
// failing the whole revenue sync over a missing/broken returns sheet.
async function fetchReturnsForBrand(brand) {
  try {
    const rows = await readRows(sheets.returns, brand.tabName);
    return rows || [];
  } catch (err) {
    console.warn(`[sync-revenue-process] ${brand.id} — failed to read returns sheet (revenue will NOT be netted against returns this run):`, err.message);
    return [];
  }
}

// Sums returned quantity and ESTIMATES the returned dollar value for a
// set of return rows, using the price lookup above. Amazon's FBA Returns
// report has no price field of its own — see file header for why this is
// necessarily an estimate rather than an exact figure.
function estimateReturnImpact(returnRows, priceLookup) {
  let returnedUnits = 0, returnedRevenue = 0, unmatchedPriceCount = 0;

  returnRows.forEach(r => {
    const qty = parseInt(r.quantity, 10) || 0;
    if (!qty) return;
    returnedUnits += qty;

    const sku     = (r.sku || '').toUpperCase();
    const orderId = r.order_id || '';
    const price = priceLookup.lookup(orderId, sku);
    if (price == null) { unmatchedPriceCount++; return; } // no price data anywhere — dollar impact left at $0 for this line item, not guessed further

    returnedRevenue = round2(returnedRevenue + price * qty);
  });

  return { returnedUnits, returnedRevenue, unmatchedPriceCount };
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
