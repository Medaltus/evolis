/**
 * api/upload-amazon-reviews.js
 * POST /api/upload-amazon-reviews
 *
 * DIFFERENT from upload-h10-reviews.js — that endpoint only updates ONE
 * aggregate field (reviews_requested per brand/month). This endpoint
 * ingests full PER-REVIEW detail: one row per individual Amazon review,
 * with reviewer name, star rating, title, full text, purchase type, and
 * the two source columns confirmed 2026-08-05 from a real Cowork export
 * (AmazonReviews_evolis_2026-07-31.xlsx, "Reviews" tab, 368 rows):
 *   SKU | ASIN | Product Name | Reviewer Name | Star Rating |
 *   Review Title | Date | Review Text | Purchase Type | Date Logged
 *
 * PRODUCT CATEGORY — per Jaclyn 2026-08-05: Cowork's NEXT export will add
 * a "Product Category" column that doesn't exist in the file confirmed
 * above. Added to this sheet's HEADERS now, proactively, rather than
 * waiting for that column to show up and hitting the exact kind of
 * "[sheets] HEADER MISMATCH" issue already found and fixed on the Amazon
 * Revenue History sheet (see sync-revenue-process.js, 2026-08-05) — this
 * sheet is ready for that column from day one; it'll just read as blank
 * on every upload until Cowork actually starts sending it.
 *
 * No brand column in the source file — brand is inferred from each row's
 * SKU prefix against config/brands.js, same convention already used by
 * sync-returns-process.js / sync-revenue-process.js. Unmatched SKU
 * prefixes are reported back in the response, never silently dropped.
 *
 * FIXED 2026-08-14 — this file predates skinuva-ca (added to
 * config/brands.js on 2026-08-14), and its brand-matching was a plain
 * `brands.find(b => sku.startsWith(b.skuPrefix))` — the exact same
 * shared-SKU-prefix collision bug already found and fixed today across
 * sync-products.js, sync-advertising-process.js, sync-subscriptions.js,
 * and others: skinuva-ca shares skinuva's exact 'SVA' prefix on purpose.
 * Not currently affecting anything live — no review-scraping automation
 * exists yet for skinuva or skinuva-ca specifically (confirmed with
 * Jaclyn: this pipeline currently only runs for evolis and
 * skinside-seoul, both of which have unique prefixes) — but fixed
 * proactively now, matching the same "close it before it becomes live"
 * approach used elsewhere today, given more brands are expected to be
 * onboarded through this same pipeline over time.
 *
 * FIXED 2026-08-14, second pass — this file also had no way to attribute
 * High On Love's reviews at all: it's deliberately excluded from
 * config/brands.js (separate Amazon seller account — see
 * _fulfillment_brands.js and upload-h10-reviews.js for the same
 * exclusion and reasoning), and this file's matching only ever checked
 * that shared registry. Confirmed 2026-08-14 per Jaclyn: SKU prefix
 * 'HOL'. Added the same way upload-h10-reviews.js already handles this
 * exact situation — an explicit extra entry, merged into the candidate
 * pool alongside brands.js, not a change to the shared registry itself.
 *
 * source data, so this uses a composite of sku + date + reviewer_name +
 * review_title. Not bulletproof (two genuinely different reviews from
 * the same reviewer, same day, with an identical title, would collide
 * and the second would overwrite the first) but is the most specific key
 * the available columns support. Flagging this rather than presenting it
 * as a guaranteed-unique ID. Each Cowork export appears to be a FULL
 * current snapshot (all 368 évolis rows carry the same "Date Logged" of
 * 2026-07-31, not just new reviews since last run), so this endpoint
 * upserts/merges rather than blindly appending — an unchanged review
 * re-uploaded on a later date just refreshes its date_logged and any
 * other field, never creates a duplicate row.
 *
 * Sheet: SHEET_AMAZON_REVIEWS. One tab per brand, auto-created on first
 * run — same convention as every other multi-brand sheet in this repo.
 *
 * Body: { filename, contentBase64 }
 *   No sheetId in the body (unlike upload-keyword-tracker.js) — there's
 *   only one legitimate destination for this specific upload, same
 *   reasoning upload-h10-reviews.js already documents for itself.
 *
 * Auth: Bearer CRON_SECRET required (upload-keyword-tracker.js's
 * convention — NOT upload-h10-reviews.js's, which has no auth check at
 * all; that looked like an oversight rather than a deliberate choice, so
 * defaulting to the safer precedent here rather than repeating it).
 *
 * Example curl:
 *   python3 -c "
 *   import base64, json
 *   with open('AmazonReviews_evolis_2026-07-31.xlsx','rb') as f:
 *       b64 = base64.b64encode(f.read()).decode()
 *   open('/tmp/reviews_payload.json','w').write(json.dumps({
 *       'filename': 'AmazonReviews_evolis_2026-07-31.xlsx',
 *       'contentBase64': b64
 *   }))
 *   "
 *   curl -X POST https://evolis.medaltus.com/api/upload-amazon-reviews \
 *     -H 'Authorization: Bearer <CRON_SECRET>' \
 *     -H 'Content-Type: application/json' \
 *     --data-binary @/tmp/reviews_payload.json
 */

