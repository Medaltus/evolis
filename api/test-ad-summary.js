/**
 * api/test-ad-summary.js
 * Debug — shows raw fields returned by the SP campaigns report with portfolioName column.
 * DELETE after confirming field names.
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
    const token     = await getAdToken();
    const profiles  = await adRequest('GET', '/v2/profiles', token, null, null);
    const profile   = profiles.find(p =>
      p.countryCode === 'US' && p.accountInfo?.type === 'seller' &&
      (p.accountInfo?.name?.toLowerCase().includes('newderm') || p.accountInfo?.id === 'A25QTQX4QSLFM9')
    );
    const profileId = profile.profileId;

    // Yesterday only — minimal data, fast report
    const pad = x => String(x).padStart(2, '0');
    const d   = new Date(); d.setDate(d.getDate() - 1);
    const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

    // Test 1: spCampaigns groupBy campaign WITH portfolioName column
    const create = await adRequest('POST', '/reporting/reports', token, profileId, {
      name:      `debug_summary_${date}`,
      startDate:  date,
      endDate:    date,
      configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['campaign'],
        columns:      ['campaignName', 'impressions', 'clicks', 'spend', 'purchases14d', 'sales14d', 'unitsSoldClicks14d'],
        reportTypeId: 'spCampaigns',
        timeUnit:     'SUMMARY',
        format:       'GZIP_JSON',
      },
    });

    if (!create.reportId) {
      return res.status(200).json({ error: 'Report creation failed', raw: create });
    }

    // Poll 90s
    const deadline = Date.now() + 90_000;
    let poll;
    while (Date.now() < deadline) {
      await sleep(6000);
      poll = await adRequest('GET', `/reporting/reports/${create.reportId}`, token, profileId, null);
      if (poll.status === 'COMPLETED') break;
      if (poll.status === 'FAILED') return res.status(200).json({ error: 'Report FAILED', raw: poll });
    }

    if (poll.status !== 'COMPLETED') {
      return res.status(200).json({ 
        note: 'Still pending — but creation succeeded, column names are valid',
        reportId: create.reportId,
        lastStatus: poll.status 
      });
    }

    const rows = await downloadReport(poll.url);

    return res.status(200).json({
      success:       true,
      totalRows:     rows.length,
      columnsSeen:   rows.length > 0 ? Object.keys(rows[0]) : [],
      // Show first 5 rows with just the fields we care about
      sampleRows:    rows.slice(0, 5).map(r => ({
        
        
        campaignName:  r.campaignName,
        impressions:   r.impressions,
        clicks:        r.clicks,
        spend:         r.spend,
        sales14d:      r.sales14d,
        unitsSoldClicks14d: r.unitsSoldClicks14d,
      })),
      // Show all unique portfolio names in the data
      uniqueCampaignNames: [...new Set(rows.map(r => r.campaignName).filter(Boolean))].sort(),
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
        catch (e) { reject(new Error(`Parse error (${res.statusCode}): ${d.slice(0,300)}`)); }
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
