/**
 * api/test-sd-campaigns.js
 * ONE-OFF diagnostic — tests whether 'sdCampaigns' exists as a real,
 * dedicated campaign-level report type for Sponsored Display, the same
 * way spCampaigns/sbCampaigns work independently of their ASIN-level
 * counterparts.
 *
 * WHY THIS MATTERS: the current implementation (sync-advertising-process.js,
 * 2026-08-19) derives SD's campaign-level totals in SHEET_ADVERTISING by
 * summing its ASIN-level report (sdAdvertisedProduct). Per Jaclyn: the
 * priority is capturing 100% of spend and sales, even if some of it can't
 * be broken out by ASIN — an ASIN-level shortfall is fine, but a
 * CAMPAIGN-level shortfall (missing spend/sales entirely because it
 * wasn't attributed to any specific promoted product) would not be. If a
 * genuine sdCampaigns report exists, it should be used for
 * SHEET_ADVERTISING instead of the derived sum, to guarantee completeness
 * rather than relying on an assumption that the ASIN-level report already
 * captures every dollar.
 *
 * 'sdCampaigns' was never confirmed before this test — it was a guess by
 * naming-convention analogy to spCampaigns/sbCampaigns, never verified.
 * This test reuses the SAME trick that worked for confirming
 * sdAdvertisedProduct/sdTargeting's real columns earlier: Amazon's own
 * 400 validation error, when the reportTypeId itself IS valid but the
 * requested columns aren't, includes the FULL real valid-columns list —
 * more useful than a successful request would have been. If the
 * reportTypeId itself doesn't exist at all, Amazon's error should say
 * something different (invalid report type, not invalid columns) —
 * itself a clear, conclusive answer.
 *
 * Writes nothing anywhere.
 *
 * Usage — two-step, since this is an async SP-API-style report request:
 *   Step 1 — request:
 *     GET /api/test-sd-campaigns?step=request
 *     Authorization: Bearer <CRON_SECRET>
 *
 *   Step 2 — wait 15-20 min, then check:
 *     GET /api/test-sd-campaigns?step=check&reportId=...
 *     Authorization: Bearer <CRON_SECRET>
 */

const { getAdToken } = require('./_spauth');
const https          = require('https');

const AD_API_HOST = 'advertising-api.amazon.com';

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
    const token     = await getAdToken();
    const profileId = await discoverProfileId(token);

    if (step === 'request') {
      const { startDate, endDate } = last7DaysRange();

      const resp = await adRequest('POST', '/reporting/reports', token, profileId, {
        name: `test_sd_campaigns_${endDate}`,
        startDate, endDate,
        configuration: {
          adProduct: 'SPONSORED_DISPLAY',
          groupBy: ['campaign'],
          // Reasonable guess matching spCampaigns/sbCampaigns' own shape
          // — if wrong, Amazon's 400 error will hand us the real list,
          // same trick that worked for sdAdvertisedProduct/sdTargeting.
          columns: ['campaignName', 'campaignId', 'impressions', 'clicks', 'cost', 'purchases', 'sales', 'unitsSold'],
          reportTypeId: 'sdCampaigns', // UNCONFIRMED — this test exists to answer that
          timeUnit: 'SUMMARY',
          format: 'GZIP_JSON',
        },
      });

      if (resp?.reportId) {
        return res.status(200).json({
          reportId: resp.reportId,
          note: 'sdCampaigns accepted the request outright — reportTypeId AND columns both valid on the first guess. Wait 15-20 min, then ?step=check to see real sample data.',
        });
      }

      return res.status(200).json({
        reportId: null,
        rawErrorResponse: resp,
        note: 'No reportId returned — check rawErrorResponse. If it lists valid COLUMNS, sdCampaigns IS a real report type (just wrong guessed columns — use the real list to retry). If it says the report TYPE itself is invalid/unrecognized, sdCampaigns does not exist at all.',
      });
    }

    // step === 'check'
    const { reportId } = req.query;
    if (!reportId) return res.status(400).json({ error: 'Provide ?reportId=...' });

    const statusResp = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId);
    if (statusResp.status !== 'COMPLETED') {
      return res.status(200).json({ status: statusResp.status, note: 'Not ready yet — try again shortly.', raw: statusResp });
    }

    const rows = await downloadAndParse(statusResp.url);
    return res.status(200).json({
      status: 'COMPLETED',
      rowCount: rows.length,
      realColumnNames: rows.length ? Object.keys(rows[0]) : [],
      sampleRows: rows.slice(0, 5),
    });

  } catch (err) {
    console.error('[test-sd-campaigns] fatal:', err.message);
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

function last7DaysRange() {
  const pad = x => String(x).padStart(2, '0');
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { startDate: fmt(sevenDaysAgo), endDate: fmt(yesterday) };
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