const XLSX = require('xlsx');
const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const brands = require('./config/brands');

// ADDED 2026-08-14 — HighOnLove is deliberately NOT in config/brands.js
// (separate Amazon seller account — same reasoning documented in
// _fulfillment_brands.js and upload-h10-reviews.js, which already solves
// this exact problem for itself by appending HighOnLove alongside the
// brands.js-derived list). Confirmed 2026-08-14 per Jaclyn: SKU prefix
// 'HOL'. Without this, every HighOnLove review would land in
// unmatchedSkus and never get written anywhere — confirmed as a real gap
// before Lindsay's brands were onboarded through this pipeline.
const EXTRA_BRANDS_NOT_IN_REGISTRY = [
  { id: 'high-on-love', tabName: 'high-on-love', skuPrefix: 'HOL', active: true },
];

const SHEET_ID = process.env.SHEET_AMAZON_REVIEWS;

const HEADERS = [
  'sku', 'asin', 'product_name', 'product_category', 'reviewer_name',
  'star_rating', 'review_title', 'date', 'review_text', 'purchase_type',
  'date_logged', 'last_synced',
];

// ADDED 2026-08-14 — see file header. Same two-stage disambiguation
// helper used across every other file fixed today for this exact issue.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

function resolveBrandForSku(sku, candidates) {
  if (candidates.length === 1) return candidates[0];
  const isCa    = CA_SKU_PATTERN.test(sku);
  const caBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.ca');
  const usBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.com');
  if (isCa && caBrand) return caBrand;
  if (!isCa && usBrand) return usBrand;
  return usBrand || candidates[0];
}

