/**
 * api/products.js
 * GET /api/products?year=2026&month=5&limit=10
 *
 * Returns top-selling products by units for the given month.
 * Uses the SP-API Sales & Traffic report (GET_SALES_AND_TRAFFIC_REPORT)
 * which gives us per-ASIN units ordered, ordered product sales, sessions, etc.
 *
 * Falls back to order-item aggregation if the report isn't available yet
 * (reports can have up to 72h latency for some report types).
 *
 * Response shape:
 * {
 *   products: [
 *     {
 *       rank: 1,
 *       asin: 'B0XXXXXXXX',
 *       name: 'Reverse Shampoo (Travel Size)',
 *       unitsSold: 59,
 *       revenue: 1239.41,
 *       sessions: 420,
 *       conversionRate: 14.05   ← %
 *     },
 *     ...
 *   ],
 *   reportDate: '2026-05-31',
 *   source: 'report' | 'order-aggregation'
 * }
 */

const { spRequest } = require('./_spauth');
const https = require('https');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);
    const limit = parseInt(req.query.limit || 10);

    let result;

    try {
      // Preferred: use the Sales & Traffic by ASIN report
      result = await fetchViaReport(year, month, limit);
    } catch (reportErr) {
      console.warn('[api/products] Report fetch failed, falling back to order aggregation:', reportErr.message);
      // Fallback: aggregate from order items directly
      result = await fetchViaOrders(year, month, limit);
    }

    res.status(200).json(result);
  } catch (err) {
    console.error('[api/products]', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Strategy 1: Reports API (GET_SALES_AND_TRAFFIC_REPORT) ──────────────────

async function fetchViaReport(year, month, limit) {
  const { start, end } = monthRange(year, month);

  // Step 1: Request the report
  const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
    reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
    dataStartTime: start,
    dataEndTime: end,
    marketplaceIds: [process.env.SP_MARKETPLACE_ID],
    reportOptions: { asinGranularity: 'CHILD' },
  });

  const reportId = createResp.reportId;
  if (!reportId) throw new Error('No reportId returned');

  // Step 2: Poll until report is ready (max 60s)
  const reportDoc = await pollReport(reportId, 60_000);

  // Step 3: Download the report document
  const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${reportDoc.reportDocumentId}`);
  const reportText = await downloadDocument(docResp.url);
  const reportData = JSON.parse(reportText);

  // Step 4: Parse and rank by units ordered
  const rows = reportData.salesAndTrafficByAsin || [];
  const products = rows
    .map(row => ({
      asin: row.parentAsin || row.childAsin,
      name: row.childAsin, // We'll resolve names from catalog if needed
      unitsSold: row.salesByAsin?.unitsOrdered || 0,
      revenue: round2(parseFloat(row.salesByAsin?.orderedProductSales?.amount || 0)),
      sessions: row.trafficByAsin?.sessions || 0,
      conversionRate: row.trafficByAsin?.unitSessionPercentage || 0,
    }))
    .filter(p => p.unitsSold > 0)
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, ...p }));

  // Enrich with product names from Catalog Items API
  const enriched = await enrichWithNames(products);

  return {
    products: enriched,
    reportDate: end.slice(0, 10),
    source: 'report',
  };
}

async function pollReport(reportId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
    if (resp.processingStatus === 'DONE') return resp;
    if (resp.processingStatus === 'FATAL' || resp.processingStatus === 'CANCELLED') {
      throw new Error(`Report ${reportId} failed: ${resp.processingStatus}`);
    }
    await sleep(5000);
  }
  throw new Error(`Report ${reportId} timed out after ${timeoutMs}ms`);
}

async function downloadDocument(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function enrichWithNames(products) {
  // Batch catalog lookup — up to 20 ASINs per request
  const asins = products.map(p => p.asin).filter(Boolean);
  if (!asins.length) return products;

  try {
    const resp = await spRequest('GET', '/catalog/2022-04-01/items', {
      identifiers: asins.join(','),
      identifiersType: 'ASIN',
      marketplaceIds: process.env.SP_MARKETPLACE_ID,
      includedData: 'summaries',
    });

    const nameMap = {};
    (resp.items || []).forEach(item => {
      const asin = item.asin;
      const title = item.summaries?.[0]?.itemName || asin;
      nameMap[asin] = title;
    });

    return products.map(p => ({ ...p, name: nameMap[p.asin] || p.asin }));
  } catch {
    return products; // non-fatal — return with ASIN as name
  }
}

// ─── Strategy 2: Aggregate from Orders API (fallback) ────────────────────────

async function fetchViaOrders(year, month, limit) {
  const { start, end } = monthRange(year, month);
  const orders = await paginateOrders(start, end);

  // Fetch items for all orders in batches
  const itemBatches = await batchFetch(
    orders.map(o => o.AmazonOrderId),
    async (orderId) => {
      const resp = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`);
      return resp.payload?.OrderItems || [];
    },
    10
  );

  // Aggregate by ASIN
  const asinMap = {};
  itemBatches.flat().forEach(item => {
    const asin = item.ASIN;
    if (!asin) return;
    if (!asinMap[asin]) {
      asinMap[asin] = { asin, name: item.Title || asin, unitsSold: 0, revenue: 0, sessions: null, conversionRate: null };
    }
    asinMap[asin].unitsSold += item.QuantityOrdered || 0;
    asinMap[asin].revenue = round2(
      asinMap[asin].revenue + parseFloat(item.ItemPrice?.Amount || 0) * (item.QuantityOrdered || 0)
    );
  });

  const products = Object.values(asinMap)
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, ...p }));

  return {
    products,
    reportDate: end.slice(0, 10),
    source: 'order-aggregation',
  };
}

async function paginateOrders(start, end) {
  const orders = [];
  let nextToken = null;
  do {
    const query = nextToken
      ? { NextToken: nextToken }
      : { MarketplaceIds: process.env.SP_MARKETPLACE_ID, CreatedAfter: start, CreatedBefore: end, MaxResultsPerPage: '100' };
    const resp = await spRequest('GET', '/orders/v0/orders', query);
    orders.push(...(resp.payload?.Orders || []));
    nextToken = resp.payload?.NextToken || null;
  } while (nextToken);
  return orders;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthRange(year, month) {
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${pad(month)}-01T00:00:00Z`,
    end:   `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z`,
  };
}

async function batchFetch(ids, fn, size) {
  const results = [];
  for (let i = 0; i < ids.length; i += size) {
    const batch = await Promise.all(ids.slice(i, i + size).map(fn));
    results.push(...batch);
    if (i + size < ids.length) await sleep(1000);
  }
  return results;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;
