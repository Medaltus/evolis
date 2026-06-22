/**
 * api/test-ad-connection.js
 * Debug — fetches a raw SP advertised product report and shows first 10 rows.
 */

const { getAdToken } = require('./_spauth');
const https          = require('https');
const zlib           = require('zlib');

const AD_API_HOST = 'advertising-api.amazon.com';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token    = await getAdToken();
    const profiles = await adRequest('GET', '/v2/profiles', token, null, null);
    const profile  = profiles.find(p =>
      p.countryCode === 'US' && p.accountInfo?.type === 'seller' &&
      (p.accountInfo?.name?.toLowerCase().includes('newderm') || p.accountInfo?.id === 'A25QTQX4QSLFM9')
    );
    if (!profile) return res.status(200).json({ error: 'NewDerm US profile not found' });

    const profileId = profile.profileId;

    // Last 7 days
    const pad   = x => String(x).padStart(2, '0');
    const end   = new Date(); end.setDate(end.getDate() - 1);
    const start = new Date(end); start.setDate(start.getDate() - 6);
    const fmt   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const startDate = fmt(start);
    const endDate   = fmt(end);

    // Request SKU report
    const create = await adRequest('POST', '/reporting/reports', token, profileId, {
      name:      `debug_sku_${endDate}`,
      startDate,
      endDate,
      configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['advertised_asin'],
        columns:      ['advertisedSku', 'advertisedAsin', 'impressions', 'clicks', 'spend', 'purchases14d', 'unitsSoldClicks14d', 'sales14d'],
        reportTypeId: 'spAdvertisedProduct',
        timeUnit:     'SUMMARY',
        format:       'GZIP_JSON',
      },
    });

    if (!create.reportId) return res.status(200).json({ error: 'No reportId', raw: create });

    // Poll 90s
    const deadline = Date.now() + 90_000;
    let poll;
    while (Date.now() < deadline) {
      await sleep(5000);
      poll = await adRequest('GET', `/reporting/reports/${create.reportId}`, token, profileId, null);
      if (poll.status === 'COMPLETED') break;
      if (poll.status === 'FAILED') return res.status(200).json({ error: 'Report FAILED', raw: poll });
    }

    if (poll.status !== 'COMPLETED') {
      return res.status(200).json({ error: 'Timed out', reportId: create.reportId, lastStatus: poll.status });
    }

    // Download and show first 10 rows
    const rows = await downloadReport(poll.url);

    return res.status(200).json({
      success:      true,
      profileId,
      startDate,
      endDate,
      totalRows:    rows.length,
      first10Rows:  rows.slice(0, 10),
      columnsSeen:  rows.length > 0 ? Object.keys(rows[0]) : [],
    });

  } catch (err) {
    return res.status(200).json({ error: err.message });
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

function downloadReport(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        zlib.gunzip(buf, (err, decoded) => {
          if (err) {
            try { resolve(JSON.parse(buf.toString())); } catch(e) { reject(e); }
            return;
          }
          try { resolve(JSON.parse(decoded.toString())); } catch(e) { reject(e); }
        });
      });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