function matchBrandForSku(sku) {
  const candidates = [...brands, ...EXTRA_BRANDS_NOT_IN_REGISTRY]
    .filter(b => b.active && sku.startsWith(b.skuPrefix.toUpperCase()));
  if (candidates.length === 0) return null;
  return resolveBrandForSku(sku, candidates);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SHEET_ID) {
    return res.status(500).json({ error: 'SHEET_AMAZON_REVIEWS env var not set — create the sheet and set this before uploading real data' });
  }

  const { filename, contentBase64 } = req.body || {};
  if (!contentBase64) return res.status(400).json({ error: 'Missing contentBase64' });

  let rows;
  try {
    const buffer = Buffer.from(contentBase64, 'base64');
    const workbook  = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames.includes('Reviews') ? 'Reviews' : workbook.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    console.log(`[upload-amazon-reviews] ${filename || '(no filename)'} — sheet "${sheetName}", ${rows.length} rows`);
  } catch (err) {
    console.error('[upload-amazon-reviews] failed to parse workbook:', err.message);
    return res.status(400).json({ error: 'Could not parse file as xlsx', detail: err.message });
  }

  if (!rows.length) return res.status(400).json({ error: 'No rows found in uploaded file' });

  // FIXED 2026-08-19 per Jaclyn — new Date().toISOString() is always
  // UTC, making last_synced confusing to read against Eastern-time
  // activity. Same toEstIso() helper already proven working in
  // sync-fbm-returns-process.js / sync-returns-process.js earlier this
  // project — reused here rather than inventing a new approach.
  const nowIso = toEstIso(new Date());
  const unmatchedSkus = new Set();
  const rowsByBrandTab = {};

  rows.forEach(r => {
    const sku = String(r['SKU'] || '').trim().toUpperCase();
    if (!sku) return;
    const matched = matchBrandForSku(sku);
    if (!matched) { unmatchedSkus.add(sku); return; }
    (rowsByBrandTab[matched.tabName] = rowsByBrandTab[matched.tabName] || []).push(r);
  });

  const results = [];

  for (const [tabName, brandRows] of Object.entries(rowsByBrandTab)) {
    try {
      const token    = await ensureTab(SHEET_ID, tabName, HEADERS);
      const existing = await readRows(SHEET_ID, tabName);

      // Merge by composite key — see file header for why this key shape
      // was chosen and its one known collision risk. Map naturally
      // gives incoming rows priority over existing ones on a key match
      // (existing populated first, incoming processed after), which is
      // exactly the desired "refresh on re-upload" behavior.
      const reviewKey = r => [
        String(r['SKU'] ?? r.sku ?? '').trim().toUpperCase(),
        String(r['Date'] ?? r.date ?? '').trim(),
        String(r['Reviewer Name'] ?? r.reviewer_name ?? '').trim().toLowerCase(),
        String(r['Review Title'] ?? r.review_title ?? '').trim().toLowerCase(),
      ].join('||');

      const merged = new Map();
      (existing || []).forEach(r => merged.set(reviewKey(r), r));

      brandRows.forEach(r => {
        merged.set(reviewKey(r), {
          sku:              String(r['SKU'] || '').trim().toUpperCase(),
          asin:             r['ASIN'] || '',
          product_name:     r['Product Name'] || '',
          // Blank until Cowork's next export actually sends this column
          // — see file header. Not an error, not guessed at.
          product_category: r['Product Category'] ?? '',
          reviewer_name:    r['Reviewer Name'] || '',
          star_rating:      r['Star Rating'] ?? '',
          review_title:     r['Review Title'] || '',
          date:             r['Date'] || '',
          review_text:      r['Review Text'] || '',
          purchase_type:    r['Purchase Type'] || '',
          date_logged:      r['Date Logged'] || '',
          last_synced:      nowIso,
        });
      });

      // FIXED 2026-08-14 — was defaulting to valueInputOption=RAW, same
      // forced-text issue found and fixed across several other files
      // today. star_rating now writes as a real number, date/date_logged
      // as real dates. sku/asin protected with a leading apostrophe
      // (Sheets' own force-text convention under USER_ENTERED) since
      // both can look numeric-ish and shouldn't risk reinterpretation.
      const TEXT_PROTECTED_COLS = new Set(['sku', 'asin']);
      const outRows = Array.from(merged.values()).map(r => HEADERS.map(h => {
        const v = r[h] ?? '';
        return (TEXT_PROTECTED_COLS.has(h) && v !== '') ? `'${v}` : v;
      }));
      await replaceRows(SHEET_ID, tabName, HEADERS, outRows, token, 'USER_ENTERED');

      console.log(`[upload-amazon-reviews] ${tabName} — ${brandRows.length} incoming rows, ${outRows.length} total rows after merge`);
      results.push({ brand: tabName, status: 'ok', incomingRows: brandRows.length, totalRows: outRows.length });
    } catch (err) {
      console.error(`[upload-amazon-reviews] ${tabName} failed:`, err.message);
      results.push({ brand: tabName, status: 'error', error: err.message });
    }
  }

  res.status(200).json({
    ok: true,
    filename: filename || null,
    results,
    ...(unmatchedSkus.size ? { unmatchedSkus: Array.from(unmatchedSkus) } : {}),
  });
};

// Same helper already proven in sync-fbm-returns-process.js /
// sync-returns-process.js — formats Eastern wall-clock time as an
// ISO-shaped string ending in "Z", so it displays consistently with
// every other Eastern-anchored timestamp in this project rather than
// UTC. Not a literal UTC timestamp despite the "Z" suffix — a deliberate,
// consistent convention already established elsewhere in this codebase.
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
