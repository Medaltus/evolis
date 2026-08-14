/**
 * api/cron/migrate-skinuva-ca.js
 * ONE-OFF cleanup tool — NOT wired into vercel.json, run manually.
 *
 * sync-orders-process.js only started splitting skinuva's Amazon.ca orders
 * into their own tab (skinuva-ca) as of 2026-08-13, and only for orders
 * inside its own rolling report window. Two kinds of leftover Canadian
 * orders are sitting in the regular skinuva tab as a result:
 *
 *   1. DUPLICATES — orders recent enough that today's live-split cron
 *      already wrote a fresh copy into skinuva-ca, but the OLD copy in
 *      skinuva was never deleted (sync-orders-process.js only ever
 *      adds/overwrites rows matching its own filter each run — it never
 *      removes a row that stops matching). These get REMOVED from
 *      skinuva. Before removing, any 'Amazon Estimated fees' / 'Amazon
 *      Sale Promotions' value already computed on the OLD row is carried
 *      forward onto the skinuva-ca row IF that field is still blank there
 *      — real API-derived work already done should never just get thrown
 *      away because the row moved tabs.
 *   2. ORPHANS — orders old enough to be outside the live cron's
 *      reporting window entirely, so they were never touched by the fix
 *      and have no copy in skinuva-ca at all. These get MOVED (removed
 *      from skinuva, appended to skinuva-ca) with all their existing data
 *      intact, fees/promos included.
 *
 * Identification uses TWO independent signals, matching sync-orders-
 * process.js's own live filter (updated 2026-08-14 — the first version
 * of this script only checked the first signal and missed a real,
 * confirmed-in-production category of rows as a result):
 *   a) SKU pattern — "-CA"/"-CA-SF"/".1-CA" suffix. CA_SKU_PATTERN matches
 *      "-CA" immediately followed by "-", ".", or end-of-string.
 *   b) marketplace column — literal "amazon.ca". Catches orders sold
 *      through Amazon.ca but fulfilled using a PLAIN, non-suffixed SKU
 *      (e.g. cross-border fulfillment sharing the same US inventory/SKU —
 *      consistent with Remote Fulfillment with FBA). Confirmed live:
 *      order 702-8529886-87, sku "SVA0001" (no CA suffix at all),
 *      marketplace explicitly "amazon.ca". Only rows written after
 *      2026-08-12 have this column populated at all — older rows must
 *      rely on signal (a) alone.
 * Every matched SKU is printed in dry-run output, split by which signal
 * caught it — visually confirm the full list looks right before running
 * for real.
 *
 * Manual:
 *   GET /api/cron/migrate-skinuva-ca?dryRun=true   — report only, no writes
 *   GET /api/cron/migrate-skinuva-ca                — actually write
 *   Authorization: Bearer <CRON_SECRET>
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');
const { sendCronFailureAlert }             = require('../_alerts');

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

const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dryRun === 'true';

  try {
    const usToken   = await ensureTab(sheets.orders, 'skinuva', HEADERS);
    const usRowsRaw = await readRows(sheets.orders, 'skinuva');
    const usRows    = (usRowsRaw || []).map(normalizeRow);

    const caToken   = await ensureTab(sheets.orders, 'skinuva-ca', HEADERS);
    const caRowsRaw = await readRows(sheets.orders, 'skinuva-ca');
    const caRows    = (caRowsRaw || []).map(normalizeRow);

    const caRowsByKey = new Map();
    caRows.forEach(r => caRowsByKey.set(`${r.order_id}||${r.sku}`, r));

    const keptUsRows       = [];
    const orphansMoved     = [];
    const matchedSkus      = new Set();
    const matchedByMarketplaceOnly = new Set(); // rows caught ONLY by marketplace field, not SKU pattern — worth a closer look
    let duplicatesRemoved  = 0;
    let feesCarriedForward = 0;

    usRows.forEach(r => {
      const sku = r.sku || '';
      // FIXED 2026-08-14 — this only ever checked the SKU suffix pattern,
      // missing a second real category: orders genuinely sold through
      // Amazon.ca but using a PLAIN, non-suffixed SKU (e.g. cross-border
      // fulfillment sharing the same US inventory/SKU — consistent with
      // Remote Fulfillment with FBA). Confirmed live in production:
      // order 702-8529886-87, sku "SVA0001" (no -CA suffix at all),
      // marketplace column explicitly "amazon.ca" — invisible to the
      // SKU-pattern check alone. sync-orders-process.js's LIVE filter
      // already checks both signals (SKU pattern first, falls back to
      // the marketplace/sales-channel field) — this one-time migration
      // script just hadn't caught up to match that same dual-signal logic.
      const isCaByPattern = CA_SKU_PATTERN.test(sku);
      const isCaByMarketplace = (r.marketplace || '').trim().toLowerCase() === 'amazon.ca';
      if (!isCaByPattern && !isCaByMarketplace) {
        keptUsRows.push(r);
        return;
      }

      matchedSkus.add(sku);
      if (isCaByMarketplace && !isCaByPattern) {
        matchedByMarketplaceOnly.add(`${sku} (order ${r.order_id})`);
      }
      const key = `${r.order_id}||${r.sku}`;
      const existingCaRow = caRowsByKey.get(key);

      if (existingCaRow) {
        // Duplicate — skinuva-ca already has this row. Carry forward any
        // already-computed fee/promo value that's still blank over there,
        // then drop the old skinuva-side copy.
        if (!existingCaRow['Amazon Estimated fees'] && r['Amazon Estimated fees']) {
          existingCaRow['Amazon Estimated fees'] = r['Amazon Estimated fees'];
          feesCarriedForward++;
        }
        if (!existingCaRow['Amazon Sale Promotions'] && r['Amazon Sale Promotions']) {
          existingCaRow['Amazon Sale Promotions'] = r['Amazon Sale Promotions'];
        }
        duplicatesRemoved++;
      } else {
        // Orphan — never touched by the live split, move it over whole.
        orphansMoved.push(r);
      }
      // Either way, do not keep this row in skinuva.
    });

    const finalCaRows = [...caRows, ...orphansMoved]; // caRows entries may have been mutated in place above

    const summary = {
      dryRun,
      skinuva: {
        totalRowsBefore:   usRows.length,
        totalRowsAfter:    keptUsRows.length,
        duplicatesRemoved,
        orphansMovedOut:   orphansMoved.length,
      },
      'skinuva-ca': {
        totalRowsBefore: caRows.length,
        totalRowsAfter:  finalCaRows.length,
        orphansMovedIn:  orphansMoved.length,
        feesCarriedForwardFromDuplicates: feesCarriedForward,
      },
      matchedSkus: [...matchedSkus].sort(),
      matchedByMarketplaceFieldOnly: [...matchedByMarketplaceOnly].sort(), // plain SKU, no CA suffix — caught via marketplace column instead
    };

    if (!dryRun) {
      const usArrays = keptUsRows.map(r => HEADERS.map(h => r[h] ?? ''));
      const caArrays = finalCaRows.map(r => HEADERS.map(h => r[h] ?? ''));
      await replaceRows(sheets.orders, 'skinuva', HEADERS, usArrays, usToken);
      await replaceRows(sheets.orders, 'skinuva-ca', HEADERS, caArrays, caToken);
    }

    res.status(200).json(summary);
  } catch (err) {
    console.error('[migrate-skinuva-ca] failed:', err.message);
    await sendCronFailureAlert('migrate-skinuva-ca', err.message);
    res.status(500).json({ error: err.message });
  }
};

function normalizeRow(r) {
  if (Array.isArray(r)) {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  }
  return r;
}
