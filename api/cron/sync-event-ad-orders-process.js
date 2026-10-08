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

const { getAdToken, getSellerId }          = require('../_spauth');
const { getAccount, brandsForAccount, metaTabFor, cronLabel } = require('../_account');
const { isoDate } = require('../_dates'); // ADDED 2026-10-08
const { identifyBrand } = require('../_campaign-brands'); // ADDED 2026-10-08 — campaign→brand list (copy of sync-advertising-process.js's)
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                                = require('../config/brands');
const sheets                                = require('../config/sheets');
const https                                  = require('https');
const zlib                                   = require('zlib');

const AD_API_HOST  = 'advertising-api.amazon.com';
// META_TAB is per account — set inside the handler via metaTabFor().
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

const HEADERS = ['asin', 'brand', 'impressions', 'clicks', 'ad_units', 'purchases', 'spend', 'sales', 'acos', 'last_updated', 'purchase_date', 'year'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Seller account (ADDED 2026-10-06) ─────────────────────────────────────
  // NewDerm by default; ?account=hol runs the same job for High On Love on
  // its own staggered schedule — see api/_account.js. Same Amazon Ads login
  // for both; the account decides which ad PROFILE is used and which _meta
  // tab this run's report IDs live in, so the two runs never collide.
  let account;
  try { account = getAccount(req); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const META_TAB = metaTabFor(account, '_meta_events');
  const accountBrands = brandsForAccount(account);
  if (accountBrands.length === 0) {
    return res.status(200).json({ skipped: true, account, reason: 'no active brands for this account' });
  }

  const force = req.query.force === 'true';
  const now   = toEstIso(new Date()); // FIXED 2026-08-19 -- was UTC

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
  const asinBrandMap = await buildAsinBrandMap(accountBrands); // this account's brands only (2026-10-06)

  // Sponsored Brands campaign → brand (ADDED 2026-10-08). Same rule as the
  // daily ads cron: a single-brand account (High On Love) owns every
  // campaign in its own ad profile; NewDerm matches by campaign name.
  const ownIds = new Set(accountBrands.map(b => b.id));
  const campaignBrand = accountBrands.length === 1
    ? (() => accountBrands[0].id)
    : (name => { const t = identifyBrand(name); return t && ownIds.has(t) ? t : null; });

  const results = [];
  const metaUpdates = {};

  for (const tabName of targetTabs) {
    const spReportId = metaMap[`report_id_sp_${tabName}`];
    const sdReportId = metaMap[`report_id_sd_${tabName}`];
    const sbReportId = metaMap[`report_id_sb_${tabName}`]; // ADDED 2026-10-08
    if (!spReportId && !sdReportId && !sbReportId) { results.push({ tab: tabName, status: 'skipped', reason: 'no reportId of any type' }); continue; }

    if (metaMap[`processed_${tabName}`] === 'true' && !force) {
      results.push({ tab: tabName, status: 'already_processed' });
      continue;
    }

    // ── Check + download each report type independently — neither
    // blocks the other. Whichever is ready gets merged in now; the other
    // merges in additively on a later run once it's ready.
    const spOutRows = await checkAndBuildRows(spReportId, tabName, 'sp', token, metaMap['ad_profile_id'], asinBrandMap, now, req.query.debug === 'true');
    const sdOutRows = await checkAndBuildRows(sdReportId, tabName, 'sd', token, metaMap['ad_profile_id'], asinBrandMap, now, req.query.debug === 'true');
    const sbOutRows = await checkAndBuildRows(sbReportId, tabName, 'sb', token, metaMap['ad_profile_id'], asinBrandMap, now, req.query.debug === 'true', campaignBrand);

    if (req.query.debug === 'true' && (spOutRows?.debug || sdOutRows?.debug || sbOutRows?.debug)) {
      return res.status(200).json({
        debug: true,
        tab: tabName,
        sp: spOutRows?.debug || null,
        sd: sdOutRows?.debug || null,
        sb: sbOutRows?.debug || null,
        note: 'Check whether SD\'s first row has a real "date" field (see file header — this was never directly confirmed) before trusting purchase_date for SD in the real write path.',
      });
    }

    const bothMissingOrFailed = (!spReportId || spOutRows === 'failed') && (!sdReportId || sdOutRows === 'failed') && (!sbReportId || sbOutRows === 'failed');
    if (bothMissingOrFailed) { results.push({ tab: tabName, status: 'failed' }); metaUpdates[`processed_${tabName}`] = 'true'; continue; }

    // CHANGED 2026-10-08 — wait until BOTH report types are finished (or
    // definitively failed) before writing. Each ASIN/day row is now the SUM
    // of SP + SD (see aggregateByAsinDate), so writing one type now and the
    // other later would overwrite the first half of that sum.
    if (spOutRows === 'pending' || sdOutRows === 'pending' || sbOutRows === 'pending') {
      const st = x => Array.isArray(x) ? 'ready' : (x || 'none');
      results.push({ tab: tabName, status: 'pending', sp: st(spOutRows), sd: st(sdOutRows), sb: st(sbOutRows) });
      continue;
    }

    const rawRowCount = [spOutRows, sdOutRows, sbOutRows].reduce((n, x) => n + (Array.isArray(x) ? x.length : 0), 0);
    const newRows = aggregateByAsinDate([
      ...(Array.isArray(spOutRows) ? spOutRows : []),
      ...(Array.isArray(sdOutRows) ? sdOutRows : []),
      ...(Array.isArray(sbOutRows) ? sbOutRows : []),
    ]);

    if (newRows.length === 0) {
      // Neither produced real rows this run (one or both still pending) —
      // don't mark processed yet, so a later run gets another chance.
      results.push({ tab: tabName, status: 'no_new_rows_yet' });
      continue;
    }

    // Upsert keyed by asin+purchase_date, NOT a full replace — a run for
    // one year's event must never wipe out a different year's rows already
    // in this tab. newRows already has exactly one row per asin+date (all
    // campaigns, SP + SD summed — see aggregateByAsinDate).
    //
    // ADDED 2026-10-08 — a re-run first removes this account's existing rows
    // inside this pull's date window, so rows written by the old collapsing
    // logic (one campaign's numbers per ASIN/day) are replaced rather than
    // left behind. The other account's rows (different brands/ASINs) and
    // other years are never touched.
    try {
      const tabToken = await ensureTab(sheets.adOrders, tabName, HEADERS);
      const existingRaw = await readRows(sheets.adOrders, tabName);
      const keyOf = r => {
        const arr = Array.isArray(r) ? r : HEADERS.map(h => r[h] ?? '');
        return `${arr[0]}||${arr[10]}`; // asin||purchase_date
      };

      const newDates   = newRows.map(r => isoDate(r[10])).filter(Boolean).sort();
      const windowFrom = newDates[0], windowTo = newDates[newDates.length - 1];
      const ownBrandIds = new Set(accountBrands.map(b => b.id));
      const newAsins    = new Set(newRows.map(r => r[0]));
      let replacedExisting = 0;

      const merged = new Map();
      (existingRaw || []).forEach(r => {
        const rowArr = Array.isArray(r) ? r : HEADERS.map(h => r[h] ?? '');
        const d = isoDate(rowArr[10]);
        const inWindow = d && windowFrom && d >= windowFrom && d <= windowTo;
        if (inWindow && (ownBrandIds.has(rowArr[1]) || newAsins.has(String(rowArr[0]).toUpperCase()))) {
          replacedExisting++;
          return;
        }
        merged.set(keyOf(rowArr), rowArr);
      });
      newRows.forEach(r => merged.set(keyOf(r), r));

      const finalRows = Array.from(merged.values());
      await replaceRows(sheets.adOrders, tabName, HEADERS, finalRows, tabToken);
      const totalPurchases = newRows.reduce((s, r) => s + (Number(r[5]) || 0), 0);
      console.log(`[sync-event-ad-orders-process] ${tabName} — ${rawRowCount} report rows → ${newRows.length} ASIN/day rows (${totalPurchases} purchases), replaced ${replacedExisting} existing, ${finalRows.length} total`);
      results.push({ tab: tabName, status: 'ok', reportRows: rawRowCount, rowsThisRun: newRows.length, purchases: totalPurchases, replacedExisting, window: windowFrom ? `${windowFrom} → ${windowTo}` : null, totalRows: finalRows.length });
      // Only mark fully processed once BOTH report types have either
      // succeeded or definitively failed — a still-pending one means
      // there's more to merge in later.
      const spDone = !spReportId || Array.isArray(spOutRows) || spOutRows === 'failed';
      const sdDone = !sdReportId || Array.isArray(sdOutRows) || sdOutRows === 'failed';
      const sbDone = !sbReportId || Array.isArray(sbOutRows) || sbOutRows === 'failed';
      if (spDone && sdDone && sbDone) metaUpdates[`processed_${tabName}`] = 'true';
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

  res.status(200).json({ account, checked: results, timestamp: now });
};

// ── Helpers ───────────────────────────────────────────────────────────────

// Checks one report's status and, if COMPLETED, downloads + normalizes it
// into row arrays matching HEADERS. Returns:
//   'pending'  — not ready yet
//   'failed'   — terminal FAILED/CANCELLED status, or no reportId at all
//   [...]      — array of row arrays, ready to merge
//   {debug: {...}} — only when debugMode is true and the report is COMPLETED
async function checkAndBuildRows(reportId, tabName, kind, token, profileId, asinBrandMap, now, debugMode, campaignBrand = () => null) {
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
      // 7-day attribution (CHANGED 2026-10-08 — matches sync-advertising-
      // process.js and the Amazon Ads console). Falls back to the 14-day
      // fields for any report requested before this change.
      const purchases    = parseInt(r.purchases7d ?? r.purchases14d ?? 0, 10) || 0;
      const adUnits       = parseInt(r.unitsSoldClicks7d ?? r.unitsSoldClicks14d ?? 0, 10) || 0;
      const sales         = round2(parseFloat(r.sales7d ?? r.sales14d ?? 0) || 0);
      const acos          = sales > 0 ? round2((spend / sales) * 100) : '';
      const purchaseDate  = r.date || r.reportDate || '';
      if (!purchaseDate) console.warn(`[sync-event-ad-orders-process] ${tabName} (sp) — row for ${asin} has no date field. Raw keys: ${Object.keys(r).join(',')}`);
      const year = purchaseDate ? parseInt(purchaseDate.slice(0, 4), 10) : '';
      return [asin, asinBrandMap[asin] || 'unknown', impressions, clicks, adUnits, purchases, spend, sales, acos, now, purchaseDate, year];
    } else if (kind === 'sb') {
      // ADDED 2026-10-08 — Sponsored Brands campaign rows. No ASIN exists at
      // this level, so the row is labeled "SB:<brand>" and summed per brand
      // per day by aggregateByAsinDate. ad_units uses purchases, same
      // convention as the daily ads cron (SB reports no separate units).
      const brandId     = campaignBrand(r.campaignName) || 'unknown';
      if (brandId === 'unknown') console.log(`[sync-event-ad-orders-process] ${tabName} (sb) unmatched campaign: "${r.campaignName}"`);
      const impressions = parseInt(r.impressions || 0, 10) || 0;
      const clicks      = parseInt(r.clicks || 0, 10) || 0;
      const spend       = round2(parseFloat(r.cost || 0) || 0);
      const purchases   = parseInt(r.purchases || 0, 10) || 0;
      const sales       = round2(parseFloat(r.sales || 0) || 0);
      const acos        = sales > 0 ? round2((spend / sales) * 100) : '';
      const purchaseDate = r.date || '';
      const year = purchaseDate ? parseInt(purchaseDate.slice(0, 4), 10) : '';
      return [`SB:${brandId}`, brandId, impressions, clicks, purchases, purchases, spend, sales, acos, now, purchaseDate, year];
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

async function buildAsinBrandMap(brandList = brands.filter(b => b.active)) {
  const map = {};
  for (const brand of brandList) {
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

// Same helper already proven in sync-fbm-returns-process.js /
// sync-returns-process.js — formats Eastern wall-clock time as an
// ISO-shaped string ending in "Z", so it displays consistently with
// every other Eastern-anchored timestamp in this project rather than
// UTC. Not a literal UTC timestamp despite the "Z" suffix — a
// deliberate, consistent convention used throughout this codebase.
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}

// ADDED 2026-10-08 — real incident: Skinuva showed 6 Prime Big Deal Days
// ad purchases here vs 99 in the Ads console. Amazon's advertised-product
// reports return one row per ASIN PER CAMPAIGN/AD GROUP per day, and rows
// were written keyed by asin+date, so each campaign's row overwrote the
// previous one and only the last campaign's numbers survived (SP and SD
// rows for the same ASIN/day overwrote each other too). This sums every
// row for an ASIN/day into one row before anything is written.
// Row layout matches HEADERS: [asin, brand, impressions, clicks, ad_units,
// purchases, spend, sales, acos, last_updated, purchase_date, year].
function aggregateByAsinDate(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r || !r[0]) continue;
    const key = `${r[0]}||${r[10]}`;
    const t = byKey.get(key);
    if (!t) { byKey.set(key, [...r]); continue; }
    for (const i of [2, 3, 4, 5]) t[i] = (Number(t[i]) || 0) + (Number(r[i]) || 0);
    for (const i of [6, 7])       t[i] = round2((Number(t[i]) || 0) + (Number(r[i]) || 0));
    if (t[1] === 'unknown' && r[1] !== 'unknown') t[1] = r[1];
  }
  for (const t of byKey.values()) t[8] = t[7] > 0 ? round2((t[6] / t[7]) * 100) : '';
  return Array.from(byKey.values());
}
