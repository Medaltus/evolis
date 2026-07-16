// /api/sync-sqp-request.js
//
// Step 1 of 2 (same two-step pattern as sync-ad-search-terms-request.js /
// sync-ad-search-terms-process.js): requests the Search Query Performance
// report from Amazon's SP-API Reports API for last full month, and stores
// the returned reportId in the sheet's _meta tab. sync-sqp-process.js (the
// companion cron) polls for completion and writes the actual data once
// Amazon finishes generating it.
//
// Report type: GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT
// Endpoint:    POST /reports/2021-06-30/reports
// Requires:    Brand Analytics SP-API role + Brand Registry enrollment
//              (same entitlement Search Query Performance requires in the
//              Seller Central UI).
//
// IMPORTANT — auth: this imports getSpApiAccessToken from _sp_api_client.js,
// assuming that's the same helper sync-orders-process.js already uses for
// SP-API (LWA token refresh, etc.) — since Orders sync already talks to
// SP-API successfully, that helper must already exist somewhere in this
// repo. ADJUST THIS IMPORT PATH to match whatever it's actually named.
// I do not have that file in front of me, so I'm not guessing at its
// internals — only assuming its existence and a plausible export name.

import { ensureTab, readRows, replaceRows, getGoogleToken } from '../config/_sheets_client.js';
import { getSpApiAccessToken } from '../_sp_api_client.js'; // ← verify/adjust this import

const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com'; // adjust region if not NA marketplace
const SHEET_SQP_ID = process.env.SHEET_SEARCH_QUERY_PERFORMANCE_ID; // set in Vercel env vars
const META_TAB = '_meta';

// Last FULL calendar month, as {year, month, startISO, endISO} — mirrors the
// getLastFullMonth() pattern already used on the dashboard side (index.html).
function getLastFullMonthRange() {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed "this month" == 1-indexed "last month"
  if (month === 0) { month = 12; year -= 1; }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // last day of that month
  const iso = (d) => d.toISOString().slice(0, 10) + 'T00:00:00Z';
  return { year, month, dataStartTime: iso(start), dataEndTime: iso(end) };
}

export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) return res.status(401).end();

  try {
    const { year, month, dataStartTime, dataEndTime } = getLastFullMonthRange();
    const metaKey = `sqp_${year}_${String(month).padStart(2, '0')}`;

    // Skip if we've already successfully requested (or completed) this
    // month's report — this cron can safely run daily across the 10-15 day
    // "data not ready yet" window without re-requesting every time.
    const { headers, rows } = await readRows(SHEET_SQP_ID, META_TAB).catch(() => ({ headers: [], rows: [] }));
    const keyIdx = headers.indexOf('key');
    const existing = rows.find(r => r[keyIdx] === metaKey);
    if (existing) {
      console.log(`[sync-sqp-request] ${metaKey} already requested — skipping. Status: ${existing[headers.indexOf('status')]}`);
      return res.status(200).json({ ok: true, skipped: true, metaKey });
    }

    const accessToken = await getSpApiAccessToken();

    const reportResp = await fetch(`${SP_API_BASE}/reports/2021-06-30/reports`, {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
        marketplaceIds: [process.env.SP_API_MARKETPLACE_ID], // e.g. ATVPDKIKX0DER for US
        reportOptions: {
          reportPeriod: 'MONTH'
        },
        dataStartTime,
        dataEndTime
      })
    });

    if (!reportResp.ok) {
      const errText = await reportResp.text();
      // A common early-month response: Amazon rejects the request because
      // last month's data isn't finalized yet. Don't treat this as a hard
      // failure — just don't write to _meta, so the next daily run retries
      // automatically until it succeeds (this is the mechanism that
      // handles the "wait 10-15 days" requirement without any special-case
      // date logic — we just keep trying and let Amazon tell us when it's
      // ready).
      console.warn(`[sync-sqp-request] report request failed (expected during the first ~10-15 days of the month if last month's data isn't finalized yet): ${reportResp.status} ${errText}`);
      return res.status(200).json({ ok: true, notReadyYet: true, detail: errText });
    }

    const { reportId } = await reportResp.json();
    console.log(`[sync-sqp-request] requested ${metaKey} — reportId ${reportId}`);

    await ensureTab(SHEET_SQP_ID, META_TAB, ['key', 'reportId', 'status', 'requestedAt', 'processedAt']);
    const newRow = [metaKey, reportId, 'REQUESTED', new Date().toISOString(), ''];
    const googleToken = await getGoogleToken();
    await replaceRows(SHEET_SQP_ID, META_TAB, ['key', 'reportId', 'status', 'requestedAt', 'processedAt'], [...rows, newRow], googleToken);

    res.status(200).json({ ok: true, metaKey, reportId });
  } catch (err) {
    console.error('[sync-sqp-request] error:', err);
    res.status(500).json({ error: err.message });
  }
}
