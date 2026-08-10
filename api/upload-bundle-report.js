/**
 * api/upload-bundle-report.js
 * POST /api/upload-bundle-report
 *
 * Accepts Amazon's "virtual bundle & multipack sales" report as a base64-
 * encoded CSV, parses it, and writes it into the shared "Product Bundle
 * Sales" Google Sheet using the same service account every other cron in
 * this repo already uses — via ensureTab/readRows/replaceRows in
 * config/_sheets_client.js. Modeled directly on upload-keyword-tracker.js.
 *
 * This report is company-wide, not per-brand — a single pull can contain
 * rows for évolis, Skinuva, Just Bjorn, Crème Shop, etc. all mixed together.
 * It's delivered by email as a "Download Now" link (not an attachment) and
 * downloaded manually today, so like the Keyword Tracker flow, this
 * endpoint is the write step: download the file to
 * ~/Documents/Claude/"Newderm Product Bundles Sales Reports"/, then run
 * upload_bundle_report.sh to POST it here.
 *
 * There are two selling accounts (Newderm, VB Cosmetics) that each get
 * their own copy of this report. Only Newderm is wired up for now — the
 * sourceAccount field exists so VB Cosmetics can be added later without a
 * schema change or risk of the same bundle ASIN colliding across accounts.
 *
 * Body: { sheetId, filename, sourceAccount, contentBase64 }
 *   sheetId        — target Google Sheet ID (the Product Bundle Sales sheet)
 *   filename       — original filename, logged only, not otherwise used
 *   sourceAccount  — 'newderm' or 'vbcosmetics' — which selling account this came from
 *   contentBase64  — the .csv file's bytes, base64-encoded
 *
 * Upsert rule: key = date + source_account + bundle_asin. The report window
 * is ~90 trailing days and consecutive pulls are expected to overlap
 * heavily — incoming rows overwrite existing rows for the same key, so a
 * later pull's numbers (which may be more finalized) win.
 *
 * Uses the `xlsx` package (SheetJS) to parse the CSV — it already handles
 * quoted fields with embedded commas correctly (the TITLE column in this
 * report routinely contains commas), so there's no need for a separate
 * hand-rolled CSV parser. `xlsx` is already a dependency of this repo
 * (added for upload-keyword-tracker.js).
 */
const XLSX = require('xlsx');
const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');

const TAB_NAME = 'bundle_sales';
const HEADERS = ['date', 'source_account', 'bundle_asin', 'title', 'is_virtual_multipack', 'bundles_sold', 'total_sales'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sheetId, filename, sourceAccount, contentBase64 } = req.body || {};
  if (!sheetId)        return res.status(400).json({ error: 'Missing sheetId' });
  if (!sourceAccount)  return res.status(400).json({ error: 'Missing sourceAccount' });
  if (!contentBase64)  return res.status(400).json({ error: 'Missing contentBase64' });

  console.log(`[upload-bundle-report] received ${filename || '(no filename)'} from ${sourceAccount}, ${contentBase64.length} base64 chars, target sheet ${sheetId}`);

  let rows;
  try {
    const buffer = Buffer.from(contentBase64, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { defval: '' });
  } catch (err) {
    console.error('[upload-bundle-report] failed to parse CSV:', err.message);
    return res.status(400).json({ error: 'Could not parse file as CSV', detail: err.message });
  }

  if (!rows.length) {
    return res.status(200).json({ status: 'ok', tab: TAB_NAME, incomingRows: 0, totalRows: 0, note: 'File parsed but contained no rows' });
  }

  // Normalize the report's UPPER_SNAKE_CASE headers (DATE, BUNDLE_ASIN,
  // TITLE, IS_VIRTUAL_MULTIPACK, BUNDLES_SOLD, TOTAL_SALES) to our
  // lowercase convention, and stamp on which selling account this came from.
  const incoming = rows.map(r => ({
    date: r.DATE || '',
    source_account: sourceAccount,
    bundle_asin: r.BUNDLE_ASIN || '',
    title: r.TITLE || '',
    is_virtual_multipack: r.IS_VIRTUAL_MULTIPACK || '',
    bundles_sold: r.BUNDLES_SOLD || '',
    total_sales: r.TOTAL_SALES || '',
  }));

  try {
    const token = await ensureTab(sheetId, TAB_NAME, HEADERS);
    const existing = await readRows(sheetId, TAB_NAME);
    const key = r => `${r.date}||${(r.source_account || '').toLowerCase()}||${(r.bundle_asin || '').toUpperCase()}`;
    const merged = new Map();
    (existing || []).forEach(r => merged.set(key(r), r));
    incoming.forEach(r => merged.set(key(r), r));
    const outRows = Array.from(merged.values()).map(r => HEADERS.map(h => r[h] ?? ''));
    await replaceRows(sheetId, TAB_NAME, HEADERS, outRows, token);
    return res.status(200).json({ status: 'ok', tab: TAB_NAME, incomingRows: incoming.length, totalRows: outRows.length });
  } catch (err) {
    console.error('[upload-bundle-report] sheet write failed:', err.message);
    return res.status(500).json({ status: 'error', error: err.message });
  }
};
