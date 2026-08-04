/**
 * api/cron/sync-walmart-inventory.js
 * Resumable daily log — one row PER SKU PER DAY (never overwritten), same
 * pattern as sync-products.js (Amazon), so this plugs into the exact same
 * "read latest date, ignore history" convention the dashboard already
 * uses for Products Cache. Would pair with a trim-walmart-inventory-log.js
 * the same way sync-products.js pairs with trim-products-log.js, if this
 * grows large enough to need it — not built yet, flagging as a likely
 * future need rather than building it preemptively.
 *
 * WFS ONLY — per Jaclyn 2026-08-04: Walmart Seller-Fulfilled inventory
 * draws from the SAME physical stock pool as Amazon FBM (already captured
 * as qty_at_medaltus/seller_fulfilled_quantity in Products Cache), so
 * pulling it again here would double-count. This cron exists specifically
 * to capture the ONE number that isn't already tracked anywhere else:
 * stock sitting in Walmart's own fulfillment centers.
 *
 * ENDPOINT — CONFIRMED 2026-08-04 via live test against a known-WFS
 * SVA SKU (8 real WFS units): GET /v3/fulfillment/inventory?sku={sku}
 * returns payload.inventory[0].shipNodes, an array with one entry per
 * fulfillment location/type. Filtered here to shipNodeType ===
 * "WFSFulfilled" specifically (defensive — protects against a SKU that
 * might return multiple shipNodes of different types in one response,
 * even though the SKU tested only had one). onHandQty and availToSellQty
 * on that matching entry both read 8, exactly matching known truth.
 *
 * A separate, richer endpoint (GET /v3/wfs/inventory?sku=) ALSO returned
 * matching data (onhandUnits/availableUnits = 8) plus extra fields not
 * used here — sell-through rate, days-of-supply, inventory-age buckets,
 * restock forecasts. Not used for this cron (heavier response, more
 * parsing surface than needed for a simple on-hand number), but flagged
 * as a real option if restock-planning-style metrics are ever wanted on
 * the dashboard later.
 *
 * Sheet: SHEET_WALMART_INVENTORY (env var — sheet does not exist yet,
 * needs to be created and its ID set before this can run for real).
 * Columns: date, sku, wfs_on_hand, wfs_available, last_synced
 * One tab per brand, auto-created on first run — same convention as
 * every other cron in this repo.
 */

