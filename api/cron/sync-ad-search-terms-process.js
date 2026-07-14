/**
 * api/cron/sync-ad-search-terms-process.js
 * Step 2 of 2 — checks on the search term reports requested by
 * sync-ad-search-terms-request.js, downloads any that are ready, and
 * writes to SHEET_AD_SEARCH_TERMS — one tab per brand, one row per
 * (search term + matched keyword + match type + ad type + DAY).
 *
 * CHANGED (2026-07-14) — two changes:
 *
 * 1. Daily grain. Reports are now requested with timeUnit: DAILY (see
 *    sync-ad-search-terms-request.js), so each row carries its own `date`
 *    field. Rows are bucketed/upserted by that per-row date, not by the
 *    report's overall curr/prev period. year/month are still stored
 *    alongside `date` for convenience, but derived from the row's date.
 *
 * 2. Non-blocking polling. The OLD version looped inside a single
 *    invocation, sleeping for up to POLL_TIMEOUT_MS (240s) waiting for
 *    COMPLETED. That's the wrong shape for a Vercel serverless function:
 *    reports can take 5–90 minutes (per Amazon_Ads_Search_Term_API_Guide.md),
 *    which is far longer than any Vercel execution-time ceiling. Blocking
 *    and sleeping just gets the function killed by the platform, which
 *    looks identical to "stuck in PENDING" from the outside — this was
 *    very likely the real cause of the reports that "never" completed.
 *
 *    Now each invocation makes ONE status check per not-yet-processed
 *    report, persists status/processed flags to _meta, and returns
 *    immediately. Progress happens across MULTIPLE invocations — schedule
 *    this endpoint to run every ~5 minutes in vercel.json (instead of the
 *    old single one-off run ~10-15 min after the request step) until
 *    st_report_status flips to PROCESSED. Each report is downloaded and
 *    written to the sheet at most once (tracked via st_processed_<label>).
 *
 * SP and SB report different native columns for the same concepts (see
 * sync-ad-search-terms-request.js for the full confirmed column lists).
 * This step normalizes both into the same output shape:
 *   search_term, keyword, match_type, ad_type, campaign_name,
 *   ad_group_name, date, year, month, impressions, clicks, ctr, cost, cpc,
 *   cpm, purchases, sales, acos, conversion_rate, current_bid, last_updated
 *
 * Conversion rate: SP reports it directly (purchaseClickRate14d, requested
 * as a column in sync-ad-search-terms-request.js) so it's used as-is. SB
 * has no equivalent column, so it's calculated here as
 * (purchases / clicks) * 100. Both paths already existed in the prior
 * version of this file — unchanged by the daily-grain rewrite.
 *
 * Upsert, not full replace: rows are keyed by
 * (search_term, keyword, match_type, ad_type, date), so re-running this
 * for a report that's already been processed, or for a different report,
 * never touches unrelated dates.
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
  'campaign_name', 'ad_group_name', 'date', 'year', 'month',
  'impressions', 'clicks', 'ctr', 'cost', 'cpc', 'cpm',
  'purchases', 'sales', 'acos', 'conversion_rate', 'current_bid',
  'last_updated',
];

// One check per invocation, no sleeping — see header comment.
const LABELS = [
  { label: 'sp_curr', adType: 'SP' },
  { label: 'sb_curr', adType: 'SB' },
  { label: 'sp_prev', adType: 'SP' },
  { label: 'sb_prev', adType: 'SB' },
];

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

  const profileId = meta['st_profile_id'];
  const hasAnyReportId = LABELS.some(({ label }) => meta[`st_report_id_${label}`]);
  if (!hasAnyReportId) {
    return res.status(400).json({ error: 'No search term report IDs found in _meta — did sync-ad-search-terms-request run?' });
  }

  if (meta['st_report_status'] === 'PROCESSED' && !req.query.force) {
    return res.status(200).json({ message: 'Already processed. Pass ?force=true to re-check anyway.' });
  }

  const token = await getAdToken();
  const metaUpdates = {}; // KEY -> VALUE, applied once at the end
  const results = [];

  for (const { label, adType } of LABELS) {
    const reportId = meta[`st_report_id_${label}`];
    if (!reportId) continue;

    const alreadyProcessed = meta[`st_processed_${label}`] === 'true';
    if (alreadyProcessed) {
      results.push({ label, status: 'already_processed' });
      continue;
    }

    let statusResp;
    try {
      statusResp = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    } catch (err) {
      console.error(`[sync-ad-search-terms-process] ${label} status check failed:`, err.message);
      results.push({ label, status: 'check_failed', error: err.message });
      continue;
    }

    const status = statusResp.status;
    console.log(`[sync-ad-search-terms-process] ${label} (${reportId}): ${status}`);
    metaUpdates[`st_status_${label}`] = status;

    if (status === 'COMPLETED') {
      let rows;
      try {
        rows = await downloadAdReport(statusResp.url);
      } catch (err) {
        console.error(`[sync-ad-search-terms-process] ${label} download failed:`, err.message);
        results.push({ label, status: 'download_failed', error: err.message });
        continue; // don't mark processed — retry download next invocation
      }

      const writeResult = await writeRowsForLabel(rows, adType, now);
      metaUpdates[`st_processed_${label}`] = 'true';
      results.push({ label, status: 'ok', ...writeResult });

    } else if (status === 'FAILED' || status === 'CANCELLED') {
      // Terminal failure states — stop retrying this label, but don't let
      // it block the other 3 labels from being marked PROCESSED.
      console.warn(`[sync-ad-search-terms-process] ${label} terminal status: ${status}`);
      metaUpdates[`st_processed_${label}`] = 'true';
      results.push({ label, status: status.toLowerCase() });

    } else {
      // PENDING / IN_PROGRESS / etc — nothing to do, check again next invocation.
      results.push({ label, status: 'pending' });
    }
  }

  // Persist per-label status/processed flags.
  try {
    const tok = await ensureTab(SHEET_AD_SEARCH_TERMS, META_TAB, ['KEY', 'VALUE', 'UPDATED_AT']);
    const ex  = await readRows(SHEET_AD_SEARCH_TERMS, META_TAB);
    const mm  = {};
    ex.forEach(r => { if (r.KEY) mm[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    Object.entries(metaUpdates).forEach(([k, v]) => { mm[k] = [k, v, now]; });

    // Overall PROCESSED only once every requested label has been processed
    // (successfully or terminally-failed) — mirrors mm's just-updated values.
    const allProcessed = LABELS
      .filter(({ label }) => meta[`st_report_id_${label}`]) // only ones actually requested
      .every(({ label }) => (mm[`st_processed_${label}`]?.[1] ?? meta[`st_processed_${label}`]) === 'true');

    mm['st_report_status'] = ['st_report_status', allProcessed ? 'PROCESSED' : 'REQUESTED', now];
    await replaceRows(SHEET_AD_SEARCH_TERMS, META_TAB, ['KEY', 'VALUE', 'UPDATED_AT'], Object.values(mm), tok);

    res.status(200).json({ checked: results, overallStatus: allProcessed ? 'PROCESSED' : 'REQUESTED', timestamp: now });
  } catch (err) {
    console.error('[sync-ad-search-terms-process] failed to persist _meta:', err.message);
    res.status(200).json({ checked: results, warning: 'meta persist failed: ' + err.message, timestamp: now });
  }
};

// ── Sheet writing ────────────────────────────────────────────────────────

async function writeRowsForLabel(rawRows, adType, now) {
  const rows = (rawRows || []).map(r => ({ ...r, adType }));

  const byBrand = {};
  let unmatched = 0;
  rows.forEach(row => {
    const tabName = identifyBrand(row.campaignName);
    if (!tabName) { unmatched++; return; }
    if (!byBrand[tabName]) byBrand[tabName] = [];
    byBrand[tabName].push(row);
  });
  if (unmatched > 0) {
    console.log(`[sync-ad-search-terms-process] ${unmatched} rows had unmatched campaign names`);
  }

  const perBrand = [];
  for (const [tabName, brandRows] of Object.entries(byBrand)) {
    try {
      const normalized = brandRows.map(row => normalizeRow(row, now)).filter(Boolean);

      const token1     = await ensureTab(SHEET_AD_SEARCH_TERMS, tabName, HEADERS);
      const existing    = await readRows(SHEET_AD_SEARCH_TERMS, tabName);
      const existingObj = existing.map(normalizeExisting);

      // Upsert keyed by (search_term, keyword, match_type, ad_type, date) —
      // preserves every row for other dates untouched.
      const merged = new Map();
      existingObj.forEach(r => merged.set(rowKey(r), r));
      normalized.forEach(r => merged.set(rowKey(r), r));

      const outRows = Array.from(merged.values()).map(r => HEADERS.map(h => r[h] ?? ''));
      await replaceRows(SHEET_AD_SEARCH_TERMS, tabName, HEADERS, outRows, token1);

      console.log(`[sync-ad-search-terms-process] ${tabName}: upserted ${normalized.length} rows`);
      perBrand.push({ brand: tabName, rows: normalized.length });
    } catch (err) {
      console.error(`[sync-ad-search-terms-process] ${tabName} failed:`, err.message);
      perBrand.push({ brand: tabName, error: err.message });
    }
  }

  return { rawRows: rows.length, unmatched, perBrand };
}

function rowKey(r) {
  return `${r.search_term}||${r.keyword}||${r.match_type}||${r.ad_type}||${r.date}`;
}

function normalizeExisting(r) {
  // readRows returns header-keyed objects already — pass through as-is,
  // values will be re-stringified by HEADERS.map(...) at write time.
  return r;
}

function normalizeRow(row, now) {
  const isSP = row.adType === 'SP';

  const date = row.date || '';
  if (!date) return null; // shouldn't happen with DAILY timeUnit, but skip rather than write a garbage key
  const [yearStr, monthStr] = date.split('-');
  const year  = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const impressions = parseInt(row.impressions || '0', 10);
  const clicks       = parseInt(row.clicks || '0', 10);
  const cost         = parseFloat(row.cost || '0');

  const purchases = isSP ? parseInt(row.purchases14d || '0', 10) : parseInt(row.purchases || '0', 10);
  const sales      = isSP ? parseFloat(row.sales14d || '0')       : parseFloat(row.sales || '0');

  // Conversion rate: SP reports this directly (purchaseClickRate14d); SB
  // has no equivalent column so it's calculated from purchases/clicks.
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
    date, year, month,
    impressions, clicks, ctr,
    cost: round2(cost), cpc, cpm,
    purchases, sales: round2(sales), acos, conversion_rate: conversionRate,
    current_bid: row.keywordBid != null ? parseFloat(row.keywordBid) : '',
    last_updated: now,
  };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Amazon API calls ────────────────────────────────────────────────────

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
