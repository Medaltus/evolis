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
 */
async function ensureTab(sheetId, tabName, headers) {
  const token = await getSheetsToken();

  // Get existing sheets
  const meta = await sheetsGet(token, `/${sheetId}?fields=sheets.properties.title`);
  const exists = (meta.sheets || []).some(s => s.properties.title === tabName);

  if (!exists) {
    // Add the sheet tab
    await sheetsPost(token, `/${sheetId}:batchUpdate`, {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    });
    // Write headers on row 1
    await writeRow(sheetId, tabName, 1, headers, token);
    console.log(`[sheets] created tab "${tabName}" in sheet ${sheetId}`);
  }

  return token;
}

/**
 * Append rows to a tab. Rows is an array of arrays.
 */
async function appendRows(sheetId, tabName, rows, token) {
  if (!rows.length) return;
  const range = `${tabName}!A1`;
  await sheetsPost(
    token,
    `/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
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
async function readRows(sheetId, tabName) {
  const token = await getSheetsToken();
  const range = encodeURIComponent(`${tabName}!A1:ZZ`);
  const data  = await sheetsGet(token, `/${sheetId}/values/${range}`);
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

function sheetsGet(token, path) {
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
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Sheets GET parse error: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sheetsPost(token, path, body, method = 'POST') {
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
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Sheets POST parse error (${res.statusCode}): ${d.slice(0, 200)}`)); }
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
