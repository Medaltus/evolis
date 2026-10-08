/**
 * api/cron/sync-event-orders-request.js
 * Step 1 of 2 — for each of 4 fixed target tabs (Big Spring Sale, Prime Day,
 * Prime Big Deal Days, Black Friday and Cyber Monday), looks up that
 * event's date range from the Events tab (SHEET_MASTER_SKU_LIST, "Events"
 * tab) and requests ONE flat-file order report per matched event, covering
 * ALL brands combined (unlike sync-orders-request.js, this does not split
 * by brand at request time OR write time — these tabs are event-scoped,
 * not brand-scoped, per the point of this cron).
 *
 * Matching is by keyword substring, not exact string — the Events tab's
 * actual naming convention is like "March Big Spring Sale 2026" and "June
 * Prime Day 2026" (month-prefixed, year-suffixed), not the bare event
 * names used as this cron's tab names. If the Events tab has more than one
 * row matching a keyword (e.g. multiple years), the row with the most
 * recent end_date is used.
 *
 * A target tab is SKIPPED (not an error — logged and left alone) if:
 *   - no row in the Events tab matches its keyword, or
 *   - the matched row has a blank start_date or end_date
 * As of 2026-07-16, only "June Prime Day 2026" has both a match and real
 * dates — the other 3 tabs will skip until their Events rows are filled in.
 *
 * Stores reportIds in the ORDERS sheet's `_meta_events` tab (a separate
 * meta tab from sync-orders-request.js's `_meta`, so the two crons never
 * collide). sync-event-orders-process.js picks up ~15 min later.
 *
 * Runs on-demand / manually for now — these are fixed historical windows,
 * not a rolling sync, so there's no obvious daily schedule need. Add to
 * vercel.json only if you want it re-validated periodically (e.g. in case
 * an event's dates get corrected after the fact).
 *
 * Manual:
 *   GET /api/cron/sync-event-orders-request
 *   Authorization: Bearer <CRON_SECRET>
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const sheets                               = require('../config/sheets');
const { getAccount, brandsForAccount, metaTabFor } = require('../_account');
const { ptStartOfDayUtc, ptEndOfDayUtc } = require('../_dates'); // ADDED 2026-10-06

// META_TAB is per account — set inside the handler via metaTabFor().
const META_HEADERS = ['KEY', 'VALUE', 'UPDATED_AT'];
const EVENTS_TAB    = 'Events';

// tabName -> keyword(s) to match against the Events tab's Event Name column
// (case-insensitive substring match). "Prime Day" is checked as a whole
// phrase specifically so it doesn't false-match "Prime Big Deal Days".
const TARGET_TABS = [
  { tabName: 'Big Spring Sale',              keywords: ['big spring sale'] },
  { tabName: 'Prime Day',                    keywords: ['prime day'] },
  { tabName: 'Prime Big Deal Days',          keywords: ['prime big deal days', 'big deal days'] },
  { tabName: 'Black Friday and Cyber Monday', keywords: ['black friday', 'cyber monday'] },
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Seller account (ADDED 2026-10-05) ─────────────────────────────────────
  // NewDerm by default; ?account=hol runs the same job for High On Love —
  // see api/_account.js.
  // High On Love's orders go into the SAME event tabs (rows are tagged by
  // brand), but its pending report IDs live in _meta_events_hol.
  let account;
  try { account = getAccount(req); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const META_TAB = metaTabFor(account, '_meta_events');
  const accountBrands = brandsForAccount(account);
  if (accountBrands.length === 0) {
    return res.status(200).json({ skipped: true, account, reason: 'no active brands for this account' });
  }

  const now = new Date();
  const ts  = now.toISOString();
  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  if (!sheets.masterSkuList) {
    return res.status(500).json({ error: 'sheets.masterSkuList is not configured in config/sheets.js' });
  }

  // ── 1. Read the Events tab ──────────────────────────────────────────────
  let eventRows;
  try {
    eventRows = await readRows(sheets.masterSkuList, EVENTS_TAB);
  } catch (err) {
    console.error('[sync-event-orders-request] failed to read Events tab:', err.message);
    return res.status(500).json({ error: 'Failed to read Events tab', detail: err.message });
  }

  // ── 2. Match each target tab against the Events rows ───────────────────
  // Optional ?tab=... narrows to just one target (case-insensitive exact
  // match against tabName) — useful for running events one at a time
  // given how much order data a single event can pull.
  const tabFilter = (req.query.tab || '').toLowerCase().trim();
  const activeTargets = tabFilter
    ? TARGET_TABS.filter(t => t.tabName.toLowerCase() === tabFilter)
    : TARGET_TABS;

  if (tabFilter && !activeTargets.length) {
    return res.status(400).json({
      error: `No target tab named "${req.query.tab}"`,
      validTabs: TARGET_TABS.map(t => t.tabName),
    });
  }

  const matched = [];   // [{ tabName, start, end, matchedEventName }]
  const skipped = [];   // [{ tabName, reason }]

  for (const target of activeTargets) {
    const candidates = eventRows.filter(r => {
      const name = (r['Event Name'] || '').toLowerCase();
      return target.keywords.some(kw => name.includes(kw));
    });

    if (!candidates.length) {
      skipped.push({ tabName: target.tabName, reason: 'no matching row in Events tab' });
      continue;
    }

    // Most recent end_date wins by default. Pass ?year=YYYY to deliberately
    // pull a specific year's occurrence instead — useful now that tabs
    // accumulate years as rows rather than one tab per year, since you may
    // want to intentionally backfill an older year through this normal
    // flow (when it's within Amazon's retention window) rather than the
    // one-off manual CSV path.
    const yearFilter = req.query.year ? parseInt(req.query.year, 10) : null;
    const yearMatches = yearFilter
      ? candidates.filter(c => (c['start_date'] || '').startsWith(String(yearFilter)))
      : candidates;

    if (yearFilter && !yearMatches.length) {
      skipped.push({ tabName: target.tabName, reason: `no row matching year ${yearFilter}` });
      continue;
    }

    yearMatches.sort((a, b) => (b['end_date'] || '').localeCompare(a['end_date'] || ''));
    const best = yearMatches[0];

    const startDate = (best['start_date'] || '').trim();
    const endDate   = (best['end_date'] || '').trim();

    if (!startDate || !endDate) {
      skipped.push({ tabName: target.tabName, reason: `matched "${best['Event Name']}" but start_date/end_date is blank` });
      continue;
    }

    // Cap the end at "now minus buffer" if the event is still in progress or
    // hasn't happened yet — Amazon has no order data for the future.
    // FIXED 2026-10-06 — event days are PACIFIC days (Amazon US runs its
    // events on Pacific time). This used to request 00:00–23:59 UTC, which
    // pulled in the evening before the event and dropped the last evening
    // of it (7–8 hours each). Convert the event's dates to the exact UTC
    // instants of Pacific midnight → 23:59:59, daylight saving included.
    const ptStart   = ptStartOfDayUtc(startDate);
    const ptEnd     = ptEndOfDayUtc(endDate);
    const cappedEnd = ptEnd > safeBefore ? safeBefore : ptEnd;

    // FIXED 2026-10-05 — an event that hasn't STARTED yet (e.g. Prime Big
    // Deal Days on 2026-10-05, starting 10-06) had its end capped to "now"
    // while its start stayed in the future, producing an inverted range
    // (start after end) that Amazon rejects. Nothing to pull until it starts.
    if (ptStart >= cappedEnd) {
      skipped.push({ tabName: target.tabName, reason: `"${best['Event Name']}" hasn't started yet (starts ${startDate})` });
      continue;
    }

    matched.push({
      tabName: target.tabName,
      start: ptStart,
      end: cappedEnd,
      matchedEventName: best['Event Name'],
    });
  }

  if (skipped.length) {
    console.log('[sync-event-orders-request] skipped tabs:', JSON.stringify(skipped));
  }

  if (!matched.length) {
    return res.status(200).json({
      message: 'No target tabs matched a valid event with real dates — nothing to request',
      skipped,
    });
  }

  // ── 3. Request one report per matched event ─────────────────────────────
  const reportIds = {};
  const errors    = {}; // tabName -> Amazon's actual error message (ADDED 2026-10-05)
  for (const m of matched) {
    try {
      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  m.start,
        dataEndTime:    m.end,
      }, account);
      if (!createResp || !createResp.reportId) {
        console.error(`[sync-event-orders-request] ${m.tabName} — no reportId in response:`, JSON.stringify(createResp));
        errors[m.tabName] = `no reportId in response: ${JSON.stringify(createResp).slice(0, 300)}`;
        continue;
      }
      reportIds[m.tabName] = createResp.reportId;
      console.log(`[sync-event-orders-request] ${m.tabName} (${m.matchedEventName}) report requested: ${createResp.reportId}`);
    } catch (err) {
      console.error(`[sync-event-orders-request] ${m.tabName} failed to request report:`, err.message);
      errors[m.tabName] = err.message;
    }
  }

  if (!Object.keys(reportIds).length) {
    return res.status(500).json({ error: 'All report requests failed', account, errors, matched, skipped });
  }

  // ── 4. Write meta ─────────────────────────────────────────────────────────
  try {
    const token   = await ensureTab(sheets.orders, META_TAB, META_HEADERS);
    const rawMeta = await readRows(sheets.orders, META_TAB);
    const metaMap = {};
    for (const r of (rawMeta || [])) {
      if (r['KEY']) metaMap[r['KEY']] = r['VALUE'];
    }

    for (const m of matched) {
      if (!reportIds[m.tabName]) continue;
      metaMap[`report_id_${m.tabName}`]    = reportIds[m.tabName];
      metaMap[`report_start_${m.tabName}`] = m.start;
      metaMap[`report_end_${m.tabName}`]   = m.end;
      metaMap[`processed_${m.tabName}`]    = 'false';
    }
    const existingTargets = (metaMap['target_tabs'] || '').split(',').filter(Boolean);
    const newTargets = matched.filter(m => reportIds[m.tabName]).map(m => m.tabName);
    metaMap['target_tabs'] = Array.from(new Set([...existingTargets, ...newTargets])).join(',');
    metaMap['last_requested_at'] = ts;

    const metaRows = Object.entries(metaMap).map(([k, v]) => [k, v, ts]);
    await replaceRows(sheets.orders, META_TAB, META_HEADERS, metaRows, token);
  } catch (err) {
    console.error('[sync-event-orders-request] failed to write meta:', err.message);
    return res.status(500).json({ error: 'Failed to write meta', detail: err.message, reportIds });
  }

  res.status(200).json({ account, reportIds, errors, matched, skipped });
};
