/**
 * api/cron/sync-advertising.js
 * Nightly cron — syncs Amazon Advertising metrics to Google Sheets.
 * Runs at 3:00 AM UTC daily.
 *
 * Writes to TWO sheets:
 *
 *   SHEET_ADVERTISING (env var) — monthly brand-level summary
 *     Tab per brand (e.g. "evolis")
 *     Columns: year, month, impressions, clicks, spend, sales,
 *              acos, roas, ad_units, ctr, cpc, brand, last_updated
 *     Uses replaceRows — full overwrite, always current 13 months.
 *
 *   SHEET_AD_ORDERS (env var = 13cN301QZxkEGy6-8LfdzB8zmsHhUKwZqz6lsXKUJcnI)
 *     Advertising Orders Cache — SKU-level monthly ad data
 *     Tab per brand (e.g. "evolis")
 *     Columns: year, month, sku, ad_units, spend, sales, acos, brand, last_updated
 *     Uses replaceRows — full overwrite per tab.
 *     Rows older than 3 years are automatically trimmed before writing.
 *
 * Ad types covered: Sponsored Products (SP) + Sponsored Brands (SB).
 * DSP uses a separate API and will be a separate cron.
 *
 * Report groupBy:
 *   Brand summary  → groupBy: ['campaign']   (SP campaigns report)
 *   SKU detail     → groupBy: ['advertised_asin']  with advertisedSku column
 *
 * NOTE: SP_AD_PROFILE_ID is a single profile covering all brands on this
 * seller account. The Amazon Ads API returns data for all SKUs under that
 * profile — we filter by brand.skuPrefix to split per brand.
 */

const { getAdToken }                             = require('../_spauth');
const { ensureTab, replaceRows, getSheetsToken } = require('../config/_sheets_client');
const brands                                     = require('../config/brands');
const https                                      = require('https');
const zlib                                       = require('zlib');

const AD_API_HOST      = 'advertising-api.amazon.com';
const SHEET_AD_SUMMARY = process.env.SHEET_ADVERTISING;
const SHEET_AD_ORDERS  = process.env.SHEET_AD_ORDERS
                      || '1N30haUFZkdv9rrvYuWwUhxEm0z7MGp1bz9F462aF-QI';

// Three years of months to keep in the ad orders sheet
const TRIM_YEARS = 3;

const SUMMARY_HEADERS = [
  'year', 'month', 'impressions', 'clicks', 'spend', 'sales',
  'acos', 'roas', 'ad_units', 'ctr', 'cpc', 'brand', 'last_updated',
];

const SKU_HEADERS = [
  'year', 'month', 'sku', 'ad_units', 'spend', 'sales',
  'acos', 'brand', 'last_updated',
];

