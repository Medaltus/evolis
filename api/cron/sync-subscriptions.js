/**
 * api/cron/sync-subscriptions.js
 * Nightly cron — syncs Subscribe & Save metrics to Google Sheets.
 * Runs at 3:30 AM UTC.
 *
 * REWRITTEN to use the Replenishment API's getSellingPartnerMetrics
 * endpoint instead of the old GET_FBA_SNS_PERFORMANCE_DATA report flow.
 *
 * Why the old version timed out:
 *   It requested a brand-new Amazon REPORT for each of 15 months,
 *   sequentially — each report has its own async generate-then-poll cycle
 *   (up to 90s), plus a mandatory 3s sleep between iterations. Worst case
 *   that's 15 report cycles in one function call — well past any
 *   serverless timeout.
 *
 * Why this version doesn't:
 *   getSellingPartnerMetrics is a direct, synchronous POST — no report
 *   queue, no polling. One call per brand, with aggregationFrequency=MONTH
 *   over a 13-month window, returns all 13 monthly ACTIVE_SUBSCRIPTIONS
 *   values (plus SUBSCRIBER_RETENTION) at once. Rate limit is 1 req/sec
 *   burst 1 — respected via a 1.1s delay between brands.
 *
 * Response shape — CONFIRMED against a real logged response (2026-07):
 *   { "metrics": [ { "timeInterval": {startDate, endDate}, "activeSubscriptions": N, ... }, ... ] }
 *   i.e. each array entry is a TIME PERIOD, with every requested metric as
 *   a camelCase key directly on it — not a per-metric series list.
 *
 * Brand scoping — CONFIRMED via /api/test-subscriptions-filter.js (2026-07):
 *   This SP-API connection's account covers ALL Medaltus brands combined —
 *   an unfiltered call returns the same whole-account number for every
 *   brand. Fixed by passing `filters.asins` scoped to just that brand's
 *   ASINs (confirmed empirically: Evolis and Skinuva returned distinct,
 *   plausible numbers when filtered, vs. identical inflated numbers
 *   unfiltered). ASINs come from the same master ASIN→brand sheet
 *   sync-advertising-process.js already reads.
 *
 * Sheet: amazon-subscriptions
 * Columns: year, month, active_subscriptions, retention_90_day,
 *          brand, last_updated
 */

const { spRequest }              = require('../_spauth');
const { ensureTab, replaceRows } = require('../config/_sheets_client');
const brands                     = require('../config/brands');
const sheets                     = require('../config/sheets');

const HEADERS = [
  'year', 'month', 'active_subscriptions',
  'retention_90_day', 'brand', 'last_updated',
];

const MONTHS_OF_HISTORY   = 13; // matches the dashboard's 13-month trailing chart
const REPLENISHMENT_BASE  = '/replenishment/2022-11-07';
// getSellingPartnerMetrics is rate-limited to 1 req/sec, burst 1. Looping
// over 15 brands back-to-back with no delay hit "QuotaExceeded" on a real
// run — this sleep keeps every call at least 1.1s apart.
const RATE_LIMIT_DELAY_MS = 1100;

