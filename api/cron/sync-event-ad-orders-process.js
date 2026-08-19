/**
 * api/cron/sync-event-ad-orders-process.js
 * Step 2 of 2 — reads the reportIds stored by sync-event-ad-orders-request.js,
 * checks each report's status once per invocation (no blocking/sleeping —
 * see sync-ad-search-terms-process.js for why that shape matters on
 * Vercel), downloads any that are COMPLETED, and writes ASIN-level ad
 * performance for that event into SHEET_AD_ORDERS, one tab per event, all
 * brands combined (brand derived per-row via the Products Cache sheet,
 * same lookup sync-business-report-process.js already uses).
 *
 * SPONSORED DISPLAY — ADDED 2026-08-19. Each event tab now merges TWO
 * independently-tracked report IDs (report_id_sp_<tab>, report_id_sd_<tab>
 * — see sync-event-ad-orders-request.js). SP and SD are checked/processed
 * independently per tab — if one is ready this run and the other isn't,
 * whichever is ready gets written now via the existing upsert-by-key
 * merge logic below; the other merges in additively whenever it's ready
 * on a later run. Neither report type blocks the other.
 *
 * SD field names differ from SP's (promotedAsin/cost/sales/unitsSold vs
 * SP's advertisedAsin/spend/sales14d/unitsSoldClicks14d) — normalized
 * into the same row shape before merging, same normalization already
 * proven in sync-advertising-process.js's own ASIN-level merge.
 *
 * SPONSORED BRANDS NOT INCLUDED — SHEET_AD_ORDERS is ASIN-level; SB has
 * no ASIN-level report at all. See sync-event-ad-orders-request.js's
 * header for the full explanation.
 *
 * SD 'date' COLUMN UNVERIFIED — see sync-event-ad-orders-request.js's
 * header. ?debug=true below now surfaces SD's first raw row alongside
 * SP's, specifically to check this against real data before trusting it.
 *
 * Full REPLACE per tab, not an upsert — each event tab is a fixed
 * historical snapshot of "what did ad performance look like during this
 * event," re-generated cleanly each run, same model as
 * sync-event-orders-process.js uses for the organic/combined orders side.
 *
 * Manual:
 *   GET /api/cron/sync-event-ad-orders-process
 *   GET /api/cron/sync-event-ad-orders-process?force=true
 *   GET /api/cron/sync-event-ad-orders-process?debug=true
 *   Authorization: Bearer <CRON_SECRET>
 */

const { getAdToken }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                                = require('../config/brands');
const sheets                                = require('../config/sheets');
const https                                  = require('https');
const zlib                                   = require('zlib');

const AD_API_HOST  = 'advertising-api.amazon.com';
const META_TAB     = '_meta_events';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

