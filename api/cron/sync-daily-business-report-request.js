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
 * Capped per run (MAX_REQUESTS_PER_RUN), and in practice Amazon's own limit
 * for THIS report type is tighter (~3 in a burst, then a slow refill — seen
 * live 2026-10-27), so each run takes what Amazon allows and stops at the
 * first QuotaExceeded; the next run (every 5 minutes) continues. It's a
 * separate allowance from the account's other report types.
 *
 * Backfill pace is set by Amazon's limit for this report type. After the
 * backfill each run only checks for gaps (and writes nothing when there are none).
 *
 * Manual:
 *   GET /api/cron/sync-daily-business-report-request                 normal run (NewDerm)
 *   GET /api/cron/sync-daily-business-report-request?account=hol     High On Love
 *   GET /api/cron/sync-daily-business-report-request?date=2026-10-15 one specific day
 *   GET /api/cron/sync-daily-business-report-request?force=true      re-request D-2..D-4 even if done today
 *   GET /api/cron/sync-daily-business-report-request?market=ca       NewDerm's Amazon.ca brands (skinuva-ca) — ADDED 2026-11-16
 *   GET /api/cron/sync-daily-business-report-request?redo=2026-07-20:2026-11-12
 *        queue a date range to be pulled again (ADDED 2026-11-16). Each run works
 *        through the queue at Amazon's pace, after D-2..D-4; every re-pulled day
 *        is rewritten by the process cron — cleaned of Vine and cancelled orders
 *        where the orders data reaches. Combine with &account= / &market=.
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
  let market;
  try { market = C.getMarket(req); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const scope = C.scopeKey(account, market);
  const CRON = cronLabel('sync-daily-business-report-request', account) + (market === 'us' ? '' : ` [${market}]`);
  const META_TAB = C.metaTabForScope(metaTabFor(account), market);
  const accountBrands = C.MARKETS[market].brands(brandsForAccount(account));
  if (!accountBrands.length) return res.status(200).json({ skipped: true, account, market, reason: 'no active brands for this account in this marketplace' });

  const today = C.todayPT();
  try {
    await C.ensureTabs(accountBrands, META_TAB, C.unmatchedTabForScope(account, market));
    const meta = await C.readMeta(META_TAB);
    const pending = C.readPending(meta);
    const pendingDates = new Set(pending.map(p => p.date));

    // ── Re-pull queue (ADDED 2026-11-16) ───────────────────────────────
    let redo = []; try { redo = JSON.parse(meta.redo_queue || '[]'); } catch { redo = []; }
    const redoArg = String(req.query.redo || '').trim();
    if (redoArg) {
      const [from, to] = redoArg.split(':').map(x => x.trim());
      const last = C.addDays(today, -2);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        return res.status(400).json({ error: 'redo must be FROM:TO, both YYYY-MM-DD, FROM before TO' });
      }
      for (let d = to > last ? last : to; d >= from; d = C.addDays(d, -1)) redo.push(d);
      redo = [...new Set(redo)].sort().reverse();
    }

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
      wanted.push(...redo.filter(d => !pendingDates.has(d))); // re-pull queue, newest first (ADDED 2026-11-16)
      const have = new Set((await C.readTotals()).filter(r => r[1] === scope).map(r => r[0]));
      const oldest = C.addDays(today, -C.BACKFILL_DAYS);
      // CHANGED 2026-10-27 — the gap-fill now starts at D-2 instead of D-5, so
      // a recent day that couldn't be requested (Amazon's limit hit partway
      // through the D-2..D-4 batch) is retried on the next run instead of
      // waiting until it ages into the gap-fill window. Real case: NewDerm's
      // 2026-10-23 was skipped on 2026-10-27.
      for (let d = C.addDays(today, -Math.min(...C.RECENT_OFFSETS)); d >= oldest; d = C.addDays(d, -1)) {
        if (!have.has(d) && !pendingDates.has(d)) wanted.push(d);
      }
      wanted = [...new Set(wanted)]; // a recent day can now appear in both lists
    }
    const missingTotal = wanted.length;
    wanted = wanted.slice(0, C.MAX_REQUESTS_PER_RUN);

    // ── Request ────────────────────────────────────────────────────────
    const requested = [], failed = [];
    for (const date of wanted) {
      const { start, end } = C.dayRange(date);
      const resp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [C.MARKETS[market].marketplaceId()],
        dataStartTime: start,
        dataEndTime: end,
        reportOptions: { dateGranularity: 'DAY', asinGranularity: 'CHILD' },
      }, account);
      if (resp && resp.reportId) {
        requested.push({ date, reportId: resp.reportId, requestedAt: new Date().toISOString(), window: `${start} → ${end}` }); // window: exactly what Amazon was asked for (ADDED 2026-10-21)
      } else {
        const msg = JSON.stringify((resp && resp.errors) || resp).slice(0, 300);
        failed.push({ date, error: msg });
        if (/QuotaExceeded|429|TooManyRequests/i.test(msg)) break; // allowance used up — next run continues
      }
    }

    const reqDates = new Set(requested.map(r => r.date));
    const redoLeft = redo.filter(d => !reqDates.has(d));
    const nextPending = [...pending.filter(p => !reqDates.has(p.date)), ...requested];
    const remaining = String(Math.max(0, missingTotal - requested.length));
    // ADDED 2026-10-27 — runs every 5 minutes now; when nothing was requested
    // and nothing changed, skip the _meta write (saves Sheets write quota).
    if (requested.length || meta.backfill_remaining !== remaining || redoArg) {
      meta.redo_queue = JSON.stringify(redoLeft);
      meta.pending = JSON.stringify(nextPending);
      meta.last_request_at = new Date().toISOString();
      if (!one && requested.some(r => C.RECENT_OFFSETS.map(n => C.addDays(today, -n)).includes(r.date))) meta.recent_requested_for = today;
      meta.backfill_remaining = remaining;
      await C.writeMeta(META_TAB, meta);
    }

    // Quota pushback alone isn't a failure (the next run continues); only alert on real errors.
    const realFailures = failed.filter(f => !/QuotaExceeded|429|TooManyRequests/i.test(f.error));
    if (realFailures.length && !requested.length) {
      await sendCronFailureAlert(CRON, `No reports could be requested. First error: ${realFailures[0].error}`, { Dates: realFailures.map(f => f.date).join(', ') });
    }
    console.log(`[daily-br-request] (${scope}) requested ${requested.length} (${requested.map(r => r.date).join(', ')}), failed ${failed.length}, still to request ${meta.backfill_remaining}`);
    return res.status(200).json({ success: true, account, market, requested, failed, pending: nextPending.length, backfill_remaining: Number(remaining), redo_remaining: redoLeft.length });
  } catch (err) {
    console.error('[daily-br-request]', err.message);
    await sendCronFailureAlert(CRON, err.message);
    return res.status(500).json({ error: err.message });
  }
};
