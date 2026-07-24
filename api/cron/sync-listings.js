/**
 * api/cron/sync-listings.js
 * Runs weekly — pulls live listing copy from Amazon SP-API for all évolis SKUs.
 * Writes to SHEET_LISTINGS (one tab, one row per SKU, replaces on each run).
 *
 * SP-API endpoint: GET /listings/2021-08-01/items/{sellerId}/{sku}
 * includedData: attributes, summaries, issues
 *
 * Fields pulled:
 *   title          ← attributes.item_name[0].value
 *   item_highlights← attributes.item_overview[0].value  (Hair Care field name)
 *                    fallback: product_overview, item_type_keyword
 *   bullet_1–5     ← attributes.bullet_point[0–4].value
 *   description    ← attributes.product_description[0].value
 *   backend_keywords← attributes.generic_keyword[0].value
 *   status         ← summaries[0].status
 *   issues         ← issues[].message joined
 *
 * Sheet: SHEET_LISTINGS | Tab: evolis (one row per SKU, full replace on each run)
 * Schedule: weekly Sunday at 02:00 UTC ("0 2 * * 0")
 *
 * Debug mode: GET /api/cron/sync-listings?debug=EVO0001
 *   Returns raw SP-API attributes for that SKU so you can confirm field names.
 */

const { spRequest }                       = require('../_spauth');
const { ensureTab, replaceRows, readRows } = require('../config/_sheets_client');
const { sendCronFailureAlert }             = require('../_alerts');

const SELLER_ID    = process.env.SP_SELLER_ID;
const MARKETPLACE  = process.env.SP_MARKETPLACE_ID || 'ATVPDKIKX0DER';
const SHEET_ID     = process.env.SHEET_LISTINGS;
const TAB_NAME     = 'evolis';

const HEADERS = [
  'sku', 'asin', 'name', 'status',
  'title', 'item_highlights',
  'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5',
  'description', 'backend_keywords',
  'ingredients', 'item_type_keyword', 'issues', 'last_synced'
];

// All active évolis SKUs — SKU must match exactly what's in Seller Central
const EVOLIS_SKUS = [
  { sku: 'EVO0001', asin: 'B08BJBM77V', name: 'Reverse Activator' },
  { sku: 'EVO0005', asin: 'B07SG6S4VV', name: 'Promote Activator' },
  { sku: 'EVO0009', asin: 'B08BJCP9TV', name: 'Prevent Activator' },
  { sku: 'EVO0002', asin: 'B08BJBKY8N', name: 'Reverse Shampoo' },
  { sku: 'EVO0006', asin: 'B07SG8KM44', name: 'Promote Shampoo' },
  { sku: 'EVO0010', asin: 'B08BJCM6YH', name: 'Prevent Shampoo' },
  { sku: 'EVO0014', asin: 'B0C625D751', name: 'Reverse Shampoo Travel' },
  { sku: 'EVO0016', asin: 'B0C62SD751', name: 'Promote Shampoo Travel' },
  { sku: 'EVO0003', asin: 'B08BJBRP6H', name: 'Reverse Conditioner' },
  { sku: 'EVO0007', asin: 'B07SGBN7LK', name: 'Promote Conditioner' },
  { sku: 'EVO0011', asin: 'B08BJCNK8Q', name: 'Prevent Conditioner' },
  { sku: 'EVO0015', asin: 'B0C62RQGVX', name: 'Reverse Conditioner Travel' },
  { sku: 'EVO0017', asin: 'B0C62SD8BQ', name: 'Promote Conditioner Travel' },
  { sku: 'EVO0004', asin: 'B0CQSXSHZT', name: 'Reverse Mask' },
  { sku: 'EVO0008', asin: 'B0DC82QRGVX', name: 'Promote Mask' },
  { sku: 'EVO0018', asin: 'B0DC82RGV1', name: 'Promote Mask Travel' },
  { sku: 'EVO0019', asin: 'B0CQSXSHBZ', name: 'Reverse Mask Travel' },
  { sku: 'EVO0012', asin: 'B08BGCRKTV', name: 'Dry Shampoo' },
];

