/**
 * api/cron/reviews-alert-email.js
 * ADDED 2026-11-16 (per Jaclyn) — weekly "Reviews & Ratings" alert email,
 * styled like listing-alerts-email.js. Unlike the other alert emails, this
 * one goes out as ONE full email (every brand) to Ashley and all Brand
 * Managers (CHANGED 2026-11-16 per Jaclyn). Mondays 3 PM Eastern (after Isabella's Monday upload).
 * Sends only when there's something to report.
 *
 * 1. NEW BAD REVIEWS — reviews under 4 stars that have appeared in the
 *    Amazon reviews sheet (SHEET_AMAZON_REVIEWS, one tab per brand, filled by
 *    upload-amazon-reviews.js) since the last email. Reviews already sent are
 *    remembered in that sheet's "alerted-reviews" tab, so re-uploads and
 *    catch-up uploads never repeat one. On the very first run only reviews
 *    from the last 14 days are sent (older ones are recorded as seen).
 * 2. STAR RATING CHANGES — from the Helium 10 Keyword Tracker workbook
 *    (SHEET_KEYWORD_TRACKER), "summary" tab: each product's latest rating vs
 *    its previous one. Drops are listed (falling below 4.0 is flagged —
 *    eligibility); rises are a one-line FYI. Only products whose latest
 *    rating is from the last 10 days are compared, and each update's change
 *    is reported once (remembered in "alerted-reviews" too), so a Keyword
 *    Tracker that wasn't refreshed never repeats last week's drop.
 *
 * Brands in EMAIL_EXCLUDED_BRANDS are left out. Only SKUs on the master SKU
 * list (Amazon rows, column G) decide the Brand Manager; anything else still
 * goes to the full email.
 *
 * Modes (same as the other alert emails):
 *   ?testTo=a@medaltus.com (&as=someone@medaltus.com | all)  send only there; nothing recorded
 *   ?preview=true (&as=…)                                     return the HTML
 *   ?force=true                                               send again today
 * Env: CRON_SECRET, ALERTS_API_KEY, SHEET_AMAZON_REVIEWS, SHEET_KEYWORD_TRACKER,
 *      SHEET_MASTER_SKU_LIST, optional FROM_EMAIL.
 */

