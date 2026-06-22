/**
 * api/cron/sync-advertising-request.js
 * Step 1 of 2 — requests Amazon Advertising reports and stores report IDs in _meta tab.
 * Runs at 3:00 AM UTC daily.
 *
 * Fires two SP report requests:
 *   1. spAdvertisedProduct (ASIN-level) — for per-ASIN ad units
 *   2. spCampaigns (campaign-level)     — for brand-level summary metrics
 *
 * Stores report IDs in SHEET_ADVERTISING → _meta tab so sync-advertising-process
 * can pick them up 15 minutes later once Amazon has finished generating them.
 *
 * _meta tab structure: KEY | VALUE | UPDATED_AT
 *   ad_report_id_asin     — reportId for spAdvertisedProduct report
 *   ad_report_id_summary  — reportId for spCampaigns report
 *   ad_report_status      — REQUESTED | PROCESSED
 *   ad_start_date         — report start date
 *   ad_end_date           — report end date
 *   ad_profile_id         — profile ID used
 */

const { getAdToken }                             = require('../_spauth');
const { ensureTab, readRows, replaceRows }        = require('../config/_sheets_client');
const https                                      = require('https');

const AD_API_HOST  = 'advertising-api.amazon.com';
const SHEET_AD_SUMMARY = process.env.SHEET_ADVERTISING;
const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

// Default: last 7 days. Pass ?days=N (max 30) to override.
const DEFAULT_DAYS = 30;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now  = new Date().toISOString();
  const days = Math.min(parseInt(req.query.days, 10) || DEFAULT_DAYS, 30);
  const { startDate, endDate } = getDateRange(days);

  console.log(`[sync-advertising-request] date range: ${startDate} → ${endDate}`);

  try {
    // ── 1. Get LWA token + discover profile ──────────────────────────────────
    const token     = await getAdToken();
    const profileId = await discoverProfileId(token);
    console.log(`[sync-advertising-request] using profileId=${profileId}`);

    // ── 2. Request ASIN-level report ──────────────────────────────────────────
    let asinReportId = null;
    try {
      const resp = await adRequest('POST', '/reporting/reports', token, profileId, {
        name:      `ad_asin_${endDate}`,
        startDate,
        endDate,
        configuration: {
          adProduct:    'SPONSORED_PRODUCTS',
          groupBy:      ['advertiser'],
          columns:      ['advertisedAsin', 'impressions', 'clicks', 'spend', 'purchases14d', 'unitsSoldClicks14d', 'sales14d'],
          reportTypeId: 'spAdvertisedProduct',
          timeUnit:     'SUMMARY',
          format:       'GZIP_JSON',
        },
      });
      asinReportId = resp.reportId;
      console.log(`[sync-advertising-request] ASIN report requested: ${asinReportId}`);
    } catch (err) {
      console.error('[sync-advertising-request] ASIN report request failed:', err.message);
    }

    // ── 3. Request portfolio-level summary report ─────────────────────────────
    // Group by campaign but include portfolioName so we can aggregate per brand.
    // portfolioName matches the names in the Amazon Ads console portfolio list.
    let summaryReportId = null;
    try {
      const resp = await adRequest('POST', '/reporting/reports', token, profileId, {
        name:      `ad_summary_${endDate}`,
        startDate,
        endDate,
        configuration: {
          adProduct:    'SPONSORED_PRODUCTS',
          groupBy:      ['campaign'],
          columns:      ['campaignName', 'impressions', 'clicks', 'spend', 'purchases14d', 'sales14d', 'unitsSoldClicks14d'],
          reportTypeId: 'spCampaigns',
          timeUnit:     'SUMMARY',
          format:       'GZIP_JSON',
        },
      });
      summaryReportId = resp.reportId;
      console.log(`[sync-advertising-request] summary report requested: ${summaryReportId}`);
    } catch (err) {
      console.error('[sync-advertising-request] summary report request failed:', err.message);
    }

    if (!asinReportId && !summaryReportId) {
      return res.status(500).json({ error: 'Both report requests failed' });
    }

    // ── 4. Write report IDs to _meta tab ──────────────────────────────────────
    const metaRows = [
      ['ad_report_id_asin',    asinReportId    || '',  now],
      ['ad_report_id_summary', summaryReportId || '',  now],
      ['ad_report_status',     'REQUESTED',            now],
      ['ad_start_date',        startDate,              now],
      ['ad_end_date',          endDate,                now],
      ['ad_profile_id',        String(profileId),      now],
      ['ad_backfill',          'false',                now],
    ];

    const token2 = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    // Read existing _meta rows (may have revenue keys) and merge
    const existing = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const existingMap = {};
    existing.forEach(r => { if (r.KEY) existingMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaRows.forEach(r => { existingMap[r[0]] = r; });
    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(existingMap), token2);

    return res.status(200).json({
      asinReportId,
      summaryReportId,
      startDate,
      endDate,
      profileId,
      note: 'Run sync-advertising-process in 10-15 minutes',
    });

  } catch (err) {
    console.error('[sync-advertising-request] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function getDateRange(days) {
  const pad   = x => String(x).padStart(2, '0');
  const end   = new Date(); end.setDate(end.getDate() - 1);
  const start = new Date(end); start.setDate(start.getDate() - (days - 1));
  const fmt   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return { startDate: fmt(start), endDate: fmt(end) };
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
