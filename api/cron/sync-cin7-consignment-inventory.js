/**
 * api/cron/sync-cin7-consignment-inventory.js
 *
 * Companion to sync-consignment-inventory.js (ShipStation V2 — MiGuard,
 * Prohibition, HighOnLove). This one covers the four brands whose
 * consignment inventory lives in Cin7 Core instead: Just Bjorn, Hillside
 * Candle, Skinuva, évolis. Eraclea was originally in scope for this cron
 * too but is moving to ShipStation — removed 2026-07-22 per Jaclyn, add it
 * to the sibling ShipStation cron's CONSIGNMENT_BRANDS array instead, once
 * its warehouse ID is known.
 *
 * Cin7 Core has no API and no native file-drop/SFTP export — its
 * Automation module normally emails scheduled reports as attachments.
 * Jaclyn's Drive-export feature is the intake here instead: Cin7 drops a
 * fresh InventoryStockLevel report into a shared Drive folder daily, and
 * this cron finds the newest one, reads it, and writes the result — same
 * "read newest file, extract fields, write to sheet" shape as everything
 * else in this repo, just with Drive-file-lookup standing in for an API call.
 *
 * SOURCE FILE STRUCTURE (confirmed against a real 2026-07-21 export, NOT
 * assumed from the original spec — the spec said headers were on row 2;
 * the real file has them on row 6, after 4 rows of report metadata and a
 * blank "Grand Total" group-header row. Rather than hardcode a row number
 * that's already proven wrong once, this searches for the header row by
 * content — the first row containing both "sku" and "product" cells.
 *
 * Real header names confirmed 2026-07-21: Location, Brand, SKU, Product,
 * Unit, Quantity on hand, Allocated, On order, In transit, Unit cost,
 * Stock on hand, Available. Column matching below tolerates case/spacing
 * variance on the 4 columns actually used (SKU, Product, Quantity on
 * hand, Allocated) since the spec explicitly asked for that and the real
 * header text ("Quantity on hand") already differs slightly from the
 * spec's own example ("Qty on Hand").
 *
 * WHY "available" IS COMPUTED, NOT READ FROM THE REPORT'S OWN "Available"
 * COLUMN: confirmed against real data that Cin7's native Available does
 * NOT simply equal Quantity on hand minus Allocated — found a row showing
 * Available=1517 at a location where both Quantity on hand and Allocated
 * were 0. Whatever Cin7's own column represents, it isn't safe to trust
 * for this purpose, so this cron always derives it from the two summed
 * inputs instead, per Jaclyn's original spec.
 *
 * WHY LOCATION IS IGNORED: the report is a full cross-product of every
 * SKU × all 11 Cin7 locations (confirmed: exactly total_rows/11 unique
 * SKUs, every SKU appearing in all 11). The consignment/non-consignment
 * distinction lives entirely in the SKU itself (the "C-" prefix, or for
 * Just Bjorn, an embedded code in the Product column) — not in which
 * locations happen to be named "Consignment." So every location's row
 * for a matched consignment SKU gets summed in, regardless of that
 * location's own name.
 *
 * JUST BJORN SPECIAL CASE: Just Bjorn doesn't consistently put its C-JBJ
 * SKU in the SKU column. Confirmed 2026-07-21 against real data: of 16
 * unique Just Bjorn products with a non-standard SKU, 9 have an
 * extractable C-JBJ#### code somewhere in the Product column (e.g. SKU
 * "3489122191", Product "*C* C-JBJ0019 just bjorn Chitosan Starter Kit"),
 * and 7 have no extractable code at all (e.g. Product "*C* On-The-Go
 * Stick Packs 3 Pack" — no JBJ code anywhere). Per Jaclyn: if there's no
 * extractable code, skip the row — we cannot safely guess which
 * consignment SKU it belongs to, and a wrong guess is worse than a gap.
 *
 * "OLD SKU" / "DO NOT USE" EXCLUSION: applies globally, not just to Just
 * Bjorn — any row whose Product text contains either phrase is excluded
 * entirely, before grouping. Confirmed real case: SKU "C-JBJ0002" itself
 * carries Product text "OLD SKU - DO NOT USE *C* just bjorn Marine
 * Collagen protein pouch - 17.2oz" and must be excluded, while a
 * DIFFERENT row (SKU "3489122177", Product "C-JBJ0002 *C* just bjorn
 * Marine Collagen protein pouch - 17.2oz", no OLD SKU marker) is the one
 * that should actually be counted under grouping key C-JBJ0002. Per
 * Jaclyn 2026-07-22 — confirmed as a general rule, not Just-Bjorn-specific,
 * since nothing rules out a future export marking an évolis or Hillside
 * row the same way.
 *
 * Sheet: SHEET_CONSIGNMENT_INVENTORY (same sheet as the ShipStation
 * cron — sheets.consignmentInventory must already be configured in
 * config/sheets.js since that cron depends on it too). One tab per brand:
 * just-bjorn, hillside, skinuva, evolis.
 * Columns: sku, name, on_hand, available, last_updated
 * Full clear-and-rewrite per run — current-state snapshot, not a daily
 * history log, matching the ShipStation cron and the original spec's
 * explicit "replace, don't append" instruction.
 *
 * DEPENDENCY: needs the `xlsx` (SheetJS) npm package added to
 * package.json — this repo has never needed to parse a binary Excel file
 * before, everything else here is CSV-over-HTTP or JSON APIs. `npm
 * install xlsx` and confirm it's committed before deploying this. (No
 * JWT library needed for the Drive auth below — see that section for why.)
 *
 * CONFIRMED 2026-07-22: Drive folder ID is 1basS09tY_yw348xDiJbUmRxsIboKe5ux
 * (from https://drive.google.com/drive/folders/1basS09tY_yw348xDiJbUmRxsIboKe5ux),
 * set as env var GOOGLE_CIN7_CONSIGNMENT_FOLDER_ID below. Service account
 * has already been shared as Viewer on that folder — done per Jaclyn.
 */

