/**
 * api/cron/underperforming-email.js
 * ADDED 2026-11-16 (per Jaclyn) — weekly "Underperforming Products" email,
 * styled and routed like listing-alerts-email.js: Ashley gets every brand,
 * each Brand Manager (master list "Brand Manager" column) gets their own.
 * Sent Mondays, ~7:40 AM Eastern. Sends only if something qualifies.
 *
 * SOURCE: the Daily Business Report sheet (one tab per brand; DATE, ASIN,
 * SKU, SESSIONS, UNITS_ORDERED, ORDERED_PRODUCT_SALES, BUY_BOX_PCT …), NewDerm
 * and High On Love. Windows (all complete Pacific days, ending 2 days ago):
 *   CURRENT   the last 28 days
 *   PRIOR     the 28 days before that (month-over-month)
 *   BASELINE  the 84 days before CURRENT (trailing 3 months)
 *   LAST YEAR the same 28 days 52 weeks earlier (weekdays line up)
 * Every comparison uses per-day averages over the days in each window that
 * are NOT event days (the "events" tab in the Daily Business Report sheet,
 * which you maintain: event, start_date, end_date, brands [blank = all]),
 * so a Prime Day or Black Friday in either window never reads as a
 * decline. A window needs at least 14 usable days to be compared.
 *
 * ALERTS (thresholds per Jaclyn's notes):
 *   TRAFFIC     sessions down ≥30% vs PRIOR and ≥20% vs LAST YEAR (no
 *               last-year data → ≥30% below BASELINE instead); needs ≥150
 *               PRIOR-window sessions.
 *   SALES       units or revenue down ≥30% vs PRIOR and ≥20% vs LAST YEAR,
 *               or ≥35% below BASELINE; needs ≥20 baseline units and at
 *               least $200 of revenue lost over 28 days.
 *   CONVERSION  unit session % down ≥25% vs BASELINE while sessions are
 *               steady or up (≥90% of PRIOR); ≥200 sessions in both.
 * NOT FLAGGED (listed separately or left out):
 *   - out of FBA stock for ≥3 days of CURRENT (OOS history 'fba' periods)
 *     → "likely inventory" list, not ranked as a performance problem
 *   - not on the master SKU list as an Amazon LIVE SKU (discontinued etc.)
 *   - new products: no sales/traffic data in the first 28 days of BASELINE
 * CONTEXT shown on each product (not excuses — price stays flagged):
 *   - Buy Box % fell ≥15 points vs PRIOR (an offer problem)
 *   - average selling price (revenue ÷ units) up/down ≥10% vs PRIOR
 *   - listing not discoverable on Amazon today (Products Cache status)
 *   - "brand-wide": the product's revenue change is within 10 points of the
 *     REST of its brand's change (the product itself left out), so it may be
 *     seasonality or a budget change;
 *     these sort below products declining on their own.
 * PRIORITY: sorted by revenue at stake (lost revenue over 28 days vs
 * PRIOR, or vs LAST YEAR if larger), halved for brand-wide declines, so a
 * best-seller losing $2,400 ranks above a small product losing $100 even if
 * the small one dropped by a bigger %. Each row also shows the product's
 * share of its brand's sales.
 *
 * Modes (same as the other alert emails): ?testTo=…@medaltus.com (&as=…/all),
 * ?preview=true, ?date=YYYY-MM-DD (end day of CURRENT), ?force=true.
 * Env: CRON_SECRET, ALERTS_API_KEY, SHEET_MASTER_SKU_LIST, SHEET_OOS_HISTORY.
 */

