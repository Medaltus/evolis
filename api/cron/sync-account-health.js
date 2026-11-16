/**
 * api/cron/sync-account-health.js
 * ADDED 2026-11-16 (per Jaclyn) — daily Amazon account health, for:
 *   NewDerm · Amazon.com, NewDerm · Amazon.ca, High On Love · Amazon.com
 *
 * Amazon builds reports in the background, so each run does two things:
 *   1. collects any reports requested earlier that are now ready, and writes them;
 *   2. requests today's reports for any account not yet requested today:
 *        GET_V2_SELLER_PERFORMANCE_REPORT — the Seller Central Account Health page
 *          as data: account status, Account Health Rating, every performance
 *          metric (status, value, Amazon's target) and every policy violation count
 *        GET_SELLER_FEEDBACK_DATA — negative/neutral (1–3★) seller feedback, last 30 days
 *        GET_MERCHANTS_LISTINGS_FYP_REPORT — suppressed listings with Amazon's reason
 *          (ADDED 2026-11-16, feeds the listing_issues tab)
 * Scheduled a few times each morning, so a report requested on one run is
 * written on the next.
 *
 * Five sheets (one tab each; the tab is created/renamed automatically):
 *   Daily Health     one row per account + marketplace + day: status, rating,
 *                    the headline metrics and every violation count
 *   Metrics Detail   one row per metric per account + marketplace + day, exactly
 *                    as Amazon reports it (incl. metrics Amazon adds later)
 *   Changes          one row per change vs the previous snapshot: statuses,
 *                    counts, rates, account status, health rating (feeds the
 *                    future alert email)
 *   Seller Feedback  each feedback once (date + order ID), never repeated;
 *                    the rater's email is not stored
 *   Meta             pending report IDs, last request date per account
 *   Metrics Detail, 2nd tab "listing_issues" (ADDED 2026-11-16): which LISTINGS
 *                    carry policy / enforcement problems — Amazon's Account Health
 *                    report only gives violation COUNTS, never the ASINs. One row per
 *                    account + SKU + issue per day, from: the Suppressed Listings
 *                    report, the Products Cache "issues" column (FBA SKUs, latest
 *                    day) and the -SF product sheet's "<brand> fbm" tabs (FBM SKUs).
 *                    Kept: anything Amazon enforced ({LISTING_SUPPRESSED}, removed,
 *                    search-suppressed…) or whose message is about policy
 *                    (restricted, prohibited, safety, authenticity, IP…). first_seen
 *                    carries over from earlier days, so you can see how long it's been.
 * Writes alternate between the project's two Google service accounts (see
 * SHEETS below); if one can't open a sheet, the other is tried.
 *
 * Amazon says not to rely on the exact JSON layout of the performance report,
 * so it's read generically: every metric object anywhere in the report becomes
 * a Metrics Detail row, and the Daily Health columns are filled by matching
 * metric names. Nothing is dropped if Amazon renames or adds a metric.
 *
 * Needs the "Selling Partner Insights" role on each Amazon app (NewDerm's and
 * High On Love's). ?check=true tests that without writing anything.
 *
 * INACTIVE LISTINGS SCAN (ADDED 2026-11-16; CHANGED same day per Jaclyn: it
 * now records EVERY issue on every inactive SKU — no keyword guessing about
 * which violation it belongs to — into the "inactive_listings" tab, and runs
 * daily on its own schedule, once per day). Only the active cron brands
 * (brands.js, minus the brands left out of the emails):
 *   1. requests the All Listings report (every SKU, incl. inactive/removed) and
 *      the Stranded inventory report per account;
 *   2. on later ?scan=violations runs, collects them, keeps the cron brands' SKUs
 *      that are NOT active (active ones are already in listing_issues), asks the
 *      Listings API for each one's issues (a few minutes per run, resuming on the
 *      next run), and keeps every issue Amazon reports (one row per SKU + message);
 *      every stranded SKU is added with its stranded reason;
 *   3. writes them to Metrics Detail → "inactive_listings" (first_seen carries
 *      over, so new ones can be flagged). Once a day's scan is done, further
 *      calls that day just answer "done".
 *
 * Manual:
 *   GET /api/cron/sync-account-health?scan=violations   inactive listings scan (scheduled daily; see above)
 *   GET /api/cron/sync-account-health              normal run
 *   GET /api/cron/sync-account-health?check=true   access check: request the report for each account, write nothing
 *   GET /api/cron/sync-account-health?force=true   request today's reports again
 */

const zlib = require('zlib');
const { spRequest } = require('../_spauth');
const { getSheetsToken } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheetsConfig = require('../config/sheets');
const { accountForBrand } = require('../_account');
const { sendCronFailureAlert } = require('../_alerts');

const SCOPES = [
  { key: 'newderm-us', account: 'newderm', label: 'NewDerm', marketplace: 'US', marketplaceId: () => process.env.SP_MARKETPLACE_ID },
  { key: 'newderm-ca', account: 'newderm', label: 'NewDerm', marketplace: 'CA', marketplaceId: () => process.env.SP_MARKETPLACE_ID_CA || 'A2EUQ1WTGCTBG2' },
  { key: 'hol-us', account: 'hol', label: 'High On Love', marketplace: 'US', marketplaceId: () => process.env.SP_MARKETPLACE_ID },
];