const { ensureTab, replaceRows } = require('../config/_sheets_client');
const sheets = require('../config/sheets');
const XLSX = require('xlsx');
const { sendCronFailureAlert } = require('../_alerts');

const DRIVE_FOLDER_ID = process.env.GOOGLE_CIN7_CONSIGNMENT_FOLDER_ID; // = 1basS09tY_yw348xDiJbUmRxsIboKe5ux
const HEADERS = ['sku', 'name', 'on_hand', 'available', 'last_updated'];

// Eraclea intentionally removed 2026-07-22 — moving to ShipStation instead.
const CONSIGNMENT_BRANDS = [
  { brandId: 'just-bjorn', skuPrefix: 'JBJ', tabName: 'just-bjorn' },
  { brandId: 'hillside',   skuPrefix: 'HIL', tabName: 'hillside' },
  { brandId: 'skinuva',    skuPrefix: 'SVA', tabName: 'skinuva' },
  { brandId: 'evolis',     skuPrefix: 'EVO', tabName: 'evolis' },
];

const EXCLUDE_PATTERN = /old sku|do not use/i;
const JBJ_EXTRACT_PATTERN = /(C-JBJ\d+)/i;
const STANDARD_SKU_PATTERN = /^(C-([A-Z]+)\d+)$/i;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.consignmentInventory) {
    await sendCronFailureAlert('sync-cin7-consignment-inventory', 'sheets.consignmentInventory is not configured in config/sheets.js');
    return res.status(500).json({ error: 'sheets.consignmentInventory is not configured in config/sheets.js' });
  }
  if (!DRIVE_FOLDER_ID) {
    await sendCronFailureAlert('sync-cin7-consignment-inventory', 'GOOGLE_CIN7_CONSIGNMENT_FOLDER_ID is not set');
    return res.status(500).json({ error: 'GOOGLE_CIN7_CONSIGNMENT_FOLDER_ID is not set' });
  }

  // Test-only params, both optional — normal scheduled runs pass neither.
  // ?targetDate=YYYY-MM-DD — test against a SPECIFIC day's file by name
  // (matches "InventoryStockLevel_DD_MM_YYYY-*.xlsx") instead of whatever's
  // currently newest. Without this, once today's file has also landed,
  // "newest" silently stops meaning "yesterday's" — this makes the target
  // explicit instead of relying on timing.
  // ?dryRun=true — run the full pipeline (find/download/parse/aggregate)
  // but skip the actual ensureTab/replaceRows write, returning the rows
  // that WOULD have been written instead. Safe to run against the real
  // destination sheet with zero risk of touching it.
  const targetDate = (req.query && req.query.targetDate) || '';
  const dryRun = String((req.query && req.query.dryRun) || '').toLowerCase() === 'true';

  const now = new Date().toISOString();

  let fileInfo;
  try {
    fileInfo = targetDate
      ? await findFileByDate(DRIVE_FOLDER_ID, targetDate)
      : await findNewestFile(DRIVE_FOLDER_ID);
  } catch (err) {
    await sendCronFailureAlert('sync-cin7-consignment-inventory', err.message, { Stage: 'finding the Cin7 export in Drive' });
    return res.status(500).json({ error: 'Failed to find the Cin7 export in Drive', detail: err.message });
  }
  if (!fileInfo) {
    const msg = targetDate
      ? `No file found in the Cin7 export Drive folder matching date ${targetDate}`
      : 'No files found in the Cin7 export Drive folder';
    // A missing daily export is exactly the kind of silent gap this whole
    // system is trying to catch — worth an alert, not just a 404 nobody sees.
    await sendCronFailureAlert('sync-cin7-consignment-inventory', msg);
    return res.status(404).json({ error: msg });
  }

  let rows;
  try {
    const buffer = await downloadFile(fileInfo.id);
    rows = parseWorkbook(buffer);
  } catch (err) {
    console.error(`[sync-cin7-consignment-inventory] failed to read "${fileInfo.name}" (${fileInfo.id}):`, err.message);
    // Per spec: never erase existing destination data on a bad/missing file.
    await sendCronFailureAlert('sync-cin7-consignment-inventory', err.message, { Stage: 'reading/parsing source file', File: fileInfo.name });
    return res.status(500).json({ error: 'Failed to read or parse the source file', file: fileInfo.name, detail: err.message });
  }

  console.log(`[sync-cin7-consignment-inventory] source file: "${fileInfo.name}" (modified ${fileInfo.modifiedTime}) — ${rows.length} data rows${dryRun ? ' [DRY RUN]' : ''}`);

  const { groups, skippedNoCode, skippedExcluded, unmatched } = aggregateConsignmentRows(rows);

  const results = [];
  for (const { brandId, skuPrefix, tabName } of CONSIGNMENT_BRANDS) {
    try {
      const brandGroups = Object.entries(groups).filter(([key]) => key.startsWith(skuPrefix + '::'));
      const outRows = brandGroups.map(([, g]) => {
        const available = g.onHand - g.allocated;
        return [g.sku, g.name, g.onHand, available, now];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

      if (!dryRun) {
        const token = await ensureTab(sheets.consignmentInventory, tabName, HEADERS);
        await replaceRows(sheets.consignmentInventory, tabName, HEADERS, outRows, token);
      }

      const brandDupeNames = brandGroups.filter(([, g]) => g.names.size > 1);
      if (brandDupeNames.length) {
        console.warn(`[sync-cin7-consignment-inventory] ${brandId} — ${brandDupeNames.length} SKU(s) had conflicting product names across rows:`,
          brandDupeNames.map(([, g]) => `${g.sku}: [${Array.from(g.names).join(' | ')}]`).join('; '));
      }

      console.log(`[sync-cin7-consignment-inventory] ${brandId} — ${outRows.length} consignment SKUs ${dryRun ? 'computed (not written)' : 'written'}`);
      results.push({
        brand: brandId, status: 'ok', skuCount: outRows.length,
        ...(dryRun ? { rows: outRows } : {}), // only inline the actual data on dry runs — keep the real response small
      });
    } catch (err) {
      console.error(`[sync-cin7-consignment-inventory] ${brandId} failed:`, err.message);
      results.push({ brand: brandId, status: 'error', error: err.message });
    }
  }

  if (skippedNoCode.length) {
    console.log(`[sync-cin7-consignment-inventory] ${skippedNoCode.length} Just Bjorn row(s) had no extractable C-JBJ code — skipped:`, skippedNoCode.slice(0, 20).join('; '));
  }
  if (skippedExcluded.length) {
    console.log(`[sync-cin7-consignment-inventory] ${skippedExcluded.length} row(s) excluded via OLD SKU / DO NOT USE marker:`, skippedExcluded.slice(0, 20).join('; '));
  }
  if (unmatched.length) {
    console.log(`[sync-cin7-consignment-inventory] ${unmatched.length} row(s) looked like consignment SKUs but didn't match any of the 4 supported brand prefixes:`, unmatched.slice(0, 20).join('; '));
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-cin7-consignment-inventory',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': `${failedBrands.length} of ${CONSIGNMENT_BRANDS.length}` }
    );
  }

  res.status(200).json({
    dryRun,
    targetDate: targetDate || null,
    sourceFile: fileInfo.name,
    sourceFileModified: fileInfo.modifiedTime,
    sourceRowsProcessed: rows.length,
    synced: results,
    justBjornSkippedNoCode: skippedNoCode.length,
    excludedOldSku: skippedExcluded.length,
    unmatchedConsignmentSkus: unmatched.length,
    timestamp: now,
  });
};

