/**
 * api/run-ppc-strategy-analysis.js
 * POST /api/run-ppc-strategy-analysis
 * Body: { brand: "evolis" }
 *
 * Added 2026-08-07 per Jaclyn. Manually triggered from a new "Run PPC
 * Analysis" button on the Insights Log page — same manual-not-cron
 * philosophy as run-analysis.js and run-listing-audit.js (Jaclyn wants
 * these trackable by who ran them and when, not silently automated).
 *
 * WHY THIS EXISTS SEPARATELY FROM run-analysis.js's EXISTING
 * ppc.strategy_by_sku: run-analysis.js already computes a per-SKU
 * snapshot (sessions/units/revenue/conversion/top_keywords) and has
 * Claude write 2-4 recommended_bullets + suggested_exact_match_targets
 * into the ppc_json column of SHEET_INSIGHTS's per-brand tab. That
 * genuinely overlaps with part of this. But the hardcoded dashboard
 * cards this is meant to replace (see Jaclyn's screenshots, 2026-08-07)
 * have THREE things the existing ppc_json approach doesn't:
 *   1. A top-line status badge per product ("TRAFFIC — Conv is strong",
 *      "LISTING FIX BEFORE SCALING PPC", "IMMEDIATE — 0 sessions, 0
 *      units") — not computed anywhere currently.
 *   2. "Wasted spend" flags on specific suggested keyword targets —
 *      not computed anywhere currently.
 *   3. A storage shape Jaclyn explicitly wants changed: ONE ROW PER
 *      PRODUCT on a NEW shared tab (SHEET_INSIGHTS gid=1053885538,
 *      currently blank) that EVERY BRAND writes to, keyed by SKU/ASIN —
 *      not a brand-scoped tab with one JSON blob per week nested
 *      inside a single log row. That's a real architecture change, not
 *      just an additive field, so it gets its own endpoint and its own
 *      write path rather than bolting further complexity onto
 *      run-analysis.js's existing per-brand-tab logic.
 *
 * Same "code computes facts, Claude only writes prose against them"
 * philosophy as run-analysis.js throughout: sessions/units/revenue/
 * conversion_pct, the status badge, and wasted-spend terms are ALL
 * computed deterministically in code below. Claude's only job is to
 * write 2-4 tactical recommendation bullets (with a priority per
 * bullet) and pick which of a SKU's own top keywords are worth calling
 * out as suggested exact-match targets — it does not invent numbers,
 * classify status, or decide what counts as wasted spend.
 *
 * ADDED 2026-08-07 per Jaclyn: this cron, run-analysis.js, and
 * run-listing-audit.js were operating as three independent silos —
 * PPC strategy had no idea the listing had a known, already-flagged
 * compliance violation; a fresh listing audit had no idea PPC already
 * concluded a product needs a listing fix before scaling spend. Fixed
 * by pulling in BOTH other analyses' latest output as extra read-only
 * context per SKU:
 *   - SHEET_INSIGHTS (évolis tab, gid=1069613491) — run-analysis.js's
 *     own most recent weekly row. Its ppc_json.strategy_by_sku is
 *     surfaced per SKU as "what the other weekly analysis already
 *     concluded" (a second opinion, not a duplicate — this cron's own
 *     status_badge/wasted_spend/inventory checks aren't in that older
 *     analysis at all), and its listing_json.implementation_status is
 *     surfaced too (whether a PRIOR listing recommendation actually got
 *     implemented, per that file's own already-built comparison logic).
 *   - SHEET_LISTING_AUDIT (évolis tab, gid=2075287627) — the latest
 *     audit row per SKU. Its *_notes fields (compliance findings, not
 *     the full rewrite text — kept short deliberately, see GAP #5) are
 *     surfaced so Claude can factor in a REAL, currently-open listing
 *     issue when writing PPC recommendations, the same way it already
 *     factors in this cron's own status_badge.
 * See buildCrossAnalysisContext() below. Same instruction pattern as
 * the OOS check further down: Claude is told explicitly what to do
 * with this context (don't recommend scaling PPC into a listing with
 * an unresolved violation), not just handed the data and left to guess
 * how much weight to give it.
 *
 * ═══════════════════════════════════════════════════════════════════
 * REAL GAPS BELOW — FLAGGED, NOT SILENTLY GUESSED:
 *
 *   1. RESOLVED 2026-08-07: the guessed tab name ("ppc_strategy") turned
 *      out not to match gid=1053885538 (Jaclyn's originally-intended
 *      blank tab) — since Google's write API needs a name not a gid,
 *      writing to the guessed name created a NEW tab instead, with its
 *      own new gid (1273080018). Confirmed working and Jaclyn opted to
 *      just keep this new tab as the real one going forward rather than
 *      correct it — PPC_STRATEGY_TAB_NAME below is now the confirmed,
 *      real destination.
 *
 *   1b. NEW 2026-08-07 per Jaclyn: PPC should never be recommended on an
 *      out-of-stock product. Added an inventory check against
 *      SHEET_NEWDERM_INVENTORY (évolis tab gid=2074324776).
 *
 *      FULLY RESOLVED 2026-08-10 — Jaclyn provided both config/sheets.js
 *      and a screenshot of the real sheet. Confirmed: config key is
 *      `newdermInventory`; the sheet genuinely has the 2-row merged
 *      header sheets.js's own comment described (row 1 = merged section
 *      titles like "Amazon Warehouse USA - FBA" / "Medaltus Warehouse -
 *      SF", blank outside each merge's leftmost cell; row 2 = the real
 *      column names; data starts row 3); readRows() (confirmed from its
 *      actual source) always treats row 1 as headers with no per-sheet
 *      override, so it was reading row 2's real headers as if they were
 *      the first data row, and every value came back undefined —
 *      exactly why is_oos read false for every single SKU. Fixed by
 *      fetchNewdermInventoryRows() below, which fetches this one sheet's
 *      raw range directly (A2:AE, skipping row 1 entirely) instead of
 *      going through readRows(). Also confirmed: this sheet has NO ASIN
 *      column at all, only `sku` — buildSkuSnapshots()'s existing
 *      ASIN-then-SKU fallback already handles this correctly since
 *      oosMaps.byAsin is simply always empty for this sheet, no code
 *      change needed there. FBA_QTY_CANDIDATES/WAREHOUSE_SF_QTY_
 *      CANDIDATES below now lead with `core_available_fba`/
 *      `core_available_sf` — this sheet reconciles marketplace-reported
 *      quantities against Cin7 Core's own tracked quantities (per
 *      sheets.js: "marketplace vs Cin7 Core by location"), and the
 *      core_available_* columns are Cin7's reconciled true-available
 *      figure, which is presumably the whole reason this reconciliation
 *      sheet exists rather than reading Amazon's/Walmart's own reported
 *      numbers directly. The raw marketplace-reported columns
 *      (amazon_fulfillable_quantity, amazon_seller_fulfilled_quantity)
 *      are kept as fallback candidates in case core_available_* is ever
 *      blank for a row Cin7 hasn't reconciled yet.
 *
 *   2. UPDATED 2026-08-08 per Jaclyn: this tab is meant to hold HISTORY,
 *      not just current state — "if I run this a week from now, I want
 *      it to add new rows," with same-day re-runs overwriting only that
 *      day's row per SKU. writeSkuStrategyRows() below was originally
 *      wrong here (stripped ALL of a brand's rows on every run
 *      regardless of date, silently deleting prior history) — fixed to
 *      only strip rows matching this brand AND today's exact date.
 *
 *      REVISITED 2026-08-10 — Jaclyn provided the real
 *      config/_sheets_client.js. Confirmed: replaceRows(sheetId,
 *      tabName, headers, rows, token) clears A2:ZZ then writes `rows`
 *      starting at A2 — it NEVER touches row 1, and its `headers`
 *      parameter is dead code, never referenced in the function body.
 *      ensureTab() only writes row 1 when the tab doesn't exist yet; on
 *      an existing tab it just logs a loud warning on header mismatch
 *      and deliberately does not auto-correct (its own comment: sheets
 *      "get hand-edited sometimes... blind auto-correction could clobber
 *      that"). Practical result confirmed from a live incident: this
 *      tab's header row got stuck at an old 14-column schema after
 *      is_oos was added as a 15th column, and neither ensureTab() nor
 *      replaceRows() will ever fix that automatically — it needs a
 *      one-time manual correction of row 1 (already done as of
 *      2026-08-10). The code in writeSkuStrategyRows() below does NOT
 *      attempt to write or correct row 1 itself, on purpose — a prior
 *      attempt to do so by prepending the header into the `rows` array
 *      wrote it as a literal data row at A2 instead (since that's where
 *      rows always start), stacking a duplicate-looking row instead of
 *      fixing anything. If this schema changes again, row 1 needs
 *      another manual fix — that's a real, known limitation of this
 *      tab's write path, not an oversight.
 *
 *   3. WASTED-SPEND JOIN KEY IS GUESSED. aggregatePpcByTerm() (copied
 *      from run-analysis.js) doesn't scope by ASIN/SKU at all — it just
 *      sums by search term across the whole sheet. buildWastedSpend()
 *      below tries to re-scope it per-ASIN by checking for an `asin` or
 *      `sku` field on each PPC row (ASIN tried first). If neither field
 *      exists on the real advertising sheet, wasted_spend_terms will
 *      come back empty for every SKU rather than wrong — check the
 *      console warning this logs if that happens.
 *
 *   4. STATUS BADGE THRESHOLDS ARE A FIRST-PASS GUESS, calibrated
 *      against exactly the 3 screenshot examples Jaclyn gave (Reverse:
 *      122 sessions/22.95% conv → "TRAFFIC"; Promote: 1,125 sessions/
 *      3.2% conv → "LISTING FIX"; Prevent: 15 sessions/0 units →
 *      "IMMEDIATE"). See computeStatusBadge() below for the exact
 *      numbers — these are almost certainly worth tuning once this runs
 *      against the full catalog and Jaclyn can eyeball whether the
 *      cutoffs feel right on products outside those 3 examples.
 *
 *   5. CROSS-ANALYSIS FIELD NAMES — mostly confirmed, one guess. SHEET_
 *      INSIGHTS's date/organic_json/ppc_json/listing_json/summary/
 *      uploaded_at columns and listing_json.implementation_status are
 *      confirmed directly from run-analysis.js's own header comment and
 *      code (same file this endpoint is meant to collaborate with).
 *      SHEET_LISTING_AUDIT's `sku` and `audited_at` fields are confirmed
 *      from the dashboard's own already-working loadAuditResultsFromSheet()
 *      code. The one real guess: the exact *_notes field names
 *      (title_notes/ih_notes/bullets_notes/desc_notes/backend_notes) —
 *      these match what showed up in a screenshot of one real audit
 *      result earlier in this project, but weren't re-confirmed against
 *      a fresh fetch here. buildCrossAnalysisContext() logs the real
 *      keys it finds on the first row of each sheet every run, so a
 *      naming drift is a quick console check rather than a silent gap.
 * ═══════════════════════════════════════════════════════════════════
 */

