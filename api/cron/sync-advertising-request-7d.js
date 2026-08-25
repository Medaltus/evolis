/**
 * api/cron/sync-advertising-request-7d.js
 * DIAGNOSTIC ONLY — not scheduled, not linked to any production sheet.
 *
 * Identical to sync-advertising-request.js except: spAdvertisedProduct and
 * spCampaigns request the 7-day attribution columns (sales7d,
 * unitsSoldClicks7d, purchases7d) instead of the 14-day ones this project
 * normally uses. sbCampaigns / sdAdvertisedProduct / sdCampaigns are
 * requested UNCHANGED — confirmed against the real columns already in use
 * elsewhere in this project that neither Sponsored Brands nor Sponsored
 * Display expose a day-window suffix at all (SB: cost/sales/purchases,
 * SD: cost/sales/unitsSold, no "14d"/"7d" variant on either). So this is a
 * clean, isolated test of the SP attribution window specifically — SB/SD
 * are identical between this and the real 14-day pull, only SP's
 * sales/units differ.
 *
 * Purpose: Jaclyn's dashboard summary (14-day SP attribution) runs a few
 * percent above both Helium 10's Analytics total and Amazon's own console
 * for the same period. Pairing this with sync-advertising-process-7d.js
 * (which writes to its own test tab, not any production sheet) answers
 * directly whether switching SP to a 7-day window closes that gap, instead
 * of guessing.
 *
 * Run manually via:
 *   POST /api/cron/sync-advertising-request-7d
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Stores report IDs in SHEET_ADVERTISING → _meta tab, under keys suffixed
 * "_7d" so they never collide with or overwrite the production keys this
 * same tab already holds (ad_report_id_sp_curr etc.). Date range keys are
 * NOT duplicated — curr/prev cover the exact same calendar months as the
 * production run, so ad_start_date_curr / ad_end_date_curr / etc. are
 * reused as-is, read-only, by sync-advertising-process-7d.js.
 */

const { getAdToken }                      = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const https                               = require('https');

