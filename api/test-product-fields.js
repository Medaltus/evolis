/**
 * api/test-product-fields.js
 * ONE-OFF DIAGNOSTIC — not a cron. Pulls REAL data from the two APIs that
 * actually have what sync-products.js needs to be rebuilt around:
 *
 *   Listings Items API   — title, bullet points, description, images,
 *                           and other full listing content, keyed by SKU.
 *   FBA Inventory API    — sellable/reserved/inbound inventory levels,
 *                           keyed by SKU.
 *
 * (The current sync-products.js calls neither of these — it derives
 * "products" from order line items, which is why it has no listing
 * content or inventory data at all, and why it's slow enough to time out.)
 *
 * Uses one real SKU pulled from the master ASIN→brand sheet (same one
 * sync-advertising-process.js and sync-subscriptions.js already read) so
 * there's a real, known-good SKU to test against without guessing one.
 *
 * DELETE this file once sync-products.js is rebuilt and confirmed working.
 *
 * GET or POST /api/test-product-fields?brand=evolis
 * Authorization: Bearer <CRON_SECRET>
 */

const { spRequest } = require('./_spauth');
const brands         = require('./config/brands');

const PRODUCT_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const PRODUCT_SHEET_GID = '164358627';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const brandId = req.query.brand || 'evolis';
  const brand   = brands.find(b => b.id === brandId);
  if (!brand) return res.status(400).json({ error: `Unknown brand id "${brandId}"` });

  try {
    const { sku, asin } = req.query.sku
      ? { sku: req.query.sku, asin: req.query.asin || null }
      : await findOneSkuForBrand(brand.tabName);

    if (!sku) return res.status(400).json({ error: `No SKU found for brand "${brandId}" in the master sheet. Pass ?sku=... explicitly.` });

    console.log(`[test-product-fields] using sku=${sku} asin=${asin || '(unknown)'}`);

    const results = {};

    // ── Listings Items API — full listing content ────────────────────────
    try {
      results.listingsItemsApi = await spRequest(
        'GET',
        `/listings/2021-08-01/items/${process.env.SP_SELLER_ID}/${encodeURIComponent(sku)}`,
        {
          marketplaceIds: process.env.SP_MARKETPLACE_ID,
          includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability,procurement',
        }
      );
    } catch (err) {
      results.listingsItemsApi = { error: err.message };
    }

    // ── FBA Inventory API — inventory levels ──────────────────────────────
    try {
      results.fbaInventoryApi = await spRequest(
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
    } catch (err) {
      results.fbaInventoryApi = { error: err.message };
    }

    // ── Catalog Items API — bonus: ASIN-level catalog data (sales rank,
    //    images, product type) in case it's useful alongside the above ──
    if (asin) {
      try {
        results.catalogItemsApi = await spRequest(
          'GET',
          `/catalog/2022-04-01/items/${asin}`,
          {
            marketplaceIds: process.env.SP_MARKETPLACE_ID,
            includedData:   'attributes,images,productTypes,salesRanks,summaries,dimensions',
          }
        );
      } catch (err) {
        results.catalogItemsApi = { error: err.message };
      }
    }

    return res.status(200).json({ brand: brandId, sku, asin, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Strips accents so "évolis" matches "evolis" regardless of exact casing —
// same fix already applied to sync-advertising-process.js's brand matching.
function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Pulls one real SKU (+ its ASIN if present) for a brand from the master
// ASIN→brand sheet, so this test doesn't need a hand-typed SKU to start.
async function findOneSkuForBrand(tabName) {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${PRODUCT_SHEET_ID}/export?format=csv&gid=${PRODUCT_SHEET_GID}`;
  const resp   = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master ASIN sheet: ${resp.status}`);
  const csv   = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  for (const line of lines) {
    const cols      = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const asin      = cols[0] || '';
    const sku       = cols[1] || '';
    const brandName = stripAccents((cols[3] || '').toLowerCase().trim());
    if (!sku) continue;
    const matched = brands.find(b =>
      b.active && (
        brandName === stripAccents(b.id.toLowerCase()) ||
        brandName === stripAccents((b.displayName || '').toLowerCase()) ||
        brandName.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (matched && matched.tabName === tabName) return { sku, asin };
  }
  return { sku: null, asin: null };
}
