/**
 * api/_spauth.js
 * Shared Amazon SP-API authentication helper.
 * Signs requests directly with IAM user credentials (no STS AssumeRole).
 * Matches the auth pattern used in fetch_total_sales.py.
 *
 * Required Vercel environment variables:
 *   SP_CLIENT_ID          — LWA app client ID
 *   SP_CLIENT_SECRET      — LWA app client secret
 *   SP_REFRESH_TOKEN      — Seller's refresh token (Atzr|...)
 *   SP_AWS_ACCESS_KEY     — IAM user access key
 *   SP_AWS_SECRET_KEY     — IAM user secret key
 *   SP_MARKETPLACE_ID     — e.g. ATVPDKIKX0DER (US)
 *
 *   SP_AD_CLIENT_ID       — Advertising API client ID
 *   SP_AD_CLIENT_SECRET   — Advertising API client secret
 *   SP_AD_REFRESH_TOKEN   — Advertising API refresh token
 *   SP_AD_PROFILE_ID      — Advertising profile ID
 */

const https  = require('https');
const crypto = require('crypto');

// ── Retry for transient network errors ─────────────────────────────────────
// Added 2026-09-02 — a single ECONNRESET (or similar connection blip between
// Vercel and Amazon) used to fail the whole request immediately, with no
// retry at any layer. For a cron that only runs every few hours, that meant
// a brief network hiccup cost a full cycle before the next attempt, rather
// than being absorbed within the same run. Applies to BOTH the LWA token
// fetch (httpPost) and the actual SP-API call (httpRequest), so every caller
// of spRequest()/getAdToken() gets this without any change on their end.
//
// Only retries genuine transport-level errors (connection reset, timeout,
// refused, broken pipe, DNS blip) — never a parsed API error response (a
// 429 or 5xx from Amazon still resolves/rejects exactly as before; this
// doesn't change that behavior, see the note on httpRequest below).
//
// Worth knowing: a report-request POST isn't guaranteed idempotent — if an
// ECONNRESET happens after Amazon already processed the request but before
// the response made it back, a retry could occasionally cause a duplicate
// report request. Low-stakes here (an unused extra report, not a real
// side effect like a duplicate order/charge), so the tradeoff still clearly
// favors retrying over failing outright and waiting for the next scheduled
// run.
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN']);
const MAX_RETRIES    = 2;          // 3 attempts total
const RETRY_DELAYS_MS = [500, 1500]; // backoff before attempt 2 and 3
const REQUEST_TIMEOUT_MS = 30000;   // convert a hung socket into a retryable timeout error

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = RETRYABLE_ERROR_CODES.has(err.code);
      if (!retryable || attempt === MAX_RETRIES) throw err;
      console.warn(`[_spauth] ${label} — ${err.code}, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`);
      await sleep(RETRY_DELAYS_MS[attempt] || 1500);
    }
  }
  throw lastErr;
}

// ── Token cache ───────────────────────────────────────────────────────────────
const tokenCache = {};

async function getLWAToken(clientId, clientSecret, refreshToken, cacheKey) {
  const now = Date.now();
  if (tokenCache[cacheKey]?.expiresAt > now + 60_000) {
    return tokenCache[cacheKey].token;
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();

  const data = await httpPost('api.amazon.com', '/auth/o2/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  if (data.error) {
    throw new Error(`LWA error: ${data.error} — ${data.error_description}`);
  }

  tokenCache[cacheKey] = {
    token:     data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return tokenCache[cacheKey].token;
}

async function getSPToken() {
  return getLWAToken(
    process.env.SP_CLIENT_ID,
    process.env.SP_CLIENT_SECRET,
    process.env.SP_REFRESH_TOKEN,
    'sp'
  );
}

async function getAdToken() {
  return getLWAToken(
    process.env.SP_AD_CLIENT_ID,
    process.env.SP_AD_CLIENT_SECRET,
    process.env.SP_AD_REFRESH_TOKEN,
    'ad'
  );
}

/**
 * Make a signed SP-API request using direct IAM signing (no STS).
 */
async function spRequest(method, path, query = {}, body = null) {
  const host     = 'sellingpartnerapi-na.amazon.com';
  const spToken  = await getSPToken();
  const bodyStr  = body ? JSON.stringify(body) : '';
  const qs       = Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
  const fullPath = path + qs;

  const headers  = signRequest(
    method, host, fullPath, bodyStr,
    process.env.SP_AWS_ACCESS_KEY,
    process.env.SP_AWS_SECRET_KEY,
    spToken,
    'execute-api',
    'us-east-1'
  );

  return httpRequest(method, host, fullPath, headers, bodyStr);
}

// ── AWS SigV4 (direct IAM — no session token) ─────────────────────────────────
function signRequest(method, host, fullPath, body, accessKey, secretKey, lwaToken, service, region) {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const [pathOnly, queryStr = ''] = fullPath.split('?');
  const canonicalQS = queryStr.split('&').filter(Boolean).sort().join('&');
  const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');

  const headers = {
    'host':                host,
    'x-amz-access-token':  lwaToken,
    'x-amz-date':          amzDate,
  };

  const sortedKeys       = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeadersStr = sortedKeys.join(';');

  const canonicalRequest = [
    method, pathOnly, canonicalQS,
    canonicalHeaders, signedHeadersStr, payloadHash,
  ].join('\n');

  const credScope    = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...headers,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`,
    'Content-Type':  'application/json',
  };
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpPost(host, path, body, headers) {
  return withRetry(() => new Promise((resolve, reject) => {
    const opts = {
      hostname: host, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,200))); } });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const timeoutErr = new Error(`LWA token request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      timeoutErr.code = 'ETIMEDOUT';
      req.destroy(timeoutErr);
    });
    req.write(body);
    req.end();
  }), 'LWA token request');
}

function httpRequest(method, host, path, headers, body) {
  return withRetry(() => new Promise((resolve, reject) => {
    const opts = {
      hostname: host, path, method,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body || '') },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(`SP-API parse error (${res.statusCode}): ${d.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const timeoutErr = new Error(`SP-API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      timeoutErr.code = 'ETIMEDOUT';
      req.destroy(timeoutErr);
    });
    if (body) req.write(body);
    req.end();
  }), 'SP-API request');
}

module.exports = { spRequest, getAdToken };
