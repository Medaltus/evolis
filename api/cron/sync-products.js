/**
 * api/cron/sync-products.js
 * Resumable daily log — one row PER SKU PER DAY (never overwritten), so
 * inventory history accumulates for stockout/trend analysis. Paired with
 * trim-products-log.js, which drops rows older than 2 years.
 *
 * REPLACES the old sync-products.js entirely. The old version derived
 * "products" from 13 months of individual order-items API calls (one
 * order at a time) — that's why it timed out (504 seen 2026-07-06) and
 * why it had no listing content or inventory data at all. This version
 * calls the actual right APIs:
 *   Listings Items API  — title, bullets, description, backend keywords,
 *                          ingredients, status, issues, B2C price
 *   FBA Inventory API   — fulfillable/reserved/inbound/unfulfillable
 *                          quantities
 *   Catalog Items API   — sales rank
 *
 * Scope: only ASINs listed on the master SKU list's "Product Short Name"
 * tab (SHEET_MASTER_SKU_LIST, gid 164358627) — not a full catalog scan.
 * That sheet is also where `name` comes from (column C), NOT the API —
 * per requirements, `name` and `title` are deliberately different columns.
 * High On Love is hard-excluded — different Amazon seller account,
 * these credentials don't apply there. SKUs prefixed "C-SVA" are also
 * excluded — those are website-only inventory, not Amazon listings.
 *
 * WHY THIS IS RESUMABLE, NOT ONE SHOT:
 *   Hundreds of SKUs × 3 API calls each, spaced responsibly, cannot
 *   finish in one 300s function run — the math doesn't work. Each run
 *   processes as many SKUs as fit in a safe time budget, stores a cursor
 *   in _meta, and continues from there next run. Scheduled every 10-15
 *   minutes; once a day's log is complete, later runs that same day are
 *   fast no-ops.
 *
 * RATE LIMITING — assumption worth verifying on first real run:
 *   SP-API rate-limits per OPERATION, not globally, so the 3 calls for
 *   one SKU (different operations) are fired in parallel — safe. The
 *   1.2s delay is only BETWEEN SKUs, to stay safely under each
 *   operation's own per-second cap. This number is a conservative
 *   default, not independently confirmed against Amazon's actual limits
 *   for these three specific operations — watch the logs on first run
 *   for 429s and increase if needed.
 *
 * Sheet: SHEET_PRODUCTS, one tab per brand.
 * Columns: date, sku, asin, fulfillable_quantity, reserved_quantity,
 *   inbound_working_quantity, inbound_shipped_quantity,
 *   inbound_receiving_quantity, unfulfillable_quantity, total_quantity,
 *   name, status, sales_ranks, title, item_highlights, bullet_1..5,
 *   description, backend_keywords, ingredients, item_type_keyword,
 *   offers, issues, last_synced, purchased_units_90d, days_of_inventory,
 *   qty_on_hand
 *
 * total_quantity (col K), days_of_inventory (col AD), and qty_on_hand
 * (col AE) are LIVE SPREADSHEET FORMULAS, not code-computed values —
 * written with valueInputOption=USER_ENTERED so they actually evaluate
 * rather than store as literal formula-looking text:
 *   qty_on_hand ("On Hand") = D{row}+E{row}+J{row}
 *                             (fulfillable + reserved + seller-fulfilled)
 *   total_quantity ("Available") = AE{row}-E{row}  (qty_on_hand - reserved)
 *   days_of_inventory            = total_quantity / (purchased_units_90d / 90)
 *
 * total_quantity is explicitly DERIVED FROM qty_on_hand minus reserved,
 * not computed independently — per exact definition given 2026-07-20.
 * Numerically this still lands on fulfillable+seller_fulfilled (reserved
 * cancels out), but the formula itself now matches the stated derivation.
 *
 * qty_on_hand deliberately excludes inbound (working/shipped/receiving)
 * — confirmed via Amazon's FBA Inventory API docs that "Inbound" units
 * are still on their way to Amazon's network, not yet fulfillable/
 * sellable/physically on hand. It also excludes unfulfillable_quantity
 * (damaged/expired stock) — physically present but not usable inventory,
 * per exact definition given 2026-07-20.
 *
 * purchased_units_90d (col AC) is summed from the rolling 90-day orders
 * cache (sheets.orders, same sheet/tab-per-brand every other cron in this
 * repo uses) — see fetchBrand90dUnits. FAILSAFE: this lookup is fetched
 * once per brand and wrapped in its own try/catch; if it fails, that
 * brand's rows just get a blank purchased_units_90d/days_of_inventory for
 * this run rather than blocking the inventory/listing sync that already
 * works today.
 */

