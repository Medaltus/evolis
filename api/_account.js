/**
 * api/_account.js
 * ADDED 2026-10-05 — shared seller-account helpers for every Amazon cron.
 *
 * Each Amazon cron runs once per seller account: the existing schedule entry
 * (no query param) is NewDerm, and a second, staggered vercel.json entry with
 * ?account=hol is High On Love. Every Amazon cron uses these helpers the same
 * way, so the per-cron change is small and identical:
 *
 *   const { getAccount, brandsForAccount, metaTabFor, cronLabel } = require('../_account');
 *
 *   const account = getAccount(req);              // 'newderm' (default) or 'hol'
 *   const META_TAB = metaTabFor(account);         // '_meta' or '_meta_hol'
 *   const activeBrands = brandsForAccount(account);
 *   await spRequest('GET', path, query, body, account);
 *   await sendCronFailureAlert(cronLabel('sync-orders-request', account), ...);
 *
 * Why a separate _meta tab per account: request/process cron pairs store the
 * pending report ID, cursors and status in _meta. Two accounts writing the
 * same keys would overwrite each other's report IDs. Giving High On Love its
 * own '_meta_hol' tab rules that out without renaming any existing NewDerm
 * key, so NewDerm's existing state is untouched.
 *
 * Sheet-only crons (no Amazon calls) don't need any of this — they just keep
 * looping active brands and pick up High On Love automatically.
 */

const brands = require('./config/brands');
const { SELLER_ACCOUNTS } = require('./_spauth');

const DEFAULT_ACCOUNT = 'newderm';

// Reads ?account= from the request. Missing = NewDerm, so every existing
// schedule entry and manual curl keeps working unchanged. An unknown value
// throws instead of silently falling back to NewDerm.
function getAccount(req) {
  const raw = ((req && req.query && req.query.account) || DEFAULT_ACCOUNT).trim().toLowerCase();
  if (!SELLER_ACCOUNTS.includes(raw)) {
    const err = new Error(`Unknown account "${raw}" — expected one of: ${SELLER_ACCOUNTS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return raw;
}

// Active brands that sell under this account. A brand with no sellerAccount
// field belongs to NewDerm.
function brandsForAccount(account = DEFAULT_ACCOUNT, { includeInactive = false } = {}) {
  return brands.filter(b =>
    (includeInactive || b.active) &&
    (b.sellerAccount || DEFAULT_ACCOUNT) === account
  );
}

// NewDerm keeps the existing tab name; other accounts get their own tab.
function metaTabFor(account = DEFAULT_ACCOUNT, baseTab = '_meta') {
  return account === DEFAULT_ACCOUNT ? baseTab : `${baseTab}_${account}`;
}

// Cron name for logs and failure alerts, so a High On Love failure is
// labeled as such instead of looking like a NewDerm one.
function cronLabel(cronName, account = DEFAULT_ACCOUNT) {
  return account === DEFAULT_ACCOUNT ? cronName : `${cronName} [${account}]`;
}

module.exports = { DEFAULT_ACCOUNT, getAccount, brandsForAccount, metaTabFor, cronLabel };
