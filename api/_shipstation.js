/**
 * api/_shipstation.js
 * ADDED 2026-10-12 — one place for every ShipStation call to go through.
 *
 * Why: the Évolis and VBC projects share ONE ShipStation API key, and
 * ShipStation's rate limit is per account — every call from both projects
 * counts against the same per-minute limit (V2: 200/min per ShipStation's
 * docs; the older V1 API's limit is lower). Before this, each cron called
 * fetch() directly and treated a 429 "Too Many Requests" as a hard failure
 * (e.g. sync-fulfillment-kpis, 2026-10-07: 5 of 8 brands failed).
 *
 * What it does:
 *   - On 429, waits exactly as long as ShipStation says — the Retry-After
 *     header (V2) or X-Rate-Limit-Reset (V1) — plus a little random jitter
 *     so several calls don't all retry in the same instant, then retries.
 *     Up to MAX_RETRIES times; each wait is capped at MAX_WAIT_S.
 *   - When a response says only a couple of requests are left in the
 *     current window (X-Rate-Limit-Remaining, V1), it pauses until the
 *     window resets BEFORE the next call, instead of running into a 429.
 *   - Everything else (non-429 errors) is returned as-is for the caller to
 *     handle, exactly like plain fetch().
 *
 *   const { ssFetch } = require('../_shipstation');
 *   const res = await ssFetch(url, { headers: { 'API-Key': token } });
 *
 * The VBC project can drop this same file into its own api/ folder — the
 * shared key means its calls matter just as much.
 */

const MAX_RETRIES   = 4;
const MAX_WAIT_S    = 65;   // ShipStation windows are per minute
const DEFAULT_WAIT_S = 10;  // if a 429 arrives without any timing header
const LOW_REMAINING = 2;    // proactively pause when this few requests are left

let pauseUntil = 0; // shared by every call in this invocation

const sleep = ms => new Promise(r => setTimeout(r, ms));

function headerSeconds(res, names) {
  for (const n of names) {
    const v = res.headers.get(n);
    if (v != null && v !== '' && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

async function ssFetch(url, options = {}, label = 'ShipStation') {
  for (let attempt = 0; ; attempt++) {
    const wait = pauseUntil - Date.now();
    if (wait > 0) await sleep(wait);

    const res = await fetch(url, options);

    // Proactive slow-down (V1 sends these headers on every response).
    const remaining = headerSeconds(res, ['x-rate-limit-remaining', 'x-ratelimit-remaining']);
    const resetS    = headerSeconds(res, ['x-rate-limit-reset', 'x-ratelimit-reset']);
    if (remaining != null && remaining <= LOW_REMAINING && resetS != null) {
      pauseUntil = Math.max(pauseUntil, Date.now() + Math.min(resetS, MAX_WAIT_S) * 1000);
    }

    if (res.status !== 429) return res;

    if (attempt >= MAX_RETRIES) {
      console.warn(`[shipstation] ${label} — still rate-limited after ${MAX_RETRIES} retries, giving up`);
      return res; // caller handles it as before (status 429)
    }
    const waitS = Math.min(
      headerSeconds(res, ['retry-after', 'x-rate-limit-reset', 'x-ratelimit-reset']) ?? DEFAULT_WAIT_S,
      MAX_WAIT_S
    );
    const jitterMs = Math.floor(Math.random() * 1500);
    console.warn(`[shipstation] ${label} — 429, waiting ${waitS}s before retry ${attempt + 1}/${MAX_RETRIES}`);
    pauseUntil = Math.max(pauseUntil, Date.now() + waitS * 1000 + jitterMs);
  }
}

module.exports = { ssFetch };
