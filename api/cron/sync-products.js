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
 *
 * ADDED (2026-08-04): purchased_units_90d now combines Amazon + Walmart
 * for SKUs sold on both channels, per master SKU list column G ("channel":
 * Amazon / Walmart / Amazon / Walmart). Amazon side stays keyed by ASIN as
 * before. Walmart side is keyed by SKU — no ASIN concept on that
 * marketplace. Same failsafe pattern: a failed lookup leaves that
 * channel's contribution out rather than blocking the run. SKUs not
 * flagged sellsOnWalmart are completely unaffected — Amazon-only behavior,
 * unchanged.
 *
 * CHANGED (2026-08-13): fetchBrand90dUnits/fetchBrandWalmart90dUnits no
 * longer re-derive these sums live from the full orders/Walmart-orders
 * history on every 15-minute run — that was re-reading thousands of rows
 * per brand up to 36x/day for a number that only meaningfully changes
 * daily. Both now read a small pre-computed cache (UNITS_90D_CACHE_SHEET_ID)
 * populated once daily by sync-90d-units-cache.js. Same failsafe behavior,
 * same return shape, just a cheaper, once-a-day-fresh data source.
 */

const { spRequest }                                     = require('../_spauth');
const { ensureTab, readRows, replaceRows, updateRange } = require('../config/_sheets_client');
const brands                                            = require('../config/brands');
const sheets                                            = require('../config/sheets');
const { sendCronFailureAlert }                          = require('../_alerts');

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand, G=channel (Amazon / Walmart / Amazon / Walmart)

