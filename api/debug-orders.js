/**
 * api/debug-orders.js — lightweight SKU audit
 * Fetches items for only the first 20 orders to identify SKU prefixes.
 * DELETE after debugging.
 */

const https  = require('https');
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const lwaToken = await getLWAToken();

    // Just fetch first page of orders — no pagination, no date filter
    const now        = new Date();
    const thirtyAgo  = new Date(now); thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    const query = {
      MarketplaceIds:    process.env.SP_MARKETPLACE_ID,
      CreatedAfter:      thirtyAgo.toISOString().slice(0,10) + 'T00:00:00Z',
      CreatedBefore:     fiveMinAgo.toISOString().slice(0,19) + 'Z',
      MaxResultsPerPage: '20',
      OrderStatuses:     'Pending,Unshipped,PartiallyShipped,Shipped,InvoiceUnconfirmed,Unfulfillable',
    };

    const qs   = '?' + new URLSearchParams(query).toString();
    const hdrs = sign('GET', 'sellingpartnerapi-na.amazon.com', '/orders/v0/orders' + qs, '', lwaToken);
    const resp = await httpGetJSON('sellingpartnerapi-na.amazon.com', '/orders/v0/orders' + qs, hdrs);
    const orders = resp.payload?.Orders || [];

    // Fetch items for first 10 orders only
    const skuMap    = {};
    const prefixMap = {};

    for (const order of orders.slice(0, 10)) {
      try {
        const path  = `/orders/v0/orders/${order.AmazonOrderId}/orderItems`;
        const ihdrs = sign('GET', 'sellingpartnerapi-na.amazon.com', path, '', lwaToken);
        const iresp = await httpGetJSON('sellingpartnerapi-na.amazon.com', path, ihdrs);
        const items = iresp.payload?.OrderItems || [];

        items.forEach(item => {
          const sku    = item.SellerSKU || 'UNKNOWN';
          const prefix = sku.slice(0, 3).toUpperCase();
          if (!skuMap[sku]) skuMap[sku] = { prefix, count: 0, title: item.Title?.slice(0, 50) };
          skuMap[sku].count++;
          prefixMap[prefix] = (prefixMap[prefix] || 0) + 1;
        });
      } catch (e) {
        console.warn('items failed:', e.message);
      }
      await sleep(300);
    }

    const prefixSummary = Object.entries(prefixMap)
      .sort((a,b) => b[1] - a[1])
      .map(([prefix, count]) => ({ prefix, count }));

    const evoSkus = Object.entries(skuMap)
      .filter(([sku]) => sku.toUpperCase().startsWith('EVO'))
      .map(([sku, d]) => ({ sku, ...d }));

    res.status(200).json({
      ordersFound:   orders.length,
      sampledOrders: Math.min(orders.length, 10),
      prefixSummary,
      evoSkus,
      allSkus: Object.entries(skuMap)
        .sort((a,b) => b[1].count - a[1].count)
        .map(([sku, d]) => ({ sku, ...d })),
    });

  } catch (err) {
    console.error('[debug-orders]', err);
    res.status(500).json({ error: err.message });
  }
};

async function getLWAToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token', client_id: process.env.SP_CLIENT_ID,
    client_secret: process.env.SP_CLIENT_SECRET, refresh_token: process.env.SP_REFRESH_TOKEN,
  }).toString();
  const data = await httpPostJSON('api.amazon.com', '/auth/o2/token', body, { 'Content-Type': 'application/x-www-form-urlencoded' });
  if (data.error) throw new Error(`LWA: ${data.error}`);
  return data.access_token;
}

function sign(method, host, fullPath, body, lwaToken) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g,'').slice(0,15)+'Z';
  const dateStamp = amzDate.slice(0,8);
  const [pathOnly, qs=''] = fullPath.split('?');
  const canonicalQS = qs.split('&').filter(Boolean).sort().join('&');
  const payloadHash = crypto.createHash('sha256').update(body||'').digest('hex');
  const headers = { host, 'x-amz-access-token': lwaToken, 'x-amz-date': amzDate };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k=>`${k}:${headers[k]}`).join('\n')+'\n';
  const signedHeadersStr = sortedKeys.join(';');
  const canonicalRequest = [method,pathOnly,canonicalQS,canonicalHeaders,signedHeadersStr,payloadHash].join('\n');
  const credScope = `${dateStamp}/us-east-1/execute-api/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256',amzDate,credScope,crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4'+process.env.SP_AWS_SECRET_KEY,dateStamp),'us-east-1'),'execute-api'),'aws4_request');
  const signature = crypto.createHmac('sha256',signingKey).update(stringToSign).digest('hex');
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${process.env.SP_AWS_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`, 'Content-Type': 'application/json' };
}

function hmac(key, data) { return crypto.createHmac('sha256',key).update(data).digest(); }

function httpGetJSON(host, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method: 'GET', headers }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,200)));} });
    });
    req.on('error', reject); req.end();
  });
}

function httpPostJSON(host, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = { hostname:host, path, method:'POST', headers:{...headers,'Content-Length':Buffer.byteLength(body)} };
    const req = https.request(opts, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,200)));} });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
