/**
 * api/cron/inventory-alert-email.js
 * ADDED 2026-11-23 (per Jaclyn) — weekly "Inventory Alert" email, Mondays.
 *
 * 1. LOW INVENTORY — products with under 30 days of cover:
 *      🔴 CRITICAL  under 30 days even counting FBM stock (no backup)
 *      🟡 FBA LOW   FBA alone under 30 days, FBM brings it to 30+
 *    FBA units = fulfillable + reserved (Products Cache, latest complete day).
 *    FBM units = the FBA SKU's own seller-fulfilled quantity + its -SF twin's
 *    fbm_quantity (the "-SF product sheet" fbm tabs). Inbound is NOT counted.
 *    Days of cover are forecast day by day: normal days use the average daily
 *    units sold over the last 90 days (FBA SKU + -SF SKU, by ASIN, from the
 *    orders sheet); days inside an event on the master Events tab count at
 *    EVENT_MULTIPLIER × (Brands column respected: blank = every brand, a
 *    brand's own row overrides it for that event + year).
 * 2. OUT OF STOCK — open periods in the OOS history sheet:
 *      🔴 FULLY OOS  out at FBA and FBM ('all_inventory' period open)
 *      🟡 FBA OOS    out at FBA, still selling through FBM
 *
 * Only master-list Amazon SKUs that are LIVE. Bundles (master "SKU Type" =
 * BUNDLE) and VMPs (virtual multi-packs, SKUs starting VMP_) are left out
 * entirely (ADDED 2026-11-23): Amazon never assigns them inventory — they're
 * sellable whenever their component SKUs are in stock, and those components
 * are checked individually. Also left out: dearcloud (closing),
 * the brands left out of every alert email, and Crème Shop SKUs on the
 * discontinued tab of "The Creme Shop Listing Tracking" (DISCONTINUED_LIST).
 * Recipients like Listing Alerts: ALWAYS_TO get every brand, each Brand
 * Manager (master list) gets their own SKUs. Sends only when something is listed.
 *
 * Uses the latest COMPLETE day: the products and FBM syncs are still running
 * Monday morning, so today's rows are ignored.
 *
 * Modes: ?testTo=a@medaltus.com (&as=all | someone@medaltus.com) · ?preview=true (&as=…) · ?force=true
 * Env: CRON_SECRET, ALERTS_API_KEY, SHEET_MASTER_SKU_LIST, optional SHEET_SF_PRODUCTS, FROM_EMAIL.
 */

