/**
 * api/cron/sync-google-ads.js
 * Runs daily — pulls yesterday's Google Ads campaign performance and
 * writes one row per campaign per day to the ads tab on the Shopify sheet.
 * Computes ACOS using Shopify revenue from the orders tab for that date.
 * Deduplicates on date + campaign_name — safe to re-run.
 *
 * Sheet: SHOPIFY_ORDERS_SHEET
 *   - Source: orders tab (reads revenue for ACOS)
 *   - Destination: ads tab (gid=767884356)
 *
 * Headers: date | campaign_name | impressions | clicks | spend |
 *          conversions | revenue | acos | last_updated
 *
 * Schedule: daily at 15 7 * * * (after orders + revenue sync)
 */

const { ensureTab, appendRows, readRows } = require('../config/_sheets_client');

const CUSTOMER_ID   = process.env.GOOGLE_ADS_CUSTOMER_ID;   // 7766709758
const DEV_TOKEN     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const SHEET_ID      = process.env.SHOPIFY_ORDERS_SHEET;
const API_VERSION   = 'v24';

const ORDERS_TAB = 'orders';
const ADS_TAB    = 'ads';

const ADS_HEADERS = [
  'date', 'campaign_name', 'impressions', 'clicks',
  'spend', 'conversions', 'revenue', 'acos', 'last_updated',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!CUSTOMER_ID || !DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    return res.status(500).json({ error: 'Google Ads env vars not set' });
  }
  if (!SHEET_ID) {
    return res.status(500).json({ error: 'SHOPIFY_ORDERS_SHEET not set' });
  }

  const mode = req.query.mode || 'yesterday';
  const { startDate, endDate } = getDateRange(mode, req);
  const nowEst = toEstIso(new Date());

  console.log(`[sync-google-ads] mode=${mode} start=${startDate} end=${endDate}`);

  // ── 1. Get Google OAuth access token ─────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken();
    console.log('[sync-google-ads] access token obtained');
  } catch (err) {
    console.error('[sync-google-ads] token failed:', err.message);
    return res.status(500).json({ error: 'Token request failed', detail: err.message });
  }

  // ── 2. Query Google Ads — daily campaign performance ──────────────────────
  const gaqlDate = startDate === endDate
    ? `segments.date = '${startDate}'`
    : `segments.date >= '${startDate}' AND segments.date <= '${endDate}'`;

  const query = `
    SELECT
      segments.date,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions
    FROM campaign
    WHERE ${gaqlDate}
      AND metrics.impressions > 0
    ORDER BY segments.date DESC, metrics.cost_micros DESC
  `;

  let adsRows = [];
  try {
    const resp = await googleAdsSearch(accessToken, query);
    adsRows = resp.results || [];
    console.log(`[sync-google-ads] ${adsRows.length} campaign-day rows from API`);
  } catch (err) {
    console.error('[sync-google-ads] API query failed:', err.message);
    return res.status(500).json({ error: 'Google Ads query failed', detail: err.message });
  }

  if (adsRows.length === 0) {
    return res.status(200).json({ message: 'No ad data in range', mode, startDate, endDate });
  }

  // ── 3. Read Shopify orders for revenue lookup ─────────────────────────────
  let orderRows = [];
  try {
    orderRows = await readRows(SHEET_ID, ORDERS_TAB);
    console.log(`[sync-google-ads] loaded ${orderRows.length} order rows for revenue lookup`);
  } catch (e) {
    console.warn('[sync-google-ads] could not read orders tab — ACOS will be blank');
  }

  // Build revenue map: date → total revenue (sum item_price, exclude refunded/cancelled)
  const revenueByDate = {};
  for (const row of orderRows) {
    const finStatus = (row.financial_status || row.status || '').toLowerCase();
    if (finStatus === 'refunded' || finStatus === 'cancelled' || finStatus === 'canceled') continue;
    const date  = normalizeDate(row.date);
    if (!date) continue;
    const price = parseFloat((row.item_price || '0').replace(/[$,]/g, '')) || 0;
    revenueByDate[date] = (revenueByDate[date] || 0) + price;
  }

  // ── 4. Build sheet rows ───────────────────────────────────────────────────
  const newLineItems = adsRows.map(r => {
    const date         = r.segments?.date || '';
    const campaignName = r.campaign?.name || '';
    const impressions  = parseInt(r.metrics?.impressions || '0', 10);
    const clicks       = parseInt(r.metrics?.clicks || '0', 10);
    const spend        = round2(parseInt(r.metrics?.costMicros || '0', 10) / 1_000_000);
    const conversions  = round2(r.metrics?.conversions || 0);
    const revenue      = round2(revenueByDate[date] || 0);
    const acos         = revenue > 0 ? round2(spend / revenue) : '';

    return {
      date,
      campaign_name: campaignName,
      impressions,
      clicks,
      spend,
      conversions,
      revenue,
      acos,
      last_updated: nowEst,
    };
  }).filter(r => r.date && r.campaign_name);

  // ── 5. Dedup and write ────────────────────────────────────────────────────
  const token        = await ensureTab(SHEET_ID, ADS_TAB, ADS_HEADERS);
  const existingRows = await readRows(SHEET_ID, ADS_TAB);
  const existingKeys = new Set(
    existingRows
      .map(r => `${r.date}||${r.campaign_name}`)
      .filter(k => k !== '||')
  );

  const rowsToWrite = newLineItems
    .filter(r => !existingKeys.has(`${r.date}||${r.campaign_name}`))
    .map(r => ADS_HEADERS.map(h => r[h] ?? ''));

  const dupCount = newLineItems.length - rowsToWrite.length;
  if (dupCount > 0) {
    console.log(`[sync-google-ads] skipped ${dupCount} duplicate date+campaign rows`);
  }

  if (rowsToWrite.length > 0) {
    await appendRows(SHEET_ID, ADS_TAB, rowsToWrite, token);
    console.log(`[sync-google-ads] wrote ${rowsToWrite.length} rows`);
  } else {
    console.log('[sync-google-ads] 0 new rows (all duplicates)');
  }

  return res.status(200).json({
    rows:      rowsToWrite.length,
    skipped:   dupCount,
    mode,
    startDate,
    endDate,
    timestamp: nowEst,
  });
};

