/**
 * api/cron/sync-advertising-backfill.js
 * One-time manual trigger — pulls 13 months of advertising history.
 * Run once to seed the advertising sheets, then leave unused.
 *
 * Trigger manually:
 *   curl https://evolis-xi.vercel.app/api/cron/sync-advertising-backfill \
 *     -H "Authorization: Bearer r29fu&7S;gq@$bOw"
 *
 * This is intentionally separate from the daily sync-advertising.js cron
 * because 13 months × 2 report types takes 10–20 minutes to complete.
 * maxDuration: 300 means it will process as many months as it can and
 * log which ones completed — re-run if needed until all months are covered.
 */

// Re-uses all logic from sync-advertising.js — just calls with 13 months
const syncAdvertising = require('./sync-advertising');

module.exports = async (req, res) => {
  // Temporarily override the month count via query param if needed
  req.query = { ...req.query, months: req.query.months || '13' };
  return syncAdvertising(req, res);
};
