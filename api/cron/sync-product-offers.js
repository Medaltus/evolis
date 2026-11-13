/**
 * api/cron/sync-product-offers.js
 * ADDED 2026-10-20 — fills other-seller ("alternate seller") data into the
 * Products Cache sheet, on the same per-SKU daily rows sync-products.js
 * writes, in this cron's OWN columns after qty_on_hand (see
 * config/product-offer-columns.js):
 *   alt_seller_count, alt_sellers, alt_seller_links, buybox_owner,
 *   lowest_alt_price, offers_synced_at
 *
 * Kept separate from sync-products.js on purpose (that cron already handles
 * hundreds of SKUs and a lot of data per run). This one only ever writes its
 * own columns, cell ranges only — it never rewrites a row or a tab.
 *
 * Source: SP-API Product Pricing getItemOffersBatch — up to 20 ASINs per
 * call, one call per ~10 seconds (Amazon's default 0.1/sec limit). Gives the
 * total number of offers on each ASIN, and for the lowest-priced offers each
 * seller's ID, price and whether they hold the Buy Box. Amazon does NOT
 * provide seller names or other sellers' stock / units.
 *
 * Seller names: the "seller_names" tab (seller_id | seller_name | first_seen |
 * example_asin). Every new seller ID this cron sees is added there with a
 * blank name; type a name next to an ID once and every later run uses it.
 * Until then the seller ID is shown, with a storefront link that opens the
 * seller's name on Amazon.
 *
 * Resumes across runs: only rows for TODAY (Eastern, same date sync-products
 * stamps) whose offers_synced_at isn't today yet are worked on, so each
 * scheduled run picks up where the last one stopped. Stops starting new
 * Amazon calls after ~4 minutes to stay inside the 5-minute limit.
 *
 * OFFER DETAIL (ADDED 2026-11-13): every offer Amazon returns is also saved,
 * one row per offer per ASIN per day, to the "Newderm -SF product Sync" sheet
 * (SHEET_SF_PRODUCTS, default 1eAkS2Jr30ewk57mP39wA9h6Z862pE1zlE9znTXsZi34),
 * tab "<brand tab> offers": seller, FBA/FBM, listing price, shipping, landed
 * price, difference from our price, and whether THAT offer holds the Buy Box,
 * so "who has the Buy Box" is known down to our FBA vs our FBM (-SF) offer.
 * Same Amazon calls as before; nothing extra is asked of Amazon. Re-running a
 * day replaces that day's rows for the ASINs re-fetched (no duplicates), and
 * rows older than 90 days are removed. Feeds the Alternate Sellers email.
 *
 * Manual:
 *   GET /api/cron/sync-product-offers                  — normal run
 *   GET /api/cron/sync-product-offers?brand=skinuva    — one brand only
 *   GET /api/cron/sync-product-offers?asin=B07RCJDFN4  — test one ASIN, writes nothing, returns Amazon's raw answer
 */

const { spRequest, getSellerId } = require('../_spauth');
const { getSheetsToken, ensureTab } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { sendCronFailureAlert } = require('../_alerts');
const { accountForBrand } = require('../_account');
const { isoDate } = require('../_dates');
const { OFFER_HEADERS } = require('../config/product-offer-columns');

// ── Offer detail sheet (ADDED 2026-11-13) ──────────────────────────────────
const DETAIL_SHEET = process.env.SHEET_SF_PRODUCTS || '1eAkS2Jr30ewk57mP39wA9h6Z862pE1zlE9znTXsZi34';
const DETAIL_SUFFIX = ' offers';
const DETAIL_HEADERS = ['date', 'asin', 'sku', 'seller_id', 'seller_name', 'is_us', 'fulfillment', 'listing_price', 'shipping',
  'landed_price', 'our_price', 'price_diff', 'is_buybox', 'buybox_owner', 'total_offers', 'synced_at'];
const DETAIL_KEEP_DAYS = 90;

