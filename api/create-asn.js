// api/create-asn.js
//
// Creates a new ASN (Advance Shipping Notice) from a parsed CSV upload:
//   1. Copies the blank ASN template into the ASNs Drive folder
//   2. Writes the header block + line items into the new sheet
//   3. Appends a row to Évolis's own master tracker (Inbound_Shipments tab)
//   4. Returns the new shipment ID + sheet URL so the dashboard can render
//      the new card immediately without waiting for a full re-fetch
//
// Manually-triggered from the dashboard's "Create ASN" button — no
// CRON_SECRET, same exception already established for run-analysis.js.
//
// Uses the real config/_sheets_client.js (confirmed from GitHub commit
// history, 2026-07-23) for the one thing it already covers well — the
// master-tracker append, via appendRows() + its own getSheetsToken()
// caching/retry-with-backoff. Two things it does NOT cover, so these stay
// on direct `googleapis` calls:
//   - Drive file-copy (the shared client only ever requests the
//     spreadsheets scope, never drive)
//   - Arbitrary single-cell/range writes into the new ASN sheet's header
//     block (B3, B5, etc.) and line-item grid — ensureTab/appendRows/
//     replaceRows are all header+full-column shaped, not a fit for writing
//     specific cells. Worth asking Jaclyn whether it's worth exporting the
//     module's internal sheetsPost/sheetsGet too, since this is exactly
//     the kind of write that recurs.
//
// ⚠️ Built against _sheets_client (9) from commit history, not confirmed
// HEAD — diff against your actual current file before trusting this.
// ⚠️ Not tested against the live sheets/Drive folder — curl it against a
// throwaway copy of the template first.

const { google } = require('googleapis');
const { appendRows, getSheetsToken } = require('./config/_sheets_client');

const ASN_TEMPLATE_ID = '12wOeZryBrUKsWFrPr6SzHadwEti1SI1hEEv1X2vjHkk';
const ASN_DRIVE_FOLDER_ID = '1UNcwvEitFys68i1xDhZNW1ly4hq1VrRE';
const TRACKER_SHEET_ID = '1Pb50CzCb0fouNsaewQATEY_c3IpgRVPu5FoppNg19_A';
const TRACKER_TAB = 'Inbound_Shipments';

// Separate from _sheets_client's own getSheetsToken() because Drive
// file-copy needs the drive scope, which that module never requests.
function getDriveSheetsAuth() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY env vars');
  }
  return new google.auth.JWT(email, null, key, [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.projects', // needed to push the Apps
    // Script project onto each new ASN file — Drive's files.copy does NOT
    // duplicate a container-bound script (documented API limitation), so
    // this has to be pushed explicitly via the separate Apps Script API.
  ]);
}

