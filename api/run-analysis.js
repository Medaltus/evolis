/**
 * api/run-analysis.js
 * POST /api/run-analysis
 * Body: { brand: "evolis" }
 *
 * Manually triggered from the "Run Analysis" button on a single brand's
 * dashboard page — intentionally NOT a cron job. Jaclyn wants this to stay
 * manual so how often the team reviews each brand is trackable.
 *
 * REWRITTEN 2026-07-16: this used to be a proxy that received pre-parsed
 * summaries from manually-uploaded reports on the dashboard. Now that
 * keyword tracker, business report, SQP, and PPC data all sync
 * automatically, this reads directly from those sheets instead — no more
 * uploads, no more client-side parsing. It also writes the resulting
 * insights directly to sheets.insights, rather than just returning JSON
 * for a separate write-insights.js call to handle.
 *
 * FIX 2026-07-17: a prior deploy of this file had the loop-every-brand +
 * CRON_SECRET-gated shape from an earlier draft. That shape was correct
 * for a scheduled cron, but this endpoint is called directly from the
 * browser with no Authorization header, so every click 401'd. Reverted
 * to single-brand, no auth check.
 *
 * ASSUMPTIONS / CONFIRMED MAPPINGS (updated 2026-07-17 after checking
 * Vercel env vars directly and reading both sheets' actual tab structure):
 *
 * 1. Sheet mapping:
 *      Business Report  → sheets.businessReport (assumed — no env var
 *                          screenshot confirmed this one yet)
 *      SQP              → sheets.searchQueryPerformance (CONFIRMED —
 *                          SHEET_SEARCH_QUERY_PERFORMANCE exists)
 *      PPC (search terms) → sheets.advertising (CONFIRMED — SHEET_ADVERTISING
 *                          exists; tab structure confirmed: search_term,
 *                          keyword, match_type, ad_type, campaign_name,
 *                          ad_group_name, date, year, month, impressions,
 *                          clicks, ctr, cost, cpc, cpm, purchases, sales,
 *                          acos, conversion_rate, current_bid, last_updated)
 *      PPC Orders       → sheets.adOrders (CONFIRMED — SHEET_AD_ORDERS
 *                          exists; tab structure confirmed: year, month,
 *                          asin, ad_units, spend, sales, acos, brand,
 *                          last_updated). Per Jaclyn, this is "just a
 *                          different view of ads performance" so it's
 *                          folded into the SAME PPC prompt section below,
 *                          not a separate section.
 *      Keyword Tracker  → sheets.keywordTracker — STILL UNCONFIRMED. No
 *                          env var matching this name has turned up across
 *                          any of the Vercel env var screenshots so far.
 *                          SHEET_BRAND_ANALYTICS (added same day as
 *                          SHEET_SEARCH_QUERY_PERFORMANCE) is the closest
 *                          candidate but unverified. If sheets.keywordTracker
 *                          resolves to undefined, this read silently
 *                          returns [] with no error — worth confirming
 *                          against config/sheets.js directly.
 *      Insights output  → sheets.insights (assumed)
 *
 *    Explicitly OUT of scope per Jaclyn (2026-07-17):
 *      - The "Prime Day" tab in the ad orders sheet (cross-brand, brand-as-
 *        column, impressions/clicks/purchases) is for something else —
 *        not read here.
 *      - The blank sku-keyed tab in the ad orders sheet is a placeholder —
 *        not read here.
 *
 * 2. Per-brand tab name within each sheet — assumed brand.tabName, matching
 *    sync-business-report-process.js and the SQP cron. CONFIRMED for the
 *    ad orders sheet (evolis, skinuva, dearcloud, creme-shop, cloud-cafe,
 *    miguard, pbj, just-bjorn, amala, hillside, eraclea all exist as
 *    separate tabs there) and for the advertising/search-terms sheet.
 *    Still assumed for businessReport/keywordTracker/insights.
 *
 * 3. "Current listing" text — defaulting to sheets.listingAudit's
 *    most-recent-per-SKU columns. Not explicitly specified — verify.
 *
 * 4. "Last 4 weeks" history — derived from this brand's own last 4 rows
 *    in sheets.insights (each week's output becomes next week's input).
 *    An inference, not something explicitly specified — flag if a
 *    different history source was intended.
 */

