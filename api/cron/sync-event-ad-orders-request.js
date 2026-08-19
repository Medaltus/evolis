/**
 * api/cron/sync-event-ad-orders-request.js
 * Step 1 of 2 — for each of 4 fixed target tabs (Big Spring Sale, Prime Day,
 * Prime Big Deal Days, Black Friday and Cyber Monday), looks up that
 * event's date range from the Events tab (SHEET_MASTER_SKU_LIST, "Events"
 * tab — same source sync-event-orders-request.js uses) and requests TWO
 * ASIN-level ad performance reports per matched event, scoped to exactly
 * that event's start/end dates:
 *   - spAdvertisedProduct (Sponsored Products)
 *   - sdAdvertisedProduct (Sponsored Display) — ADDED 2026-08-19
 *
 * SPONSORED BRANDS DELIBERATELY NOT INCLUDED — this writes to
 * SHEET_AD_ORDERS, which is ASIN-level. SB has no ASIN-level report at
 * all (it promotes the brand storefront, not individual products) — the
 * same asymmetry already confirmed for the regular daily advertising
 * pipeline (sync-advertising-process.js). If event-scoped SB tracking is
 * ever wanted, it would need a separate, CAMPAIGN-level piece mirroring
 * SHEET_ADVERTISING, not an addition here.
 *
 * SPONSORED DISPLAY DAILY GRANULARITY — UNVERIFIED, FLAGGED: SD's
 * 'date' column for DAILY timeUnit has never been directly confirmed
 * the way spAdvertisedProduct's was (test-sd-connection.js only ever
 * tested SD with timeUnit=SUMMARY, no date column requested). Requesting
 * it here on the same precedent as SP's DAILY variant, since SD's other
 * confirmed columns have consistently mirrored SP's structure so far —
 * but this is a reasonable extrapolation, not a confirmed fact. The
 * existing ?debug=true mode in sync-event-ad-orders-process.js has been
 * extended to surface SD's first raw row too, specifically so this can
 * be checked against real data before trusting it in the real write path
 * — same safety net the SP side already used for its own date column.
 *
 * DAILY GRANULARITY (both report types): requests each event's reports
 * with timeUnit=DAILY, so every row carries a real per-day date within
 * the event window — one row per ASIN per day, not one summary row per
 * ASIN for the whole event.
 *
 * Matching logic, meta tab naming, and the ?tab= single-event filter are
 * identical to sync-event-orders-request.js — see that file for the full
 * rationale (keyword substring matching against Events tab, skip tabs
 * with no match or blank dates, etc).
 *
 * Stores reportIds in SHEET_AD_ORDERS's `_meta_events` tab (this sheet's
 * own meta tab — separate from the orders sheet's `_meta_events`, since
 * these are two different sheets). Keys are now report-type-scoped
 * (report_id_sp_<tab>, report_id_sd_<tab>) rather than the single
 * report_id_<tab> used before this change, to hold two report IDs per
 * event tab instead of one.
 *
 * Manual, one event at a time (recommended given data volume):
 *   GET /api/cron/sync-event-ad-orders-request?tab=Prime%20Day
 *   Authorization: Bearer <CRON_SECRET>
 */

const { getAdToken }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                                = require('../config/sheets');
const https                                 = require('https');

const AD_API_HOST  = 'advertising-api.amazon.com';
const META_TAB     = '_meta_events';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];
const EVENTS_TAB   = 'Events';

const TARGET_TABS = [
  { tabName: 'Big Spring Sale',               keywords: ['big spring sale'] },
  { tabName: 'Prime Day',                     keywords: ['prime day'] },
  { tabName: 'Prime Big Deal Days',           keywords: ['prime big deal days', 'big deal days'] },
  { tabName: 'Black Friday and Cyber Monday', keywords: ['black friday', 'cyber monday'] },
];

