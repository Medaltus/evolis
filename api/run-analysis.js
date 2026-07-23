/**
 * api/run-analysis.js
 * POST /api/run-analysis
 * Body: { brand: "evolis" }
 *
 * Manually triggered from the "Run Analysis" button on a single brand's
 * dashboard page — intentionally NOT a cron job. Jaclyn wants this to stay
 * manual so how often the team reviews each brand is trackable.
 *
 * REWRITTEN 2026-07-23: organic.* used to be four loose arrays of strings
 * (summary/wins/actions/keywords_to_watch) built by handing Claude raw
 * keyword-tracker/PPC dumps and asking it to reason about changes itself.
 * Now that the keyword tracker has real week-over-week history (backfilled
 * to 2026-01-26, syncing weekly every Monday going forward), this computes
 * rank deltas, per-keyword PPC signal, and listing placement DETERMINISTICALLY
 * in code — Claude's job is now only to write the prose (recommended_action
 * per keyword, and the reading_the_changes narrative) against numbers it's
 * handed, not to compute or restate them. This mirrors the MiGuard-style
 * report Jaclyn built by hand in chat (rank change table + narrative +
 * "new PPC converters not yet tracked" section) — see organic.rank_changes /
 * organic.new_ppc_converters below. summary/wins/actions/keywords_to_watch
 * are kept for backward compatibility with the existing dashboard Insights
 * cards, which read those same fields.
 *
 * KNOWN GAP, FLAGGED RATHER THAN GUESSED SILENTLY: this file's own prior
 * comment block (2026-07-17) admitted sheets.keywordTracker was UNCONFIRMED
 * against config/sheets.js. Given everything below depends on reading the
 * real keyword tracker, this now reads that sheet by its CONFIRMED ID
 * directly (KEYWORD_TRACKER_SHEET_ID, matching the sheet Jaclyn's screenshots
 * and upload-keyword-tracker.js both point at) instead of trusting
 * sheets.keywordTracker. If config/sheets.js's mapping has since been fixed
 * to point at the same sheet, this is redundant but harmless; if it hasn't,
 * this is what actually makes the feature work. Worth reconciling the two
 * once config/sheets.js is confirmed, so there's only one source of truth.
 *
 * ASSUMPTIONS BELOW THAT NEED A REAL LOOK, NOT JUST A GUESS:
 *   - Listing placement ("Where in Listing"): matches keyword text against
 *     whatever title/bullet/backend fields exist on each listingRows row.
 *     Field names are GUESSED (tries several common variants — see
 *     LISTING_FIELD_CANDIDATES) since I don't have listingAudit's real
 *     schema. If placement comes back "—" for everything, the field names
 *     are wrong, not the logic.
 *   - ABA%: Amazon's real Search Query Performance export uses
 *     purchases_brand_share (a 0–1 decimal) for what Helium 10 calls
 *     "ABA Conv Share" — that's what this maps organic.rank_changes[].aba_pct
 *     to, IF sqpRows has that field under one of a few guessed name variants.
 *     If it's consistently null, the real field name in sheets.
 *     searchQueryPerformance needs confirming.
 *   - PPC-to-keyword join is an exact, case-insensitive match on
 *     search_term === keyword. A keyword tracked as "hair growth serum"
 *     will not catch PPC spend under the search term "hair growth serums"
 *     (plural) — deliberately conservative rather than fuzzy-matching and
 *     risking a wrong join looking confident.
 *   - Comparison window: current keyword-tracker snapshot vs. whichever
 *     earlier snapshot is closest to 28 days before it. Falls back to "not
 *     enough history yet" if fewer than 2 distinct sync dates exist —
 *     expected for the first several weeks after 2026-07-14.
 *
 * FIX 2026-07-17 (kept): this endpoint is called directly from the browser
 * with no Authorization header — no CRON_SECRET check, single-brand only.
 */

const { readRows, ensureTab, appendRows } = require('./config/_sheets_client');
const sheets = require('./config/sheets');
const brands = require('./config/brands');

// Confirmed directly (screenshot of the live sheet + upload-keyword-tracker.js's
// own example) — see the header comment above for why this bypasses
// sheets.keywordTracker rather than trusting it.
const KEYWORD_TRACKER_SHEET_ID = '1geNDQgd_1ensLDyZOuXZBnvQrFT_RC85l9rHHGpgJe4';

