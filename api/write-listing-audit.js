/**
 * api/write-listing-audit.js
 * POST /api/write-listing-audit
 *
 * Writes per-SKU listing audit results to the dedicated listing audit sheet.
 * One row per SKU per field, so Claude can review full history on next run.
 *
 * Body: { brand, sheetId, gid, date, sku, sku_name, action,
 *         skip_reason?, suggestions: [{field, issue, suggestion}] }
 *
 * Columns: date | sku | sku_name | field | issue | suggestion | action | skip_reason | audited_at
 */

const { google } = require('googleapis');

const HEADERS = ['date','sku','sku_name','field','issue','suggestion','action','skip_reason','audited_at'];

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

  const { brand, sheetId, date, sku, sku_name,
          action, skip_reason, suggestions } = req.body || {};

  if (!sheetId || !brand || !sku) {
    return res.status(400).json({ error: 'Missing: brand, sheetId, or sku' });
  }

  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Google credentials not configured' });
  }

  try {
    const token = await getAuthToken();
    const tabName = brand;
    const now = new Date().toISOString();
    const auditDate = date || now.slice(0, 10);

    // Ensure headers
    await ensureHeaders(sheetId, tabName, token);

    // For audit_run: write a single row with full results as JSON
    // For updated/skipped: write one row per field
    const rows = [];
    if (action === 'audit_run') {
      rows.push([
        auditDate, sku, sku_name || '', 'audit_run', '', 
        JSON.stringify(suggestions || []),
        'audit_run', '', now
      ]);
    } else if (suggestions && suggestions.length) {
      for (const s of suggestions) {
        rows.push([
          auditDate, sku, sku_name || '',
          s.field || '', s.issue || '', s.suggestion || '',
          action || 'pending', skip_reason || '', now
        ]);
      }
    } else {
      rows.push([auditDate, sku, sku_name || '', 'all', '', '', action || 'pending', skip_reason || '', now]);
    }

    // Prepend rows at row 2 (newest first)
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

    return res.status(200).json({ ok: true, sku, rowsWritten: rows.length });

  } catch(err) {
    console.error('write-listing-audit error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function ensureHeaders(sheetId, tabName, token) {
  const checkRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName + '!A1:I1')}`,
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
