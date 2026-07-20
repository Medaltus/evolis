/**
 * api/cron/sync-consignment-inventory.js
 * Single-step cron (no request/process split needed — ShipStation V2's
 * inventory endpoint is synchronous, unlike Amazon's async report APIs
 * everything else in this repo deals with).
 *
 * Fetches on-hand/available consignment inventory from ShipStation V2 for
 * MiGuard and Prohibition (each has its own dedicated warehouse — they do
 * NOT share one), cross-references against the master SKU list so a SKU
 * ShipStation doesn't return still shows up with 0/0 rather than silently
 * missing.
 *
 * WHY THE MASTER-LIST CROSS-REFERENCE MATTERS: confirmed via a working
 * inventory-sync cron from a sibling project (Dazzle Dry) that ShipStation
 * V2's /v2/inventory endpoint appears to OMIT SKUs with zero stock
 * entirely, rather than returning them with a 0. Without this
 * cross-reference, a SKU going out of stock would look identical to "not
 * in ShipStation at all" — and worse, if this feeds the same
 * Out-of-Stock-Log logic built for the Amazon side, a missing row reads
 * as "no data this run," not "confirmed zero" — exactly backwards for a
 * SKU that just went OOS.
 *
 * High On Love is deliberately NOT included yet — not in config/brands.js
 * at all (different Amazon seller account), and explicitly deferred by
 * Jaclyn until after the Évolis dashboard is fully built (2026-07-20).
 * Its warehouse (se-154551) is known for whenever this gets picked up.
 *
 * Sheet: SHEET_CONSIGNMENT_INVENTORY, one tab per brand.
 * Columns: sku, name, on_hand, available, last_updated
 * Full clear-and-rewrite per run (same as the Dazzle Dry reference cron)
 * — this is a current-state snapshot, not a daily history log like
 * sync-products.js. If historical OOS tracking is wanted for consignment
 * later, that would need a date column + row-per-day design, same as the
 * Amazon-side Out-of-Stock Log — not built here, flagging as a possible
 * future ask rather than assuming it's wanted now.
 *
 * Runs manually for now — add to vercel.json once confirmed working.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets = require('../config/sheets');

const SS_V2_BASE = 'https://api.shipstation.com';

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand

const HEADERS = ['sku', 'name', 'on_hand', 'available', 'last_updated'];

// Each brand has its OWN warehouse — confirmed via GET /v2/inventory_warehouses,
// 2026-07-20. They do NOT share one, so this is two separate fetches, not
// one fetch split by brand.
//
// HighOnLove (se-154551) is NOT included yet — still needs: (1) its SKU
// prefix, (2) confirmation of whether a master SKU list exists for it to
// cross-reference against (it's on a separate Amazon seller account, so
// the Newderm master list almost certainly doesn't cover it). Add it here
// once both are known — see fetchMasterSkuListFor() below for how the
// cross-reference would need to change if there's no master list for it.
const CONSIGNMENT_BRANDS = [
  { brandId: 'miguard',     warehouseId: 'se-157240', skuPrefix: 'MIG', tabName: 'miguard' },
  { brandId: 'prohibition', warehouseId: 'se-173781', skuPrefix: 'PRB', tabName: 'prohibition' },
  // { brandId: 'high-on-love', warehouseId: 'se-154551', skuPrefix: '???', tabName: 'high-on-love' }, // pending prefix + master-list confirmation
];

// Consignment SKUs in ShipStation always carry a "C-" prefix over the base
// SKU (e.g. ShipStation's "C-MIG0001" = master list's "MIG0001"). Stripped
// here so everything downstream — the cross-reference match AND the
// written output — uses the same base SKU form the rest of the dashboard
// already uses (needed for the eventual Inventory-page merge to be a
// plain SKU-to-SKU join, no transformation at merge time).
function stripConsignmentPrefix(sku) {
  return String(sku || '').replace(/^C-/i, '').trim();
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ssToken = process.env.SS_V2_TOKEN;
  if (!ssToken) return res.status(500).json({ error: 'Missing SS_V2_TOKEN' });
  if (!sheets.consignmentInventory) return res.status(500).json({ error: 'sheets.consignmentInventory is not configured in config/sheets.js' });

  const now = new Date().toISOString();

  let masterSkus;
  try {
    masterSkus = await fetchMasterSkuList();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read master SKU list', detail: err.message });
  }

  const results = [];

  for (const { brandId, warehouseId, skuPrefix, tabName } of CONSIGNMENT_BRANDS) {
    try {
      const inventory = await fetchAllInventory(ssToken, warehouseId);
      const ssMap = {};
      inventory.forEach(x => {
        const baseSku = stripConsignmentPrefix(x.sku);
        if (baseSku) ssMap[baseSku] = x;
      });

      const rows = Object.entries(ssMap).map(([baseSku, x]) => [baseSku, x.name || baseSku, x.on_hand ?? 0, x.available ?? 0, now]);

      // Cross-reference: any of THIS brand's master-list SKUs missing from
      // ShipStation's response is a confirmed zero, not a gap in our data.
      // NOTE: this assumes ShipStation's SKU strings, once the "C-" prefix
      // is stripped, match the master list's SKU strings exactly — same
      // assumption the Dazzle Dry reference cron makes for its own SKUs.
      // Unverified for these two brands specifically. If matching turns
      // out to be off, most/all SKUs will show as "missing" here and that
      // mismatch will be obvious immediately.
      let zeroAdded = 0;
      masterSkus
        .filter(m => m.sku.toUpperCase().startsWith(skuPrefix.toUpperCase()))
        .forEach(({ sku, name }) => {
          if (ssMap[sku]) return;
          rows.push([sku, name || sku, 0, 0, now]);
          zeroAdded++;
        });

      rows.sort((a, b) => {
        const aOut = a[3] === 0 ? 0 : 1;
        const bOut = b[3] === 0 ? 0 : 1;
        if (aOut !== bOut) return aOut - bOut;
        return String(a[0]).localeCompare(String(b[0]));
      });

      const token = await ensureTab(sheets.consignmentInventory, tabName, HEADERS);
      await replaceRows(sheets.consignmentInventory, tabName, HEADERS, rows, token);

      console.log(`[sync-consignment-inventory] ${brandId} — ${inventory.length} from ShipStation, ${zeroAdded} zero-stock added from master list`);
      results.push({ brand: brandId, status: 'ok', fromShipStation: inventory.length, zeroAdded, totalRows: rows.length });
    } catch (err) {
      console.error(`[sync-consignment-inventory] ${brandId} failed:`, err.message);
      results.push({ brand: brandId, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ synced: results, timestamp: now });
};

// ── ShipStation ─────────────────────────────────────────────────────────

async function fetchAllInventory(token, warehouseId) {
  let all = [];
  let url = `${SS_V2_BASE}/v2/inventory?inventory_warehouse_id=${warehouseId}&limit=100`;
  while (url) {
    const res = await fetch(url, { headers: { 'API-Key': token, 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`ShipStation V2 inventory HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    all = all.concat(data.inventory || []);
    url = data.links?.next?.href || null;
  }
  return all;
}

// ── Master SKU list — same source sync-products.js uses for `name` ──────

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
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const sku  = cols[1] || '';
    const name = cols[2] || '';
    if (!sku) continue;
    out.push({ sku, name });
  }
  return out;
}
