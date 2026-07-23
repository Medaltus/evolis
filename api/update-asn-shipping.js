// api/update-asn-shipping.js
//
// Fills in Carrier / PRO-Tracking# / Box-Pallet-Count after an ASN has
// already been created (these usually aren't known at CSV-upload time).
// Updates both the per-ASN sheet's own header cells AND the matching row
// on the master tracker, so the two never drift out of sync.
//
// Manually-triggered from the dashboard's "Add shipping info" form — no
// CRON_SECRET, same exception as run-analysis.js / create-asn.js.
//
// ⚠️ Same caveats as create-asn.js: written directly against `googleapis`
// rather than the shared config/_sheets_client.js helpers (signature
// unknown to me), and not yet tested against the live sheets — verify with
// curl before trusting in production.

const { google } = require('googleapis');

const TRACKER_SHEET_ID = '1Pb50CzCb0fouNsaewQATEY_c3IpgRVPu5FoppNg19_A';
const TRACKER_TAB = 'Inbound_Shipments';

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY env vars');
  }
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
}

function fileIdFromUrl(url) {
  const m = String(url || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { shipmentId, carrier, trackingNo, boxCount } = req.body || {};
  if (!shipmentId) {
    res.status(400).json({ error: 'Missing shipmentId' });
    return;
  }

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Find the matching tracker row (and its DriveUrl, to reach the ASN's
    // own sheet) by scanning column A for the shipment ID — small sheet,
    // fine to read in full rather than maintaining a separate index.
    const trackerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `${TRACKER_TAB}!A:J`,
    });
    const trackerRows = trackerRes.data.values || [];
    const rowIdx = trackerRows.findIndex(r => (r[0] || '').trim() === shipmentId);
    if (rowIdx < 0) {
      res.status(404).json({ error: `Shipment ${shipmentId} not found on the tracker` });
      return;
    }
    const sheetRowNumber = rowIdx + 1; // 1-indexed, matches the sheet directly
    const driveUrl = trackerRows[rowIdx][9] || '';
    const fileId = fileIdFromUrl(driveUrl);

    // Update the tracker row's Carrier(D) / TrackingNo(E) / BoxCount(F).
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `${TRACKER_TAB}!D${sheetRowNumber}:F${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[carrier || '', trackingNo || '', boxCount || '']] },
    });

    // Update the ASN sheet's own header cells (B6 Carrier, B7 Tracking#,
    // B8 Box/Pallet Count) so the sheet stays the source of truth too.
    if (fileId) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: fileId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: 'B6', values: [[carrier || '']] },
            { range: 'B7', values: [[trackingNo || '']] },
            { range: 'B8', values: [[boxCount || '']] },
          ],
        },
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[update-asn-shipping] failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update shipping info' });
  }
};