const BRAND_DESCRIPTIONS = {
  evolis:  'évolis (EVO) — a clinically tested hair growth brand using FGF5-inhibiting botanicals',
  skinuva: 'Skinuva (SVA) — a scar, bruise, and skin recovery brand',
  default: 'a Medaltus brand'
};

const INSIGHTS_HEADERS = ['DATE', 'BRAND', 'ORGANIC_JSON', 'PPC_JSON', 'LISTING_JSON', 'LOG_SUMMARY'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const COMPARISON_WINDOW_DAYS = 28;

const LISTING_FIELD_CANDIDATES = {
  title: ['title', 'Title', 'listing_title'],
  bullets: [
    ['bullet_1', 'bullet1', 'Bullet 1', 'bullet_point_1'],
    ['bullet_2', 'bullet2', 'Bullet 2', 'bullet_point_2'],
    ['bullet_3', 'bullet3', 'Bullet 3', 'bullet_point_3'],
    ['bullet_4', 'bullet4', 'Bullet 4', 'bullet_point_4'],
    ['bullet_5', 'bullet5', 'Bullet 5', 'bullet_point_5'],
  ],
  itemHighlights: ['item_highlights', 'itemHighlights', 'Item Highlights'],
  backend: ['backend_keywords', 'backendKeywords', 'Backend Keywords', 'search_terms', 'generic_keywords'],
};

const ABA_FIELD_CANDIDATES = ['purchases_brand_share', 'purchase_brand_share', 'aba_conv_share', 'aba_purchase_share', 'conv_share'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const brandId = (req.body && req.body.brand) || req.query.brand;
  if (!brandId) return res.status(400).json({ error: 'Missing required field: brand' });

  const brand = brands.find(b => b.id === brandId && b.active);
  if (!brand) return res.status(400).json({ error: `Brand '${brandId}' not found or not active` });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const insights = await runAnalysisForBrand(brand, apiKey);
    await writeInsightsToSheet(brand, insights);
    return res.status(200).json({ ok: true, insights });
  } catch (err) {
    console.error(`[run-analysis] ${brand.id} failed:`, err.message);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message });
  }
};

// ── Deterministic computation helpers ───────────────────────────────────────
// Everything in this section produces NUMBERS. None of it goes through Claude
// — Claude only ever writes prose against what these functions compute.

function findField(row, candidates) {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== null && row[c] !== '') return row[c];
  }
  return null;
}

// Helium 10 ranks come through as either a plain integer string ("83") or
// ">306" / ">96" meaning "not found within the checked depth" — not a real
// number, and must never be parsed as one (306 is not actually this
// keyword's rank, it's "somewhere past 306").
function parseRank(raw) {
  if (raw === null || raw === undefined || raw === '') return { numeric: null, raw: '—' };
  const s = String(raw).trim();
  if (s.startsWith('>')) return { numeric: null, raw: s };
  const n = parseInt(s, 10);
  return { numeric: Number.isFinite(n) ? n : null, raw: s };
}

function formatChange(prev, curr) {
  const p = parseRank(prev);
  const c = parseRank(curr);
  if (p.numeric === null && c.numeric === null) return { change: null, label: '— Not tracked organically' };
  if (p.numeric === null && c.numeric !== null) return { change: null, label: '↑ NEW' };
  if (p.numeric !== null && c.numeric === null) return { change: null, label: '🔴 DROPPED' };
  const delta = p.numeric - c.numeric; // positive = improved (lower rank number is better)
  if (delta === 0) return { change: 0, label: '→ HELD' };
  return { change: delta, label: delta > 0 ? `↑ +${delta}` : `↓ ${delta}` };
}

function normalizeTerm(s) {
  return String(s || '').trim().toLowerCase();
}