const { spRequest }                                     = require('../_spauth');
const { ensureTab, readRows, replaceRows, appendRows }  = require('../config/_sheets_client');
const brands                                            = require('../config/brands');
const sheets                                            = require('../config/sheets');

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

const HEADERS = [
  'date', 'sku', 'asin',
  'fulfillable_quantity', 'reserved_quantity', 'inbound_working_quantity',
  'inbound_shipped_quantity', 'inbound_receiving_quantity',
  'unfulfillable_quantity', 'seller_fulfilled_quantity', 'total_quantity',
  'name', 'status', 'sales_ranks', 'title', 'item_highlights',
  'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5',
  'description', 'backend_keywords', 'ingredients', 'item_type_keyword',
  'offers', 'issues', 'last_synced',
  'purchased_units_90d', 'days_of_inventory', 'qty_on_hand',
];

// Column letters for the formulas below — spelled out once here so a
// future HEADERS reorder doesn't silently break the formula strings.
const COL_FULFILLABLE      = 'D';
const COL_RESERVED         = 'E';
const COL_SELLER_FULFILLED = 'J';
const COL_TOTAL_QUANTITY   = 'K'; // "Available"
const COL_PURCHASED_90D    = 'AC';
const COL_QTY_ON_HAND      = 'AE';

const EXCLUDED_BRAND_NAMES = ['high on love']; // different seller account entirely

const TIME_BUDGET_MS = 250_000; // stay safely under Vercel's 300s cap
const INTER_SKU_DELAY_MS = 1200; // conservative default — see rate-limiting note above

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ── Diagnostic-only test mode ────────────────────────────────────────
  // ?testSku=DEC0001&testAsin=B0DRPPFP7Z — bypasses the cursor/masterList
  // walk entirely and calls buildProductRow for just this one item,
  // returning the RAW listing/inventory/catalog responses (including any
  // {__error} objects the Promise.all .catch() below normally swallows
  // silently — see file header note added 2026-07-22). Never writes to
  // the sheet. Added specifically because this cron has no other way to
  // test one SKU without waiting for the resumable cursor to reach it,
  // which for a brand sitting late in the master list could take several
  // real invocations.
  if (req.query.testSku && req.query.testAsin) {
    const testItem = { sku: req.query.testSku, asin: req.query.testAsin, name: '(test mode)' };
    try {
      const [listing, inventory, catalog, sfListing] = await Promise.all([
        fetchListing(testItem.sku).catch(err => ({ __error: err.message })),
        fetchInventory(testItem.sku).catch(err => ({ __error: err.message })),
        fetchCatalog(testItem.asin).catch(err => ({ __error: err.message })),
        fetchListing(`${testItem.sku}-SF`).catch(err => ({ __error: err.message })),
      ]);
      return res.status(200).json({
        testMode: true, sku: testItem.sku, asin: testItem.asin,
        listing, inventory, catalog, sfListing,
      });
    } catch (err) {
      return res.status(500).json({ testMode: true, error: err.message });
    }
  }

  const force = req.query.force === 'true';

  let meta;
  try {
    meta = await readMeta();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  let cursor = 0;
  if (force) {
    // Remove any rows already written for TODAY (across all brand tabs)
    // before reprocessing — this is an "overwrite today" operation, not a
    // duplicate-creating re-append. Every other day's history is untouched.
    try {
      await clearRowsForDate(today);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to clear today\'s existing rows before forced re-run', detail: err.message });
    }
    console.log(`[sync-products] force=true — cleared today's (${today}) existing rows, restarting from cursor 0`);
  } else if (meta.products_log_date === today) {
    if (meta.products_log_complete === 'true') {
      return res.status(200).json({ message: `Already completed for ${today}. Pass ?force=true to overwrite today's rows and reprocess (e.g. after a column/logic change).` });
    }
    cursor = parseInt(meta.products_log_cursor || '0', 10) || 0;
  }
  // else: new day — cursor resets to 0, starting a fresh daily log

  let masterList;
  try {
    masterList = await fetchMasterSkuList();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read master SKU list', detail: err.message });
  }

  const totalCount = masterList.length;
  const startTime  = Date.now();
  const nowIso      = new Date().toISOString();

  let processed = 0;
  let i = cursor;
  const tabTokens = {};
  const tabNextRow = {};       // brandTabName -> next row number to write to
  const brand90dMaps = {};     // brandTabName -> { [asin]: unitsSoldLast90d } — see fetchBrand90dUnits

  for (; i < masterList.length; i++) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    if (i > cursor) await sleep(INTER_SKU_DELAY_MS);

    const item = masterList[i];
    try {
      if (!tabTokens[item.brandTabName]) {
        tabTokens[item.brandTabName] = await ensureTab(sheets.products, item.brandTabName, HEADERS);
        const existingRows = await readRows(sheets.products, item.brandTabName);
        tabNextRow[item.brandTabName] = existingRows.length + 2; // +1 for header row, +1 to move past the last existing row
      }

      // FAILSAFE: 90-day units lookup is fetched once per brand and never
      // throws out of this block — if it fails, that brand's SKUs just get
      // a blank purchased_units_90d/days_of_inventory this run rather than
      // blocking the inventory/listing data that already works today.
      if (!(item.brandTabName in brand90dMaps)) {
        try {
          brand90dMaps[item.brandTabName] = await fetchBrand90dUnits(item.brandTabName);
        } catch (err) {
          console.warn(`[sync-products] ${item.brandTabName} — 90-day units lookup failed, leaving purchased_units_90d blank this run:`, err.message);
          brand90dMaps[item.brandTabName] = {};
        }
      }

      const rowNumber = tabNextRow[item.brandTabName];
      const units90d = brand90dMaps[item.brandTabName][item.asin.toUpperCase()] ?? '';
      const row = await buildProductRow(item, today, nowIso, rowNumber, units90d);

      await appendRows(sheets.products, item.brandTabName, [row], tabTokens[item.brandTabName], 'USER_ENTERED');
      tabNextRow[item.brandTabName]++;
      processed++;
    } catch (err) {
      console.error(`[sync-products] ${item.sku} (${item.brandTabName}) failed:`, err.message);
      // Continue to the next SKU — one bad SKU shouldn't stall the whole run.
    }
  }

  const complete = i >= masterList.length;
  try {
    await writeMeta({
      products_log_date:     today,
      products_log_cursor:   String(i),
      products_log_complete: complete ? 'true' : 'false',
    });
  } catch (err) {
    console.warn('[sync-products] failed to update _meta:', err.message);
  }

  res.status(200).json({
    date: today,
    processedThisRun: processed,
    cursor: i,
    totalCount,
    complete,
  });
};

