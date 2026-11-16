/**
 * api/cron/sync-oos-history-ledger-backfill.js
 * ONE-TIME BACKFILL (ADDED 2026-11-16 per Jaclyn) of OOS history for a brand
 * whose Products Cache has no history to replay — first used for High On
 * Love, which sync-products.js only started covering on 2026-11-16.
 * sync-oos-history-backfill.js replays the Products Cache; this one uses
 * Amazon's own daily FBA inventory ledger instead
 * (GET_LEDGER_SUMMARY_VIEW_DATA, daily, by country), pulled from the brand's
 * own seller account (High On Love → its own account).
 *
 * WHAT IT CAN AND CAN'T REBUILD
 *   - 'fba' periods: yes. A day is out of stock when the SKU's SELLABLE
 *     ending FBA balance in the US is 0. Amazon keeps up to 18 months.
 *   - 'all_inventory' periods: no. Amazon keeps no history of FBM
 *     (merchant-fulfilled) quantities, so this type starts with the live
 *     sync-oos-history.js cron and isn't backfilled.
 *   - The ledger's ending balance counts all sellable units in Amazon's
 *     warehouses, including units already reserved for orders, so a day
 *     where every unit was reserved reads as in stock here. Close to, but not
 *     exactly, the live cron's fulfillable_quantity <= 0.
 *   - Within a SKU's ledger history (first day it appears → last day of
 *     the report), a day with NO ledger row is read as 0 stock: Amazon only
 *     lists a SKU on days it holds stock or has activity. Before its first
 *     appearance the SKU isn't tracked. The count of such days is reported
 *     as daysReadAsZero.
 *   - Deleted / discontinued SKUs (master SKU list Status DELETED, or a
 *     Product Short Name starting "DISCONTINUED") are excluded, as in
 *     sync-oos-history-backfill.js.
 *
 * OUTPUT: the brand's tab in SHEET_OOS_HISTORY, same columns and values as
 * sync-oos-history.js (brand, sku, asin, type, start_date, end_date,
 * status, last_updated; type 'fba'; status 'open' with blank end_date, or
 * 'closed'). A period still out on the ledger's last day stays OPEN, so the
 * live cron continues it. Rows already in the tab are kept: all
 * 'all_inventory' rows, and any 'fba' row that starts after the ledger's
 * last day. 'fba' rows inside the ledger's window are replaced by the
 * rebuilt history (an open live-cron row for a SKU the history already
 * shows as out is folded into the earlier start date).
 *
 * TWO STEPS (Amazon builds the report in the background):
 *   1. GET /api/cron/sync-oos-history-ledger-backfill?brand=high-on-love
 *        → asks Amazon for the report; returns a reportId
 *   2. GET /api/cron/sync-oos-history-ledger-backfill?brand=high-on-love&reportId=<id>&dryRun=true
 *        → if ready: rebuilds the periods and reports counts, writes nothing
 *      then the same without &dryRun=true to write.
 *      If the report isn't ready yet, it says so: wait a few minutes, re-run.
 *   &months=N  (step 1) how far back, 1–18, default 18
 *
 * Not in vercel.json — run manually.
 */

const zlib = require('zlib');
const { spRequest } = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { accountForBrand } = require('../_account');

