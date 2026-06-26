/**
 * api/write-listing-audit.js
 * POST /api/write-listing-audit
 *
 * Two modes:
 * 1. action=audit_run: writes one row per SKU with flat columns
 * 2. action=updated|skipped: writes one row with the action taken
 *
 * Audit run columns (one row per SKU):
 *   date | sku | sku_name | action |
 *   title_notes | title_rewrite |
 *   ih_notes | ih_rewrite |
 *   bullets_notes | bullets_rewrite |
 *   backend_notes | backend_rewrite |
 *   skip_reason | audited_at
 */

const { google } = require('googleapis');

const HEADERS = [
  'date', 'sku', 'sku_name', 'action',
  'title_notes', 'title_rewrite',
  'ih_notes', 'ih_rewrite',
  'bullets_notes', 'bullets_rewrite',
  'backend_notes', 'backend_rewrite',
  'skip_reason', 'audited_at'
];

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, sheetId, date, action, results, sku, sku_name, skip_reason } = req.body || {};
  if (!sheetId || !brand) return res.status(400).json({ error: 'Missing: brand or sheetId' });

  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Google credentials not configured' });
  }

  try {
    const token = await getAuthToken();
    const tabName = brand;
    const now = new Date().toISOString();
    const auditDate = date || now.slice(0, 10);

    await ensureHeaders(sheetId, tabName, token);

    let rows = [];

    if (action === 'audit_run' && results && results.length) {
      // One flat row per SKU — no nested JSON
      for (const r of results) {
        rows.push([
          auditDate,
          r.sku || '',
          r.sku_name || '',
          'audit_run',
          (r.title && r.title.notes)            || '',
          (r.title && r.title.rewrite)           || '',
          (r.item_highlights && r.item_highlights.notes)   || '',
          (r.item_highlights && r.item_highlights.rewrite) || '',
          (r.bullets && r.bullets.notes)         || '',
          (r.bullets && r.bullets.rewrite)       || '',
          (r.backend && r.backend.notes)         || '',
          (r.backend && r.backend.rewrite)       || '',
          '',
          now
        ]);
      }
    } else {
      // Single action row (updated / skipped)
      rows.push([
        auditDate, sku || '', sku_name || '', action || 'pending',
        '', '', '', '', '', '', '', '',
        skip_reason || '', now
      ]);
    }

    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A2')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const appendRes = await fetch(appendUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows })
    });

    if (!appendRes.ok) {
      const err = await appendRes.text();
      console.error('write-listing-audit append failed:', appendRes.status, err.slice(0, 200));
      return res.status(502).json({ error: 'Sheets append failed', status: appendRes.status });
    }

    return res.status(200).json({ ok: true, rowsWritten: rows.length });

  } catch(err) {
    console.error('write-listing-audit error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function ensureHeaders(sheetId, tabName, token) {
  const checkRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1:N1')}`,
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
      body: JSON.stringify({ values: [HEADERS] })
    }
  );
}
