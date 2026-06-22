/**
 * api/test-ad-connection.js
 * Debug endpoint — lists all profiles and tests report creation on the US NewDerm profile.
 */

const { getAdToken } = require('./_spauth');
const https          = require('https');

const AD_API_HOST = 'advertising-api.amazon.com';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = [];
  const step = (msg, data) => { console.log(`[test-ad] ${msg}`); log.push({ step: msg, ...data }); };

  try {
    // ── Step 1: LWA token ──────────────────────────────────────────────────
    step('LWA token...', {});
    const token = await getAdToken();
    step('LWA OK', { tokenPrefix: token.slice(0, 20) + '...' });

    // ── Step 2: List ALL profiles (no truncation) ──────────────────────────
    step('Fetching profiles...', {});
    const profiles = await adRequest('GET', '/v2/profiles', token, null, null);

    if (!Array.isArray(profiles)) {
      return res.status(200).json({ success: false, log, error: 'Profiles not an array', raw: profiles });
    }

    const profileList = profiles.map(p => ({
      profileId:   p.profileId,
      name:        p.accountInfo?.name,
      type:        p.accountInfo?.type,
      countryCode: p.countryCode,
      sellerId:    p.accountInfo?.id,
    }));
    step(`Found ${profiles.length} profiles`, { profiles: profileList });

    // ── Step 3: Find US NewDerm seller profile ─────────────────────────────
    const newdermUS = profiles.find(p =>
      p.countryCode === 'US' &&
      p.accountInfo?.type === 'seller' &&
      (p.accountInfo?.name?.toLowerCase().includes('newderm') ||
       p.accountInfo?.id === 'A25QTQX4QSLFM9')
    );

    if (!newdermUS) {
      step('NewDerm US profile not found — listing all for manual selection', { profiles: profileList });
      return res.status(200).json({ success: false, log });
    }

    step('Using NewDerm US profile', {
      profileId:   newdermUS.profileId,
      name:        newdermUS.accountInfo?.name,
      countryCode: newdermUS.countryCode,
    });

    // ── Step 4: Test report creation ───────────────────────────────────────
    const yesterday = (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`;
    })();

    step('Requesting test SP report...', { date: yesterday });
    const createResp = await adRequest('POST', '/reporting/reports', token, newdermUS.profileId, {
      name:      `test_${yesterday}`,
      startDate:  yesterday,
      endDate:    yesterday,
      configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['campaign'],
        columns:      ['impressions', 'clicks', 'spend', 'purchases7d', 'sales7d'],
        reportTypeId: 'spCampaigns',
        timeUnit:     'SUMMARY',
        format:       'GZIP_JSON',
      },
    });

    if (!createResp.reportId) {
      step('Report creation FAILED', { raw: createResp });
      return res.status(200).json({ success: false, log });
    }

    step('Report created — polling 60s...', { reportId: createResp.reportId });

    // ── Step 5: Poll 60s ───────────────────────────────────────────────────
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const poll = await adRequest('GET', `/reporting/reports/${createResp.reportId}`, token, newdermUS.profileId, null);
      step(`Poll: ${poll.status}`, {});
      if (poll.status === 'COMPLETED') {
        step('SUCCESS ✓', { profileId: newdermUS.profileId, note: `Update SP_AD_PROFILE_ID to ${newdermUS.profileId}` });
        return res.status(200).json({ success: true, log, correctProfileId: newdermUS.profileId });
      }
      if (poll.status === 'FAILED') {
        step('Report FAILED', { raw: poll });
        return res.status(200).json({ success: false, log });
      }
    }

    step('Timed out — but auth + report creation worked', { correctProfileId: newdermUS.profileId });
    return res.status(200).json({ success: false, log, correctProfileId: newdermUS.profileId, note: 'Auth works — report just needs more time. Update SP_AD_PROFILE_ID.' });

  } catch (err) {
    log.push({ step: 'ERROR', message: err.message });
    return res.status(200).json({ success: false, log, error: err.message });
  }
};

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
        catch (e) { reject(new Error(`Parse error (${res.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
