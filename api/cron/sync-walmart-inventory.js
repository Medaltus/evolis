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
 * SCOPE — also per Jaclyn 2026-08-04: only processes SKUs that have a
 * Walmart Item ID filled in on column I of the master Product Short Name
 * sheet. A blank column I means that product isn't sold on Walmart at
 * all, so it's skipped entirely before any Walmart API call is made for
 * it — not just excluded from the output, genuinely never queried. See
 * fetchMasterSkuList() below.
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

const HEADERS = ['date', 'sku', 'product_name', 'wfs_on_hand', 'wfs_available', 'last_synced'];

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
  // ── Diagnostic-only test mode — ITEM ID RESOLUTION ───────────────────────
  // Added 2026-08-04: verifies fetchItemByItemId() in isolation — does
  // productIdType=ITEM_ID actually return the item, and does its sku
  // field match what you'd expect for that product? Never writes to the
  // sheet.
  if (req.query.testItemId) {
    const itemId = req.query.testItemId;
    try {
      const tokenData = await getWalmartToken();
      const token = tokenData.access_token;
      if (!token) return res.status(500).json({ testMode: true, error: 'No access_token in Walmart token response' });
      const raw = await wmRequest('GET', `/v3/items/${encodeURIComponent(itemId)}?productIdType=ITEM_ID`, token).catch(err => ({ __error: err.message }));
      return res.status(200).json({ testMode: true, itemId, rawResponse: raw, resolvedSku: raw?.ItemResponse?.[0]?.sku || null });
    } catch (err) {
      return res.status(500).json({ testMode: true, error: err.message });
    }
  }

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
        // Real Walmart docs list productIdType as GTIN/UPC/EAN/ISBN/SKU/ITEM_ID
        // only — "WPID" isn't among them, so this one is expected to keep
        // 404ing; kept only in case wpid happens to work undocumented.
        'items_by_wpid':         wpid   ? () => wmRequest('GET', `/v3/items/${encodeURIComponent(wpid)}`, token)   : null,
        // FIXED 2026-08-04: per real Walmart docs (developer.walmart.com/us-marketplace/docs/get-item-details),
        // GET /v3/items/{ID} defaults to interpreting {ID} as a SKU unless
        // productIdType is explicitly set — the earlier 404 for itemId was
        // almost certainly this, not a nonexistent endpoint.
        'items_by_itemId':       itemId ? () => wmRequest('GET', `/v3/items/${encodeURIComponent(itemId)}?productIdType=ITEM_ID`, token) : null,
        'items_by_gtin':         () => wmRequest('GET', `/v3/items/00850056891011?productIdType=GTIN`, token), // GTIN already known from items_by_sku's earlier response
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

  // FIXED 2026-08-05 — real incident: a cursor saved from BEFORE the
  // 2026-08-04 column-I scoping change (against the old, unfiltered
  // ~233-row list) was still on file when that filter shrank the real
  // list to 73 Walmart-only SKUs. Since the main loop is a plain
  // `for (; i < masterList.length; i++)`, a cursor already past the end
  // of a since-shrunk list meant the loop never ran even once —
  // processedThisRun came back 0 and the run was incorrectly marked
  // complete. Any time the stored cursor is >= the CURRENT list length,
  // that cursor is stale relative to today's list and gets reset to 0
  // rather than trusted — this can legitimately happen any time the
  // list gets scoped differently between runs, not just this one time.
  if (cursor >= masterList.length && masterList.length > 0) {
    console.warn(`[sync-walmart-inventory] stored cursor (${cursor}) is >= current list length (${masterList.length}) — list likely shrank since the cursor was saved (e.g. a scoping change). Resetting cursor to 0 instead of trusting it.`);
    cursor = 0;
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

      // Try the direct SKU first — cheap, and already confirmed working
      // for SKUs where the master list's SKU matches Walmart's exactly.
      let wfs = await fetchWfsInventory(item.sku, token).catch(err => ({ __error: err.message }));
      let resolvedVia = 'sku';
      let productName = '';

      // Only SKUs with a Walmart Item ID on the master list get a
      // /v3/items call at all — per Jaclyn 2026-08-04, deliberately
      // scoped this way rather than calling it for every SKU, since most
      // of the master list isn't sold on Walmart in the first place. One
      // call serves two purposes: productName for the sheet, AND (only
      // if the direct SKU attempt above found no WFS data) the resolved
      // Walmart-side SKU to retry with — e.g. "SVA0001" vs
      // "SVA0001-stickerless". Confirmed keyFeatures/shortDescription/
      // longDescription are NOT present anywhere in this response via
      // live testing — productName is the only usable content field.
      // This check is now ALWAYS true for every item reaching this point —
      // fetchMasterSkuList() filters out any SKU with no Walmart Item ID
      // before it ever gets here (see 2026-08-04 change above). Left in
      // place as a defensive guard rather than removed, in case that
      // filter ever changes; not dead logic, just currently unconditional.
      if (item.walmartItemId) {
        await sleep(INTER_SKU_DELAY_MS);
        const itemRecord = await fetchItemByItemId(item.walmartItemId, token).catch(err => ({ __error: err.message }));

        if (itemRecord?.__error) {
          console.warn(`[sync-walmart-inventory] ${item.sku} (${item.brandTabName}) — productName lookup via itemId ${item.walmartItemId} failed:`, itemRecord.__error);
        } else if (itemRecord) {
          productName = itemRecord.productName || '';

          const resolvedSku = itemRecord.sku || null;
          if (!wfs?.__error && parseWfsShipNode(wfs).matchedNodes === 0 && resolvedSku && resolvedSku !== item.sku) {
            console.log(`[sync-walmart-inventory] ${item.sku} (${item.brandTabName}) — no WFS data under master-list SKU, resolved via itemId ${item.walmartItemId} to Walmart SKU "${resolvedSku}", retrying`);
            await sleep(INTER_SKU_DELAY_MS);
            const retryWfs = await fetchWfsInventory(resolvedSku, token).catch(err => ({ __error: err.message }));
            if (!retryWfs?.__error) { wfs = retryWfs; resolvedVia = 'itemId'; }
          }
        }
      }

      if (wfs?.__error) {
        console.error(`[sync-walmart-inventory] ${item.sku} (${item.brandTabName}) — Walmart inventory call failed:`, wfs.__error);
      } else if (resolvedVia === 'itemId') {
        console.log(`[sync-walmart-inventory] ${item.sku} (${item.brandTabName}) — used itemId-resolved SKU successfully`);
      }

      const row = buildInventoryRow(item, wfs, productName, today, nowIso);
      // FIXED 2026-08-14 — was defaulting to valueInputOption=RAW, same
      // forced-text issue found and fixed elsewhere today. 'date' now
      // writes as a real date, wfs_on_hand/wfs_available as real numbers.
      await appendRows(SHEET_ID, item.brandTabName, [row], tabTokens[item.brandTabName], 'USER_ENTERED');
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

function buildInventoryRow(item, wfs, productName, dateStr, nowIso) {
  // REVISED 2026-08-04 per Jaclyn: now that fetchMasterSkuList() only
  // ever hands this function a SKU confirmed to be sold on Walmart (has
  // a Walmart Item ID on the master list), the old ambiguity between
  // "not sold on Walmart" and "sold but zero WFS stock" is already
  // resolved upstream — every row reaching here IS a real Walmart
  // product. So a successful API call that finds no WFSFulfilled ship
  // node now genuinely means 0 stock, not "unknown," and gets written as
  // 0/0 rather than blank.
  //
  // The ONE case that still stays blank: an actual API/network failure
  // (wfs.__error) — that's a different kind of "we don't know" than
  // "confirmed zero," and writing 0 there would misrepresent a transient
  // technical failure as verified stock data. productName is separately
  // blank whenever item.walmartItemId wasn't set — shouldn't happen post
  // 2026-08-04 scoping, but left as a safety fallback rather than assumed
  // impossible.
  // FIXED 2026-08-14 — sku protected with a leading apostrophe (Sheets'
  // own force-text convention under USER_ENTERED) since it can look
  // numeric and risk reinterpretation or lost leading zeros.
  const protectedSku = `'${item.sku}`;
  if (wfs?.__error) return [dateStr, protectedSku, productName, '', '', nowIso];
  const { onHand, available, matchedNodes } = parseWfsShipNode(wfs);
  if (matchedNodes === 0) return [dateStr, protectedSku, productName, 0, 0, nowIso];
  return [dateStr, protectedSku, productName, onHand, available, nowIso];
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

// Looks up a Walmart Item ID and returns the full item record (not just
// the SKU) — reused for two purposes: (1) resolving the ACTUAL Walmart
// SKU when the master-list SKU doesn't match Walmart's directly, and
// (2) reading productName, confirmed-real per live testing 2026-08-04
// (see: every /v3/items response for this account contains productName;
// none contain keyFeatures/shortDescription/longDescription — tested and
// ruled out, not assumed). One call serves both needs rather than two.
// CONFIRMED endpoint per real Walmart docs (developer.walmart.com
// /us-marketplace/docs/get-item-details): GET /v3/items/{ID} interprets
// {ID} as a SKU by default, so productIdType=ITEM_ID is required to look
// up by Item ID instead. Returns null (not throws) if the item isn't
// found — callers treat a null as "lookup didn't help, fall back to
// what's already known."
async function fetchItemByItemId(itemId, token) {
  const path = `/v3/items/${encodeURIComponent(itemId)}?productIdType=ITEM_ID`;
  const resp = await wmRequest('GET', path, token);
  return resp?.ItemResponse?.[0] || null;
}

// ── Master SKU list — same source/shape sync-products.js uses ───────────
// Deliberately NOT excluding "C-SVA" or "high on love" here — those
// exclusions in sync-products.js are Amazon-SP-API-specific (website-only
// inventory, separate Amazon seller account). Neither reason obviously
// applies to Walmart; included here at face value unless told otherwise.

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ADDED 2026-08-14 — same bug as sync-products.js: skinuva-ca
// (config/brands.js) shares "skinuva" as a substring of its own id, and
// the master sheet almost certainly labels both US and CA rows the same
// ("skinuva") regardless of marketplace — a plain name-based match can
// only ever resolve to skinuva, never skinuva-ca (a shorter string can't
// contain a longer one). Likely a no-op in practice here specifically —
// nothing suggests skinuva-ca sells on Walmart — but applied for
// consistency with every other brand-matching cron fixed today. Same
// helper, kept identical for consistency across the codebase.
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

// FIXED 2026-08-04 — real bug found while debugging product_name coming
// back empty: a naive line.split(',') breaks whenever any field BEFORE
// the one you actually want contains a comma inside quotes (e.g. a
// product description or short name like "...with Niacinamide, Peptides
// + ..."), which shifts every later column's index — including column I
// (Walmart Item ID) — out of alignment for that row. Since this master
// sheet is shared across many brands' product names/descriptions, this
// wasn't a hypothetical edge case; it was actively corrupting
// walmartItemId for at least some rows, which meant item.walmartItemId
// came back falsy, which meant the productName lookup never even fired.
// This proper parser tracks quote state character-by-character so a
// comma inside a quoted field is never treated as a column separator.
function parseCsvLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } // escaped "" inside a quoted field
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current);
  return cols.map(c => c.trim());
}

