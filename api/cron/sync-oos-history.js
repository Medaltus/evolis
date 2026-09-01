/**
 * api/cron/sync-oos-history.js
 * Runs once daily, after sync-products.js's window would reasonably be
 * complete for the day. Tracks out-of-stock PERIODS (start date + end
 * date, per SKU, per brand) rather than just point-in-time snapshots --
 * a running history of every time a product fell out of stock and when
 * it came back.
 *
 * ADDED 2026-09-01 per Jaclyn -- same reasoning as sync-listing-change-
 * log.js (see that file's header): trim-products-log.js's retention was
 * cut from 2 years to 13 months for real cell-budget reasons, and this
 * cron exists to preserve out-of-stock history separately and
 * indefinitely, so a shorter SHEET_PRODUCTS retention doesn't mean
 * losing the ability to see when a product was out of stock and for how
 * long.
 *
 * UPDATED 2026-09-01 per Jaclyn: this cron no longer infers anything
 * from a SKU's absence from today's snapshot. It used to close an open
 * instance as 'closed_discontinued' when a SKU didn't appear in today's
 * rows at all -- but that can't distinguish an actual deletion from
 * sync-products.js simply failing or skipping a row that day, and a
 * cron failure should never be read as evidence a product was
 * discontinued. A SKU absent from today's snapshot is now just skipped
 * entirely for this run: any open instance it has is carried forward
 * completely unchanged (re-written into the sheet as-is, not touched or
 * closed), and picked back up normally whenever it next appears. There
 * is no 'closed_discontinued' status produced by this file anymore.
 * (sync-products.js already excludes deleted/discontinued SKUs at the
 * source, so this cron doesn't need its own deleted-SKU check.)
 *
 * Two SEPARATE tracked definitions per SKU, since a product can be sold
 * out of FBA specifically while still fulfillable another way:
 *   'fba'          -- fulfillable_quantity <= 0
 *   'all_inventory' -- fulfillable_quantity <= 0 AND seller_fulfilled_quantity <= 0
 * NOTE: these are the most direct, well-understood columns on
 * SHEET_PRODUCTS for this -- deliberately NOT using total_quantity or
 * qty_on_hand, since their exact composition wasn't independently
 * confirmed here. Worth checking these definitions against the
 * dashboard's own existing "[OOS]" logic (referenced in its own console
 * logs) before trusting this as the single source of truth -- if that
 * logic uses a different combination of columns, this should be updated
 * to match it exactly rather than risk two different OOS definitions
 * existing side by side.
 *
 * State machine per (sku, type), each run:
 *   - out of stock today, no open instance   -> START (new row, end_date blank)
 *   - out of stock today, instance already open -> CONTINUE (no write needed)
 *   - back in stock today, instance open      -> CLOSE (end_date = yesterday)
 *   - back in stock today, no open instance   -> nothing to do
 *   - SKU absent from today's snapshot entirely -> nothing to do; any
 *     open instance is carried forward unchanged, not closed
 *
 * "Open" instance = a row with a start_date and a blank end_date. Rather
 * than rewrite the whole tab every run, only the specific rows that need
 * to start or close get touched -- everything else (past closed
 * instances, plus any open instance untouched this run) is read once
 * and written back alongside whatever's new/closed this run.
 *
 * Sheet: SHEET_OOS_HISTORY (must be added to config/sheets.js and set as
 * an env var before deploying). One tab per brand, auto-created on first
 * run, matching this repo's usual convention.
 * Columns: brand, sku, asin, type, start_date, end_date, status, last_updated
 *
 * Manual:
 *   GET /api/cron/sync-oos-history
 *   Authorization: Bearer <CRON_SECRET>
 *   &brand=creme-shop   -- restrict to one brand
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands                               = require('../config/brands');
const sheets                               = require('../config/sheets');
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
  const activeBrands = brands.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));

  const today = toEstIso(new Date()).slice(0, 10);
  const yesterday = toEstIso(new Date(Date.now() - 24 * 60 * 60 * 1000)).slice(0, 10);
  const now = toEstIso(new Date());

  const results = [];

  for (const brand of activeBrands) {
    try {
      const productRows = await readRows(sheets.products, brand.tabName);
      const todayRowsBySku = new Map();
      (productRows || []).forEach(r => {
        if ((r.date || '').trim() !== today) return;
        const sku = (r.sku || '').trim();
        if (sku) todayRowsBySku.set(sku, r);
      });

      if (todayRowsBySku.size === 0) {
        results.push({ brand: brand.id, status: 'skipped', reason: `no rows found for today (${today}) -- sync-products.js may not have run yet` });
        continue;
      }

      const token = await ensureTab(sheets.oosHistory, brand.tabName, HEADERS);
      const existingRows = await readRows(sheets.oosHistory, brand.tabName);

      // Open instance = has a start_date, blank end_date. Keyed by
      // sku||type so 'fba' and 'all_inventory' are tracked independently.
      const openInstanceByKey = new Map();
      const closedRows = []; // untouched rows carried forward as-is
      (existingRows || []).forEach(r => {
        const sku = (r.sku || '').trim();
        const type = (r.type || '').trim();
        if (!sku || !type) return;
        const isOpen = (r.start_date || '').trim() && !(r.end_date || '').trim();
        if (isOpen) {
          openInstanceByKey.set(`${sku}||${type}`, r);
        } else {
          closedRows.push(r);
        }
      });

      let started = 0, continued = 0, closed = 0;
      const finalOpenRows = [];

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
            // START -- new open instance
            finalOpenRows.push([brand.id, sku, row.asin || '', type, today, '', 'open', now]);
            started++;
            openInstanceByKey.delete(key); // consumed
          } else if (isOutToday && openRow) {
            // CONTINUE -- carry the existing open row forward unchanged
            finalOpenRows.push([brand.id, sku, openRow.asin || row.asin || '', type, openRow.start_date, '', 'open', openRow.last_updated || now]);
            continued++;
            openInstanceByKey.delete(key);
          } else if (!isOutToday && openRow) {
            // CLOSE -- back in stock today, so the last confirmed
            // out-of-stock day was yesterday
            closedRows.push([brand.id, sku, openRow.asin || row.asin || '', type, openRow.start_date, yesterday, 'closed', now]);
            closed++;
            openInstanceByKey.delete(key);
          }
          // else: in stock today, no open instance -- nothing to do
        });
      });

      // Anything still left in openInstanceByKey is a SKU that had an
      // open instance but didn't appear in today's snapshot at all.
      // That is NOT evidence of discontinuation -- it could just as
      // easily be a sync gap or a partial cron failure -- so nothing is
      // inferred. Carry it forward completely unchanged.
      openInstanceByKey.forEach((openRow, key) => {
        const [sku, type] = key.split('||');
        finalOpenRows.push([brand.id, sku, openRow.asin || '', type, openRow.start_date, '', 'open', openRow.last_updated || now]);
      });

      const outRows = [
        ...closedRows.map(r => Array.isArray(r) ? r : HEADERS.map(h => r[h] ?? '')),
        ...finalOpenRows,
      ];

      await replaceRows(sheets.oosHistory, brand.tabName, HEADERS, outRows, token);

      console.log(`[sync-oos-history] ${brand.id} -- started=${started} continued=${continued} closed=${closed}`);
      results.push({ brand: brand.id, status: 'ok', started, continued, closed, totalRows: outRows.length });
    } catch (err) {
      console.error(`[sync-oos-history] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  const failedBrands = results.filter(r => r.status === 'error');
  if (failedBrands.length > 0) {
    await sendCronFailureAlert(
      'sync-oos-history',
      failedBrands.map(r => `${r.brand}: ${r.error}`).join('\n'),
      { 'Brands failed': String(failedBrands.length) }
    );
  }

  res.status(200).json({ today, yesterday, results });
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
