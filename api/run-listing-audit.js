/**
 * api/run-listing-audit.js
 * POST /api/run-listing-audit
 *
 * Reads listing copy directly from the source Google Sheet.
 * Calls Claude once per SKU using a plain-text delimited response format —
 * NO JSON from Claude, so no JSON parse errors, ever.
 *
 * Claude responds with labeled lines:
 *   TITLE_NOTES: ...
 *   TITLE_REWRITE: ...
 *   IH_NOTES: ...
 *   IH_REWRITE: ...
 *   BULLETS_NOTES: ...
 *   BULLETS_REWRITE: ...
 *   BACKEND_NOTES: ...
 *   BACKEND_REWRITE: ...
 *
 * Results are written directly to the audit sheet by this endpoint.
 * The dashboard does NOT call Claude — it only reads the completed audit sheet.
 *
 * POST body:
 *   { brand, sourceSheetId, auditSheetId, auditGid, sku? }
 *   sku — optional, limits run to one SKU for testing
 *
 * Vercel config: maxDuration: 300
 */

const { google } = require('googleapis');

// ─── source sheet column indices (0-based) ──────────────────────────────────
// sku | asin | name | status | title | item_highlights |
// bullet_1 | bullet_2 | bullet_3 | bullet_4 | bullet_5 |
// description | backend_keywords | issues | last_synced
const COL = {
  sku:              0,
  asin:             1,
  name:             2,
  status:           3,
  title:            4,
  item_highlights:  5,
  bullet_1:         6,
  bullet_2:         7,
  bullet_3:         8,
  bullet_4:         9,
  bullet_5:         10,
  description:      11,
  backend_keywords: 12,
  ingredients:       13,
  item_type_keyword: 14,
  issues:            15,
  last_synced:       16,
};

// ─── keyword strategy sheet ─────────────────────────────────────────────────
// Sheet ID passed in POST body as keywordSheetId (optional).
// SKU-to-GID map: when a tab exists for a SKU, fetch keywords from it.
// If no tab exists for this SKU, keyword coverage is skipped.
// Tab headers live in row 2; keyword columns found by searching for header text.
// Each keyword cell contains up to 20 newline-separated keywords in one cell.

// ─── uploads log sheet ───────────────────────────────────────────────────────
// Sheet ID passed in POST body as uploadsSheetId (optional).
// Tab name = brand (e.g. "evolis"). Columns: date, week_label, kw_summary_json, ...
// kw_summary_json is a JSON array: [{asin, kw, rank, vl, aba_click, aba_conv}, ...]
// We read the most recent row and build a rank lookup: keyword → rank

// ─── audit sheet headers (must match write-listing-audit.js) ────────────────
const AUDIT_HEADERS = [
  'date', 'sku', 'sku_name', 'action',
  'title_notes', 'title_rewrite',
  'ih_notes', 'ih_rewrite',
  'bullets_notes',
  'bullet_1_rewrite', 'bullet_2_rewrite', 'bullet_3_rewrite', 'bullet_4_rewrite', 'bullet_5_rewrite',
  'desc_notes', 'desc_rewrite',
  'backend_notes', 'backend_rewrite',
  'skip_reason', 'audited_at'
];

// ─── helpers ────────────────────────────────────────────────────────────────

async function getToken() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getAccessToken();
}

// Sanitize a cell value for sending to Claude — remove smart quotes, em dashes,
// HTML entities, extra whitespace. Truncate to maxLen.
function san(s, maxLen) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, 'and').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/[\u2018\u2019\u0060\u00b4]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen || 400);
}

