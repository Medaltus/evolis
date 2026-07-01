/**
 * api/run-analysis.js
 * POST /api/run-analysis
 *
 * Server-side proxy for Claude API — avoids CORS and keeps API key secret.
 * Receives parsed report summaries from the dashboard, calls Claude, returns insights JSON.
 *
 * Body: { brand, summaries, historicalCtx, listingCtx, skillB64 }
 * Returns: { ok: true, insights: { date, organic, ppc, listing, log_summary } }
 */

const BRAND_DESCRIPTIONS = {
  evolis:  'évolis (EVO) — a clinically tested hair growth brand using FGF5-inhibiting botanicals',
  skinuva: 'Skinuva (SVA) — a scar, bruise, and skin recovery brand',
  default: 'a Medaltus brand'
};

module.exports = async function handler(req, res) {
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

  let skill = '';
  if (skillB64) {
    try { skill = Buffer.from(skillB64, 'base64').toString('utf-8').slice(0, 4000); } catch(e) {}
  }

  // Keep listing context tight to avoid response truncation
  const listingCtxTrimmed = (listingCtx || '').slice(0, 3000);

  const systemPrompt = `You are an expert Amazon brand strategist and listing compliance auditor for Medaltus. Analyzing weekly performance data for ${brandDesc}.

${skill ? 'Key listing compliance rules:\n' + skill + '\n' : ''}
CRITICAL: Respond with a single valid JSON object only. No markdown fences, no preamble, no trailing text after the closing brace. All string values must use escaped quotes if they contain apostrophes or special characters.`;

  const sqpSection = summaries.sqp && summaries.sqp.length
    ? '\n\nSQP Brand Search Query Performance (top queries):\n' + JSON.stringify(summaries.sqp.slice(0, 15))
    : '';

  // Trim summaries to keep prompt size manageable
  const kwTrimmed  = (summaries.kw  || []).slice(0, 20);
  const bizTrimmed = (summaries.biz || []).slice(0, 15);
  const ppcTrimmed = (summaries.ppc || []).slice(0, 15);

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

H10 ADS (search terms):
${JSON.stringify(ppcTrimmed)}${sqpSection}

HISTORY (last 4 weeks):
${(historicalCtx || 'First upload — no prior data.').slice(0, 2000)}

CURRENT LISTING:
${listingCtxTrimmed}`;

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
        max_tokens: 5000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(502).json({ error: 'Claude API error ' + claudeRes.status, detail: err.slice(0, 300) });
    }

    const data = await claudeRes.json();

    // Check for Claude-level errors (e.g. max_tokens exceeded)
    if (data.stop_reason === 'max_tokens') {
      console.warn('run-analysis: response truncated by max_tokens');
    }

    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Strip markdown fences if present
    let clean = raw
      .replace(/^```json\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    // If response is truncated mid-JSON, attempt to close it gracefully
    if (!clean.endsWith('}')) {
      console.warn('run-analysis: response may be truncated, attempting repair');
      // Find the last complete top-level key and close the object
      const lastBrace = clean.lastIndexOf('"log_summary"');
      if (lastBrace > 0) {
        // Truncate to before log_summary and add a safe fallback
        clean = clean.slice(0, lastBrace) + '"log_summary":"Analysis complete — see organic, PPC and listing sections above."}';
      } else {
        // Can't repair — find last valid } and close
        const lastClose = clean.lastIndexOf('}');
        if (lastClose > 0) clean = clean.slice(0, lastClose + 1);
      }
    }

    let insights;
    try {
      insights = JSON.parse(clean);
    } catch (parseErr) {
      // Last resort: log raw for debugging and return a structured error
      console.error('run-analysis JSON parse failed. Raw response length:', raw.length);
      console.error('Parse error:', parseErr.message);
      console.error('Clean (first 500):', clean.slice(0, 500));
      return res.status(500).json({
        error: 'Could not parse Claude response as JSON: ' + parseErr.message,
        rawLength: raw.length,
        hint: 'Check Vercel logs for the full response'
      });
    }

    // Always override date with actual server date — Claude often hallucinates dates
    insights.date = new Date().toISOString().slice(0, 10);

    return res.status(200).json({ ok: true, insights });

  } catch (err) {
    console.error('run-analysis error:', err);
    return res.status(500).json({ error: err.message });
  }
}
