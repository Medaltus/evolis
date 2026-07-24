/**
 * api/test-alert.js
 * One-off manual test for the shared failure-alert helper (api/_alerts.js).
 * Does nothing except send a test email — no sheets, no SP-API, no real
 * cron logic touched. Safe to call as many times as needed.
 *
 * GET /api/test-alert
 * Authorization: Bearer <CRON_SECRET>
 *
 * NOT added to vercel.json — manual trigger only, never runs on a schedule.
 * Safe to delete once you've confirmed the email arrives, or just leave it —
 * it's harmless and not publicly triggerable without CRON_SECRET.
 */

const { sendCronFailureAlert } = require('./_alerts');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await sendCronFailureAlert(
    'test-alert',
    'This is a manual test triggered via /api/test-alert — not a real cron failure. If this email arrived, CRON_ALERTS_RESEND_API_KEY and CRON_ALERTS_RECIPIENTS are correctly configured for evolis.',
    {
      'Triggered at': new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    }
  );

  // sendCronFailureAlert never throws (by design — see _alerts.js), so this
  // 200 only confirms the function ran, not that the email actually sent.
  // Check your inbox, or the Vercel function logs for this request for one
  // of two lines: "[_alerts] Failure alert sent for ..." (success) or
  // "[_alerts] Failed to send failure alert for ..." / "...cannot send
  // failure alert..." (env vars missing or Resend rejected it).
  res.status(200).json({ ok: true, message: 'Test alert dispatched — check inbox and Vercel logs to confirm.' });
};