const { readRows, ensureTab, appendRows, replaceRows, getSheetsToken } = require('./config/_sheets_client');
const sheets = require('./config/sheets');
const brands = require('./config/brands');

// Same sheet already used for the per-keyword tracker elsewhere in this
// project (run-analysis.js, and the dashboard's own live BSR/keyword
// pulls) — confirmed directly, not routed through sheets.keywordTracker.
const KEYWORD_TRACKER_SHEET_ID = '1geNDQgd_1ensLDyZOuXZBnvQrFT_RC85l9rHHGpgJe4';

const PPC_STRATEGY_TAB_NAME = 'ppc_strategy'; // resolved 2026-08-07 — see GAP #1 in header comment

const PPC_STRATEGY_HEADERS = [
  'date', 'brand', 'sku', 'asin', 'status_badge', 'is_oos',
  'sessions', 'units', 'revenue', 'conversion_pct',
  'headline', 'recommended_bullets_json', 'suggested_exact_match_targets_json',
  'wasted_spend_terms_json', 'uploaded_at',
];

// ═══════════════════════════════════════════════════════════════════
// CROSS-ANALYSIS CONTEXT — added 2026-08-07 per Jaclyn (see GAP #5 and
// the file header comment for what's confirmed vs. guessed here).
// Pulls run-analysis.js's and run-listing-audit.js's latest output as
// extra read-only context per SKU, so PPC strategy can build on what
// those two already found instead of contradicting them.
const LISTING_AUDIT_NOTE_FIELDS = ['title_notes', 'ih_notes', 'bullets_notes', 'desc_notes', 'backend_notes'];

