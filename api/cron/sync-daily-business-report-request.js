/**
 * api/cron/sync-daily-business-report-request.js
 * ADDED 2026-10-21 — step 1 of 2, DAILY Sales & Traffic by child ASIN.
 * See api/cron/_daily-business-report-common.js for the sheet layout.
 *
 * Each run, for one seller account (NewDerm by default, ?account=hol for
 * High On Love), requests one single-day GET_SALES_AND_TRAFFIC_REPORT per
 * Pacific day:
 *   1. D-2, D-3, D-4 — re-pulled once per calendar day, since Amazon's
 *      numbers keep settling for a few days.
 *   2. Gap-fill — any day in the last 730 (2 years) that this account doesn't have in
 *      Daily Totals yet (first-run backfill, or a missed day), newest first.
 * Capped at 6 requests per run: createReport is one shared allowance for
 * the whole seller account (burst 15, refills ~1/min), and this account's
 * orders / revenue / returns / SQP crons draw on it too.
 *
 * The 730-day backfill takes ~122 rounds; the every-20-minutes schedule gets
 * through it in under two days. After that each run only checks for gaps.
 *
 * Manual:
 *   GET /api/cron/sync-daily-business-report-request                 normal run (NewDerm)
 *   GET /api/cron/sync-daily-business-report-request?account=hol     High On Love
 *   GET /api/cron/sync-daily-business-report-request?date=2026-10-15 one specific day
 *   GET /api/cron/sync-daily-business-report-request?force=true      re-request D-2..D-4 even if done today
 */

const { spRequest } = require('../_spauth');
const { sendCronFailureAlert } = require('../_alerts');
const { getAccount, brandsForAccount, metaTabFor, cronLabel } = require('../_account');
const C = require('./_daily-business-report-common');

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let account;
  try { account = getAccount(req); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const CRON = cronLabel('sync-daily-business-report-request', account);
  const META_TAB = metaTabFor(account);
  const accountBrands = brandsForAccount(account).filter(C.isUsBrand); // US marketplace only
  if (!accountBrands.length) return res.status(200).json({ skipped: true, account, reason: 'no active brands for this account' });

  const today = C.todayPT();
  try {
    await C.ensureTabs(accountBrands, META_TAB, C.unmatchedTabFor(account));
    const meta = await C.readMeta(META_TAB);
    const pending = C.readPending(meta);
    const pendingDates = new Set(pending.map(p => p.date));

    // ── Which dates to request ─────────────────────────────────────────
    let wanted = [];
    const one = String(req.query.date || '').trim();
    if (one) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(one) || one > C.addDays(today, -2)) {
        return res.status(400).json({ error: `date must be YYYY-MM-DD and no later than ${C.addDays(today, -2)} (data isn't complete for 48 hours)` });
      }
      wanted = [one];
    } else {
      const recentDone = meta.recent_requested_for === today && req.query.force !== 'true';
      if (!recentDone) wanted.push(...C.RECENT_OFFSETS.map(n => C.addDays(today, -n)));
      const have = new Set((await C.readTotals()).filter(r => r[1] === account).map(r => r[0]));
      const oldest = C.addDays(today, -C.BACKFILL_DAYS);
      for (let d = C.addDays(today, -(Math.max(...C.RECENT_OFFSETS) + 1)); d >= oldest; d = C.addDays(d, -1)) {
        if (!have.has(d) && !pendingDates.has(d)) wanted.push(d);
      }
    }
    const missingTotal = wanted.length;
    wanted = wanted.slice(0, C.MAX_REQUESTS_PER_RUN);

    // ── Request ────────────────────────────────────────────────────────
    const requested = [], failed = [];
    for (const date of wanted) {
      const { start, end } = C.dayRange(date);
      const resp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime: start,
        dataEndTime: end,
        reportOptions: { dateGranularity: 'DAY', asinGranularity: 'CHILD' },
      }, account);
      if (resp && resp.reportId) {
        requested.push({ date, reportId: resp.reportId, requestedAt: new Date().toISOString() });
      } else {
        const msg = JSON.stringify((resp && resp.errors) || resp).slice(0, 300);
        failed.push({ date, error: msg });
        if (/QuotaExceeded|429|TooManyRequests/i.test(msg)) break; // allowance used up — next run continues
      }
    }

    const reqDates = new Set(requested.map(r => r.date));
    const nextPending = [...pending.filter(p => !reqDates.has(p.date)), ...requested];
    meta.pending = JSON.stringify(nextPending);
    meta.last_request_at = new Date().toISOString();
    if (!one && requested.some(r => C.RECENT_OFFSETS.map(n => C.addDays(today, -n)).includes(r.date))) meta.recent_requested_for = today;
    meta.backfill_remaining = String(Math.max(0, missingTotal - requested.length));
    await C.writeMeta(META_TAB, meta);

    // Quota pushback alone isn't a failure (the next run continues); only alert on real errors.
    const realFailures = failed.filter(f => !/QuotaExceeded|429|TooManyRequests/i.test(f.error));
    if (realFailures.length && !requested.length) {
      await sendCronFailureAlert(CRON, `No reports could be requested. First error: ${realFailures[0].error}`, { Dates: realFailures.map(f => f.date).join(', ') });
    }
    console.log(`[daily-br-request] (${account}) requested ${requested.length} (${requested.map(r => r.date).join(', ')}), failed ${failed.length}, still to request ${meta.backfill_remaining}`);
    return res.status(200).json({ success: true, account, requested, failed, pending: nextPending.length, backfill_remaining: Number(meta.backfill_remaining) });
  } catch (err) {
    console.error('[daily-br-request]', err.message);
    await sendCronFailureAlert(CRON, err.message);
    return res.status(500).json({ error: err.message });
  }
};
