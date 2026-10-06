/**
 * api/cron/trim-orders.js
 * Runs daily — removes rows older than 120 days from all brand tabs
 * in the rolling amazon-orders sheet.
 *
 * CHANGED 2026-08-12 per Jaclyn — was 90 days. Real data check across all
 * 15 brand tabs confirmed the actual real-data footprint at 90 days is
 * only ~262K cells total, nowhere close to Google Sheets' 10M cell limit
 * — plenty of headroom to extend. The extra 30 days is a safety margin
 * for the Sales page's Prior Month view (needs a full prior calendar
 * month of data behind whatever "today" is, and 90 days was occasionally
 * cutting it close depending on the day of month).
 *
 * Keeps the sheet lean for fast reads while retaining enough history
 * for current month + 3 full prior months (MOM trending).
 * YOY data lives in sheets.ordersHistorical.
 *
 * Schedule: daily at 3AM UTC ("0 3 * * *")
 *
 * GET /api/cron/trim-orders
 * Authorization: Bearer <CRON_SECRET>
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');
const { normalizeOrderDate }               = require('../_dates'); // ADDED 2026-10-06 — reads every date shape

// FIXED 2026-08-14 — same bug as fees-estimate.js and sale-promotions.js,
// found earlier today: this was still the pre-2026-08-12 15-column shape,
// missing 'Amazon Estimated fees'/'Amazon Sale Promotions'/'marketplace'/
// 'channel'. Since this cron runs DAILY and rebuilds every kept row via
// `HEADERS.map(h => row[h] ...)` whenever there's anything to trim — which
// in steady state (once a tab has 120+ days of history) is effectively
// every single day — this was silently wiping all four columns across
// the ENTIRE orders sheet on nearly every run, not just the trimmed rows.
const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
  'Amazon Estimated fees',
  'Amazon Sale Promotions',
  'marketplace',
  'channel',
  // ADDED 2026-10-06 — same bug a FOURTH time (see the 2026-08-14 note
  // above): sync-orders-process.js added selling_account (column T) on
  // 2026-08-21 and this list was never updated, so every daily trim
  // rewrote each brand's orders tab without column T.
  'selling_account',
];
// HEADERS above is now only what ensureTab checks/creates a NEW tab with.
// The rewrite below uses each tab's OWN header row instead (see
// columnsForTab), so a column added to the orders sheet in the future can
// never be silently wiped by this cron again, even if nobody remembers to
// update this list.

const RETENTION_DAYS = 120;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff    = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  // ADDED 2026-10-06 — ?dryRun=true reports what WOULD be trimmed per brand
  // (and which date formats each tab actually has) without writing anything.
  const dryRun = req.query.dryRun === 'true';
  console.log(`[trim-orders] ${dryRun ? '(dry run) ' : ''}trimming rows before ${cutoffStr}`);

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token   = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const allRows = await readRows(sheets.orders, brand.tabName);

      if (allRows.length === 0) {
        results.push({ brand: brand.id, before: 0, after: 0, trimmed: 0 });
        continue;
      }

      // FIXED 2026-10-06 — real incident: MiGuard still had April orders in
      // a 120-day cache in October. This compared the RAW date text against
      // "YYYY-MM-DD". If a tab's date cells read back as "4/15/2026" (Sheets
      // auto-converting text into real date cells), plain text comparison
      // breaks both ways: "4/15/2026" sorts AFTER "2026-..." so old rows were
      // never trimmed, and "10/5/2026" sorts BEFORE it so recent Oct–Jan
      // rows could be deleted. Every date is now normalized to YYYY-MM-DD
      // first (ISO text, M/D/YYYY text, or a raw Sheets date serial). A date
      // that can't be read at all is KEPT — this cron never deletes a row it
      // can't date.
      const formats = {};
      let unreadable = 0;
      const kept = allRows.filter(r => {
        const { iso, format } = normalizeOrderDate(r.date);
        formats[format] = (formats[format] || 0) + 1;
        if (!iso) { unreadable++; return true; }
        r.__iso = iso;
        return iso >= cutoffStr;
      });
      const trimmed = allRows.length - kept.length;
      if (unreadable) console.warn(`[trim-orders] ${brand.id} — ${unreadable} row(s) with an unreadable date kept as-is`);

      // ADDED 2026-10-06 — safety valve. This cron deletes data, so if a
      // trim would remove EVERY row, something is wrong (e.g. the date
      // column switched to a format like 10/5/2026 that doesn't compare
      // against YYYY-MM-DD) — skip the tab and alert instead of emptying it.
      if (kept.length === 0) {
        console.error(`[trim-orders] ${brand.id} — every row is older than ${cutoffStr}?! Skipping instead of emptying the tab. First date seen: "${allRows[0].date}"`);
        results.push({ brand: brand.id, status: 'error', error: `trim would delete all ${allRows.length} rows — skipped (check the date column's format; first date seen: "${allRows[0].date}")` });
        continue;
      }

      if (trimmed === 0) {
        console.log(`[trim-orders] ${brand.id} — nothing to trim`);
        results.push({ brand: brand.id, before: allRows.length, after: kept.length, trimmed: 0, dateFormats: formats, ...(dryRun ? { dryRun: true, ...duplicateStats(kept) } : {}) });
        continue;
      }

      // Sort by date asc, then order_id for consistency
      kept.sort((a, b) => {
        const d = (a.__iso || '').localeCompare(b.__iso || ''); // normalized dates (2026-10-06)
        return d !== 0 ? d : (a.order_id || '').localeCompare(b.order_id || '');
      });

      // Rewrite using this tab's ACTUAL columns, in its actual order (readRows
      // keys every row by row 1), so every column survives — including ones
      // added later that HEADERS doesn't know about. CHANGED 2026-10-06.
      const columns   = columnsForTab(allRows);
      if (dryRun) {
        const oldest = kept.reduce((m, r) => (r.__iso && (!m || r.__iso < m) ? r.__iso : m), null);
        results.push({ brand: brand.id, dryRun: true, before: allRows.length, wouldKeep: kept.length, wouldTrim: trimmed, oldestKept: oldest, dateFormats: formats, unreadableDatesKept: unreadable, ...duplicateStats(kept) });
        continue;
      }

      const rowArrays = kept.map(row => columns.map(h => row[h] ?? ''));
      await replaceRows(sheets.orders, brand.tabName, HEADERS, rowArrays, token);

      console.log(`[trim-orders] ${brand.id} — trimmed ${trimmed} rows (${allRows.length} → ${kept.length})`);
      results.push({ brand: brand.id, before: allRows.length, after: kept.length, trimmed, dateFormats: formats });

    } catch (err) {
      console.error(`[trim-orders] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const totalTrimmed = results.reduce((s, r) => s + (r.trimmed || 0), 0);

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'trim-orders',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({
    dryRun,
    cutoff: cutoffStr,
    results,
    totalTrimmed,
    timestamp: new Date().toISOString(),
  });
};

// The tab's real header row, in order. readRows builds every row object from
// row 1, so the first row's keys ARE the sheet's columns. Falls back to
// HEADERS only if somehow nothing was read.
function columnsForTab(allRows) {
  const cols = allRows.length ? Object.keys(allRows[0]) : [];
  return cols.length ? cols : HEADERS;
}

// ADDED 2026-10-06 — dry-run diagnostic only (never changes data). Counts
// rows that share an order_id + sku with an earlier row — the same key
// sync-orders-process.js matches on — so duplicated orders show up
// directly instead of being guessed at from row counts.
function duplicateStats(rows) {
  const seen = new Map();
  let duplicateRows = 0;
  const examples = [];
  for (const r of rows) {
    const key = `${r.order_id || ''}||${r.sku || ''}`;
    if (key === '||') continue;
    if (seen.has(key)) {
      duplicateRows++;
      if (examples.length < 3) examples.push({ order_id: r.order_id, sku: r.sku, dates: [seen.get(key), r.date] });
    } else {
      seen.set(key, r.date);
    }
  }
  return duplicateRows ? { duplicateRows, duplicateExamples: examples } : { duplicateRows: 0 };
}
