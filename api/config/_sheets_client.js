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

// ensureTab's "does this tab exist" check fetches ALL tab titles for the
// whole spreadsheet (fields=sheets.properties.title) — that result is
// identical no matter which tabName you're checking. But every caller was
// calling ensureTab once per brand tab, so a 17-brand run fires this exact
// same whole-sheet read 17 times. Confirmed as a major contributor to the
// 429 RESOURCE_EXHAUSTED on 2026-08-13 (sync-advertising-process ran
// ensureTab for every brand, twice — once per period — against the
// default 60 reads/min/service-account quota, which is shared across
// EVERY cron using this client, not just one). Caching the titles list
// per sheetId for a short TTL turns 17 reads into 1 for that lookup alone.
// TTL is deliberately short (not "for the life of the process") since
// Vercel may reuse a warm lambda across invocations and a stale cache
// could hide a tab another concurrent run just created.
const _tabTitleCache = new Map(); // sheetId -> { titles: string[], fetchedAt: number }
const TAB_TITLE_CACHE_TTL_MS = 30_000;

async function getTabTitles(sheetId, token) {
  const cached = _tabTitleCache.get(sheetId);
  if (cached && Date.now() - cached.fetchedAt < TAB_TITLE_CACHE_TTL_MS) {
    return cached.titles;
  }
  const meta = await sheetsGet(token, `/${sheetId}?fields=sheets.properties.title`);
  const titles = (meta.sheets || []).map(s => s.properties.title);
  _tabTitleCache.set(sheetId, { titles, fetchedAt: Date.now() });
  return titles;
}

