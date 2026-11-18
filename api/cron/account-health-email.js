/**
 * api/cron/account-health-email.js
 * ADDED 2026-11-16 (per Jaclyn) — "Account Health" email for the whole team
 * (Ashley + every Brand Manager), styled like the other alert emails.
 * 8:00 AM Eastern, after sync-account-health.js's morning pull.
 *
 * Sends:
 *   - weekdays, only when something is NEW today: a metric / status / rating
 *     got worse ("changes" sheet) or new negative seller feedback ("seller_feedback");
 *   - every Monday, always — a weekly snapshot even when nothing changed.
 * Reads every set in SHEET_SETS (one per seller account group) and combines them.
 * Contents: a status card per account (status + Account Health Rating), what
 * changed (worse first), every metric that isn't healthy (value vs Amazon's
 * target; Amazon violations are counts only — Amazon doesn't say which SKUs;
 * Walmart metrics list the orders behind them), "Inactive listings" (every
 * issue on the cron brands' inactive SKUs + stranded stock, from the daily
 * scan → "inactive_listings"; NEW = first seen on the latest scan), and new
 * negative seller feedback.
 * Listing-level issues are NOT in this email (CHANGED 2026-11-16 per Jaclyn —
 * Listing Alerts already covers them).
 *
 * Modes: ?testTo=a@medaltus.com (send only there, not logged) · ?preview=true
 * (return the HTML) · ?force=true (send even if nothing is new / already sent).
 * Env: CRON_SECRET, ALERTS_API_KEY, optional FROM_EMAIL.
 */

const { getSheetsToken } = require('../config/_sheets_client');
const { sendCronFailureAlert } = require('../_alerts');

// CHANGED 2026-11-16 — the email reads every SET of account-health sheets
// below and combines them; account cards come from whatever accounts are in
// the data, so a new set's account appears automatically once it has data.
const SHEET_SETS = [
  { // NewDerm US, NewDerm CA, High On Love — written by this project's sync-account-health.js
    health:   { id: '18TMRTDW1Mvodx7hZ1dWu1763_gCokFytC8BxHAWxOSE', tab: 'health_daily' },
    metrics:  { id: '1gsbzdc6AJMSyyTgEbc1Lh2ccEgSJLtwg1GK7To8sWgI', tab: 'metrics_detail' },
    inactive: { id: '1gsbzdc6AJMSyyTgEbc1Lh2ccEgSJLtwg1GK7To8sWgI', tab: 'inactive_listings' }, // daily inactive-listings scan
    feedback: { id: '1sMJEdXewdG_PXzN_Saj-2Wkd9ozihBUXDGwwopS8YwQ', tab: 'seller_feedback' },
    changes:  { id: '1AjYkrA8INLdkTViF-Ve4poHtlDmXPgkYiDUpK5JPY2Q', tab: 'changes' },
  },
  { // 4th seller account (ADDED 2026-11-16) — same layout, written by its own sync-account-health.js
    health:   { id: '14zbDimNq2BQIRFu1dB5purlFjZVAWx2uneC2bniiFIE', tab: 'health_daily' },
    metrics:  { id: '16DQAvusbKxULEh1_Opzb_WjUc5S3ohUBAtN0xWQ4DU4', tab: 'metrics_detail' },
    inactive: { id: '16DQAvusbKxULEh1_Opzb_WjUc5S3ohUBAtN0xWQ4DU4', tab: 'inactive_listings' },
    feedback: { id: '1Gk-fM_GIEYyZqmkGBzA17EneoXx6mxSioMOya5ztaSE', tab: 'seller_feedback' },
    changes:  { id: '1Id_oct_VhZUpUadsbwDPc9wsG7oWIe6ZG1eQ5DhC_Qc', tab: 'changes' },
  },
];
SHEET_SETS.push({ // Walmart (ADDED 2026-11-16) — written by sync-walmart-health.js in the same layout, as account "Walmart"
  metrics:  { id: '1AXGABShbHsPT5lBCY809a8RtWn0a9Lgm9CZzjGS6FzE', tab: 'metrics_detail' },
  changes:  { id: '1AXGABShbHsPT5lBCY809a8RtWn0a9Lgm9CZzjGS6FzE', tab: 'changes' },
  defects:  { id: '1AXGABShbHsPT5lBCY809a8RtWn0a9Lgm9CZzjGS6FzE', tab: 'defect_orders' },
});
const SHEETS = { meta: { id: '1DhduU87hFgGOdsuK5XBBNRXVn4mpZzNkC1AKoDwhOnA', tab: 'email-log' } }; // send log lives with set 1
// ADDED 2026-11-18 — Amazon emails to cs@onlineskincaresales.com, logged by the
// "Amazon Performance Notifications" Apps Script in that mailbox. Columns:
// 0 received_at · 1 store · 2 marketplace · 3 notice_type · 4 amazon_action · 5 asins · 6 skus ·
// 7 subject · 8 summary · 9 policy_link · 10 from · 11 gmail_link · 12 message_id · 13 full_text ·
// 14 logged_at · 15 category · 16 case_or_complaint_id
const NOTICES = { id: '1hGOiCwcfRN-OIMjKdYCmtXb4VdD9CJV1EeFM_Vr-vRA', tab: 'notifications' };
const NOTICE_OPEN_DAYS = 90, CASE_OPEN_DAYS = 30;
// Manual entries (ADDED 2026-11-18) — Account Health items the team copies in by hand. Columns:
// 0 date · 1 reason · 2 asin · 3 sku · 4 product · 5 action_taken · 6 at_risk_sales · 7 status · 8 next_step · 9 notes · 10 added_by
const MANUAL = { id: '1hGOiCwcfRN-OIMjKdYCmtXb4VdD9CJV1EeFM_Vr-vRA', tab: 'manual_entries' };
const MANUAL_DONE = /resolved|reinstated|closed/i;
// Keeping open issues current (ADDED 2026-11-18 per Jaclyn) — Amazon rarely emails when an issue is fixed:
//  1. a deactivated / removed / suppressed listing that is BUYABLE again in today's Products Cache
//     (and not in today's inactive-listings scan) drops off, with a one-time "✓ Listing active again";
//  2. an "at risk" notice with no deactivation after it drops off AT_RISK_DAYS after it arrived;
//  3. a manual_entries row marked Resolved / Reinstated closes the captured notices for its ASIN —
//     unless Amazon sends a newer email with an action (deactivation, warning…) about that ASIN.
const AT_RISK_DAYS = 30;
// "deactivated", not "deactivation" — "At risk of deactivation" is NOT a deactivation (FIXED 2026-11-18).
const DEACTIVATED = /deactivated|removed|suppressed|blocked|restricted in some|appeal rejected|detail page changed/i;
const AT_RISK = /at risk|action required|warning/i;
const RESOLVED_LOG = { id: '1DhduU87hFgGOdsuK5XBBNRXVn4mpZzNkC1AKoDwhOnA', tab: 'resolved-log' }; // one-time "resolved" lines already shown
const brandsConfig = require('../config/brands');
const sheetsConfig = require('../config/sheets');
const MASTER_GID = '164358627';
const TO = ['awilcox@medaltus.com', 'jcarter@medaltus.com', 'sdeavies@medaltus.com', 'mgallagher@medaltus.com', 'jsonberg@medaltus.com', 'ifernandez@medaltus.com', 'lrohde@medaltus.com']; // jcarter, sdeavies, mgallagher ADDED 2026-11-17
const FROM_EMAIL = process.env.FROM_EMAIL || 'reports@medaltus.com';
const REPLY_TO = 'reports@medaltus.com';
const LOGO_URL = 'https://vbcosmeticsreport.medaltus.com/api/medaltus-logo';
const ACCOUNT_ORDER = ['NewDerm|US', 'NewDerm|CA', 'High On Love|US']; // these first; other Amazon accounts next; Walmart last
const HEALTHY = /^(GOOD|GREAT|NONE|NORMAL|HEALTHY|ACTIVE|MEETS STANDARD|)$/i; // last two: Walmart

