/**
 * api/cron/sync-advertising-backfill.js
 * Manual backfill — requests ad reports for a specific calendar month.
 * Uses the same request → _meta → process pattern as the daily cron.
 *
 * Usage:
 *   Step 1 — Request reports for a month:
 *     curl "https://evolis-xi.vercel.app/api/cron/sync-advertising-backfill?month=2025-06" \
 *       -H "Authorization: Bearer r29fu&7S;gq@\$bOw"
 *
 *   Step 2 — Wait 15 minutes, then run the normal process step:
 *     curl https://evolis-xi.vercel.app/api/cron/sync-advertising-process \
 *       -H "Authorization: Bearer r29fu&7S;gq@\$bOw"
 *
 *   Repeat for each month working backwards from most recent:
 *     2026-05 → 2026-04 → 2026-03 → 2026-02 → 2026-01
 *     2025-12 → 2025-11 → 2025-10 → 2025-09 → 2025-08 → 2025-07 → 2025-06
 *
 * The ad_backfill=true flag in _meta tells sync-advertising-process to
 * append rows rather than replace, so historical months aren't overwritten.
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

  const monthParam = req.query.month;
  if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
    return res.status(400).json({ error: 'Required: ?month=YYYY-MM (e.g. ?month=2025-06)' });
  }

  const [yearStr, monthStr] = monthParam.split('-');
  const year  = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const pad   = x => String(x).padStart(2, '0');

  const lastDay   = new Date(year, month, 0).getDate();
  const startDate = `${year}-${pad(month)}-01`;
  const endDate   = `${year}-${pad(month)}-${pad(lastDay)}`;

  if (new Date(endDate) > new Date()) {
    return res.status(400).json({ error: `Cannot backfill future month: ${monthParam}` });
  }

  const now = new Date().toISOString();
  console.log(`[sync-advertising-backfill] month=${monthParam} range: ${startDate} → ${endDate}`);

  try {
    const token     = await getAdToken();
    const profileId = await discoverProfileId(token);

    let asinReportId = null;
    try {
      const resp = await adRequest('POST', '/reporting/reports', token, profileId, {
        name: `backfill_asin_${monthParam}`,
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
      console.log(`[sync-advertising-backfill] ASIN report: ${asinReportId}`);
    } catch (err) {
      console.error('[sync-advertising-backfill] ASIN report failed:', err.message);
    }

    let summaryReportId = null;
    try {
      const resp = await adRequest('POST', '/reporting/reports', token, profileId, {
        name: `backfill_summary_${monthParam}`,
        startDate,
        endDate,
        configuration: {
          adProduct:    'SPONSORED_PRODUCTS',
          groupBy:      ['campaign'],
          columns:      ['portfolioId', 'portfolioName', 'impressions', 'clicks', 'spend', 'purchases14d', 'sales14d', 'unitsSoldClicks14d'],
          reportTypeId: 'spCampaigns',
          timeUnit:     'SUMMARY',
          format:       'GZIP_JSON',
        },
      });
      summaryReportId = resp.reportId;
      console.log(`[sync-advertising-backfill] summary report: ${summaryReportId}`);
    } catch (err) {
      console.error('[sync-advertising-backfill] summary report failed:', err.message);
    }

    if (!asinReportId && !summaryReportId) {
      return res.status(500).json({ error: 'Both report requests failed' });
    }

    // Write to _meta — merge with existing keys so revenue keys aren't clobbered
    const metaRows = [
      ['ad_report_id_asin',    asinReportId    || '', now],
      ['ad_report_id_summary', summaryReportId || '', now],
      ['ad_report_status',     'REQUESTED',           now],
      ['ad_start_date',        startDate,             now],
      ['ad_end_date',          endDate,               now],
      ['ad_profile_id',        String(profileId),     now],
      ['ad_backfill',          'true',                now],
    ];

    const token2     = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    const existing   = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const metaMap    = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaRows.forEach(r => { metaMap[r[0]] = r; });
    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);

    return res.status(200).json({
      month: monthParam, asinReportId, summaryReportId, startDate, endDate, profileId,
      note: 'Wait 15 min then run sync-advertising-process',
    });

  } catch (err) {
    console.error('[sync-advertising-backfill] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function discoverProfileId(token) {
  const profiles = await adRequest('GET', '/v2/profiles', token, null, null);
  const p = profiles.find(p =>
    p.countryCode === 'US' && p.accountInfo?.type === 'seller' &&
    (p.accountInfo?.name?.toLowerCase().includes('newderm') || p.accountInfo?.id === 'A25QTQX4QSLFM9')
  );
  if (!p) throw new Error('NewDerm US seller profile not found');
  return p.profileId;
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
        catch (e) { reject(new Error(`Ad API parse error (${res.statusCode}): ${d.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
