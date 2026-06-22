/**
 * api/test-ad-connection.js
 * One-shot test endpoint — verifies Amazon Advertising API connectivity.
 * Hit manually to confirm auth + report creation works before running the full cron.
 *
 * Usage:
 *   curl https://evolis-xi.vercel.app/api/test-ad-connection \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 *
 * What it tests (in order, stops on first failure):
 *   1. LWA token exchange — confirms SP_AD_CLIENT_ID/SECRET/REFRESH_TOKEN are valid
 *   2. Profile lookup     — confirms SP_AD_PROFILE_ID resolves to a real profile
 *   3. Report creation    — requests a minimal 1-day SP report (yesterday)
 *   4. Report poll        — waits up to 60s for COMPLETED status
 *
 * Does NOT write to any sheet. Safe to run any time.
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

    // ── Step 2: Profile lookup ────────────────────────────────────────────
    step('Looking up profile...', { profileId: process.env.SP_AD_PROFILE_ID });
    const profile = await adRequest('GET', `/v2/profiles/${process.env.SP_AD_PROFILE_ID}`, token, null);
    step('Profile OK', {
      profileId:   profile.profileId,
      countryCode: profile.countryCode,
      accountName: profile.accountInfo?.name,
      accountType: profile.accountInfo?.type,
      timezone:    profile.timezone,
    });

    // ── Step 3: Request a minimal SP report (yesterday only) ─────────────
    const yesterday = (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}${m}${day}`;
    })();

    step('Requesting SP test report...', { date: yesterday });
    const createResp = await adRequest('POST', '/reporting/reports', token, {
      name:      `test_connection_${yesterday}`,
      startDate:  yesterday,
      endDate:    yesterday,
      configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['advertised_asin'],
        columns:      ['advertisedSku', 'impressions', 'clicks', 'spend', 'unitsSoldClicks14d', 'sales14d'],
        reportTypeId: 'spAdvertisedProduct',
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
      const poll = await adRequest('GET', `/reporting/reports/${createResp.reportId}`, token, null);
      finalStatus = poll.status;
      step(`Poll: ${finalStatus}`);

      if (finalStatus === 'COMPLETED') {
        step('Report COMPLETED ✓', { url: poll.url ? poll.url.slice(0, 60) + '...' : 'no url' });
        return res.status(200).json({ success: true, log });
      }
      if (finalStatus === 'FAILED') {
        step('Report FAILED', poll);
        return res.status(200).json({ success: false, log, error: 'Report FAILED', raw: poll });
      }
    }

    step('Poll timed out', { lastStatus: finalStatus });
    return res.status(200).json({
      success: false,
      log,
      error:  `Report did not complete within 60s. Last status: ${finalStatus}`,
      note:   'Auth is working if report was created — this just means the report is still processing.',
    });

  } catch (err) {
    step('ERROR', { message: err.message });
    return res.status(200).json({ success: false, log, error: err.message });
  }
};

// ── Ad API helper ─────────────────────────────────────────────────────────────

function adRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                   `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Amazon-Advertising-API-Scope':    process.env.SP_AD_PROFILE_ID,
      'Content-Type':                    'application/vnd.createasyncreportrequest.v3+json',
      'Content-Length':                  Buffer.byteLength(bodyStr),
    };
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
