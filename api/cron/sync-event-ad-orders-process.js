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
 * Full REPLACE per tab, not an upsert — each event tab is a fixed
 * historical snapshot of "what did ad performance look like during this
 * event," re-generated cleanly each run, same model as
 * sync-event-orders-process.js uses for the organic/combined orders side.
 *
 * Manual:
 *   GET /api/cron/sync-event-ad-orders-process
 *   GET /api/cron/sync-event-ad-orders-process?force=true
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

const HEADERS = ['asin', 'brand', 'impressions', 'clicks', 'ad_units', 'purchases', 'spend', 'sales', 'acos', 'last_updated', 'purchase_date'];

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
    const reportId = metaMap[`report_id_${tabName}`];
    if (!reportId) { results.push({ tab: tabName, status: 'skipped', reason: 'no reportId' }); continue; }

    if (metaMap[`processed_${tabName}`] === 'true' && !force) {
      results.push({ tab: tabName, status: 'already_processed' });
      continue;
    }

    let statusResp;
    try {
      statusResp = await adRequest('GET', `/reporting/reports/${reportId}`, token, metaMap['ad_profile_id']);
    } catch (err) {
      results.push({ tab: tabName, status: 'check_failed', error: err.message });
      continue;
    }

    const status = statusResp.status;
    console.log(`[sync-event-ad-orders-process] ${tabName} (${reportId}): ${status}`);

    if (status === 'COMPLETED') {
      let rows;
      try {
        rows = await downloadAdReport(statusResp.url);
      } catch (err) {
        results.push({ tab: tabName, status: 'download_failed', error: err.message });
        continue;
      }

      if (req.query.debug === 'true') {
        return res.status(200).json({
          debug: true,
          tab: tabName,
          rowCount: rows.length,
          firstRow: rows[0] || null,
          note: 'Check whether the per-row date field is actually named "date" before trusting purchase_date in the real write path.',
        });
      }

      const outRows = rows.map(r => {
        const asin       = (r.advertisedAsin || '').toUpperCase();
        const impressions = parseInt(r.impressions || 0, 10) || 0;
        const clicks       = parseInt(r.clicks || 0, 10) || 0;
        const spend        = round2(parseFloat(r.spend || 0) || 0);
        const purchases    = parseInt(r.purchases14d || 0, 10) || 0;
        const adUnits       = parseInt(r.unitsSoldClicks14d || 0, 10) || 0;
        const sales         = round2(parseFloat(r.sales14d || 0) || 0);
        const acos          = sales > 0 ? round2((spend / sales) * 100) : '';
        const purchaseDate  = r.date || ''; // present now that request.js uses timeUnit=DAILY
        return [asin, asinBrandMap[asin] || 'unknown', impressions, clicks, adUnits, purchases, spend, sales, acos, now, purchaseDate];
      });

      try {
        const tabToken = await ensureTab(sheets.adOrders, tabName, HEADERS);
        await replaceRows(sheets.adOrders, tabName, HEADERS, outRows, tabToken);
        console.log(`[sync-event-ad-orders-process] ${tabName} — wrote ${outRows.length} rows`);
        results.push({ tab: tabName, status: 'ok', rows: outRows.length });
        metaUpdates[`processed_${tabName}`] = 'true';
      } catch (err) {
        results.push({ tab: tabName, status: 'write_failed', error: err.message });
      }

    } else if (status === 'FAILED' || status === 'CANCELLED') {
      console.warn(`[sync-event-ad-orders-process] ${tabName} terminal status: ${status}`);
      metaUpdates[`processed_${tabName}`] = 'true';
      results.push({ tab: tabName, status: status.toLowerCase() });
    } else {
      results.push({ tab: tabName, status: 'pending' });
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
