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
 *          promos_total, vine_total, revenue, units, last_updated
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

const MASTER_SHEET_ID = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=ASIN, B=SKU, C=Name, D=Brand, E=Price, F=Date Enrolled in Vine

const VINE_COST_PER_ENROLLMENT = 200;

const HEADERS = [
  'year', 'month',
  'ads_spend', 'impressions', 'clicks', 'ad_units',
  'promos_total', 'vine_total',
  'revenue', 'units',
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

  const now = new Date().toISOString();

  let vineByBrand;
  try {
    vineByBrand = await fetchVineByBrand();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read master ASIN/SKU list for Vine', detail: err.message });
  }

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const [syncRows, histRows, adRows, revRows] = await Promise.all([
        readRows(SYNC_SHEET_ID, brand.tabName).catch(() => []),
        readRows(HISTORICAL_SHEET_ID, brand.tabName).catch(() => []),
        readRows(AD_SUMMARY_SHEET_ID, brand.tabName).catch(() => []),
        readRows(REVENUE_SHEET_ID, brand.tabName).catch(() => []),
      ]);

      const allOrderRows = [...(syncRows || []), ...(histRows || [])];

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

      const outRows = Array.from(allMonths).sort().map(ym => {
        const [y, m] = ym.split('-').map(n => parseInt(n, 10));
        const adRow = (adRows || []).find(r => parseInt(r.year, 10) === y && parseInt(r.month, 10) === m);
        const revRow = (revRows || []).find(r => parseInt(r.YEAR, 10) === y && parseInt(r.MONTH, 10) === m);

        return [
          y, m,
          adRow ? parseAmt(adRow.spend) : 0,
          adRow ? (parseInt(adRow.impressions, 10) || 0) : 0,
          adRow ? (parseInt(adRow.clicks, 10) || 0) : 0,
          adRow ? (parseInt(adRow.ad_units, 10) || 0) : 0,
          round2(promosByMonth[ym] || 0),
          vineByMonth[ym] || 0,
          revRow ? (parseFloat(revRow.REVENUE) || 0) : 0,
          revRow ? (parseInt(revRow['UNITS SOLD'], 10) || 0) : 0,
          now,
        ];
      });

      const token = await ensureTab(SUMMARY_SHEET_ID, brand.tabName, HEADERS);
      await replaceRows(SUMMARY_SHEET_ID, brand.tabName, HEADERS, outRows, token);

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

async function fetchVineByBrand() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master ASIN sheet: ${resp.status}`);
  const csv = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  const result = {};
  for (const line of lines) {
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const rawBrand = (cols[3] || '').trim();
    const rawDate  = (cols[5] || '').trim();
    if (!rawBrand || !rawDate) continue;

    const brandNorm = stripAccents(rawBrand.toLowerCase());
    const matched = brands.find(b =>
      b.active && (
        brandNorm === stripAccents(b.id.toLowerCase()) ||
        brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
        brandNorm.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (!matched) continue;

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

function round2(n) { return Math.round((n || 0) * 100) / 100; }