// Each sheet, its one tab, and which Google service account writes it.
const SHEETS = {
  health:   { id: '18TMRTDW1Mvodx7hZ1dWu1763_gCokFytC8BxHAWxOSE', tab: 'health_daily', account: 'writer' },
  metrics:  { id: '1gsbzdc6AJMSyyTgEbc1Lh2ccEgSJLtwg1GK7To8sWgI', tab: 'metrics_detail', account: 'primary' },
  feedback: { id: '1sMJEdXewdG_PXzN_Saj-2Wkd9ozihBUXDGwwopS8YwQ', tab: 'seller_feedback', account: 'primary' },
  changes:  { id: '1AjYkrA8INLdkTViF-Ve4poHtlDmXPgkYiDUpK5JPY2Q', tab: 'changes', account: 'writer' },
  meta:     { id: '1DhduU87hFgGOdsuK5XBBNRXVn4mpZzNkC1AKoDwhOnA', tab: '_meta', account: 'primary' },
  issues:   { id: '1gsbzdc6AJMSyyTgEbc1Lh2ccEgSJLtwg1GK7To8sWgI', tab: 'listing_issues', account: 'primary' }, // 2nd tab of Metrics Detail
  scan:     { id: '1gsbzdc6AJMSyyTgEbc1Lh2ccEgSJLtwg1GK7To8sWgI', tab: 'inactive_listings', account: 'primary' }, // 3rd tab of Metrics Detail
};
const SCAN_HEADERS = ['date', 'account', 'marketplace', 'brand', 'sku', 'asin', 'listing_status', 'source', 'severity', 'amazon_message', 'enforcement', 'first_seen'];
const SCAN_EXCLUDED_BRANDS = ['cimeosil', 'collagelee', 'hillside']; // same brands left out of the alert emails
const SCAN_BUDGET_MS = 230_000;
const SF_SHEET = process.env.SHEET_SF_PRODUCTS || '1eAkS2Jr30ewk57mP39wA9h6Z862pE1zlE9znTXsZi34';
const REPORT_TYPES = ['GET_V2_SELLER_PERFORMANCE_REPORT', 'GET_SELLER_FEEDBACK_DATA', 'GET_MERCHANTS_LISTINGS_FYP_REPORT'];
const ISSUE_HEADERS = ['date', 'account', 'marketplace', 'brand', 'sku', 'asin', 'source', 'listing_status', 'issue', 'issue_code', 'severity', 'enforcement', 'first_seen', 'details'];
const ENFORCED = /LISTING_SUPPRESSED|ATTRIBUTE_SUPPRESSED|CATALOG_ITEM_REMOVED|SEARCH_SUPPRESSED|LISTING_REMOVED|ITEM_REMOVED|SUPPRESS|REMOV|BLOCK|INACTIV/i;
const POLICY = /restrict|prohibit|polic|pesticid|drug|unapproved|dietary supplement|ingredient|safety|hazmat|dangerous|recall|authentic|counterfeit|intellectual|trademark|copyright|patent|brand registry|compliance|regulat|claim|disease|medical|fda|epa|approval|ungated|gated|category approval/i;

