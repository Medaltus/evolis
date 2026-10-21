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

const SHEETS_API     = 'https://sheets.googleapis.com/v4/spreadsheets';
const NAMES_TAB      = 'seller_names';
const NAMES_HEADERS  = ['seller_id', 'seller_name', 'first_seen', 'example_asin'];
const BATCH_SIZE     = 20;      // Amazon max per getItemOffersBatch call
const CALL_GAP_MS    = 10_500;  // 0.1 calls/sec, with a little headroom
const TIME_BUDGET_MS = 240_000; // stop starting new calls after 4 minutes

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
    const parsed = raw.byAsin[asin] ? summarizeOffers(raw.byAsin[asin], ourSellerIds, {}) : null;
    return res.status(200).json({ testMode: true, asin, account, parsed, raw: raw.raw });
  }

  const onlyBrand = (req.query.brand || '').trim() || null;
  const activeBrands = brands.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));
  if (onlyBrand && !activeBrands.length) return res.status(400).json({ error: `No active brand "${onlyBrand}"` });

  const today = easternDate(new Date());
  const nowEt = easternIso(new Date());
  let token;
  try { token = await getSheetsToken(); }
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
  for (const brand of activeBrands) {
    try {
      const head = await sheetsApi(token, 'GET', `/${sheets.products}/values/${rng(brand.tabName, 'A1:ZZ1')}`);
      const header = ((head.values || [])[0] || []).map(h => String(h).trim());
      if (!header.length) continue;
      // Offer columns: wherever they already are, else appended after the last column.
      const idx = {}; let next = header.length; let headerNeedsWrite = false;
      OFFER_HEADERS.forEach(h => { const i = header.indexOf(h); if (i >= 0) idx[h] = i; else { idx[h] = next++; headerNeedsWrite = true; } });
      const dateCol = header.indexOf('date'), asinCol = header.indexOf('asin');
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
      const [dates, asins, synced] = await Promise.all([dateCol, asinCol, syncedCol].map(c =>
        sheetsApi(token, 'GET', `/${sheets.products}/values/${rng(brand.tabName, `${colLetter(c)}2:${colLetter(c)}`)}`).then(d => (d.values || []).map(r => r[0]))));
      const byAsin = new Map();
      dates.forEach((d, i) => {
        if (isoDate(d) !== today) return;
        const asin = String(asins[i] || '').trim().toUpperCase();
        if (!asin) return;
        if (isoDate(String(synced[i] || '').slice(0, 10)) === today) return; // already done today
        if (!byAsin.has(asin)) byAsin.set(asin, []);
        byAsin.get(asin).push(i + 2);
      });
      for (const [asin, rows] of byAsin) work.push({ brand, account: accountForBrand(brand), asin, rows });
    } catch (err) {
      console.warn(`[sync-product-offers] ${brand.id} — could not read tab:`, err.message);
      errors.push(`${brand.id} tab read: ${err.message}`);
      delete tabCols[brand.tabName]; // don't write anything to a tab we couldn't read
    }
  }

  // ── Fetch offers, 20 ASINs per call, per seller account ──────────────────
  const results = {}; // asin|account → summary
  let calls = 0, stoppedEarly = false;
  for (const account of [...new Set(work.map(w => w.account))]) {
    const asins = [...new Set(work.filter(w => w.account === account).map(w => w.asin))];
    for (let i = 0; i < asins.length; i += BATCH_SIZE) {
      if (Date.now() - started > TIME_BUDGET_MS) { stoppedEarly = true; break; }
      if (calls++ > 0) await sleep(CALL_GAP_MS);
      const chunk = asins.slice(i, i + BATCH_SIZE);
      try {
        const { byAsin, failed } = await fetchOffersBatch(chunk, marketplaceId, account);
        for (const asin of chunk) {
          if (byAsin[asin]) {
            const s = summarizeOffers(byAsin[asin], ourSellerIds, names);
            s.sellerIds.forEach(id => { if (!names[id] && !newSellerIds.has(id)) newSellerIds.set(id, asin); });
            results[`${asin}|${account}`] = s;
          }
        }
        failed.forEach(f => errors.push(f));
      } catch (err) {
        errors.push(`${account} batch starting ${chunk[0]}: ${err.message}`);
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
      const s = results[`${w.asin}|${w.account}`];
      if (!s) continue;
      const values = {
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

  // ── Add newly seen seller IDs to seller_names (names left blank) ─────────
  if (newSellerIds.size) {
    try {
      const rows = [...newSellerIds].map(([id, asin]) => [id, '', today, asin]);
      await sheetsApi(token, 'POST', `/${sheets.products}/values/${rng(NAMES_TAB, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
    } catch (err) {
      console.warn('[sync-product-offers] could not add new seller IDs to seller_names:', err.message);
    }
  }

  const remaining = work.filter(w => !results[`${w.asin}|${w.account}`]).length;
  if (errors.length) {
    await sendCronFailureAlert('sync-product-offers', errors.slice(0, 15).join('\n'), { 'ASINs left for later runs': String(remaining) });
  }
  res.status(200).json({
    date: today, asinsNeeded: work.length, asinsDone: Object.keys(results).length, asinsRemaining: remaining,
    amazonCalls: calls, stoppedEarly, rowsWrittenByBrand: written, newSellerIdsAdded: newSellerIds.size,
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
    if (payload && (!code || code < 300)) byAsin[asin] = payload;
    else failed.push(`${asin}: ${code || ''} ${JSON.stringify(r?.body?.errors || r?.body || '').slice(0, 160)}`);
  });
  return { byAsin, failed, raw: resp };
}

function summarizeOffers(payload, ourSellerIds, names) {
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

  return {
    altCount,
    altLabels: altIds.map(label),
    altLinks: altIds.map(id => `https://www.amazon.com/sp?seller=${id}`),
    buyboxOwner,
    lowestAltPrice,
    sellerIds: altIds,
  };
}

// ── Sheets helpers ─────────────────────────────────────────────────────────
async function sheetsApi(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SHEETS_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * 2 ** attempt); continue; }
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
