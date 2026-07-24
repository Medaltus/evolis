/**
 * api/cron/sync-newderm-inventory-reconciliation.js
 *
 * Compares marketplace-reported inventory (Amazon FBA/seller-fulfilled
 * today, via SHEET_PRODUCT_INVENTORY) against Cin7 Core's own inventory,
 * broken out per fulfillment location — to surface discrepancies (lost,
 * damaged, or otherwise unreflected stock). Completely separate from
 * sync-cin7-consignment-inventory.js: different sheet, different SKU
 * universe (regular SKUs only, C- excluded here entirely — no Just Bjorn
 * Product-column extraction, that's consignment-only), and Cin7 data is
 * kept PER LOCATION here rather than summed across all of them.
 *
 * "SHEET_PRODUCTS" IN THE ORIGINAL SPEC → sheets.productInventory: the
 * spec named the env var SHEET_PRODUCTS with sheet ID
 * 1cdqKzqaUFr8MFDWkskpGJ5NQSv9QjVv64ab8P_PPr6s — but that exact ID is
 * already configured as SHEET_PRODUCT_INVENTORY (added when the Listing
 * Audit page was rebuilt), and its real columns
 * (fulfillable_quantity/reserved_quantity/etc.) are exactly what this
 * cron needs. The OLDER, separate SHEET_PRODUCTS env var is an unrelated
 * sheet (master SKU/ASIN list, Vine tab). Using sheets.productInventory
 * — flag if that's actually wrong and a genuinely separate sheet was meant.
 *
 * DESTINATION SHEET HAS A TWO-ROW HEADER — confirmed directly against the
 * real sheet, not assumed: row 1 is merged group headers ("Amazon
 * Warehouse USA - FBA" spans 9 columns, etc.), row 2 is the real column
 * names, so data starts at row 3. Every other sheet in this codebase has
 * a single header row on row 1 with data starting row 2 — _sheets_client.js's
 * replaceRows() hardcodes that assumption and can't be reused here as-is.
 * This file has its own row-3-aware clear+write instead (see
 * replaceDataRowsFrom() below), scoped to just this file rather than
 * changing shared behavior every other cron already depends on.
 *
 * TABS ARE NOT AUTO-CREATED — per spec, a missing brand tab gets logged,
 * not created. Jaclyn manually duplicated the correctly-formatted tab 16
 * times (2026-07-22) rather than have this cron reconstruct the merged-
 * header formatting in code, which is easy to get subtly wrong.
 *
 * BRAND ASSIGNMENT: uses the master SKU list's own Brand column (same
 * source sync-products.js already trusts), matched against config/brands.js
 * WITHOUT filtering by active — deliberately different from the
 * brands.filter(b => b.active) pattern every other cron in this repo
 * uses. High On Love is active:false (separate Amazon seller account,
 * no SP-API connection yet) but the spec explicitly requires it included
 * here. Confirmed 2026-07-22 via the sibling consignment cron's own real
 * run that the master list DOES have HOL-prefixed rows, so this should
 * find its regular SKUs the same way. Its Amazon-side columns will
 * legitimately end up blank regardless (SHEET_PRODUCT_INVENTORY almost
 * certainly has no tab for it either, since sync-products.js DOES filter
 * by active) — that's correct, not a bug, per the "marketplace source
 * not yet connected → leave blank" rule.
 *
 * CIN7 "Available" IS SUMMED AS-REPORTED, NOT RECOMPUTED — deliberately
 * different from the consignment cron, which distrusted Cin7's own
 * Available column (found a real row where it didn't equal qty−allocated)
 * and computed it manually instead. This cron's whole purpose is
 * reconciling OUR numbers against CIN7's AND AMAZON'S as each system
 * reports them, so second-guessing Cin7's own Available here would
 * undermine the comparison rather than support it. Per spec: sum Qty on
 * Hand, Allocated, AND Available independently, all three as reported.
 *
 * Sheet: SHEET_NEWDERM_INVENTORY (1anFivXORPzJCCTr_RyuQQ2ZCgH25tQM86pkwLbL7_4k)
 * One tab per brand, tab names matching config/brands.js exactly.
 * 29-column layout confirmed directly from the real sheet — see HEADERS
 * below; do not change without updating the real header rows to match.
 *
 * DEPENDENCY: needs `xlsx` (SheetJS) — same requirement as the sibling
 * consignment cron; if that one's already deployed with it working,
 * nothing further needed here.
 */