function generateShipmentId(uploadDate) {
  const ymd = uploadDate.replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/1 to avoid ambiguity
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `ASN-${ymd}-${suffix}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// appsscript.json manifest — required alongside Code.gs for any Apps
// Script project pushed via script.projects.updateContent.
const ASN_APPSSCRIPT_MANIFEST = JSON.stringify({
  timeZone: 'America/New_York',
  exceptionLogging: 'STACKDRIVER',
  runtimeVersion: 'V8',
});

// Full Medaltus ASN script (Jaclyn's corrected évolis version, 2026-07-24).
// Embedded verbatim so it can be pushed onto every new ASN file's bound
// script project via the Apps Script API — see step 4 below for why this
// is necessary rather than relying on the copy itself to carry it over.
const ASN_APPS_SCRIPT_SOURCE = `/**
 * Medaltus ASN — Évolis
 * ----------------------------------------
 * Bound to the évolis ASN template, so every new ASN copied from it
 * automatically inherits this whole menu. Adapted from Luccini's own
 * receiving-labels script — same menu, same label designs — with two
 * real changes for évolis:
 *
 *   1. "Close Shipment & Generate CSVs" now actually closes the shipment
 *      from THIS sheet (Luccini's version only ever showed an alert
 *      telling you to go open the master sheet instead — per Jaclyn,
 *      évolis needs closing to work from the individual ASN sheet).
 *   2. Every function that used to look up Color/Size/Case Qty from
 *      Luccini's Master_Products sheet (a second spreadsheet, keyed by a
 *      Medaltus-SKU-vs-Luccini-SKU translation) now just reads directly
 *      off THIS sheet's own columns instead — évolis has one SKU per
 *      product, not two, and Case Qty / # of Cases are already columns
 *      on the ASN itself, so there's nothing to look up.
 *
 * Everything else (label HTML/CSS, Initialize Sheet Tabs, the overall
 * menu shape) is unchanged from Luccini's version — those were never
 * Luccini-specific, they just lived in a Luccini-specific file.
 *
 * ⚠️ NOT YET TESTED against a real évolis ASN sheet or the live tracker.
 * Run Close Shipment once against a throwaway copy before a real shipment.
 * ShipStation CSV format (SKU,ProductName,Loc1-4,Stock,ReorderThreshold,
 * Cost) is confirmed from Luccini's own generateShipStationCsvFromAsnFile.
 *
 * Pushed automatically onto every new ASN sheet by create-asn.js via the
 * Apps Script API, since Drive's files.copy does not duplicate bound
 * scripts. Edit the copy embedded in create-asn.js to make changes stick
 * for future ASNs — editing a single existing ASN's script directly only
 * affects that one file.
 */

var TRACKER_SHEET_ID = '1Pb50CzCb0fouNsaewQATEY_c3IpgRVPu5FoppNg19_A';
var TRACKER_TAB       = 'Inbound_Shipments';
var ALERT_RECIPIENTS  = ['jrisser@medaltus.com', 'awilcox@medaltus.com'];
var FOOTER_ADDR       = 'Medaltus  ·  265 Treeland Drive  ·  Ladson, SC 29456';
var DEFAULT_LOCATION  = 'Medaltus';

var SHIPMENT_ID_ROW = 3;
var STATUS_ROW      = 5;
var HEADER_ROW      = 13;
var FIRST_DATA_ROW  = 14;

// Évolis's own 8-column line-item layout (SKU | Product Name | Expected
// Qty | Received Qty | Discrepancy | Case Qty | # of Cases | Location) —
// different from Luccini's 6-column ASN + separate Master_Products lookup.
var COL_ASN = {
  SKU:          1,
  PRODUCT_NAME: 2,
  EXPECTED_QTY: 3,
  RECEIVED_QTY: 4,
  DISCREPANCY:  5,
  CASE_QTY:     6,
  NUM_CASES:    7,
  LOCATION:     8,
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚀 Medaltus ASN')
    .addItem('Close Shipment & Generate CSVs',      'closeShipment')
    .addItem('Generate ShipStation CSV (this ASN)',  'generateShipStationCsvFromAsnFile')
    .addSeparator()
    .addItem('🏷️  Print Pallet Labels',              'showPalletLabels')
    .addItem('📦  Print Case Labels',                'showCaseLabels')
    .addSeparator()
    .addItem('Initialize Sheet Tabs',                'initializeTabs')
    .addToUi();
}

// ── Utilities ────────────────────────────────────────────────────────────
function isBlank(v) { return v === '' || v === null || v === undefined; }
function safe(v)    { return isBlank(v) ? '' : String(v).trim(); }
function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function csvEscape(val) {
  var s = String(val == null ? '' : val);
  return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function getShipmentId(sheet) {
  var val = sheet.getRange(SHIPMENT_ID_ROW, 2).getValue();
  if (!isBlank(val)) return safe(val);
  var name  = SpreadsheetApp.getActiveSpreadsheet().getName();
  var match = name.match(/ASN-\\S+/);
  return match ? match[0] : name;
}

// Reads évolis's own line items directly — no Master_Products lookup,
// since Case Qty / # of Cases / Location are already columns on this
// sheet, and there's only one SKU system (no Medaltus-vs-Luccini split).
function readAsnRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return [];
  var numRows = lastRow - FIRST_DATA_ROW + 1;
  var values  = sheet.getRange(FIRST_DATA_ROW, 1, numRows, 8).getValues();
  var items = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var sku = safe(row[COL_ASN.SKU - 1]);
    if (!sku) continue;
    var receivedRaw = row[COL_ASN.RECEIVED_QTY - 1];
    items.push({
      row:         FIRST_DATA_ROW + i,
      sku:         sku,
      productName: safe(row[COL_ASN.PRODUCT_NAME - 1]),
      expectedQty: parseInt(row[COL_ASN.EXPECTED_QTY - 1]) || 0,
      receivedQty: isBlank(receivedRaw) ? '' : (parseInt(receivedRaw) || 0),
      caseQty:     parseInt(row[COL_ASN.CASE_QTY - 1]) || 0,
      numCases:    parseInt(row[COL_ASN.NUM_CASES - 1]) || 0,
      location:    safe(row[COL_ASN.LOCATION - 1]) || DEFAULT_LOCATION,
    });
  }
  return items;
}

