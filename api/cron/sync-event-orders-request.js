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

const META_TAB     = '_meta_events';
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

  const now = new Date();
  const ts  = now.toISOString();
  const safeBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

  if (!sheets.masterSkuList) {
    return res.status(500).json({ error: 'sheets.masterSkuList is not configured in config/sheets.js' });
  }

  // ── Manual override — for one-off historical backfills (e.g. an older
  // year's occurrence of an event that's no longer the "newest" match)
  // that shouldn't touch the standard auto-matched tabs at all. When
  // startDate/endDate/outTab are all given, this bypasses the Events tab
  // lookup entirely and writes to whatever tab name you specify — safe to
  // use alongside the normal flow since it never writes to one of the 4
  // standard tab names unless you explicitly pass one.
  //   GET ?startDate=2025-06-21&endDate=2025-06-24&outTab=Prime Day 2025
  if (req.query.startDate && req.query.endDate && req.query.outTab) {
    const overrideStart = req.query.startDate;
    const overrideEndRaw = `${req.query.endDate}T23:59:59Z`;
    const overrideEnd = overrideEndRaw > safeBefore ? safeBefore : overrideEndRaw;

    let reportId;
    try {
      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  `${overrideStart}T00:00:00Z`,
        dataEndTime:    overrideEnd,
      });
      reportId = createResp?.reportId;
    } catch (err) {
      return res.status(500).json({ error: 'Failed to request override report', detail: err.message });
    }
    if (!reportId) return res.status(500).json({ error: 'No reportId returned for override request' });

    try {
      const metaToken = await ensureTab(sheets.orders, META_TAB, META_HEADERS);
      const rawMeta    = await readRows(sheets.orders, META_TAB);
      const metaMap    = {};
      (rawMeta || []).forEach(r => { if (r['KEY']) metaMap[r['KEY']] = [r['KEY'], r['VALUE'], r['UPDATED_AT']]; });

      const tabName = req.query.outTab;
      metaMap[`report_id_${tabName}`]    = [`report_id_${tabName}`, reportId, ts];
      metaMap[`processed_${tabName}`]    = [`processed_${tabName}`, 'false', ts];
      const existingTargets = ((metaMap['target_tabs'] || [])[1] || '').split(',').filter(Boolean);
      metaMap['target_tabs'] = ['target_tabs', Array.from(new Set([...existingTargets, tabName])).join(','), ts];

      await replaceRows(sheets.orders, META_TAB, META_HEADERS, Object.values(metaMap), metaToken);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to write meta for override', detail: err.message, reportId });
    }

    return res.status(200).json({
      mode: 'manual_override',
      outTab: req.query.outTab,
      reportId,
      start: overrideStart,
      end: overrideEnd,
    });
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

    // Most recent end_date wins if multiple rows match (e.g. multiple years)
    candidates.sort((a, b) => (b['end_date'] || '').localeCompare(a['end_date'] || ''));
    const best = candidates[0];

    const startDate = (best['start_date'] || '').trim();
    const endDate   = (best['end_date'] || '').trim();

    if (!startDate || !endDate) {
      skipped.push({ tabName: target.tabName, reason: `matched "${best['Event Name']}" but start_date/end_date is blank` });
      continue;
    }

    // Cap the end at "now minus buffer" if the event is still in progress or
    // hasn't happened yet — Amazon has no order data for the future.
    const cappedEnd = `${endDate}T23:59:59Z` > safeBefore ? safeBefore : `${endDate}T23:59:59Z`;

    matched.push({
      tabName: target.tabName,
      start: `${startDate}T00:00:00Z`,
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
  for (const m of matched) {
    try {
      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  m.start,
        dataEndTime:    m.end,
      });
      if (!createResp || !createResp.reportId) {
        console.error(`[sync-event-orders-request] ${m.tabName} — no reportId in response:`, JSON.stringify(createResp));
        continue;
      }
      reportIds[m.tabName] = createResp.reportId;
      console.log(`[sync-event-orders-request] ${m.tabName} (${m.matchedEventName}) report requested: ${createResp.reportId}`);
    } catch (err) {
      console.error(`[sync-event-orders-request] ${m.tabName} failed to request report:`, err.message);
    }
  }

  if (!Object.keys(reportIds).length) {
    return res.status(500).json({ error: 'All report requests failed', matched, skipped });
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

  res.status(200).json({ reportIds, matched, skipped });
};
