/**
 * api/cron/sync-oos-history-backfill.js
 * ONE-TIME BACKFILL for api/cron/sync-oos-history.js. Reconstructs OOS
 * PERIODS retroactively by replaying that cron's state machine once per
 * historical date already logged in SHEET_PRODUCTS, instead of once for
 * "today."
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
 * DELETED/DISCONTINUED SKUS ARE EXCLUDED ENTIRELY, per Jaclyn -- cross-
 * referenced against SHEET_MASTER_SKU_LIST (one shared tab across all
 * brands, not per-brand). Checks TWO signals, because the sheet uses two
 * different conventions:
 *   - Status column === 'DELETED' (most brands)
 *   - Product Short Name starts with "DISCONTINUED" (Dazzle Dry, which
 *     leaves Status blank entirely)
 * A SKU matching either never enters the replay at all -- no rows are
 * ever written for it, for any date in the range.
 *
 * *** ABSENCE FROM A DAY'S SNAPSHOT NEVER MEANS DISCONTINUED ***
 * Per Jaclyn: if the underlying products cron failed or skipped a row
 * on some day, that is NOT evidence the product was discontinued, and
 * this script must not guess otherwise. A SKU that simply doesn't
 * appear in a given date's SHEET_PRODUCTS rows is skipped for that date
 * only -- its open instance (if any) is carried forward completely
 * unchanged, picked back up whenever the SKU next appears in the data,
 * however many days later that is. The only way a SKU's tracking ever
 * ends before the range's last date is a genuine "back in stock"
 * reading, or the master-SKU-list exclusion above. There is no
 * "closed_discontinued" status produced by this script.
 *
 * State machine, replayed once per date D in ascending order across
 * every date SHEET_PRODUCTS has rows for:
 *   - out on D, no open instance    -> START (start_date = D)
 *   - out on D, instance open       -> CONTINUE
 *   - back in stock on D, open      -> CLOSE. end_date = the LAST
 *     historical date that SKU/type was actually confirmed out -- i.e.
 *     the last date it was seen in a START or CONTINUE, which may be
 *     several days before D if there were gaps in between.
 *   - SKU absent from D's snapshot entirely -> no action taken this
 *     date. Any open instance is left exactly as it was.
 *
 * On the FINAL date processed, anything still open is left OPEN and
 * written as-is. sync-oos-history.js's next live daily run reads
 * existing rows via readRows() and will pick these up and continue them
 * normally, as if it had been running the whole time.
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
  if (!sheets.masterSkuList) {
    return res.status(500).json({ error: 'sheets.masterSkuList is not configured in config/sheets.js -- add SHEET_MASTER_SKU_LIST (needed to exclude deleted/discontinued SKUs)' });
  }

  // SHEET_MASTER_SKU_LIST is ONE shared tab across all brands (same gid
  // for every brand row in the sheet-ID map), not a per-brand tab like
  // SHEET_PRODUCTS/SHEET_OOS_HISTORY -- so this is read once, not per
  // brand. NOTE: readRows(sheets.masterSkuList) with no tabName argument
  // is an assumption based on that single-tab structure -- if
  // _sheets_client.js actually requires a tabName, this throws, which
  // is why it's wrapped below instead of left to crash the function.
  let deletedSkus;
  try {
    const masterRows = await readRows(sheets.masterSkuList);
    deletedSkus = new Set();
    (masterRows || []).forEach(r => {
      const sku = (r.sku || '').trim();
      if (!sku) return;
      const status = (r.status || '').trim().toUpperCase();
      const shortName = (r.product_short_name || '').trim();
      if (status === 'DELETED' || /^DISCONTINUED\b/i.test(shortName)) {
        deletedSkus.add(sku);
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to read SHEET_MASTER_SKU_LIST',
      detail: err.message,
      hint: 'readRows(sheets.masterSkuList) was called with no tabName -- check whether _sheets_client.js requires one even for a single-tab sheet, and if so pass the correct tab name here.',
    });
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

      // Group every historical row by date, keyed by SKU within each
      // date. Rows with a malformed date (anything not YYYY-MM-DD -- a
      // stray cell reference like "A1" leaking in from a header row)
      // are skipped rather than included, since a garbage value sorting
      // after real dates would get mistaken for the range's last date.
      // SKUs confirmed deleted/discontinued in SHEET_MASTER_SKU_LIST
      // are excluded entirely -- they never enter the replay.
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const rowsByDate = new Map(); // date -> Map(sku -> row)
      let badDateRows = 0;
      let excludedDeletedRows = 0;
      productRows.forEach(r => {
        const date = (r.date || '').trim();
        const sku = (r.sku || '').trim();
        if (!date || !sku) return;
        if (deletedSkus.has(sku)) { excludedDeletedRows++; return; }
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
      let started = 0, continued = 0, closed = 0;

      sortedDates.forEach((date) => {
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
              // CONTINUE -- extend the known-out window through today.
              // If there was a gap in the data since it was last seen,
              // this silently spans it: we never invent a status change
              // from missing data, so the SKU is just treated as still
              // out the whole time.
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

        // SKUs absent from today's snapshot are simply left alone --
        // no close, no status change. Their open instances (if any)
        // remain in openInstanceByKey untouched, to be picked up again
        // whenever they next appear in the data.
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

      console.log(`[sync-oos-history-backfill] ${brand.id} -- window=${truncatedStart}..${windowEnd} started=${started} continued=${continued} closed=${closed} stillOpen=${finalOpenRows.length} badDateRows=${badDateRows} excludedDeletedRows=${excludedDeletedRows}${dryRun ? ' (DRY RUN)' : ''}`);
      results.push({
        brand: brand.id,
        status: dryRun ? 'dry_run' : 'ok',
        truncated_start: truncatedStart,
        window_end: windowEnd,
        started, continued, closed,
        stillOpen: finalOpenRows.length,
        totalRows: outRows.length,
        badDateRows,
        excludedDeletedRows,
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