// Item Highlights is NOT returned by the SP-API Listings Items endpoint
// for this product type (TOPICAL_HAIR_REGROWTH_TREATMENT).
// The field will be left blank — populated via the listing audit process instead.

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SELLER_ID) {
    await sendCronFailureAlert('sync-listings', 'SP_SELLER_ID not set');
    return res.status(500).json({ error: 'SP_SELLER_ID not set' });
  }
  if (!SHEET_ID) {
    await sendCronFailureAlert('sync-listings', 'SHEET_LISTINGS not set');
    return res.status(500).json({ error: 'SHEET_LISTINGS not set' });
  }

  // ── Debug mode: return raw attributes for one SKU ──────────────────────────
  const debugSku = req.query.debug;
  if (debugSku) {
    const skuMeta = EVOLIS_SKUS.find(s => s.sku === debugSku);
    if (!skuMeta) return res.status(400).json({ error: `SKU ${debugSku} not in list` });
    try {
      const data = await fetchListingItem(skuMeta.sku);
      return res.status(200).json({
        sku: skuMeta.sku,
        rawAttributeKeys: Object.keys(data.attributes || {}),
        attributes: data.attributes,
        summaries: data.summaries,
        issues: data.issues,
      });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Full sync ──────────────────────────────────────────────────────────────
  console.log(`[sync-listings] Starting sync for ${EVOLIS_SKUS.length} SKUs`);

  const rows = [];
  const errors = [];
  const now = new Date().toISOString();

  for (const skuMeta of EVOLIS_SKUS) {
    try {
      const data = await fetchListingItem(skuMeta.sku);
      const attrs = data.attributes || {};
      const summary = (data.summaries || [])[0] || {};

      // Extract fields
      const title       = getAttr(attrs, 'item_name');
      const ih          = getItemHighlights(attrs);
      const bullets     = getBullets(attrs);
      const description  = getAttr(attrs, 'product_description');
      const ingredients       = getAttr(attrs, 'ingredients');
      const itemTypeKeyword  = getAttr(attrs, 'item_type_keyword');
      const backend     = getAttr(attrs, 'generic_keyword');
      const status      = Array.isArray(summary.status)
        ? summary.status.join(', ')
        : (summary.status || 'UNKNOWN');
      const issuesList  = (data.issues || []).map(i => i.message).join(' | ').slice(0, 500);

      rows.push([
        skuMeta.sku,
        skuMeta.asin,
        skuMeta.name,
        status,
        title,
        ih,
        bullets[0] || '',
        bullets[1] || '',
        bullets[2] || '',
        bullets[3] || '',
        bullets[4] || '',
        description,
        backend,
        ingredients,
        itemTypeKeyword,
        issuesList,
        now,
      ]);

      console.log(`[sync-listings] ✓ ${skuMeta.sku} — status:${status} title:${title.slice(0,40)}...`);

      // Rate limit: 1 request/second for Listings Items (burst 5)
      await sleep(1200);

    } catch(err) {
      console.error(`[sync-listings] ✗ ${skuMeta.sku}: ${err.message}`);
      errors.push({ sku: skuMeta.sku, error: err.message });
      // Still write a row with what we know so the sheet stays complete
      rows.push([
        skuMeta.sku, skuMeta.asin, skuMeta.name,
        'ERROR', '', '', '', '', '', '', '', '', '', '', '',
        err.message.slice(0, 200), now
      ]);
    }
  }

  // ── Write to sheet — full replace (one row per SKU) ───────────────────────
  try {
    const token = await ensureTab(SHEET_ID, TAB_NAME, HEADERS);
    await replaceRows(SHEET_ID, TAB_NAME, HEADERS, rows, token);
    console.log(`[sync-listings] Wrote ${rows.length} rows to ${TAB_NAME}`);
  } catch(err) {
    console.error('[sync-listings] Sheet write failed:', err.message);
    await sendCronFailureAlert('sync-listings', err.message, { Stage: 'writing evolis tab' });
    return res.status(500).json({ error: 'Sheet write failed', detail: err.message });
  }

  if (errors.length > 0) {
    await sendCronFailureAlert(
      'sync-listings',
      errors.map(e => `${e.sku}: ${e.error}`).join('\n'),
      { 'SKUs failed': `${errors.length} of ${EVOLIS_SKUS.length}` }
    );
  }

  return res.status(200).json({
    ok: true,
    synced: rows.length - errors.length,
    errors: errors.length,
    errorDetails: errors,
    timestamp: now,
  });
};

// ── SP-API fetch ──────────────────────────────────────────────────────────────
async function fetchListingItem(sku) {
  const path = `/listings/2021-08-01/items/${encodeURIComponent(SELLER_ID)}/${encodeURIComponent(sku)}`;
  const params = {
    marketplaceIds: MARKETPLACE,
    includedData:   'attributes,summaries,issues',
  };
  const resp = await spRequest('GET', path, params);
  // spRequest throws on non-2xx, so if we get here it succeeded
  return resp;
}

// ── Attribute helpers ─────────────────────────────────────────────────────────
function getAttr(attrs, fieldName) {
  const val = attrs[fieldName];
  if (!val) return '';
  if (Array.isArray(val)) return (val[0] && val[0].value) ? String(val[0].value) : '';
  if (typeof val === 'string') return val;
  if (val.value) return String(val.value);
  return '';
}

function getItemHighlights(attrs) {
  // Item Highlights is not returned by the SP-API Listings Items endpoint
  // for TOPICAL_HAIR_REGROWTH_TREATMENT product type.
  // Return empty — populated via listing audit process.
  return '';
}

function getBullets(attrs) {
  const bullets = attrs['bullet_point'];
  if (!bullets || !Array.isArray(bullets)) return ['','','','',''];
  return bullets.slice(0, 5).map(b => (b && b.value) ? String(b.value) : '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