async function fetchMasterSkuList() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp   = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master SKU list: ${resp.status}`);
  const csv   = await resp.text();
  // Known remaining limitation: this still splits into lines by '\n'
  // BEFORE per-line CSV parsing, so a field containing an actual embedded
  // newline (a multi-line description wrapped in quotes) would still
  // break row alignment, same as before this fix. Embedded commas are
  // confirmed fixed; embedded newlines are a separate, rarer edge case
  // not addressed here — flagging rather than silently assuming it's
  // covered too.
  const lines = csv.trim().split('\n').slice(1);

  const out = [];
  for (const line of lines) {
    const cols      = parseCsvLine(line);
    const asin      = cols[0] || '';
    const sku       = cols[1] || '';
    const rawBrand  = (cols[3] || '').trim();
    const brandNorm = stripAccents(rawBrand.toLowerCase());
    // Added 2026-08-04 per Jaclyn: column I, Walmart's own Item ID for
    // this product. Used below to resolve the EXACT Walmart-side SKU
    // string via a confirmed-working lookup (GET /v3/items/{itemId}
    // ?productIdType=ITEM_ID) rather than assuming this master list's SKU
    // matches Walmart's SKU string directly — it doesn't always (e.g.
    // "SVA0001" here vs. "SVA0001-stickerless" on Walmart's side).
    const walmartItemId = (cols[8] || '').trim();

    if (!sku) continue;

    // Added 2026-08-04 per Jaclyn: skip this SKU ENTIRELY if it has no
    // Walmart Item ID — a blank column I means this product isn't sold on
    // Walmart at all, so there's no WFS inventory to look up for it in
    // the first place. This scopes the whole cron down to only
    // Walmart-relevant SKUs, not just the productName lookup — the WFS
    // inventory API call itself is now skipped too for everything else,
    // cutting the total number of Walmart API calls this cron makes on
    // every run, not just trimming what gets written to the sheet.
    if (!walmartItemId) {
      console.log(`[sync-walmart-inventory] ${sku} — no Walmart Item ID in column I, skipped (not sold on Walmart)`);
      continue;
    }

    const nameMatched = brands.find(b =>
      b.active && (
        brandNorm === stripAccents(b.id.toLowerCase()) ||
        brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
        brandNorm.includes(stripAccents(b.id.toLowerCase()))
      )
    );
    if (!nameMatched) {
      console.log(`[sync-walmart-inventory] unmatched brand in master sheet: "${rawBrand}" (sku ${sku}) — skipped`);
      continue;
    }
    // Name matching alone can't distinguish skinuva from skinuva-ca — see
    // comment above resolveBrandForSku. Find the real sibling set via
    // shared SKU PREFIX (not name), then disambiguate by SKU suffix.
    const siblings = brands.filter(b =>
      b.active && b.skuPrefix && nameMatched.skuPrefix && b.skuPrefix === nameMatched.skuPrefix
    );
    const matched = siblings.length > 1 ? resolveBrandForSku(sku, siblings) : nameMatched;

    out.push({ asin, sku, walmartItemId, brandTabName: matched.tabName });
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
        // FIXED 2026-08-14 — same protection as the main write path:
        // sku re-protected on rewrite, USER_ENTERED so numbers/dates stay
        // real rather than reverting to forced text on every ?force=true.
        const rowArrays = kept.map(r => HEADERS.map(h => {
          const v = r[h] ?? '';
          return (h === 'sku' && v !== '') ? `'${v}` : v;
        }));
        await replaceRows(SHEET_ID, brand.tabName, HEADERS, rowArrays, token, 'USER_ENTERED');
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
