/**
 * api/cron/sync-oos-history-backfill.js
 * ONE-TIME BACKFILL for api/cron/sync-oos-history.js. Reconstructs OOS
 * PERIODS retroactively by replaying that cron's exact state machine
 * once per historical date already logged in SHEET_PRODUCTS, instead
 * of once for "today."
 *
 * ADDED 2026-09-01 per Jaclyn, alongside sync-oos-history.js itself.
 *
 * *** IMPORTANT CAVEAT ***
 * This can only reconstruct history as far back as SHEET_PRODUCTS still
 * has rows for. Per sync-oos-history.js's own header, trim-products-
 * log.js's retention was cut from 2 years to 13 months. So if the
 * products cache cron has actually been running longer than that, the
 * earliest OOS periods are already gone from the source data and this
 * script cannot recover them -- there's nothing left to replay against.
 * Each brand's actual reconstructed window start is reported back in
 * the response as `truncated_start`, so you can see exactly how far
 * back each brand really goes before trusting the "since the products
 * cache cron started" framing.
 *
 * This file is NOT added to vercel.json -- it's meant to be triggered
 * once, manually, then left alone. Re-running it is safe (see the
 * &force flag below) but pointless once sync-oos-history.js has taken
 * over live.
 *
 * SAME two tracked definitions per SKU as sync-oos-history.js:
 *   'fba'          -- fulfillable_quantity <= 0
 *   'all_inventory' -- fulfillable_quantity <= 0 AND seller_fulfilled_quantity <= 0
 * (Same caveat applies here too: these weren't independently confirmed
 * against the dashboard's own "[OOS]" logic -- check that before
 * trusting this as ground truth.)
 *
 * State machine, replayed once per date D in ascending order across
 * every date SHEET_PRODUCTS has rows for (one full day D fully
 * processed = SKU is either "out" or "in" for that day, exactly as
 * sync-oos-history.js would have found it had it run live that day):
 *   - out on D, no open instance    -> START (start_date = D)
 *   - out on D, instance open       -> CONTINUE
 *   - back in stock on D, open      -> CLOSE. end_date = the LAST
 *     historical date that SKU/type was actually confirmed out -- i.e.
 *     the previous date *processed*, not calendar D-1. SHEET_PRODUCTS
 *     can have gaps (cron didn't run some days), so calendar arithmetic
 *     would silently invent OOS days that were never actually observed.
 *   - SKU missing entirely from D's snapshot while an instance is open
 *     -> CLOSE, status 'closed_discontinued', same last-processed-date
 *     logic for end_date. Skipped on the very last date in the range
 *     (see below).
 *
 * On the FINAL date processed, anything still open is left OPEN and
 * written as-is -- never force-closed just because the backfill loop
 * ends. sync-oos-history.js's next live daily run reads existing rows
 * via readRows() and will pick these up and continue them normally, as
 * if it had been running the whole time. This is also why the
 * "discontinued" check is skipped on the final date: with no
 * "tomorrow" to confirm the SKU is really gone (vs. just not synced
 * yet), closing it here would risk a false discontinuation the live
 * cron could never undo.
 *
 * Sheet: SHEET_OOS_HISTORY (same sheet/tabs sync-oos-history.js writes
 * to). Columns: brand, sku, asin, type, start_date, end_date, status,
 * last_updated
 *
 * Manual:
 *   GET /api/cron/sync-oos-history-backfill
 *   Authorization: Bearer <CRON_SECRET>
 *   &brand=creme-shop   -- restrict to one brand
 *   &dryRun=true        -- compute + report window/counts, write nothing
 *   &force=true          -- backfill a brand even if its OOS tab already
 *                            has rows (overwrites them). Without this,
 *                            a brand with any existing rows is skipped,
 *                            so you can't accidentally double-count a
 *                            brand that's already been backfilled or
 *                            that the live cron has already started
 *                            writing to.
 *
 * Recommended: run once with &dryRun=true first (per brand or all), eyeball
 * truncated_start / totalRows in the response, THEN run for real.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                                = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');

const HEADERS = ['brand', 'sku', 'asin', 'type', 'start_date', 'end_date', 'status', 'last_updated'];
const TYPES = ['fba', 'all_inventory'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sheets.oosHistory) {
    return res.status(500).json({ error: 'sheets.oosHistory is not configured in config/sheets.js -- add SHEET_OOS_HISTORY' });
  }

  const onlyBrand = req.query.brand || null;
  const dryRun = req.query.dryRun === 'true';
  const force = req.query.force === 'true';
  const activeBrands = brands.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));

  const now = toEstIso(new Date());
  const results = [];

  for (const brand of activeBrands) {
    try {
      // Refuse to clobber a brand that's already been backfilled (or
      // that the live cron has already started writing to) unless
      // explicitly forced.
      if (!force) {
        const already = await readRows(sheets.oosHistory, brand.tabName).catch(() => []);
        if (already && already.length > 0) {
          results.push({ brand: brand.id, status: 'skipped', reason: `SHEET_OOS_HISTORY already has ${already.length} row(s) for this brand -- pass &force=true to overwrite` });
          continue;
        }
      }

      const productRows = await readRows(sheets.products, brand.tabName);
      if (!productRows || productRows.length === 0) {
        results.push({ brand: brand.id, status: 'skipped', reason: 'no rows found in SHEET_PRODUCTS' });
        continue;
      }

      // Group every historical row by date, keyed by SKU within each date.
      // Rows with a malformed date (anything not YYYY-MM-DD -- e.g. a
      // stray cell reference like "A1" leaking in from a header row)
      // are skipped rather than included: a garbage value that sorts
      // after real dates would get mistaken for the range's last date,
      // which would wrongly exempt the TRUE last date from the
      // discontinued-check and instead subject it to a bogus one.
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const rowsByDate = new Map(); // date -> Map(sku -> row)
      let badDateRows = 0;
      productRows.forEach(r => {
        const date = (r.date || '').trim();
        const sku = (r.sku || '').trim();
        if (!date || !sku) return;
        if (!DATE_RE.test(date)) { badDateRows++; return; }
        if (!rowsByDate.has(date)) rowsByDate.set(date, new Map());
        rowsByDate.get(date).set(sku, r);
      });

      // ISO 'YYYY-MM-DD' dates sort correctly as plain strings.
      const sortedDates = Array.from(rowsByDate.keys()).sort();
      if (sortedDates.length === 0) {
        results.push({ brand: brand.id, status: 'skipped', reason: 'no dated rows found in SHEET_PRODUCTS' });
        continue;
      }

      // sku||type -> { asin, start_date, last_seen_date }
      const openInstanceByKey = new Map();
      const closedRows = [];
      let started = 0, continued = 0, closed = 0, closedDiscontinued = 0;

      sortedDates.forEach((date, idx) => {
        const isLastDate = idx === sortedDates.length - 1;
        const todayRowsBySku = rowsByDate.get(date);

        todayRowsBySku.forEach((row, sku) => {
          const fulfillable = parseInt(row.fulfillable_quantity, 10) || 0;
          const sellerFulfilled = parseInt(row.seller_fulfilled_quantity, 10) || 0;
          const isOutFba = fulfillable <= 0;
          const isOutAll = fulfillable <= 0 && sellerFulfilled <= 0;
          const outByType = { fba: isOutFba, all_inventory: isOutAll };

          TYPES.forEach(type => {
            const key = `${sku}||${type}`;
            const openRow = openInstanceByKey.get(key);
            const isOutToday = outByType[type];

            if (isOutToday && !openRow) {
              // START
              openInstanceByKey.set(key, { asin: row.asin || '', start_date: date, last_seen_date: date });
              started++;
            } else if (isOutToday && openRow) {
              // CONTINUE -- extend the known-out window through today
              openRow.last_seen_date = date;
              if (row.asin) openRow.asin = row.asin;
              continued++;
            } else if (!isOutToday && openRow) {
              // CLOSE -- back in stock; end_date = last date actually
              // confirmed out (not calendar D-1, to survive gaps)
              closedRows.push([brand.id, sku, openRow.asin || row.asin || '', type, openRow.start_date, openRow.last_seen_date, 'closed', now]);
              openInstanceByKey.delete(key);
              closed++;
            }
            // else: in stock today, no open instance -- nothing to do
          });
        });

        // Discontinued check: any instance still open after processing
        // `date` whose SKU didn't appear in `date`'s snapshot at all.
        // Skipped on the final date -- see header note on why.
        if (!isLastDate) {
          Array.from(openInstanceByKey.entries()).forEach(([key, openRow]) => {
            const [sku, type] = key.split('||');
            if (!todayRowsBySku.has(sku)) {
              closedRows.push([brand.id, sku, openRow.asin || '', type, openRow.start_date, openRow.last_seen_date, 'closed_discontinued', now]);
              openInstanceByKey.delete(key);
              closedDiscontinued++;
            }
          });
        }
      });

      // Whatever's left open at the end of the range stays open, ready
      // for sync-oos-history.js's next live run to pick up and continue.
      const finalOpenRows = Array.from(openInstanceByKey.entries()).map(([key, openRow]) => {
        const [sku, type] = key.split('||');
        return [brand.id, sku, openRow.asin || '', type, openRow.start_date, '', 'open', now];
      });

      const outRows = [...closedRows, ...finalOpenRows];
      const truncatedStart = sortedDates[0];
      const windowEnd = sortedDates[sortedDates.length - 1];

      if (!dryRun) {
        const token = await ensureTab(sheets.oosHistory, brand.tabName, HEADERS);
        await replaceRows(sheets.oosHistory, brand.tabName, HEADERS, outRows, token);
      }

      console.log(`[sync-oos-history-backfill] ${brand.id} -- window=${truncatedStart}..${windowEnd} started=${started} continued=${continued} closed=${closed} closedDiscontinued=${closedDiscontinued} stillOpen=${finalOpenRows.length} badDateRows=${badDateRows}${dryRun ? ' (DRY RUN)' : ''}`);
      results.push({
        brand: brand.id,
        status: dryRun ? 'dry_run' : 'ok',
        truncated_start: truncatedStart,
        window_end: windowEnd,
        started, continued, closed, closedDiscontinued,
        stillOpen: finalOpenRows.length,
        totalRows: outRows.length,
        badDateRows,
      });
    } catch (err) {
      console.error(`[sync-oos-history-backfill] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0 && !dryRun) {
    await sendCronFailureAlert(
      'sync-oos-history-backfill',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ dryRun, results });
};

// Same helper already proven throughout this project.
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
