/**
 * api/test-walmart.js
 * Debug endpoint — tests Walmart Marketplace API auth and pulls raw data.
 *
 * GET /api/test-walmart?endpoint=token
 * GET /api/test-walmart?endpoint=orders
 * GET /api/test-walmart?endpoint=items
 */

const https = require('https');

const WM_HOST        = 'marketplace.walmartapis.com';
const WM_TOKEN_PATH  = '/v3/token';
const WM_ORDERS_PATH = '/v3/orders?createdStartDate=2026-05-01&limit=10';
const WM_ITEMS_PATH  = '/v3/items?limit=10';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const endpoint = req.query.endpoint || 'token';

  const clientId     = process.env.WALMART_CLIENT_ID;
  const clientSecret = process.env.WALMART_CLIENT_SECRET;
  const partnerId    = process.env.WALMART_PARTNER_ID;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'WALMART_CLIENT_ID or WALMART_CLIENT_SECRET not set' });
  }

  try {
    // ── Step 1: Get OAuth token ─────────────────────────────────────────────
    console.log('[test-walmart] requesting token...');
    const tokenData = await getWalmartToken(clientId, clientSecret, partnerId);
    console.log('[test-walmart] token response keys:', Object.keys(tokenData));

    if (endpoint === 'token') {
      return res.status(200).json({ success: true, tokenData });
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(500).json({ error: 'No access_token in response', tokenData });
    }

    if (endpoint === 'order') {
      const orderId = req.query.orderId;
      if (!orderId) return res.status(400).json({ error: 'orderId required' });
      const data = await wmRequest('GET', `/v3/orders/${orderId}`, token);
      return res.status(200).json({ endpoint, raw: data });
    }
    if (endpoint === 'orders')     path = WM_ORDERS_PATH;
    else if (endpoint === 'items') path = WM_ITEMS_PATH;
    else return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });

    console.log(`[test-walmart] calling ${path}...`);
    const data = await wmRequest('GET', path, accessToken, clientId, partnerId);

    return res.status(200).json({ endpoint, raw: data });

  } catch (err) {
    console.error('[test-walmart] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function getWalmartToken(clientId, clientSecret, partnerId) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body        = 'grant_type=client_credentials';

    const headers = {
      'Authorization':         `Basic ${credentials}`,
      'Content-Type':          'application/x-www-form-urlencoded',
      'Accept':                'application/json',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `token-${Date.now()}`,
      'WM_SVC.VERSION':        '1.0.0',
      'Content-Length':        Buffer.byteLength(body),
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const req = https.request({ hostname: WM_HOST, path: WM_TOKEN_PATH, method: 'POST', headers }, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Token parse error (${httpRes.statusCode}): ${d.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function wmRequest(method, path, accessToken, clientId, partnerId) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization':         `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
      'WM_SEC.ACCESS_TOKEN':   accessToken,
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `req-${Date.now()}`,
      'WM_SVC.VERSION':        '1.0.0',
      'Accept':                'application/json',
      'Content-Type':          'application/json',
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const req = https.request({ hostname: WM_HOST, path, method, headers }, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error (${httpRes.statusCode}): ${d.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
