/**
 * api/upload-walmart-ads.js
 * POST /api/upload-walmart-ads
 *
 * Ingests TWO Helium 10 Walmart Ads exports (search_item level + search_term
 * level, both pulled via H10's Data Query MCP tools — confirmed live
 * 2026-08-05 against profile 224591, the one shared Walmart Ads profile
 * covering every brand) and writes to THREE sheets:
 *
 *   1. SHEET_WALMART_AD_ORDERS      — one row per item per month (from the
 *      search_item export directly)
 *   2. SHEET_WALMART_ADVERTISING    — one row per brand per month — NOT
 *      pulled from H10 separately. DERIVED here by summing the Ad Orders
 *      rows per brand+month. Reason: H10's plain "campaign" level for
 *      Walmart has NO item_id field at all (confirmed via
 *      get_ads_query_schema, 2026-08-05) — with one shared profile across
 *      every brand, campaign-level data has no reliable way to resolve
 *      brand except parsing brand name out of free-text campaign names,
 *      which is fragile. item_id (confirmed present on search_item) joins
 *      cleanly against column I of the Product Short Name sheet instead,
 *      so deriving the monthly aggregate from already-brand-resolved
 *      item-level rows avoids that fragility entirely.
 *   3. SHEET_WALMART_SEARCH_TERMS   — one row per search term per month
 *      (from the search_term export directly)
 *
 * BRAND RESOLUTION: every row in both source exports carries item_id (the
 * Walmart Item ID) but no brand field. Brand is resolved by matching
 * item_id against column I of the master Product Short Name sheet — same
 * source and same convention already established in
 * sync-walmart-inventory.js. Reuses that file's quoted-CSV-aware line
 * parser (parseCsvLine) rather than a naive split — that exact naive-split
 * bug (comma inside a product description shifting every later column)
 * is what silently broke column I resolution there before it was fixed
 * 2026-08-04; reusing the same fix here rather than reintroducing it.
 *
 * Body: { adOrdersFilename, adOrdersContentBase64, searchTermsFilename, searchTermsContentBase64 }
 *   Both files uploaded together, in one request, so the derived
 *   Advertising Cache is always computed from a consistent snapshot of
 *   Ad Orders rather than from a possibly-stale earlier upload.
 *
 * Auth: Bearer CRON_SECRET required (same convention as
 * upload-keyword-tracker.js / upload-amazon-reviews.js).
 */

const XLSX = require('xlsx');
const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const brands = require('./config/brands');

const SHEET_AD_ORDERS    = process.env.SHEET_WALMART_AD_ORDERS;
const SHEET_ADVERTISING  = process.env.SHEET_WALMART_ADVERTISING;
const SHEET_SEARCH_TERMS = process.env.SHEET_WALMART_SEARCH_TERMS;

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand, ... I=walmart_item_id

const AD_ORDERS_HEADERS    = ['year', 'month', 'item_id', 'item_name', 'ad_units', 'spend', 'sales', 'acos', 'brand', 'last_updated', 'date'];
const ADVERTISING_HEADERS  = ['year', 'month', 'impressions', 'clicks', 'spend', 'sales', 'acos', 'roas', 'ad_units', 'ctr', 'cpc', 'brand', 'last_updated'];
const SEARCH_TERMS_HEADERS = ['search_term', 'keyword', 'match_type', 'campaign_name', 'ad_group_name', 'date', 'year', 'month', 'impressions', 'clicks', 'ctr', 'cost', 'cpc', 'cpm', 'purchases', 'sales', 'acos', 'conversion_rate', 'brand', 'last_updated'];
// NOTE: no cpm/current_bid confirmed available directly from H10's Walmart
// search_term measures (confirmed via get_ads_query_schema, 2026-08-05) —
// cpm is computed here (spend ÷ impressions × 1000); current_bid is
// omitted entirely (it lives on the keyword/target dimension table, not
// the performance fact table H10 exposes — would need a separate join
// H10 doesn't appear to offer through this query surface).