// Plain-English names for Amazon's metric keys.
const NAMES = {
  accountStatus: 'Account status', accountHealthRating: 'Account Health Rating', lateShipmentRate: 'Late shipment rate',
  invoiceDefectRate: 'Invoice defect rate', 'orderDefectRate.afn': 'Order defect rate (FBA)', 'orderDefectRate.mfn': 'Order defect rate (FBM)',
  onTimeDeliveryRate: 'On-time delivery rate', unitOnTimeDeliveryRate: 'Unit on-time delivery rate', validTrackingRate: 'Valid tracking rate',
  preFulfillmentCancellationRate: 'Pre-fulfillment cancellation rate', listingPolicyViolations: 'Listing policy violations',
  productAuthenticityCustomerComplaints: 'Product authenticity complaints', productConditionCustomerComplaints: 'Product condition complaints',
  productSafetyCustomerComplaints: 'Product safety complaints', receivedIntellectualPropertyComplaints: 'IP complaints received',
  restrictedProductPolicyViolations: 'Restricted product policy violations', suspectedIntellectualPropertyViolations: 'Suspected IP violations',
  foodAndProductSafetyIssues: 'Food & product safety issues', customerProductReviewsPolicyViolations: 'Review policy violations',
  otherPolicyViolations: 'Other policy violations', documentRequests: 'Document requests',
  // Walmart (sync-walmart-health.js)
  cancellations: 'Cancellation rate', onTimeDelivery: 'On-time delivery rate', validTracking: 'Valid tracking rate', sellerResponse: 'Seller response rate',
  lateShipment: 'Late shipment rate', onTimeShipment: 'On-time shipment rate', carrierMethodAccuracy: 'Carrier method accuracy',
  shipFromAccuracy: 'Ship-from location accuracy', negativeFeedback: 'Negative feedback rate', returns: 'Return rate', itemNotReceived: 'Item not received rate',
};
const WM_RATES = new Set(['cancellations', 'onTimeDelivery', 'validTracking', 'sellerResponse', 'lateShipment', 'onTimeShipment', 'carrierMethodAccuracy', 'shipFromAccuracy', 'negativeFeedback', 'returns', 'itemNotReceived']);
const nameOf = m => NAMES[m] || m.replace(/\[\d+\]$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\./g, ' › ').replace(/^./, c => c.toUpperCase());
const isRate = m => WM_RATES.has(m) || (/rate/i.test(m) && !/rating/i.test(m));
const sameNumber = (a, b) => { const x = parseFloat(a), y = parseFloat(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.round(x) === Math.round(y) : String(a).trim() === String(b).trim(); };

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const testTo = String(req.query.testTo || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (testTo.some(e => !e.endsWith('@medaltus.com'))) return res.status(400).json({ error: 'testTo addresses must be @medaltus.com' });
  const preview = req.query.preview === 'true', force = req.query.force === 'true';
  const today = todayEt();
  const monday = new Date(today + 'T12:00:00Z').getUTCDay() === 1;

  try {
    const read = async s => readTab(s).catch(() => []); // a set with no data yet just adds nothing
    const all = async key => (await Promise.all(SHEET_SETS.map(set => read(set[key])))).flat();
    const [metrics, inactive, feedback, changes, defects] = await Promise.all([all('metrics'), all('inactive'), all('feedback'), all('changes'), all('defects')]);
    const sendLog = await read(SHEETS.meta);
    if (!testTo.length && !preview && !force) {
      if (sendLog.some(r => r[0] === today)) return res.status(200).json({ skipped: true, reason: `already sent today (${today})` });
    }
    // "New" = received after the last real send (Eastern time, "YYYY-MM-DD HH:MM"); first time: last 3 days.
    const lastSentIso = sendLog.map(r => r[1]).filter(Boolean).sort().pop();
    const since = lastSentIso ? etStamp(new Date(lastSentIso)) : `${addDaysIso(today, -3)} 00:00`;
    const [noticeRows, manualRows, master] = await Promise.all([read(NOTICES), read(MANUAL), loadMaster().catch(() => new Map())]);
    const inactiveNow = latestScan(inactive);
    const [live, resolvedShown] = await Promise.all([loadLiveStatus().catch(() => new Map()), read(RESOLVED_LOG)]);
    const notices = buildNotices(noticeRows, master, today, since, manualRows,
      { live, inactiveAsins: new Set(inactiveNow.map(r => String(r[5] || '').toUpperCase())), shown: new Set(resolvedShown.map(r => r[0])) });

    // Latest snapshot per account
    const latestDate = (rows, acc, mkt) => rows.filter(r => r[1] === acc && r[2] === mkt).map(r => r[0]).sort().pop();
    const accounts = [...new Set(metrics.filter(r => r[1] && r[2]).map(r => `${r[1]}|${r[2]}`))]
      .sort((a, b) => ((ACCOUNT_ORDER.indexOf(a) + 1) || (a.startsWith('Walmart|') ? 200 : 99)) - ((ACCOUNT_ORDER.indexOf(b) + 1) || (b.startsWith('Walmart|') ? 200 : 99)) || a.localeCompare(b))
      .map(k => k.split('|'));
    const cards = accounts.map(([acc, mkt]) => {
      const d = latestDate(metrics, acc, mkt);
      const rows = metrics.filter(r => r[0] === d && r[1] === acc && r[2] === mkt);
      const get = m => rows.find(r => r[3] === m) || [];
      return { acc, mkt, date: d, status: get('accountStatus')[4] || '—', ahr: get('accountHealthRating')[5] || '—', ahrStatus: get('accountHealthRating')[4] || '',
        attention: rows.filter(r => r[3] !== 'accountStatus' && !/\[\d+\]$/.test(r[3]) && !/\.(claims|chargebacks|negativeFeedback|orderWithDefects|invoiceDefect|missingInvoice|lateInvoice)$/.test(r[3]) && !HEALTHY.test(r[4] || ''))
          .map(r => ({ metric: r[3], status: r[4], value: r[5], target: r[6], cond: r[7], defects: r[8], from: r[10], to: r[11] })) };
    });
    // Hide "changes" that look identical once rounded for display (also covers sheets written by other crons).
    const todays = changes.filter(r => r[0] === today && !(r[4] !== 'status' && (r[4] === 'value' && isRate(r[3]) ? pct(r[5]) === pct(r[6]) : sameNumber(r[5], r[6]))));
    const worse = todays.filter(r => r[7] === 'worse');
    const inactiveLatest = latestScan(inactive);
    const newFeedback = feedback.filter(r => r[7] === today);

    const somethingNew = worse.length || newFeedback.length || notices.newNotices.length || notices.cases.some(c => c.state === 'NEW');
    if (!somethingNew && !monday && !force && !preview && !testTo.length) {
      return res.status(200).json({ sent: false, reason: 'nothing new today (weekday)', changesToday: todays.length });
    }

    const defectsLatest = latestScan(defects); // same "newest day per account" rule
    const html = buildHtml({ today, monday, cards, todays, inactiveLatest, defectsLatest, newFeedback, notices, test: testTo.length ? TO : null });
    if (preview) { res.setHeader('Content-Type', 'text/html'); return res.status(200).send(html); }
    if (!process.env.ALERTS_API_KEY) throw new Error('ALERTS_API_KEY is not set');
    const atRisk = cards.filter(c => !HEALTHY.test(c.status));
    const bits = [atRisk.length ? `${atRisk.map(c => `${c.acc} ${c.mkt}`).join(', ')} ${atRisk.length === 1 ? 'is' : 'are'} ${atRisk.map(c => c.status.replace(/_/g, ' ').toLowerCase())[0]}` : 'all accounts healthy',
      worse.length ? `${worse.length} change${worse.length === 1 ? '' : 's'} for the worse` : '',
      notices.cases.filter(c => c.state === 'NEW').length ? `${notices.cases.filter(c => c.state === 'NEW').length} new case${notices.cases.filter(c => c.state === 'NEW').length === 1 ? '' : 's'}` : ''].filter(Boolean);
    const subject = `${testTo.length ? '[TEST] ' : ''}Account Health — ${bits.join(' · ')} · ${fmtDay(today)}`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.ALERTS_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Medaltus Reports <${FROM_EMAIL}>`, reply_to: REPLY_TO, to: testTo.length ? testTo : TO, subject, html }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
    if (!testTo.length) {
      await logSend(today, subject, body.id);
      if ((notices.resolved || []).length) await appendLog(RESOLVED_LOG, ['key', 'shown_on', 'why'], notices.resolved.map(x => [x.logKey, today, x.why]));
    }
    return res.status(200).json({ sent: true, test: !!testTo.length, to: testTo.length ? testTo : TO, subject, worse: worse.length, inactiveListingIssues: inactiveLatest.length, newFeedback: newFeedback.length });
  } catch (err) {
    console.error('[account-health-email]', err.message);
    await sendCronFailureAlert('account-health-email', err.message);
    return res.status(500).json({ error: err.message });
  }
};
// Newest day's rows PER ACCOUNT (inactive_listings, defect_orders). inactive_listings
// columns: date, account, marketplace, brand, sku, asin, listing_status, source,
// severity, amazon_message, enforcement, first_seen.
const latestScan = rows => {
  const last = {};
  rows.forEach(r => { const k = `${r[1]}|${r[2]}`; if (!last[k] || r[0] > last[k]) last[k] = r[0]; });
  return rows.filter(r => r[0] === last[`${r[1]}|${r[2]}`]);
};

// ── Email ──────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = v => { const n = parseFloat(v); return Number.isFinite(n) ? `${(n * 100).toFixed(n < 0.1 ? 2 : 1).replace(/\.0+$/, '')}%` : esc(v); };
const fmtVal = (m, v) => (v === '' || v == null ? '' : isRate(m) ? pct(v) : esc(v));
const statusPill = s => {
  const bad = /risk|bad|poor|fail|critical|suspend|deactivat/i.test(s), mid = /fair|warning|at_risk|attention|monitor|recommended/i.test(s) && !/bad/i.test(s);
  const [bg, fg] = bad ? ['#FFD2CC', '#C0392B'] : mid ? ['#FFE8A3', '#7A5B00'] : ['#D6F7EA', '#1A7F5A'];
  return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:700;">${esc(String(s || '—').replace(/_/g, ' '))}</span>`;
};
const shortDate = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? fmtDay(m[0], true) : ''; };
const daysOpen = (first, today) => { const a = new Date(first + 'T12:00:00Z'), b = new Date(today + 'T12:00:00Z'); return Math.max(0, Math.round((b - a) / 86400000)); };

function buildHtml({ today, monday, cards, todays, inactiveLatest = [], defectsLatest = [], newFeedback, notices = { newNotices: [], open: [], cases: [] }, test }) {
  const th = 'padding:7px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#fff;background:#001F60;text-align:left;font-family:Arial,sans-serif;';
  const td = 'padding:8px 10px;font-size:12px;color:#001F60;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;vertical-align:top;';
  const section = (title, color, inner) => `<tr><td style="padding:18px 32px 4px;"><div style="font-size:15px;font-weight:700;color:${color};font-family:Georgia,'Times New Roman',serif;border-bottom:2px solid #24E9A3;padding-bottom:4px;margin-bottom:8px;">${title}</div>${inner}</td></tr>`;

  const cardHtml = cards.map((c, i) => `${i && i % 4 === 0 ? '</tr><tr><td colspan="4" style="height:8px;"></td></tr><tr>' : ''}<td style="padding:0 8px 0 0;vertical-align:top;width:25%;"><div style="border:1px solid #e4e8ef;border-radius:10px;padding:12px 14px;height:96px;box-sizing:border-box;">
      <div style="font-size:11px;color:#6B7BA2;text-transform:uppercase;letter-spacing:.05em;font-weight:700;">${esc(c.acc)} · ${esc(c.mkt)}</div>
      <div style="margin-top:6px;">${statusPill(c.status)}</div>
      <div style="font-size:12px;color:#001F60;margin-top:6px;">Health rating <b>${esc(c.ahr)}</b> ${c.ahrStatus ? `<span style="color:#6B7BA2;">(${esc(c.ahrStatus.toLowerCase())})</span>` : ''}${c.attention.length ? ` · <span style="color:#C0392B;font-weight:700;">${c.attention.length} need${c.attention.length === 1 ? 's' : ''} attention</span>` : ''}</div>
    </div></td>`).join('');

  const order = { worse: 0, changed: 1, new: 2, better: 3 };
  const changeRows = todays.slice().sort((a, b) => (order[a[7]] ?? 9) - (order[b[7]] ?? 9)).map(r => {
    const col = r[7] === 'worse' ? '#C0392B' : r[7] === 'better' ? '#1A7F5A' : '#6B7BA2';
    const f = r[4] === 'value' ? fmtVal(r[3], r[5]) : esc(r[5]), t = r[4] === 'value' ? fmtVal(r[3], r[6]) : esc(r[6]);
    return `<tr><td style="${td}">${esc(r[1])} ${esc(r[2])}</td><td style="${td}font-weight:700;">${esc(nameOf(r[3]))}${r[4] !== 'status' && r[4] !== 'value' ? ` <span style="font-weight:400;color:#6B7BA2;">(${esc(r[4].replace(/_/g, ' '))})</span>` : ''}</td>
      <td style="${td}white-space:nowrap;">${f} → <b style="color:${col};">${t}</b></td><td style="${td}color:${col};font-weight:700;text-transform:uppercase;font-size:10px;">${esc(r[7])}</td></tr>`;
  }).join('');
  const changesHtml = changeRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;"><tr><th style="${th}">Account</th><th style="${th}">What</th><th style="${th}">Change</th><th style="${th}"></th></tr>${changeRows}</table>`
    : `<div style="font-size:12px;color:#6B7BA2;">No changes since the previous snapshot.</div>`;

  const attention = cards.flatMap(c => c.attention.map(a => ({ ...a, acc: c.acc, mkt: c.mkt })));
  // Under each policy-violation row: the SKUs the violation scan found for it.
  const skuRow = a => {
    if (a.acc === 'Walmart') { // Walmart: the orders behind the metric (defect_orders)
      const orders = defectsLatest.filter(r => r[3] === a.metric);
      if (!orders.length) return '';
      const shown = orders.slice(0, 10).map(r => `<div style="margin:2px 0;">Order <b style="color:#001F60;">${esc(r[4])}</b>${r[5] ? ` · SKU <b style="color:#001F60;">${esc(r[5])}</b>` : ''}${r[6] ? ` · ${esc(r[6])}` : ''}${r[7] ? ` · <span style="color:#6B7BA2;">${esc(r[7])}</span>` : ''}${r[8] ? ` — ${esc(r[8])}` : ''}</div>`).join('');
      return `<tr><td style="padding:0 10px 9px 22px;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;font-size:11px;color:#3a4a6b;" colspan="6">
        <span style="font-size:10px;font-weight:700;color:#6B7BA2;text-transform:uppercase;letter-spacing:.04em;">Orders behind it (${orders.length}):</span> ${shown}${orders.length > 10 ? `<div style="color:#9ba8c0;">+ ${orders.length - 10} more in the Walmart Account Health sheet (defect_orders)</div>` : ''}</td></tr>`;
    }
    return ''; // Amazon violations: counts only (Amazon doesn't say which SKUs)
  };
  const attentionHtml = attention.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
      <tr><th style="${th}">Account</th><th style="${th}">Metric</th><th style="${th}">Status</th><th style="${th}">Now</th><th style="${th}">Target</th><th style="${th}">Period</th></tr>
      ${attention.map(a => `<tr><td style="${td}">${esc(a.acc)} ${esc(a.mkt)}</td><td style="${td}font-weight:700;">${esc(nameOf(a.metric))}</td><td style="${td}">${statusPill(a.status)}</td>
        <td style="${td}white-space:nowrap;">${a.defects !== '' && a.defects != null && !isRate(a.metric) ? `<b>${esc(a.defects)}</b>` : `<b>${fmtVal(a.metric, a.value)}</b>`}</td>
        <td style="${td}white-space:nowrap;color:#6B7BA2;">${a.target !== '' ? `${({ LESS_THAN: 'under', GREATER_THAN: 'over', EQUALS: '' })[a.cond] ?? ''} ${isRate(a.metric) ? pct(a.target) : esc(a.target)}` : '—'}</td>
        <td style="${td}white-space:nowrap;color:#6B7BA2;">${a.from ? `${shortDate(a.from)} – ${shortDate(a.to)}` : ''}</td></tr>${skuRow(a)}`).join('')}</table>`
    : `<div style="font-size:12px;color:#1A7F5A;">Every metric on every account is healthy.</div>`;

  // Inactive listings, grouped by account + brand; NEW first, then by SKU.
  // Email shows errors, enforcements, stranded stock and "no reason" rows; warnings stay in the sheet.
  // Only rows from the current rules (they always carry why_listed); errors, enforcements, stranded stock, "no reason" rows.
  const important = r => (r[12] || '').trim() && (/ERROR/i.test(r[8] || '') || (r[10] || '').trim() || r[7] === 'Stranded inventory report' || /no reason/i.test(r[9] || ''));
  const hiddenWarnings = inactiveLatest.filter(r => (r[12] || '').trim() && !important(r)).length;
  const groups = {};
  inactiveLatest.filter(important).forEach(r => { const k = `${r[1]} ${r[2]} · ${r[3] || 'Other'}`; (groups[k] = groups[k] || []).push(r); });
  const clip = (t, n) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n).trimEnd() + '… (full text in the inactive_listings tab)' : t; };
  const inactiveHtml = inactiveLatest.length ? Object.keys(groups).sort().map(k => {
    const rows = groups[k].sort((a, b) => (b[11] === b[0]) - (a[11] === a[0]) || a[4].localeCompare(b[4]));
    const skus = new Set(rows.map(r => r[4])).size;
    return `<div style="font-size:13px;font-weight:700;color:#001F60;margin:10px 0 4px;">${esc(k)} <span style="font-weight:400;color:#6B7BA2;font-size:11px;">· ${skus} SKU${skus === 1 ? '' : 's'}, ${rows.length} issue${rows.length === 1 ? '' : 's'}</span></div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
        <tr><th style="${th}"></th><th style="${th}">SKU</th><th style="${th}">Why it's listed</th><th style="${th}">Amazon's message</th><th style="${th}">Open</th></tr>
        ${rows.map(r => `<tr style="background:${r[11] === r[0] ? '#FFF8E6' : '#fff'};">
          <td style="${td}white-space:nowrap;">${r[11] === r[0] ? '<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:#24E9A3;color:#001F60;font-size:10px;font-weight:700;">NEW</span>' : ''}</td>
          <td style="${td}white-space:nowrap;"><b>${esc(r[4])}</b><div style="font-size:10px;color:#9ba8c0;">${esc(r[5])}</div></td>
          <td style="${td}font-size:11px;"><b>${esc(r[12] || r[6])}</b><div style="font-size:10px;color:#9ba8c0;">${esc(r[12] ? r[6] : '')}</div></td>
          <td style="${td}font-size:11px;">${esc(clip(r[9], 400))}${r[10] ? `<div style="font-size:10px;color:#9ba8c0;">${esc(String(r[10]).replace(/_/g, ' ').toLowerCase())}</div>` : ''}</td>
          <td style="${td}white-space:nowrap;color:#6B7BA2;">${r[11] ? `${daysOpen(r[11], today)} day${daysOpen(r[11], today) === 1 ? '' : 's'}` : ''}</td></tr>`).join('')}</table>`;
  }).join('') + `<div style="font-size:11px;color:#9ba8c0;margin-top:6px;">Cron-brand SKUs Amazon has suppressed, removed or blocked, that aren't discoverable, or that the All Listings report calls Incomplete — plus stranded stock. Out-of-stock and closed listings are left out. Errors and enforcements shown${hiddenWarnings ? `; ${hiddenWarnings} lower-priority warning${hiddenWarnings === 1 ? '' : 's'} on these SKUs are in the inactive_listings tab` : ''}. Not tied to the Account Health violation counts above — Amazon doesn't link those to SKUs.</div>`
    : `<div style="font-size:12px;color:#1A7F5A;">No suppressed, removed, undiscoverable or incomplete listings on the latest scan.</div>`;

  const feedbackHtml = newFeedback.length ? newFeedback.map(f => `<div style="border:1px solid #e4e8ef;border-left:4px solid #C0392B;border-radius:6px;padding:9px 12px;margin-bottom:6px;font-size:12px;color:#3a4a6b;">
      <b style="color:#001F60;">${esc(f[3])}★</b> · ${esc(f[1])} ${esc(f[2])} · ${esc(f[0])}${f[6] ? ` · order ${esc(f[6])}` : ''}<div style="margin-top:3px;">${esc(f[4])}</div></div>`).join('')
    : `<div style="font-size:12px;color:#1A7F5A;">No new negative seller feedback.</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:32px 0;"><tr><td align="center">
    <table width="1100" cellpadding="0" cellspacing="0" style="width:1100px;max-width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <tr><td style="background:#001F60;padding:24px 32px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#24E9A3;font-weight:700;">Medaltus &middot; Amazon &amp; Walmart Seller Accounts</div>
        <div style="font-size:24px;color:#fff;font-weight:700;margin-top:6px;font-family:Georgia,'Times New Roman',serif;">Account Health</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px;">${esc(fmtDay(today))}${monday ? ' &middot; weekly snapshot' : ''} &middot; ${cards.map(c => `${esc(c.acc)} ${esc(c.mkt)}`).join(', ')}</div>
      </td></tr>
      <tr><td style="padding:22px 32px 4px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>${cardHtml}</tr></table></td></tr>
      ${section('What changed since the previous snapshot', '#001F60', changesHtml)}
      ${section('Needs attention', '#C0392B', attentionHtml)}
      ${section('Policy issues', '#C0392B', noticesHtml(notices.open.filter(o => groupOf(o) === 'policy'), today, th, td, 'No open restricted-product, product safety / compliance, geographic restriction or IP complaint issues.', (notices.resolved || []).filter(o => groupOf(o) === 'policy')))}
      ${section('Other notices', '#001F60', noticesHtml(notices.open.filter(o => groupOf(o) === 'other'), today, th, td, 'No other open Amazon notices.', (notices.resolved || []).filter(o => groupOf(o) === 'other')))}
      ${section('Brand Registry', '#001F60', noticesHtml(notices.open.filter(o => groupOf(o) === 'brand'), today, th, td, 'No open Brand Registry notices.', (notices.resolved || []).filter(o => groupOf(o) === 'brand')) + `<div style="font-size:11px;color:#9ba8c0;margin-top:8px;">Policy issues, other notices and Brand Registry come from Amazon's emails to cs@onlineskincaresales.com (last ${NOTICE_OPEN_DAYS} days) plus items copied from the Account Health page into the manual_entries tab. An emailed issue drops off when Amazon's latest email for it is a reinstatement; a manual entry drops off when its status is Resolved or Reinstated.</div>`)}
      ${section('Inactive listings', '#001F60', inactiveHtml)}
      ${section('Seller Support cases', '#001F60', casesHtml(notices.cases, today, th, td))}
      ${section('New negative seller feedback', '#001F60', feedbackHtml)}
      <tr><td style="padding:14px 32px 24px;"><div style="font-size:11px;color:#9ba8c0;">Sources: Amazon's Account Health report and Walmart's Seller Performance API (30-day window), pulled each morning. Full history in the Account Health sheets.</div>
        ${test ? `<div style="font-size:11px;color:#9ba8c0;margin-top:4px;">TEST SEND — the real email goes to: ${test.map(esc).join(', ')}.</div>` : ''}</td></tr>
      <tr><td style="background:#001F60;padding:16px 32px;"><div style="padding-bottom:12px;"><img src="${LOGO_URL}" alt="Medaltus" height="22" style="height:22px;display:block;"></div>
        <span style="font-size:11px;color:#6B7BA2;">Medaltus automated report &middot; reports@medaltus.com</span></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// ── Sheets ─────────────────────────────────────────────────────────────────
// ── Amazon notices + Seller Support cases (ADDED 2026-11-18) ───────────────
function buildNotices(rows, master, today, since, manualRows = [], ctx = { live: new Map(), inactiveAsins: new Set(), shown: new Set() }) {
  const resolved = []; // auto-resolved this run (shown once)
  const asinInfo = a => master.get(a) || null;
  const label = list => list.map(a => { const m = asinInfo(a); return m ? `${a} · ${m.sku}${m.brand ? ' · ' + m.brand : ''}` : a; });
  const perf = rows.filter(r => r[15] === 'Performance / policy notice');
  const cutoff = `${addDaysIso(today, -NOTICE_OPEN_DAYS)} 00:00`;
  const shortAct = (r) => r[4] || 'Reply';
  // New since the last email
  const newNotices = perf.filter(r => r[0] > since).sort((a, b) => b[0].localeCompare(a[0]))
    .map(r => ({ when: r[0], type: r[3], action: r[4], asins: label(splitList(r[5])), ids: r[16], summary: niceSummary(r), subject: r[7], store: r[1] }));
  // Open issues: one row per ASIN (or per complaint / subject when no ASIN), last 90 days
  const groups = new Map();
  perf.filter(r => r[0] >= cutoff).forEach(r => {
    const keys = splitList(r[5]).length ? splitList(r[5]) : [r[16] || r[7]];
    keys.forEach(k => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  });
  const open = [];
  for (const [k, list] of groups) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
    const last = list[list.length - 1];
    if (/^Reinstated/i.test(last[3]) || /^Reinstated/i.test(last[4])) continue; // resolved
    // Latest notice that carried an action (case replies without one don't change the state).
    const lastAct = [...list].reverse().find(r => r[4]) || last;
    const isAsinKey = /^B0[A-Z0-9]{8}$/.test(k);
    // Rule 2: "at risk" with nothing worse after it, older than AT_RISK_DAYS → drops off.
    if (AT_RISK.test(lastAct[4]) && !DEACTIVATED.test(lastAct[4]) && lastAct[0] < `${addDaysIso(today, -AT_RISK_DAYS)} 00:00`) {
      resolved.push({ key: k, why: `No deactivation within ${AT_RISK_DAYS} days of the "at risk" notice`, type: last[3], lastWhen: last[0], logKey: `${k}|${lastAct[0]}` });
      continue;
    }
    const steps = []; list.forEach(r => { const st = `${shortAct(r)} ${fmtShort(r[0])}`; if (steps[steps.length - 1] !== st) steps.push(st); });
    const m = /^B0[A-Z0-9]{8}$/.test(k) ? asinInfo(k) : null;
    open.push({ key: k, isAsin: /^B0[A-Z0-9]{8}$/.test(k), sku: m ? m.sku : '', brand: m ? m.brand : '', product: m ? m.name : '', type: last[3], action: last[4],
      history: steps.slice(-4).join(' → '), ids: [...new Set(list.map(r => r[16]).filter(Boolean))].join(', '), summary: niceSummary(last), lastWhen: last[0], isNew: list.some(r => r[0] > since),
      lastActionWhen: lastAct[4] ? lastAct[0] : '', lastActionText: lastAct[4] || '' });
  }
  // Manual entries from the Account Health page: merged into the same ASIN's row, or added as their own.
  for (const r of manualRows) {
    const asin = String(r[2] || '').trim().toUpperCase();
    const status = String(r[7] || '').trim();
    if (!asin && !r[1]) continue;
    const when = looseDate(r[0]);
    if (MANUAL_DONE.test(status)) { // Rule 3: closes the captured notices for this ASIN…
      const i = asin ? open.findIndex(o => o.key === asin) : -1;
      // …unless Amazon acted again after this entry's date (a newer deactivation / warning reopens it).
      if (i >= 0 && !(open[i].lastActionWhen && when && open[i].lastActionWhen.slice(0, 10) > when)) open.splice(i, 1);
      continue;
    }
    const manual = { date: when, reason: String(r[1] || '').trim(), action: String(r[5] || '').trim(), status: status || 'Open',
      atRisk: String(r[6] || '').trim(), next: String(r[8] || '').trim(), notes: String(r[9] || '').trim() };
    const existing = asin && open.find(o => o.key === asin);
    if (existing) { existing.manual = manual; continue; }
    const m = /^B0[A-Z0-9]{8}$/.test(asin) ? asinInfo(asin) : null;
    open.push({ key: asin || manual.reason, isAsin: /^B0[A-Z0-9]{8}$/.test(asin), sku: String(r[3] || '').trim() || (m ? m.sku : ''), brand: m ? m.brand : '',
      product: String(r[4] || '').trim() || (m ? m.name : ''), type: manual.reason || 'Account Health item', action: manual.action,
      history: '', ids: '', summary: '', lastWhen: when || '', isNew: false, manual });
  }
  // Rule 1 (captured and manual alike): a deactivated / removed / suppressed listing that is
  // BUYABLE in today's Products Cache and not in today's inactive scan → resolved.
  for (let i = open.length - 1; i >= 0; i--) {
    const o = open[i];
    if (!o.isAsin) continue;
    const wasDown = DEACTIVATED.test(o.lastActionText || o.action || '') || (o.manual && DEACTIVATED.test(o.manual.action));
    const liveNow = ctx.live.get(o.key);
    if (wasDown && liveNow && liveNow.buyable && !ctx.inactiveAsins.has(o.key)) {
      resolved.push({ key: o.key, why: o.manual ? 'Listing active again — mark its manual entry Resolved' : 'Listing active again',
        type: o.type, lastWhen: o.lastWhen, logKey: `${o.key}|${o.lastActionWhen || o.lastWhen}`, manual: !!o.manual });
      open.splice(i, 1);
    }
  }
  open.sort((a, b) => b.lastWhen.localeCompare(a.lastWhen));
  // Seller Support cases, grouped by case number
  const caseRows = rows.filter(r => r[15] === 'Seller Support case');
  const byCase = new Map();
  caseRows.forEach(r => {
    const id = ((r[16] || '').match(/Case (\d+)/) || (r[7] || '').match(/\[CASE (\d+)\]|Case ID:\s*(\d+)/i) || []).slice(1).find(Boolean) || r[7].replace(/^(RE:|FW:)\s*/i, '');
    if (!byCase.has(id)) byCase.set(id, []); byCase.get(id).push(r);
  });
  const caseCutoff = `${addDaysIso(today, -CASE_OPEN_DAYS)} 00:00`;
  const cases = [];
  for (const [id, list] of byCase) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
    const first = list[0], last = list[list.length - 1];
    const resolved = /has been resolved|we (have )?resolved|case (has been |is )?(closed|resolved)|marked as resolved|reinstated/i.test(String(last[13] || '').slice(0, 3000));
    let state;
    if (first[0] > since) state = 'NEW';
    else if (resolved && last[0] > since) state = 'RESOLVED';
    else if (!resolved && last[0] >= caseCutoff) state = 'OPEN';
    else continue; // quiet for 30+ days, or resolved before the last email
    const asins = [...new Set(list.flatMap(r => splitList(r[5])))];
    cases.push({ id: /^\d+$/.test(id) ? id : '', state, title: cleanSubject(last[7]), asins: label(asins), messages: list.length,
      opened: first[0], lastWhen: last[0], updatedSince: last[0] > since && first[0] <= since, summary: niceSummary(last) });
  }
  const order = { NEW: 0, OPEN: 1, RESOLVED: 2 };
  cases.sort((a, b) => order[a.state] - order[b.state] || b.lastWhen.localeCompare(a.lastWhen));
  resolved.forEach(x => { const m = asinInfo(x.key); x.label = m && m.sku ? `${m.sku} (${x.key})` : x.key; });
  const resolvedNew = resolved.filter(x => !ctx.shown.has(x.logKey)); // one-time lines
  return { newNotices, open, cases, resolved: resolvedNew };
}
// First real sentence of the email: skips the subject echo, greetings and "my name is…" lines.
function niceSummary(r) {
  const subject = String(r[7] || '').trim();
  const body = String(r[13] || r[8] || '').split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 30 && p.split(' ').length >= 8 && !/<#|English \(United States\)|Deutsch|Español|Français|日本語/.test(p)
      && !/^(dear|hello|hi|greetings)\b/i.test(p) && !/^my name is/i.test(p) && p !== subject && !subject.startsWith(p.slice(0, 40)) && !/^\[?case/i.test(p));
  return (body[0] || r[8] || subject).replace(/<?https?:\/\/\S+>?/g, '').slice(0, 300);
}
// "11/14/2026", "Nov 14, 2026", "2026-11-14", or a Sheets date number → "2026-11-14".
function looseDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{5}$/.test(s) && +s > 40000 && +s < 60000) return new Date(Date.UTC(1899, 11, 30) + +s * 86400000).toISOString().slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s); return isNaN(d) ? s : d.toISOString().slice(0, 10);
}
const splitList = v => String(v || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
const cleanSubject = s => String(s || '').replace(/^((RE|FW|FWD):\s*)+/i, '').replace(/\[CASE \d+\]\s*/i, '').replace(/\[Case ID:\s*\d+\]\s*/i, '').trim();
function fmtShort(stamp) { const d = String(stamp).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? fmtDay(d, true) : stamp; }
function etStamp(d) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`; }
function addDaysIso(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// Which open issues go in which section (CHANGED 2026-11-18 per Jaclyn). Matched on the
// issue's type (captured notices) or its reason (manual entries).
const POLICY_GROUP = /restricted product|product safety|compliance doc|geographic sales|intellectual property|ip complaint|trademark complaint|infring/i;
const BRAND_REGISTRY_GROUP = /brand registry|trademark confirmation/i;
const groupOf = o => { const t = `${o.type} ${o.manual ? o.manual.reason : ''}`; return BRAND_REGISTRY_GROUP.test(t) ? 'brand' : POLICY_GROUP.test(t) ? 'policy' : 'other'; };

function resolvedLines(items) {
  if (!items.length) return '';
  return `<div style="font-size:12px;color:#1A7F5A;margin:0 0 8px;">${items.map(x => `✓ <b>${esc(x.label || x.key)}</b> — ${esc(x.why)} <span style="color:#9ba8c0;">(${esc(x.type)}, last email ${esc(fmtShort(x.lastWhen))})</span>`).join('<br>')}</div>`;
}
function noticesHtml(items, today, th, td, emptyText, resolvedItems = []) {
  const n = { open: items };
  const pill = (txt, bg, fg) => `<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:${bg};color:${fg};font-size:10px;font-weight:700;">${txt}</span>`;
  const newBlock = ''; // "New since the last email" removed 2026-11-18 per Jaclyn — open issues only
  const openBlock = n.open.length ? `<div style="font-size:12px;font-weight:700;color:#001F60;margin:2px 0 4px;">Open · ${n.open.length}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
      <tr><th style="${th}">Listing</th><th style="${th}">Latest</th><th style="${th}">History</th><th style="${th}">Reference</th></tr>
      ${n.open.map(o => `<tr style="background:#fff;">
        <td style="${td}">${o.isAsin ? `<b>${esc(o.sku || o.key)}</b> <span style="font-size:10px;color:#9ba8c0;">${esc(o.key)}</span>${o.brand || o.product ? `<div style="font-size:11px;color:#6B7BA2;">${esc([o.brand, o.product].filter(Boolean).join(' · '))}</div>` : ''}` : `<b>${esc(o.key)}</b>`}</td>
        <td style="${td}"><b>${esc(o.type)}</b>${o.action ? `<div style="font-size:11px;color:#C0392B;">${esc(o.action)}</div>` : ''}${o.manual ? `<div style="margin-top:4px;"><span style="display:inline-block;padding:1px 7px;border-radius:999px;background:#E8ECF7;color:#001F60;font-size:10px;font-weight:700;">Account Health page</span> <span style="font-size:11px;color:#7A5B00;font-weight:700;">${esc(o.manual.status)}</span></div>` : ''}</td>
        <td style="${td}font-size:11px;color:#3a4a6b;">${esc(o.history)}${o.manual ? `<div style="${o.history ? 'margin-top:3px;' : ''}">${esc([o.manual.reason && o.manual.reason !== o.type ? o.manual.reason : '', o.manual.date ? 'flagged ' + fmtShort(o.manual.date) : '', o.manual.action, o.manual.atRisk ? 'at-risk sales ' + o.manual.atRisk : ''].filter(Boolean).join(' · '))}</div>${o.manual.next || o.manual.notes ? `<div style="color:#6B7BA2;margin-top:2px;">${esc([o.manual.next ? 'Next: ' + o.manual.next : '', o.manual.notes].filter(Boolean).join(' · '))}</div>` : ''}` : ''}<div style="font-size:11px;color:#6B7BA2;margin-top:3px;">${esc(String(o.summary || '').slice(0, 260))}</div></td>
        <td style="${td}font-size:11px;color:#6B7BA2;white-space:nowrap;">${esc(o.ids || '')}</td></tr>`).join('')}</table>`
    : `<div style="font-size:12px;color:#1A7F5A;">${emptyText}</div>`;
  return resolvedLines(resolvedItems) + newBlock + openBlock;
}

