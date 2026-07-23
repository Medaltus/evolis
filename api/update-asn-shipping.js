// api/update-asn-shipping.js
//
// Fills in Carrier / PRO-Tracking# / Box-Pallet-Count after an ASN has
// already been created (these usually aren't known at CSV-upload time).
// Updates both the master tracker row AND the per-ASN sheet's own header
// cells, so the two never drift out of sync.
//
// Manually-triggered from the dashboard's "Add shipping info" form — no
// CRON_SECRET, same exception as run-analysis.js / create-asn.js.
//
// Uses the real config/_sheets_client.js (confirmed from GitHub commit
// history, 2026-07-23):
//   - readRows() + replaceRows() for the tracker update — reads all rows
//     as header-keyed objects, patches the matching shipment's Carrier/
//     TrackingNo/BoxCount, writes the whole tab back. A little more than
//     is strictly needed for a one-row change, but it means this goes
//     through the real shared retry-with-backoff path instead of a
//     one-off call, and there's no arbitrary-single-row-write helper
//     exported to reach for instead.
//   - getSheetsToken() for the ASN sheet's own header-cell update (B6:B8)
//     — that one genuinely needs an arbitrary-range write, which nothing
//     in _sheets_client.js covers, so it's a direct authenticated fetch
//     using the same cached token rather than pulling in googleapis for
//     a file that otherwise doesn't need it.
//
// ⚠️ Built against _sheets_client (9) from commit history, not confirmed
// HEAD — diff against your actual current file before trusting this.
// ⚠️ Not tested against the live sheets — curl it against a throwaway
// shipment first.

const { readRows, replaceRows, getSheetsToken } = require('./config/_sheets_client');

const TRACKER_SHEET_ID = '1Pb50CzCb0fouNsaewQATEY_c3IpgRVPu5FoppNg19_A';
const TRACKER_TAB = 'Inbound_Shipments';
const TRACKER_HEADERS = [
  'ShipmentID', 'UploadDate', 'Status', 'Carrier', 'TrackingNo',
  'BoxCount', 'Notes', 'ReceivedDate', 'DiscrepancyCount', 'DriveUrl',
];

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
    // Header-keyed rows, courtesy of the real readRows() — much easier to
    // work with than raw column-index arrays.
    const trackerRows = await readRows(TRACKER_SHEET_ID, TRACKER_TAB);
    const target = trackerRows.find(r => String(r.ShipmentID || '').trim() === shipmentId);
    if (!target) {
      res.status(404).json({ error: `Shipment ${shipmentId} not found on the tracker` });
      return;
    }
    const driveUrl = target.DriveUrl || '';
    const fileId = fileIdFromUrl(driveUrl);

    target.Carrier = carrier || '';
    target.TrackingNo = trackingNo || '';
    target.BoxCount = boxCount || '';

    // Write every row back in the sheet's real column order — replaceRows
    // clears row 2 onward and rewrites, so this has to include every row,
    // not just the one that changed.
    const outputRows = trackerRows.map(r => TRACKER_HEADERS.map(h => r[h] ?? ''));
    const token = await getSheetsToken();
    await replaceRows(TRACKER_SHEET_ID, TRACKER_TAB, TRACKER_HEADERS, outputRows, token);

    // Update the ASN sheet's own header cells (B6 Carrier, B7 Tracking#,
    // B8 Box/Pallet Count) so the sheet stays the source of truth too.
    // Arbitrary-range write — nothing in _sheets_client.js fits, so this
    // reuses the same cached token via a direct authenticated call.
    if (fileId) {
      await sheetsValuesBatchUpdate(token, fileId, [
        { range: 'B6', values: [[carrier || '']] },
        { range: 'B7', values: [[trackingNo || '']] },
        { range: 'B8', values: [[boxCount || '']] },
      ]);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[update-asn-shipping] failed:', err);
    res.status(500).json({ error: err.message || 'Failed to update shipping info' });
  }
};

async function sheetsValuesBatchUpdate(token, spreadsheetId, data) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Sheets batchUpdate failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  return resp.json();
}
