/**
 * api/write-insights.js
 * POST /api/write-insights
 * Appends a new row to the brand's tab in the shared Insights Log sheet.
 * Creates the tab if it doesn't exist yet.
 * 
 * Body: { brand, date, organic, ppc, listing, summary, sheetId }
 * 
 * Columns written (in order):
 *   date | organic_json | ppc_json | listing_json | summary | uploaded_at
 */

const { ensureTab, appendRows } = require('./config/_sheets_client');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, date, organic, ppc, listing, summary, sheetId } = req.body || {};

  if (!brand || !sheetId || !summary) {
    return res.status(400).json({ error: 'Missing required fields: brand, sheetId, summary' });
  }

  const HEADERS = ['date', 'organic_json', 'ppc_json', 'listing_json', 'summary', 'uploaded_at'];
  const row = [
    date || new Date().toISOString().slice(0, 10),
    organic || '',
    ppc || '',
    listing || '',
    summary || '',
    new Date().toISOString()
  ];

  // Build Google auth token
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const token = await auth.getAccessToken();

  // Ensure the brand tab exists
  await ensureTab(sheetId, brand, HEADERS, token);

  // Prepend row (newest-first) by inserting at row 2 (after header)
  await prependRow(sheetId, brand, row, token);

  return res.status(200).json({ ok: true, brand, date });
}

async function prependRow(sheetId, tabName, rowData, token) {
  // Insert a blank row at position 2 (index 1), then write data to it
  const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

  // First get the sheetId (numeric) for this tab
  const metaRes = await fetch(`${sheetsUrl}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const meta = await metaRes.json();
  const sheet = meta.sheets.find(s => s.properties.title === tabName);
  if (!sheet) throw new Error(`Tab "${tabName}" not found`);
  const numericSheetId = sheet.properties.sheetId;

  // Insert blank row at index 1 (row 2)
  await fetch(`${sheetsUrl}/values/${encodeURIComponent(tabName + '!A2')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [rowData] })
  });
}
