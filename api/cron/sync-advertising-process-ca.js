/**
 * api/cron/sync-advertising-process-ca.js
 * Step 2 of 2 — Canadian counterpart to sync-advertising-process.js.
 * Reads the 10 CA-scoped report IDs stored by
 * sync-advertising-request-ca.js, downloads them, and writes into the
 * SAME SHEET_ADVERTISING and SHEET_AD_ORDERS sheets the US pipeline
 * uses — not a separate CA-specific sheet.
 *
 * Simpler than the US file by design: no legacy single-report format to
 * support (this is a brand-new pipeline, never had an old shape to stay
 * compatible with).
 *
 * BRAND MATCHING reuses the exact same identifyBrand()/CAMPAIGN_BRANDS
 * logic already fixed in sync-advertising-process.js (the skinuva+canada
 * combined-word check, added 2026-08-19 after the three earlier guessed
 * variants were confirmed wrong against real data) — duplicated here
 * rather than imported, matching this project's existing convention of
 * self-contained cron files. If that check is ever changed, it needs to
 * be updated in BOTH files, same as sync-advertising-process.js and
 * sync-ad-search-terms-process.js already require of each other.
 *
 * ASIN-LEVEL matching (SHEET_AD_ORDERS) reuses the same Products-Cache-
 * based asinBrandMap approach already proven correct for skinuva-ca
 * elsewhere in this project (distinct real ASINs per marketplace).
 *
 * Manual:
 *   GET /api/cron/sync-advertising-process-ca
 *   Authorization: Bearer <CRON_SECRET>
 */

const { getAdToken }                                   = require('../_spauth');
const { ensureTab, readRows, replaceRows }             = require('../config/_sheets_client');
const brands                                           = require('../config/brands');
const sheets                                           = require('../config/sheets');
const https                                            = require('https');
const zlib                                             = require('zlib');

const AD_API_HOST      = 'advertising-api.amazon.com';
const SHEET_AD_SUMMARY = process.env.SHEET_ADVERTISING;
const SHEET_AD_ORDERS  = process.env.SHEET_AD_ORDERS || '1N30haUFZkdv9rrvYuWwUhxEm0z7MGp1bz9F462aF-QI';
const META_TAB         = '_meta';
const META_HEADERS     = ['KEY', 'VALUE', 'UPDATED_AT'];

const SUMMARY_HEADERS = [
  'year', 'month', 'impressions', 'clicks', 'spend', 'sales',
  'acos', 'roas', 'ad_units', 'ctr', 'cpc', 'brand', 'last_updated',
];
const ASIN_HEADERS = [
  'year', 'month', 'asin', 'ad_units', 'spend', 'sales',
  'acos', 'brand', 'last_updated', 'date',
];

const POLL_TIMEOUT_MS  = 240_000;
const POLL_INTERVAL_MS = 10_000;
const SHEET_WRITE_STAGGER_MS = 2500;