const XLSX = require('xlsx');
const { getSheetsToken, readRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { sendCronFailureAlert } = require('../_alerts');
const { isoDate } = require('../_dates');

const DAYS_THRESHOLD = 30;
const VELOCITY_DAYS = 90;
const EVENT_MULTIPLIER = 2.5;
const SF_SHEET = process.env.SHEET_SF_PRODUCTS || '1eAkS2Jr30ewk57mP39wA9h6Z862pE1zlE9znTXsZi34';
const MASTER_GID = '164358627', EVENTS_GID = '347530381';
// Crème Shop SKUs to leave out (SKU in column A of the tab at this gid) — found by its ID, so a
// rename doesn't break it. Matched on the BASE SKU (CHANGED 2026-11-23): CRE0002-LABEL and
// CRE0020-STICKERLESS count as CRE0002 / CRE0020.
const DISCONTINUED_LIST = { id: '1Z7QkwbWUovCms5lrYxB-Wdroe5xfXUBLEh_sNprxlBk', gid: 1134932401, brandId: 'creme-shop' };
const baseSku = s => String(s || '').trim().toUpperCase().replace(/-(LABEL|STICKERLESS)\b.*$/, '');
const EXCLUDED_BRANDS = ['cimeosil', 'collagelee', 'hillside', 'dearcloud']; // dearcloud: closing (Nov 2026)
const LOG_TAB = 'email-log-inventory';
const ALWAYS_TO = ['awilcox@medaltus.com', 'jcarter@medaltus.com', 'sdeavies@medaltus.com', 'mgallagher@medaltus.com'];
const MANAGER_EMAILS = { 'jaclyn sonberg': 'jsonberg@medaltus.com', 'isabella fernandez': 'ifernandez@medaltus.com', 'lindsay rohde': 'lrohde@medaltus.com' };
const FROM_EMAIL = process.env.FROM_EMAIL || 'reports@medaltus.com';
const REPLY_TO = 'reports@medaltus.com';
const LOGO_URL = 'https://vbcosmeticsreport.medaltus.com/api/medaltus-logo';

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const testTo = String(req.query.testTo || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (testTo.some(e => !e.endsWith('@medaltus.com'))) return res.status(400).json({ error: 'testTo addresses must be @medaltus.com' });
  const preview = req.query.preview === 'true', force = req.query.force === 'true';
  const real = !testTo.length && !preview;
  const today = todayEt();

  try {
    if (real && !force) {
      const log = await readRows(sheets.products, LOG_TAB).catch(() => []);
      if ((log || []).some(r => String(r.sent_date || '').slice(0, 10) === today)) return res.status(200).json({ skipped: true, reason: `already sent today (${today})` });
    }
    const [master, events, discontinued] = await Promise.all([loadMaster(), loadEvents(), loadDiscontinued().catch(e => { console.warn('[inventory-alert] discontinued list:', e.message); return null; })]);
    const horizon = range(today, addDays(today, 120));
    skipTab = discontinued ? discontinued.tab : null;
    const low = [], oos = [], notes = [];
    if (discontinued === null) notes.push('The Crème Shop discontinued list could not be read — share "The Creme Shop Listing Tracking" with the service accounts; Crème Shop discontinued SKUs may appear.');

    for (const brand of brands.filter(b => b.active && !EXCLUDED_BRANDS.includes(b.id))) {
      const bName = brand.displayName || brand.id;
      const skip = sku => (brand.id === DISCONTINUED_LIST.brandId && discontinued && discontinued.skus.has(baseSku(sku)));
      const [cache, fbm, units, oosRows] = await Promise.all([
        latestComplete(sheets.products, brand.tabName, ['date', 'sku', 'asin', 'name', 'fulfillable_quantity', 'reserved_quantity', 'seller_fulfilled_quantity'], today).catch(() => []),
        latestComplete(SF_SHEET, `${brand.tabName} fbm`, ['date', 'fbm_sku', 'fba_sku', 'asin', 'fbm_quantity'], today).catch(() => []),
        unitsByAsin(brand, today).catch(() => new Map()),
        sheets.oosHistory ? readRows(sheets.oosHistory, brand.tabName).catch(() => []) : [],
      ]);
      const fbmBySku = new Map(); fbm.forEach(r => fbmBySku.set(String(r.fba_sku || '').toUpperCase(), num(r.fbm_quantity)));
      const fbmByAsin = new Map(); fbm.forEach(r => { const a = String(r.asin || '').toUpperCase(); fbmByAsin.set(a, (fbmByAsin.get(a) || 0) + num(r.fbm_quantity)); });
      const eventDays = eventDaysFor(events, brand);
      const openOos = new Map(); // asin -> { fba: start, all: start }
      for (const r of oosRows || []) {
        if (String(r.status || '').trim() !== 'open' && String(r.end_date || '').trim()) continue;
        const asin = String(r.asin || '').trim().toUpperCase(); const type = String(r.type || '').trim();
        if (!asin || !['fba', 'all_inventory'].includes(type)) continue;
        const o = openOos.get(asin) || {}; o[type === 'fba' ? 'fba' : 'all'] = isoDate(r.start_date) || ''; openOos.set(asin, o);
      }

      for (const r of cache) {
        const sku = String(r.sku || '').replace(/^'/, '').trim().toUpperCase();
        const asin = String(r.asin || '').replace(/^'/, '').trim().toUpperCase();
        const m = master.get(sku);
        if (!m || m.status !== 'LIVE' || skip(sku)) continue; // master-list LIVE Amazon SKUs only
        if (m.bundle || /^VMP_/i.test(sku)) continue;              // bundles & VMPs never hold their own inventory
        const fbaUnits = num(r.fulfillable_quantity) + num(r.reserved_quantity);
        const fbmUnits = num(r.seller_fulfilled_quantity) + (fbmBySku.has(sku) ? fbmBySku.get(sku) : (fbmByAsin.get(asin) || 0));
        const perDay = (units.get(asin) || 0) / VELOCITY_DAYS;
        const base = { brand: bName, brandId: brand.id, sku, asin, name: m.name || r.name || '', manager: m.manager, fbaUnits, fbmUnits, perDay };
        const o = openOos.get(asin);
        if (o && o.fba) { // out of stock at FBA
          const fully = !!o.all || fbmUnits <= 0;
          oos.push({ ...base, level: fully ? 'FULLY' : 'FBA', since: o.fba, days: o.fba ? daysBetween(o.fba, today) : null });
          continue;
        }
        if (fbaUnits <= 0 && perDay > 0) { // no open period yet (OOS since the last sync) — still out
          oos.push({ ...base, level: fbmUnits > 0 ? 'FBA' : 'FULLY', since: '', days: null });
          continue;
        }
        if (perDay <= 0) continue; // no sales in 90 days → no meaningful cover
        const fbaCover = coverDays(fbaUnits, perDay, horizon, eventDays);
        const allCover = coverDays(fbaUnits + fbmUnits, perDay, horizon, eventDays);
        if (fbaCover.days >= DAYS_THRESHOLD) continue;
        low.push({ ...base, level: allCover.days < DAYS_THRESHOLD ? 'CRITICAL' : 'FBA', fbaDays: fbaCover.days, allDays: allCover.days,
          runOut: fbaCover.date, allRunOut: allCover.date, eventBoost: fbaCover.eventDaysUsed > 0 || allCover.eventDaysUsed > 0 });
      }
      await sleep(400);
    }
    low.sort((a, b) => (a.level === b.level ? 0 : a.level === 'CRITICAL' ? -1 : 1) || a.allDays - b.allDays);
    oos.sort((a, b) => (a.level === b.level ? 0 : a.level === 'FULLY' ? -1 : 1) || b.perDay - a.perDay);

    if (!low.length && !oos.length && !preview && !testTo.length) return res.status(200).json({ sent: false, reason: 'nothing under 30 days and nothing out of stock', cremeShopSkipTab: skipTab });

    // Versions per recipient (like Listing Alerts)
    const emailOf = n => MANAGER_EMAILS[String(n || '').trim().toLowerCase()] || null;
    const all = { low, oos };
    const versions = new Map(ALWAYS_TO.map(e => [e, all]));
    const unknown = new Set();
    for (const kind of ['low', 'oos']) for (const x of all[kind]) {
      const e = emailOf(x.manager);
      if (!e) { if (x.manager) unknown.add(x.manager); continue; }
      if (ALWAYS_TO.includes(e)) continue;
      if (!versions.has(e)) versions.set(e, { low: [], oos: [] });
      versions.get(e)[kind].push(x);
    }
    if (unknown.size) notes.push(`Brand Manager names with no email on file (their SKUs only go to the full email): ${[...unknown].join(', ')}.`);
    const asParam = String(req.query.as || '').trim().toLowerCase();
    const pick = who => (who === 'all' || !versions.has(who) || ALWAYS_TO.includes(who)) ? { who: 'all', data: all } : { who, data: versions.get(who) };
    if (preview) { const v = pick(asParam || 'all'); res.setHeader('Content-Type', 'text/html'); return res.status(200).send(buildHtml(v.data, today, v.who, notes, null)); }
    if (!process.env.ALERTS_API_KEY) throw new Error('ALERTS_API_KEY is not set');

    const sends = testTo.length ? [{ to: testTo, ...pick(asParam || testTo[0]), test: true }]
      : [...versions.entries()].map(([who, data]) => ({ to: [who], who: ALWAYS_TO.includes(who) ? 'all' : who, data }));
    const results = [];
    for (const s of sends) {
      const { low: L, oos: O } = s.data;
      if (!L.length && !O.length) continue;
      const crit = L.filter(x => x.level === 'CRITICAL').length, full = O.filter(x => x.level === 'FULLY').length;
      const subject = `${s.test ? '[TEST] ' : ''}Inventory Alert — ${[crit ? `${crit} critical` : '', L.length - crit ? `${L.length - crit} FBA low` : '', O.length ? `${O.length} out of stock${full ? ` (${full} fully)` : ''}` : ''].filter(Boolean).join(' · ')} · ${fmtDay(today)}`;
      const html = buildHtml(s.data, today, s.who, notes, s.test ? (s.who === 'all' ? ALWAYS_TO : [s.who]) : null);
      const attachment = Buffer.from(XLSX.write(buildWorkbook(s.data), { type: 'buffer', bookType: 'xlsx' })).toString('base64');
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.ALERTS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `Medaltus Reports <${FROM_EMAIL}>`, reply_to: REPLY_TO, to: s.to, subject, html, attachments: [{ filename: `Inventory Alert_${today}.xlsx`, content: attachment }] }) });
      const body = await r.json().catch(() => ({}));
      results.push({ to: s.to, version: s.who, low: L.length, oos: O.length, ok: r.ok, id: body.id || null, error: r.ok ? undefined : JSON.stringify(body).slice(0, 200) });
      await sleep(600);
    }
    const failed = results.filter(r => !r.ok);
    if (failed.length) await sendCronFailureAlert('inventory-alert-email', failed.map(f => `${f.to.join(',')}: ${f.error}`).join('\n'));
    if (real && results.some(r => r.ok)) await logSend(today, low.length, oos.length, results);
    return res.status(200).json({ sent: results.some(r => r.ok), test: !!testTo.length, cremeShopSkipTab: skipTab, cremeShopSkusSkipped: discontinued ? discontinued.skus.size : 0, low: low.length, critical: low.filter(x => x.level === 'CRITICAL').length, oos: oos.length, emails: results });
  } catch (err) {
    console.error('[inventory-alert-email]', err.message);
    await sendCronFailureAlert('inventory-alert-email', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Forecast: day-by-day cover with event days at EVENT_MULTIPLIER × ──────
function coverDays(stock, perDay, days, eventDays) {
  let left = stock, used = 0;
  for (let i = 0; i < days.length; i++) {
    const ev = eventDays.has(days[i]); if (ev) used++;
    const need = perDay * (ev ? EVENT_MULTIPLIER : 1);
    if (left < need) return { days: i + left / need, date: days[i], eventDaysUsed: used };
    left -= need;
  }
  return { days: days.length, date: '', eventDaysUsed: used };
}
function eventDaysFor(events, brand) {
  const norm = v => String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const keys = [brand.id, brand.displayName, brand.tabName, brand.amazonBrandName].map(norm).filter(Boolean);
  const own = events.filter(e => e.brands.length && e.brands.some(b => keys.includes(norm(b))));
  const ownKeys = new Set(own.map(e => e.key));
  const set = new Set();
  for (const e of [...own, ...events.filter(e => !e.brands.length && !ownKeys.has(e.key))]) range(e.start, e.end).forEach(d => set.add(d));
  return set;
}

// ── Data ───────────────────────────────────────────────────────────────────
// The latest day BEFORE today in a tab (only the named columns).
async function latestComplete(sheetId, tab, cols, today) {
  const token = await getSheetsToken(sheetId);
  const api = async p => { const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${p}`, { headers: { Authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error(`${tab} ${r.status}`); return r.json(); };
  const q = `'${String(tab).replace(/'/g, "''")}'`;
  const head = (((await api(`/values/${encodeURIComponent(q + '!A1:ZZ1')}`)).values || [[]])[0] || []).map(h => String(h).trim());
  const idx = cols.map(c => head.indexOf(c));
  if (idx[0] < 0) return [];
  const letter = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const present = idx.filter(i => i >= 0);
  const got = await api(`/values:batchGet?majorDimension=COLUMNS&${present.map(i => `ranges=${encodeURIComponent(`${q}!${letter(i)}2:${letter(i)}`)}`).join('&')}`);
  const data = {}; let k = 0;
  cols.forEach((c, j) => { data[c] = idx[j] >= 0 ? (((got.valueRanges[k++] || {}).values || [[]])[0] || []) : []; });
  const dates = data.date.map(d => isoDate(d) || '');
  const latest = dates.filter(d => d && d < today).sort().pop();
  const out = [];
  dates.forEach((d, i) => { if (d === latest) out.push(Object.fromEntries(cols.map(c => [c, String(data[c][i] ?? '').replace(/^'/, '')]))); });
  return out;
}
// Units sold per ASIN over the last VELOCITY_DAYS complete days (FBA + -SF SKUs), cancelled excluded.
async function unitsByAsin(brand, today) {
  const rows = await readRows(sheets.orders, brand.tabName);
  const from = addDays(today, -VELOCITY_DAYS), map = new Map();
  for (const r of rows || []) {
    const d = isoDate(r.date); if (!d || d < from || d >= today) continue;
    if (/cancel/i.test(String(r.status || ''))) continue;
    const asin = String(r.asin || '').trim().toUpperCase(); if (!asin) continue;
    map.set(asin, (map.get(asin) || 0) + (num(r.unit_count) || num(r.quantity_ordered)));
  }
  return map;
}
async function loadMaster() {
  const rows = await csv(process.env.SHEET_MASTER_SKU_LIST, MASTER_GID);
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const col = (n, f) => { const i = head.indexOf(n.toLowerCase()); return i >= 0 ? i : f; };
  const iSku = col('SKU', 1), iName = col('Product Short Name', 2), iStatus = col('Status', 7), iMgr = col('Brand Manager', 26), iCh = col('Channel', 6), iType = col('SKU Type', 9);
  const map = new Map();
  for (const r of rows.slice(1)) {
    const sku = String(r[iSku] || '').trim().toUpperCase();
    if (!sku || !/amazon/i.test(String(r[iCh] || ''))) continue;
    map.set(sku, { name: String(r[iName] || '').trim(), status: String(r[iStatus] || '').trim().toUpperCase(), manager: String(r[iMgr] || '').trim(),
      bundle: /bundle/i.test(String(r[iType] || '')) || /^VMP_/i.test(sku) });
  }
  return map;
}
async function loadEvents() {
  const rows = await csv(process.env.SHEET_MASTER_SKU_LIST, EVENTS_GID);
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const i = n => head.indexOf(n);
  return rows.slice(1).map(x => { const name = String(x[i('event name')] || '').trim(), start = isoDate(x[i('start_date')]), end = isoDate(x[i('end_date')]) || start;
    return { name, start, end, key: `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}|${String(start).slice(0, 4)}`,
      brands: i('brands') >= 0 ? String(x[i('brands')] || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean) : [] }; }).filter(e => e.name && e.start);
}
async function loadDiscontinued() {
  const token = await getSheetsToken(DISCONTINUED_LIST.id);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${DISCONTINUED_LIST.id}`;
  const meta = await (await fetch(`${base}?fields=sheets.properties(sheetId,title)`, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (meta.error) throw new Error(meta.error.message);
  const tab = ((meta.sheets || []).find(s => s.properties.sheetId === DISCONTINUED_LIST.gid) || {}).properties;
  if (!tab) throw new Error('discontinued tab not found');
  const d = await (await fetch(`${base}/values/${encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'!A2:A`)}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  return { tab: tab.title, skus: new Set((d.values || []).map(r => baseSku(r[0])).filter(Boolean)) };
}
async function csv(id, gid) {
  if (!id) throw new Error('SHEET_MASTER_SKU_LIST env var not set');
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`);
  if (!r.ok) throw new Error(`CSV ${gid} → ${r.status}`);
  const text = await r.text(); const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c; }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}
async function logSend(today, low, oos, results) {
  const token = await getSheetsToken(sheets.products);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheets.products}`;
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const meta = await (await fetch(`${base}?fields=sheets.properties(title)`, { headers: h })).json();
  if (!(meta.sheets || []).some(s => s.properties.title === LOG_TAB)) {
    await fetch(`${base}:batchUpdate`, { method: 'POST', headers: h, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: LOG_TAB } } }] }) });
    await fetch(`${base}/values/${encodeURIComponent(`'${LOG_TAB}'!A1`)}?valueInputOption=RAW`, { method: 'PUT', headers: h, body: JSON.stringify({ values: [['sent_date', 'sent_at', 'low', 'oos', 'recipients']] }) });
  }
  await fetch(`${base}/values/${encodeURIComponent(`'${LOG_TAB}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: h,
    body: JSON.stringify({ values: [[today, new Date().toISOString(), low, oos, results.filter(r => r.ok).map(r => r.to.join(',')).join('; ')]] }) });
}

// ── Email ──────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtN = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const fmtRate = n => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
const fmtDays = d => (d >= 120 ? '120+' : d < 1 ? '<1' : d.toFixed(0));
let skipTab = null; // set per run (tab name of the Crème Shop list)
function buildHtml({ low, oos }, today, who, notes, testRecipients) {
  const th = 'padding:7px 9px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#fff;background:#001F60;text-align:left;font-family:Arial,sans-serif;';
  const td = 'padding:8px 9px;font-size:12px;color:#001F60;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;vertical-align:top;';
  const pill = (t, bg, fg) => `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-size:10px;font-weight:700;white-space:nowrap;">${t}</span>`;
  const crit = low.filter(x => x.level === 'CRITICAL').length, fully = oos.filter(x => x.level === 'FULLY').length;
  const tile = (l, v, c, sub) => `<td style="padding:0 8px 8px 0;vertical-align:top;"><div style="border:1px solid #e4e8ef;border-radius:10px;padding:10px 14px;min-width:170px;height:74px;box-sizing:border-box;">
    <div style="font-size:11px;color:#6B7BA2;text-transform:uppercase;letter-spacing:.05em;font-weight:700;">${esc(l)}</div><div style="font-size:26px;color:${c};font-weight:700;line-height:1.1;margin-top:2px;">${v}</div><div style="font-size:11px;color:#6B7BA2;">${sub || '&nbsp;'}</div></div></td>`;
  const tiles = tile('Critical (incl. FBM)', crit, crit ? '#C0392B' : '#1A7F5A', 'under 30 days with FBM') + tile('FBA low', low.length - crit, low.length - crit ? '#B7791F' : '#1A7F5A', 'FBM covers 30+ days')
    + tile('Fully out of stock', fully, fully ? '#C0392B' : '#1A7F5A', 'FBA and FBM') + tile('FBA out of stock', oos.length - fully, oos.length - fully ? '#B7791F' : '#1A7F5A', 'selling through FBM');
  const brandsIn = [...new Set([...low, ...oos].map(x => x.brand))].sort();
  const sections = brandsIn.map(b => {
    const L = low.filter(x => x.brand === b), O = oos.filter(x => x.brand === b);
    const lowTable = L.length ? `<div style="font-size:13px;font-weight:700;color:#001F60;margin:10px 0 4px;">Under ${DAYS_THRESHOLD} days of inventory · ${L.length}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
        <tr><th style="${th}"></th><th style="${th}">Product</th><th style="${th}">FBA units</th><th style="${th}">FBM units</th><th style="${th}">Sells / day</th><th style="${th}">Days at FBA</th><th style="${th}">Days incl. FBM</th><th style="${th}">FBA runs out</th></tr>
        ${L.map(x => { const c = x.level === 'CRITICAL'; return `<tr style="background:${c ? '#FFE3DE' : '#FFF8E6'};${c ? 'border-left:4px solid #C0392B;' : ''}">
          <td style="${td}">${c ? pill('CRITICAL', '#C0392B', '#fff') : pill('FBA LOW', '#FFE8A3', '#7A5B00')}</td>
          <td style="${td}"><b>${esc(x.sku)}</b> <span style="font-size:10px;color:#9ba8c0;">${esc(x.asin)}</span><div style="font-size:11px;color:#6B7BA2;">${esc(x.name)}</div></td>
          <td style="${td}">${fmtN(x.fbaUnits)}</td><td style="${td}">${fmtN(x.fbmUnits)}</td><td style="${td}">${fmtRate(x.perDay)}</td>
          <td style="${td}font-weight:700;color:${c ? '#C0392B' : '#B7791F'};">${fmtDays(x.fbaDays)}</td>
          <td style="${td}font-weight:700;color:${c ? '#C0392B' : '#1A7F5A'};${c ? 'font-size:14px;' : ''}">${fmtDays(x.allDays)}</td>
          <td style="${td}white-space:nowrap;">${x.runOut ? esc(fmtDay(x.runOut, true)) : '—'}${x.eventBoost ? '<div style="font-size:10px;color:#9ba8c0;">event sales ×2.5 included</div>' : ''}</td></tr>`; }).join('')}
      </table>` : '';
    const oosTable = O.length ? `<div style="font-size:13px;font-weight:700;color:#001F60;margin:12px 0 4px;">Out of stock · ${O.length}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
        <tr><th style="${th}"></th><th style="${th}">Product</th><th style="${th}">Out since</th><th style="${th}">FBM units</th><th style="${th}">Sold / day (90-day avg)</th></tr>
        ${O.map(x => { const f = x.level === 'FULLY'; return `<tr style="background:${f ? '#FFE3DE' : '#FFF8E6'};">
          <td style="${td}">${f ? pill('FULLY OOS', '#C0392B', '#fff') : pill('FBA OOS', '#FFE8A3', '#7A5B00')}</td>
          <td style="${td}"><b>${esc(x.sku)}</b> <span style="font-size:10px;color:#9ba8c0;">${esc(x.asin)}</span><div style="font-size:11px;color:#6B7BA2;">${esc(x.name)}</div></td>
          <td style="${td}white-space:nowrap;">${x.since ? `${esc(fmtDay(x.since, true))}<div style="font-size:10px;color:#9ba8c0;">${x.days} day${x.days === 1 ? '' : 's'}</div>` : 'since the last sync'}</td>
          <td style="${td}">${fmtN(x.fbmUnits)}</td><td style="${td}">${fmtRate(x.perDay)}</td></tr>`; }).join('')}
      </table>` : '';
    return `<tr><td style="padding:16px 32px 4px;"><div style="font-size:18px;font-weight:700;color:#001F60;font-family:Georgia,'Times New Roman',serif;border-bottom:2px solid #24E9A3;padding-bottom:4px;">${esc(b)}</div>${lowTable}${oosTable}</td></tr>`;
  }).join('');
  const scope = who && who !== 'all' ? `Your SKUs only — the full every-brand email goes to ${ALWAYS_TO.join(', ')}.` : '';
  const foot = [`Days of cover = units ÷ average daily sales over the last ${VELOCITY_DAYS} days (FBA and -SF SKUs), forecast day by day; days inside an event on the Events tab count at ${EVENT_MULTIPLIER}× sales. FBA = fulfillable + reserved; inbound shipments are not counted. Data: Sunday's syncs.`,
    `Left out: bundles and VMPs (they sell from their component SKUs, which are checked individually), dearcloud, Cimeosil, Collagelée, Hillside, SKUs not LIVE on the master list, and Crème Shop SKUs on the "${skipTab || 'discontinued'}" tab of The Creme Shop Listing Tracking (by base SKU — -LABEL / -STICKERLESS versions included).`, ...notes,
    testRecipients ? `TEST SEND — the real email would go to: ${testRecipients.join(', ')}.` : ''].filter(Boolean).map(n => `<div style="font-size:11px;color:#9ba8c0;margin-top:4px;">${esc(n)}</div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:32px 0;"><tr><td align="center">
    <table width="1100" cellpadding="0" cellspacing="0" style="width:1100px;max-width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <tr><td style="background:#001F60;padding:24px 32px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#24E9A3;font-weight:700;">NewDerm &middot; Amazon Inventory</div>
        <div style="font-size:24px;color:#fff;font-weight:700;margin-top:6px;font-family:Georgia,'Times New Roman',serif;">Inventory Alert</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px;">${esc(fmtDay(today))} &middot; under ${DAYS_THRESHOLD} days of inventory and out of stock</div>
        ${scope ? `<div style="font-size:12px;color:#24E9A3;margin-top:6px;">${esc(scope)}</div>` : ''}
      </td></tr>
      <tr><td style="padding:22px 32px 4px;"><table cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table></td></tr>
      ${sections || `<tr><td style="padding:16px 32px;font-size:13px;color:#1A7F5A;">Nothing under ${DAYS_THRESHOLD} days and nothing out of stock.</td></tr>`}
      <tr><td style="padding:14px 32px 24px;">${foot}</td></tr>
      <tr><td style="background:#001F60;padding:16px 32px;"><div style="padding-bottom:12px;"><img src="${LOGO_URL}" alt="Medaltus" height="22" style="height:22px;display:block;"></div>
        <span style="font-size:11px;color:#6B7BA2;">Medaltus automated report &middot; reports@medaltus.com</span></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
function buildWorkbook({ low, oos }) {
  const wb = XLSX.utils.book_new();
  const r1 = (n) => Math.round(n * 10) / 10;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Level', 'Brand', 'SKU', 'ASIN', 'Product', 'FBA units', 'FBM units', 'Sells / day (90-day avg)', 'Days at FBA', 'Days incl. FBM', 'FBA runs out', 'Event ×2.5 included', 'Brand Manager'],
    ...low.map(x => [x.level === 'CRITICAL' ? 'Critical (incl. FBM)' : 'FBA low', x.brand, x.sku, x.asin, x.name, x.fbaUnits, x.fbmUnits, r1(x.perDay), r1(x.fbaDays), r1(x.allDays), x.runOut, x.eventBoost ? 'yes' : '', x.manager])]), 'Under 30 days');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Level', 'Brand', 'SKU', 'ASIN', 'Product', 'Out since', 'Days out', 'FBM units', 'Sold / day (90-day avg)', 'Brand Manager'],
    ...oos.map(x => [x.level === 'FULLY' ? 'Fully OOS' : 'FBA OOS', x.brand, x.sku, x.asin, x.name, x.since, x.days ?? '', x.fbmUnits, r1(x.perDay), x.manager])]), 'Out of stock');
  return wb;
}

// ── Helpers ────────────────────────────────────────────────────────────────
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function todayEt() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function range(a, b) { const out = []; for (let d = a; d && d <= b; d = addDays(d, 1)) out.push(d); return out; }
function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000); }
function fmtDay(iso, short) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', short ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
