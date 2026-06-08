/**
 * _spauth.js
 * Shared Amazon SP-API authentication helper.
 * Handles LWA (Login with Amazon) token refresh and request signing (AWS SigV4).
 *
 * Required Vercel environment variables:
 *   SP_CLIENT_ID          — LWA app client ID
 *   SP_CLIENT_SECRET      — LWA app client secret
 *   SP_REFRESH_TOKEN      — Seller's refresh token (from SP-API app authorization)
 *   SP_AWS_ACCESS_KEY     — IAM user access key (must have SP-API role)
 *   SP_AWS_SECRET_KEY     — IAM user secret key
 *   SP_AWS_ROLE_ARN       — ARN of the IAM role to assume (SellingPartnerAPIRole)
 *   SP_MARKETPLACE_ID     — e.g. ATVPDKIKX0DER (US), A2EUQ1WTGCTBG2 (CA)
 *   SP_SELLER_ID          — Your seller/merchant ID
 *   SP_AD_CLIENT_ID       — Advertising API client ID (can be same as SP_CLIENT_ID)
 *   SP_AD_CLIENT_SECRET   — Advertising API client secret
 *   SP_AD_REFRESH_TOKEN   — Advertising API refresh token
 *   SP_AD_PROFILE_ID      — Advertising profile ID for this account
 */

const https = require('https');
const crypto = require('crypto');

// ─── In-memory token cache ───────────────────────────────────────────────────
const tokenCache = {};

/**
 * Get a fresh LWA access token, using cache if still valid.
 */
async function getLWAToken(clientId, clientSecret, refreshToken, cacheKey) {
  const now = Date.now();
  if (tokenCache[cacheKey] && tokenCache[cacheKey].expiresAt > now + 60_000) {
    return tokenCache[cacheKey].token;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();

  const data = await httpPost('api.amazon.com', '/auth/o2/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  tokenCache[cacheKey] = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return data.access_token;
}

/**
 * Get SP-API access token (LWA).
 */
async function getSPToken() {
  return getLWAToken(
    process.env.SP_CLIENT_ID,
    process.env.SP_CLIENT_SECRET,
    process.env.SP_REFRESH_TOKEN,
    'sp'
  );
}

/**
 * Get Advertising API access token (LWA).
 */
async function getAdToken() {
  return getLWAToken(
    process.env.SP_AD_CLIENT_ID,
    process.env.SP_AD_CLIENT_SECRET,
    process.env.SP_AD_REFRESH_TOKEN,
    'ad'
  );
}

/**
 * Get temporary AWS credentials via STS AssumeRole.
 * Cached for the duration of the session credentials (~1h).
 */
async function getSTSCredentials() {
  const now = Date.now();
  if (tokenCache.sts && tokenCache.sts.expiresAt > now + 60_000) {
    return tokenCache.sts.creds;
  }

  const region = 'us-east-1';
  const service = 'sts';
  const host = 'sts.amazonaws.com';
  const params = new URLSearchParams({
    Action: 'AssumeRole',
    RoleArn: process.env.SP_AWS_ROLE_ARN,
    RoleSessionName: 'EvolisSpApi',
    DurationSeconds: '3600',
    Version: '2011-06-15',
  });

  const queryStr = params.toString();
  const endpoint = `/?${queryStr}`;
  const headers = signRequest(
    'GET', host, endpoint, '', '',
    process.env.SP_AWS_ACCESS_KEY,
    process.env.SP_AWS_SECRET_KEY,
    region, service
  );

  const xml = await httpGetRaw(host, endpoint, headers);

  // Parse XML manually (avoid external deps)
  const extract = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    return m ? m[1] : null;
  };

  const creds = {
    accessKeyId: extract('AccessKeyId'),
    secretAccessKey: extract('SecretAccessKey'),
    sessionToken: extract('SessionToken'),
    expiration: extract('Expiration'),
  };

  tokenCache.sts = {
    creds,
    expiresAt: new Date(creds.expiration).getTime(),
  };
  return creds;
}

/**
 * Make a signed SP-API request.
 * @param {string} method  - GET | POST | etc.
 * @param {string} path    - e.g. /orders/v0/orders
 * @param {object} query   - query string params object
 * @param {object} body    - request body (for POST)
 */
async function spRequest(method, path, query = {}, body = null) {
  const region = 'us-east-1';
  const service = 'execute-api';
  const host = 'sellingpartnerapi-na.amazon.com';

  const [spToken, stsCreds] = await Promise.all([getSPToken(), getSTSCredentials()]);

  const qs = Object.keys(query).length
    ? '?' + new URLSearchParams(query).toString()
    : '';
  const fullPath = path + qs;
  const bodyStr = body ? JSON.stringify(body) : '';

  const extraHeaders = {
    'x-amz-access-token': spToken,
    'x-amz-security-token': stsCreds.sessionToken,
  };

  const signedHeaders = signRequest(
    method, host, fullPath, bodyStr,
    stsCreds.sessionToken,
    stsCreds.accessKeyId,
    stsCreds.secretAccessKey,
    region, service,
    extraHeaders
  );

  const data = await httpRequest(method, host, fullPath, signedHeaders, bodyStr);
  return data;
}

// ─── AWS SigV4 ────────────────────────────────────────────────────────────────

function signRequest(method, host, fullPath, body, sessionToken,
  accessKey, secretKey, region, service, extra = {}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const [pathOnly, queryStr = ''] = fullPath.split('?');
  const canonicalQueryString = queryStr
    .split('&')
    .filter(Boolean)
    .sort()
    .join('&');

  const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');

  const headers = {
    host,
    'x-amz-date': amzDate,
    ...extra,
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeadersStr = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method, pathOnly, canonicalQueryString,
    canonicalHeaders, signedHeadersStr, payloadHash,
  ].join('\n');

  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  return {
    ...headers,
    Authorization: authHeader,
    'Content-Type': 'application/json',
  };
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpPost(host, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: host, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`LWA parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGetRaw(host, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpRequest(method, host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: host, path, method,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body || '') },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`SP-API parse error (${res.statusCode}): ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { spRequest, getAdToken };
