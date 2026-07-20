// api/_ss.js — shared ShipStation V1 helper
//
// Adapted from the VB Cosmetics project's own _ss.js. Kept: the generic
// auth/fetch/date-range helpers, used as-is by sync-fulfillment-*.js.
// Removed: STORE_ID_MAP / STORE_DISPLAY / VBC_STORE_IDS / storeLabel /
// storeDisplayName — that's VB Cosmetics' own internal store
// segmentation (their literal numeric store IDs mapped to DTC/PRO/VVSC/
// Employee), specific to their ShipStation account. Nothing in this
// project's crons uses it, and Newderm has no confirmed equivalent, so
// it's left out rather than carried over unused.

const SS_BASE = 'https://ssapi.shipstation.com';

function ssAuth() {
  const key    = process.env.SS_API_KEY;
  const secret = process.env.SS_API_SECRET;
  if (!key || !secret) throw new Error('Missing SS_API_KEY or SS_API_SECRET env vars');
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

async function ssFetch(path) {
  const res = await fetch(`${SS_BASE}${path}`, {
    headers: { 'Authorization': ssAuth(), 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ShipStation ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Date helpers — all return YYYY-MM-DD strings
function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateStr(d);
}

function startOfYear() {
  return `${new Date().getFullYear()}-01-01`;
}

function startOfLastMonth() {
  const d = new Date();
  return toDateStr(new Date(d.getFullYear(), d.getMonth() - 1, 1));
}

function endOfLastMonth() {
  const d = new Date();
  // Day 0 of current month = last day of previous month
  return toDateStr(new Date(d.getFullYear(), d.getMonth(), 0));
}

// Parse range param → { since, until } — both are YYYY-MM-DD or null
function rangeParams(range) {
  switch (range) {
    case '7d':  return { since: daysAgo(7),         until: null };
    case '30d': return { since: daysAgo(30),         until: null };
    case 'mo':  return { since: startOfLastMonth(),  until: endOfLastMonth() };
    case '90d': return { since: daysAgo(90),         until: null };
    case 'yr':  return { since: startOfYear(),       until: null };
    default:    return { since: daysAgo(30),         until: null };
  }
}

function rangeDays(range) {
  return { '7d': 7, '30d': 30, 'mo': 30, '90d': 90, 'yr': 365 }[range] || 30;
}

module.exports = {
  ssFetch,
  daysAgo, rangeParams, rangeDays,
};
