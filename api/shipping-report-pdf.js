// api/shipping-report-pdf.js
//
// Serves the finished, hand-built monthly Shipping Report PDF (e.g.
// "VBC_Shipping_Report_September_2026.pdf") so the dashboard's Shipping
// Data Report "Export PDF" button downloads THAT file instead of
// generating one in the browser. Per Jaclyn 2026-10-13.
//
// Where the PDFs live: Google Drive → VBC Reporting → "Shipping Report PDFs"
// (folder id below). The dashboard service account
// (vbc-states-writer@states-cache.iam.gserviceaccount.com) already has
// access through the VBC Reporting folder — nothing extra to share.
//
// Matching: a PDF in that folder whose name contains the month name (or
// 3-letter abbreviation) AND the year — e.g. "September_2026", "Sep 2026" —
// or the "YYYY-MM" / "YYYY_MM" form ("2026-09"). If several match, the most
// recently modified wins (so re-uploading a corrected version just works).
//
// GET /api/shipping-report-pdf?month=9&year=2026
//   200 → the PDF bytes (application/pdf, attachment)
//   404 → { error } when no PDF for that month is in the folder yet — the
//         dashboard then falls back to its own generated export.

const SHIPPING_PDF_FOLDER_ID = '13H8RIUS7wGe1hQly7rT4Bf6xlIvOZxmL';
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100)) {
      return res.status(400).json({ error: 'month (1-12) and year are required' });
    }
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      return res.status(500).json({ error: 'Server is not configured for Google access' });
    }
    const token = await getGoogleToken();

    // List PDFs in the folder (folder sits in a shared drive → allDrives flags).
    const q = encodeURIComponent(`'${SHIPPING_PDF_FOLDER_ID}' in parents and mimeType = 'application/pdf' and trashed = false`);
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime desc&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const list = await listRes.json();
    if (!listRes.ok) throw new Error(list.error?.message || 'Drive list failed');

    const full = MONTH_NAMES[month - 1].toLowerCase();
    const abbr = full.slice(0, 3);
    const mm = String(month).padStart(2, '0');
    const matches = (list.files || []).filter(f => {
      const n = f.name.toLowerCase().replace(/[_\-.]+/g, ' ');
      const hasYear = new RegExp(`\\b${year}\\b`).test(n);
      const hasMonthName = new RegExp(`\\b(${full}|${abbr})\\b`).test(n);
      const hasIso = new RegExp(`\\b${year}[ ]?${mm}\\b`).test(n); // "2026 09" after normalising 2026-09 / 2026_09
      return (hasYear && hasMonthName) || hasIso;
    });
    if (!matches.length) {
      return res.status(404).json({ error: `No Shipping Report PDF for ${MONTH_NAMES[month - 1]} ${year} in the Shipping Report PDFs folder yet` });
    }
    const file = matches[0]; // newest modified first

    const fileRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!fileRes.ok) throw new Error(`Drive download failed (HTTP ${fileRes.status})`);
    const buf = Buffer.from(await fileRes.arrayBuffer());

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);
    res.setHeader('X-Report-Filename', encodeURIComponent(file.name));
    return res.status(200).send(buf);
  } catch (err) {
    console.error('[shipping-report-pdf]', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function getGoogleToken() {
  const email  = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const now    = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
  })).toString('base64url');
  const sigInput = `${header}.${payload}`;
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(sigInput);
  const jwt = `${sigInput}.${sign.sign(rawKey, 'base64url')}`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await tokenRes.json();
  if (!d.access_token) throw new Error('Google auth failed: ' + JSON.stringify(d));
  return d.access_token;
}
