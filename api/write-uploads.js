/**
 * api/write-uploads.js
 * POST /api/write-uploads
 * Prepends a summary row to the brand tab in the uploads history sheet.
 * Newest row always at top (row 2) so the dashboard reads history newest-first.
 *
 * Body: { brand, sheetId, gid, date, week_label,
 *         kw_summary, biz_summary, ppc_summary, files_uploaded }
 *
 * Columns: date | week_label | kw_summary_json | biz_summary_json | ppc_summary_json | files_uploaded | uploaded_at
 */

const { google } = require('googleapis');

const HEADERS = ['date','week_label','kw_summary_json','biz_summary_json','ppc_summary_json','files_uploaded','uploaded_at'];

async function getAuthToken() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getAccessToken();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, sheetId, gid, date, week_label,
          kw_summary, biz_summary, ppc_summary, files_uploaded } = req.body || {};

  if (!sheetId || !brand) return res.status(400).json({ error: 'Missing sheetId or brand' });

  const token = await getAuthToken();

  // Ensure header row exists — append if sheet is empty
  await ensureHeaders(sheetId, brand, token);

  // Prepend new summary row at row 2
  const row = [
    date || new Date().toISOString().slice(0, 10),
    week_label || '',
    kw_summary  || '[]',
    biz_summary || '[]',
    ppc_summary || '[]',
    files_uploaded || '',
    new Date().toISOString()
  ];

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(brand + '!A2')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] })
    }
  );

  return res.status(200).json({ ok: true, brand, date });
}

async function ensureHeaders(sheetId, tabName, token) {
  // Check if row 1 is already written
  const checkRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1:G1')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await checkRes.json();
  if (data.values && data.values[0] && data.values[0].length > 0) return; // headers exist

  // Write headers to row 1
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1')}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [HEADERS] })
    }
  );
}