const https = require('https');
const { ensureTab, readRows, replaceRows, appendRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const { sendCronFailureAlert } = require('../_alerts');

const WM_HOST       = 'marketplace.walmartapis.com';
const WM_TOKEN_PATH = '/v3/token';

const SHEET_ID = process.env.SHEET_WALMART_INVENTORY;

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

const HEADERS = ['date', 'sku', 'wfs_on_hand', 'wfs_available', 'last_synced'];

const TIME_BUDGET_MS = 250_000; // stay safely under Vercel's 300s cap — same default as sync-products.js
// UNCONFIRMED against Walmart's actual per-operation rate limit for this
// specific endpoint (same caveat sync-products.js's own inter-SKU delay
// carries for Amazon) — a conservative starting point, not a verified one.
const INTER_SKU_DELAY_MS = 600;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SHEET_ID) {
    await sendCronFailureAlert('sync-walmart-inventory', 'SHEET_WALMART_INVENTORY env var not set — create the sheet and set this before enabling the cron schedule.');
    return res.status(500).json({ error: 'SHEET_WALMART_INVENTORY env var not set' });
  }

  const today = new Date().toISOString().slice(0, 10);

  // ── Diagnostic-only test mode — INVENTORY ───────────────────────────────
  // Same pattern as sync-products.js's ?testSku= — verifies the raw
  // Walmart response before trusting a real run. Never writes to the sheet.
  // (Simplified 2026-08-04 back down to a single call now that the
  // endpoint itself is confirmed — see file header for the multi-endpoint
  // exploration that got us here.)
  if (req.query.testSku) {
    const sku = req.query.testSku;
    try {
      const tokenData = await getWalmartToken();
      const token = tokenData.access_token;
      if (!token) return res.status(500).json({ testMode: true, error: 'No access_token in Walmart token response' });
      const raw = await fetchWfsInventory(sku, token).catch(err => ({ __error: err.message }));
      return res.status(200).json({ testMode: true, sku, rawResponse: raw, parsed: parseWfsShipNode(raw) });
    } catch (err) {
      return res.status(500).json({ testMode: true, error: err.message });
    }
  }

  // ── Diagnostic-only test mode — LISTING CONTENT (exploratory) ───────────
  // Added 2026-08-04 per Jaclyn: does Walmart's API expose title/bullets/
  // description the way it exposes inventory? The ONE listing-adjacent
  // field seen so far — item_lookup's "productName" from the earlier
  // multi-probe inventory exploration — is title-like but nothing else
  // (no bullets, no description). These probes are a first pass at
  // finding a richer content endpoint, using two IDs that same earlier
  // probe surfaced for this SKU (wpid, itemID) as lookup keys, since a
  // "list" style endpoint (?sku=) may return a summary while a
  // "get by ID" style endpoint returns full detail — genuinely unverified,
  // same exploratory spirit as the inventory probes before this one
  // confirmed a working endpoint. Never writes to the sheet.
  if (req.query.testListingSku) {
    const sku = req.query.testListingSku;
    const wpid = req.query.wpid || '';     // pass the wpid from a prior testSku-adjacent item_lookup, if you have one, for the by-ID probes below
    const itemId = req.query.itemId || ''; // same idea, from wfs_inventory's itemInformation.itemID
    try {
      const tokenData = await getWalmartToken();
      const token = tokenData.access_token;
      if (!token) return res.status(500).json({ testMode: true, error: 'No access_token in Walmart token response' });

      const probes = {
        'items_by_sku':          () => wmRequest('GET', `/v3/items?sku=${encodeURIComponent(sku)}`, token),
        'items_by_wpid':         wpid   ? () => wmRequest('GET', `/v3/items/${encodeURIComponent(wpid)}`, token)   : null,
        'items_by_itemId':       itemId ? () => wmRequest('GET', `/v3/items/${encodeURIComponent(itemId)}`, token) : null,
        'items_by_sku_details':  () => wmRequest('GET', `/v3/items?sku=${encodeURIComponent(sku)}&includeDetails=true`, token),
        'item_spec_by_sku':      () => wmRequest('GET', `/v3/items/spec?sku=${encodeURIComponent(sku)}`, token),
        'content_by_sku':        () => wmRequest('GET', `/v3/content?sku=${encodeURIComponent(sku)}`, token),
      };

      const entries = await Promise.all(
        Object.entries(probes)
          .filter(([, fn]) => fn !== null) // drop the by-wpid/by-itemId probes if those IDs weren't passed in
          .map(async ([name, fn]) => {
            try { return [name, await fn()]; }
            catch (err) { return [name, { __error: err.message }]; }
          })
      );

      return res.status(200).json({
        testMode: true, sku, wpidUsed: wpid || '(not provided)', itemIdUsed: itemId || '(not provided)',
        note: 'All paths below are UNCONFIRMED guesses. Look for bullets/key features/description fields specifically — a plain "productName" or "title" alone is not enough to replace Amazon-style listing content. Pass &wpid=... and &itemId=... (from an earlier testSku result\u2019s item_lookup / wfs_inventory probes) to also test the by-ID lookups.',
        results: Object.fromEntries(entries),
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
    await sendCronFailureAlert('sync-walmart-inventory', err.message, { Stage: 'reading _meta tab' });
    return res.status(500).json({ error: 'Failed to read _meta', detail: err.message });
  }

  let cursor = 0;
  if (force) {
    try {
      await clearRowsForDate(today);
    } catch (err) {
      await sendCronFailureAlert('sync-walmart-inventory', err.message, { Stage: "clearing today's rows for ?force=true" });
      return res.status(500).json({ error: "Failed to clear today's existing rows before forced re-run", detail: err.message });
    }
    console.log(`[sync-walmart-inventory] force=true — cleared today's (${today}) existing rows, restarting from cursor 0`);
  } else if (meta.inventory_log_date === today) {
    if (meta.inventory_log_complete === 'true') {
      return res.status(200).json({ message: `Already completed for ${today}. Pass ?force=true to overwrite today's rows and reprocess.` });
    }
    cursor = parseInt(meta.inventory_log_cursor || '0', 10) || 0;
  }
  // else: new day — cursor resets to 0, starting a fresh daily log

  let masterList;
  try {
    masterList = await fetchMasterSkuList();
  } catch (err) {
    await sendCronFailureAlert('sync-walmart-inventory', err.message, { Stage: 'fetching master SKU list' });
    return res.status(500).json({ error: 'Failed to read master SKU list', detail: err.message });
  }

  let tokenData;
  try {
    tokenData = await getWalmartToken();
  } catch (err) {
    await sendCronFailureAlert('sync-walmart-inventory', err.message, { Stage: 'Walmart token request' });
    return res.status(500).json({ error: 'Failed to get Walmart token', detail: err.message });
  }
  const token = tokenData.access_token;
  if (!token) {
    await sendCronFailureAlert('sync-walmart-inventory', 'No access_token in Walmart token response');
    return res.status(500).json({ error: 'No access_token returned' });
  }

  const totalCount = masterList.length;
  const startTime  = Date.now();
  const nowIso     = new Date().toISOString();

  let processed = 0;
  let i = cursor;
  const tabTokens = {};
  const tabNextRow = {};
  const failedSkus = [];

  for (; i < masterList.length; i++) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    if (i > cursor) await sleep(INTER_SKU_DELAY_MS);

    const item = masterList[i];
    try {
      if (!tabTokens[item.brandTabName]) {
        tabTokens[item.brandTabName] = await ensureTab(SHEET_ID, item.brandTabName, HEADERS);
        const existingRows = await readRows(SHEET_ID, item.brandTabName);
        tabNextRow[item.brandTabName] = existingRows.length + 2;
      }

      const wfs = await fetchWfsInventory(item.sku, token).catch(err => ({ __error: err.message }));
      if (wfs?.__error) {
        console.error(`[sync-walmart-inventory] ${item.sku} (${item.brandTabName}) — Walmart inventory call failed:`, wfs.__error);
      }

      const row = buildInventoryRow(item, wfs, today, nowIso);
      await appendRows(SHEET_ID, item.brandTabName, [row], tabTokens[item.brandTabName]);
      tabNextRow[item.brandTabName]++;
      processed++;
    } catch (err) {
      console.error(`[sync-walmart-inventory] ${item.sku} (${item.brandTabName}) failed:`, err.message);
      failedSkus.push(`${item.sku} (${item.brandTabName}): ${err.message}`);
      // Continue to the next SKU — one bad SKU shouldn't stall the whole run.
    }
  }

  const complete = i >= masterList.length;
  try {
    await writeMeta({
      inventory_log_date:     today,
      inventory_log_cursor:   String(i),
      inventory_log_complete: complete ? 'true' : 'false',
    });
  } catch (err) {
    console.warn('[sync-walmart-inventory] failed to update _meta:', err.message);
    await sendCronFailureAlert('sync-walmart-inventory', err.message, { Stage: 'persisting cursor to _meta', Cursor: String(i), 'Total SKUs': String(totalCount) });
  }

  if (failedSkus.length > 0) {
    await sendCronFailureAlert(
      'sync-walmart-inventory',
      failedSkus.slice(0, 20).join('\n') + (failedSkus.length > 20 ? `\n...and ${failedSkus.length - 20} more` : ''),
      { 'SKUs failed this run': String(failedSkus.length) }
    );
  }

  res.status(200).json({ date: today, processedThisRun: processed, cursor: i, totalCount, complete });
};

// ── Row building ────────────────────────────────────────────────────────

// Shared by both the real write path and ?testSku= diagnostic mode, so
// the two can never silently drift apart (test mode showing one shape
// while the real writer reads a different one). Filters the shipNodes
// array to shipNodeType === "WFSFulfilled" specifically — defensive
// against a SKU ever returning multiple ship nodes of different types in
// one response, even though every SKU tested so far only had one entry.
// If more than one WFSFulfilled node came back (e.g. multiple WFS
// warehouses), sums across all of them rather than just taking the first.
function parseWfsShipNode(raw) {
  const shipNodes = raw?.payload?.inventory?.[0]?.shipNodes || [];
  const wfsNodes = shipNodes.filter(n => n.shipNodeType === 'WFSFulfilled');
  if (!wfsNodes.length) return { onHand: '', available: '', matchedNodes: 0 };
  const onHand    = wfsNodes.reduce((s, n) => s + (parseInt(n.onHandQty, 10) || 0), 0);
  const available = wfsNodes.reduce((s, n) => s + (parseInt(n.availToSellQty, 10) || 0), 0);
  return { onHand, available, matchedNodes: wfsNodes.length };
}

function buildInventoryRow(item, wfs, dateStr, nowIso) {
  // Left blank (not zero) if the call failed or returned no WFSFulfilled
  // ship node at all — a blank is "we don't know / not WFS-stocked," a
  // zero would falsely read as "confirmed no WFS stock."
  if (wfs?.__error) return [dateStr, item.sku, '', '', nowIso];
  const { onHand, available, matchedNodes } = parseWfsShipNode(wfs);
  if (matchedNodes === 0) return [dateStr, item.sku, '', '', nowIso];
  return [dateStr, item.sku, onHand, available, nowIso];
}

// ── Walmart auth — copied verbatim from sync-walmart-orders.js (proven working) ──

function getWalmartToken() {
  return new Promise((resolve, reject) => {
    const clientId     = process.env.WALMART_CLIENT_ID;
    const clientSecret = process.env.WALMART_CLIENT_SECRET;
    const partnerId    = process.env.WALMART_PARTNER_ID;
    if (!clientId || !clientSecret) return reject(new Error('WALMART credentials not set'));

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body        = 'grant_type=client_credentials';
    const headers = {
      'Authorization':         `Basic ${credentials}`,
      'Content-Type':          'application/x-www-form-urlencoded',
      'Accept':                'application/json',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `token-${Date.now()}`,
      'WM_SVC.VERSION':        '1.0.0',
      'Content-Length':        Buffer.byteLength(body),
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const req = https.request({ hostname: WM_HOST, path: WM_TOKEN_PATH, method: 'POST', headers }, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Token parse error (${httpRes.statusCode}): ${d.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function wmRequest(method, path, token) {
  return new Promise((resolve, reject) => {
    const clientId  = process.env.WALMART_CLIENT_ID;
    const partnerId = process.env.WALMART_PARTNER_ID;
    const headers = {
      'Authorization':         `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
      'WM_SEC.ACCESS_TOKEN':   token,
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': `req-${Date.now()}`,
      'WM_SVC.VERSION':        '1.0.0',
      'Accept':                'application/json',
      'Content-Type':          'application/json',
    };
    if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

    const req = https.request({ hostname: WM_HOST, path, method, headers }, httpRes => {
      let d = '';
      httpRes.on('data', c => d += c);
      httpRes.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error (${httpRes.statusCode}): ${d.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Walmart inventory API — CONFIRMED 2026-08-04, see file header ────────
function fetchWfsInventory(sku, token) {
  const path = `/v3/fulfillment/inventory?sku=${encodeURIComponent(sku)}`;
  return wmRequest('GET', path, token);
}

// ── Master SKU list — same source/shape sync-products.js uses ───────────
// Deliberately NOT excluding "C-SVA" or "high on love" here — those
// exclusions in sync-products.js are Amazon-SP-API-specific (website-only
// inventory, separate Amazon seller account). Neither reason obviously
// applies to Walmart; included here at face value unless told otherwise.

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
    const rawBrand  = (cols[3] || '').trim();
    const brandNorm = stripAccents(rawBrand.toLowerCase());

    if (!sku) continue;

    const matched = brands.find(b =>
      b.active && (
        brandNorm === stripAccents(b.id.toLowerCase()) ||
        brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
        brandNorm.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (!matched) {
      console.log(`[sync-walmart-inventory] unmatched brand in master sheet: "${rawBrand}" (sku ${sku}) — skipped`);
      continue;
    }

    out.push({ asin, sku, brandTabName: matched.tabName });
  }
  return out;
}

// Removes every row matching `dateStr` from every active brand's tab —
// same "overwrite today, leave history alone" behavior as sync-products.js.
async function clearRowsForDate(dateStr) {
  for (const brand of brands.filter(b => b.active)) {
    try {
      const token = await ensureTab(SHEET_ID, brand.tabName, HEADERS);
      const rows  = await readRows(SHEET_ID, brand.tabName);
      const kept  = rows.filter(r => (r.date || '') !== dateStr);
      if (kept.length !== rows.length) {
        const rowArrays = kept.map(r => HEADERS.map(h => r[h] ?? ''));
        await replaceRows(SHEET_ID, brand.tabName, HEADERS, rowArrays, token);
        console.log(`[sync-walmart-inventory] ${brand.id} — cleared ${rows.length - kept.length} existing rows for ${dateStr}`);
      }
    } catch (err) {
      console.warn(`[sync-walmart-inventory] ${brand.id} — failed to clear rows for ${dateStr}:`, err.message);
    }
  }
}

// ── _meta helpers ─────────────────────────────────────────────────────────

async function readMeta() {
  // FIXED 2026-08-04: must ensureTab before reading, same as writeMeta
  // already does below — on a genuinely brand-new sheet (no tabs at all
  // yet), reading a tab that doesn't exist fails with a Sheets API 400
  // ("Unable to parse range") rather than returning an empty result. This
  // exact gap exists in sync-products.js's own readMeta() too — it just
  // never surfaced there because that sheet already had a _meta tab left
  // over from earlier use. ensureTab is safe to call every time: it's a
  // no-op if the tab already exists.
  await ensureTab(SHEET_ID, META_TAB, META_HEADERS);
  const rows = await readRows(SHEET_ID, META_TAB);
  const map  = {};
  (rows || []).forEach(r => { if (r.KEY) map[r.KEY] = r.VALUE; });
  return map;
}

async function writeMeta(updates) {
  const token = await ensureTab(SHEET_ID, META_TAB, META_HEADERS);
  const nowIso = new Date().toISOString();
  const existing = await readRows(SHEET_ID, META_TAB);
  const map = {};
  (existing || []).forEach(r => { if (r.KEY) map[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
  Object.entries(updates).forEach(([k, v]) => { map[k] = [k, v, nowIso]; });
  await replaceRows(SHEET_ID, META_TAB, META_HEADERS, Object.values(map), token);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
