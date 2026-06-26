/**
 * api/run-listing-audit.js
 * POST /api/run-listing-audit
 * 
 * Calls Claude once per SKU (sequentially) to avoid JSON corruption from
 * large batched responses. Each call returns a small, simple JSON object
 * that's easy to parse reliably.
 */

// Fix unescaped double quotes inside JSON string values.
// Claude often writes: "notes": "Use "clinically tested" carefully" which breaks JSON.parse.
// This walks char-by-char and escapes inner quotes.
function fixJsonStrings(s) {
  const result = [];
  let inString = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && inString) {
      result.push(c);
      i++;
      if (i < s.length) result.push(s[i]);
      i++;
      continue;
    }
    if (c === '"') {
      if (!inString) {
        inString = true;
        result.push(c);
      } else {
        // Check what follows (skip whitespace) to determine if this closes the string
        let j = i + 1;
        while (j < s.length && ' \t\r\n'.includes(s[j])) j++;
        if (j >= s.length || ':,}]'.includes(s[j])) {
          inString = false;
          result.push(c);
        } else {
          // Unescaped quote inside string value — escape it
          result.push('\\"');
        }
      }
    } else {
      result.push(c);
    }
    i++;
  }
  return result.join('');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, catalog, skillB64 } = req.body || {};
  if (!catalog || !catalog.length) return res.status(400).json({ error: 'Missing catalog' });

  // Test mode: ?sku=EVO0001 limits the run to just that SKU
  const testSku = req.query && req.query.sku;
  const skusToAudit = testSku
    ? catalog.filter(s => s.sku === testSku)
    : catalog;

  if (testSku && !skusToAudit.length) {
    return res.status(400).json({ error: `SKU ${testSku} not found in catalog` });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  let skill = '';
  if (skillB64) {
    try { skill = Buffer.from(skillB64, 'base64').toString('utf-8').slice(0, 2000); } catch(e) {}
  }

  function san(s, maxLen) {
    if (!s) return '';
    return String(s)
      .replace(/&amp;/g,'and').replace(/&nbsp;/g,' ').replace(/&[a-z]+;/g,' ')
      .replace(/[\u2018\u2019\u0060\u00b4]/g,'')
      .replace(/[\u201C\u201D]/g,'')
      .replace(/[\u2013\u2014]/g,'-')
      .replace(/\u2026/g,'...')
      .replace(/"/g,'')
      .replace(/\\/g,'')
      .replace(/\r?\n|\r/g,' ')
      .replace(/\s+/g,' ')
      .trim()
      .slice(0, maxLen || 300);
  }

  const systemPrompt = `You are an Amazon listing compliance auditor for evolis hair care (Medaltus).
${skill ? '\nKey rules:\n' + skill + '\n' : ''}
OUTPUT FORMAT - follow exactly:
- Return a single JSON object (not array) for the ONE SKU you are given
- Use only straight double quotes for JSON
- No apostrophes in values - write "does not" not "don't"  
- No em dashes - use hyphen only
- No newlines inside string values
- Keep notes under 150 chars, rewrites under the stated char limits
- Title rewrite: max 75 chars
- Item Highlights rewrite: max 125 chars (generate even if missing)
- Bullet rewrite: max 200 chars (B1 only as example)
- Backend rewrite: max 200 chars

Return exactly this structure:
{"sku":"SKU","title_notes":"...","title_rewrite":"...","ih_notes":"...","ih_rewrite":"...","bullets_notes":"...","bullets_rewrite":"...","desc_notes":"...","backend_notes":"...","backend_rewrite":"..."}`;

  const results = [];

  for (const skuData of skusToAudit) {
    try {
      let userPrompt;
      if (skuData.travel) {
        userPrompt = `Audit this travel/size variation SKU. For travel SKUs: check title compliance only, generate Item Highlights if missing. Set bullets_rewrite and desc_notes to empty string.

SKU: ${skuData.sku}
Name: ${skuData.name} [TRAVEL SIZE]
Title: ${san(skuData.title, 300)}
Item Highlights: ${san(skuData.item_highlights, 200) || 'MISSING - GENERATE ONE'}
Backend: ${san(skuData.backend, 200)}`;
      } else {
        const bullets = (skuData.bullets||[]).slice(0,5).map((b,i)=>`Bullet ${i+1}: ${san(b,250)}`).join('\n');
        userPrompt = `Audit this full SKU listing.

SKU: ${skuData.sku}
Name: ${skuData.name}
Title: ${san(skuData.title, 300)}
Item Highlights: ${san(skuData.item_highlights, 200) || 'MISSING - GENERATE ONE'}
${bullets}
Description (excerpt): ${san(skuData.description, 300)}
Backend: ${san(skuData.backend, 200)}`;
      }

      // Retry loop — handles 429 rate limits with backoff
      let claudeRes;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          const wait = attempt * 8000; // 8s, 16s backoff
          console.log(`[audit] ${skuData.sku} retry ${attempt} after ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        }
        claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 600,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
          })
        });
        if (claudeRes.status !== 429) break;
        console.log(`[audit] ${skuData.sku} Claude error 429 — will retry`);
      }

      // Sleep between SKUs to avoid rate limits (1 req/sec sustained)
      await new Promise(r => setTimeout(r, 3000));

      if (!claudeRes.ok) {
        console.error(`[audit] ${skuData.sku} Claude error ${claudeRes.status}`);
        results.push({ sku: skuData.sku, title_notes: 'API error ' + claudeRes.status, title_rewrite: '', ih_notes: '', ih_rewrite: '', bullets_notes: '', bullets_rewrite: '', desc_notes: '', backend_notes: '', backend_rewrite: '' });
        continue;
      }

      const data = await claudeRes.json();
      const raw = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');

      // Sanitize and parse
      let clean = raw
        .replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```\s*$/i,'')
        .replace(/[\u2018\u2019\u0060\u00b4]/g,"'")
        .replace(/[\u201C\u201D]/g,'"')
        .replace(/[\u2013\u2014]/g,'-')
        .replace(/\u2026/g,'...')
        .replace(/\\'/g,"'")
        .replace(/\\\//g,'/')
        .replace(/,\s*}/g,'}')
        .trim();

      // Extract just the object
      const objStart = clean.indexOf('{');
      const objEnd   = clean.lastIndexOf('}');
      if (objStart >= 0 && objEnd > objStart) clean = clean.slice(objStart, objEnd+1);

      // Fix unescaped double quotes inside JSON string values
      // e.g. Claude writes: "notes": "Use "clinically tested" carefully" → breaks parse
      clean = fixJsonStrings(clean);

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch(e) {
        // Return raw Claude output when ?rawDebug=1 is passed
        if (req.query && req.query.rawDebug) {
          return res.status(200).json({ debug: true, sku: skuData.sku, parseError: e.message, raw, clean });
        }
        console.error(`[audit] ${skuData.sku} parse error: ${e.message}`);
        console.error(`[audit] clean (full): ${clean}`);
        // Build a minimal result so the SKU isn't skipped entirely
        parsed = {
          sku: skuData.sku,
          title_notes: 'Parse error - rerun audit',
          title_rewrite: '', ih_notes: '', ih_rewrite: '',
          bullets_notes: '', bullets_rewrite: '', desc_notes: '',
          backend_notes: '', backend_rewrite: ''
        };
      }

      // Normalize to expected structure
      results.push({
        sku:              skuData.sku,
        title:            { notes: parsed.title_notes||'', rewrite: parsed.title_rewrite||'' },
        item_highlights:  { notes: parsed.ih_notes||'',    rewrite: parsed.ih_rewrite||''    },
        bullets:          skuData.travel ? null : { notes: parsed.bullets_notes||'', rewrite: parsed.bullets_rewrite||'' },
        description:      skuData.travel ? null : { notes: parsed.desc_notes||'',   rewrite: '' },
        backend:          { notes: parsed.backend_notes||'', rewrite: parsed.backend_rewrite||'' }
      });

      console.log(`[audit] ✓ ${skuData.sku}`);

    } catch(err) {
      console.error(`[audit] ✗ ${skuData.sku}: ${err.message}`);
      results.push({
        sku: skuData.sku,
        title: { notes: err.message, rewrite: '' },
        item_highlights: { notes: '', rewrite: '' },
        bullets: null, description: null,
        backend: { notes: '', rewrite: '' }
      });
    }
  }

  return res.status(200).json({ ok: true, results, skuCount: results.length });
}
