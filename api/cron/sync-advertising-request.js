/**
 * api/cron/sync-advertising-request.js
 * Step 1 of 2 — requests Amazon Advertising reports and stores report IDs in _meta tab.
 * Runs at 3:00 AM UTC daily.
 *
 * Fires 6 report requests per run:
 *   Current month MTD (1st of this month → yesterday):
 *     1. spAdvertisedProduct  — ASIN-level SP ad units
 *     2. spCampaigns          — SP campaign-level brand summary
 *     3. sbCampaigns          — SB campaign-level brand summary
 *   Last full calendar month (1st → last day of prev month):
 *     4. spAdvertisedProduct  — ASIN-level SP ad units
 *     5. spCampaigns          — SP campaign-level brand summary
 *     6. sbCampaigns          — SB campaign-level brand summary
 *
 * Stores report IDs in SHEET_ADVERTISING → _meta tab:
 *   ad_report_id_asin_curr     — SP ASIN report, current month
 *   ad_report_id_sp_curr       — SP campaign report, current month
 *   ad_report_id_sb_curr       — SB campaign report, current month
 *   ad_report_id_asin_prev     — SP ASIN report, last full month
 *   ad_report_id_sp_prev       — SP campaign report, last full month
 *   ad_report_id_sb_prev       — SB campaign report, last full month
 *   ad_report_status           — REQUESTED | PROCESSED
 *   ad_start_date_curr / ad_end_date_curr
 *   ad_start_date_prev / ad_end_date_prev
 *   ad_profile_id
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

  console.log(`[sync-advertising-request] curr: ${curr.startDate} → ${curr.endDate}`);
  console.log(`[sync-advertising-request] prev: ${prev.startDate} → ${prev.endDate}`);

  try {
    const token     = await getAdToken();
    const profileId = await discoverProfileId(token);
    console.log(`[sync-advertising-request] using profileId=${profileId}`);

    // ── Request all 6 reports in parallel ────────────────────────────────────
    const [
      asinCurrResp,
      spCurrResp,
      sbCurrResp,
      asinPrevResp,
      spPrevResp,
      sbPrevResp,
    ] = await Promise.allSettled([
      requestReport(token, profileId, 'spAdvertisedProduct', 'SPONSORED_PRODUCTS', curr, ['advertiser'],  ['advertisedAsin','impressions','clicks','spend','purchases14d','unitsSoldClicks14d','sales14d']),
      requestReport(token, profileId, 'spCampaigns',         'SPONSORED_PRODUCTS', curr, ['campaign'],    ['campaignName','impressions','clicks','spend','purchases14d','sales14d','unitsSoldClicks14d']),
      requestReport(token, profileId, 'sbCampaigns',         'SPONSORED_BRANDS',   curr, ['campaign'],    ['campaignName','impressions','clicks','cost','purchases14d','sales14d','unitsSoldClicks14d']),
      requestReport(token, profileId, 'spAdvertisedProduct', 'SPONSORED_PRODUCTS', prev, ['advertiser'],  ['advertisedAsin','impressions','clicks','spend','purchases14d','unitsSoldClicks14d','sales14d']),
      requestReport(token, profileId, 'spCampaigns',         'SPONSORED_PRODUCTS', prev, ['campaign'],    ['campaignName','impressions','clicks','spend','purchases14d','sales14d','unitsSoldClicks14d']),
      requestReport(token, profileId, 'sbCampaigns',         'SPONSORED_BRANDS',   prev, ['campaign'],    ['campaignName','impressions','clicks','cost','purchases14d','sales14d','unitsSoldClicks14d']),
    ]);

    const getId = (result, label) => {
      if (result.status === 'fulfilled' && result.value?.reportId) {
        console.log(`[sync-advertising-request] ${label}: ${result.value.reportId}`);
        return result.value.reportId;
      }
      console.error(`[sync-advertising-request] ${label} failed:`, result.reason?.message || JSON.stringify(result.value).slice(0,200));
      return null;
    };

    const asinCurrId = getId(asinCurrResp, 'asin_curr');
    const spCurrId   = getId(spCurrResp,   'sp_curr');
    const sbCurrId   = getId(sbCurrResp,   'sb_curr');
    const asinPrevId = getId(asinPrevResp, 'asin_prev');
    const spPrevId   = getId(spPrevResp,   'sp_prev');
    const sbPrevId   = getId(sbPrevResp,   'sb_prev');

    // Require at least one curr and one prev report to succeed
    if (!spCurrId && !sbCurrId) return res.status(500).json({ error: 'All current month report requests failed' });
    if (!spPrevId && !sbPrevId) return res.status(500).json({ error: 'All previous month report requests failed' });

    // ── Write report IDs to _meta ─────────────────────────────────────────────
    const metaRows = [
      ['ad_report_id_asin_curr', asinCurrId || '', now],
      ['ad_report_id_sp_curr',   spCurrId   || '', now],
      ['ad_report_id_sb_curr',   sbCurrId   || '', now],
      ['ad_report_id_asin_prev', asinPrevId || '', now],
      ['ad_report_id_sp_prev',   spPrevId   || '', now],
      ['ad_report_id_sb_prev',   sbPrevId   || '', now],
      ['ad_report_status',       'REQUESTED',      now],
      ['ad_start_date_curr',     curr.startDate,   now],
      ['ad_end_date_curr',       curr.endDate,     now],
      ['ad_start_date_prev',     prev.startDate,   now],
      ['ad_end_date_prev',       prev.endDate,     now],
      ['ad_profile_id',          String(profileId),now],
      ['ad_backfill',            'false',          now],
    ];

    const token2   = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    const existing = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const metaMap  = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaRows.forEach(r => { metaMap[r[0]] = r; });
    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);

    return res.status(200).json({
      curr: { asinReportId: asinCurrId, spReportId: spCurrId, sbReportId: sbCurrId, ...curr },
      prev: { asinReportId: asinPrevId, spReportId: spPrevId, sbReportId: sbPrevId, ...prev },
      note: 'Run sync-advertising-process in 10-15 minutes',
    });

  } catch (err) {
    console.error('[sync-advertising-request] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requestReport(token, profileId, reportTypeId, adProduct, dateRange, groupBy, columns) {
  return adRequest('POST', '/reporting/reports', token, profileId, {
    name:      `ad_${reportTypeId}_${dateRange.endDate}`,
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