const XLSX = require('xlsx');
const { getSheetsToken, readRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { sendCronFailureAlert } = require('../_alerts');
const { isoDate } = require('../_dates');

const DAILY_SHEET = '1QLjUvYg-JR6jQmdFlykypkNarqsZvTCOgA3bFagDlVg';
const EVENTS_TAB = 'events';
const EVENTS_HEADERS = ['event', 'start_date', 'end_date', 'brands', 'notes'];
const LOG_TAB = 'email-log-underperforming';
const MASTER_GID = '164358627';
const ALWAYS_TO = ['awilcox@medaltus.com'];
const MANAGER_EMAILS = {
  'jaclyn sonberg': 'jsonberg@medaltus.com',
  'isabella fernandez': 'ifernandez@medaltus.com',
  'lindsay rohde': 'lrohde@medaltus.com',
};
const FROM_EMAIL = process.env.FROM_EMAIL || 'reports@medaltus.com';
const REPLY_TO = 'reports@medaltus.com';
const LOGO_URL = 'https://vbcosmeticsreport.medaltus.com/api/medaltus-logo';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const ROWS_PER_BRAND = 15;

// ADDED 2026-11-16 per Jaclyn — brands never included in the alert emails.
// collagelee: merged into Cloud Café (2026-11-16); hillside: brand terminated (2026-11-16).
const EMAIL_EXCLUDED_BRANDS = ['cimeosil', 'collagelee', 'hillside'];

const T = { // thresholds
  trafficMoM: 0.30, trafficYoY: 0.20, trafficMinSessions: 150,
  salesMoM: 0.30, salesYoY: 0.20, salesBaseline: 0.35, salesMinUnits: 20, salesMinLoss: 200,
  cvrDrop: 0.25, cvrMinSessions: 200, cvrSteady: 0.90,
  minUsableDays: 14, oosDays: 3, buyboxDropPts: 15, priceMove: 0.10, brandWidePts: 10,
  // ADDED 2026-11-16 — minimums relative to brand size, so small brands get alerts too:
  // a product that's ≥10% of its brand's sales qualifies with lower floors.
  importantShare: 0.10, smallTrafficMin: 50, smallUnitsMin: 5, smallCvrMin: 80,
  lossShareOfBrand: 0.05, lossFloor: 50,
  brandAlertMoM: 0.30, brandAlertYoY: 0.20,
};
const SF_SHEET = process.env.SHEET_SF_PRODUCTS || '1eAkS2Jr30ewk57mP39wA9h6Z862pE1zlE9znTXsZi34';

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const testTo = String(req.query.testTo || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (testTo.some(e => !e.endsWith('@medaltus.com'))) return res.status(400).json({ error: 'testTo addresses must be @medaltus.com' });
  const preview = req.query.preview === 'true';
  const force = req.query.force === 'true';
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : addDays(todayEt(), -2);
  const W = {
    cur: range(addDays(end, -27), end),
    prior: range(addDays(end, -55), addDays(end, -28)),
    base: range(addDays(end, -111), addDays(end, -28)),
    yoy: range(addDays(end, -27 - 364), addDays(end, -364)),
  };

  try {
    const token = await getSheetsToken(DAILY_SHEET);
    const meta = await sheetsApi(token, 'GET', `/${DAILY_SHEET}?fields=sheets.properties(title)`);
    const tabs = new Set((meta.sheets || []).map(s => s.properties.title));

    if (!testTo.length && !preview && !force && tabs.has(LOG_TAB)) {
      const log = await sheetsApi(token, 'GET', `/${DAILY_SHEET}/values/${rng(LOG_TAB, 'A2:A')}`);
      if ((log.values || []).some(r => String(r[0] || '').slice(0, 10) === end)) return res.status(200).json({ skipped: true, reason: `already sent for ${end}` });
    }

    // ── Events (create the tab on first run) ────────────────────────────────
    if (!tabs.has(EVENTS_TAB)) {
      await sheetsApi(token, 'POST', `/${DAILY_SHEET}:batchUpdate`, { requests: [{ addSheet: { properties: { title: EVENTS_TAB, gridProperties: { rowCount: 200, columnCount: EVENTS_HEADERS.length, frozenRowCount: 1 } } } }] });
      await sheetsApi(token, 'PUT', `/${DAILY_SHEET}/values/${rng(EVENTS_TAB, 'A1')}?valueInputOption=RAW`, { values: [EVENTS_HEADERS] });
      tabs.add(EVENTS_TAB);
    }
    const ev = await sheetsApi(token, 'GET', `/${DAILY_SHEET}/values/${rng(EVENTS_TAB, 'A2:E')}`);
    const events = (ev.values || []).map(r => ({ name: r[0], start: isoDate(r[1]), end: isoDate(r[2]) || isoDate(r[1]),
      brands: String(r[3] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean) })).filter(e => e.start);
    const eventDaysFor = brandId => {
      const set = new Set();
      for (const e of events) if (!e.brands.length || e.brands.includes(brandId)) for (const d of range(e.start, e.end)) set.add(d);
      return set;
    };

    const master = await loadMaster();
    const wanted = new Set([...W.cur, ...W.base, ...W.yoy]);
    const cards = []; const inventory = []; const brandSummaries = {};

    for (const brand of brands.filter(b => b.active && !EMAIL_EXCLUDED_BRANDS.includes(b.id))) {
      const bName = brand.displayName || brand.id;
      if (!tabs.has(brand.tabName)) { brandSummaries[bName] = { note: 'Not in the Daily Business Report (no tab)' }; continue; }
      const evDays = eventDaysFor(brand.id);
      const days = await readDays(token, brand.tabName, wanted); // asin -> Map(date -> {s,u,r,bb,sku})
      if (!days.size) { brandSummaries[bName] = { note: 'No Daily Business Report data for these dates yet' }; continue; }
      const oos = await oosDaysByAsin(brand, W.cur);
      const pc = await productsCacheInfo(brand, W.prior[0]); // status + listing changes
      const status = pc.status;
      const competition = await competitionFor(brand);
      const ads = await adMonthsFor(brand, end); // ADDED 2026-11-16 — monthly ad vs organic

      // Brand totals, for "brand-wide" and share of sales.
      const brandAgg = { cur: agg(), prior: agg(), base: agg(), yoy: agg() };
      const per = [];
      for (const [asin, byDate] of days) {
        const sku = [...byDate.values()].map(v => v.sku).find(Boolean) || '';
        const m = master.get(sku.toUpperCase());
        const a = Object.fromEntries(Object.entries(W).map(([k, list]) => [k, sum(byDate, list, evDays)]));
        Object.keys(brandAgg).forEach(k => addAgg(brandAgg[k], a[k]));
        per.push({ asin, sku, m, a, byDate });
      }
      const brandChange = pctChange(brandAgg.prior.avg('r'), brandAgg.cur.avg('r'));
      const brandYoY = brandAgg.yoy.n >= T.minUsableDays ? pctChange(brandAgg.yoy.avg('r'), brandAgg.cur.avg('r')) : null;
      const summary = brandSummaries[bName] = {
        revenueVsPrior: brandChange, revenueVsLastYear: brandYoY,
        sessionsVsPrior: pctChange(brandAgg.prior.avg('s'), brandAgg.cur.avg('s')), curRevenue28: brandAgg.cur.avg('r') * 28,
        checked: 0, flagged: 0, inventory: 0, manager: '',
        brandAlert: brandChange != null && brandChange <= -T.brandAlertMoM && (brandYoY == null || brandYoY <= -T.brandAlertYoY),
      };
      const brandBaseRev = brandAgg.prior.avg('r') * 28 || 1;
      const minLoss = Math.max(T.lossFloor, Math.min(T.salesMinLoss, brandBaseRev * T.lossShareOfBrand));

      for (const p of per) {
        if (!p.m || p.m.status !== 'LIVE') continue;               // master list = source of truth
        if (!summary.manager && p.m.manager) summary.manager = p.m.manager;
        const firstBaseMonth = W.base.slice(0, 28);
        if (!firstBaseMonth.some(d => p.byDate.has(d))) continue;  // launched < ~90 days ago
        const { cur, prior, base, yoy } = p.a;
        if (cur.n < T.minUsableDays || prior.n < T.minUsableDays) continue;
        const hasYoy = yoy.n >= T.minUsableDays;
        summary.checked++;
        const important = (prior.avg('r') * 28) / brandBaseRev >= T.importantShare; // ≥10% of brand sales
        const d = {
          s: [pctChange(prior.avg('s'), cur.avg('s')), hasYoy ? pctChange(yoy.avg('s'), cur.avg('s')) : null, pctChange(base.avg('s'), cur.avg('s'))],
          u: [pctChange(prior.avg('u'), cur.avg('u')), hasYoy ? pctChange(yoy.avg('u'), cur.avg('u')) : null, pctChange(base.avg('u'), cur.avg('u'))],
          r: [pctChange(prior.avg('r'), cur.avg('r')), hasYoy ? pctChange(yoy.avg('r'), cur.avg('r')) : null, pctChange(base.avg('r'), cur.avg('r'))],
        };
        const flags = [];
        // TRAFFIC
        if ((prior.avg('s') * 28 >= T.trafficMinSessions || (important && prior.avg('s') * 28 >= T.smallTrafficMin)) && d.s[0] <= -T.trafficMoM && (hasYoy ? d.s[1] <= -T.trafficYoY : d.s[2] <= -T.trafficMoM)) flags.push('Traffic');
        // SALES
        const lost = Math.max((prior.avg('r') - cur.avg('r')) * 28, hasYoy ? (yoy.avg('r') - cur.avg('r')) * 28 : 0);
        const salesBy = k => (d[k][0] <= -T.salesMoM && (hasYoy ? d[k][1] <= -T.salesYoY : true)) || d[k][2] <= -T.salesBaseline;
        if ((base.avg('u') * 28 >= T.salesMinUnits || (important && base.avg('u') * 28 >= T.smallUnitsMin)) && lost >= minLoss && (salesBy('u') || salesBy('r'))) flags.push('Sales');
        // CONVERSION
        const cvr = x => (x.s ? x.u / x.s : 0);
        const cvrChange = pctChange(cvr(base), cvr(cur));
        const cvrMin = important ? T.smallCvrMin : T.cvrMinSessions;
        if (cur.s >= cvrMin && base.s >= cvrMin && cur.avg('s') >= prior.avg('s') * T.cvrSteady && cvrChange <= -T.cvrDrop) flags.push('Conversion');
        if (!flags.length) continue;

        const name = p.m.name || '';
        const oosCount = oos.get(p.asin) || 0;
        const row = {
          brand: brand.displayName || brand.id, brandId: brand.id, asin: p.asin, sku: p.sku, name, manager: p.m.manager, flags,
          share: (prior.avg('r') * 28) / brandBaseRev, lost: Math.max(0, lost),
          cur: { s: cur.avg('s') * 28, u: cur.avg('u') * 28, r: cur.avg('r') * 28, cvr: cvr(cur) }, d, cvrChange, cvrBase: cvr(base), hasYoy,
          context: [],
        };
        const bbPrior = prior.bbAvg(), bbCur = cur.bbAvg();
        if (bbPrior != null && bbCur != null && bbPrior - bbCur >= T.buyboxDropPts) row.context.push({ label: 'Buy Box', text: `${Math.round(bbPrior)}% → ${Math.round(bbCur)}% of the time` });
        const asp = x => (x.u ? x.r / x.u : null);
        const aspCh = asp(prior) && asp(cur) ? pctChange(asp(prior), asp(cur)) : null;
        if (aspCh != null && Math.abs(aspCh) >= T.priceMove) row.context.push({ label: 'Price', text: `avg ${aspCh > 0 ? 'up' : 'down'} ${Math.round(Math.abs(aspCh) * 100)}% ($${asp(prior).toFixed(2)} → $${asp(cur).toFixed(2)})` });
        if (status.get(p.asin) === 'hidden') row.context.push({ label: 'Listing', text: 'not discoverable on Amazon today' });
        const comp = competition.get(p.asin);
        if (comp) row.context.push({ label: 'Competition', text: comp });
        // Ads vs organic for the last two complete months (Ad Orders Cache is
        // monthly; organic units = total units − ad units for the same month).
        const ad = ads.byAsin.get(p.asin);
        if (ad && ads.months.length === 3) {
          // Per day for each period, so a partial current month compares fairly,
          // and total = ads + organic for the SAME days (they always add up).
          const per = ads.months.map(mo => {
            const days = ads.monthDays(mo.key);
            const total = days.reduce((n, d) => n + (p.byDate.get(d)?.u || 0), 0);
            const a = ad[mo.key] || { u: 0, spend: 0, sales: 0 };
            const n = days.length || 1;
            return { label: mo.label, total: total / n, ad: a.u / n, organic: Math.max(0, total - a.u) / n, spend: a.spend / n, adTotal: a.u, spendTotal: a.spend, adSales: a.sales, organicTotal: Math.max(0, total - a.u) };
          });
          const f = v => (v >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
          const line = key => per.map(x => `${x.label} ${f(x[key])}`).join(' · ');
          row.ads = per;
          row.context.unshift(
            { label: 'Units per day', text: line('total'), ads: true },
            { label: 'Ad units per day', text: `${line('ad')} · spend/day ${per.map(x => '$' + Math.round(x.spend).toLocaleString('en-US')).join(' · ')}`, ads: true },
            { label: 'Organic units per day', text: line('organic'), ads: true });
        }
        const changes = (pc.changes.get(p.asin) || []).slice(-3);
        if (changes.length) row.context.push({ label: 'Listing changes', text: changes.map(c => `${c.what} ${fmtDay(c.date)}`).join(' · ') });
        // Compare with the REST of the brand (this product left out), so a big
        // product's own drop can't make the brand look like it fell with it.
        const restChange = pctChange(brandAgg.prior.avg('r') - prior.avg('r'), brandAgg.cur.avg('r') - cur.avg('r'));
        const brandWide = restChange != null && d.r[0] != null && Math.abs(d.r[0] - restChange) * 100 <= T.brandWidePts;
        if (brandWide) row.context.push({ label: 'Brand-wide', text: `rest of the brand is ${fmtPct(restChange)} too` });
        const evInWindows = [...W.cur, ...W.prior, ...W.yoy].some(x => evDays.has(x));
        if (evInWindows) row.context.push({ label: 'Events', text: 'event days left out of the comparison' });
        row.priority = row.lost * (brandWide ? 0.5 : 1);

        if (oosCount >= T.oosDays) { inventory.push({ ...row, oosDays: oosCount }); summary.inventory++; }
        else { cards.push(row); summary.flagged++; }
      }
      await sleep(300);
    }

    const anyBrandAlert = Object.values(brandSummaries).some(b => b.brandAlert);
    if (!cards.length && !inventory.length && !anyBrandAlert) return res.status(200).json({ sent: false, reason: 'nothing qualifies', windowEnd: end, brandSummaries });

    // ── Versions per recipient ───────────────────────────────────────────────
    const emailOf = n => MANAGER_EMAILS[String(n || '').trim().toLowerCase()] || null;
    const all = { cards, inventory };
    const versions = new Map(ALWAYS_TO.map(e => [e, all]));
    for (const list of ['cards', 'inventory']) for (const c of all[list]) {
      const e = emailOf(c.manager);
      if (!e || ALWAYS_TO.includes(e)) continue;
      if (!versions.has(e)) versions.set(e, { cards: [], inventory: [] });
      versions.get(e)[list].push(c);
    }
    const unknownManagers = [...new Set([...cards, ...inventory].filter(c => c.manager && !emailOf(c.manager)).map(c => c.manager))];
    const asParam = String(req.query.as || '').trim().toLowerCase();
    const pick = who => (who === 'all' || !versions.has(who)) ? { who: 'all', data: all } : { who, data: versions.get(who) };
    const yr = list => fmtDay(list[0]).length && new Date(list[0] + 'T12:00:00Z').getUTCFullYear();
    const span = (list, withYear) => `${fmtDay(list[0])} – ${fmtDay(list[list.length - 1])}${withYear ? `, ${yr(list)}` : ''}`;
    const L = { cur: span(W.cur), prior: span(W.prior), yoy: span(W.yoy, true), base: span(W.base) }; // ADDED 2026-11-16 — real dates instead of "prior" / "last yr"
    const ctx = { W, end, brandSummaries, events, L };

    if (preview) {
      const v = pick(asParam || 'all');
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(buildHtml(v.data, ctx, v.who === 'all' ? unknownManagers : [], null, v.who));
    }
    if (!process.env.ALERTS_API_KEY) throw new Error('ALERTS_API_KEY is not set');
    const sends = testTo.length ? [{ to: testTo, ...pick(asParam || testTo[0]), test: true }]
      : [...versions.entries()].map(([who, data]) => ({ to: [who], who: ALWAYS_TO.includes(who) ? 'all' : who, data }));
    const results = [];
    for (const s of sends) {
      if (!s.data.cards.length && !s.data.inventory.length && !(s.who === 'all' && anyBrandAlert)) continue;
      const lost = s.data.cards.reduce((n, c) => n + c.lost, 0);
      const subject = `${s.test ? '[TEST] ' : ''}Underperforming Products — ${s.data.cards.length} to review, ~$${Math.round(lost).toLocaleString('en-US')} at stake · ${ctx.L.cur}`;
      const html = buildHtml(s.data, ctx, s.who === 'all' ? unknownManagers : [], s.test ? (s.who === 'all' ? ALWAYS_TO : [s.who]) : null, s.who);
      const attachment = Buffer.from(XLSX.write(buildWorkbook(s.data, ctx.L), { type: 'buffer', bookType: 'xlsx' })).toString('base64');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.ALERTS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `Medaltus Reports <${FROM_EMAIL}>`, reply_to: REPLY_TO, to: s.to, subject, html,
          attachments: [{ filename: `Underperforming Products_${end}.xlsx`, content: attachment }] }),
      });
      const body = await r.json().catch(() => ({}));
      results.push({ to: s.to, version: s.who, products: s.data.cards.length, inventory: s.data.inventory.length, ok: r.ok, id: body.id || null, error: r.ok ? undefined : JSON.stringify(body).slice(0, 200) });
      await sleep(600);
    }
    const failed = results.filter(r => !r.ok);
    if (failed.length) await sendCronFailureAlert('underperforming-email', failed.map(f => `${f.to.join(',')}: ${f.error}`).join('\n'));
    if (!testTo.length && results.some(r => r.ok)) {
      if (!tabs.has(LOG_TAB)) {
        await sheetsApi(token, 'POST', `/${DAILY_SHEET}:batchUpdate`, { requests: [{ addSheet: { properties: { title: LOG_TAB, gridProperties: { rowCount: 500, columnCount: 5 } } } }] });
        await sheetsApi(token, 'PUT', `/${DAILY_SHEET}/values/${rng(LOG_TAB, 'A1')}?valueInputOption=RAW`, { values: [['window_end', 'sent_at', 'products', 'recipients', 'message_ids']] });
      }
      await sheetsApi(token, 'POST', `/${DAILY_SHEET}/values/${rng(LOG_TAB, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [[end, new Date().toISOString(), cards.length,
        results.filter(r => r.ok).map(r => `${r.to.join(',')} (${r.products})`).join('; '), results.map(r => r.id).filter(Boolean).join(', ')]] });
    }
    return res.status(200).json({ sent: results.some(r => r.ok), test: !!testTo.length, windowEnd: end, products: cards.length, inventory: inventory.length, eventsLoaded: events.length, emails: results, unknownManagers });
  } catch (err) {
    console.error('[underperforming-email]', err.message);
    await sendCronFailureAlert('underperforming-email', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Reading the Daily Business Report efficiently ───────────────────────────
// Read the DATE column, then only the row blocks for the dates needed (each
// day's rows are written together, so they sit in contiguous blocks).
async function readDays(token, tab, wanted) {
  const head = await sheetsApi(token, 'GET', `/${DAILY_SHEET}/values/${rng(tab, 'A1:J1')}`);
  const h = ((head.values || [])[0] || []).map(x => String(x).trim().toUpperCase());
  const col = n => h.indexOf(n);
  const dateCol = await sheetsApi(token, 'GET', `/${DAILY_SHEET}/values/${rng(tab, 'A2:A')}`);
  const dates = (dateCol.values || []).map(r => isoDate(r[0]));
  const blocks = [];
  dates.forEach((d, i) => {
    if (!d || !wanted.has(d)) return;
    const row = i + 2, last = blocks[blocks.length - 1];
    if (last && last[1] === row - 1) last[1] = row; else blocks.push([row, row]);
  });
  const out = new Map();
  for (let k = 0; k < blocks.length; k += 80) {
    const chunk = blocks.slice(k, k + 80);
    const got = await sheetsApi(token, 'GET', `/${DAILY_SHEET}/values:batchGet?${chunk.map(([a, b]) => `ranges=${rng(tab, `A${a}:J${b}`)}`).join('&')}`);
    for (const vr of got.valueRanges || []) for (const r of vr.values || []) {
      const date = isoDate(r[col('DATE')]); const asin = String(r[col('ASIN')] || '').trim().toUpperCase();
      if (!date || !asin) continue;
      if (!out.has(asin)) out.set(asin, new Map());
      out.get(asin).set(date, { s: num(r[col('SESSIONS')]), u: num(r[col('UNITS_ORDERED')]), r: num(r[col('ORDERED_PRODUCT_SALES')]),
        bb: r[col('BUY_BOX_PCT')] === '' || r[col('BUY_BOX_PCT')] == null ? null : num(r[col('BUY_BOX_PCT')]), sku: String(r[col('SKU')] || '').trim() });
    }
    await sleep(200);
  }
  return out;
}

function agg() {
  const a = { s: 0, u: 0, r: 0, n: 0, bbSum: 0, bbN: 0 };
  a.avg = k => (a.n ? a[k] / a.n : 0);
  a.bbAvg = () => (a.bbN ? a.bbSum / a.bbN : null);
  return a;
}
function addAgg(t, x) { t.s += x.s; t.u += x.u; t.r += x.r; t.n = Math.max(t.n, x.n); }
// Sum over the window's non-event days; a day with no row counts as 0 sales
// (the report has no row for a day with no traffic) but still a usable day.
function sum(byDate, list, evDays) {
  const a = agg();
  for (const d of list) {
    if (evDays.has(d)) continue;
    a.n++;
    const v = byDate.get(d);
    if (!v) continue;
    a.s += v.s; a.u += v.u; a.r += v.r;
    if (v.bb != null) { a.bbSum += v.bb; a.bbN++; }
  }
  return a;
}
const pctChange = (from, to) => (from > 0 ? (to - from) / from : null);

// FBA out-of-stock days within CURRENT, per ASIN (OOS history 'fba' periods).
async function oosDaysByAsin(brand, curDays) {
  const out = new Map();
  if (!sheets.oosHistory) return out;
  const rows = await readRows(sheets.oosHistory, brand.tabName).catch(() => []);
  const today = todayEt();
  for (const r of rows || []) {
    if (String(r.type || '').trim() !== 'fba') continue;
    const asin = String(r.asin || '').trim().toUpperCase(); const s = isoDate(r.start_date); const e = isoDate(r.end_date) || today;
    if (!asin || !s) continue;
    const n = curDays.filter(d => d >= s && d <= e).length;
    if (n) out.set(asin, (out.get(asin) || 0) + n);
  }
  return out;
}

// From the Products Cache: latest status per ASIN ('hidden' when not
// DISCOVERABLE), and listing changes since `since` — dates where the title,
// item highlights, bullets, description, backend keywords or an image slot
// differ from the previous day (ADDED 2026-11-16).
const CHANGE_FIELDS = [['title', 'title'], ['item_highlights', 'item highlights'], ['bullet_1', 'bullets'], ['bullet_2', 'bullets'], ['bullet_3', 'bullets'],
  ['bullet_4', 'bullets'], ['bullet_5', 'bullets'], ['description', 'description'], ['backend_keywords', 'backend keywords']];
async function productsCacheInfo(brand, since) {
  const status = new Map(), changes = new Map();
  const rows = await readRows(sheets.products, brand.tabName).catch(() => []);
  let latest = '';
  const bySku = new Map(); // sku -> [{date,row}]
  for (const r of rows || []) {
    const d = isoDate(r.date); if (!d) continue;
    if (d > latest) latest = d;
    if (d < addDays(since, -1)) continue;
    const sku = String(r.sku || '').replace(/^'/, '').trim();
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push({ date: d, row: r });
  }
  for (const r of rows || []) {
    if (isoDate(r.date) !== latest) continue;
    const st = String(r.status || '').toUpperCase();
    if (st && !st.includes('DISCOVERABLE')) status.set(String(r.asin || '').trim().toUpperCase(), 'hidden');
  }
  const slots = c => Object.fromEntries(String(c || '').split('|').map(x => x.trim()).filter(Boolean).map(x => [x.split(':')[0], x.slice(x.indexOf(':') + 1)]));
  for (const [, list] of bySku) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    const asin = String(list[0]?.row.asin || '').trim().toUpperCase();
    if (!asin || changes.has(asin)) continue; // one SKU per ASIN is enough
    const found = [];
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1].row, b = list[i].row, date = list[i].date;
      if (date < since) continue;
      const what = new Set();
      for (const [f, label] of CHANGE_FIELDS) if (String(a[f] || '').trim() && String(b[f] || '').trim() && String(a[f]).trim() !== String(b[f]).trim()) what.add(label);
      const sa = slots(a.images), sb = slots(b.images);
      if (Object.keys(sa).length && Object.keys(sb).length) for (const v of new Set([...Object.keys(sa), ...Object.keys(sb)])) if (sa[v] !== sb[v]) what.add(`${v} image`);
      for (const w of what) found.push({ date, what: w });
    }
    changes.set(asin, found);
  }
  return { status, changes };
}

// Ad units / spend / ad sales per ASIN for the two complete months before
// `end`'s month, from the Ad Orders Cache (Sponsored Products + Display;
// Sponsored Brands can't be split by ASIN) — ADDED 2026-11-16, used until
// a daily per-ASIN ad feed exists.
async function adMonthsFor(brand, end) {
  const out = { byAsin: new Map(), months: [], monthDays: () => [] };
  if (!sheets.adOrders) return out;
  const [y, m] = end.split('-').map(Number);
  const mk = (yy, mm) => { const d = new Date(Date.UTC(yy, mm - 1, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; };
  // CHANGED 2026-11-16 — three periods: the two complete months before
  // `end`'s month, plus `end`'s month to date (so a drop inside the current
  // month shows up). Compared PER DAY, since the current month is partial.
  const last = mk(y, m - 1), prev = mk(y, m - 2), curM = mk(y, m);
  const label = x => new Date(Date.UTC(x.y, x.m - 1, 15)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  out.months = [prev, last, curM].map((x, i) => {
    const key = `${x.y}-${String(x.m).padStart(2, '0')}`;
    return { ...x, key, label: i === 2 ? `${label(x)} 1–${Number(end.slice(8, 10))}` : label(x) };
  });
  out.monthDays = key => { const [yy, mm] = key.split('-').map(Number); const days = []; for (let d = new Date(Date.UTC(yy, mm - 1, 1)); d.getUTCMonth() === mm - 1; d.setUTCDate(d.getUTCDate() + 1)) { const iso = d.toISOString().slice(0, 10); if (iso <= end) days.push(iso); } return days; };
  const rows = await readRows(sheets.adOrders, brand.tabName).catch(() => []);
  for (const r of rows || []) {
    const key = `${parseInt(r.year, 10)}-${String(parseInt(r.month, 10)).padStart(2, '0')}`;
    if (!out.months.some(x => x.key === key)) continue;
    const asin = String(r.asin || '').trim().toUpperCase();
    if (!asin) continue;
    if (!out.byAsin.has(asin)) out.byAsin.set(asin, {});
    const a = out.byAsin.get(asin)[key] || (out.byAsin.get(asin)[key] = { u: 0, spend: 0, sales: 0 });
    a.u += parseInt(r.ad_units, 10) || 0; a.spend += num(r.spend); a.sales += num(r.sales);
  }
  return out;
}

// Other sellers on each ASIN on the latest offers day (the offers tabs).
async function competitionFor(brand) {
  const out = new Map();
  try {
    const token = await getSheetsToken('writer');
    const got = await sheetsApi(token, 'GET', `/${SF_SHEET}/values/${rng(brand.tabName + ' offers', 'A1:P')}`);
    const [head = [], ...rows] = got.values || [];
    const ix = Object.fromEntries(head.map((h, i) => [String(h).trim(), i]));
    let latest = '';
    for (const r of rows) { const d = isoDate(r[ix.date]); if (d && d > latest) latest = d; }
    const byAsin = new Map();
    for (const r of rows) {
      if (isoDate(r[ix.date]) !== latest) continue;
      const asin = String(r[ix.asin] || '').trim().toUpperCase();
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin).push(r);
    }
    for (const [asin, list] of byAsin) {
      const others = list.filter(r => r[ix.is_us] !== 'TRUE' && r[ix.seller_id]);
      if (!others.length) continue;
      const our = num(list[0][ix.our_price]);
      const lowest = Math.min(...others.map(r => num(r[ix.landed_price])));
      const owner = String(list[0][ix.buybox_owner] || '');
      const vs = our ? (lowest < our ? `, lowest $${(our - lowest).toFixed(2)} below ours` : lowest > our ? `, lowest $${(lowest - our).toFixed(2)} above ours` : ', lowest = ours') : '';
      out.set(asin, `${others.length} other seller${others.length === 1 ? '' : 's'}${vs} · Buy Box: ${owner.startsWith('us') ? owner.replace('us', 'ours') : owner || 'none'}`);
    }
  } catch { /* no offers tab yet for this brand */ }
  return out;
}

// ── Email ──────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtPct = p => (p == null ? '—' : `${p > 0 ? '+' : ''}${Math.round(p * 100)}%`);
const money = n => `$${Math.round(n).toLocaleString('en-US')}`;
const pctCell = p => (p == null ? '<span style="color:#9ba8c0;">—</span>' : `<span style="color:${p < 0 ? '#C0392B' : '#1A7F5A'};font-weight:${p <= -0.3 ? 700 : 400};">${fmtPct(p)}</span>`);

// Ads vs organic, per day, as a small aligned table (ADDED 2026-11-16).
function adsTable(per) {
  if (!per) return '';
  const f = v => (v >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
  const c = 'padding:2px 6px;font-size:11px;font-family:Arial,sans-serif;text-align:right;white-space:nowrap;';
  const h = 'padding:2px 6px;font-size:10px;font-family:Arial,sans-serif;color:#6B7BA2;font-weight:700;text-align:right;white-space:nowrap;border-bottom:1px solid #e4e8ef;';
  const lab = 'padding:2px 6px 2px 0;font-size:11px;font-family:Arial,sans-serif;color:#001F60;font-weight:700;white-space:nowrap;';
  const row = (label, key, money) => `<tr><td style="${lab}">${label}</td>${per.map(x => `<td style="${c}">${money ? '$' + Math.round(x[key]).toLocaleString('en-US') : f(x[key])}</td>`).join('')}</tr>`;
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:6px;">
    <tr><td style="${h}text-align:left;padding-left:0;">Per day</td>${per.map(x => `<td style="${h}">${esc(x.label)}</td>`).join('')}</tr>
    ${row('Units', 'total')}${row('From ads', 'ad')}${row('Organic', 'organic')}${row('Ad spend', 'spend', true)}</table>`;
}

function buildHtml(data, ctx, unknownManagers, wouldSendTo, who) {
  const { cards, inventory } = data;
  const th = 'padding:7px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#fff;background:#001F60;text-align:left;font-family:Arial,sans-serif;';
  const td = 'padding:7px 8px;font-size:12px;color:#001F60;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;vertical-align:top;';
  const pill = (t, bg, fg) => `<span style="display:inline-block;padding:1px 7px;margin:0 3px 2px 0;border-radius:999px;background:${bg};color:${fg};font-size:10px;font-weight:700;">${esc(t)}</span>`;
  const flagPill = f => pill(f, f === 'Sales' ? '#FFD2CC' : f === 'Traffic' ? '#FFE8A3' : '#E3DCF7', f === 'Sales' ? '#C0392B' : f === 'Traffic' ? '#7A5B00' : '#4B2E9E');
  const lostTotal = cards.reduce((n, c) => n + c.lost, 0);
  const tile = (l, v, c, sub) => `<td style="padding:0 8px 8px 0;vertical-align:top;"><div style="border:1px solid #e4e8ef;border-radius:10px;padding:10px 14px;min-width:130px;">
    <div style="font-size:11px;color:#6B7BA2;text-transform:uppercase;letter-spacing:.05em;font-weight:700;">${esc(l)}</div><div style="font-size:24px;color:${c};font-weight:700;margin-top:2px;">${v}</div>${sub ? `<div style="font-size:11px;color:#6B7BA2;">${esc(sub)}</div>` : ''}</div></td>`;
  const tiles = tile('Products to review', cards.length, '#001F60') + tile('Revenue at stake', money(lostTotal), '#C0392B', ctx.L.cur)
    + tile('Likely inventory', inventory.length, '#D35400', 'out of FBA stock ≥3 days');

  // ADDED 2026-11-16 — every brand, so "checked and fine" is visible and
  // nothing drops out silently. A brand manager's version lists their brands.
  const mine = name => {
    if (!who || who === 'all') return true;
    const b = ctx.brandSummaries[name] || {};
    return MANAGER_EMAILS[String(b.manager || '').trim().toLowerCase()] === who || [...cards, ...inventory].some(c => c.brand === name);
  };
  // CHANGED 2026-11-16 per Jaclyn — only brands whose revenue is DOWN vs the
  // prior 28 days are listed; flat/growing and unchecked brands get one
  // line at the bottom, so the email stays about what's declining.
  const mineList = Object.entries(ctx.brandSummaries).filter(([name]) => mine(name));
  const downList = mineList.filter(([, b]) => !b.note && b.revenueVsPrior != null && b.revenueVsPrior < 0);
  const upList = mineList.filter(([, b]) => !b.note && !(b.revenueVsPrior != null && b.revenueVsPrior < 0));
  const notChecked = mineList.filter(([, b]) => b.note);
  const summaryRows = downList
    .sort((a, b) => (b[1].brandAlert - a[1].brandAlert) || ((a[1].revenueVsPrior || 0) - (b[1].revenueVsPrior || 0)))
    .map(([name, b], i) => `<tr style="background:${b.brandAlert ? '#FFF1EE' : i % 2 ? '#F7F8FC' : '#fff'};">
          <td style="${td}font-weight:700;">${esc(name)}${b.brandAlert ? ` ${pill('Brand down', '#FFD2CC', '#C0392B')}` : ''}<div style="font-size:10px;color:#9ba8c0;">${esc(b.manager || '')}</div></td>
          <td style="${td}text-align:right;">${money(b.curRevenue28 || 0)}</td><td style="${td}text-align:right;">${pctCell(b.revenueVsPrior)}</td><td style="${td}text-align:right;">${pctCell(b.revenueVsLastYear)}</td>
          <td style="${td}text-align:right;">${pctCell(b.sessionsVsPrior)}</td><td style="${td}text-align:right;">${b.checked}</td>
          <td style="${td}text-align:right;font-weight:${b.flagged ? 700 : 400};color:${b.flagged ? '#C0392B' : '#001F60'};">${b.flagged}</td><td style="${td}text-align:right;">${b.inventory || 0}</td></tr>`).join('');
  const summaryTable = !downList.length ? '' : `<tr><td style="padding:6px 32px 4px;">
      <div style="font-size:13px;font-weight:700;color:#001F60;margin-bottom:6px;">Brands with revenue down: ${esc(ctx.L.cur)} vs ${esc(ctx.L.prior)}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
        <tr><th style="${th}">Brand</th><th style="${th}text-align:right;">Revenue<br>${esc(ctx.L.cur)}</th><th style="${th}text-align:right;">vs<br>${esc(ctx.L.prior)}</th><th style="${th}text-align:right;">vs<br>${esc(ctx.L.yoy)}</th>
        <th style="${th}text-align:right;">Sessions vs<br>${esc(ctx.L.prior)}</th><th style="${th}text-align:right;">Products checked</th><th style="${th}text-align:right;">Flagged</th><th style="${th}text-align:right;">Likely inventory</th></tr>
        ${summaryRows}</table></td></tr>`;

  const brandsInOrder = [...new Set([...cards, ...inventory].map(c => c.brand))]
    .sort((a, b) => cards.filter(c => c.brand === b).reduce((n, c) => n + c.lost, 0) - cards.filter(c => c.brand === a).reduce((n, c) => n + c.lost, 0));
  const sections = brandsInOrder.map(brand => {
    const list = cards.filter(c => c.brand === brand).sort((a, b) => b.priority - a.priority);
    const inv = inventory.filter(c => c.brand === brand).sort((a, b) => b.lost - a.lost);
    const bs = ctx.brandSummaries[brand] || {};
    const mgrs = [...new Set([...list, ...inv].map(c => c.manager).filter(Boolean))].join(', ');
    const rows = list.slice(0, ROWS_PER_BRAND).map((c, i) => `<tr style="background:${i % 2 ? '#F7F8FC' : '#fff'};">
        <td style="${td}font-weight:700;">${i + 1}</td>
        <td style="${td}"><span style="font-weight:700;">${esc(c.sku)}</span> <span style="font-size:10px;color:#9ba8c0;">${esc(c.asin)}</span><div style="font-size:11px;color:#6B7BA2;">${esc(c.name)}</div><div style="margin-top:3px;">${c.flags.map(flagPill).join('')}</div></td>
        <td style="${td}text-align:right;">${Math.round(c.share * 100)}%</td>
        <td style="${td}text-align:right;font-weight:700;color:#C0392B;">${money(c.lost)}</td>
        <td style="${td}text-align:right;">${money(c.cur.r)}<div style="font-size:11px;">${pctCell(c.d.r[0])} <span style="color:#9ba8c0;">/</span> ${pctCell(c.d.r[1])}</div></td>
        <td style="${td}text-align:right;">${Math.round(c.cur.s).toLocaleString('en-US')}<div style="font-size:11px;">${pctCell(c.d.s[0])} <span style="color:#9ba8c0;">/</span> ${pctCell(c.d.s[1])}</div></td>
        <td style="${td}text-align:right;">${Math.round(c.cur.u).toLocaleString('en-US')}<div style="font-size:11px;">${pctCell(c.d.u[0])} <span style="color:#9ba8c0;">/</span> ${pctCell(c.d.u[1])}</div></td>
        <td style="${td}text-align:right;">${(c.cur.cvr * 100).toFixed(1)}%<div style="font-size:11px;">${pctCell(c.cvrChange)}</div></td>
        <td style="${td}font-size:11px;line-height:1.45;">${adsTable(c.ads)}${c.context.filter(x => !x.ads).map(x => `<div style="margin-bottom:3px;"><b style="color:#001F60;">${esc(x.label)}:</b> <span style="color:#3a4a6b;">${esc(x.text)}</span></div>`).join('') || (c.ads ? '' : '<span style="color:#9ba8c0;">—</span>')}</td></tr>`).join('');
    const more = list.length > ROWS_PER_BRAND ? `<div style="font-size:11px;color:#6B7BA2;margin-top:6px;">+ ${list.length - ROWS_PER_BRAND} more in the attached Excel</div>` : '';
    const table = list.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;margin-top:8px;">
        <tr><th style="${th}width:24px;">#</th><th style="${th}">Product</th><th style="${th}text-align:right;">Share of brand sales</th><th style="${th}text-align:right;">Revenue at stake</th>
        <th style="${th}text-align:right;">Revenue</th><th style="${th}text-align:right;">Sessions</th><th style="${th}text-align:right;">Units</th><th style="${th}text-align:right;">Conversion</th><th style="${th}">Context</th></tr>
        <tr><td colspan="9" style="padding:5px 8px;font-size:10px;color:#6B7BA2;background:#F7F8FC;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;">
          Numbers are for <b style="color:#001F60;">${esc(ctx.L.cur)}</b>. Changes underneath: <b style="color:#001F60;">vs ${esc(ctx.L.prior)}</b> / <b style="color:#001F60;">vs ${esc(ctx.L.yoy)}</b>. Conversion change is vs ${esc(ctx.L.base)}.</td></tr>${rows}</table>${more}` : '';
    const invList = inv.length ? `<div style="margin-top:10px;font-size:12px;color:#D35400;font-weight:700;">Likely inventory-driven (out of FBA stock in this period) · ${inv.length}</div>
        <div style="font-size:12px;color:#001F60;margin-top:3px;">${inv.map(c => `${esc(c.sku)} — ${c.oosDays} days out, ${money(c.lost)} at stake`).join(' &middot; ')}</div>` : '';
    return `<tr><td style="padding:18px 32px 6px;">
      <div style="font-size:18px;font-weight:700;color:#001F60;font-family:Georgia,'Times New Roman',serif;border-bottom:2px solid #24E9A3;padding-bottom:4px;">${esc(brand)}
        <span style="font-size:11px;font-weight:400;color:#6B7BA2;font-family:Arial,sans-serif;">${mgrs ? '&nbsp;·&nbsp;' + esc(mgrs) : ''}</span></div>
      <div style="font-size:12px;color:#6B7BA2;margin-top:6px;">Brand revenue ${esc(ctx.L.cur)}: <b style="color:#001F60;">${money(bs.curRevenue28 || 0)}</b> &middot; vs ${esc(ctx.L.prior)} ${pctCell(bs.revenueVsPrior)} &middot; vs ${esc(ctx.L.yoy)} ${pctCell(bs.revenueVsLastYear)} &middot; sessions vs ${esc(ctx.L.prior)} ${pctCell(bs.sessionsVsPrior)}</div>
      ${table}${invList}</td></tr>`;
  }).join('');

  const scope = who && who !== 'all' ? `Your brands only — the full every-brand email goes to ${ALWAYS_TO.join(', ')}.` : '';
  const notes = [
    'Small brands: a product that is ≥10% of its brand\'s sales is checked with lower minimums (50 sessions / 5 units), and the minimum revenue loss is 5% of the brand\'s 28-day revenue (between $50 and $200). "Brand down" = the whole brand\'s revenue is down ≥30% vs the prior 28 days and ≥20% vs last year.',
    'Units per day / ad units per day / organic units per day cover the last two complete months and the current month so far (Sponsored Products + Display; Sponsored Brands can\'t be split by product). Organic = total units − ad units for the same days, so they always add up.',
    `Ranked by revenue at stake: revenue lost in ${esc(ctx.L.cur)} compared with ${esc(ctx.L.prior)} (or with ${esc(ctx.L.yoy)}, if larger); brand-wide declines count half. Changes compare per-day averages, with event days left out.`,
    ctx.events.length ? `Event days left out of every comparison: ${ctx.events.map(e => esc(e.name)).join(', ')}.` : 'No events listed yet — add Prime Day, Black Friday etc. to the "events" tab of the Daily Business Report sheet so they are left out of comparisons.',
    unknownManagers.length ? `Brand Manager name(s) on the master list with no email on file (not emailed): ${unknownManagers.map(esc).join(', ')}.` : '',
    wouldSendTo ? `TEST SEND — the real email would go to: ${wouldSendTo.map(esc).join(', ')}.` : '',
  ].filter(Boolean).map(n => `<div style="font-size:11px;color:#9ba8c0;margin-top:4px;">${n}</div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:32px 0;"><tr><td align="center">
    <table width="1100" cellpadding="0" cellspacing="0" style="width:1100px;max-width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <tr><td style="background:#001F60;padding:24px 32px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#24E9A3;font-weight:700;">NewDerm &middot; Weekly Performance</div>
        <div style="font-size:24px;color:#fff;font-weight:700;margin-top:6px;font-family:Georgia,'Times New Roman',serif;">Underperforming Products</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px;">${esc(ctx.L.cur)} vs ${esc(ctx.L.prior)} and vs ${esc(ctx.L.yoy)} &middot; highest revenue at stake first</div>
        ${scope ? `<div style="font-size:12px;color:#24E9A3;margin-top:6px;">${esc(scope)}</div>` : ''}
      </td></tr>
      <tr><td style="padding:22px 32px 4px;"><table cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table></td></tr>
      ${summaryTable}
      ${sections}
      ${upList.length || notChecked.length ? `<tr><td style="padding:10px 32px 0;"><div style="font-size:11px;color:#6B7BA2;">
        ${upList.length ? `Flat or growing vs ${esc(ctx.L.prior)} (not shown): ${upList.map(([n, b]) => `${esc(n)} ${fmtPct(b.revenueVsPrior)}`).join(', ')}.` : ''}
        ${notChecked.length ? ` Not checked: ${notChecked.map(([n, b]) => `${esc(n)} (${esc(b.note)})`).join(', ')}.` : ''}</div></td></tr>` : ''}
      <tr><td style="padding:14px 32px 24px;"><div style="font-size:12px;color:#6B7BA2;">Every flagged product, with all its numbers, is in the attached Excel file.</div>${notes}</td></tr>
      <tr><td style="background:#001F60;padding:16px 32px;"><div style="padding-bottom:12px;"><img src="${LOGO_URL}" alt="Medaltus" height="22" style="height:22px;display:block;"></div>
        <span style="font-size:11px;color:#6B7BA2;">Medaltus automated report &middot; reports@medaltus.com</span></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function buildWorkbook({ cards, inventory }, L) {
  const wb = XLSX.utils.book_new();
  const head = ['Brand', 'SKU', 'ASIN', 'Product', 'Brand Manager', 'Flags', 'Share of brand sales', `Revenue at stake (${L.cur})`, `Revenue ${L.cur}`, `Revenue vs ${L.prior}`, `Revenue vs ${L.yoy}`,
    `Sessions ${L.cur}`, `Sessions vs ${L.prior}`, `Sessions vs ${L.yoy}`, `Units ${L.cur}`, `Units vs ${L.prior}`, `Units vs ${L.yoy}`, 'Conversion', `Conversion vs ${L.base}`, 'Context',
    'Periods', 'Units per day', 'Ad units per day', 'Ad spend per day', 'Organic units per day'];
  const line = c => [c.brand, c.sku, c.asin, c.name, c.manager || '', c.flags.join(', '), round(c.share, 3), Math.round(c.lost), Math.round(c.cur.r), round(c.d.r[0]), round(c.d.r[1]),
    Math.round(c.cur.s), round(c.d.s[0]), round(c.d.s[1]), Math.round(c.cur.u), round(c.d.u[0]), round(c.d.u[1]), round(c.cur.cvr, 4), round(c.cvrChange), c.context.filter(x => !x.ads).map(x => `${x.label}: ${x.text}`).join(' | '),
    c.ads ? c.ads.map(x => x.label).join(' | ') : '', c.ads ? c.ads.map(x => x.total.toFixed(1)).join(' | ') : '', c.ads ? c.ads.map(x => x.ad.toFixed(1)).join(' | ') : '',
    c.ads ? c.ads.map(x => x.spend.toFixed(2)).join(' | ') : '', c.ads ? c.ads.map(x => x.organic.toFixed(1)).join(' | ') : ''];
  const ws = XLSX.utils.aoa_to_sheet([head, ...[...cards].sort((a, b) => b.priority - a.priority).map(line)]);
  ws['!cols'] = head.map((h, i) => ({ wch: i === 3 || i === 19 ? 40 : 14 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Underperforming');
  if (inventory.length) {
    const ws2 = XLSX.utils.aoa_to_sheet([[...head, 'FBA out-of-stock days'], ...inventory.map(c => [...line(c), c.oosDays])]);
    XLSX.utils.book_append_sheet(wb, ws2, 'Likely inventory');
  }
  return wb;
}
const round = (v, dp = 3) => (v == null ? '' : Math.round(v * 10 ** dp) / 10 ** dp);

// ── Master list (Amazon rows only, column G) ───────────────────────────────
async function loadMaster() {
  const id = process.env.SHEET_MASTER_SKU_LIST;
  if (!id) throw new Error('SHEET_MASTER_SKU_LIST env var not set');
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${MASTER_GID}`);
  if (!r.ok) throw new Error(`master SKU list CSV → ${r.status}`);
  const rows = parseCsv(await r.text());
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const col = (n, f) => { const i = head.indexOf(n.toLowerCase()); return i >= 0 ? i : f; };
  const iSku = col('SKU', 1), iName = col('Product Short Name', 2), iStatus = col('Status', 7), iMgr = col('Brand Manager', 26), iChannel = col('Channel', 6);
  const map = new Map();
  for (const row of rows.slice(1)) {
    const sku = String(row[iSku] || '').trim().toUpperCase();
    if (!sku || !/amazon/i.test(String(row[iChannel] || ''))) continue;
    map.set(sku, { name: String(row[iName] || '').trim(), status: String(row[iStatus] || '').trim().toUpperCase(), manager: String(row[iMgr] || '').trim() });
  }
  return map;
}
function parseCsv(text) {
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

// ── Sheets / dates ─────────────────────────────────────────────────────────
const RETRY_WAITS_MS = [2000, 4000, 8000, 16000, 20000, 30000];
async function sheetsApi(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SHEETS_API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || (res.status >= 500 && attempt < 4);
    if (retryable && attempt < RETRY_WAITS_MS.length) { await sleep(RETRY_WAITS_MS[attempt] + Math.floor(Math.random() * 1500)); continue; }
    throw new Error(`Sheets ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
}
const quoteTab = t => `'${String(t).replace(/'/g, "''")}'`;
const rng = (tab, a1) => encodeURIComponent(`${quoteTab(tab)}!${a1}`);
const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,%]/g, '')); return Number.isFinite(n) ? n : 0; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function todayEt() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function range(a, b) { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; }
function fmtDay(iso) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
