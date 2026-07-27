// api/update-asn-shipping.js
//
// Fills in Carrier / PRO-Tracking# / Box-Pallet-Count after an ASN has
// already been created (these usually aren't known at CSV-upload time).
// Updates both the master tracker row AND the specific ASN's own header
// cells, so the two never drift out of sync.
//
// Manually-triggered from the dashboard's "Add shipping info" form — no
// CRON_SECRET, same exception as run-analysis.js / create-asn.js.
//
// UPDATED 2026-07-27: every ASN now lives as a TAB inside the Evolis ASN
// spreadsheet (TRACKER_SHEET_ID) instead of a separate Drive file — see
// create-asn.js for the full reasoning. That means the header-cell writes
// below now target `'${shipmentId}'!B6` etc. (a specific tab within the
// shared spreadsheet) rather than an unqualified 'B6' on a separate
// file's only tab. An unqualified range would default to whichever tab
// happens to be first/active in the spreadsheet — wrong now that there
// are many ASN tabs living together in one file. Since the tab name is
// always exactly the shipmentId (set at creation in create-asn.js), no
// URL-parsing is needed to find it — shipmentId is already the request's
// primary key.

const { readRows, replaceRows, getSheetsToken } = require('./config/_sheets_client');

const TRACKER_SHEET_ID = '1Pb50CzCb0fouNsaewQATEY_c3IpgRVPu5FoppNg19_A';
const TRACKER_TAB = 'Inbound_Shipments';
const TRACKER_HEADERS = [
  'ShipmentID', 'UploadDate', 'Status', 'Carrier', 'TrackingNo',
  'BoxCount', 'Notes', 'ReceivedDate', 'DiscrepancyCount', 'DriveUrl',
];

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

    target.Carrier = carrier || '';
    target.TrackingNo = trackingNo || '';
    target.BoxCount = boxCount || '';

    // Write every row back in the sheet's real column order — replaceRows
    // clears row 2 onward and rewrites, so this has to include every row,
    // not just the one that changed.
    const outputRows = trackerRows.map(r => TRACKER_HEADERS.map(h => r[h] ?? ''));
    const token = await getSheetsToken();
    await replaceRows(TRACKER_SHEET_ID, TRACKER_TAB, TRACKER_HEADERS, outputRows, token);

    // Update this specific ASN's own header cells (B6 Carrier, B7
    // Tracking#, B8 Box/Pallet Count) so the tab stays the source of
    // truth too. The tab name is always exactly the shipmentId (set at
    // creation), so no lookup is needed — just quote it for A1-notation
    // safety, same as create-asn.js does.
    const tabPrefix = `'${shipmentId}'!`;
    await sheetsValuesBatchUpdate(token, TRACKER_SHEET_ID, [
      { range: `${tabPrefix}B6`, values: [[carrier || '']] },
      { range: `${tabPrefix}B7`, values: [[trackingNo || '']] },
      { range: `${tabPrefix}B8`, values: [[boxCount || '']] },
    ]);

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
