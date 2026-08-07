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
 *
 * EXPANDED 2026-07-27 per Jaclyn — three real additions, all deterministic
 * (computed in code, Claude only writes the prose against them, same
 * philosophy as the 07-23 rewrite above):
 *   1. Item-count caps removed entirely from every list field. Report
 *      what's actually there — some weeks 2 wins, other weeks 10.
 *   2. organic.page1_opportunities — keywords at rank 49-100 (real
 *      page-1 depth varies ~24-60; 48 is a working cutoff, see
 *      PAGE1_RANK_CUTOFF/CLOSE_TO_PAGE1_MAX below), sorted by volume, so a
 *      keyword close to page 1 with real search volume doesn't get lost
 *      in the full rank-change table.
 *   3. organic.ranking_diagnostic — the "why are we only ranking for our
 *      own brand name" question. Splits tracked keywords into high/low
 *      volume using this brand's OWN median volume (not a fixed number),
 *      and reports the real ranking rate in each bucket. Per Jaclyn:
 *      "keywords with higher search volume are more difficult" as the
 *      rule of thumb — there's no competing-ASIN-count field in the
 *      keyword tracker to use instead (checked, not assumed absent).
 *   4. listing.implementation_status — compares each SKU's last audit
 *      recommendation (title_rewrite/backend_rewrite) against today's
 *      actual live copy in SHEET_PRODUCT_INVENTORY. Deliberately NOT
 *      extended to PPC/ads recommendations — those aren't independently
 *      verifiable (no log of what the ads team actually changed), so
 *      tracking "did this get acted on" for anything but listing copy
 *      would be pretending to know something this system can't actually
 *      confirm. See buildListingImplementationStatus() for the honesty
 *      caveat on what a "no match" here does and doesn't prove.
 *
 * ADDED 2026-07-31 per Jaclyn — ppc.strategy_by_sku replaces the
 * hand-authored PPC "Strategy by Product" cards on the dashboard (the
 * per-SKU sections like "PPC on 'hair growth serum' + 'scalp serum'...").
 * Same deterministic-then-prose split as everything else in this file:
 * buildSkuStrategySnapshots() computes each SKU's latest-month business
 * numbers (sessions/units/revenue/conversion) and top tracked keywords by
 * volume in code; Claude only writes 2-4 prioritized recommendation
 * bullets and a suggested-exact-match-target list against those real
 * numbers. Written into the ppc_json column, which already existed — no
 * sheet schema change needed. BIZ_FIELD_CANDIDATES (sessions/units/
 * revenue/conversion column names) was CONFIRMED 2026-07-31 per Jaclyn
 * against the real Business Report sheet headers (MONTH, YEAR, ASIN, SKU,
 * SESSIONS, PAGE_VIEWS, UNITS_ORDERED, ORDERED_PRODUCT_SALES,
 * CONVERSION_RATE) — the candidate arrays are kept only as a defensive
 * fallback against future casing drift, not because the names are in
 * doubt. CONVERSION_RATE's actual stored format (decimal fraction like
 * 0.2295 vs. an already-percent number like 22.95) is NOT confirmed —
 * parseConversionPct() below guesses using the same "≤1 means it's a
 * fraction" heuristic computeAbaPct() already uses elsewhere in this file
 * for the same ambiguity. Worth a quick sanity check against a real row
 * once this runs — if every SKU's conversion_pct looks off by 100x, this
 * is the guess to fix.
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