// ── Aggregation ──────────────────────────────────────────────────────────

function aggregateConsignmentRows(rows) {
  const groups = {}; // "PREFIX::SKU" -> { sku, name, onHand, allocated, names:Set }
  const skippedNoCode = [];
  const skippedExcluded = [];
  const unmatched = [];
  const supportedPrefixes = new Set(CONSIGNMENT_BRANDS.map(b => b.skuPrefix));

  for (const row of rows) {
    const skuRaw = String(row.sku ?? '').trim();
    const product = String(row.product ?? '').trim();
    const qty = numOrZero(row.qtyOnHand);
    const alloc = numOrZero(row.allocated);

    if (EXCLUDE_PATTERN.test(product)) {
      skippedExcluded.push(`${skuRaw} (${product.slice(0, 60)})`);
      continue;
    }

    let key, prefix, groupSku;
    const stdMatch = STANDARD_SKU_PATTERN.exec(skuRaw);
    if (stdMatch) {
      groupSku = stdMatch[1].toUpperCase();
      prefix = stdMatch[2].toUpperCase();
    } else {
      const jbjMatch = JBJ_EXTRACT_PATTERN.exec(product);
      if (jbjMatch) {
        groupSku = jbjMatch[1].toUpperCase();
        prefix = 'JBJ';
      } else if (skuRaw.toUpperCase().startsWith('C-JBJ') || /just\s*bjorn/i.test(product)) {
        // Looks like a Just Bjorn consignment item (brand mentioned, or a
        // malformed C-JBJ-ish SKU) but no clean extractable code — per
        // Jaclyn: skip rather than guess.
        skippedNoCode.push(`${skuRaw} (${product.slice(0, 60)})`);
        continue;
      } else {
        continue; // not a consignment row for any brand we handle at all
      }
    }

    if (!supportedPrefixes.has(prefix)) {
      unmatched.push(`${groupSku} (${product.slice(0, 60)})`);
      continue;
    }

    key = `${prefix}::${groupSku}`;
    if (!groups[key]) groups[key] = { sku: groupSku, name: product, onHand: 0, allocated: 0, names: new Set() };
    groups[key].onHand += qty;
    groups[key].allocated += alloc;
    if (product) groups[key].names.add(product);
  }

  // Prefer the first non-"OLD SKU" name already guaranteed by the exclude
  // filter above; if a group somehow collected multiple distinct names
  // (logged as a warning per-brand above), keep whichever was seen first.
  Object.values(groups).forEach(g => { g.name = Array.from(g.names)[0] || g.sku; });

  return { groups, skippedNoCode, skippedExcluded, unmatched };
}

