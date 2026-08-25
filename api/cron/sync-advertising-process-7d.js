/**
 * api/cron/sync-advertising-process-7d.js
 * DIAGNOSTIC ONLY — pairs with sync-advertising-request-7d.js.
 *
 * Polls the "_7d"-suffixed report IDs that request cron wrote to _meta,
 * aggregates them with the exact same campaign-matching logic as the real
 * sync-advertising-process.js (identifyBrand/CAMPAIGN_BRANDS, copied
 * verbatim so the two are comparable apples-to-apples), and writes ONE
 * shared tab — _test_7d_summary, one row per brand per period — rather
 * than touching any of the real per-brand SHEET_ADVERTISING tabs or
 * SHEET_AD_ORDERS. Nothing this writes is read by the live dashboard.
 *
 * SP rows are read using sales7d / unitsSoldClicks7d (the fields
 * sync-advertising-request-7d.js actually requested). SB and SD rows are
 * read exactly the same way the production process cron reads them —
 * confirmed neither has a day-window field to swap in the first place, so
 * this isolates the test to SP's attribution window specifically.
 *
 * ASIN-level (SHEET_AD_ORDERS equivalent) is intentionally NOT built here —
 * the question this is answering is about the brand-level Total row
 * (H10's Portfolio total / the Channel Breakdown "Amazon" row), not a
 * per-ASIN breakdown. Skipped to keep this diagnostic small.
 *
 * Run manually via:
 *   POST /api/cron/sync-advertising-process-7d
 *   Authorization: Bearer <CRON_SECRET>
 * (after sync-advertising-request-7d.js has been run and Amazon has had a
 * few minutes to generate the reports — same polling wait as production.)
 *
 * To compare: open _test_7d_summary next to SHEET_ADVERTISING's own
 * "skinuva" tab for the same year/month. spend/impressions/clicks should
 * match almost exactly (nothing about SP's spend or clicks changes with
 * the attribution window). sales/ad_units are the numbers actually being
 * tested — if they land closer to H10's Sales/Sale Units than the
 * production 14-day row does, that confirms the attribution window as
 * the cause of the gap.
 */

const { getAdToken }                                   = require('../_spauth');
const { ensureTab, readRows, replaceRows }             = require('../config/_sheets_client');
const brands                                           = require('../config/brands');
const https                                            = require('https');
const zlib                                             = require('zlib');

const AD_API_HOST      = 'advertising-api.amazon.com';
const SHEET_AD_SUMMARY = process.env.SHEET_ADVERTISING;
const META_TAB         = '_meta';
const META_HEADERS     = ['KEY', 'VALUE', 'UPDATED_AT'];
const TEST_TAB         = '_test_7d_summary';
const TEST_HEADERS     = [
  'year', 'month', 'brand', 'impressions', 'clicks', 'spend', 'sales',
  'acos', 'roas', 'ad_units', 'ctr', 'cpc', 'last_updated',
];

const POLL_TIMEOUT_MS  = 240_000;
const POLL_INTERVAL_MS = 10_000;