// CONFIRMED 2026-07-23 against a screenshot of the actual live sheet
// (tab "Evolis"): real columns are date, organic_json, ppc_json,
// listing_json, summary, uploaded_at — no brand column at all (brand
// identity is already the tab name, e.g. "Evolis" vs "skinuva", so a
// BRAND column was always redundant). The prior INSIGHTS_HEADERS list
// below had 'BRAND' as its 2nd entry, which doesn't exist in the real
// sheet — since ensureTab() never rewrites an existing tab's header row,
// every write was silently shifting one column left of where it belonged
// (brand.id landing under "organic_json", real organic_json content
// landing under "ppc_json", etc.). Visible directly in the live sheet:
// one row per date with real JSON, one row per date with "evolis" sitting
// in the organic_json column instead. Fixed to match reality below.
const INSIGHTS_HEADERS = ['date', 'organic_json', 'ppc_json', 'listing_json', 'summary', 'uploaded_at'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const COMPARISON_WINDOW_DAYS = 28;

// Added 2026-07-27 per Jaclyn: page-1 opportunity band and the "why aren't
// we ranking beyond the brand term" diagnostic. Rank ≤48 = "page 1" (real
// depth varies ~24-60 depending on layout/sponsored density — 48 is a
// working middle, adjust here if it's consistently off in practice).
// 49-100 = "close" — a realistic push target, not "anything not page 1."
const PAGE1_RANK_CUTOFF = 48;
const CLOSE_TO_PAGE1_MAX = 100;

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

// CONFIRMED 2026-07-31 per Jaclyn — real headers on the Business Report
// sheet are: MONTH, YEAR, ASIN, SKU, SESSIONS, PAGE_VIEWS, UNITS_ORDERED,
// ORDERED_PRODUCT_SALES, CONVERSION_RATE. Candidate arrays kept (rather
// than single string lookups) only as a defensive fallback in case
// casing/spacing ever drifts between sheet syncs — the confirmed
// ALL_CAPS name is listed first in each and is what should actually match.
const BIZ_FIELD_CANDIDATES = {
  sku:         ['SKU', 'sku', 'Sku'],
  sessions:    ['SESSIONS', 'sessions', 'Sessions'],
  units:       ['UNITS_ORDERED', 'units_ordered', 'Units Ordered', 'units', 'Units'],
  revenue:     ['ORDERED_PRODUCT_SALES', 'ordered_product_sales', 'revenue', 'Revenue'],
  conversion:  ['CONVERSION_RATE', 'conversion_rate', 'conversion', 'Conversion'],
  year:        ['YEAR', 'year', 'Year'],
  month:       ['MONTH', 'month', 'Month'],
  date:        ['date', 'Date'],
};

// Also unconfirmed — the keyword tracker sheet's real column names for
// competing-ASIN-count and CPC aren't established anywhere else in this
// file (buildRankingDiagnostic above explicitly notes no competing-ASIN
// field was found and works around it — this list is included anyway in
// case a real one exists under a name not yet checked). Falls back to
// null cleanly via findField() if none of these match.
const KEYWORD_COMPETING_CANDIDATES = ['competing_products', 'competing', 'competing_asins', 'comp_count'];
const KEYWORD_CPC_CANDIDATES = ['cpc', 'suggested_cpc', 'estimated_cpc', 'sp_cpc'];

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
    const currRankParsed = currRow ? parseRank(currRow.organic_rank) : { numeric: null, raw: '—' };

    rows.push({
      keyword,
      sku: anyRow.sku || '',
      vol_mo: currRow ? (parseInt(currRow.search_volume, 10) || null) : (prevRow ? (parseInt(prevRow.search_volume, 10) || null) : null),
      rank_prev: prevRow ? parseRank(prevRow.organic_rank).raw : '—',
      rank_curr: currRankParsed.raw,
      rank_curr_numeric: currRankParsed.numeric, // NOT sent to Claude directly — used to build page1_protects/page1_opportunities and the ranking diagnostic below
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

function normalizeForCompare(s) {
  return String(s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Per Jaclyn 2026-07-27: "changes can only be tracked based off listing
// updates... on the products sheet you can see daily what the listings
// are showing." This is the one kind of "did our suggestion get acted on"
// tracking that's actually verifiable — unlike a PPC bid change, listing
// copy is a fact you can check, not an assumption. NOTE ON HONESTY: the
// audit sheet only ever stored the RECOMMENDED rewrite, never the
// "before" text — so this can only say whether current copy now matches
// (or doesn't match) the exact recommended wording, not "changed" vs.
// "unchanged" from before. A false match could mean "not yet updated" OR
// "fixed with different wording" — framed that way below rather than
// asserting more confidence than the data supports.
function buildListingImplementationStatus(latestAuditBySku, latestInventoryBySku) {
  const out = [];
  latestAuditBySku.forEach((auditRow, sku) => {
    const invRow = latestInventoryBySku.get(sku);
    if (!invRow) return;
    const checks = [
      { field: 'title', recommended: auditRow.title_rewrite, current: invRow.title },
      { field: 'backend_keywords', recommended: auditRow.backend_rewrite, current: invRow.backend_keywords },
    ];
    checks.forEach(({ field, recommended, current }) => {
      if (!recommended) return; // nothing was recommended for this field
      const matches = normalizeForCompare(recommended) === normalizeForCompare(current);
      out.push({
        sku,
        field,
        recommended: String(recommended).slice(0, 200),
        current_matches_recommendation: matches,
        audited_at: (auditRow.audited_at || '').slice(0, 10),
      });
    });
  });
  return out;
}

function mergeRecommendedActions(rows, actionsByKeyword, fallback) {
  rows.forEach(r => {
    r.recommended_action = (actionsByKeyword && actionsByKeyword[r.keyword]) || fallback;
  });
}

// Added 2026-07-28 after a real truncated response failed to parse even
// after the old log_summary-based repair attempt. That approach only
// works if truncation happened to land AFTER the log_summary field
// started — this one tracks actual bracket/brace nesting and string state
// through the whole text, so it can validly close whatever was left open
// regardless of WHERE the cut happened. Not guaranteed to produce
// SEMANTICALLY complete data (a cut mid-array means that array's later
// items are just gone), but it produces syntactically valid JSON far more
// reliably than guessing at a specific field name or blindly grabbing the
// last '}' in the text, which can leave a dangling comma or an unclosed
// string — differently invalid, not fixed.
function repairTruncatedJson(text) {
  const stack = [];
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  let repaired = text;
  if (inString) repaired += '"'; // cut off mid-string-value — close it first
  // A cut landing right after a property name (with or without its colon)
  // leaves a key with no value at all — that can't be closed validly, has
  // to be removed entirely along with its leading comma. Checked against
  // 4 realistic truncation points before trusting this, not just assumed.
  repaired = repaired.replace(/,\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, '');
  repaired = repaired.replace(/,\s*$/, '').replace(/:\s*$/, ''); // trailing dangling comma/colon from elsewhere
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === '{' ? '}' : ']';
  }
  return repaired;
}

// Last resort when Claude's response can't be salvaged at all (rare, but
// real — see the two repair attempts above). Everything in here was
// already fully computed in code regardless of what Claude returned, so
// this still writes real numbers to the sheet with a clearly-labeled
// placeholder narrative, rather than the whole run producing nothing.
// Matches the same "never let one bad response destroy the whole result"
// principle the cron reliability playbook already applies elsewhere.
function buildFallbackInsights({ rankChanges, newPpcConverters, page1Opportunities, rankingDiagnostic, listingImplementationStatus, skuStrategySnapshots, comparison }) {
  const note = 'Claude\'s narrative response could not be parsed this run (likely truncated) — the numbers below are real and fully computed, but the written summary/wins/actions text is a placeholder until the next successful run.';
  const fallbackStrategyBySku = {};
  Object.keys(skuStrategySnapshots || {}).forEach(sku => {
    fallbackStrategyBySku[sku] = { ...skuStrategySnapshots[sku], recommended_bullets: [], suggested_exact_match_targets: [] };
  });
  return {
    date: new Date().toISOString().slice(0, 10),
    organic: {
      summary: note, reading_the_changes: note, wins: [], actions: [], opportunities: [], keywords_to_watch: [],
      ranking_diagnostic: rankingDiagnostic ? note : 'Not enough data this week to compute.',
      rank_changes: rankChanges, new_ppc_converters: newPpcConverters, page1_opportunities: page1Opportunities,
      ranking_diagnostic_data: rankingDiagnostic,
      comparison_window: comparison.hasHistory ? { prev_date: comparison.prevDate, curr_date: comparison.currDate } : null,
    },
    ppc: { summary: note, wins: [], actions: [], opportunities: [], strategy_by_sku: fallbackStrategyBySku },
    listing: { summary: note, violations: [], keyword_gaps: [], rewrites_recommended: [], implementation_status: listingImplementationStatus },
    log_summary: note,
  };
}

// Keywords sitting just off page 1 with real volume behind them — a
// realistic push target, not just "everything unranked." Sorted by volume
// so the highest-payoff pushes surface first. Added 2026-07-27 per Jaclyn:
// "as keywords get close to first page, we want to make sure we are taking
// advantage of trying to get it pushed to first page."
function buildPage1Opportunities(rankChanges) {
  return rankChanges
    .filter(r => r.rank_curr_numeric !== null && r.rank_curr_numeric > PAGE1_RANK_CUTOFF && r.rank_curr_numeric <= CLOSE_TO_PAGE1_MAX)
    .sort((a, b) => (b.vol_mo || 0) - (a.vol_mo || 0))
    .map(r => ({ ...r, recommended_action: null }));
}

// The "why are we only ranking for our own brand name" diagnostic. Splits
// tracked keywords into high/low volume using the MEDIAN of this brand's
// OWN tracked keyword volumes (not a fixed number) — relative to each
// brand's actual keyword landscape rather than one magic threshold that
// wouldn't generalize across brands with very different search volumes.
// Per Jaclyn 2026-07-27: higher search volume = harder to rank for, as a
// rule of thumb (no competing-ASIN-count field available to use instead —
// confirmed absent from the keyword tracker sheet). Gives Claude the real
// ranking-rate split by volume tier — Claude reasons about WHY using only
// these numbers, does not invent the diagnosis from nothing.
function buildRankingDiagnostic(rankChanges) {
  const withVolume = rankChanges.filter(r => r.vol_mo !== null && r.vol_mo > 0);
  if (!withVolume.length) return null;
  const sortedVolumes = withVolume.map(r => r.vol_mo).sort((a, b) => a - b);
  const medianVolume = sortedVolumes[Math.floor(sortedVolumes.length / 2)];
  const highVol = withVolume.filter(r => r.vol_mo >= medianVolume);
  const lowVol = withVolume.filter(r => r.vol_mo < medianVolume);
  const rankingCount = arr => arr.filter(r => r.rank_curr_numeric !== null).length;
  return {
    median_volume_threshold: medianVolume,
    high_volume_total: highVol.length,
    high_volume_ranking: rankingCount(highVol),
    low_volume_total: lowVol.length,
    low_volume_ranking: rankingCount(lowVol),
  };
}

// ── Per-SKU strategy snapshot (replaces the hand-authored "Strategy by
// Product" cards) ────────────────────────────────────────────────────────
// Added 2026-07-31 per Jaclyn. Same philosophy as everything above: the
// real numbers (latest-month sessions/units/revenue/conversion per SKU,
// plus that SKU's top tracked keywords by volume) are computed here in
// code. Claude's only job (see ppc.strategy_by_sku in the prompt below) is
// to turn those numbers into 2-4 prioritized recommendation bullets per
// SKU, matching the tone of the old hand-written cards — not to invent or
// restate the numbers itself.
//
// Deliberately keyed by SKU, not by product type (Activators/Shampoos/
// etc.) — this file has no reliable source for that grouping (it's a
// dashboard-side concept baked into index.html's tab structure), whereas
// every sheet already keys rows by SKU. The dashboard slots each SKU's
// strategy into the right product-type tab itself.

function latestBizRowPerSku(bizRowsFull) {
  const map = new Map();
  bizRowsFull.forEach(r => {
    const sku = findField(r, BIZ_FIELD_CANDIDATES.sku);
    if (!sku) return;
    const y = parseInt(findField(r, BIZ_FIELD_CANDIDATES.year), 10);
    const m = parseInt(findField(r, BIZ_FIELD_CANDIDATES.month), 10);
    // Prefer a real year/month sort key; fall back to a raw date string if
    // year/month columns don't exist under any of the guessed names above.
    const sortKey = (Number.isFinite(y) && Number.isFinite(m))
      ? y * 100 + m
      : (findField(r, BIZ_FIELD_CANDIDATES.date) || '');
    const existing = map.get(sku);
    if (!existing || sortKey > existing._sortKey) map.set(sku, { row: r, _sortKey: sortKey });
  });
  return map;
}

// CONVERSION_RATE's stored format isn't confirmed (could be a 0-1 fraction
// or an already-percent number) — same ambiguity computeAbaPct() already
// handles above for ABA%, so reusing the identical "≤1 means fraction"
// heuristic here rather than inventing a different rule for a very
// similar problem. Also strips a trailing "%" defensively in case the
// sheet stores it as formatted text rather than a raw number.
function parseConversionPct(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(String(raw).replace('%', '').trim());
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

// Guards against the same failure mode this codebase has already hit once
// elsewhere (documented in the dashboard's PPC search-term code): Google
// Sheets CSV export writes a cell's DISPLAYED text, so a currency- or
// comma-formatted number like "$1,234.56" fails parseInt/parseFloat
// outright (they stop at the first non-numeric character) and silently
// becomes 0/null instead of throwing. Stripping everything but digits,
// a single leading minus, and a decimal point before parsing avoids that
// regardless of whether ORDERED_PRODUCT_SALES/UNITS_ORDERED ever end up
// formatted that way.
function parseNumericCell(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function buildSkuStrategySnapshots(kwRows, bizRowsFull, sqpRows) {
  const bizBySku = latestBizRowPerSku(bizRowsFull);

  const kwBySku = new Map();
  kwRows.forEach(r => {
    const sku = (r.sku || '').trim();
    if (!sku) return;
    if (!kwBySku.has(sku)) kwBySku.set(sku, []);
    kwBySku.get(sku).push(r);
  });

  const allSkus = new Set([...bizBySku.keys(), ...kwBySku.keys()]);
  const snapshots = {};

  allSkus.forEach(sku => {
    const bizEntry = bizBySku.get(sku);
    const bizRow = bizEntry ? bizEntry.row : null;

    // Top 10 tracked keywords for this SKU by volume — Claude picks which
    // few are worth featuring in its recommendation bullets and suggested
    // exact-match targets; it doesn't need the full long tail to do that.
    const topKeywords = (kwBySku.get(sku) || [])
      .filter(r => r.keyword)
      .map(r => ({
        keyword: r.keyword,
        vol_mo: parseInt(r.search_volume, 10) || null,
        organic_rank: parseRank(r.organic_rank).raw,
        aba_pct: computeAbaPct(sqpRows, r.keyword),
        competing: findField(r, KEYWORD_COMPETING_CANDIDATES),
        cpc: findField(r, KEYWORD_CPC_CANDIDATES),
      }))
      .sort((a, b) => (b.vol_mo || 0) - (a.vol_mo || 0))
      .slice(0, 10);

    snapshots[sku] = {
      sku,
      sessions:        bizRow ? parseNumericCell(findField(bizRow, BIZ_FIELD_CANDIDATES.sessions)) : null,
      units:           bizRow ? parseNumericCell(findField(bizRow, BIZ_FIELD_CANDIDATES.units)) : null,
      revenue:         bizRow ? parseNumericCell(findField(bizRow, BIZ_FIELD_CANDIDATES.revenue)) : null,
      conversion_pct:  bizRow ? parseConversionPct(findField(bizRow, BIZ_FIELD_CANDIDATES.conversion)) : null,
      top_keywords:    topKeywords,
    };
  });

  return snapshots;
}



async function runAnalysisForBrand(brand, apiKey) {
  const brandDesc = BRAND_DESCRIPTIONS[brand.id] || BRAND_DESCRIPTIONS.default;

  const [kwRows, bizRows, sqpRows, ppcRows, adOrdersRows, listingRows, historyRows, productInventoryRows] = await Promise.all([
    readRows(KEYWORD_TRACKER_SHEET_ID, brand.tabName).catch(() => []),
    readRows(sheets.businessReport, brand.tabName).catch(() => []),
    readRows(sheets.searchQueryPerformance, brand.tabName).catch(() => []),
    readRows(sheets.advertising, brand.tabName).catch(() => []),
    readRows(sheets.adOrders, brand.tabName).catch(() => []),
    readRows(sheets.listingAudit, brand.tabName).catch(() => []),
    readRows(sheets.insights, brand.tabName).catch(() => []),
    readRows(sheets.productInventory, brand.tabName).catch(() => []),
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

  // Real current listing copy, collapsed to most-recent-date per SKU — same
  // pattern run-listing-audit.js already uses on this same sheet. Needed
  // for buildListingImplementationStatus() below.
  const latestInventoryBySku = new Map();
  productInventoryRows.forEach(r => {
    const sku = (r.sku || '').trim();
    if (!sku) return;
    const existing = latestInventoryBySku.get(sku);
    if (!existing || (r.date || '') > (existing.date || '')) latestInventoryBySku.set(sku, r);
  });

  const historicalCtx = historyRows.length
    ? historyRows.slice(-4).map(r => r['LOG_SUMMARY'] || '').filter(Boolean).join('\n---\n').slice(0, 2000)
    : 'First automated run — no prior data.';

  // ── The new deterministic layer ──────────────────────────────────────────
  const comparison = pickComparisonDates(kwRows);
  const ppcByTerm = aggregatePpcByTerm(ppcRows);
  const trackedKeywordSet = new Set(kwRows.map(r => normalizeTerm(r.keyword)));
  const rankChanges = buildRankChanges(kwRows, ppcByTerm, sqpRows, latestBySku, comparison);
  const newPpcConverters = buildNewPpcConverters(ppcByTerm, trackedKeywordSet);
  const page1Opportunities = buildPage1Opportunities(rankChanges);
  const rankingDiagnostic = buildRankingDiagnostic(rankChanges);
  const listingImplementationStatus = buildListingImplementationStatus(latestBySku, latestInventoryBySku);
  // Uses the FULL bizRows, not bizTrimmed (which is sliced to the last 15
  // rows for the general PPC prompt context below) — this needs a real
  // latest-month-per-SKU lookup across all history, not just a recent tail.
  const skuStrategySnapshots = buildSkuStrategySnapshots(kwRows, bizRows, sqpRows);

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

  // Added 2026-07-27 per Jaclyn — "as keywords get close to first page, we
  // want to make sure we are taking advantage of trying to get it pushed
  // to first page." Already computed/sorted by volume; Claude writes the
  // push tactic per keyword, same merge-back pattern as rank changes.
  const page1OpportunitiesSection = page1Opportunities.length
    ? `\n\nPAGE 1 PUSH OPPORTUNITIES — rank ${PAGE1_RANK_CUTOFF + 1}-${CLOSE_TO_PAGE1_MAX}, sorted by volume (already computed; write recommended_action for each — a specific tactic to push this keyword onto page 1, not a generic note):\n${JSON.stringify(page1Opportunities.map(r => ({ keyword: r.keyword, vol_mo: r.vol_mo, rank_curr: r.rank_curr, ppc_signal: r.ppc_signal, aba_pct: r.aba_pct })))}`
    : '\n\nPAGE 1 PUSH OPPORTUNITIES: none in the 49-100 rank band this week.';

  // Added 2026-07-27 per Jaclyn's évolis-brand-term example: "if the
  // keyword tracker is showing that we are only ranking for evolis... I
  // want to know if we are not ranking for other keywords - why & what we
  // should do about it." Real ranking-rate split by volume tier, computed
  // in code — Claude reasons about WHY using only these numbers.
  const rankingDiagnosticSection = rankingDiagnostic
    ? `\n\nRANKING DIAGNOSTIC (already computed — real counts, not an estimate): of ${rankingDiagnostic.high_volume_total} higher-volume tracked keywords (≥${rankingDiagnostic.median_volume_threshold}/mo), ${rankingDiagnostic.high_volume_ranking} currently rank at all. Of ${rankingDiagnostic.low_volume_total} lower-volume tracked keywords, ${rankingDiagnostic.low_volume_ranking} currently rank at all. If BOTH figures are near zero, that points toward something structural (possible suppression, indexing issue, or a listing genuinely thin on these terms) rather than just difficulty — say so plainly. If only the higher-volume group is failing while lower-volume terms show real ranking success, that instead points toward those specific terms simply being too competitive to win right now — say that instead, and suggest whether effort is better spent on comparatively attainable lower-volume expansion. Do not claim a diagnosis stronger than these two numbers actually support.`
    : '\n\nRANKING DIAGNOSTIC: not enough keywords with recorded search volume to compute this week.';

  // Added 2026-07-27 per Jaclyn: "changes can only be tracked based off
  // listing updates... on the products sheet you can see daily what the
  // listings are showing." Real comparison of past audit recommendations
  // against today's actual live copy — not a guess about whether ads/PPC
  // suggestions were acted on (that's not independently verifiable and
  // was deliberately dropped, see file history).
  const listingImplementationSection = listingImplementationStatus.length
    ? `\n\nPAST LISTING RECOMMENDATIONS VS. CURRENT LIVE COPY (already computed by directly comparing text — not a guess): ${JSON.stringify(listingImplementationStatus)}. For any entry where current_matches_recommendation is false, note in listing.rewrites_recommended (or listing.summary if more than a couple) that the recommendation from that entry's audited_at date does not yet match current live copy — it may not have been implemented yet, or may have been addressed with different wording; do not assume which.`
    : '';

  // Added 2026-07-31 per Jaclyn — replaces the hand-authored PPC "Strategy
  // by Product" cards on the dashboard. Same merge-back pattern as rank
  // changes/page1 opportunities above: numbers computed here, Claude only
  // writes the prose (see ppc.strategy_by_sku in the schema below).
  const skuStrategySection = Object.keys(skuStrategySnapshots).length
    ? `\n\nPER-SKU BUSINESS + KEYWORD SNAPSHOT — replaces the old hand-authored "Strategy by Product" cards (already computed; write 2-4 prioritized recommendation bullets per SKU plus a short list of suggested exact-match keyword targets, same style as the old cards: "PPC on 'hair growth serum' + 'scalp serum' — Reverse converts at 22.95% but only sees 122 sessions. At current conversion, adding 300 incremental sessions = +68 units/month."):\n${JSON.stringify(skuStrategySnapshots)}`
    : '';

  const userPrompt = `Analyze this week vs history. Return ONLY this JSON structure, nothing else:

{"date":"YYYY-MM-DD","organic":{"summary":"string","reading_the_changes":"string","wins":["string"],"actions":["string"],"opportunities":["string"],"keywords_to_watch":["string"],"ranking_diagnostic":"string","recommended_actions_by_keyword":{"<keyword>":"string"},"recommended_actions_new_converters":{"<keyword>":"string"},"recommended_actions_page1_opportunities":{"<keyword>":"string"}},"ppc":{"summary":"string","wins":["string"],"actions":["string"],"opportunities":["string"],"strategy_by_sku":{"<SKU>":{"recommended_bullets":[{"priority":"HIGH|MED|LOW","text":"string"}],"suggested_exact_match_targets":["string"]}}},"listing":{"summary":"string","violations":["string"],"keyword_gaps":["string"],"rewrites_recommended":["string"]},"log_summary":"string"}

Rules for the response:
- date: today's date in YYYY-MM-DD format
- organic.reading_the_changes: prose, in the style of a sharp weekly recap — call out the single biggest win, the single biggest drop, and one clear next action, using ONLY the rank-change data provided below (do not invent numbers)
- organic.recommended_actions_by_keyword: one entry per keyword from KEYWORD RANK CHANGES below, keyed EXACTLY as given. Each value is one tactical sentence (bid amount, campaign type, or "no action" if genuinely nothing to do) — same style as: "Add exact-match PPC at $1.00-1.25 to rebuild this term." Do not add or omit keywords from what's given.
- organic.recommended_actions_new_converters: same idea, one entry per term from NEW PPC CONVERTERS below, keyed EXACTLY as given
- organic.recommended_actions_page1_opportunities: same idea, one entry per keyword from PAGE 1 PUSH OPPORTUNITIES below, keyed EXACTLY as given
- organic.opportunities: the page-1-push keywords framed as prose opportunities (not a duplicate of the keyed action map above — this is the human-readable version for the insights card)
- organic.ranking_diagnostic: 2-4 sentences using ONLY the RANKING DIAGNOSTIC numbers below. If nothing notable, say organic ranking looks proportional to keyword difficulty this week rather than forcing a concern that isn't there.
- ppc.strategy_by_sku: one entry per SKU from the PER-SKU BUSINESS + KEYWORD SNAPSHOT below, keyed EXACTLY by SKU (e.g. "EVO0001"). Do not add or omit SKUs from what's given. 2-4 recommended_bullets per SKU, ordered HIGH priority first, each one tactical sentence that references real numbers from that SKU's own snapshot (sessions, conversion_pct, revenue, or a keyword's vol_mo/aba_pct) — do not invent numbers not present in the snapshot, and do not compare one SKU's numbers against another SKU's. suggested_exact_match_targets: 3-7 keyword strings pulled from that SKU's own top_keywords list (do not invent keywords not in the list).
- IMPORTANT — DO NOT LIMIT THE NUMBER OF ITEMS IN ANY LIST FIELD (wins, actions, opportunities, keywords_to_watch, violations, keyword_gaps, rewrites_recommended, etc). Report every genuine finding the data actually supports. Do not pad weak filler to reach a minimum, and do not cut real findings to fit an artificial maximum — some weeks may have 2 real wins, other weeks may have 10; both are fine, report what's actually there.
- No apostrophes in string values — use "does not" not "doesn't", etc.
- Keep all string values under 200 characters

BUSINESS REPORT (sessions/units/revenue):
${JSON.stringify(bizTrimmed)}

PPC (search terms / ad performance):
${JSON.stringify(ppcTrimmed)}${sqpSection}${adOrdersSection}${rankChangesSection}${newConvertersSection}${page1OpportunitiesSection}${rankingDiagnosticSection}${listingImplementationSection}${skuStrategySection}

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
      // Raised from 5000 to 12000 on 2026-07-28 — the item-count caps
      // removed earlier that same day made responses genuinely longer
      // (uncapped wins/actions/opportunities/keywords_to_watch, plus a
      // keyed recommended-action sentence per keyword in rank_changes,
      // which scales with however many keywords this brand tracks), and
      // 5000 started truncating mid-response for evolis the same day this
      // shipped. See the repair logic below for what happens if a
      // response still exceeds this.
      max_tokens: 12000,
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

  const clean0 = raw
    .replace(/^```json\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  // Three escalating attempts before giving up — see repairTruncatedJson()
  // and buildFallbackInsights() above for why each exists.
  let insights = null;
  let lastParseErr = null;

  // Attempt 1: as-is (covers the common case — not actually truncated).
  try { insights = JSON.parse(clean0); } catch (e) { lastParseErr = e; }

  // Attempt 2: the original log_summary-based repair — cheap, and still
  // exactly right when truncation happens to land late in the response.
  if (!insights && !clean0.endsWith('}')) {
    console.warn(`[run-analysis] ${brand.id} — response may be truncated, attempting repair (1/2: log_summary cut)`);
    const lastBrace = clean0.lastIndexOf('"log_summary"');
    if (lastBrace > 0) {
      const attempt = clean0.slice(0, lastBrace) + '"log_summary":"Analysis complete — see organic, PPC and listing sections above."}';
      try { insights = JSON.parse(attempt); } catch (e) { lastParseErr = e; }
    }
  }

  // Attempt 3: real bracket/string-tracking repair — works regardless of
  // WHERE the cut happened, unlike attempt 2.
  if (!insights) {
    console.warn(`[run-analysis] ${brand.id} — attempting repair (2/2: bracket-tracking)`);
    try { insights = JSON.parse(repairTruncatedJson(clean0)); } catch (e) { lastParseErr = e; }
  }

  // All three failed — fall back to deterministic-only data rather than
  // throwing and writing nothing at all for this week.
  if (!insights) {
    console.error(`[run-analysis] ${brand.id} — all JSON repair attempts failed. Raw length: ${raw.length}. Last error: ${lastParseErr && lastParseErr.message}. Falling back to deterministic-only insights.`);
    console.error('[run-analysis] Raw (first 500):', clean0.slice(0, 500));
    insights = buildFallbackInsights({ rankChanges, newPpcConverters, page1Opportunities, rankingDiagnostic, listingImplementationStatus, skuStrategySnapshots, comparison });
    return insights; // already has rank_changes/etc. attached — skip the merge-back below, it's already in final shape
  }

  insights.date = new Date().toISOString().slice(0, 10); // always override — Claude often hallucinates dates

  // Merge Claude's prose back onto the code-computed numbers — this is the
  // only place organic.rank_changes / organic.new_ppc_converters /
  // organic.page1_opportunities get built.
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
  mergeRecommendedActions(
    page1Opportunities,
    insights.organic && insights.organic.recommended_actions_page1_opportunities,
    'Increase exact-match PPC bid to build ranking velocity toward page 1.'
  );
  if (insights.organic) {
    insights.organic.rank_changes = rankChanges;
    insights.organic.new_ppc_converters = newPpcConverters;
    insights.organic.page1_opportunities = page1Opportunities;
    insights.organic.ranking_diagnostic_data = rankingDiagnostic; // real numbers behind organic.ranking_diagnostic's prose
    insights.organic.comparison_window = comparison.hasHistory
      ? { prev_date: comparison.prevDate, curr_date: comparison.currDate }
      : null;
    delete insights.organic.recommended_actions_by_keyword;
    delete insights.organic.recommended_actions_new_converters;
    delete insights.organic.recommended_actions_page1_opportunities;
  }
  if (insights.listing) {
    insights.listing.implementation_status = listingImplementationStatus; // real comparison data backing any "not yet implemented" notes above
  }
  if (insights.ppc) {
    // Attach the deterministic snapshot (sessions/units/revenue/conversion/
    // top_keywords) onto whatever Claude wrote for each SKU — the dashboard
    // needs both the real numbers (for the card header) and the prose
    // (recommended_bullets / suggested_exact_match_targets), same as
    // organic.rank_changes above. Every SKU in the snapshot gets an entry
    // even if Claude's response omitted it (empty bullets rather than a
    // missing card), and any SKU Claude invented that isn't in the real
    // snapshot is dropped rather than trusted.
    const claudeBySku = insights.ppc.strategy_by_sku || {};
    const merged = {};
    Object.keys(skuStrategySnapshots).forEach(sku => {
      const claudeEntry = claudeBySku[sku] || {};
      merged[sku] = {
        ...skuStrategySnapshots[sku],
        recommended_bullets: Array.isArray(claudeEntry.recommended_bullets) ? claudeEntry.recommended_bullets : [],
        suggested_exact_match_targets: Array.isArray(claudeEntry.suggested_exact_match_targets) ? claudeEntry.suggested_exact_match_targets : [],
      };
    });
    insights.ppc.strategy_by_sku = merged;
  }

  return insights;
}

// ── Write result directly to sheets.insights ────────────────────────────────

// Google Sheets hard-rejects any single cell over 50,000 characters. Real
// failure hit 2026-07-31: with item-count caps removed (per Jaclyn
// 2026-07-27), organic.rank_changes/page1_opportunities/new_ppc_converters
// now carry one full entry per TRACKED keyword with no cap — for a brand
// tracking enough keywords, JSON.stringify(insights.organic) alone blew
// past the limit and the whole write failed.
//
// Fix is scoped deliberately: the NARRATIVE fields (summary, wins,
// actions, opportunities, keywords_to_watch, ranking_diagnostic) stay
// fully uncapped — that was the actual point of removing the caps, and
// none of those are large enough to be the real risk here anyway. Only
// the raw BULK DATA ARRAYS get trimmed, and only for what gets PERSISTED
// to the historical log — the live HTTP response (returned to whoever
// clicked "Run Analysis") keeps everything untrimmed, since those arrays
// get recomputed fresh from source data on every run regardless — losing
// some rows from one historical log snapshot isn't losing real
// information, it's just not re-deriving something that's already
// available live.
//
// Trimming is dynamic (check actual size, cut the largest array, repeat)
// rather than a fixed item-count guess — entries vary in string length
// (a longer recommended_action sentence takes more room than a short
// one), so a fixed count doesn't reliably guarantee staying under the
// real character limit the way actually measuring it does.
const MAX_CELL_CHARS = 45000; // Google's real limit is 50000 — leaving real margin, not cutting it close

function trimArraysToFit(obj, arrayFieldNames) {
  const clone = JSON.parse(JSON.stringify(obj)); // never mutate the original — the live HTTP response needs the full version
  let trimmed = false;
  while (JSON.stringify(clone).length > MAX_CELL_CHARS) {
    let largestField = null, largestLen = 0;
    arrayFieldNames.forEach(f => {
      if (Array.isArray(clone[f]) && clone[f].length > largestLen) {
        largestLen = clone[f].length;
        largestField = f;
      }
    });
    if (!largestField) break; // nothing left we're allowed to trim — stop rather than loop forever
    clone[largestField] = clone[largestField].slice(0, Math.ceil(largestLen * 0.8)); // cut 20% at a time
    trimmed = true;
  }
  if (trimmed) clone._truncated_for_sheet_storage = true; // visible marker, not a silent cut
  return clone;
}

// ppc_json wasn't a size risk before (summary/wins/actions/opportunities
// strings only), so it was never run through trimArraysToFit above. Added
// 2026-07-31: ppc.strategy_by_sku now carries one entry per SKU, each with
// its own top_keywords array — for a brand tracking many SKUs and many
// keywords per SKU, this can realistically approach the same 50k-char
// Google Sheets cell limit organic/listing already had to guard against.
// trimArraysToFit above assumes the arrays needing trimming sit at the
// object's top level (rank_changes, etc.) — strategy_by_sku's arrays are
// one level down, nested per SKU, so it needs its own pass rather than
// reusing that function as-is.
function trimPpcToFit(ppcObj) {
  const clone = JSON.parse(JSON.stringify(ppcObj)); // never mutate the original — the live HTTP response needs the full version
  if (!clone.strategy_by_sku) return clone;
  let trimmed = false;

  // Pass 1: shrink every SKU's top_keywords list down toward a floor of 3
  // before dropping whole SKU entries — losing a few long-tail keyword
  // rows per SKU is a smaller loss than losing an entire product's card.
  let floor = 10;
  while (JSON.stringify(clone).length > MAX_CELL_CHARS && floor > 3) {
    floor -= 2;
    Object.values(clone.strategy_by_sku).forEach(entry => {
      if (Array.isArray(entry.top_keywords) && entry.top_keywords.length > floor) {
        entry.top_keywords = entry.top_keywords.slice(0, floor);
        trimmed = true;
      }
    });
  }

  // Pass 2 (rare): still too big — drop the lowest-revenue SKU entries one
  // at a time until it fits. Same "measure, don't guess a fixed count"
  // approach as trimArraysToFit above; revenue (rather than alphabetical
  // or insertion order) as the drop priority so whatever's cut is the
  // least business-relevant entry, not an arbitrary one.
  while (JSON.stringify(clone).length > MAX_CELL_CHARS) {
    const skus = Object.keys(clone.strategy_by_sku);
    if (!skus.length) break;
    let lowestSku = skus[0], lowestRevenue = Infinity;
    skus.forEach(sku => {
      const rev = clone.strategy_by_sku[sku].revenue || 0;
      if (rev < lowestRevenue) { lowestRevenue = rev; lowestSku = sku; }
    });
    delete clone.strategy_by_sku[lowestSku];
    trimmed = true;
  }

  if (trimmed) clone._truncated_for_sheet_storage = true; // visible marker, not a silent cut
  return clone;
}

async function writeInsightsToSheet(brand, insights) {
  const token = await ensureTab(sheets.insights, brand.tabName, INSIGHTS_HEADERS);

  const organicForSheet = trimArraysToFit(insights.organic || {}, ['rank_changes', 'new_ppc_converters', 'page1_opportunities']);
  const ppcForSheet = trimPpcToFit(insights.ppc || {});
  const listingForSheet = trimArraysToFit(insights.listing || {}, ['implementation_status']);
  if (organicForSheet._truncated_for_sheet_storage || ppcForSheet._truncated_for_sheet_storage || listingForSheet._truncated_for_sheet_storage) {
    console.warn(`[run-analysis] ${brand.id} — organic/ppc/listing data trimmed to fit Google Sheets' 50k-char cell limit for the historical log. Full untrimmed data was still returned in this run's live response.`);
  }

  const row = [
    insights.date,
    JSON.stringify(organicForSheet),
    JSON.stringify(ppcForSheet),
    JSON.stringify(listingForSheet),
    insights.log_summary || '',
    new Date().toISOString(),
  ];
  await appendRows(sheets.insights, brand.tabName, [row], token);
  console.log(`[run-analysis] ${brand.id} — insights written for ${insights.date}`);
}