function numOrZero(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// ── Workbook parsing ─────────────────────────────────────────────────────

// Finds the header row by content (first row containing both a "sku" and
// a "product" cell) rather than a hardcoded row number — the spec assumed
// row 2, the real file had it on row 6. Column matching tolerates case/
// spacing variance per the spec's own requirement.
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  let headerRowIdx = -1;
  let colIdx = {};
  for (let i = 0; i < raw.length; i++) {
    const cells = raw[i].map(norm);
    const skuIdx = cells.indexOf('sku');
    const productIdx = cells.indexOf('product');
    if (skuIdx !== -1 && productIdx !== -1) {
      headerRowIdx = i;
      const qtyIdx = cells.findIndex(c => c === 'quantity on hand' || c === 'qty on hand');
      const allocIdx = cells.indexOf('allocated');
      colIdx = { sku: skuIdx, product: productIdx, qtyOnHand: qtyIdx, allocated: allocIdx };
      break;
    }
  }
  if (headerRowIdx === -1) throw new Error('Could not locate header row (no row found with both "SKU" and "Product" columns)');
  if (colIdx.qtyOnHand === -1) throw new Error('Header row found, but no "Quantity on hand" / "Qty on hand" column present');
  if (colIdx.allocated === -1) throw new Error('Header row found, but no "Allocated" column present');

  const out = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || !r.length) continue;
    out.push({
      sku: r[colIdx.sku],
      product: r[colIdx.product],
      qtyOnHand: r[colIdx.qtyOnHand],
      allocated: r[colIdx.allocated],
    });
  }
  return out;
}

