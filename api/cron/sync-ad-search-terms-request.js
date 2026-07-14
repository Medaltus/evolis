/**
 * api/cron/sync-ad-search-terms-request.js
 * Step 1 of 2 — requests Amazon Advertising SEARCH TERM reports and stores
 * report IDs in the SHEET_AD_SEARCH_TERMS sheet's _meta tab.
 *
 * CHANGED (2026-07-14): timeUnit switched from SUMMARY to DAILY, and 'date'
 * added to both column lists. This matches the pattern in the coworker's
 * Amazon_Ads_Search_Term_API_Guide.md, and is required for the dashboard's
 * "today vs 30-day avg CPC" / CPC-trend panels — those can't be built from
 * monthly-summary rows since there's no "today" inside a SUMMARY row.
 *
 * Fires 4 report requests per run (mirrors sync-advertising-request.js's
 * curr/prev pattern):
 *   Current month MTD (1st of this month → yesterday):
 *     1. spSearchTerm — Sponsored Products search terms
 *     2. sbSearchTerm — Sponsored Brands search terms
 *   Last full calendar month:
 *     3. spSearchTerm
 *     4. sbSearchTerm
 *
 * Each report now returns ONE ROW PER (search term + matched keyword +
 * match type + DAY) rather than one row per month. sync-ad-search-terms-process.js
 * uses the per-row `date` field, not the report's overall date range, to
 * bucket rows.
 *
 * SP and SB use different column names for the same concepts (same
 * pattern already seen on the campaign-level sync):
 *   SP: costPerClick, purchaseClickRate14d, acosClicks14d, sales14d,
 *       purchases14d, keyword (not keywordText)
 *   SB: no direct CPC/conversion-rate/ACOS columns — derived from
 *       cost/clicks/sales/purchases in the process step. keywordText
 *       (not keyword).
 *
 * `keywordBid` IS a real column on both report types, so current bid comes
 * from the SAME report as everything else — no separate Keywords API call.
 *
 * Runs daily — stagger the actual cron schedule a few minutes apart from
 * sync-advertising-request to avoid both hitting the Ads API at once.
 */

const { getAdToken }                      = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const https                               = require('https');

const AD_API_HOST           = 'advertising-api.amazon.com';
const SHEET_AD_SEARCH_TERMS = process.env.SHEET_AD_SEARCH_TERMS;
const META_TAB              = '_meta';
const META_HEADERS          = ['KEY', 'VALUE', 'UPDATED_AT'];

const SP_COLUMNS = [
  'date', 'searchTerm', 'keyword', 'matchType', 'keywordId', 'keywordBid',
  'campaignName', 'campaignId', 'adGroupName', 'adGroupId',
  'impressions', 'clicks', 'clickThroughRate',
  'cost', 'costPerClick', 'purchases14d', 'sales14d',
  'acosClicks14d', 'purchaseClickRate14d',
];