// ── Close Shipment (the actual fix — works from THIS sheet) ─────────────
function closeShipment() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();

  var shipmentId = getShipmentId(sheet);
  if (!shipmentId) {
    ui.alert('No Shipment ID found in B' + SHIPMENT_ID_ROW + ' — is this the right sheet?');
    return;
  }
  var currentStatus = safe(sheet.getRange(STATUS_ROW, 2).getValue());
  if (currentStatus === 'Received') {
    ui.alert('This shipment is already marked Received.');
    return;
  }

  var lineItems = readAsnRows(sheet);
  if (!lineItems.length) {
    ui.alert('No line items found starting at row ' + FIRST_DATA_ROW + '.');
    return;
  }
  var missingReceived = lineItems.filter(function (li) { return li.receivedQty === ''; });
  if (missingReceived.length) {
    var proceed = ui.alert(
      'Confirm Close',
      missingReceived.length + ' of ' + lineItems.length + ' SKU(s) have no Received Qty entered. ' +
      'Close anyway? (Blank rows will be treated as 0 received.)',
      ui.ButtonSet.YES_NO
    );
    if (proceed !== ui.Button.YES) return;
  }

  var discrepancyCount = 0;
  lineItems.forEach(function (li) {
    var received = li.receivedQty === '' ? 0 : li.receivedQty;
    var discrepancy = received - li.expectedQty;
    sheet.getRange(li.row, COL_ASN.DISCREPANCY).setValue(discrepancy);
    if (discrepancy !== 0) discrepancyCount++;
  });

  var receivedDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyy-MM-dd');
  sheet.getRange(STATUS_ROW, 2).setValue('Received');
  updateTrackerRow(shipmentId, receivedDate, discrepancyCount);

  var shipStationCsv = buildShipStationCsv(lineItems);
  var discrepancyCsv = buildDiscrepancyCsv(lineItems);
  sendCloseEmail(shipmentId, receivedDate, discrepancyCount, shipStationCsv, discrepancyCsv);

  ui.alert('Shipment ' + shipmentId + ' closed. ' + discrepancyCount + ' discrepanc' +
    (discrepancyCount === 1 ? 'y' : 'ies') + ' found. Reports emailed to ' + ALERT_RECIPIENTS.join(' and ') + '.');
}

function updateTrackerRow(shipmentId, receivedDate, discrepancyCount) {
  var tracker = SpreadsheetApp.openById(TRACKER_SHEET_ID).getSheetByName(TRACKER_TAB);
  if (!tracker) throw new Error('Tracker tab "' + TRACKER_TAB + '" not found on the master sheet');
  var data = tracker.getRange(1, 1, tracker.getLastRow(), 10).getValues();
  var rowIdx = -1;
  for (var i = 0; i < data.length; i++) {
    if (safe(data[i][0]) === shipmentId) { rowIdx = i; break; }
  }
  if (rowIdx < 0) throw new Error('Shipment ' + shipmentId + ' not found on the master tracker');
  var sheetRow = rowIdx + 1; // 1-indexed
  tracker.getRange(sheetRow, 3).setValue('Received');   // C = Status
  tracker.getRange(sheetRow, 8).setValue(receivedDate); // H = ReceivedDate
  tracker.getRange(sheetRow, 9).setValue(discrepancyCount); // I = DiscrepancyCount
}

// Confirmed directly from Luccini's own generateShipStationCsvFromAsnFile.
function buildShipStationCsv(lineItems) {
  var lines = ['SKU,ProductName,Loc1,Loc2,Loc3,Loc4,Stock,ReorderThreshold,Cost'];
  lineItems.forEach(function (li) {
    var received = li.receivedQty === '' ? 0 : li.receivedQty;
    if (received <= 0) return;
    lines.push([
      csvEscape(li.sku), csvEscape(li.productName), csvEscape(li.location || DEFAULT_LOCATION),
      '', '', '', received, '', '',
    ].join(','));
  });
  return lines.join('\\n');
}