// ── Same brand-matching logic as production, copied verbatim ────────────────
// (see sync-advertising-process.js for the history behind this list — kept
// identical here on purpose so a mismatch between the two tools is never
// the cause of a numbers difference.)
const CAMPAIGN_BRANDS = [
  { name: 'skinuva',        tabName: 'skinuva'        },
  { name: 'the creme shop', tabName: 'creme-shop'     },
  { name: 'cloud cafe',     tabName: 'cloud-cafe'     },
  { name: 'just bjorn',     tabName: 'just-bjorn'     },
  { name: 'pb & jay',       tabName: 'pbj'            },
  { name: 'pb&jay',         tabName: 'pbj'            },
  { name: 'miguard',        tabName: 'miguard'        },
  { name: 'dearcloud',      tabName: 'dearcloud'      },
  { name: 'eraclea',        tabName: 'eraclea'        },
  { name: 'evolis',         tabName: 'evolis'         },
  { name: 'amala',          tabName: 'amala'          },
  { name: 'cimeosil',       tabName: 'cimeosil'       },
  { name: 'collagelee',     tabName: 'collagelee'     },
  { name: 'hillside',       tabName: 'hillside'       },
  { name: 'prohibition',    tabName: 'prohibition'    },
  { name: 'skinside seoul', tabName: 'skinside-seoul' },
  { name: 'skinside-seoul', tabName: 'skinside-seoul' },
  { name: 'cosmette',       tabName: 'cosmette'       },
].sort((a, b) => b.name.length - a.name.length);

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function identifyBrand(campaignName) {
  const normalized = stripAccents((campaignName || '').toLowerCase());
  if (normalized.includes('skinuva') && normalized.includes('canada')) return 'skinuva-ca';
  const match = CAMPAIGN_BRANDS.find(b => normalized.includes(b.name));
  return match ? match.tabName : null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = toEstIso(new Date());

  // ── 1. Read _meta ──────────────────────────────────────────────────────────
  let meta = {};
  try {
    const rawMeta = await readRows(SHEET_AD_SUMMARY, META_TAB);
    rawMeta.forEach(r => { if (r.KEY) meta[r.KEY] = r.VALUE; });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read _meta tab', detail: err.message });
  }

  const spCurrId     = meta['ad_report_id_sp_curr_7d'];
  const sbCurrId     = meta['ad_report_id_sb_curr_7d'];
  const sdCampCurrId = meta['ad_report_id_sdcamp_curr_7d'];
  const spPrevId     = meta['ad_report_id_sp_prev_7d'];
  const sbPrevId     = meta['ad_report_id_sb_prev_7d'];
  const sdCampPrevId = meta['ad_report_id_sdcamp_prev_7d'];
  const profileId    = meta['ad_profile_id'];
  // Reused from the production run -- see file header. Same calendar
  // months, only the SP attribution window differs.
  const endDateCurr  = meta['ad_end_date_curr'];
  const endDatePrev  = meta['ad_end_date_prev'];

  if (!spCurrId && !sbCurrId) {
    return res.status(400).json({ error: 'No _7d report IDs found in _meta — run sync-advertising-request-7d first' });
  }

  let token;
  try {
    token = await getAdToken();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get ad token', detail: err.message });
  }

  // ── 2. Poll + download ────────────────────────────────────────────────────
  const [spCurrRows, sbCurrRows, sdCampCurrRows, spPrevRows, sbPrevRows, sdCampPrevRows] = await Promise.all([
    spCurrId     ? pollAndDownload(spCurrId,     token, profileId) : Promise.resolve([]),
    sbCurrId     ? pollAndDownload(sbCurrId,     token, profileId) : Promise.resolve([]),
    sdCampCurrId ? pollAndDownload(sdCampCurrId, token, profileId) : Promise.resolve([]),
    spPrevId     ? pollAndDownload(spPrevId,     token, profileId) : Promise.resolve([]),
    sbPrevId     ? pollAndDownload(sbPrevId,     token, profileId) : Promise.resolve([]),
    sdCampPrevId ? pollAndDownload(sdCampPrevId, token, profileId) : Promise.resolve([]),
  ]);

  if (spCurrRows === null || spPrevRows === null) {
    return res.status(202).json({ message: 'Reports not ready yet — try again in a minute or two' });
  }

  const periods = [
    { label: 'curr', spRows: spCurrRows || [], sbRows: sbCurrRows || [], sdCampRows: sdCampCurrRows || [], endDate: endDateCurr, ...yearMonthFromEndDate(endDateCurr) },
    { label: 'prev', spRows: spPrevRows || [], sbRows: sbPrevRows || [], sdCampRows: sdCampPrevRows || [], endDate: endDatePrev, ...yearMonthFromEndDate(endDatePrev) },
  ];

  const results = [];
  const tok = await ensureTab(SHEET_AD_SUMMARY, TEST_TAB, TEST_HEADERS);
  const existing = await readRows(SHEET_AD_SUMMARY, TEST_TAB);

  for (const period of periods) {
    const { label, year, month, spRows, sbRows, sdCampRows } = period;
    console.log(`[sync-advertising-process-7d] ${label}: year=${year} month=${month} sp=${spRows.length} sb=${sbRows.length} sdcamp=${sdCampRows.length}`);

    // Same remap-to-SP-shape approach as production, but reading sales7d /
    // unitsSoldClicks7d from the SP rows instead of the 14d fields.
    const allCampaignRows = [
      ...spRows.map(r => ({
        campaignName:       r.campaignName,
        impressions:        r.impressions,
        clicks:             r.clicks,
        spend:              r.spend,
        sales14d:           r.sales7d,            // reusing the "sales14d" key name downstream, value is actually 7d here
        unitsSoldClicks14d: r.unitsSoldClicks7d,   // same -- key name kept for shared aggregation code below
      })),
      ...sbRows.map(r => ({
        ...r,
        spend:               r.cost      || r.spend      || 0,
        sales14d:            r.sales     || r.sales14d    || 0,
        unitsSoldClicks14d:  r.purchases || r.purchases14d || 0,
      })),
      ...sdCampRows.map(r => ({
        ...r,
        spend:               r.cost      || 0,
        sales14d:            r.sales     || 0,
        unitsSoldClicks14d:  r.unitsSold || 0,
      })),
    ];

    const brandTotals = {};
    allCampaignRows.forEach(r => {
      const tabName = identifyBrand(r.campaignName);
      if (!tabName) return;
      if (!brandTotals[tabName]) brandTotals[tabName] = { impressions: 0, clicks: 0, spend: 0, sales: 0, adUnits: 0 };
      brandTotals[tabName].impressions += r.impressions        || 0;
      brandTotals[tabName].clicks      += r.clicks             || 0;
      brandTotals[tabName].spend       += r.spend              || 0;
      brandTotals[tabName].sales       += r.sales14d           || 0;
      brandTotals[tabName].adUnits     += r.unitsSoldClicks14d || 0;
    });

    Object.entries(brandTotals).forEach(([tabName, t]) => {
      const acos = t.sales > 0 ? round2((t.spend / t.sales) * 100) : null;
      const roas = t.spend > 0 ? round2(t.sales / t.spend)          : null;
      const ctr  = t.impressions > 0 ? round2((t.clicks / t.impressions) * 100) : 0;
      const cpc  = t.clicks > 0 ? round2(t.spend / t.clicks)        : 0;
      results.push([year, month, tabName, t.impressions, t.clicks, round2(t.spend), round2(t.sales), acos, roas, t.adUnits, ctr, cpc, now]);
      console.log(`[sync-advertising-process-7d] ${label} ${tabName}: spend=${round2(t.spend)} sales=${round2(t.sales)} adUnits=${t.adUnits}`);
    });
  }

  // Upsert by year+month+brand into the single shared test tab
  const keysThisRun = new Set(results.map(r => `${r[0]}||${r[1]}||${r[2]}`));
  const kept = existing
    .filter(r => !keysThisRun.has(`${r.year}||${r.month}||${r.brand}`))
    .map(r => [r.year, r.month, r.brand, r.impressions, r.clicks, r.spend, r.sales, r.acos, r.roas, r.ad_units, r.ctr, r.cpc, r.last_updated]);
  await replaceRows(SHEET_AD_SUMMARY, TEST_TAB, TEST_HEADERS, [...kept, ...results], tok);

  console.log(`[sync-advertising-process-7d] wrote ${results.length} brand/period rows to "${TEST_TAB}"`);
  return res.status(200).json({ results, tab: TEST_TAB });
};

// ── Poll + download (identical to production) ────────────────────────────────
async function pollAndDownload(reportId, token, profileId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp   = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    const status = resp.status;
    console.log(`[sync-advertising-process-7d] poll ${reportId}: ${status}`);
    if (status === 'COMPLETED') return downloadAdReport(resp.url);
    if (status === 'FAILED')    return null;
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn(`[sync-advertising-process-7d] ${reportId} not ready after ${POLL_TIMEOUT_MS}ms`);
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
        catch (e) { reject(new Error(`Ad API parse error (${res.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function yearMonthFromEndDate(endDate) {
  const [y, m] = (endDate || '').split('-');
  return {
    year:  parseInt(y, 10) || new Date().getFullYear(),
    month: parseInt(m, 10) || new Date().getMonth() + 1,
  };
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;

function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
