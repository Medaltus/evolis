/**
 * api/_dates.js
 * ADDED 2026-10-06 — reads an order date in any shape it appears in the
 * sheets and returns it as YYYY-MM-DD, so date comparisons and month
 * grouping work regardless of how a given cell happens to be stored.
 *
 * Why this exists: the same orders tab can hold three different shapes —
 *   - "2026-05-22"  plain text, as sync-orders-process.js writes it
 *   - "5/22/2026"   text, after a cell got converted to a real date and a
 *                   whole-tab rewrite (fees-estimate, sale-promotions,
 *                   trim-orders) saved its displayed value back as text
 *   - a real date cell, read back in whatever display format the sheet
 *     uses ("5/22/2026", "May 22, 2026", "22-May-2026", "5/22/26", …)
 * Comparing those as raw text silently breaks: "4/15/2026" sorts after
 * "2026-06-08" and "10/5/2026" before it. Always normalize first.
 *
 * Slash/dash dates are read as US month-first (M/D/Y), matching the sheets'
 * US locale. Returns { iso: null } for anything it can't confidently read,
 * so callers can decide what's safe (trim-orders keeps those rows).
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function pad(n) { return String(n).padStart(2, '0'); }

function build(y, m, d, format) {
  if (y < 100) y += 2000;                                   // 26 → 2026
  if (m < 1 || m > 12 || d < 1 || d > 31) return { iso: null, format: 'unreadable' };
  if (y < 2000 || y > 2100) return { iso: null, format: 'unreadable' };
  return { iso: `${y}-${pad(m)}-${pad(d)}`, format };
}

// Returns { iso: 'YYYY-MM-DD' | null, format: <label of the shape it found> }.
function normalizeOrderDate(value) {
  if (value == null || value === '') return { iso: null, format: 'blank' };
  if (value instanceof Date && !isNaN(value)) {
    return build(value.getFullYear(), value.getMonth() + 1, value.getDate(), 'Date');
  }
  const str = String(value).trim();
  let m;

  // 2026-05-22, 2026-05-22T14:03:00Z, 2026/05/22
  if ((m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/))) return build(+m[1], +m[2], +m[3], 'YYYY-MM-DD');

  // 5/22/2026, 05/22/2026, 5/22/26, 5-22-2026 (US month-first)
  if ((m = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?!\d)/))) return build(+m[3], +m[1], +m[2], 'M/D/Y');

  // May 22, 2026 · Thursday, May 22, 2026 · Thu May 22 2026
  if ((m = str.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/))) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mo) return build(+m[3], mo, +m[2], 'Month D, Y');
  }

  // 22 May 2026 · 22-May-2026 · 22-May-26
  if ((m = str.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,9})\.?[\s\-,]+(\d{2,4})/))) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mo) return build(+m[3], mo, +m[1], 'D-Mon-Y');
  }

  // Raw Sheets date serial (days since 1899-12-30), e.g. 46164
  if (/^\d+(\.\d+)?$/.test(str)) {
    const serial = parseFloat(str);
    if (serial > 30000 && serial < 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      return build(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 'serial');
    }
  }

  return { iso: null, format: 'unreadable' };
}

// Convenience: just the YYYY-MM-DD string, or '' if unreadable.
function isoDate(value) {
  return normalizeOrderDate(value).iso || '';
}

// ── Pacific time (ADDED 2026-10-06) ─────────────────────────────────────────
// Amazon US runs its events (Prime Day, Prime Big Deal Days, BFCM…) and its
// Seller Central/ads day boundaries on Pacific time. These convert a Pacific
// calendar date to the exact UTC instants Amazon's APIs expect, handling
// daylight saving (PDT = UTC-7, PST = UTC-8) per date.
const PT = 'America/Los_Angeles';

// Hours Pacific is behind UTC on a given YYYY-MM-DD (7 in PDT, 8 in PST).
// Checked at noon UTC so the answer isn't thrown off by the 2 AM switch.
function ptOffsetHours(isoDay) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: PT, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(`${isoDay}T12:00:00Z`)).find(p => p.type === 'timeZoneName').value; // "GMT-7"
  return -parseInt(name.replace('GMT', ''), 10) || 8;
}

function addDays(isoDay, n) {
  const d = new Date(`${isoDay}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 00:00:00 Pacific on isoDay, as a UTC timestamp string ("…Z").
function ptStartOfDayUtc(isoDay) {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + ptOffsetHours(isoDay) * 3600000).toISOString().slice(0, 19) + 'Z';
}

// 23:59:59 Pacific on isoDay, as a UTC timestamp string ("…Z").
function ptEndOfDayUtc(isoDay) {
  return new Date(Date.parse(ptStartOfDayUtc(addDays(isoDay, 1))) - 1000).toISOString().slice(0, 19) + 'Z';
}

// The Pacific calendar date (YYYY-MM-DD) of a timestamp — e.g. an order's
// purchase-date of "2026-10-07T04:10:00+00:00" is 2026-10-06 in Pacific.
function ptDate(timestamp) {
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

module.exports = { normalizeOrderDate, isoDate, ptStartOfDayUtc, ptEndOfDayUtc, ptDate };
