/**
 * api/cron/sync-ad-search-terms-process.js
 * Step 2 of 2 — polls for the search term reports requested by
 * sync-ad-search-terms-request.js, downloads them, and writes to
 * SHEET_AD_SEARCH_TERMS — one tab per brand, one row per
 * (search term + matched keyword + match type + ad type).
 *
 * SP and SB report different native columns for the same concepts (see
 * sync-ad-search-terms-request.js for the full confirmed column lists).
 * This step normalizes both into the same output shape:
 *   search_term, keyword, match_type, ad_type, campaign_name,
 *   ad_group_name, year, month, impressions, clicks, ctr, cost, cpc, cpm,
 *   purchases, sales, acos, conversion_rate, current_bid, last_updated
 *
 * CPC, ACOS, conversion rate, and CTR are taken directly from SP's report
 * where available (costPerClick, acosClicks14d, purchaseClickRate14d,
 * clickThroughRate); for SB, which has no such direct columns, they're
 * derived from cost/clicks/sales/purchases/impressions. CPM is always
 * derived (cost ÷ impressions × 1000) — neither report has it as a
 * literal column.
 *
 * Upsert, not full replace: existing rows for months OUTSIDE this run's
 * curr/prev window are preserved. Only curr and prev month's rows get
 * overwritten — same accumulate-history pattern used elsewhere in this
 * codebase (e.g. sync-subscriptions.js).
 *
 * Runs a few minutes after sync-ad-search-terms-request.
 */

const { getAdToken }                                   = require('../_spauth');
const { ensureTab, readRows, replaceRows }             = require('../config/_sheets_client');
const https                                            = require('https');
const zlib                                             = require('zlib');

const AD_API_HOST           = 'advertising-api.amazon.com';
const SHEET_AD_SEARCH_TERMS = process.env.SHEET_AD_SEARCH_TERMS;
const META_TAB               = '_meta';

const HEADERS = [
  'search_term', 'keyword', 'match_type', 'ad_type',
  'campaign_name', 'ad_group_name', 'year', 'month',
  'impressions', 'clicks', 'ctr', 'cost', 'cpc', 'cpm',
  'purchases', 'sales', 'acos', 'conversion_rate', 'current_bid',
  'last_updated',
];

const POLL_TIMEOUT_MS  = 240_000;
const POLL_INTERVAL_MS = 10_000;

// Same brand-matching list as sync-advertising-process.js, kept in sync
// intentionally — if that list changes, update both places.
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