// CHANGED 2026-08-13 — this file no longer reads Walmart orders (or
// Amazon orders) directly for the 90-day units figures; see
// fetchBrand90dUnits()/fetchBrandWalmart90dUnits() below. Both now read
// UNITS_90D_CACHE_SHEET_ID, populated once daily by the new
// sync-90d-units-cache.js, instead of re-deriving live from the full
// rolling-90-day orders history on every 15-minute run.
const UNITS_90D_CACHE_SHEET_ID = process.env.SHEET_90D_UNITS_CACHE; // must be created + set before deploying — see sync-90d-units-cache.js

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
  // ADDED 2026-08-14 — total SKU volume across all brands grew enough
  // (Cosmette + skinuva-ca added today, dearcloud/creme-shop already
  // large) that splitting into two scheduled invocations, each covering
  // half the brands (config/brands.js's productsSyncGroup field), keeps
  // each run comfortably within its time budget. Every _meta key below is
  // namespaced by group so two groups running on overlapping schedules
  // can NEVER stomp on each other's cursor/completion state — critical,
  // since they'd otherwise both read/write the exact same
  // products_log_cursor key and corrupt each other's progress tracking.
  // Omitting ?group= entirely still works exactly as before (all brands,
  // unsuffixed meta keys) — useful for manual/debug/backfill runs.
  const group = (req.query.group || '').trim().toUpperCase() || null;
  const metaKey = base => group ? `${base}_group${group}` : base;

  let meta;
  try {
    meta = await readMeta();
  } catch (err) {
    await sendCronFailureAlert('sync-products', err.message, { Stage: 'reading _meta tab' });
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  // Brands belonging to this run's group (or every active brand, if no
  // group was specified) — used both to scope ?force=true's clear step
  // and to filter the master SKU list below.
  const scopedBrands = brands.filter(b => b.active && (!group || b.productsSyncGroup === group));
  if (group && scopedBrands.length === 0) {
    return res.status(400).json({ error: `No active brand has productsSyncGroup="${group}" — check config/brands.js` });
  }

  let cursor = 0;
  if (force) {
    // Remove any rows already written for TODAY (across this run's scoped
    // brands only — a group-scoped force run must never touch the OTHER
    // group's brands) before reprocessing. Every other day's history is
    // untouched.
    try {
      await clearRowsForDate(today, scopedBrands);
    } catch (err) {
      await sendCronFailureAlert('sync-products', err.message, { Stage: "clearing today's rows for ?force=true" });
      return res.status(500).json({ error: 'Failed to clear today\'s existing rows before forced re-run', detail: err.message });
    }
    console.log(`[sync-products] force=true${group ? ` (group ${group})` : ''} — cleared today's (${today}) existing rows, restarting from cursor 0`);
  } else if (meta[metaKey('products_log_date')] === today) {
    if (meta[metaKey('products_log_complete')] === 'true') {
      return res.status(200).json({ message: `Already completed for ${today}${group ? ` (group ${group})` : ''}. Pass ?force=true to overwrite today's rows and reprocess (e.g. after a column/logic change).` });
    }
    cursor = parseInt(meta[metaKey('products_log_cursor')] || '0', 10) || 0;
  }
  // else: new day — cursor resets to 0, starting a fresh daily log

  let masterList;
  try {
    masterList = await fetchMasterSkuList();
  } catch (err) {
    await sendCronFailureAlert('sync-products', err.message, { Stage: 'fetching master SKU list' });
    return res.status(500).json({ error: 'Failed to read master SKU list', detail: err.message });
  }

  if (group) {
    const scopedTabNames = new Set(scopedBrands.map(b => b.tabName));
    masterList = masterList.filter(item => scopedTabNames.has(item.brandTabName));
  }

  const totalCount = masterList.length;
  const startTime  = Date.now();
  const nowIso      = new Date().toISOString();

  let processed = 0;
  let i = cursor;
  const tabTokens = {};
  const tabNextRow = {};       // brandTabName -> next row number to write to
  const brand90dMaps = {};     // brandTabName -> { [asin]: unitsSoldLast90d } — see fetchBrand90dUnits
  const walmart90dMaps = {};   // brandTabName -> { [sku]: unitsSoldLast90d }  — see fetchBrandWalmart90dUnits, only populated for sellsOnWalmart SKUs
  const failedSkus = [];

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

      // Walmart side — only fetched for brands that actually have a
      // sellsOnWalmart SKU, and only once per brand (same lazy-cache
      // pattern as the Amazon lookup above). Same failsafe: a failure here
      // never blocks the run, it just leaves the Walmart contribution out
      // of purchased_units_90d for this brand this run.
      if (item.sellsOnWalmart && !(item.brandTabName in walmart90dMaps)) {
        try {
          walmart90dMaps[item.brandTabName] = await fetchBrandWalmart90dUnits(item.brandTabName);
        } catch (err) {
          console.warn(`[sync-products] ${item.brandTabName} — Walmart 90-day units lookup failed, leaving that channel's contribution blank this run:`, err.message);
          walmart90dMaps[item.brandTabName] = {};
        }
      }

      const rowNumber = tabNextRow[item.brandTabName];

      // purchased_units_90d — combined across channels. Amazon side keyed
      // by ASIN (as before); Walmart side keyed by SKU (no ASIN concept on
      // that marketplace). Only combined for SKUs actually flagged as
      // selling on Walmart (master list column G) — everything else is
      // unchanged Amazon-only behavior. Blank only if there's genuinely
      // nothing from either applicable channel, so a real zero from one
      // channel doesn't get masked by a blank from the other.
      const amazonUnits = brand90dMaps[item.brandTabName][item.asin.toUpperCase()];
      let units90d = amazonUnits ?? '';
      if (item.sellsOnWalmart) {
        const walmartUnits = walmart90dMaps[item.brandTabName]?.[item.sku.toUpperCase()];
        if (amazonUnits != null || walmartUnits != null) {
          units90d = (amazonUnits || 0) + (walmartUnits || 0);
        }
      }

      const row = await buildProductRow(item, today, nowIso, rowNumber, units90d);

      // FIXED 2026-08-14 — this used to call appendRows(), which under the
      // hood uses Google's values:append endpoint with
      // insertDataOption=INSERT_ROWS. That endpoint lets SHEETS decide
      // where the row actually lands — but the formulas in buildProductRow
      // (total_quantity, days_of_inventory, qty_on_hand) hardcode this
      // file's OWN `rowNumber` counter, computed once per brand and just
      // incremented in memory. Those two numbers were never guaranteed to
      // match — if Sheets' own table-detection ever placed a row somewhere
      // other than exactly where this file assumed (a stray blank row, a
      // formatting quirk, anything), the formulas would silently reference
      // the WRONG row and compute garbage with no error thrown. Writing to
      // an EXPLICIT range instead removes the ambiguity entirely: the row
      // number embedded in the formula strings IS the literal range being
      // written to, always, by construction — not two systems that are
      // merely supposed to agree.
      const range = `${item.brandTabName}!A${rowNumber}:${COL_QTY_ON_HAND}${rowNumber}`;
      await updateRange(sheets.products, range, [row], tabTokens[item.brandTabName], 'USER_ENTERED');
      tabNextRow[item.brandTabName]++;
      processed++;
    } catch (err) {
      console.error(`[sync-products] ${item.sku} (${item.brandTabName}) failed:`, err.message);
      failedSkus.push(`${item.sku} (${item.brandTabName}): ${err.message}`);
      // Continue to the next SKU — one bad SKU shouldn't stall the whole run.
    }
  }

  const complete = i >= masterList.length;
  try {
    await writeMeta({
      [metaKey('products_log_date')]:     today,
      [metaKey('products_log_cursor')]:   String(i),
      [metaKey('products_log_complete')]: complete ? 'true' : 'false',
    });
  } catch (err) {
    console.warn('[sync-products] failed to update _meta:', err.message);
    // This is the cursor itself — losing this write means tomorrow's run
    // can't tell where today's pass left off. Given the whole reason this
    // schedule was redesigned was a silent cursor problem, a failure here
    // gets an alert every time, not just a log line.
    await sendCronFailureAlert('sync-products', err.message, { Stage: 'persisting cursor to _meta', Group: group || '(none)', Cursor: String(i), 'Total SKUs': String(totalCount) });
  }

  if (failedSkus.length > 0) {
    await sendCronFailureAlert(
      'sync-products',
      failedSkus.slice(0, 20).join('\n') + (failedSkus.length > 20 ? `\n...and ${failedSkus.length - 20} more` : ''),
      { 'SKUs failed this run': String(failedSkus.length), Group: group || '(none)' }
    );
  }

  res.status(200).json({
    date: today,
    group: group || null,
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
    // CONFIRMED 2026-08-12 via the ?testSku diagnostic endpoint against a
    // real ASIN (EVO0001/B08BJBM77V) — item_highlights genuinely does not
    // exist anywhere in the API response (checked listing.attributes,
    // catalog.attributes, AND sfListing.attributes — absent from all
    // three, not just blank). Amazon's real equivalent is
    // title_differentiation: "Clinically tested hair growth serum -
    // FGF5-blocking formula targets thinning hair and postpartum
    // shedding in women and men." — verified by Jaclyn against the
    // actual live listing as matching what Amazon displays as Item
    // Highlights. Column name in the sheet stays item_highlights
    // (matches what the dashboard already reads); only the API source
    // attribute changed.
    listing?.attributes?.title_differentiation?.[0]?.value || '',
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

// FIXED 2026-08-13 — skinuva-ca (config/brands.js) shares "skinuva" as a
// substring of its own id ('skinuva-ca'.includes('skinuva')), so any
// master-list row whose brand column contains "skinuva" satisfied BOTH
// brands' matching conditions below. brands.find() returns the FIRST
// match in array order, and skinuva is listed before skinuva-ca — so
// EVERY skinuva-labeled row, including genuinely Canadian ones, was
// silently attributed to plain skinuva. skinuva-ca was getting zero rows
// from the master list, meaning this cron never synced its inventory or
// listing data at all. Same root cause and same fix as the identical bug
// found in sync-sqp-request.js, sync-orders-process.js, and
// sync-revenue-process.js earlier — disambiguate by the SKU's own "-CA"
// suffix before falling back to brand-name matching.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

function resolveBrandForSku(sku, candidates) {
  if (candidates.length === 1) return candidates[0];
  const isCa    = CA_SKU_PATTERN.test(sku);
  const caBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.ca');
  const usBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.com');
  if (isCa && caBrand) return caBrand;
  if (!isCa && usBrand) return usBrand;
  return usBrand || candidates[0];
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
    // Column G — channel. Values seen: "Amazon", "Walmart", "Amazon / Walmart".
    // Only SKUs whose channel mentions Walmart get a Walmart 90d units lookup;
    // everyone else behaves exactly as before (Amazon-only).
    const rawChannel     = (cols[6] || '').trim();
    const channelNorm    = stripAccents(rawChannel.toLowerCase());
    const sellsOnWalmart = channelNorm.includes('walmart');

    if (!asin || !sku) continue;
    if (sku.toUpperCase().startsWith('C-SVA')) continue; // website-only inventory, not Amazon
    if (EXCLUDED_BRAND_NAMES.some(x => brandNorm.includes(x))) continue;

    const nameMatched = brands.find(b =>
      b.active && (
        brandNorm === stripAccents(b.id.toLowerCase()) ||
        brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
        brandNorm.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (!nameMatched) {
      console.log(`[sync-products] unmatched brand in master sheet: "${rawBrand}" (asin ${asin}) — skipped`);
      continue;
    }
    // Name matching alone can't distinguish skinuva from skinuva-ca — the
    // master sheet almost certainly labels both "skinuva" regardless of
    // marketplace (it's the same company brand), and skinuva-ca's id can
    // never satisfy brandNorm.includes('skinuva-ca') when brandNorm is
    // just "skinuva" (a shorter string can't contain a longer one). Instead,
    // find the real sibling set via shared SKU PREFIX (not name), then
    // disambiguate those siblings using the SKU's own "-CA" suffix.
    const siblings = brands.filter(b =>
      b.active && b.skuPrefix && nameMatched.skuPrefix && b.skuPrefix === nameMatched.skuPrefix
    );
    const matched = siblings.length > 1 ? resolveBrandForSku(sku, siblings) : nameMatched;

    out.push({ asin, sku, name, brandTabName: matched.tabName, sellsOnWalmart });
  }
  return out;
}

// CHANGED 2026-08-13 — these two functions used to re-read each brand's
// FULL orders history live, on every single 15-minute run (36x/day). For
// a brand like skinuva (~7,200 rows) or creme-shop (~6,800 rows), that
// was a genuinely large read repeated far more often than the underlying
// number actually changes — this figure only meaningfully shifts day to
// day, not minute to minute. sync-90d-units-cache.js now does this exact
// same computation once daily and writes the result to a small
// pre-computed cache tab; these functions just read that cache instead.
// Return shape is UNCHANGED ({ [asin]: units } / { [sku]: units }), so
// every caller of these two functions works exactly as before — only the
// data source moved, not the interface.
async function fetchBrand90dUnits(brandTabName) {
  const rows = await readRows(UNITS_90D_CACHE_SHEET_ID, brandTabName).catch(err => {
    console.warn(`[sync-products] ${brandTabName} — 90-day units cache read failed (leaving purchased_units_90d blank this run): ${err.message}`);
    return [];
  });
  const map = {};
  (rows || []).forEach(r => {
    if ((r.type || '').toLowerCase() !== 'amazon') return;
    const key = (r.key || '').trim().toUpperCase();
    if (!key) return;
    map[key] = parseInt(r.units_90d, 10) || 0;
  });
  return map;
}

// Walmart counterpart — same cache tab, filtered to the 'walmart' rows
// (keyed by SKU, since Walmart has no ASIN concept). Only called for
// brands that have at least one sellsOnWalmart SKU, and only once per
// brand per run (cached by the caller), same as the Amazon lookup.
async function fetchBrandWalmart90dUnits(brandTabName) {
  const rows = await readRows(UNITS_90D_CACHE_SHEET_ID, brandTabName).catch(err => {
    console.warn(`[sync-products] ${brandTabName} — 90-day Walmart units cache read failed (leaving that channel's contribution blank this run): ${err.message}`);
    return [];
  });
  const map = {};
  (rows || []).forEach(r => {
    if ((r.type || '').toLowerCase() !== 'walmart') return;
    const key = (r.key || '').trim().toUpperCase();
    if (!key) return;
    map[key] = parseInt(r.units_90d, 10) || 0;
  });
  return map;
}

// Removes every row matching `dateStr` from every brand tab in `brandList`
// (defaults to every active brand), leaving all other dates' history
// untouched. Used by ?force=true to support "overwrite today" without
// duplicating rows or losing history. ADDED 2026-08-14: accepts an
// explicit brand list so a group-scoped ?force=true run only clears that
// group's brands, never the other group's.
async function clearRowsForDate(dateStr, brandList = brands.filter(b => b.active)) {
  for (const brand of brandList) {
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
