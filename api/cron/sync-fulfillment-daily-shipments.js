/**
 * api/cron/sync-fulfillment-daily-shipments.js
 * One row per brand, per day, into that brand's own tab — attribution is
 * a direct &storeId= filter on /shipments (see _fulfillment_brands.js
 * for why this is simpler and more reliable than SKU matching).
 *
 * Sheet: SHEET_FULFILLMENT_DAILY_SHIPMENTS, one tab per brand (the 8
 * confirmed brands in _fulfillment_brands.js only).
 * Columns: date, orders_shipped, last_updated
 *
 * Date ranges use explicit 00:00:00/23:59:59 boundaries on shipDateStart/
 * shipDateEnd — added 2026-07-21 after the bare-date version returned
 * empty results for some (not all) dates for reasons never fully
 * diagnosed. Matches the pattern already proven working in
 * sync-fulfillment-states.js.
 *
 * BACKFILL MODE: pass ?days=N to process the last N days in ONE call,
 * reading and writing each brand's tab ONCE total (not once per day) —
 * added 2026-07-21 after manual single-day backfills, run back-to-back,
 * repeatedly triggered Google Sheets' per-minute read-quota limit. Has a
 * time budget (TIME_BUDGET_MS) — if it runs out mid-backfill, it still
 * writes everything accumulated so far and reports exactly which
 * brand/date combos didn't finish, so a second call can pick up cleanly
 * rather than silently losing partial progress.
 *
 * Manual / single-day backfill:
 *   GET /api/cron/sync-fulfillment-daily-shipments?date=YYYY-MM-DD
 * Bulk backfill:
 *   GET /api/cron/sync-fulfillment-daily-shipments?days=30
 */

const { ssFetch } = require('../_ss');
const { FULFILLMENT_BRANDS } = require('../_fulfillment_brands');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets = require('../config/sheets');

const HEADERS = ['date', 'orders_shipped', 'last_updated'];
const TIME_BUDGET_MS = 250_000; // stay safely under Vercel's 300s cap

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.fulfillmentDailyShipments) return res.status(500).json({ error: 'sheets.fulfillmentDailyShipments is not configured in config/sheets.js' });

  const startTime = Date.now();

  try {
    // ── Build the list of dates to process ────────────────────────────
    let dateList;
    if (req.query.days) {
      const n = parseInt(req.query.days, 10) || 30;
      dateList = [];
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dateList.push(easternDateStr(d));
      }
    } else if (req.query.date) {
      dateList = [req.query.date];
    } else {
      dateList = [easternDateStr(new Date())];
    }

    const nowLabel = new Date().toISOString();
    const results = [];
    let timedOut = false;

    for (const brand of FULFILLMENT_BRANDS) {
      if (Date.now() - startTime > TIME_BUDGET_MS) { timedOut = true; break; }

      try {
        const token = await ensureTab(sheets.fulfillmentDailyShipments, brand.tabName, HEADERS);
        const existing = await readRows(sheets.fulfillmentDailyShipments, brand.tabName);
        const rows = existing.map(r => [r.date, r.orders_shipped, r.last_updated]);
        const rowIndexByDate = {};
        rows.forEach((r, i) => { rowIndexByDate[r[0]] = i; });

        const brandResult = { brand: brand.id, days: {} };
        let brandTimedOut = false;

        for (const dateStr of dateList) {
          if (Date.now() - startTime > TIME_BUDGET_MS) { brandTimedOut = true; timedOut = true; break; }

          const count = await countShipmentsForDay(brand.storeId, dateStr);
          const newRow = [dateStr, count, nowLabel];
          if (dateStr in rowIndexByDate) rows[rowIndexByDate[dateStr]] = newRow;
          else { rowIndexByDate[dateStr] = rows.length; rows.push(newRow); }

          brandResult.days[dateStr] = count;
          await sleep(300);
        }

        await replaceRows(sheets.fulfillmentDailyShipments, brand.tabName, HEADERS, rows, token);
        if (brandTimedOut) brandResult.note = 'Time budget hit mid-brand — re-run the same call to pick up remaining dates for this brand.';
        results.push(brandResult);
      } catch (err) {
        console.error(`[sync-fulfillment-daily-shipments] ${brand.id} failed:`, err.message);
        results.push({ brand: brand.id, status: 'error', error: err.message });
      }
    }

    console.log(`[sync-fulfillment-daily-shipments] processed ${dateList.length} date(s) across ${results.length}/${FULFILLMENT_BRANDS.length} brands${timedOut ? ' (TIMED OUT — incomplete)' : ''}`);
    res.status(200).json({
      datesProcessed: dateList.length,
      dateRange: [dateList[0], dateList[dateList.length - 1]],
      results,
      ...(timedOut ? { timedOut: true, note: 'Ran out of time budget — re-run the exact same request to continue from where this left off.' } : {}),
    });
  } catch (err) {
    console.error('[sync-fulfillment-daily-shipments]', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

function easternDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}

async function countShipmentsForDay(storeId, dateStr) {
  const dateParam = `${dateStr.slice(5,7)}/${dateStr.slice(8,10)}/${dateStr.slice(0,4)}`;
  const startParam = `${dateParam} 00:00:00`;
  const endParam    = `${dateParam} 23:59:59`;

  let count = 0, page = 1, hasMore = true;
  while (hasMore) {
    const data = await ssFetch(`/shipments?storeId=${storeId}&shipDateStart=${encodeURIComponent(startParam)}&shipDateEnd=${encodeURIComponent(endParam)}&shipmentStatus=shipped&pageSize=500&page=${page}`);
    count += (data.shipments || []).length;
    hasMore = page < (data.pages || 1);
    page++;
    if (page > 200) break; // safety net against a runaway loop, not a real ceiling
    if (hasMore) await sleep(300);
  }
  return count;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
