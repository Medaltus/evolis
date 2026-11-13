/**
 * api/cron/sync-fbm-listings.js
 * ADDED 2026-11-13 (per Jaclyn) — daily snapshot of our FBM (merchant-
 * fulfilled, "-SF") listings, which sync-products.js doesn't record (it
 * only reads the -SF listing for its seller-fulfilled quantity).
 *
 * For every SKU in the Products Cache (its latest day), looks up "<SKU>-SF"
 * on the same seller account and marketplace and records ONE row per -SF
 * listing per day in the "Newderm -SF product Sync" sheet (SHEET_SF_PRODUCTS,
 * default 1eAkS2Jr30ewk57mP39wA9h6Z862pE1zlE9znTXsZi34), tab "<brand tab> fbm":
 *   date, fbm_sku, fba_sku, asin, status (BUYABLE / DISCOVERABLE), issues
 *   (same format as sync-products, incl. {LISTING_SUPPRESSED} etc. tags),
 *   fbm_quantity, price, title, item_highlights, bullet_1..5, description,
 *   backend_keywords, synced_at
 * Contributions are the -SF SKU's OWN (no catalog fallback), so a blank
 * field means the FBM listing itself doesn't supply it.
 *
 * Buy Box ownership (our FBA vs our FBM offer) comes from
 * sync-product-offers.js, which writes the "<brand tab> offers" tabs.
 *
 * Resumes across runs (4 passes, 8:03–8:48 AM Eastern): SKUs that already
 * have a row for today are skipped; SKUs with no -SF listing are remembered
 * for the day in this sheet's _meta tab so they aren't looked up again.
 * Re-running a day replaces that day's rows (no duplicates); rows older than
 * 90 days are removed.
 *
 * Manual:
 *   GET /api/cron/sync-fbm-listings                       normal run
 *   GET /api/cron/sync-fbm-listings?brand=skinuva         one brand only
 *   GET /api/cron/sync-fbm-listings?force=true            redo today from scratch
 *   GET /api/cron/sync-fbm-listings?sku=SVA0001-SF        test one SKU: writes nothing, returns Amazon's answer
 *                                                         (&account=hol for High On Love, &marketplace=<id>)
 */

const { spRequest, getSellerId } = require('../_spauth');
const { getSheetsToken } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { sendCronFailureAlert } = require('../_alerts');
const { accountForBrand } = require('../_account');
const { isoDate } = require('../_dates');

const SF_SHEET = process.env.SHEET_SF_PRODUCTS || '1eAkS2Jr30ewk57mP39wA9h6Z862pE1zlE9znTXsZi34';
const TAB_SUFFIX = ' fbm';
const HEADERS = ['date', 'fbm_sku', 'fba_sku', 'asin', 'status', 'issues', 'fbm_quantity', 'price', 'title', 'item_highlights',
  'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5', 'description', 'backend_keywords', 'synced_at'];
