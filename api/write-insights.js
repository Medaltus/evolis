/**
 * api/write-insights.js
 * POST /api/write-insights
 * Prepends a row to the brand's tab in the shared Insights Log sheet.
 *
 * Body: { brand, sheetId, gid, date, organic, ppc, listing, summary }
 * Columns: date | organic_json | ppc_json | listing_json | summary | uploaded_at
 */

const { google } = require('googleapis');

const HEADERS = ['date', 'organic_json', 'ppc_json', 'listing_json', 'summary', 'uploaded_at'];

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, sheetId, date, organic, ppc, listing, summary } = req.body || {};

  if (!sheetId || !brand || !summary) {
    return res.status(400).json({ error: 'Missing: brand, sheetId, or summary' });
  }

  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.error('write-insights: missing Google credentials env vars');
    return res.status(500).json({ error: 'Google credentials not configured' });
  }

  try {
    const token = await getAuthToken();

    // Ensure header row exists
    await ensureHeaders(sheetId, brand, token);

    // Prepend row at row 2 (newest-first)
    const row = [
      date || new Date().toISOString().slice(0, 10),
      organic  || '',
      ppc      || '',
      listing  || '',
      summary  || '',
      new Date().toISOString()
    ];

    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(brand + '!A2')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const appendRes = await fetch(appendUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] })
    });

    if (!appendRes.ok) {
      const err = await appendRes.text();
      console.error('write-insights append failed:', appendRes.status, err.slice(0, 300));
      return res.status(502).json({ error: 'Sheets append failed', status: appendRes.status, detail: err.slice(0, 200) });
    }

    return res.status(200).json({ ok: true, brand, date });

  } catch (err) {
    console.error('write-insights error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function ensureHeaders(sheetId, tabName, token) {
  const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1:F1')}`;
  const checkRes = await fetch(checkUrl, { headers: { Authorization: `Bearer ${token}` } });

  if (!checkRes.ok) {
    console.error('write-insights: could not check headers, status', checkRes.status);
    return;
  }

  const data = await checkRes.json();
  if (data.values && data.values[0] && data.values[0].length > 0) return;

  // Write headers
  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1')}?valueInputOption=RAW`;
  await fetch(putUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [HEADERS] })
  });
}
