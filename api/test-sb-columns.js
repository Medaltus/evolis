/**
 * api/test-sb-columns.js
 * ONE-OFF DIAGNOSTIC — not a cron, not scheduled, not wired into any
 * dashboard. Exists only to answer one question: what are the ACTUAL
 * valid `columns` values for the sbCampaigns report type?
 *
 * How it works: submits a report request to Amazon's Ads Reporting API
 * with a deliberately invalid column name. Amazon's validation error for
 * an invalid column lists every column that IS valid for that report type —
 * so instead of guessing (twice now) or reading a truncated log line, we
 * get the real schema straight from Amazon's own error response, returned
 * here in full with no truncation.
 *
 * Safe to call as many times as needed — it never actually creates a
 * report (the invalid column makes Amazon reject it before that happens),
 * so there's no report-quota cost.
 *
 * DELETE this file (and remove its vercel.json functions entry, if you
 * add one) once sync-advertising-request.js's sbCampaigns columns are
 * fixed and confirmed working — this only exists to answer one question.
 *
 * GET or POST /api/test-sb-columns
 * Authorization: Bearer <CRON_SECRET>
 */

const { getAdToken } = require('./_spauth');
const https           = require('https');

const AD_API_HOST = 'advertising-api.amazon.com';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token     = await getAdToken();
    const profileId = await discoverProfileId(token);

    const probeBody = {
      name:      'sb_columns_schema_probe',
      startDate: '2026-07-01',
      endDate:   '2026-07-01',
      configuration: {
        adProduct:    'SPONSORED_BRANDS',
        groupBy:      ['campaign'],
        // Deliberately invalid — this is the whole trick. Amazon's
        // rejection message enumerates every column that IS allowed.
        columns:      ['__PROBE_INVALID_COLUMN__'],
        reportTypeId: 'sbCampaigns',
        timeUnit:     'SUMMARY',
        format:       'GZIP_JSON',
      },
    };

    const { statusCode, body } = await adRequestRaw('POST', '/reporting/reports', token, profileId, probeBody);

    // Full body, no .slice() truncation anywhere — that's the entire point.
    return res.status(200).json({
      note: 'This is expected to be a 400 with an "Allowed values" list — that list is the real answer.',
      statusCode,
      amazonResponse: body,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function discoverProfileId(token) {
  const { body: profiles } = await adRequestRaw('GET', '/v2/profiles', token, null, null);
  const newdermUS = profiles.find(p =>
    p.countryCode === 'US' &&
    p.accountInfo?.type === 'seller' &&
    (p.accountInfo?.name?.toLowerCase().includes('newderm') ||
     p.accountInfo?.id === 'A25QTQX4QSLFM9')
  );
  if (!newdermUS) throw new Error('NewDerm US seller profile not found');
  return newdermUS.profileId;
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
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ statusCode: res.statusCode, body: { parseError: d } }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
