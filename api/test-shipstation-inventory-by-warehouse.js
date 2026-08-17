/**
 * api/test-shipstation-inventory-by-warehouse.js
 * ONE-OFF diagnostic — directly queries ShipStation's real /v2/inventory
 * endpoint (the same one sync-consignment-inventory.js uses for
 * MiGuard/Prohibition/High On Love) using the four GENERAL warehouse IDs
 * just discovered via /v2/warehouses for évolis, Hillside, Just Bjorn,
 * and Skinuva.
 *
 * WHY THIS TEST, NOT ANOTHER LISTING CALL: /v2/inventory_warehouses (the
 * endpoint the working cron's comment says discovered its 3 IDs) returned
 * ZERO results when tested 2026-08-17, despite those 3 IDs still being
 * independently confirmed accurate (MiGuard's se-157240 matched
 * ShipStation's own product page exactly: 1,159 = 1,159). That strongly
 * suggests "inventory warehouses" and "general warehouses" (the ones
 * /v2/warehouses returns) may be two separate ID spaces — untested
 * whether they happen to overlap for these 4 brands. Rather than guess,
 * this queries the real inventory endpoint directly with each ID and
 * reports back real data, empty results, or an error for each —
 * conclusive either way.
 *
 * Writes nothing anywhere.
 *
 * Usage:
 *   GET /api/test-shipstation-inventory-by-warehouse
 *   Authorization: Bearer <CRON_SECRET>
 */

const SS_V2_BASE = 'https://api.shipstation.com';

const CANDIDATES = [
  { brandId: 'evolis',      warehouseId: 'se-749942' },
  { brandId: 'hillside',    warehouseId: 'se-856130' },
  { brandId: 'just-bjorn',  warehouseId: 'se-843506' },
  { brandId: 'skinuva',     warehouseId: 'se-237056' },
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ssToken = process.env.SS_V2_TOKEN;
  if (!ssToken) {
    return res.status(500).json({ error: 'Missing SS_V2_TOKEN env var' });
  }

  const results = {};

  for (const { brandId, warehouseId } of CANDIDATES) {
    try {
      const url = `${SS_V2_BASE}/v2/inventory?inventory_warehouse_id=${warehouseId}&limit=25`;
      const resp = await fetch(url, {
        headers: { 'API-Key': ssToken, 'Content-Type': 'application/json' },
      });
      const bodyText = await resp.text();
      let body;
      try { body = JSON.parse(bodyText); } catch { body = { rawText: bodyText.slice(0, 500) }; }

      if (!resp.ok) {
        results[brandId] = { warehouseId, status: resp.status, ok: false, body };
        continue;
      }

      const inventory = body.inventory || [];
      results[brandId] = {
        warehouseId,
        status: resp.status,
        ok: true,
        totalCount: body.total ?? inventory.length,
        sampleRows: inventory.slice(0, 10),
      };
    } catch (err) {
      results[brandId] = { warehouseId, ok: false, error: err.message };
    }
  }

  res.status(200).json({
    results,
    note: 'For each brand: totalCount > 0 with real sampleRows means this warehouse ID genuinely works for the Inventory API — ShipStation IS tracking a separate inventory number for this brand, worth reconciling against Core. totalCount: 0 or an empty inventory array most likely means ShipStation is not tracking inventory for this warehouse at all (just processing shipments without a tracked count) — nothing to reconcile. A non-200 status means the ID itself is invalid for the Inventory API specifically, confirming general warehouses and inventory warehouses are separate ID spaces.',
  });
};
