/**
 * scripts/test-7d-vs-14d-skinuva.js
 * DIAGNOSTIC ONLY — run directly with `node`, not a Vercel cron endpoint.
 * Touches NOTHING in Google Sheets. Prints straight to your terminal.
 *
 * Requests last month's spCampaigns twice (once with the 14-day
 * attribution columns this project normally uses, once with 7-day),
 * plus sbCampaigns and sdCampaigns ONCE each (neither has a day-window
 * variant — confirmed against the real columns already in production use:
 * SB is cost/sales/purchases, SD is cost/sales/unitsSold, no "14d"/"7d"
 * suffix on either). Filters everything to Skinuva campaigns only (same
 * identifyBrand() logic as the real sync-advertising-process.js, so a
 * skinuva-ca campaign can't accidentally get counted as US skinuva here
 * either), then prints a 14d-vs-7d side-by-side total.
 *
 * Usage:
 *   node scripts/test-7d-vs-14d-skinuva.js
 *
 * Assumes it's run from a location where `../api/_spauth` resolves — if
 * you put this file somewhere other than a `scripts/` folder at the repo
 * root, adjust that require path. Needs the same env vars the real ad
 * crons use: SP_AD_CLIENT_ID plus whatever _spauth's getAdToken() itself
 * needs (same credentials, no new setup).
 */

const { getAdToken } = require('../api/_spauth');
const https           = require('https');
const zlib            = require('zlib');

const AD_API_HOST = 'advertising-api.amazon.com';

