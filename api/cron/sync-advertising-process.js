/**
 * api/cron/sync-advertising-process.js
 * Step 2 of 2 — polls for completed ad reports and writes data to sheets.
 * Runs at 3:15 AM UTC daily (15 minutes after sync-advertising-request).
 *
 * Reads 6 report IDs from SHEET_ADVERTISING → _meta tab:
 *   ad_report_id_asin_curr / ad_report_id_sp_curr / ad_report_id_sb_curr
 *   ad_report_id_asin_prev / ad_report_id_sp_prev / ad_report_id_sb_prev
 *
 * Writes to:
 *   SHEET_ADVERTISING  → one tab per brand, one row per month (upsert by year+month)
 *                        SP + SB campaign data merged into single row
 *   SHEET_AD_ORDERS    → one tab per brand, one row per ASIN per month (SP only)
 */

const { getAdToken }                                   = require('../_spauth');
const { ensureTab, readRows, replaceRows, appendRows, updateRange } = require('../config/_sheets_client');
const brands                                           = require('../config/brands');
const { sendCronFailureAlert }                         = require('../_alerts');
const https                                            = require('https');
const zlib                                             = require('zlib');

const AD_API_HOST      = 'advertising-api.amazon.com';
const SHEET_AD_SUMMARY = process.env.SHEET_ADVERTISING;
const SHEET_AD_ORDERS  = process.env.SHEET_AD_ORDERS || '1N30haUFZkdv9rrvYuWwUhxEm0z7MGp1bz9F462aF-QI';
const META_TAB         = '_meta';
const META_HEADERS     = ['KEY', 'VALUE', 'UPDATED_AT'];
const TRIM_YEARS       = 3;

const SUMMARY_HEADERS = [
  'year', 'month', 'impressions', 'clicks', 'spend', 'sales',
  'acos', 'roas', 'ad_units', 'ctr', 'cpc', 'brand', 'last_updated',
  // ADDED 2026-09-04 — PPC Ad Type Snapshot card breakdown. Derived from
  // the SAME spCampaigns/sbCampaigns/sdCampaigns report data already
  // being requested and downloaded above for the blended columns — no
  // new report requests needed, see brandTypeTotals below. campaigns_running
  // is the one genuinely new API surface (campaign LISTING, not reporting
  // — see getEnabledCampaignCountsByBrand for confidence caveats per ad
  // type, SB and SD specifically are NOT yet confirmed against a real
  // response).
  'sp_spend', 'sp_sales', 'sp_ad_units', 'sp_acos', 'sp_campaigns_running',
  'sb_spend', 'sb_sales', 'sb_ad_units', 'sb_acos', 'sb_campaigns_running',
  'sd_spend', 'sd_sales', 'sd_ad_units', 'sd_acos', 'sd_campaigns_running',
];
const ASIN_HEADERS = [
  'year', 'month', 'asin', 'ad_units', 'spend', 'sales',
  'acos', 'brand', 'last_updated', 'date',
];

const POLL_TIMEOUT_MS  = 240_000;
const POLL_INTERVAL_MS = 10_000;

// Google Sheets throttling — this cron does an ensureTab + readRows +
// replaceRows for every brand tab, twice (curr + prev), across BOTH the
// ASIN-level write (5a) and summary write (5b) loops below. With 15 active
// brands that's roughly 60+ per-tab Sheets operations fired back-to-back.
// Each "operation" is actually 2 *read* calls (ensureTab's existence check
// + readRows), so a 1000ms stagger — the original fix attempt — was still
// pushing ~2 reads/sec = ~120 reads/min against Sheets' default 60
// "Read requests per minute per user" quota. That undercount is what let
// the 429 RESOURCE_EXHAUSTED on 2026-08-13 through despite the stagger
// already being in place (first seen 2026-08-04). Two changes:
//   1. ensuredTabsThisRun (below) skips the redundant ensureTab existence
//      check on the second period for a tab we already ensured this run —
//      headers/tab-existence can't change mid-run, so this is safe and
//      cuts reads for repeat tabs from 2/iteration to 1.
//   2. Stagger raised to 2500ms so that even the *first* pass through a
//      tab (ensureTab + readRows = 2 reads) stays under ~50 reads/min,
//      leaving headroom for other crons sharing the same Sheets quota.
// At ~90 iterations total across both loops/periods this adds up to ~3.75
// min, still inside the 5min function budget seen in the Vercel logs.
// Not independently confirmed against Google's actual per-project quota —
// watch logs for further 429s. If they persist, request a quota increase
// in Google Cloud Console (APIs & Services → Sheets API → Quotas) rather
// than continuing to stretch the stagger, since other crons hitting the
// same sheets in the same minute count against this same bucket.
const SHEET_WRITE_STAGGER_MS = 2500;

