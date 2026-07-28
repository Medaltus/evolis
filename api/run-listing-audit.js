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
 * This needed a new data source this file didn't have before: rank alone
 * (from the uploads log) isn't enough to build real tiers, volume is
 * required too, and volume only exists in the keyword tracker sheet —
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

// ─── uploads log sheet ───────────────────────────────────────────────────────
// Sheet ID passed in POST body as uploadsSheetId (optional).
// Tab name = brand (e.g. "evolis"). Columns: date, week_label, kw_summary_json, ...
// kw_summary_json is a JSON array: [{asin, kw, rank, vl, aba_click, aba_conv}, ...]
// We read the most recent row and build a rank lookup: keyword → rank

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
// + upload-keyword-tracker.js's own example) — reused here rather than
// relying only on the uploads-log rankings, since the tracker has BOTH
// rank and search volume per keyword, and volume is required to do this
// prioritization at all (the uploads log has rank only).
const KEYWORD_TRACKER_SHEET_ID = '1geNDQgd_1ensLDyZOuXZBnvQrFT_RC85l9rHHGpgJe4';

// Real page-1 depth varies ~24-60 depending on layout/sponsored density —
// 48 is a working middle, same cutoff run-analysis.js uses, adjust here if
// it's consistently off in practice. 49-100 = "close" — a realistic push
// target, not "anything not page 1."
const PAGE1_RANK_CUTOFF = 48;
const CLOSE_TO_PAGE1_MAX = 100;
// How long a keyword needs to have sat unchanged in the listing with zero
// ranking progress before it's worth questioning whether it's simply too
// competitive to win. Adjustable — 30 days was chosen as "long enough to
// rule out normal indexing lag," not because of any specific data point.
const LONG_TENURE_DAYS = 30;

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
function categorizeKeywordTiers(allKeywords, kwTrackerLookup, kwRankingsFallback) {
  const tier1Protect = [];  // rank <= PAGE1_RANK_CUTOFF — already page 1, do not lose
  const tier2Push = [];     // rank 49-100 — close, push toward page 1
  const other = [];         // unranked, or ranked >100 — not a placement priority this pass

  allKeywords.forEach(kw => {
    const key = normTerm(kw);
    const tracked = kwTrackerLookup[key];
    const rank = tracked ? tracked.rank : (kwRankingsFallback[key] || null);
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
    if (tenureDays === null || tenureDays < LONG_TENURE_DAYS) return;
    const alternative = reachKeywords.find(rk => {
      const key = normTerm(rk);
      return !alreadyUsedReach.has(key) && key !== normTerm(keyword);
    });
    if (alternative) alreadyUsedReach.add(normTerm(alternative));
    out.push({
      keyword,
      volume,
      tenure_days: tenureDays,
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
// HTML entities, extra whitespace. Truncate to maxLen.
function san(s, maxLen) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, 'and').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/[\u2018\u2019\u0060\u00b4]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen || 400);
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

  const { brand, sourceSheetId, auditSheetId, auditGid, sku: testSku, keywordSheetId, skuGidMap, uploadsSheetId, uploadsGid, skuFilter } = req.body || {};

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
  let kwRankings = {};    // keyword (lowercase) → rank number
  let skuKeywordMap = {}; // sku → { top20, opportunity, reach }

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

  // ── 0b. Now fetch keyword data (token is available) ─────────────────────────
  if (uploadsSheetId) {
    try {
      const uploadsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${uploadsSheetId}/values/${encodeURIComponent(brand + '!A:F')}?majorDimension=ROWS`;
      const uploadsRes = await fetch(uploadsUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (uploadsRes.ok) {
        const uploadsData = await uploadsRes.json();
        const uploadsRows = (uploadsData.values || []).slice(1);
        for (let i = uploadsRows.length - 1; i >= 0; i--) {
          const kwJson = uploadsRows[i][2];
          if (kwJson) {
            try {
              const kwArr = JSON.parse(kwJson);
              for (const entry of kwArr) {
                if (entry.kw && entry.rank) {
                  kwRankings[entry.kw.toLowerCase().trim()] = parseInt(entry.rank) || 999;
                }
              }
              console.log(`[listing-audit] Loaded ${Object.keys(kwRankings).length} keyword rankings`);
            } catch(e) { console.warn('[listing-audit] kw_summary_json parse error:', e.message); }
            break;
          }
        }
      }
    } catch(e) { console.warn('[listing-audit] Could not fetch upload rankings:', e.message); }
  }

  if (keywordSheetId && skuGidMap) {
    for (const [skuKey, gid] of Object.entries(skuGidMap)) {
      try {
        // Fetch the tab as CSV using export URL with gid parameter
        const csvUrl = `https://docs.google.com/spreadsheets/d/${keywordSheetId}/export?format=csv&gid=${gid}`;
        const csvRes = await fetch(csvUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!csvRes.ok) { console.warn(`[listing-audit] KW sheet fetch failed for ${skuKey}: ${csvRes.status}`); continue; }
        const csvText = await csvRes.text();
        const csvLines = csvText.split('\n').map(l => l.trim());

        // Find row 2 (index 1) as headers — keywords headers are in row 2
        // Row 1 is row index 0, row 2 is index 1
        const headerLine = csvLines[1] || csvLines[0] || '';
        const headers = parseSimpleCsv(headerLine);

        const top20Idx = headers.findIndex(h => h.trim() === 'Top 20 Keywords');
        const oppIdx   = headers.findIndex(h => h.trim() === 'Top 20 Opportunity Keywords');
        const reachIdx = headers.findIndex(h => h.trim() === 'Top 20 Reach for the stars keywords');

        if (top20Idx < 0) { console.warn(`[listing-audit] No keyword headers found for ${skuKey}`); continue; }

        // Collect keywords from all data rows for those columns
        function colKws(colIdx) {
          if (colIdx < 0) return [];
          const kws = [];
          for (let r = 2; r < csvLines.length; r++) {
            const cells = parseSimpleCsv(csvLines[r]);
            const val = (cells[colIdx] || '').trim();
            if (val) {
              val.split(/\n|\r|,/).map(k => k.trim()).filter(Boolean).forEach(k => kws.push(k));
            }
          }
          return [...new Set(kws)].slice(0, 20);
        }

        skuKeywordMap[skuKey] = {
          top20:       colKws(top20Idx),
          opportunity: colKws(oppIdx),
          reach:       colKws(reachIdx),
        };
        console.log(`[listing-audit] ${skuKey}: ${skuKeywordMap[skuKey].top20.length} top20 keywords loaded`);
      } catch(e) { console.warn(`[listing-audit] KW fetch error for ${skuKey}:`, e.message); }
    }
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
      const lines = csvText.trim().split('\n');
      if (lines.length > 1) {
        const headers = parseSimpleCsv(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
        for (let i = 1; i < lines.length; i++) {
          const cells = parseSimpleCsv(lines[i]).map(c => c.replace(/^"|"$/g, '').trim());
          const obj = {};
          headers.forEach((h, idx) => { obj[h] = cells[idx] || ''; });
          kwTrackerRows.push(obj);
        }
      }
      console.log(`[listing-audit] keyword tracker: ${kwTrackerRows.length} rows loaded for ${brand}`);
    } else {
      console.warn(`[listing-audit] keyword tracker fetch failed (${kwTrackerRes.status}) — tier 1/2/3 keyword priority will fall back to uploads-log rank only, no volume`);
    }
  } catch (e) {
    console.warn('[listing-audit] keyword tracker fetch error:', e.message);
  }

  // ── 2. Ensure audit sheet has headers ────────────────────────────────────
  const auditTabName = brand; // tab is named after the brand, e.g. "evolis"
  await ensureAuditHeaders(auditSheetId, auditTabName, token);

  // ── 3. Audit each SKU ────────────────────────────────────────────────────
  const auditRows = [];
  const now = new Date().toISOString();
  const auditDate = now.slice(0, 10);

  const systemPrompt = `You are an Amazon listing compliance auditor for ${brand} (Medaltus portfolio).

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
- SIZE FORMAT IN TITLE: Size must always appear at the end of the title in parentheses. Liquid products (serums, shampoos, conditioners, masks, oils) must use "fl oz" format: (1.7 fl oz), (8.5 fl oz), (2 fl oz). Non-liquid/powder products use "oz" only: (5.2 oz). Never use bare "oz" without "fl" for liquid products. Never omit parentheses around size. Never place size mid-title. Flag any title where size is missing, uses wrong format, or lacks parentheses. Rewrite must include size in correct format at end of title.
- Timeline claims (e.g. "in 90 days", "in 3 months") require a consumer perception study qualifier. Unqualified timeline claims are a violation. Safe form: "In a consumer perception study, X% of users reported [benefit] in [timeframe]." Timeline claims in Item Highlights are especially risky due to 125-char limit — recommend removing from IH and moving to bullets with full qualifier.
- Item Highlights must not contain unqualified efficacy timelines.
- INGREDIENT QA: When ingredients are provided, cross-check every specific ingredient named in bullets and description against the actual ingredient list. If a bullet claims an ingredient (e.g. "keratin", "rosemary oil", "hyaluronic acid", "vitamin C") that does NOT appear in the ingredient list, flag it as a violation: "Ingredient '[X]' listed in bullet [N] not found in actual ingredient list — remove or verify." Only flag ingredients that are definitively absent. Common ingredient aliases are acceptable (e.g. "Rosmarinus Officinalis" = rosemary oil). If a timeline claim is present in IH without qualifier, flag it and rewrite removing the timeline or moving it to a bullet.

KEYWORD COVERAGE RULES — priority order matters, read the tiers below carefully:
- TIER 1 keywords (already ranking page 1) are the HIGHEST priority of anything in this audit — higher than adding any new keyword, higher than fixing a coverage gap. If a rewrite would remove or weaken a Tier 1 keyword's presence in whatever field it currently occupies, that is a critical problem — flag it explicitly and do not let the rewrite do that. We never want to lose a page-1 ranking to make room for something else.
- TIER 2 keywords (close to page 1, sorted by volume) are the priority for NEW placement — these are the closest realistic wins. When choosing what to add to a field, prefer a Tier 2 keyword over an unranked keyword every time, even if the unranked one seems more "important" — proximity to page 1 with real volume behind it is worth more right now than a keyword with no ranking traction at all, no matter how strategically desirable that keyword sounds.
- TIER 3 items (in the listing a long time, still not ranking) are NOT a placement task — do not just try to shove them into more fields. Raise them as a genuine open question in the relevant NOTES field: is this keyword too competitive for this listing to win, and does the suggested lower-volume alternative deserve a try instead? Do not resolve this question yourself — surface it for a human decision.
- Do NOT recommend adding drug-claim keywords or any keyword that violates compliance rules, regardless of tier.
- In BACKEND_NOTES: flag any Tier 1 or Tier 2 keyword missing from every field. In BACKEND_REWRITE: ensure Tier 1 and Tier 2 keywords not already in title/bullets/item highlights are in the backend.
- In BULLETS_NOTES: flag the highest-priority keyword gaps by tier order (Tier 1 gaps first, then Tier 2), with specific placement recommendations respecting the field-priority order given above.

BULLET FORMATTING RULES (apply to all bullet rewrites):
- Every bullet must open with an ALL-CAPS phrase (3-6 words) followed by a colon, then sentence-case detail. Example: "CLINICALLY TESTED HAIR GROWTH SERUM: In 3 independent studies, 95% of users reported visibly thicker hair."
- Flag any bullet that does NOT follow this ALL-CAPS header: detail format as a violation.
- Across the catalog, align parallel bullets by position where products are related: B1 = hero claim/clinical proof, B2 = science/mechanism, B3 = key ingredients, B4 = who it is for/hair types, B5 = brand credentials/clean formula. Rewrites should follow this structure consistently.
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
      const title     = san(row[COL.title], 400);
      const ih        = san(row[COL.item_highlights], 200) || 'MISSING';
      const b1        = san(row[COL.bullet_1], 300);
      const b2        = san(row[COL.bullet_2], 300);
      const b3        = san(row[COL.bullet_3], 300);
      const b4        = san(row[COL.bullet_4], 300);
      const b5        = san(row[COL.bullet_5], 300);
      const desc      = san(row[COL.description], 400);
      const backend      = san(row[COL.backend_keywords], 300);
      const ingredients  = san(row[COL.ingredients], 600);

      let userPrompt;
      if (travel) {
        userPrompt = `Audit this TRAVEL SIZE SKU. For travel SKUs only check title and item highlights. Set BULLETS_NOTES and BULLETS_REWRITE to empty string.

SKU: ${sku}
Name: ${name} [TRAVEL SIZE]
Title: ${title}
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
        const asin = (row[COL.asin] || '').trim();
        const skuKws = skuKeywordMap[sku] || null;
        const kwTrackerLookup = buildKwTrackerLookup(kwTrackerRows, sku);
        let kwContext = '';

        if (skuKws && skuKws.top20.length) {
          const allTargetKeywords = [...skuKws.top20, ...(skuKws.opportunity || [])];
          const { tier1Protect, tier2Push, other } = categorizeKeywordTiers(allTargetKeywords, kwTrackerLookup, kwRankings);
          const tier3 = buildTier3Reconsiderations(other, sku, allRawRows, skuKws.reach || [], kwTrackerLookup);

          const fmt = e => `${e.keyword}${e.rank !== null ? ` (rank #${e.rank}` : ' (not ranking'}${e.volume !== null ? `, ${e.volume}/mo)` : ')'}`;

          kwContext = `
TIER 1 — PROTECT (already ranking page 1 — DO NOT let a rewrite remove or weaken these; this is the highest priority, above adding anything new):
${tier1Protect.length ? tier1Protect.map(fmt).join(', ') : 'None currently on page 1 for this SKU.'}

TIER 2 — PUSH (rank ${PAGE1_RANK_CUTOFF + 1}-${CLOSE_TO_PAGE1_MAX}, sorted by volume — closest realistic wins, prioritize placement for these over anything unranked):
${tier2Push.length ? tier2Push.map(fmt).join(', ') : 'None in this range currently.'}
${tier3.length ? `
TIER 3 — RECONSIDER (already in the listing ${LONG_TENURE_DAYS}+ consecutive days per daily listing snapshots, still not ranking at all — raise as a QUESTION, not a directive: is this keyword too competitive to win, and would a lower-volume alternative be more attainable?):
${tier3.map(t => `"${t.keyword}"${t.volume !== null ? ` (${t.volume}/mo)` : ''} — in listing ${t.tenure_days} days, no rank${t.suggested_alternative ? `. Consider substituting: "${t.suggested_alternative}"` : ''}`).join('; ')}` : ''}

FIELD PRIORITY FOR PLACEMENT (highest SEO weight to lowest): Title > Item Highlights > Bullets > Product Description > Backend Keywords. When a Tier 1 or Tier 2 keyword is missing, place it in the HIGHEST-weight field it can compliantly fit in that's currently missing it — do not default to backend just because there's room there.`;
        } else if (Object.keys(kwRankings).length > 0) {
          // No strategy sheet tab for this SKU — use top ranking keywords from upload as proxy.
          // No volume data available in this fallback path, so this can only
          // sort by rank, not build real tiers — noted to Claude as such.
          const ranked = Object.entries(kwRankings)
            .filter(([kw]) => {
              const nameParts = name.toLowerCase().split(' ');
              return nameParts.some(p => p.length > 3 && kw.includes(p));
            })
            .sort(([, a], [, b]) => a - b)
            .slice(0, 15)
            .map(([kw, rank]) => `${kw} (rank #${rank})`);
          if (ranked.length) {
            kwContext = `
KEYWORD RANKINGS FROM TRACKER (no keyword strategy tab for this SKU, so no volume data available — ranked by position only, real 3-tier volume-weighted prioritization not possible this run):
${ranked.join(', ')}

FIELD PRIORITY FOR PLACEMENT (highest SEO weight to lowest): Title > Item Highlights > Bullets > Product Description > Backend Keywords.`;
          }
        }

        userPrompt = `Audit this full listing SKU.

SKU: ${sku}
Name: ${name}
ASIN: ${asin}
Related SKUs in this catalog: ${siblings || 'none'}
Title: ${title}
Item Highlights: ${ih}
Bullet 1: ${b1}
Bullet 2: ${b2}
Bullet 3: ${b3}
Bullet 4: ${b4}
Bullet 5: ${b5}
Description (excerpt): ${desc}
Backend: ${backend}
Ingredients: ${ingredients || 'NOT AVAILABLE'}${kwContext}`;
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

      console.log(`[listing-audit] ✓ ${sku}`);

    } catch (err) {
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

  console.log(`[listing-audit] Done — ${auditRows.length} rows written`);
  return res.status(200).json({ ok: true, skuCount: auditRows.length });
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
  if (!checkRes.ok) return;
  const data = await checkRes.json();
  if (data.values && data.values[0] && data.values[0].length > 0) return;

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
