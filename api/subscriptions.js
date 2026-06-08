/**
 * api/subscriptions.js
 * GET /api/subscriptions?year=2026&month=5
 *
 * Returns Subscribe & Save metrics using the SP-API
 * Easy Ship / FBA Subscribe & Save endpoints.
 *
 * SP-API endpoint used:
 *   POST /easy-ship/2022-03-23/subscriptions/search  (if applicable)
 *   GET  /fba/inventory/v1/summaries                 (stock snapshot)
 *
 * Note: Subscribe & Save subscriber counts are available via
 * Seller Central reports (GET_FBA_SNS_FORECAST_DATA, GET_FBA_SNS_PERFORMANCE_DATA).
 * We use the Reports API to pull those.
 *
 * Response shape:
 * {
 *   activeSubscriptions: 123,
 *   retention90Day: 70.4,           ← %
 *   monthly: [
 *     { label: 'Jan 2025', year: 2025, month: 1, active: 196 },
 *     ...
 *   ]
 * }
 */

const { spRequest } = require('./_spauth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const year  = parseInt(req.query.year  || new Date().getFullYear());
    const month = parseInt(req.query.month || new Date().getMonth() + 1);

    // Fetch current month snapshot + 14-month history for chart + retention calc
    const [snapshot, history] = await Promise.all([
      fetchSubscriptionSnapshot(year, month),
      fetchSubscriptionHistory(year, month, 15),
    ]);

    // 90-day retention: compare subs from 3 months ago still active today
    const retention90Day = computeRetention(history, snapshot.activeSubscriptions);

    res.status(200).json({
      activeSubscriptions: snapshot.activeSubscriptions,
      retention90Day,
      monthly: history,
    });
  } catch (err) {
    console.error('[api/subscriptions]', err);
    res.status(500).json({ error: err.message });
  }
};

// ─── Current month snapshot via SNS Performance report ───────────────────────

async function fetchSubscriptionSnapshot(year, month) {
  const { start, end } = monthRange(year, month);

  const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
    reportType: 'GET_FBA_SNS_PERFORMANCE_DATA',
    dataStartTime: start,
    dataEndTime: end,
    marketplaceIds: [process.env.SP_MARKETPLACE_ID],
  });

  const reportId = createResp.reportId;
  if (!reportId) throw new Error('No SNS report ID returned');

  const meta = await pollReport(reportId, 90_000);
  const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${meta.reportDocumentId}`);

  const https = require('https');
  const text = await downloadText(docResp.url);

  // SNS Performance report is TSV
  const lines = text.trim().split('\n');
  const headers = lines[0].split('\t').map(h => h.trim());

  let totalActive = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const row = Object.fromEntries(headers.map((h, j) => [h, cols[j]]));
    // Column name varies by marketplace — try common variants
    const active = parseInt(
      row['Total Subscriptions'] ||
      row['Active Subscriptions'] ||
      row['Subscriber Count'] ||
      0
    );
    totalActive += active;
  }

  return { activeSubscriptions: totalActive };
}

// ─── Rolling history for chart ────────────────────────────────────────────────

async function fetchSubscriptionHistory(currentYear, currentMonth, numMonths) {
  // Build list of months to fetch
  const months = [];
  for (let i = numMonths - 1; i >= 0; i--) {
    months.push(prevMonthN(currentYear, currentMonth, i));
  }

  // Fetch snapshots in sequence to avoid rate limits
  const results = [];
  for (const [y, m] of months) {
    try {
      const snap = await fetchSubscriptionSnapshot(y, m);
      results.push({ label: monthLabel(y, m), year: y, month: m, active: snap.activeSubscriptions });
    } catch {
      results.push({ label: monthLabel(y, m), year: y, month: m, active: null });
    }
    await sleep(500);
  }
  return results;
}

// ─── Retention calc ───────────────────────────────────────────────────────────

function computeRetention(history, currentActive) {
  // Find subscriber count from 3 months ago
  if (history.length < 4) return null;
  const threeMonthsAgo = history[history.length - 4];
  if (!threeMonthsAgo?.active || threeMonthsAgo.active === 0) return null;
  return round2((currentActive / threeMonthsAgo.active) * 100);
}

// ─── Report polling ───────────────────────────────────────────────────────────

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
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
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

function prevMonth(year, month) {
  return month === 1 ? [year - 1, 12] : [year, month - 1];
}

function prevMonthN(year, month, n) {
  let y = year, m = month;
  for (let i = 0; i < n; i++) [y, m] = prevMonth(y, m);
  return [y, m];
}

function monthLabel(year, month) {
  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${labels[month - 1]} ${year}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;
