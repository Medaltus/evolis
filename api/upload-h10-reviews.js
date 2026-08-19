/**
 * api/upload-h10-reviews.js
 * POST /api/upload-h10-reviews
 *
 * Accepts an XLSX (base64) with one row per brand — columns: brand, year,
 * month, reviews_requested — and upserts ONLY those three fields into
 * that brand's own tab in SHEET_CUSTOMER_SERVICE, keyed by (year, month).
 *
 * DELIBERATELY DOES NOT TOUCH compliance_cases_resolved,
 * compliance_cases_open, or last_updated_on — those are manually
 * maintained, confirmed explicitly 2026-07-21. If a (year, month) row
 * doesn't exist yet, it's created with those three columns left blank
 * rather than guessed at. If it already exists, whatever's already in
 * those three columns is preserved exactly as-is — same "preserve the
 * other owner's columns" pattern sync-orders-process.js already uses for
 * Amazon Estimated Fees / Amazon Sale Promotions.
 *
 * Mirrors the same technical shape as upload-keyword-tracker.js (base64
 * XLSX in a JSON body, parsed with the xlsx/SheetJS package, written via
 * the service account) — same npm dependency, no new one needed if that
 * cron is already deployed.
 *
 * Brand matching: the XLSX's `brand` column is matched against
 * config/brands.js by `id` (case-insensitive) to find the right tab
 * name. Unmatched brand names are skipped and reported back in the
 * response — never silently dropped, never guessed at.
 *
 * Body: { sheetId, filename, contentBase64 }
 *   sheetId is accepted for parity with upload-keyword-tracker.js but
 *   this endpoint always writes to SHEET_CUSTOMER_SERVICE regardless —
 *   there's only one legitimate destination for this specific upload,
 *   unlike Keyword Tracker which can target different brand sheets.
 */

const XLSX = require('xlsx');
const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const brands = require('./config/brands');
const sheets = require('./config/sheets');

const HEADERS = ['year', 'month', 'reviews_requested', 'compliance_cases_resolved', 'compliance_cases_open', 'last_updated_on'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // FIXED 2026-08-19 — this endpoint had no authentication check at all,
  // confirmed while reviewing it directly (already flagged as suspicious
  // in upload-amazon-reviews.js's own comments, but never actually fixed
  // here until now). Every other upload-*.js endpoint in this project
  // requires this same Bearer CRON_SECRET check; this one writes to real
  // Customer Service data and had no protection whatsoever.
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { filename, contentBase64 } = req.body || {};
  if (!contentBase64) return res.status(400).json({ error: 'Missing contentBase64' });
  if (!sheets.customerService) return res.status(500).json({ error: 'sheets.customerService is not configured in config/sheets.js — add SHEET_CUSTOMER_SERVICE' });

  let rows;
  try {
    const buf = Buffer.from(contentBase64, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse XLSX', detail: err.message });
  }

  if (!rows.length) return res.status(400).json({ error: 'No rows found in uploaded file' });

  // HighOnLove is NOT in config/brands.js (deliberately kept out — same
  // reasoning as _fulfillment_brands.js: it's on a separate Amazon seller
  // account, and adding it to the shared registry would make it start
  // appearing in every cron that loops brands.filter(b => b.active)).
  // Confirmed 2026-07-21 that HighOnLove DOES have a Follow Up automation,
  // so it needs to be recognized here specifically, without touching the
  // shared registry.
  const activeBrands = [
    ...brands.filter(b => b.active).map(b => ({ id: b.id, tabName: b.tabName })),
    { id: 'high-on-love', tabName: 'high-on-love' },
  ];
  const nowIso = new Date().toISOString();
  const results = [];
  const unmatched = [];

  // Group rows by matched brand — one file can carry multiple brands' rows
  const rowsByBrand = {};
  rows.forEach(r => {
    const rawBrand = String(r.brand || r.Brand || '').trim().toLowerCase();
    const match = activeBrands.find(b => b.id.toLowerCase() === rawBrand);
    if (!match) { unmatched.push(rawBrand || '(blank)'); return; }
    (rowsByBrand[match.tabName] = rowsByBrand[match.tabName] || []).push(r);
  });

  for (const [tabName, brandRows] of Object.entries(rowsByBrand)) {
    try {
      const token = await ensureTab(sheets.customerService, tabName, HEADERS);
      const existing = await readRows(sheets.customerService, tabName);
      const sheetRows = existing.map(r => HEADERS.map(h => r[h] ?? ''));
      const indexByPeriod = {};
      sheetRows.forEach((r, i) => { indexByPeriod[`${r[0]}-${r[1]}`] = i; });

      let updated = 0, added = 0;
      for (const r of brandRows) {
        const year  = String(r.year || r.Year || '').trim();
        const month = String(r.month || r.Month || '').trim();
        const reviewsRequested = r.reviews_requested ?? r['Reviews Requested'] ?? '';
        if (!year || !month) continue;

        const key = `${year}-${month}`;
        if (key in indexByPeriod) {
          // Existing row — overwrite ONLY reviews_requested, leave the
          // other four columns (including the other two indices 0/1
          // which get rewritten identically, and indices 3/4/5 which are
          // untouched) exactly as they already were.
          sheetRows[indexByPeriod[key]][2] = reviewsRequested;
          updated++;
        } else {
          // New period — year/month/reviews_requested filled in, the
          // three manually-maintained columns left blank, not guessed at.
          sheetRows.push([year, month, reviewsRequested, '', '', '']);
          added++;
        }
      }

      // FIXED 2026-08-19 — was defaulting to valueInputOption=RAW. This
      // matters more here than in most files: every run reads back and
      // rewrites the ENTIRE row, including the compliance_cases_* /
      // last_updated_on columns this file explicitly promises never to
      // touch (per file header, "preserve the other owner's columns").
      // Under RAW, a manually-typed number in those columns would get
      // silently rewritten as forced text on every single run — the
      // displayed value looks unchanged, but the cell's real type
      // quietly degrades each time. year/month/reviews_requested also
      // now correctly write as real numbers instead of text.
      await replaceRows(sheets.customerService, tabName, HEADERS, sheetRows, token, 'USER_ENTERED');
      results.push({ brand: tabName, status: 'ok', updated, added });
    } catch (err) {
      console.error(`[upload-h10-reviews] ${tabName} failed:`, err.message);
      results.push({ brand: tabName, status: 'error', error: err.message });
    }
  }

  res.status(200).json({
    ok: true,
    filename: filename || null,
    results,
    ...(unmatched.length ? { unmatchedBrandNames: unmatched } : {}),
  });
};