const SHEETS_API     = 'https://sheets.googleapis.com/v4/spreadsheets';
const NAMES_TAB      = 'seller_names';
const NAMES_HEADERS  = ['seller_id', 'seller_name', 'first_seen', 'example_asin'];
const BATCH_SIZE     = 20;      // Amazon max per getItemOffersBatch call
const CALL_GAP_MS    = 10_500;  // 0.1 calls/sec, with a little headroom
const TIME_BUDGET_MS = 240_000; // stop starting new calls after 4 minutes
const BRAND_PAUSE_MS = 500;     // between brands' sheet reads (2026-10-28)


// Seller storefront link (FIXED 2026-11-13 per Jaclyn): the bare
// /sp?seller=ID link opened a blank page. This is the format Amazon uses on
// the product page's seller link; same for both marketplaces, only the
// domain changes (amazon.com US, amazon.ca Canada).
const CA_MARKETPLACE_ID = process.env.SP_MARKETPLACE_ID_CA || 'A2EUQ1WTGCTBG2';
const domainFor = marketplaceId => (marketplaceId === CA_MARKETPLACE_ID ? 'ca' : 'com');
function sellerLink(domain, sellerId, asin) {
  return `https://www.amazon.${domain}/sp?ie=UTF8&seller=${encodeURIComponent(sellerId)}`
    + `${asin ? `&asin=${encodeURIComponent(asin)}` : ''}&ref_=dp_merchant_link`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const started = Date.now();
  const marketplaceId = process.env.SP_MARKETPLACE_ID;

  // Our own seller IDs — offers from these are "us", not alternate sellers.
  const ourSellerIds = new Set(['newderm', 'hol'].map(a => { try { return getSellerId(a); } catch { return null; } }).filter(Boolean));

  // ── Test mode: one ASIN, nothing written ─────────────────────────────────
  if (req.query.asin) {
    const asin = String(req.query.asin).trim().toUpperCase();
    const account = req.query.account === 'hol' ? 'hol' : 'newderm';
    const raw = await fetchOffersBatch([asin], marketplaceId, account);
    const parsed = raw.byAsin[asin] ? summarizeOffers(raw.byAsin[asin], ourSellerIds, {}, asin, marketplaceId) : null;
    return res.status(200).json({ testMode: true, asin, account, parsed, raw: raw.raw });
  }

  const onlyBrand = (req.query.brand || '').trim() || null;
  const activeBrands = brands.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));
  if (onlyBrand && !activeBrands.length) return res.status(400).json({ error: `No active brand "${onlyBrand}"` });

  const today = easternDate(new Date());
  const nowEt = easternIso(new Date());
  let token;
  try { token = await getSheetsToken(sheets.products); } // writer account for this sheet (2026-10-27)
  catch (err) { return res.status(500).json({ error: 'Google auth failed', detail: err.message }); }

  // ── Seller names lookup ──────────────────────────────────────────────────
  let names = {};
  try {
    await ensureTab(sheets.products, NAMES_TAB, NAMES_HEADERS);
    const data = await sheetsApi(token, 'GET', `/${sheets.products}/values/${rng(NAMES_TAB, 'A1:D')}`);
    (data.values || []).slice(1).forEach(r => { if (r[0]) names[String(r[0]).trim()] = { name: String(r[1] || '').trim() }; });
  } catch (err) {
    console.warn('[sync-product-offers] could not read seller_names (IDs will be shown instead):', err.message);
  }
  const newSellerIds = new Map(); // id → example ASIN

  // ── Tab grid sizes (FIXED 2026-10-21) ────────────────────────────────────
  // Google refuses to read or write past a tab's grid edge. The brand tabs
  // were exactly as wide as sync-products' columns (e.g. Skinuva: 33), so
  // the new offer columns (AF–AK) were off the grid: the read of
  // offers_synced_at failed and the header write got a 400. Columns are now
  // added to a tab before anything is read from or written to them.
  let grids = {};
  try {
    const meta = await sheetsApi(token, 'GET', `/${sheets.products}?fields=sheets.properties(sheetId,title,gridProperties)`);
    (meta.sheets || []).forEach(sh => { grids[sh.properties.title] = { sheetId: sh.properties.sheetId, cols: sh.properties.gridProperties?.columnCount || 0 }; });
  } catch (err) {
    return res.status(500).json({ error: 'Could not read Products Cache sheet layout', detail: err.message });
  }

  // ── Find today's rows still needing offer data, per brand ────────────────
  const work = [];      // { brand, account, asin, rows: [sheetRowNumber...] }
  const tabCols = {};   // brand.tabName → { colIndex by header, headerNeedsWrite }
  const errors = [];
  // CHANGED 2026-10-28 — real incident: this used to make 4 separate reads per
  // brand (header row + 3 columns), ~72 reads in a few seconds, over Google's
  // 60-reads-per-minute-per-account limit on its own ("cosmette tab read: 429").
  // Now: every brand's header row in ONE call, then ONE call per brand for its
  // three columns (~19 reads per run), with a short pause between brands.
  const present = activeBrands.filter(b => grids[b.tabName]);
  const headerByTab = {};
  if (present.length) {
    const hb = await sheetsApi(token, 'GET', `/${sheets.products}/values:batchGet?${present.map(b => `ranges=${rng(b.tabName, 'A1:ZZ1')}`).join('&')}`);
    (hb.valueRanges || []).forEach((vr, i) => { headerByTab[present[i].tabName] = ((vr.values || [])[0] || []).map(h => String(h).trim()); });
  }
  let brandN = 0;
  for (const brand of present) {
    if (brandN++ > 0) await sleep(BRAND_PAUSE_MS);
    try {
      const header = headerByTab[brand.tabName] || [];
      if (!header.length) continue;
      // Offer columns: wherever they already are, else appended after the last column.
      const idx = {}; let next = header.length; let headerNeedsWrite = false;
      OFFER_HEADERS.forEach(h => { const i = header.indexOf(h); if (i >= 0) idx[h] = i; else { idx[h] = next++; headerNeedsWrite = true; } });
      const dateCol = header.indexOf('date'), asinCol = header.indexOf('asin'), skuCol = header.indexOf('sku');
      if (dateCol < 0 || asinCol < 0) { console.warn(`[sync-product-offers] ${brand.id} — no date/asin column, skipping`); continue; }

      const neededCols = Math.max(...Object.values(idx)) + 1;
      const grid = grids[brand.tabName];
      if (grid && grid.cols < neededCols) {
        await sheetsApi(token, 'POST', `/${sheets.products}:batchUpdate`, { requests: [{
          appendDimension: { sheetId: grid.sheetId, dimension: 'COLUMNS', length: neededCols - grid.cols },
        }] });
        console.log(`[sync-product-offers] ${brand.id} — widened tab from ${grid.cols} to ${neededCols} columns`);
        grid.cols = neededCols;
      }
      tabCols[brand.tabName] = { idx, headerNeedsWrite };

      const syncedCol = idx.offers_synced_at;
      const readCols = [dateCol, asinCol, syncedCol, skuCol >= 0 ? skuCol : asinCol];
      const cols = await sheetsApi(token, 'GET', `/${sheets.products}/values:batchGet?majorDimension=COLUMNS&${
        readCols.map(c => `ranges=${rng(brand.tabName, `${colLetter(c)}2:${colLetter(c)}`)}`).join('&')}`);
      const [dates, asins, synced, skuVals] = (cols.valueRanges || []).map(vr => (vr.values || [])[0] || []);
      const byAsin = new Map();
      const skusByAsin = new Map(); // ADDED 2026-11-13 — for the offer detail rows
      dates.forEach((d, i) => {
        if (isoDate(d) !== today) return;
        const asin = String(asins[i] || '').trim().toUpperCase();
        if (!asin) return;
        if (isoDate(String(synced[i] || '').slice(0, 10)) === today) return; // already done today
        if (!byAsin.has(asin)) byAsin.set(asin, []);
        byAsin.get(asin).push(i + 2);
        if (skuCol >= 0 && skuVals[i]) {
          if (!skusByAsin.has(asin)) skusByAsin.set(asin, new Set());
          skusByAsin.get(asin).add(String(skuVals[i]).replace(/^'/, '').trim());
        }
      });
      // Brand's own marketplace when it has one (e.g. skinuva-ca → Amazon.ca), else US. ADDED 2026-10-21
      const market = brand.marketplaceId || marketplaceId;
      for (const [asin, rows] of byAsin) work.push({ brand, account: accountForBrand(brand), market, asin, rows, skus: [...(skusByAsin.get(asin) || [])] });
    } catch (err) {
      console.warn(`[sync-product-offers] ${brand.id} — could not read tab:`, err.message);
      errors.push(`${brand.id} tab read: ${err.message}`);
      delete tabCols[brand.tabName]; // don't write anything to a tab we couldn't read
    }
  }

  // ── Fetch offers, 20 ASINs per call, per seller account ──────────────────
  const results = {}; // asin|account → summary
  let calls = 0, stoppedEarly = false;
  const keyOf = w => `${w.asin}|${w.account}|${w.market}`;
  const groups = [...new Set(work.map(w => `${w.account}|${w.market}`))];
  for (const g of groups) {
    const [account, market] = g.split('|');
    const asins = [...new Set(work.filter(w => w.account === account && w.market === market).map(w => w.asin))];
    for (let i = 0; i < asins.length; i += BATCH_SIZE) {
      if (Date.now() - started > TIME_BUDGET_MS) { stoppedEarly = true; break; }
      if (calls++ > 0) await sleep(CALL_GAP_MS);
      const chunk = asins.slice(i, i + BATCH_SIZE);
      try {
        const { byAsin, failed } = await fetchOffersBatch(chunk, market, account);
        for (const asin of chunk) {
          if (byAsin[asin]) {
            const s = summarizeOffers(byAsin[asin], ourSellerIds, names, asin, market);
            s.sellerIds.forEach(id => { if (!names[id] && !newSellerIds.has(id)) newSellerIds.set(id, asin); });
            results[`${asin}|${account}|${market}`] = s;
          }
        }
        // ADDED 2026-10-21 — Amazon says this ASIN doesn't exist in this
        // marketplace (retired / merged listing). That won't change on a
        // retry, so record it on the row instead of retrying + alerting daily.
        failed.forEach(f => {
          if (f.invalidAsin) results[`${f.asin}|${account}|${market}`] = { invalid: true };
          else errors.push(f.text);
        });
      } catch (err) {
        errors.push(`${account} ${market} batch starting ${chunk[0]}: ${err.message}`);
      }
    }
    if (stoppedEarly) break;
  }

  // ── Write offer cells (one Sheets call per brand) ────────────────────────
  const written = {};
  for (const brand of activeBrands) {
    const cols = tabCols[brand.tabName];
    if (!cols) continue;
    const data = [];
    if (cols.headerNeedsWrite) {
      OFFER_HEADERS.forEach(h => data.push({ range: `${quoteTab(brand.tabName)}!${colLetter(cols.idx[h])}1`, values: [[h]] }));
    }
    let rowsWritten = 0;
    for (const w of work.filter(x => x.brand.id === brand.id)) {
      const s = results[keyOf(w)];
      if (!s) continue;
      const values = s.invalid ? {
        alt_seller_count: '', alt_sellers: '', alt_seller_links: '',
        buybox_owner: 'ASIN not found on Amazon', lowest_alt_price: '', offers_synced_at: nowEt,
      } : {
        alt_seller_count: s.altCount,
        alt_sellers: s.altLabels.join(' | '),
        alt_seller_links: s.altLinks.join(' | '),
        buybox_owner: s.buyboxOwner,
        lowest_alt_price: s.lowestAltPrice ?? '',
        offers_synced_at: nowEt,
      };
      for (const row of w.rows) {
        OFFER_HEADERS.forEach(h => data.push({ range: `${quoteTab(brand.tabName)}!${colLetter(cols.idx[h])}${row}`, values: [[values[h]]] }));
        rowsWritten++;
      }
    }
    if (!data.length) continue;
    try {
      for (let i = 0; i < data.length; i += 3000) {
        await sheetsApi(token, 'POST', `/${sheets.products}/values:batchUpdate`, { valueInputOption: 'RAW', data: data.slice(i, i + 3000) });
      }
      written[brand.id] = rowsWritten;
    } catch (err) {
      errors.push(`${brand.id} sheet write: ${err.message}`);
    }
  }

  // ── Offer detail → "Newderm -SF product Sync" (ADDED 2026-11-13) ─────────
  let detail = null;
  try {
    detail = await writeOfferDetail(work, results, keyOf, today, nowEt);
  } catch (err) {
    errors.push(`offer detail sheet: ${err.message}`);
  }

  // ── Add newly seen seller IDs to seller_names (names left blank) ─────────
  if (newSellerIds.size) {
    try {
      const rows = [...newSellerIds].map(([id, asin]) => [id, '', today, asin]);
      await sheetsApi(token, 'POST', `/${sheets.products}/values/${rng(NAMES_TAB, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
    } catch (err) {
      console.warn('[sync-product-offers] could not add new seller IDs to seller_names:', err.message);
    }
  }

  const remaining = work.filter(w => !results[keyOf(w)]).length;
  const invalidAsins = [...new Set(work.filter(w => results[keyOf(w)]?.invalid).map(w => `${w.asin} (${w.brand.id})`))];
  if (errors.length) {
    await sendCronFailureAlert('sync-product-offers', errors.slice(0, 15).join('\n'), { 'ASINs left for later runs': String(remaining) });
  }
  res.status(200).json({
    date: today, asinsNeeded: work.length, asinsDone: Object.keys(results).length, asinsRemaining: remaining,
    amazonCalls: calls, stoppedEarly, rowsWrittenByBrand: written, newSellerIdsAdded: newSellerIds.size, offerDetail: detail,
    ...(invalidAsins.length ? { asinsNotOnAmazon: invalidAsins } : {}),
    ...(errors.length ? { errors: errors.slice(0, 15) } : {}),
  });
};

// ── Amazon ─────────────────────────────────────────────────────────────────
async function fetchOffersBatch(asins, marketplaceId, account) {
  const body = {
    requests: asins.map(asin => ({
      uri: `/products/pricing/v0/items/${asin}/offers`,
      method: 'GET',
      MarketplaceId: marketplaceId,
      ItemCondition: 'New',
      CustomerType: 'Consumer',
    })),
  };
  let resp;
  for (let attempt = 0; attempt < 4; attempt++) {
    resp = await spRequest('POST', '/batches/products/pricing/v0/itemOffers', {}, body, account);
    const quota = (resp?.errors || []).some(e => /QuotaExceeded|TooManyRequests/i.test(e.code || ''));
    if (!quota) break;
    await sleep(15_000 * (attempt + 1)); // Amazon said slow down — wait, then retry
  }
  if (resp?.errors?.length) throw new Error(resp.errors.map(e => `${e.code}: ${e.message}`).join('; '));

  const byAsin = {}, failed = [];
  (resp?.responses || []).forEach((r, i) => {
    const payload = r?.body?.payload;
    const asin = String(r?.request?.Asin || payload?.ASIN || asins[i] || '').toUpperCase();
    const code = r?.status?.statusCode;
    if (payload && (!code || code < 300)) { byAsin[asin] = payload; return; }
    const errs = r?.body?.errors || [];
    const invalidAsin = errs.some(e => e.code === 'InvalidInput' && /invalid ASIN/i.test(e.message || ''));
    failed.push({ asin, invalidAsin, text: `${asin}: ${code || ''} ${JSON.stringify(errs.length ? errs : (r?.body || '')).slice(0, 160)}` });
  });
  return { byAsin, failed, raw: resp };
}

function summarizeOffers(payload, ourSellerIds, names, asin = '', marketplaceId = '') {
  const offers = payload.Offers || [];
  const isOurs = o => o.MyOffer === true || ourSellerIds.has(o.SellerId);
  const alt = offers.filter(o => !isOurs(o) && o.SellerId);
  const altIds = [...new Set(alt.map(o => o.SellerId))];

  // Amazon lists at most ~20 offers but reports the full total. If every
  // offer is listed, count distinct other sellers exactly; otherwise use the
  // total minus the offers we can see are ours.
  const total = Number(payload.Summary?.TotalOfferCount ?? offers.length) || 0;
  const altCount = total <= offers.length ? altIds.length : Math.max(0, total - offers.filter(isOurs).length);

  const label = id => names[id]?.name || id;
  const bb = offers.find(o => o.IsBuyBoxWinner);
  const buyboxOwner = !bb ? 'none' : (isOurs(bb) ? 'us' : label(bb.SellerId || 'unknown'));
  const price = o => (Number(o.ListingPrice?.Amount) || 0) + (Number(o.Shipping?.Amount) || 0);
  const lowestAltPrice = alt.length ? Math.round(Math.min(...alt.map(price)) * 100) / 100 : null;

  // ADDED 2026-11-13 — who holds the Buy Box down to OUR FBA vs OUR FBM offer,
  // our reference price (our Buy Box offer, else our lowest), and one detail
  // row per offer for the offer detail sheet.
  const round2 = n => Math.round(n * 100) / 100;
  const ours = offers.filter(isOurs);
  const ourPrice = bb && isOurs(bb) ? round2(price(bb)) : (ours.length ? round2(Math.min(...ours.map(price))) : null);
  const channel = o => (o.IsFulfilledByAmazon ? 'FBA' : 'FBM');
  const buyboxDetail = !bb ? 'none' : (isOurs(bb) ? `us (${channel(bb)})` : label(bb.SellerId || 'unknown'));
  const offerRows = offers.map(o => {
    const landed = round2(price(o));
    const us = isOurs(o);
    return {
      seller_id: o.SellerId || '', seller_name: us ? 'us' : (names[o.SellerId]?.name || ''), is_us: us ? 'TRUE' : 'FALSE',
      fulfillment: channel(o), listing_price: Number(o.ListingPrice?.Amount) || 0, shipping: Number(o.Shipping?.Amount) || 0,
      landed_price: landed, our_price: ourPrice ?? '', price_diff: us || ourPrice == null ? '' : round2(landed - ourPrice),
      is_buybox: o.IsBuyBoxWinner ? 'TRUE' : 'FALSE',
    };
  });

  return {
    altCount,
    altLabels: altIds.map(label),
    altLinks: altIds.map(id => sellerLink(domainFor(marketplaceId), id, asin)),
    buyboxOwner,
    lowestAltPrice,
    sellerIds: altIds,
    buyboxDetail, ourPrice, offerRows, totalOffers: total,
  };
}

// ── Offer detail sheet writer (ADDED 2026-11-13) ───────────────────────────
// Per brand tab "<tab> offers": today's rows for the ASINs fetched this run
// replace any earlier rows for the same ASIN + day; rows older than
// DETAIL_KEEP_DAYS are removed; new rows are appended at the end.
async function writeOfferDetail(work, results, keyOf, today, nowEt) {
  const byTab = new Map(); // tab -> { asins:Set, rows:[] }
  for (const w of work) {
    const s = results[keyOf(w)];
    if (!s || s.invalid) continue;
    const tab = `${w.brand.tabName}${DETAIL_SUFFIX}`;
    if (!byTab.has(tab)) byTab.set(tab, { asins: new Set(), rows: [] });
    const t = byTab.get(tab);
    if (t.asins.has(w.asin)) continue; // one set of rows per ASIN per run
    t.asins.add(w.asin);
    const sku = (w.skus || []).join(' | ');
    const base = [today, w.asin, sku];
    if (!s.offerRows.length) {
      t.rows.push([...base, '', '', '', '', '', '', '', '', '', '', 'no offers', s.totalOffers, nowEt]);
    } else {
      for (const o of s.offerRows) {
        t.rows.push([...base, o.seller_id, o.seller_name, o.is_us, o.fulfillment, o.listing_price, o.shipping, o.landed_price,
          o.our_price, o.price_diff, o.is_buybox, s.buyboxDetail, s.totalOffers, nowEt]);
      }
    }
  }
  if (!byTab.size) return { tabs: 0, rowsAdded: 0, rowsRemoved: 0 };

  const token = await getSheetsToken('writer');
  const meta = await sheetsApi(token, 'GET', `/${DETAIL_SHEET}?fields=sheets.properties(sheetId,title)`);
  const ids = Object.fromEntries((meta.sheets || []).map(x => [x.properties.title, x.properties.sheetId]));

  // Create missing tabs, then label them.
  const missing = [...byTab.keys()].filter(t => ids[t] == null);
  if (missing.length) {
    const r = await sheetsApi(token, 'POST', `/${DETAIL_SHEET}:batchUpdate`, { requests: missing.map(title => ({
      addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: DETAIL_HEADERS.length, frozenRowCount: 1 } } } })) });
    (r.replies || []).forEach((rep, i) => { ids[missing[i]] = rep.addSheet?.properties?.sheetId; });
    await sheetsApi(token, 'POST', `/${DETAIL_SHEET}/values:batchUpdate`, { valueInputOption: 'RAW',
      data: missing.map(t => ({ range: `${quoteTab(t)}!A1`, values: [DETAIL_HEADERS] })) });
  }

  // Find rows to remove: same ASIN + today (being replaced), or older than the keep window.
  const cutoff = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - DETAIL_KEEP_DAYS); return d.toISOString().slice(0, 10); })();
  const existingTabs = [...byTab.keys()].filter(t => !missing.includes(t));
  const deletes = [];
  let rowsRemoved = 0;
  if (existingTabs.length) {
    const got = await sheetsApi(token, 'GET', `/${DETAIL_SHEET}/values:batchGet?majorDimension=COLUMNS&${existingTabs.map(t => `ranges=${rng(t, 'A2:B')}`).join('&')}`);
    (got.valueRanges || []).forEach((vr, k) => {
      const tab = existingTabs[k];
      const [dates = [], asins = []] = vr.values || [];
      const drop = [];
      dates.forEach((d, i) => {
        const iso = isoDate(d);
        const asin = String(asins[i] || '').trim().toUpperCase();
        if ((iso === today && byTab.get(tab).asins.has(asin)) || (iso && iso < cutoff)) drop.push(i + 1); // 0-based grid row (row 1 = header)
      });
      rowsRemoved += drop.length;
      // merge into ranges, deleted bottom-up so earlier indexes stay valid
      const ranges = [];
      for (const r of drop) { const last = ranges[ranges.length - 1]; if (last && r === last[1]) last[1]++; else ranges.push([r, r + 1]); }
      ranges.reverse().forEach(([a, b]) => deletes.push({ deleteDimension: { range: { sheetId: ids[tab], dimension: 'ROWS', startIndex: a, endIndex: b } } }));
    });
  }
  if (deletes.length) await sheetsApi(token, 'POST', `/${DETAIL_SHEET}:batchUpdate`, { requests: deletes });

  let rowsAdded = 0;
  for (const [tab, t] of byTab) {
    if (!t.rows.length) continue;
    await sheetsApi(token, 'POST', `/${DETAIL_SHEET}/values/${rng(tab, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: t.rows });
    rowsAdded += t.rows.length;
    await sleep(300);
  }
  return { tabs: byTab.size, rowsAdded, rowsRemoved };
}

// ── Sheets helpers ─────────────────────────────────────────────────────────
// Retries match config/_sheets_client.js (CHANGED 2026-10-28): Google's
// quotas are per minute, so a 429 keeps waiting up to ~85s total (always past
// the minute boundary); 5xx errors get the original 4 tries. Jitter keeps
// crons that hit the limit together from retrying in the same instant.
const RETRY_WAITS_MS = [2000, 4000, 8000, 16000, 20000, 30000];
async function sheetsApi(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SHEETS_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || (res.status >= 500 && attempt < 4);
    if (retryable && attempt < RETRY_WAITS_MS.length) {
      console.warn(`[sync-product-offers] Sheets ${res.status} on ${method}, retrying in ${RETRY_WAITS_MS[attempt] / 1000}s`);
      await sleep(RETRY_WAITS_MS[attempt] + Math.floor(Math.random() * 1500));
      continue;
    }
    throw new Error(`Sheets ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
}
const quoteTab = t => `'${String(t).replace(/'/g, "''")}'`;
const rng = (tab, a1) => encodeURIComponent(`${quoteTab(tab)}!${a1}`);
function colLetter(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

// Eastern date / timestamp — same convention as sync-products.js.
function easternParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).map(x => [x.type, x.value]));
  return p;
}
function easternDate(d) { const p = easternParts(d); return `${p.year}-${p.month}-${p.day}`; }
function easternIso(d)  { const p = easternParts(d); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`; }
