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
// ⚠️ VERIFY BEFORE DEPLOYING:
//   - This uses `googleapis` directly with a service account rather than
//     the shared config/_sheets_client.js helpers (ensureTab/readRows/
//     replaceRows/sheetsGet/sheetsPost) referenced elsewhere in this repo,
//     since I don't have that file's exact export signatures to match
//     against. Behavior here should be correct, but consider refactoring
//     to use the shared client for consistency (retry-with-backoff on 429s,
//     etc.) once you've confirmed its API.
//   - Env var names below (GOOGLE_SERVICE_ACCOUNT_EMAIL /
//     GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) are a guess at Vercel convention —
//     swap in whatever the vbc-states-writer service account credentials
//     are actually stored under.
//   - Not tested against the live sheets/Drive folder — test with curl
//     against a real (or throwaway) ASN template + tracker sheet before
//     trusting this in production, per the project's own "test before
//     considering anything done" convention.

const { google } = require('googleapis');

const ASN_TEMPLATE_ID = '12wOeZryBrUKsWFrPr6SzHadwEti1SI1hEEv1X2vjHkk';
const ASN_DRIVE_FOLDER_ID = '1UNcwvEitFys68i1xDhZNW1ly4hq1VrRE';
const TRACKER_SHEET_ID = '1Pb50CzCb0fouNsaewQATEY_c3IpgRVPu5FoppNg19_A';
const TRACKER_TAB = 'Inbound_Shipments';

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY env vars');
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
    const auth = getAuth();
    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    // 1) Copy the template into the ASNs folder.
    const copyRes = await drive.files.copy({
      fileId: ASN_TEMPLATE_ID,
      requestBody: {
        name: `${uploadDate.replace(/-/g, ' ')} — ${shipmentId}`,
        parents: [ASN_DRIVE_FOLDER_ID],
      },
      fields: 'id, webViewLink',
    });
    const newFileId = copyRes.data.id;
    const driveUrl = copyRes.data.webViewLink || `https://docs.google.com/spreadsheets/d/${newFileId}/edit`;

    // 2) Write the header block (rows 3–11, column B) + line items (row 14+).
    // Matches the fixed layout confirmed from Luccini's populated example:
    //   row3 Shipment ID · row4 Upload Date · row5 Status · row6 Carrier ·
    //   row7 PRO/Tracking # · row8 Box/Pallet Count · row9 Notes ·
    //   row10 Total SKUs · row11 Total Units · row13 line-item header ·
    //   row14+ line items (SKU, Product Name, Expected Qty, Received Qty,
    //   Discrepancy, Case Qty, # of Cases, Location).
    const lineItemRows = cleanRows.map(r => [r.sku, r.productName, r.quantity, '', '', '', '', 'Medaltus']);

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: newFileId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'B3', values: [[shipmentId]] },
          { range: 'B4', values: [[uploadDate]] },
          { range: 'B5', values: [['Open']] },
          { range: 'B10', values: [[totalSkus]] },
          { range: 'B11', values: [[totalUnits]] },
          { range: `A14:H${13 + lineItemRows.length}`, values: lineItemRows },
        ],
      },
    });

    // 3) Append a row to the master tracker.
    await sheets.spreadsheets.values.append({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `${TRACKER_TAB}!A:J`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[shipmentId, uploadDate, 'Open', '', '', '', '', '', '', driveUrl]],
      },
    });

    res.status(200).json({ shipmentId, driveUrl, fileId: newFileId });
  } catch (err) {
    console.error('[create-asn] failed:', err);
    res.status(500).json({ error: err.message || 'Failed to create ASN' });
  }
};
