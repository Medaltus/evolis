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
 * ~/Documents/Claude/"Newderm Product Bundles Sales Report"/, then run
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
 * FIXED 2026-08-10 — real incident: this originally used the `xlsx`
 * (SheetJS) package to parse the CSV, reused from upload-keyword-tracker.js
 * since it already handles quoted fields with embedded commas (the TITLE
 * column here routinely has commas). The problem: SheetJS's CSV reader
 * auto-detects date-looking strings (e.g. "2026-06-04") and silently
 * converts them to Excel's internal date representation — a serial number
 * counting days since 1899-12-30 — and sheet_to_json() returns that raw
 * number instead of the original text. Confirmed live: every DATE value in
 * the bundle_sales tab was written as a 5-digit number (e.g. 46177) instead
 * of "2026-06-04". CSV has no real concept of cell types — every field is
 * just text — so this endpoint now uses a small quote-aware CSV parser
 * (identical logic to index.html's own parseCsv/parseCsvLine) instead of
 * xlsx. It does zero type inference: every field stays exactly the string
 * it was in the file, dates included. `xlsx` is no longer a dependency of
 * this specific endpoint (still used by upload-keyword-tracker.js, which
 * parses real .xlsx workbooks, not CSV, so it isn't affected by this bug).
 */
const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');

const TAB_NAME = 'bundle_sales';
const HEADERS = ['date', 'source_account', 'bundle_asin', 'title', 'is_virtual_multipack', 'bundles_sold', 'total_sales'];

// Quote-aware CSV line splitter — handles embedded commas inside quoted
// fields (e.g. TITLE values like `"Foo, Bar & Baz"`) and doubled-quote
// escaping (`""` inside a quoted field means a literal `"`). Deliberately
// does NO type inference — every field comes back as a plain string.
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] || '').replace(/^"|"$/g, '').trim(); });
    rows.push(obj);
  }
  return rows;
}

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
    const text = Buffer.from(contentBase64, 'base64').toString('utf-8');
    rows = parseCsv(text);
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
