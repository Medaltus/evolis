/**
 * api/test-minimal-search-term.js
 * ONE-OFF DIAGNOSTIC — not a cron. Submits the SMALLEST possible
 * spSearchTerm report (1 day, 3 columns) to isolate whether search term
 * reports are just slow at scale, or something is stuck/wrong regardless
 * of size. If this also hangs at PENDING, the problem isn't report size.
 *
 * Only REQUESTS the report and returns its ID — check status separately
 * with test-minimal-search-term-status.js style polling, or just poll it
 * manually via the reportId this returns.
 *
 * DELETE once the real search terms sync is confirmed working.
 *
 * GET or POST /api/test-minimal-search-term
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

    // Yesterday only — smallest realistic single-day window.
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);

    const body = {
      name:      `minimal_search_term_test_${dateStr}`,
      startDate: dateStr,
      endDate:   dateStr,
      configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['searchTerm'],
        columns:      ['searchTerm', 'impressions', 'clicks'],
        reportTypeId: 'spSearchTerm',
        timeUnit:     'SUMMARY',
        format:       'GZIP_JSON',
      },
    };

    const { statusCode, body: respBody } = await adRequestRaw('POST', '/reporting/reports', token, profileId, body);

    return res.status(200).json({
      note: 'Save this reportId, then check /api/test-minimal-search-term-poll?reportId=... every minute or two.',
      statusCode,
      response: respBody,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

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
