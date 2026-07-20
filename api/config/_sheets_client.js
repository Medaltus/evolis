/**
 * api/config/_sheets_client.js
 * Shared Google Sheets helper.
 * Handles auth, tab creation, header writing, and data upsert.
 *
 * Uses the same service account as VB Cosmetics:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY
 */

const https = require('https');
const crypto = require('crypto');

// ── JWT / OAuth ───────────────────────────────────────────────────────────────

let _tokenCache = null;

async function getSheetsToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 60_000) {
    return _tokenCache.token;
  }

  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat     = Math.floor(now / 1000);
  const payload = base64url(JSON.stringify({
    iss:   email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat,
    exp:   iat + 3600,
  }));

  const sigInput  = `${header}.${payload}`;
  const sign      = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(rawKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt  = `${sigInput}.${signature}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  const data = await httpPost('oauth2.googleapis.com', '/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  _tokenCache = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return _tokenCache.token;
}

// ── Tab management ────────────────────────────────────────────────────────────

/**
 * Ensure a tab exists in the sheet. If not, create it and write headers.
 *
 * CHANGED (2026-07-16): previously only checked/wrote headers when the tab
 * didn't exist yet — an existing tab's header row was never looked at
 * again, ever. That silently broke two sheets so far (Business Report,
 * Ad Search Terms Cache) after their cron's column shape changed:
 * every column from the changed point onward quietly read as the wrong
 * field, with no error anywhere, for however long it took someone to
 * notice the numbers looked wrong.
 *
 * This does NOT auto-rewrite an existing header row — these sheets get
 * hand-edited sometimes (someone adding a column, fixing a header by
 * hand), and blind auto-correction could clobber that. It just reads
 * row 1 and logs a loud, specific warning if it doesn't match what this
 * call expects, so drift shows up in Vercel logs immediately instead of
 * silently corrupting every read for weeks.
 */
async function ensureTab(sheetId, tabName, headers) {
  const token = await getSheetsToken();

  // Get existing sheets
  const meta = await sheetsGet(token, `/${sheetId}?fields=sheets.properties.title`);
  const titles = (meta.sheets || []).map(s => s.properties.title);
  const exists = titles.some(t => t === tabName);

  // 2026-07-16 — diagnostic for the "addSheet says it already exists, but
  // the exists-check above said it didn't" contradiction: since both the
  // check and the create target the exact same sheetId in the exact same
  // call, the only way to get that contradiction is either (a) `titles`
  // didn't actually contain everything Google has, or (b) it did contain
  // the right tab but under a title that LOOKS like "revenue" without
  // being === to it — a trailing space, a non-breaking space, a lookalike
  // unicode character, anything invisible in the Sheets UI's tab strip.
  // Logging the exact list + character codes here means the next failure
  // (if there is one) is diagnosable from Vercel logs directly instead of
  // needing another guess-and-check round.
  if (!exists) {
    const targetCodes = tabName.split('').map(c => c.charCodeAt(0)).join(',');
    console.log(`[sheets] ensureTab("${tabName}") — not found in titles: ${JSON.stringify(titles)} — target char codes: [${targetCodes}]`);
  }

  if (!exists) {
    // Add the sheet tab
    try {
      await sheetsPost(token, `/${sheetId}:batchUpdate`, {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      });
      // Write headers on row 1
      await writeRow(sheetId, tabName, 1, headers, token);
      console.log(`[sheets] created tab "${tabName}" in sheet ${sheetId}`);
    } catch (err) {
      // 2026-07-16 — self-heal against the exact contradiction above: if
      // Google's own error says this tab already exists, that's ground
      // truth — trust it over our own (apparently wrong) pre-check rather
      // than failing the whole sync over a tab that's actually fine. Any
      // OTHER addSheet failure still throws normally.
      if (/already exists/i.test(err.message)) {
        console.warn(`[sheets] addSheet said "${tabName}" already exists (contradicts the exists-check above — see titles logged) — continuing as if it already existed.`);
      } else {
        throw err;
      }
    }
  } else {
    // Tab already exists — check its actual header row against what this
    // caller expects. Doesn't fix anything, just makes drift loud.
    try {
      const range = encodeURIComponent(`${tabName}!A1:ZZ1`);
      const data  = await sheetsGet(token, `/${sheetId}/values/${range}`);
      const actualHeaders = (data.values && data.values[0]) || [];

      const mismatch = actualHeaders.length !== headers.length ||
        headers.some((h, i) => (actualHeaders[i] || '').trim() !== h);

      if (mismatch) {
        console.error(
          `[sheets] HEADER MISMATCH on tab "${tabName}" in sheet ${sheetId}. ` +
          `This means every column read/write on this tab may be misaligned. ` +
          `Expected: ${JSON.stringify(headers)} — Actual row 1: ${JSON.stringify(actualHeaders)}`
        );
      }
    } catch (err) {
      // Don't let a header-check failure block the actual sync — just log it.
      console.warn(`[sheets] header check failed for tab "${tabName}":`, err.message);
    }
  }

  return token;
}

/**
 * Append rows to a tab. Rows is an array of arrays.
 */
/**
 * valueInputOption defaults to 'RAW' (existing behavior, unchanged for every
 * current caller). Pass 'USER_ENTERED' when rows contain real spreadsheet
 * formulas that need to actually evaluate rather than be stored as literal
 * text — same reasoning as replaceRows's own valueInputOption param below.
 * Added 2026-07-20 for sync-products.js's total_quantity/days_of_inventory
 * formula columns.
 */
async function appendRows(sheetId, tabName, rows, token, valueInputOption = 'RAW') {
  if (!rows.length) return;
  const range = `${tabName}!A1`;
  await sheetsPost(
    token,
    `/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`,
    { values: rows }
  );
}

/**
 * Clear all data rows (keep header) then write fresh rows.
 * Used for full-refresh syncs.
 *
 * valueInputOption defaults to 'RAW' (existing behavior, unchanged for every
 * current caller). Pass 'USER_ENTERED' when rows contain real spreadsheet
 * formulas (e.g. "=K2+L2") that need to actually evaluate rather than be
 * stored as literal text — RAW stores formula-looking strings as-is, it
 * does not evaluate them. Added 2026-07-13 for sync-stewardship-summary.js.
 */
async function replaceRows(sheetId, tabName, headers, rows, token, valueInputOption = 'RAW') {
  // Clear everything from row 2 onwards
  const clearRange = `${tabName}!A2:ZZ`;
  await sheetsPost(token, `/${sheetId}/values/${encodeURIComponent(clearRange)}:clear`, {});

  if (rows.length) {
    await sheetsPost(
      token,
      `/${sheetId}/values/${encodeURIComponent(tabName + '!A2')}?valueInputOption=${valueInputOption}`,
      { values: rows },
      'PUT'
    );
  }
}

/**
 * Read all rows from a tab. Returns array of objects keyed by header.
 */
/**
 * valueRenderOption defaults to the Sheets API's own default
 * (FORMATTED_VALUE — a formula cell's computed result, not its formula
 * text), unchanged for every existing caller. Pass 'FORMULA' when a tab
 * may contain live formulas (e.g. sync-products.js's total_quantity /
 * days_of_inventory columns) and you need to round-trip the formula
 * itself rather than flattening it into whatever number it last
 * evaluated to. Added 2026-07-20.
 */
async function readRows(sheetId, tabName, valueRenderOption = null) {
  const token = await getSheetsToken();
  const range = encodeURIComponent(`${tabName}!A1:ZZ`);
  const suffix = valueRenderOption ? `?valueRenderOption=${valueRenderOption}` : '';
  const data  = await sheetsGet(token, `/${sheetId}/values/${range}${suffix}`);
  const rows  = data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0];
  return rows.slice(1).map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null]))
  );
}

/**
 * Update the last_updated timestamp for a specific tab's data rows.
 * Called at end of each sync.
 */
async function touchMeta(sheetId, tabName, status, rowsWritten, token, errorMsg) {
  // We write a meta row into the sheet's first tab named '_meta' if it exists
  // For simplicity we just log — meta tab is optional enhancement
  console.log(`[sheets] ${tabName} sync complete — ${status}, ${rowsWritten} rows, ${new Date().toISOString()}`);
  if (errorMsg) console.error(`[sheets] ${tabName} error: ${errorMsg}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const SHEETS_BASE = 'sheets.googleapis.com';
const SHEETS_PATH = '/v4/spreadsheets';

function sheetsGet(token, path, retriesLeft = 3) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: SHEETS_BASE,
      path:     SHEETS_PATH + path,
      method:   'GET',
      headers:  { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', async () => {
        let parsed;
        try { parsed = JSON.parse(d); }
        catch (e) { return reject(new Error(`Sheets GET parse error (${res.statusCode}): ${d.slice(0, 200)}`)); }

        // Previously this resolved on ANY parseable body regardless of
        // status code — a 429 (rate limit) response is still valid JSON,
        // so it silently resolved with an error object that has no
        // `.values` field. readRows then saw `data.values || []` and
        // returned an empty array as if the tab just had no data, with no
        // exception ever thrown. Discovered 2026-07-13 when the last two
        // brands processed in sync-stewardship-summary's loop (pbj,
        // skinside-seoul) came back completely empty across every single
        // source with zero warnings logged — consistent with quota
        // exhaustion near the end of a ~100-call run, silently swallowed.
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const isRateLimited = res.statusCode === 429 || parsed?.error?.status === 'RESOURCE_EXHAUSTED';
          if (isRateLimited && retriesLeft > 0) {
            const waitMs = (4 - retriesLeft) * 2000 + 2000; // 2s, 4s, 6s
            console.warn(`[sheets] rate limited on GET ${path}, retrying in ${waitMs}ms (${retriesLeft} left)`);
            await new Promise(r => setTimeout(r, waitMs));
            try {
              resolve(await sheetsGet(token, path, retriesLeft - 1));
            } catch (err) {
              reject(err);
            }
            return;
          }
          return reject(new Error(`Sheets GET failed (${res.statusCode}): ${JSON.stringify(parsed).slice(0, 300)}`));
        }

        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sheetsPost(token, path, body, method = 'POST', retriesLeft = 3) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const opts = {
      hostname: SHEETS_BASE,
      path:     SHEETS_PATH + path,
      method,
      headers:  {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', async () => {
        let parsed;
        try { parsed = JSON.parse(d); }
        catch (e) { return reject(new Error(`Sheets POST parse error (${res.statusCode}): ${d.slice(0, 200)}`)); }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const isRateLimited = res.statusCode === 429 || parsed?.error?.status === 'RESOURCE_EXHAUSTED';
          if (isRateLimited && retriesLeft > 0) {
            const waitMs = (4 - retriesLeft) * 2000 + 2000;
            console.warn(`[sheets] rate limited on ${method} ${path}, retrying in ${waitMs}ms (${retriesLeft} left)`);
            await new Promise(r => setTimeout(r, waitMs));
            try {
              resolve(await sheetsPost(token, path, body, method, retriesLeft - 1));
            } catch (err) {
              reject(err);
            }
            return;
          }
          return reject(new Error(`Sheets ${method} failed (${res.statusCode}): ${JSON.stringify(parsed).slice(0, 300)}`));
        }

        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpPost(host, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: host, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`HTTP POST parse error: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function writeRow(sheetId, tabName, rowNum, values, token) {
  const range = `${tabName}!A${rowNum}`;
  await sheetsPost(
    token,
    `/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { values: [values] },
    'PUT'
  );
}

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

module.exports = { ensureTab, appendRows, replaceRows, readRows, getSheetsToken, touchMeta };