async function buildCrossAnalysisContext(brand) {
  const context = {
    priorPpcBySku: {},       // from SHEET_INSIGHTS's latest ppc_json.strategy_by_sku
    implementationBySku: {}, // from SHEET_INSIGHTS's latest listing_json.implementation_status
    listingViolations: [],   // from SHEET_INSIGHTS's latest listing_json.violations (brand-level, not per-SKU)
    auditNotesBySku: {},     // from SHEET_LISTING_AUDIT, latest row per SKU
  };

  try {
    const insightsRows = await readRows(sheets.insights, brand.tabName).catch(() => []);
    if (insightsRows.length) {
      const latest = insightsRows.reduce((best, r) => (!best || (r.date || '') > (best.date || '')) ? r : best, null);
      let ppcJson = {}, listingJson = {};
      try { ppcJson = JSON.parse(latest.ppc_json || '{}'); } catch (e) { console.warn('[run-ppc-strategy-analysis] SHEET_INSIGHTS latest row: ppc_json did not parse as JSON.'); }
      try { listingJson = JSON.parse(latest.listing_json || '{}'); } catch (e) { console.warn('[run-ppc-strategy-analysis] SHEET_INSIGHTS latest row: listing_json did not parse as JSON.'); }
      context.priorPpcBySku = ppcJson.strategy_by_sku || {};
      context.listingViolations = Array.isArray(listingJson.violations) ? listingJson.violations : [];
      (listingJson.implementation_status || []).forEach(item => {
        if (item && item.sku) context.implementationBySku[item.sku] = item;
      });
      console.log(`[run-ppc-strategy-analysis] ${brand.id} — SHEET_INSIGHTS latest row date: ${latest.date || '(none)'}, prior PPC SKUs found: ${Object.keys(context.priorPpcBySku).length}, implementation_status entries: ${(listingJson.implementation_status || []).length}`);
    } else {
      console.warn(`[run-ppc-strategy-analysis] ${brand.id} — SHEET_INSIGHTS returned no rows for this brand's tab.`);
    }
  } catch (e) {
    console.warn('[run-ppc-strategy-analysis] SHEET_INSIGHTS fetch failed:', e.message);
  }

  try {
    const auditRows = await readRows(sheets.listingAudit, brand.tabName).catch(() => []);
    if (auditRows.length) {
      console.log('[run-ppc-strategy-analysis][qa] SHEET_LISTING_AUDIT — row[0] keys:', Object.keys(auditRows[0]).join(' | '));
      const bySku = {};
      auditRows.forEach(r => {
        const sku = (r.sku || r.SKU || '').toString().trim();
        if (!sku) return;
        const existing = bySku[sku];
        if (!existing || (r.audited_at || '') > (existing.audited_at || '')) bySku[sku] = r;
      });
      Object.keys(bySku).forEach(sku => {
        const r = bySku[sku];
        const notes = LISTING_AUDIT_NOTE_FIELDS.map(f => r[f]).filter(Boolean).join(' | ').slice(0, 500);
        context.auditNotesBySku[sku] = notes;
      });
      console.log(`[run-ppc-strategy-analysis] ${brand.id} — SHEET_LISTING_AUDIT: ${Object.keys(bySku).length} SKUs with a latest audit row.`);
    } else {
      console.warn(`[run-ppc-strategy-analysis] ${brand.id} — SHEET_LISTING_AUDIT returned no rows for this brand's tab.`);
    }
  } catch (e) {
    console.warn('[run-ppc-strategy-analysis] SHEET_LISTING_AUDIT fetch failed:', e.message);
  }

  return context;
}

// Évolis tab, gid=2074324776, per Jaclyn 2026-08-07.
// CONFIRMED 2026-08-10 against a real screenshot of the sheet: column
// names are `sku` (no ASIN column exists on this sheet at all),
// `core_available_fba`, `core_available_sf`, plus the raw marketplace-
// reported `amazon_fulfillable_quantity` / `amazon_seller_fulfilled_
// quantity` kept as fallbacks. core_available_* leads the candidate
// list deliberately — this sheet's whole purpose (per sheets.js:
// "marketplace vs Cin7 Core by location") is reconciling marketplace-
// reported quantities against Cin7 Core's own tracked quantities, and
// core_available_* is Cin7's reconciled true-available figure.
const NEWDERM_INVENTORY_SHEET_KEY_CANDIDATES = ['newdermInventory', 'newdermInventoryReconciliation', 'newderm_inventory'];
const FBA_QTY_CANDIDATES = ['core_available_fba', 'amazon_fulfillable_quantity', 'amazon_fba', 'Amazon FBA', 'fba_available', 'fba_quantity', 'FBA'];
const WAREHOUSE_SF_QTY_CANDIDATES = ['core_available_sf', 'amazon_seller_fulfilled_quantity', 'medaltus_warehouse_sf', 'Medaltus Warehouse - SF', 'warehouse_sf', 'sf_quantity'];
const OOS_ASIN_CANDIDATES = ['ASIN', 'asin', 'Asin'];
const OOS_SKU_CANDIDATES = ['SKU', 'sku', 'Sku'];