const { readRows, getSheetsToken } = require('../config/_sheets_client');
const sheets = require('../config/sheets');
const brands = require('../config/brands');
const XLSX = require('xlsx');
const crypto = require('crypto');
const { sendCronFailureAlert } = require('../_alerts');

const DRIVE_FOLDER_ID = process.env.GOOGLE_CIN7_CONSIGNMENT_FOLDER_ID; // same Cin7 export folder as the consignment cron

const MASTER_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const MASTER_SHEET_GID = '164358627'; // "Product Short Name" tab: A=asin, B=sku, C=name, D=brand

// Real 29-column header confirmed directly from the destination sheet,
// 2026-07-22. Row 1 (merged group headers, not written by this cron —
// already in place) is not part of this array; this is row 2's actual
// column names, matching the order data must be written in.
const HEADERS = [
  'sku', 'name',
  'amazon_fulfillable_quantity', 'amazon_reserved_quantity', 'amazon_inbound_working_quantity',
  'amazon_inbound_shipped_quantity', 'amazon_inbound_receiving_quantity', 'amazon_unfulfillable_quantity',
  'core_qty_on_hand_fba', 'core_allocated_fba', 'core_available_fba',
  'amazon_seller_fulfilled_quantity', 'core_qty_on_hand_sf', 'core_allocated_sf', 'core_available_sf',
  'amazon_fulfillable_quantity_ca', 'amazon_reserved_quantity_ca', 'amazon_inbound_working_quantity_ca',
  'amazon_inbound_shipped_quantity_ca', 'amazon_inbound_receiving_quantity_ca', 'amazon_unfulfillable_quantity_ca',
  'core_qty_on_hand_fba_ca', 'core_allocated_fba_ca', 'core_available_fba_ca',
  'walmart_quantity', 'core_qty_on_hand_walmart', 'core_allocated_walmart', 'core_available_walmart',
  'last_updated',
];

