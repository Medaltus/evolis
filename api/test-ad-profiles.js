/**
 * api/test-ad-profiles.js
 * ONE-OFF diagnostic — lists every Amazon Ads profile on the account,
 * completely unfiltered. Every advertising cron in this codebase
 * (sync-advertising-request.js, sync-advertising-backfill.js,
 * sync-ad-search-terms-request.js) calls this same underlying endpoint
 * via discoverProfileId(), but immediately filters down to
 * countryCode==='US' only — meaning none of them have ever actually
 * looked at what else is on the account. This shows everything,
 * specifically to check whether a Canadian (or any other) profile
 * already exists, even if no campaigns have been built under it yet —
 * Amazon Ads can auto-create a profile for each marketplace a seller
 * account is registered in, independent of whether it's actually used.
 *
 * Synchronous endpoint (GET /v2/profiles) — no async report/polling
 * needed, unlike the reporting-API diagnostics elsewhere in this
 * project. One call, immediate answer.
 *
 * Writes nothing anywhere.
 *
 * Usage:
 *   GET /api/test-ad-profiles
 *   Authorization: Bearer <CRON_SECRET>
 */

const { getAdToken } = require('./_spauth');
const https          = require('https');

const AD_API_HOST = 'advertising-api.amazon.com';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getAdToken();
    const profiles = await adRequest('GET', '/v2/profiles', token, null, null);

    const summarized = (profiles || []).map(p => ({
      profileId:       p.profileId,
      countryCode:     p.countryCode,
      currencyCode:    p.currencyCode,
      timezone:        p.timezone,
      accountType:     p.accountInfo?.type,
      accountName:     p.accountInfo?.name,
      accountId:       p.accountInfo?.id,
      marketplaceStringId: p.accountInfo?.marketplaceStringId,
    }));

    res.status(200).json({
      totalProfiles: summarized.length,
      profiles: summarized,
      note: 'Look for anything with countryCode "CA" — that\'s the Canadian profile, if one exists. Every current advertising cron only ever uses the "US" one.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

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
