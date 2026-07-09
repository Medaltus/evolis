/**
 * api/cron/sync-advertising-process.js
 * Step 2 of 2 — polls for completed ad reports and writes data to sheets.
 * Runs at 3:15 AM UTC daily (15 minutes after sync-advertising-request).
 *
 * Reads 6 report IDs from SHEET_ADVERTISING → _meta tab:
 *   ad_report_id_asin_curr / ad_report_id_sp_curr / ad_report_id_sb_curr
 *   ad_report_id_asin_prev / ad_report_id_sp_prev / ad_report_id_sb_prev
 *
 * Writes to:
 *   SHEET_ADVERTISING  → one tab per brand, one row per month (upsert by year+month)
 *                        SP + SB campaign data merged into single row
 *   SHEET_AD_ORDERS    → one tab per brand, one row per ASIN per month (SP only)
 */

const { getAdToken }                                   = require('../_spauth');
const { ensureTab, readRows, replaceRows, appendRows }  = require('../config/_sheets_client');
const brands                                           = require('../config/brands');
const https                                            = require('https');
const zlib                                             = require('zlib');

const AD_API_HOST      = 'advertising-api.amazon.com';
const SHEET_AD_SUMMARY = process.env.SHEET_ADVERTISING;
const SHEET_AD_ORDERS  = process.env.SHEET_AD_ORDERS || '1N30haUFZkdv9rrvYuWwUhxEm0z7MGp1bz9F462aF-QI';
const META_TAB         = '_meta';
const META_HEADERS     = ['KEY', 'VALUE', 'UPDATED_AT'];
const TRIM_YEARS       = 3;

const SUMMARY_HEADERS = [
  'year', 'month', 'impressions', 'clicks', 'spend', 'sales',
  'acos', 'roas', 'ad_units', 'ctr', 'cpc', 'brand', 'last_updated',
];
const ASIN_HEADERS = [
  'year', 'month', 'sku', 'ad_units', 'spend', 'sales',
  'acos', 'brand', 'last_updated',
];

const POLL_TIMEOUT_MS  = 240_000;
const POLL_INTERVAL_MS = 10_000;

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
].sort((a, b) => b.name.length - a.name.length);