// Exact Cin7 location strings — confirmed 2026-07-21 against the real
// export. Anything else in the report (Consignment-specific locations,
// other warehouses) is irrelevant to this cron and never read.
const LOCATIONS = {
  fba:      'Amazon Warehouse USA - FBA',
  sf:       'Medaltus Warehouse',
  fbaCa:    'Amazon - Canada (Newderm)',
  walmart:  'Walmart Fulfillment Centers (WFN)',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.newdermInventory) {
    await sendCronFailureAlert('sync-newderm-inventory-reconciliation', 'sheets.newdermInventory is not configured in config/sheets.js');
    return res.status(500).json({ error: 'sheets.newdermInventory is not configured in config/sheets.js' });
  }
  if (!sheets.productInventory) {
    await sendCronFailureAlert('sync-newderm-inventory-reconciliation', 'sheets.productInventory is not configured in config/sheets.js');
    return res.status(500).json({ error: 'sheets.productInventory is not configured in config/sheets.js' });
  }
  if (!DRIVE_FOLDER_ID) {
    await sendCronFailureAlert('sync-newderm-inventory-reconciliation', 'GOOGLE_CIN7_CONSIGNMENT_FOLDER_ID is not set');
    return res.status(500).json({ error: 'GOOGLE_CIN7_CONSIGNMENT_FOLDER_ID is not set' });
  }

  // Same test affordances as the sibling consignment cron.
  const targetDate = (req.query && req.query.targetDate) || '';
  const dryRun = String((req.query && req.query.dryRun) || '').toLowerCase() === 'true';

  const nowIso = new Date().toISOString();
  const todayEt = getTodayEasternDateString();

  console.log(`[inventory-reconciliation] run start ${nowIso} — today (ET): ${todayEt}${dryRun ? ' [DRY RUN]' : ''}`);

  // ── 1. Cin7 Core — find + read the file once, shared across all brands ──
  let fileInfo, cin7Rows;
  try {
    fileInfo = targetDate
      ? await findFileByDate(DRIVE_FOLDER_ID, targetDate)
      : await findNewestFile(DRIVE_FOLDER_ID);
    if (!fileInfo) throw new Error(targetDate ? `No file found matching date ${targetDate}` : 'No files found in folder');
    const buffer = await downloadFile(fileInfo.id);
    cin7Rows = parseWorkbook(buffer);
  } catch (err) {
    console.error('[inventory-reconciliation] failed to read Cin7 export:', err.message);
    await sendCronFailureAlert('sync-newderm-inventory-reconciliation', err.message, { Stage: 'finding/reading Cin7 export' });
    return res.status(500).json({ error: 'Failed to find or read the Cin7 export', detail: err.message });
  }
  console.log(`[inventory-reconciliation] Cin7 source file: "${fileInfo.name}" (modified ${fileInfo.modifiedTime}) — ${cin7Rows.length} rows`);

  // Map<normalizedSku, Map<locationName, {qtyOnHand, allocated, available}>>
  const cin7ByLocation = aggregateCin7ByLocation(cin7Rows);
  const duplicateLocationPairs = cin7ByLocation.duplicateCount;

  // ── 2. Master SKU list — who belongs to which brand, once ──────────────
  let masterRows;
  try {
    masterRows = await fetchMasterSkuList();
  } catch (err) {
    await sendCronFailureAlert('sync-newderm-inventory-reconciliation', err.message, { Stage: 'fetching master SKU list' });
    return res.status(500).json({ error: 'Failed to read master SKU list', detail: err.message });
  }

  // Deliberately NOT filtered to active brands — see file header note re: High On Love.
  // Deduped per-brand by SKU (Map, not array/push) — the master list has
  // genuine duplicate rows for the same SKU (confirmed 2026-07-22: several
  // Skinuva SKUs came back as literal duplicate output rows before this
  // fix, most likely from multiple ASIN rows sharing one SKU). Last
  // matching row for a given SKU wins if names ever actually differ.
  const brandSkuMap = {}; // tabName -> Map<sku, name>
  const unassigned = [];
  let masterDupeCount = 0;
  for (const { sku, name, rawBrand } of masterRows) {
    const normSku = normalizeSku(sku);
    if (!normSku || normSku.toUpperCase().startsWith('C-')) continue; // consignment — out of scope for this cron entirely
    const matched = matchBrand(rawBrand);
    if (!matched) { unassigned.push(`${normSku} (brand: "${rawBrand}")`); continue; }
    const map = (brandSkuMap[matched.tabName] = brandSkuMap[matched.tabName] || new Map());
    if (map.has(normSku)) masterDupeCount++;
    map.set(normSku, name); // overwrite, not push — see comment above
  }
  if (masterDupeCount) {
    console.log(`[inventory-reconciliation] ${masterDupeCount} duplicate SKU row(s) in the master SKU list collapsed to one entry each.`);
  }

  // ── 3. Per brand ─────────────────────────────────────────────────────
  const results = [];
  let noTodayRecordTotal = 0;

  for (const brand of brands) {
    const brandSkuEntries = brandSkuMap[brand.tabName] || new Map();
    const brandSkus = Array.from(brandSkuEntries.entries(), ([sku, name]) => ({ sku, name }));
    if (!brandSkus.length) continue; // nothing to reconcile for this brand

    // SHEET_PRODUCT_INVENTORY: today's row per SKU, if any. Tolerates a
    // missing tab (e.g. High On Love, since sync-products.js only builds
    // tabs for active brands) rather than failing the whole brand.
    let productRows = [];
    try {
      productRows = await readRows(sheets.productInventory, brand.tabName);
    } catch (err) {
      console.warn(`[inventory-reconciliation] ${brand.id} — no SHEET_PRODUCT_INVENTORY tab or read failed (${err.message}) — all marketplace fields will be blank for this brand.`);
    }
    const todayBySku = buildTodayMap(productRows, todayEt);

    const outRows = [];
    let noTodayRecord = 0;
    for (const { sku, name: masterName } of brandSkus) {
      const todayRow = todayBySku[sku] || null;
      if (!todayRow) {
        noTodayRecord++;
        console.log(`[inventory-reconciliation] ${brand.id} — no current-day (${todayEt}) SHEET_PRODUCT_INVENTORY record for SKU ${sku}`);
      }

      const cin7ForSku = cin7ByLocation.map[sku] || {};
      const fba     = cin7ForSku[LOCATIONS.fba]     || null;
      const sf      = cin7ForSku[LOCATIONS.sf]      || null;
      const fbaCa   = cin7ForSku[LOCATIONS.fbaCa]   || null;
      const walmart = cin7ForSku[LOCATIONS.walmart] || null;

      const name = (todayRow && todayRow.name) || masterName || sku;

      outRows.push([
        sku,
        name,
        // Amazon Warehouse USA - FBA
        blankOrNum(todayRow, 'fulfillable_quantity'),
        blankOrNum(todayRow, 'reserved_quantity'),
        blankOrNum(todayRow, 'inbound_working_quantity'),
        blankOrNum(todayRow, 'inbound_shipped_quantity'),
        blankOrNum(todayRow, 'inbound_receiving_quantity'),
        blankOrNum(todayRow, 'unfulfillable_quantity'),
        fba ? fba.qtyOnHand : 0,
        fba ? fba.allocated : 0,
        fba ? fba.available : 0,
        // Medaltus Warehouse - SF
        blankOrNum(todayRow, 'seller_fulfilled_quantity'),
        sf ? sf.qtyOnHand : 0,
        sf ? sf.allocated : 0,
        sf ? sf.available : 0,
        // Amazon - Canada (Newderm) — marketplace side not connected yet, always blank
        '', '', '', '', '', '',
        fbaCa ? fbaCa.qtyOnHand : 0,
        fbaCa ? fbaCa.allocated : 0,
        fbaCa ? fbaCa.available : 0,
        // Walmart — marketplace side not connected yet, always blank
        '',
        walmart ? walmart.qtyOnHand : 0,
        walmart ? walmart.allocated : 0,
        walmart ? walmart.available : 0,
        nowIso,
      ]);
    }

    noTodayRecordTotal += noTodayRecord;
    outRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    if (dryRun) {
      results.push({ brand: brand.id, status: 'ok', skuCount: outRows.length, noTodayRecord, rows: outRows });
      console.log(`[inventory-reconciliation] ${brand.id} — ${outRows.length} SKUs computed (dry run, not written), ${noTodayRecord} missing today's marketplace record`);
      continue;
    }

    try {
      await replaceDataRowsFrom3(sheets.newdermInventory, brand.tabName, outRows);
      results.push({ brand: brand.id, status: 'ok', skuCount: outRows.length, noTodayRecord });
      console.log(`[inventory-reconciliation] ${brand.id} — ${outRows.length} SKUs written, ${noTodayRecord} missing today's marketplace record`);
    } catch (err) {
      const missingTab = /Unable to parse range|not found/i.test(err.message);
      if (missingTab) {
        console.error(`[inventory-reconciliation] ${brand.id} — destination tab "${brand.tabName}" not found in SHEET_NEWDERM_INVENTORY. NOT auto-created — per spec, add it manually (duplicate an existing correctly-formatted tab) then re-run.`);
        results.push({ brand: brand.id, status: 'error', error: 'Destination tab missing — not auto-created, see logs' });
      } else {
        console.error(`[inventory-reconciliation] ${brand.id} failed:`, err.message);
        results.push({ brand: brand.id, status: 'error', error: err.message });
      }
    }
  }

  if (unassigned.length) {
    console.log(`[inventory-reconciliation] ${unassigned.length} regular SKU(s) could not be assigned to any configured brand:`, unassigned.slice(0, 30).join('; '));
  }
  if (duplicateLocationPairs) {
    console.log(`[inventory-reconciliation] ${duplicateLocationPairs} duplicate SKU+location row-pair(s) aggregated (summed) rather than treated as separate rows.`);
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-newderm-inventory-reconciliation',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({
    dryRun,
    targetDate: targetDate || null,
    sourceFile: fileInfo.name,
    sourceFileModified: fileInfo.modifiedTime,
    sourceRowsProcessed: cin7Rows.length,
    synced: results,
    unassignedSkuCount: unassigned.length,
    noTodayRecordTotal,
    duplicateLocationPairsAggregated: duplicateLocationPairs,
    timestamp: nowIso,
  });
};

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeSku(sku) { return String(sku ?? '').trim(); }

