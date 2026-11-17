/**
 * api/cron/sync-walmart-health.js
 * ADDED 2026-11-16 (per Jaclyn) — daily Walmart account health for the one
 * Walmart seller account (credentials: WALMART_CLIENT_ID / _SECRET / _PARTNER_ID,
 * the same ones sync-walmart-inventory.js uses).
 *
 * Walmart Seller Performance API (US), one call per metric (Walmart allows one
 * call per minute per metric, so a daily pull is well inside the limit):
 *   GET /v3/insights/performance/{metric}/summary?reportDuration=30
 *   GET /v3/insights/performance/{metric}/report?reportDuration=30   (order-level .xlsx)
 * Metrics: cancellations, on-time delivery (otd), valid tracking, seller response
 * (srr), late shipment, on-time shipment (sss/ots), carrier method accuracy
 * (sss/cma), ship-from location accuracy (sss/sfla), negative feedback, returns,
 * item not received. Paths confirmed in Walmart's docs are used as-is; for the
 * few not confirmed, the likely names are tried in turn and the one that works
 * is remembered in _meta.
 *
 * One spreadsheet (SHEET below), tabs created automatically:
 *   health_daily   one row per day: account status + each metric's rate and risk level
 *   metrics_detail SAME layout as the Amazon account-health sheets, as account
 *                  "Walmart" — so account-health-email.js shows Walmart like any
 *                  other account: date, account, marketplace, metric, status,
 *                  value (rate as a fraction), target, target_condition,
 *                  defects_count (orders impacted), orders_count, reporting_from,
 *                  reporting_to, details (drivers, GMV loss, trend, recommendations)
 *   defect_orders  the orders (and SKUs) behind every metric with impacted orders,
 *                  from Walmart's order-level report
 *   changes        SAME layout as Amazon's: what moved since the previous day
 *   _meta          which endpoint path worked per metric, last run
 * Account status: Walmart answers "Partner is SUSPENDED" while an account is
 * suspended (seen Nov 2026); that is recorded as status SUSPENDED.
 *
 * Manual: GET /api/cron/sync-walmart-health        (safe to re-run; today's rows are replaced)
 */

const https = require('https');
const XLSX = require('xlsx');
const { getSheetsToken } = require('../config/_sheets_client');
const { sendCronFailureAlert } = require('../_alerts');

const SHEET = '1AXGABShbHsPT5lBCY809a8RtWn0a9Lgm9CZzjGS6FzE';
const WM_HOST = 'marketplace.walmartapis.com';
const ACCOUNT = 'Walmart', MARKET = 'US', WINDOW = 30;