const { readRows, ensureTab, appendRows } = require('./config/_sheets_client');
const sheets = require('./config/sheets');
const brands = require('./config/brands');

const BRAND_DESCRIPTIONS = {
  evolis:  'évolis (EVO) — a clinically tested hair growth brand using FGF5-inhibiting botanicals',
  skinuva: 'Skinuva (SVA) — a scar, bruise, and skin recovery brand',
  default: 'a Medaltus brand'
};

const INSIGHTS_HEADERS = ['DATE', 'BRAND', 'ORGANIC_JSON', 'PPC_JSON', 'LISTING_JSON', 'LOG_SUMMARY'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Accept brand from body (primary, matches dashboard button) or query
  // (in case anything calls this via curl/query string).
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

// ── Per-brand analysis ──────────────────────────────────────────────────────

async function runAnalysisForBrand(brand, apiKey) {
  const brandDesc = BRAND_DESCRIPTIONS[brand.id] || BRAND_DESCRIPTIONS.default;

  const [kwRows, bizRows, sqpRows, ppcRows, adOrdersRows, listingRows, historyRows] = await Promise.all([
    readRows(sheets.keywordTracker, brand.tabName).catch(() => []),
    readRows(sheets.businessReport, brand.tabName).catch(() => []),
    readRows(sheets.searchQueryPerformance, brand.tabName).catch(() => []),
    readRows(sheets.advertising, brand.tabName).catch(() => []),
    readRows(sheets.adOrders, brand.tabName).catch(() => []),
    readRows(sheets.listingAudit, brand.tabName).catch(() => []),
    readRows(sheets.insights, brand.tabName).catch(() => []),
  ]);

  const kwTrimmed       = kwRows.slice(-20);
  const bizTrimmed      = bizRows.slice(-15);
  const ppcTrimmed      = ppcRows.slice(-15);
  const sqpTrimmed      = sqpRows.slice(-15);
  const adOrdersTrimmed = adOrdersRows.slice(-30); // ASIN-level monthly rollup — fewer, denser rows than search-terms data

  // Most recent audit per SKU — same "most recent per SKU by audited_at"
  // logic already used in the listing audit pipeline.
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

  const systemPrompt = `You are an expert Amazon brand strategist and listing compliance auditor for Medaltus. Analyzing weekly performance data for ${brandDesc}.

CRITICAL: Respond with a single valid JSON object only. No markdown fences, no preamble, no trailing text after the closing brace. All string values must use escaped quotes if they contain apostrophes or special characters.`;

  const sqpSection = sqpTrimmed.length
    ? '\n\nSQP Brand Search Query Performance (recent rows):\n' + JSON.stringify(sqpTrimmed)
    : '';

  const adOrdersSection = adOrdersTrimmed.length
    ? '\n\nAD ORDERS — ASIN-level monthly ad-attributed rollup (same ads, different view — units/spend/sales/ACOS by ASIN by month):\n' + JSON.stringify(adOrdersTrimmed)
    : '';

  const userPrompt = `Analyze this week vs history. Return ONLY this JSON structure, nothing else:

{"date":"YYYY-MM-DD","organic":{"summary":"string","wins":["string"],"actions":["string"],"keywords_to_watch":["string"]},"ppc":{"summary":"string","wins":["string"],"actions":["string"],"opportunities":["string"]},"listing":{"summary":"string","violations":["string"],"keyword_gaps":["string"],"rewrites_recommended":["string"]},"log_summary":"string"}

Rules for the response:
- date: today's date in YYYY-MM-DD format
- organic.wins: 3-4 items. organic.actions: 4-6 items. organic.keywords_to_watch: 4-6 items
- ppc.wins: 3-4 items. ppc.actions: 4-6 items. ppc.opportunities: 4-6 items
- listing.violations: 1-2 items. listing.keyword_gaps: 1-2 items. listing.rewrites_recommended: 1-2 items
- log_summary: 3-4 sentences maximum
- No apostrophes in string values — use "does not" not "doesn't", etc.
- Keep all string values under 200 characters

KEYWORD TRACKER (organic ranks):
${JSON.stringify(kwTrimmed)}

BUSINESS REPORT (sessions/units/revenue):
${JSON.stringify(bizTrimmed)}

PPC (search terms / ad performance):
${JSON.stringify(ppcTrimmed)}${sqpSection}${adOrdersSection}

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
