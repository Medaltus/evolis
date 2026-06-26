/**
 * api/run-analysis.js
 * POST /api/run-analysis
 *
 * Acts as a server-side proxy for the Claude API call.
 * Receives parsed report summaries + context from the dashboard,
 * calls api.anthropic.com server-side (no CORS issues, API key stays secret),
 * returns structured insights JSON.
 *
 * Body: {
 *   brand,           // 'evolis' | 'skinuva' | etc.
 *   summaries,       // { kw[], biz[], ppc[], sqp[] }
 *   historicalCtx,   // formatted string from formatHistoryForClaude()
 *   listingCtx,      // current listing copy text
 *   skillB64         // base64-encoded listing audit skill (client sends it)
 * }
 *
 * Returns: { ok: true, insights: { date, organic, ppc, listing, log_summary } }
 */

const BRAND_DESCRIPTIONS = {
  evolis:  'évolis (EVO) — a clinically tested hair growth brand using FGF5-inhibiting botanicals',
  skinuva: 'Skinuva (SVA) — a scar, bruise, and skin recovery brand',
  default: 'a Medaltus brand'
};

export default async function handler(req, res) {
  // CORS headers — allow requests from Vercel preview + production URLs
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, summaries, historicalCtx, listingCtx, skillB64 } = req.body || {};

  if (!summaries) return res.status(400).json({ error: 'Missing summaries' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const brandDesc = BRAND_DESCRIPTIONS[brand] || BRAND_DESCRIPTIONS.default;

  // Decode listing audit skill from base64 (sent by client to keep HTML self-contained)
  let skill = '';
  if (skillB64) {
    try { skill = Buffer.from(skillB64, 'base64').toString('utf-8'); } catch(e) {}
  }

  const systemPrompt = `You are an expert Amazon brand strategist and listing compliance auditor for Medaltus. Analyzing weekly performance data for ${brandDesc}.

${skill ? 'Listing compliance rules to apply:\n' + skill + '\n' : ''}
Respond with valid JSON only. No markdown fences, no preamble.`;

  const sqpSection = summaries.sqp && summaries.sqp.length
    ? '\n\nSQP — Brand Search Query Performance (top queries with brand presence):\n' + JSON.stringify(summaries.sqp)
    : '';

  const userPrompt = `Analyze this week's data vs historical context. Return a JSON object with exactly these keys:

{
  "date": "YYYY-MM-DD",
  "organic": {
    "summary": "2-3 sentence summary of organic keyword performance",
    "wins": ["up to 3 ranking wins or positive signals"],
    "actions": ["up to 3 specific actions to improve organic rank"],
    "keywords_to_watch": ["up to 5 keywords with notable movement"]
  },
  "ppc": {
    "summary": "2-3 sentence summary of PPC performance",
    "wins": ["up to 3 campaign wins"],
    "actions": ["up to 3 specific campaign optimizations"],
    "opportunities": ["up to 3 new keyword or targeting opportunities"]
  },
  "listing": {
    "summary": "2-3 sentence compliance and keyword coverage summary",
    "violations": ["any compliance violations found"],
    "keyword_gaps": ["T1/T2 keywords missing from current copy"],
    "rewrites_recommended": ["specific elements to rewrite with priority"]
  },
  "log_summary": "One paragraph (4-6 sentences) summarizing all three areas for the internal Medaltus team."
}

CURRENT WEEK:

Keyword Tracker (organic ranks + ABA data):
${JSON.stringify(summaries.kw || [])}

Business Report (per SKU — sessions, units, revenue, conversion):
${JSON.stringify(summaries.biz || [])}

H10 Ads Report (search terms — spend, sales, ACoS):
${JSON.stringify(summaries.ppc || [])}${sqpSection}

HISTORICAL CONTEXT (last 4 weeks):
${historicalCtx || 'No prior data — this is the first upload.'}

CURRENT LISTING COPY:
${listingCtx || 'Not available.'}`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(502).json({ error: 'Claude API error', detail: err.slice(0, 200) });
    }

    const data = await claudeRes.json();
    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const clean = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    const insights = JSON.parse(clean);

    return res.status(200).json({ ok: true, insights });

  } catch (err) {
    console.error('run-analysis error:', err);
    return res.status(500).json({ error: err.message });
  }
}
