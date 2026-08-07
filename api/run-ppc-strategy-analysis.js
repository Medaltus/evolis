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
 *      PARTIALLY RESOLVED — Jaclyn provided the real config/sheets.js
 *      (2026-08-07): confirmed the config key really is `newdermInventory`
 *      (one of the candidates guessed below happened to be right — kept
 *      the candidate list anyway as a defensive fallback rather than
 *      hardcoding a bare `sheets.newdermInventory` reference, in case
 *      that ever gets renamed).
 *
 *      STILL A REAL GAP, AND A BIGGER ONE THAN THE COLUMN NAMES: that
 *      same sheets.js comment describes this sheet as having "pre-built
 *      2-row merged headers (data starts row 3)". Every other sheet in
 *      this whole codebase assumes row 1 is a plain single-row header —
 *      if readRows() does the same here (no special-casing for this
 *      sheet), it will treat the FIRST of the two merged header rows as
 *      column names and the SECOND header row as if it were a real data
 *      row, and my FBA_QTY_CANDIDATES/WAREHOUSE_SF_QTY_CANDIDATES field
 *      names below will very likely not match anything real. I do not
 *      have visibility into readRows()'s implementation to know whether
 *      it already special-cases this sheet's row offset — if it
 *      doesn't, this needs a real fix (either readRows() gains a
 *      header-row-offset parameter, or this file fetches the raw range
 *      starting at row 3 itself). Added a diagnostic log
 *      (buildOosMaps() logs the actual first-row keys it receives every
 *      run) specifically so this is fast to confirm or rule out the
 *      first time this runs against real data, rather than silently
 *      reading is_oos=false for every SKU with no visible clue why.
 *
 *   2. replaceRows()'s EXACT SIGNATURE IS UNCONFIRMED. Every other file
 *      I've seen in this project uses ensureTab+appendRows (pure
 *      append, one row per run). This endpoint needs different
 *      behavior: since ALL BRANDS share one tab and this represents
 *      CURRENT state per product (not a historical log), re-running
 *      this for one brand should REPLACE that brand's existing rows,
 *      not pile up duplicates forever. I'm assuming replaceRows(sheetId,
 *      tabName, headers, rowsAsArrays) mirrors appendRows's shape —
 *      confirm against config/_sheets_client.js and adjust
 *      writeSkuStrategyRows() below if the real signature differs.
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
 * ═══════════════════════════════════════════════════════════════════
 */

const { readRows, ensureTab, appendRows, replaceRows } = require('./config/_sheets_client');
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

// Évolis tab, gid=2074324776, per Jaclyn 2026-08-07.
// CONFIRMED 2026-08-07 against the real config/sheets.js: the key is
// `newdermInventory` (kept as first candidate in the list below, with
// the other two kept only as a defensive fallback in case it's ever
// renamed — not because the real name is still in doubt).
// STILL UNCONFIRMED: the column names below, AND — more importantly —
// whether readRows() correctly skips this sheet's documented "2-row
// merged header, data starts row 3" structure. See GAP #1b in the file
// header comment; buildOosMaps() below logs real header keys + sample
// rows every run specifically so this is fast to check.
const NEWDERM_INVENTORY_SHEET_KEY_CANDIDATES = ['newdermInventory', 'newdermInventoryReconciliation', 'newderm_inventory'];
const FBA_QTY_CANDIDATES = ['amazon_fba', 'Amazon FBA', 'fba_available', 'fba_quantity', 'FBA'];
const WAREHOUSE_SF_QTY_CANDIDATES = ['medaltus_warehouse_sf', 'Medaltus Warehouse - SF', 'warehouse_sf', 'sf_quantity'];
const OOS_ASIN_CANDIDATES = ['ASIN', 'asin', 'Asin'];
const OOS_SKU_CANDIDATES = ['SKU', 'sku', 'Sku'];

function resolveNewdermInventorySheetId() {
  for (const key of NEWDERM_INVENTORY_SHEET_KEY_CANDIDATES) {
    if (sheets[key]) return sheets[key];
  }
  return null;
}

