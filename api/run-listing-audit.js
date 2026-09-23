/**
 * api/run-listing-audit.js
 * POST /api/run-listing-audit
 *
 * Reads listing copy directly from the source Google Sheet.
 *
 * CHANGED 2026-07-17 per Jaclyn: "current listing" data now comes from
 * SHEET_PRODUCT_INVENTORY (dated daily snapshots, one tab per brand) instead
 * of the old SHEET_LISTINGS (single current-state row per SKU). For each
 * SKU, this reads the row with the most recent date in column A. The sheet
 * ID itself still comes from the sourceSheetId POST param below — whoever
 * calls this endpoint (dashboard button, curl) now needs to pass
 * SHEET_PRODUCT_INVENTORY's ID (1cdqKzqaUFr8MFDWkskpGJ5NQSv9QjVv64ab8P_PPr6s)
 * instead of the old SHEET_LISTINGS ID.
 *
 * Calls Claude once per SKU using a plain-text delimited response format —
 * NO JSON from Claude, so no JSON parse errors, ever.
 *
 * Claude responds with labeled lines:
 *   TITLE_NOTES: ...
 *   TITLE_REWRITE: ...
 *   IH_NOTES: ...
 *   IH_REWRITE: ...
 *   BULLETS_NOTES: ...
 *   BULLETS_REWRITE: ...
 *   BACKEND_NOTES: ...
 *   BACKEND_REWRITE: ...
 *
 * Results are written directly to the audit sheet by this endpoint.
 * The dashboard does NOT call Claude — it only reads the completed audit sheet.
 *
 * POST body:
 *   { brand, sourceSheetId, auditSheetId, auditGid, sku? }
 *   sku — optional, limits run to one SKU for testing
 *
 * EXPANDED 2026-07-27 per Jaclyn — 3-tier keyword priority replacing the
 * old "prioritize unranked keywords" logic entirely:
 *   TIER 1 (protect) — already ranking page 1 (rank <= PAGE1_RANK_CUTOFF).
 *     Highest priority of anything in the audit: a rewrite must never
 *     remove or weaken these, full stop, even to make room for something
 *     that sounds more strategically important.
 *   TIER 2 (push) — rank 49-100, sorted by volume. The priority for NEW
 *     placement — closest realistic wins beat any unranked keyword,
 *     regardless of how "important" the unranked one seems.
 *   TIER 3 (reconsider) — present in the listing 30+ consecutive days
 *     (checked against SHEET_PRODUCT_INVENTORY's real daily snapshots,
 *     not assumed) with zero ranking progress. Raised as an open QUESTION
 *     with a suggested lower-volume Reach-tier alternative, not resolved
 *     automatically — "maybe this is too competitive to win" is a human
 *     call, not something to decide silently.
 * Current rank and search volume come from SHEET_KEYWORD_TRACKER.
 * The older uploads-log ranking source has been retired.
 * same sheet run-analysis.js already reads, added here as a second
 * fetch. Field-priority hierarchy for placement (Title > Item Highlights
 * > Bullets > Product Description > Backend Keywords) added to the
 * system prompt for the same reason — a keyword missing from Title is a
 * bigger gap than the same keyword only missing from Backend.
 *
 * Vercel config: maxDuration: 300
 */

const { google } = require('googleapis');

// ─── source sheet column indices (0-based) ──────────────────────────────────
// CHANGED 2026-07-17 per Jaclyn: source of "current listing" data moved from
// SHEET_LISTINGS to SHEET_PRODUCT_INVENTORY (1cdqKzqaUFr8MFDWkskpGJ5NQSv9QjVv64ab8P_PPr6s).
// Confirmed directly from the sheet — one tab per brand, dated daily snapshots
// (each SKU has 4-5 rows spanning different dates, not just one current row).
// Column layout, confirmed from the actual header row:
// date | sku | asin | fulfillable_quantity | reserved_quantity |
// inbound_working_quantity | inbound_shipped_quantity | inbound_receiving_quantity |
// unfulfillable_quantity | seller_fulfilled_quantity | total_quantity | name |
// status | sales_ranks | title | item_highlights | bullet_1..bullet_5 |
// description | backend_keywords | ingredients | item_type_keyword | offers |
// issues | last_synced
const COL = {
  date:              0,
  sku:               1,
  asin:              2,
  fulfillable_qty:   3,
  reserved_qty:      4,
  inbound_working:   5,
  inbound_shipped:   6,
  inbound_receiving: 7,
  unfulfillable_qty: 8,
  seller_fulfilled_qty: 9,
  total_qty:         10,
  name:              11,
  status:            12,
  sales_ranks:       13,
  title:             14,
  item_highlights:   15,
  bullet_1:          16,
  bullet_2:          17,
  bullet_3:          18,
  bullet_4:          19,
  bullet_5:          20,
  description:       21,
  backend_keywords:  22,
  ingredients:       23,
  item_type_keyword: 24,
  offers:            25,
  issues:            26,
  last_synced:       27,
};

// ─── keyword strategy sheet ─────────────────────────────────────────────────
// Sheet ID passed in POST body as keywordSheetId (optional).
// SKU-to-GID map: when a tab exists for a SKU, fetch keywords from it.
// If no tab exists for this SKU, keyword coverage is skipped.
// Tab headers live in row 2; keyword columns found by searching for header text.
// Each keyword cell contains up to 20 newline-separated keywords in one cell.

// ─── audit sheet headers (must match write-listing-audit.js) ────────────────
const AUDIT_HEADERS = [
  'date', 'sku', 'sku_name', 'action',
  'title_notes', 'title_rewrite',
  'ih_notes', 'ih_rewrite',
  'bullets_notes',
  'bullet_1_rewrite', 'bullet_2_rewrite', 'bullet_3_rewrite', 'bullet_4_rewrite', 'bullet_5_rewrite',
  'desc_notes', 'desc_rewrite',
  'backend_notes', 'backend_rewrite',
  'skip_reason', 'audited_at'
];

// ─── Keyword priority tiers — added 2026-07-27 per Jaclyn ───────────────────
// Same sheet run-analysis.js reads (confirmed there against a real screenshot
// + upload-keyword-tracker.js's own example). The tracker supplies BOTH
// current organic rank and search volume per keyword.
const KEYWORD_TRACKER_SHEET_ID = '1geNDQgd_1ensLDyZOuXZBnvQrFT_RC85l9rHHGpgJe4';

// Real page-1 depth varies ~24-60 depending on layout/sponsored density —
// 48 is a working middle, same cutoff run-analysis.js uses, adjust here if
// it's consistently off in practice. 49-100 = "close" — a realistic push
// target, not "anything not page 1."
const PAGE1_RANK_CUTOFF = 48;
const CLOSE_TO_PAGE1_MAX = 100;
// FIXED 2026-09-18 per Jaclyn — 30 days was never grounded in real SEO
// timing (see prior comment: chosen only to rule out indexing lag), and
// organic ranking movement genuinely takes much longer than that —
// realistically 6-12 months, and NOT a flat number: how long is
// reasonable depends heavily on how competitive the keyword is. A
// broad, low-competition term can move in a couple months; a
// competitive head term can legitimately take the better part of a
// year. Flagging every keyword as "stuck" after just 30 days would
// have meant suggesting a reach-for-the-stars swap for the vast
// majority of keywords almost immediately — nowhere near enough
// runway for real organic movement, regardless of competitiveness.
//
// Search volume is used here as the competitiveness proxy, since it's
// the one signal already flowing into this script per-keyword (from
// the keyword tracker sheet) — not a perfect stand-in for true
// competitiveness (title density, number of competing listings, and
// CPR all factor in too, and none of those are wired into this script
// today), but a reasonable, defensible one: higher-volume terms
// generally draw more competing sellers chasing the same traffic.
// When volume is unknown (keyword tracker sheet not yet populated for
// this brand — true for Crème Shop today, confirmed live: 0 rows
// loaded), this defaults to the LONGEST tier rather than the
// shortest — better to wait too long on an unknown than to flag it as
// stuck prematurely.
//
// These bucket boundaries are a starting point matching the 6-12
// month range as stated, not a precise science — adjust the volume
// cutoffs or day counts here once there's real experience with how
// long Crème Shop's own keywords actually take to move.
const TENURE_THRESHOLDS_BY_VOLUME = [
  { maxVolume: 1000,      days: 180 },  // low competition — ~6 months
  { maxVolume: 10000,     days: 270 },  // moderate competition — ~9 months
  { maxVolume: Infinity,  days: 365 },  // high competition — ~12 months
];
function tenureThresholdForVolume(volume) {
  if (volume == null) return TENURE_THRESHOLDS_BY_VOLUME[TENURE_THRESHOLDS_BY_VOLUME.length - 1].days; // unknown competitiveness — assume the longest, most conservative case
  const tier = TENURE_THRESHOLDS_BY_VOLUME.find(t => volume <= t.maxVolume);
  return tier.days;
}

