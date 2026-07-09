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
 *   offers, issues, last_synced
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
];

const EXCLUDED_BRAND_NAMES = ['high on love']; // different seller account entirely

const TIME_BUDGET_MS = 250_000; // stay safely under Vercel's 300s cap
const INTER_SKU_DELAY_MS = 1200; // conservative default — see rate-limiting note above

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let meta;
  try {
    meta = await readMeta();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  let cursor = 0;
  if (meta.products_log_date === today) {
    if (meta.products_log_complete === 'true') {
      return res.status(200).json({ message: `Already completed for ${today}` });
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

  for (; i < masterList.length; i++) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    if (i > cursor) await sleep(INTER_SKU_DELAY_MS);

    const item = masterList[i];
    try {
      const row = await buildProductRow(item, today, nowIso);

      if (!tabTokens[item.brandTabName]) {
        tabTokens[item.brandTabName] = await ensureTab(sheets.products, item.brandTabName, HEADERS);
      }
      await appendRows(sheets.products, item.brandTabName, [row], tabTokens[item.brandTabName]);
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

async function buildProductRow(item, dateStr, nowIso) {
  const { sku, asin, name } = item;

  const [listing, inventory, catalog] = await Promise.all([
    fetchListing(sku).catch(err => ({ __error: err.message })),
    fetchInventory(sku).catch(err => ({ __error: err.message })),
    fetchCatalog(asin).catch(err => ({ __error: err.message })),
  ]);

  const inv = inventory?.payload?.inventorySummaries?.[0]?.inventoryDetails || {};
  const totalQuantity = inventory?.payload?.inventorySummaries?.[0]?.totalQuantity ?? '';

  // Merchant-fulfilled (seller-fulfilled) stock — comes from the SAME
  // Listings API call, under the "DEFAULT" fulfillment channel, distinct
  // from FBA's "AMAZON_NA" channel. No separate API call needed.
  const fulfillmentAvailability = listing?.attributes?.fulfillment_availability || [];
  const defaultChannel = fulfillmentAvailability.find(f => f.fulfillment_channel_code === 'DEFAULT');
  const sellerFulfilledQuantity = defaultChannel?.quantity ?? '';

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
    totalQuantity,
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