// FIXED 2026-08-14 — this list is a hand-maintained duplicate of
// config/brands.js's active brand list, kept separate (not derived
// dynamically) because several entries are deliberately hand-tuned to
// real observed Amazon Ads campaign naming that doesn't match the
// brand's id/tabName at all ("the creme shop", "pb & jay", "skinside
// seoul" with a space). A full dynamic derivation from brands.js risked
// silently breaking those already-correct, non-obvious matches.
//
// The cost of keeping it hand-maintained: it silently drifted out of
// sync TWICE on 2026-08-14 — missing both 'cosmette' (added to
// brands.js that morning, meaning every Cosmette ad campaign had been
// falling into "unmatched campaign" and never syncing at all) and
// 'skinuva-ca' (meaning any Canada-specific campaign could only ever
// match plain skinuva, never its own tab). Both are now resolved:
//   - cosmette: added to this list directly, CONFIRMED 2026-08-21
//     against real campaign names ("Cosmette - SP - Auto - ...",
//     screenshot from Jaclyn — 6 real campaigns, all matching).
//   - skinuva-ca: the three guessed campaign-name variants first added
//     here ("skinuva ca", "skinuva-ca", "skinuva canada") were confirmed
//     WRONG once real Canada ads actually launched (2026-08-19) — real
//     names look like "Skinuva - SP - Scar - Auto - CANADA 7.26", never
//     matching any of those three guesses. Removed from this list
//     entirely and replaced with an explicit special-case check in
//     identifyBrand() below, confirmed working against real data.
// The runtime check right after this list makes sure a future brand
// addition can't repeat this same silent gap — it'll show up loudly in
// the logs instead.
const CAMPAIGN_BRANDS = [
  { name: 'skinuva',        tabName: 'skinuva'        },
  { name: 'the creme shop', tabName: 'creme-shop'     },
  { name: 'cloud cafe',     tabName: 'cloud-cafe'     },
  { name: 'just bjorn',     tabName: 'just-bjorn'     },
  { name: 'pb & jay',       tabName: 'pbj'            },
  { name: 'pb&jay',         tabName: 'pbj'            },
  { name: 'miguard',        tabName: 'miguard'        },
  { name: 'dearcloud',      tabName: 'dearcloud'      },
  { name: 'eraclea',        tabName: 'eraclea'        },
  { name: 'evolis',         tabName: 'evolis'         },
  { name: 'amala',          tabName: 'amala'          },
  { name: 'cimeosil',       tabName: 'cimeosil'       },
  { name: 'collagelee',     tabName: 'collagelee'     },
  { name: 'hillside',       tabName: 'hillside'       },
  { name: 'prohibition',    tabName: 'prohibition'    },
  { name: 'skinside seoul', tabName: 'skinside-seoul' },
  { name: 'skinside-seoul', tabName: 'skinside-seoul' },
  { name: 'cosmette',       tabName: 'cosmette'       }, // CONFIRMED 2026-08-21 — real campaigns are "Cosmette - SP - Auto - ..." (6 campaigns, screenshot from Jaclyn)
].sort((a, b) => b.name.length - a.name.length);

// Loudly flags any active brand this hand-maintained list has fallen out
// of sync with, so a future brand addition can't repeat today's silent
// gap. Runs once per invocation, cheap (brands.js is tiny).
// skinuva-ca is handled via the explicit special case in identifyBrand()
// below, not a CAMPAIGN_BRANDS entry (see that function's comment) — so
// it's excluded here too, to avoid a false "missing" warning every run.
(function checkCampaignBrandsCoverage() {
  const coveredTabNames = new Set([...CAMPAIGN_BRANDS.map(b => b.tabName), 'skinuva-ca']);
  const missing = brands.filter(b => b.active && !coveredTabNames.has(b.tabName));
  if (missing.length > 0) {
    console.error(`[sync-advertising-process] CAMPAIGN_BRANDS is missing ${missing.length} active brand(s): ${missing.map(b => b.id).join(', ')} — their ad campaigns will fall into "unmatched campaign" and never sync until added to CAMPAIGN_BRANDS in this file.`);
  }
})();

