// /api/sync-sqp-process.js
//
// Step 2 of 2 — companion to sync-sqp-request.js. Finds any _meta rows still
// in REQUESTED status, polls Amazon for completion, and once DONE, downloads
// the report document and writes it to the sheet.
//
// SP-API Reports API flow after requesting a report:
//   1. GET /reports/2021-06-30/reports/{reportId}  → check processingStatus
//   2. Once DONE, it includes a reportDocumentId
//   3. GET /reports/2021-06-30/documents/{reportDocumentId} → returns a
//      short-lived, pre-signed S3 url (and possibly a compressionAlgorithm)
//   4. Fetch that url directly (no SP-API auth headers — it's pre-signed)
//   5. The SQP report body is TSV, one row per search query, with columns
//      roughly: searchQuery, searchQueryScore, searchQueryVolume,
//      impressions (total/brand/asin), clicks (total/brand/asin + rates),
//      cartAdds (total/brand/asin + rates), purchases (total/brand/asin +
//      rates) — the "full report" the user asked for, so every column is
//      written through as-is rather than trimmed to a subset.
//
// IMPORTANT — auth: same note as sync-sqp-request.js. Reuses whatever
// existing getSpApiAccessToken() helper sync-orders-process.js already
// relies on. Verify/adjust the import path.

import { ensureTab, readRows, replaceRows, getGoogleToken } from '../config/_sheets_client.js';
import { getSpApiAccessToken } from '../_sp_api_client.js'; // ← verify/adjust this import

const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
const SHEET_SQP_ID = process.env.SHEET_SEARCH_QUERY_PERFORMANCE_ID;
const META_TAB = '_meta';
const DATA_TAB = 'search_query_performance';

async function pollReportStatus(reportId, accessToken) {
  const resp = await fetch(`${SP_API_BASE}/reports/2021-06-30/reports/${reportId}`, {
    headers: { 'x-amz-access-token': accessToken }
  });
  if (!resp.ok) throw new Error(`report status check failed: ${resp.status} ${await resp.text()}`);
  return resp.json(); // { processingStatus, reportDocumentId, ... }
}

async function downloadReportDocument(reportDocumentId, accessToken) {
  const docResp = await fetch(`${SP_API_BASE}/reports/2021-06-30/documents/${reportDocumentId}`, {
    headers: { 'x-amz-access-token': accessToken }
  });
  if (!docResp.ok) throw new Error(`document lookup failed: ${docResp.status} ${await docResp.text()}`);
  const { url, compressionAlgorithm } = await docResp.json();

  const fileResp = await fetch(url); // pre-signed — no auth headers needed/allowed here
  if (!fileResp.ok) throw new Error(`document download failed: ${fileResp.status}`);

  if (compressionAlgorithm === 'GZIP') {
    // Reports API sometimes gzips large reports. Node's fetch gives us an
    // ArrayBuffer; decompress with zlib.
    const zlib = await import('zlib');
    const buf = Buffer.from(await fileResp.arrayBuffer());
    return zlib.gunzipSync(buf).toString('utf-8');
  }
  return fileResp.text();
}

function parseTsv(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split('\t');
  const rows = lines.slice(1).map(line => line.split('\t'));
  return { headers, rows };
}

export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) return res.status(401).end();

  try {
    const accessToken = await getSpApiAccessToken();
    const googleToken = await getGoogleToken();

    const { headers: metaHeaders, rows: metaRows } = await readRows(SHEET_SQP_ID, META_TAB).catch(() => ({ headers: [], rows: [] }));
    const keyIdx = metaHeaders.indexOf('key');
    const reportIdIdx = metaHeaders.indexOf('reportId');
    const statusIdx = metaHeaders.indexOf('status');
    const processedAtIdx = metaHeaders.indexOf('processedAt');

    const pending = metaRows.filter(r => r[statusIdx] === 'REQUESTED');
    if (!pending.length) {
      return res.status(200).json({ ok: true, message: 'no pending reports to process' });
    }

    const results = [];
    for (const row of pending) {
      const metaKey = row[keyIdx];
      const reportId = row[reportIdIdx];
      const statusResp = await pollReportStatus(reportId, accessToken);

      if (statusResp.processingStatus === 'IN_QUEUE' || statusResp.processingStatus === 'IN_PROGRESS') {
        console.log(`[sync-sqp-process] ${metaKey} still ${statusResp.processingStatus} — will check again next run`);
        results.push({ metaKey, status: statusResp.processingStatus });
        continue;
      }

      if (statusResp.processingStatus === 'CANCELLED' || statusResp.processingStatus === 'FATAL') {
        row[statusIdx] = statusResp.processingStatus;
        console.error(`[sync-sqp-process] ${metaKey} report failed: ${statusResp.processingStatus}`);
        results.push({ metaKey, status: statusResp.processingStatus, error: true });
        continue;
      }

      // DONE — download, parse, write.
      const tsvText = await downloadReportDocument(statusResp.reportDocumentId, accessToken);
      const { headers: dataHeaders, rows: dataRows } = parseTsv(tsvText);

      // Tag each row with the month key so the sheet accumulates history
      // across months in one tab rather than overwriting each time.
      const taggedHeaders = ['month_key', ...dataHeaders];
      const { headers: existingHeaders, rows: existingRows } = await readRows(SHEET_SQP_ID, DATA_TAB).catch(() => ({ headers: [], rows: [] }));
      const otherMonthsRows = existingRows.filter(r => r[0] !== metaKey); // drop any prior write of this SAME month (idempotent re-run), keep all others
      const newRows = dataRows.map(r => [metaKey, ...r]);

      await ensureTab(SHEET_SQP_ID, DATA_TAB, taggedHeaders);
      await replaceRows(SHEET_SQP_ID, DATA_TAB, taggedHeaders, [...otherMonthsRows, ...newRows], googleToken);

      row[statusIdx] = 'DONE';
      row[processedAtIdx] = new Date().toISOString();
      console.log(`[sync-sqp-process] ${metaKey} — wrote ${newRows.length} rows`);
      results.push({ metaKey, status: 'DONE', rowsWritten: newRows.length });
    }

    // Persist updated statuses back to _meta.
    await replaceRows(SHEET_SQP_ID, META_TAB, metaHeaders, metaRows, googleToken);

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('[sync-sqp-process] error:', err);
    res.status(500).json({ error: err.message });
  }
}