// ── Entry point ───────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now     = new Date().toISOString();
  const token   = await getAdToken();
  const months  = rollingMonths(13);
  const results = [];

  // ── 1. Pull SP report for all brands in one request (grouped by SKU) ───────
  // The ad profile covers all brands on the account. We request one report
  // that returns all SKUs, then split by skuPrefix per brand.
  let skuReportRows = [];
  let summaryReportRows = [];

  try {
    console.log('[sync-advertising] requesting SP SKU report...');
    skuReportRows = await fetchSpSkuReport(months, token);
    console.log(`[sync-advertising] SP SKU report: ${skuReportRows.length} rows`);
  } catch (err) {
    console.error('[sync-advertising] SP SKU report failed:', err.message);
    // Non-fatal — continue so summary still writes
  }

  try {
    console.log('[sync-advertising] requesting SP summary report...');
    summaryReportRows = await fetchSpSummaryReport(months, token);
    console.log(`[sync-advertising] SP summary report: ${summaryReportRows.length} rows`);
  } catch (err) {
    console.error('[sync-advertising] SP summary report failed:', err.message);
  }

  // ── 2. Per-brand: split, aggregate, write ──────────────────────────────────
  for (const brand of brands.filter(b => b.active)) {
    try {
      const prefix = brand.skuPrefix.toUpperCase();

      // ── Brand summary tab ──────────────────────────────────────────────────
      const summaryRows = buildSummaryRows(
        summaryReportRows.filter(r => (r.advertisedSku || r.sku || '').toUpperCase().startsWith(prefix)),
        months, brand.id, now
      );

      const summaryToken = await ensureTab(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS);
      await replaceRows(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS, summaryRows, summaryToken);
      console.log(`[sync-advertising] ${brand.id} summary — ${summaryRows.length} rows`);

      // ── SKU detail tab in ad orders sheet ─────────────────────────────────
      const brandSkuRows = skuReportRows.filter(r =>
        (r.advertisedSku || r.sku || '').toUpperCase().startsWith(prefix)
      );
      const skuRows = buildSkuRows(brandSkuRows, months, brand.id, now);

      // Trim rows older than TRIM_YEARS before writing
      const cutoff    = new Date().getFullYear() - TRIM_YEARS;
      const trimmed   = skuRows.filter(r => parseInt(r[0], 10) >= cutoff);
      const trimCount = skuRows.length - trimmed.length;
      if (trimCount > 0) {
        console.log(`[sync-advertising] ${brand.id} trimmed ${trimCount} rows older than ${TRIM_YEARS} years`);
      }

      const skuToken = await ensureTab(SHEET_AD_ORDERS, brand.tabName, SKU_HEADERS);
      await replaceRows(SHEET_AD_ORDERS, brand.tabName, SKU_HEADERS, trimmed, skuToken);
      console.log(`[sync-advertising] ${brand.id} sku detail — ${trimmed.length} rows`);

      results.push({ brand: brand.id, status: 'ok', summaryRows: summaryRows.length, skuRows: trimmed.length });
    } catch (err) {
      console.error(`[sync-advertising] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: now });
};

// ── SP SKU-level report ───────────────────────────────────────────────────────
// Groups by advertised SKU + date, giving us per-SKU per-month metrics.
// We request one report per month (same date chunking as summary).

async function fetchSpSkuReport(months, token) {
  const allRows = [];

  for (const { year, month, startDate, endDate } of months) {
    try {
      const body = {
        name: `SP_sku_${year}_${String(month).padStart(2,'0')}`,
        startDate,
        endDate,
        configuration: {
          adProduct:    'SPONSORED_PRODUCTS',
          groupBy:      ['advertised_asin'],
          columns:      [
            'advertisedSku',
            'advertisedAsin',
            'impressions',
            'clicks',
            'spend',
            'purchases14d',
            'unitsSoldClicks14d',
            'sales14d',
          ],
          reportTypeId: 'spAdvertisedProduct',
          timeUnit:     'SUMMARY',
          format:       'GZIP_JSON',
        },
      };

      const create   = await adRequest('POST', '/reporting/reports', token, body);
      const meta     = await pollAdReport(create.reportId, token, 90_000);
      const rows     = await downloadAdReport(meta.url);

      // Tag each row with year+month for later aggregation
      rows.forEach(r => { r._year = year; r._month = month; });
      allRows.push(...rows);
    } catch (err) {
      console.warn(`[sync-advertising] SKU report ${year}-${month} failed:`, err.message);
    }

    await sleep(2000);
  }

  return allRows;
}

// ── SP campaign-level summary report ─────────────────────────────────────────
// Groups by campaign for brand-level totals. Same structure as before.

async function fetchSpSummaryReport(months, token) {
  const allRows = [];

  for (const { year, month, startDate, endDate } of months) {
    try {
      const body = {
        name: `SP_summary_${year}_${String(month).padStart(2,'0')}`,
        startDate,
        endDate,
        configuration: {
          adProduct:    'SPONSORED_PRODUCTS',
          groupBy:      ['campaign'],
          columns:      ['impressions', 'clicks', 'spend', 'purchases14d', 'sales14d', 'unitsSoldClicks14d'],
          reportTypeId: 'spCampaigns',
          timeUnit:     'SUMMARY',
          format:       'GZIP_JSON',
        },
      };

      const create = await adRequest('POST', '/reporting/reports', token, body);
      const meta   = await pollAdReport(create.reportId, token, 90_000);
      const rows   = await downloadAdReport(meta.url);

      rows.forEach(r => { r._year = year; r._month = month; });
      allRows.push(...rows);
    } catch (err) {
      console.warn(`[sync-advertising] summary report ${year}-${month} failed:`, err.message);
    }

    await sleep(2000);
  }

  return allRows;
}

// ── Row builders ──────────────────────────────────────────────────────────────

// Brand-level monthly summary — one row per month
function buildSummaryRows(rows, months, brandId, now) {
  return months.map(({ year, month }) => {
    const monthRows = rows.filter(r => r._year === year && r._month === month);
    let impressions = 0, clicks = 0, spend = 0, sales = 0, adUnits = 0;

    monthRows.forEach(r => {
      impressions += r.impressions          || 0;
      clicks      += r.clicks               || 0;
      spend       += r.spend                || 0;
      sales       += r.sales14d             || 0;
      adUnits     += r.unitsSoldClicks14d   || 0;
    });

    const acos = sales  > 0 ? round2((spend / sales) * 100) : null;
    const roas = spend  > 0 ? round2(sales / spend)         : null;
    const ctr  = impressions > 0 ? round2((clicks / impressions) * 100) : 0;
    const cpc  = clicks > 0 ? round2(spend / clicks) : 0;

    return [year, month, impressions, clicks, round2(spend), round2(sales),
            acos, roas, adUnits, ctr, cpc, brandId, now];
  });
}

// SKU-level monthly rows — one row per SKU per month
// Normalizes SKU by stripping -SF suffix (FBM variant) to merge with FBA base.
function buildSkuRows(rows, months, brandId, now) {
  const output = [];

  for (const { year, month } of months) {
    const monthRows = rows.filter(r => r._year === year && r._month === month);

    // Aggregate by normalized SKU within this month
    const skuMap = {};
    monthRows.forEach(r => {
      const rawSku  = (r.advertisedSku || r.sku || '').toUpperCase().replace(/-SF$/i, '');
      if (!rawSku) return;
      if (!skuMap[rawSku]) skuMap[rawSku] = { adUnits: 0, spend: 0, sales: 0 };
      skuMap[rawSku].adUnits += r.unitsSoldClicks14d || 0;
      skuMap[rawSku].spend   += r.spend              || 0;
      skuMap[rawSku].sales   += r.sales14d            || 0;
    });

    Object.entries(skuMap).forEach(([sku, agg]) => {
      const acos = agg.sales > 0 ? round2((agg.spend / agg.sales) * 100) : null;
      output.push([
        year, month, sku,
        agg.adUnits, round2(agg.spend), round2(agg.sales),
        acos, brandId, now,
      ]);
    });
  }

  return output;
}

// ── Advertising API helpers ───────────────────────────────────────────────────

function adRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                   `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Amazon-Advertising-API-Scope':    process.env.SP_AD_PROFILE_ID,
      'Content-Type':                    'application/vnd.createasyncreportrequest.v3+json',
      'Content-Length':                  Buffer.byteLength(bodyStr),
    };
    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Ad API parse error (${res.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function pollAdReport(reportId, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await adRequest('GET', `/reporting/reports/${reportId}`, token, null);
    console.log(`[sync-advertising] poll ${reportId}: ${resp.status}`);
    if (resp.status === 'COMPLETED') return resp;
    if (resp.status === 'FAILED')    throw new Error(`Ad report ${reportId} FAILED: ${JSON.stringify(resp)}`);
    await sleep(6000);
  }
  throw new Error(`Ad report ${reportId} timed out after ${timeoutMs}ms`);
}

function downloadAdReport(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        zlib.gunzip(buf, (err, decoded) => {
          if (err) {
            // Fall back to plain JSON if not gzipped
            try { resolve(JSON.parse(buf.toString())); }
            catch (e) { reject(new Error('Ad report: not gzipped and not valid JSON')); }
            return;
          }
          try { resolve(JSON.parse(decoded.toString())); }
          catch (e) { reject(new Error('Ad report: gzip decoded but not valid JSON')); }
        });
      });
    }).on('error', reject);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rollingMonths(n) {
  const months = [];
  const now    = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d       = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year    = d.getFullYear();
    const month   = d.getMonth() + 1;
    const pad     = x => String(x).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    months.push({
      year, month,
      startDate: `${year}${pad(month)}01`,
      endDate:   `${year}${pad(month)}${pad(lastDay)}`,
    });
  }
  return months;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
