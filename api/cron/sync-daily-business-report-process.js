/**
 * api/cron/sync-daily-business-report-process.js
 * ADDED 2026-10-21 — step 2 of 2, DAILY Sales & Traffic by child ASIN.
 * See api/cron/_daily-business-report-common.js for the sheet layout.
 *
 * For each pending report in this account's _meta (from the request cron):
 *   DONE                → download, total per child ASIN, write the day
 *   IN_QUEUE/PROGRESS   → left for the next run (dropped after 12 hours;
 *                         the request cron re-requests any day still missing)
 *   CANCELLED           → Amazon had no data for that day; recorded as a
 *                         "(no data)" day so it isn't re-requested forever
 *   FATAL               → dropped and alerted; the gap-fill re-requests it
 *
 * Writes without rewriting the big tabs: reads column A of each of this
 * account's brand tabs, deletes the rows for the days being rewritten plus
 * anything older than 369 days, then appends the fresh rows. Daily Totals
 * is small and is rewritten — only this account's rows for the rewritten
 * days are replaced; the other account's rows are never touched.
 *
 * Manual:
 *   GET /api/cron/sync-daily-business-report-process              NewDerm
 *   GET /api/cron/sync-daily-business-report-process?account=hol  High On Love
 */

const zlib = require('zlib');
const { spRequest } = require('../_spauth');
const { sendCronFailureAlert } = require('../_alerts');
const { getAccount, brandsForAccount, metaTabFor, cronLabel } = require('../_account');
const C = require('./_daily-business-report-common');

