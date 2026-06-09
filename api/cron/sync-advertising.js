/**
 * api/cron/sync-advertising.js
 * Nightly cron — syncs Amazon Advertising metrics to Google Sheets.
 * Runs at 3:00 AM UTC.
 *
 * Sheet: amazon-advertising
 * Columns: year, month, impressions, clicks, spend, sales,
 *          acos, roas, ad_units, ctr, cpc, brand, last_updated
 */

const { getAdToken }                             = require('../_spauth');
const { ensureTab, replaceRows, getSheetsToken } = require('../config/_sheets_client');
const brands                                     = require('../config/brands');
const sheets                                     = require('../config/sheets');
const https                                      = require('https');
const zlib                                       = require('zlib');

const AD_API_HOST = 'advertising-api.amazon.com';

const HEADERS = [
  'year', 'month', 'impressions', 'clicks', 'spend', 'sales',
  'acos', 'roas', 'ad_units', 'ctr', 'cpc', 'brand', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      console.log(`[sync-advertising] starting ${brand.id}`);
      const rows  = await fetchAdRows(brand);
      const token = await ensureTab(sheets.advertising, brand.tabName, HEADERS);
      await replaceRows(sheets.advertising, brand.tabName, HEADERS, rows, token);
      results.push({ brand: brand.id, status: 'ok', rows: rows.length });
      console.log(`[sync-advertising] ${brand.id} — ${rows.length} rows written`);
    } catch (err) {
      console.error(`[sync-advertising] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: new Date().toISOString() });
};

async function fetchAdRows(brand) {
  const rows   = [];
  const months = rollingMonths(13);
  const now    = new Date().toISOString();
  const token  = await getAdToken();

  for (const { year, month, startDate, endDate } of months) {
    try {
      const reportBody = {
        name: `SP_monthly_${brand.id}_${year}_${month}`,
        startDate,
        endDate,
        configuration: {
          adProduct:    'SPONSORED_PRODUCTS',
          groupBy:      ['campaign'],
          columns:      ['impressions', 'clicks', 'spend', 'purchases14d', 'sales14d', 'unitsSoldClicks14d'],
          reportTypeId: 'spCampaigns',
          timeUnit:     'SUMMARY',
          format:       'GZIP_JSON',
        },
      };

      const createResp = await adRequest('POST', '/reporting/reports', token, reportBody);
      const reportMeta = await pollAdReport(createResp.reportId, token, 90_000);
      const rows_raw   = await downloadAdReport(reportMeta.url);

      let impressions = 0, clicks = 0, spend = 0, sales = 0, adUnits = 0;
      rows_raw.forEach(row => {
        impressions += row.impressions           || 0;
        clicks      += row.clicks                || 0;
        spend       += row.spend                 || 0;
        sales       += row.sales14d              || 0;
        adUnits     += row.unitsSoldClicks14d    || 0;
      });

      const acos = sales  > 0 ? round2((spend / sales) * 100) : null;
      const roas = spend  > 0 ? round2(sales / spend)         : null;
      const ctr  = impressions > 0 ? round2((clicks / impressions) * 100) : 0;
      const cpc  = clicks > 0 ? round2(spend / clicks) : 0;

      rows.push([
        year, month, impressions, clicks, round2(spend), round2(sales),
        acos, roas, adUnits, ctr, cpc, brand.id, now,
      ]);
    } catch (err) {
      console.warn(`[sync-advertising] ${brand.id} ${year}-${month} failed:`, err.message);
    }

    await sleep(2000);
  }

  return rows;
}

// ── Advertising API helpers ───────────────────────────────────────────────────

function adRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                        `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId':      process.env.SP_AD_CLIENT_ID,
      'Amazon-Advertising-API-Scope':         process.env.SP_AD_PROFILE_ID,
      'Content-Type':                         'application/vnd.createasyncreportrequest.v3+json',
      'Content-Length':                       Buffer.byteLength(bodyStr),
    };
    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Ad API parse error (${res.statusCode}): ${d.slice(0, 200)}`)); }
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
    await sleep(6000);
  }
  throw new Error(`Ad report ${reportId} timed out`);
}

function downloadAdReport(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        zlib.gunzip(Buffer.concat(chunks), (err, decoded) => {
          if (err) return reject(err);
          try { resolve(JSON.parse(decoded.toString())); }
          catch (e) { reject(e); }
        });
      });
    }).on('error', reject);
  });
}

function rollingMonths(n) {
  const months = [];
  const now    = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d       = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year    = d.getFullYear();
    const month   = d.getMonth() + 1;
    const pad     = x => String(x).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    months.push({
      year, month,
      startDate: `${year}${pad(month)}01`,
      endDate:   `${year}${pad(month)}${pad(lastDay)}`,
    });
  }
  return months;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