function normTerm(s) { return String(s || '').trim().toLowerCase(); }

// Real Helium 10 ranks come through as either a plain integer or ">306" /
// ">96" meaning "not found within the checked depth" — never a real
// number, and must never be parsed as one. Same logic run-analysis.js uses.
function parseRankValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (s.startsWith('>')) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// Builds keyword -> {rank, volume} for one SKU from the keyword tracker
// sheet's most recent snapshot date. Falls back to null volume (not zero —
// zero would wrongly imply "no search volume" rather than "unknown") when
// a keyword isn't on the tracker at all.
function buildKwTrackerLookup(kwTrackerRows, sku) {
  const rowsForSku = kwTrackerRows.filter(r => (r.sku || '').trim() === sku);
  if (!rowsForSku.length) return {};
  const latestDate = rowsForSku.reduce((max, r) => (r.date || '') > max ? (r.date || '') : max, '');
  const map = {};
  rowsForSku.forEach(r => {
    if ((r.date || '') !== latestDate) return;
    const kw = normTerm(r.keyword);
    if (!kw) return;
    map[kw] = { rank: parseRankValue(r.organic_rank), volume: parseInt(r.search_volume, 10) || null };
  });
  return map;
}

// Sorts a SKU's keyword targets into 3 tiers. Volume-unknown keywords
// (not on the tracker) fall into "other" rather than being guessed into
// tier 2 or 3 — no invented numbers.
function categorizeKeywordTiers(allKeywords, kwTrackerLookup) {
  const tier1Protect = [];  // rank <= PAGE1_RANK_CUTOFF — already page 1, do not lose
  const tier2Push = [];     // below page-1 cutoff through CLOSE_TO_PAGE1_MAX
  const other = [];         // unranked, or ranked beyond CLOSE_TO_PAGE1_MAX

  allKeywords.forEach(kw => {
    const key = normTerm(kw);
    const tracked = kwTrackerLookup[key];
    const rank = tracked ? tracked.rank : null;
    const volume = tracked ? tracked.volume : null;
    const entry = { keyword: kw, rank, volume };
    if (rank !== null && rank <= PAGE1_RANK_CUTOFF) tier1Protect.push(entry);
    else if (rank !== null && rank <= CLOSE_TO_PAGE1_MAX) tier2Push.push(entry);
    else other.push(entry);
  });

  tier2Push.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return { tier1Protect, tier2Push, other };
}

// Checks how many consecutive days (counting back from the most recent
// snapshot) a keyword has been continuously present in this SKU's title,
// bullets, or backend keywords. Returns null if the keyword isn't
// currently present at all (nothing to question — it's simply not there
// yet, a placement gap, not a "reconsider this keyword" case).
function computeKeywordTenureDays(sku, keyword, allRawRowsForSku) {
  const kw = normTerm(keyword);
  const datedRows = allRawRowsForSku
    .filter(row => (row[COL.sku] || '').trim() === sku)
    .map(row => ({
      date: (row[COL.date] || '').trim(),
      text: normTerm([row[COL.title], row[COL.bullet_1], row[COL.bullet_2], row[COL.bullet_3], row[COL.bullet_4], row[COL.bullet_5], row[COL.backend_keywords]].join(' ')),
    }))
    .filter(r => r.date)
    .sort((a, b) => b.date.localeCompare(a.date)); // most recent first

  if (!datedRows.length || !datedRows[0].text.includes(kw)) return null; // not present today at all

  let consecutiveDays = 0;
  let lastDate = null;
  for (const row of datedRows) {
    if (!row.text.includes(kw)) break; // presence streak broken
    if (lastDate !== null) {
      const gapDays = Math.round((new Date(lastDate) - new Date(row.date)) / (24 * 60 * 60 * 1000));
      if (gapDays > 3) break; // real gap in snapshots, not continuous presence — stop counting
    }
    consecutiveDays = Math.round((new Date(datedRows[0].date) - new Date(row.date)) / (24 * 60 * 60 * 1000)) + 1;
    lastDate = row.date;
  }
  return consecutiveDays;
}

// Tier 3 — "this keyword has been in the listing a long time and still
// isn't ranking, maybe it's too competitive." Per Jaclyn 2026-07-27:
// "consider as a question in the insight that there is another keyword
// with less search volume but might be more attainable." Suggests a
// Reach-tier alternative (lower volume, by definition, since Reach is the
// long-tail tier) rather than just flagging the problem with no next step.
function buildTier3Reconsiderations(otherKeywords, sku, allRawRowsForSku, reachKeywords, kwTrackerLookup) {
  const alreadyUsedReach = new Set(); // don't suggest the same alternative twice in one audit
  const out = [];
  otherKeywords.forEach(({ keyword, rank, volume }) => {
    if (rank !== null) return; // it IS ranking somewhere past 100 — not the "stuck" case being asked about here
    const tenureDays = computeKeywordTenureDays(sku, keyword, allRawRowsForSku);
    const threshold = tenureThresholdForVolume(volume);
    if (tenureDays === null || tenureDays < threshold) return;
    const alternative = reachKeywords.find(rk => {
      const key = normTerm(rk);
      return !alreadyUsedReach.has(key) && key !== normTerm(keyword);
    });
    if (alternative) alreadyUsedReach.add(normTerm(alternative));
    out.push({
      keyword,
      volume,
      tenure_days: tenureDays,
      tenure_threshold_applied: threshold, // surfaced so the reasoning is auditable, not a silent internal decision
      suggested_alternative: alternative || null,
    });
  });
  return out;
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function getToken() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getAccessToken();
}

// Sanitize a cell value for sending to Claude — remove smart quotes, em dashes,
// HTML entities and extra whitespace. Input is preserved in full unless a
// caller deliberately supplies maxLen. Output character limits are enforced
// separately in the audit prompt and must never be reused as read-side caps.
function san(s, maxLen) {
  if (!s) return '';
  const cleaned = String(s)
    .replace(/&amp;/g, 'and').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/[\u2018\u2019\u0060\u00b4]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Number.isFinite(maxLen) ? cleaned.slice(0, maxLen) : cleaned;
}

// Parse Claude's plain-text delimited response into a result object.
// Each line starts with LABEL: value.
// Claude may write multi-sentence notes that span the value after the colon —
// we capture everything after the first colon on each labeled line.
function parseDelimited(text) {
  const keys = [
    'TITLE_NOTES', 'TITLE_REWRITE',
    'IH_NOTES', 'IH_REWRITE',
    'BULLETS_NOTES',
    'BULLET_1_REWRITE', 'BULLET_2_REWRITE', 'BULLET_3_REWRITE', 'BULLET_4_REWRITE', 'BULLET_5_REWRITE',
    'DESC_NOTES', 'DESC_REWRITE',
    'BACKEND_NOTES', 'BACKEND_REWRITE',
  ];

  const result = {};
  let currentKey = null;

  for (const line of text.split('\n')) {
    const upper = line.toUpperCase();
    let matched = false;
    for (const key of keys) {
      if (upper.startsWith(key + ':')) {
        currentKey = key;
        result[currentKey] = line.slice(key.length + 1).trim();
        matched = true;
        break;
      }
    }
    if (!matched && currentKey && line.trim()) {
      result[currentKey] += ' ' + line.trim();
    }
  }

  return {
    title_notes:      result['TITLE_NOTES']      || '',
    title_rewrite:    result['TITLE_REWRITE']    || '',
    ih_notes:         result['IH_NOTES']         || '',
    ih_rewrite:       result['IH_REWRITE']       || '',
    bullets_notes:    result['BULLETS_NOTES']    || '',
    bullet_1_rewrite: result['BULLET_1_REWRITE'] || '',
    bullet_2_rewrite: result['BULLET_2_REWRITE'] || '',
    bullet_3_rewrite: result['BULLET_3_REWRITE'] || '',
    bullet_4_rewrite: result['BULLET_4_REWRITE'] || '',
    bullet_5_rewrite: result['BULLET_5_REWRITE'] || '',
    desc_notes:       result['DESC_NOTES']       || '',
    desc_rewrite:     result['DESC_REWRITE']     || '',
    backend_notes:    result['BACKEND_NOTES']    || '',
    backend_rewrite:  result['BACKEND_REWRITE']  || '',
  };
}

// Simple CSV line parser — handles quoted fields
function parseSimpleCsv(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(field); field = ''; continue; }
    field += ch;
  }
  result.push(field);
  return result;
}

// Full CSV parser — handles commas, escaped quotes, and embedded newlines in quoted cells.
// Use this for sheet exports where product context, reviews, bullets, or descriptions can be multiline.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      row.push(field); field = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => String(v || '').trim())) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(v => String(v || '').trim())) rows.push(row);
  return rows;
}