// ── Row building ────────────────────────────────────────────────────────────

async function buildProductRow(item, dateStr, nowIso, rowNumber, units90d) {
  const { sku, asin, name } = item;
  const sfSku = `${sku}-SF`;

  // Fire all 4 API calls in parallel — the SF listing call costs no extra
  // wall-clock time this way vs. the 3 we were already making.
  const [listing, inventory, catalog, sfListing] = await Promise.all([
    fetchListing(sku).catch(err => ({ __error: err.message })),
    fetchInventory(sku).catch(err => ({ __error: err.message })),
    fetchCatalog(asin).catch(err => ({ __error: err.message })),
    fetchListing(sfSku).catch(() => null), // null = SF SKU doesn't exist for this product, that's fine
  ]);

  // ADDED 2026-07-22: these three errors used to be captured into
  // {__error} and never read again anywhere — the row would still get
  // built and written (with the corresponding fields blank), with zero
  // trace in the logs that anything failed. Found while diagnosing
  // Dearcloud coming back completely empty; logging now, regardless of
  // whether it turns out to be the actual cause there.
  if (listing?.__error)   console.error(`[sync-products] ${sku} (${item.brandTabName}) — Listings API failed:`, listing.__error);
  if (inventory?.__error) console.error(`[sync-products] ${sku} (${item.brandTabName}) — FBA Inventory API failed:`, inventory.__error);
  if (catalog?.__error)   console.error(`[sync-products] ${asin} (${item.brandTabName}) — Catalog Items API failed:`, catalog.__error);

  const inv = inventory?.payload?.inventorySummaries?.[0]?.inventoryDetails || {};
  // total_quantity is now a live formula (fulfillable + seller-fulfilled),
  // NOT read from Amazon's own totalQuantity field — that field wasn't
  // reflecting sellable inventory correctly. Inbound-working is
  // deliberately excluded: confirmed via Amazon's FBA Inventory API docs
  // that "Inbound" (working/shipped/receiving) is still on its way to
  // Amazon's network, not yet fulfillable/sellable — there's no state in
  // which those units become customer-orderable before being received.

  // Merchant-fulfilled stock lives on the -SF SKU, not the FBA SKU.
  // The DEFAULT channel on the FBA SKU's own listing always returned 0
  // because that's a different listing — confirmed 2026-07-10.
  const sfFulfillmentAvail  = sfListing?.attributes?.fulfillment_availability || [];
  const sfDefaultChannel    = sfFulfillmentAvail.find(f => f.fulfillment_channel_code === 'DEFAULT');
  const sellerFulfilledQuantity = sfDefaultChannel?.quantity ?? '';

  const bullets = listing?.attributes?.bullet_point || [];
  const bulletVal = idx => bullets[idx]?.value || '';

  const b2cOffer = (listing?.offers || []).find(o => o.offerType === 'B2C');
  const offersStr = b2cOffer ? `${b2cOffer.price?.currencyCode || ''} ${b2cOffer.price?.amount || ''}`.trim() : '';

  const issuesStr = (listing?.issues || [])
    .map(iss => `[${iss.severity}] ${(iss.attributeNames || []).join(',')}: ${iss.message}`)
    .join(' | ');

  const salesRanksStr = (catalog?.salesRanks?.[0]?.classificationRanks || [])
    .map(r => `${r.title} (#${r.rank})`)
    .join('; ');

  return [
    dateStr,
    sku,
    asin,
    inv.fulfillableQuantity ?? '',
    inv.reservedQuantity?.totalReservedQuantity ?? '',
    inv.inboundWorkingQuantity ?? '',
    inv.inboundShippedQuantity ?? '',
    inv.inboundReceivingQuantity ?? '',
    inv.unfulfillableQuantity?.totalUnfulfillableQuantity ?? '',
    sellerFulfilledQuantity,
    // total_quantity ("Available") — live formula: qty_on_hand minus
    // allocated (reserved). Not computed independently from
    // fulfillable+seller_fulfilled anymore — it's explicitly derived FROM
    // qty_on_hand, per exact definition given 2026-07-20. Numerically this
    // still lands on fulfillable+seller_fulfilled (reserved cancels out:
    // (fulfillable+reserved+seller_fulfilled) - reserved), but the formula
    // itself now matches the stated derivation rather than coincidentally
    // producing the same number.
    `=${COL_QTY_ON_HAND}${rowNumber}-${COL_RESERVED}${rowNumber}`,
    name || '', // from master sheet, NOT the API — per requirements
    (listing?.summaries?.[0]?.status || []).join(', '),
    salesRanksStr,
    listing?.summaries?.[0]?.itemName || listing?.attributes?.item_name?.[0]?.value || '',
    listing?.attributes?.item_highlights?.[0]?.value || '', // often blank today — see file header note
    bulletVal(0), bulletVal(1), bulletVal(2), bulletVal(3), bulletVal(4),
    listing?.attributes?.product_description?.[0]?.value || '',
    listing?.attributes?.generic_keyword?.[0]?.value || '',
    listing?.attributes?.ingredients?.[0]?.value || '',
    listing?.attributes?.item_type_keyword?.[0]?.value || '',
    offersStr,
    issuesStr,
    nowIso,
    units90d, // purchased_units_90d — summed from the rolling 90-day orders cache, blank if that lookup failed this run
    // days_of_inventory — live formula, guarded against divide-by-zero/blank
    // (N() coerces blank to 0 so the IF check works even if units90d is '').
    `=IF(N(${COL_PURCHASED_90D}${rowNumber})=0,"",${COL_TOTAL_QUANTITY}${rowNumber}/(${COL_PURCHASED_90D}${rowNumber}/90))`,
    // qty_on_hand — live formula: fulfillable + reserved + seller-fulfilled.
    // Deliberately excludes unfulfillable_quantity (damaged/expired stock)
    // AND inbound (still in transit, not physically on hand yet) — per
    // exact definition given 2026-07-20.
    `=${COL_FULFILLABLE}${rowNumber}+${COL_RESERVED}${rowNumber}+${COL_SELLER_FULFILLED}${rowNumber}`,
  ];
}

