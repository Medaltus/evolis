/**
 * api/run-analysis.js
 * GET/POST /api/run-analysis           — runs for every active brand
 * GET/POST /api/run-analysis?brand=evolis — runs for one brand only
 *
 * REWRITTEN 2026-07-16 per Jaclyn: this used to be a proxy that received
 * pre-parsed summaries from manually-uploaded reports on the dashboard.
 * Now that keyword tracker, business report, SQP, and PPC data all sync
 * automatically, this reads directly from those sheets instead — no more
 * uploads, no more client-side parsing. It also now writes the resulting
 * insights directly to sheets.insights, rather than just returning JSON
 * for a separate write-insights.js call to handle.
 *
 * ASSUMPTIONS THAT NEED VERIFICATION (I don't have config/sheets.js's
 * final current state, config/brands.js, or any of these 5 sheets' actual
 * tab layouts in front of me):
 *
 * 1. Sheet mapping — matched against sheet IDs already confirmed elsewhere
 *    in this project:
 *      Keyword Tracker  → sheets.keywordTracker (NEW — needs to be added
 *                          to config/sheets.js, pointed at
 *                          1geNDQgd_1ensLDyZOuXZBnvQrFT_RC85l9rHHGpgJe4)
 *      Business Report  → sheets.businessReport (assumed same sheet
 *                          sync-business-report-process.js already writes)
 *      SQP              → sheets.searchQueryPerformance (CONFIRMED —
 *                          exact sheet ID match to the cron built earlier
 *                          this session)
 *      PPC (ads)         → sheets.advertising (assumed)
 *      PPC Orders        → sheets.adOrders (CONFIRMED — exact sheet ID
 *                          match to SHEET_AD_ORDERS per this project's
 *                          established sheet catalog)
 *      Insights output   → sheets.insights (assumed same sheet
 *                          write-insights.js already targets)
 *
 * 2. Per-brand tab name within each sheet — assumed to be brand.tabName,
 *    matching the convention already established in
 *    sync-business-report-process.js and this session's SQP cron. If any
 *    of these 5 sheets are NOT structured one-tab-per-brand (e.g. a single
 *    tab with a BRAND column instead), the read functions below will need
 *    adjusting.
 *
 * 3. "Current listing" text — the OLD listingCtx parameter was previously
 *    uploaded/pasted directly; no sheet was specified for this in the new
 *    setup. Defaulting to sheets.listingAudit's most-recent-per-SKU
 *    columns (title/highlights/bullets/description), same source the
 *    Listing Audit pipeline already maintains — VERIFY this is actually
 *    the intended source, since it wasn't explicitly named.
 *
 * 4. "Last 4 weeks" history — previously uploaded directly. Now derived
 *    by reading this SAME brand's own last 4 rows already written to
 *    sheets.insights, i.e. each week's output becomes next week's input
 *    history. This is an inference, not something explicitly specified —
 *    flag if a different history source was intended.
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const requestedBrandId = req.query.brand;
  const activeBrands = brands.filter(b => b.active && (!requestedBrandId || b.id === requestedBrandId));
  if (requestedBrandId && !activeBrands.length) {
    return res.status(400).json({ error: `Brand '${requestedBrandId}' not found or not active` });
  }

  const results = [];
  for (const brand of activeBrands) {
    try {
      const insights = await runAnalysisForBrand(brand, apiKey);
      await writeInsightsToSheet(brand, insights);
      results.push({ brand: brand.id, status: 'ok' });
    } catch (err) {
      console.error(`[run-analysis] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', reason: err.message });
    }
  }

  res.status(200).json({ ok: true, results });
};

// ── Per-brand analysis ──────────────────────────────────────────────────────

async function runAnalysisForBrand(brand, apiKey) {
  const brandDesc = BRAND_DESCRIPTIONS[brand.id] || BRAND_DESCRIPTIONS.default;

  const [kwRows, bizRows, sqpRows, ppcRows, listingRows, historyRows] = await Promise.all([
    readRows(sheets.keywordTracker, brand.tabName).catch(() => []),
    readRows(sheets.businessReport, brand.tabName).catch(() => []),
    readRows(sheets.searchQueryPerformance, brand.tabName).catch(() => []),
    readRows(sheets.advertising, brand.tabName).catch(() => []),
    readRows(sheets.listingAudit, brand.tabName).catch(() => []),
    readRows(sheets.insights, brand.tabName).catch(() => []),
  ]);

  const kwTrimmed  = kwRows.slice(-20);
  const bizTrimmed = bizRows.slice(-15);
  const ppcTrimmed = ppcRows.slice(-15);
  const sqpTrimmed = sqpRows.slice(-15);

  // Most recent audit per SKU — same "most recent per SKU by audited_at"
  // logic already used elsewhere in this project's listing audit pipeline.
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
${JSON.stringify(ppcTrimmed)}${sqpSection}

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
    throw new Error(`Claude API error ${claudeRes.status}: ${err.slice(0, 300)}`);
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
    throw new Error(`Could not parse Claude response as JSON: ${parseErr.message}`);
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
