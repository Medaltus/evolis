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

  // 2026-07-16 — optional override: ?month=YYYY-MM processes ONLY that one
  // month instead of the normal current+previous window. Needed because
  // this script only ever recomputes the current+previous month relative
  // to whenever it runs — a month like May, once July starts, falls
  // permanently outside that window and can never self-heal again no
  // matter how many times the normal cron fires. This is how May gets
  // fixed by hand without waiting for (or faking) a different system
  // clock. Combined with the existing mis-keyed-row cleanup below, this
  // also removes May's corrupted "1905" row the same way it already
  // cleaned up June/July's. Default (unparameterized) behavior, used by
  // the actual scheduled cron trigger, is completely unchanged. Per
  // Jaclyn 2026-07-16.
  const monthOverride = req.query.month; // e.g. "2026-05"
  let targetKeys;
  if (monthOverride) {
    if (!/^\d{4}-\d{2}$/.test(monthOverride)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format, e.g. 2026-05' });
    }
    targetKeys = new Set([monthOverride]);
    console.log(`[sync-shopify-revenue] month override active — processing ONLY ${monthOverride}, ignoring the normal current+previous window`);
  } else {
    let prevMonth = currMonth - 1;
    let prevYear  = currYear;
    if (prevMonth === 0) { prevMonth = 12; prevYear--; }
    targetKeys = new Set([
      `${currYear}-${String(currMonth).padStart(2,'0')}`,
      `${prevYear}-${String(prevMonth).padStart(2,'0')}`,
    ]);
  }

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
    //
    // 2026-07-16 — root cause confirmed for the "YEAR shows 1905" bug seen
    // in this tab: column B (YEAR) has date-type cell formatting applied
    // somewhere along the way. Google Sheets stores dates as a serial
    // day-count from Dec 30, 1899 — and the literal integer 2026 (or
    // 2023-2027, i.e. any year this cron would ever write), reinterpreted
    // as that kind of serial number, lands on a date in mid-1905 — exactly:
    // 2026 days after Dec 30 1899 is July 18 1905. Every year value this
    // cron writes gets silently reinterpreted the same way, regardless of
    // how carefully the value itself is sent, because cell FORMATTING is
    // independent of the write. The actual fix for that is in the sheet,
    // not in this file: select column B in this tab and set Format →
    // Number → Number, clearing whatever date format is currently applied.
    //
    // Separately — a real bug in THIS file, independent of the formatting
    // issue above: once a row's YEAR is corrupted, this upsert had no way
    // to recognize "this is the same real month, just mis-keyed" — it keys
    // existingMap by whatever YEAR the sheet currently shows, so a
    // corrupted row for real month 2026-06 sits at key "1905-06", a
    // DIFFERENT key than the "2026-06" this run computes fresh from real
    // order data. The corrected entry got ADDED alongside it instead of
    // replacing it, and the corrupted row was never removed — exactly the
    // duplicate rows found in the sheet (1905/6 and 1905/7 sitting next to
    // the correct 2026/6 and 2026/7).
    //
    // Fix: for each month this run is about to write a fresh, correct
    // entry for, first look for and delete any EXISTING row with a
    // plausible MONTH match but an implausible YEAR — same real month,
    // stale mis-keyed data — before adding the new one. Deliberately
    // scoped to only the months this run is already touching (current +
    // previous), never anything older: this cron only ever recomputes a
    // 2-month rolling window, so blindly discarding any implausible-year
    // row regardless of month would have deleted May's data outright once
    // it aged past that window, rather than leaving it for a manual fix.
    // That's exactly why May's row never self-corrected the way June/July
    // eventually did (they were still inside the rolling window when a
    // later run added a corrected duplicate; May wasn't, by the very next
    // run). Per Jaclyn 2026-07-16.
    let updatedCount = 0;
    for (const [key, data] of Object.entries(monthMap)) {
      const [yr, mo] = key.split('-');
      const yrNum = parseInt(yr, 10);

      Object.keys(existingMap).forEach(existingKey => {
        const [existingYr, existingMo] = existingKey.split('-');
        if (existingMo !== mo || existingKey === key) return;
        const existingYrNum = parseInt(existingYr, 10);
        const isImplausible = !existingYrNum || existingYrNum < yrNum - 15 || existingYrNum > yrNum + 2;
        if (isImplausible) {
          console.warn(`[sync-shopify-revenue] removing stale mis-keyed row for month ${mo} (was under key "${existingKey}", likely the date-formatting bug — see comment above) — replacing with correctly-keyed "${key}"`);
          delete existingMap[existingKey];
        }
      });

      existingMap[key] = {
        MONTH:            parseInt(mo, 10),
        YEAR:             yrNum,
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
