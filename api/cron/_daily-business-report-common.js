/**
 * api/cron/_daily-business-report-common.js
 * ADDED 2026-10-21 — shared pieces for the DAILY business report crons
 * (adapted from the VBC project's _biz-daily-common.js):
 *   api/cron/sync-daily-business-report-request.js
 *   api/cron/sync-daily-business-report-process.js
 *
 * Writes to "Newderm - Daily Business Report"
 * (1QLjUvYg-JR6jQmdFlykypkNarqsZvTCOgA3bFagDlVg):
 *   <brand tab>    one per brand (brands.js tabName): one row per day per
 *                  child ASIN — sessions, page views, units, sales,
 *                  conversion rate, Buy Box %.
 *   unmatched / unmatched_hol   ASINs not found on the Master SKU List,
 *                  per account (nothing is dropped).
 *   Daily Totals   one row per day per brand, for charting trends without
 *                  reading the brand tabs. The sheet's blank "Sheet1" is
 *                  renamed to this on first run.
 *   _meta / _meta_hol   pending report IDs + run timestamps, per seller account.
 *
 * Seller accounts: NewDerm by default; ?account=hol runs the same jobs for
 * High On Love (see api/_account.js). Each account only ever writes its own
 * brands' tabs and its own Daily Totals rows.
 *
 * Space: ~810 child ASINs × 730 days × 10 columns ≈ 5.9M cells if EVERY ASIN
 * had traffic EVERY day (Amazon only lists ASINs with activity, so far less
 * in practice), against Google's 10M-cell limit per spreadsheet. An alert is
 * sent if the whole spreadsheet ever passes CELL_ALERT.
 *
 * Why one report per day: GET_SALES_AND_TRAFFIC_REPORT's per-ASIN section is
 * one total for the whole requested range, even with dateGranularity DAY. A
 * single-day range is the only way to get per-ASIN daily numbers.
 *
 * Days are Amazon US business days. Amazon reads only the calendar date of
 * the requested range and applies its own business day, so each request is
 * that date 00:00:00Z → 23:59:59Z (see dayRange below).
 *
 * Metrics match the monthly business report: SESSIONS = sessions +
 * sessionsB2B, CONVERSION_RATE = units ÷ sessions × 100.
 */

const { getSheetsToken } = require('../config/_sheets_client');
const brands = require('../config/brands');

const DAILY_SHEET_ID = '1QLjUvYg-JR6jQmdFlykypkNarqsZvTCOgA3bFagDlVg';
const MASTER_GID = '164358627'; // Master SKU List "Product Short Name": A=asin, B=sku, D=brand

const BRAND_HEADERS  = ['DATE', 'ASIN', 'PARENT_ASIN', 'SKU', 'SESSIONS', 'PAGE_VIEWS', 'UNITS_ORDERED', 'ORDERED_PRODUCT_SALES', 'CONVERSION_RATE', 'BUY_BOX_PCT'];
const unmatchedTabFor = account => (account === 'newderm' ? 'unmatched' : `unmatched_${account}`);
const TOTALS_TAB     = 'Daily Totals';
const TOTALS_HEADERS = ['DATE', 'ACCOUNT', 'BRAND', 'ASINS', 'SESSIONS', 'PAGE_VIEWS', 'UNITS_ORDERED', 'ORDERED_PRODUCT_SALES', 'CONVERSION_RATE', 'FINAL', 'SYNCED_AT'];
const META_HEADERS   = ['KEY', 'VALUE', 'UPDATED_AT'];
const NO_DATA_BRAND  = '(no data)';         // a day Amazon had nothing for, so it isn't re-requested
const NOT_AVAILABLE_BRAND = '(not available)'; // a day Amazon failed twice (e.g. past how far back it keeps data)
const FATAL_LIMIT = 2;

const RETENTION_DAYS = 730;        // CHANGED 2026-10-21 per Jaclyn: 2 years (was 369)
const BACKFILL_DAYS  = 730;
const RECENT_OFFSETS = [2, 3, 4];   // re-pull D-2..D-4 daily (numbers settle over ~48–72h)
const FINAL_AFTER    = 4;           // a day is FINAL once it's D-4 or older
const MAX_REQUESTS_PER_RUN = 8;     // shared createReport allowance (burst 15, ~1/min) with this account's other crons; runs are 30 min apart (CHANGED 2026-10-27, was 6)
const CELL_ALERT     = 9_000_000;

// ── Dates (Pacific) ────────────────────────────────────────────────────────
function todayPT() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function normDate(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000).toISOString().slice(0, 10);
  return '';
}
// FIXED 2026-10-21 — for this report Amazon reads only the CALENDAR DATE of
// dataStartTime / dataEndTime (it applies its own marketplace business day).
// Pacific-midnight instants (07:00Z → next day 06:59Z) were read as TWO
// dates, so one "day" combined two days. Confirmed live: a request for
// 2024-10-23 came back covering 2024-10-23 and 2024-10-24. Same-date
// T00:00:00Z → T23:59:59Z (what the VBC version uses) is one day.
const dayRange = date => ({ start: `${date}T00:00:00Z`, end: `${date}T23:59:59Z` });

// ── Sheets REST with retry (429 / 5xx) ─────────────────────────────────────
async function gs(method, path, body, attempt = 0) {
  const token = await getSheetsToken(DAILY_SHEET_ID); // writer account for this sheet (2026-10-27)
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${DAILY_SHEET_ID}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(1000 * 2 ** attempt + Math.random() * 500);
    return gs(method, path, body, attempt + 1);
  }
  const text = await res.text();
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data.error && data.error.message) || text.slice(0, 200);
    throw new Error(`Sheets ${method} ${path.split('?')[0]} → ${res.status}: ${msg}${res.status === 403 ? ' (is the sheet shared with this project\'s service account as Editor?)' : ''}`);
  }
  return data;
}
const rng = a1 => encodeURIComponent(a1);
const q = title => `'${String(title).replace(/'/g, "''")}'`;

