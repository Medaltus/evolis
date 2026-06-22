/**
 * api/test-ad-connection.js
 * One-shot test endpoint — verifies Amazon Advertising API connectivity.
 * Mirrors the auth pattern from fetch_ads_data.py:
 *   1. LWA token exchange
 *   2. List all profiles (GET /v2/profiles) — discovers real numeric profile IDs
 *   3. Request a minimal 1-day SP report using the first profile found
 *   4. Poll up to 60s for COMPLETED
 *
 * Also logs all profile IDs found — use these to update SP_AD_PROFILE_ID env var.
 *
 * Usage:
 *   curl https://evolis-xi.vercel.app/api/test-ad-connection \
 *     -H "Authorization: Bearer r29fu&7S;gq@\$bOw"
 *
 * Safe to run any time — does NOT write to any sheet.
 * DELETE this file after confirming the connection works.
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
  const step = (msg, data) => {
    console.log(`[test-ad-connection] ${msg}`, data || '');
    log.push({ step: msg, ...(data || {}) });
  };

  try {
    // ── Step 1: LWA token ─────────────────────────────────────────────────
    step('Requesting LWA token...');
    const token = await getAdToken();
    step('LWA token OK', { tokenPrefix: token.slice(0, 20) + '...' });

    // ── Step 2: List all profiles (no scope header needed for this call) ──
    step('Listing all profiles...');
    const profiles = await adRequest('GET', '/v2/profiles', token, null, null);

    if (!Array.isArray(profiles) || profiles.length === 0) {
      step('No profiles found', { raw: profiles });
      return res.status(200).json({ success: false, log, error: 'No profiles returned', raw: profiles });
    }

    // Log all profiles so we can identify the correct one for Évolis/Newderm
    const profileSummary = profiles.map(p => ({
      profileId:   p.profileId,
      name:        p.accountInfo?.name || '(no name)',
      type:        p.accountInfo?.type || '(no type)',
      countryCode: p.countryCode,
    }));
    step(`Found ${profiles.length} profile(s)`, { profiles: profileSummary });

    // Use the first seller profile for the test report
    const testProfile = profiles.find(p =>
      ['seller', 'vendor', ''].includes((p.accountInfo?.type || '').toLowerCase())
    ) || profiles[0];

    const profileId = testProfile.profileId;
    step('Using profile for test', {
      profileId,
      name:        testProfile.accountInfo?.name || '(no name)',
      countryCode: testProfile.countryCode,
    });

    // ── Step 3: Request a minimal SP report (yesterday) ───────────────────
    const yesterday = (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}${m}${day}`;
    })();

    step('Requesting SP test report...', { date: yesterday, profileId });
    const createResp = await adRequest('POST', '/reporting/reports', token, profileId, {
      name:      `test_connection_${yesterday}`,
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
      step('Report creation FAILED', createResp);
      return res.status(200).json({ success: false, log, error: 'No reportId in response', raw: createResp });
    }

    step('Report created', { reportId: createResp.reportId, status: createResp.status });

    // ── Step 4: Poll up to 60s ────────────────────────────────────────────
    const deadline = Date.now() + 60_000;
    let finalStatus = createResp.status;
    while (Date.now() < deadline) {
      await sleep(5000);
      const poll = await adRequest('GET', `/reporting/reports/${createResp.reportId}`, token, profileId, null);
      finalStatus = poll.status;
      step(`Poll: ${finalStatus}`);

      if (finalStatus === 'COMPLETED') {
        step('Report COMPLETED ✓', { url: poll.url ? poll.url.slice(0, 60) + '...' : 'no url' });
        return res.status(200).json({
          success: true,
          log,
          // Surface all profile IDs clearly so the correct one can be set in SP_AD_PROFILE_ID
          profiles: profileSummary,
          note: 'Update SP_AD_PROFILE_ID in Vercel to the profileId for your Newderm/Évolis seller profile above.',
        });
      }
      if (finalStatus === 'FAILED') {
        step('Report FAILED', poll);
        return res.status(200).json({ success: false, log, error: 'Report FAILED', raw: poll });
      }
    }

    // Timed out but auth worked — still surface profile IDs
    step('Poll timed out', { lastStatus: finalStatus });
    return res.status(200).json({
      success: false,
      log,
      profiles: profileSummary,
      error:  `Report did not complete within 60s. Last status: ${finalStatus}`,
      note:   'Auth is working if report was created. Also check profiles above to update SP_AD_PROFILE_ID.',
    });

  } catch (err) {
    step('ERROR', { message: err.message });
    return res.status(200).json({ success: false, log, error: err.message });
  }
};

// ── Ad API helper ─────────────────────────────────────────────────────────────
// profileId is passed per-call (not from env) so we use the discovered numeric ID.

function adRequest(method, path, token, profileId, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                   `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Content-Type': method === 'POST' && path === '/reporting/reports' ? 'application/vnd.createasyncreportrequest.v3+json' : 'application/json',
      'Content-Length':                  Buffer.byteLength(bodyStr),
    };
    // Only add Scope header if profileId is provided (not needed for /v2/profiles list)
    if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);

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

const sleep = ms => new Promise(r => setTimeout(r, ms));