function identifyBrand(campaignName) {
  const lower = (campaignName || '').toLowerCase();
  const match = CAMPAIGN_BRANDS.find(b => lower.includes(b.name));
  return match ? match.tabName : null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date().toISOString();

  // ── 1. Read _meta ──────────────────────────────────────────────────────────
  let meta = {};
  try {
    const rawMeta = await readRows(SHEET_AD_SUMMARY, META_TAB);
    rawMeta.forEach(r => { if (r.KEY) meta[r.KEY] = r.VALUE; });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read _meta tab', detail: err.message });
  }

  const asinCurrId = meta['ad_report_id_asin_curr'];
  const spCurrId   = meta['ad_report_id_sp_curr'];
  const sbCurrId   = meta['ad_report_id_sb_curr'];
  const asinPrevId = meta['ad_report_id_asin_prev'];
  const spPrevId   = meta['ad_report_id_sp_prev'];
  const sbPrevId   = meta['ad_report_id_sb_prev'];
  const profileId  = meta['ad_profile_id'];
  const endDateCurr = meta['ad_end_date_curr'];
  const endDatePrev = meta['ad_end_date_prev'];

  // Support old-style single report IDs for backwards compatibility
  const legacyAsinId    = meta['ad_report_id_asin'];
  const legacySummaryId = meta['ad_report_id_summary'];
  const legacyEndDate   = meta['ad_end_date'];

  const hasNewIds = asinCurrId || spCurrId || sbCurrId;
  const hasLegacyIds = legacyAsinId || legacySummaryId;

  if (!hasNewIds && !hasLegacyIds) {
    return res.status(400).json({ error: 'No ad report IDs found in _meta — did sync-advertising-request run?' });
  }

  // ── PROCESSED early exit — check queue first ──────────────────────────────
  if (meta['ad_report_status'] === 'PROCESSED') {
    const queueStr = meta['ad_backfill_queue'] || '';
    const queue    = queueStr.split(',').map(s => s.trim()).filter(Boolean);
    if (queue.length > 0) {
      const nextMonth = queue.shift();
      console.log(`[sync-advertising-process] PROCESSED + queue ${queue.length + 1} months — advancing to ${nextMonth}`);
      try {
        const tok = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
        const ex  = await readRows(SHEET_AD_SUMMARY, META_TAB);
        const mm  = {};
        ex.forEach(r => { if (r.KEY) mm[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
        mm['ad_backfill_queue'] = ['ad_backfill_queue', queue.join(','), now];
        if (queue.length === 0) mm['ad_backfill_complete'] = ['ad_backfill_complete', 'true', now];
        await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(mm), tok);
        const backfillHandler = require('./sync-advertising-backfill');
        await backfillHandler(
          { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: { month: nextMonth } },
          { status: () => ({ json: (d) => console.log(`[sync-advertising-process] queued ${nextMonth}:`, JSON.stringify(d).slice(0,150)) }), end: () => {} }
        );
        return res.status(200).json({ message: `Queue advanced to ${nextMonth}`, remaining: queue.length });
      } catch (err) {
        console.error(`[sync-advertising-process] queue advance failed:`, err.message);
        return res.status(200).json({ message: 'Queue advance failed', error: err.message });
      }
    }
    return res.status(200).json({ message: 'Already processed, no queue remaining' });
  }

  const token = await getAdToken();

  // ── 2. Poll + download all reports ────────────────────────────────────────
  // Handle both new multi-report format and legacy single-report format
  let asinCurrRows = [], spCurrRows = [], sbCurrRows = [];
  let asinPrevRows = [], spPrevRows = [], sbPrevRows = [];
  let legacyAsinRows = [], legacySummaryRows = [];

  if (hasNewIds) {
    console.log(`[sync-advertising-process] processing new-format reports`);
    const results = await Promise.all([
      asinCurrId ? pollAndDownload(asinCurrId, token, profileId) : Promise.resolve([]),
      spCurrId   ? pollAndDownload(spCurrId,   token, profileId) : Promise.resolve([]),
      sbCurrId   ? pollAndDownload(sbCurrId,   token, profileId) : Promise.resolve([]),
      asinPrevId ? pollAndDownload(asinPrevId, token, profileId) : Promise.resolve([]),
      spPrevId   ? pollAndDownload(spPrevId,   token, profileId) : Promise.resolve([]),
      sbPrevId   ? pollAndDownload(sbPrevId,   token, profileId) : Promise.resolve([]),
    ]);
    [asinCurrRows, spCurrRows, sbCurrRows, asinPrevRows, spPrevRows, sbPrevRows] = results;

    // If any curr or prev campaign report is still pending, retry later
    if (spCurrRows === null || spPrevRows === null) {
      return res.status(202).json({ message: 'Reports not ready yet — will retry next run' });
    }
    // Treat null as empty (non-critical reports e.g. SB may fail gracefully)
    asinCurrRows = asinCurrRows || [];
    sbCurrRows   = sbCurrRows   || [];
    asinPrevRows = asinPrevRows || [];
    sbPrevRows   = sbPrevRows   || [];

  } else {
    // Legacy path — single period
    console.log(`[sync-advertising-process] processing legacy-format reports`);
    const results = await Promise.all([
      legacyAsinId    ? pollAndDownload(legacyAsinId,    token, profileId) : Promise.resolve([]),
      legacySummaryId ? pollAndDownload(legacySummaryId, token, profileId) : Promise.resolve([]),
    ]);
    [legacyAsinRows, legacySummaryRows] = results;
    if (legacyAsinRows === null || legacySummaryRows === null) {
      return res.status(202).json({ message: 'Reports not ready yet — will retry next run' });
    }
  }

  // ── 3. Derive year/month for each period ──────────────────────────────────
  function yearMonthFromEndDate(endDate) {
    const [y, m] = (endDate || '').split('-');
    return {
      year:  parseInt(y, 10) || new Date().getFullYear(),
      month: parseInt(m, 10) || new Date().getMonth() + 1,
    };
  }

  const periods = hasNewIds
    ? [
        { label: 'curr', asinRows: asinCurrRows, spRows: spCurrRows, sbRows: sbCurrRows, ...yearMonthFromEndDate(endDateCurr) },
        { label: 'prev', asinRows: asinPrevRows, spRows: spPrevRows, sbRows: sbPrevRows, ...yearMonthFromEndDate(endDatePrev) },
      ]
    : [
        { label: 'legacy', asinRows: legacyAsinRows, spRows: legacySummaryRows, sbRows: [], ...yearMonthFromEndDate(legacyEndDate) },
      ];

  // ── 4. Build ASIN → brand map ──────────────────────────────────────────────
  const PRODUCT_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
  const PRODUCT_SHEET_GID = '164358627';
  const asinBrandMap = {};
  try {
    const csvUrl  = `https://docs.google.com/spreadsheets/d/${PRODUCT_SHEET_ID}/export?format=csv&gid=${PRODUCT_SHEET_GID}`;
    const csvResp = await fetch(csvUrl);
    if (csvResp.ok) {
      const csv = await csvResp.text();
      csv.trim().split('\n').slice(1).forEach(line => {
        const cols      = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        const asin      = (cols[0] || '').toUpperCase();
        const brandName = (cols[3] || '').toLowerCase().trim();
        if (!asin || !brandName) return;
        const matched = brands.find(b =>
          b.active && (
            brandName === b.id.toLowerCase() ||
            brandName === b.displayName.toLowerCase() ||
            brandName.includes(b.id.toLowerCase())
          )
        );
        if (matched) asinBrandMap[asin] = matched.tabName;
      });
      console.log(`[sync-advertising-process] ASIN→brand map: ${Object.keys(asinBrandMap).length} entries`);
    }
  } catch (err) {
    console.warn('[sync-advertising-process] ASIN→brand lookup failed:', err.message);
  }

  // ── 5. Process each period ────────────────────────────────────────────────
  const allResults = [];
  const cutoff = new Date().getFullYear() - TRIM_YEARS;

  for (const period of periods) {
    const { label, year, month, asinRows, spRows, sbRows } = period;
    console.log(`[sync-advertising-process] ${label}: year=${year} month=${month} asin=${asinRows.length} sp=${spRows.length} sb=${sbRows.length}`);

    // ── 5a. Write ASIN-level data (SP only) ──────────────────────────────────
    if (asinRows.length > 0) {
      const byBrand = { 'asin-data': [] };
      asinRows.forEach(r => {
        const asin    = (r.advertisedAsin || '').trim().toUpperCase();
        if (!asin) return;
        const tabName = asinBrandMap[asin] || 'asin-data';
        if (!byBrand[tabName]) byBrand[tabName] = [];
        byBrand[tabName].push(r);
      });

      for (const [tabName, tabRows] of Object.entries(byBrand)) {
        if (tabRows.length === 0) continue;
        const asinMap = {};
        tabRows.forEach(r => {
          const asin = (r.advertisedAsin || '').trim().toUpperCase();
          if (!asin) return;
          if (!asinMap[asin]) asinMap[asin] = { adUnits: 0, spend: 0, sales: 0 };
          asinMap[asin].adUnits += r.unitsSoldClicks14d || 0;
          asinMap[asin].spend   += r.spend              || 0;
          asinMap[asin].sales   += r.sales14d            || 0;
        });
        const brandLabel = tabName === 'asin-data' ? 'unmatched' : tabName;
        const newRows = Object.entries(asinMap).map(([asin, agg]) => {
          const acos = agg.sales > 0 ? round2((agg.spend / agg.sales) * 100) : null;
          return [year, month, asin, agg.adUnits, round2(agg.spend), round2(agg.sales), acos, brandLabel, now];
        }).filter(r => parseInt(r[0], 10) >= cutoff);

        try {
          const tok      = await ensureTab(SHEET_AD_ORDERS, tabName, ASIN_HEADERS);
          const existing = await readRows(SHEET_AD_ORDERS, tabName);
          // Remove rows matching this year/month, then append new ones
          const kept = existing.filter(r => !(parseInt(r.year,10) === year && parseInt(r.month,10) === month));
          const allRows = [...kept.map(r => [r.year, r.month, r.sku, r.ad_units, r.spend, r.sales, r.acos, r.brand, r.last_updated]), ...newRows];
          await replaceRows(SHEET_AD_ORDERS, tabName, ASIN_HEADERS, allRows, tok);
          console.log(`[sync-advertising-process] ${label} ${tabName}: upserted ${newRows.length} ASIN rows`);
        } catch (err) {
          console.error(`[sync-advertising-process] ${label} ${tabName} ASIN write failed:`, err.message);
        }
      }
    }

    // ── 5b. Merge SP + SB campaign rows, aggregate per brand ─────────────────
    // SB and SP use different column names for the same concepts — SB has no
    // "14d attribution window" suffix the way SP does. Confirmed against
    // Amazon's real sbCampaigns schema (2026-07-09):
    //   SP: spend, sales14d, unitsSoldClicks14d
    //   SB: cost,  sales,    purchases
    // Remap all three SB fields to the SP-shaped keys the aggregation below
    // reads — previously only `spend` was remapped and `purchases14d` (which
    // was never actually SB's field name) was used instead of `purchases`,
    // so SB sales and units were both silently counted as 0 in every total.
    const allCampaignRows = [
      ...spRows,
      ...sbRows.map(r => ({
        ...r,
        spend:               r.cost      || r.spend      || 0,
        sales14d:            r.sales     || r.sales14d    || 0,
        unitsSoldClicks14d:  r.purchases || r.purchases14d || 0,
      })),
    ];

    const brandTotals = {};
    allCampaignRows.forEach(r => {
      const tabName = identifyBrand(r.campaignName);
      if (!tabName) {
        console.log(`[sync-advertising-process] unmatched campaign: "${r.campaignName}"`);
        return;
      }
      if (!brandTotals[tabName]) brandTotals[tabName] = { impressions: 0, clicks: 0, spend: 0, sales: 0, adUnits: 0 };
      brandTotals[tabName].impressions += r.impressions        || 0;
      brandTotals[tabName].clicks      += r.clicks             || 0;
      brandTotals[tabName].spend       += r.spend              || 0;
      brandTotals[tabName].sales       += r.sales14d           || 0;
      brandTotals[tabName].adUnits     += r.unitsSoldClicks14d || 0;
    });

    for (const brand of brands.filter(b => b.active)) {
      try {
        const t    = brandTotals[brand.tabName] || { impressions: 0, clicks: 0, spend: 0, sales: 0, adUnits: 0 };
        const acos = t.sales  > 0 ? round2((t.spend / t.sales) * 100)            : null;
        const roas = t.spend  > 0 ? round2(t.sales / t.spend)                     : null;
        const ctr  = t.impressions > 0 ? round2((t.clicks / t.impressions) * 100) : 0;
        const cpc  = t.clicks > 0 ? round2(t.spend / t.clicks)                    : 0;
        const newRow = [year, month, t.impressions, t.clicks, round2(t.spend), round2(t.sales), acos, roas, t.adUnits, ctr, cpc, brand.id, now];

        const tok      = await ensureTab(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS);
        const existing = await readRows(SHEET_AD_SUMMARY, brand.tabName);
        // Upsert: remove matching year/month row, append new one
        const kept = existing.filter(r => !(parseInt(r.year,10) === year && parseInt(r.month,10) === month));
        await replaceRows(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS,
          [...kept.map(r => [r.year, r.month, r.impressions, r.clicks, r.spend, r.sales, r.acos, r.roas, r.ad_units, r.ctr, r.cpc, r.brand, r.last_updated]), newRow],
          tok
        );
        allResults.push({ period: label, brand: brand.id, status: 'ok', spend: round2(t.spend), adUnits: t.adUnits });
        console.log(`[sync-advertising-process] ${label} ${brand.id}: spend=${round2(t.spend)} adUnits=${t.adUnits}`);
      } catch (err) {
        console.error(`[sync-advertising-process] ${label} ${brand.id} failed:`, err.message);
        allResults.push({ period: label, brand: brand.id, status: 'error', error: err.message });
      }
    }
  }

  // ── 6. Mark _meta as PROCESSED ────────────────────────────────────────────
  try {
    const existing = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const metaMap  = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaMap['ad_report_status'] = ['ad_report_status', 'PROCESSED', now];
    metaMap['ad_backfill']      = ['ad_backfill', 'false', now];

    // Queue auto-advance
    const queueStr = metaMap['ad_backfill_queue']?.[1] || '';
    const queue    = queueStr.split(',').map(s => s.trim()).filter(Boolean);
    if (queue.length > 0) {
      const nextMonth = queue.shift();
      metaMap['ad_backfill_queue'] = ['ad_backfill_queue', queue.join(','), now];
      if (queue.length === 0) metaMap['ad_backfill_complete'] = ['ad_backfill_complete', 'true', now];
      const token2 = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
      await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);
      try {
        const backfillHandler = require('./sync-advertising-backfill');
        await backfillHandler(
          { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: { month: nextMonth } },
          { status: () => ({ json: (d) => console.log(`[sync-advertising-process] backfill ${nextMonth}:`, JSON.stringify(d).slice(0,150)) }), end: () => {} }
        );
      } catch (err) {
        console.error(`[sync-advertising-process] backfill fire failed:`, err.message);
      }
      return res.status(200).json({ results: allResults, queueAdvanced: nextMonth, remaining: queue.length, timestamp: now });
    }

    const token2 = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);
  } catch (err) {
    console.warn('[sync-advertising-process] failed to update _meta status:', err.message);
  }

  return res.status(200).json({ results: allResults, timestamp: now });
};

// ── Poll + download ───────────────────────────────────────────────────────────
async function pollAndDownload(reportId, token, profileId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp   = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    const status = resp.status;
    console.log(`[sync-advertising-process] poll ${reportId}: ${status}`);
    if (status === 'COMPLETED') return downloadAdReport(resp.url);
    if (status === 'FAILED')    return null;
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn(`[sync-advertising-process] ${reportId} not ready after ${POLL_TIMEOUT_MS}ms`);
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

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