const HEADERS = ['asin', 'brand', 'impressions', 'clicks', 'ad_units', 'purchases', 'spend', 'sales', 'acos', 'last_updated', 'purchase_date', 'year'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const force = req.query.force === 'true';
  const now   = new Date().toISOString();

  let metaMap;
  try {
    const rawMeta = await readRows(sheets.adOrders, META_TAB);
    metaMap = {};
    (rawMeta || []).forEach(r => { if (r.KEY) metaMap[r.KEY] = r.VALUE; });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read _meta_events', detail: err.message });
  }

  const targetTabs = (metaMap['target_tabs'] || '').split(',').filter(Boolean);
  if (!targetTabs.length) return res.status(400).json({ error: 'No target_tabs in _meta_events — did sync-event-ad-orders-request run?' });

  let token;
  try {
    token = await getAdToken();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get ad token', detail: err.message });
  }

  // Build one ASIN -> brand map spanning every active brand's Products
  // Cache tab, most recent snapshot date only (it's a daily-cron sheet, so
  // ASINs repeat once per sync date — same pattern as
  // sync-business-report-process.js's getBrandAsinMap, just merged across
  // all brands here instead of kept per-brand).
  const asinBrandMap = await buildAsinBrandMap();

  const results = [];
  const metaUpdates = {};

  for (const tabName of targetTabs) {
    const spReportId = metaMap[`report_id_sp_${tabName}`];
    const sdReportId = metaMap[`report_id_sd_${tabName}`];
    if (!spReportId && !sdReportId) { results.push({ tab: tabName, status: 'skipped', reason: 'no reportId of either type' }); continue; }

    if (metaMap[`processed_${tabName}`] === 'true' && !force) {
      results.push({ tab: tabName, status: 'already_processed' });
      continue;
    }

    // ── Check + download each report type independently — neither
    // blocks the other. Whichever is ready gets merged in now; the other
    // merges in additively on a later run once it's ready.
    const spOutRows = await checkAndBuildRows(spReportId, tabName, 'sp', token, metaMap['ad_profile_id'], asinBrandMap, now, req.query.debug === 'true');
    const sdOutRows = await checkAndBuildRows(sdReportId, tabName, 'sd', token, metaMap['ad_profile_id'], asinBrandMap, now, req.query.debug === 'true');

    if (req.query.debug === 'true' && (spOutRows?.debug || sdOutRows?.debug)) {
      return res.status(200).json({
        debug: true,
        tab: tabName,
        sp: spOutRows?.debug || null,
        sd: sdOutRows?.debug || null,
        note: 'Check whether SD\'s first row has a real "date" field (see file header — this was never directly confirmed) before trusting purchase_date for SD in the real write path.',
      });
    }

    const bothPending = spOutRows === 'pending' && sdOutRows === 'pending';
    const bothMissingOrFailed = (!spReportId || spOutRows === 'failed') && (!sdReportId || sdOutRows === 'failed');

    if (bothPending) { results.push({ tab: tabName, status: 'pending' }); continue; }
    if (bothMissingOrFailed) { results.push({ tab: tabName, status: 'failed' }); metaUpdates[`processed_${tabName}`] = 'true'; continue; }

    const newRows = [
      ...(Array.isArray(spOutRows) ? spOutRows : []),
      ...(Array.isArray(sdOutRows) ? sdOutRows : []),
    ];

    if (newRows.length === 0) {
      // Neither produced real rows this run (one or both still pending) —
      // don't mark processed yet, so a later run gets another chance.
      results.push({ tab: tabName, status: 'no_new_rows_yet' });
      continue;
    }

    // Upsert keyed by asin+purchase_date, NOT a full replace — same fix
    // applied to sync-event-orders-process.js. A run for one year's
    // event must never wipe out a different year's rows already sitting
    // in this tab (e.g. a manually-merged 2025 backfill), and SP/SD rows
    // for the same asin+date are independent entries (different ad
    // products), not the same key — see keyOf below.
    try {
      const tabToken = await ensureTab(sheets.adOrders, tabName, HEADERS);
      const existingRaw = await readRows(sheets.adOrders, tabName);
      const keyOf = r => {
        const arr = Array.isArray(r) ? r : HEADERS.map(h => r[h] ?? '');
        return `${arr[0]}||${arr[10]}`; // asin||purchase_date
      };

      const merged = new Map();
      (existingRaw || []).forEach(r => {
        const rowArr = Array.isArray(r) ? r : HEADERS.map(h => r[h] ?? '');
        merged.set(keyOf(rowArr), rowArr);
      });
      newRows.forEach(r => merged.set(keyOf(r), r));

      const finalRows = Array.from(merged.values());
      await replaceRows(sheets.adOrders, tabName, HEADERS, finalRows, tabToken);
      console.log(`[sync-event-ad-orders-process] ${tabName} — upserted ${newRows.length} rows this run, ${finalRows.length} total across all years`);
      results.push({ tab: tabName, status: 'ok', rowsThisRun: newRows.length, totalRows: finalRows.length });
      // Only mark fully processed once BOTH report types have either
      // succeeded or definitively failed — a still-pending one means
      // there's more to merge in later.
      const spDone = !spReportId || Array.isArray(spOutRows) || spOutRows === 'failed';
      const sdDone = !sdReportId || Array.isArray(sdOutRows) || sdOutRows === 'failed';
      if (spDone && sdDone) metaUpdates[`processed_${tabName}`] = 'true';
    } catch (err) {
      results.push({ tab: tabName, status: 'write_failed', error: err.message });
    }
  }

  try {
    const metaToken = await ensureTab(sheets.adOrders, META_TAB, META_HEADERS);
    const rawMeta    = await readRows(sheets.adOrders, META_TAB);
    const mm = {};
    (rawMeta || []).forEach(r => { if (r.KEY) mm[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    Object.entries(metaUpdates).forEach(([k, v]) => { mm[k] = [k, v, now]; });
    await replaceRows(sheets.adOrders, META_TAB, META_HEADERS, Object.values(mm), metaToken);
  } catch (err) {
    console.warn('[sync-event-ad-orders-process] failed to persist meta:', err.message);
  }

  res.status(200).json({ checked: results, timestamp: now });
};

// ── Helpers ───────────────────────────────────────────────────────────────

// Checks one report's status and, if COMPLETED, downloads + normalizes it
// into row arrays matching HEADERS. Returns:
//   'pending'  — not ready yet
//   'failed'   — terminal FAILED/CANCELLED status, or no reportId at all
//   [...]      — array of row arrays, ready to merge
//   {debug: {...}} — only when debugMode is true and the report is COMPLETED
async function checkAndBuildRows(reportId, tabName, kind, token, profileId, asinBrandMap, now, debugMode) {
  if (!reportId) return 'failed';

  let statusResp;
  try {
    statusResp = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId);
  } catch (err) {
    console.warn(`[sync-event-ad-orders-process] ${tabName} (${kind}) status check failed:`, err.message);
    return 'pending'; // transient — try again next run rather than giving up
  }

  const status = statusResp.status;
  console.log(`[sync-event-ad-orders-process] ${tabName} (${kind}, ${reportId}): ${status}`);

  if (status === 'FAILED' || status === 'CANCELLED') return 'failed';
  if (status !== 'COMPLETED') return 'pending';

  let rows;
  try {
    rows = await downloadAdReport(statusResp.url);
  } catch (err) {
    console.warn(`[sync-event-ad-orders-process] ${tabName} (${kind}) download failed:`, err.message);
    return 'pending';
  }

  if (debugMode) {
    return { debug: { tab: tabName, kind, rowCount: rows.length, firstRow: rows[0] || null } };
  }

  return rows.map(r => {
    if (kind === 'sp') {
      const asin        = (r.advertisedAsin || '').toUpperCase();
      const impressions = parseInt(r.impressions || 0, 10) || 0;
      const clicks       = parseInt(r.clicks || 0, 10) || 0;
      const spend        = round2(parseFloat(r.spend || 0) || 0);
      const purchases    = parseInt(r.purchases14d || 0, 10) || 0;
      const adUnits       = parseInt(r.unitsSoldClicks14d || 0, 10) || 0;
      const sales         = round2(parseFloat(r.sales14d || 0) || 0);
      const acos          = sales > 0 ? round2((spend / sales) * 100) : '';
      const purchaseDate  = r.date || r.reportDate || '';
      if (!purchaseDate) console.warn(`[sync-event-ad-orders-process] ${tabName} (sp) — row for ${asin} has no date field. Raw keys: ${Object.keys(r).join(',')}`);
      const year = purchaseDate ? parseInt(purchaseDate.slice(0, 4), 10) : '';
      return [asin, asinBrandMap[asin] || 'unknown', impressions, clicks, adUnits, purchases, spend, sales, acos, now, purchaseDate, year];
    } else {
      // kind === 'sd' — different real field names, confirmed via
      // test-sd-connection.js: promotedAsin/cost/sales/unitsSold/purchases.
      const asin        = (r.promotedAsin || '').toUpperCase();
      const impressions = parseInt(r.impressions || 0, 10) || 0;
      const clicks       = parseInt(r.clicks || 0, 10) || 0;
      const spend        = round2(parseFloat(r.cost || 0) || 0);
      const purchases    = parseInt(r.purchases || 0, 10) || 0;
      const adUnits       = parseInt(r.unitsSold || 0, 10) || 0;
      const sales         = round2(parseFloat(r.sales || 0) || 0);
      const acos          = sales > 0 ? round2((spend / sales) * 100) : '';
      const purchaseDate  = r.date || r.reportDate || ''; // UNVERIFIED for SD — see file header
      if (!purchaseDate) console.warn(`[sync-event-ad-orders-process] ${tabName} (sd) — row for ${asin} has no date field. Raw keys: ${Object.keys(r).join(',')}`);
      const year = purchaseDate ? parseInt(purchaseDate.slice(0, 4), 10) : '';
      return [asin, asinBrandMap[asin] || 'unknown', impressions, clicks, adUnits, purchases, spend, sales, acos, now, purchaseDate, year];
    }
  });
}

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
      console.warn(`[sync-event-ad-orders-process] failed to read Products Cache for ${brand.id}:`, err.message);
    }
  }
  return map;
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

const round2 = n => Math.round(n * 100) / 100;