// ── Google Drive ─────────────────────────────────────────────────────────
// Deliberately NOT reusing _sheets_client.js's getSheetsToken() — that
// function's scope is hardcoded to spreadsheets-only, and this needs
// drive.readonly instead. Same underlying approach though: raw
// crypto.createSign('RSA-SHA256'), no external JWT library — confirmed
// 2026-07-22 against the real _sheets_client.js that this codebase has no
// jsonwebtoken dependency anywhere, so this avoids introducing one just
// for this file. If a third Drive-based cron shows up, this and the
// Cosmette holiday-schedule fetcher's near-identical copy are both worth
// consolidating into a shared _drive.js — not done here to keep this
// change scoped to just this one file.

const crypto = require('crypto');

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

let _driveTokenCache = null;

async function getGoogleDriveToken() {
  const now = Date.now();
  if (_driveTokenCache && _driveTokenCache.expiresAt > now + 60_000) {
    return _driveTokenCache.token;
  }

  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !rawKey) throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY');

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const payload = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
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

// Test-only: find a file by DATE rather than "whatever's newest right now."
// CORRECTED 2026-07-22: real filenames in the actual Drive folder look
// like InventoryStockLevel_21/07/2026-16:46.xlsx — forward slashes and a
// colon, confirmed directly from a Drive screenshot. The sample .xlsx
// Jaclyn uploaded to this chat showed underscores instead
// (InventoryStockLevel_21_07_2026-16_46.xlsx) — that's Claude's own file
// upload pipeline silently sanitizing filesystem-illegal characters
// (/ and :) on the way in, not what Cin7 actually names its exports.
// Matching a flexible separator (/, _, or -) between the date parts
// instead of a fixed one, so this survives either convention and doesn't
// break again if Cin7's own naming shifts a second time.
async function findFileByDate(folderId, targetDateIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDateIso);
  if (!m) throw new Error(`targetDate must be YYYY-MM-DD, got "${targetDateIso}"`);
  const [, yyyy, mm, dd] = m;
  const dateRegex = new RegExp(`${dd}[/_-]${mm}[/_-]${yyyy}`); // matches "21/07/2026" or "21_07_2026" or "21-07-2026"

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
    console.warn(`[sync-cin7-consignment-inventory] multiple files matched date ${targetDateIso} — using the most recently modified: ${matches.map(f => f.name).join(', ')}`);
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
