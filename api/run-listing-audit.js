/**
 * api/run-listing-audit.js
 * POST /api/run-listing-audit
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, catalog, skillB64 } = req.body || {};
  if (!catalog || !catalog.length) return res.status(400).json({ error: 'Missing catalog' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  let skill = '';
  if (skillB64) {
    try { skill = Buffer.from(skillB64, 'base64').toString('utf-8').slice(0, 4000); } catch(e) {}
  }

  const isTravel = catalog.every(s => s.travel);

  // Sanitize copy text — remove HTML entities, smart quotes, em dashes
  function sanitize(s) {
    if (!s) return '';
    return String(s)
      .replace(/&amp;/g, 'and')
      .replace(/&nbsp;/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")   // smart single quotes -> straight
      .replace(/[\u201C\u201D]/g, '"')   // smart double quotes -> straight
      .replace(/[\u2013\u2014]/g, '-')   // en/em dashes -> hyphen
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
  }

  const systemPrompt = `You are an Amazon listing compliance auditor for Medaltus / evolis hair care brand.

${skill ? 'Compliance rules:\n' + skill + '\n\n' : ''}Rules:
- Title: max 75 chars (hard limit July 27 2026)
- Item Highlights: max 125 chars (new required field - generate if missing)
- No prohibited words: brightening, heals, anti-inflammatory, eliminates, cures, guaranteed, best, #1
- FGF5: explain in plain English before using the term
- No apostrophes in your JSON string values - use "does not" not "don't"
- No em dashes or smart quotes in your JSON output
- Keep all string values under 250 characters

CRITICAL OUTPUT RULES:
1. Output ONLY a valid JSON array. Nothing before or after the array.
2. No markdown code fences.
3. Every string value must use only plain ASCII characters.
4. No newlines inside string values - use spaces instead.
5. Maximum 2 items in wins/actions arrays.`;

  const catalogText = catalog.map(s => {
    const title = sanitize(s.title);
    const ih    = sanitize(s.item_highlights);
    const back  = sanitize(s.backend);

    if (s.travel) {
      return `SKU:${s.sku}|${s.name}[TRAVEL]|Title:${title}|IH:${ih||'MISSING'}|Backend:${back}`;
    }
    const bullets = (s.bullets || []).map((b,i) => `B${i+1}:${sanitize(b)}`).join('|');
    const desc = sanitize(s.description);
    return `SKU:${s.sku}|${s.name}|Title:${title}|IH:${ih||'MISSING-GENERATE'}|${bullets}|Desc:${desc}|Backend:${back}`;
  }).join('\n\n');

  const schemaExample = isTravel
    ? `[{"sku":"EVO0014","title":{"notes":"note","rewrite":"rewrite under 75 chars"},"item_highlights":{"notes":"note","rewrite":"IH under 125 chars"},"bullets":null,"description":null,"backend":{"notes":"note","rewrite":""}}]`
    : `[{"sku":"EVO0001","title":{"notes":"note","rewrite":"rewrite under 75 chars"},"item_highlights":{"notes":"note","rewrite":"IH under 125 chars"},"bullets":{"notes":"issues summary","rewrite":"B1 rewrite only"},"description":{"notes":"brief note","rewrite":""},"backend":{"notes":"note","rewrite":"cleaned keywords"}}]`;

  const userPrompt = `Audit these evolis SKUs. Return a JSON array matching this exact schema:
${schemaExample}

Rules for your response:
- Use only plain ASCII in all strings
- No apostrophes - write "does not" not "don't", "it is" not "it's"
- No em dashes - use hyphens
- Keep every string value under 250 characters
- For missing Item Highlights: generate a compliant one under 125 chars
- For travel SKUs: audit title + generate IH only, set bullets/description to null

CATALOG:
${catalogText}`;

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
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(502).json({ error: 'Claude API error ' + claudeRes.status, detail: err.slice(0, 200) });
    }

    const data = await claudeRes.json();

    if (data.stop_reason === 'max_tokens') {
      console.warn('run-listing-audit: truncated by max_tokens');
    }

    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Strip markdown fences
    let clean = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    // Must start with [ and end with ]
    const arrStart = clean.indexOf('[');
    const arrEnd   = clean.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      clean = clean.slice(arrStart, arrEnd + 1);
    }

    // Replace any remaining smart quotes and em dashes that Claude snuck in
    clean = clean
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-');

    let results;
    try {
      results = JSON.parse(clean);
    } catch(parseErr) {
      console.error('parse error:', parseErr.message, '| raw length:', raw.length);
      console.error('clean first 500:', clean.slice(0, 500));
      console.error('clean last 500:', clean.slice(-500));
      return res.status(500).json({
        error: 'Could not parse audit response: ' + parseErr.message,
        rawLength: raw.length,
        hint: 'Check Vercel logs for full response'
      });
    }

    return res.status(200).json({ ok: true, results, skuCount: results.length });

  } catch(err) {
    console.error('run-listing-audit error:', err);
    return res.status(500).json({ error: err.message });
  }
}
