/**
 * api/run-listing-audit.js
 * POST /api/run-listing-audit
 *
 * Runs a full listing audit across all active SKUs for a brand.
 * Calls Claude with the listing audit skill + all SKU copy.
 * Returns per-field audit notes + rewrites for every SKU.
 *
 * Body: { brand, catalog: [{sku, name, travel, title, item_highlights, bullets[], description, backend}], skillB64 }
 * Returns: { ok: true, results: [{sku, title:{notes,rewrite}, item_highlights:{notes,rewrite}, bullets:{notes,rewrite}, ...}] }
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
    try { skill = Buffer.from(skillB64, 'base64').toString('utf-8').slice(0, 5000); } catch(e) {}
  }

  // Separate full SKUs from travel variations
  const fullSkus    = catalog.filter(s => !s.travel);
  const travelSkus  = catalog.filter(s => s.travel);

  const systemPrompt = `You are an expert Amazon listing compliance auditor for Medaltus working on the evolis hair care brand.

${skill ? 'Apply these listing compliance and optimization rules:\n' + skill + '\n\n' : ''}Key rules to enforce:
- Title: max 75 characters (hard limit as of July 27 2026)
- Item Highlights: max 125 characters (new required field, indexed — MUST be generated if missing)
- No prohibited words (brightening, heals, anti-inflammatory, etc.)
- No promotional language (best, #1, guaranteed, etc.)
- FGF5 mechanism must be explained in plain English before using the term
- All T1 keywords should appear across title, IH, or bullets

For travel/size variations: provide a lighter audit — note the size difference, check title compliance only, flag if Item Highlights is missing. No full bullet rewrite needed.

CRITICAL: Respond with valid JSON only. No markdown. No preamble. No text after the closing bracket.
All string values must avoid apostrophes — use "does not" not "doesn't".`;

  // Build catalog text — full SKUs get full audit, travel get light audit
  const catalogText = catalog.map(s => {
    if (s.travel) {
      return `SKU: ${s.sku} | ${s.name} [TRAVEL/SIZE VARIATION]
Title: ${s.title || 'MISSING'}
Item Highlights: ${s.item_highlights || 'MISSING'}
Backend: ${s.backend || ''}`;
    }
    return `SKU: ${s.sku} | ${s.name}
Title: ${s.title || 'MISSING'}
Item Highlights: ${s.item_highlights || 'MISSING — MUST GENERATE'}
Bullets: ${(s.bullets || []).map((b,i) => `B${i+1}: ${b}`).join(' | ')}
Description: ${(s.description || '').slice(0, 300)}
Backend: ${(s.backend || '').slice(0, 200)}`;
  }).join('\n\n---\n\n');

  const userPrompt = `Audit all evolis listings below. Return a JSON array where each element covers one SKU.

For FULL SKUs return this structure per SKU:
{
  "sku": "EVO0001",
  "title": { "notes": "what is wrong or confirm compliant", "rewrite": "compliant rewrite under 75 chars" },
  "item_highlights": { "notes": "compliance note", "rewrite": "new IH under 125 chars — generate if missing" },
  "bullets": { "notes": "key issues across all 5 bullets", "rewrite": "rewrite bullet 1 only as example" },
  "description": { "notes": "brief note", "rewrite": "" },
  "backend": { "notes": "any prohibited terms or gaps", "rewrite": "cleaned backend string" }
}

For TRAVEL SKUs return lighter structure:
{
  "sku": "EVO0014",
  "title": { "notes": "compliance check only", "rewrite": "compliant title if needed" },
  "item_highlights": { "notes": "generate if missing", "rewrite": "IH under 125 chars" },
  "bullets": null,
  "description": null,
  "backend": { "notes": "brief check", "rewrite": "" }
}

Keep all string values under 300 characters. No apostrophes.

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
      console.warn('run-listing-audit: response truncated — consider batching');
    }

    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const clean = raw
      .replace(/^```json\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let results;
    try {
      results = JSON.parse(clean);
    } catch(parseErr) {
      console.error('run-listing-audit parse error:', parseErr.message);
      console.error('Raw length:', raw.length, '| First 300:', clean.slice(0, 300));
      return res.status(500).json({
        error: 'Could not parse audit response: ' + parseErr.message,
        hint: 'Check Vercel logs'
      });
    }

    return res.status(200).json({ ok: true, results, skuCount: results.length });

  } catch(err) {
    console.error('run-listing-audit error:', err);
    return res.status(500).json({ error: err.message });
  }
}
