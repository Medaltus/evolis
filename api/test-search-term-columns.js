/**
 * api/test-search-term-columns.js
 * ONE-OFF DIAGNOSTIC — not a cron. Finds the REAL valid `columns` values
 * for search-term-level report types, the same way we found sbCampaigns'
 * real columns earlier: submit a deliberately invalid column name, and
 * Amazon's validation error enumerates every column that IS valid.
 *
 * Probes BOTH:
 *   spSearchTerm — Sponsored Products search term report
 *   sbSearchTerm — Sponsored Brands search term report
 * (Sponsored Display has no search-term-level report — search terms only
 * apply to keyword/auto targeting, which SP and SB both support.)
 *
 * Safe to call repeatedly — the invalid column makes Amazon reject the
 * request before any report is actually generated, so this costs nothing.
 *
 * DELETE this file once the real sync is built and confirmed working.
 *
 * GET or POST /api/test-search-term-columns
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

    const probes = [
      { reportTypeId: 'spSearchTerm', adProduct: 'SPONSORED_PRODUCTS' },
      { reportTypeId: 'sbSearchTerm', adProduct: 'SPONSORED_BRANDS' },
    ];

    const results = {};
    for (let i = 0; i < probes.length; i++) {
      if (i > 0) await sleep(1500); // stagger, same reasoning as sync-advertising-request.js
      const { reportTypeId, adProduct } = probes[i];

      const probeBody = {
        name:      `${reportTypeId}_columns_schema_probe`,
        startDate: '2026-07-01',
        endDate:   '2026-07-01',
        configuration: {
          adProduct,
          groupBy:      ['searchTerm'],
          columns:      ['__PROBE_INVALID_COLUMN__'],
          reportTypeId,
          timeUnit:     'SUMMARY',
          format:       'GZIP_JSON',
        },
      };

      const { statusCode, body } = await adRequestRaw('POST', '/reporting/reports', token, profileId, probeBody);
      results[reportTypeId] = { statusCode, response: body };
    }

    return res.status(200).json({
      note: 'Each result is expected to be a 400 with an "Allowed values" list — that list is the real answer for that report type.',
      results,
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