// ── Quoted-CSV-aware line parser — REUSED verbatim from the fix applied to
// sync-walmart-inventory.js 2026-08-04. See that file for the original
// incident: a naive line.split(',') silently shifts every column after
// any field containing a comma inside quotes (e.g. a product description),
// which broke column I (Walmart Item ID) resolution for affected rows.
function parseCsvLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current);
  return cols.map(c => c.trim());
}

// Builds item_id -> { brandTabName, brandId } from the master Product
// Short Name sheet's column I. Only includes SKUs with a non-blank
// Walmart Item ID — same "not sold on Walmart, skip entirely" scoping
// already used in sync-walmart-inventory.js.
async function buildItemIdToBrandMap() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master SKU list: ${resp.status}`);
  const csv = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  const map = {};
  for (const line of lines) {
    const cols = parseCsvLine(line);
    const rawBrand = (cols[3] || '').trim();
    const walmartItemId = (cols[8] || '').trim();
    if (!walmartItemId) continue;

    const brandNorm = stripAccents(rawBrand.toLowerCase());
    const matched = brands.find(b =>
      b.active && (
        brandNorm === stripAccents(b.id.toLowerCase()) ||
        brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
        brandNorm.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (matched) map[walmartItemId] = { brandTabName: matched.tabName, brandId: matched.id };
  }
  return map;
}

function stripAccents(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// FIXED 2026-08-06 — real incident: the schema I confirmed live listed
// "year"/"month_of_year" as available dimension fields, but Cowork's
// ACTUAL execute_ads_query export (WalmartAdsItems_2026-08-06.xlsx /
// WalmartAdsSearchTerms_2026-08-06.xlsx) contains neither — only a single
// "date" field per row (e.g. "2026-08-01T00:00:00", the first day of the
// requested month bucket), confirmed by reading the real files directly.
// Every row's derived year/month came back blank, which collapsed BOTH
// July and August into one "undefined-undefined" bucket in the
// Advertising Cache derivation. This parses year/month from that real
// date field instead of assuming fields that don't actually appear.
function extractYearMonth(dateVal) {
  if (!dateVal) return { year: '', month: '' };
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return { year: '', month: '' };
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// FIXED 2026-08-06 — real incident: item_id was confirmed BLANK on every
// one of 107 real search_term rows in the same export (not intermittent —
// zero exceptions). Walmart keyword-targeted campaigns often don't map to
// a single item, so item-level brand resolution genuinely doesn't work
// for this level despite being theoretically available per the schema.
// Falls back to parsing the brand out of campaign_name instead — all 3
// real campaign names in this account's export cleanly start with
// "Skinuva - ...", confirming this actually works in practice, not just
// in theory.
function resolveBrandFromCampaignName(campaignName) {
  const firstToken = String(campaignName || '').split(/[\s-]+/)[0];
  if (!firstToken) return null;
  const norm = stripAccents(firstToken.toLowerCase());
  return brands.find(b =>
    b.active && (
      norm === stripAccents(b.id.toLowerCase()) ||
      norm === stripAccents((b.displayName || '').toLowerCase())
    )
  ) || null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SHEET_AD_ORDERS || !SHEET_ADVERTISING || !SHEET_SEARCH_TERMS) {
    return res.status(500).json({ error: 'SHEET_WALMART_AD_ORDERS / SHEET_WALMART_ADVERTISING / SHEET_WALMART_SEARCH_TERMS env vars not fully set' });
  }

  const { adOrdersFilename, adOrdersContentBase64, searchTermsFilename, searchTermsContentBase64 } = req.body || {};
  if (!adOrdersContentBase64) return res.status(400).json({ error: 'Missing adOrdersContentBase64' });
  if (!searchTermsContentBase64) return res.status(400).json({ error: 'Missing searchTermsContentBase64' });

  function parseWorkbook(base64, label) {
    const buffer = Buffer.from(base64, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    console.log(`[upload-walmart-ads] ${label} — sheet "${sheetName}", ${rows.length} rows`);
    return rows;
  }

  let adOrderRows, searchTermRows, itemIdToBrand;
  try {
    adOrderRows   = parseWorkbook(adOrdersContentBase64, adOrdersFilename || 'ad orders file');
    searchTermRows = parseWorkbook(searchTermsContentBase64, searchTermsFilename || 'search terms file');
  } catch (err) {
    console.error('[upload-walmart-ads] failed to parse a workbook:', err.message);
    return res.status(400).json({ error: 'Could not parse one of the uploaded files as xlsx', detail: err.message });
  }

  try {
    itemIdToBrand = await buildItemIdToBrandMap();
  } catch (err) {
    console.error('[upload-walmart-ads] failed to build item_id->brand map:', err.message);
    return res.status(500).json({ error: 'Failed to read master SKU list for brand resolution', detail: err.message });
  }

  const nowIso = new Date().toISOString();
  const unmatchedItemIds = new Set();

  // ── 1. Ad Orders — one row per item per month, brand-resolved ───────────
  const adOrdersByBrand = {};
  adOrderRows.forEach(r => {
    const itemId = String(r.item_id || r['item_id'] || '').trim();
    const brandInfo = itemIdToBrand[itemId];
    if (!brandInfo) { if (itemId) unmatchedItemIds.add(itemId); return; }

    // Added 2026-08-06 per Jaclyn: skip items with NO ad spend at all —
    // if no ads were served, none of the other measures (impressions,
    // clicks, sales, acos) mean anything for reporting either. Keeps this
    // sheet limited to products that actually had ad activity, rather
    // than every item in the catalog regardless of whether it ran ads.
    const spend = parseFloat(r.spend) || 0;
    if (spend <= 0) return;

    const { year, month } = extractYearMonth(r.date);
    if (!year) return; // no parseable date — confirmed 2026-08-06 these are zero-activity items, not worth a stray blank-month row
    const row = {
      year,
      month,
      item_id: itemId,
      item_name: r.item_name || '',
      ad_units: r.sale_units ?? r.ad_units ?? 0,
      spend,
      sales: r.sales ?? 0,
      acos: r.acos ?? '',
      brand: brandInfo.brandId,
      last_updated: nowIso,
      date: nowIso.slice(0, 10),
    };
    (adOrdersByBrand[brandInfo.brandTabName] = adOrdersByBrand[brandInfo.brandTabName] || []).push(row);
  });

  // ── 2. Advertising Cache — DERIVED by summing Ad Orders per brand+month ──
  const advertisingByBrand = {};
  Object.entries(adOrdersByBrand).forEach(([tabName, rows]) => {
    const monthMap = {};
    rows.forEach(r => {
      const key = `${r.year}-${r.month}`;
      if (!monthMap[key]) monthMap[key] = { year: r.year, month: r.month, spend: 0, sales: 0, ad_units: 0, impressions: 0, clicks: 0 };
      monthMap[key].spend += parseFloat(r.spend) || 0;
      monthMap[key].sales += parseFloat(r.sales) || 0;
      monthMap[key].ad_units += parseInt(r.ad_units, 10) || 0;
    });
    // impressions/clicks come from the SAME source rows in adOrderRows
    // (search_item measures include them) — re-derive per brand+month
    // from the raw rows rather than the already-narrowed `rows` above,
    // since impressions/clicks weren't carried into the Ad Orders sheet
    // shape itself (that sheet mirrors Amazon's Ad Orders columns, which
    // don't include them either). Same spend>0 filter applied here as
    // above — without it, a zero-spend item sharing a month with a real
    // spend>0 item would still leak its impressions/clicks into that
    // month's total, even though it was excluded from the Ad Orders sheet.
    adOrderRows.forEach(r => {
      const itemId = String(r.item_id || '').trim();
      const brandInfo = itemIdToBrand[itemId];
      if (!brandInfo || brandInfo.brandTabName !== tabName) return;
      if ((parseFloat(r.spend) || 0) <= 0) return;
      const { year, month } = extractYearMonth(r.date);
      const key = `${year}-${month}`;
      if (!monthMap[key]) return;
      monthMap[key].impressions += parseInt(r.impressions, 10) || 0;
      monthMap[key].clicks += parseInt(r.clicks, 10) || 0;
    });

    advertisingByBrand[tabName] = Object.values(monthMap).map(m => ({
      year: m.year,
      month: m.month,
      impressions: m.impressions,
      clicks: m.clicks,
      spend: Math.round(m.spend * 100) / 100,
      sales: Math.round(m.sales * 100) / 100,
      acos: m.sales > 0 ? Math.round((m.spend / m.sales) * 10000) / 100 : '',
      roas: m.spend > 0 ? Math.round((m.sales / m.spend) * 100) / 100 : '',
      ad_units: m.ad_units,
      ctr: m.impressions > 0 ? Math.round((m.clicks / m.impressions) * 10000) / 100 : '',
      cpc: m.clicks > 0 ? Math.round((m.spend / m.clicks) * 100) / 100 : '',
      brand: brands.find(b => b.tabName === tabName)?.id || tabName,
      last_updated: nowIso,
    }));
  });

  // ── 3. Search Terms — one row per term per month, brand-resolved ────────
  // Brand resolution here tries item_id FIRST (kept in case a future
  // export ever does carry it — costs nothing), then falls back to
  // parsing the brand out of campaign_name. Confirmed 2026-08-06 that
  // item_id is blank on 100% of real search_term rows for this account,
  // so the campaign-name fallback is what actually resolves brand in
  // practice today, not item_id.
  const searchTermsByBrand = {};
  let searchTermsResolvedViaCampaignName = 0;
  searchTermRows.forEach(r => {
    const itemId = String(r.item_id || '').trim();
    let brandInfo = itemId ? itemIdToBrand[itemId] : null;

    const campaignName = r['campaign.campaign_name'] || r.campaign_name || '';
    if (!brandInfo) {
      const matched = resolveBrandFromCampaignName(campaignName);
      if (matched) { brandInfo = { brandTabName: matched.tabName, brandId: matched.id }; searchTermsResolvedViaCampaignName++; }
    }
    if (!brandInfo) {
      if (itemId) unmatchedItemIds.add(itemId);
      else console.warn(`[upload-walmart-ads] search term row skipped — no item_id AND no brand match from campaign_name "${campaignName}"`);
      return;
    }

    const impressions = parseInt(r.impressions, 10) || 0;
    const spend = parseFloat(r.spend) || 0;
    // Extended 2026-08-06 from the same request for Ad Orders — same
    // reasoning applies here: a search term with $0 spend means no ad
    // was actually served on it, so nothing else on the row (clicks,
    // sales, acos) is meaningful for reporting either. If this should
    // behave differently from Ad Orders (e.g. keeping $0-spend terms
    // that still show organic-adjacent impressions), this is the one
    // line to remove.
    if (spend <= 0) return;
    const { year, month } = extractYearMonth(r.date);
    if (!year) return; // no parseable date — same defensive guard as Ad Orders, though current real data always has one here
    const row = {
      search_term: r.query || '',
      keyword: r.keyword_text || '',
      match_type: r.match_type || '',
      campaign_name: campaignName,
      ad_group_name: r['adgroup.adgroup_name'] || r.ad_group_name || r.adgroup_name || '',
      date: nowIso.slice(0, 10),
      year,
      month,
      impressions,
      clicks: r.clicks ?? 0,
      ctr: r.ctr ?? '',
      cost: spend,
      cpc: r.cpc ?? '',
      cpm: impressions > 0 ? Math.round((spend / impressions) * 100000) / 100 : '', // computed — see header note
      purchases: r.orders ?? 0,
      sales: r.sales ?? 0,
      acos: r.acos ?? '',
      conversion_rate: r.cvr ?? '',
      brand: brandInfo.brandId,
      last_updated: nowIso,
    };
    (searchTermsByBrand[brandInfo.brandTabName] = searchTermsByBrand[brandInfo.brandTabName] || []).push(row);
  });

  // ── Write all 3 sheets ────────────────────────────────────────────────
  async function writeSheet(sheetId, headers, rowsByBrand, label) {
    const results = [];
    for (const [tabName, rows] of Object.entries(rowsByBrand)) {
      try {
        const token = await ensureTab(sheetId, tabName, headers);
        const existing = await readRows(sheetId, tabName);
        // FIXED 2026-08-14 — real incident: 'date' was left IN the key
        // despite the comment saying "everything but last_updated." Both
        // AD_ORDERS_HEADERS and SEARCH_TERMS_HEADERS include a 'date'
        // column, but it's set to the day the cron RAN
        // (nowIso.slice(0,10)), not a stable identifier — same kind of
        // sync-timestamp metadata as last_updated. Since that value
        // differs on every run, every re-run generated a brand-new key
        // for the same year+month+item (or +search_term), producing an
        // exact duplicate row instead of overwriting the existing one.
        // Confirmed directly: the Walmart Ads Orders Cache sheet had two
        // full copies of every July/August row, one dated 2026-08-06 and
        // one dated 2026-08-10. Excluding 'date' from the key (same as
        // 'last_updated') fixes this for both affected sheets.
        // ADVERTISING_HEADERS has no 'date' column at all, so it was
        // never affected by this specific bug.
        const keyOf = r => headers.filter(h => h !== 'last_updated' && h !== 'date').map(h => r[h]).join('||');
        const merged = new Map();
        (existing || []).forEach(r => merged.set(keyOf(r), r));
        rows.forEach(r => merged.set(keyOf(r), r));

        // Added 2026-08-06 per Jaclyn: sort by year ascending, then month
        // ascending, so the most recent month always sits at the bottom
        // — matches the same convention sync-walmart-revenue.js/
        // sync-shopify-revenue.js already use for their own sheets.
        // Applied here in the shared writeSheet function rather than per
        // sheet, since all 3 of Ad Orders/Advertising Cache/Search Terms
        // carry year+month columns. Numeric sort (not string) so e.g.
        // month "10" doesn't sort before month "2".
        const sortedRows = Array.from(merged.values()).sort((a, b) => {
          const ay = parseInt(a.year, 10) || 0, by = parseInt(b.year, 10) || 0;
          if (ay !== by) return ay - by;
          const am = parseInt(a.month, 10) || 0, bm = parseInt(b.month, 10) || 0;
          return am - bm;
        });

        const outRows = sortedRows.map(r => headers.map(h => r[h] ?? ''));
        await replaceRows(sheetId, tabName, headers, outRows, token);
        results.push({ brand: tabName, status: 'ok', incomingRows: rows.length, totalRows: outRows.length });
      } catch (err) {
        console.error(`[upload-walmart-ads] ${label} ${tabName} failed:`, err.message);
        results.push({ brand: tabName, status: 'error', error: err.message });
      }
    }
    return results;
  }

  const adOrdersResults   = await writeSheet(SHEET_AD_ORDERS, AD_ORDERS_HEADERS, adOrdersByBrand, 'ad-orders');
  const advertisingResults = await writeSheet(SHEET_ADVERTISING, ADVERTISING_HEADERS, advertisingByBrand, 'advertising');
  const searchTermsResults = await writeSheet(SHEET_SEARCH_TERMS, SEARCH_TERMS_HEADERS, searchTermsByBrand, 'search-terms');

  res.status(200).json({
    ok: true,
    adOrders: adOrdersResults,
    advertising: advertisingResults,
    searchTerms: searchTermsResults,
    searchTermsResolvedViaCampaignName,
    ...(unmatchedItemIds.size ? { unmatchedItemIds: Array.from(unmatchedItemIds) } : {}),
  });
};
