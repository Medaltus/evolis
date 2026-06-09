/**
 * api/debug-orders.js
 * Verbose debug endpoint — logs every step so we can see exactly where auth fails.
 * DELETE after debugging is complete.
 */

const https  = require('https');
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = [];
  const step = (msg, data) => {
    console.log(msg, data || '');
    log.push({ step: msg, ...(data || {}) });
  };

  try {
    // ── Step 1: Check env vars are present ──────────────────────────────────
    step('1. Checking env vars', {
      SP_CLIENT_ID:       present(process.env.SP_CLIENT_ID),
      SP_CLIENT_SECRET:   present(process.env.SP_CLIENT_SECRET),
      SP_REFRESH_TOKEN:   present(process.env.SP_REFRESH_TOKEN),
      SP_AWS_ACCESS_KEY:  present(process.env.SP_AWS_ACCESS_KEY),
      SP_AWS_SECRET_KEY:  present(process.env.SP_AWS_SECRET_KEY),
      SP_AWS_ROLE_ARN:    present(process.env.SP_AWS_ROLE_ARN),
      SP_MARKETPLACE_ID:  process.env.SP_MARKETPLACE_ID || 'MISSING',
      SP_SELLER_ID:       process.env.SP_SELLER_ID      || 'MISSING',
    });

    // ── Step 2: Get LWA access token ─────────────────────────────────────────
    step('2. Requesting LWA token...');
    let lwaToken;
    try {
      const lwaResp = await httpPost('api.amazon.com', '/auth/o2/token',
        new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     process.env.SP_CLIENT_ID,
          client_secret: process.env.SP_CLIENT_SECRET,
          refresh_token: process.env.SP_REFRESH_TOKEN,
        }).toString(),
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );
      if (lwaResp.error) {
        step('2. LWA FAILED', { error: lwaResp.error, description: lwaResp.error_description });
        return res.status(200).json({ success: false, log });
      }
      lwaToken = lwaResp.access_token;
      step('2. LWA token OK', { expires_in: lwaResp.expires_in });
    } catch (e) {
      step('2. LWA EXCEPTION', { error: e.message });
      return res.status(200).json({ success: false, log });
    }

    // ── Step 3: Try WITHOUT STS (direct IAM signing like coworker's script) ──
    step('3. Trying direct IAM signing (no STS role assumption)...');
    let ordersResp;
    try {
      const now      = new Date();
      const pad      = n => String(n).padStart(2, '0');
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 7);
      const start = `${yesterday.getFullYear()}-${pad(yesterday.getMonth()+1)}-${pad(yesterday.getDate())}T00:00:00Z`;
      const end   = now.toISOString().slice(0,10) + 'T23:59:59Z';

      const query = new URLSearchParams({
        MarketplaceIds:    process.env.SP_MARKETPLACE_ID,
        CreatedAfter:      start,
        CreatedBefore:     end,
        MaxResultsPerPage: '5',
        OrderStatuses:     'Pending,Unshipped,PartiallyShipped,Shipped,InvoiceUnconfirmed,Unfulfillable',
      });

      const path     = `/orders/v0/orders?${query.toString()}`;
      const headers  = signDirect(
        'GET',
        'sellingpartnerapi-na.amazon.com',
        path,
        '',
        process.env.SP_AWS_ACCESS_KEY,
        process.env.SP_AWS_SECRET_KEY,
        lwaToken
      );

      ordersResp = await httpGetRaw('sellingpartnerapi-na.amazon.com', path, headers);
      const parsed = JSON.parse(ordersResp);

      if (parsed.errors) {
        step('3. Orders API returned errors', { errors: parsed.errors });
      } else {
        const orders = parsed.payload?.Orders || [];
        step('3. Orders API SUCCESS (direct IAM)', {
          ordersFound: orders.length,
          sampleOrderIds: orders.slice(0,3).map(o => o.AmazonOrderId),
          sampleSKUs: [],
        });

        // Fetch items for first order to check SKUs
        if (orders.length > 0) {
          const firstOrder = orders[0];
          const itemsPath  = `/orders/v0/orders/${firstOrder.AmazonOrderId}/orderItems`;
          const itemHeaders = signDirect(
            'GET', 'sellingpartnerapi-na.amazon.com', itemsPath, '',
            process.env.SP_AWS_ACCESS_KEY, process.env.SP_AWS_SECRET_KEY, lwaToken
          );
          const itemsRaw  = await httpGetRaw('sellingpartnerapi-na.amazon.com', itemsPath, itemHeaders);
          const itemsParsed = JSON.parse(itemsRaw);
          const items = itemsParsed.payload?.OrderItems || [];
          step('3b. First order items', {
            orderId: firstOrder.AmazonOrderId,
            date:    firstOrder.PurchaseDate?.slice(0,10),
            status:  firstOrder.OrderStatus,
            items:   items.map(i => ({ sku: i.SellerSKU, asin: i.ASIN, qty: i.QuantityOrdered, title: i.Title?.slice(0,50) })),
          });
        }
      }
    } catch (e) {
      step('3. Direct IAM EXCEPTION', { error: e.message });
    }

    // ── Step 4: Try WITH STS role assumption (our current approach) ──────────
    if (process.env.SP_AWS_ROLE_ARN) {
      step('4. Trying STS AssumeRole...');
      try {
        const stsResp = await httpGetRaw(
          'sts.amazonaws.com',
          `/?Action=AssumeRole&RoleArn=${encodeURIComponent(process.env.SP_AWS_ROLE_ARN)}&RoleSessionName=DebugSession&DurationSeconds=3600&Version=2011-06-15`,
          signDirect('GET', 'sts.amazonaws.com',
            `/?Action=AssumeRole&RoleArn=${encodeURIComponent(process.env.SP_AWS_ROLE_ARN)}&RoleSessionName=DebugSession&DurationSeconds=3600&Version=2011-06-15`,
            '', process.env.SP_AWS_ACCESS_KEY, process.env.SP_AWS_SECRET_KEY, null, 'sts', 'us-east-1'
          )
        );
        if (stsResp.includes('AssumeRoleResult')) {
          step('4. STS AssumeRole SUCCESS');
        } else if (stsResp.includes('Error')) {
          const code = stsResp.match(/<Code>(.*?)<\/Code>/)?.[1] || 'unknown';
          const msg  = stsResp.match(/<Message>(.*?)<\/Message>/)?.[1] || stsResp.slice(0,200);
          step('4. STS AssumeRole FAILED', { code, message: msg });
        }
      } catch (e) {
        step('4. STS EXCEPTION', { error: e.message });
      }
    } else {
      step('4. Skipping STS — SP_AWS_ROLE_ARN not set');
    }

    res.status(200).json({ success: true, log });

  } catch (err) {
    console.error('[debug-orders]', err);
    res.status(500).json({ error: err.message, log });
  }
};

// ── Direct IAM SigV4 (no STS) ────────────────────────────────────────────────
function signDirect(method, host, fullPath, body, accessKey, secretKey, lwaToken, service = 'execute-api', region = 'us-east-1') {
  const now    = new Date();
  const amzDate  = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const [pathOnly, queryStr = ''] = fullPath.split('?');

  const canonicalQS = queryStr.split('&').filter(Boolean).sort().join('&');
  const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');

  const headers = { 'host': host, 'x-amz-date': amzDate };
  if (lwaToken) headers['x-amz-access-token'] = lwaToken;

  const sortedKeys      = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeadersStr = sortedKeys.join(';');

  const canonicalRequest = [method, pathOnly, canonicalQS, canonicalHeaders, signedHeadersStr, payloadHash].join('\n');
  const credScope        = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign     = ['AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service), 'aws4_request');
  const signature  = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

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
    const opts = { hostname: host, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } };
    const req  = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,200))); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGetRaw(host, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method: 'GET', headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.end();
  });
}

const present = v => v ? `SET (${v.slice(0,8)}...)` : 'MISSING';
