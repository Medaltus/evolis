/**
 * api/write-listing-audit.js
 * POST /api/write-listing-audit
 *
 * Writes a single action row to the audit sheet when a listing is
 * manually marked as updated or skipped from the dashboard.
 *
 * Bulk audit run rows are now written directly by run-listing-audit.js —
 * the dashboard no longer needs to call this endpoint for audit results.
 *
 * POST body:
 *   { brand, sheetId, date, action, sku, sku_name, skip_reason }
 *   action: "updated" | "skipped" | "pending"
 */

const { google } = require('googleapis');

async function getToken() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getAccessToken();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, sheetId, date, action, sku, sku_name, skip_reason } = req.body || {};
  if (!sheetId || !brand) return res.status(400).json({ error: 'Missing: brand or sheetId' });
  if (!sku)               return res.status(400).json({ error: 'Missing: sku' });

  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Google credentials not configured' });
  }

  try {
    const token = await getToken();
    const tabName = brand;
    const now = new Date().toISOString();
    const auditDate = date || now.slice(0, 10);

    await ensureHeaders(sheetId, tabName, token);

    const row = [
      auditDate,
      sku,
      sku_name || '',
      action || 'pending',
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', // notes/rewrite columns — empty for manual actions
      skip_reason || '',
      now
    ];

    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A2')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const appendRes = await fetch(appendUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] })
    });

    if (!appendRes.ok) {
      const err = await appendRes.text();
      console.error('write-listing-audit append failed:', appendRes.status, err.slice(0, 200));
      return res.status(502).json({ error: 'Sheets append failed', status: appendRes.status });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('write-listing-audit error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function ensureHeaders(sheetId, tabName, token) {
  const checkRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1:T1')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!checkRes.ok) return;
  const data = await checkRes.json();
  if (data.values && data.values[0] && data.values[0].length > 0) return;

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1')}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [[
          'date', 'sku', 'sku_name', 'action',
          'title_notes', 'title_rewrite',
          'ih_notes', 'ih_rewrite',
          'bullets_notes',
          'bullet_1_rewrite', 'bullet_2_rewrite', 'bullet_3_rewrite', 'bullet_4_rewrite', 'bullet_5_rewrite',
          'desc_notes', 'desc_rewrite',
          'backend_notes', 'backend_rewrite',
          'skip_reason', 'audited_at'
        ]]
      })
    }
  );
}
