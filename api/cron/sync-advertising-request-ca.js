/**
 * api/cron/sync-advertising-request-ca.js
 * Step 1 of 2 — Canadian counterpart to sync-advertising-request.js.
 * Requests the SAME 5 report types (spAdvertisedProduct, spCampaigns,
 * sbCampaigns, sdAdvertisedProduct, sdCampaigns) for current + prior
 * month, but scoped to the Canadian Amazon Ads profile instead of the US
 * one.
 *
 * WHY A SEPARATE FILE, NOT A PARAMETER ON THE EXISTING ONE: Amazon Ads
 * scopes campaigns per-marketplace by profile ID — Canadian campaign
 * data is structurally unreachable through the US profile no matter what
 * report type or column is requested. Every advertising cron in this
 * project (sync-advertising-request.js, sync-advertising-backfill.js,
 * sync-ad-search-terms-request.js) has only ever queried the US profile;
 * this is the first to reach Canada at all. Kept as a separate,
 * dedicated cron rather than branching the existing file, matching how
 * this project has generally kept parallel marketplace pipelines
 * distinct elsewhere.
 *
 * CA PROFILE — confirmed 2026-08-19 via test-ad-profiles.js: profileId
 * 257626120209879, same NewDerm seller account (A25QTQX4QSLFM9) as the
 * US profile, same LWA credentials (SP_AD_CLIENT_ID/SP_AD_REFRESH_TOKEN)
 * — no separate OAuth setup needed. Discovered dynamically here (same
 * approach as the US file) rather than hardcoded, in case the account
 * setup ever changes.
 *
 * REAL CAMPAIGN NAMES CONFIRMED (test-ca-ad-campaigns.js, 2026-08-19):
 * e.g. "Skinuva - SP - Scar - Auto - CANADA 7.26" — "CANADA" sits at the
 * end, separated from "Skinuva" by several other segments. The
 * corresponding process file's brand-matching (identifyBrand) already
 * has this handled via the same fix already deployed in
 * sync-advertising-process.js / sync-ad-search-terms-process.js.
 *
 * WHETHER SB/SD ARE ACTUALLY RUNNING IN CANADA — NOT YET CONFIRMED. Only
 * spCampaigns has been directly tested against real CA data so far. All
 * 5 report types are requested here anyway, matching the full US-side
 * shape — if SB/SD genuinely have no Canadian campaigns, Amazon simply
 * returns an empty report, which costs nothing and itself confirms
 * there's no CA spend there yet, rather than silently never checking.
 *
 * META KEYS — suffixed with _ca to avoid colliding with the US file's
 * own keys in the SAME _meta tab (SHEET_ADVERTISING → _meta):
 *   ad_report_id_asin_curr_ca / _prev_ca
 *   ad_report_id_sp_curr_ca / _prev_ca
 *   ad_report_id_sb_curr_ca / _prev_ca
 *   ad_report_id_sd_curr_ca / _prev_ca
 *   ad_report_id_sdcamp_curr_ca / _prev_ca
 *   ad_report_status_ca, ad_start_date_curr_ca / _prev_ca, etc.
 *   ad_profile_id_ca
 *
 * WRITE DESTINATION: the SAME SHEET_ADVERTISING and SHEET_AD_ORDERS
 * sheets the US pipeline uses — NOT a separate CA-specific sheet. Real
 * routing per brand happens in sync-advertising-process-ca.js via the
 * same identifyBrand()/asinBrandMap logic already proven correct
 * elsewhere (skinuva-ca has real, distinct ASINs and campaign-name
 * markers), so this isn't hardcoded to assume every CA campaign belongs
 * to skinuva-ca specifically — any other brand that starts running CA
 * ads would be correctly attributed too, as long as its campaign naming
 * follows a recognizable pattern (may need its own identifyBrand()
 * addition at that point, same as any new brand would).
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

  const now = new Date().toISOString();

  const curr = getCurrentMonthRange();
  const prev = getLastMonthRange();

  console.log(`[sync-advertising-request-ca] curr: ${curr.startDate} → ${curr.endDate}`);
  console.log(`[sync-advertising-request-ca] prev: ${prev.startDate} → ${prev.endDate}`);

  try {
    const token     = await getAdToken();
    const profileId = await discoverCaProfileId(token);
    console.log(`[sync-advertising-request-ca] using CA profileId=${profileId}`);

    // Same 1.5s stagger reasoning as the US file — avoid a self-inflicted
    // burst of simultaneous requests against Amazon's reporting queue.
    const reportJobs = [
      () => requestReportWithRetry(token, profileId, 'spAdvertisedProduct', 'SPONSORED_PRODUCTS', curr, ['advertiser'], ['advertisedAsin','impressions','clicks','spend','purchases14d','unitsSoldClicks14d','sales14d'], 'asin_curr_ca'),
      () => requestReportWithRetry(token, profileId, 'spCampaigns',         'SPONSORED_PRODUCTS', curr, ['campaign'],   ['campaignName','impressions','clicks','spend','purchases14d','sales14d','unitsSoldClicks14d'], 'sp_curr_ca'),
      () => requestReportWithRetry(token, profileId, 'sbCampaigns',        'SPONSORED_BRANDS',    curr, ['campaign'],   ['campaignName','impressions','clicks','cost','purchases','sales'], 'sb_curr_ca'),
      () => requestReportWithRetry(token, profileId, 'sdAdvertisedProduct', 'SPONSORED_DISPLAY',  curr, ['advertiser'], ['campaignName','campaignId','adGroupName','promotedAsin','promotedSku','impressions','clicks','cost','purchases','sales','unitsSold'], 'sd_curr_ca'),
      () => requestReportWithRetry(token, profileId, 'sdCampaigns',         'SPONSORED_DISPLAY',  curr, ['campaign'],   ['campaignName','campaignId','impressions','clicks','cost','purchases','sales','unitsSold'], 'sdcamp_curr_ca'),
      () => requestReportWithRetry(token, profileId, 'spAdvertisedProduct', 'SPONSORED_PRODUCTS', prev, ['advertiser'], ['advertisedAsin','impressions','clicks','spend','purchases14d','unitsSoldClicks14d','sales14d'], 'asin_prev_ca'),
      () => requestReportWithRetry(token, profileId, 'spCampaigns',         'SPONSORED_PRODUCTS', prev, ['campaign'],   ['campaignName','impressions','clicks','spend','purchases14d','sales14d','unitsSoldClicks14d'], 'sp_prev_ca'),
      () => requestReportWithRetry(token, profileId, 'sbCampaigns',        'SPONSORED_BRANDS',    prev, ['campaign'],   ['campaignName','impressions','clicks','cost','purchases','sales'], 'sb_prev_ca'),
      () => requestReportWithRetry(token, profileId, 'sdAdvertisedProduct', 'SPONSORED_DISPLAY',  prev, ['advertiser'], ['campaignName','campaignId','adGroupName','promotedAsin','promotedSku','impressions','clicks','cost','purchases','sales','unitsSold'], 'sd_prev_ca'),
      () => requestReportWithRetry(token, profileId, 'sdCampaigns',         'SPONSORED_DISPLAY',  prev, ['campaign'],   ['campaignName','campaignId','impressions','clicks','cost','purchases','sales','unitsSold'], 'sdcamp_prev_ca'),
    ];

    const STAGGER_MS = 1500;
    const results = [];
    for (let i = 0; i < reportJobs.length; i++) {
      if (i > 0) await sleep(STAGGER_MS);
      results.push(await reportJobs[i]());
    }
    const [asinCurrId, spCurrId, sbCurrId, sdCurrId, sdCampCurrId, asinPrevId, spPrevId, sbPrevId, sdPrevId, sdCampPrevId] = results;

    // Require at least one curr and one prev report to succeed, same
    // logic as the US file — SB/SD not required (see file header, their
    // CA activity level isn't confirmed yet).
    if (!spCurrId && !sbCurrId) return res.status(500).json({ error: 'All current month CA report requests failed' });
    if (!spPrevId && !sbPrevId) return res.status(500).json({ error: 'All previous month CA report requests failed' });

    const metaRows = [
      ['ad_report_id_asin_curr_ca', asinCurrId   || '', now],
      ['ad_report_id_sp_curr_ca',   spCurrId     || '', now],
      ['ad_report_id_sb_curr_ca',   sbCurrId     || '', now],
      ['ad_report_id_sd_curr_ca',   sdCurrId     || '', now],
      ['ad_report_id_sdcamp_curr_ca', sdCampCurrId || '', now],
      ['ad_report_id_asin_prev_ca', asinPrevId   || '', now],
      ['ad_report_id_sp_prev_ca',   spPrevId     || '', now],
      ['ad_report_id_sb_prev_ca',   sbPrevId     || '', now],
      ['ad_report_id_sd_prev_ca',   sdPrevId     || '', now],
      ['ad_report_id_sdcamp_prev_ca', sdCampPrevId || '', now],
      ['ad_report_status_ca',       'REQUESTED',        now],
      ['ad_start_date_curr_ca',     curr.startDate,     now],
      ['ad_end_date_curr_ca',       curr.endDate,       now],
      ['ad_start_date_prev_ca',     prev.startDate,     now],
      ['ad_end_date_prev_ca',       prev.endDate,       now],
      ['ad_profile_id_ca',          String(profileId),  now],
    ];

    const token2   = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    const existing = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const metaMap  = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaRows.forEach(r => { metaMap[r[0]] = r; });
    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);

    return res.status(200).json({
      curr: { asinReportId: asinCurrId, spReportId: spCurrId, sbReportId: sbCurrId, sdReportId: sdCurrId, sdCampaignReportId: sdCampCurrId, ...curr },
      prev: { asinReportId: asinPrevId, spReportId: spPrevId, sbReportId: sbPrevId, sdReportId: sdPrevId, sdCampaignReportId: sdCampPrevId, ...prev },
      profileId,
      note: 'Run sync-advertising-process-ca in 10-15 minutes',
    });

  } catch (err) {
    console.error('[sync-advertising-request-ca] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const DUPLICATE_ID_REGEX = /duplicate of\s*:\s*([a-f0-9-]+)/i;

async function requestReportWithRetry(token, profileId, reportTypeId, adProduct, dateRange, groupBy, columns, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { statusCode, body, retryAfterSec } = await adRequestRaw('POST', '/reporting/reports', token, profileId, {
      name:      `ad_${reportTypeId}_${dateRange.endDate}_ca`,
      startDate: dateRange.startDate,
      endDate:   dateRange.endDate,
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
      console.log(`[sync-advertising-request-ca] ${label}: ${body.reportId}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return body.reportId;
    }

    const duplicateMatch = (statusCode === 425 || body?.code === '425') && body?.detail?.match(DUPLICATE_ID_REGEX);
    if (duplicateMatch) {
      const existingId = duplicateMatch[1];
      console.log(`[sync-advertising-request-ca] ${label}: reusing existing report ${existingId} (identical request already made today)`);
      return existingId;
    }

    const isThrottled = statusCode === 429 || body?.code === '429';
    if (isThrottled && attempt < MAX_RETRIES) {
      const waitSec = retryAfterSec ?? (2 * attempt);
      console.warn(`[sync-advertising-request-ca] ${label} throttled (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }

    console.error(`[sync-advertising-request-ca] ${label} failed (attempt ${attempt}/${MAX_RETRIES}):`, JSON.stringify(body));
    return null;
  }
  return null;
}

async function discoverCaProfileId(token) {
  const profiles = await adRequest('GET', '/v2/profiles', token, null, null);
  const newdermCA = profiles.find(p =>
    p.countryCode === 'CA' &&
    p.accountInfo?.type === 'seller' &&
    (p.accountInfo?.name?.toLowerCase().includes('newderm') ||
     p.accountInfo?.id === 'A25QTQX4QSLFM9')
  );
  if (!newdermCA) throw new Error('NewDerm CA seller profile not found');
  return newdermCA.profileId;
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
