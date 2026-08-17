/**
 * api/test-shipstation-warehouses.js
 * ONE-OFF diagnostic — lists every ShipStation warehouse on the account,
 * so we can find warehouse IDs for évolis, Hillside, Just Bjorn, and
 * Skinuva (the four brands Jaclyn confirmed are Core-tracked for
 * consignment, but which also have their own ShipStation store since
 * that's the actual fulfillment system for their website orders).
 *
 * WHY WAREHOUSES, NOT STORES: what sync-consignment-inventory.js actually
 * needs to check ShipStation's own inventory count is a WAREHOUSE id
 * (used in that cron's /v2/inventory?inventory_warehouse_id=... calls),
 * not a store id. Also, ShipStation's "List Stores" endpoint is a V1-only
 * endpoint (ssapi.shipstation.com/stores) requiring different credentials
 * (API Key + Secret, Basic Auth) than the V2 API-Key header this whole
 * codebase already uses everywhere else — untested whether Medaltus even
 * has V1 credentials configured. Warehouses avoid that question entirely.
 *
 * TWO ENDPOINTS TRIED, NOT ASSUMED: sync-consignment-inventory.js's own
 * comment claims /v2/inventory_warehouses was confirmed working
 * 2026-07-20 (and its real warehouse IDs for MiGuard/Prohibition/
 * High On Love prove SOMETHING worked) — but ShipStation's current public
 * docs describe a plain /v2/warehouses endpoint instead. Rather than
 * assume one is right, both are tried here and reported separately.
 *
 * Writes nothing anywhere — just returns whatever ShipStation's API
 * actually says exists, so the real warehouse names can be matched
 * against the 7 known store names by eye.
 *
 * Usage:
 *   GET /api/test-shipstation-warehouses
 *   Authorization: Bearer <CRON_SECRET>
 */

const SS_V2_BASE = 'https://api.shipstation.com';

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

  // Known warehouse IDs already confirmed working, for cross-reference —
  // if either endpoint below returns these same three, that's a strong
  // signal the endpoint is correct and complete.
  const knownWarehouseIds = {
    'se-157240': 'miguard (confirmed working)',
    'se-173781': 'prohibition (confirmed working)',
    'se-154551': 'high-on-love (confirmed working)',
  };

  for (const [label, path] of [['inventory_warehouses', '/v2/inventory_warehouses'], ['warehouses', '/v2/warehouses']]) {
    try {
      const resp = await fetch(`${SS_V2_BASE}${path}`, {
        headers: { 'API-Key': ssToken, 'Content-Type': 'application/json' },
      });
      const bodyText = await resp.text();
      let body;
      try { body = JSON.parse(bodyText); } catch { body = { rawText: bodyText.slice(0, 500) }; }

      if (!resp.ok) {
        results[label] = { status: resp.status, ok: false, body };
        continue;
      }

      const warehouses = body.warehouses || body || [];
      const annotated = (Array.isArray(warehouses) ? warehouses : []).map(w => ({
        id: w.warehouse_id || w.id || null,
        name: w.name || w.warehouse_name || null,
        knownMatch: knownWarehouseIds[w.warehouse_id || w.id] || null,
        raw: w,
      }));

      results[label] = { status: resp.status, ok: true, count: annotated.length, warehouses: annotated };
    } catch (err) {
      results[label] = { ok: false, error: err.message };
    }
  }

  res.status(200).json({
    results,
    note: 'Match the warehouse "name" fields against your 7 known ShipStation store names (évolis, High on Love, Hillside, Just Bjorn, MiGuard, Prohibition, Skinuva) to find the 4 we need. knownMatch confirms which entries are already proven-working from sync-consignment-inventory.js.',
  });
};