function buildDiscrepancyCsv(lineItems) {
  var lines = ['SKU,Product Name,Expected Qty,Received Qty,Discrepancy'];
  lineItems.forEach(function (li) {
    var received = li.receivedQty === '' ? 0 : li.receivedQty;
    lines.push([csvEscape(li.sku), csvEscape(li.productName), li.expectedQty, received, received - li.expectedQty].join(','));
  });
  return lines.join('\\n');
}

function sendCloseEmail(shipmentId, receivedDate, discrepancyCount, shipStationCsv, discrepancyCsv) {
  var subject = 'ASN Closed: ' + shipmentId + ' (' + discrepancyCount + ' discrepanc' + (discrepancyCount === 1 ? 'y' : 'ies') + ')';
  var body = 'Shipment ' + shipmentId + ' was marked Received on ' + receivedDate + '.\\n\\n' +
    'Discrepancies found: ' + discrepancyCount + '\\n\\n' +
    'Attached: ShipStation import CSV and a full discrepancy report.';
  MailApp.sendEmail({
    to: ALERT_RECIPIENTS.join(','),
    subject: subject,
    body: body,
    attachments: [
      Utilities.newBlob(shipStationCsv, 'text/csv', shipmentId + '-shipstation.csv'),
      Utilities.newBlob(discrepancyCsv, 'text/csv', shipmentId + '-discrepancy-report.csv'),
    ],
  });
}

// ── Generate ShipStation CSV (this ASN) — standalone, no Close needed ───
function generateShipStationCsvFromAsnFile() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var lineItems = readAsnRows(sheet).filter(function (li) { return li.receivedQty !== '' && li.receivedQty > 0; });
  if (!lineItems.length) {
    ui.alert('No items with received quantities > 0 found.\\nPlease fill in the Received Qty column first.');
    return;
  }
  var shipmentId = getShipmentId(sheet);
  var csvContent = buildShipStationCsv(lineItems);
  var fileName = 'ShipStation_Import_' + shipmentId + '_' + new Date().toISOString().slice(0, 10) + '.csv';
  downloadCsvViaDialog(csvContent, fileName);
}

function downloadCsvViaDialog(csvContent, fileName) {
  var html = '<html><body><script>' +
    'var c=' + JSON.stringify(csvContent) + ';' +
    'var b=new Blob([c],{type:"text/csv;charset=utf-8;"});' +
    'var u=URL.createObjectURL(b);var a=document.createElement("a");' +
    'a.href=u;a.download=' + JSON.stringify(fileName) + ';document.body.appendChild(a);a.click();' +
    'setTimeout(function(){URL.revokeObjectURL(u);google.script.host.close();},1500);' +
    '<\\/script><p style="font-family:Arial;color:#001F60;padding:20px">Downloading <strong>' + fileName + '<\\/strong>…<\\/p><\\/body><\\/html>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(380).setHeight(120),
    'Downloading CSV…'
  );
}

// ── Print Pallet Labels / Print Case Labels ──────────────────────────────
// Both read directly off this sheet's own rows now — no Master_Products
// lookup, no Color/Size (évolis doesn't have those attributes), Case Qty
// comes straight from this ASN's own Case Qty column.
function showPalletLabels() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var asnId = getShipmentId(sheet);
  var rows = readAsnRows(sheet);
  if (rows.length === 0) { ui.alert('No data rows found.'); return; }
  var pallets = rows.map(function (row, idx) {
    return {
      palletNum: idx + 1,
      asnId: asnId,
      sku: row.sku,
      productName: row.productName,
      receivedQty: row.receivedQty === '' ? row.expectedQty : row.receivedQty,
    };
  });
  var html = buildLabelsPage(pallets.map(buildPalletTagHtml), pallets.length, 'Pallet');
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(520).setHeight(680),
    '🏷️  Pallet Labels (' + pallets.length + ')'
  );
}

