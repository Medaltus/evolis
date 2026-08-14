/**
 * api/test-sd-connection.js
 * ONE-OFF diagnostic tool — verifies Sponsored Display's real report
 * schema before building actual ingestion into sync-advertising-request.js
 * / sync-advertising-process.js / sync-advertising-backfill.js.
 *
 * WHY THIS EXISTS: sdAdvertisedProduct (adProduct: SPONSORED_DISPLAY) is
 * confirmed real by Amazon's own engineering team (GitHub discussion,
 * amzn/ads-advanced-tools-docs#347). A campaign-level equivalent likely
 * exists as sdCampaigns, following the spCampaigns/sbCampaigns naming
 * pattern, but that's an inference, not a confirmed fact. More
 * importantly, SD's actual COLUMN NAMES are NOT confirmed at all — SD
 * metrics genuinely differ from SP/SB (e.g. viewImpressions,
 * viewAttributedSales14d exist for display ads with no SP/SB
 * equivalent, per amzn/ads-advanced-tools-docs#165). Guessing these wrong
 * risks the same silent-zero bug already found and fixed today in
 * sync-business-report-process.js's sessionsB2B field. This tool lets you
 * see Amazon's REAL response before any of that gets written.
 *
 * SD also has NO keyword/search-term report at all — confirmed by Amazon:
 * "Keyword is not currently a supported targeting type for Sponsored
 * Display... there is no keyword report for Sponsored Display." SD
 * targets audiences/products instead — this tool requests a targeting
 * report as its second report to see that schema too, since that's SD's
 * closest equivalent to SP/SB's keyword-level detail.
 *
 * Writes NOTHING to any sheet — reports back what Amazon actually returns
 * so the real ingestion pipeline can be built against confirmed field
 * names instead of guesses.
 *
 * Usage — two-step, since Amazon's Reporting API is async:
 *   Step 1 — request both reports for a short recent window:
 *     GET /api/test-sd-connection?step=request
 *     Authorization: Bearer <CRON_SECRET>
 *     → returns { productReportId, targetingReportId }
 *
 *   Step 2 — wait 15-20 min, then check status and see the real data:
 *     GET /api/test-sd-connection?step=check&productReportId=...&targetingReportId=...
 *     Authorization: Bearer <CRON_SECRET>
 *     → returns real column names + first 5 rows of each report, raw
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
      // Last 7 days — short window, just enough to confirm schema, not a
      // real ingestion range. Minimal, conservative column guesses below —
      // this is exactly what step=check will confirm or correct.
      const { startDate, endDate } = last7DaysRange();

      const productReportId = await requestReport(token, profileId, {
        name: `test_sd_product_${endDate}`,
        startDate, endDate,
        configuration: {
          adProduct: 'SPONSORED_DISPLAY',
          groupBy: ['advertiser'],
          columns: ['campaignName', 'advertisedAsin', 'impressions', 'clicks', 'cost', 'purchases', 'sales', 'viewImpressions', 'viewAttributedSales14d'],
          reportTypeId: 'sdAdvertisedProduct', // CONFIRMED real by Amazon's own team
          timeUnit: 'SUMMARY',
          format: 'GZIP_JSON',
        },
      });

      // UNCONFIRMED report type name — 'sdTargeting' is a guess following
      // Amazon's naming pattern (SD has no keyword report, per the header
      // comment above; targeting is its closest equivalent). If this
      // fails, that's useful information too — check the error body.
      const targetingReportId = await requestReport(token, profileId, {
        name: `test_sd_targeting_${endDate}`,
        startDate, endDate,
        configuration: {
          adProduct: 'SPONSORED_DISPLAY',
          groupBy: ['targeting'],
          columns: ['campaignName', 'targetingText', 'targetingType', 'impressions', 'clicks', 'cost', 'purchases', 'sales'],
          reportTypeId: 'sdTargeting', // UNCONFIRMED — best guess, see header comment
          timeUnit: 'SUMMARY',
          format: 'GZIP_JSON',
        },
      });

      return res.status(200).json({
        productReportId: productReportId.id,
        productReportError: productReportId.error,
        targetingReportId: targetingReportId.id,
        targetingReportError: targetingReportId.error,
        note: 'Wait 15-20 min, then call ?step=check with both IDs to see the real column names and sample rows.',
      });
    }

    // step === 'check'
    const { productReportId, targetingReportId } = req.query;
    if (!productReportId && !targetingReportId) {
      return res.status(400).json({ error: 'Provide at least one of ?productReportId= or ?targetingReportId=' });
    }

    const result = {};
    if (productReportId) result.product = await checkAndSample(token, profileId, productReportId);
    if (targetingReportId) result.targeting = await checkAndSample(token, profileId, targetingReportId);

    return res.status(200).json(result);

  } catch (err) {
    console.error('[test-sd-connection] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function requestReport(token, profileId, body) {
  try {
    const resp = await adRequest('POST', '/reporting/reports', token, profileId, body);
    if (resp?.reportId) return { id: resp.reportId };
    return { id: null, error: resp };
  } catch (err) {
    return { id: null, error: err.message };
  }
}

async function checkAndSample(token, profileId, reportId) {
  const statusResp = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
  if (statusResp.status !== 'COMPLETED') {
    return { status: statusResp.status, note: 'Not ready yet — try ?step=check again shortly.' };
  }

  const rows = await downloadAndParse(statusResp.url);
  return {
    status: 'COMPLETED',
    rowCount: rows.length,
    realColumnNames: rows.length ? Object.keys(rows[0]) : [],
    sampleRows: rows.slice(0, 5),
  };
}

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

// Same US-profile discovery as every other advertising file — see
// sync-advertising-backfill.js's header comment for the known limitation
// that this doesn't (yet) support a Canadian ad profile.
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