// Strips accents/diacritics so "évolis", "ÉVOLIS", and "evolis" all match
// the same way. Lowercasing alone isn't enough — 'évolis'.includes('evolis')
// is false, since é and e are different characters even after lowercasing.
// FIXED 2026-07-09 — campaign names were confirmed to use a mix of
// evolis/Evolis/évolis, which this was previously silently dropping into
// "unmatched campaign" for the accented variants.
function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ADDED 2026-08-14 — shared-SKU-prefix disambiguation (skinuva/skinuva-ca
// share prefix 'SVA' on purpose). Same pattern used in sync-orders-
// process.js, sync-revenue-process.js, sync-returns-process.js,
// sync-sqp-request.js, and sync-products.js — kept identical for
// consistency across the codebase.
const CA_SKU_PATTERN = /-CA(-|\.|$)/i;

function resolveBrandForSku(sku, candidates) {
  if (candidates.length === 1) return candidates[0];
  const isCa    = CA_SKU_PATTERN.test(sku);
  const caBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.ca');
  const usBrand = candidates.find(b => (b.salesChannel || '').toLowerCase() === 'amazon.com');
  if (isCa && caBrand) return caBrand;
  if (!isCa && usBrand) return usBrand;
  return usBrand || candidates[0];
}

// FIXED 2026-08-19 — the three guessed skinuva-ca campaign name variants
// ("skinuva ca", "skinuva-ca", "skinuva canada") were confirmed WRONG
// against real Canadian campaign data once CA ads actually launched
// (test-ca-ad-campaigns.js): real names look like "Skinuva - SP - Scar -
// Auto - CANADA 7.26" — "CANADA" sits at the END, separated from
// "Skinuva" by several other segments (ad type, category, targeting
// mode), never adjacent. None of the guessed variants are contiguous
// substrings of this, so they never matched anything — meanwhile the
// plain "skinuva" entry DOES trivially match (it's a substring of the
// whole name), meaning real Canadian ad spend/sales were being silently
// attributed to skinuva US this whole time. This checks for "skinuva"
// AND "canada" appearing ANYWHERE in the name (not contiguous) — a
// combined check the simple CAMPAIGN_BRANDS substring-list design can't
// express on its own, so it runs as an explicit override BEFORE that
// list, the same way Skinuva already needed other special-case handling
// elsewhere in this project (P-/S-/I- SKU prefixes, marketing-material
// name matching in sync-cin7-consignment-inventory.js).
function identifyBrand(campaignName) {
  const normalized = stripAccents((campaignName || '').toLowerCase());
  if (normalized.includes('skinuva') && normalized.includes('canada')) return 'skinuva-ca';
  const match = CAMPAIGN_BRANDS.find(b => normalized.includes(b.name));
  return match ? match.tabName : null;
}

// ── Campaign counts (currently ENABLED) per ad type — ADDED 2026-09-04 ──────
// For the PPC Ad Type Snapshot card's "# of Campaigns Running" metric. This
// is a snapshot of campaign STATE, not performance data, so it needs the
// campaign LISTING endpoints — a completely separate Ads API surface from
// the Reporting API everything else in this file uses. Fetched ONCE per
// run (not once per period) since "currently enabled" means the same thing
// regardless of which month's row it ends up attached to.
//
// CONFIDENCE LEVELS — read before trusting these numbers:
//   SP: reasonably confident — POST /sp/campaigns/list with a stateFilter
//       body is a directly-documented v3 pattern.
//   SB: BEST EFFORT, NOT CONFIRMED against a real response. Guessed from
//       the same "POST .../list with stateFilter" convention used
//       elsewhere in this API, following this file's own established
//       practice of verifying a new endpoint with a one-off test-*.js
//       script before trusting it in production (see CAMPAIGN_BRANDS'
//       history, sdCampaigns, the 7-day attribution fix) — that
//       verification hasn't happened yet for this specific endpoint.
//   SD: BEST EFFORT, NOT CONFIRMED, same caveat as SB.
// Each ad type's call is independently wrapped so a wrong guess for SB or
// SD doesn't take down SP's (or the rest of the run's) numbers — same
// "additive, non-blocking" philosophy already used for SD elsewhere here.
async function getEnabledCampaignCountsByBrand(token, profileId) {
  const counts = {}; // tabName -> { sp: n, sb: n, sd: n }
  const bump = (tabName, key) => {
    if (!counts[tabName]) counts[tabName] = { sp: 0, sb: 0, sd: 0 };
    counts[tabName][key]++;
  };

  try {
    const spCampaigns = await listAllPages(nextToken => listCampaignsPage(
      '/sp/campaigns/list', token, profileId, 'application/vnd.spCampaign.v3+json', nextToken));
    spCampaigns.forEach(c => { const t = identifyBrand(c.name || c.campaignName); if (t) bump(t, 'sp'); });
    console.log(`[sync-advertising-process] SP enabled campaigns fetched: ${spCampaigns.length}`);
  } catch (err) {
    console.warn('[sync-advertising-process] SP campaign count fetch failed (sp_campaigns_running blank this run):', err.message);
  }

  try {
    const sbCampaigns = await listAllPages(nextToken => listCampaignsPage(
      '/sb/v4/campaigns/list', token, profileId, 'application/vnd.sbcampaignresource.v4+json', nextToken));
    sbCampaigns.forEach(c => { const t = identifyBrand(c.name || c.campaignName); if (t) bump(t, 'sb'); });
    console.log(`[sync-advertising-process] SB enabled campaigns fetched: ${sbCampaigns.length}`);
  } catch (err) {
    console.warn('[sync-advertising-process] SB campaign count fetch failed — endpoint shape not yet confirmed, see header comment (sb_campaigns_running blank this run):', err.message);
  }

  try {
    const sdCampaigns = await listAllPages(nextToken => listCampaignsPage(
      '/sd/campaigns/list', token, profileId, 'application/vnd.sdcampaign.v3+json', nextToken));
    sdCampaigns.forEach(c => { const t = identifyBrand(c.name || c.campaignName); if (t) bump(t, 'sd'); });
    console.log(`[sync-advertising-process] SD enabled campaigns fetched: ${sdCampaigns.length}`);
  } catch (err) {
    console.warn('[sync-advertising-process] SD campaign count fetch failed — endpoint shape not yet confirmed, see header comment (sd_campaigns_running blank this run):', err.message);
  }

  return counts;
}

async function listCampaignsPage(path, token, profileId, contentType, nextToken) {
  const resp = await adRequestJson('POST', path, token, profileId,
    { stateFilter: { include: ['ENABLED'] }, maxResults: 200, ...(nextToken ? { nextToken } : {}) },
    contentType);
  return { items: resp.campaigns || [], nextToken: resp.nextToken || null };
}

// Generic nextToken-paginated collector, capped at 20 pages (4000
// campaigns) as a sanity ceiling — no account here should have anywhere
// near that many enabled campaigns of one type, so hitting the cap is
// itself a sign the response shape isn't what's expected, not real
// account size.
async function listAllPages(fetchPage) {
  const all = [];
  let nextToken = null;
  for (let i = 0; i < 20; i++) {
    const { items, nextToken: nt } = await fetchPage(nextToken);
    all.push(...items);
    if (!nt) break;
    nextToken = nt;
  }
  return all;
}

// Same shape as adRequest below, but with a caller-supplied versioned
// content-type — the campaign listing endpoints use per-resource
// versioned content-types (application/vnd.spCampaign.v3+json etc.), not
// the plain application/json the reporting endpoints use. Also rejects on
// a non-2xx status (adRequest doesn't) since these responses are read
// directly rather than polled, so a bad status needs to surface as an
// error immediately rather than being silently parsed as if it succeeded.
function adRequestJson(method, path, token, profileId, body, contentType) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                   `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Content-Type':                    contentType,
      'Accept':                          contentType,
    };
    if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);
    if (bodyStr)   headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`${path} failed (${res.statusCode}): ${d.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`${path} parse error (${res.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = toEstIso(new Date()); // FIXED 2026-08-19 -- was UTC

  // ── 1. Read _meta ──────────────────────────────────────────────────────────
  let meta = {};
  try {
    const rawMeta = await readRows(SHEET_AD_SUMMARY, META_TAB);
    rawMeta.forEach(r => { if (r.KEY) meta[r.KEY] = r.VALUE; });
  } catch (err) {
    await sendCronFailureAlert('sync-advertising-process', err.message, { stage: 'read _meta tab' });
    return res.status(500).json({ error: 'Failed to read _meta tab', detail: err.message });
  }

  const asinCurrId = meta['ad_report_id_asin_curr'];
  const spCurrId   = meta['ad_report_id_sp_curr'];
  const sbCurrId   = meta['ad_report_id_sb_curr'];
  const sdCurrId   = meta['ad_report_id_sd_curr']; // ADDED 2026-08-19 — Sponsored Display, ASIN-level
  const sdCampCurrId = meta['ad_report_id_sdcamp_curr']; // ADDED 2026-08-19 — Sponsored Display, dedicated campaign-level
  const asinPrevId = meta['ad_report_id_asin_prev'];
  const spPrevId   = meta['ad_report_id_sp_prev'];
  const sbPrevId   = meta['ad_report_id_sb_prev'];
  const sdPrevId   = meta['ad_report_id_sd_prev']; // ADDED 2026-08-19 — Sponsored Display, ASIN-level
  const sdCampPrevId = meta['ad_report_id_sdcamp_prev']; // ADDED 2026-08-19 — Sponsored Display, dedicated campaign-level
  const profileId  = meta['ad_profile_id'];
  const endDateCurr = meta['ad_end_date_curr'];
  const endDatePrev = meta['ad_end_date_prev'];

  // Support old-style single report IDs for backwards compatibility
  const legacyAsinId    = meta['ad_report_id_asin'];
  const legacySummaryId = meta['ad_report_id_summary'];
  const legacyEndDate   = meta['ad_end_date'];

  const hasNewIds = asinCurrId || spCurrId || sbCurrId;
  const hasLegacyIds = legacyAsinId || legacySummaryId;

  if (!hasNewIds && !hasLegacyIds) {
    const msg = 'No ad report IDs found in _meta — did sync-advertising-request run?';
    await sendCronFailureAlert('sync-advertising-process', msg);
    return res.status(400).json({ error: msg });
  }

  // ── PROCESSED early exit — check queue first ──────────────────────────────
  if (meta['ad_report_status'] === 'PROCESSED') {
    const queueStr = meta['ad_backfill_queue'] || '';
    const queue    = queueStr.split(',').map(s => s.trim()).filter(Boolean);
    if (queue.length > 0) {
      const nextMonth = queue.shift();
      console.log(`[sync-advertising-process] PROCESSED + queue ${queue.length + 1} months — advancing to ${nextMonth}`);
      try {
        const tok = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
        const ex  = await readRows(SHEET_AD_SUMMARY, META_TAB);
        const mm  = {};
        ex.forEach(r => { if (r.KEY) mm[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
        mm['ad_backfill_queue'] = ['ad_backfill_queue', queue.join(','), now];
        if (queue.length === 0) mm['ad_backfill_complete'] = ['ad_backfill_complete', 'true', now];
        await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(mm), tok);
        const backfillHandler = require('./sync-advertising-backfill');
        await backfillHandler(
          { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: { month: nextMonth } },
          { status: () => ({ json: (d) => console.log(`[sync-advertising-process] queued ${nextMonth}:`, JSON.stringify(d).slice(0,150)) }), end: () => {} }
        );
        return res.status(200).json({ message: `Queue advanced to ${nextMonth}`, remaining: queue.length });
      } catch (err) {
        console.error(`[sync-advertising-process] queue advance failed:`, err.message);
        await sendCronFailureAlert('sync-advertising-process', err.message, { stage: 'backfill queue advance', nextMonth });
        return res.status(200).json({ message: 'Queue advance failed', error: err.message });
      }
    }
    return res.status(200).json({ message: 'Already processed, no queue remaining' });
  }

  let token;
  try {
    token = await getAdToken();
  } catch (err) {
    await sendCronFailureAlert('sync-advertising-process', err.message, { stage: 'getAdToken' });
    return res.status(500).json({ error: 'Failed to get ad token', detail: err.message });
  }

  // ── 2. Poll + download all reports ────────────────────────────────────────
  // Handle both new multi-report format and legacy single-report format
  let asinCurrRows = [], spCurrRows = [], sbCurrRows = [], sdCurrRows = [], sdCampCurrRows = [];
  let asinPrevRows = [], spPrevRows = [], sbPrevRows = [], sdPrevRows = [], sdCampPrevRows = [];
  let legacyAsinRows = [], legacySummaryRows = [];

  if (hasNewIds) {
    console.log(`[sync-advertising-process] processing new-format reports`);
    const results = await Promise.all([
      asinCurrId   ? pollAndDownload(asinCurrId,   token, profileId) : Promise.resolve([]),
      spCurrId     ? pollAndDownload(spCurrId,     token, profileId) : Promise.resolve([]),
      sbCurrId     ? pollAndDownload(sbCurrId,     token, profileId) : Promise.resolve([]),
      sdCurrId     ? pollAndDownload(sdCurrId,     token, profileId) : Promise.resolve([]),
      sdCampCurrId ? pollAndDownload(sdCampCurrId, token, profileId) : Promise.resolve([]),
      asinPrevId   ? pollAndDownload(asinPrevId,   token, profileId) : Promise.resolve([]),
      spPrevId     ? pollAndDownload(spPrevId,     token, profileId) : Promise.resolve([]),
      sbPrevId     ? pollAndDownload(sbPrevId,     token, profileId) : Promise.resolve([]),
      sdPrevId     ? pollAndDownload(sdPrevId,     token, profileId) : Promise.resolve([]),
      sdCampPrevId ? pollAndDownload(sdCampPrevId, token, profileId) : Promise.resolve([]),
    ]);
    [asinCurrRows, spCurrRows, sbCurrRows, sdCurrRows, sdCampCurrRows, asinPrevRows, spPrevRows, sbPrevRows, sdPrevRows, sdCampPrevRows] = results;

    // If any curr or prev campaign report is still pending, retry later
    if (spCurrRows === null || spPrevRows === null) {
      return res.status(202).json({ message: 'Reports not ready yet — will retry next run' });
    }
    // Treat null as empty (non-critical reports e.g. SB/SD may fail gracefully)
    asinCurrRows   = asinCurrRows   || [];
    sbCurrRows     = sbCurrRows     || [];
    sdCurrRows     = sdCurrRows     || [];
    sdCampCurrRows = sdCampCurrRows || []; // ADDED 2026-08-19
    asinPrevRows   = asinPrevRows   || [];
    sbPrevRows     = sbPrevRows     || [];
    sdPrevRows     = sdPrevRows     || [];
    sdCampPrevRows = sdCampPrevRows || []; // ADDED 2026-08-19

  } else {
    // Legacy path — single period
    console.log(`[sync-advertising-process] processing legacy-format reports`);
    const results = await Promise.all([
      legacyAsinId    ? pollAndDownload(legacyAsinId,    token, profileId) : Promise.resolve([]),
      legacySummaryId ? pollAndDownload(legacySummaryId, token, profileId) : Promise.resolve([]),
    ]);
    [legacyAsinRows, legacySummaryRows] = results;
    if (legacyAsinRows === null || legacySummaryRows === null) {
      return res.status(202).json({ message: 'Reports not ready yet — will retry next run' });
    }
  }

  // ── 2b. Campaign counts (currently ENABLED) — ADDED 2026-09-04 ────────────
  // Independent of report polling above (different API surface entirely —
  // see getEnabledCampaignCountsByBrand's header comment) and independent
  // of curr/prev (a state snapshot, not a monthly aggregate), so fetched
  // once here rather than inside the period loop below. Failure here
  // should never block the spend/sales/units writes that already work —
  // same non-blocking philosophy as the SD reports elsewhere in this file.
  const enabledCampaignCounts = await getEnabledCampaignCountsByBrand(token, profileId).catch(err => {
    console.warn('[sync-advertising-process] campaign count fetch failed entirely — all *_campaigns_running columns blank this run:', err.message);
    return {};
  });

  // ── 3. Derive year/month for each period ──────────────────────────────────
  function yearMonthFromEndDate(endDate) {
    const [y, m] = (endDate || '').split('-');
    return {
      year:  parseInt(y, 10) || new Date().getFullYear(),
      month: parseInt(m, 10) || new Date().getMonth() + 1,
    };
  }

  const periods = hasNewIds
    ? [
        { label: 'curr', asinRows: asinCurrRows, spRows: spCurrRows, sbRows: sbCurrRows, sdRows: sdCurrRows, sdCampRows: sdCampCurrRows, endDate: endDateCurr, ...yearMonthFromEndDate(endDateCurr) },
        { label: 'prev', asinRows: asinPrevRows, spRows: spPrevRows, sbRows: sbPrevRows, sdRows: sdPrevRows, sdCampRows: sdCampPrevRows, endDate: endDatePrev, ...yearMonthFromEndDate(endDatePrev) },
      ]
    : [
        { label: 'legacy', asinRows: legacyAsinRows, spRows: legacySummaryRows, sbRows: [], sdRows: [], sdCampRows: [], endDate: legacyEndDate, ...yearMonthFromEndDate(legacyEndDate) },
      ];

  // ── 4. Build ASIN → brand map ──────────────────────────────────────────────
  const PRODUCT_SHEET_ID  = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
  const PRODUCT_SHEET_GID = '164358627';
  const asinBrandMap = {};
  try {
    const csvUrl  = `https://docs.google.com/spreadsheets/d/${PRODUCT_SHEET_ID}/export?format=csv&gid=${PRODUCT_SHEET_GID}`;
    const csvResp = await fetch(csvUrl);
    if (csvResp.ok) {
      const csv = await csvResp.text();
      csv.trim().split('\n').slice(1).forEach(line => {
        const cols      = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        const asin      = (cols[0] || '').toUpperCase();
        const sku       = (cols[1] || '').toUpperCase();
        const brandName = (cols[3] || '').toLowerCase().trim();
        if (!asin || !brandName) return;
        const nameMatched = brands.find(b =>
          b.active && (
            brandName === b.id.toLowerCase() ||
            brandName === b.displayName.toLowerCase() ||
            brandName.includes(b.id.toLowerCase())
          )
        );
        if (!nameMatched) return;
        // FIXED 2026-08-14 — same bug as sync-products.js: skinuva-ca
        // shares "skinuva" as a substring of its own id, so a plain
        // "skinuva" brand-name label could only ever satisfy skinuva's
        // OWN condition above (brandNorm.includes('skinuva-ca') is
        // impossible when brandNorm is just "skinuva" — a shorter string
        // can't contain a longer one). Disambiguate the real sibling set
        // by shared SKU PREFIX (not name), then resolve using the SKU's
        // own "-CA" suffix, same pattern as everywhere else today.
        const siblings = brands.filter(b =>
          b.active && b.skuPrefix && nameMatched.skuPrefix && b.skuPrefix === nameMatched.skuPrefix
        );
        const matched = siblings.length > 1 ? resolveBrandForSku(sku, siblings) : nameMatched;
        asinBrandMap[asin] = matched.tabName;
      });
      console.log(`[sync-advertising-process] ASIN→brand map: ${Object.keys(asinBrandMap).length} entries`);
    }
  } catch (err) {
    console.warn('[sync-advertising-process] ASIN→brand lookup failed:', err.message);
  }

  // ── 5. Process each period ────────────────────────────────────────────────
  const allResults = [];
  const cutoff = new Date().getFullYear() - TRIM_YEARS;
  let sheetOpIndex = 0; // shared across both periods and both write loops (5a + 5b) — see SHEET_WRITE_STAGGER_MS

  // Tracks which `${sheetId}::${tabName}` combos have already had ensureTab
  // called this run. Tab existence/headers can't change between the curr
  // and prev passes within a single invocation, so the second pass can skip
  // straight to readRows — halving the read calls for repeat tabs. See
  // SHEET_WRITE_STAGGER_MS comment above for the quota math this supports.
  const ensuredTabsThisRun = new Map(); // key -> token, so replaceRows still gets a valid token on the 2nd pass
  async function ensureTabOnce(sheetId, tabName, headers) {
    const key = `${sheetId}::${tabName}`;
    if (ensuredTabsThisRun.has(key)) return ensuredTabsThisRun.get(key);
    const tok = await ensureTab(sheetId, tabName, headers);
    ensuredTabsThisRun.set(key, tok);
    return tok;
  }

  // ADDED 2026-09-04 — ensureTab only CHECKS an existing tab's header row
  // against `headers` and logs a warning on mismatch; it never fixes one
  // (see its own comment: "Doesn't fix anything, just makes drift loud").
  // replaceRows never touches row 1 at all — it only clears/writes from
  // row 2 down. So on every brand tab created before today (i.e. all of
  // them), row 1 would stay stuck at the old 13 column names forever
  // without this. That's not just cosmetic: readRows keys each row by
  // whatever's actually in row 1, so the new sp_/sb_/sd_ columns would
  // read back as undefined on every row — including ones THIS cron just
  // wrote real data into — meaning every subsequent run's upsert would
  // silently blank those columns out for every month except the two
  // currently being processed. Cached per tab per run, same pattern as
  // ensureTabOnce above, so this fires once per tab even though both the
  // curr and prev passes call it.
  const headersRefreshedThisRun = new Set();
  async function refreshHeaderOnce(sheetId, tabName, headers, token) {
    const key = `${sheetId}::${tabName}`;
    if (headersRefreshedThisRun.has(key)) return;
    headersRefreshedThisRun.add(key);
    try {
      await updateRange(sheetId, `${tabName}!A1`, [headers], token, 'RAW');
    } catch (err) {
      console.error(`[sync-advertising-process] header refresh failed for tab "${tabName}" — new columns may not read back correctly until this succeeds:`, err.message);
    }
  }

  for (const period of periods) {
    const { label, year, month, endDate, asinRows, spRows, sbRows, sdRows, sdCampRows } = period;
    console.log(`[sync-advertising-process] ${label}: year=${year} month=${month} asin=${asinRows.length} sp=${spRows.length} sb=${sbRows.length} sd=${(sdRows || []).length} sdcamp=${(sdCampRows || []).length}`);

    // ── 5a. Write ASIN-level data (SP + SD — SB has no ASIN-level report) ────
    // CHANGED 2026-08-25 per Jaclyn — SP now reads the 7-day attribution
    // fields (sales7d, unitsSoldClicks7d) instead of 14-day. See the
    // "SP ATTRIBUTION WINDOW" note in sync-advertising-request.js's file
    // header for the reconciliation test that motivated this: 14-day was
    // confirmed to be the cause of this dashboard running ~$1,825/month
    // above both Helium 10 and Amazon's own console for Skinuva, with
    // spend/clicks/impressions matching almost exactly in both windows —
    // only the attribution-dependent sales/units figures moved. Internal
    // field names below (`units`/`spend`/`sales`) are already window-
    // agnostic, so nothing downstream of this block needed to change.
    //
    // ADDED 2026-08-19 — SD's real column names (confirmed via
    // test-sd-connection.js against actual returned data, not guessed)
    // differ from SP's: promotedAsin/cost/sales/unitsSold vs SP's
    // advertisedAsin/spend/sales7d/unitsSoldClicks7d. Normalized into a
    // single common shape here before aggregating, rather than forcing
    // SD's field names to match SP's or duplicating the aggregation loop.
    const normalizedAsinRows = [
      ...asinRows.map(r => ({
        asin:  (r.advertisedAsin || '').trim().toUpperCase(),
        units: r.unitsSoldClicks7d || 0,
        spend: r.spend || 0,
        sales: r.sales7d || 0,
      })),
      ...(sdRows || []).map(r => ({
        asin:  (r.promotedAsin || '').trim().toUpperCase(),
        units: r.unitsSold || 0,
        spend: r.cost || 0,
        sales: r.sales || 0,
      })),
    ];

    if (normalizedAsinRows.length > 0) {
      const byBrand = { 'asin-data': [] };
      normalizedAsinRows.forEach(r => {
        if (!r.asin) return;
        const tabName = asinBrandMap[r.asin] || 'asin-data';
        if (!byBrand[tabName]) byBrand[tabName] = [];
        byBrand[tabName].push(r);
      });

      for (const [tabName, tabRows] of Object.entries(byBrand)) {
        if (tabRows.length === 0) continue;
        const asinMap = {};
        tabRows.forEach(r => {
          if (!r.asin) return;
          if (!asinMap[r.asin]) asinMap[r.asin] = { adUnits: 0, spend: 0, sales: 0 };
          asinMap[r.asin].adUnits += r.units;
          asinMap[r.asin].spend   += r.spend;
          asinMap[r.asin].sales   += r.sales;
        });
        const brandLabel = tabName === 'asin-data' ? 'unmatched' : tabName;
        const newRows = Object.entries(asinMap).map(([asin, agg]) => {
          const acos = agg.sales > 0 ? round2((agg.spend / agg.sales) * 100) : null;
          return [year, month, asin, agg.adUnits, round2(agg.spend), round2(agg.sales), acos, brandLabel, now, endDate || ''];
        }).filter(r => parseInt(r[0], 10) >= cutoff);

        if (sheetOpIndex > 0) await sleep(SHEET_WRITE_STAGGER_MS);
        sheetOpIndex++;

        try {
          const tok      = await ensureTabOnce(SHEET_AD_ORDERS, tabName, ASIN_HEADERS);
          const existing = await readRows(SHEET_AD_ORDERS, tabName);
          // Remove rows matching this year/month, then append new ones
          const kept = existing.filter(r => !(parseInt(r.year,10) === year && parseInt(r.month,10) === month));
          const allRows = [...kept.map(r => [r.year, r.month, r.asin, r.ad_units, r.spend, r.sales, r.acos, r.brand, r.last_updated, r.date]), ...newRows];
          await replaceRows(SHEET_AD_ORDERS, tabName, ASIN_HEADERS, allRows, tok);
          console.log(`[sync-advertising-process] ${label} ${tabName}: upserted ${newRows.length} ASIN rows`);
        } catch (err) {
          console.error(`[sync-advertising-process] ${label} ${tabName} ASIN write failed:`, err.message);
          allResults.push({ period: label, brand: tabName, stage: 'asin-write', status: 'error', error: err.message });
        }
      }
    }

    // ── 5b. Merge SP + SB campaign rows, aggregate per brand ─────────────────
    // CHANGED 2026-08-25 per Jaclyn — SP campaign rows now carry sales7d /
    // unitsSoldClicks7d (see sync-advertising-request.js's file header for
    // the reconciliation test behind this). Remapped into the SAME
    // sales14d/unitsSoldClicks14d key names the aggregation below already
    // reads for SB and SD, purely so one shared aggregation loop can keep
    // working unchanged for all three ad types — those two key names are
    // now a slight misnomer (they hold 7-day SP data, not 14-day), kept
    // only for internal consistency with the rest of this function. Not
    // exposed anywhere outside this file: SUMMARY_HEADERS/ASIN_HEADERS
    // (the actual sheet column names) were always window-agnostic
    // ('sales', 'ad_units'), so nothing downstream of this file changes.
    //
    // SB and SP use different column names for the same concepts — SB has no
    // day-window suffix the way SP does. Confirmed against Amazon's real
    // sbCampaigns schema (2026-07-09):
    //   SP: spend, sales7d, unitsSoldClicks7d
    //   SB: cost,  sales,   purchases
    // Remap all three SB fields to the SP-shaped keys the aggregation below
    // reads — previously only `spend` was remapped and `purchases14d` (which
    // was never actually SB's field name) was used instead of `purchases`,
    // so SB sales and units were both silently counted as 0 in every total.
    //
    // FIXED 2026-08-19 — an earlier version of this derived SD's
    // campaign-level totals by aggregating its ASIN-level rows (sdRows)
    // by campaignName. Per Jaclyn: the priority is capturing 100% of
    // spend/sales, even where the ASIN-level breakdown is incomplete —
    // deriving campaign totals FROM the ASIN-level report risked
    // silently missing any spend/sales Amazon's attribution never tied
    // to a specific promoted product. Confirmed via test-sd-campaigns.js
    // (2026-08-19, accepted outright with zero column corrections
    // needed) that 'sdCampaigns' is a genuine, DEDICATED campaign-level
    // report — the same way spCampaigns/sbCampaigns already work
    // independently of their own ASIN-level counterparts. Using this
    // real report instead of a derived sum removes the completeness risk
    // entirely, rather than relying on an unverified assumption that the
    // ASIN-level report already captures every dollar.
    const allCampaignRows = [
      ...spRows.map(r => ({
        ...r,
        adType:             'sp', // ADDED 2026-09-04 — see brandTypeTotals below
        sales14d:           r.sales7d           || 0,
        unitsSoldClicks14d: r.unitsSoldClicks7d || 0,
      })),
      ...sbRows.map(r => ({
        ...r,
        adType:              'sb', // ADDED 2026-09-04
        spend:               r.cost      || r.spend      || 0,
        sales14d:            r.sales     || r.sales14d    || 0,
        unitsSoldClicks14d:  r.purchases || r.purchases14d || 0,
      })),
      ...(sdCampRows || []).map(r => ({
        ...r,
        adType:              'sd', // ADDED 2026-09-04
        spend:               r.cost      || 0,
        sales14d:            r.sales     || 0,
        unitsSoldClicks14d:  r.unitsSold || 0,
      })),
    ];

    const brandTotals = {};
    // ADDED 2026-09-04 — parallel per-ad-type breakdown for the new sp_/
    // sb_/sd_ columns, built from the exact same allCampaignRows the
    // blended brandTotals below already uses (same data, same
    // identifyBrand call) — just kept separate by type instead of
    // immediately collapsed. brandTotals itself is completely untouched
    // by this addition, so the existing blended columns this dashboard
    // has always shown can't be affected by it.
    const brandTypeTotals = {}; // tabName -> { sp: {spend,sales,adUnits}, sb: {...}, sd: {...} }
    allCampaignRows.forEach(r => {
      const tabName = identifyBrand(r.campaignName);
      if (!tabName) {
        console.log(`[sync-advertising-process] unmatched campaign: "${r.campaignName}"`);
        return;
      }
      if (!brandTotals[tabName]) brandTotals[tabName] = { impressions: 0, clicks: 0, spend: 0, sales: 0, adUnits: 0 };
      brandTotals[tabName].impressions += r.impressions        || 0;
      brandTotals[tabName].clicks      += r.clicks             || 0;
      brandTotals[tabName].spend       += r.spend              || 0;
      brandTotals[tabName].sales       += r.sales14d           || 0;
      brandTotals[tabName].adUnits     += r.unitsSoldClicks14d || 0;

      if (!brandTypeTotals[tabName]) {
        brandTypeTotals[tabName] = { sp: { spend: 0, sales: 0, adUnits: 0 }, sb: { spend: 0, sales: 0, adUnits: 0 }, sd: { spend: 0, sales: 0, adUnits: 0 } };
      }
      const tt = brandTypeTotals[tabName][r.adType];
      if (tt) {
        tt.spend   += r.spend              || 0;
        tt.sales   += r.sales14d           || 0;
        tt.adUnits += r.unitsSoldClicks14d || 0;
      }
    });

    for (const brand of brands.filter(b => b.active)) {
      if (sheetOpIndex > 0) await sleep(SHEET_WRITE_STAGGER_MS);
      sheetOpIndex++;

      try {
        const t    = brandTotals[brand.tabName] || { impressions: 0, clicks: 0, spend: 0, sales: 0, adUnits: 0 };
        const acos = t.sales  > 0 ? round2((t.spend / t.sales) * 100)            : null;
        const roas = t.spend  > 0 ? round2(t.sales / t.spend)                     : null;
        const ctr  = t.impressions > 0 ? round2((t.clicks / t.impressions) * 100) : 0;
        const cpc  = t.clicks > 0 ? round2(t.spend / t.clicks)                    : 0;

        // ADDED 2026-09-04 — per-ad-type columns. tt falls back to zeroed
        // sub-objects for a brand with no campaigns of a given type this
        // period (e.g. no Sponsored Display yet) — same "0, not blank"
        // convention the blended columns above already use via `t`'s own
        // fallback. cc (campaign counts) falls back to '' per-type rather
        // than 0, since a fetch failure (see getEnabledCampaignCountsByBrand)
        // means "unknown this run", not "confirmed zero".
        const tt = brandTypeTotals[brand.tabName] || { sp: {spend:0,sales:0,adUnits:0}, sb: {spend:0,sales:0,adUnits:0}, sd: {spend:0,sales:0,adUnits:0} };
        const cc = enabledCampaignCounts[brand.tabName] || {};
        const typeAcos = x => x.sales > 0 ? round2((x.spend / x.sales) * 100) : null;

        const newRow = [
          year, month, t.impressions, t.clicks, round2(t.spend), round2(t.sales), acos, roas, t.adUnits, ctr, cpc, brand.id, now,
          round2(tt.sp.spend), round2(tt.sp.sales), tt.sp.adUnits, typeAcos(tt.sp), cc.sp ?? '',
          round2(tt.sb.spend), round2(tt.sb.sales), tt.sb.adUnits, typeAcos(tt.sb), cc.sb ?? '',
          round2(tt.sd.spend), round2(tt.sd.sales), tt.sd.adUnits, typeAcos(tt.sd), cc.sd ?? '',
        ];

        const tok      = await ensureTabOnce(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS);
        await refreshHeaderOnce(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS, tok);
        const existing = await readRows(SHEET_AD_SUMMARY, brand.tabName);
        // Upsert: remove matching year/month row, append new one. Switched
        // the kept-row mapping from a hand-listed column array to a
        // SUMMARY_HEADERS-driven one — with 28 columns now (up from 13),
        // hand-listing every column here risked a transcription slip that
        // a header-driven map can't have. Preserves whatever a past run
        // already computed for every OTHER month's row untouched, same as
        // before.
        const kept = existing.filter(r => !(parseInt(r.year,10) === year && parseInt(r.month,10) === month));
        await replaceRows(SHEET_AD_SUMMARY, brand.tabName, SUMMARY_HEADERS,
          [...kept.map(r => SUMMARY_HEADERS.map(h => r[h] ?? '')), newRow],
          tok
        );
        allResults.push({ period: label, brand: brand.id, status: 'ok', spend: round2(t.spend), adUnits: t.adUnits });
        console.log(`[sync-advertising-process] ${label} ${brand.id}: spend=${round2(t.spend)} adUnits=${t.adUnits}`);
      } catch (err) {
        console.error(`[sync-advertising-process] ${label} ${brand.id} failed:`, err.message);
        allResults.push({ period: label, brand: brand.id, status: 'error', error: err.message });
      }
    }
  }

  // ── Summary alert — one alert per run if any per-brand/per-item writes failed ──
  const failedResults = allResults.filter(r => r.status === 'error');
  if (failedResults.length > 0) {
    const summary = failedResults
      .map(r => `${r.period}/${r.brand}${r.stage ? ` (${r.stage})` : ''}: ${r.error}`)
      .join('\n');
    await sendCronFailureAlert('sync-advertising-process', summary, {
      failedCount: failedResults.length,
      totalCount:  allResults.length,
    });
  }

  // ── 6. Mark _meta as PROCESSED ────────────────────────────────────────────
  try {
    const existing = await readRows(SHEET_AD_SUMMARY, META_TAB);
    const metaMap  = {};
    existing.forEach(r => { if (r.KEY) metaMap[r.KEY] = [r.KEY, r.VALUE, r.UPDATED_AT]; });
    metaMap['ad_report_status'] = ['ad_report_status', 'PROCESSED', now];
    metaMap['ad_backfill']      = ['ad_backfill', 'false', now];

    // Queue auto-advance
    const queueStr = metaMap['ad_backfill_queue']?.[1] || '';
    const queue    = queueStr.split(',').map(s => s.trim()).filter(Boolean);
    if (queue.length > 0) {
      const nextMonth = queue.shift();
      metaMap['ad_backfill_queue'] = ['ad_backfill_queue', queue.join(','), now];
      if (queue.length === 0) metaMap['ad_backfill_complete'] = ['ad_backfill_complete', 'true', now];
      const token2 = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
      await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);
      try {
        const backfillHandler = require('./sync-advertising-backfill');
        await backfillHandler(
          { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: { month: nextMonth } },
          { status: () => ({ json: (d) => console.log(`[sync-advertising-process] backfill ${nextMonth}:`, JSON.stringify(d).slice(0,150)) }), end: () => {} }
        );
      } catch (err) {
        console.error(`[sync-advertising-process] backfill fire failed:`, err.message);
      }
      return res.status(200).json({ results: allResults, queueAdvanced: nextMonth, remaining: queue.length, timestamp: now });
    }

    const token2 = await ensureTab(SHEET_AD_SUMMARY, META_TAB, META_HEADERS);
    await replaceRows(SHEET_AD_SUMMARY, META_TAB, META_HEADERS, Object.values(metaMap), token2);
  } catch (err) {
    console.warn('[sync-advertising-process] failed to update _meta status:', err.message);
  }

  return res.status(200).json({ results: allResults, timestamp: now });
};