const AD_API_HOST      = 'advertising-api.amazon.com';
const SHEET_AD_SUMMARY = process.env.SHEET_ADVERTISING;
const META_TAB         = '_meta';
const META_HEADERS     = ['KEY', 'VALUE', 'UPDATED_AT'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = toEstIso(new Date());

  const curr = getCurrentMonthRange();
  const prev = getLastMonthRange();

  console.log(`[sync-advertising-request-7d] curr: ${curr.startDate} → ${curr.endDate}`);
  console.log(`[sync-advertising-request-7d] prev: ${prev.startDate} → ${prev.endDate}`);

  try {
    const token     = await getAdToken();
    const profileId = await discoverProfileId(token);
    console.log(`[sync-advertising-request-7d] using profileId=${profileId}`);

    // Same 1.5s stagger as the production request cron — no reason for
    // this diagnostic run to burst Amazon's reporting queue either.
    const reportJobs = [
      () => requestReportWithRetry(token, profileId, 'spAdvertisedProduct', 'SPONSORED_PRODUCTS', curr, ['advertiser'], ['advertisedAsin','impressions','clicks','spend','purchases7d','unitsSoldClicks7d','sales7d'], 'asin_curr_7d'),
      () => requestReportWithRetry(token, profileId, 'spCampaigns',         'SPONSORED_PRODUCTS', curr, ['campaign'],   ['campaignName','impressions','clicks','spend','purchases7d','sales7d','unitsSoldClicks7d'], 'sp_curr_7d'),
      () => requestReportWithRetry(token, profileId, 'sbCampaigns',        'SPONSORED_BRANDS',    curr, ['campaign'],   ['campaignName','impressions','clicks','cost','purchases','sales'], 'sb_curr_7d'),
      () => requestReportWithRetry(token, profileId, 'sdAdvertisedProduct', 'SPONSORED_DISPLAY',  curr, ['advertiser'], ['campaignName','campaignId','adGroupName','promotedAsin','promotedSku','impressions','clicks','cost','purchases','sales','unitsSold'], 'sd_curr_7d'),
      () => requestReportWithRetry(token, profileId, 'sdCampaigns',         'SPONSORED_DISPLAY',  curr, ['campaign'],   ['campaignName','campaignId','impressions','clicks','cost','purchases','sales','unitsSold'], 'sdcamp_curr_7d'),
      () => requestReportWithRetry(token, profileId, 'spAdvertisedProduct', 'SPONSORED_PRODUCTS', prev, ['advertiser'], ['advertisedAsin','impressions','clicks','spend','purchases7d','unitsSoldClicks7d','sales7d'], 'asin_prev_7d'),
      () => requestReportWithRetry(token, profileId, 'spCampaigns',         'SPONSORED_PRODUCTS', prev, ['campaign'],   ['campaignName','impressions','clicks','spend','purchases7d','sales7d','unitsSoldClicks7d'], 'sp_prev_7d'),
      () => requestReportWithRetry(token, profileId, 'sbCampaigns',        'SPONSORED_BRANDS',    prev, ['campaign'],   ['campaignName','impressions','clicks','cost','purchases','sales'], 'sb_prev_7d'),
      () => requestReportWithRetry(token, profileId, 'sdAdvertisedProduct', 'SPONSORED_DISPLAY',  prev, ['advertiser'], ['campaignName','campaignId','adGroupName','promotedAsin','promotedSku','impressions','clicks','cost','purchases','sales','unitsSold'], 'sd_prev_7d'),
      () => requestReportWithRetry(token, profileId, 'sdCampaigns',         'SPONSORED_DISPLAY',  prev, ['campaign'],   ['campaignName','campaignId','impressions','clicks','cost','purchases','sales','unitsSold'], 'sdcamp_prev_7d'),
    ];

    const STAGGER_MS = 1500;
    const results = [];
    for (let i = 0; i < reportJobs.length; i++) {
      if (i > 0) await sleep(STAGGER_MS);
      results.push(await reportJobs[i]());
    }
    const [asinCurrId, spCurrId, sbCurrId, sdCurrId, sdCampCurrId, asinPrevId, spPrevId, sbPrevId, sdPrevId, sdCampPrevId] = results;

    if (!spCurrId && !sbCurrId) return res.status(500).json({ error: 'All current month report requests failed' });
    if (!spPrevId && !sbPrevId) return res.status(500).json({ error: 'All previous month report requests failed' });

    const metaRows = [
      ['ad_report_id_asin_curr_7d',   asinCurrId   || '', now],
      ['ad_report_id_sp_curr_7d',     spCurrId     || '', now],
      ['ad_report_id_sb_curr_7d',     sbCurrId     || '', now],
      ['ad_report_id_sd_curr_7d',     sdCurrId     || '', now],
      ['ad_report_id_sdcamp_curr_7d', sdCampCurrId || '', now],
      ['ad_report_id_asin_prev_7d',   asinPrevId   || '', now],
      ['ad_report_id_sp_prev_7d',     spPrevId     || '', now],
      ['ad_report_id_sb_prev_7d',     sbPrevId     || '', now],
      ['ad_report_id_sd_prev_7d',     sdPrevId     || '', now],
      ['ad_report_id_sdcamp_prev_7d', sdCampPrevId || '', now],
      ['ad_report_status_7d',         'REQUESTED',        now],
      ['ad_profile_id',               String(profileId),  now], // shared with production, read-only here
    ];

    const token2   = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    const existing = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const metaMap  = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaRows.forEach(r => { metaMap[r[0]] = r; });
    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);

    console.log('[sync-advertising-request-7d] report IDs stored — run sync-advertising-process-7d next.');
    return res.status(200).json({
      message: 'Requested 7d-attribution reports (SP only; SB/SD unchanged, no window variant exists for them)',
      curr, prev,
      reportIds: { asinCurrId, spCurrId, sbCurrId, sdCurrId, sdCampCurrId, asinPrevId, spPrevId, sbPrevId, sdPrevId, sdCampPrevId },
    });
  } catch (err) {
    console.error('[sync-advertising-request-7d] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Report request with retry (identical to production cron) ────────────────
const MAX_RETRIES        = 3;
const DUPLICATE_ID_REGEX = /report with ID '([^']+)' already exists/i;

async function requestReportWithRetry(token, profileId, reportTypeId, adProduct, range, groupBy, columns, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { statusCode, body, retryAfterSec } = await adRequestRaw('POST', '/reporting/reports', token, profileId, {
      name: `${label} ${range.startDate} to ${range.endDate}`,
      startDate: range.startDate,
      endDate:   range.endDate,
      configuration: {
        adProduct,
        groupBy,
        columns,
        reportTypeId,
        timeUnit: 'SUMMARY',
        format:   'GZIP_JSON',
      },
    });

    if (body?.reportId) {
      console.log(`[sync-advertising-request-7d] ${label}: ${body.reportId}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return body.reportId;
    }

    const duplicateMatch = (statusCode === 425 || body?.code === '425') && body?.detail?.match(DUPLICATE_ID_REGEX);
    if (duplicateMatch) {
      const existingId = duplicateMatch[1];
      console.log(`[sync-advertising-request-7d] ${label}: reusing existing report ${existingId} (identical request already made today)`);
      return existingId;
    }

    const isThrottled = statusCode === 429 || body?.code === '429';
    if (isThrottled && attempt < MAX_RETRIES) {
      const waitSec = retryAfterSec ?? (2 * attempt);
      console.warn(`[sync-advertising-request-7d] ${label} throttled (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }

    console.error(`[sync-advertising-request-7d] ${label} failed (attempt ${attempt}/${MAX_RETRIES}):`, JSON.stringify(body));
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

function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
