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
 * ⚠ UNCONFIRMED — READ BEFORE DEPLOYING ⚠
 * fetchWfsInventory() below is a best-effort implementation, not a
 * verified one. I do not have confirmed Walmart WFS API documentation in
 * front of me. Two real open questions:
 *   1. Whether GET /v3/inventory (Walmart's general seller inventory
 *      endpoint, same API family sync-walmart-orders.js already
 *      authenticates against) actually returns WFS-specific quantity at
 *      all, separately from seller-fulfilled quantity — or whether WFS
 *      inventory requires an entirely different endpoint (Walmart's
 *      developer portal has historically documented WFS-specific supply
 *      chain APIs separately from the core Marketplace API).
 *   2. The exact response shape (field names) for whatever endpoint turns
 *      out to be correct.
 * DO NOT trust this cron's output until you've run it once with
 * ?testSku=<a real WFS-fulfilled évolis SKU> and confirmed the raw
 * response actually contains a WFS-specific quantity that matches what
 * Walmart Seller Center shows for that SKU. If the number returned looks
 * identical to total inventory regardless of fulfillment type, this is
 * the wrong endpoint and needs to be swapped for whatever Walmart's real
 * WFS inventory API turns out to be.
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

  // ── Diagnostic-only test mode ──────────────────────────────────────────
  // EXPANDED 2026-08-04 per Jaclyn: instead of testing one guessed
  // endpoint at a time, fire several plausible variations in parallel and
  // return every raw response (success or error) side by side. Purely
  // exploratory — none of these paths/params are confirmed against real
  // Walmart docs, they're educated guesses based on (a) the general
  // Inventory API we already know responds, (b) the shipNode-based
  // WFS/SellerFulfilled split sync-walmart-orders.js already uses
  // successfully for /v3/orders, and (c) common Walmart API naming
  // patterns elsewhere in their Marketplace API. Never writes to the sheet.
  if (req.query.testSku) {
    const sku = req.query.testSku;
    try {
      const tokenData = await getWalmartToken();
      const token = tokenData.access_token;
      if (!token) return res.status(500).json({ testMode: true, error: 'No access_token in Walmart token response' });

      const probes = {
        'inventory_plain':            () => wmRequest('GET', `/v3/inventory?sku=${encodeURIComponent(sku)}`, token),
        'inventory_shipNode_WFS':     () => wmRequest('GET', `/v3/inventory?sku=${encodeURIComponent(sku)}&shipNode=WFS`, token),
        'inventory_fulfillmentType':  () => wmRequest('GET', `/v3/inventory?sku=${encodeURIComponent(sku)}&fulfillmentType=WFS`, token),
        'fulfillment_inventory':      () => wmRequest('GET', `/v3/fulfillment/inventory?sku=${encodeURIComponent(sku)}`, token),
        'wfs_inventory':              () => wmRequest('GET', `/v3/wfs/inventory?sku=${encodeURIComponent(sku)}`, token),
        'inbound_inventory':          () => wmRequest('GET', `/v3/inventory/inbound?sku=${encodeURIComponent(sku)}`, token),
        'item_lookup':                () => wmRequest('GET', `/v3/items?sku=${encodeURIComponent(sku)}`, token),
        'inventory_bulk_no_sku':      () => wmRequest('GET', `/v3/inventory`, token),
      };

      const entries = await Promise.all(
        Object.entries(probes).map(async ([name, fn]) => {
          try {
            const result = await fn();
            return [name, result];
          } catch (err) {
            return [name, { __error: err.message }];
          }
        })
      );

      const results = Object.fromEntries(entries);
      return res.status(200).json({ testMode: true, sku, note: 'All paths/params below are UNCONFIRMED guesses — look for whichever response actually contains a number matching known WFS stock, and check whether any response includes a field that explicitly labels fulfillment type.', results });
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

function buildInventoryRow(item, wfs, dateStr, nowIso) {
  // UNCONFIRMED field names — see file header. Guessing at a shape close
  // to Walmart's documented general inventory response
  // ({ sku, quantity: { unit, amount } }), with an "available" fallback
  // to the same value if Walmart doesn't distinguish on-hand vs available
  // for WFS stock specifically. Left blank (not zero) if the call failed
  // or returned nothing usable — a blank is "we don't know," a zero would
  // falsely read as "confirmed no stock."
  const onHand   = wfs?.quantity?.amount ?? wfs?.availableToSellQty?.amount ?? '';
  const available = wfs?.availableQuantity?.amount ?? onHand;
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

// ── Walmart inventory API — SEE FILE HEADER, UNCONFIRMED ─────────────────
// Best-effort guess: GET /v3/inventory?sku={sku} is Walmart's documented
// general seller-inventory lookup. Whether it returns a WFS-specific
// breakdown, or whether WFS inventory needs an entirely different
// endpoint, is NOT confirmed. Verify with ?testSku= before trusting this.
function fetchWfsInventory(sku, token) {
  const path = `/v3/inventory?sku=${encodeURIComponent(sku)}`;
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
