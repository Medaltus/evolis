/**
 * api/upload-keyword-tracker.js
 * POST /api/upload-keyword-tracker
 *
 * Accepts a Keyword Tracker workbook (xlsx) as base64 in the request body,
 * parses its "summary" and "evolis" (or other brand-named) tabs, and writes
 * them into the "Helium 10 - Keyword Tracker" Google Sheet using the same
 * service account (vbc-states-writer) every other cron in this repo already
 * uses — via ensureTab/readRows/replaceRows in config/_sheets_client.js.
 *
 * This exists because Cowork's Google Sheets connector could reliably PULL
 * Helium 10 data and structure it correctly, but could not reliably WRITE
 * into the target Sheet — it kept saving a local .xlsx to the filesystem
 * instead. That local file is real, correctly-shaped data. This endpoint is
 * how it actually gets into the Sheet: upload the file here (from your
 * machine, or from any script/tool that can run a curl command against
 * this URL), and this endpoint does the write server-side with real,
 * working credentials — no MCP, no local file access needed on Vercel's
 * end (Vercel cannot read files on your laptop; this is the workaround for
 * that specific limitation).
 *
 * Body: { sheetId, filename, contentBase64 }
 *   sheetId        — target Google Sheet ID (e.g. the Keyword Tracker sheet)
 *   filename       — original filename, logged only, not otherwise used
 *   contentBase64  — the .xlsx file's bytes, base64-encoded
 *
 * Upsert rules (same as the Cowork task prompt specified):
 *   summary tab   — key: date + brand + asin
 *   <brand> tab   — key: date + asin + keyword
 *
 * Requires the `xlsx` npm package (SheetJS) — not currently a dependency of
 * this repo. Run `npm install xlsx` before deploying this file.
 *
 * Example curl:
 *   curl -X POST https://evolis-xi.vercel.app/api/upload-keyword-tracker \
 *     -H 'Authorization: Bearer <CRON_SECRET>' \
 *     -H 'Content-Type: application/json' \
 *     -d "{\"sheetId\":\"1geNDQgd_1ensLDyZOuXZBnvQrFT_RC85l9rHHGpgJe4\",\"filename\":\"Helium10_KeywordTracker_evolis_2026-07-14.xlsx\",\"contentBase64\":\"$(base64 -i Helium10_KeywordTracker_evolis_2026-07-14.xlsx)\"}"
 */
const XLSX = require('xlsx');
const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const SUMMARY_HEADERS = ['date', 'brand', 'asin', 'sku', 'total_tracked_keywords', 'top50_organic_count', 'avg_organic_rank', 'boosted_count', 'last_synced'];
const KEYWORD_HEADERS = ['date', 'asin', 'sku', 'keyword', 'organic_rank', 'sponsored_rank', 'search_volume', 'keyword_sales', 'boosted', 'last_synced'];
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { sheetId, filename, contentBase64 } = req.body || {};
  if (!sheetId)       return res.status(400).json({ error: 'Missing sheetId' });
  if (!contentBase64) return res.status(400).json({ error: 'Missing contentBase64' });
  console.log(`[upload-keyword-tracker] received ${filename || '(no filename)'}, ${contentBase64.length} base64 chars, target sheet ${sheetId}`);
  let workbook;
  try {
    const buffer = Buffer.from(contentBase64, 'base64');
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    console.error('[upload-keyword-tracker] failed to parse workbook:', err.message);
    return res.status(400).json({ error: 'Could not parse file as xlsx', detail: err.message });
  }
  const results = [];
  // ── summary tab — key: date + brand + asin ─────────────────────────────
  if (workbook.SheetNames.includes('summary')) {
    try {
      const sheet = workbook.Sheets['summary'];
      const incoming = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      console.log(`[upload-keyword-tracker] summary — ${incoming.length} incoming rows`);
      const token    = await ensureTab(sheetId, 'summary', SUMMARY_HEADERS);
      const existing = await readRows(sheetId, 'summary');
      const key = r => `${r.date}||${(r.brand || '').toLowerCase()}||${(r.asin || '').toUpperCase()}`;
      const merged = new Map();
      (existing || []).forEach(r => merged.set(key(r), r));
      incoming.forEach(r => merged.set(key(r), r));
      const outRows = Array.from(merged.values()).map(r => SUMMARY_HEADERS.map(h => r[h] ?? ''));
      await replaceRows(sheetId, 'summary', SUMMARY_HEADERS, outRows, token);
      results.push({ tab: 'summary', status: 'ok', incomingRows: incoming.length, totalRows: outRows.length });
    } catch (err) {
      console.error('[upload-keyword-tracker] summary tab failed:', err.message);
      results.push({ tab: 'summary', status: 'error', error: err.message });
    }
  } else {
    results.push({ tab: 'summary', status: 'skipped', reason: 'not present in workbook' });
  }
  // ── every other tab in the workbook is treated as a brand keyword-detail
  // tab (e.g. "evolis", later "skinuva") — key: date + asin + keyword ──────
  for (const sheetName of workbook.SheetNames) {
    if (sheetName === 'summary') continue;
    try {
      const sheet = workbook.Sheets[sheetName];
      const incoming = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (!incoming.length) { results.push({ tab: sheetName, status: 'skipped', reason: 'empty' }); continue; }
      console.log(`[upload-keyword-tracker] ${sheetName} — ${incoming.length} incoming rows`);
      const token    = await ensureTab(sheetId, sheetName, KEYWORD_HEADERS);
      const existing = await readRows(sheetId, sheetName);
      const key = r => `${r.date}||${(r.asin || '').toUpperCase()}||${(r.keyword || '').toLowerCase()}`;
      const merged = new Map();
      (existing || []).forEach(r => merged.set(key(r), r));
      incoming.forEach(r => merged.set(key(r), r));
      const outRows = Array.from(merged.values()).map(r => KEYWORD_HEADERS.map(h => r[h] ?? ''));
      await replaceRows(sheetId, sheetName, KEYWORD_HEADERS, outRows, token);
      results.push({ tab: sheetName, status: 'ok', incomingRows: incoming.length, totalRows: outRows.length });
    } catch (err) {
      console.error(`[upload-keyword-tracker] ${sheetName} tab failed:`, err.message);
      results.push({ tab: sheetName, status: 'error', error: err.message });
    }
  }
  res.status(200).json({ synced: results });
};
