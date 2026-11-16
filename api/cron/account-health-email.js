/**
 * api/cron/account-health-email.js
 * ADDED 2026-11-16 (per Jaclyn) — "Account Health" email for the whole team
 * (Ashley + every Brand Manager), styled like the other alert emails.
 * 8:00 AM Eastern, after sync-account-health.js's morning pull.
 *
 * Sends:
 *   - weekdays, only when something is NEW today: a metric / status / rating
 *     got worse ("changes" sheet), a listing policy issue first seen today
 *     ("listing_issues"), or new negative seller feedback ("seller_feedback");
 *   - every Monday, always — a weekly snapshot even when nothing changed.
 * Reads every set in SHEET_SETS (one per seller account group) and combines them.
 * Contents: a status card per account (status + Account Health Rating), what
 * changed (worse first), every metric that isn't healthy (value vs Amazon's
 * target), listings with policy issues (new ones flagged, days open), and new
 * negative seller feedback.
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
    issues:   { id: '1gsbzdc6AJMSyyTgEbc1Lh2ccEgSJLtwg1GK7To8sWgI', tab: 'listing_issues' },
    feedback: { id: '1sMJEdXewdG_PXzN_Saj-2Wkd9ozihBUXDGwwopS8YwQ', tab: 'seller_feedback' },
    changes:  { id: '1AjYkrA8INLdkTViF-Ve4poHtlDmXPgkYiDUpK5JPY2Q', tab: 'changes' },
  },
  { // 4th seller account (ADDED 2026-11-16) — same layout, written by its own sync-account-health.js
    health:   { id: '14zbDimNq2BQIRFu1dB5purlFjZVAWx2uneC2bniiFIE', tab: 'health_daily' },
    metrics:  { id: '16DQAvusbKxULEh1_Opzb_WjUc5S3ohUBAtN0xWQ4DU4', tab: 'metrics_detail' },
    issues:   { id: '16DQAvusbKxULEh1_Opzb_WjUc5S3ohUBAtN0xWQ4DU4', tab: 'listing_issues' },
    feedback: { id: '1Gk-fM_GIEYyZqmkGBzA17EneoXx6mxSioMOya5ztaSE', tab: 'seller_feedback' },
    changes:  { id: '1Id_oct_VhZUpUadsbwDPc9wsG7oWIe6ZG1eQ5DhC_Qc', tab: 'changes' },
  },
];
const SHEETS = { meta: { id: '1DhduU87hFgGOdsuK5XBBNRXVn4mpZzNkC1AKoDwhOnA', tab: 'email-log' } }; // send log lives with set 1
const TO = ['awilcox@medaltus.com', 'jsonberg@medaltus.com', 'ifernandez@medaltus.com', 'lrohde@medaltus.com'];
const FROM_EMAIL = process.env.FROM_EMAIL || 'reports@medaltus.com';
const REPLY_TO = 'reports@medaltus.com';
const LOGO_URL = 'https://vbcosmeticsreport.medaltus.com/api/medaltus-logo';
const ACCOUNT_ORDER = ['NewDerm|US', 'NewDerm|CA', 'High On Love|US']; // these first; any other account follows
const HEALTHY = /^(GOOD|GREAT|NONE|NORMAL|HEALTHY|)$/i;

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
};
const nameOf = m => NAMES[m] || m.replace(/\[\d+\]$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\./g, ' › ').replace(/^./, c => c.toUpperCase());
const isRate = m => /rate/i.test(m) && !/rating/i.test(m);

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
    const [metrics, issues, feedback, changes] = await Promise.all([all('metrics'), all('issues'), all('feedback'), all('changes')]);
    if (!testTo.length && !preview && !force) {
      const log = await read(SHEETS.meta);
      if (log.some(r => r[0] === today)) return res.status(200).json({ skipped: true, reason: `already sent today (${today})` });
    }

    // Latest snapshot per account
    const latestDate = (rows, acc, mkt) => rows.filter(r => r[1] === acc && r[2] === mkt).map(r => r[0]).sort().pop();
    const accounts = [...new Set(metrics.filter(r => r[1] && r[2]).map(r => `${r[1]}|${r[2]}`))]
      .sort((a, b) => ((ACCOUNT_ORDER.indexOf(a) + 1) || 99) - ((ACCOUNT_ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b))
      .map(k => k.split('|'));
    const cards = accounts.map(([acc, mkt]) => {
      const d = latestDate(metrics, acc, mkt);
      const rows = metrics.filter(r => r[0] === d && r[1] === acc && r[2] === mkt);
      const get = m => rows.find(r => r[3] === m) || [];
      return { acc, mkt, date: d, status: get('accountStatus')[4] || '—', ahr: get('accountHealthRating')[5] || '—', ahrStatus: get('accountHealthRating')[4] || '',
        attention: rows.filter(r => r[3] !== 'accountStatus' && !/\[\d+\]$/.test(r[3]) && !/\.(claims|chargebacks|negativeFeedback|orderWithDefects|invoiceDefect|missingInvoice|lateInvoice)$/.test(r[3]) && !HEALTHY.test(r[4] || ''))
          .map(r => ({ metric: r[3], status: r[4], value: r[5], target: r[6], cond: r[7], defects: r[8], from: r[10], to: r[11] })) };
    });
    const todays = changes.filter(r => r[0] === today);
    const worse = todays.filter(r => r[7] === 'worse');
    const issuesToday = latestIssues(issues);
    const newIssues = issuesToday.filter(r => r[12] === r[0]);
    const newFeedback = feedback.filter(r => r[7] === today);

    const somethingNew = worse.length || newIssues.length || newFeedback.length;
    if (!somethingNew && !monday && !force && !preview && !testTo.length) {
      return res.status(200).json({ sent: false, reason: 'nothing new today (weekday)', changesToday: todays.length });
    }

    const html = buildHtml({ today, monday, cards, todays, issuesToday, newIssues, newFeedback, test: testTo.length ? TO : null });
    if (preview) { res.setHeader('Content-Type', 'text/html'); return res.status(200).send(html); }
    if (!process.env.ALERTS_API_KEY) throw new Error('ALERTS_API_KEY is not set');
    const atRisk = cards.filter(c => !HEALTHY.test(c.status));
    const bits = [atRisk.length ? `${atRisk.map(c => `${c.acc} ${c.mkt}`).join(', ')} ${atRisk.length === 1 ? 'is' : 'are'} ${atRisk.map(c => c.status.replace(/_/g, ' ').toLowerCase())[0]}` : 'all accounts healthy',
      worse.length ? `${worse.length} change${worse.length === 1 ? '' : 's'} for the worse` : '', newIssues.length ? `${newIssues.length} new listing issue${newIssues.length === 1 ? '' : 's'}` : ''].filter(Boolean);
    const subject = `${testTo.length ? '[TEST] ' : ''}Account Health — ${bits.join(' · ')} · ${fmtDay(today)}`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.ALERTS_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Medaltus Reports <${FROM_EMAIL}>`, reply_to: REPLY_TO, to: testTo.length ? testTo : TO, subject, html }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
    if (!testTo.length) await logSend(today, subject, body.id);
    return res.status(200).json({ sent: true, test: !!testTo.length, to: testTo.length ? testTo : TO, subject, worse: worse.length, newIssues: newIssues.length, newFeedback: newFeedback.length });
  } catch (err) {
    console.error('[account-health-email]', err.message);
    await sendCronFailureAlert('account-health-email', err.message);
    return res.status(500).json({ error: err.message });
  }
};
const latestOf = rows => rows.map(r => r[0]).sort().pop();
// Latest listing_issues day PER ACCOUNT (sets can be pulled on different mornings).
const latestIssues = issues => {
  const last = {};
  issues.forEach(r => { const k = `${r[1]}|${r[2]}`; if (!last[k] || r[0] > last[k]) last[k] = r[0]; });
  return issues.filter(r => r[0] === last[`${r[1]}|${r[2]}`]);
};

// ── Email ──────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = v => { const n = parseFloat(v); return Number.isFinite(n) ? `${(n * 100).toFixed(n < 0.1 ? 2 : 1).replace(/\.0+$/, '')}%` : esc(v); };
const fmtVal = (m, v) => (v === '' || v == null ? '' : isRate(m) ? pct(v) : esc(v));
const statusPill = s => {
  const bad = /risk|bad|poor|fail|critical|suspend|deactivat/i.test(s), mid = /fair|warning|at_risk/i.test(s) && !/bad/i.test(s);
  const [bg, fg] = bad ? ['#FFD2CC', '#C0392B'] : mid ? ['#FFE8A3', '#7A5B00'] : ['#D6F7EA', '#1A7F5A'];
  return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:700;">${esc(String(s || '—').replace(/_/g, ' '))}</span>`;
};
const shortDate = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? fmtDay(m[0], true) : ''; };
const daysOpen = (first, today) => { const a = new Date(first + 'T12:00:00Z'), b = new Date(today + 'T12:00:00Z'); return Math.max(0, Math.round((b - a) / 86400000)); };

function buildHtml({ today, monday, cards, todays, issuesToday, newIssues, newFeedback, test }) {
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
  const attentionHtml = attention.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
      <tr><th style="${th}">Account</th><th style="${th}">Metric</th><th style="${th}">Status</th><th style="${th}">Now</th><th style="${th}">Amazon's target</th><th style="${th}">Period</th></tr>
      ${attention.map(a => `<tr><td style="${td}">${esc(a.acc)} ${esc(a.mkt)}</td><td style="${td}font-weight:700;">${esc(nameOf(a.metric))}</td><td style="${td}">${statusPill(a.status)}</td>
        <td style="${td}white-space:nowrap;">${a.defects !== '' && a.defects != null && !isRate(a.metric) ? `<b>${esc(a.defects)}</b>` : `<b>${fmtVal(a.metric, a.value)}</b>`}</td>
        <td style="${td}white-space:nowrap;color:#6B7BA2;">${a.target !== '' ? `${({ LESS_THAN: 'under', GREATER_THAN: 'over', EQUALS: '' })[a.cond] ?? ''} ${isRate(a.metric) ? pct(a.target) : esc(a.target)}` : '—'}</td>
        <td style="${td}white-space:nowrap;color:#6B7BA2;">${a.from ? `${shortDate(a.from)} – ${shortDate(a.to)}` : ''}</td></tr>`).join('')}</table>`
    : `<div style="font-size:12px;color:#1A7F5A;">Every metric on every account is healthy.</div>`;

  const issuesHtml = issuesToday.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
      <tr><th style="${th}"></th><th style="${th}">Listing</th><th style="${th}">Amazon's message</th><th style="${th}">Enforcement</th><th style="${th}">Open</th></tr>
      ${issuesToday.slice().sort((a, b) => (b[12] === b[0]) - (a[12] === a[0]) || (a[1] + a[3]).localeCompare(b[1] + b[3])).map(r => `<tr style="background:${r[12] === r[0] ? '#FFF8E6' : '#fff'};">
        <td style="${td}white-space:nowrap;">${r[12] === r[0] ? '<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:#24E9A3;color:#001F60;font-size:10px;font-weight:700;">NEW</span>' : ''}</td>
        <td style="${td}"><b>${esc(r[4])}</b> <span style="font-size:10px;color:#9ba8c0;">${esc(r[5])}</span><div style="font-size:11px;color:#6B7BA2;">${esc(r[3] || r[1])} · ${esc(r[1])} ${esc(r[2])}</div></td>
        <td style="${td}">${esc(r[8])}${r[6] ? `<div style="font-size:10px;color:#9ba8c0;">${esc(r[6])}</div>` : ''}</td>
        <td style="${td}font-size:11px;">${esc(String(r[11] || '').replace(/_/g, ' ').toLowerCase())}</td>
        <td style="${td}white-space:nowrap;color:#6B7BA2;">${r[12] ? `${daysOpen(r[12], today)} day${daysOpen(r[12], today) === 1 ? '' : 's'}` : ''}</td></tr>`).join('')}</table>
      <div style="font-size:11px;color:#9ba8c0;margin-top:4px;">Amazon's Account Health report gives violation counts only; these are the listings currently carrying policy or enforcement issues. Older, resolved violations only appear in Seller Central.</div>`
    : `<div style="font-size:12px;color:#1A7F5A;">No listings with policy or enforcement issues.</div>`;

  const feedbackHtml = newFeedback.length ? newFeedback.map(f => `<div style="border:1px solid #e4e8ef;border-left:4px solid #C0392B;border-radius:6px;padding:9px 12px;margin-bottom:6px;font-size:12px;color:#3a4a6b;">
      <b style="color:#001F60;">${esc(f[3])}★</b> · ${esc(f[1])} ${esc(f[2])} · ${esc(f[0])}${f[6] ? ` · order ${esc(f[6])}` : ''}<div style="margin-top:3px;">${esc(f[4])}</div></div>`).join('')
    : `<div style="font-size:12px;color:#1A7F5A;">No new negative seller feedback.</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:32px 0;"><tr><td align="center">
    <table width="1100" cellpadding="0" cellspacing="0" style="width:1100px;max-width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <tr><td style="background:#001F60;padding:24px 32px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#24E9A3;font-weight:700;">NewDerm &middot; Amazon Seller Accounts</div>
        <div style="font-size:24px;color:#fff;font-weight:700;margin-top:6px;font-family:Georgia,'Times New Roman',serif;">Account Health</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px;">${esc(fmtDay(today))}${monday ? ' &middot; weekly snapshot' : ''} &middot; ${cards.map(c => `${esc(c.acc)} ${esc(c.mkt)}`).join(', ')}</div>
      </td></tr>
      <tr><td style="padding:22px 32px 4px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>${cardHtml}</tr></table></td></tr>
      ${section('What changed since the previous snapshot', '#001F60', changesHtml)}
      ${section('Needs attention', '#C0392B', attentionHtml)}
      ${section('Listings with policy issues', '#001F60', issuesHtml)}
      ${section('New negative seller feedback', '#001F60', feedbackHtml)}
      <tr><td style="padding:14px 32px 24px;"><div style="font-size:11px;color:#9ba8c0;">Source: Amazon's Account Health report, pulled each morning. Full history in the Account Health sheets (Daily Health, Metrics Detail, Changes, Seller Feedback).</div>
        ${test ? `<div style="font-size:11px;color:#9ba8c0;margin-top:4px;">TEST SEND — the real email goes to: ${test.map(esc).join(', ')}.</div>` : ''}</td></tr>
      <tr><td style="background:#001F60;padding:16px 32px;"><div style="padding-bottom:12px;"><img src="${LOGO_URL}" alt="Medaltus" height="22" style="height:22px;display:block;"></div>
        <span style="font-size:11px;color:#6B7BA2;">Medaltus automated report &middot; reports@medaltus.com</span></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// ── Sheets ─────────────────────────────────────────────────────────────────
async function readTab(sheet) {
  const token = await getSheetsToken(sheet.id);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${encodeURIComponent(`'${sheet.tab}'!A2:ZZ`)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${sheet.tab}: ${res.status}`);
  return ((await res.json()).values || []).map(r => r.map(v => String(v ?? '')));
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