// ── Poll + download ───────────────────────────────────────────────────────────
async function pollAndDownload(reportId, token, profileId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp   = await adRequest('GET', `/reporting/reports/${reportId}`, token, profileId, null);
    const status = resp.status;
    console.log(`[sync-advertising-process] poll ${reportId}: ${status}`);
    if (status === 'COMPLETED') return downloadAdReport(resp.url);
    if (status === 'FAILED')    return null;
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn(`[sync-advertising-process] ${reportId} not ready after ${POLL_TIMEOUT_MS}ms`);
  return null;
}

function downloadAdReport(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        zlib.gunzip(buf, (err, decoded) => {
          if (err) {
            try { resolve(JSON.parse(buf.toString())); } catch(e) { reject(e); }
            return;
          }
          try { resolve(JSON.parse(decoded.toString())); } catch(e) { reject(e); }
        });
      });
    }).on('error', reject);
  });
}

function adRequest(method, path, token, profileId, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Authorization':                   `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': process.env.SP_AD_CLIENT_ID,
      'Content-Type':                    method === 'POST' && path === '/reporting/reports'
                                           ? 'application/vnd.createasyncreportrequest.v3+json'
                                           : 'application/json',
    };
    if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);
    if (bodyStr)   headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: AD_API_HOST, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Ad API parse error (${res.statusCode}): ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;

// Same helper already proven in sync-fbm-returns-process.js /
// sync-returns-process.js — formats Eastern wall-clock time as an
// ISO-shaped string ending in "Z", so it displays consistently with
// every other Eastern-anchored timestamp in this project rather than
// UTC. Not a literal UTC timestamp despite the "Z" suffix — a
// deliberate, consistent convention used throughout this codebase.
function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