// Both report types share the same shape apart from reportTypeId/adProduct
// and their promoted-item column names — requested together per event via
// requestBothReports() below, rather than duplicating this twice inline.
async function requestBothReports(token, profileId, startDate, endDate, tabName) {
  const spReportId = await requestReportWithRetry(
    token, profileId, 'spAdvertisedProduct', 'SPONSORED_PRODUCTS',
    { startDate, endDate }, ['advertiser'],
    ['date', 'advertisedAsin', 'impressions', 'clicks', 'spend', 'purchases14d', 'unitsSoldClicks14d', 'sales14d'],
    `${tabName} (SP)`
  );
  // ADDED 2026-08-19 — see file header for the unverified 'date' column caveat.
  const sdReportId = await requestReportWithRetry(
    token, profileId, 'sdAdvertisedProduct', 'SPONSORED_DISPLAY',
    { startDate, endDate }, ['advertiser'],
    ['date', 'campaignName', 'campaignId', 'adGroupName', 'promotedAsin', 'promotedSku', 'impressions', 'clicks', 'cost', 'purchases', 'sales', 'unitsSold'],
    `${tabName} (SD)`
  );
  return { spReportId, sdReportId };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const ts  = now.toISOString();
  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  if (!sheets.masterSkuList) return res.status(500).json({ error: 'sheets.masterSkuList is not configured' });
  if (!sheets.adOrders)      return res.status(500).json({ error: 'sheets.adOrders is not configured' });

  // ── Manual override — same one-off backfill path as
  // sync-event-orders-request.js. Bypasses Events tab matching entirely.
  //   GET ?startDate=2025-06-21&endDate=2025-06-24&outTab=Prime Day 2025
  if (req.query.startDate && req.query.endDate && req.query.outTab) {
    let overrideToken, overrideProfileId;
    try {
      overrideToken     = await getAdToken();
      overrideProfileId = await discoverProfileId(overrideToken);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to auth/discover ad profile', detail: err.message });
    }

    const overrideEndRaw = `${req.query.endDate}T23:59:59Z`;
    const overrideEnd = overrideEndRaw > safeBefore ? safeBefore.slice(0, 10) : req.query.endDate;
    const tabName = req.query.outTab;

    const { spReportId, sdReportId } = await requestBothReports(overrideToken, overrideProfileId, req.query.startDate, overrideEnd, tabName);
    if (!spReportId && !sdReportId) return res.status(500).json({ error: 'Both report requests failed for override' });

    try {
      const metaToken = await ensureTab(sheets.adOrders, META_TAB, META_HEADERS);
      const rawMeta   = await readRows(sheets.adOrders, META_TAB);
      const metaMap2  = {};
      (rawMeta || []).forEach(r => { if (r.KEY) metaMap2[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });

      metaMap2[`report_id_sp_${tabName}`] = [`report_id_sp_${tabName}`, spReportId || '', ts];
      metaMap2[`report_id_sd_${tabName}`] = [`report_id_sd_${tabName}`, sdReportId || '', ts];
      metaMap2[`processed_${tabName}`]    = [`processed_${tabName}`, 'false', ts];
      const existingTargets = ((metaMap2['target_tabs'] || [])[1] || '').split(',').filter(Boolean);
      metaMap2['target_tabs']  = ['target_tabs', Array.from(new Set([...existingTargets, tabName])).join(','), ts];
      metaMap2['ad_profile_id'] = ['ad_profile_id', String(overrideProfileId), ts];

      await replaceRows(sheets.adOrders, META_TAB, META_HEADERS, Object.values(metaMap2), metaToken);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to write meta for override', detail: err.message, spReportId, sdReportId });
    }

    return res.status(200).json({ mode: 'manual_override', outTab: tabName, spReportId, sdReportId, start: req.query.startDate, end: overrideEnd });
  }

  // ── 1. Read Events tab, apply optional ?tab= filter ─────────────────────
  let eventRows;
  try {
    eventRows = await readRows(sheets.masterSkuList, EVENTS_TAB);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read Events tab', detail: err.message });
  }

  const tabFilter = (req.query.tab || '').toLowerCase().trim();
  const activeTargets = tabFilter
    ? TARGET_TABS.filter(t => t.tabName.toLowerCase() === tabFilter)
    : TARGET_TABS;

  if (tabFilter && !activeTargets.length) {
    return res.status(400).json({ error: `No target tab named "${req.query.tab}"`, validTabs: TARGET_TABS.map(t => t.tabName) });
  }

  const matched = [];
  const skipped = [];

  for (const target of activeTargets) {
    const candidates = eventRows.filter(r => {
      const name = (r['Event Name'] || '').toLowerCase();
      return target.keywords.some(kw => name.includes(kw));
    });
    if (!candidates.length) { skipped.push({ tabName: target.tabName, reason: 'no matching row in Events tab' }); continue; }

    candidates.sort((a, b) => (b['end_date'] || '').localeCompare(a['end_date'] || ''));
    const best = candidates[0];
    const startDate = (best['start_date'] || '').trim();
    const endDate   = (best['end_date'] || '').trim();

    if (!startDate || !endDate) {
      skipped.push({ tabName: target.tabName, reason: `matched "${best['Event Name']}" but start_date/end_date is blank` });
      continue;
    }

    const cappedEnd = `${endDate}T23:59:59Z` > safeBefore ? safeBefore.slice(0, 10) : endDate;
    matched.push({ tabName: target.tabName, startDate, endDate: cappedEnd, matchedEventName: best['Event Name'] });
  }

  if (skipped.length) console.log('[sync-event-ad-orders-request] skipped:', JSON.stringify(skipped));
  if (!matched.length) return res.status(200).json({ message: 'No target tabs matched a valid event with real dates', skipped });

  // ── 2. Request SP + SD reports per matched event ────────────────────────
  let token, profileId;
  try {
    token     = await getAdToken();
    profileId = await discoverProfileId(token);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to auth/discover ad profile', detail: err.message });
  }

  const reportIdsByTab = {};
  for (const m of matched) {
    const { spReportId, sdReportId } = await requestBothReports(token, profileId, m.startDate, m.endDate, m.tabName);
    reportIdsByTab[m.tabName] = { spReportId, sdReportId };
  }

  const anySucceeded = Object.values(reportIdsByTab).some(r => r.spReportId || r.sdReportId);
  if (!anySucceeded) return res.status(500).json({ error: 'All report requests failed', matched, skipped });

  // ── 3. Write meta (accumulates across separate single-event calls) ─────
  try {
    const metaToken = await ensureTab(sheets.adOrders, META_TAB, META_HEADERS);
    const rawMeta   = await readRows(sheets.adOrders, META_TAB);
    const metaMap   = {};
    (rawMeta || []).forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });

    for (const m of matched) {
      const { spReportId, sdReportId } = reportIdsByTab[m.tabName] || {};
      if (!spReportId && !sdReportId) continue;
      metaMap[`report_id_sp_${m.tabName}`] = [`report_id_sp_${m.tabName}`, spReportId || '', ts];
      metaMap[`report_id_sd_${m.tabName}`] = [`report_id_sd_${m.tabName}`, sdReportId || '', ts];
      metaMap[`processed_${m.tabName}`]    = [`processed_${m.tabName}`, 'false', ts];
    }
    const existingTargets = ((metaMap['target_tabs'] || [])[1] || '').split(',').filter(Boolean);
    const newTargets = matched.filter(m => reportIdsByTab[m.tabName]?.spReportId || reportIdsByTab[m.tabName]?.sdReportId).map(m => m.tabName);
    const allTargets = Array.from(new Set([...existingTargets, ...newTargets]));
    metaMap['target_tabs']  = ['target_tabs', allTargets.join(','), ts];
    metaMap['ad_profile_id'] = ['ad_profile_id', String(profileId), ts];

    await replaceRows(sheets.adOrders, META_TAB, META_HEADERS, Object.values(metaMap), metaToken);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to write meta', detail: err.message, reportIdsByTab });
  }

  res.status(200).json({ reportIdsByTab, matched, skipped });
};

