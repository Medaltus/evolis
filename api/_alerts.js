// api/_alerts.js
//
// Shared failure-alerting helper for crons and background email sends.
// Uses its own dedicated Resend key/recipient pair — deliberately NOT
// shared with any of the report emails — so an alert can still go out
// even if the failure that triggered it was caused by a different
// email's own key, or by the shared Google Sheets quota.
//
// Usage (inside any catch block):
//   const { sendCronFailureAlert } = require('./_alerts');
//   await sendCronFailureAlert('sync-products', err.message);
//
// This function never throws — a failure inside the alerting itself only
// logs a warning, so it can never mask or replace the original error.
//
// Required env vars (set these in the evolis Vercel project — they do
// NOT carry over from the VB Cosmetics project):
//   CRON_ALERTS_RESEND_API_KEY
//   CRON_ALERTS_RECIPIENTS — comma-separated

const INSTRUCTIONS_URL = 'https://docs.google.com/document/d/1eR41bQVQtP4PJMyX5P0Pa3yS6e_1SOTgW7wec3xJcW4/edit?tab=t.0';

async function sendCronFailureAlert(sourceName, errorMessage, extra = {}) {
  try {
    const recipients = (process.env.CRON_ALERTS_RECIPIENTS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!recipients.length) {
      console.warn(`[_alerts] CRON_ALERTS_RECIPIENTS is empty — cannot send failure alert for "${sourceName}"`);
      return;
    }
    if (!process.env.CRON_ALERTS_RESEND_API_KEY) {
      console.warn(`[_alerts] CRON_ALERTS_RESEND_API_KEY is not set — cannot send failure alert for "${sourceName}"`);
      return;
    }

    const now = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'
    });

    const extraRows = Object.entries(extra || {})
      .map(([k, v]) => `<tr><td style="padding:6px 0;color:#666;font-size:12px;width:120px">${k}</td><td style="padding:6px 0;font-size:12px;color:#001F60">${v}</td></tr>`)
      .join('');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#a02828;padding:18px 22px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:16px">⚠ NEWDERM Cron Failure — ${sourceName}</h2>
        </div>
        <div style="background:#f8f9fa;padding:20px 22px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px">
          <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
            <tr><td style="padding:6px 0;color:#666;font-size:12px;width:120px">Cron</td><td style="padding:6px 0;font-size:12px;color:#001F60;font-weight:600">${sourceName}</td></tr>
            <tr><td style="padding:6px 0;color:#666;font-size:12px;width:120px">Failed At</td><td style="padding:6px 0;font-size:12px;color:#001F60">${now} ET</td></tr>
            ${extraRows}
          </table>
          <p style="margin:0 0 6px;font-size:12px;color:#666;font-weight:600">Error</p>
          <pre style="margin:0;padding:12px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;font-size:11px;color:#a02828;white-space:pre-wrap;word-break:break-word">${String(errorMessage).slice(0, 2000)}</pre>
          <p style="margin:16px 0 0;">
            <a href="${INSTRUCTIONS_URL}" style="font-size:12.5px;color:#001F60;font-weight:600;text-decoration:none;">
              📋 Manual Fix Instructions →
            </a>
          </p>
          <p style="margin:14px 0 0;font-size:11px;color:#999">Sent by the shared failure-alert helper (api/_alerts.js) · Medaltus · NEWDERM</p>
        </div>
      </div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CRON_ALERTS_RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'Medaltus Alerts <reports@medaltus.com>',
        to:      recipients,
        subject: `⚠ NEWDERM Cron Failure — ${sourceName}`,
        html,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`[_alerts] Failed to send failure alert for "${sourceName}":`, data?.message || res.status);
    } else {
      console.log(`[_alerts] Failure alert sent for "${sourceName}", id: ${data.id}`);
    }
  } catch (err) {
    // Alerting must never throw — that would mask the original error
    // that triggered it in the first place.
    console.error('[_alerts] sendCronFailureAlert threw:', err.message);
  }
}

module.exports = { sendCronFailureAlert };
