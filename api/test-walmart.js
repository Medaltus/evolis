/**
 * api/test-walmart.js
 * Debug endpoint — tests Walmart Marketplace API auth and pulls raw data
 * so we can see exactly what's available before building the real sync.
 *
 * GET /api/test-walmart?endpoint=orders
 * GET /api/test-walmart?endpoint=items
 * GET /api/test-walmart?endpoint=inventory
 * GET /api/test-walmart?endpoint=token   (just tests auth)
 *
 * Authorization: Bearer <CRON_SECRET>
 */

const https = require('https');

const WM_HOST         = 'marketplace.walmartapis.com';
const WM_TOKEN_PATH   = '/v3/token';
const WM_ORDERS_PATH  = '/v3/orders?createdStartDate=2026-05-01&limit=10';
const WM_ITEMS_PATH   = '/v3/items?limit=10';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const endpoint = req.query.endpoint || 'token';

  try {
    // ── Step 1: Get OAuth token ─────────────────────────────────────────────
    console.log('[test-walmart] requesting token...');
    const token = await getWalmartToken();
    console.log('[test-walmart] token obtained:', token.slice(0, 20) + '...');

    if (endpoint === 'token') {
      return res.status(200).json({ 
        success: true, 
        message: 'Auth successful',
        tokenPreview: token.slice(0, 20) + '...',
      });
    }

    // ── Step 2: Call requested endpoint ────────────────────────────────────
    let path;
    if (endpoint === 'orders')    path = WM_ORDERS_PATH;
    else if (endpoint === 'items') path = WM_ITEMS_PATH;
    else return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });

    console.log(`[test-walmart] calling ${path}...`);
    const data = await wmRequest('GET', path, token);

    return res.status(200).json({ 
      endpoint,
      raw: data,
    });

  } catch (err) {
    console.error('[test-walmart] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Get Walmart OAuth token ───────────────────────────────────────────────────
function getWalmartToken() {
  return new Promise((resolve, reject) => {
    const clientId     = process.env.WALMART_CLIENT_ID;
    const clientSecret = process.env.WALMART_CLIENT_SECRET;
    const partnerId    = process.env.WALMART_PARTNER_ID;

    if (!clientId || !clientSecret) {
      return reject(new Error('WALMART_CLIENT_ID or WALMART_CLIENT_SECRET not set'));
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body        = 'grant_type=client_credentials';

    const headers = {
      'Authorization':      `Basic ${credentials}`,
      'Content-Type':       'application/x-www-form-urlencoded',
      'WM_SVC.NAME':        'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `debug-${Date.now()}`,
      'Accept':             'application/json',
      'Content-Length':     Buffer.byteLength(body),
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const reqOpts = {
      hostname: WM_HOST,
      path:     WM_TOKEN_PATH,
      method:   'POST',
      headers,
    };

    const request = https.request(reqOpts, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.access_token) {
            resolve(parsed.access_token);
          } else {
            reject(new Error(`Token error: ${JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(new Error(`Token parse error (${httpRes.statusCode}): ${d.slice(0, 300)}`));
        }
      });
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

// ── Make authenticated Walmart API request ────────────────────────────────────
function wmRequest(method, path, token) {
  return new Promise((resolve, reject) => {
    const partnerId = process.env.WALMART_PARTNER_ID;

    const headers = {
      'Authorization':      `Bearer ${token}`,
      'WM_SVC.NAME':        'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `debug-${Date.now()}`,
      'Accept':             'application/json',
      'Content-Type':       'application/json',
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const reqOpts = {
      hostname: WM_HOST,
      path,
      method,
      headers,
    };

    const request = https.request(reqOpts, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(new Error(`Parse error (${httpRes.statusCode}): ${d.slice(0, 300)}`));
        }
      });
    });

    request.on('error', reject);
    request.end();
  });
}