function casesHtml(cases, today, th, td) {
  if (!cases.length) return `<div style="font-size:12px;color:#6B7BA2;">No new or open Seller Support cases (activity in the last ${CASE_OPEN_DAYS} days).</div>`;
  const pill = s => ({ NEW: ['#24E9A3', '#001F60'], OPEN: ['#FFE8A3', '#7A5B00'], RESOLVED: ['#D6F7EA', '#1A7F5A'] })[s];
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
    <tr><th style="${th}"></th><th style="${th}">Case</th><th style="${th}">Listings</th><th style="${th}">Latest reply</th><th style="${th}">Activity</th></tr>
    ${cases.map(c => { const [bg, fg] = pill(c.state); return `<tr>
      <td style="${td}white-space:nowrap;"><span style="display:inline-block;padding:1px 7px;border-radius:999px;background:${bg};color:${fg};font-size:10px;font-weight:700;">${c.state}</span>${c.updatedSince ? '<div style="font-size:10px;color:#C0392B;margin-top:3px;">new reply</div>' : ''}</td>
      <td style="${td}"><b>${esc(c.title)}</b>${c.id ? `<div style="font-size:10px;color:#9ba8c0;">Case ${esc(c.id)}</div>` : ''}</td>
      <td style="${td}font-size:11px;">${c.asins.length ? c.asins.map(esc).join('<br>') : '—'}</td>
      <td style="${td}font-size:11px;color:#3a4a6b;">${esc(String(c.summary || '').slice(0, 280))}</td>
      <td style="${td}font-size:11px;color:#6B7BA2;white-space:nowrap;">Opened ${esc(fmtShort(c.opened))}<br>Last ${esc(fmtShort(c.lastWhen))} · ${c.messages} email${c.messages === 1 ? '' : 's'}</td></tr>`; }).join('')}
  </table><div style="font-size:11px;color:#9ba8c0;margin-top:6px;">NEW = first email since the last Account Health email · OPEN = activity in the last ${CASE_OPEN_DAYS} days · RESOLVED = Amazon's latest reply says it's resolved (shown once).</div>`;
}

// Master SKU list (ASIN → SKU, brand, name), Amazon rows only.
async function loadMaster() {
  const id = process.env.SHEET_MASTER_SKU_LIST;
  if (!id) return new Map();
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${MASTER_GID}`);
  if (!r.ok) return new Map();
  const text = await r.text(); const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const col = (n, f) => { const i = head.indexOf(n); return i >= 0 ? i : f; };
  const iAsin = col('asin', 0), iSku = col('sku', 1), iName = col('product short name', 2), iBrand = col('brand', 3), iCh = col('channel', 6);
  const map = new Map();
  for (const r of rows.slice(1)) {
    const asin = String(r[iAsin] || '').trim().toUpperCase();
    if (!/^B0[A-Z0-9]{8}$/.test(asin) || !/amazon/i.test(String(r[iCh] || ''))) continue;
    if (!map.has(asin)) map.set(asin, { sku: String(r[iSku] || '').trim(), brand: String(r[iBrand] || '').trim(), name: String(r[iName] || '').trim() });
  }
  return map;
}

