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
];

const RETENTION_DAYS = 120;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff    = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  console.log(`[trim-orders] trimming rows before ${cutoffStr}`);

  const results = [];

  for (const brand of brands.filter(b => b.active)) {
    try {
      const token   = await ensureTab(sheets.orders, brand.tabName, HEADERS);
      const allRows = await readRows(sheets.orders, brand.tabName);

      if (allRows.length === 0) {
        results.push({ brand: brand.id, before: 0, after: 0, trimmed: 0 });
        continue;
      }

      const kept    = allRows.filter(r => (r.date || '') >= cutoffStr);
      const trimmed = allRows.length - kept.length;

      if (trimmed === 0) {
        console.log(`[trim-orders] ${brand.id} — nothing to trim`);
        results.push({ brand: brand.id, before: allRows.length, after: kept.length, trimmed: 0 });
        continue;
      }

      // Sort by date asc, then order_id for consistency
      kept.sort((a, b) => {
        const d = (a.date || '').localeCompare(b.date || '');
        return d !== 0 ? d : (a.order_id || '').localeCompare(b.order_id || '');
      });

      const rowArrays = kept.map(row => HEADERS.map(h => row[h] !== undefined ? row[h] : ''));
      await replaceRows(sheets.orders, brand.tabName, HEADERS, rowArrays, token);

      console.log(`[trim-orders] ${brand.id} — trimmed ${trimmed} rows (${allRows.length} → ${kept.length})`);
      results.push({ brand: brand.id, before: allRows.length, after: kept.length, trimmed });

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
    cutoff: cutoffStr,
    results,
    totalTrimmed,
    timestamp: new Date().toISOString(),
  });
};
