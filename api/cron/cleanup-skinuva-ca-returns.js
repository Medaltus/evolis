/**
 * api/cron/cleanup-skinuva-ca-returns.js
 * ONE-OFF — removes rows from skinuva-ca's returns tab that actually
 * belong to skinuva (US), left over from before the ASIN-based
 * disambiguation fix in sync-returns-process.js (2026-08-19). That fix
 * only affects what a FRESH report run rebuilds — sync-returns-process.js
 * only reprocesses whatever Amazon's current report covers (a rolling
 * 30-day window by default), so older rows already sitting in the sheet
 * from before the fix are never touched or re-validated by a normal run.
 *
 * VERIFICATION METHOD: cross-references each row's ASIN against
 * skinuva's OWN known ASIN set (from its Products Cache tab,
 * sheets.products) — the same real, verified source the actual fix
 * itself uses. This is NOT based on any assumption about order-ID
 * prefixes indicating marketplace — that pattern was considered and
 * deliberately rejected as unverified and irreversible if wrong. ASIN
 * membership is a hard fact already relied on elsewhere in this project,
 * not a guess.
 *
 * A row is removed from skinuva-ca's tab ONLY if its ASIN is found in
 * skinuva's (not skinuva-ca's) known ASIN set — rows with an ASIN found
 * in neither, or in skinuva-ca's own set, are left untouched rather than
 * guessed at.
 *
 * Always run with ?dryRun=true first — reports exactly which rows would
 * be removed without touching the sheet, same convention as every other
 * cleanup tool in this project.
 *
 * Manual:
 *   GET /api/cron/cleanup-skinuva-ca-returns?dryRun=true
 *   GET /api/cron/cleanup-skinuva-ca-returns
 *   Authorization: Bearer <CRON_SECRET>
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets = require('../config/sheets');

const HEADERS = [
  'return_date', 'order_id', 'sku', 'asin', 'fnsku', 'product_name',
  'quantity', 'fulfillment_center_id', 'detailed_disposition', 'reason',
  'status', 'license_plate_number', 'customer_comments', 'brand', 'last_updated',
  'order_date', 'fulfillment_channel', 'refund_amount', 'amazon_rma_id', 'resolution',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dryRun === 'true';

  // ── Build skinuva's known ASIN set from its own Products Cache tab ──────
  let skinuvaAsins;
  try {
    const rows = await readRows(sheets.products, 'skinuva');
    const latestDate = (rows || []).reduce((max, r) => ((r.date || '') > max ? r.date : max), '');
    skinuvaAsins = new Set(
      (rows || [])
        .filter(r => r.date === latestDate)
        .map(r => (r.asin || '').trim().toUpperCase())
        .filter(Boolean)
    );
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read skinuva Products Cache', detail: err.message });
  }

  if (skinuvaAsins.size === 0) {
    return res.status(500).json({ error: 'skinuva ASIN set came back empty — refusing to run, this would look like every row matches for removal when really the verification data just failed to load' });
  }

  // ── Read skinuva-ca's existing returns rows ──────────────────────────────
  let existingRows, token;
  try {
    token = await ensureTab(sheets.returns, 'skinuva-ca', HEADERS);
    existingRows = await readRows(sheets.returns, 'skinuva-ca');
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read skinuva-ca returns tab', detail: err.message });
  }

  const toRemove = [];
  const toKeep = [];
  (existingRows || []).forEach(r => {
    const asin = (r.asin || '').trim().toUpperCase();
    if (asin && skinuvaAsins.has(asin)) {
      toRemove.push(r);
    } else {
      toKeep.push(r);
    }
  });

  const result = {
    dryRun,
    totalRowsBefore: existingRows.length,
    rowsToRemove: toRemove.length,
    rowsToKeep: toKeep.length,
    sampleRemoved: toRemove.slice(0, 10).map(r => ({ order_id: r.order_id, sku: r.sku, asin: r.asin, return_date: r.return_date })),
  };

  if (dryRun) {
    return res.status(200).json(result);
  }

  try {
    const outRows = toKeep.map(r => HEADERS.map(h => r[h] ?? ''));
    await replaceRows(sheets.returns, 'skinuva-ca', HEADERS, outRows, token, 'USER_ENTERED');
    result.status = 'ok';
    result.totalRowsAfter = outRows.length;
  } catch (err) {
    return res.status(500).json({ error: 'Failed to write cleaned rows', detail: err.message, ...result });
  }

  res.status(200).json(result);
};