const XLSX = require('xlsx');
const { getSheetsToken, readRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const { sendCronFailureAlert } = require('../_alerts');
const { isoDate } = require('../_dates');

const REVIEWS_SHEET = process.env.SHEET_AMAZON_REVIEWS;
const KT_SHEET = process.env.SHEET_KEYWORD_TRACKER;
const KT_TAB = 'summary';
const SEEN_TAB = 'alerted-reviews';
const SEEN_HEADERS = ['review_key', 'brand', 'sku', 'star_rating', 'review_date', 'first_alerted'];
const LOG_TAB = 'email-log-reviews';
const MASTER_GID = '164358627';
const BAD_BELOW = 4;          // under 4 stars
const FIRST_RUN_DAYS = 14;
const RATING_FRESH_DAYS = 10;
const ELIGIBILITY_LINE = 4.0;
const ALWAYS_TO = ['awilcox@medaltus.com'];
// collagelee: merged into Cloud Café; hillside: terminated (2026-11-16).
const EMAIL_EXCLUDED_BRANDS = ['cimeosil', 'collagelee', 'hillside'];
const MANAGER_EMAILS = {
  'jaclyn sonberg': 'jsonberg@medaltus.com',
  'isabella fernandez': 'ifernandez@medaltus.com',
  'lindsay rohde': 'lrohde@medaltus.com',
};
const FROM_EMAIL = process.env.FROM_EMAIL || 'reports@medaltus.com';
const REPLY_TO = 'reports@medaltus.com';
const LOGO_URL = 'https://vbcosmeticsreport.medaltus.com/api/medaltus-logo';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const testTo = String(req.query.testTo || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (testTo.some(e => !e.endsWith('@medaltus.com'))) return res.status(400).json({ error: 'testTo addresses must be @medaltus.com' });
  const preview = req.query.preview === 'true';
  const force = req.query.force === 'true';
  const real = !testTo.length && !preview;
  const today = todayEt();

  try {
    if (!REVIEWS_SHEET) throw new Error('SHEET_AMAZON_REVIEWS env var not set');
    if (!KT_SHEET) throw new Error('SHEET_KEYWORD_TRACKER env var not set');
    const token = await getSheetsToken(REVIEWS_SHEET);
    const meta = await sheetsApi(token, 'GET', `/${REVIEWS_SHEET}?fields=sheets.properties(title)`);
    const tabs = new Set((meta.sheets || []).map(s => s.properties.title));

    if (real && !force && tabs.has(LOG_TAB)) {
      const log = await sheetsApi(token, 'GET', `/${REVIEWS_SHEET}/values/${rng(LOG_TAB, 'A2:A')}`);
      if ((log.values || []).some(r => String(r[0] || '').slice(0, 10) === today)) return res.status(200).json({ skipped: true, reason: `already sent today (${today})` });
    }

    const master = await loadMaster();
    const active = brands.filter(b => b.active && !EMAIL_EXCLUDED_BRANDS.includes(b.id));
    const brandName = Object.fromEntries(active.map(b => [b.id, b.displayName || b.id]));
    const managerFor = sku => master.get(String(sku || '').replace(/^'/, '').trim().toUpperCase())?.manager || '';

    // ── 1. New bad reviews ──────────────────────────────────────────────────
    const seen = new Set();
    const firstRun = !tabs.has(SEEN_TAB);
    if (!firstRun) {
      const s = await sheetsApi(token, 'GET', `/${REVIEWS_SHEET}/values/${rng(SEEN_TAB, 'A2:A')}`);
      (s.values || []).forEach(r => r[0] && seen.add(String(r[0])));
    }
    const cutoff = addDays(today, -FIRST_RUN_DAYS);
    const badReviews = [], quietlySeen = [];
    const allByAsin = new Map(); // ADDED 2026-11-16 — every review per ASIN, for "last 3 reviews" under a rating drop
    for (const b of active) {
      if (!tabs.has(b.tabName)) continue;
      const rows = await readRows(REVIEWS_SHEET, b.tabName).catch(() => []);
      for (const r of rows || []) {
        const stars = parseFloat(r.star_rating);
        const asinKey = String(r.asin || '').replace(/^'/, '').trim().toUpperCase();
        if (asinKey && Number.isFinite(stars)) {
          if (!allByAsin.has(asinKey)) allByAsin.set(asinKey, []);
          allByAsin.get(asinKey).push({ stars, title: r.review_title || '', text: r.review_text || '', date: isoDate(r.date) || '', dateText: r.date || '', purchase: r.purchase_type || '' });
        }
        if (!Number.isFinite(stars) || stars >= BAD_BELOW) continue;
        const key = reviewKey(r);
        if (seen.has(key)) continue;
        const d = isoDate(r.date) || '';
        const item = { brandId: b.id, brand: brandName[b.id], key, sku: String(r.sku || '').replace(/^'/, '').trim(), asin: String(r.asin || '').replace(/^'/, '').trim(),
          product: r.product_name || '', stars, title: r.review_title || '', text: r.review_text || '', date: d, dateText: r.date || '', reviewer: r.reviewer_name || '',
          purchase: r.purchase_type || '', manager: managerFor(r.sku) };
        if (firstRun && d && d < cutoff) quietlySeen.push(item); else badReviews.push(item);
      }
      await sleep(250);
    }
    badReviews.sort((a, b) => a.stars - b.stars || (b.date || '').localeCompare(a.date || ''));

    // ── 2. Star rating changes (Helium 10 Keyword Tracker summary) ──────────
    const ratingChanges = [];
    const kt = await readRows(KT_SHEET, KT_TAB).catch(err => { throw new Error(`Keyword Tracker "${KT_TAB}" tab: ${err.message}`); });
    const byAsin = new Map();
    for (const r of kt || []) {
      const rating = parseFloat(r.rating); const d = isoDate(r.date);
      const asin = String(r.asin || '').trim().toUpperCase();
      if (!asin || !d || !Number.isFinite(rating)) continue;
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin).push({ d, rating, reviews: parseInt(String(r.review_count || '').replace(/,/g, ''), 10), brandId: String(r.brand || '').trim().toLowerCase(), sku: String(r.sku || '').trim() });
    }
    for (const [asin, list] of byAsin) {
      list.sort((a, b) => a.d.localeCompare(b.d));
      const last = list[list.length - 1];
      if (last.d < addDays(today, -RATING_FRESH_DAYS)) continue;
      const prev = [...list].reverse().find(x => x.d < last.d);
      if (!prev || Math.abs(last.rating - prev.rating) < 0.05) continue;
      if (!brandName[last.brandId]) continue; // inactive / excluded brand
      const key = `rating:${asin}:${last.d}`;   // each update's change is reported once
      if (seen.has(key)) continue;
      ratingChanges.push({ key, stars: last.rating, date: last.d, brandId: last.brandId, brand: brandName[last.brandId], asin, sku: last.sku, manager: managerFor(last.sku),
        from: prev.rating, to: last.rating, fromDate: prev.d, toDate: last.d,
        reviewsFrom: prev.reviews, reviewsTo: last.reviews, drop: last.rating < prev.rating, belowLine: last.rating < ELIGIBILITY_LINE && prev.rating >= ELIGIBILITY_LINE });
    }
    ratingChanges.sort((a, b) => (a.to - a.from) - (b.to - b.from));
    for (const rc of ratingChanges) {
      rc.last3 = (allByAsin.get(rc.asin) || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 3);
    }

    const drops = ratingChanges.filter(r => r.drop);
    if (!badReviews.length && !drops.length) {
      if (real) await recordSeen(token, tabs, [...quietlySeen], today);
      return res.status(200).json({ sent: false, reason: 'no new bad reviews and no rating drops', firstRun, recordedQuietly: quietlySeen.length, ratingRises: ratingChanges.length });
    }

    // ── Versions per recipient ──────────────────────────────────────────────
    const emailOf = n => MANAGER_EMAILS[String(n || '').trim().toLowerCase()] || null;
    const all = { reviews: badReviews, ratings: ratingChanges };
    const versions = new Map(ALWAYS_TO.map(e => [e, all]));
    for (const kind of ['reviews', 'ratings']) for (const x of all[kind]) {
      const e = emailOf(x.manager);
      if (!e || ALWAYS_TO.includes(e)) continue;
      if (!versions.has(e)) versions.set(e, { reviews: [], ratings: [] });
      versions.get(e)[kind].push(x);
    }
    const asParam = String(req.query.as || '').trim().toLowerCase();
    const pick = who => (who === 'all' || !versions.has(who)) ? { who: 'all', data: all } : { who, data: versions.get(who) };
    if (preview) { const v = pick(asParam || 'all'); res.setHeader('Content-Type', 'text/html'); return res.status(200).send(buildHtml(v.data, today, null, v.who, firstRun)); }
    if (!process.env.ALERTS_API_KEY) throw new Error('ALERTS_API_KEY is not set');

    // One full email to everyone (CHANGED 2026-11-16): Ashley + every Brand Manager.
    const everyone = [...new Set([...ALWAYS_TO, ...Object.values(MANAGER_EMAILS)])];
    const sends = testTo.length ? [{ to: testTo, ...pick(asParam || 'all'), test: true }]
      : [{ to: everyone, who: 'all', data: all }];
    const results = [];
    for (const s of sends) {
      const dropsHere = s.data.ratings.filter(r => r.drop);
      if (!s.data.reviews.length && !dropsHere.length) continue;
      const parts = [s.data.reviews.length ? `${s.data.reviews.length} new review${s.data.reviews.length === 1 ? '' : 's'} under 4★` : '', dropsHere.length ? `${dropsHere.length} rating drop${dropsHere.length === 1 ? '' : 's'}` : ''].filter(Boolean);
      const subject = `${s.test ? '[TEST] ' : ''}Reviews & Ratings — ${parts.join(', ')} · ${fmtDay(today)}`;
      const html = buildHtml(s.data, today, s.test ? (s.who === 'all' ? [...new Set([...ALWAYS_TO, ...Object.values(MANAGER_EMAILS)])] : [s.who]) : null, s.who, firstRun);
      const attachment = Buffer.from(XLSX.write(buildWorkbook(s.data), { type: 'buffer', bookType: 'xlsx' })).toString('base64');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.ALERTS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `Medaltus Reports <${FROM_EMAIL}>`, reply_to: REPLY_TO, to: s.to, subject, html,
          attachments: [{ filename: `Reviews and Ratings_${today}.xlsx`, content: attachment }] }),
      });
      const body = await r.json().catch(() => ({}));
      results.push({ to: s.to, version: s.who, reviews: s.data.reviews.length, ratingDrops: dropsHere.length, ok: r.ok, id: body.id || null, error: r.ok ? undefined : JSON.stringify(body).slice(0, 200) });
      await sleep(600);
    }
    const failed = results.filter(r => !r.ok);
    if (failed.length) await sendCronFailureAlert('reviews-alert-email', failed.map(f => `${f.to.join(',')}: ${f.error}`).join('\n'));

    if (real && results.some(r => r.ok)) {
      await recordSeen(token, tabs, [...badReviews, ...quietlySeen, ...ratingChanges.map(r => ({ ...r, brandId: r.brandId }))], today);
      if (!tabs.has(LOG_TAB)) {
        await sheetsApi(token, 'POST', `/${REVIEWS_SHEET}:batchUpdate`, { requests: [{ addSheet: { properties: { title: LOG_TAB, gridProperties: { rowCount: 500, columnCount: 6 } } } }] });
        await sheetsApi(token, 'PUT', `/${REVIEWS_SHEET}/values/${rng(LOG_TAB, 'A1')}?valueInputOption=RAW`, { values: [['sent_date', 'sent_at', 'bad_reviews', 'rating_drops', 'recipients', 'message_ids']] });
      }
      await sheetsApi(token, 'POST', `/${REVIEWS_SHEET}/values/${rng(LOG_TAB, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [[today, new Date().toISOString(), badReviews.length, drops.length,
        results.filter(r => r.ok).map(r => `${r.to.join(',')} (${r.reviews}/${r.ratingDrops})`).join('; '), results.map(r => r.id).filter(Boolean).join(', ')]] });
    }
    return res.status(200).json({ sent: results.some(r => r.ok), test: !!testTo.length, firstRun, badReviews: badReviews.length, ratingDrops: drops.length, ratingRises: ratingChanges.length - drops.length, emails: results });
  } catch (err) {
    console.error('[reviews-alert-email]', err.message);
    await sendCronFailureAlert('reviews-alert-email', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Same review identity as upload-amazon-reviews.js: Amazon's review_id, else ASIN + date + reviewer + title.
function reviewKey(r) {
  const id = String(r.review_id || '').trim();
  if (id) return `id:${id}`;
  const norm = v => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  return `k:${[norm(String(r.asin || r.sku || '').replace(/^'/, '')), isoDate(r.date) || norm(r.date), norm(r.reviewer_name), norm(r.review_title)].join('|')}`;
}

async function recordSeen(token, tabs, items, today) {
  if (!items.length) return;
  if (!tabs.has(SEEN_TAB)) {
    await sheetsApi(token, 'POST', `/${REVIEWS_SHEET}:batchUpdate`, { requests: [{ addSheet: { properties: { title: SEEN_TAB, gridProperties: { rowCount: 1000, columnCount: SEEN_HEADERS.length, frozenRowCount: 1 } } } }] });
    await sheetsApi(token, 'PUT', `/${REVIEWS_SHEET}/values/${rng(SEEN_TAB, 'A1')}?valueInputOption=RAW`, { values: [SEEN_HEADERS] });
    tabs.add(SEEN_TAB);
  }
  const rows = items.map(x => [x.key, x.brandId, x.sku, x.stars, x.date, today]);
  for (let i = 0; i < rows.length; i += 500) {
    await sheetsApi(token, 'POST', `/${REVIEWS_SHEET}/values/${rng(SEEN_TAB, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows.slice(i, i + 500) });
  }
}

// ── Email ──────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n).trimEnd() + '…' : t; };
const starsHtml = n => `<span style="color:#F2A900;letter-spacing:1px;">${'★'.repeat(Math.round(n))}</span><span style="color:#d6dbe6;letter-spacing:1px;">${'★'.repeat(5 - Math.round(n))}</span>`;

function buildHtml(data, today, wouldSendTo, who, firstRun) {
  const { reviews, ratings } = data;
  const drops = ratings.filter(r => r.drop), rises = ratings.filter(r => !r.drop);
  // Same height for every box (CHANGED 2026-11-16): fixed height, and the
  // sub-line is always there (blank when there's nothing to say).
  const tile = (l, v, c, sub) => `<td style="padding:0 8px 8px 0;vertical-align:top;"><div style="border:1px solid #e4e8ef;border-radius:10px;padding:10px 14px;min-width:170px;height:74px;box-sizing:border-box;">
    <div style="font-size:11px;color:#6B7BA2;text-transform:uppercase;letter-spacing:.05em;font-weight:700;">${esc(l)}</div><div style="font-size:26px;color:${c};font-weight:700;margin-top:2px;line-height:1.1;">${v}</div><div style="font-size:11px;color:#6B7BA2;">${sub ? esc(sub) : '&nbsp;'}</div></div></td>`;
  const tiles = tile('New reviews under 4★', reviews.length, reviews.length ? '#C0392B' : '#1A7F5A')
    + tile('Rating drops', drops.length, drops.length ? '#C0392B' : '#1A7F5A', drops.filter(d => d.belowLine).length ? `${drops.filter(d => d.belowLine).length} fell below ${ELIGIBILITY_LINE.toFixed(1)}★` : '');
  // (scope note no longer needed: everyone gets the full email)
  const th = 'padding:7px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#fff;background:#001F60;text-align:left;font-family:Arial,sans-serif;';
  const td = 'padding:8px 10px;font-size:12px;color:#001F60;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;vertical-align:top;';

  const brandsInOrder = [...new Set([...reviews, ...drops].map(x => x.brand))].sort();
  const sections = brandsInOrder.map(brand => {
    const rv = reviews.filter(x => x.brand === brand), dr = drops.filter(x => x.brand === brand);
    const mgrs = [...new Set([...rv, ...dr].map(x => x.manager).filter(Boolean))].join(', ');
    const dropTable = dr.length ? `<div style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#C0392B;">Star rating dropped · ${dr.length}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
        <tr><th style="${th}">Product</th><th style="${th}">Rating</th><th style="${th}">Reviews</th><th style="${th}">Compared</th></tr>
        ${dr.map((x, i) => `<tr style="background:${x.belowLine ? '#FFF1EE' : i % 2 ? '#F7F8FC' : '#fff'};">
          <td style="${td}"><b>${esc(x.sku)}</b> <span style="font-size:10px;color:#9ba8c0;">${esc(x.asin)}</span>${x.belowLine ? `<div style="margin-top:3px;"><span style="display:inline-block;padding:1px 7px;border-radius:999px;background:#FFD2CC;color:#C0392B;font-size:10px;font-weight:700;">Now below ${ELIGIBILITY_LINE.toFixed(1)}★</span></div>` : ''}</td>
          <td style="${td}white-space:nowrap;"><b>${x.from.toFixed(1)}★ → <span style="color:#C0392B;">${x.to.toFixed(1)}★</span></b></td>
          <td style="${td}white-space:nowrap;">${Number.isFinite(x.reviewsFrom) && Number.isFinite(x.reviewsTo) ? `${x.reviewsFrom.toLocaleString('en-US')} → ${x.reviewsTo.toLocaleString('en-US')} <span style="color:#6B7BA2;">(+${(x.reviewsTo - x.reviewsFrom).toLocaleString('en-US')})</span>` : '—'}</td>
          <td style="${td}white-space:nowrap;color:#6B7BA2;">${esc(fmtDay(x.fromDate))} → ${esc(fmtDay(x.toDate))}</td></tr>
          <tr style="background:${x.belowLine ? '#FFF1EE' : i % 2 ? '#F7F8FC' : '#fff'};"><td colspan="4" style="padding:0 10px 10px 22px;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;">
            <div style="font-size:10px;font-weight:700;color:#6B7BA2;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Last 3 reviews</div>
            ${x.last3 && x.last3.length ? x.last3.map(v => `<div style="font-size:12px;color:#3a4a6b;margin-bottom:5px;line-height:1.45;">${starsHtml(v.stars)} <b style="color:#001F60;">${esc(v.title || '(no title)')}</b> <span style="color:#9ba8c0;font-size:11px;">· ${esc(v.date ? fmtDay(v.date) : v.dateText)}${v.purchase ? ' · ' + esc(v.purchase) : ''}</span><br><span style="white-space:pre-line;">${esc(String(v.text || '').trim())}</span></div>`).join('')
              : '<div style="font-size:11px;color:#9ba8c0;">No written reviews for this product in the reviews sheet yet.</div>'}
          </td></tr>`).join('')}</table>` : '';
    const reviewCards = rv.length ? `<div style="margin:14px 0 4px;font-size:13px;font-weight:700;color:#001F60;">New reviews under 4★ · ${rv.length}</div>
      ${rv.map(x => `<div style="border:1px solid #e4e8ef;border-left:4px solid ${x.stars <= 2 ? '#C0392B' : '#F2A900'};border-radius:6px;padding:10px 12px;margin-bottom:8px;">
        <div style="font-size:12px;">${starsHtml(x.stars)} &nbsp;<b style="color:#001F60;">${esc(x.title || '(no title)')}</b></div>
        <div style="font-size:11px;color:#6B7BA2;margin:3px 0 6px;"><b style="color:#001F60;">${esc(x.sku)}</b> · ${esc(clip(x.product, 70))} · ${esc(x.date ? fmtDay(x.date) : x.dateText)}${x.purchase ? ` · ${esc(x.purchase)}` : ''}${x.reviewer ? ` · ${esc(x.reviewer)}` : ''}</div>
        <div style="font-size:12px;color:#3a4a6b;line-height:1.5;white-space:pre-line;">${esc(String(x.text || '').trim())}</div></div>`).join('')}` : '';
    return `<tr><td style="padding:18px 32px 6px;">
      <div style="font-size:18px;font-weight:700;color:#001F60;font-family:Georgia,'Times New Roman',serif;border-bottom:2px solid #24E9A3;padding-bottom:4px;">${esc(brand)}
        <span style="font-size:11px;font-weight:400;color:#6B7BA2;font-family:Arial,sans-serif;">${mgrs ? '&nbsp;·&nbsp;' + esc(mgrs) : ''}</span></div>
      ${dropTable}${reviewCards}</td></tr>`;
  }).join('');

  const scope = '';
  const notes = [
    rises.length ? `Ratings up: ${rises.map(x => `${esc(x.sku)} ${x.from.toFixed(1)}★ → ${x.to.toFixed(1)}★`).join(', ')}.` : '',
    'Reviews: under 4★ and new since the last email (from the weekly reviews upload). Ratings: Helium 10 Keyword Tracker, latest update vs the one before. "Last 3 reviews" are written reviews only — Amazon\'s rating also counts star ratings left without a review, so a drop can come from ratings that don\'t appear here.',
    firstRun ? `First email: only reviews from the last ${FIRST_RUN_DAYS} days are included; older ones were recorded as already seen.` : '',
    wouldSendTo ? `TEST SEND — the real email would go to: ${wouldSendTo.map(esc).join(', ')}.` : '',
  ].filter(Boolean).map(n => `<div style="font-size:11px;color:#9ba8c0;margin-top:4px;">${n}</div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:32px 0;"><tr><td align="center">
    <table width="1100" cellpadding="0" cellspacing="0" style="width:1100px;max-width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <tr><td style="background:#001F60;padding:24px 32px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#24E9A3;font-weight:700;">NewDerm &middot; Customer Feedback</div>
        <div style="font-size:24px;color:#fff;font-weight:700;margin-top:6px;font-family:Georgia,'Times New Roman',serif;">Reviews &amp; Ratings</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px;">${esc(fmtDay(today))} &middot; new reviews under 4★ and star rating drops</div>
        ${scope ? `<div style="font-size:12px;color:#24E9A3;margin-top:6px;">${esc(scope)}</div>` : ''}
      </td></tr>
      <tr><td style="padding:22px 32px 4px;"><table cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table></td></tr>
      ${sections}
      <tr><td style="padding:14px 32px 24px;"><div style="font-size:12px;color:#6B7BA2;">Full review text and every rating change are in the attached Excel file.</div>${notes}</td></tr>
      <tr><td style="background:#001F60;padding:16px 32px;"><div style="padding-bottom:12px;"><img src="${LOGO_URL}" alt="Medaltus" height="22" style="height:22px;display:block;"></div>
        <span style="font-size:11px;color:#6B7BA2;">Medaltus automated report &middot; reports@medaltus.com</span></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function buildWorkbook({ reviews, ratings }) {
  const wb = XLSX.utils.book_new();
  if (reviews.length) {
    const ws = XLSX.utils.aoa_to_sheet([['Brand', 'SKU', 'ASIN', 'Product', 'Stars', 'Title', 'Review', 'Date', 'Purchase type', 'Reviewer', 'Brand Manager'],
      ...reviews.map(x => [x.brand, x.sku, x.asin, x.product, x.stars, x.title, x.text, x.date || x.dateText, x.purchase, x.reviewer, x.manager])]);
    ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 13 }, { wch: 30 }, { wch: 6 }, { wch: 30 }, { wch: 80 }, { wch: 11 }, { wch: 14 }, { wch: 18 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, 'New reviews under 4 stars');
  }
  if (ratings.length) {
    const last = (x, i) => { const v = (x.last3 || [])[i]; return v ? `${v.stars}★ ${v.date || v.dateText} — ${v.title}: ${String(v.text || '').trim()}` : ''; };
    const ws = XLSX.utils.aoa_to_sheet([['Brand', 'SKU', 'ASIN', 'Rating before', 'Rating now', 'Change', 'Reviews before', 'Reviews now', 'Compared from', 'Compared to', `Below ${ELIGIBILITY_LINE.toFixed(1)}?`, 'Brand Manager', 'Latest review', '2nd latest review', '3rd latest review'],
      ...ratings.map(x => [x.brand, x.sku, x.asin, x.from, x.to, Math.round((x.to - x.from) * 100) / 100, Number.isFinite(x.reviewsFrom) ? x.reviewsFrom : '', Number.isFinite(x.reviewsTo) ? x.reviewsTo : '', x.fromDate, x.toDate, x.to < ELIGIBILITY_LINE ? 'YES' : '', x.manager, last(x, 0), last(x, 1), last(x, 2)])]);
    ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 13 }, { wch: 12 }, { wch: 11 }, { wch: 8 }, { wch: 13 }, { wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 60 }, { wch: 60 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Rating changes');
  }
  return wb;
}

// ── Master list (Amazon rows only, column G) ───────────────────────────────
async function loadMaster() {
  const id = process.env.SHEET_MASTER_SKU_LIST;
  if (!id) throw new Error('SHEET_MASTER_SKU_LIST env var not set');
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${MASTER_GID}`);
  if (!r.ok) throw new Error(`master SKU list CSV → ${r.status}`);
  const rows = parseCsv(await r.text());
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const col = (n, f) => { const i = head.indexOf(n.toLowerCase()); return i >= 0 ? i : f; };
  const iSku = col('SKU', 1), iMgr = col('Brand Manager', 26), iChannel = col('Channel', 6);
  const map = new Map();
  for (const row of rows.slice(1)) {
    const sku = String(row[iSku] || '').trim().toUpperCase();
    if (!sku || !/amazon/i.test(String(row[iChannel] || ''))) continue;
    map.set(sku, { manager: String(row[iMgr] || '').trim() });
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
function todayEt() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fmtDay(iso) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