// key, label, candidate paths (first confirmed in Walmart docs), extra query
const METRICS = [
  ['cancellations', 'Cancellation rate', ['cancellations'], ''],
  ['onTimeDelivery', 'On-time delivery rate', ['otd'], '&shippingMethod=ALL_METHODS'],
  ['validTracking', 'Valid tracking rate', ['vtr', 'validTrackingRate'], ''],
  ['sellerResponse', 'Seller response rate', ['srr'], ''],
  ['lateShipment', 'Late shipment rate', ['sss/lsr', 'lsr', 'lateShipment'], ''],
  ['onTimeShipment', 'On-time shipment rate', ['sss/ots'], ''],
  ['carrierMethodAccuracy', 'Carrier method accuracy', ['sss/cma'], ''],
  ['shipFromAccuracy', 'Ship-from location accuracy', ['sss/sfla'], ''],
  ['negativeFeedback', 'Negative feedback rate', ['negativeFeedback'], ''],
  ['returns', 'Return rate', ['returns'], ''],
  ['itemNotReceived', 'Item not received rate', ['inr', 'itemNotReceived'], ''],
];
const TABS = {
  health:  { tab: 'health_daily', headers: ['date', 'account_status', ...METRICS.flatMap(([k]) => [`${k}_rate`, `${k}_risk`]), 'synced_at'] },
  metrics: { tab: 'metrics_detail', headers: ['date', 'account', 'marketplace', 'metric', 'status', 'value', 'target', 'target_condition', 'defects_count', 'orders_count', 'reporting_from', 'reporting_to', 'details'] },
  defects: { tab: 'defect_orders', headers: ['date', 'account', 'marketplace', 'metric', 'order_id', 'sku', 'item', 'order_date', 'reason', 'details'] },
  changes: { tab: 'changes', headers: ['date', 'account', 'marketplace', 'metric', 'field', 'from', 'to', 'direction', 'previous_snapshot'] },
  meta:    { tab: '_meta', headers: ['key', 'value', 'updated_at'] },
};
const BAD = /risk|attention|monitor|below|fail|suspend|poor|critical|not meet|does not/i;

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  for (const k of Object.keys(tokens)) delete tokens[k]; acct = 'writer'; tabsKnown = null; // fresh per run (FIXED 2026-11-17)
  const today = todayEt();
  const from = addDays(today, -WINDOW), to = addDays(today, -1);
  try {
    const meta = Object.fromEntries((await readTab('meta')).map(r => [r[0], r[1]]));
    const tokenRes = await getWalmartToken();
    const token = tokenRes.access_token;
    if (!token) throw new Error(`Walmart token: ${JSON.stringify(tokenRes).slice(0, 200)}`);

    let accountStatus = 'ACTIVE';
    const detail = [[today, ACCOUNT, MARKET, 'accountStatus', '', '', '', '', '', '', '', '', '']];
    const healthRow = { date: today };
    const defects = [];
    const results = [];

    for (const [key, label, paths, extra] of METRICS) {
      const tryPaths = meta[`path ${key}`] ? [meta[`path ${key}`], ...paths.filter(p => p !== meta[`path ${key}`])] : paths;
      let got = null, usedPath = null, lastErr = '';
      for (const p of tryPaths) {
        const r = await wmJson(`/v3/insights/performance/${p}/summary?reportDuration=${WINDOW}${extra}`, token).catch(e => ({ __err: e.message }));
        const text = JSON.stringify(r || {});
        if (/SUSPENDED/i.test(text)) { accountStatus = 'SUSPENDED'; lastErr = 'account suspended'; break; }
        if (r && r.payload) { got = r.payload; usedPath = p; break; }
        lastErr = (r && (r.__err || r.errors?.[0]?.description || r.errors?.[0]?.code || r.message)) || text.slice(0, 150);
        await sleep(400);
      }
      if (accountStatus === 'SUSPENDED') { results.push({ metric: key, status: 'skipped — account suspended' }); break; }
      if (!got) { results.push({ metric: key, status: 'not available', error: String(lastErr).slice(0, 150) }); continue; }
      meta[`path ${key}`] = usedPath;

      const rate = num(got.cumulativeRate ?? got.cumulativeAccuracy ?? got.rate);
      const std = parseStandard(got.standard || got.performanceStandard, got.recommendedRate ?? got.recommendedAccuracy);
      const risk = got.riskLevel || got.performanceRiskLevel
        || (Number.isFinite(rate) && Number.isFinite(std.value) ? (std.cond === 'GREATER_THAN' ? (rate / 100 >= std.value ? 'MEETS STANDARD' : 'BELOW RECOMMENDED') : (rate / 100 <= std.value ? 'MEETS STANDARD' : 'ABOVE RECOMMENDED')) : '');
      const impacted = got.ordersImpacted ?? got.impactedOrderCount ?? got.impactedCustomerCount ?? '';
      const details = {
        performanceRiskLevel: got.performanceRiskLevel, trend: got.cumulativeRateTrend || got.cumulativeAccuracyTrend, gmvLoss: got.gmvLoss,
        sellerAccountableDrivers: got.sellerAccountableDrivers || got.infractionDrivers, nonAccountableDrivers: got.nonAccountableDrivers,
        recommendations: (got.recommendations || []).map(x => x.recommendation).filter(Boolean), updated: got.updatedTimestamp,
      };
      detail.push([today, ACCOUNT, MARKET, key, risk, Number.isFinite(rate) ? +(rate / 100).toFixed(4) : '', Number.isFinite(std.value) ? std.value : '', std.cond,
        impacted === '' ? '' : impacted, '', from, to, JSON.stringify(details).slice(0, 1500)]);
      healthRow[`${key}_rate`] = Number.isFinite(rate) ? +(rate / 100).toFixed(4) : '';
      healthRow[`${key}_risk`] = risk;
      results.push({ metric: key, path: usedPath, rate: Number.isFinite(rate) ? `${rate}%` : '', risk, ordersImpacted: impacted });

      // Order-level report for any metric with impacted orders
      if (Number(impacted) > 0) {
        const buf = await wmBinary(`/v3/insights/performance/${usedPath}/report?reportDuration=${WINDOW}${extra}`, token).catch(() => null);
        const rows = buf ? parseReport(buf) : [];
        rows.forEach(r => defects.push([today, ACCOUNT, MARKET, key, r.order, r.sku, r.item, r.date, r.reason, r.details]));
        results[results.length - 1].defectOrders = rows.length;
      }
      await sleep(600);
    }

    detail[0][4] = accountStatus;
    healthRow.account_status = accountStatus;
    healthRow.synced_at = new Date().toISOString();

    // Changes vs the previous snapshot
    const prevAll = await readTab('metrics');
    const prevDate = prevAll.filter(r => r[0] < today).map(r => r[0]).sort().pop();
    const changes = [];
    if (prevDate) {
      const prev = new Map(prevAll.filter(r => r[0] === prevDate).map(r => [r[3], r]));
      for (const row of detail) {
        const p = prev.get(row[3]); if (!p) continue;
        for (const [field, i] of [['status', 4], ['value', 5], ['defects_count', 8]]) {
          const a = String(p[i] ?? '').trim(), b = String(row[i] ?? '').trim();
          if (a === b) continue;
          changes.push([today, ACCOUNT, MARKET, row[3], field, a || '(blank)', b || '(blank)', direction(row[3], field, a, b), prevDate]);
        }
      }
    }

    await upsert('metrics', detail, r => r[0] === today);
    await upsert('health', [TABS.health.headers.map(h => healthRow[h] ?? '')], r => r[0] === today);
    await upsert('changes', changes, r => r[0] === today);
    await upsert('defects', defects, r => r[0] === today);
    meta.last_run = new Date().toISOString();
    await replace('meta', Object.entries(meta).map(([k, v]) => [k, v, new Date().toISOString()]));

    const unavailable = results.filter(r => r.status === 'not available');
    if (unavailable.length === METRICS.length) await sendCronFailureAlert('sync-walmart-health', `No Walmart performance metric could be read: ${unavailable[0].error}`);
    return res.status(200).json({ date: today, accountStatus, window: `${from} → ${to}`, metrics: results, defectOrders: defects.length, changes: changes.length, comparedWith: prevDate || '(first snapshot)' });
  } catch (err) {
    console.error('[sync-walmart-health]', err.message);
    await sendCronFailureAlert('sync-walmart-health', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Walmart ────────────────────────────────────────────────────────────────
function headers(token, accept) {
  const h = {
    Authorization: `Basic ${Buffer.from(`${process.env.WALMART_CLIENT_ID}:${process.env.WALMART_CLIENT_SECRET}`).toString('base64')}`,
    'WM_SEC.ACCESS_TOKEN': token, 'WM_SVC.NAME': 'Walmart Marketplace', 'WM_QOS.CORRELATION_ID': `health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    'WM_SVC.VERSION': '1.0.0', 'WM_MARKET': 'US', Accept: accept,
  };
  if (process.env.WALMART_PARTNER_ID) h['WM_PARTNER.ID'] = process.env.WALMART_PARTNER_ID;
  return h;
}
function getWalmartToken() { // same call as sync-walmart-inventory.js
  return new Promise((resolve, reject) => {
    const id = process.env.WALMART_CLIENT_ID, secret = process.env.WALMART_CLIENT_SECRET;
    if (!id || !secret) return reject(new Error('WALMART credentials not set'));
    const body = 'grant_type=client_credentials';
    const h = { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      'WM_SVC.NAME': 'Walmart Marketplace', 'WM_QOS.CORRELATION_ID': `token-${Date.now()}`, 'WM_SVC.VERSION': '1.0.0', 'Content-Length': Buffer.byteLength(body) };
    if (process.env.WALMART_PARTNER_ID) h['WM_PARTNER.ID'] = process.env.WALMART_PARTNER_ID;
    const req = https.request({ hostname: WM_HOST, path: '/v3/token', method: 'POST', headers: h }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(`Token parse error (${r.statusCode}): ${d.slice(0, 200)}`)); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
function wmJson(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: WM_HOST, path, method: 'GET', headers: headers(token, 'application/json') }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ __err: `HTTP ${r.statusCode}: ${d.slice(0, 150)}` }); } });
    });
    req.on('error', reject); req.end();
  });
}
function wmBinary(path, token, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: WM_HOST, path, method: 'GET', headers: headers(token, 'application/octet-stream') }, r => {
      if ([301, 302, 303, 307].includes(r.statusCode) && r.headers.location && hops < 3) {
        r.resume();
        return https.get(r.headers.location, rr => { const cs = []; rr.on('data', c => cs.push(c)); rr.on('end', () => resolve(Buffer.concat(cs))); }).on('error', reject);
      }
      const cs = []; r.on('data', c => cs.push(c));
      r.on('end', () => (r.statusCode >= 200 && r.statusCode < 300 ? resolve(Buffer.concat(cs)) : reject(new Error(`report HTTP ${r.statusCode}`))));
    });
    req.on('error', reject); req.end();
  });
}
// Walmart's order-level reports differ per metric, so columns are found by name.
// FIXED 2026-11-17: the sheet starts with a title row ("Data current as of …");
// the real header row is found first. Reports for tracking / shipping metrics
// have no SKU — they carry PO #, sales order #, carrier and tracking number.
function parseReport(buf) {
  let grid = [];
  const quiet = console.error; console.error = () => {}; // the library warns "Bad uncompressed size" on Walmart's zips but reads them fine
  try { const wb = XLSX.read(buf, { type: 'buffer' }); grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false }); }
  catch { return []; } finally { console.error = quiet; }
  const hi = grid.findIndex(r => r.filter(c => String(c).trim()).length >= 3 && r.some(c => /po ?#|purchase order|sales order|order ?(number|#|id)|tracking/i.test(String(c))));
  if (hi < 0) return [];
  const head = grid[hi].map(h => String(h).trim());
  const col = re => head.findIndex(h => re.test(h));
  const iPo = col(/^po ?#|purchase ?order/i), iSo = col(/sales ?order/i), iSku = col(/sku/i), iItem = col(/item ?name|product ?name|title/i),
        iDate = col(/order ?date/i), iReason = col(/reason|defect|cause|marked late by/i), iCarrier = col(/^carrier/i), iTrack = col(/tracking/i);
  return grid.slice(hi + 1).filter(r => r.some(c => String(c).trim())).slice(0, 500).map(r => {
    const v = i => (i >= 0 ? String(r[i] ?? '').trim() : '');
    let reason = v(iReason);
    if (/marked late by/i.test(head[iReason] || '')) reason = `Marked late by ${reason || 0} day${reason === '1' ? '' : 's'}`;
    const extra = [v(iCarrier) && `Carrier ${v(iCarrier)}`, v(iTrack) && `tracking ${v(iTrack)}`].filter(Boolean).join(' · ');
    return { order: v(iPo) || v(iSo), sku: v(iSku), item: v(iItem), date: v(iDate), reason: [reason, extra].filter(Boolean).join(' · '),
      details: JSON.stringify(Object.fromEntries(head.map((h, i) => [h || `col${i + 1}`, String(r[i] ?? '').trim()]).filter(([, x]) => x))).slice(0, 500) };
  });
}
// "below 2%" → { value: 0.02, cond: 'LESS_THAN' }; "above 95%" → GREATER_THAN; else recommended rate (a minimum)
function parseStandard(text, recommended) {
  const m = String(text || '').match(/([\d.]+)\s*%/);
  if (m) return { value: +(+m[1] / 100).toFixed(4), cond: /below|or below|less|under|max/i.test(text) ? 'LESS_THAN' : 'GREATER_THAN' };
  if (recommended != null && recommended !== '') return { value: +(+recommended / 100).toFixed(4), cond: 'GREATER_THAN' };
  return { value: NaN, cond: '' };
}
function direction(metric, field, a, b) {
  if (field === 'status') return BAD.test(b) && !BAD.test(a) ? 'worse' : BAD.test(a) && !BAD.test(b) ? 'better' : 'changed';
  const x = parseFloat(a), y = parseFloat(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'changed';
  const higherIsBetter = /onTimeDelivery|validTracking|sellerResponse|onTimeShipment|Accuracy/i.test(metric);
  return (y > x) === higherIsBetter ? 'better' : 'worse';
}

// ── Sheets (writer account, falling back to the primary) ───────────────────
let acct = 'writer'; const tokens = {};
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    if (!tokens[acct]) tokens[acct] = await getSheetsToken(acct);
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET}${path}`, { method, headers: { Authorization: `Bearer ${tokens[acct]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.ok) return r.json();
    const t = await r.text();
    if (r.status === 401 && attempt < 1) { delete tokens[acct]; continue; } // expired sign-in: new one, retry once
    if ((r.status === 403 || r.status === 404) && acct === 'writer') { acct = 'primary'; continue; }
    if ((r.status === 429 || r.status >= 500) && attempt < 5) { await sleep(2000 * (attempt + 1)); continue; }
    throw new Error(`Sheets ${method} ${r.status}: ${t.slice(0, 200)}`);
  }
}
const rng = (tab, a1) => encodeURIComponent(`'${tab}'!${a1}`);
let tabsKnown = null;
async function ensure(key) {
  const { tab, headers } = TABS[key];
  if (!tabsKnown) {
    const m = await api('GET', '?fields=sheets.properties(sheetId,title)');
    tabsKnown = (m.sheets || []).map(s => s.properties);
  }
  if (!tabsKnown.some(t => t.title === tab)) {
    const blank = tabsKnown.find(t => /^Sheet1$/i.test(t.title));
    const req = blank ? { updateSheetProperties: { properties: { sheetId: blank.sheetId, title: tab, gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } }
      : { addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } };
    await api('POST', ':batchUpdate', { requests: [req] });
    if (blank) blank.title = tab; else tabsKnown.push({ title: tab });
  }
  await api('PUT', `/values/${rng(tab, 'A1')}?valueInputOption=RAW`, { values: [headers] });
}
async function readTab(key) {
  try { const d = await api('GET', `/values/${rng(TABS[key].tab, 'A2:ZZ')}`); return (d.values || []).map(r => r.map(v => String(v ?? ''))); }
  catch (e) { if (/400/.test(e.message)) return []; throw e; }
}
async function replace(key, rows) {
  await ensure(key);
  await api('POST', `/values/${rng(TABS[key].tab, 'A2:ZZ')}:clear`, {});
  if (rows.length) await api('PUT', `/values/${rng(TABS[key].tab, 'A2')}?valueInputOption=USER_ENTERED`, { values: rows });
}
async function upsert(key, rows, drop) {
  await ensure(key);
  const existing = await readTab(key);
  const keep = existing.filter(r => !drop(r));
  if (keep.length === existing.length) {
    if (rows.length) await api('POST', `/values/${rng(TABS[key].tab, 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: rows });
    return;
  }
  await replace(key, [...keep, ...rows]);
}

const num = v => (v === '' || v == null ? NaN : parseFloat(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function todayEt() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
