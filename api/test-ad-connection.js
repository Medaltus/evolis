/**
 * api/test-ad-connection.js
 * Debug endpoint — dumps raw Amazon Ads API responses at each step.
 */

const { getAdToken } = require('./_spauth');
const https          = require('https');

const AD_API_HOST = 'advertising-api.amazon.com';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const debug = {};

  // ── Step 1: LWA token ───────────────────────────────────────────────────
  let token;
  try {
    token = await getAdToken();
    debug.step1_lwa = { ok: true, tokenPrefix: token.slice(0, 20) + '...' };
  } catch (err) {
    debug.step1_lwa = { ok: false, error: err.message };
    return res.status(200).json(debug);
  }

  // ── Step 2: GET /v2/profiles — raw dump ────────────────────────────────
  // Try with no Content-Type at all on GET
  try {
    const raw = await rawRequest('GET', '/v2/profiles', token, null, null);
    debug.step2_profiles = { statusCode: raw.statusCode, headers: raw.headers, body: raw.body };
  } catch (err) {
    debug.step2_profiles = { ok: false, error: err.message };
  }

  // ── Step 3: Try /v2/profiles with Accept header ─────────────────────────
  try {
    const raw = await rawRequest('GET', '/v2/profiles', token, null, null, {
      'Accept': 'application/json',
    });
    debug.step3_profiles_with_accept = { statusCode: raw.statusCode, body: raw.body };
  } catch (err) {
    debug.step3_profiles_with_accept = { ok: false, error: err.message };
  }

  // ── Step 4: Try without Amazon-Advertising-API-ClientId header ──────────
  try {
    const raw = await rawRequest('GET', '/v2/profiles', token, null, null, {}, true);
    debug.step4_profiles_no_client_id = { statusCode: raw.statusCode, body: raw.body };
  } catch (err) {
    debug.step4_profiles_no_client_id = { ok: false, error: err.message };
  }

  return res.status(200).json(debug);
};

// Raw request — returns statusCode + full body string for debugging
function rawRequest(method, path, token, profileId, body, extraHeaders = {}, omitClientId = false) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization': `Bearer ${token}`,
      ...extraHeaders,
    }; 
    if (!omitClientId) {
      headers['Amazon-Advertising-API-ClientId'] = process.env.SP_AD_CLIENT_ID;
    }
    if (profileId) {
      headers['Amazon-Advertising-API-Scope'] = String(profileId);
    }
    if (bodyStr) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          body:       d.slice(0, 1000), // cap at 1000 chars
        });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
