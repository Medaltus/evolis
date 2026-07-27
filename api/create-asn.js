// api/create-asn.js
//
// Creates a new ASN as a TAB inside the Evolis ASN Google Sheet itself
// (1Pb50CzCb0fouNsaewQATEY_c3IpgRVPu5FoppNg19_A) — NOT a separate Drive
// file. Per Jaclyn, 2026-07-27.
//
// This replaces the old "copy a template file per ASN" design entirely,
// and sidesteps everything that made that approach painful:
//   - No more "does copying preserve the bound Apps Script" problem — a
//     bound script belongs to the whole spreadsheet, not to an individual
//     tab, so once the Medaltus ASN script is pasted into this file's
//     Extensions > Apps Script ONCE (already done, confirmed working),
//     every tab in this file — past, present, future — automatically has
//     the same menu. No copying, no Apps Script API, no domain-wide
//     delegation, none of it needed anymore.
//   - No more separate-file Drive permissions to manage. Sharing is a
//     per-FILE setting; since this spreadsheet is already shared "Anyone
//     with the link: Viewer" (needed for the dashboard's public CSV
//     reads), every new tab automatically inherits that, with nothing
//     extra to grant.
//   - No more Drive API calls anywhere in this file — this is now a pure
//     Sheets API operation (spreadsheets.batchUpdate + values.batchUpdate),
//     which also means the JWT only needs the 'spreadsheets' scope, not
//     'drive' or 'script.projects'.
//
// Still writes a summary row to the Inbound_Shipments tab in this same
// spreadsheet (unchanged), with a DriveUrl that now points directly at
// the new tab's own gid — e.g.
//   https://docs.google.com/spreadsheets/d/{TRACKER_SHEET_ID}/edit#gid={newSheetId}
// — so the dashboard card's link opens straight to the right tab instead
// of a separate file.
//
// Manually-triggered from the dashboard's "Create ASN" button — no
// CRON_SECRET, same exception already established for run-analysis.js.

const { google } = require('googleapis');
const { appendRows, getSheetsToken } = require('./config/_sheets_client');

const TRACKER_SHEET_ID = '1Pb50CzCb0fouNsaewQATEY_c3IpgRVPu5FoppNg19_A';
const TRACKER_TAB = 'Inbound_Shipments';

function getSheetsAuth() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY env vars');
  }
  return new google.auth.JWT(email, null, key, [
    'https://www.googleapis.com/auth/spreadsheets',
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
    const auth = getSheetsAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // 1) Add a new tab, named after the shipment ID. Tab names must be
    // unique within a spreadsheet — shipment IDs already are (date + 4
    // random chars), same uniqueness guarantee the old file-naming scheme
    // relied on.
    const addSheetRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: TRACKER_SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: shipmentId } } }],
      },
    });
    const newSheetId = addSheetRes.data.replies[0].addSheet.properties.sheetId;
    const tabPrefix = `'${shipmentId}'!`; // quoted for A1-notation safety

    // 2) Write the title bar, field labels, dynamic values, line-item
    // header row, and line items — same layout as before, just targeting
    // this tab instead of a separate file's Sheet1.
    const lineItemRows = cleanRows.map(r => [r.sku, r.productName, r.quantity, '', '', '', '', 'Medaltus']);
    const lineItemsEndRow = 13 + lineItemRows.length;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: TRACKER_SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${tabPrefix}A1`, values: [['ÉVOLIS × MEDALTUS — ADVANCED SHIPPING NOTICE']] },
          { range: `${tabPrefix}A3:B11`, values: [
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
          { range: `${tabPrefix}A13:H13`, values: [
            ['SKU', 'Product Name', 'Expected Qty', 'Received Qty', 'Discrepancy', 'Case Qty', '# of Cases', 'Location'],
          ] },
          { range: `${tabPrefix}A14:H${lineItemsEndRow}`, values: lineItemRows },
        ],
      },
    });

    // 3) Formatting pass — navy title bar, bold field labels, navy header
    // row. Same visual result as before, targeting the new tab's sheetId.
    const NAVY = { red: 0, green: 0.1216, blue: 0.3765 };
    const WHITE = { red: 1, green: 1, blue: 1 };
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: TRACKER_SHEET_ID,
      requestBody: {
        requests: [
          {
            mergeCells: {
              range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
              mergeType: 'MERGE_ALL',
            },
          },
          {
            repeatCell: {
              range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
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
          {
            repeatCell: {
              range: { sheetId: newSheetId, startRowIndex: 2, endRowIndex: 11, startColumnIndex: 0, endColumnIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: 'userEnteredFormat.textFormat.bold',
            },
          },
          {
            repeatCell: {
              range: { sheetId: newSheetId, startRowIndex: 12, endRowIndex: 13, startColumnIndex: 0, endColumnIndex: 8 },
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

    // 4) Link straight to this new tab, not just the spreadsheet root.
    const driveUrl = `https://docs.google.com/spreadsheets/d/${TRACKER_SHEET_ID}/edit#gid=${newSheetId}`;

    // 5) Append the summary row to Inbound_Shipments — unchanged, still
    // goes through the shared _sheets_client.js helper (same token cache +
    // 429 retry-with-backoff as every cron in this repo).
    const token = await getSheetsToken();
    await appendRows(
      TRACKER_SHEET_ID,
      TRACKER_TAB,
      [[shipmentId, uploadDate, 'Open', '', '', '', '', '', '', driveUrl]],
      token
    );

    res.status(200).json({ shipmentId, driveUrl, sheetId: newSheetId });
  } catch (err) {
    console.error('[create-asn] failed:', err);
    res.status(500).json({ error: err.message || 'Failed to create ASN' });
  }
};