function resolveNewdermInventorySheetId() {
  for (const key of NEWDERM_INVENTORY_SHEET_KEY_CANDIDATES) {
    if (sheets[key]) return sheets[key];
  }
  return null;
}

// FIXED 2026-08-10 per Jaclyn (confirmed via a real screenshot of the
// sheet — see GAP #1b in the file header comment): this sheet genuinely
// has a 2-row merged header (row 1 = merged section titles, blank
// outside each merge's leftmost cell; row 2 = real column names; data
// starts row 3). readRows() always treats row 1 as headers with no
// per-sheet override, so it was reading row 2's real headers as if they
// were the first data row — every field came back undefined, which is
// why is_oos read false for every SKU. Fetches the raw range directly
// instead, skipping row 1 entirely and using row 2 as headers.
async function fetchNewdermInventoryRows(sheetId, tabName) {
  try {
    const token = await getSheetsToken();
    const range = encodeURIComponent(`${tabName}!A2:AE`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.warn(`[run-ppc-strategy-analysis] SHEET_NEWDERM_INVENTORY raw fetch not ok (${res.status}) — is_oos will be false for every SKU this run.`);
      return [];
    }
    const data = await res.json();
    const values = data.values || [];
    if (values.length < 2) {
      console.warn('[run-ppc-strategy-analysis] SHEET_NEWDERM_INVENTORY raw fetch returned no data rows (only the header row, or nothing at all).');
      return [];
    }
    const headers = values[0]; // this is the sheet's real row 2 — the actual column names, not the merged section titles in row 1
    return values.slice(1).map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] !== undefined ? row[i] : ''])));
  } catch (e) {
    console.warn('[run-ppc-strategy-analysis] SHEET_NEWDERM_INVENTORY raw fetch failed:', e.message);
    return [];
  }
}

// Returns { bySku: Map, byAsin: Map } of booleans — true means this
// product is out of stock (FBA + Warehouse SF both at or below zero).
// Never throws: if the sheet or the expected columns aren't found, logs
// a clear warning and returns empty maps, so every SKU just falls back
// to is_oos=false (behaves exactly as before this feature existed)
// rather than crashing the whole run.
function buildOosMaps(inventoryRows) {
  const bySku = new Map();
  const byAsin = new Map();
  if (!inventoryRows.length) {
    console.warn('[run-ppc-strategy-analysis] SHEET_NEWDERM_INVENTORY returned no rows — is_oos will be false for every SKU.');
    return { bySku, byAsin };
  }

  console.log('[run-ppc-strategy-analysis][qa] SHEET_NEWDERM_INVENTORY — row[0] keys:', Object.keys(inventoryRows[0]).join(' | '));
  console.log('[run-ppc-strategy-analysis][qa] SHEET_NEWDERM_INVENTORY — row[0] sample:', JSON.stringify(inventoryRows[0]));

  const sample = inventoryRows[0];
  const hasFba = FBA_QTY_CANDIDATES.some(c => sample[c] !== undefined);
  const hasSf = WAREHOUSE_SF_QTY_CANDIDATES.some(c => sample[c] !== undefined);
  if (!hasFba && !hasSf) {
    console.warn('[run-ppc-strategy-analysis] Could not find an FBA or Warehouse SF column on SHEET_NEWDERM_INVENTORY (tried:', FBA_QTY_CANDIDATES.join(', '), '/', WAREHOUSE_SF_QTY_CANDIDATES.join(', '), ') — is_oos will be false for every SKU. Check the [qa] log line just above for the real column names on this run.');
    return { bySku, byAsin };
  }
  // This sheet has no ASIN column at all (confirmed 2026-08-10) — byAsin
  // will simply stay empty every run, and buildSkuSnapshots()'s existing
  // ASIN-then-SKU fallback already handles that correctly with no
  // further changes needed there.
  inventoryRows.forEach(r => {
    const fba = parseFloat(findField(r, FBA_QTY_CANDIDATES)) || 0;
    const sf = parseFloat(findField(r, WAREHOUSE_SF_QTY_CANDIDATES)) || 0;
    const isOos = (fba + sf) <= 0;
    const sku = (findField(r, OOS_SKU_CANDIDATES) || '').toString().trim().toUpperCase();
    const asin = (findField(r, OOS_ASIN_CANDIDATES) || '').toString().trim().toUpperCase();
    if (sku) bySku.set(sku, isOos);
    if (asin) byAsin.set(asin, isOos);
  });
  return { bySku, byAsin };
}


const BRAND_DESCRIPTIONS = {
  evolis:  'évolis (EVO) — a clinically tested hair growth brand using FGF5-inhibiting botanicals',
  skinuva: 'Skinuva (SVA) — a scar, bruise, and skin recovery brand',
  default: 'a Medaltus brand',
};

// ── Deterministic computation helpers ────────────────────────────────
// Copied from run-analysis.js rather than imported, since these are
// small, self-contained, and this endpoint should keep working even if
// run-analysis.js's internals change shape later.

function findField(row, candidates) {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== null && row[c] !== '') return row[c];
  }
  return null;
}

function normalizeTerm(s) {
  return String(s || '').trim().toLowerCase();
}