// Today's listing status per ASIN from the Products Cache (each brand tab's latest day).
async function loadLiveStatus() {
  const id = sheetsConfig.products;
  const map = new Map();
  if (!id) return map;
  const token = await getSheetsToken(id);
  const api = async path => { const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${path}`, { headers: { Authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error(`Products Cache ${r.status}`); return r.json(); };
  const letter = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  for (const b of brandsConfig.filter(x => x.active)) {
    try {
      const tab = `'${String(b.tabName).replace(/'/g, "''")}'`;
      const head = ((await api(`/values/${encodeURIComponent(tab + '!A1:ZZ1')}`)).values || [[]])[0].map(h => String(h).trim());
      const [iD, iA, iS] = ['date', 'asin', 'status'].map(h => head.indexOf(h));
      if (iD < 0 || iA < 0 || iS < 0) continue;
      const got = await api(`/values:batchGet?majorDimension=COLUMNS&${[iD, iA, iS].map(i => `ranges=${encodeURIComponent(`${tab}!${letter(i)}2:${letter(i)}`)}`).join('&')}`);
      const [dates, asins, statuses] = got.valueRanges.map(v => ((v.values || [[]])[0]) || []);
      const latest = dates.map(d => String(d).slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
      dates.forEach((d, i) => {
        if (String(d).slice(0, 10) !== latest) return;
        const asin = String(asins[i] || '').replace(/^'/, '').trim().toUpperCase();
        if (!asin) return;
        const buyable = /BUYABLE/i.test(String(statuses[i] || ''));
        const prev = map.get(asin);
        map.set(asin, { buyable: buyable || (prev && prev.buyable) || false, date: latest });
      });
    } catch (e) { /* a brand tab that can't be read just isn't checked */ }
  }
  return map;
}
async function appendLog(sheet, headers, rows) {
  const token = await getSheetsToken(sheet.id);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}`;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const meta = await (await fetch(`${base}?fields=sheets.properties(title)`, { headers: h })).json();
  if (!(meta.sheets || []).some(x => x.properties.title === sheet.tab)) {
    await fetch(`${base}:batchUpdate`, { method: 'POST', headers: h, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheet.tab } } }] }) });
    await fetch(`${base}/values/${encodeURIComponent(`'${sheet.tab}'!A1`)}?valueInputOption=RAW`, { method: 'PUT', headers: h, body: JSON.stringify({ values: [headers] }) });
  }
  await fetch(`${base}/values/${encodeURIComponent(`'${sheet.tab}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: h, body: JSON.stringify({ values: rows }) });
}

async function readTab(sheet) {
  const token = await getSheetsToken(sheet.id);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${encodeURIComponent(`'${sheet.tab}'!A2:ZZ`)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${sheet.tab}: ${res.status}`);
  const cols = { health_daily: [0], metrics_detail: [0], changes: [0, 8], seller_feedback: [7], inactive_listings: [0, 11], defect_orders: [0] }[sheet.tab] || [];
  const iso = v => (/^\d{5}$/.test(v) && +v > 40000 && +v < 60000 ? new Date(Date.UTC(1899, 11, 30) + +v * 86400000).toISOString().slice(0, 10) : v); // Sheets date numbers → YYYY-MM-DD
  return ((await res.json()).values || []).map(r => r.map((v, i) => { const s = String(v ?? ''); return cols.includes(i) ? iso(s) : s; }));
}
async function logSend(today, subject, id) {
  const token = await getSheetsToken(SHEETS.meta.id);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS.meta.id}`;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const meta = await (await fetch(`${base}?fields=sheets.properties(title)`, { headers: h })).json();
  if (!(meta.sheets || []).some(s => s.properties.title === SHEETS.meta.tab)) {
    await fetch(`${base}:batchUpdate`, { method: 'POST', headers: h, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEETS.meta.tab } } }] }) });
    await fetch(`${base}/values/${encodeURIComponent(`'${SHEETS.meta.tab}'!A1`)}?valueInputOption=RAW`, { method: 'PUT', headers: h, body: JSON.stringify({ values: [['date', 'sent_at', 'subject', 'message_id']] }) });
  }
  await fetch(`${base}/values/${encodeURIComponent(`'${SHEETS.meta.tab}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: h, body: JSON.stringify({ values: [[today, new Date().toISOString(), subject, id || '']] }) });
}
function todayEt() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
function fmtDay(iso, short) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', short ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