function rowsToObjects(rows, headerRowIndex = 0) {
  if (!rows || rows.length <= headerRowIndex) return [];
  const headers = rows[headerRowIndex].map(h => String(h || '').trim());
  return rows.slice(headerRowIndex + 1).map(cells => {
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = String(cells[idx] || '').trim(); });
    return obj;
  }).filter(obj => Object.values(obj).some(Boolean));
}

async function fetchCsvByGid(sheetId, gid, token, label) {
  if (!sheetId || gid === undefined || gid === null || gid === '') return null;
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${label} fetch failed: HTTP ${response.status}`);
  return parseCsvRows(await response.text());
}

function headerIndex(headers, names) {
  const wanted = names.map(n => String(n).trim().toLowerCase());
  return headers.findIndex(h => wanted.includes(String(h || '').trim().toLowerCase()));
}

// Detect travel SKUs by name or status containing "travel" (case-insensitive)
function isTravel(row) {
  const name   = (row[COL.name]   || '').toLowerCase();
  const status = (row[COL.status] || '').toLowerCase();
  return name.includes('travel') || status.includes('travel');
}

// ─── main handler ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, sourceSheetId, auditSheetId, auditGid, sku: testSku, keywordSheetId, skuGidMap, masterSkuSheetId, masterSkuGid, brandInsightsSheetId, brandInsightsGid, businessReportSheetId, businessReportGid, adSearchTermsSheetId, adSearchTermsGid, amazonReviewsSheetId, amazonReviewsGid, skuFilter } = req.body || {};

  if (!brand)         return res.status(400).json({ error: 'Missing: brand' });
  if (!sourceSheetId) return res.status(400).json({ error: 'Missing: sourceSheetId' });
  if (!auditSheetId)  return res.status(400).json({ error: 'Missing: auditSheetId' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Google credentials not configured' });
  }

  // ── 0. Pre-fetch keyword targets and recent rankings (optional) ─────────────
  // Runs AFTER getToken() — token is available from step 1 below.
  // Declared here as empty; populated after token is obtained.
  let skuStrategyMap = {}; // sku → { top20, opportunity, reach, competitors, categoryLeaders }
  let skuContextMap = {};  // sku → { productContext, auditGuardrails }
  let brandInsights = '';
  let businessReportRows = [];
  let adSearchTermRows = [];
  let amazonReviewRows = [];
  const debug = { sources: {}, skus: {}, warnings: [] };
  const debugOk = (source, detail) => { debug.sources[source] = { ok: true, ...detail }; console.log(`[listing-audit][debug] ${source}: OK`, detail); };
  const debugFail = (source, error) => { const message = error instanceof Error ? error.message : String(error); debug.sources[source] = { ok: false, error: message }; debug.warnings.push(`${source}: ${message}`); console.warn(`[listing-audit][debug] ${source}: FAILED - ${message}`); };

    // ── 1. Read source sheet ──────────────────────────────────────────────────
  let token;
  try {
    token = await getToken();
  } catch (e) {
    return res.status(500).json({ error: 'Google auth failed: ' + e.message });
  }

  // Fetch all rows (skip header row 1)
  // CHANGED 2026-07-17: range widened from A2:Q to A2:AB — SHEET_PRODUCT_INVENTORY
  // has 28 columns (date through last_synced), vs. the old 17-column SHEET_LISTINGS.
  const tabName = brand; // e.g. "evolis"
  const sourceUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sourceSheetId}/values/${encodeURIComponent(tabName + '!A2:AB')}?majorDimension=ROWS`;
  const sourceRes = await fetch(sourceUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!sourceRes.ok) {
    const err = await sourceRes.text();
    console.error(`[listing-audit] source sheet read failed (${brand}, tab "${tabName}"): ${sourceRes.status} — ${err.slice(0, 300)}`);
    return res.status(502).json({ error: 'Failed to read source sheet', detail: err.slice(0, 300) });
  }
  const sourceData = await sourceRes.json();
  const allRawRows = sourceData.values || [];
  debugOk('productInventory', { rawRows: allRawRows.length, brand });

  if (!allRawRows.length) {
    return res.status(200).json({ ok: true, message: 'No rows found in source sheet', skuCount: 0 });
  }

  // CHANGED 2026-07-17: SHEET_PRODUCT_INVENTORY has multiple dated rows per
  // SKU (daily snapshots), not one current row per SKU like the old sheet.
  // Collapse to the single most-recent-date row per SKU. Done per-SKU rather
  // than filtering to one global max date, since a few SKUs are missing the
  // very latest sync date (observed: some evolis SKUs have only 4 of the
  // last 5 days) — a global-max filter would silently drop those SKUs
  // entirely rather than falling back to their next-most-recent row.
  const latestBySkuDate = new Map();
  for (const row of allRawRows) {
    const sku = (row[COL.sku] || '').trim();
    if (!sku) continue;
    const date = (row[COL.date] || '').trim();
    const existing = latestBySkuDate.get(sku);
    if (!existing || date > (existing[COL.date] || '')) latestBySkuDate.set(sku, row);
  }
  const allRows = Array.from(latestBySkuDate.values());

  // Filter rows: testSku (single), skuFilter (array from batch), or all
  const rows = allRows.filter(row => {
    const sku = (row[COL.sku] || '').trim();
    if (!sku) return false;
    if (testSku)   return sku === testSku;
    if (skuFilter && Array.isArray(skuFilter) && skuFilter.length) {
      return skuFilter.includes(sku);
    }
    return true;
  });

  if (testSku && !rows.length) {
    return res.status(400).json({ error: `SKU ${testSku} not found in source sheet` });
  }

  // ── 0b. Fetch keyword strategy + competitor/category data ───────────────
  if (keywordSheetId && skuGidMap) {
    for (const [skuKey, gid] of Object.entries(skuGidMap)) {
      try {
        const csvRows = await fetchCsvByGid(keywordSheetId, gid, token, `strategy ${skuKey}`);
        if (!csvRows || !csvRows.length) { debugFail(`strategy:${skuKey}`, 'No rows returned'); continue; }
        const headers = csvRows[1] || csvRows[0] || [];
        const top20Idx = headerIndex(headers, ['Top 20 Keywords']);
        const oppIdx = headerIndex(headers, ['Top 20 Opportunity Keywords']);
        const reachIdx = headerIndex(headers, ['Top 20 Reach for the stars keywords']);
        if (top20Idx < 0) console.warn(`[listing-audit] No keyword strategy headers for ${skuKey}; competitor/category data will still be checked`);

        function colKws(colIdx) {
          if (colIdx < 0) return [];
          const kws = [];
          for (let r = 2; r < csvRows.length; r++) {
            const cells = csvRows[r];
            if (String(cells[0] || '').trim()) break;
            const val = String(cells[colIdx] || '').trim();
            if (val) val.split(/\n|\r|,/).map(k => k.trim()).filter(Boolean).forEach(k => kws.push(k));
          }
          return [...new Set(kws)].slice(0, 20);
        }

        function findRowContaining(text) {
          const target = text.toLowerCase();
          return csvRows.findIndex(row => row.some(cell => String(cell || '').toLowerCase().includes(target)));
        }
        function parseMarketTable(sectionStart, nextSectionStart = csvRows.length) {
          if (sectionStart < 0) return [];
          let headerRow = -1;
          for (let r = sectionStart + 1; r < nextSectionStart; r++) {
            const normalized = csvRows[r].map(c => String(c || '').trim().toLowerCase());
            if (normalized.includes('asin') && (normalized.includes('brand') || normalized.includes('product name'))) { headerRow = r; break; }
          }
          if (headerRow < 0) return [];
          const tableHeaders = csvRows[headerRow].map(h => String(h || '').trim());
          const asinIdx = headerIndex(tableHeaders, ['ASIN']);
          const results = [];
          for (let r = headerRow + 1; r < nextSectionStart; r++) {
            const cells = csvRows[r];
            const asinVal = asinIdx >= 0 ? String(cells[asinIdx] || '').trim() : '';
            if (!asinVal) continue;
            const obj = {};
            tableHeaders.forEach((h, idx) => { if (h) obj[h] = String(cells[idx] || '').trim(); });
            results.push(obj);
          }
          return results;
        }

        const competitorStart = findRowContaining('Current Competitors');
        const leaderStart = findRowContaining('CATEGORY LEADERS');
        const competitors = parseMarketTable(competitorStart, leaderStart > competitorStart ? leaderStart : csvRows.length);
        const categoryLeaders = parseMarketTable(leaderStart, csvRows.length);
        skuStrategyMap[skuKey] = { top20: colKws(top20Idx), opportunity: colKws(oppIdx), reach: colKws(reachIdx), competitors, categoryLeaders };
        debugOk(`strategy:${skuKey}`, { top20: skuStrategyMap[skuKey].top20.length, opportunity: skuStrategyMap[skuKey].opportunity.length, reach: skuStrategyMap[skuKey].reach.length, competitors: competitors.length, categoryLeaders: categoryLeaders.length });
      } catch (e) { debugFail(`strategy:${skuKey}`, e); }
    }
  } else {
    debugFail('strategy', 'keywordSheetId or skuGidMap not supplied');
  }

  console.log(`[listing-audit] Starting audit: ${rows.length} SKUs (brand: ${brand})`);

  // ── 1b. Keyword tracker — real rank + volume, for the 3-tier priority
  // system below. Fetched once for the whole brand, filtered per-SKU
  // inside the loop, rather than once per SKU. ─────────────────────────
  let kwTrackerRows = [];
  try {
    const kwTrackerUrl = `https://docs.google.com/spreadsheets/d/${KEYWORD_TRACKER_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(brand)}`;
    const kwTrackerRes = await fetch(kwTrackerUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (kwTrackerRes.ok) {
      const csvText = await kwTrackerRes.text();
      kwTrackerRows = rowsToObjects(parseCsvRows(csvText));
      debugOk('keywordTracker', { rows: kwTrackerRows.length, brand });
    } else {
      debugFail('keywordTracker', `HTTP ${kwTrackerRes.status}; keyword strategy can still load, but current rank/volume will be unavailable`);
    }
  } catch (e) {
    debugFail('keywordTracker', e);
  }

  // ── 1c. Optional context/performance sources ─────────────────────────────
  try {
    const masterRows = await fetchCsvByGid(masterSkuSheetId, masterSkuGid, token, 'Master SKU List');
    if (masterRows && masterRows.length) {
      const headers = masterRows[0].map(h => String(h || '').trim());
      const skuIdx = headerIndex(headers, ['SKU']);
      const contextIdx = headerIndex(headers, ['PRODUCT_CONTEXT', 'Product Context']);
      const guardIdx = headerIndex(headers, ['AUDIT_GUARDRAILS', 'Audit Guardrails']);
      if (skuIdx < 0) throw new Error('SKU header not found');
      for (const row of masterRows.slice(1)) {
        const sku = String(row[skuIdx] || '').trim();
        if (!sku) continue;
        skuContextMap[sku] = { productContext: contextIdx >= 0 ? String(row[contextIdx] || '').trim() : '', auditGuardrails: guardIdx >= 0 ? String(row[guardIdx] || '').trim() : '' };
      }
      debugOk('masterSku', { rows: masterRows.length - 1, skuContexts: Object.keys(skuContextMap).length, productContextHeader: contextIdx >= 0, guardrailsHeader: guardIdx >= 0 });
    } else debugFail('masterSku', 'sheet ID/GID not supplied or no rows returned');
  } catch (e) { debugFail('masterSku', e); }

  try {
    const insightRows = await fetchCsvByGid(brandInsightsSheetId, brandInsightsGid, token, 'Brand Insights');
    if (insightRows && insightRows.length) {
      const headers = insightRows[0].map(h => String(h || '').trim());
      const idx = headerIndex(headers, ['Brand_Insights', 'Brand Insights']);
      if (idx < 0) throw new Error('Brand_Insights header not found');
      brandInsights = insightRows.slice(1).map(r => String(r[idx] || '').trim()).filter(Boolean).join('\n');
      debugOk('brandInsights', { insightRows: brandInsights ? brandInsights.split('\n').length : 0 });
    } else debugFail('brandInsights', 'sheet ID/GID not supplied or no rows returned');
  } catch (e) { debugFail('brandInsights', e); }

  try {
    const rows = await fetchCsvByGid(businessReportSheetId, businessReportGid, token, 'Business Report');
    if (rows) { businessReportRows = rowsToObjects(rows); debugOk('businessReport', { rows: businessReportRows.length }); }
    else debugFail('businessReport', 'sheet ID/GID not supplied');
  } catch (e) { debugFail('businessReport', e); }

  try {
    const rows = await fetchCsvByGid(adSearchTermsSheetId, adSearchTermsGid, token, 'Ad Search Terms');
    if (rows) { adSearchTermRows = rowsToObjects(rows); const hasAsin = rows[0] ? headerIndex(rows[0], ['asin']) >= 0 : false; debugOk('adSearchTerms', { rows: adSearchTermRows.length, asinColumnPresent: hasAsin }); }
    else debugFail('adSearchTerms', 'sheet ID/GID not supplied');
  } catch (e) { debugFail('adSearchTerms', e); }

  try {
    const rows = await fetchCsvByGid(amazonReviewsSheetId, amazonReviewsGid, token, 'Amazon Reviews');
    if (rows) { amazonReviewRows = rowsToObjects(rows); debugOk('amazonReviews', { rows: amazonReviewRows.length }); }
    else debugFail('amazonReviews', 'sheet ID/GID not supplied');
  } catch (e) { debugFail('amazonReviews', e); }

  // ── 2. Ensure audit sheet has headers ────────────────────────────────────
  const auditTabName = brand; // tab is named after the brand, e.g. "evolis"
  await ensureAuditHeaders(auditSheetId, auditTabName, token);

  let previousAuditMap = {};
  try {
    const historyUrl = `https://sheets.googleapis.com/v4/spreadsheets/${auditSheetId}/values/${encodeURIComponent(auditTabName + '!A2:T')}?majorDimension=ROWS`;
    const historyRes = await fetch(historyUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!historyRes.ok) throw new Error(`HTTP ${historyRes.status}`);
    const historyRows = (await historyRes.json()).values || [];
    for (const row of historyRows) {
      const date = String(row[0] || '').trim(), sku = String(row[1] || '').trim(), action = String(row[3] || '').trim();
      if (!sku || action !== 'audit_run') continue;
      const audit = { date, titleNotes: row[4] || '', titleRewrite: row[5] || '', ihNotes: row[6] || '', ihRewrite: row[7] || '', bulletsNotes: row[8] || '', bullet1Rewrite: row[9] || '', bullet2Rewrite: row[10] || '', bullet3Rewrite: row[11] || '', bullet4Rewrite: row[12] || '', bullet5Rewrite: row[13] || '', descNotes: row[14] || '', descRewrite: row[15] || '', backendNotes: row[16] || '', backendRewrite: row[17] || '' };
      if (!previousAuditMap[sku] || date > previousAuditMap[sku].date) previousAuditMap[sku] = audit;
    }
    debugOk('auditHistory', { rows: historyRows.length, skusWithPriorAudit: Object.keys(previousAuditMap).length });
  } catch (e) { debugFail('auditHistory', e); }

  // ── 3. Audit each SKU ────────────────────────────────────────────────────
  const auditRows = [];
  const now = new Date().toISOString();
  const auditDate = now.slice(0, 10);

  const systemPrompt = `You are an Amazon listing compliance auditor for ${brand} (Medaltus portfolio).

CONTEXT HIERARCHY — use evidence before generic convention:
1. Actual Amazon/compliance restrictions in CRITICAL RULES
2. AUDIT GUARDRAILS
3. PRODUCT CONTEXT
4. BRAND INSIGHTS
5. Current live listing
6. Previous audit
7. Business performance
8. Current keyword rank/volume + strategy
9. SKU-attributed ad search terms
10. Customer reviews
11. Competitor/category context

Do not present a stylistic preference or common category convention as an Amazon compliance requirement. Preserve meaningful shopper information when compliant. If a convention conflicts with useful product-specific information, explain the tradeoff in NOTES rather than mechanically applying the convention.

CRITICAL RULES:
- Title must be 75 characters or fewer (including spaces). Flag if over.
- Item Highlights must be 125 characters or fewer. Flag if over. Generate one if missing.
- No drug-claim verbs: reverses, regrows, cures, heals, treats, eliminates (disease context)
- No brightening / brightens / brightener / dark spot language
- No "free from X" framed as health risk
- No apostrophes in rewrites (write "does not" not "don't")
- No em dashes in rewrites (use hyphen only)
- No promotional language: no "best", "award-winning" without citation, no "order now"
- No competitor comparisons
- Stats (95% of users etc) require qualifier: "in a consumer perception study"
- FGF5-blocking is mechanistic language — permissible as descriptor, not disease claim
- Backend keywords: spaces only, no commas, no drug-claim terms
- TITLE QUANTITY / SIZE / SERVING INFORMATION: Physical net quantity and shopper-use quantity communicate different things. Do not automatically replace servings, count, supply duration, pack quantity, or format with oz/fl oz when PRODUCT_CONTEXT or AUDIT_GUARDRAILS indicates that information is meaningful to purchase understanding. If both are useful and fit within the portfolio title limit, they may coexist. Use fl oz for liquid physical volume and oz for solid/powder physical weight when physical quantity is shown. A bullet separator before size/quantity is a default house style, not a universal Amazon compliance rule. Scent/flavor may remain parenthetical when it is the meaningful variation-family differentiator. In TITLE_NOTES explain the quantity logic used; never call a quantity presentation noncompliant unless an explicit supplied rule establishes that.
- Timeline claims (e.g. "in 90 days", "in 3 months") require a consumer perception study qualifier. Unqualified timeline claims are a violation. Safe form: "In a consumer perception study, X% of users reported [benefit] in [timeframe]." Timeline claims in Item Highlights are especially risky due to 125-char limit — recommend removing from IH and moving to bullets with full qualifier.
- Item Highlights must not contain unqualified efficacy timelines.
- INGREDIENT QA: When ingredients are provided, cross-check every specific ingredient named in bullets and description against the actual ingredient list. If a bullet claims an ingredient (e.g. "keratin", "rosemary oil", "hyaluronic acid", "vitamin C") that does NOT appear in the ingredient list, flag it as a violation: "Ingredient '[X]' listed in bullet [N] not found in actual ingredient list — remove or verify." Only flag ingredients that are definitively absent. Common ingredient aliases are acceptable (e.g. "Rosmarinus Officinalis" = rosemary oil). If a timeline claim is present in IH without qualifier, flag it and rewrite removing the timeline or moving it to a bullet.

PAST AUDIT + PERFORMANCE RULES:
- Compare the previous recommended copy with the CURRENT LIVE LISTING before making a new recommendation.
- Treat a prior recommendation as NOT IMPLEMENTED, IMPLEMENTED/SUBSTANTIALLY IMPLEMENTED, or NO LONGER RELEVANT.
- Do not claim an unimplemented recommendation failed. Do not repeat the exact same recommendation without acknowledging it was already recommended.
- If a prior change is live and performance is healthy/improving, prefer preserving it absent a meaningful compliance issue or stronger evidence-based opportunity.
- If performance weakened, do not assume the listing change caused it. Sessions, conversion, advertising, inventory, pricing, seasonality and events can all contribute. Use performance as evidence, not proof of causation.

AD SEARCH TERM ATTRIBUTION:
- When a row contains an ASIN matching the audited SKU, treat its metrics as SKU-specific shopper-search evidence.
- When ASIN is blank, absent, or does not match, treat the row only as brand/catalog-level language evidence and do not attribute its sales, purchases, conversion or ACOS to this SKU.
- Never add a term solely because it performs in ads; it must accurately describe the product and comply with guardrails.

CUSTOMER REVIEW EVIDENCE:
- Use recurring themes to identify shopper language, motivations, confusion, expectations and listing information gaps.
- Do not turn an isolated review into a product claim or copy unsupported efficacy language into the listing.
- Distinguish listing-clarity problems from product-experience problems; only recommend copy changes when copy can reasonably address the issue.

COMPETITOR + CATEGORY-LEADER EVIDENCE:
- Comparative context is not a template. Do not copy competitor wording or assume competitor claims/listings are compliant or substantiated for this product.
- Use market data to understand positioning, shopper expectations and supported differentiation. Product-specific evidence outranks competitor/category convention.

HOLISTIC PDP STRATEGY — REQUIRED BEFORE WRITING ANY FIELD:
- Treat the title, Item Highlights, five bullets, description and backend keywords as one coordinated content system. Do not audit or rewrite a field in isolation.
- First inventory the complete available evidence: PRODUCT CONTEXT, AUDIT GUARDRAILS, current listing, prior audit, business performance, keyword rankings and search volume, strategy groups, SKU-attributed ad terms, customer reviews, ingredients, brand insights and market context.
- Build an internal content-priority map before generating rewrites. Identify: core product/use, purchase-critical facts, meaningful differentiators, substantiated proof, key ingredients, recurring customer needs or confusion, compliance constraints, established ranking terms, growth keyword opportunities, and useful information currently missing from the PDP.
- Rank concepts by their value to shopper comprehension, conversion, differentiation, SEO defense, SEO growth and compliance. Existing copy does not receive priority merely because it is already present. PRODUCT CONTEXT is the source of truth for deciding which accurate product facts deserve PDP real estate.
- Then assign each high-priority concept to its strongest appropriate field. Use the title for immediate product identification and the most valuable natural-fit search language; Item Highlights for rapid differentiation; bullets for the five strongest purchase-driving messages; description for useful detail, mechanism, education and supporting information; backend for relevant indexed keyword coverage that does not need shopper-facing placement.
- Eliminate cross-field redundancy. Once a core benefit is clearly established, do not spend scarce space restating it in multiple bullets unless repetition is strategically justified by shopper comprehension or keyword protection.
- Character limits are allocation constraints, not instructions to compress the current field. When a field is over limit, decide which concepts should remain, which should move, which are redundant or low-value enough to remove, and whether higher-priority unused PRODUCT CONTEXT or customer evidence should replace existing copy.
- Do not silently discard meaningful information. If a product fact, customer need, differentiator, proof point or targeted keyword is removed from one field, determine whether it warrants relocation elsewhere in the PDP. State material relocations or intentional omissions concisely in the relevant NOTES field.
- Do not assume all five current bullet topics deserve to survive. Select the five highest-value, nonredundant messages for this specific SKU from all available evidence. Likewise, do not omit a stronger unused message merely because no current bullet contains it.
- Before finalizing, perform a whole-PDP coverage check: confirm the rewrites collectively communicate what the product is, why it matters, its strongest supported differentiators, the most important customer information, and the deliberate keyword strategy without avoidable duplication.
- INPUT AND OUTPUT LENGTHS ARE SEPARATE: The current live title, Item Highlights, bullets, description, backend terms and ingredients are supplied for complete analysis and are not constrained by the rewrite limits. Read and assess the full supplied field. The 75/125/200/400-character limits apply only to the corresponding generated rewrites.
- Do not say that a live field was truncated merely because it exceeds the allowed rewrite length. Only report input truncation if the prompt explicitly labels the field as truncated or includes a truncation marker.

KEYWORD TIER CLASSIFICATION — DO NOT CONFUSE STRATEGY WITH PERFORMANCE:
- Top 20, Opportunity, and Reach for the Stars are STRATEGY GROUPS: they identify keywords we want to target.
- Tier 1, Tier 2, and Tier 3 are PERFORMANCE GROUPS: they are determined from current SHEET_KEYWORD_TRACKER data and the existing tenure logic.
- A keyword may be called TIER 1 only when SHEET_KEYWORD_TRACKER provides a current organic rank <= PAGE1_RANK_CUTOFF for this SKU.
- A keyword may be called TIER 2 only when SHEET_KEYWORD_TRACKER provides a current organic rank > PAGE1_RANK_CUTOFF and <= CLOSE_TO_PAGE1_MAX for this SKU.
- A keyword may be called TIER 3 only when the existing Tier 3 tenure logic qualifies it.
- If the tracker has no current organic rank for a keyword, NEVER describe it as Tier 1 or Tier 2.
- Never infer a performance tier merely because a keyword appears in Top 20, Opportunity, Reach, the live listing, a previous audit, ads, reviews, or competitor data.

TITLE KEYWORD SELECTION:
- Title space is scarce. For SEO-oriented title language, preferentially use exact target keywords or natural grammatical forms of target keywords supplied in the strategy/performance evidence.
- Priority for title SEO terms: Tier 1 Protect, then Tier 2 Push, then relevant Top 20 strategy keywords, then relevant Opportunity keywords. Reach for the Stars may be used only when strategically justified and when stronger target terms do not fit or are not appropriate.
- Do NOT invent a new keyword phrase merely because it sounds natural, compact, or semantically related to the product.
- Do NOT replace an available targeted keyword with an untracked synonym just to shorten the title.
- An untracked phrase may be used only when it is necessary for accurate shopper comprehension/grammar or PRODUCT_CONTEXT/BRAND_INSIGHTS establishes it as important product terminology. If used, TITLE_NOTES must explicitly say it is untracked and explain why it is preferable to the available target keywords.
- When shortening a title to meet the character limit, first look for a shorter accurate/compliant phrase from the supplied target keyword lists. Do not fill newly available title space with invented SEO terminology while relevant target keywords are available.
- Consider current organic rank, search volume, strategy group, exact product relevance, compliance, and shopper comprehension together. Do not keyword-stuff.

SEO EQUITY DEFENSE + KEYWORD RELOCATION:
- Treat meaningful existing organic rankings as established SEO equity. The goal is incremental visibility growth without avoidable backsliding.
- Before removing, materially altering, or reducing the prominence of a ranked keyword, evaluate its current organic rank, search volume, current PDP placement, exact product relevance and strategic importance. Consider ranking trajectory when trajectory data is supplied; never invent a trend when only current rank is available.
- Protect valuable ranking terms in their current prominent field when practical. A larger-volume opportunity does not automatically justify displacing a relevant term with an established valuable ranking.
- Before removing any targeted or ranked keyword from a field, check whether it appears elsewhere in the current PDP and proposed PDP. If it deserves continued coverage, relocate it to the strongest natural and compliant field available rather than letting it disappear.
- Preserve exact keyword phrasing or a natural grammatical form when doing so remains accurate and readable. Do not force awkward repetition, keyword stuffing, irrelevant terms or noncompliant claims solely to preserve text.
- Evaluate defense and opportunity together: protect what the ASIN is already winning, identify valuable coverage gaps, and add realistic growth terms without unnecessarily sacrificing existing visibility.
- If an important keyword must be removed because it is inaccurate, noncompliant, irreconcilably awkward or displaced by materially stronger evidence, explain the tradeoff in the relevant NOTES field.
- Complete this defense analysis before drafting rewrites, not as a QA step after the copy has already been written.

KEYWORD COVERAGE RULES — priority order matters, read the tiers below carefully:
- TIER 1 keywords (already ranking page 1) are the highest SEO-defense priority. If a rewrite would remove or weaken a Tier 1 keyword in the field where it currently appears, treat that as a critical SEO risk: preserve it when accurate, compliant and natural, or explicitly explain the unavoidable tradeoff. Do not sacrifice valuable page-1 equity merely to add a new term or make copy sound cleaner.
- TIER 2 keywords (close to page 1, sorted by volume) are the priority for NEW placement — these are the closest realistic wins. When choosing what to add to a field, prefer a Tier 2 keyword over an unranked keyword every time, even if the unranked one seems more "important" — proximity to page 1 with real volume behind it is worth more right now than a keyword with no ranking traction at all, no matter how strategically desirable that keyword sounds.
- TIER 3 items (in the listing a long time, still not ranking) are NOT a placement task — do not just try to shove them into more fields. Raise them as a genuine open question in the relevant NOTES field: is this keyword too competitive for this listing to win, and does the suggested lower-volume alternative deserve a try instead? Do not resolve this question yourself — surface it for a human decision.
- Do NOT recommend adding drug-claim keywords or any keyword that violates compliance rules, regardless of tier.
- In BACKEND_NOTES: flag any Tier 1 or Tier 2 keyword missing from every field. In BACKEND_REWRITE: ensure Tier 1 and Tier 2 keywords not already in title/bullets/item highlights are in the backend.
- In BULLETS_NOTES: flag the highest-priority keyword gaps by tier order (Tier 1 gaps first, then Tier 2), with specific placement recommendations respecting the field-priority order given above.

BULLET FORMATTING RULES (apply to all bullet rewrites):
- Every bullet must open with an ALL-CAPS phrase (3-6 words) followed by a colon, then sentence-case detail. Example: "CLINICALLY TESTED HAIR GROWTH SERUM: In 3 independent studies, 95% of users reported visibly thicker hair."
- Flag any bullet that does NOT follow this ALL-CAPS header: detail format as a violation.
- Choose bullet topics only after completing the holistic PDP strategy. Each bullet must earn its space as one of the five strongest purchase-driving, nonredundant messages for this SKU.
- For genuinely related variations, align parallel bullet positions when doing so improves comparison and consistency. Use B1 = hero value/proof, B2 = science/mechanism, B3 = key ingredients, B4 = intended user/use case, and B5 = credentials/formula as a flexible starting framework, not a mandatory template. Reorder or replace topics when PRODUCT CONTEXT, customer evidence or keyword strategy shows a different sequence is more valuable.
- When shortening a bullet, do not merely compress its existing sentences. Reassess the current bullet against all unused and used evidence, retain only concepts that deserve bullet-level prominence, and relocate worthwhile supporting detail to the description or another appropriate field.
- Within a single SKU, bullet headers should not repeat the same keyword root — vary to maximize keyword coverage.
- Bullet rewrites must be max 200 chars including the ALL-CAPS header.

OUTPUT FORMAT — use exactly these labels, one per line, no JSON, no markdown:
TITLE_NOTES: [violations found, or "No violations" if clean. Max 300 chars.]
TITLE_REWRITE: [compliant rewrite, max 75 chars. If clean, repeat original trimmed to 75.]
IH_NOTES: [violations found, or generated if missing. Max 300 chars.]
IH_REWRITE: [compliant rewrite or new copy, max 125 chars.]
BULLETS_NOTES: [key violations across all bullets, noted by bullet number. Max 500 chars. Empty string if travel SKU.]
BULLET_1_REWRITE: [compliant rewrite of bullet 1, max 200 chars. Empty string if travel SKU.]
BULLET_2_REWRITE: [compliant rewrite of bullet 2, max 200 chars. Empty string if travel SKU.]
BULLET_3_REWRITE: [compliant rewrite of bullet 3, max 200 chars. Empty string if travel SKU.]
BULLET_4_REWRITE: [compliant rewrite of bullet 4, max 200 chars. Empty string if travel SKU.]
BULLET_5_REWRITE: [compliant rewrite of bullet 5, max 200 chars. Empty string if travel SKU.]
DESC_NOTES: [violations found in description, or "No violations" if clean. Max 300 chars. Empty string if travel SKU.]
DESC_REWRITE: [compliant rewrite of description, max 400 chars, plain sentences no bullets. Empty string if travel SKU.]
BACKEND_NOTES: [violations found, or "No violations" if clean. Max 300 chars.]
BACKEND_REWRITE: [compliant backend keywords, max 200 chars, spaces only no commas.]

Write nothing else. No preamble. No explanation after the last line. Start immediately with TITLE_NOTES:`;

  for (const row of rows) {
    const sku  = (row[COL.sku]  || '').trim();
    const name = (row[COL.name] || '').trim();
    const travel = isTravel(row);

    try {
      // Preserve the complete current PDP for analysis. Rewrite limits belong
      // only to Claude's output instructions, never to these input fields.
      const title        = san(row[COL.title]);
      const ih           = san(row[COL.item_highlights]) || 'MISSING';
      const b1           = san(row[COL.bullet_1]);
      const b2           = san(row[COL.bullet_2]);
      const b3           = san(row[COL.bullet_3]);
      const b4           = san(row[COL.bullet_4]);
      const b5           = san(row[COL.bullet_5]);
      const desc         = san(row[COL.description]);
      const backend      = san(row[COL.backend_keywords]);
      const ingredients  = san(row[COL.ingredients]);
      const asin = (row[COL.asin] || '').trim();
      const skuContext = skuContextMap[sku] || {};
      const productContext = san(skuContext.productContext || '');
      const auditGuardrails = san(skuContext.auditGuardrails || '');
      const previousAudit = previousAuditMap[sku] || null;
      const contextBlock = `
BUSINESS CONTEXT:
BRAND INSIGHTS: ${san(brandInsights) || 'NOT AVAILABLE'}
PRODUCT CONTEXT: ${productContext || 'NOT AVAILABLE'}
AUDIT GUARDRAILS: ${auditGuardrails || 'NOT AVAILABLE'}
`;
      const previousAuditContext = previousAudit ? `
PREVIOUS AUDIT (${previousAudit.date}):
Title recommendation: ${san(previousAudit.titleRewrite, 300) || 'None'}
Item Highlights recommendation: ${san(previousAudit.ihRewrite, 300) || 'None'}
Bullet recommendations: ${[previousAudit.bullet1Rewrite, previousAudit.bullet2Rewrite, previousAudit.bullet3Rewrite, previousAudit.bullet4Rewrite, previousAudit.bullet5Rewrite].map((x,i)=>`${i+1}. ${san(x,250) || 'None'}`).join(' | ')}
Description recommendation: ${san(previousAudit.descRewrite, 450) || 'None'}
Backend recommendation: ${san(previousAudit.backendRewrite, 250) || 'None'}
Prior notes: ${san([previousAudit.titleNotes, previousAudit.ihNotes, previousAudit.bulletsNotes, previousAudit.descNotes, previousAudit.backendNotes].filter(Boolean).join(' | '), 1000) || 'None'}
` : '\nPREVIOUS AUDIT: No previous audit is available for this SKU.\n';

      let userPrompt;
      if (travel) {
        userPrompt = `Audit this TRAVEL SIZE SKU. For travel SKUs only check title and item highlights. Set BULLETS_NOTES, BULLET_1_REWRITE through BULLET_5_REWRITE, DESC_NOTES, and DESC_REWRITE to empty strings.
${contextBlock}${previousAuditContext}
SKU: ${sku}
Name: ${name} [TRAVEL SIZE]
Title (${title.length} chars as received by audit): ${title}
Item Highlights: ${ih}
Backend: ${backend}`;
      } else {
        // Pass sibling SKU names for cross-catalog bullet alignment
        const siblings = rows
          .filter(r => (r[COL.sku] || '').trim() !== sku && !isTravel(r))
          .map(r => (r[COL.name] || '').trim())
          .filter(Boolean)
          .slice(0, 8)
          .join(', ');

        // Build keyword coverage context — 3-tier priority system, added
        // 2026-07-27 per Jaclyn (see header comment). Replaces the old
        // "prioritize unranked keywords" logic entirely.
        const skuKws = skuStrategyMap[sku] || null;
        const kwTrackerLookup = buildKwTrackerLookup(kwTrackerRows, sku);
        let kwContext = '';

        if (skuKws && skuKws.top20.length) {
          const allTargetKeywords = [...skuKws.top20, ...(skuKws.opportunity || [])];
          const { tier1Protect, tier2Push, other } = categorizeKeywordTiers(allTargetKeywords, kwTrackerLookup);
          const tier3 = buildTier3Reconsiderations(other, sku, allRawRows, skuKws.reach || [], kwTrackerLookup);

          const fmt = e => `${e.keyword}${e.rank !== null ? ` (rank #${e.rank}` : ' (not ranking'}${e.volume !== null ? `, ${e.volume}/mo)` : ')'}`;

          kwContext = `
QUARTERLY KEYWORD STRATEGY GROUPS (these are TARGET GROUPS, not performance tiers):
TOP 20 TARGETS: ${skuKws.top20.length ? skuKws.top20.join(', ') : 'None supplied.'}
OPPORTUNITY TARGETS: ${(skuKws.opportunity || []).length ? skuKws.opportunity.join(', ') : 'None supplied.'}
REACH FOR THE STARS: ${(skuKws.reach || []).length ? skuKws.reach.join(', ') : 'None supplied.'}

IMPORTANT: Only the tracker-derived sections below establish Tier 1/Tier 2 status. A keyword appearing in a strategy group does not make it Tier 1 or Tier 2.

TIER 1 — PROTECT (already ranking page 1 — DO NOT let a rewrite remove or weaken these; this is the highest priority, above adding anything new):
${tier1Protect.length ? tier1Protect.map(fmt).join(', ') : 'None currently on page 1 for this SKU.'}

TIER 2 — PUSH (rank ${PAGE1_RANK_CUTOFF + 1}-${CLOSE_TO_PAGE1_MAX}, sorted by volume — closest realistic wins, prioritize placement for these over anything unranked):
${tier2Push.length ? tier2Push.map(fmt).join(', ') : 'None in this range currently.'}
${tier3.length ? `
TIER 3 — RECONSIDER (in the listing well past a competitiveness-scaled threshold per daily listing snapshots — longer for higher-volume/more-competitive terms, shorter for lower-volume ones — still not ranking at all — raise as a QUESTION, not a directive: is this keyword too competitive to win, and would a lower-volume alternative be more attainable?):
${tier3.map(t => `"${t.keyword}"${t.volume !== null ? ` (${t.volume}/mo)` : ''} — in listing ${t.tenure_days} days (past the ${t.tenure_threshold_applied}-day threshold for its volume tier), no rank${t.suggested_alternative ? `. Consider substituting: "${t.suggested_alternative}"` : ''}`).join('; ')}` : ''}

FIELD PRIORITY FOR PLACEMENT (highest SEO weight to lowest): Title > Item Highlights > Bullets > Product Description > Backend Keywords. When a Tier 1 or Tier 2 keyword is missing, place it in the HIGHEST-weight field it can compliantly fit in that's currently missing it — do not default to backend just because there's room there.`;
        } else if (Object.keys(kwTrackerLookup).length > 0) {
          const trackedKeywords = Object.entries(kwTrackerLookup).map(([keyword, data]) => ({ keyword, rank: data.rank, volume: data.volume }));
          const byVolume = (a, b) => (b.volume || 0) - (a.volume || 0);
          const trackerPage1 = trackedKeywords.filter(k => k.rank !== null && k.rank <= PAGE1_RANK_CUTOFF).sort(byVolume);
          const trackerPush = trackedKeywords.filter(k => k.rank !== null && k.rank > PAGE1_RANK_CUTOFF && k.rank <= CLOSE_TO_PAGE1_MAX).sort(byVolume);
          const trackerOther = trackedKeywords.filter(k => k.rank === null || k.rank > CLOSE_TO_PAGE1_MAX).sort(byVolume);
          kwContext = `
KEYWORD PERFORMANCE — QUARTERLY STRATEGY LIST NOT AVAILABLE:
Do not invent Top 20, Opportunity, or Reach classifications.
CURRENT PAGE-1 / PROTECT TERMS: ${JSON.stringify(trackerPage1.slice(0, 15))}
CURRENT PUSH OPPORTUNITIES: ${JSON.stringify(trackerPush.slice(0, 15))}
OTHER TRACKED TERMS: ${JSON.stringify(trackerOther.slice(0, 15))}
FIELD PRIORITY FOR PLACEMENT: Title > Item Highlights > Bullets > Product Description > Backend Keywords.`;
        }

        const skuBusinessRows = businessReportRows.filter(r => String(r.SKU || r.sku || '').trim() === sku).sort((a,b) => `${b.YEAR || b.year || ''}-${String(b.MONTH || b.month || '').padStart(2,'0')}`.localeCompare(`${a.YEAR || a.year || ''}-${String(a.MONTH || a.month || '').padStart(2,'0')}`)).slice(0, 6);
        const performanceContext = skuBusinessRows.map(r => ({ month: r.MONTH || r.month, year: r.YEAR || r.year, sessions: r.SESSIONS || r.sessions, pageViews: r.PAGE_VIEWS || r.page_views, units: r.UNITS_ORDERED_CLEAN || r.units_ordered_clean || r.UNITS_ORDERED || r.units_ordered, sales: r.ORDERED_PRODUCT_SALES_CLEAN || r.ordered_product_sales_clean || r.ORDERED_PRODUCT_SALES || r.ordered_product_sales, conversionRate: r.CONVERSION_RATE || r.conversion_rate }));

        const adAsinRows = asin ? adSearchTermRows.filter(r => String(r.asin || r.ASIN || '').trim().toUpperCase() === asin.toUpperCase()) : [];
        const unattributedAdRows = adSearchTermRows.filter(r => !String(r.asin || r.ASIN || '').trim());
        const sortAds = arr => [...arr].sort((a,b) => Number(b.sales||0)-Number(a.sales||0) || Number(b.purchases||0)-Number(a.purchases||0) || Number(b.clicks||0)-Number(a.clicks||0));
        const formatAd = r => ({ searchTerm:r.search_term, keyword:r.keyword, matchType:r.match_type, adType:r.ad_type, impressions:r.impressions, clicks:r.clicks, purchases:r.purchases, sales:r.sales, conversionRate:r.conversion_rate, acos:r.acos, year:r.year, month:r.month });
        const adSearchContext = adAsinRows.length ? `SKU-SPECIFIC AD SEARCH TERMS (ASIN ${asin}): ${JSON.stringify(sortAds(adAsinRows).slice(0,30).map(formatAd))}\nUNATTRIBUTED BRAND/CATALOG SEARCH LANGUAGE: ${JSON.stringify(sortAds(unattributedAdRows).slice(0,20).map(formatAd))}` : `No ASIN-attributed ad search terms found for ${asin || 'this SKU'}. Treat these only as brand/catalog-level language evidence: ${JSON.stringify(sortAds(adSearchTermRows).slice(0,30).map(formatAd))}`;

        const skuReviews = amazonReviewRows.filter(r => String(r.sku || r.SKU || '').trim() === sku || (asin && String(r.asin || r.ASIN || '').trim().toUpperCase() === asin.toUpperCase())).sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')));
        const lowReviews = skuReviews.filter(r => Number(r.star_rating) <= 3).slice(0,12);
        const highReviews = skuReviews.filter(r => Number(r.star_rating) >= 4).slice(0,12);
        const reviewSample = [...lowReviews, ...highReviews].slice(0,24).map(r => ({ rating:r.star_rating, title:san(r.review_title,150), review:san(r.review_text,500), date:r.date, purchaseType:r.purchase_type }));

        function compactMarketProduct(p) { return { asin:p['ASIN']||'', brand:p['Brand']||'', productName:p['Product Name']||'', itemHighlights:san(p['Item Highlights'],300), price:p['Price']||'', size:p['Size']||'', pricePerOz:p['Price/oz']||'', rating:p['Rating']||'', reviewCount:p['# Reviews']||'', estimatedMonthlySales:p['Est Monthly Sales']||'', subcategoryBsr:p['Subcategory BSR']||'', keyIngredients:san(p['Key Ingredients'],300), keyBenefits:san(p['Key Benefits Clinically'],300), skinType:p['Skin Type']||'', cleanStandards:san(p['Clean Standards/Certifications'],200), fragrance:p['Fragrance']||'', targetConsumer:san(p['Target Consumer'],200), priceTier:p['Price Tier']||'', competitiveAdvantage:san(p['Competitive Advantage'],300), threatLevel:p['Threat Level']||'', bullet1:san(p['Bullet1'],250), bullet2:san(p['Bullet2'],250), bullet3:san(p['Bullet3'],250), bullet4:san(p['Bullet4'],250), bullet5:san(p['Bullet5'],250), description:san(p['Description'],400) }; }
        const marketContext = `CLOSE COMPETITORS: ${JSON.stringify((skuKws?.competitors || []).slice(0,10).map(compactMarketProduct))}\nCATEGORY LEADERS: ${JSON.stringify((skuKws?.categoryLeaders || []).slice(0,10).map(compactMarketProduct))}`;

        console.log(`[listing-audit][debug] ${sku}: context product=${!!productContext}, guardrails=${!!auditGuardrails}, priorAudit=${!!previousAudit}, businessMonths=${performanceContext.length}, trackerKeywords=${Object.keys(kwTrackerLookup).length}, adAsinRows=${adAsinRows.length}, reviews=${skuReviews.length}, competitors=${(skuKws?.competitors||[]).length}, leaders=${(skuKws?.categoryLeaders||[]).length}`);
        console.log(`[listing-audit][debug] ${sku}: liveTitleChars=${title.length}, liveTitle=${JSON.stringify(title)}, strategyTop20=${skuKws?.top20?.length || 0}, strategyOpportunity=${skuKws?.opportunity?.length || 0}, strategyReach=${skuKws?.reach?.length || 0}`);

        userPrompt = `Audit this full listing SKU.
${contextBlock}${previousAuditContext}
RECENT BUSINESS PERFORMANCE (up to 6 months): ${performanceContext.length ? JSON.stringify(performanceContext) : 'NOT AVAILABLE'}
${kwContext}
AD SEARCH TERM EVIDENCE: ${adSearchContext}
CUSTOMER REVIEW EVIDENCE: Total available ${skuReviews.length}; balanced recent sample ${reviewSample.length ? JSON.stringify(reviewSample) : 'NOT AVAILABLE'}
COMPETITIVE MARKET CONTEXT: ${marketContext}

SKU: ${sku}
Name: ${name}
ASIN: ${asin}
Related SKUs in this catalog: ${siblings || 'none'}
Title (${title.length} chars as received by audit): ${title}
Item Highlights (${ih === 'MISSING' ? 0 : ih.length} chars as received by audit): ${ih}
Bullet 1 (${b1.length} chars as received by audit): ${b1}
Bullet 2 (${b2.length} chars as received by audit): ${b2}
Bullet 3 (${b3.length} chars as received by audit): ${b3}
Bullet 4 (${b4.length} chars as received by audit): ${b4}
Bullet 5 (${b5.length} chars as received by audit): ${b5}
Description (${desc.length} chars as received by audit): ${desc}
Backend: ${backend}
Ingredients: ${ingredients || 'NOT AVAILABLE'}`;
      }

      // Call Claude — retry once on 429
      let claudeRes;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          const wait = attempt * 10000;
          console.log(`[listing-audit] ${sku} retry ${attempt} after ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        }
        claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: travel ? 600 : 2500,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
          })
        });
        if (claudeRes.status !== 429) break;
        console.log(`[listing-audit] ${sku} 429 rate limit — will retry`);
      }

      // Sleep between SKUs — shorter for travel SKUs (title+IH only = faster response)
      await new Promise(r => setTimeout(r, travel ? 500 : 1500));

      if (!claudeRes.ok) {
        const errText = await claudeRes.text().catch(() => '');
        console.error(`[listing-audit] ${sku} Claude error ${claudeRes.status}: ${errText.slice(0, 100)}`);
        debug.skus[sku] = { ok: false, error: `Claude HTTP ${claudeRes.status}` };
        debug.warnings.push(`sku:${sku}: Claude HTTP ${claudeRes.status}`);
        auditRows.push(buildErrorRow(auditDate, sku, name, `Claude error ${claudeRes.status}`, now));
        continue;
      }

      const claudeData = await claudeRes.json();
      const rawText = (claudeData.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      // Parse plain-text delimited response — zero JSON involved
      const parsed = parseDelimited(rawText);

      auditRows.push([
        auditDate,
        sku,
        name,
        'audit_run',
        parsed.title_notes,
        parsed.title_rewrite,
        parsed.ih_notes,
        parsed.ih_rewrite,
        travel ? '' : parsed.bullets_notes,
        travel ? '' : parsed.bullet_1_rewrite,
        travel ? '' : parsed.bullet_2_rewrite,
        travel ? '' : parsed.bullet_3_rewrite,
        travel ? '' : parsed.bullet_4_rewrite,
        travel ? '' : parsed.bullet_5_rewrite,
        travel ? '' : parsed.desc_notes,
        travel ? '' : parsed.desc_rewrite,
        parsed.backend_notes,
        parsed.backend_rewrite,
        '',   // skip_reason
        now   // audited_at
      ]);

      debug.skus[sku] = { ok: true };
      console.log(`[listing-audit] ✓ ${sku}`);

    } catch (err) {
      debug.skus[sku] = { ok: false, error: err.message };
      debug.warnings.push(`sku:${sku}: ${err.message}`);
      console.error(`[listing-audit] ✗ ${sku}: ${err.message}`);
      auditRows.push(buildErrorRow(auditDate, sku, name, err.message, now));
    }
  }

  // ── 4. Write all audit rows to the audit sheet ───────────────────────────
  if (auditRows.length) {
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${auditSheetId}/values/${encodeURIComponent(auditTabName + '!A2')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const appendRes = await fetch(appendUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: auditRows })
    });

    if (!appendRes.ok) {
      const err = await appendRes.text();
      console.error('[listing-audit] Sheet write failed:', appendRes.status, err.slice(0, 200));
      return res.status(502).json({
        error: 'Audit completed but sheet write failed',
        status: appendRes.status,
        skuCount: auditRows.length
      });
    }
  }

  debugOk('auditWrite', { rowsWritten: auditRows.length, tab: auditTabName });
  console.log(`[listing-audit] Done — ${auditRows.length} rows written`);
  return res.status(200).json({ ok: true, skuCount: auditRows.length, debug });
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildErrorRow(date, sku, name, errorMsg, now) {
  return [
    date, sku, name, 'error',
    errorMsg.slice(0, 300), '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', now
  ];
}

async function ensureAuditHeaders(sheetId, tabName, token) {
  const checkRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1:T1')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // FIXED 2026-09-18 per Jaclyn — this used to just `return` here on any
  // non-ok response, which silently no-opped for BOTH kinds of failure it
  // could mean: (a) some other real error (auth, rate limit, etc — fine to
  // bail and let the caller's own logging surface it), and (b) the tab
  // for this brand doesn't exist in the audit-results spreadsheet yet,
  // which is NOT fine to silently skip — it let execution fall through to
  // the append step below, which then failed for real with "Unable to
  // parse range: <tab>!A2" (exactly what happened on Crème Shop's first
  // real audit run: its tab was simply never created in
  // LISTING_AUDIT_SHEET_ID, and this function's silence hid that until
  // the append blew up with a much less useful error two steps later).
  // Every new brand this script gets pointed at will hit this same gap
  // on its first run unless its tab already happens to exist, so this is
  // fixed at the source rather than as a one-off "go add a tab" — a
  // brand-new tab is created automatically now, exactly like a brand-new
  // Google Sheet does when you type a name that doesn't exist yet.
  if (!checkRes.ok) {
    let body = '';
    try { body = await checkRes.text(); } catch (_) { /* ignore */ }
    const isMissingTab = checkRes.status === 400 && /Unable to parse range/i.test(body);
    if (!isMissingTab) {
      console.error(`[listing-audit] ensureAuditHeaders: header check failed for tab "${tabName}" (${checkRes.status}): ${body.slice(0, 300)}`);
      return;
    }
    console.warn(`[listing-audit] tab "${tabName}" not found in audit sheet — creating it now`);
    const createRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: tabName } } }]
        })
      }
    );
    if (!createRes.ok) {
      const createErr = await createRes.text().catch(() => '');
      console.error(`[listing-audit] failed to create tab "${tabName}" (${createRes.status}): ${createErr.slice(0, 300)}`);
      return;
    }
    console.warn(`[listing-audit] tab "${tabName}" created — writing headers`);
    // Fall through to the header write below — the tab now exists but is
    // brand new, so its A1:T1 is empty and needs headers exactly like the
    // "existing tab, empty header row" path this function already handles.
  } else {
    const data = await checkRes.json();
    if (data.values && data.values[0] && data.values[0].length > 0) return;
  }

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1')}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [[
          'date', 'sku', 'sku_name', 'action',
          'title_notes', 'title_rewrite',
          'ih_notes', 'ih_rewrite',
          'bullets_notes',
          'bullet_1_rewrite', 'bullet_2_rewrite', 'bullet_3_rewrite', 'bullet_4_rewrite', 'bullet_5_rewrite',
          'desc_notes', 'desc_rewrite',
          'backend_notes', 'backend_rewrite',
          'skip_reason', 'audited_at'
        ]]
      })
    }
  );
}