function addTabToTitleCache(sheetId, tabName) {
  const cached = _tabTitleCache.get(sheetId);
  if (cached && !cached.titles.includes(tabName)) cached.titles.push(tabName);
}

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

  // Get existing sheets (cached per sheetId — see getTabTitles above)
  const titles = await getTabTitles(sheetId, token);
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
      addTabToTitleCache(sheetId, tabName);
    } catch (err) {
      // 2026-07-16 — self-heal against the exact contradiction above: if
      // Google's own error says this tab already exists, that's ground
      // truth — trust it over our own (apparently wrong) pre-check rather
      // than failing the whole sync over a tab that's actually fine. Any
      // OTHER addSheet failure still throws normally.
      if (/already exists/i.test(err.message)) {
        console.warn(`[sheets] addSheet said "${tabName}" already exists (contradicts the exists-check above — see titles logged) — continuing as if it already existed.`);
        addTabToTitleCache(sheetId, tabName);
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
 * Grows a tab's actual GRID row count (not just its data) if minRows
 * exceeds what the grid currently has. ADDED 2026-08-14 after a real
 * production failure: sync-products.js's row-position fix (switching
 * from appendRows to an explicit updateRange write, so the row number in
 * a formula string always matches the literal row being written to — see
 * that file's own comment) traded away something appendRows did for
 * free — values:append with insertDataOption=INSERT_ROWS auto-grows a
 * sheet's grid as needed, but a plain values.update PUT to an explicit
 * range does NOT. Once creme-shop's accumulated daily-snapshot rows
 * passed its grid's actual row count (10776), every subsequent write
 * failed outright with a 400 ("Range ... exceeds grid limits") — not a
 * quota issue, not a bad row number, just a grid that was never told to
 * get bigger.
 *
 * Grows with a generous buffer (not exactly enough for 1 row) so this
 * doesn't need to run again on the very next row — cheap insurance
 * against needing frequent grid-resize calls for a fast-growing tab.
 * Callers should call this ONCE per tab per run (e.g. right after
 * establishing that tab's next-row counter), not before every single row.
 */
async function ensureRowCapacity(sheetId, tabName, minRows, token) {
  const meta = await sheetsGet(token, `/${sheetId}?fields=sheets.properties`);
  const tab = (meta.sheets || []).find(s => s.properties?.title === tabName);
  if (!tab) {
    console.warn(`[sheets] ensureRowCapacity — tab "${tabName}" not found in sheet ${sheetId}, skipping grid-size check`);
    return;
  }

  const currentRows = tab.properties.gridProperties?.rowCount || 0;
  if (minRows <= currentRows) return; // already big enough, nothing to do

  const GROWTH_BUFFER = 2000;
  const newRowCount = minRows + GROWTH_BUFFER;

  await sheetsPost(token, `/${sheetId}:batchUpdate`, {
    requests: [{
      updateSheetProperties: {
        properties: {
          sheetId: tab.properties.sheetId, // the TAB's internal numeric id, not the spreadsheet id
          gridProperties: { rowCount: newRowCount },
        },
        fields: 'gridProperties.rowCount',
      },
    }],
  });
  console.log(`[sheets] grew "${tabName}" in sheet ${sheetId} from ${currentRows} to ${newRowCount} rows (needed at least ${minRows})`);
}

/**
 * Write values into an explicit range (e.g. a single column) WITHOUT
 * clearing or touching anything outside that range — unlike replaceRows,
 * which always clears A2:ZZ first. Added 2026-08-13 for a targeted,
 * column-only fix (converting sheets.orders' `date` column from
 * forced-text to a real date type via valueInputOption=USER_ENTERED)
 * where touching only column B, and nothing else, is the whole point —
 * other columns (sku, order_id, promotion_ids) must never risk being
 * reinterpreted as numbers.
 */
async function updateRange(sheetId, range, values, token, valueInputOption = 'RAW') {
  await sheetsPost(
    token,
    `/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`,
    { values },
    'PUT'
  );
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

function sheetsGet(token, path, retriesLeft = 4) {
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
          // Retry on 429 (rate limit) AND 500/INTERNAL — added 2026-07-21
          // after a real backfill run hit repeated "Internal error
          // encountered" / status:"INTERNAL" 500s that failed immediately
          // with no retry at all, since this check only covered 429
          // before. Google's own API docs describe INTERNAL as generally
          // transient and safe to retry, same reasoning as 429.
          //
          // CHANGED 2026-08-13: 3 retries topping out at a 6s wait (12s
          // total) wasn't enough headroom for a fully-drained per-minute
          // quota to reset — evolis exhausted all 3 retries and hard-
          // failed on 429, while skinuva's read moments later, given the
          // same schedule, happened to land after the window rolled over
          // and recovered. 4 retries reaching a 16s top wait (30s total)
          // gives a real shot at outlasting a full quota window without
          // costing more than one function's worth of timeout budget if
          // several tabs hit this back to back.
          // CHANGED 2026-08-14 — added 503/UNAVAILABLE after two separate
          // crons (sale-promotions, sync-walmart-inventory) both hard-
          // failed on a real Google-side 503 with zero retry, since this
          // check only covered 429/500 before. 503 is a standard,
          // well-established transient condition (Google's own API
          // client libraries universally treat it as safe to retry) —
          // same class of reasoning already applied to 429 and 500/
          // INTERNAL above, just never extended to cover this specific
          // status code until it actually happened in production.
          const isRetryable = res.statusCode === 429 || res.statusCode === 500 || res.statusCode === 503
            || parsed?.error?.status === 'RESOURCE_EXHAUSTED' || parsed?.error?.status === 'INTERNAL' || parsed?.error?.status === 'UNAVAILABLE';
          if (isRetryable && retriesLeft > 0) {
            const waitMs = Math.min(2000 * Math.pow(2, 4 - retriesLeft), 16_000); // 2s, 4s, 8s, 16s
            console.warn(`[sheets] retryable error (${res.statusCode}) on GET ${path}, retrying in ${waitMs}ms (${retriesLeft} left)`);
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

function sheetsPost(token, path, body, method = 'POST', retriesLeft = 4) {
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
          // CHANGED 2026-08-14 — see sheetsGet's identical fix above for
          // the full explanation.
          const isRetryable = res.statusCode === 429 || res.statusCode === 500 || res.statusCode === 503
            || parsed?.error?.status === 'RESOURCE_EXHAUSTED' || parsed?.error?.status === 'INTERNAL' || parsed?.error?.status === 'UNAVAILABLE';
          if (isRetryable && retriesLeft > 0) {
            const waitMs = Math.min(2000 * Math.pow(2, 4 - retriesLeft), 16_000); // 2s, 4s, 8s, 16s — see sheetsGet
            console.warn(`[sheets] retryable error (${res.statusCode}) on ${method} ${path}, retrying in ${waitMs}ms (${retriesLeft} left)`);
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

module.exports = { ensureTab, appendRows, replaceRows, readRows, updateRange, ensureRowCapacity, getSheetsToken, touchMeta };
