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
 *   serverless timeout, and fragile even when it happened to finish in time.
 *
 * Why this version doesn't:
 *   getSellingPartnerMetrics is a direct, synchronous POST — no report
 *   queue, no polling, no waiting on Amazon to generate a file. One call,
 *   with aggregationFrequency=MONTH over a 13-month window, returns all
 *   13 monthly ACTIVE_SUBSCRIPTIONS values (plus SUBSCRIBER_RETENTION) in
 *   a single response. Rate limit on this endpoint is 1 req/sec burst 1 —
 *   trivial to respect when you only need one call per brand.
 *
 * IMPORTANT — verify before relying on this in production:
 *   Amazon's public reference for getSellingPartnerMetrics doesn't expose
 *   a full example response body, so the exact field names in
 *   extractMetricSeries() below are a best-effort guess based on the
 *   documented request shape (metricType, values, interval.startDate).
 *   The first real run logs the raw response — if extractMetricSeries()
 *   comes back empty, check that log and adjust the field names to match
 *   what Amazon actually sends back.
 *
 * OPEN QUESTION — brand scoping:
 *   Unlike sync-orders.js (which filters by SKU prefix), this endpoint has
 *   no documented per-brand/SKU filter. If this SP-API connection's seller
 *   account covers more than just this brand, these numbers may need a
 *   different scoping approach (offer-level listOfferMetrics filtered by
 *   ASIN/SKU, e.g.) rather than the seller-level metrics used here.
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

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  const now = new Date().toISOString();

  for (const brand of brands.filter(b => b.active)) {
    try {
      console.log(`[sync-subscriptions] starting ${brand.id}`);
      const rows  = await fetchSubscriptionRows(brand, now);
      const token = await ensureTab(sheets.subscriptions, brand.tabName, HEADERS);
      await replaceRows(sheets.subscriptions, brand.tabName, HEADERS, rows, token);
      results.push({ brand: brand.id, status: 'ok', rows: rows.length });
      console.log(`[sync-subscriptions] ${brand.id} — ${rows.length} rows written`);
    } catch (err) {
      console.error(`[sync-subscriptions] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: now });
};

async function fetchSubscriptionRows(brand, now) {
  const { startDate, endDate } = trailingMonthRange(MONTHS_OF_HISTORY);

  const body = {
    aggregationFrequency: 'MONTH',
    timeInterval: { startDate, endDate },
    metrics: ['ACTIVE_SUBSCRIPTIONS', 'SUBSCRIBER_RETENTION'],
    timePeriodType: 'PERFORMANCE',
    marketplaceId: process.env.SP_MARKETPLACE_ID,
    programTypes: ['SUBSCRIBE_AND_SAVE'],
  };

  const resp = await spRequest(
    'POST',
    `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`,
    {},
    body
  );

  // Log the raw shape on every run (truncated) until the parser below is
  // confirmed correct against a real response — cheap insurance.
  console.log(`[sync-subscriptions] ${brand.id} raw response sample:`, JSON.stringify(resp).slice(0, 800));

  const activeSeries    = extractMetricSeries(resp, 'ACTIVE_SUBSCRIPTIONS');
  const retentionSeries = extractMetricSeries(resp, 'SUBSCRIBER_RETENTION');

  if (activeSeries.length === 0) {
    throw new Error('No ACTIVE_SUBSCRIPTIONS data returned — check the raw response log and adjust extractMetricSeries()');
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

/**
 * Normalizes one metric's time series out of the getSellingPartnerMetrics
 * response into [{ year, month, value }, ...].
 *
 * See the IMPORTANT note at the top of this file — these field names are
 * a best-effort guess pending a confirmed real response. Adjust here if
 * the first live run's logged raw response uses different key names.
 */
function extractMetricSeries(resp, metricType) {
  const metricsArray = resp?.metrics || resp?.payload?.metrics || [];
  const match = metricsArray.find(m => m.metricType === metricType || m.metric === metricType);
  if (!match) return [];

  const values = match.values || match.dataPoints || [];
  return values
    .map(v => {
      const dateStr = v.interval?.startDate || v.startDate || v.date;
      const d = new Date(dateStr);
      return {
        year:  d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        value: v.value ?? v.metricValue ?? null,
      };
    })
    .filter(v => !isNaN(v.year));
}

// Builds a { startDate, endDate } window covering the last `monthsBack`
// full calendar months, ending at the start of the current (incomplete)
// month — matching the "13 trailing months" the dashboard chart wants.
function trailingMonthRange(monthsBack) {
  const now         = new Date();
  const endOfWindow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startOfWindow = new Date(Date.UTC(endOfWindow.getUTCFullYear(), endOfWindow.getUTCMonth() - (monthsBack - 1), 1));

  return {
    startDate: startOfWindow.toISOString().slice(0, 19) + 'Z',
    // 10-minute safety buffer, matching the pattern used elsewhere in this codebase
    endDate: new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z',
  };
}