// ── Google OAuth token exchange ───────────────────────────────────────────────

async function getAccessToken() {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`Token request failed: ${resp.status}`);
  const { access_token, error } = await resp.json();
  if (error) throw new Error(`Token error: ${error}`);
  if (!access_token) throw new Error('No access_token in response');
  return access_token;
}

// ── Google Ads API search ─────────────────────────────────────────────────────

async function googleAdsSearch(accessToken, query) {
  const resp = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}/googleAds:search`,
    {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${accessToken}`,
        'developer-token': DEV_TOKEN,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({ query }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Ads API error ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// ── Date range ────────────────────────────────────────────────────────────────

function getDateRange(mode, req) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');

  if (mode === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    const y = d.getFullYear(), m = pad(d.getMonth() + 1), day = pad(d.getDate());
    return { startDate: `${y}-${m}-${day}`, endDate: `${y}-${m}-${day}` };
  }

  if (mode === 'week') {
    const start = req?.query?.start;
    const end   = req?.query?.end;
    if (!start || !end) throw new Error('mode=week requires ?start=YYYY-MM-DD&end=YYYY-MM-DD');
    return { startDate: start, endDate: end };
  }

  if (mode === 'day') {
    const y = now.getUTCFullYear(), m = pad(now.getUTCMonth() + 1), d = pad(now.getUTCDate());
    return { startDate: `${y}-${m}-${d}`, endDate: `${y}-${m}-${d}` };
  }

  throw new Error(`Unknown mode: ${mode}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeDate(val) {
  if (!val) return '';
  if (/^\d{4}-\d{2}/.test(val)) return val.substring(0, 10);
  return val;
}

function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}

const round2 = n => Math.round(n * 100) / 100;