const STALE_PENDING_MS = 12 * 3600 * 1000;

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let account;
  try { account = getAccount(req); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const CRON = cronLabel('sync-daily-business-report-process', account);
  const META_TAB = metaTabFor(account);
  const UNMATCHED = C.unmatchedTabFor(account);
  const accountBrands = brandsForAccount(account).filter(C.isUsBrand);
  if (!accountBrands.length) return res.status(200).json({ skipped: true, account, reason: 'no active brands for this account' });

  const today = C.todayPT();
  const ts = new Date().toISOString();
  try {
    const tabs = await C.ensureTabs(accountBrands, META_TAB, UNMATCHED);
    const meta = await C.readMeta(META_TAB);
    const pending = C.readPending(meta);
    if (!pending.length) return res.status(200).json({ success: true, account, message: 'Nothing pending.' });

    // ── Check each pending report once ─────────────────────────────────
    const days = new Map();   // date -> [asin rows] (empty array = no-data day)
    const notAvailable = new Set(); // days Amazon failed FATAL_LIMIT times
    let fatalCounts = {}; try { fatalCounts = JSON.parse(meta.fatal_counts || '{}'); } catch { fatalCounts = {}; }
    const keep = [], problems = [];
    for (const p of pending) {
      let status;
      try { status = await spRequest('GET', `/reports/2021-06-30/reports/${p.reportId}`, {}, null, account); }
      catch (e) { keep.push(p); problems.push(`${p.date}: status check failed — ${e.message}`); continue; }
      const st = status && status.processingStatus;
      if (st === 'DONE') {
        try { days.set(p.date, await downloadAsinRows(status.reportDocumentId, p.date, account, problems)); }
        catch (e) { keep.push(p); problems.push(`${p.date}: download failed — ${e.message}`); }
      } else if (st === 'CANCELLED') {
        days.set(p.date, []);
      } else if (st === 'FATAL') {
        // ADDED 2026-10-21 — a day Amazon keeps failing (most likely older than
        // it keeps daily data) is recorded as "(not available)" after
        // FATAL_LIMIT tries, instead of being re-requested and alerted forever.
        fatalCounts[p.date] = (fatalCounts[p.date] || 0) + 1;
        if (fatalCounts[p.date] >= C.FATAL_LIMIT) {
          days.set(p.date, []); notAvailable.add(p.date); delete fatalCounts[p.date];
          console.log(`[daily-br-process] ${p.date}: FATAL ${C.FATAL_LIMIT}x — recorded as not available`);
        } else {
          problems.push(`${p.date}: Amazon report FATAL (${p.reportId}) — will be re-requested once more`);
        }
      } else if (Date.now() - new Date(p.requestedAt).getTime() > STALE_PENDING_MS) {
        problems.push(`${p.date}: still ${st || 'unknown'} after 12h — dropped, will be re-requested`);
      } else {
        keep.push(p);
      }
    }

    let written = { asinRows: 0, days: 0, rowsRemoved: 0, byTab: {} };
    if (days.size) {
      const asinMap = await C.loadAsinMap(accountBrands);
      const freshByTab = new Map();   // tab -> rows
      const totals = new Map();       // `${date}|${brandTab}` -> acc
      for (const [date, rows] of days) {
        const perAsin = new Map();
        for (const r of rows) {
          const asin = (r.childAsin || r.parentAsin || '').toUpperCase(); if (!asin) continue;
          if (!perAsin.has(asin)) perAsin.set(asin, { parent: (r.parentAsin || '').toUpperCase(), s: 0, pv: 0, u: 0, rev: 0, bb: null });
          const a = perAsin.get(asin), t = r.trafficByAsin || {}, sa = r.salesByAsin || {};
          a.s   += (parseInt(t.sessions ?? 0, 10) || 0) + (parseInt(t.sessionsB2B ?? 0, 10) || 0);
          // Same definitions as the monthly business report: only sessions add B2B.
          a.pv  += parseInt(t.pageViews ?? 0, 10) || 0;
          a.u   += parseInt(sa.unitsOrdered ?? 0, 10) || 0;
          a.rev += parseFloat(sa.orderedProductSales?.amount ?? 0) || 0;
          if (t.buyBoxPercentage != null) a.bb = parseFloat(t.buyBoxPercentage);
        }
        for (const [asin, a] of perAsin) {
          const m = asinMap.get(asin);
          const tab = m ? m.brandTab : UNMATCHED;
          if (!freshByTab.has(tab)) freshByTab.set(tab, []);
          freshByTab.get(tab).push([date, asin, a.parent, m ? m.sku : '', a.s, a.pv, a.u, C.round2(a.rev), a.s ? C.round2(a.u / a.s * 100) : 0, a.bb == null ? '' : C.round2(a.bb)]);
          const k = `${date}|${tab}`;
          const tt = totals.get(k) || { asins: 0, s: 0, pv: 0, u: 0, rev: 0 };
          tt.asins++; tt.s += a.s; tt.pv += a.pv; tt.u += a.u; tt.rev += a.rev; totals.set(k, tt);
        }
        // A no-data day still gets a totals row, so the gap-fill knows it's done.
        if (!perAsin.size) totals.set(`${date}|${notAvailable.has(date) ? C.NOT_AVAILABLE_BRAND : C.NO_DATA_BRAND}`, { asins: 0, s: 0, pv: 0, u: 0, rev: 0 });
      }
      for (const rows of freshByTab.values()) rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

      const cutoff = C.addDays(today, -C.RETENTION_DAYS);
      const accountTabs = [...accountBrands.map(b => b.tabName), UNMATCHED];
      const plan = await planBrandTabs(tabs, accountTabs, freshByTab, new Set(days.keys()), cutoff);
      written = { ...written, asinRows: plan.asinRows, rowsRemoved: plan.rowsRemoved, byTab: plan.byTab, days: days.size };

      // ── Daily Totals: replace only THIS account's rows for these days ──
      const finalCut = C.addDays(today, -C.FINAL_AFTER);
      const oldTotals = (await C.readTotals()).filter(r => r[0] >= cutoff && !(r[1] === account && days.has(r[0])));
      const newTotals = [...totals.entries()].map(([k, t]) => {
        const [date, brand] = k.split('|');
        return [date, account, brand, t.asins, t.s, t.pv, t.u, C.round2(t.rev), t.s ? C.round2(t.u / t.s * 100) : 0, date <= finalCut ? 'Y' : 'N', ts];
      });
      const allTotals = [...oldTotals, ...newTotals].sort((a, b) => a[0].localeCompare(b[0]) || String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2])));

      // ── All writes for this run: 1 structural + 1 values + 1 clear ───────
      const totalsTab = tabs.find(t => t.title === C.TOTALS_TAB);
      const totalsGrid = totalsTab?.gridProperties?.rowCount || 1000;
      if (totalsTab && totalsGrid < allTotals.length + 1) {
        plan.structural.push({ appendDimension: { sheetId: totalsTab.sheetId, dimension: 'ROWS', length: allTotals.length + 1 - totalsGrid + 500 } });
      }
      for (let i = 0; i < plan.structural.length; i += 200) await C.gs('POST', ':batchUpdate', { requests: plan.structural.slice(i, i + 200) });
      if (allTotals.length) plan.data.push({ range: `${C.q(C.TOTALS_TAB)}!A2`, values: allTotals });
      if (plan.data.length) await C.gs('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: plan.data });
      // Totals only shrink when days pass the 2-year cutoff; clear anything left below.
      await C.gs('POST', `/values/${C.rng(`${C.q(C.TOTALS_TAB)}!A${allTotals.length + 2}:K`)}:clear`, {});

      // ── Space check (whole spreadsheet) ─────────────────────────────────
      const cells = (await C.getTabs()).reduce((n, t) => n + (t.gridProperties?.rowCount || 0) * (t.gridProperties?.columnCount || 0), 0);
      written.sheetCells = cells;
      if (cells > C.CELL_ALERT) problems.push(`Daily Business Report sheet is at ${cells.toLocaleString()} cells (Google's limit is 10,000,000) — shorten RETENTION_DAYS or move older history to a second sheet`);
    }

    meta.pending = JSON.stringify(keep);
    meta.fatal_counts = JSON.stringify(fatalCounts);
    meta.last_process_at = ts;
    meta.last_written_days = [...days.keys()].sort().join(',');
    await C.writeMeta(META_TAB, meta);

    if (problems.length) {
      await sendCronFailureAlert(CRON, problems.join(' | ').slice(0, 1500), { 'Still pending': String(keep.length) });
    }
    console.log(`[daily-br-process] (${account}) wrote ${written.days} day(s), ${written.asinRows} ASIN rows, removed ${written.rowsRemoved}; still pending ${keep.length}`);
    return res.status(200).json({ success: true, account, days_written: [...days.keys()].sort(), ...(notAvailable.size ? { not_available: [...notAvailable].sort() } : {}), ...written, still_pending: keep.length, problems });
  } catch (err) {
    console.error('[daily-br-process]', err.message);
    await sendCronFailureAlert(CRON, err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function downloadAsinRows(documentId, date, account, problems) {
  const doc = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`, {}, null, account);
  if (!doc || !doc.url) throw new Error(`no document URL (${JSON.stringify(doc).slice(0, 200)})`);
  const fileRes = await fetch(doc.url);
  if (!fileRes.ok) throw new Error(`document download ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const raw = await new Promise(r => zlib.gunzip(buf, (e, out) => r(e ? buf.toString('utf8') : out.toString('utf8'))));
  const parsed = JSON.parse(raw);
  // Amazon must have treated the range as exactly the one Pacific day requested.
  const byDate = (parsed.salesAndTrafficByDate || []).map(x => x.date).filter(Boolean);
  if (byDate.length && (byDate.length > 1 || byDate[0] !== date)) {
    problems.push(`${date}: Amazon's report covers ${byDate.join(', ')} instead of just ${date} — per-ASIN numbers for this day may include a neighboring day`);
  }
  return parsed.salesAndTrafficByAsin || [];
}

// For every tab this account owns: delete the rows for the days being
// rewritten and anything older than the cutoff, then write the fresh rows.
// CHANGED 2026-10-27 — real incident: sync-orders-process hit Google's
// "write requests per minute" limit, which every cron in this project
// shares. This used to make one write per brand tab (plus several more for
// totals), ~20 per run. Now: ONE structural call (all row deletions + grid
// growth, every tab) and the rows for every tab go into the caller's single
// values:batchUpdate together with Daily Totals.
async function planBrandTabs(tabs, accountTabs, freshByTab, rewriteDates, cutoff) {
  const byTitle = new Map(tabs.map(t => [t.title, t]));
  const present = accountTabs.filter(t => byTitle.has(t));

  // Column A of every tab in one read.
  const colA = await C.gs('GET', `/values:batchGet?majorDimension=COLUMNS&${present.map(t => `ranges=${C.rng(`${C.q(t)}!A2:A`)}`).join('&')}`);
  const structural = [], data = [];
  let rowsRemoved = 0, asinRows = 0;
  const byTab = {};
  (colA.valueRanges || []).forEach((vr, i) => {
    const title = present[i], tab = byTitle.get(title), sheetId = tab.sheetId;
    const dates = ((vr.values || [])[0] || []).map(C.normDate);
    const del = [];
    dates.forEach((d, j) => { if (!d || d < cutoff || rewriteDates.has(d)) del.push(j + 1); }); // +1: header is row index 0
    const ranges = [];
    for (const idx of del) { const last = ranges[ranges.length - 1]; if (last && last[1] === idx) last[1] = idx + 1; else ranges.push([idx, idx + 1]); }
    ranges.reverse().forEach(([s, e]) => structural.push({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: s, endIndex: e } } }));
    rowsRemoved += del.length;

    const fresh = freshByTab.get(title) || [];
    if (!fresh.length) return;
    const remaining = dates.length - del.length;           // data rows left after deletions
    const gridAfterDeletes = (tab.gridProperties?.rowCount || 1000) - del.length;
    const needed = 1 + remaining + fresh.length;           // header + data
    if (gridAfterDeletes < needed) {
      structural.push({ appendDimension: { sheetId, dimension: 'ROWS', length: needed - gridAfterDeletes + 500 } });
    }
    data.push({ range: `${C.q(title)}!A${remaining + 2}`, values: fresh });
    byTab[title] = fresh.length; asinRows += fresh.length;
  });
  return { structural, data, rowsRemoved, asinRows, byTab };
}

async function ensureRows(tabs, title, minRows) {
  const tab = tabs.find(t => t.title === title);
  const cur = (tab && tab.gridProperties && tab.gridProperties.rowCount) || 0;
  if (!tab || cur >= minRows) return;
  await C.gs('POST', ':batchUpdate', { requests: [{ updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { rowCount: minRows + 500 } }, fields: 'gridProperties.rowCount' } }] });
}
