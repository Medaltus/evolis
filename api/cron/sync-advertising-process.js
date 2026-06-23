/**
 * api/cron/sync-advertising-process.js
 * Step 2 of 2 — polls for completed ad reports and writes data to sheets.
 * Runs at 3:15 AM UTC daily (15 minutes after sync-advertising-request).
 *
 * Reads report IDs from SHEET_ADVERTISING → _meta tab.
 * If reports aren't ready yet, returns 202 — Vercel cron will retry next day.
 *
 * Writes to:
 *   SHEET_ADVERTISING  → one tab per brand (campaign-level monthly summary)
 *   SHEET_AD_ORDERS    → 'asin-data' tab (ASIN-level ad units, all brands)
 */

const { getAdToken }                             = require('../_spauth');
const { ensureTab, readRows, replaceRows, appendRows } = require('../config/_sheets_client');
const brands                                     = require('../config/brands');
const https                                      = require('https');
const zlib                                       = require('zlib');

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
  'year', 'month', 'asin', 'ad_units', 'spend', 'sales',
  'acos', 'brand', 'last_updated',
];

// Poll timeout — if reports still not ready after this, return 202
const POLL_TIMEOUT_MS  = 240_000; // 4 minutes
const POLL_INTERVAL_MS = 10_000;  // 10 seconds

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date().toISOString();

  // ── 1. Read _meta tab ───────────────────────────────────────────────────────
  let asinReportId, summaryReportId, startDate, endDate, profileId, isBackfill;
  try {
    const rawMeta = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const meta    = {};
    rawMeta.forEach(r => { if (r.KEY) meta[r.KEY] = r.VALUE; });

    asinReportId    = meta['ad_report_id_asin'];
    summaryReportId = meta['ad_report_id_summary'];
    startDate       = meta['ad_start_date'];
    endDate         = meta['ad_end_date'];
    profileId       = meta['ad_profile_id'];
    isBackfill      = meta['ad_backfill'] === 'true';

    if (!asinReportId && !summaryReportId) {
      return res.status(400).json({ error: 'No ad report IDs found in _meta — did sync-advertising-request run?' });
    }

    if (meta['ad_report_status'] === 'PROCESSED') {
      // Check if there's a backfill queue waiting — if so, advance it
      const queueStr = meta['ad_backfill_queue'] || '';
      const queue    = queueStr.split(',').map(s => s.trim()).filter(Boolean);
      if (queue.length > 0) {
        console.log(`[sync-advertising-process] PROCESSED but queue has ${queue.length} months — advancing`);
        // Fire the next backfill request inline then return
        const nextMonth = queue.shift();
        try {
          const backfillHandler = require('./sync-advertising-backfill');
          await backfillHandler(
            { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: { month: nextMonth } },
            { status: () => ({ json: (d) => console.log(`[sync-advertising-process] backfill ${nextMonth}:`, JSON.stringify(d).slice(0,150)) }), end: () => {} }
          );
          // Update queue in _meta
          const tok2    = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
          const ex2     = await readRows(SHEET_AD_SUMMARY, META_TAB);
          const mm2     = {};
          ex2.forEach(r => { if (r.KEY) mm2[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
          mm2['ad_backfill_queue'] = ['ad_backfill_queue', queue.join(','), new Date().toISOString()];
          if (queue.length === 0) mm2['ad_backfill_complete'] = ['ad_backfill_complete', 'true', new Date().toISOString()];
          await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(mm2), tok2);
          return res.status(200).json({ message: `Queue advanced to ${nextMonth}`, remaining: queue.length });
        } catch (err) {
          console.error(`[sync-advertising-process] queue advance failed:`, err.message);
          return res.status(200).json({ message: 'Queue advance failed', error: err.message });
        }
      }
      return res.status(200).json({ message: 'Already processed, no queue remaining', asinReportId, summaryReportId });
    }

    console.log(`[sync-advertising-process] resuming asin=${asinReportId} summary=${summaryReportId}`);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read _meta tab', detail: err.message });
  }

  const token = await getAdToken();

  // ── 2. Poll + download both reports ────────────────────────────────────────
  const [asinResult, summaryResult] = await Promise.all([
    asinReportId    ? pollAndDownload(asinReportId,    token, profileId) : Promise.resolve({ rows: [], status: 'skipped' }),
    summaryReportId ? pollAndDownload(summaryReportId, token, profileId) : Promise.resolve({ rows: [], status: 'skipped' }),
  ]);

  // If reports are still genuinely pending (just requested), wait for next cron run
  if (asinResult.status === 'pending' || summaryResult.status === 'pending') {
    console.log('[sync-advertising-process] reports still pending — will retry in 15 min');
    return res.status(202).json({
      message: 'Reports not ready yet — will retry next run',
      asinReportId,
      summaryReportId,
    });
  }

  // If reports failed or expired, mark as PROCESSED so we don't loop forever
  // The daily request cron will fire fresh reports tomorrow
  if (asinResult.status === 'failed' || summaryResult.status === 'failed') {
    console.error('[sync-advertising-process] one or more reports failed/expired — marking done to unblock queue');
    try {
      const existing = await readRows(SHEET_AD_SUMMARY, META_TAB);
      const metaMap  = {};
      existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
      metaMap['ad_report_status'] = ['ad_report_status', 'PROCESSED', now];
      metaMap['ad_backfill']      = ['ad_backfill', 'false', now];
      const token2 = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
      await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);
    } catch (e) { console.warn('[sync-advertising-process] meta update failed:', e.message); }
    return res.status(200).json({ message: 'Reports failed/expired — unblocked queue', asinReportId, summaryReportId });
  }

  const asinRows    = asinResult.rows;
  const summaryRows = summaryResult.rows;
  console.log(`[sync-advertising-process] asin rows: ${asinRows.length}, summary rows: ${summaryRows.length}`);

  // Derive year/month from endDate
  const [yearStr, monthStr] = (endDate || '').split('-');
  const year  = parseInt(yearStr,  10) || new Date().getFullYear();
  const month = parseInt(monthStr, 10) || new Date().getMonth() + 1;

  // ── 3. Build ASIN → brand map from product sheet ──────────────────────────
  // Sheet 1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA, gid 164358627
  // Col A = ASIN, col B = SKU, col C = Product Short Name, col D = Brand
  const PRODUCT_SHEET_ID = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
  const PRODUCT_SHEET_GID = '164358627';
  const asinBrandMap = {}; // ASIN → tabName

  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${PRODUCT_SHEET_ID}/export?format=csv&gid=${PRODUCT_SHEET_GID}`;
    const csvResp = await fetch(csvUrl);
    if (csvResp.ok) {
      const csv = await csvResp.text();
      const lines = csv.trim().split('\n').slice(1); // skip header
      lines.forEach(line => {
        const cols     = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        const asin     = (cols[0] || '').toUpperCase();
        const brandName = (cols[3] || '').toLowerCase().trim();
        if (!asin || !brandName) return;

        // Match brand name to a tabName in brands.js
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

  // ── 4. Write ASIN-level data — split by brand via ASIN lookup ─────────────
  if (asinRows.length > 0) {
    const cutoff = new Date().getFullYear() - TRIM_YEARS;

    // Group rows by brand tab
    const byBrand = {}; // brandTabName → [rows]
    byBrand['asin-data'] = []; // catch-all for unmatched ASINs

    asinRows.forEach(r => {
      const asin    = (r.advertisedAsin || '').trim().toUpperCase();
      if (!asin) return;
      const tabName = asinBrandMap[asin] || 'asin-data';
      if (!byBrand[tabName]) byBrand[tabName] = [];
      byBrand[tabName].push(r);
    });

    // Aggregate and write per brand tab
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
      const sheetRows  = Object.entries(asinMap).map(([asin, agg]) => {
        const acos = agg.sales > 0 ? round2((agg.spend / agg.sales) * 100) : null;
        return [year, month, asin, agg.adUnits, round2(agg.spend), round2(agg.sales), acos, brandLabel, now];
      }).filter(r => parseInt(r[0], 10) >= cutoff);

      try {
        const tok = await ensureTab(SHEET_AD_ORDERS, tabName, ASIN_HEADERS);
        if (isBackfill) {
          await appendRows(SHEET_AD_ORDERS, tabName, sheetRows, tok);
          console.log(`[sync-advertising-process] ${tabName}: appended ${sheetRows.length} ASIN rows (backfill)`);
        } else {
          await replaceRows(SHEET_AD_ORDERS, tabName, ASIN_HEADERS, sheetRows, tok);
          console.log(`[sync-advertising-process] ${tabName}: replaced with ${sheetRows.length} ASIN rows`);
        }
      } catch (err) {
        console.error(`[sync-advertising-process] ${tabName} write failed:`, err.message);
      }
    }
  }
  // ── 5. Write brand summary to SHEET_ADVERTISING using campaign name matching ─
  // Match campaigns to brands using substring matching — brand name must appear
  // anywhere in the campaign name (case-insensitive). Longest match wins to
  // prevent "Cloud" matching before "Cloud Cafe". Rows with no match are logged.
  // Source: coworker's fetch_ads_data.py identify_brand() function.

  const CAMPAIGN_BRANDS = [
    { name: 'skinuva',          tabName: 'skinuva'        },
    { name: 'the creme shop',   tabName: 'creme-shop'     },
    { name: 'cloud cafe',       tabName: 'cloud-cafe'     },
    { name: 'just bjorn',       tabName: 'just-bjorn'     },
    { name: 'pb & jay',         tabName: 'pbj'            },
    { name: 'pb&jay',           tabName: 'pbj'            },
    { name: 'miguard',          tabName: 'miguard'        },
    { name: 'dearcloud',        tabName: 'dearcloud'      },
    { name: 'eraclea',          tabName: 'eraclea'        },
    { name: 'evolis',           tabName: 'evolis'         },
    { name: 'amala',            tabName: 'amala'          },
    { name: 'cimeosil',         tabName: 'cimeosil'       },
    { name: 'collagelee',       tabName: 'collagelee'     },
    { name: 'hillside',         tabName: 'hillside'       },
    { name: 'prohibition',      tabName: 'prohibition'    },
    { name: 'skinside seoul',   tabName: 'skinside-seoul' },
    { name: 'skinside-seoul',   tabName: 'skinside-seoul' },
  // Sort longest first so "the creme shop" matches before "creme", "cloud cafe" before "cloud"
  ].sort((a, b) => b.name.length - a.name.length);

  function identifyBrand(campaignName) {
    const lower = (campaignName || '').toLowerCase();
    const match = CAMPAIGN_BRANDS.find(b => lower.includes(b.name));
    return match ? match.tabName : null;
  }

  // Build per-brand aggregates from summaryRows
  const brandSummaryTotals = {};

  summaryRows.forEach(r => {
    const tabName = identifyBrand(r.campaignName);
    if (!tabName) {
      console.log(`[sync-advertising-process] unmatched campaign: "${r.campaignName}"`);
      return;
    }
    if (!brandSummaryTotals[tabName]) {
      brandSummaryTotals[tabName] = { impressions: 0, clicks: 0, spend: 0, sales: 0, adUnits: 0 };
    }
    brandSummaryTotals[tabName].impressions += r.impressions         || 0;
    brandSummaryTotals[tabName].clicks      += r.clicks              || 0;
    brandSummaryTotals[tabName].spend       += r.spend               || 0;
    brandSummaryTotals[tabName].sales       += r.sales14d            || 0;
    brandSummaryTotals[tabName].adUnits     += r.unitsSoldClicks14d  || 0;
  });

  const results = [];
  for (const brand of brands.filter(b => b.active)) {
    try {
      const t = brandSummaryTotals[brand.tabName] || { impressions: 0, clicks: 0, spend: 0, sales: 0, adUnits: 0 };

      const acos = t.sales  > 0 ? round2((t.spend / t.sales) * 100)          : null;
      const roas = t.spend  > 0 ? round2(t.sales / t.spend)                   : null;
      const ctr  = t.impressions > 0 ? round2((t.clicks / t.impressions) * 100) : 0;
      const cpc  = t.clicks > 0 ? round2(t.spend / t.clicks)                  : 0;

      const row = [year, month, t.impressions, t.clicks, round2(t.spend), round2(t.sales),
                   acos, roas, t.adUnits, ctr, cpc, brand.id, now];

      const summaryToken = await ensureTab(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS);
      if (isBackfill) {
        await appendRows(SHEET_AD_SUMMARY, brand.tabName, [row], summaryToken);
      } else {
        await replaceRows(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS, [row], summaryToken);
      }
      results.push({ brand: brand.id, status: 'ok', spend: round2(t.spend), adUnits: t.adUnits });
    } catch (err) {
      console.error(`[sync-advertising-process] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  // ── 5. Mark _meta as PROCESSED + auto-advance backfill queue ────────────────
  try {
    const existing  = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const metaMap   = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaMap['ad_report_status'] = ['ad_report_status', 'PROCESSED', now];
    metaMap['ad_backfill']      = ['ad_backfill', 'false', now];

    // ── Queue auto-advance ──────────────────────────────────────────────────
    // If a backfill queue exists and has remaining months, fire the next request
    // automatically so the 15-min cron can pick it up without manual intervention.
    const queueStr = metaMap['ad_backfill_queue']?.[1] || '';
    const queue    = queueStr.split(',').map(s => s.trim()).filter(Boolean);

    if (queue.length > 0) {
      const nextMonth = queue.shift(); // pop oldest month off front
      metaMap['ad_backfill_queue'] = ['ad_backfill_queue', queue.join(','), now];

      console.log(`[sync-advertising-process] queue: firing next month ${nextMonth} (${queue.length} remaining)`);

      // Fire the backfill request for the next month inline
      // (lightweight — just requests the report and writes to _meta, no polling)
      try {
        const backfillHandler = require('./sync-advertising-backfill');
        const fakeReq = {
          method:  'GET',
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
          query:   { month: nextMonth },
        };
        const fakeRes = {
          status: (code) => ({ json: (data) => {
            console.log(`[sync-advertising-process] backfill request for ${nextMonth}:`, JSON.stringify(data).slice(0, 200));
          }}),
          end: () => {},
        };
        await backfillHandler(fakeReq, fakeRes);
        // Status will be reset to REQUESTED by backfill handler — process cron picks it up in 15 min
      } catch (err) {
        console.error(`[sync-advertising-process] failed to fire next queue month ${nextMonth}:`, err.message);
        // Put month back at front of queue so it retries next run
        queue.unshift(nextMonth);
        metaMap['ad_backfill_queue'] = ['ad_backfill_queue', queue.join(','), now];
      }

      if (queue.length === 0) {
        metaMap['ad_backfill_complete'] = ['ad_backfill_complete', 'true', now];
        console.log('[sync-advertising-process] backfill queue complete!');
      }
    }

    const token2 = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);
  } catch (err) {
    console.warn('[sync-advertising-process] failed to update _meta status:', err.message);
  }

  return res.status(200).json({
    asinRows:    asinRows.length,
    summaryRows: summaryRows.length,
    brands:      results,
    timestamp:   now,
  });
};

// ── Poll + download a single report ──────────────────────────────────────────
// Returns { rows, status } where status is 'completed'|'pending'|'failed'
async function pollAndDownload(reportId, token, profileId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp   = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    const status = resp.status;
    console.log(`[sync-advertising-process] poll ${reportId}: ${status}`);
    if (status === 'COMPLETED') {
      const rows = await downloadAdReport(resp.url);
      return { rows, status: 'completed' };
    }
    if (status === 'FAILED') return { rows: [], status: 'failed' };
    // PENDING or IN_PROGRESS — keep polling
    await sleep(POLL_INTERVAL_MS);
  }
  // Timed out — check one more time if it failed vs still pending
  try {
    const finalCheck = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    if (finalCheck.status === 'FAILED') return { rows: [], status: 'failed' };
  } catch (e) { /* ignore */ }
  console.warn(`[sync-advertising-process] ${reportId} not ready after ${POLL_TIMEOUT_MS}ms`);
  return { rows: [], status: 'pending' };
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