// Daily Health columns: [column, how to find it among the flattened metrics]
const HEALTH_COLS = [
  ['account_status', m => m.__accountStatus],
  ['ahr_status', m => pick(m, /accounthealthrating/, 'status')],
  ['ahr_score', m => pick(m, /accounthealthrating/, 'value')],
  ['odr_fba', m => pick(m, /orderdefectrate.*afn/, 'value')], ['odr_fba_status', m => pick(m, /orderdefectrate.*afn/, 'status')],
  ['odr_fbm', m => pick(m, /orderdefectrate.*mfn/, 'value')], ['odr_fbm_status', m => pick(m, /orderdefectrate.*mfn/, 'status')],
  ['late_shipment_rate', m => pick(m, /lateshipment/, 'value')], ['late_shipment_status', m => pick(m, /lateshipment/, 'status')],
  ['pre_fulfillment_cancel_rate', m => pick(m, /prefulfillmentcancel/, 'value')], ['pre_fulfillment_cancel_status', m => pick(m, /prefulfillmentcancel/, 'status')],
  ['valid_tracking_rate', m => pick(m, /validtracking/, 'value')], ['valid_tracking_status', m => pick(m, /validtracking/, 'status')],
  ['on_time_delivery_rate', m => pick(m, /ontimedelivery/, 'value')], ['on_time_delivery_status', m => pick(m, /ontimedelivery/, 'status')],
  ['invoice_defect_rate', m => pick(m, /invoicedefect/, 'value')],
  ['listing_policy_violations', m => pick(m, /listingpolicy/, 'defects')],
  ['ip_complaints_received', m => pick(m, /receivedintellectualproperty|intellectualpropertycomplaint/, 'defects')],
  ['ip_violations_suspected', m => pick(m, /suspectedintellectualproperty/, 'defects')],
  ['authenticity_complaints', m => pick(m, /authenticity/, 'defects')],
  ['condition_complaints', m => pick(m, /productcondition/, 'defects')],
  ['product_safety_complaints', m => pick(m, /productsafety/, 'defects')],
  ['food_product_safety_issues', m => pick(m, /foodandproductsafety/, 'defects')],
  ['restricted_product_violations', m => pick(m, /restrictedproduct/, 'defects')],
  ['review_policy_violations', m => pick(m, /reviewspolicy|productreviews/, 'defects')],
  ['other_policy_violations', m => pick(m, /otherpolicy/, 'defects')],
  ['document_requests', m => pick(m, /documentrequest/, 'defects')],
];
const HEALTH_HEADERS = ['date', 'account', 'marketplace', ...HEALTH_COLS.map(c => c[0]), 'synced_at'];
const METRIC_HEADERS = ['date', 'account', 'marketplace', 'metric', 'status', 'value', 'target', 'target_condition', 'defects_count', 'orders_count', 'reporting_from', 'reporting_to', 'details'];
const CHANGE_HEADERS = ['date', 'account', 'marketplace', 'metric', 'field', 'from', 'to', 'direction', 'previous_snapshot'];
const FEEDBACK_HEADERS = ['feedback_date', 'account', 'marketplace', 'rating', 'comments', 'your_response', 'order_id', 'first_seen'];
const META_HEADERS = ['key', 'value', 'updated_at'];
const BAD_STATUS = /risk|bad|poor|fail|critical|warning|unhealthy|suspend|deactivat/i;

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const today = todayEt();
  const check = req.query.check === 'true';
  const force = req.query.force === 'true';
  const results = [];

  try {
    // ── Access check: request the performance report per account, write nothing ──
    if (check) {
      for (const sc of SCOPES) {
        const r = await requestReport(sc, 'GET_V2_SELLER_PERFORMANCE_REPORT').catch(err => ({ error: err.message }));
        results.push({ scope: sc.key, ok: !!r.reportId, reportId: r.reportId || null, error: r.reportId ? undefined : (r.error || JSON.stringify(r).slice(0, 300)),
          hint: r.reportId ? 'access OK' : (/unauthori|access|role|403/i.test(String(r.error || JSON.stringify(r))) ? 'the app is missing the "Selling Partner Insights" role for this account' : undefined) });
        await sleep(500);
      }
      return res.status(200).json({ check: true, results });
    }

    const meta = await readMeta();
    if (req.query.scan === 'violations') {
      const out = await violationScan(meta, today);
      meta.last_scan_run = new Date().toISOString();
      await writeMeta(meta);
      return res.status(200).json({ scan: 'violations', ...out });
    }
    let pending = []; try { pending = JSON.parse(meta.pending || '[]'); } catch { pending = []; }

    // ── 1. Collect ready reports ─────────────────────────────────────────────
    const still = [];
    for (const p of pending) {
      const sc = SCOPES.find(s => s.key === p.scope);
      if (!sc) continue;
      let rep;
      try { rep = await spRequest('GET', `/reports/2021-06-30/reports/${p.reportId}`, {}, null, sc.account); }
      catch (err) { still.push(p); results.push({ scope: p.scope, type: p.type, status: 'error checking', error: err.message }); continue; }
      const st = rep && rep.processingStatus;
      if (st === 'IN_QUEUE' || st === 'IN_PROGRESS') { if (ageHours(p.requestedAt) < 24) still.push(p); continue; }
      if (st !== 'DONE') {
        // A cancelled suppressed-listings report means none are suppressed — the
        // listing_issues tab is still written from the other two sources.
        if (st === 'CANCELLED' && p.type === 'GET_MERCHANTS_LISTINGS_FYP_REPORT') { results.push({ scope: p.scope, type: 'listing issues', ...(await writeListingIssues(sc, p.date, null)) }); continue; }
        results.push({ scope: p.scope, type: p.type, status: st || 'unknown', note: st === 'CANCELLED' ? 'no data for this period' : 'Amazon could not build it' }); continue;
      }
      const text = await download(rep.reportDocumentId, sc.account);
      if (p.type === 'GET_V2_SELLER_PERFORMANCE_REPORT') results.push({ scope: p.scope, type: 'performance', ...(await writePerformance(sc, p.date, text)) });
      else if (p.type === 'GET_MERCHANTS_LISTINGS_FYP_REPORT') results.push({ scope: p.scope, type: 'listing issues', ...(await writeListingIssues(sc, p.date, text)) });
      else results.push({ scope: p.scope, type: 'feedback', ...(await writeFeedback(sc, text, today)) });
      await sleep(400);
    }

    // ── 2. Request today's reports ───────────────────────────────────────────
    for (const sc of SCOPES) {
      const k = `requested ${sc.key}`;
      if (meta[k] === today && !force) continue;
      const got = [];
      for (const type of REPORT_TYPES) {
        const r = await requestReport(sc, type).catch(err => ({ error: err.message }));
        if (r.reportId) { still.push({ scope: sc.key, type, reportId: r.reportId, date: today, requestedAt: new Date().toISOString() }); got.push(type); }
        else results.push({ scope: sc.key, type, status: 'request failed', error: r.error || JSON.stringify(r).slice(0, 300) });
        await sleep(600);
      }
      if (got.length === REPORT_TYPES.length) meta[k] = today;
    }

    meta.pending = JSON.stringify(still);
    meta.last_run = new Date().toISOString();
    await writeMeta(meta);

    const failures = results.filter(r => r.error);
    if (failures.length) await sendCronFailureAlert('sync-account-health', failures.map(f => `${f.scope} ${f.type || ''}: ${f.error}`).join('\n').slice(0, 1500));
    return res.status(200).json({ date: today, results, pending: still.length });
  } catch (err) {
    console.error('[sync-account-health]', err.message);
    await sendCronFailureAlert('sync-account-health', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Amazon ─────────────────────────────────────────────────────────────────
async function requestReport(sc, type) {
  const body = { reportType: type, marketplaceIds: [sc.marketplaceId()] };
  if (type === 'GET_SELLER_FEEDBACK_DATA') {
    const end = new Date(); const start = new Date(end.getTime() - 30 * 86400000);
    body.dataStartTime = start.toISOString(); body.dataEndTime = end.toISOString();
  }
  const r = await spRequest('POST', '/reports/2021-06-30/reports', {}, body, sc.account);
  return r && r.reportId ? r : { error: JSON.stringify((r && r.errors) || r).slice(0, 300) };
}
async function download(documentId, account) {
  const doc = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`, {}, null, account);
  const buf = Buffer.from(await (await fetch(doc.url)).arrayBuffer());
  return (doc.compressionAlgorithm === 'GZIP' ? zlib.gunzipSync(buf) : buf).toString('utf8');
}

// ── Performance report → Daily Health, Metrics Detail, Changes ─────────────
async function writePerformance(sc, date, text) {
  const json = JSON.parse(text);
  const mid = sc.marketplaceId();
  const accountStatus = ((json.accountStatuses || []).find(a => a.marketplaceId === mid) || (json.accountStatuses || [])[0] || {}).status || '';
  const perf = (json.performanceMetrics || []).find(p => !p.marketplaceId || p.marketplaceId === mid) || (json.performanceMetrics || [])[0] || {};
  const metrics = flatten(perf);
  metrics.__accountStatus = accountStatus;

  // Metrics Detail rows (+ the account status itself as a metric)
  const detail = [[date, sc.label, sc.marketplace, 'accountStatus', accountStatus, '', '', '', '', '', '', '', '']];
  for (const [path, m] of Object.entries(metrics)) {
    if (path.startsWith('__')) continue;
    detail.push([date, sc.label, sc.marketplace, path, m.status ?? '', m.value ?? '', m.target ?? '', m.condition ?? '', m.defects ?? '', m.orders ?? '', m.from ?? '', m.to ?? '', m.extra ? JSON.stringify(m.extra).slice(0, 500) : '']);
  }
  const health = [date, sc.label, sc.marketplace, ...HEALTH_COLS.map(([, f]) => { const v = f(metrics); return v == null ? '' : v; }), new Date().toISOString()];

  // Changes vs the previous snapshot of this account + marketplace
  const prevRows = await readTab(SHEETS.metrics);
  const prevDate = prevRows.filter(r => r[1] === sc.label && r[2] === sc.marketplace && r[0] < date).map(r => r[0]).sort().pop();
  const changes = [];
  if (prevDate) {
    const prev = new Map(prevRows.filter(r => r[1] === sc.label && r[2] === sc.marketplace && r[0] === prevDate).map(r => [r[3], r]));
    for (const row of detail) {
      const p = prev.get(row[3]);
      if (!p) { changes.push([date, sc.label, sc.marketplace, row[3], 'metric', '(none)', 'new metric', 'new', prevDate]); continue; }
      for (const [field, i] of [['status', 4], ['value', 5], ['defects_count', 8]]) {
        const a = String(p[i] ?? '').trim(), b = String(row[i] ?? '').trim();
        if (a === b || (a === '' && b === '')) continue;
        changes.push([date, sc.label, sc.marketplace, row[3], field, a || '(blank)', b || '(blank)', direction(field, row[3], a, b), prevDate]);
      }
    }
  }

  // Write: replace any rows already written for this account + marketplace + date (re-runs)
  await upsertRows(SHEETS.health, HEALTH_HEADERS, [health], r => r[0] === date && r[1] === sc.label && r[2] === sc.marketplace);
  await upsertRows(SHEETS.metrics, METRIC_HEADERS, detail, r => r[0] === date && r[1] === sc.label && r[2] === sc.marketplace);
  await upsertRows(SHEETS.changes, CHANGE_HEADERS, changes, r => r[0] === date && r[1] === sc.label && r[2] === sc.marketplace);
  return { status: 'written', accountStatus, metrics: detail.length, changes: changes.length, comparedWith: prevDate || '(first snapshot)' };
}

// Every object in the report that looks like a metric → { status, value, target, … }
function flatten(obj, path = '', out = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const keys = Object.keys(obj);
  const isMetric = keys.some(k => /^(status|rate|defectsCount|targetValue|ahrStatus|ahrScore|count|score)$/i.test(k));
  if (isMetric && path) {
    const rd = obj.reportingDateRange || {};
    const target = obj.targetValue ?? obj.target ?? '';
    out[path] = {
      status: obj.status ?? obj.ahrStatus ?? '',
      value: obj.rate ?? obj.ahrScore ?? obj.score ?? obj.value ?? (obj.defectsCount != null && obj.ordersCount ? +(obj.defectsCount / obj.ordersCount).toFixed(4) : ''),
      target, condition: obj.targetCondition ?? '',
      defects: obj.defectsCount ?? obj.count ?? '', orders: obj.ordersCount ?? obj.orderCount ?? '',
      from: rd.reportingDateFrom ?? '', to: rd.reportingDateTo ?? '',
      extra: Object.fromEntries(Object.entries(obj).filter(([k, v]) => typeof v !== 'object' && !/^(status|rate|defectsCount|targetValue|targetCondition|ordersCount|ahrStatus|ahrScore|count|score|value|target)$/i.test(k))),
    };
  }
  for (const k of keys) if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]) && k !== 'reportingDateRange') flatten(obj[k], path ? `${path}.${k}` : k, out);
  for (const k of keys) if (Array.isArray(obj[k])) obj[k].forEach((v, i) => flatten(v, `${path ? path + '.' : ''}${k}[${i}]`, out));
  return out;
}
function pick(metrics, re, field) {
  const hit = Object.entries(metrics).find(([p]) => re.test(p.toLowerCase().replace(/[^a-z]/g, '')));
  if (!hit) return null;
  const m = hit[1];
  return field === 'defects' ? (m.defects !== '' ? m.defects : m.value) : m[field];
}
function direction(field, metric, a, b) {
  if (field === 'status' || metric === 'accountStatus') {
    if (BAD_STATUS.test(b) && !BAD_STATUS.test(a)) return 'worse';
    if (BAD_STATUS.test(a) && !BAD_STATUS.test(b)) return 'better';
    return 'changed';
  }
  const x = parseFloat(a), y = parseFloat(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'changed';
  if (/accounthealthrating|ahr|ontimedelivery|validtracking/i.test(metric)) return y > x ? 'better' : 'worse'; // higher is better
  return y > x ? 'worse' : 'better';                                                                        // rates / counts: higher is worse
}

// ── Listing issues (ADDED 2026-11-16) ──────────────────────────────────────
async function writeListingIssues(sc, date, fypText) {
  const scopeBrands = brands.filter(b => b.active && accountForBrand(b) === sc.account
    && ((b.marketplaceId || process.env.SP_MARKETPLACE_ID) === sc.marketplaceId()));
  const brandForSku = sku => {
    const s = String(sku || '').toUpperCase();
    const hits = scopeBrands.filter(b => b.skuPrefix && s.startsWith(b.skuPrefix.toUpperCase()));
    return (hits.find(b => /-CA(-|\.|$)/i.test(s) === !!b.marketplaceId) || hits[0] || {}).displayName || '';
  };
  const rows = [];
  const add = (brand, sku, asin, source, status, issue, code, severity, enforcement, details) =>
    rows.push([date, sc.label, sc.marketplace, brand, sku, asin, source, status, issue, code, severity, enforcement, '', details ? JSON.stringify(details).slice(0, 500) : '']);

  // 1. Suppressed Listings report — every row is a suppression (Amazon's own reason)
  if (fypText) {
    const lines = fypText.split(/\r?\n/).filter(l => l.trim());
    const cells = l => l.split('\t').map(v => v.trim().replace(/^"(.*)"$/, '$1'));
    const head = lines.length ? cells(lines.shift()).map(h => h.toLowerCase()) : [];
    const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
    const iSku = col('sku', 'seller-sku'), iAsin = col('asin'), iStatus = col('status'), iReason = col('reason', 'issue', 'description');
    for (const l of lines) {
      const c = cells(l);
      const sku = c[iSku] || '';
      if (!sku) continue;
      add(brandForSku(sku), sku, c[iAsin] || '', 'Suppressed Listings report', c[iStatus] || 'Suppressed', c[iReason] || '', '', '', 'LISTING_SUPPRESSED',
        Object.fromEntries(head.map((h, i) => [h, c[i]]).filter(([h, v]) => v && ![iSku, iAsin, iStatus, iReason].includes(head.indexOf(h)))));
    }
  }

  // 2 + 3. Listing issues from the Products Cache (FBA) and the FBM tabs
  const fromIssues = (brand, sku, asin, status, issuesCell, source) => {
    for (const issue of String(issuesCell || '').split(' | ').map(x => x.trim()).filter(Boolean)) {
      const tags = ((issue.match(/\{([^}]*)\}\s*$/) || [, ''])[1]).split(';').map(t => t.trim()).filter(Boolean);
      const sev = (issue.match(/^\[([A-Z]+)\]/) || [, ''])[1];
      const msg = issue.replace(/^\[[A-Z]+\]\s*/, '').replace(/\s*\{[^}]*\}\s*$/, '');
      const enforced = tags.filter(t => ENFORCED.test(t));
      if (!enforced.length && !POLICY.test(msg)) continue;
      const attrs = (msg.match(/^([^:]*):/) || [, ''])[1];
      add(brand, sku, asin, source, status, msg.replace(/^[^:]*:\s*/, ''), attrs, sev, enforced.join('; ') || tags.join('; '), null);
    }
  };
  for (const b of scopeBrands) {
    const cache = await latestRows(sheetsConfig.products, b.tabName, ['date', 'sku', 'asin', 'status', 'issues']).catch(() => []);
    cache.forEach(r => fromIssues(b.displayName || b.id, r.sku, r.asin, r.status, r.issues, 'Listing (FBA SKU)'));
    const fbm = await latestRows(SF_SHEET, `${b.tabName} fbm`, ['date', 'fbm_sku', 'asin', 'status', 'issues']).catch(() => []);
    fbm.forEach(r => fromIssues(b.displayName || b.id, r.fbm_sku, r.asin, r.status, r.issues, 'Listing (FBM SKU)'));
    await sleep(300);
  }

  // De-duplicate (same SKU + issue from two sources keeps the first), carry first_seen
  const seenKey = new Set(); const unique = [];
  for (const r of rows) { const k = `${r[4]}|${r[8]}`; if (seenKey.has(k)) continue; seenKey.add(k); unique.push(r); }
  const history = await readTab(SHEETS.issues);
  const first = new Map();
  history.filter(h => h[1] === sc.label && h[2] === sc.marketplace).forEach(h => {
    const k = `${h[4]}|${h[8]}`; const f = h[12] || h[0];
    if (!first.has(k) || f < first.get(k)) first.set(k, f);
  });
  unique.forEach(r => { r[12] = first.get(`${r[4]}|${r[8]}`) || date; });
  await upsertRows(SHEETS.issues, ISSUE_HEADERS, unique, r => r[0] === date && r[1] === sc.label && r[2] === sc.marketplace);
  return { status: 'written', listingsWithIssues: new Set(unique.map(r => r[4])).size, issues: unique.length,
    newToday: unique.filter(r => r[12] === date).length, suppressedReport: fypText ? 'read' : 'none suppressed' };
}

// The latest day's rows of a tab, only the named columns (by header).
async function latestRows(sheetId, tab, cols) {
  const token = await getSheetsToken(sheetId);
  const head = await sheetsApi(token, 'GET', `/${sheetId}/values/${rng(tab, 'A1:ZZ1')}`);
  const h = ((head.values || [])[0] || []).map(x => String(x).trim());
  const idx = cols.map(c => h.indexOf(c));
  if (idx[0] < 0) return [];
  const letter = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const got = await sheetsApi(token, 'GET', `/${sheetId}/values:batchGet?majorDimension=COLUMNS&${idx.filter(i => i >= 0).map(i => `ranges=${rng(tab, `${letter(i)}2:${letter(i)}`)}`).join('&')}`);
  const colsData = {}; let k = 0;
  cols.forEach((c, j) => { colsData[c] = idx[j] >= 0 ? ((got.valueRanges[k++] || {}).values || [[]])[0] || [] : []; });
  const isoOf = v => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : ''; };
  const dates = colsData.date.map(isoOf);
  const latest = dates.filter(Boolean).sort().pop();
  const out = [];
  dates.forEach((d, i) => { if (d === latest) out.push(Object.fromEntries(cols.map(c => [c, String(colsData[c][i] ?? '').replace(/^'/, '')]))); });
  return out;
}

// ── Violation scan (ADDED 2026-11-16) ──────────────────────────────────────
async function violationScan(meta, today) {
  const started = Date.now();
  const scanBrands = sc => brands.filter(b => b.active && !SCAN_EXCLUDED_BRANDS.includes(b.id) && accountForBrand(b) === sc.account
    && ((b.marketplaceId || process.env.SP_MARKETPLACE_ID) === sc.marketplaceId()));
  const brandOf = (sc, sku) => {
    const s = String(sku || '').toUpperCase();
    const hits = scanBrands(sc).filter(b => b.skuPrefix && s.startsWith(b.skuPrefix.toUpperCase()));
    return hits.find(b => /-CA(-|\.|$)/i.test(s) === !!b.marketplaceId) || hits[0] || null;
  };
  if (meta.scan_done_date === today) return { allDone: true, accounts: [], note: `today's scan already finished (${today})`, sheet: 'Metrics Detail → inactive_listings' };
  let state = {}; try { state = JSON.parse(meta.scan_state || '{}'); } catch { state = {}; }
  if (Object.values(state).some(v => v.date && v.date !== today)) state = {}; // a scan left over from another day starts over
  const summary = [];

  for (const sc of SCOPES) {
    const st = state[sc.key] || (state[sc.key] = {});
    if (!scanBrands(sc).length) { st.done = true; st.date = today; st.found = 0; summary.push({ scope: sc.key, status: 'no cron brands on this account' }); continue; }

    // 1. Request the two reports (once per scan)
    if (!st.allId && !st.done) {
      const a = await requestRaw(sc, 'GET_MERCHANT_LISTINGS_ALL_DATA');
      const s2 = await requestRaw(sc, 'GET_STRANDED_INVENTORY_UI_DATA');
      st.allId = a.reportId || null; st.strandedId = s2.reportId || null; st.date = today; st.queue = null; st.found = 0;
      await upsertRows(SHEETS.scan, SCAN_HEADERS, [], r => r[0] === today && r[1] === sc.label && r[2] === sc.marketplace); // a re-run replaces today's rows
      summary.push({ scope: sc.key, status: st.allId ? 'reports requested — run again in a few minutes' : `could not request: ${a.error}` });
      continue;
    }
    if (st.done) { summary.push({ scope: sc.key, status: 'done', found: st.found }); continue; }

    // 2a. Build the queue from the All Listings report (+ stranded rows) once ready
    if (!st.queue) {
      const all = await reportText(sc, st.allId);
      if (all.waiting) { summary.push({ scope: sc.key, status: `All Listings report still ${all.waiting} — run again shortly` }); continue; }
      const rows = [];
      if (all.text) {
        const t = tsv(all.text);
        for (const r of t.rows) {
          const sku = r['seller-sku'] || r.sku || '';
          const b = brandOf(sc, sku);
          if (!b) continue;                                       // not a cron brand
          const status = r.status || '';
          if (/^active$/i.test(status)) continue;                // active SKUs are already in listing_issues
          rows.push({ sku, asin: r.asin1 || r.asin || '', status, brand: b.displayName || b.id });
        }
      }
      st.queue = rows; st.checked = 0;
      // Stranded inventory: removal / policy reasons go straight in
      const stranded = st.strandedId ? await reportText(sc, st.strandedId) : { text: '' };
      if (stranded.text) {
        const t = tsv(stranded.text); const add = [];
        for (const r of t.rows) {
          const sku = r.sku || r['seller-sku'] || ''; const b = brandOf(sc, sku);
          const reason = [r['stranded-reason'], r['primary-action'], r['status-primary'], r['status-secondary'], r.reason].filter(Boolean).join(' · ');
          if (!b) continue;
          add.push([today, sc.label, sc.marketplace, b.displayName || b.id, sku, r.asin || '', 'Stranded', 'Stranded inventory report', '', reason || 'Stranded', '', '']);
        }
        if (add.length) { await writeScanRows(sc, add, today); st.found += add.length; }
      }
    }

    // 2b. Ask the Listings API about each queued SKU (resumes next run)
    const found = [];
    while (st.checked < st.queue.length && Date.now() - started < SCAN_BUDGET_MS) {
      const q = st.queue[st.checked++];
      let listing;
      try {
        listing = await spRequest('GET', `/listings/2021-08-01/items/${await sellerIdFor(sc)}/${encodeURIComponent(q.sku)}`,
          { marketplaceIds: sc.marketplaceId(), includedData: 'summaries,issues' }, null, sc.account);
      } catch { continue; }
      for (const iss of (listing && listing.issues) || []) {
        const actions = (iss.enforcements?.actions || []).map(a => a.action).filter(Boolean);
        const msg = String(iss.message || '').trim();
        if (!msg) continue;
        found.push([today, sc.label, sc.marketplace, q.brand, q.sku, q.asin, q.status, 'Listings API', iss.severity || '', msg, actions.join('; '), '']);
      }
      await sleep(220);
    }
    if (found.length) { await writeScanRows(sc, found, today); st.found += found.length; }
    if (st.checked >= st.queue.length) { st.done = true; st.queue = []; }
    summary.push({ scope: sc.key, status: st.done ? 'done' : 'in progress — run again', inactiveSkusChecked: st.checked, toCheck: st.done ? 0 : st.queue.length - st.checked, violationsFound: st.found });
  }
  // A finished scan can be started again later: clear its state when every account is done.
  const allDone = SCOPES.every(sc => !state[sc.key] || state[sc.key].done);
  meta.scan_state = allDone ? '{}' : JSON.stringify(state);
  if (allDone) meta.scan_done_date = today; // once a day
  return { allDone, accounts: summary, sheet: 'Metrics Detail → inactive_listings' };
}
async function requestRaw(sc, type) {
  const r = await spRequest('POST', '/reports/2021-06-30/reports', {}, { reportType: type, marketplaceIds: [sc.marketplaceId()] }, sc.account).catch(e => ({ error: e.message }));
  return r && r.reportId ? r : { error: JSON.stringify((r && (r.errors || r.error)) || r).slice(0, 200) };
}
async function reportText(sc, reportId) {
  const rep = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`, {}, null, sc.account);
  if (['IN_QUEUE', 'IN_PROGRESS'].includes(rep.processingStatus)) return { waiting: rep.processingStatus.toLowerCase().replace('_', ' ') };
  if (rep.processingStatus !== 'DONE') return { text: '' };
  return { text: await download(rep.reportDocumentId, sc.account) };
}
function tsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const cell = v => v.trim().replace(/^"(.*)"$/, '$1');
  const head = (lines.shift() || '').split('\t').map(h => cell(h).toLowerCase());
  return { head, rows: lines.map(l => { const c = l.split('\t').map(cell); return Object.fromEntries(head.map((h, i) => [h, c[i] || ''])); }) };
}
const sellerIds = {};
async function sellerIdFor(sc) {
  if (!sellerIds[sc.account]) sellerIds[sc.account] = require('../_spauth').getSellerId(sc.account);
  return sellerIds[sc.account];
}
async function writeScanRows(sc, rows, today) {
  const existing = await readTab(SHEETS.scan);
  const firstSeen = new Map(existing.map(r => [`${r[1]}|${r[2]}|${r[4]}|${r[9]}`, r[11] || r[0]]));
  const fresh = []; const batch = new Set();
  for (const r of rows) {
    const k = `${r[1]}|${r[2]}|${r[4]}|${r[9]}`;
    if (batch.has(k)) continue; batch.add(k);
    r[11] = firstSeen.get(k) || today;
    if (existing.some(e => e[0] === today && `${e[1]}|${e[2]}|${e[4]}|${e[9]}` === k)) continue; // already written today
    fresh.push(r);
  }
  if (fresh.length) await appendRows(SHEETS.scan, SCAN_HEADERS, fresh);
}

// ── Seller feedback ────────────────────────────────────────────────────────
async function writeFeedback(sc, text, today) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { status: 'written', newFeedback: 0 };
  const cells = l => l.split('\t').map(v => v.trim().replace(/^"(.*)"$/, '$1'));
  const head = cells(lines.shift()).map(h => h.toLowerCase());
  const col = n => head.findIndex(h => h.includes(n));
  const iDate = col('date'), iRating = col('rating'), iComments = col('comment'), iResp = col('response'), iOrder = col('order');
  const existing = await readTab(SHEETS.feedback);
  const seen = new Set(existing.map(r => `${r[1]}|${r[2]}|${r[6]}|${r[0]}`));
  const fresh = [];
  for (const l of lines) {
    const c = cells(l);
    const row = [c[iDate] || '', sc.label, sc.marketplace, c[iRating] || '', c[iComments] || '', iResp >= 0 ? c[iResp] || '' : '', c[iOrder] || '', today];
    const k = `${row[1]}|${row[2]}|${row[6]}|${row[0]}`;
    if (seen.has(k)) continue;
    seen.add(k); fresh.push(row);
  }
  if (fresh.length) await appendRows(SHEETS.feedback, FEEDBACK_HEADERS, fresh);
  return { status: 'written', feedbackInReport: lines.length, newFeedback: fresh.length };
}

// ── Meta ───────────────────────────────────────────────────────────────────
async function readMeta() {
  const rows = await readTab(SHEETS.meta);
  return Object.fromEntries(rows.filter(r => r[0]).map(r => [r[0], r[1] || '']));
}
async function writeMeta(meta) {
  const now = new Date().toISOString();
  const rows = Object.entries(meta).map(([k, v]) => [k, v, now]);
  await replaceTab(SHEETS.meta, META_HEADERS, rows);
}

// ── Sheets (each sheet with its own Google service account, falling back) ──
const tokenCache = {};
async function tokenFor(sheet, other = false) {
  const acct = other ? (sheet.account === 'writer' ? 'primary' : 'writer') : sheet.account;
  if (!tokenCache[acct]) tokenCache[acct] = await getSheetsToken(acct);
  return tokenCache[acct];
}
async function api(sheet, method, path, body) {
  try { return await sheetsApi(await tokenFor(sheet), method, `/${sheet.id}${path}`, body); }
  catch (err) {
    if (!/ 40[34]:/.test(err.message)) throw err;
    console.warn(`[sync-account-health] ${sheet.tab}: ${sheet.account} account can't open the sheet — trying the other account (${err.message.slice(0, 80)})`);
    const result = await sheetsApi(await tokenFor(sheet, true), method, `/${sheet.id}${path}`, body);
    sheet.account = sheet.account === 'writer' ? 'primary' : 'writer'; // use the one that worked for the rest of this run
    return result;
  }
}
const ready = new Set();
async function ensureTab(sheet, headers) {
  if (ready.has(`${sheet.id}|${sheet.tab}`)) return; // per TAB: Metrics Detail holds two tabs
  const meta = await api(sheet, 'GET', '?fields=sheets.properties(sheetId,title)');
  const tabs = (meta.sheets || []).map(s => s.properties);
  if (!tabs.some(t => t.title === sheet.tab)) {
    const blank = tabs.find(t => /^Sheet1$/i.test(t.title));
    const peek = blank ? await api(sheet, 'GET', `/values/${rng(blank.title, 'A1:C3')}`) : null;
    const req = blank && !(peek.values || []).length
      ? { updateSheetProperties: { properties: { sheetId: blank.sheetId, title: sheet.tab, gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } }
      : { addSheet: { properties: { title: sheet.tab, gridProperties: { frozenRowCount: 1 } } } };
    await api(sheet, 'POST', ':batchUpdate', { requests: [req] });
  }
  await api(sheet, 'PUT', `/values/${rng(sheet.tab, 'A1')}?valueInputOption=RAW`, { values: [headers] });
  ready.add(`${sheet.id}|${sheet.tab}`);
}
async function readTab(sheet) {
  try {
    const d = await api(sheet, 'GET', `/values/${rng(sheet.tab, 'A2:ZZ')}`);
    return (d.values || []).map(r => r.map(v => String(v ?? '')));
  } catch (err) {
    if (/Unable to parse range|400/.test(err.message)) return []; // tab not created yet
    throw err;
  }
}
async function appendRows(sheet, headers, rows) {
  await ensureTab(sheet, headers);
  for (let i = 0; i < rows.length; i += 500) {
    await api(sheet, 'POST', `/values/${rng(sheet.tab, 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: rows.slice(i, i + 500) });
  }
}
async function replaceTab(sheet, headers, rows) {
  await ensureTab(sheet, headers);
  await api(sheet, 'POST', `/values/${rng(sheet.tab, 'A2:ZZ')}:clear`, {});
  if (rows.length) await api(sheet, 'PUT', `/values/${rng(sheet.tab, 'A2')}?valueInputOption=USER_ENTERED`, { values: rows });
}
// Keep every row except the ones `drop` matches, then add the new ones.
async function upsertRows(sheet, headers, rows, drop) {
  await ensureTab(sheet, headers);
  const existing = await readTab(sheet);
  const keep = existing.filter(r => !drop(r));
  if (keep.length === existing.length) { if (rows.length) await appendRows(sheet, headers, rows); return; }
  await replaceTab(sheet, headers, [...keep, ...rows]);
}

const RETRY_WAITS_MS = [2000, 4000, 8000, 16000, 20000, 30000];
async function sheetsApi(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || (res.status >= 500 && attempt < 4);
    if (retryable && attempt < RETRY_WAITS_MS.length) { await sleep(RETRY_WAITS_MS[attempt] + Math.floor(Math.random() * 1500)); continue; }
    throw new Error(`Sheets ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
}
const rng = (tab, a1) => encodeURIComponent(`'${String(tab).replace(/'/g, "''")}'!${a1}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ageHours = iso => (Date.now() - new Date(iso).getTime()) / 3600000;
function todayEt() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