const HEADERS = ['brand', 'sku', 'asin', 'type', 'start_date', 'end_date', 'status', 'last_updated'];
const MASTER_GID = '164358627';
const REPORTS = '/reports/2021-06-30';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  if (!sheets.oosHistory) return res.status(500).json({ error: 'sheets.oosHistory is not configured — add SHEET_OOS_HISTORY' });

  const brand = brands.find(b => b.id === String(req.query.brand || '').trim());
  if (!brand) return res.status(400).json({ error: 'Pass &brand=<brand id>, e.g. &brand=high-on-love' });
  if (!brand.skuPrefix) return res.status(400).json({ error: `${brand.id} has no skuPrefix in brands.js` });
  const account = accountForBrand(brand);
  const marketplaceId = brand.marketplaceId || process.env.SP_MARKETPLACE_ID;

  try {
    // ── Step 1: request the report ────────────────────────────────────────
    if (!req.query.reportId) {
      const months = Math.min(18, Math.max(1, parseInt(req.query.months, 10) || 18));
      const end = new Date(Date.now() - 2 * 86400000);            // the ledger lags a day or two
      const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - months); start.setUTCDate(start.getUTCDate() + 1);
      const r = await spRequest('POST', `${REPORTS}/reports`, {}, {
        reportType: 'GET_LEDGER_SUMMARY_VIEW_DATA',
        marketplaceIds: [marketplaceId],
        dataStartTime: `${start.toISOString().slice(0, 10)}T00:00:00Z`,
        dataEndTime: `${end.toISOString().slice(0, 10)}T23:59:59Z`,
        reportOptions: { aggregateByLocation: 'COUNTRY', aggregatedByTimePeriod: 'DAILY' },
      }, account);
      return res.status(200).json({
        step: 1, brand: brand.id, account, reportId: r.reportId,
        window: `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`,
        next: `Wait a few minutes, then run again with &reportId=${r.reportId}&dryRun=true`,
      });
    }

    // ── Step 2: fetch the report when ready ─────────────────────────────────
    const reportId = String(req.query.reportId).trim();
    const rep = await spRequest('GET', `${REPORTS}/reports/${reportId}`, {}, null, account);
    if (['IN_QUEUE', 'IN_PROGRESS'].includes(rep.processingStatus)) {
      return res.status(200).json({ step: 2, ready: false, processingStatus: rep.processingStatus, next: 'Not ready yet — wait a few minutes and run this again.' });
    }
    if (rep.processingStatus !== 'DONE') return res.status(200).json({ step: 2, ready: false, processingStatus: rep.processingStatus, error: 'Amazon could not build the report; run step 1 again.' });
    const doc = await spRequest('GET', `${REPORTS}/documents/${rep.reportDocumentId}`, {}, null, account);
    const buf = Buffer.from(await (await fetch(doc.url)).arrayBuffer());
    const text = (doc.compressionAlgorithm === 'GZIP' ? zlib.gunzipSync(buf) : buf).toString('utf8');

    const dryRun = req.query.dryRun === 'true';
    const deleted = await loadDeletedSkus();
    const now = toEstIso(new Date());

    // Ending SELLABLE balance per SKU per day (US).
    const lines = text.split(/\r?\n/).filter(Boolean);
    const head = lines.shift().split('\t').map(h => h.trim().toLowerCase());
    const col = name => head.indexOf(name);
    const iDate = col('date'), iAsin = col('asin'), iSku = col('msku'), iDisp = col('disposition'),
      iEnd = col('ending warehouse balance'), iLoc = col('location');
    if ([iDate, iSku, iDisp, iEnd].some(i => i < 0)) throw new Error(`unexpected report columns: ${head.join(', ')}`);
    const prefix = brand.skuPrefix.toUpperCase();
    const bySku = new Map(); // sku -> { asin, days: Map(date -> units) }
    let excludedDeleted = 0, otherSkus = 0;
    for (const line of lines) {
      const c = line.split('\t');
      if (String(c[iDisp] || '').trim().toUpperCase() !== 'SELLABLE') continue;
      if (iLoc >= 0 && c[iLoc] && !/^US$/i.test(c[iLoc].trim()) && marketplaceId === process.env.SP_MARKETPLACE_ID) continue;
      const sku = String(c[iSku] || '').trim();
      if (!sku.toUpperCase().startsWith(prefix)) { otherSkus++; continue; }
      if (deleted.has(sku.toUpperCase())) { excludedDeleted++; continue; }
      const date = usDate(c[iDate]);
      if (!date) continue;
      if (!bySku.has(sku)) bySku.set(sku, { asin: String(c[iAsin] || '').trim(), days: new Map() });
      const s = bySku.get(sku);
      s.days.set(date, (s.days.get(date) || 0) + (parseInt(c[iEnd], 10) || 0));
    }
    const allDates = [...new Set([...bySku.values()].flatMap(s => [...s.days.keys()]))].sort();
    if (!allDates.length) return res.status(200).json({ step: 2, brand: brand.id, ready: true, message: `No ${prefix} SKUs found in the ledger report.`, otherSkus });
    const windowStart = allDates[0], windowEnd = allDates[allDates.length - 1];

    // Rebuild 'fba' periods, day by day.
    const periods = [];
    let daysReadAsZero = 0;
    for (const [sku, s] of bySku) {
      const first = [...s.days.keys()].sort()[0];
      let open = null;
      for (let d = first; d <= windowEnd; d = addDays(d, 1)) {
        if (!s.days.has(d)) daysReadAsZero++;
        const out = (s.days.get(d) || 0) <= 0;
        if (out && !open) open = { start: d, last: d };
        else if (out && open) open.last = d;
        else if (!out && open) { periods.push([brand.id, sku, s.asin, 'fba', open.start, open.last, 'closed', now]); open = null; }
      }
      if (open) periods.push([brand.id, sku, s.asin, 'fba', open.start, '', 'open', now]);
    }

    // Merge with whatever is already in the tab.
    const existing = (await readRows(sheets.oosHistory, brand.tabName).catch(() => [])) || [];
    const openInHistory = new Set(periods.filter(p => p[6] === 'open').map(p => p[1]));
    const kept = [];
    let replaced = 0;
    for (const r of existing) {
      const type = String(r.type || '').trim();
      const start = String(r.start_date || '').trim();
      const isOpen = start && !String(r.end_date || '').trim();
      if (type !== 'fba') { kept.push(HEADERS.map(h => r[h] ?? '')); continue; }
      if (start > windowEnd && !(isOpen && openInHistory.has(String(r.sku || '').trim()))) { kept.push(HEADERS.map(h => r[h] ?? '')); continue; }
      replaced++;
    }
    const outRows = [...periods, ...kept];

    if (!dryRun) {
      const token = await ensureTab(sheets.oosHistory, brand.tabName, HEADERS);
      await replaceRows(sheets.oosHistory, brand.tabName, HEADERS, outRows, token);
    }
    return res.status(200).json({
      step: 2, dryRun, brand: brand.id, account, window: `${windowStart} → ${windowEnd}`,
      skus: bySku.size, fbaPeriods: periods.length, stillOpen: periods.filter(p => p[6] === 'open').length,
      existingRowsKept: kept.length, existingFbaRowsReplaced: replaced, daysReadAsZero, excludedDeleted,
      ...(dryRun ? { next: 'Looks right? Run the same command without &dryRun=true to write.' } : { written: outRows.length }),
    });
  } catch (err) {
    console.error('[sync-oos-history-ledger-backfill]', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Deleted / discontinued SKUs, same two signals as sync-oos-history-backfill.js.
async function loadDeletedSkus() {
  const out = new Set();
  const id = process.env.SHEET_MASTER_SKU_LIST;
  if (!id) return out;
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${MASTER_GID}`);
  if (!r.ok) throw new Error(`master SKU list CSV → ${r.status}`);
  const rows = parseCsv(await r.text());
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const iSku = head.indexOf('sku') >= 0 ? head.indexOf('sku') : 1;
  const iName = head.indexOf('product short name') >= 0 ? head.indexOf('product short name') : 2;
  const iStatus = head.indexOf('status') >= 0 ? head.indexOf('status') : 7;
  for (const row of rows.slice(1)) {
    const sku = String(row[iSku] || '').trim().toUpperCase();
    if (!sku) continue;
    if (String(row[iStatus] || '').trim().toUpperCase() === 'DELETED' || /^DISCONTINUED\b/i.test(String(row[iName] || '').trim())) out.add(sku);
  }
  return out;
}
function parseCsv(text) {
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

// Ledger dates are MM/DD/YYYY (sometimes ISO).
function usDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function toEstIso(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}.000Z`;
}