// ── API calls ───────────────────────────────────────────────────────────────

function fetchListing(sku) {
  return spRequest(
    'GET',
    `/listings/2021-08-01/items/${process.env.SP_SELLER_ID}/${encodeURIComponent(sku)}`,
    {
      marketplaceIds: process.env.SP_MARKETPLACE_ID,
      includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability,procurement',
    }
  );
}

function fetchInventory(sku) {
  return spRequest(
    'GET',
    '/fba/inventory/v1/summaries',
    {
      granularityType: 'Marketplace',
      granularityId:   process.env.SP_MARKETPLACE_ID,
      marketplaceIds:  process.env.SP_MARKETPLACE_ID,
      details:         'true',
      sellerSkus:      sku,
    }
  );
}

function fetchCatalog(asin) {
  return spRequest(
    'GET',
    `/catalog/2022-04-01/items/${asin}`,
    {
      marketplaceIds: process.env.SP_MARKETPLACE_ID,
      includedData:   'attributes,images,productTypes,salesRanks,summaries,dimensions',
    }
  );
}

// ── Master SKU list ───────────────────────────────────────────────────────

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function fetchMasterSkuList() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp   = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master SKU list: ${resp.status}`);
  const csv   = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  const out = [];
  for (const line of lines) {
    const cols      = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const asin      = cols[0] || '';
    const sku       = cols[1] || '';
    const name      = cols[2] || '';
    const rawBrand  = (cols[3] || '').trim();
    const brandNorm = stripAccents(rawBrand.toLowerCase());

    if (!asin || !sku) continue;
    if (sku.toUpperCase().startsWith('C-SVA')) continue; // website-only inventory, not Amazon
    if (EXCLUDED_BRAND_NAMES.some(x => brandNorm.includes(x))) continue;

    const matched = brands.find(b =>
      b.active && (
        brandNorm === stripAccents(b.id.toLowerCase()) ||
        brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
        brandNorm.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (!matched) {
      console.log(`[sync-products] unmatched brand in master sheet: "${rawBrand}" (asin ${asin}) — skipped`);
      continue;
    }

    out.push({ asin, sku, name, brandTabName: matched.tabName });
  }
  return out;
}

// Sums unit_count per ASIN from the rolling 90-day orders cache
// (sheets.orders, same tab-per-brand sheet every other cron in this repo
// uses). That sheet is already maintained as a 90-day rolling window by
// its own cron, so no date filtering is needed here — just exclude
// cancelled orders, since a cancelled order was never actually purchased.
// Called once per brand (not per SKU) and cached by the caller.
async function fetchBrand90dUnits(brandTabName) {
  const rows = await readRows(sheets.orders, brandTabName);
  const map = {};
  (rows || []).forEach(r => {
    const status = (r.status || '').toLowerCase();
    if (status === 'cancelled') return;
    const asin = (r.asin || '').trim().toUpperCase();
    if (!asin) return;
    const units = parseInt(r.unit_count, 10) || 0;
    map[asin] = (map[asin] || 0) + units;
  });
  return map;
}

// Removes every row matching `dateStr` from every active brand's tab,
// leaving all other dates' history untouched. Used by ?force=true to
// support "overwrite today" without duplicating rows or losing history.
async function clearRowsForDate(dateStr) {
  for (const brand of brands.filter(b => b.active)) {
    try {
      const token = await ensureTab(sheets.products, brand.tabName, HEADERS);
      const rows  = await readRows(sheets.products, brand.tabName, 'FORMULA'); // preserve formula text, not computed values
      const kept  = rows.filter(r => (r.date || '') !== dateStr);
      if (kept.length !== rows.length) {
        const rowArrays = kept.map(r => HEADERS.map(h => r[h] ?? ''));
        await replaceRows(sheets.products, brand.tabName, HEADERS, rowArrays, token, 'USER_ENTERED');
        console.log(`[sync-products] ${brand.id} — cleared ${rows.length - kept.length} existing rows for ${dateStr}`);
      }
    } catch (err) {
      console.warn(`[sync-products] ${brand.id} — failed to clear rows for ${dateStr}:`, err.message);
      // Don't throw — a brand with no tab yet (e.g. never synced before) is fine to skip.
    }
  }
}

// ── _meta helpers ────────────────────────────────────────────────────────

async function readMeta() {
  const rows = await readRows(sheets.products, META_TAB);
  const map  = {};
  (rows || []).forEach(r => { if (r.KEY) map[r.KEY] = r.VALUE; });
  return map;
}

async function writeMeta(updates) {
  const token = await ensureTab(sheets.products, META_TAB, META_HEADERS);
  const nowIso = new Date().toISOString();
  const existing = await readRows(sheets.products, META_TAB);
  const map = {};
  (existing || []).forEach(r => { if (r.KEY) map[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
  Object.entries(updates).forEach(([k, v]) => { map[k] = [k, v, nowIso]; });
  await replaceRows(sheets.products, META_TAB, META_HEADERS, Object.values(map), token);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
