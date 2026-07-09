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
 * retention_90_day uses SUBSCRIBER_RETENTION with a filters.brandNames
 * call (separate from the active_subscriptions call, which uses
 * filters.asins — the two metrics don't support the same filter type).
 * Amazon's exact registered brand names were confirmed directly from
 * Seller Central (2026-07-09) and live in brands.js as `amazonBrandName`.
 *
 * CONFIRMED (2026-07-09) two ways — a real API response, AND Seller
 * Central's own "Subscriber Retention" widget for the same account —
 * that this metric returns ONE blended value for the WHOLE requested
 * window, not a per-month series. So it deliberately reuses the SAME
 * 13-month window as active_subscriptions (a narrower "just last month"
 * window was tried and returns empty — a cohort from last month hasn't
 * reached its 90-day mark yet), and that one value is written only to
 * the current (last full) month's row — every other month keeps
 * whatever it already had.
 *
 * A retention failure for one brand doesn't block that brand's
 * active_subscriptions data from writing — the two are fetched and
 * written independently.
 *
 * The `asins` filter caps at 20 items per call — brands with more ASINs
 * than that get chunked into multiple calls and summed per month.
 *
 * Historical accumulation: each run only ever RECOMPUTES the trailing
 * MONTHS_OF_HISTORY window, but the sheet keeps growing — existing rows
 * outside that window are preserved, not wiped, on every write. Only the
 * months this run actually fetched fresh data for get overwritten.
 *
 * Sheet: amazon-subscriptions
 * Columns: year, month, active_subscriptions, retention_90_day,
 *          brand, last_updated
 */

const { spRequest }                         = require('../_spauth');
const { ensureTab, readRows, replaceRows }  = require('../config/_sheets_client');
const brands                                = require('../config/brands');
const sheets                                = require('../config/sheets');

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
      const newRows = await fetchSubscriptionRows(brand, brandAsins, now);
      const token   = await ensureTab(sheets.subscriptions, brand.tabName, HEADERS);

      // Accumulate history instead of wiping the tab each run: keep every
      // existing row, but overwrite any month THIS run actually recomputed
      // (the trailing MONTHS_OF_HISTORY window) with fresh values. Months
      // older than that window — which would otherwise get destroyed by a
      // full replaceRows every run — are left exactly as they were.
      const existingRaw  = await readRows(sheets.subscriptions, brand.tabName);
      const mergedByKey  = {};
      (existingRaw || []).forEach(r => {
        const y = parseInt(r.year, 10), m = parseInt(r.month, 10);
        if (!y || !m) return;
        mergedByKey[`${y}-${m}`] = [r.year, r.month, r.active_subscriptions, r.retention_90_day, r.brand, r.last_updated];
      });
      newRows.forEach(row => { mergedByKey[`${row[0]}-${row[1]}`] = row; });

      const mergedRows = Object.values(mergedByKey).sort((a, b) => {
        const ay = parseInt(a[0], 10), by = parseInt(b[0], 10);
        const am = parseInt(a[1], 10), bm = parseInt(b[1], 10);
        return ay !== by ? ay - by : am - bm;
      });

      await replaceRows(sheets.subscriptions, brand.tabName, HEADERS, mergedRows, token);
      results.push({ brand: brand.id, status: 'ok', totalRows: mergedRows.length, refreshedThisRun: newRows.length, asinCount: brandAsins.length });
      console.log(`[sync-subscriptions] ${brand.id} — ${mergedRows.length} total rows (${newRows.length} refreshed this run)`);
    } catch (err) {
      console.error(`[sync-subscriptions] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: now });
};

async function fetchSubscriptionRows(brand, brandAsins, now) {
  const { startDate, endDate } = trailingMonthRange(MONTHS_OF_HISTORY);

  const activeSeries = await fetchActiveSubscriptions(brandAsins, startDate, endDate);

  if (activeSeries.length === 0) {
    throw new Error('No ACTIVE_SUBSCRIPTIONS data returned — see logged raw response');
  }

  // SUBSCRIBER_RETENTION only supports filters.brandNames (not asins) —
  // confirmed via Amazon's validation error (2026-07-09). Amazon's exact
  // registered brand names were confirmed directly from Seller Central and
  // added to brands.js as `amazonBrandName`. This is a SEPARATE call (its
  // own rate-limit delay) from active_subscriptions, and its failure is
  // non-fatal — a brand's active_subscriptions data should still write even
  // if retention has a problem, rather than losing both over one issue.
  //
  // CONFIRMED (2026-07-09) two ways — a real API response, AND Seller
  // Central's own "Subscriber Retention" widget showing the exact same
  // pattern for the exact same account (évolis, 90 Days: 70.4%, computed
  // over the widget's full selected ~13-month date range) — that this
  // metric returns ONE blended value for the WHOLE requested window, not
  // a per-month series. A narrower "just last month" window was tried and
  // returns empty, because a 90-day cohort from last month hasn't reached
  // its 90-day mark yet. So this deliberately reuses the SAME wide window
  // as active_subscriptions, and the one resulting value is written only
  // to the current (last full) month's row — every other month keeps
  // whatever it already had.
  let retentionByMonth = {};
  if (brand.amazonBrandName) {
    await sleep(RATE_LIMIT_DELAY_MS);
    try {
      const value = await fetchSubscriberRetention(brand.amazonBrandName, startDate, endDate);
      if (value == null) {
        console.warn(`[sync-subscriptions] ${brand.id} — SUBSCRIBER_RETENTION call succeeded but returned no value (writing null retention this run)`);
      } else {
        const current = currentRowKey();
        retentionByMonth[`${current.year}-${current.month}`] = value;
      }
    } catch (err) {
      console.warn(`[sync-subscriptions] ${brand.id} — retention fetch failed, writing null retention this run:`, err.message);
    }
  } else {
    console.warn(`[sync-subscriptions] ${brand.id} — no amazonBrandName set in brands.js, skipping retention`);
  }

  return activeSeries.map(({ year, month, value }) => [
    year,
    month,
    value,
    retentionByMonth[`${year}-${month}`] ?? null,
    brand.id,
    now,
  ]);
}

async function fetchSubscriberRetention(amazonBrandName, startDate, endDate) {
  const body = {
    aggregationFrequency: 'MONTH',
    timeInterval: { startDate, endDate },
    metrics: ['SUBSCRIBER_RETENTION'],
    timePeriodType: 'PERFORMANCE',
    marketplaceId: process.env.SP_MARKETPLACE_ID,
    programTypes: ['SUBSCRIBE_AND_SAVE'],
    filters: { brandNames: [amazonBrandName] },
  };

  // Retry-on-429 — same gap sync-advertising-request.js had before we fixed
  // it there. A real QuotaExceeded showed up on this exact call in testing —
  // but as a NORMALLY RESOLVED response body ({"errors":[{"code":"QuotaExceeded",...}]}),
  // not a thrown exception. So we check both: a thrown error (in case
  // spRequest ever does throw for other failure modes) AND an errors[] array
  // in a successfully-resolved body.
  const MAX_RETRIES = 3;
  let resp;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let thrown = null;
    try {
      resp = await spRequest('POST', `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`, {}, body);
    } catch (err) {
      thrown = err;
    }

    const errorCode = thrown?.message || resp?.errors?.[0]?.code || '';
    const isThrottled = /quota|429|throttl/i.test(errorCode);

    if (!isThrottled) {
      if (thrown) throw thrown; // genuine non-throttle failure — don't swallow it
      break; // success (or a non-throttle error body we'll log below)
    }

    if (attempt < MAX_RETRIES) {
      const waitSec = 2 * attempt;
      console.warn(`[sync-subscriptions] retention call throttled (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }
    // Exhausted retries on a genuine throttle — fall through and let the
    // "no value found" branch below log the raw response and return null.
  }

  // CONFIRMED shape (2026-07-09): one object covering the whole requested
  // interval, e.g. { subscriberRetentionFor90Days: 71.05, timeInterval: {...} }
  // — NOT a per-month series like activeSubscriptions.
  const period = resp?.metrics?.[0];
  const value  = period?.subscriberRetentionFor90Days;

  if (value == null) {
    console.warn(`[sync-subscriptions] SUBSCRIBER_RETENTION raw response (no value found):`, JSON.stringify(resp));
    return null;
  }
  return value;
}