function parseConversionPct(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(String(raw).replace('%', '').trim());
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

function parseNumericCell(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// CONFIRMED 2026-07-31 per Jaclyn against the real Business Report
// sheet headers (MONTH, YEAR, ASIN, SKU, SESSIONS, PAGE_VIEWS,
// UNITS_ORDERED, ORDERED_PRODUCT_SALES, CONVERSION_RATE) — same as
// run-analysis.js.
const BIZ_FIELD_CANDIDATES = {
  sku:        ['SKU', 'sku', 'Sku'],
  asin:       ['ASIN', 'asin', 'Asin'],
  sessions:   ['SESSIONS', 'sessions', 'Sessions'],
  units:      ['UNITS_ORDERED', 'units_ordered', 'Units Ordered', 'units', 'Units'],
  revenue:    ['ORDERED_PRODUCT_SALES', 'ordered_product_sales', 'revenue', 'Revenue'],
  conversion: ['CONVERSION_RATE', 'conversion_rate', 'conversion', 'Conversion'],
  year:       ['YEAR', 'year', 'Year'],
  month:      ['MONTH', 'month', 'Month'],
  date:       ['date', 'Date'],
};

const KEYWORD_COMPETING_CANDIDATES = ['competing_products', 'competing', 'competing_asins', 'comp_count'];
const KEYWORD_CPC_CANDIDATES = ['cpc', 'suggested_cpc', 'estimated_cpc', 'sp_cpc'];
const ABA_FIELD_CANDIDATES = ['purchases_brand_share', 'purchase_brand_share', 'aba_conv_share', 'aba_purchase_share', 'conv_share'];

function computeAbaPct(sqpRows, keyword) {
  const kw = normalizeTerm(keyword);
  const row = sqpRows.find(r => normalizeTerm(r.search_query || r.keyword) === kw);
  if (!row) return null;
  const raw = findField(row, ABA_FIELD_CANDIDATES);
  if (raw === null) return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

function parseRank(raw) {
  if (raw === null || raw === undefined || raw === '') return { numeric: null, raw: '—' };
  const s = String(raw).trim();
  if (s.startsWith('>')) return { numeric: null, raw: s };
  const n = parseInt(s, 10);
  return { numeric: Number.isFinite(n) ? n : null, raw: s };
}

function latestBizRowPerSku(bizRowsFull) {
  const map = new Map();
  bizRowsFull.forEach(r => {
    const sku = findField(r, BIZ_FIELD_CANDIDATES.sku);
    if (!sku) return;
    const y = parseInt(findField(r, BIZ_FIELD_CANDIDATES.year), 10);
    const m = parseInt(findField(r, BIZ_FIELD_CANDIDATES.month), 10);
    const sortKey = (Number.isFinite(y) && Number.isFinite(m))
      ? y * 100 + m
      : (findField(r, BIZ_FIELD_CANDIDATES.date) || '');
    const existing = map.get(sku);
    if (!existing || sortKey > existing._sortKey) map.set(sku, { row: r, _sortKey: sortKey });
  });
  return map;
}

// Sums cost/purchases/sales/clicks per exact-match search term. See GAP
// #3 above — this does NOT scope by ASIN on its own; buildWastedSpend()
// below adds that scoping if the field exists on the real sheet.
function aggregatePpcByAsinAndTerm(ppcRows) {
  const map = new Map(); // asin -> Map(term -> {spend, purchases, sales, clicks})
  let sawAsinField = false;
  ppcRows.forEach(r => {
    const term = normalizeTerm(r.search_term || r.keyword);
    if (!term) return;
    const asin = (findField(r, ['asin', 'ASIN', 'Asin']) || '').toString().trim().toUpperCase();
    if (asin) sawAsinField = true;
    const key = asin || '__UNSCOPED__';
    if (!map.has(key)) map.set(key, new Map());
    const byTerm = map.get(key);
    const entry = byTerm.get(term) || { spend: 0, purchases: 0, sales: 0, clicks: 0 };
    entry.spend += parseFloat(r.cost) || 0;
    entry.purchases += parseInt(r.purchases, 10) || 0;
    entry.sales += parseFloat(r.sales) || 0;
    entry.clicks += parseInt(r.clicks, 10) || 0;
    byTerm.set(term, entry);
    map.set(key, byTerm);
  });
  return { byAsin: map, sawAsinField };
}

// Wasted spend = real spend, real clicks, zero purchases, for this SKU's
// own ASIN. Deliberately conservative (a minimum spend/click floor) so a
// single unlucky click doesn't get flagged as "wasted" — see the
// thresholds inline below.
const WASTED_SPEND_MIN_SPEND = 5;
const WASTED_SPEND_MIN_CLICKS = 3;
function buildWastedSpend(ppcByAsin, asin) {
  const byTerm = ppcByAsin.get((asin || '').toUpperCase());
  if (!byTerm) return [];
  const wasted = [];
  byTerm.forEach((entry, term) => {
    if (entry.purchases === 0 && entry.spend >= WASTED_SPEND_MIN_SPEND && entry.clicks >= WASTED_SPEND_MIN_CLICKS) {
      wasted.push({ term, spend: Math.round(entry.spend * 100) / 100, clicks: entry.clicks });
    }
  });
  return wasted.sort((a, b) => b.spend - a.spend);
}

// GAP #4 — SEE HEADER COMMENT. Calibrated against exactly 3 examples;
// treat as a first draft, not settled thresholds.
//   - Out of stock → OVERRIDES every other signal below. Doesn't matter
//     how well a product was converting or how much traffic it had —
//     if it's not sellable right now, PPC spend on it is wasted by
//     definition. Added 2026-08-07 per Jaclyn.
//   - No sessions/units at all → most urgent otherwise: can't tell if
//     this is a traffic problem or a listing problem until there's ANY
//     data.
//   - Meaningful traffic (>=500 sessions) but weak conversion (<10%) →
//     the product IS being found, but the listing isn't closing the
//     sale — fixing the listing multiplies whatever traffic already
//     exists, rather than paying for more traffic to the same leak.
//   - Strong conversion (>=15%) → the listing is doing its job; the
//     lever left to pull is more traffic (PPC), not the listing itself.
//   - Anything in between → no strong signal either way; flagged as
//     WATCH rather than forced into one of the other 4 buckets.
function computeStatusBadge(sessions, units, conversionPct, isOos) {
  if (isOos) {
    return { code: 'OOS', label: 'OUT OF STOCK — do not run PPC' };
  }
  const s = sessions || 0;
  const u = units || 0;
  if (s === 0 && u === 0) {
    return { code: 'IMMEDIATE', label: `IMMEDIATE — 0 sessions, 0 units` };
  }
  if (s >= 500 && (conversionPct === null || conversionPct < 10)) {
    return { code: 'LISTING_FIX', label: 'LISTING FIX BEFORE SCALING PPC' };
  }
  if (conversionPct !== null && conversionPct >= 15) {
    return { code: 'TRAFFIC', label: 'TRAFFIC — Conv is strong' };
  }
  return { code: 'WATCH', label: 'WATCH — no strong signal yet' };
}

function buildSkuSnapshots(kwRows, bizRowsFull, sqpRows, ppcByAsin, oosMaps, crossContext) {
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
    const asin = bizRow ? (findField(bizRow, BIZ_FIELD_CANDIDATES.asin) || '').toString().trim().toUpperCase() : '';

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

    const sessions = bizRow ? parseNumericCell(findField(bizRow, BIZ_FIELD_CANDIDATES.sessions)) : null;
    const units = bizRow ? parseNumericCell(findField(bizRow, BIZ_FIELD_CANDIDATES.units)) : null;
    const revenue = bizRow ? parseNumericCell(findField(bizRow, BIZ_FIELD_CANDIDATES.revenue)) : null;
    const conversionPct = bizRow ? parseConversionPct(findField(bizRow, BIZ_FIELD_CANDIDATES.conversion)) : null;

    // OOS lookup — try ASIN first (more reliable, per the same reasoning
    // used for wasted-spend scoping elsewhere in this file), fall back
    // to SKU if the inventory sheet doesn't have this ASIN for some
    // reason.
    const isOos = (asin && oosMaps.byAsin.has(asin)) ? oosMaps.byAsin.get(asin)
      : (oosMaps.bySku.has(sku) ? oosMaps.bySku.get(sku) : false);

    // Cross-analysis context — added 2026-08-07 per Jaclyn, see file
    // header comment. Read-only inputs from the OTHER two analyses;
    // Claude is instructed (see the prompt below) to factor these in
    // rather than treating this SKU in isolation.
    const priorPpc = crossContext.priorPpcBySku[sku];
    const priorRecommendedBullets = priorPpc && Array.isArray(priorPpc.recommended_bullets)
      ? priorPpc.recommended_bullets.map(b => b.text).filter(Boolean).join(' | ')
      : '';
    const implementation = crossContext.implementationBySku[sku] || null;
    const auditNotes = crossContext.auditNotesBySku[sku] || '';

    snapshots[sku] = {
      sku,
      asin,
      sessions,
      units,
      revenue,
      conversion_pct: conversionPct,
      top_keywords: topKeywords,
      wasted_spend_terms: asin ? buildWastedSpend(ppcByAsin, asin) : [],
      is_oos: isOos,
      status_badge: computeStatusBadge(sessions, units, conversionPct, isOos),
      prior_weekly_analysis_ppc_notes: priorRecommendedBullets,
      listing_implementation_status: implementation,
      listing_audit_notes: auditNotes,
    };
  });

  return snapshots;
}


// ── Claude prompt — writes prose only, against the snapshot above ───
//
// FIXED 2026-08-07: the original version sent EVERY SKU's snapshot to
// Claude in one API call, asking for a headline + 2-4 bullets + 3-7
// targets per SKU all at once. For a full catalog (~18 SKUs here) that's
// enough generation work that the Claude call itself took longer than
// Vercel's 30s function timeout and got killed mid-response (confirmed
// in the Vercel logs: the Anthropic call hit "Timeout" at 29.18s).
// Not a data problem — a single-call-does-everything design problem.
// Fixed by splitting into small batches run in PARALLEL: each batch only
// has to generate output for a few SKUs, so each individual call
// finishes fast, and the total wall-clock time is bounded by the
// slowest single batch rather than the sum of all of them. A failed or
// slow batch also only blanks bullets for ITS few SKUs, not the whole
// run.
const SKUS_PER_BATCH = 4;

// Bracket/string-tracking JSON repair — ported directly from
// run-analysis.js's own repairTruncatedJson(), added here 2026-08-07
// after a real batch response came back malformed (see the note above
// callClaudeForOneBatch's parse logic). Works regardless of WHERE a cut
// or broken escape happened, unlike a naive "just close the last brace"
// approach — not guaranteed to recover every SKU in a badly broken
// response, but recovers far more than failing the whole batch outright.
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
  if (inString) repaired += '"';
  while (stack.length) {
    const open = stack.pop();
    repaired += (open === '{') ? '}' : ']';
  }
  return repaired;
}

