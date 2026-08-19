/**
 * api/test-ca-ad-campaigns.js
 * ONE-OFF diagnostic — requests real Canadian campaign data using the
 * confirmed CA ad profile (profileId 257626120209879, same NewDerm
 * seller account, same LWA credentials as every other advertising file
 * — confirmed via test-ad-profiles.js, 2026-08-19).
 *
 * WHY THIS EXISTS: the campaign-name matching for skinuva-ca in
 * sync-advertising-process.js and sync-ad-search-terms-process.js
 * currently contains three GUESSED variants ("skinuva ca", "skinuva-ca",
 * "skinuva canada") — added back when Jaclyn confirmed no CA ads existed
 * yet to check against. Now that real CA ads are confirmed running,
 * this checks the actual campaign names before trusting those guesses
 * or building the full CA request/process pipeline.
 *
 * Uses spCampaigns (already confirmed real and working for the US
 * profile) — same reporting pattern, just scoped to the CA profileId
 * instead of the US one. No new report type or endpoint being tested
 * here, only a different profile scope.
 *
 * Writes nothing anywhere.
 *
 * Usage — two-step, same as every other reporting-API diagnostic:
 *   Step 1:
 *     GET /api/test-ca-ad-campaigns?step=request
 *     Authorization: Bearer <CRON_SECRET>
 *
 *   Step 2, 15-20 min later:
 *     GET /api/test-ca-ad-campaigns?step=check&reportId=...
 *     Authorization: Bearer <CRON_SECRET>
 */

const { getAdToken } = require('./_spauth');
const https          = require('https');

const AD_API_HOST = 'advertising-api.amazon.com';
const CA_PROFILE_ID = '257626120209879'; // confirmed via test-ad-profiles.js — NewDerm, countryCode CA

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const step = req.query.step;
  if (step !== 'request' && step !== 'check') {
    return res.status(400).json({ error: 'Required: ?step=request or ?step=check' });
  }

  try {
    const token = await getAdToken();

    if (step === 'request') {
      const { startDate, endDate } = last30DaysRange();

      const resp = await adRequest('POST', '/reporting/reports', token, CA_PROFILE_ID, {
        name: `test_ca_campaigns_${endDate}`,
        startDate, endDate,
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: ['campaign'],
          columns: ['campaignName', 'campaignId', 'impressions', 'clicks', 'spend', 'purchases14d', 'sales14d', 'unitsSoldClicks14d'],
          reportTypeId: 'spCampaigns',
          timeUnit: 'SUMMARY',
          format: 'GZIP_JSON',
        },
      });

      if (resp?.reportId) {
        return res.status(200).json({
          reportId: resp.reportId,
          profileUsed: CA_PROFILE_ID,
          note: 'Request accepted under the CA profile. Wait 15-20 min, then ?step=check to see real Canadian campaign names.',
        });
      }

      return res.status(200).json({ reportId: null, rawErrorResponse: resp });
    }

    // step === 'check'
    const { reportId } = req.query;
    if (!reportId) return res.status(400).json({ error: 'Provide ?reportId=...' });

    const statusResp = await adRequest('GET', `/reporting/reports/${reportId}`, token, CA_PROFILE_ID);
    if (statusResp.status !== 'COMPLETED') {
      return res.status(200).json({ status: statusResp.status, note: 'Not ready yet — try again shortly.', raw: statusResp });
    }

    const rows = await downloadAndParse(statusResp.url);
    return res.status(200).json({
      status: 'COMPLETED',
      rowCount: rows.length,
      allCampaignNames: rows.map(r => r.campaignName),
      sampleRows: rows.slice(0, 10),
      note: 'Compare allCampaignNames against the guessed skinuva-ca variants in sync-advertising-process.js / sync-ad-search-terms-process.js (CAMPAIGN_BRANDS list) — correct them if the real names differ. Also check whether any OTHER brand names show up here, not just skinuva.',
    });

  } catch (err) {
    console.error('[test-ca-ad-campaigns] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function downloadAndParse(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        require('zlib').gunzip(buf, (err, decoded) => {
          if (err) {
            try { resolve(JSON.parse(buf.toString())); } catch (e) { reject(e); }
            return;
          }
          try { resolve(JSON.parse(decoded.toString())); } catch (e) { reject(e); }
        });
      });
    }).on('error', reject);
  });
}

function last30DaysRange() {
  const pad = x => String(x).padStart(2, '0');
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { startDate: fmt(thirtyDaysAgo), endDate: fmt(yesterday) };
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
