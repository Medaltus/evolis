/**
 * api/cleanup-duplicate-product-rows.js
 *
 * REPURPOSED 2026-08-31 per Jaclyn — this file previously cleaned up
 * duplicate (date, sku) rows caused by the resumable-cursor bug fixed
 * the same day in sync-products.js (see that file's own 2026-08-31
 * comment for the full story). That cleanup already ran successfully.
 * Filename kept as-is deliberately (reusing the already-deployed Vercel
 * route rather than standing up a new one) — the contents below no
 * longer have anything to do with duplicates.
 *
 * NEW PURPOSE — ONE-OFF, manually-triggered cleanup that removes
 * SHEET_PRODUCTS rows for SKUs that are NOT currently marked "LIVE"
 * (master SKU list, column H — "Status"). sync-products.js was fixed
 * the same day to stop SYNCING non-LIVE SKUs going forward (see that
 * file's own "ADDED 2026-08-31" comment), but that fix is forward-only —
 * it doesn't retroactively remove rows already written for SKUs that
 * have since been discontinued/deleted. This script is that one-time
 * backfill cleanup, and reuses the EXACT SAME master-list fetch, brand-
 * matching, and status-filtering logic sync-products.js uses — not a
 * simplified reimplementation — so this script's definition of "live"
 * can never quietly disagree with what the sync cron itself considers
 * live.
 *
 * Writes nothing until dryRun=false is explicitly passed — defaults to
 * a safe preview.
 *
 * Usage:
 *   GET /api/cleanup-duplicate-product-rows?dryRun=true
 *   Authorization: Bearer <CRON_SECRET>
 *   &brand=creme-shop   — restrict to one brand (omit to check every active brand)
 *   &dryRun=false       — actually remove rows for non-LIVE SKUs (default true, preview only)
 */

const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const brandsConfig                         = require('./config/brands');
const sheets                               = require('./config/sheets');

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand, G=channel, H=status

const EXCLUDED_BRAND_NAMES = ['high on love']; // different seller account entirely — same exclusion sync-products.js uses

// Must match sync-products.js's real, current header shape exactly —
// duplicated here deliberately, matching how every other one-off
// cleanup script in this project keeps its own explicit HEADERS
// constant instead of trying to share one.
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

// Same disambiguation helper sync-products.js uses — copied verbatim,
// not reinvented, so skinuva-ca vs skinuva (and any future brand sharing
// a SKU prefix) resolves identically here as it does in the real sync.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function resolveBrandForSku(sku, candidates) {
  if (candidates.length === 1) return candidates[0];
  const isCa    = CA_SKU_PATTERN.test(sku);
  const caBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.ca');
  const usBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.com');
  if (isCa && caBrand) return caBrand;
  if (!isCa && usBrand) return usBrand;
  return usBrand || candidates[0];
}

// Same parsing + filtering as sync-products.js's fetchMasterSkuList(),
// but returns a Set of currently-LIVE SKUs per brand tab, rather than
// the full item list that cron needs for its own sync work.
async function fetchLiveSkusByBrand() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp   = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master SKU list: ${resp.status}`);
  const csv   = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  const liveSkusByBrand = {}; // brandTabName -> Set of live SKUs (uppercased)

  for (const line of lines) {
    const cols     = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const asin     = cols[0] || '';
    const sku      = cols[1] || '';
    const rawBrand = (cols[3] || '').trim();
    const brandNorm = stripAccents(rawBrand.toLowerCase());
    const rawStatus = (cols[7] || '').trim();

    if (rawStatus.toUpperCase() !== 'LIVE') continue;
    if (!asin || !sku) continue;
    if (sku.toUpperCase().startsWith('C-SVA')) continue; // website-only inventory, not Amazon
    if (EXCLUDED_BRAND_NAMES.some(x => brandNorm.includes(x))) continue;

    const nameMatched = brandsConfig.find(b =>
      b.active && (
        brandNorm === stripAccents(b.id.toLowerCase()) ||
        brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
        brandNorm.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (!nameMatched) continue;

    const siblings = brandsConfig.filter(b =>
      b.active && b.skuPrefix && nameMatched.skuPrefix && b.skuPrefix === nameMatched.skuPrefix
    );
    const matched = siblings.length > 1 ? resolveBrandForSku(sku, siblings) : nameMatched;

    if (!liveSkusByBrand[matched.tabName]) liveSkusByBrand[matched.tabName] = new Set();
    liveSkusByBrand[matched.tabName].add(sku.trim().toUpperCase());
  }

  return liveSkusByBrand;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun    = req.query.dryRun !== 'false'; // default true — safe preview
  const onlyBrand = req.query.brand || null;

  let liveSkusByBrand;
  try {
    liveSkusByBrand = await fetchLiveSkusByBrand();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch master SKU list', detail: err.message });
  }

  const activeBrands = brandsConfig.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));
  const results = [];

  for (const brand of activeBrands) {
    try {
      const liveSkus = liveSkusByBrand[brand.tabName] || new Set();
      if (liveSkus.size === 0) {
        // Genuinely no LIVE SKUs found for this brand on the master list
        // at all — almost certainly a brand-matching or master-list
        // problem, not "this brand has zero live products." Refusing to
        // touch this brand's tab rather than risk wiping it entirely on
        // a false signal.
        results.push({ brand: brand.id, status: 'skipped', reason: 'zero LIVE SKUs found on master list for this brand — refusing to risk wiping the whole tab' });
        continue;
      }

      const token = await ensureTab(sheets.products, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.products, brand.tabName);

      if (!existingRows || existingRows.length === 0) {
        results.push({ brand: brand.id, status: 'ok', totalRows: 0, removed: 0 });
        continue;
      }

      const kept = [];
      const removedSkus = new Set();
      let removedCount = 0;

      existingRows.forEach(r => {
        const sku = (r.sku || '').trim().toUpperCase();
        if (!sku || liveSkus.has(sku)) {
          kept.push(r); // no SKU at all (leave untouched) or genuinely live
        } else {
          removedCount++;
          removedSkus.add(sku);
        }
      });

      if (removedCount > 0 && !dryRun) {
        const outRows = kept.map(r => HEADERS.map(h => r[h] ?? ''));
        await replaceRows(sheets.products, brand.tabName, HEADERS, outRows, token);
      }

      console.log(`[cleanup-non-live-product-rows] ${brand.id} — ${removedCount} row(s) removed across ${removedSkus.size} non-LIVE SKU(s), of ${existingRows.length} total${dryRun ? ' [DRY RUN — nothing written]' : ''}`);
      results.push({
        brand: brand.id,
        status: 'ok',
        totalRows: existingRows.length,
        removed: removedCount,
        distinctNonLiveSkus: removedSkus.size,
        sampleNonLiveSkus: Array.from(removedSkus).slice(0, 20),
      });
    } catch (err) {
      console.error(`[cleanup-non-live-product-rows] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const totalRemoved = results.reduce((s, r) => s + (r.removed || 0), 0);
  res.status(200).json({ dryRun, totalRemoved, results });
};