async function getTabs() {
  const d = await gs('GET', '?fields=sheets.properties');
  return (d.sheets || []).map(s => s.properties);
}

// Makes sure every tab this account needs exists (brand tabs, unmatched,
// Daily Totals, its _meta), each sized to its own column count. A blank
// "Sheet1" is renamed to Daily Totals so the shared link opens onto it.
async function ensureTabs(accountBrands, metaTab, unmatchedTab) {
  let tabs = await getTabs();
  const has = t => tabs.some(p => p.title === t);
  const want = [
    [TOTALS_TAB, TOTALS_HEADERS],
    ...accountBrands.map(b => [b.tabName, BRAND_HEADERS]),
    [unmatchedTab, BRAND_HEADERS],
    [metaTab, META_HEADERS],
  ];
  const requests = [], created = [];
  for (const [title, headers] of want) {
    if (has(title) || created.some(c => c[0] === title)) continue;
    const blank = title === TOTALS_TAB && tabs.find(p => /^Sheet1$/i.test(p.title));
    if (blank) {
      const peek = await gs('GET', `/values/${rng(`${q(blank.title)}!A1:Z3`)}`);
      if (!(peek.values || []).length) {
        requests.push({ updateSheetProperties: { properties: { sheetId: blank.sheetId, title, gridProperties: { rowCount: 1000, columnCount: headers.length } }, fields: 'title,gridProperties.rowCount,gridProperties.columnCount' } });
        created.push([title, headers]); continue;
      }
    }
    requests.push({ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: headers.length } } } });
    created.push([title, headers]);
  }
  if (requests.length) {
    await gs('POST', ':batchUpdate', { requests });
    await gs('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: created.map(([t, h]) => ({ range: `${q(t)}!A1`, values: [h] })) });
    tabs = await getTabs();
  }
  return tabs;
}

// ── _meta (per account) ────────────────────────────────────────────────────
async function readMeta(metaTab) {
  const d = await gs('GET', `/values/${rng(`${q(metaTab)}!A2:C`)}`);
  const m = {}; (d.values || []).forEach(r => { if (r[0]) m[r[0]] = r[1] || ''; });
  return m;
}
// One write (was clear + put — CHANGED 2026-10-27 to save write quota):
// the rows are padded with blank rows so any leftover keys below get blanked.
async function writeMeta(metaTab, meta) {
  const ts = new Date().toISOString();
  const rows = Object.entries(meta).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v), ts]);
  const padded = [...rows, ...Array.from({ length: 10 }, () => ['', '', ''])];
  await gs('PUT', `/values/${rng(`${q(metaTab)}!A2:C${padded.length + 1}`)}?valueInputOption=RAW`, { values: padded });
}
function readPending(meta) {
  try { const p = JSON.parse(meta.pending || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

async function readTotals() {
  const d = await gs('GET', `/values/${rng(`${q(TOTALS_TAB)}!A2:K`)}`);
  return (d.values || []).map(r => { const row = TOTALS_HEADERS.map((_, i) => r[i] ?? ''); row[0] = normDate(row[0]); return row; }).filter(r => r[0]);
}

// ── Master SKU List → { asin: { brandTab, sku } } for this account's brands ─
// Brand is decided by SKU prefix (brands.js skuPrefix), same as every other
// cron. A prefix shared by a marketplace variant (skinuva / skinuva-ca) goes
// to the US brand, since this report is the US marketplace.
async function loadAsinMap(accountBrands) {
  const id = process.env.SHEET_MASTER_SKU_LIST;
  if (!id) throw new Error('SHEET_MASTER_SKU_LIST env var not set');
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${MASTER_GID}`);
  if (!res.ok) throw new Error(`Master SKU List CSV → ${res.status}`);
  const rows = parseCsv(await res.text());
  const map = new Map();
  for (const r of rows.slice(1)) {
    const asin = (r[0] || '').trim().toUpperCase(), sku = (r[1] || '').trim();
    if (!asin || !sku) continue;
    const candidates = accountBrands.filter(b => b.skuPrefix && sku.toUpperCase().startsWith(b.skuPrefix.toUpperCase()));
    const brand = candidates.find(b => !b.marketplaceId) || candidates[0];
    if (!brand) continue;
    const cur = map.get(asin);
    // Prefer the FBA SKU over its -SF twin for the SKU column.
    if (!cur || (/-SF$/i.test(cur.sku) && !/-SF$/i.test(sku))) map.set(asin, { brandTab: brand.tabName, sku });
  }
  return map;
}
function parseCsv(text) {
  const out = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

// This report is the US marketplace only — marketplace variants like
// skinuva-ca (Amazon.ca) are left out, by setting or by sales channel.
const isUsBrand = b => !b.marketplaceId && !/amazon\.ca/i.test(b.salesChannel || '') && !/-ca$/i.test(b.id);

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;

module.exports = {
  DAILY_SHEET_ID, BRAND_HEADERS, unmatchedTabFor, TOTALS_TAB, TOTALS_HEADERS, NO_DATA_BRAND, NOT_AVAILABLE_BRAND, FATAL_LIMIT,
  RETENTION_DAYS, BACKFILL_DAYS, RECENT_OFFSETS, FINAL_AFTER, MAX_REQUESTS_PER_RUN, CELL_ALERT,
  todayPT, addDays, normDate, dayRange, gs, rng, q, getTabs, ensureTabs, readMeta, writeMeta, readPending, readTotals,
  loadAsinMap, isUsBrand, sleep, round2, brands,
};