// ── Helpers (auth/retry logic copied from sync-advertising-request.js) ────

const MAX_RETRIES = 3;
const DUPLICATE_ID_REGEX = /duplicate of\s*:\s*([a-f0-9-]+)/i;

async function requestReportWithRetry(token, profileId, reportTypeId, adProduct, dateRange, groupBy, columns, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { statusCode, body, retryAfterSec } = await adRequestRaw('POST', '/reporting/reports', token, profileId, {
      name:      `event_${reportTypeId}_${label}_${dateRange.endDate}`,
      startDate: dateRange.startDate,
      endDate:   dateRange.endDate,
      configuration: { adProduct, groupBy, columns, reportTypeId, timeUnit: 'DAILY', format: 'GZIP_JSON' },
    });

    if (body?.reportId) {
      console.log(`[sync-event-ad-orders-request] ${label}: ${body.reportId}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return body.reportId;
    }

    const duplicateMatch = (statusCode === 425 || body?.code === '425') && body?.detail?.match(DUPLICATE_ID_REGEX);
    if (duplicateMatch) {
      console.log(`[sync-event-ad-orders-request] ${label}: reusing existing report ${duplicateMatch[1]}`);
      return duplicateMatch[1];
    }

    const isThrottled = statusCode === 429 || body?.code === '429';
    if (isThrottled && attempt < MAX_RETRIES) {
      const waitSec = retryAfterSec ?? (2 * attempt);
      console.warn(`[sync-event-ad-orders-request] ${label} throttled (attempt ${attempt}/${MAX_RETRIES}), retrying in ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }

    console.error(`[sync-event-ad-orders-request] ${label} failed (attempt ${attempt}/${MAX_RETRIES}):`, JSON.stringify(body));
    return null;
  }
  return null;
}

async function discoverProfileId(token) {
  const profiles = await adRequest('GET', '/v2/profiles', token, null, null);
  const newdermUS = profiles.find(p =>
    p.countryCode === 'US' &&
    p.accountInfo?.type === 'seller' &&
    (p.accountInfo?.name?.toLowerCase().includes('newderm') || p.accountInfo?.id === 'A25QTQX4QSLFM9')
  );
  if (!newdermUS) throw new Error('NewDerm US seller profile not found');
  return newdermUS.profileId;
}

function adRequest(method, path, token, profileId, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                   `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Content-Type':                    'application/json',
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
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(d), retryAfterSec }); }
        catch (e) { resolve({ statusCode: res.statusCode, body: { parseError: d.slice(0, 300) }, retryAfterSec }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
