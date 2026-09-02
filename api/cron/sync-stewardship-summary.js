/**
 * api/cron/sync-stewardship-summary.js
 * Nightly — pre-computes everything the Brand Stewardship dashboard page
 * needs, per brand per month, and writes it to a small summary sheet.
 *
 * WHY THIS EXISTS:
 *   Before this, the dashboard did all of this math IN THE BROWSER, on
 *   every single page load: fetch the full orders history (sync +
 *   historical, potentially thousands of rows), fetch the entire master
 *   ASIN/SKU list (hundreds of rows) just to compute Vine, and re-scan all
 *   of it ~15 times (once per chart month, plus current/prior month for
 *   KPIs). That's real, repeated client-side work for numbers that don't
 *   change until the next cron run. This cron does that work ONCE, here,
 *   and the dashboard just reads the small result.
 *
 * Output sheet: SHEET_STEWARDSHIP_SUMMARY, one tab per brand.
 * Columns: year, month, ads_spend, impressions, clicks, ad_units,
 *          promos_total, vine_total, revenue, units,
 *          amazon_subscriptions, website_subscriptions, total_subscriptions,
 *          last_updated
 *
 * One row per (brand, year, month) that has ANY data in ANY source —
 * covering full history, not just a trailing window. The dashboard can
 * then trivially slice out "last 13 months" or sum "all rows" for
 * Launch to Date without doing any of the heavy lifting itself.
 *
 * Sources (all read via authenticated Sheets API, not public CSV — more
 * reliable than what the client-side dashboard has to use):
 *   Orders (sync + historical) — promos_total = promotion_discount +
 *     "Amazon Sale Promotions", summed per month.
 *   AD_SUMMARY (SHEET_ADVERTISING) — ads_spend, impressions, clicks, ad_units.
 *   Revenue history — revenue, units.
 *   Master ASIN/SKU list, "Product Short Name" tab, column F — Vine:
 *     $200 x however many SKUs enrolled that month, per brand.
 *   Subscriptions cache — written here as amazon_subscriptions (source
 *     column is still named active_subscriptions). website_subscriptions
 *     is a placeholder (0) until the Shopify subscriptions cron exists.
 *     total_subscriptions = amazon_subscriptions + website_subscriptions.
 *
 * Runs nightly after the other syncs (advertising, revenue, orders) have
 * already updated their sheets for the day.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands = require('../config/brands');

const SYNC_SHEET_ID       = '1SiYu8e2-Pfi14Aiuf6SAFytWVXb4_dtdNFT6wvLFPok'; // sync-orders (rolling)
const HISTORICAL_SHEET_ID = '1T5y-EOs21s9evwR4SR58EYsM2Vyk0awBqpE-kEnBlQU'; // historical order cache
const REVENUE_SHEET_ID    = '1equxdiqpzonA5TgsrKzbrpq92QHyJP8kQ2RoUiYmank'; // revenue history
const AD_SUMMARY_SHEET_ID = process.env.SHEET_ADVERTISING || '13cN301QZxkEGy6-8LfdzB8zmsHhUKwZqz6lsXKUJcnI';
const SUMMARY_SHEET_ID    = process.env.SHEET_STEWARDSHIP_SUMMARY; // NEW - must be created + set before deploying

// Subscriptions cache — column C is "active_subscriptions" per brand tab.
// ASSUMPTION pending confirmation: this tab has year/month columns to match
// against like AD_SUMMARY does. If it's actually a live current-snapshot
// with no month history, this will need a different join strategy — flag
// this to Jaclyn before trusting this column's output.
const SUBSCRIPTIONS_SHEET_ID = process.env.SHEET_SUBSCRIPTIONS || '1i94keQYY21aSh8KP-ZpvqO1MF2g0nX5ThMD93y3wU48';

const MASTER_SHEET_ID = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=ASIN, B=SKU, C=Name, D=Brand, E=Price, F=Date Enrolled in Vine

const VINE_COST_PER_ENROLLMENT = 200;

const HEADERS = [
  'year', 'month',
  'ads_spend', 'impressions', 'clicks', 'ad_units',
  'promos_total', 'vine_total',
  'revenue', 'units',
  'amazon_subscriptions', 'website_subscriptions', 'total_subscriptions',
  'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUMMARY_SHEET_ID) {
    return res.status(500).json({ error: 'SHEET_STEWARDSHIP_SUMMARY env var is not set - create the sheet and set this before running.' });
  }

  const now = toEstIso(new Date()); // FIXED 2026-08-19 -- was UTC

  let vineByBrand;
  try {
    vineByBrand = await fetchVineByBrand();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read master ASIN/SKU list for Vine', detail: err.message });
  }

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const [syncRows, histRows, adRows, revRows, subRows] = await Promise.all([
        readRows(SYNC_SHEET_ID, brand.tabName).catch(err => { console.warn(`[sync-stewardship-summary] ${brand.id} sync read failed: ${err.message}`); return []; }),
        readRows(HISTORICAL_SHEET_ID, brand.tabName).catch(err => { console.warn(`[sync-stewardship-summary] ${brand.id} historical read failed: ${err.message}`); return []; }),
        readRows(AD_SUMMARY_SHEET_ID, brand.tabName).catch(err => { console.warn(`[sync-stewardship-summary] ${brand.id} ad_summary read failed: ${err.message}`); return []; }),
        readRows(REVENUE_SHEET_ID, brand.tabName).catch(err => { console.warn(`[sync-stewardship-summary] ${brand.id} revenue read failed: ${err.message}`); return []; }),
        readRows(SUBSCRIPTIONS_SHEET_ID, brand.tabName).catch(err => { console.warn(`[sync-stewardship-summary] ${brand.id} subscriptions read failed: ${err.message}`); return []; }),
      ]);

      // Diagnostic — shows exactly which source(s) came back empty per
      // brand. A 0 here vs. a real row count is the difference between "no
      // tab / read failed" and "tab exists but nothing matched during the
      // year/month .find() below" — the .catch() above only fires on an
      // actual thrown error, so this line still matters even when nothing
      // above logged a warning. TEMPORARY — remove once pbj/dearcloud's
      // zero-value bug is root-caused. Added 2026-07-13.
      console.log(`[sync-stewardship-summary] ${brand.id} — sync=${syncRows.length} hist=${histRows.length} ad=${adRows.length} rev=${revRows.length} sub=${subRows.length}`);

      const allOrderRows = [...(syncRows || []), ...(histRows || [])];

      // ensureTab must run before we try to read the summary tab's own
      // existing data below — on a brand-new SUMMARY_SHEET_ID setup the tab
      // may not exist yet, and readRows would just throw.
      const token = await ensureTab(SUMMARY_SHEET_ID, brand.tabName, HEADERS);

      // Preserve any manually-pasted website_subscriptions data. This cron
      // does a full clear+rewrite of every column on every run (replaceRows
      // has no row-level patch), so without this, the very next run after
      // pasting historical numbers into that column would wipe them back to
      // 0 — this reads what's already there FIRST so it can be carried
      // forward instead of overwritten. Added 2026-07-13.
      const existingSummaryRows = await readRows(SUMMARY_SHEET_ID, brand.tabName).catch(() => []);
      const existingWebSubsByMonth = {};
      // FIXED 2026-08-28 per Jaclyn — generalized from a
      // website_subscriptions-only map to a full per-month row map. The
      // original only preserved website_subscriptions specifically; every
      // other column (ads_spend, revenue, units, vine_total, etc.) still
      // silently zeroed out for any manually-added historical month with
      // no matching live-source row, since each column's own computation
      // below unconditionally defaulted to 0 when its live source was
      // missing. This map lets every column fall back to whatever's
      // already in the sheet, not just column L.
      const existingRowsByMonth = {};
      existingSummaryRows.forEach(r => {
        if (!r.year || !r.month) return;
        const key = monthKey(r.year, r.month);
        existingRowsByMonth[key] = r;
        const val = r.website_subscriptions;
        if (val !== '' && val != null) {
          existingWebSubsByMonth[key] = val;
        }
      });

      const promosByMonth = {};
      allOrderRows.forEach(r => {
        const ym = (r.date || '').slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(ym)) return;
        const amt = parseAmt(r.promotion_discount) + parseAmt(r['Amazon Sale Promotions']);
        promosByMonth[ym] = (promosByMonth[ym] || 0) + amt;
      });

      const vineByMonth = vineByBrand[brand.tabName] || {};

      const allMonths = new Set();
      (adRows || []).forEach(r => { if (r.year && r.month) allMonths.add(monthKey(r.year, r.month)); });
      Object.keys(promosByMonth).forEach(k => allMonths.add(k));
      Object.keys(vineByMonth).forEach(k => allMonths.add(k));
      (revRows || []).forEach(r => { if (r.YEAR && r.MONTH) allMonths.add(monthKey(r.YEAR, r.MONTH)); });
      (subRows || []).forEach(r => { if (r.year && r.month) allMonths.add(monthKey(r.year, r.month)); });
      // FIXED 2026-08-28 per Jaclyn — real incident: manually-added
      // historical rows (months with no corresponding data in ANY of the
      // 5 live sources above) were being permanently deleted every time
      // this cron ran. The existingWebSubsByMonth preservation logic
      // above only carries a VALUE forward for a month that already
      // makes it into allMonths some other way — it never adds a month
      // to allMonths on its own. Since outRows only ever contains months
      // in allMonths, and replaceRows() below clears the whole tab before
      // writing, any month that only existed because it was manually
      // added — with zero live-source data — was silently wiped on the
      // very next run, regardless of what existingWebSubsByMonth
      // preserved for it. Adding every existing row's month here fixes
      // this at the root: any month already present in the sheet now
      // always survives, whether or not any live source has data for it.
      existingSummaryRows.forEach(r => { if (r.year && r.month) allMonths.add(monthKey(r.year, r.month)); });

      const outRows = Array.from(allMonths).sort().map((ym, idx) => {
        const [y, m] = ym.split('-').map(n => parseInt(n, 10));
        const adRow = (adRows || []).find(r => parseInt(r.year, 10) === y && parseInt(r.month, 10) === m);
        const revRow = (revRows || []).find(r => parseInt(r.YEAR, 10) === y && parseInt(r.MONTH, 10) === m);
        const subRow = (subRows || []).find(r => parseInt(r.year, 10) === y && parseInt(r.month, 10) === m);
        // FIXED 2026-08-28 — see the note on existingRowsByMonth above.
        // Used as a fallback below for every column whose live source has
        // nothing for this month, so a manually-added historical month
        // keeps its real values instead of getting zeroed out.
        const existingRow = existingRowsByMonth[ym] || null;

        const activeSubscriptions = subRow ? parseIntSafe(subRow.active_subscriptions)
          : (existingRow ? parseIntSafe(existingRow.amazon_subscriptions) : 0);
        // Carry forward whatever's already in website_subscriptions (e.g.
        // manually pasted historical data or the future Shopify cron's
        // output) instead of overwriting it with 0 every run.
        const websiteSubscriptions = existingWebSubsByMonth[ym] ?? 0;

        // total_subscriptions — CHANGED 2026-08-04: was a live in-sheet
        // formula (`=K{row}+L{row}`) referencing this sheet's OWN
        // amazon_subscriptions column. Computing it directly in JS instead:
        // (1) matches the actual intended source — activeSubscriptions is
        // already read straight from SHEET_SUBSCRIPTIONS' active_subscriptions
        // column above, so summing it with websiteSubscriptions here is the
        // real computation, not a dependency on K reflecting that value
        // correctly; (2) removes a formula-string write that was the likely
        // cause of total_subscriptions AND last_updated (the very next
        // column) both coming out blank — a failed/mishandled formula write
        // taking the rest of that row's write down with it.
        const totalSubscriptions = activeSubscriptions + parseIntSafe(websiteSubscriptions);

        // promosByMonth/vineByMonth check KEY EXISTENCE, not just a truthy
        // value — a genuinely-zero promo/vine total for a month with real
        // order data is a valid computed 0, not a sign of missing data,
        // so it should NOT fall back to the existing sheet value in that
        // case. Only fall back when the month has no live order data at
        // all (key doesn't exist in the map).
        const promosVal = (ym in promosByMonth) ? round2(promosByMonth[ym])
          : (existingRow ? parseAmt(existingRow.promos_total) : 0);
        const vineVal = (ym in vineByMonth) ? vineByMonth[ym]
          : (existingRow ? parseAmt(existingRow.vine_total) : 0);

        return [
          y, m,
          adRow ? parseAmt(adRow.spend) : (existingRow ? parseAmt(existingRow.ads_spend) : 0),
          adRow ? (parseIntSafe(adRow.impressions) || 0) : (existingRow ? parseIntSafe(existingRow.impressions) : 0),
          adRow ? (parseIntSafe(adRow.clicks) || 0) : (existingRow ? parseIntSafe(existingRow.clicks) : 0),
          adRow ? (parseIntSafe(adRow.ad_units) || 0) : (existingRow ? parseIntSafe(existingRow.ad_units) : 0),
          promosVal,
          vineVal,
          revRow ? parseAmt(revRow.REVENUE) : (existingRow ? parseAmt(existingRow.revenue) : 0),
          revRow ? (parseIntSafe(revRow['UNITS SOLD']) || 0) : (existingRow ? parseIntSafe(existingRow.units) : 0),
          activeSubscriptions,
          websiteSubscriptions,
          totalSubscriptions,
          now,
        ];
      });

      await replaceRows(SUMMARY_SHEET_ID, brand.tabName, HEADERS, outRows, token, 'USER_ENTERED');

      results.push({ brand: brand.id, status: 'ok', months: outRows.length });
      console.log(`[sync-stewardship-summary] ${brand.id} - ${outRows.length} months written`);
    } catch (err) {
      console.error(`[sync-stewardship-summary] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ results, timestamp: now });
};

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ADDED 2026-08-14 — shared-SKU-prefix disambiguation (skinuva/skinuva-ca
// share prefix 'SVA' on purpose). Same pattern used in sync-orders-
// process.js, sync-revenue-process.js, sync-returns-process.js,
// sync-sqp-request.js, sync-products.js, and sync-advertising-process.js
// — kept identical for consistency across the codebase.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

function resolveBrandForSku(sku, candidates) {
  if (candidates.length === 1) return candidates[0];
  const isCa    = CA_SKU_PATTERN.test(sku);
  const caBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.ca');
  const usBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.com');
  if (isCa && caBrand) return caBrand;
  if (!isCa && usBrand) return usBrand;
  return usBrand || candidates[0];
}

async function fetchVineByBrand() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master ASIN sheet: ${resp.status}`);
  const csv = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  const result = {};
  for (const line of lines) {
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const sku      = cols[1] || '';
    const rawBrand = (cols[3] || '').trim();
    const rawDate  = (cols[5] || '').trim();
    if (!rawBrand || !rawDate) continue;

    const brandNorm = stripAccents(rawBrand.toLowerCase());
    const nameMatched = brands.find(b =>
      b.active && (
        brandNorm === stripAccents(b.id.toLowerCase()) ||
        brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
        brandNorm.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (!nameMatched) continue;
    // FIXED 2026-08-14 — same bug as sync-products.js and
    // sync-advertising-process.js: skinuva-ca shares "skinuva" as a
    // substring of its own id, so a plain "skinuva" brand-name label in
    // this master sheet could only ever satisfy skinuva's OWN condition
    // above — brandNorm.includes('skinuva-ca') is impossible when
    // brandNorm is just "skinuva" (a shorter string can't contain a
    // longer one). This one has real dollar consequences: every skinuva
    // Vine enrollment was being counted (and its $200/month cost
    // attributed) entirely under plain skinuva, even for genuinely
    // Canadian-listing enrollments. Disambiguate the real sibling set by
    // shared SKU PREFIX (not name), then resolve using the SKU's own
    // "-CA" suffix, same pattern as everywhere else today.
    const siblings = brands.filter(b =>
      b.active && b.skuPrefix && nameMatched.skuPrefix && b.skuPrefix === nameMatched.skuPrefix
    );
    const matched = siblings.length > 1 ? resolveBrandForSku(sku, siblings) : nameMatched;

    let yy, mm;
    if (/^\d{4,5}$/.test(rawDate)) {
      const d = new Date(Date.UTC(1899, 11, 30) + parseInt(rawDate, 10) * 86400000);
      yy = String(d.getUTCFullYear());
      mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    } else if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
      yy = rawDate.slice(0, 4);
      mm = rawDate.slice(5, 7);
    } else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(rawDate)) {
      const parts = rawDate.split('/');
      mm = parts[0].padStart(2, '0');
      yy = parts[2].trim().length === 2 ? '20' + parts[2].trim() : parts[2].trim();
    } else {
      continue;
    }

    const key = `${yy}-${mm}`;
    if (!result[matched.tabName]) result[matched.tabName] = {};
    result[matched.tabName][key] = (result[matched.tabName][key] || 0) + VINE_COST_PER_ENROLLMENT;
  }
  return result;
}

function monthKey(year, month) {
  return `${parseInt(year, 10)}-${String(parseInt(month, 10)).padStart(2, '0')}`;
}

function parseAmt(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(/[$,]/g, '')) || 0;
}

// parseInt(adRow.impressions, 10) on a formatted number like "65,935.00"
// stops at the first comma and silently returns 65 instead of 65935 — this
// is what was truncating impressions (and, less visibly, clicks/ad_units/
// units sold, which are prone to the exact same formatting). Strip
// thousands separators before parsing, same as parseAmt already does for
// dollar amounts. FIXED 2026-07-13.
function parseIntSafe(val) {
  if (!val) return 0;
  return Math.round(parseFloat(String(val).replace(/,/g, '')) || 0);
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// Same helper already proven in sync-fbm-returns-process.js /
// sync-returns-process.js — formats Eastern wall-clock time as an
// ISO-shaped string ending in "Z", so it displays consistently with
// every other Eastern-anchored timestamp in this project rather than
// UTC. Not a literal UTC timestamp despite the "Z" suffix — a
// deliberate, consistent convention used throughout this codebase.
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
