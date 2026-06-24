/**
 * api/cron/sync-shopify-revenue.js
 * Runs daily — reads Shopify orders sheet, aggregates revenue for the
 * current month and last month only, and upserts those two rows into
 * the Shopify revenue tab.
 *
 * Only current + last month are updated on each run. All historical rows
 * are preserved and written back untouched.
 *
 * Source sheet:  SHOPIFY_ORDERS_SHEET  (tab: orders, gid=0)
 * Revenue sheet: SHOPIFY_ORDERS_SHEET  (tab: revenue, gid=7000599)
 *
 * Revenue headers: MONTH | YEAR | REVENUE | UNITS ORDERED | LAST UPDATED
 *
 * Schedule: daily at 7AM UTC ("0 7 * * *") — same run as sync-shopify-orders
 * so revenue is always updated after orders are written.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');

const SHEET_ID = process.env.SHOPIFY_ORDERS_SHEET;

const ORDERS_TAB  = 'orders';
const REVENUE_TAB = 'revenue';

const REVENUE_HEADERS = ['MONTH', 'YEAR', 'REVENUE', 'UNITS ORDERED', 'LAST UPDATED'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SHEET_ID) return res.status(500).json({ error: 'SHOPIFY_ORDERS_SHEET not set' });

  const nowEst = toEstIso(new Date());

  // Determine current month and last month
  const today     = new Date();
  const currYear  = today.getUTCFullYear();
  const currMonth = today.getUTCMonth() + 1; // 1-indexed

  let prevMonth = currMonth - 1;
  let prevYear  = currYear;
  if (prevMonth === 0) { prevMonth = 12; prevYear--; }

  const targetKeys = new Set([
    `${currYear}-${String(currMonth).padStart(2,'0')}`,
    `${prevYear}-${String(prevMonth).padStart(2,'0')}`,
  ]);

  console.log(`[sync-shopify-revenue] updating months: ${[...targetKeys].join(', ')}`);

  try {
    // ── 1. Read orders ──────────────────────────────────────────────────────
    let orderRows = [];
    try {
      orderRows = await readRows(SHEET_ID, ORDERS_TAB);
    } catch (e) {
      console.log('[sync-shopify-revenue] no orders tab yet, skipping');
      return res.status(200).json({ message: 'No orders tab found', timestamp: nowEst });
    }

    if (!orderRows.length) {
      return res.status(200).json({ message: '0 order rows', timestamp: nowEst });
    }

    // ── 2. Aggregate current + last month ───────────────────────────────────
    const monthMap = {}; // "YYYY-MM" → { orderIds, revenue, units }

    for (const row of orderRows) {
      // Skip refunded/cancelled
      const finStatus = (row.financial_status || row.status || '').toLowerCase().trim();
      if (finStatus === 'refunded' || finStatus === 'cancelled' || finStatus === 'canceled') continue;

      const date = normalizeDate(row.date);
      if (!date) continue;
      const key = date.substring(0, 7); // "YYYY-MM"
      if (!targetKeys.has(key)) continue;

      if (!monthMap[key]) {
        monthMap[key] = { orderIds: new Set(), revenue: 0, units: 0 };
      }

      const orderId = (row.order_id || '').trim();
      const price   = parseFloat((row.item_price || '0').replace(/[$,]/g, '')) || 0;
      const units   = parseInt(row.unit_count, 10) || 0;

      // Revenue: sum item_price per unique order_id to avoid multi-line double count
      if (orderId && !monthMap[key].orderIds.has(orderId)) {
        monthMap[key].orderIds.add(orderId);
      }
      // item_price is already per-line so sum all lines
      monthMap[key].revenue += price;
      monthMap[key].units   += units;
    }

    if (!Object.keys(monthMap).length) {
      console.log('[sync-shopify-revenue] no data for target months');
      return res.status(200).json({ message: 'No data for target months', timestamp: nowEst });
    }

    // ── 3. Read existing revenue rows ───────────────────────────────────────
    const tok = await ensureTab(SHEET_ID, REVENUE_TAB, REVENUE_HEADERS);
    let existingRows = [];
    try {
      existingRows = await readRows(SHEET_ID, REVENUE_TAB);
    } catch (e) { /* new tab */ }

    // Build map of existing rows keyed by "YYYY-MM"
    const existingMap = {};
    for (const r of existingRows) {
      const yr = String(r.YEAR  || r.year  || '').trim();
      const mo = String(r.MONTH || r.month || '').trim().padStart(2, '0');
      if (yr && mo) existingMap[`${yr}-${mo}`] = r;
    }

    // ── 4. Upsert target months only ────────────────────────────────────────
    let updatedCount = 0;
    for (const [key, data] of Object.entries(monthMap)) {
      const [yr, mo] = key.split('-');
      existingMap[key] = {
        MONTH:            parseInt(mo, 10),
        YEAR:             parseInt(yr, 10),
        REVENUE:          Math.round(data.revenue * 100) / 100,
        'UNITS ORDERED':  data.units,
        'LAST UPDATED':   nowEst,
      };
      updatedCount++;
    }

    // ── 5. Write all rows back sorted by year-month ascending ───────────────
    const sortedKeys = Object.keys(existingMap).sort();
    const newRows = sortedKeys.map(key => {
      const r = existingMap[key];
      return [
        r.MONTH             || r.month  || '',
        r.YEAR              || r.year   || '',
        r.REVENUE           || r.revenue || 0,
        r['UNITS ORDERED']  || r.units  || 0,
        r['LAST UPDATED']   || r.last_updated || '',
      ];
    });

    await replaceRows(SHEET_ID, REVENUE_TAB, REVENUE_HEADERS, newRows, tok);
    console.log(`[sync-shopify-revenue] ${updatedCount} months updated, ${newRows.length} total rows written`);

    return res.status(200).json({
      monthsUpdated: updatedCount,
      totalRows:     newRows.length,
      timestamp:     nowEst,
    });

  } catch (err) {
    console.error('[sync-shopify-revenue] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeDate(val) {
  if (!val) return '';
  if (/^\d{4}-\d{2}/.test(val)) return val.substring(0, 10);
  const parts = val.split('/');
  if (parts.length === 3) {
    const m = parts[0].padStart(2, '0');
    const d = parts[1].padStart(2, '0');
    const y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
    return `${y}-${m}-${d}`;
  }
  return val;
}

function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