const PRODUCT_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const PRODUCT_SHEET_GID = '164358627'; // ASIN → brand map tab (same one sync-advertising-process.js uses)

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  const now = new Date().toISOString();

  // Fetch once, reuse for every brand — no reason to re-read the sheet 15 times.
  let asinBrandMap;
  try {
    asinBrandMap = await fetchAsinBrandMap();
  } catch (err) {
    console.error('[sync-subscriptions] failed to load ASIN→brand map:', err.message);
    return res.status(500).json({ error: 'Failed to load ASIN→brand map', detail: err.message });
  }

  let isFirstBrand = true;

  for (const brand of brands.filter(b => b.active)) {
    if (!isFirstBrand) await sleep(RATE_LIMIT_DELAY_MS);
    isFirstBrand = false;

    const brandAsins = Object.entries(asinBrandMap)
      .filter(([, tabName]) => tabName === brand.tabName)
      .map(([asin]) => asin);

    // No ASINs mapped for this brand — do NOT fall back to an unfiltered
    // call. That would silently write the whole-account number into this
    // brand's tab again, exactly the bug we just fixed.
    if (brandAsins.length === 0) {
      console.warn(`[sync-subscriptions] ${brand.id} — no ASINs found in master sheet, skipping (not writing unfiltered data)`);
      results.push({ brand: brand.id, status: 'skipped', reason: 'no ASINs in master sheet' });
      continue;
    }

    try {
      console.log(`[sync-subscriptions] starting ${brand.id} (${brandAsins.length} ASINs)`);
      const rows  = await fetchSubscriptionRows(brand, brandAsins, now);
      const token = await ensureTab(sheets.subscriptions, brand.tabName, HEADERS);
      await replaceRows(sheets.subscriptions, brand.tabName, HEADERS, rows, token);
      results.push({ brand: brand.id, status: 'ok', rows: rows.length, asinCount: brandAsins.length });
      console.log(`[sync-subscriptions] ${brand.id} — ${rows.length} rows written`);
    } catch (err) {
      console.error(`[sync-subscriptions] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: now });
};

async function fetchSubscriptionRows(brand, brandAsins, now) {
  const { startDate, endDate } = trailingMonthRange(MONTHS_OF_HISTORY);

  const body = {
    aggregationFrequency: 'MONTH',
    timeInterval: { startDate, endDate },
    metrics: ['ACTIVE_SUBSCRIPTIONS', 'SUBSCRIBER_RETENTION'],
    timePeriodType: 'PERFORMANCE',
    marketplaceId: process.env.SP_MARKETPLACE_ID,
    programTypes: ['SUBSCRIBE_AND_SAVE'],
    filters: { asins: brandAsins },
  };

  const resp = await spRequest(
    'POST',
    `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`,
    {},
    body
  );

  const activeSeries    = extractMetricSeries(resp, 'activeSubscriptions');
  const retentionSeries = extractMetricSeries(resp, 'subscriberRetention');

  if (activeSeries.length === 0) {
    console.error(`[sync-subscriptions] ${brand.id} — empty response:`, JSON.stringify(resp));
    throw new Error('No ACTIVE_SUBSCRIPTIONS data returned — see logged raw response');
  }

  const retentionByMonth = {};
  retentionSeries.forEach(({ year, month, value }) => {
    retentionByMonth[`${year}-${month}`] = value;
  });

  return activeSeries.map(({ year, month, value }) => [
    year,
    month,
    value,
    retentionByMonth[`${year}-${month}`] ?? null,
    brand.id,
    now,
  ]);
}

// Normalizes the getSellingPartnerMetrics response into [{ year, month, value }, ...]
// for a given metric key. See the confirmed shape documented at the top of this file.
function extractMetricSeries(resp, metricKey) {
  const periods = resp?.metrics || [];
  return periods
    .filter(p => p[metricKey] !== undefined && p[metricKey] !== null)
    .map(p => {
      const dateStr = p.timeInterval?.startDate;
      const d = new Date(dateStr);
      return {
        year:  d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        value: p[metricKey],
      };
    })
    .filter(v => !isNaN(v.year));
}

// Same ASIN→brand lookup sync-advertising-process.js uses, kept in sync
// intentionally — if that mapping logic ever changes, update both places.
async function fetchAsinBrandMap() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${PRODUCT_SHEET_ID}/export?format=csv&gid=${PRODUCT_SHEET_GID}`;
  const resp   = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master ASIN sheet: ${resp.status}`);
  const csv = await resp.text();
  const map = {};
  csv.trim().split('\n').slice(1).forEach(line => {
    const cols      = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const asin      = (cols[0] || '').toUpperCase();
    const brandName = (cols[3] || '').toLowerCase().trim();
    if (!asin || !brandName) return;
    const matched = brands.find(b =>
      b.active && (
        brandName === b.id.toLowerCase() ||
        brandName === b.displayName?.toLowerCase() ||
        brandName.includes(b.id.toLowerCase())
      )
    );
    if (matched) map[asin] = matched.tabName;
  });
  return map;
}

// Builds a { startDate, endDate } window covering the last `monthsBack`
// full calendar months, ending at the start of the current (incomplete)
// month — matching the "13 trailing months" the dashboard chart wants.
function trailingMonthRange(monthsBack) {
  const now           = new Date();
  const endOfWindow    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startOfWindow  = new Date(Date.UTC(endOfWindow.getUTCFullYear(), endOfWindow.getUTCMonth() - (monthsBack - 1), 1));

  return {
    startDate: startOfWindow.toISOString().slice(0, 19) + 'Z',
    // 10-minute safety buffer, matching the pattern used elsewhere in this codebase
    endDate: new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z',
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