const META_TAB = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];
const KEEP_DAYS = 90;
const CALL_GAP_MS = 250;        // Listings API: 5 requests/sec; stay under it
const TIME_BUDGET_MS = 240_000; // stop starting new lookups after 4 minutes
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const started = Date.now();
  const usMarket = process.env.SP_MARKETPLACE_ID;

  // ── Test mode: one -SF SKU, nothing written ───────────────────────────────
  if (req.query.sku) {
    const sku = String(req.query.sku).trim();
    const account = req.query.account === 'hol' ? 'hol' : 'newderm';
    const market = String(req.query.marketplace || usMarket);
    try {
      const listing = await fetchListing(sku, account, market);
      return res.status(200).json({ testMode: true, sku, account, marketplace: market, row: buildRow(listing, sku, '', '', 'TODAY', 'NOW'), raw: listing });
    } catch (err) {
      return res.status(200).json({ testMode: true, sku, account, marketplace: market, notFound: isNotFound(err), error: err.message });
    }
  }

  const onlyBrand = (req.query.brand || '').trim() || null;
  const force = req.query.force === 'true';
  const activeBrands = brands.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));
  if (onlyBrand && !activeBrands.length) return res.status(400).json({ error: `No active brand "${onlyBrand}"` });

  const today = easternDate(new Date());
  const nowEt = easternIso(new Date());
  const errors = [];

  try {
    const tokP = await getSheetsToken(sheets.products);
    const tokW = await getSheetsToken('writer');

    // ── 1. Our SKUs: each brand's latest day in the Products Cache ─────────
    const pMeta = await sheetsApi(tokP, 'GET', `/${sheets.products}?fields=sheets.properties(title)`);
    const pTabs = new Set((pMeta.sheets || []).map(s => s.properties.title));
    const present = activeBrands.filter(b => pTabs.has(b.tabName));
    const heads = {};
    if (present.length) {
      const hb = await sheetsApi(tokP, 'GET', `/${sheets.products}/values:batchGet?${present.map(b => `ranges=${rng(b.tabName, 'A1:ZZ1')}`).join('&')}`);
      (hb.valueRanges || []).forEach((vr, i) => { heads[present[i].tabName] = ((vr.values || [])[0] || []).map(h => String(h).trim()); });
    }
    const candidates = []; // { brand, account, market, fbaSku, fbmSku, asin }
    for (const brand of present) {
      const h = heads[brand.tabName] || [];
      const cD = h.indexOf('date'), cS = h.indexOf('sku'), cA = h.indexOf('asin');
      if (cD < 0 || cS < 0 || cA < 0) continue;
      const got = await sheetsApi(tokP, 'GET', `/${sheets.products}/values:batchGet?majorDimension=COLUMNS&${
        [cD, cS, cA].map(c => `ranges=${rng(brand.tabName, `${colLetter(c)}2:${colLetter(c)}`)}`).join('&')}`);
      const [dates = [], skus = [], asins = []] = (got.valueRanges || []).map(vr => (vr.values || [])[0] || []);
      const isoDates = dates.map(d => isoDate(d));
      const latest = isoDates.filter(Boolean).sort().pop();
      if (!latest) continue;
      const seen = new Set();
      isoDates.forEach((d, i) => {
        if (d !== latest) return;
        const fbaSku = String(skus[i] || '').replace(/^'/, '').trim();
        if (!fbaSku || /-SF$/i.test(fbaSku) || seen.has(fbaSku)) return;
        seen.add(fbaSku);
        candidates.push({ brand, account: accountForBrand(brand), market: brand.marketplaceId || usMarket,
          fbaSku, fbmSku: `${fbaSku}-SF`, asin: String(asins[i] || '').trim().toUpperCase() });
      });
      await sleep(300);
    }

    // ── 2. What's already done today ───────────────────────────────────────
    const sMeta = await sheetsApi(tokW, 'GET', `/${SF_SHEET}?fields=sheets.properties(sheetId,title)`);
    const ids = Object.fromEntries((sMeta.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
    const tabsNeeded = [...new Set(candidates.map(c => c.brand.tabName + TAB_SUFFIX))];
    const existingTabs = tabsNeeded.filter(t => ids[t] != null);
    const tabRows = {}; // tab -> [[date, fbm_sku], ...] (data rows, in sheet order)
    if (existingTabs.length) {
      const got = await sheetsApi(tokW, 'GET', `/${SF_SHEET}/values:batchGet?majorDimension=COLUMNS&${existingTabs.map(t => `ranges=${rng(t, 'A2:B')}`).join('&')}`);
      (got.valueRanges || []).forEach((vr, k) => {
        const [dates = [], skus = []] = vr.values || [];
        tabRows[existingTabs[k]] = dates.map((d, i) => [isoDate(d), String(skus[i] || '').trim().toUpperCase()]);
      });
    }
    let meta = {};
    if (ids[META_TAB] != null) {
      const m = await sheetsApi(tokW, 'GET', `/${SF_SHEET}/values/${rng(META_TAB, 'A2:C')}`);
      (m.values || []).forEach(r => { if (r[0]) meta[r[0]] = { value: r[1] || '', updated: r[2] || '' }; });
    }
    const missingKey = `no_sf_listing ${today}`;
    const noListing = new Set(force ? [] : JSON.parse(meta[missingKey]?.value || '[]'));
    const doneToday = new Set();
    if (!force) for (const rows of Object.values(tabRows)) rows.forEach(([d, s]) => { if (d === today) doneToday.add(s); });

    // ── 3. Look up the -SF listings still to do ────────────────────────────
    const todo = candidates.filter(c => !doneToday.has(c.fbmSku.toUpperCase()) && !noListing.has(c.fbmSku.toUpperCase()));
    const newRows = new Map(); // tab -> rows
    let lookups = 0, stoppedEarly = false;
    for (const c of todo) {
      if (Date.now() - started > TIME_BUDGET_MS) { stoppedEarly = true; break; }
      if (lookups++ > 0) await sleep(CALL_GAP_MS);
      try {
        const listing = await fetchListing(c.fbmSku, c.account, c.market);
        const tab = c.brand.tabName + TAB_SUFFIX;
        if (!newRows.has(tab)) newRows.set(tab, []);
        newRows.get(tab).push(buildRow(listing, c.fbmSku, c.fbaSku, c.asin, today, nowEt));
      } catch (err) {
        if (isNotFound(err)) noListing.add(c.fbmSku.toUpperCase());
        else errors.push(`${c.fbmSku} (${c.brand.id}): ${err.message}`);
      }
    }

    // ── 4. Write ───────────────────────────────────────────────────────────
    const toCreate = [...newRows.keys()].filter(t => ids[t] == null);
    if (ids[META_TAB] == null) toCreate.push(META_TAB);
    if (toCreate.length) {
      const r = await sheetsApi(tokW, 'POST', `/${SF_SHEET}:batchUpdate`, { requests: toCreate.map(title => ({
        addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: title === META_TAB ? 3 : HEADERS.length, frozenRowCount: 1 } } } })) });
      (r.replies || []).forEach((rep, i) => { ids[toCreate[i]] = rep.addSheet?.properties?.sheetId; });
      await sheetsApi(tokW, 'POST', `/${SF_SHEET}/values:batchUpdate`, { valueInputOption: 'RAW',
        data: toCreate.map(t => ({ range: `${quoteTab(t)}!A1`, values: [t === META_TAB ? META_HEADERS : HEADERS] })) });
    }

    // Remove: today's rows being replaced (all of today's on force), and rows past the keep window.
    const cutoff = addDays(today, -KEEP_DAYS);
    const deletes = [];
    let rowsRemoved = 0;
    for (const [tab, rows] of Object.entries(tabRows)) {
      const writing = new Set((newRows.get(tab) || []).map(r => String(r[1]).toUpperCase()));
      const drop = [];
      rows.forEach(([d, s], i) => {
        if ((d === today && (force || writing.has(s))) || (d && d < cutoff)) drop.push(i + 1);
      });
      rowsRemoved += drop.length;
      const ranges = [];
      for (const r of drop) { const last = ranges[ranges.length - 1]; if (last && r === last[1]) last[1]++; else ranges.push([r, r + 1]); }
      ranges.reverse().forEach(([a, b]) => deletes.push({ deleteDimension: { range: { sheetId: ids[tab], dimension: 'ROWS', startIndex: a, endIndex: b } } }));
    }
    if (deletes.length) await sheetsApi(tokW, 'POST', `/${SF_SHEET}:batchUpdate`, { requests: deletes });

    let rowsAdded = 0;
    for (const [tab, rows] of newRows) {
      await sheetsApi(tokW, 'POST', `/${SF_SHEET}/values/${rng(tab, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
      rowsAdded += rows.length;
      await sleep(300);
    }

    // Remember today's SKUs with no -SF listing; keep only the last 7 days of these notes.
    meta[missingKey] = { value: JSON.stringify([...noListing].sort()), updated: nowEt };
    const metaRows = Object.entries(meta)
      .filter(([k]) => !k.startsWith('no_sf_listing ') || k.slice(14) >= addDays(today, -7))
      .map(([k, v]) => [k, v.value, v.updated]);
    await sheetsApi(tokW, 'POST', `/${SF_SHEET}/values/${rng(META_TAB, 'A2:C')}:clear`, {});
    if (metaRows.length) await sheetsApi(tokW, 'PUT', `/${SF_SHEET}/values/${rng(META_TAB, 'A2')}?valueInputOption=RAW`, { values: metaRows });

    const remaining = todo.length - lookups + (stoppedEarly ? 1 : 0);
    if (errors.length) await sendCronFailureAlert('sync-fbm-listings', errors.slice(0, 15).join('\n'), { 'SKUs left for later runs': String(Math.max(0, remaining)) });
    return res.status(200).json({
      date: today, skusChecked: candidates.length, alreadyDoneToday: doneToday.size, lookedUp: lookups,
      fbmListingsWritten: rowsAdded, noSfListing: noListing.size, rowsRemoved, stoppedEarly,
      complete: !stoppedEarly && Math.max(0, remaining) === 0, errors: errors.length,
    });
  } catch (err) {
    await sendCronFailureAlert('sync-fbm-listings', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Amazon ─────────────────────────────────────────────────────────────────
function fetchListing(sku, account, marketplaceId) {
  return spRequest('GET', `/listings/2021-08-01/items/${getSellerId(account)}/${encodeURIComponent(sku)}`,
    { marketplaceIds: marketplaceId, includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability' }, null, account);
}
const isNotFound = err => /\b404\b|NOT_FOUND|not found/i.test(String(err?.message || err));

// Same field choices as sync-products.js, but the -SF listing's OWN values only.
function buildRow(listing, fbmSku, fbaSku, asin, date, nowEt) {
  const a = listing?.attributes || {};
  const val = (k, i = 0) => a[k]?.[i]?.value || '';
  const avail = (a.fulfillment_availability || []).find(f => f.fulfillment_channel_code === 'DEFAULT')
    || (listing?.fulfillmentAvailability || []).find(f => f.fulfillmentChannelCode === 'DEFAULT');
  const b2c = (listing?.offers || []).find(o => o.offerType === 'B2C');
  const issues = (listing?.issues || []).map(iss => {
    const tags = [...((iss.enforcements?.actions || []).map(x => x.action).filter(Boolean)), ...((iss.categories || []).filter(Boolean))];
    return `[${iss.severity}] ${(iss.attributeNames || []).join(',')}: ${iss.message}${tags.length ? ` {${[...new Set(tags)].join('; ')}}` : ''}`;
  }).join(' | ');
  return [
    date, fbmSku, fbaSku, asin,
    (listing?.summaries?.[0]?.status || []).join(', '),
    issues,
    avail?.quantity ?? '',
    b2c?.price?.amount ?? '',
    listing?.summaries?.[0]?.itemName || val('item_name'),
    val('title_differentiation'),
    val('bullet_point', 0), val('bullet_point', 1), val('bullet_point', 2), val('bullet_point', 3), val('bullet_point', 4),
    val('product_description'),
    val('generic_keyword'),
    nowEt,
  ];
}

// ── Sheets ─────────────────────────────────────────────────────────────────
const RETRY_WAITS_MS = [2000, 4000, 8000, 16000, 20000, 30000];
async function sheetsApi(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SHEETS_API}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || (res.status >= 500 && attempt < 4);
    if (retryable && attempt < RETRY_WAITS_MS.length) { await sleep(RETRY_WAITS_MS[attempt] + Math.floor(Math.random() * 1500)); continue; }
    throw new Error(`Sheets ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
}
const quoteTab = t => `'${String(t).replace(/'/g, "''")}'`;
const rng = (tab, a1) => encodeURIComponent(`${quoteTab(tab)}!${a1}`);
function colLetter(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

// ── Dates (Eastern, same as sync-products) ─────────────────────────────────
function easternParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date).map(x => [x.type, x.value]));
  if (p.hour === '24') p.hour = '00';
  return p;
}
function easternDate(d) { const p = easternParts(d); return `${p.year}-${p.month}-${p.day}`; }
function easternIso(d) { const p = easternParts(d); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`; }
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
