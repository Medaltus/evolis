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
  return new Promise((resolve, reject) => {
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
    req.write(body);
    req.end();
  });
}

function httpRequest(method, host, path, headers, body) {
  return new Promise((resolve, reject) => {
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
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { spRequest, getAdToken };