function numOrZero(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// SHEET_PRODUCT_INVENTORY field → value, or '' if today's row doesn't
// exist at all for this SKU. Per spec: blank numeric CIN7 values become 0
// (handled separately below), but a MISSING marketplace record stays
// blank, never 0 — these are different conditions and must look different.
function blankOrNum(todayRow, field) {
  if (!todayRow) return '';
  const v = todayRow[field];
  if (v === undefined || v === null || v === '') return 0; // present row, blank cell = 0
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function stripAccents(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Same matching logic as sync-products.js, deliberately without the
// b.active filter that function applies — see file header note.
function matchBrand(rawBrand) {
  const brandNorm = stripAccents(String(rawBrand || '').trim().toLowerCase());
  if (!brandNorm) return null;
  return brands.find(b =>
    brandNorm === stripAccents(b.id.toLowerCase()) ||
    brandNorm === stripAccents((b.displayName || '').toLowerCase()) ||
    brandNorm.includes(stripAccents(b.id.toLowerCase()))
  );
}

// today's date as YYYY-MM-DD in US Eastern, since SHEET_PRODUCT_INVENTORY's
// own date column is written that way (confirmed when that sheet was
// first read for the Listing Audit rebuild).
function getTodayEasternDateString() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// Builds sku -> row for TODAY only. If a SKU has multiple today rows
// (shouldn't normally happen, but per spec: use the most recently
// updated based on last_synced).
function buildTodayMap(rows, todayEt) {
  const out = {};
  for (const row of rows) {
    if ((row.date || '').trim() !== todayEt) continue;
    const sku = normalizeSku(row.sku);
    if (!sku) continue;
    const existing = out[sku];
    if (!existing || (row.last_synced || '') > (existing.last_synced || '')) {
      out[sku] = row;
    }
  }
  return out;
}

// ── Cin7 aggregation — PER LOCATION, not summed across all of them ───────

function aggregateCin7ByLocation(rows) {
  const map = {}; // sku -> { locationName: {qtyOnHand, allocated, available} }
  const seenPairs = new Set();
  let duplicateCount = 0;
  const relevant = new Set(Object.values(LOCATIONS));

  for (const row of rows) {
    const sku = normalizeSku(row.sku);
    const location = String(row.location ?? '').trim();
    if (!sku || sku.toUpperCase().startsWith('C-')) continue; // consignment — out of scope
    if (!relevant.has(location)) continue; // ignore every other Cin7 location entirely

    const pairKey = `${sku}::${location}`;
    if (seenPairs.has(pairKey)) duplicateCount++;
    seenPairs.add(pairKey);

    map[sku] = map[sku] || {};
    const cell = map[sku][location] || { qtyOnHand: 0, allocated: 0, available: 0 };
    cell.qtyOnHand += numOrZero(row.qtyOnHand);
    cell.allocated += numOrZero(row.allocated);
    cell.available += numOrZero(row.available); // summed AS REPORTED — see file header note
    map[sku][location] = cell;
  }
  return { map, duplicateCount };
}

// ── Master SKU list ──────────────────────────────────────────────────────

async function fetchMasterSkuList() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${MASTER_SHEET_GID}`;
  const resp = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master SKU list: ${resp.status}`);
  const csv = await resp.text();
  const lines = csv.trim().split('\n').slice(1);

  const out = [];
  for (const line of lines) {
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const sku = cols[1] || '';
    const name = cols[2] || '';
    const rawBrand = cols[3] || '';
    if (!sku) continue;
    out.push({ sku, name, rawBrand });
  }
  return out;
}

// ── Workbook parsing — same approach as the consignment cron, plus Location ──

function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  let headerRowIdx = -1;
  let colIdx = {};
  for (let i = 0; i < raw.length; i++) {
    const cells = raw[i].map(norm);
    const skuIdx = cells.indexOf('sku');
    const productIdx = cells.indexOf('product');
    const locationIdx = cells.indexOf('location');
    if (skuIdx !== -1 && productIdx !== -1 && locationIdx !== -1) {
      headerRowIdx = i;
      const qtyIdx = cells.findIndex(c => c === 'quantity on hand' || c === 'qty on hand');
      const allocIdx = cells.indexOf('allocated');
      const availIdx = cells.indexOf('available');
      colIdx = { sku: skuIdx, product: productIdx, location: locationIdx, qtyOnHand: qtyIdx, allocated: allocIdx, available: availIdx };
      break;
    }
  }
  if (headerRowIdx === -1) throw new Error('Could not locate header row (need SKU, Product, and Location columns all present)');
  if (colIdx.qtyOnHand === -1) throw new Error('No "Quantity on hand" / "Qty on hand" column found');
  if (colIdx.allocated === -1) throw new Error('No "Allocated" column found');
  if (colIdx.available === -1) throw new Error('No "Available" column found');

  const out = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || !r.length) continue;
    out.push({
      sku: r[colIdx.sku],
      product: r[colIdx.product],
      location: r[colIdx.location],
      qtyOnHand: r[colIdx.qtyOnHand],
      allocated: r[colIdx.allocated],
      available: r[colIdx.available],
    });
  }
  return out;
}