function identifyBrand(campaignName) {
  const normalized = (campaignName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (normalized.includes('skinuva') && normalized.includes('canada')) return 'skinuva-ca';
  if (normalized.includes('skinuva')) return 'skinuva';
  return null;
}

function getLastMonthRange() {
  const pad = x => String(x).padStart(2, '0');
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfPrevMonth  = new Date(firstOfThisMonth - 1);
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { startDate: fmt(firstOfPrevMonth), endDate: fmt(lastOfPrevMonth) };
}

async function main() {
  const range = getLastMonthRange();
  console.log(`Last full month: ${range.startDate} → ${range.endDate}\n`);

  const token = await getAdToken();
  const profileId = await discoverProfileId(token);
  console.log(`Using profileId=${profileId}\n`);

  console.log('Requesting 4 reports (spCampaigns x2, sbCampaigns, sdCampaigns)...');
  const sp14dId = await requestReport(token, profileId, 'spCampaigns', 'SPONSORED_PRODUCTS', range,
    ['campaignName', 'impressions', 'clicks', 'spend', 'purchases14d', 'sales14d', 'unitsSoldClicks14d']);
  await sleep(1500);
  const sp7dId = await requestReport(token, profileId, 'spCampaigns', 'SPONSORED_PRODUCTS', range,
    ['campaignName', 'impressions', 'clicks', 'spend', 'purchases7d', 'sales7d', 'unitsSoldClicks7d']);
  await sleep(1500);
  const sbId = await requestReport(token, profileId, 'sbCampaigns', 'SPONSORED_BRANDS', range,
    ['campaignName', 'impressions', 'clicks', 'cost', 'purchases', 'sales']);
  await sleep(1500);
  const sdId = await requestReport(token, profileId, 'sdCampaigns', 'SPONSORED_DISPLAY', range,
    ['campaignName', 'campaignId', 'impressions', 'clicks', 'cost', 'purchases', 'sales', 'unitsSold']);

  if (!sp14dId || !sp7dId) {
    console.error('Report request failed for one of the SP pulls — aborting.');
    process.exit(1);
  }

  console.log('Requested. Polling for completion (this can take a couple minutes)...\n');
  const [sp14dRows, sp7dRows, sbRows, sdRows] = await Promise.all([
    pollAndDownload(sp14dId, token, profileId),
    pollAndDownload(sp7dId,  token, profileId),
    sbId ? pollAndDownload(sbId, token, profileId) : Promise.resolve([]),
    sdId ? pollAndDownload(sdId, token, profileId) : Promise.resolve([]),
  ]);

  if (sp14dRows === null || sp7dRows === null) {
    console.error('One or both SP reports were not ready in time. Re-run this script in a minute or two.');
    process.exit(1);
  }

  const skuSp14d = (sp14dRows || []).filter(r => identifyBrand(r.campaignName) === 'skinuva');
  const skuSp7d  = (sp7dRows  || []).filter(r => identifyBrand(r.campaignName) === 'skinuva');
  const skuSb    = (sbRows    || []).filter(r => identifyBrand(r.campaignName) === 'skinuva');
  const skuSd    = (sdRows    || []).filter(r => identifyBrand(r.campaignName) === 'skinuva');

  const sum = (rows, ...fields) => {
    const out = {};
    fields.forEach(f => { out[f] = rows.reduce((s, r) => s + (parseFloat(r[f]) || 0), 0); });
    return out;
  };

  const sp14 = sum(skuSp14d, 'impressions', 'clicks', 'spend', 'sales14d', 'unitsSoldClicks14d');
  const sp7  = sum(skuSp7d,  'impressions', 'clicks', 'spend', 'sales7d',  'unitsSoldClicks7d');
  const sb   = sum(skuSb,    'impressions', 'clicks', 'cost',  'sales',    'purchases');
  const sd   = sum(skuSd,    'impressions', 'clicks', 'cost',  'sales',    'unitsSold');

  const total14 = {
    impressions: sp14.impressions + sb.impressions + sd.impressions,
    clicks:      sp14.clicks      + sb.clicks      + sd.clicks,
    spend:       sp14.spend       + sb.cost         + sd.cost,
    sales:       sp14.sales14d    + sb.sales        + sd.sales,
    units:       sp14.unitsSoldClicks14d + sb.purchases + sd.unitsSold,
  };
  const total7 = {
    impressions: sp7.impressions + sb.impressions + sd.impressions,
    clicks:      sp7.clicks      + sb.clicks      + sd.clicks,
    spend:       sp7.spend       + sb.cost         + sd.cost,
    sales:       sp7.sales7d     + sb.sales        + sd.sales,
    units:       sp7.unitsSoldClicks7d + sb.purchases + sd.unitsSold,
  };

  const money = n => '$' + n.toFixed(2);
  const row = (label, a, b) => console.log(label.padEnd(14) + String(a).padStart(14) + String(b).padStart(14));

  console.log('Skinuva, ' + range.startDate + ' to ' + range.endDate + ' (SP+SB+SD):\n');
  console.log(''.padEnd(14) + '14-day'.padStart(14) + '7-day'.padStart(14));
  row('Impressions', total14.impressions, total7.impressions);
  row('Clicks',       total14.clicks,      total7.clicks);
  row('Spend',        money(total14.spend), money(total7.spend));
  row('Sales',        money(total14.sales), money(total7.sales));
  row('Units',        total14.units,        total7.units);
  console.log('\n(For reference — H10 Portfolio, same period: Spend $14,501.28, Sales $55,536.14, Impressions 1,361,296, Clicks 6,403, Sale Units 718.)');
}

// ── Amazon Ads plumbing (same as the production crons) ───────────────────────

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

async function requestReport(token, profileId, reportTypeId, adProduct, range, columns) {
  const groupBy = ['campaign'];
  const { body } = await adRequestRaw('POST', '/reporting/reports', token, profileId, {
    name: `test-7d-vs-14d ${reportTypeId} ${range.startDate} to ${range.endDate}`,
    startDate: range.startDate,
    endDate:   range.endDate,
    configuration: { adProduct, groupBy, columns, reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON' },
  });
  if (body?.reportId) {
    console.log(`  ${reportTypeId}: requested (${body.reportId})`);
    return body.reportId;
  }
  console.error(`  ${reportTypeId}: request failed —`, JSON.stringify(body));
  return null;
}

async function pollAndDownload(reportId, token, profileId) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const resp = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    if (resp.status === 'COMPLETED') return downloadAdReport(resp.url);
    if (resp.status === 'FAILED')    return null;
    await sleep(10_000);
  }
  console.warn(`  ${reportId}: not ready after 4 minutes`);
  return null;
}

function downloadAdReport(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        zlib.gunzip(buf, (err, decoded) => {
          if (err) { try { resolve(JSON.parse(buf.toString())); } catch (e) { reject(e); } return; }
          try { resolve(JSON.parse(decoded.toString())); } catch (e) { reject(e); }
        });
      });
    }).on('error', reject);
  });
}

function adRequest(method, path, token, profileId, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Content-Type': method === 'POST' && path === '/reporting/reports'
        ? 'application/vnd.createasyncreportrequest.v3+json' : 'application/json',
    };
    if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`parse error (${res.statusCode}): ${d.slice(0, 300)}`)); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function adRequestRaw(method, path, token, profileId, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Content-Type': method === 'POST' && path === '/reporting/reports'
        ? 'application/vnd.createasyncreportrequest.v3+json' : 'application/json',
    };
    if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ statusCode: res.statusCode, body: { parseError: d.slice(0, 300) } }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
