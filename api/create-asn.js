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

    res.status(200).json({ shipmentId, driveUrl, fileId: newFileId });
  } catch (err) {
    console.error('[create-asn] failed:', err);
    res.status(500).json({ error: err.message || 'Failed to create ASN' });
  }
};