function chunkSnapshotsBySku(snapshots, batchSize) {
  const skus = Object.keys(snapshots);
  const batches = [];
  for (let i = 0; i < skus.length; i += batchSize) {
    const batch = {};
    skus.slice(i, i + batchSize).forEach(sku => { batch[sku] = snapshots[sku]; });
    batches.push(batch);
  }
  return batches;
}

async function callClaudeForBullets(brand, snapshots, apiKey) {
  const batches = chunkSnapshotsBySku(snapshots, SKUS_PER_BATCH);
  console.log(`[run-ppc-strategy-analysis] ${brand.id} — ${Object.keys(snapshots).length} SKUs split into ${batches.length} batch(es) of up to ${SKUS_PER_BATCH}, run in parallel.`);

  const batchResults = await Promise.all(
    batches.map(batch => callClaudeForOneBatch(brand, batch, apiKey))
  );

  const merged = {};
  batchResults.forEach(result => Object.assign(merged, result));
  return merged;
}

async function callClaudeForOneBatch(brand, snapshotBatch, apiKey) {
  const brandDesc = BRAND_DESCRIPTIONS[brand.id] || BRAND_DESCRIPTIONS.default;

  const systemPrompt = `You are an expert Amazon PPC strategist for Medaltus. Analyzing per-product PPC opportunity for ${brandDesc}.

CRITICAL: Respond with a single valid JSON object only. No markdown fences, no preamble, no trailing text after the closing brace.`;

  const userPrompt = `For each SKU below, write a PPC strategy recommendation in the same tone as these real examples:

"PPC on 'hair growth serum' + 'scalp serum' + 'scalp treatment' — Reverse converts at 22.95% but only sees 122 sessions. At current conversion, adding 300 incremental sessions = +68 units/month = +$3,399 revenue."
"Do not scale PPC on Promote until Bullet 1 is rewritten. Spending more money to send 1,125+ monthly visitors to a listing that converts at 3.2% is burning budget."
"Prevent had 15 sessions and 0 units in April. This product has no organic rank signal on any keyword. Zero revenue means zero organic velocity."

Return ONLY this JSON structure:
{"<SKU>":{"headline":"string","recommended_bullets":[{"priority":"HIGH|MED|LOW","text":"string"}],"suggested_exact_match_targets":["string"]}}

Rules:
- One entry per SKU from the snapshot below, keyed EXACTLY by SKU. Do not add or omit SKUs.
- IF a SKU's is_oos is true: do NOT recommend launching, scaling, or bidding on PPC for it under any circumstances — status_badge already says OUT OF STOCK. headline and every bullet should instead say plainly that this product is out of stock and PPC spend should stay paused until it's back in stock. suggested_exact_match_targets should be an empty list for an out-of-stock SKU — there is nothing to target while it can't be sold.
- IF a SKU's listing_audit_notes is non-empty: that is a REAL, currently-open compliance/quality finding from this week's separate listing audit. Treat it the same weight as is_oos and status_badge — if there's an unresolved listing issue, at least one HIGH priority bullet should say to fix that specific issue before or alongside scaling PPC, referencing what the note actually says (do not paraphrase it into something vaguer).
- IF a SKU's prior_weekly_analysis_ppc_notes is non-empty: that is what last week's separate brand analysis already concluded about this SKU's PPC strategy. Use it as a second opinion, not a script to copy — if this run's own numbers (sessions/conversion/is_oos/audit notes) tell a different story than that prior note, trust THIS run's real numbers and say so, rather than silently repeating a stale conclusion.
- IF a SKU's listing_implementation_status is present: it says whether a PREVIOUSLY recommended listing fix has actually gone live yet. If it shows the fix is still NOT implemented, do not write a bullet assuming the fix already happened.
- headline: one sentence, matches the tone/urgency of that SKU's status_badge (already computed — do not contradict it).
- recommended_bullets: 2-4 bullets, HIGH priority first, each one tactical sentence referencing REAL numbers from that SKU's own snapshot only (sessions, conversion_pct, revenue, or a keyword's vol_mo/aba_pct/cpc). Do not invent numbers. Do not compare one SKU against another SKU.
- suggested_exact_match_targets: 3-7 keyword strings pulled ONLY from that SKU's own top_keywords list — do not invent keywords. (Empty for an out-of-stock SKU — see above.)
- Do not mention wasted_spend_terms in prose — that's rendered separately by the dashboard from the same data you're seeing here, no need to restate it.
- No apostrophes in string values — use "does not" not "doesn't".
- NEVER use a double-quote character anywhere inside a string value, including around keyword phrases — your entire response must itself be valid JSON, and an un-escaped double quote inside a JSON string breaks the whole response. Use single quotes for any quoted phrase instead (e.g. write 'hair growth serum', never "hair growth serum").
- Keep all string values under 200 characters.

PER-SKU SNAPSHOT:
${JSON.stringify(snapshotBatch)}`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000, // reduced from 8000 now that each call only covers up to SKUS_PER_BATCH SKUs
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error(`[run-ppc-strategy-analysis] ${brand.id} — batch failed with Claude API error ${claudeRes.status}: ${err.slice(0, 300)}`);
      return {}; // this batch's SKUs get empty bullets; other batches are unaffected
    }

    const data = await claudeRes.json();
    if (data.stop_reason === 'max_tokens') {
      console.warn(`[run-ppc-strategy-analysis] ${brand.id} — a batch response was truncated by max_tokens`);
    }

    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '').trim();

    // FIXED 2026-08-07: a real run produced malformed JSON for at least
    // one batch (confirmed — 2 SKUs in the same batch showed "No
    // recommendations generated" on the dashboard despite the batch
    // clearly having run). The old code here caught the parse failure
    // silently (logged only e.message, never the actual text that
    // failed), so there was no way to diagnose what broke. Now: (1) logs
    // the raw text on any failure so this is diagnosable next time, and
    // (2) attempts the same bracket/string-tracking repair run-
    // analysis.js already uses for its own Claude calls, so a single
    // broken escape doesn't necessarily blank the whole batch.
    try {
      return JSON.parse(clean);
    } catch (parseErr) {
      console.error(`[run-ppc-strategy-analysis] ${brand.id} — batch response was not valid JSON: ${parseErr.message}`);
      console.error(`[run-ppc-strategy-analysis] ${brand.id} — raw batch response (full):`, clean);
      try {
        const repaired = JSON.parse(repairTruncatedJson(clean));
        console.warn(`[run-ppc-strategy-analysis] ${brand.id} — repair succeeded, recovered ${Object.keys(repaired).length} SKU(s) from this batch.`);
        return repaired;
      } catch (repairErr) {
        console.error(`[run-ppc-strategy-analysis] ${brand.id} — repair also failed: ${repairErr.message}. This batch's SKUs will show no recommendations.`);
        return {};
      }
    }
  } catch (e) {
    console.error(`[run-ppc-strategy-analysis] ${brand.id} — a batch failed (network error):`, e.message);
    return {}; // this batch's SKUs get empty bullets rather than failing the entire run
  }
}