function showCaseLabels() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var asnId = getShipmentId(sheet);
  var rows = readAsnRows(sheet);
  if (rows.length === 0) { ui.alert('No data rows found.'); return; }
  var caseLabels = [];
  var warnings = [];
  rows.forEach(function (row) {
    var caseQty = row.caseQty || 0;
    var recvd = row.receivedQty === '' ? row.expectedQty : row.receivedQty;
    if (caseQty <= 0) { warnings.push(row.sku + ' — no Case Qty filled in on this ASN (skipped)'); return; }
    var numCases = Math.ceil(recvd / caseQty);
    for (var c = 1; c <= numCases; c++) {
      var unitsThisCase = (c === numCases && (recvd % caseQty !== 0)) ? (recvd % caseQty) : caseQty;
      caseLabels.push({
        caseNum: c, totalCases: numCases, asnId: asnId,
        sku: row.sku, productName: row.productName,
        unitsInCase: unitsThisCase, caseQty: caseQty, totalUnits: recvd,
      });
    }
  });
  if (caseLabels.length === 0) {
    ui.alert('No case labels generated.\\n\\nFill in the Case Qty column on this ASN sheet first.');
    return;
  }
  if (warnings.length > 0) ui.alert('⚠️  Some SKUs skipped (no case qty):\\n\\n' + warnings.join('\\n'));
  var html = buildLabelsPage(caseLabels.map(buildCaseTagHtml), caseLabels.length, 'Case');
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(520).setHeight(680),
    '📦  Case Labels (' + caseLabels.length + ')'
  );
}

// Label HTML/CSS below is unchanged from Luccini's version — this was
// always generic Medaltus branding, never Luccini-specific, it just lived
// in a Luccini-specific file. Only buildPalletTagHtml/buildCaseTagHtml
// were trimmed to drop the "Luccini: <sku>" sub-line and Color/Size attrs,
// since évolis has neither a second SKU system nor those attributes.
function buildLabelsPage(tagHtmls, count, type) {
  return (
    '<!DOCTYPE html><html><head><base target="_top">' +
    '<style>' +
    '  @page { size: 4in 6in; margin: 0; }' +
    '  * { box-sizing: border-box; margin: 0; padding: 0; }' +
    '  body { font-family: Arial, Helvetica, sans-serif; background: #ccc; }' +
    '  .toolbar { position: sticky; top: 0; background: #001F60; padding: 10px 16px;' +
    '             text-align: center; z-index: 10; display: flex; align-items: center; justify-content: center; gap: 12px; }' +
    '  .toolbar span { color: rgba(255,255,255,0.7); font-size: 12px; }' +
    '  .toolbar button { background: #fff; color: #001F60; border: none; font-size: 14px;' +
    '                    font-weight: 700; padding: 8px 24px; border-radius: 4px; cursor: pointer; }' +
    '  .tag { width: 4in; height: 6in; background: #fff; margin: 14px auto; padding: 0.2in;' +
    '         display: flex; flex-direction: column; border: 1px solid #999; page-break-after: always; }' +
    '  .tag-header { background: #001F60; color: #fff; text-align: center;' +
    '                padding: 8px 0; margin: -0.2in -0.2in 0.18in -0.2in;' +
    '                font-size: 11px; letter-spacing: 2px; font-weight: 700; }' +
    '  .tag-header .brand { font-size: 18px; letter-spacing: 1px; display: block; margin-bottom: 2px; }' +
    '  .tag-header .brand span { color: #24E9A3; }' +
    '  .pallet-num { font-size: 42px; font-weight: 900; text-align: center;' +
    '                border-bottom: 3px solid #000; padding-bottom: 10px; margin-bottom: 12px;' +
    '                color: #000; line-height: 1; }' +
    '  .pallet-num .lbl { font-size: 14px; font-weight: 400; letter-spacing: 2px;' +
    '                     color: #333; display: block; margin-bottom: 4px; }' +
    '  .sku-block { text-align: center; margin-bottom: 12px; }' +
    '  .sku-block .medaltus-sku { font-size: 30px; font-weight: 700; color: #000; font-family: monospace; }' +
    '  .sku-block .lbl { font-size: 13px; letter-spacing: 2px; color: #333; }' +
    '  .product-name { text-align: center; font-size: 28px; font-weight: 700; color: #000;' +
    '                  margin-bottom: 12px; line-height: 1.3; }' +
    '  .attrs { display: flex; justify-content: space-around; margin-bottom: 10px; }' +
    '  .attr { flex: 1; text-align: center; }' +
    '  .attr .val { font-size: 26px; font-weight: 700; color: #000; }' +
    '  .attr .lbl { font-size: 13px; letter-spacing: 1.5px; color: #333; }' +
    '  .stats-row { display: flex; justify-content: space-around;' +
    '               border-top: 2.5px solid #000; border-bottom: 2.5px solid #000;' +
    '               padding: 10px 0; margin-bottom: 10px; }' +
    '  .stats-row .val { font-size: 36px; font-weight: 900; color: #000; }' +
    '  .stats-row .lbl { font-size: 13px; letter-spacing: 1.5px; color: #333; }' +
    '  .case-badge { border: 2px solid #000; color: #000; font-size: 16px; font-weight: 700;' +
    '                text-align: center; padding: 5px; margin-bottom: 8px; letter-spacing: 1px; }' +
    '  .tag-footer { margin-top: auto; border-top: 1px solid #999; padding-top: 8px;' +
    '                display: flex; justify-content: space-between; align-items: flex-end; }' +
    '  .tag-footer .addr { font-size: 11px; color: #333; line-height: 1.5; }' +
    '  .tag-footer .asn { font-size: 11px; font-weight: 700; color: #000;' +
    '                     text-align: right; font-family: monospace; line-height: 1.5; }' +
    '  @media print {' +
    '    body { background: #fff; }' +
    '    .toolbar { display: none; }' +
    '    .tag { margin: 0; border: none; }' +
    '  }' +
    '</style></head><body>' +
    '<div class="toolbar">' +
    '  <button onclick="window.print()">🖨️  Print ' + count + ' ' + type + ' Label' + (count !== 1 ? 's' : '') + '</button>' +
    '  <span>' + count + ' label' + (count !== 1 ? 's' : '') + ' total</span>' +
    '</div>' +
    tagHtmls.join('\\n') +
    '</body></html>'
  );
}