// The last full calendar month — where the single retention value gets
// written. Same "last full month" concept used elsewhere in this codebase
// (e.g. the Stewardship dashboard charts), just needed here as a plain
// year/month lookup rather than a date-range builder.
function currentRowKey() {
  const now = new Date();
  const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// The `asins` filter caps at 20 items (confirmed via Amazon's error for a
// 21-ASIN brand). Chunk into batches of 20 and sum per month — this is
// correct because active subscriptions per ASIN sum linearly across any
// partition of a brand's ASIN list.
const MAX_ASINS_PER_FILTER = 20;

async function fetchActiveSubscriptions(brandAsins, startDate, endDate) {
  const chunks = chunkArray(brandAsins, MAX_ASINS_PER_FILTER);
  const monthTotals = {}; // 'YYYY-M' -> { year, month, value }

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_DELAY_MS); // separate rate-limited calls, same as between brands

    const body = {
      aggregationFrequency: 'MONTH',
      timeInterval: { startDate, endDate },
      metrics: ['ACTIVE_SUBSCRIPTIONS'],
      timePeriodType: 'PERFORMANCE',
      marketplaceId: process.env.SP_MARKETPLACE_ID,
      programTypes: ['SUBSCRIBE_AND_SAVE'],
      filters: { asins: chunks[i] },
    };

    const resp = await spRequest('POST', `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`, {}, body);
    const series = extractMetricSeries(resp, 'activeSubscriptions');

    series.forEach(({ year, month, value }) => {
      const key = `${year}-${month}`;
      if (!monthTotals[key]) monthTotals[key] = { year, month, value: 0 };
      monthTotals[key].value += value;
    });
  }

  return Object.values(monthTotals);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