// ── Same brand-matching as sync-advertising-process.js — see file header ──
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

  const now = new Date().toISOString();

  let meta;
  try {
    const rawMeta = await readRows(SHEET_AD_SUMMARY, META_TAB);
    meta = {};
    rawMeta.forEach(r => { if (r.KEY) meta[r.KEY] = r.VALUE; });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  const asinCurrId   = meta['ad_report_id_asin_curr_ca'];
  const spCurrId     = meta['ad_report_id_sp_curr_ca'];
  const sbCurrId     = meta['ad_report_id_sb_curr_ca'];
  const sdCurrId     = meta['ad_report_id_sd_curr_ca'];
  const sdCampCurrId = meta['ad_report_id_sdcamp_curr_ca'];
  const asinPrevId   = meta['ad_report_id_asin_prev_ca'];
  const spPrevId     = meta['ad_report_id_sp_prev_ca'];
  const sbPrevId     = meta['ad_report_id_sb_prev_ca'];
  const sdPrevId     = meta['ad_report_id_sd_prev_ca'];
  const sdCampPrevId = meta['ad_report_id_sdcamp_prev_ca'];
  const profileId    = meta['ad_profile_id_ca'];
  const endDateCurr  = meta['ad_end_date_curr_ca'];
  const endDatePrev  = meta['ad_end_date_prev_ca'];

  if (!spCurrId && !sbCurrId) {
    return res.status(400).json({ error: 'No CA report IDs in _meta — did sync-advertising-request-ca run?' });
  }

  let token;
  try {
    token = await getAdToken();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get ad token', detail: err.message });
  }

  const [asinCurrRows, spCurrRows, sbCurrRows, sdCurrRows, sdCampCurrRows, asinPrevRows, spPrevRows, sbPrevRows, sdPrevRows, sdCampPrevRows] = await Promise.all([
    asinCurrId   ? pollAndDownload(asinCurrId,   token, profileId) : Promise.resolve([]),
    spCurrId     ? pollAndDownload(spCurrId,     token, profileId) : Promise.resolve([]),
    sbCurrId     ? pollAndDownload(sbCurrId,     token, profileId) : Promise.resolve([]),
    sdCurrId     ? pollAndDownload(sdCurrId,     token, profileId) : Promise.resolve([]),
    sdCampCurrId ? pollAndDownload(sdCampCurrId, token, profileId) : Promise.resolve([]),
    asinPrevId   ? pollAndDownload(asinPrevId,   token, profileId) : Promise.resolve([]),
    spPrevId     ? pollAndDownload(spPrevId,     token, profileId) : Promise.resolve([]),
    sbPrevId     ? pollAndDownload(sbPrevId,     token, profileId) : Promise.resolve([]),
    sdPrevId     ? pollAndDownload(sdPrevId,     token, profileId) : Promise.resolve([]),
    sdCampPrevId ? pollAndDownload(sdCampPrevId, token, profileId) : Promise.resolve([]),
  ]);

  if (spCurrRows === null || spPrevRows === null) {
    return res.status(202).json({ message: 'CA reports not ready yet — will retry next run' });
  }

  const asinBrandMap = await buildAsinBrandMap();

  function yearMonthFromEndDate(endDate) {
    const [y, m] = (endDate || '').split('-');
    return {
      year:  parseInt(y, 10) || new Date().getFullYear(),
      month: parseInt(m, 10) || new Date().getMonth() + 1,
    };
  }

  const periods = [
    { label: 'curr', asinRows: asinCurrRows || [], spRows: spCurrRows || [], sbRows: sbCurrRows || [], sdRows: sdCurrRows || [], sdCampRows: sdCampCurrRows || [], endDate: endDateCurr, ...yearMonthFromEndDate(endDateCurr) },
    { label: 'prev', asinRows: asinPrevRows || [], spRows: spPrevRows || [], sbRows: sbPrevRows || [], sdRows: sdPrevRows || [], sdCampRows: sdCampPrevRows || [], endDate: endDatePrev, ...yearMonthFromEndDate(endDatePrev) },
  ];

  const ensuredTabsThisRun = new Map();
  async function ensureTabOnce(sheetId, tabName, headers) {
    const key = `${sheetId}::${tabName}`;
    if (ensuredTabsThisRun.has(key)) return ensuredTabsThisRun.get(key);
    const tok = await ensureTab(sheetId, tabName, headers);
    ensuredTabsThisRun.set(key, tok);
    return tok;
  }

  let sheetOpIndex = 0;
  const allResults = [];

  for (const period of periods) {
    const { label, year, month, endDate, asinRows, spRows, sbRows, sdRows, sdCampRows } = period;
    console.log(`[sync-advertising-process-ca] ${label}: year=${year} month=${month} asin=${asinRows.length} sp=${spRows.length} sb=${sbRows.length} sd=${sdRows.length} sdcamp=${sdCampRows.length}`);

    // ── ASIN-level (SP + SD) ──────────────────────────────────────────────
    const normalizedAsinRows = [
      ...asinRows.map(r => ({
        asin:  (r.advertisedAsin || '').trim().toUpperCase(),
        units: r.unitsSoldClicks14d || 0,
        spend: r.spend || 0,
        sales: r.sales14d || 0,
      })),
      ...sdRows.map(r => ({
        asin:  (r.promotedAsin || '').trim().toUpperCase(),
        units: r.unitsSold || 0,
        spend: r.cost || 0,
        sales: r.sales || 0,
      })),
    ];

    if (normalizedAsinRows.length > 0) {
      const byBrand = { 'asin-data': [] };
      normalizedAsinRows.forEach(r => {
        if (!r.asin) return;
        const tabName = asinBrandMap[r.asin] || 'asin-data';
        if (!byBrand[tabName]) byBrand[tabName] = [];
        byBrand[tabName].push(r);
      });

      for (const [tabName, tabRows] of Object.entries(byBrand)) {
        if (tabRows.length === 0) continue;
        const asinMap = {};
        tabRows.forEach(r => {
          if (!r.asin) return;
          if (!asinMap[r.asin]) asinMap[r.asin] = { adUnits: 0, spend: 0, sales: 0 };
          asinMap[r.asin].adUnits += r.units;
          asinMap[r.asin].spend   += r.spend;
          asinMap[r.asin].sales   += r.sales;
        });
        const brandLabel = tabName === 'asin-data' ? 'unmatched-ca' : tabName;
        const newRows = Object.entries(asinMap).map(([asin, agg]) => {
          const acos = agg.sales > 0 ? round2((agg.spend / agg.sales) * 100) : null;
          return [year, month, asin, agg.adUnits, round2(agg.spend), round2(agg.sales), acos, brandLabel, now, endDate || ''];
        });

        if (sheetOpIndex > 0) await sleep(SHEET_WRITE_STAGGER_MS);
        sheetOpIndex++;

        try {
          const tok      = await ensureTabOnce(SHEET_AD_ORDERS, tabName, ASIN_HEADERS);
          const existing = await readRows(SHEET_AD_ORDERS, tabName);
          const kept = existing.filter(r => !(parseInt(r.year,10) === year && parseInt(r.month,10) === month));
          const allRows = [...kept.map(r => [r.year, r.month, r.asin, r.ad_units, r.spend, r.sales, r.acos, r.brand, r.last_updated, r.date]), ...newRows];
          await replaceRows(SHEET_AD_ORDERS, tabName, ASIN_HEADERS, allRows, tok);
          console.log(`[sync-advertising-process-ca] ${label} ${tabName}: upserted ${newRows.length} ASIN rows`);
        } catch (err) {
          console.error(`[sync-advertising-process-ca] ${label} ${tabName} ASIN write failed:`, err.message);
          allResults.push({ period: label, brand: tabName, stage: 'asin-write', status: 'error', error: err.message });
        }
      }
    }

    // ── Campaign-level (SP + SB + SD-via-sdCampaigns) ────────────────────
    const allCampaignRows = [
      ...spRows,
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
      if (!tabName) return; // unmatched campaign — logged, not silently dropped, see note below
      if (!brandTotals[tabName]) brandTotals[tabName] = { impressions: 0, clicks: 0, spend: 0, sales: 0, adUnits: 0 };
      brandTotals[tabName].impressions += r.impressions        || 0;
      brandTotals[tabName].clicks      += r.clicks             || 0;
      brandTotals[tabName].spend       += r.spend              || 0;
      brandTotals[tabName].sales       += r.sales14d           || 0;
      brandTotals[tabName].adUnits     += r.unitsSoldClicks14d || 0;
    });

    const unmatchedCount = allCampaignRows.filter(r => !identifyBrand(r.campaignName)).length;
    if (unmatchedCount > 0) {
      console.warn(`[sync-advertising-process-ca] ${label} — ${unmatchedCount} CA campaign row(s) didn't match any known brand. If a brand other than skinuva-ca is now running CA ads, identifyBrand() needs a new entry.`);
    }

    for (const [tabName, t] of Object.entries(brandTotals)) {
      if (sheetOpIndex > 0) await sleep(SHEET_WRITE_STAGGER_MS);
      sheetOpIndex++;

      try {
        const acos = t.sales  > 0 ? round2((t.spend / t.sales) * 100)            : null;
        const roas = t.spend  > 0 ? round2(t.sales / t.spend)                     : null;
        const ctr  = t.impressions > 0 ? round2((t.clicks / t.impressions) * 100) : 0;
        const cpc  = t.clicks > 0 ? round2(t.spend / t.clicks)                    : 0;
        const newRow = [year, month, t.impressions, t.clicks, round2(t.spend), round2(t.sales), acos, roas, t.adUnits, ctr, cpc, tabName, now];

        const tok      = await ensureTabOnce(SHEET_AD_SUMMARY, tabName, SUMMARY_HEADERS);
        const existing = await readRows(SHEET_AD_SUMMARY, tabName);
        const kept = existing.filter(r => !(parseInt(r.year,10) === year && parseInt(r.month,10) === month));
        await replaceRows(SHEET_AD_SUMMARY, tabName, SUMMARY_HEADERS,
          [...kept.map(r => [r.year, r.month, r.impressions, r.clicks, r.spend, r.sales, r.acos, r.roas, r.ad_units, r.ctr, r.cpc, r.brand, r.last_updated]), newRow],
          tok
        );
        allResults.push({ period: label, brand: tabName, status: 'ok', spend: round2(t.spend), adUnits: t.adUnits });
        console.log(`[sync-advertising-process-ca] ${label} ${tabName}: spend=${round2(t.spend)} adUnits=${t.adUnits}`);
      } catch (err) {
        console.error(`[sync-advertising-process-ca] ${label} ${tabName} failed:`, err.message);
        allResults.push({ period: label, brand: tabName, status: 'error', error: err.message });
      }
    }
  }

  res.status(200).json({ results: allResults, timestamp: now });
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function buildAsinBrandMap() {
  const map = {};
  for (const brand of brands.filter(b => b.active)) {
    try {
      const rows = await readRows(sheets.products, brand.tabName);
      if (!rows || !rows.length) continue;
      const latestDate = rows.reduce((max, r) => ((r.date || '') > max ? r.date : max), '');
      rows.filter(r => r.date === latestDate).forEach(r => {
        const asin = (r.asin || '').trim().toUpperCase();
        if (asin) map[asin] = brand.id;
      });
    } catch (err) {
      console.warn(`[sync-advertising-process-ca] failed to read Products Cache for ${brand.id}:`, err.message);
    }
  }
  return map;
}

async function pollAndDownload(reportId, token, profileId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp   = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    const status = resp.status;
    console.log(`[sync-advertising-process-ca] poll ${reportId}: ${status}`);
    if (status === 'COMPLETED') return downloadAdReport(resp.url);
    if (status === 'FAILED')    return null;
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn(`[sync-advertising-process-ca] ${reportId} not ready after ${POLL_TIMEOUT_MS}ms`);
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round2 = n => Math.round(n * 100) / 100;