function buildPalletTagHtml(p) {
  var shortName = p.productName.indexOf(' | ') !== -1 ? p.productName.split(' | ')[0].trim() : p.productName;
  return (
    '<div class="tag">' +
    '  <div class="tag-header"><span class="brand">medalt<span>us</span>.</span>PALLET RECEIVING TAG</div>' +
    '  <div class="pallet-num"><span class="lbl">PALLET #</span>' + escHtml(p.palletNum) + '</div>' +
    '  <div class="sku-block"><div class="lbl">SKU</div>' +
    '    <div class="medaltus-sku">' + escHtml(p.sku) + '</div></div>' +
    '  <div class="product-name">' + escHtml(shortName) + '</div>' +
    '  <div class="stats-row">' + attrDiv(p.receivedQty.toLocaleString(), 'UNITS RECEIVED') + '</div>' +
    '  <div class="tag-footer"><div class="addr">' + escHtml(FOOTER_ADDR) + '</div>' +
    '    <div class="asn">ASN<br>' + escHtml(p.asnId) + '</div></div>' +
    '</div>'
  );
}

function buildCaseTagHtml(c) {
  var shortName = c.productName.indexOf(' | ') !== -1 ? c.productName.split(' | ')[0].trim() : c.productName;
  return (
    '<div class="tag">' +
    '  <div class="tag-header"><span class="brand">medalt<span>us</span>.</span>CASE RECEIVING TAG</div>' +
    '  <div class="case-badge">CASE ' + escHtml(c.caseNum) + ' of ' + escHtml(c.totalCases) + '</div>' +
    '  <div class="sku-block"><div class="lbl">SKU</div>' +
    '    <div class="medaltus-sku">' + escHtml(c.sku) + '</div></div>' +
    '  <div class="product-name">' + escHtml(shortName) + '</div>' +
    '  <div class="stats-row">' +
    '    ' + attrDiv(c.unitsInCase, 'UNITS IN CASE') +
    '    ' + attrDiv(c.caseQty,     'CASE QTY') +
    '    ' + attrDiv(c.totalUnits,  'TOTAL UNITS') +
    '  </div>' +
    '  <div class="tag-footer"><div class="addr">' + escHtml(FOOTER_ADDR) + '</div>' +
    '    <div class="asn">ASN<br>' + escHtml(c.asnId) + '</div></div>' +
    '</div>'
  );
}