// ── Sheets — row-3-aware clear+write, since this sheet's real data start
// row differs from every other sheet _sheets_client.js's replaceRows()
// assumes. Reuses the same auth token approach (getSheetsToken is
// exported), just with a custom range. ─────────────────────────────────

async function replaceDataRowsFrom3(sheetId, tabName, rows) {
  const token = await getSheetsToken();
  const clearRange = `${tabName}!A3:AC`;
  await sheetsRequest(token, `/${sheetId}/values/${encodeURIComponent(clearRange)}:clear`, 'POST', {});
  if (rows.length) {
    const writeRange = `${tabName}!A3`;
    await sheetsRequest(token, `/${sheetId}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`, 'PUT', { values: rows });
  }
}

async function sheetsRequest(token, path, method, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sheets ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ── Google Drive — identical to the consignment cron's own copy ─────────

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

let _driveTokenCache = null;

async function getGoogleDriveToken() {
  const now = Date.now();
  if (_driveTokenCache && _driveTokenCache.expiresAt > now + 60_000) return _driveTokenCache.token;

  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !rawKey) throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY');

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const payload = base64url(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }));
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(rawKey, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const jwt = `${sigInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google auth failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  _driveTokenCache = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return _driveTokenCache.token;
}

async function findNewestFile(folderId) {
  const accessToken = await getGoogleDriveToken();
  const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Drive files.list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function findFileByDate(folderId, targetDateIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDateIso);
  if (!m) throw new Error(`targetDate must be YYYY-MM-DD, got "${targetDateIso}"`);
  const [, yyyy, mm, dd] = m;
  const dateRegex = new RegExp(`${dd}[/_-]${mm}[/_-]${yyyy}`);

  const accessToken = await getGoogleDriveToken();
  const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Drive files.list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const files = data.files || [];
  const matches = files.filter(f => dateRegex.test(f.name));
  if (matches.length > 1) {
    console.warn(`[inventory-reconciliation] multiple files matched date ${targetDateIso} — using the most recently modified: ${matches.map(f => f.name).join(', ')}`);
  }
  return matches[0] || null;
}

async function downloadFile(fileId) {
  const accessToken = await getGoogleDriveToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive file download failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