// Strips accents/diacritics so "évolis", "ÉVOLIS", and "evolis" all match
// the same way. Lowercasing alone isn't enough — 'évolis'.includes('evolis')
// is false, since é and e are different characters even after lowercasing.
function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function identifyBrand(campaignName) {
  const normalized = stripAccents((campaignName || '').toLowerCase());
  const match = CAMPAIGN_BRANDS.find(b => normalized.includes(b.name));
  return match ? match.tabName : null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date().toISOString();

  let meta = {};
  try {
    const rawMeta = await readRows(SHEET_AD_SEARCH_TERMS, META_TAB);
    rawMeta.forEach(r => { if (r.KEY) meta[r.KEY] = r.VALUE; });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read _meta tab', detail: err.message });
  }

  const spCurrId  = meta['st_report_id_sp_curr'];
  const sbCurrId  = meta['st_report_id_sb_curr'];
  const spPrevId  = meta['st_report_id_sp_prev'];
  const sbPrevId  = meta['st_report_id_sb_prev'];
  const profileId = meta['st_profile_id'];

  if (!spCurrId && !sbCurrId && !spPrevId && !sbPrevId) {
    return res.status(400).json({ error: 'No search term report IDs found in _meta — did sync-ad-search-terms-request run?' });
  }

  if (meta['st_report_status'] === 'PROCESSED') {
    return res.status(200).json({ message: 'Already processed' });
  }

  const token = await getAdToken();

  console.log('[sync-ad-search-terms-process] polling reports');
  const [spCurrRows, sbCurrRows, spPrevRows, sbPrevRows] = await Promise.all([
    spCurrId ? pollAndDownload(spCurrId, token, profileId) : [],
    sbCurrId ? pollAndDownload(sbCurrId, token, profileId) : [],
    spPrevId ? pollAndDownload(spPrevId, token, profileId) : [],
    sbPrevId ? pollAndDownload(sbPrevId, token, profileId) : [],
  ]);

  const periods = [
    { label: 'curr', rows: [...(spCurrRows || []).map(r => ({ ...r, adType: 'SP' })), ...(sbCurrRows || []).map(r => ({ ...r, adType: 'SB' }))], endDate: meta['st_end_date_curr'] },
    { label: 'prev', rows: [...(spPrevRows || []).map(r => ({ ...r, adType: 'SP' })), ...(sbPrevRows || []).map(r => ({ ...r, adType: 'SB' }))], endDate: meta['st_end_date_prev'] },
  ];

  const results = [];

  for (const period of periods) {
    if (period.rows.length === 0) {
      console.log(`[sync-ad-search-terms-process] ${period.label} — no rows`);
      continue;
    }

    const { year, month } = yearMonthFromEndDate(period.endDate);
    console.log(`[sync-ad-search-terms-process] ${period.label} (${year}-${month}) — ${period.rows.length} raw rows`);

    // Bucket rows by brand via campaign name, same as the campaign-level sync
    const byBrand = {};
    period.rows.forEach(row => {
      const tabName = identifyBrand(row.campaignName);
      if (!tabName) {
        console.log(`[sync-ad-search-terms-process] unmatched campaign: "${row.campaignName}"`);
        return;
      }
      if (!byBrand[tabName]) byBrand[tabName] = [];
      byBrand[tabName].push(row);
    });

    for (const [tabName, rows] of Object.entries(byBrand)) {
      try {
        const normalized = rows.map(row => normalizeRow(row, year, month, now));

        const token1     = await ensureTab(SHEET_AD_SEARCH_TERMS, tabName, HEADERS);
        const existing    = await readRows(SHEET_AD_SEARCH_TERMS, tabName);
        const existingObj = existing.map(normalizeExisting);

        // Upsert keyed by (search_term, keyword, match_type, ad_type, year, month) —
        // preserves every row outside this period untouched.
        const merged = new Map();
        existingObj.forEach(r => merged.set(rowKey(r), r));
        normalized.forEach(r => merged.set(rowKey(r), r));

        const outRows = Array.from(merged.values()).map(r => HEADERS.map(h => r[h] ?? ''));
        await replaceRows(SHEET_AD_SEARCH_TERMS, tabName, HEADERS, outRows, token1);

        console.log(`[sync-ad-search-terms-process] ${period.label} ${tabName}: upserted ${normalized.length} rows`);
        results.push({ period: period.label, brand: tabName, status: 'ok', rows: normalized.length });
      } catch (err) {
        console.error(`[sync-ad-search-terms-process] ${period.label} ${tabName} failed:`, err.message);
        results.push({ period: period.label, brand: tabName, status: 'error', error: err.message });
      }
    }
  }

  // Mark processed
  try {
    const tok = await ensureTab(SHEET_AD_SEARCH_TERMS, META_TAB, ['KEY', 'VALUE', 'UPDATED_AT']);
    const ex  = await readRows(SHEET_AD_SEARCH_TERMS, META_TAB);
    const mm  = {};
    ex.forEach(r => { if (r.KEY) mm[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    mm['st_report_status'] = ['st_report_status', 'PROCESSED', now];
    await replaceRows(SHEET_AD_SEARCH_TERMS, META_TAB, ['KEY', 'VALUE', 'UPDATED_AT'], Object.values(mm), tok);
  } catch (err) {
    console.warn('[sync-ad-search-terms-process] failed to mark processed:', err.message);
  }

  res.status(200).json({ synced: results, timestamp: now });
};

// ── Row normalization ──────────────────────────────────────────────────────

function rowKey(r) {
  return `${r.search_term}||${r.keyword}||${r.match_type}||${r.ad_type}||${r.year}||${r.month}`;
}

function normalizeExisting(r) {
  // readRows returns header-keyed objects already — pass through as-is,
  // values will be re-stringified by HEADERS.map(...) at write time.
  return r;
}

function normalizeRow(row, year, month, now) {
  const isSP = row.adType === 'SP';

  const impressions = parseInt(row.impressions || '0', 10);
  const clicks       = parseInt(row.clicks || '0', 10);
  const cost         = parseFloat(row.cost || '0');

  const purchases = isSP ? parseInt(row.purchases14d || '0', 10) : parseInt(row.purchases || '0', 10);
  const sales      = isSP ? parseFloat(row.sales14d || '0')       : parseFloat(row.sales || '0');

  const cpc  = isSP && row.costPerClick != null ? parseFloat(row.costPerClick) : (clicks > 0 ? round2(cost / clicks) : 0);
  const ctr  = isSP && row.clickThroughRate != null ? parseFloat(row.clickThroughRate) : (impressions > 0 ? round2((clicks / impressions) * 100) : 0);
  const acos = isSP && row.acosClicks14d != null ? parseFloat(row.acosClicks14d) : (sales > 0 ? round2((cost / sales) * 100) : null);
  const conversionRate = isSP && row.purchaseClickRate14d != null
    ? parseFloat(row.purchaseClickRate14d)
    : (clicks > 0 ? round2((purchases / clicks) * 100) : 0);
  const cpm = impressions > 0 ? round2((cost / impressions) * 1000) : 0;

  return {
    search_term:      row.searchTerm || '',
    keyword:           isSP ? (row.keyword || '') : (row.keywordText || ''),
    match_type:        row.matchType || '',
    ad_type:            row.adType,
    campaign_name:      row.campaignName || '',
    ad_group_name:      row.adGroupName || '',
    year, month,
    impressions, clicks, ctr,
    cost: round2(cost), cpc, cpm,
    purchases, sales: round2(sales), acos, conversion_rate: conversionRate,
    current_bid: row.keywordBid != null ? parseFloat(row.keywordBid) : '',
    last_updated: now,
  };
}

function yearMonthFromEndDate(endDateStr) {
  const d = new Date(endDateStr);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Report polling/download (same pattern as sync-advertising-process.js) ──

async function pollAndDownload(reportId, token, profileId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp   = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    const status = resp.status;
    console.log(`[sync-ad-search-terms-process] poll ${reportId}: ${status}`);
    if (status === 'COMPLETED') return downloadAdReport(resp.url);
    if (status === 'FAILED')    return [];
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn(`[sync-ad-search-terms-process] ${reportId} not ready after ${POLL_TIMEOUT_MS}ms`);
  return [];
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
            try { resolve(JSON.parse(buf.toString())); } catch (e) { reject(e); }
            return;
          }
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
        catch (e) { reject(new Error(`Ad API parse error (${res.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
