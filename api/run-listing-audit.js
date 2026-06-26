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
    try { skill = Buffer.from(skillB64, 'base64').toString('utf-8').slice(0, 3000); } catch(e) {}
  }

  const isTravel = catalog.every(s => s.travel);

  function sanitize(s) {
    if (!s) return '';
    return String(s)
      .replace(/&amp;/g, 'and').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ')
      .replace(/[\u2018\u2019\u0060\u00b4]/g, '')  // remove all apostrophe variants
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\s+/g, ' ').trim().slice(0, 350);
  }

  const systemPrompt = `You are an Amazon listing compliance auditor for Medaltus / evolis hair care.

${skill ? 'Key compliance rules:\n' + skill + '\n\n' : ''}STRICT OUTPUT RULES - violations will cause system failure:
1. Output ONLY a raw JSON array. Zero text before or after the array.
2. No markdown fences of any kind.
3. No apostrophes anywhere - write "does not" not "don't", "it is" not "it's", "hair that is" not "hair that's"
4. No smart quotes - use only straight double quotes " for JSON
5. No em dashes or en dashes - use hyphen - only
6. No ellipsis character - write "..." as three separate periods
7. Every string value must be on a single line - no newlines inside string values
8. Max 200 characters per string value
9. Title max 75 chars, Item Highlights max 125 chars`;

  const catalogText = catalog.map(s => {
    if (s.travel) {
      return `SKU:${s.sku}|${s.name}[TRAVEL]|Title:${sanitize(s.title)}|IH:${sanitize(s.item_highlights)||'MISSING'}`;
    }
    const bullets = (s.bullets||[]).slice(0,5).map((b,i)=>`B${i+1}:${sanitize(b)}`).join('|');
    return `SKU:${s.sku}|${s.name}|Title:${sanitize(s.title)}|IH:${sanitize(s.item_highlights)||'MISSING-GENERATE'}|${bullets}|Backend:${sanitize(s.backend)}`;
  }).join('\n\n');

  const schema = isTravel
    ? `[{"sku":"EVO0014","title":{"notes":"note under 150 chars","rewrite":"title under 75 chars"},"item_highlights":{"notes":"note","rewrite":"IH under 125 chars"},"bullets":null,"description":null,"backend":{"notes":"note","rewrite":""}}]`
    : `[{"sku":"EVO0001","title":{"notes":"note under 150 chars","rewrite":"title under 75 chars"},"item_highlights":{"notes":"note","rewrite":"IH under 125 chars"},"bullets":{"notes":"issues summary under 150 chars","rewrite":"B1 rewrite under 200 chars"},"description":{"notes":"note under 150 chars","rewrite":""},"backend":{"notes":"note under 150 chars","rewrite":"cleaned keywords under 200 chars"}}]`;

  const userPrompt = `Audit these evolis SKUs. Return ONLY a JSON array matching this schema:
${schema}

Critical: no apostrophes, no em dashes, no smart quotes, no newlines in strings, all values under 200 chars.
For missing Item Highlights: generate one under 125 chars.
For travel SKUs: set bullets and description to null.

CATALOG:
${catalogText}`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(502).json({ error: 'Claude API error ' + claudeRes.status, detail: err.slice(0, 200) });
    }

    const data = await claudeRes.json();
    if (data.stop_reason === 'max_tokens') console.warn('run-listing-audit: truncated');

    const raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    // ── Aggressive sanitization of Claude's raw output ──────────────
    let clean = raw
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '')
      .trim();

    // Extract just the array
    const arrStart = clean.indexOf('[');
    const arrEnd   = clean.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) clean = clean.slice(arrStart, arrEnd + 1);

    // Fix common Claude output issues
    clean = clean
      .replace(/[\u2018\u2019\u0060\u00b4]/g, '')           // remove apostrophes
      .replace(/[\u201C\u201D]/g, '"')                        // smart double → straight
      .replace(/[\u2013\u2014]/g, '-')                        // dashes → hyphen
      .replace(/\u2026/g, '...')                              // ellipsis
      .replace(/\\n/g, ' ')                                   // escaped newlines in strings
      .replace(/\r?\n/g, ' ')                                 // literal newlines
      .replace(/\t/g, ' ')                                    // tabs
      .replace(/,\s*}/g, '}')                                 // trailing commas in objects
      .replace(/,\s*]/g, ']');                                // trailing commas in arrays

    // Fix unescaped double quotes inside string values — common Claude mistake
    // Pattern: find ": "...string with "quotes" inside..."
    // This is the trickiest issue. Try a targeted fix for known patterns.
    clean = clean.replace(/"notes"\s*:\s*"([^"]*)"([^"]*)"([^"]*)"/g, (m, a, b, c) => {
      return `"notes":"${a}${b}${c}"`;
    });

    let results;
    try {
      results = JSON.parse(clean);
    } catch(parseErr) {
      console.error('parse error:', parseErr.message, '| pos:', parseErr.message.match(/\d+/)?.[0]);
      console.error('Around error:', clean.slice(Math.max(0, (parseInt(parseErr.message.match(/\d+/)?.[0]||0)) - 50), (parseInt(parseErr.message.match(/\d+/)?.[0]||0)) + 50));

      // Last resort: try to build a partial result from what parsed successfully
      const partialMatch = clean.match(/(\{[^{}]*"sku"\s*:\s*"[^"]+"/g);
      if (partialMatch && partialMatch.length > 0) {
        return res.status(500).json({
          error: 'Could not parse full audit response: ' + parseErr.message,
          partialCount: partialMatch.length,
          hint: 'Claude output contained characters that broke JSON parsing. Check Vercel logs.'
        });
      }
      return res.status(500).json({ error: 'Could not parse audit response: ' + parseErr.message });
    }

    return res.status(200).json({ ok: true, results, skuCount: results.length });

  } catch(err) {
    console.error('run-listing-audit error:', err);
    return res.status(500).json({ error: err.message });
  }
}