// Parse Claude's plain-text delimited response into a result object.
// Each line starts with LABEL: value.
// Claude may write multi-sentence notes that span the value after the colon —
// we capture everything after the first colon on each labeled line.
function parseDelimited(text) {
  const keys = [
    'TITLE_NOTES', 'TITLE_REWRITE',
    'IH_NOTES', 'IH_REWRITE',
    'BULLETS_NOTES',
    'BULLET_1_REWRITE', 'BULLET_2_REWRITE', 'BULLET_3_REWRITE', 'BULLET_4_REWRITE', 'BULLET_5_REWRITE',
    'DESC_NOTES', 'DESC_REWRITE',
    'BACKEND_NOTES', 'BACKEND_REWRITE',
  ];

  const result = {};
  let currentKey = null;

  for (const line of text.split('\n')) {
    const upper = line.toUpperCase();
    let matched = false;
    for (const key of keys) {
      if (upper.startsWith(key + ':')) {
        currentKey = key;
        result[currentKey] = line.slice(key.length + 1).trim();
        matched = true;
        break;
      }
    }
    if (!matched && currentKey && line.trim()) {
      result[currentKey] += ' ' + line.trim();
    }
  }

  return {
    title_notes:      result['TITLE_NOTES']      || '',
    title_rewrite:    result['TITLE_REWRITE']    || '',
    ih_notes:         result['IH_NOTES']         || '',
    ih_rewrite:       result['IH_REWRITE']       || '',
    bullets_notes:    result['BULLETS_NOTES']    || '',
    bullet_1_rewrite: result['BULLET_1_REWRITE'] || '',
    bullet_2_rewrite: result['BULLET_2_REWRITE'] || '',
    bullet_3_rewrite: result['BULLET_3_REWRITE'] || '',
    bullet_4_rewrite: result['BULLET_4_REWRITE'] || '',
    bullet_5_rewrite: result['BULLET_5_REWRITE'] || '',
    desc_notes:       result['DESC_NOTES']       || '',
    desc_rewrite:     result['DESC_REWRITE']     || '',
    backend_notes:    result['BACKEND_NOTES']    || '',
    backend_rewrite:  result['BACKEND_REWRITE']  || '',
  };
}

// Simple CSV line parser — handles quoted fields
function parseSimpleCsv(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(field); field = ''; continue; }
    field += ch;
  }
  result.push(field);
  return result;
}

// Detect travel SKUs by name or status containing "travel" (case-insensitive)
function isTravel(row) {
  const name   = (row[COL.name]   || '').toLowerCase();
  const status = (row[COL.status] || '').toLowerCase();
  return name.includes('travel') || status.includes('travel');
}

