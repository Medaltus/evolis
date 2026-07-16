/**
 * api/cron/sync-sqp-request.js
 * Step 1 of 2 — requests the Brand Analytics SEARCH QUERY PERFORMANCE
 * report from SP-API for last full month, and stores the reportId in the
 * _meta tab of sheets.searchQueryPerformance.
 *
 * Mirrors sync-business-report-request.js's _meta pattern (KEY/VALUE/
 * UPDATED_AT, report_id_<month>, report_status, last_requested_at), with
 * one real difference: Business Report requests both prior+current month
 * EVERY day unconditionally. This one only ever targets ONE month (last
 * full month) and explicitly SKIPS re-requesting if that month's reportId
 * already exists — because unlike daily business reports, this only needs
 * to succeed once per month, and it runs on a schedule that retries daily
 * across days 8-20 (see vercel.json) specifically because Brand Analytics
 * data for the prior month isn't finalized until partway through the
 * current month. Re-requesting every day it's already succeeded would
 * just waste SP-API quota for no reason.
 *
 * NOTE: sheets.searchQueryPerformance needs to be ADDED to config/sheets.js
 * — I don't have that file's contents, so I can't add it myself. Point it
 * at the SHEET_SEARCH_QUERY_PERFORMANCE sheet ID
 * (1naEu4kADM0PBjM-lntqUU8IbI7s5ENhRmc72Q7_pVrc), same pattern as the
 * existing sheets.businessReport entry.
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');

const META_TAB     = '_meta';
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = now.toISOString();

  // ── Last FULL calendar month ────────────────────────────────────────────
  const prior    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pYear    = prior.getFullYear();
  const pMonth   = pad(prior.getMonth() + 1);
  const pLastDay = new Date(pYear, prior.getMonth() + 1, 0).getDate();
  const targetMonth = `${pYear}-${pMonth}`;
  const dataStartTime = `${pYear}-${pMonth}-01T00:00:00Z`;
  const dataEndTime   = `${pYear}-${pMonth}-${pad(pLastDay)}T23:59:59Z`;

  console.log(`[sync-sqp-request] target month: ${targetMonth} (${dataStartTime} → ${dataEndTime})`);

  // ── Skip if already requested this month ────────────────────────────────
  let metaMap = {};
  try {
    const rawMeta = await readRows(sheets.searchQueryPerformance, META_TAB);
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }
  } catch (err) {
    console.warn('[sync-sqp-request] could not read _meta (probably first-ever run, tab does not exist yet):', err.message);
  }

  if (metaMap[`report_id_${targetMonth}`] && !req.query.force) {
    console.log(`[sync-sqp-request] ${targetMonth} already requested (reportId ${metaMap[`report_id_${targetMonth}`]}, status ${metaMap['report_status'] || 'unknown'}) — skipping. Pass ?force=true to request a fresh one anyway (e.g. after a FATAL report).`);
    return res.status(200).json({ ok: true, skipped: true, targetMonth, reportId: metaMap[`report_id_${targetMonth}`] });
  }

  // ── Request the report ──────────────────────────────────────────────────
  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime,
      dataEndTime,
      reportOptions: { reportPeriod: 'MONTH' },
    });

    if (!createResp || !createResp.reportId) {
      // Most likely: Amazon saying last month's Brand Analytics data isn't
      // finalized yet — expected during roughly the first 10-15 days of the
      // month. Not a hard failure; don't write to _meta so tomorrow's run
      // retries fresh. Return 200, not 500, since nothing actually went wrong.
      console.warn(`[sync-sqp-request] ${targetMonth} — no reportId in response (likely not ready yet):`, JSON.stringify(createResp));
      return res.status(200).json({ ok: true, notReadyYet: true, targetMonth, detail: createResp });
    }
    reportId = createResp.reportId;
    console.log(`[sync-sqp-request] ${targetMonth} report requested: ${reportId}`);
  } catch (err) {
    console.error(`[sync-sqp-request] failed to request report for ${targetMonth}:`, err.message);
    return res.status(500).json({ error: `Failed to request report for ${targetMonth}`, detail: err.message });
  }

  // ── Write metadata ───────────────────────────────────────────────────────
  try {
    const token = await ensureTab(sheets.searchQueryPerformance, META_TAB, META_HEADERS);
    metaMap[`report_id_${targetMonth}`] = reportId;
    metaMap['report_status']     = 'REQUESTED';
    metaMap['target_month']      = targetMonth;
    metaMap['last_requested_at'] = ts;

    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.searchQueryPerformance, META_TAB, META_HEADERS, metaRows, token);
    console.log(`[sync-sqp-request] meta written for ${targetMonth}`);
  } catch (err) {
    console.error('[sync-sqp-request] failed to write meta:', err.message);
    // Report was successfully requested with Amazon at this point — don't
    // waste it, but make the sheet-write failure visible rather than
    // returning a plain 200 that looks fully successful.
    return res.status(207).json({
      warning: 'Report requested successfully, but failed to write _meta — check sheets.searchQueryPerformance / config/sheets.js',
      metaWriteError: err.message,
      targetMonth,
      reportId,
    });
  }

  res.status(200).json({ ok: true, targetMonth, reportId });
};