function attrDiv(val, label) {
  return '<div class="attr"><div class="val">' + (escHtml(val) || '&mdash;') + '</div><div class="lbl">' + escHtml(label) + '</div></div>';
}

// ── Initialize Sheet Tabs — unchanged, already matches évolis's schema ──
function initializeTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = {
    'Inbound_Shipments': ['ShipmentID','UploadDate','Status','Carrier','TrackingNo','BoxCount','Notes','ReceivedDate','DiscrepancyCount','DriveUrl'],
    'Inbound_Items':     ['ShipmentID','SKU','ProductName','ExpectedQty','ReceivedQty'],
  };
  Object.keys(tabs).forEach(function (name) {
    var headers = tabs[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers])
        .setBackground('#001F60').setFontColor('#FFFFFF').setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });
  SpreadsheetApp.getUi().alert('✅ Tabs initialized successfully!');
}
`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) {
    res.status(400).json({ error: 'Missing or empty rows[] — expected [{sku, productName, quantity}]' });
    return;
  }
  const cleanRows = rows
    .map(r => ({
      sku: String(r.sku || '').trim(),
      productName: String(r.productName || '').trim(),
      quantity: parseInt(r.quantity, 10) || 0,
    }))
    .filter(r => r.sku);
  if (!cleanRows.length) {
    res.status(400).json({ error: 'No rows had a SKU' });
    return;
  }

  const uploadDate = todayIso();
  const shipmentId = generateShipmentId(uploadDate);
  const totalSkus = cleanRows.length;
  const totalUnits = cleanRows.reduce((s, r) => s + r.quantity, 0);

  try {
    const auth = getDriveSheetsAuth();
    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    // 1) Copy the template into the ASNs folder.
    const copyRes = await drive.files.copy({
      fileId: ASN_TEMPLATE_ID,
      supportsAllDrives: true, // required if the template/folder live in a Shared Drive —
      // without this, Drive API v3 only looks at My Drive and returns 404 "File not
      // found" even when the service account has full Editor access to the file.
      requestBody: {
        name: `${uploadDate.replace(/-/g, ' ')} — ${shipmentId}`,
        parents: [ASN_DRIVE_FOLDER_ID],
      },
      fields: 'id, webViewLink',
    });
    const newFileId = copyRes.data.id;
    const driveUrl = copyRes.data.webViewLink || `https://docs.google.com/spreadsheets/d/${newFileId}/edit`;

    // 1b) Drive's files.copy does NOT carry over "Anyone with the link"
    // sharing from the source template — that's a separate, per-file
    // permission from the service account's own Editor access. Since the
    // dashboard reads each ASN sheet's SKUs/Units/line-items via an
    // unauthenticated CSV export (fileCsvUrl in index.html), every new copy
    // needs this set explicitly or that fetch silently returns nothing and
    // the card shows "…" forever.
    await drive.permissions.create({
      fileId: newFileId,
      supportsAllDrives: true,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // 1c) Push the Medaltus ASN Apps Script onto the new file. Drive's
    // files.copy does NOT duplicate a container-bound script — this is a
    // documented API limitation, confirmed the hard way after two ASNs in
    // a row came out with no menu despite the template being correctly
    // saved. Non-fatal: if this fails (e.g. the Apps Script API hasn't
    // been enabled for this service account yet), the ASN itself still
    // gets created successfully — just without the menu — rather than
    // failing the whole request over a supplementary feature.
    let scriptPushWarning = null;
    try {
      const script = google.script({ version: 'v1', auth });
      const proj = await script.projects.create({
        requestBody: { title: 'Medaltus ASN', parentId: newFileId },
      });
      await script.projects.updateContent({
        scriptId: proj.data.scriptId,
        requestBody: {
          files: [
            { name: 'Code', type: 'SERVER_JS', source: ASN_APPS_SCRIPT_SOURCE },
            { name: 'appsscript', type: 'JSON', source: ASN_APPSSCRIPT_MANIFEST },
          ],
        },
      });
    } catch (scriptErr) {
      console.warn('[create-asn] Apps Script push failed (non-fatal):', scriptErr.message);
      scriptPushWarning = scriptErr.message;
    }

    // 2) The source template is blank (confirmed — Luccini's is too), so the
    // title bar / field labels / header row you see on a finished ASN sheet
    // aren't coming from the template at all. This writes that structure
    // from scratch on every new sheet, then formats it to match Luccini's
    // look (navy title bar, bold white text, bold header row). Fixed layout:
    // row1 title · row3 Shipment ID · row4 Upload Date · row5 Status · row6
    // Carrier · row7 PRO/Tracking # · row8 Box/Pallet Count · row9 Notes ·
    // row10 Total SKUs · row11 Total Units · row13 line-item header · row14+
    // line items (SKU, Product Name, Expected Qty, Received Qty,
    // Discrepancy, Case Qty, # of Cases, Location).
    const lineItemRows = cleanRows.map(r => [r.sku, r.productName, r.quantity, '', '', '', '', 'Medaltus']);
    const lineItemsEndRow = 13 + lineItemRows.length;

    // 2a) Find the sheetId of the copied file's one tab — needed for the
    // formatting requests below (values.batchUpdate only takes A1 ranges,
    // but merge/color/bold requests need the numeric sheetId).
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: newFileId,
      fields: 'sheets.properties.sheetId',
    });
    const sheetId = meta.data.sheets[0].properties.sheetId;

    // 2b) Write every value in one pass — title text, static field labels,
    // dynamic values, the line-item header row, and the line items themselves.
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: newFileId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'A1', values: [['ÉVOLIS × MEDALTUS — ADVANCED SHIPPING NOTICE']] },
          { range: 'A3:B11', values: [
            ['Shipment ID', shipmentId],
            ['Upload Date', uploadDate],
            ['Status', 'Open'],
            ['Carrier', ''],
            ['PRO / Tracking #', ''],
            ['Box / Pallet Count', ''],
            ['Notes', ''],
            ['Total SKUs', totalSkus],
            ['Total Units', totalUnits],
          ] },
          { range: 'A13:H13', values: [
            ['SKU', 'Product Name', 'Expected Qty', 'Received Qty', 'Discrepancy', 'Case Qty', '# of Cases', 'Location'],
          ] },
          { range: `A14:H${lineItemsEndRow}`, values: lineItemRows },
        ],
      },
    });

    // 2c) Formatting pass — merge + style the title bar, bold the field
    // labels, and style the line-item header row to match. This is a
    // separate spreadsheets.batchUpdate (not values.batchUpdate) since
    // background color / bold / merge are cell-format requests, not values.
    const NAVY = { red: 0, green: 0.1216, blue: 0.3765 };
    const WHITE = { red: 1, green: 1, blue: 1 };
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: newFileId,
      requestBody: {
        requests: [
          // Title bar: merge A1:H1, navy background, bold white text.
          {
            mergeCells: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
              mergeType: 'MERGE_ALL',
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: NAVY,
                  textFormat: { bold: true, foregroundColor: WHITE, fontSize: 13 },
                  verticalAlignment: 'MIDDLE',
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
            },
          },
          // Field labels (A3:A11): bold.
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 2, endRowIndex: 11, startColumnIndex: 0, endColumnIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: 'userEnteredFormat.textFormat.bold',
            },
          },
          // Line-item header row (A13:H13): navy background, bold white text.
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 12, endRowIndex: 13, startColumnIndex: 0, endColumnIndex: 8 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: NAVY,
                  textFormat: { bold: true, foregroundColor: WHITE },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
        ],
      },
    });

    // 3) Append a row to the master tracker — this part genuinely fits
    // _sheets_client.js's own appendRows(), so it goes through the real
    // shared helper (same token cache + 429 retry-with-backoff as every
    // cron in this repo) rather than another one-off googleapis call.
    const token = await getSheetsToken();
    await appendRows(
      TRACKER_SHEET_ID,
      TRACKER_TAB,
      [[shipmentId, uploadDate, 'Open', '', '', '', '', '', '', driveUrl]],
      token
    );

    res.status(200).json({ shipmentId, driveUrl, fileId: newFileId, scriptPushWarning });
  } catch (err) {
    console.error('[create-asn] failed:', err);
    res.status(500).json({ error: err.message || 'Failed to create ASN' });
  }
};