// ─── main handler ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, sourceSheetId, auditSheetId, auditGid, sku: testSku, keywordSheetId, skuGidMap, uploadsSheetId, uploadsGid, skuFilter } = req.body || {};

  if (!brand)         return res.status(400).json({ error: 'Missing: brand' });
  if (!sourceSheetId) return res.status(400).json({ error: 'Missing: sourceSheetId' });
  if (!auditSheetId)  return res.status(400).json({ error: 'Missing: auditSheetId' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Google credentials not configured' });
  }

  // ── 0. Pre-fetch keyword targets and recent rankings (optional) ─────────────
  // Runs AFTER getToken() — token is available from step 1 below.
  // Declared here as empty; populated after token is obtained.
  let kwRankings = {};    // keyword (lowercase) → rank number
  let skuKeywordMap = {}; // sku → { top20, opportunity, reach }

    // ── 1. Read source sheet ──────────────────────────────────────────────────
  let token;
  try {
    token = await getToken();
  } catch (e) {
    return res.status(500).json({ error: 'Google auth failed: ' + e.message });
  }

  // Fetch all rows (skip header row 1)
  const tabName = brand; // e.g. "evolis"
  const sourceUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sourceSheetId}/values/${encodeURIComponent(tabName + '!A2:Q')}?majorDimension=ROWS`;
  const sourceRes = await fetch(sourceUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!sourceRes.ok) {
    const err = await sourceRes.text();
    return res.status(502).json({ error: 'Failed to read source sheet', detail: err.slice(0, 200) });
  }
  const sourceData = await sourceRes.json();
  const allRows = sourceData.values || [];

  if (!allRows.length) {
    return res.status(200).json({ ok: true, message: 'No rows found in source sheet', skuCount: 0 });
  }

  // Filter rows: testSku (single), skuFilter (array from batch), or all
  const rows = allRows.filter(row => {
    const sku = (row[COL.sku] || '').trim();
    if (!sku) return false;
    if (testSku)   return sku === testSku;
    if (skuFilter && Array.isArray(skuFilter) && skuFilter.length) {
      return skuFilter.includes(sku);
    }
    return true;
  });

  if (testSku && !rows.length) {
    return res.status(400).json({ error: `SKU ${testSku} not found in source sheet` });
  }

  // ── 0b. Now fetch keyword data (token is available) ─────────────────────────
  if (uploadsSheetId) {
    try {
      const uploadsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${uploadsSheetId}/values/${encodeURIComponent(brand + '!A:F')}?majorDimension=ROWS`;
      const uploadsRes = await fetch(uploadsUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (uploadsRes.ok) {
        const uploadsData = await uploadsRes.json();
        const uploadsRows = (uploadsData.values || []).slice(1);
        for (let i = uploadsRows.length - 1; i >= 0; i--) {
          const kwJson = uploadsRows[i][2];
          if (kwJson) {
            try {
              const kwArr = JSON.parse(kwJson);
              for (const entry of kwArr) {
                if (entry.kw && entry.rank) {
                  kwRankings[entry.kw.toLowerCase().trim()] = parseInt(entry.rank) || 999;
                }
              }
              console.log(`[listing-audit] Loaded ${Object.keys(kwRankings).length} keyword rankings`);
            } catch(e) { console.warn('[listing-audit] kw_summary_json parse error:', e.message); }
            break;
          }
        }
      }
    } catch(e) { console.warn('[listing-audit] Could not fetch upload rankings:', e.message); }
  }

  if (keywordSheetId && skuGidMap) {
    for (const [skuKey, gid] of Object.entries(skuGidMap)) {
      try {
        // Fetch the tab as CSV using export URL with gid parameter
        const csvUrl = `https://docs.google.com/spreadsheets/d/${keywordSheetId}/export?format=csv&gid=${gid}`;
        const csvRes = await fetch(csvUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!csvRes.ok) { console.warn(`[listing-audit] KW sheet fetch failed for ${skuKey}: ${csvRes.status}`); continue; }
        const csvText = await csvRes.text();
        const csvLines = csvText.split('\n').map(l => l.trim());

        // Find row 2 (index 1) as headers — keywords headers are in row 2
        // Row 1 is row index 0, row 2 is index 1
        const headerLine = csvLines[1] || csvLines[0] || '';
        const headers = parseSimpleCsv(headerLine);

        const top20Idx = headers.findIndex(h => h.trim() === 'Top 20 Keywords');
        const oppIdx   = headers.findIndex(h => h.trim() === 'Top 20 Opportunity Keywords');
        const reachIdx = headers.findIndex(h => h.trim() === 'Top 20 Reach for the stars keywords');

        if (top20Idx < 0) { console.warn(`[listing-audit] No keyword headers found for ${skuKey}`); continue; }

        // Collect keywords from all data rows for those columns
        function colKws(colIdx) {
          if (colIdx < 0) return [];
          const kws = [];
          for (let r = 2; r < csvLines.length; r++) {
            const cells = parseSimpleCsv(csvLines[r]);
            const val = (cells[colIdx] || '').trim();
            if (val) {
              val.split(/\n|\r|,/).map(k => k.trim()).filter(Boolean).forEach(k => kws.push(k));
            }
          }
          return [...new Set(kws)].slice(0, 20);
        }

        skuKeywordMap[skuKey] = {
          top20:       colKws(top20Idx),
          opportunity: colKws(oppIdx),
          reach:       colKws(reachIdx),
        };
        console.log(`[listing-audit] ${skuKey}: ${skuKeywordMap[skuKey].top20.length} top20 keywords loaded`);
      } catch(e) { console.warn(`[listing-audit] KW fetch error for ${skuKey}:`, e.message); }
    }
  }

  console.log(`[listing-audit] Starting audit: ${rows.length} SKUs (brand: ${brand})`);

  // ── 2. Ensure audit sheet has headers ────────────────────────────────────
  const auditTabName = brand; // tab is named after the brand, e.g. "evolis"
  await ensureAuditHeaders(auditSheetId, auditTabName, token);

  // ── 3. Audit each SKU ────────────────────────────────────────────────────
  const auditRows = [];
  const now = new Date().toISOString();
  const auditDate = now.slice(0, 10);

  const systemPrompt = `You are an Amazon listing compliance auditor for ${brand} (Medaltus portfolio).

CRITICAL RULES:
- Title must be 75 characters or fewer (including spaces). Flag if over.
- Item Highlights must be 125 characters or fewer. Flag if over. Generate one if missing.
- No drug-claim verbs: reverses, regrows, cures, heals, treats, eliminates (disease context)
- No brightening / brightens / brightener / dark spot language
- No "free from X" framed as health risk
- No apostrophes in rewrites (write "does not" not "don't")
- No em dashes in rewrites (use hyphen only)
- No promotional language: no "best", "award-winning" without citation, no "order now"
- No competitor comparisons
- Stats (95% of users etc) require qualifier: "in a consumer perception study"
- FGF5-blocking is mechanistic language — permissible as descriptor, not disease claim
- Backend keywords: spaces only, no commas, no drug-claim terms
- SIZE FORMAT IN TITLE: Size must always appear at the end of the title in parentheses. Liquid products (serums, shampoos, conditioners, masks, oils) must use "fl oz" format: (1.7 fl oz), (8.5 fl oz), (2 fl oz). Non-liquid/powder products use "oz" only: (5.2 oz). Never use bare "oz" without "fl" for liquid products. Never omit parentheses around size. Never place size mid-title. Flag any title where size is missing, uses wrong format, or lacks parentheses. Rewrite must include size in correct format at end of title.
- Timeline claims (e.g. "in 90 days", "in 3 months") require a consumer perception study qualifier. Unqualified timeline claims are a violation. Safe form: "In a consumer perception study, X% of users reported [benefit] in [timeframe]." Timeline claims in Item Highlights are especially risky due to 125-char limit — recommend removing from IH and moving to bullets with full qualifier.
- Item Highlights must not contain unqualified efficacy timelines.
- INGREDIENT QA: When ingredients are provided, cross-check every specific ingredient named in bullets and description against the actual ingredient list. If a bullet claims an ingredient (e.g. "keratin", "rosemary oil", "hyaluronic acid", "vitamin C") that does NOT appear in the ingredient list, flag it as a violation: "Ingredient '[X]' listed in bullet [N] not found in actual ingredient list — remove or verify." Only flag ingredients that are definitively absent. Common ingredient aliases are acceptable (e.g. "Rosmarinus Officinalis" = rosemary oil). If a timeline claim is present in IH without qualifier, flag it and rewrite removing the timeline or moving it to a bullet.

KEYWORD COVERAGE RULES:
- When keyword targets are provided, check that Tier 1 keywords appear in the listing (title, bullets, backend, or description). Flag any Tier 1 keyword that is completely absent from all copy fields.
- Prioritize flagging keywords that are NOT ranking (shown as "not ranking") — these need copy placement most urgently.
- For opportunity keywords (Tier 2) with rank > 50 or not ranking: recommend specific placement in bullets 3-5 or backend.
- Do NOT recommend adding drug-claim keywords or any keyword that violates compliance rules.
- In BACKEND_NOTES: flag missing Tier 1 keywords not covered by other fields. In BACKEND_REWRITE: ensure all Tier 1 keywords not in title/bullets are in the backend.
- In BULLETS_NOTES: flag the 2-3 highest-priority keyword gaps with specific placement recommendations.

BULLET FORMATTING RULES (apply to all bullet rewrites):
- Every bullet must open with an ALL-CAPS phrase (3-6 words) followed by a colon, then sentence-case detail. Example: "CLINICALLY TESTED HAIR GROWTH SERUM: In 3 independent studies, 95% of users reported visibly thicker hair."
- Flag any bullet that does NOT follow this ALL-CAPS header: detail format as a violation.
- Across the catalog, align parallel bullets by position where products are related: B1 = hero claim/clinical proof, B2 = science/mechanism, B3 = key ingredients, B4 = who it is for/hair types, B5 = brand credentials/clean formula. Rewrites should follow this structure consistently.
- Within a single SKU, bullet headers should not repeat the same keyword root — vary to maximize keyword coverage.
- Bullet rewrites must be max 200 chars including the ALL-CAPS header.

OUTPUT FORMAT — use exactly these labels, one per line, no JSON, no markdown:
TITLE_NOTES: [violations found, or "No violations" if clean. Max 300 chars.]
TITLE_REWRITE: [compliant rewrite, max 75 chars. If clean, repeat original trimmed to 75.]
IH_NOTES: [violations found, or generated if missing. Max 300 chars.]
IH_REWRITE: [compliant rewrite or new copy, max 125 chars.]
BULLETS_NOTES: [key violations across all bullets, noted by bullet number. Max 500 chars. Empty string if travel SKU.]
BULLET_1_REWRITE: [compliant rewrite of bullet 1, max 200 chars. Empty string if travel SKU.]
BULLET_2_REWRITE: [compliant rewrite of bullet 2, max 200 chars. Empty string if travel SKU.]
BULLET_3_REWRITE: [compliant rewrite of bullet 3, max 200 chars. Empty string if travel SKU.]
BULLET_4_REWRITE: [compliant rewrite of bullet 4, max 200 chars. Empty string if travel SKU.]
BULLET_5_REWRITE: [compliant rewrite of bullet 5, max 200 chars. Empty string if travel SKU.]
DESC_NOTES: [violations found in description, or "No violations" if clean. Max 300 chars. Empty string if travel SKU.]
DESC_REWRITE: [compliant rewrite of description, max 400 chars, plain sentences no bullets. Empty string if travel SKU.]
BACKEND_NOTES: [violations found, or "No violations" if clean. Max 300 chars.]
BACKEND_REWRITE: [compliant backend keywords, max 200 chars, spaces only no commas.]

Write nothing else. No preamble. No explanation after the last line. Start immediately with TITLE_NOTES:`;

  for (const row of rows) {
    const sku  = (row[COL.sku]  || '').trim();
    const name = (row[COL.name] || '').trim();
    const travel = isTravel(row);

    try {
      const title     = san(row[COL.title], 400);
      const ih        = san(row[COL.item_highlights], 200) || 'MISSING';
      const b1        = san(row[COL.bullet_1], 300);
      const b2        = san(row[COL.bullet_2], 300);
      const b3        = san(row[COL.bullet_3], 300);
      const b4        = san(row[COL.bullet_4], 300);
      const b5        = san(row[COL.bullet_5], 300);
      const desc      = san(row[COL.description], 400);
      const backend      = san(row[COL.backend_keywords], 300);
      const ingredients  = san(row[COL.ingredients], 600);

      let userPrompt;
      if (travel) {
        userPrompt = `Audit this TRAVEL SIZE SKU. For travel SKUs only check title and item highlights. Set BULLETS_NOTES and BULLETS_REWRITE to empty string.

SKU: ${sku}
Name: ${name} [TRAVEL SIZE]
Title: ${title}
Item Highlights: ${ih}
Backend: ${backend}`;
      } else {
        // Pass sibling SKU names for cross-catalog bullet alignment
        const siblings = rows
          .filter(r => (r[COL.sku] || '').trim() !== sku && !isTravel(r))
          .map(r => (r[COL.name] || '').trim())
          .filter(Boolean)
          .slice(0, 8)
          .join(', ');

        // Build keyword coverage context
        const asin = (row[COL.asin] || '').trim();
        const skuKws = skuKeywordMap[sku] || null;
        let kwContext = '';
        if (skuKws && skuKws.top20.length) {
          // Annotate each keyword with current rank from uploads log
          function kwWithRank(kw) {
            const rank = kwRankings[kw.toLowerCase().trim()];
            return rank ? `${kw} (rank #${rank})` : `${kw} (not ranking)`;
          }
          const t1 = skuKws.top20.map(kwWithRank).join(', ');
          const opp = skuKws.opportunity.length
            ? skuKws.opportunity.map(kwWithRank).filter(k => {
                // Only include opportunity keywords not already ranking well (rank > 50 or not ranking)
                const r = kwRankings[k.replace(/ \(.*\)/, '').toLowerCase().trim()];
                return !r || r > 50;
              }).slice(0, 10).join(', ')
            : '';
          kwContext = `
KEYWORD TARGETS (Tier 1 — must appear in title, bullets, or backend):
${t1}
${opp ? `OPPORTUNITY KEYWORDS (Tier 2 — high ABA, low competition — prioritize in bullets 3-5 and backend):
${opp}` : ''}`;
        } else if (Object.keys(kwRankings).length > 0) {
          // No strategy sheet tab for this SKU — use top ranking keywords from upload as proxy
          const ranked = Object.entries(kwRankings)
            .filter(([kw]) => {
              // Basic relevance filter — must contain a word from the product name
              const nameParts = name.toLowerCase().split(' ');
              return nameParts.some(p => p.length > 3 && kw.includes(p));
            })
            .sort(([,a],[,b]) => a - b)
            .slice(0, 15)
            .map(([kw, rank]) => `${kw} (rank #${rank})`);
          if (ranked.length) {
            kwContext = `
KEYWORD RANKINGS FROM TRACKER (use these to identify coverage gaps):
${ranked.join(', ')}`;
          }
        }

        userPrompt = `Audit this full listing SKU.

SKU: ${sku}
Name: ${name}
ASIN: ${asin}
Related SKUs in this catalog: ${siblings || 'none'}
Title: ${title}
Item Highlights: ${ih}
Bullet 1: ${b1}
Bullet 2: ${b2}
Bullet 3: ${b3}
Bullet 4: ${b4}
Bullet 5: ${b5}
Description (excerpt): ${desc}
Backend: ${backend}
Ingredients: ${ingredients || 'NOT AVAILABLE'}${kwContext}`;
      }

      // Call Claude — retry once on 429
      let claudeRes;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          const wait = attempt * 10000;
          console.log(`[listing-audit] ${sku} retry ${attempt} after ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        }
        claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: travel ? 600 : 2500,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
          })
        });
        if (claudeRes.status !== 429) break;
        console.log(`[listing-audit] ${sku} 429 rate limit — will retry`);
      }

      // Sleep between SKUs — shorter for travel SKUs (title+IH only = faster response)
      await new Promise(r => setTimeout(r, travel ? 500 : 1500));

      if (!claudeRes.ok) {
        const errText = await claudeRes.text().catch(() => '');
        console.error(`[listing-audit] ${sku} Claude error ${claudeRes.status}: ${errText.slice(0, 100)}`);
        auditRows.push(buildErrorRow(auditDate, sku, name, `Claude error ${claudeRes.status}`, now));
        continue;
      }

      const claudeData = await claudeRes.json();
      const rawText = (claudeData.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      // Parse plain-text delimited response — zero JSON involved
      const parsed = parseDelimited(rawText);

      auditRows.push([
        auditDate,
        sku,
        name,
        'audit_run',
        parsed.title_notes,
        parsed.title_rewrite,
        parsed.ih_notes,
        parsed.ih_rewrite,
        travel ? '' : parsed.bullets_notes,
        travel ? '' : parsed.bullet_1_rewrite,
        travel ? '' : parsed.bullet_2_rewrite,
        travel ? '' : parsed.bullet_3_rewrite,
        travel ? '' : parsed.bullet_4_rewrite,
        travel ? '' : parsed.bullet_5_rewrite,
        travel ? '' : parsed.desc_notes,
        travel ? '' : parsed.desc_rewrite,
        parsed.backend_notes,
        parsed.backend_rewrite,
        '',   // skip_reason
        now   // audited_at
      ]);

      console.log(`[listing-audit] ✓ ${sku}`);

    } catch (err) {
      console.error(`[listing-audit] ✗ ${sku}: ${err.message}`);
      auditRows.push(buildErrorRow(auditDate, sku, name, err.message, now));
    }
  }

  // ── 4. Write all audit rows to the audit sheet ───────────────────────────
  if (auditRows.length) {
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${auditSheetId}/values/${encodeURIComponent(auditTabName + '!A2')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const appendRes = await fetch(appendUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: auditRows })
    });

    if (!appendRes.ok) {
      const err = await appendRes.text();
      console.error('[listing-audit] Sheet write failed:', appendRes.status, err.slice(0, 200));
      return res.status(502).json({
        error: 'Audit completed but sheet write failed',
        status: appendRes.status,
        skuCount: auditRows.length
      });
    }
  }

  console.log(`[listing-audit] Done — ${auditRows.length} rows written`);
  return res.status(200).json({ ok: true, skuCount: auditRows.length });
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildErrorRow(date, sku, name, errorMsg, now) {
  return [
    date, sku, name, 'error',
    errorMsg.slice(0, 300), '', '', '', '', '', '', '', '', '', '', '', '', '',
    '', now
  ];
}

async function ensureAuditHeaders(sheetId, tabName, token) {
  const checkRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1:T1')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!checkRes.ok) return;
  const data = await checkRes.json();
  if (data.values && data.values[0] && data.values[0].length > 0) return;

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1')}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [[
          'date', 'sku', 'sku_name', 'action',
          'title_notes', 'title_rewrite',
          'ih_notes', 'ih_rewrite',
          'bullets_notes',
          'bullet_1_rewrite', 'bullet_2_rewrite', 'bullet_3_rewrite', 'bullet_4_rewrite', 'bullet_5_rewrite',
          'desc_notes', 'desc_rewrite',
          'backend_notes', 'backend_rewrite',
          'skip_reason', 'audited_at'
        ]]
      })
    }
  );
}