// Groups keyword-tracker rows by exact sync date, returns the most recent
// date and the earlier date closest to COMPARISON_WINDOW_DAYS before it.
// Returns hasHistory=false rather than guessing when fewer than 2 distinct
// dates exist yet (expected for the first few weeks after 2026-07-14).
function pickComparisonDates(kwRows) {
  const dates = Array.from(new Set(kwRows.map(r => (r.date || '').slice(0, 10)).filter(Boolean))).sort();
  if (dates.length < 2) return { currDate: dates[0] || null, prevDate: null, hasHistory: false, allDates: dates };
  const currDate = dates[dates.length - 1];
  const currTime = new Date(currDate).getTime();
  let prevDate = dates[0];
  let bestDiff = Infinity;
  for (const d of dates) {
    if (d === currDate) continue;
    const diff = Math.abs((currTime - new Date(d).getTime()) / MS_PER_DAY - COMPARISON_WINDOW_DAYS);
    if (diff < bestDiff) { bestDiff = diff; prevDate = d; }
  }
  return { currDate, prevDate, hasHistory: true, allDates: dates };
}

function snapshotByKeyword(kwRows, date) {
  const map = new Map();
  kwRows.forEach(r => {
    if ((r.date || '').slice(0, 10) !== date) return;
    map.set(normalizeTerm(r.keyword), r);
  });
  return map;
}

// Sums cost/purchases/sales per exact-match search term, from the advertising
// (search-terms) sheet. Deliberately exact-match only — see header comment.
function aggregatePpcByTerm(ppcRows) {
  const map = new Map();
  ppcRows.forEach(r => {
    const term = normalizeTerm(r.search_term || r.keyword);
    if (!term) return;
    const entry = map.get(term) || { spend: 0, purchases: 0, sales: 0, clicks: 0 };
    entry.spend += parseFloat(r.cost) || 0;
    entry.purchases += parseInt(r.purchases, 10) || 0;
    entry.sales += parseFloat(r.sales) || 0;
    entry.clicks += parseInt(r.clicks, 10) || 0;
    map.set(term, entry);
  });
  return map;
}

function formatPpcSignal(entry) {
  if (!entry || entry.spend === 0) return 'No spend';
  const acos = entry.sales > 0 ? ((entry.spend / entry.sales) * 100).toFixed(1) + '% ACoS' : 'no sales';
  return `$${entry.spend.toFixed(2)} · ${entry.purchases} ord · ${acos}`;
}

function computeWhereInListing(keyword, listingRow) {
  if (!listingRow) return '—';
  const kw = normalizeTerm(keyword);
  const hits = [];
  const title = findField(listingRow, LISTING_FIELD_CANDIDATES.title);
  if (title && normalizeTerm(title).includes(kw)) hits.push('Title');
  LISTING_FIELD_CANDIDATES.bullets.forEach((candidates, i) => {
    const val = findField(listingRow, candidates);
    if (val && normalizeTerm(val).includes(kw)) hits.push(`B${i + 1}`);
  });
  const itemHighlights = findField(listingRow, LISTING_FIELD_CANDIDATES.itemHighlights);
  if (itemHighlights && normalizeTerm(itemHighlights).includes(kw)) hits.push('IH');
  const backend = findField(listingRow, LISTING_FIELD_CANDIDATES.backend);
  if (backend && normalizeTerm(backend).includes(kw)) hits.push('Backend');
  if (!hits.length) return 'Not in listing';
  return hits.join(', ');
}

function computeAbaPct(sqpRows, keyword) {
  const kw = normalizeTerm(keyword);
  const row = sqpRows.find(r => normalizeTerm(r.search_query || r.keyword) === kw);
  if (!row) return null;
  const raw = findField(row, ABA_FIELD_CANDIDATES);
  if (raw === null) return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n; // handle either a 0–1 fraction or an already-percent value
}

