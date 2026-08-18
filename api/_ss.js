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
//
// FIXED 2026-08-18 — every date-range helper below used to compute
// "today" via plain `new Date()`, which is UTC in Vercel's runtime, not
// Eastern. sync-fulfillment-daily-shipments.js's own header comment
// documents a real, already-encountered symptom of exactly this class of
// bug: "the bare-date version returned empty results for some (not all)
// dates for reasons never fully diagnosed" — that file fixed itself with
// a dedicated easternDateStr() function, but these SHARED helpers (used
// by sync-fulfillment-states.js and sync-fulfillment-kpis.js) never got
// the same treatment. UTC and Eastern differ by 4-5 hours, so any
// request made in the evening ET could compute a "30 days ago" (or
// start/end of month) boundary that's already rolled into the next UTC
// day — an intermittent, date-dependent, one-day-off boundary, which
// matches the shape of that undiagnosed symptom closely enough to be
// worth fixing here regardless of whether it's the exact same root
// cause. All date-range math below is now anchored to the Eastern
// calendar date, not the server's local (UTC) one.

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

// ── Eastern-anchored date helpers ────────────────────────────────────────

// Today's Eastern calendar date as {year, month, day} — month is 1-indexed.
function easternDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { year: parseInt(p.year, 10), month: parseInt(p.month, 10), day: parseInt(p.day, 10) };
}

// A Date object anchored to midnight UTC whose UTC fields equal the
// current Eastern calendar date — safe to run UTC-based arithmetic on
// (setUTCDate, getUTCMonth, etc.) without reintroducing any timezone
// confusion, since this object's UTC fields ARE the Eastern date already.
function easternAnchor(date = new Date()) {
  const { year, month, day } = easternDateParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

// All date helpers below return YYYY-MM-DD strings
function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = easternAnchor();
  d.setUTCDate(d.getUTCDate() - n);
  return toDateStr(d);
}

function startOfYear() {
  const { year } = easternDateParts();
  return `${year}-01-01`;
}

function startOfLastMonth() {
  const { year, month } = easternDateParts();
  return toDateStr(new Date(Date.UTC(year, month - 2, 1)));
}

function endOfLastMonth() {
  const { year, month } = easternDateParts();
  // Day 0 of the current month (0-indexed) = last day of the previous month.
  return toDateStr(new Date(Date.UTC(year, month - 1, 0)));
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
