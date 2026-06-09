/**
 * api/cron/sync-subscriptions.js
 * Nightly cron — syncs Subscribe & Save metrics to Google Sheets.
 * Runs at 3:30 AM UTC.
 *
 * Sheet: amazon-subscriptions
 * Columns: year, month, active_subscriptions, retention_90_day,
 *          brand, last_updated
 */

const { spRequest }                              = require('../_spauth');
const { ensureTab, replaceRows, getSheetsToken } = require('../config/_sheets_client');
const brands                                     = require('../config/brands');
const sheets                                     = require('../config/sheets');
const https                                      = require('https');

const HEADERS = [
  'year', 'month', 'active_subscriptions',
  'retention_90_day', 'brand', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      console.log(`[sync-subscriptions] starting ${brand.id}`);
      const rows  = await fetchSubscriptionRows(brand);
      const token = await ensureTab(sheets.subscriptions, brand.tabName, HEADERS);
      await replaceRows(sheets.subscriptions, brand.tabName, HEADERS, rows, token);
      results.push({ brand: brand.id, status: 'ok', rows: rows.length });
      console.log(`[sync-subscriptions] ${brand.id} — ${rows.length} rows written`);
    } catch (err) {
      console.error(`[sync-subscriptions] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: new Date().toISOString() });
};

async function fetchSubscriptionRows(brand) {
  const months = rollingMonths(15); // 15 months for 90-day retention calc
  const rows   = [];
  const counts = [];
  const now    = new Date().toISOString();

  for (const { year, month, start, end } of months) {
    try {
      const count = await fetchSnapshotCount(year, month, start, end);
      counts.push({ year, month, count });
    } catch (err) {
      console.warn(`[sync-subscriptions] ${brand.id} ${year}-${month} failed:`, err.message);
      counts.push({ year, month, count: null });
    }
    await sleep(3000); // SNS reports have low rate limits
  }

  // Build rows with 90-day retention (compare to count 3 months ago)
  counts.forEach(({ year, month, count }, idx) => {
    const threeMonthsAgo = counts[idx - 3];
    const retention = (threeMonthsAgo?.count && count != null)
      ? round2((count / threeMonthsAgo.count) * 100)
      : null;

    rows.push([year, month, count, retention, brand.id, now]);
  });

  return rows;
}

async function fetchSnapshotCount(year, month, start, end) {
  const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
    reportType:      'GET_FBA_SNS_PERFORMANCE_DATA',
    dataStartTime:   start,
    dataEndTime:     end,
    marketplaceIds:  [process.env.SP_MARKETPLACE_ID],
  });

  if (!createResp.reportId) throw new Error('No reportId from SNS report');

  const meta    = await pollReport(createResp.reportId, 90_000);
  const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${meta.reportDocumentId}`);
  const text    = await downloadText(docResp.url);

  // TSV — sum all "Active Subscriptions" / "Total Subscriptions" rows
  const lines   = text.trim().split('\n');
  if (lines.length < 2) return 0;
  const headers = lines[0].split('\t').map(h => h.trim());
  let total     = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const row  = Object.fromEntries(headers.map((h, j) => [h, cols[j]]));
    total += parseInt(
      row['Total Subscriptions'] || row['Active Subscriptions'] || row['Subscriber Count'] || 0
    );
  }
  return total;
}

async function pollReport(reportId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
    if (resp.processingStatus === 'DONE') return resp;
    if (['FATAL', 'CANCELLED'].includes(resp.processingStatus)) {
      throw new Error(`Report ${reportId} ${resp.processingStatus}`);
    }
    await sleep(6000);
  }
  throw new Error(`Report ${reportId} timed out`);
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
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
    months.push({ year, month, start: `${year}-${pad(month)}-01T00:00:00Z`, end: `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z` });
  }
  return months;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