// Assembles the rank-change table rows — numbers only, no recommended_action
// yet (Claude fills that in afterward, see mergeRecommendedActions).
function buildRankChanges(kwRows, ppcByTerm, sqpRows, listingBySku, comparison) {
  if (!comparison.hasHistory) return [];
  const currSnap = snapshotByKeyword(kwRows, comparison.currDate);
  const prevSnap = snapshotByKeyword(kwRows, comparison.prevDate);
  const allKeywords = new Set([...currSnap.keys(), ...prevSnap.keys()]);

  const rows = [];
  allKeywords.forEach(kwKey => {
    const currRow = currSnap.get(kwKey);
    const prevRow = prevSnap.get(kwKey);
    const anyRow = currRow || prevRow;
    const keyword = anyRow.keyword;
    const { change, label } = formatChange(prevRow && prevRow.organic_rank, currRow && currRow.organic_rank);
    const ppcEntry = ppcByTerm.get(kwKey);
    const listingRow = listingBySku.get((anyRow.sku || '').trim());

    rows.push({
      keyword,
      sku: anyRow.sku || '',
      vol_mo: currRow ? (parseInt(currRow.search_volume, 10) || null) : (prevRow ? (parseInt(prevRow.search_volume, 10) || null) : null),
      rank_prev: prevRow ? parseRank(prevRow.organic_rank).raw : '—',
      rank_curr: currRow ? parseRank(currRow.organic_rank).raw : '—',
      change,
      change_label: label,
      aba_pct: computeAbaPct(sqpRows, keyword),
      where_in_listing: computeWhereInListing(keyword, listingRow),
      ppc_signal: formatPpcSignal(ppcEntry),
      ppc_spend: ppcEntry ? Number(ppcEntry.spend.toFixed(2)) : 0,
      recommended_action: null, // filled in after the Claude call
    });
  });

  // Biggest movers (up or down) and anything currently spending float to the
  // top — matches the "what should I actually look at first" ordering in
  // Jaclyn's own MiGuard report, rather than alphabetical.
  rows.sort((a, b) => {
    const aSpend = a.ppc_spend > 0 ? 1 : 0;
    const bSpend = b.ppc_spend > 0 ? 1 : 0;
    if (aSpend !== bSpend) return bSpend - aSpend;
    const aChange = Math.abs(a.change || 0);
    const bChange = Math.abs(b.change || 0);
    return bChange - aChange;
  });
  return rows;
}

// Search terms that converted via PPC this window but aren't in the
// currently-tracked keyword list at all — the "add this to the tracker"
// signal from Jaclyn's MiGuard report.
function buildNewPpcConverters(ppcByTerm, trackedKeywordSet) {
  const rows = [];
  ppcByTerm.forEach((entry, term) => {
    if (entry.purchases <= 0) return;
    if (trackedKeywordSet.has(term)) return;
    rows.push({
      keyword: term,
      ppc_signal: formatPpcSignal(entry),
      ppc_spend: Number(entry.spend.toFixed(2)),
      recommended_action: null,
    });
  });
  rows.sort((a, b) => b.ppc_spend - a.ppc_spend);
  return rows;
}

function mergeRecommendedActions(rows, actionsByKeyword, fallback) {
  rows.forEach(r => {
    r.recommended_action = (actionsByKeyword && actionsByKeyword[r.keyword]) || fallback;
  });
}

// ── Per-brand analysis ──────────────────────────────────────────────────────