const SB_COLUMNS = [
  'date', 'searchTerm', 'keywordText', 'matchType', 'keywordId', 'keywordBid',
  'campaignName', 'campaignId', 'adGroupName', 'adGroupId',
  'impressions', 'clicks', 'cost', 'purchases', 'sales',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date().toISOString();
  const curr = getCurrentMonthRange();
  const prev = getLastMonthRange();

  console.log(`[sync-ad-search-terms-request] curr: ${curr.startDate} → ${curr.endDate}`);
  console.log(`[sync-ad-search-terms-request] prev: ${prev.startDate} → ${prev.endDate}`);

  try {
    const token     = await getAdToken();
    const profileId = await discoverProfileId(token);
    console.log(`[sync-ad-search-terms-request] using profileId=${profileId}`);

    const jobs = [
      { label: 'sp_curr', reportTypeId: 'spSearchTerm', adProduct: 'SPONSORED_PRODUCTS', dateRange: curr, columns: SP_COLUMNS },
      { label: 'sb_curr', reportTypeId: 'sbSearchTerm', adProduct: 'SPONSORED_BRANDS',   dateRange: curr, columns: SB_COLUMNS },
      { label: 'sp_prev', reportTypeId: 'spSearchTerm', adProduct: 'SPONSORED_PRODUCTS', dateRange: prev, columns: SP_COLUMNS },
      { label: 'sb_prev', reportTypeId: 'sbSearchTerm', adProduct: 'SPONSORED_BRANDS',   dateRange: prev, columns: SB_COLUMNS },
    ];

    const STAGGER_MS = 1500;
    const reportIds  = {};
    for (let i = 0; i < jobs.length; i++) {
      if (i > 0) await sleep(STAGGER_MS);
      const { label, reportTypeId, adProduct, dateRange, columns } = jobs[i];
      reportIds[label] = await requestReportWithRetry(token, profileId, reportTypeId, adProduct, dateRange, ['searchTerm'], columns, label);
    }

    if (!reportIds.sp_curr && !reportIds.sb_curr) {
      return res.status(500).json({ error: 'All current month report requests failed' });
    }
    if (!reportIds.sp_prev && !reportIds.sb_prev) {
      return res.status(500).json({ error: 'All previous month report requests failed' });
    }

    // NOTE: st_processed_<label> / st_status_<label> are intentionally NOT
    // set here — they're owned by the process step. Resetting them on every
    // request run means a fresh request always starts fully unprocessed,
    // which is correct behavior (new reportId = new data to fetch).
    const metaRows = [
      ['st_report_id_sp_curr', reportIds.sp_curr || '', now],
      ['st_report_id_sb_curr', reportIds.sb_curr || '', now],
      ['st_report_id_sp_prev', reportIds.sp_prev || '', now],
      ['st_report_id_sb_prev', reportIds.sb_prev || '', now],
      ['st_report_status',     'REQUESTED',             now],
      ['st_processed_sp_curr', 'false',                 now],
      ['st_processed_sb_curr', 'false',                 now],
      ['st_processed_sp_prev', 'false',                 now],
      ['st_processed_sb_prev', 'false',                 now],
      ['st_start_date_curr',   curr.startDate,          now],
      ['st_end_date_curr',     curr.endDate,            now],
      ['st_start_date_prev',   prev.startDate,          now],
      ['st_end_date_prev',     prev.endDate,            now],
      ['st_profile_id',        String(profileId),       now],
    ];

    const token2   = await ensureTab(SHEET_AD_SEARCH_TERMS, META_TAB, META_HEADERS);
    const existing = await readRows(SHEET_AD_SEARCH_TERMS, META_TAB);
    const metaMap  = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaRows.forEach(r => { metaMap[r[0]] = r; });
    await replaceRows(SHEET_AD_SEARCH_TERMS, META_TAB, META_HEADERS, Object.values(metaMap), token2);

    return res.status(200).json({
      reportIds,
      curr, prev,
      note: 'sync-ad-search-terms-process now checks status once per invocation — schedule it to run every ~5 minutes in vercel.json until st_report_status flips to PROCESSED, rather than a single one-off call.',
    });
  } catch (err) {
    console.error('[sync-ad-search-terms-request] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

async function requestReportWithRetry(token, profileId, reportTypeId, adProduct, dateRange, groupBy, columns, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { statusCode, body, retryAfterSec } = await adRequestRaw('POST', '/reporting/reports', token, profileId, {
      name:      `st_${reportTypeId}_${dateRange.endDate}`,
      startDate: dateRange.startDate,
      endDate:   dateRange.endDate,
      configuration: {
        adProduct,
        groupBy,
        columns,
        reportTypeId,
        timeUnit: 'DAILY',
        format:   'GZIP_JSON',
      },
    });

    if (body?.reportId) {
      console.log(`[sync-ad-search-terms-request] ${label}: ${body.reportId}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return body.reportId;
    }

    const duplicateMatch = (statusCode === 425 || body?.code === '425') && body?.detail?.match(/duplicate of\s*:\s*([a-f0-9-]+)/i);
    if (duplicateMatch) {
      console.log(`[sync-ad-search-terms-request] ${label}: reusing existing report ${duplicateMatch[1]} (identical request already made today)`);
      return duplicateMatch[1];
    }

    const isThrottled = statusCode === 429 || body?.code === '429';
    if (isThrottled && attempt < MAX_RETRIES) {
      const waitSec = retryAfterSec ?? (2 * attempt);
      console.warn(`[sync-ad-search-terms-request] ${label} throttled (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }

    console.error(`[sync-ad-search-terms-request] ${label} failed (attempt ${attempt}/${MAX_RETRIES}):`, JSON.stringify(body));
    return null;
  }
  return null;
}

async function discoverProfileId(token) {
  const profiles = await adRequest('GET', '/v2/profiles', token, null, null);
  const newdermUS = profiles.find(p =>
    p.countryCode === 'US' &&
    p.accountInfo?.type === 'seller' &&
    (p.accountInfo?.name?.toLowerCase().includes('newderm') ||
     p.accountInfo?.id === 'A25QTQX4QSLFM9')
  );
  if (!newdermUS) throw new Error('NewDerm US seller profile not found');
  return newdermUS.profileId;
}

function getCurrentMonthRange() {
  const pad   = x => String(x).padStart(2, '0');
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const startDate = `${year}-${pad(month)}-01`;
  const endDate   = `${yesterday.getFullYear()}-${pad(yesterday.getMonth()+1)}-${pad(yesterday.getDate())}`;
  return { startDate, endDate };
}

function getLastMonthRange() {
  const pad       = x => String(x).padStart(2, '0');
  const now       = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfPrevMonth  = new Date(firstOfThisMonth - 1);
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return { startDate: fmt(firstOfPrevMonth), endDate: fmt(lastOfPrevMonth) };
}

function adRequest(method, path, token, profileId, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                   `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Content-Type':                    method === 'POST' && path === '/reporting/reports'
                                           ? 'application/vnd.createasyncreportrequest.v3+json'
                                           : 'application/json',
    };
    if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);
    if (bodyStr)   headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Ad API parse error (${res.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function adRequestRaw(method, path, token, profileId, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                   `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Content-Type':                    method === 'POST' && path === '/reporting/reports'
                                           ? 'application/vnd.createasyncreportrequest.v3+json'
                                           : 'application/json',
    };
    if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);
    if (bodyStr)   headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const retryAfterHeader = res.headers['retry-after'];
        const retryAfterSec    = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(d), retryAfterSec });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: { parseError: d.slice(0, 300) }, retryAfterSec });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