// ── Write one row per SKU to the shared multi-brand tab ─────────────
async function writeSkuStrategyRows(brand, rows) {
  const today = new Date().toISOString().slice(0, 10);
  const uploadedAt = new Date().toISOString();

  const newRows = rows.map(r => [
    today,
    brand.id,
    r.sku,
    r.asin,
    r.status_badge.label,
    r.is_oos ? 'TRUE' : 'FALSE',
    r.sessions ?? '',
    r.units ?? '',
    r.revenue ?? '',
    r.conversion_pct ?? '',
    r.headline || '',
    JSON.stringify(r.recommended_bullets || []),
    JSON.stringify(r.suggested_exact_match_targets || []),
    JSON.stringify(r.wasted_spend_terms || []),
    uploadedAt,
  ]);

  // ATTEMPTED FIX 2026-08-07, REVERTED 2026-08-10 per Jaclyn: I
  // originally diagnosed this tab's stale 14-column header (written once
  // by ensureTab() before is_oos existed, never corrected since) as the
  // cause of headline/bullets/targets landing under the wrong column
  // labels. That diagnosis was correct. My fix was not: I assumed
  // replaceRows()'s separate `headers` argument doesn't touch row 1, so
  // I additionally prepended PPC_STRATEGY_HEADERS as the first element
  // of the `rows` array itself to force it. Confirmed wrong from a live
  // screenshot after deploying: it produced THREE different stacked
  // header-looking rows at the top of the sheet before any real data,
  // meaning replaceRows() DOES write its own header row from the
  // `headers` argument — and, more importantly, does NOT clear
  // pre-existing rows the way "replace" implies. Every run was adding
  // on top of what was already there, not overwriting it.
  //
  // I do not have visibility into config/_sheets_client.js to know
  // replaceRows()'s exact real behavior, and two guesses in a row have
  // both been wrong — a third guess isn't the right move here. The
  // certain, verifiable fix: manually delete ALL rows in the ppc_strategy
  // tab (including the header row) so it's genuinely blank, then run
  // this endpoint once. ensureTab() will then write a single correct
  // 15-column header from scratch (it only fires on a truly blank tab,
  // which is exactly the condition this needs), and every column will
  // line up with its label from that point on. This code below is
  // reverted to its pre-2026-08-07 form — no header-prepending — since
  // that's the version that never itself caused stacking; the header
  // mismatch it still won't fix is the OLD stale header, which a manual
  // clear resolves directly instead of more code trying to out-guess an
  // unknown API.
  const token = await ensureTab(sheets.insights, PPC_STRATEGY_TAB_NAME, PPC_STRATEGY_HEADERS);
  const existingRows = await readRows(sheets.insights, PPC_STRATEGY_TAB_NAME).catch(() => []);
  const preservedRows = existingRows
    .filter(r => !((r.brand || '') === brand.id && (r.date || '') === today))
    .map(r => PPC_STRATEGY_HEADERS.map(h => r[h] !== undefined ? r[h] : ''));

  await replaceRows(sheets.insights, PPC_STRATEGY_TAB_NAME, PPC_STRATEGY_HEADERS, [...preservedRows, ...newRows], token);
  console.log(`[run-ppc-strategy-analysis] ${brand.id} — wrote ${newRows.length} SKU rows for ${today} to "${PPC_STRATEGY_TAB_NAME}" (${preservedRows.length} rows from other dates/brands preserved as history)`);
}

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
    const inventorySheetId = resolveNewdermInventorySheetId();
    if (!inventorySheetId) {
      console.warn('[run-ppc-strategy-analysis] Could not resolve a config/sheets.js key for SHEET_NEWDERM_INVENTORY (tried:', NEWDERM_INVENTORY_SHEET_KEY_CANDIDATES.join(', '), ') — is_oos will be false for every SKU until this is fixed. See GAP #1b in the file header comment.');
    }

    const [kwRows, bizRows, sqpRows, ppcRows, inventoryRows, crossContext] = await Promise.all([
      readRows(KEYWORD_TRACKER_SHEET_ID, brand.tabName).catch(() => []),
      readRows(sheets.businessReport, brand.tabName).catch(() => []),
      readRows(sheets.searchQueryPerformance, brand.tabName).catch(() => []),
      readRows(sheets.advertising, brand.tabName).catch(() => []),
      inventorySheetId ? fetchNewdermInventoryRows(inventorySheetId, brand.tabName).catch(() => []) : Promise.resolve([]),
      buildCrossAnalysisContext(brand),
    ]);

    const { byAsin: ppcByAsin, sawAsinField } = aggregatePpcByAsinAndTerm(ppcRows);
    if (!sawAsinField) {
      console.warn(`[run-ppc-strategy-analysis] ${brand.id} — no asin/ASIN field found on the advertising sheet; wasted_spend_terms will be empty for every SKU. See GAP #3 in the file header comment.`);
    }

    const oosMaps = buildOosMaps(inventoryRows);
    const oosCount = [...oosMaps.byAsin.values(), ...oosMaps.bySku.values()].filter(Boolean).length;
    console.log(`[run-ppc-strategy-analysis] ${brand.id} — inventory check found ${oosCount} out-of-stock entr${oosCount === 1 ? 'y' : 'ies'} across ${oosMaps.byAsin.size} ASINs / ${oosMaps.bySku.size} SKUs checked.`);

    const snapshots = buildSkuSnapshots(kwRows, bizRows, sqpRows, ppcByAsin, oosMaps, crossContext);
    if (!Object.keys(snapshots).length) {
      return res.status(200).json({ ok: true, message: 'No SKUs found in Business Report or Keyword Tracker for this brand — nothing to write.' });
    }

    const claudeBySku = await callClaudeForBullets(brand, snapshots, apiKey);

    const rows = Object.keys(snapshots).map(sku => {
      const snap = snapshots[sku];
      const claude = claudeBySku[sku] || {};
      return {
        ...snap,
        headline: claude.headline || '',
        recommended_bullets: Array.isArray(claude.recommended_bullets) ? claude.recommended_bullets : [],
        suggested_exact_match_targets: Array.isArray(claude.suggested_exact_match_targets) ? claude.suggested_exact_match_targets : [],
      };
    });

    await writeSkuStrategyRows(brand, rows);

    return res.status(200).json({ ok: true, sku_count: rows.length, rows });
  } catch (err) {
    console.error(`[run-ppc-strategy-analysis] ${brandId} failed:`, err.message);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message });
  }
};