// Returns { bySku: Map, byAsin: Map } of booleans — true means this
// product is out of stock (Amazon FBA + Medaltus Warehouse SF both at
// or below zero). Never throws: if the sheet or the expected columns
// aren't found, logs a clear warning and returns empty maps, so every
// SKU just falls back to is_oos=false (behaves exactly as before this
// feature existed) rather than crashing the whole run.
function buildOosMaps(inventoryRows) {
  const bySku = new Map();
  const byAsin = new Map();
  if (!inventoryRows.length) {
    console.warn('[run-ppc-strategy-analysis] SHEET_NEWDERM_INVENTORY returned no rows — is_oos will be false for every SKU.');
    return { bySku, byAsin };
  }

  // Diagnostic — see GAP #1b in the file header comment. This sheet has
  // "pre-built 2-row merged headers, data starts row 3" per Jaclyn's own
  // config/sheets.js comment; if readRows() doesn't already account for
  // that offset, row[0] here will actually be the SECOND header row
  // (not real data), and none of the candidate field names below will
  // match anything. Logging the real keys + first 2 rows every run so
  // this is a 5-second check instead of a silent guess.
  console.log('[run-ppc-strategy-analysis][qa] SHEET_NEWDERM_INVENTORY — row[0] keys:', Object.keys(inventoryRows[0]).join(' | '));
  console.log('[run-ppc-strategy-analysis][qa] SHEET_NEWDERM_INVENTORY — row[0] sample:', JSON.stringify(inventoryRows[0]));
  if (inventoryRows[1]) console.log('[run-ppc-strategy-analysis][qa] SHEET_NEWDERM_INVENTORY — row[1] sample:', JSON.stringify(inventoryRows[1]));

  const sample = inventoryRows[0];
  const hasFba = FBA_QTY_CANDIDATES.some(c => sample[c] !== undefined);
  const hasSf = WAREHOUSE_SF_QTY_CANDIDATES.some(c => sample[c] !== undefined);
  if (!hasFba && !hasSf) {
    console.warn('[run-ppc-strategy-analysis] Could not find an Amazon FBA or Medaltus Warehouse SF column on SHEET_NEWDERM_INVENTORY (tried:', FBA_QTY_CANDIDATES.join(', '), '/', WAREHOUSE_SF_QTY_CANDIDATES.join(', '), ') — is_oos will be false for every SKU. Check the [qa] log lines just above: if the first rows keys look like a second header row rather than real column names/data, this is the merged-header row-offset problem described in GAP #1b, not a wrong-field-name problem.');
    return { bySku, byAsin };
  }
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

function buildSkuSnapshots(kwRows, bizRowsFull, sqpRows, ppcByAsin, oosMaps) {
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
- headline: one sentence, matches the tone/urgency of that SKU's status_badge (already computed — do not contradict it).
- recommended_bullets: 2-4 bullets, HIGH priority first, each one tactical sentence referencing REAL numbers from that SKU's own snapshot only (sessions, conversion_pct, revenue, or a keyword's vol_mo/aba_pct/cpc). Do not invent numbers. Do not compare one SKU against another SKU.
- suggested_exact_match_targets: 3-7 keyword strings pulled ONLY from that SKU's own top_keywords list — do not invent keywords. (Empty for an out-of-stock SKU — see above.)
- Do not mention wasted_spend_terms in prose — that's rendered separately by the dashboard from the same data you're seeing here, no need to restate it.
- No apostrophes in string values — use "does not" not "doesn't".
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

    return JSON.parse(clean);
  } catch (e) {
    console.error(`[run-ppc-strategy-analysis] ${brand.id} — a batch failed (network error or invalid JSON):`, e.message);
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

  // GAP #2 — SEE HEADER COMMENT. This tab holds CURRENT state per
  // product, shared across every brand — re-running for one brand
  // should replace that brand's rows, not pile up duplicates on every
  // run. Reads existing rows, strips out ONLY this brand's old rows,
  // and writes back everyone else's rows plus this brand's fresh ones.
  const token = await ensureTab(sheets.insights, PPC_STRATEGY_TAB_NAME, PPC_STRATEGY_HEADERS);
  const existingRows = await readRows(sheets.insights, PPC_STRATEGY_TAB_NAME).catch(() => []);
  const otherBrandsRows = existingRows
    .filter(r => (r.brand || '') !== brand.id)
    .map(r => PPC_STRATEGY_HEADERS.map(h => r[h] !== undefined ? r[h] : ''));

  await replaceRows(sheets.insights, PPC_STRATEGY_TAB_NAME, PPC_STRATEGY_HEADERS, [...otherBrandsRows, ...newRows], token);
  console.log(`[run-ppc-strategy-analysis] ${brand.id} — wrote ${newRows.length} SKU rows to "${PPC_STRATEGY_TAB_NAME}" (${otherBrandsRows.length} other-brand rows preserved)`);
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

    const [kwRows, bizRows, sqpRows, ppcRows, inventoryRows] = await Promise.all([
      readRows(KEYWORD_TRACKER_SHEET_ID, brand.tabName).catch(() => []),
      readRows(sheets.businessReport, brand.tabName).catch(() => []),
      readRows(sheets.searchQueryPerformance, brand.tabName).catch(() => []),
      readRows(sheets.advertising, brand.tabName).catch(() => []),
      inventorySheetId ? readRows(inventorySheetId, brand.tabName).catch(() => []) : Promise.resolve([]),
    ]);

    const { byAsin: ppcByAsin, sawAsinField } = aggregatePpcByAsinAndTerm(ppcRows);
    if (!sawAsinField) {
      console.warn(`[run-ppc-strategy-analysis] ${brand.id} — no asin/ASIN field found on the advertising sheet; wasted_spend_terms will be empty for every SKU. See GAP #3 in the file header comment.`);
    }

    const oosMaps = buildOosMaps(inventoryRows);
    const oosCount = [...oosMaps.byAsin.values(), ...oosMaps.bySku.values()].filter(Boolean).length;
    console.log(`[run-ppc-strategy-analysis] ${brand.id} — inventory check found ${oosCount} out-of-stock entr${oosCount === 1 ? 'y' : 'ies'} across ${oosMaps.byAsin.size} ASINs / ${oosMaps.bySku.size} SKUs checked.`);

    const snapshots = buildSkuSnapshots(kwRows, bizRows, sqpRows, ppcByAsin, oosMaps);
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