async function runAnalysisForBrand(brand, apiKey) {
  const brandDesc = BRAND_DESCRIPTIONS[brand.id] || BRAND_DESCRIPTIONS.default;

  const [kwRows, bizRows, sqpRows, ppcRows, adOrdersRows, listingRows, historyRows] = await Promise.all([
    readRows(KEYWORD_TRACKER_SHEET_ID, brand.tabName).catch(() => []),
    readRows(sheets.businessReport, brand.tabName).catch(() => []),
    readRows(sheets.searchQueryPerformance, brand.tabName).catch(() => []),
    readRows(sheets.advertising, brand.tabName).catch(() => []),
    readRows(sheets.adOrders, brand.tabName).catch(() => []),
    readRows(sheets.listingAudit, brand.tabName).catch(() => []),
    readRows(sheets.insights, brand.tabName).catch(() => []),
  ]);

  const bizTrimmed      = bizRows.slice(-15);
  const ppcTrimmed      = ppcRows.slice(-15); // still sent raw for the PPC section's own prompt, unchanged from before
  const sqpSection_raw   = sqpRows.slice(-15);
  const adOrdersTrimmed = adOrdersRows.slice(-30);

  const latestBySku = new Map();
  listingRows.forEach(r => {
    const sku = r['SKU'] || r['sku'];
    if (!sku) return;
    const existing = latestBySku.get(sku);
    if (!existing || (r['audited_at'] || '') > (existing['audited_at'] || '')) latestBySku.set(sku, r);
  });
  const listingCtxTrimmed = JSON.stringify(Array.from(latestBySku.values())).slice(0, 3000);

  const historicalCtx = historyRows.length
    ? historyRows.slice(-4).map(r => r['LOG_SUMMARY'] || '').filter(Boolean).join('\n---\n').slice(0, 2000)
    : 'First automated run — no prior data.';

  // ── The new deterministic layer ──────────────────────────────────────────
  const comparison = pickComparisonDates(kwRows);
  const ppcByTerm = aggregatePpcByTerm(ppcRows);
  const trackedKeywordSet = new Set(kwRows.map(r => normalizeTerm(r.keyword)));
  const rankChanges = buildRankChanges(kwRows, ppcByTerm, sqpRows, latestBySku, comparison);
  const newPpcConverters = buildNewPpcConverters(ppcByTerm, trackedKeywordSet);

  const systemPrompt = `You are an expert Amazon brand strategist and listing compliance auditor for Medaltus. Analyzing weekly performance data for ${brandDesc}.

CRITICAL: Respond with a single valid JSON object only. No markdown fences, no preamble, no trailing text after the closing brace. All string values must use escaped quotes if they contain apostrophes or special characters.`;

  const sqpSection = sqpSection_raw.length
    ? '\n\nSQP Brand Search Query Performance (recent rows):\n' + JSON.stringify(sqpSection_raw)
    : '';

  const adOrdersSection = adOrdersTrimmed.length
    ? '\n\nAD ORDERS — ASIN-level monthly ad-attributed rollup (same ads, different view — units/spend/sales/ACOS by ASIN by month):\n' + JSON.stringify(adOrdersTrimmed)
    : '';

  // Rank changes and new-converter numbers are already computed — Claude is
  // asked ONLY for the prose that goes with them (recommended_action per
  // keyword/term, plus a narrative), never for the numbers themselves.
  const rankChangesSection = comparison.hasHistory
    ? `\n\nKEYWORD RANK CHANGES — ${comparison.prevDate} vs ${comparison.currDate} (already computed; write recommended_action for each, do not alter the numbers):\n${JSON.stringify(rankChanges.map(r => ({ keyword: r.keyword, vol_mo: r.vol_mo, rank_prev: r.rank_prev, rank_curr: r.rank_curr, change_label: r.change_label, where_in_listing: r.where_in_listing, ppc_signal: r.ppc_signal, aba_pct: r.aba_pct })))}`
    : '\n\nKEYWORD RANK CHANGES: not enough history yet (need at least 2 distinct weekly syncs) — omit rank-change commentary, note this in organic.summary instead.';

  const newConvertersSection = newPpcConverters.length
    ? `\n\nNEW PPC CONVERTERS NOT YET ON THE KEYWORD TRACKER (already computed; write recommended_action for each):\n${JSON.stringify(newPpcConverters.map(r => ({ keyword: r.keyword, ppc_signal: r.ppc_signal })))}`
    : '';

  const userPrompt = `Analyze this week vs history. Return ONLY this JSON structure, nothing else:

{"date":"YYYY-MM-DD","organic":{"summary":"string","reading_the_changes":"string","wins":["string"],"actions":["string"],"keywords_to_watch":["string"],"recommended_actions_by_keyword":{"<keyword>":"string"},"recommended_actions_new_converters":{"<keyword>":"string"}},"ppc":{"summary":"string","wins":["string"],"actions":["string"],"opportunities":["string"]},"listing":{"summary":"string","violations":["string"],"keyword_gaps":["string"],"rewrites_recommended":["string"]},"log_summary":"string"}

Rules for the response:
- date: today's date in YYYY-MM-DD format
- organic.reading_the_changes: 3-5 sentences, prose, in the style of a sharp weekly recap — call out the single biggest win, the single biggest drop, and one clear next action, using ONLY the rank-change data provided below (do not invent numbers)
- organic.recommended_actions_by_keyword: one entry per keyword from KEYWORD RANK CHANGES below, keyed EXACTLY as given. Each value is one tactical sentence (bid amount, campaign type, or "no action" if genuinely nothing to do) — same style as: "Add exact-match PPC at $1.00-1.25 to rebuild this term." Do not add or omit keywords from what's given.
- organic.recommended_actions_new_converters: same idea, one entry per term from NEW PPC CONVERTERS below, keyed EXACTLY as given
- organic.wins: 3-4 items. organic.actions: 4-6 items. organic.keywords_to_watch: 4-6 items
- ppc.wins: 3-4 items. ppc.actions: 4-6 items. ppc.opportunities: 4-6 items
- listing.violations: 1-2 items. listing.keyword_gaps: 1-2 items. listing.rewrites_recommended: 1-2 items
- log_summary: 3-4 sentences maximum
- No apostrophes in string values — use "does not" not "doesn't", etc.
- Keep all string values under 200 characters

BUSINESS REPORT (sessions/units/revenue):
${JSON.stringify(bizTrimmed)}

PPC (search terms / ad performance):
${JSON.stringify(ppcTrimmed)}${sqpSection}${adOrdersSection}${rankChangesSection}${newConvertersSection}

HISTORY (last 4 weeks):
${historicalCtx}

CURRENT LISTING:
${listingCtxTrimmed}`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 5000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.text();
    const e = new Error(`Claude API error ${claudeRes.status}: ${err.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }

  const data = await claudeRes.json();
  if (data.stop_reason === 'max_tokens') {
    console.warn(`[run-analysis] ${brand.id} — response truncated by max_tokens`);
  }

  const raw = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  let clean = raw
    .replace(/^```json\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  if (!clean.endsWith('}')) {
    console.warn(`[run-analysis] ${brand.id} — response may be truncated, attempting repair`);
    const lastBrace = clean.lastIndexOf('"log_summary"');
    if (lastBrace > 0) {
      clean = clean.slice(0, lastBrace) + '"log_summary":"Analysis complete — see organic, PPC and listing sections above."}';
    } else {
      const lastClose = clean.lastIndexOf('}');
      if (lastClose > 0) clean = clean.slice(0, lastClose + 1);
    }
  }

  let insights;
  try {
    insights = JSON.parse(clean);
  } catch (parseErr) {
    console.error(`[run-analysis] ${brand.id} JSON parse failed. Raw length:`, raw.length);
    console.error('[run-analysis] Parse error:', parseErr.message);
    console.error('[run-analysis] Clean (first 500):', clean.slice(0, 500));
    const e = new Error(`Could not parse Claude response as JSON: ${parseErr.message}`);
    e.status = 500;
    throw e;
  }

  insights.date = new Date().toISOString().slice(0, 10); // always override — Claude often hallucinates dates

  // Merge Claude's prose back onto the code-computed numbers — this is the
  // only place organic.rank_changes / organic.new_ppc_converters get built.
  mergeRecommendedActions(
    rankChanges,
    insights.organic && insights.organic.recommended_actions_by_keyword,
    'No action needed this week.'
  );
  mergeRecommendedActions(
    newPpcConverters,
    insights.organic && insights.organic.recommended_actions_new_converters,
    'Add to keyword tracker and monitor.'
  );
  if (insights.organic) {
    insights.organic.rank_changes = rankChanges;
    insights.organic.new_ppc_converters = newPpcConverters;
    insights.organic.comparison_window = comparison.hasHistory
      ? { prev_date: comparison.prevDate, curr_date: comparison.currDate }
      : null;
    delete insights.organic.recommended_actions_by_keyword;
    delete insights.organic.recommended_actions_new_converters;
  }

  return insights;
}

// ── Write result directly to sheets.insights ────────────────────────────────

async function writeInsightsToSheet(brand, insights) {
  const token = await ensureTab(sheets.insights, brand.tabName, INSIGHTS_HEADERS);
  const row = [
    insights.date,
    brand.id,
    JSON.stringify(insights.organic || {}),
    JSON.stringify(insights.ppc || {}),
    JSON.stringify(insights.listing || {}),
    insights.log_summary || '',
  ];
  await appendRows(sheets.insights, brand.tabName, [row], token);
  console.log(`[run-analysis] ${brand.id} — insights written for ${insights.date}`);
}
