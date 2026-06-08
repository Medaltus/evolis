/**
 * api/advertising.js
 * GET /api/advertising?year=2026&month=5
 *
 * Returns advertising metrics for the given month using the
 * Amazon Advertising API v3 (Sponsored Products reporting).
 *
 * Advertising API base: https://advertising-api.amazon.com
 * Auth: separate LWA token (SP_AD_* env vars) + profile ID header
 *
 * Metrics returned:
 *   impressions, clicks, spend, sales (attributedSales14d), ACOS, ROAS,
 *   adUnits (attributedUnitsOrdered14d), CTR, CPC
 *
 * Response shape:
 * {
 *   current:  { impressions, clicks, spend, sales, acos, roas, adUnits, ctr, cpc }
 *   previous: { ... }
 *   mom:      { impressions, clicks, spend, acos }   ← % change
 *   daily:    [ { date: '2026-05-01', impressions, clicks, spend, sales }, ... ]
 * }
 */

const { getAdToken } = require('./_spauth');
const https = require('https');

const AD_API_HOST = 'advertising-api.amazon.com';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);

    const [current, previous] = await Promise.all([
      fetchAdMetrics(year, month),
      fetchAdMetrics(...prevMonth(year, month)),
    ]);

    const mom = computeMOM(current, previous);

    // Daily breakdown for the current month (for sparklines/charts)
    const daily = await fetchDailyBreakdown(year, month);

    res.status(200).json({ current, previous, mom, daily });
  } catch (err) {
    console.error('[api/advertising]', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Fetch aggregated metrics for a month ────────────────────────────────────

async function fetchAdMetrics(year, month) {
  const { startDate, endDate } = monthRange(year, month);
  const token = await getAdToken();

  // Request an async Sponsored Products report
  const reportBody = {
    name: `SP_${year}_${month}`,
    startDate,
    endDate,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaign'],
      columns: [
        'impressions', 'clicks', 'spend',
        'purchases14d', 'sales14d',
        'unitsSoldClicks14d',
      ],
      reportTypeId: 'spCampaigns',
      timeUnit: 'SUMMARY',
      format: 'GZIP_JSON',
    },
  };

  const createResp = await adRequest('POST', '/reporting/reports', token, reportBody);
  const reportId = createResp.reportId;

  // Poll until ready
  const reportMeta = await pollAdReport(reportId, token, 60_000);
  const rows = await downloadAdReport(reportMeta.url, token);

  // Aggregate across all campaigns
  let impressions = 0, clicks = 0, spend = 0, sales = 0, adUnits = 0;
  rows.forEach(row => {
    impressions += row.impressions || 0;
    clicks      += row.clicks      || 0;
    spend       += row.spend       || 0;
    sales       += row.sales14d    || 0;
    adUnits     += row.unitsSoldClicks14d || 0;
  });

  const acos  = sales > 0 ? round2((spend / sales) * 100) : null;
  const roas  = spend > 0 ? round2(sales / spend) : null;
  const ctr   = impressions > 0 ? round2((clicks / impressions) * 100) : 0;
  const cpc   = clicks > 0 ? round2(spend / clicks) : 0;

  return {
    year, month,
    impressions,
    clicks,
    spend: round2(spend),
    sales: round2(sales),
    acos,
    roas,
    adUnits,
    ctr,
    cpc,
  };
}

// ─── Daily breakdown for current month chart ─────────────────────────────────

async function fetchDailyBreakdown(year, month) {
  const { startDate, endDate } = monthRange(year, month);
  const token = await getAdToken();

  const reportBody = {
    name: `SP_daily_${year}_${month}`,
    startDate,
    endDate,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaign'],
      columns: ['date', 'impressions', 'clicks', 'spend', 'sales14d'],
      reportTypeId: 'spCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  };

  const createResp = await adRequest('POST', '/reporting/reports', token, reportBody);
  const reportMeta = await pollAdReport(createResp.reportId, token, 60_000);
  const rows = await downloadAdReport(reportMeta.url, token);

  // Group by date
  const byDate = {};
  rows.forEach(row => {
    const d = row.date;
    if (!byDate[d]) byDate[d] = { date: d, impressions: 0, clicks: 0, spend: 0, sales: 0 };
    byDate[d].impressions += row.impressions || 0;
    byDate[d].clicks      += row.clicks || 0;
    byDate[d].spend       += row.spend || 0;
    byDate[d].sales       += row.sales14d || 0;
  });

  return Object.values(byDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({ ...d, spend: round2(d.spend), sales: round2(d.sales) }));
}

// ─── Advertising API helpers ──────────────────────────────────────────────────

function adRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Amazon-Advertising-API-Scope': process.env.SP_AD_PROFILE_ID,
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };

    const opts = { hostname: AD_API_HOST, path, method, headers };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Ad API parse error (${res.statusCode}): ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function pollAdReport(reportId, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await adRequest('GET', `/reporting/reports/${reportId}`, token, null);
    if (resp.status === 'COMPLETED') return resp;
    if (resp.status === 'FAILED') throw new Error(`Ad report ${reportId} failed`);
    await sleep(5000);
  }
  throw new Error(`Ad report ${reportId} timed out`);
}

async function downloadAdReport(url, token) {
  // The report URL is a pre-signed S3 URL — no auth header needed
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          // Advertising API v3 reports are GZIP_JSON
          const zlib = require('zlib');
          zlib.gunzip(buf, (err, decoded) => {
            if (err) return reject(err);
            resolve(JSON.parse(decoded.toString()));
          });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthRange(year, month) {
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    startDate: `${year}${pad(month)}01`,
    endDate:   `${year}${pad(month)}${pad(lastDay)}`,
  };
}

function prevMonth(year, month) {
  return month === 1 ? [year - 1, 12] : [year, month - 1];
}

function computeMOM(cur, prev) {
  if (!prev) return null;
  const pct = (a, b) => b === 0 ? null : round2(((a - b) / b) * 100);
  return {
    impressions: pct(cur.impressions, prev.impressions),
    clicks:      pct(cur.clicks,      prev.clicks),
    spend:       pct(cur.spend,       prev.spend),
    acos:        cur.acos != null && prev.acos != null
                   ? round2(cur.acos - prev.acos)   // ACOS delta in pp, not %
                   : null,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;
