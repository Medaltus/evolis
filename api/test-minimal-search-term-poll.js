/**
 * api/test-minimal-search-term-poll.js
 * ONE-OFF DIAGNOSTIC companion to test-minimal-search-term.js. Checks a
 * single report's status immediately, once, with no waiting/polling loop —
 * so you can call this repeatedly (every minute or two) to watch progress
 * in real time instead of waiting for a 4-minute timeout window each time.
 *
 * DELETE once the real search terms sync is confirmed working.
 *
 * GET or POST /api/test-minimal-search-term-poll?reportId=...
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

  const reportId = req.query.reportId;
  if (!reportId) return res.status(400).json({ error: 'Pass ?reportId=...' });

  try {
    const token     = await getAdToken();
    const profileId = await discoverProfileId(token);
    const resp = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    return res.status(200).json(resp);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

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
        catch (e) { reject(new Error(`Parse error (${res.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
