/**
 * api/cron/alt-sellers-email.js
 * ADDED 2026-11-13 (per Jaclyn) — weekday "Alternate Sellers" email, styled
 * like listing-alerts-email.js and routed the same way.
 *
 * Source: the "<brand tab> offers" tabs in the "Newderm -SF product Sync"
 * sheet (written by sync-product-offers.js, one row per offer per ASIN per
 * day). Runs at 4:15 PM Eastern on weekdays, after the offers cron's passes
 * (3:05–3:50 PM Eastern).
 *
 * For every ASIN where another seller has an offer TODAY:
 *   - who holds the Buy Box: us (FBA), us (FBM), another seller, or nobody
 *   - our price (our Buy Box offer, else our lowest), how many other sellers
 *   - each other seller: NEW (not on this ASIN at the last report — the
 *     previous weekday, so Monday looks back to Friday) or ongoing (with the
 *     first date we saw them in the last 90 days), FBA/FBM, their price incl.
 *     shipping and the difference from ours, and whether they hold the Buy Box
 *   - sellers that were on the ASIN at the last report but are gone today
 * Amazon does not share other sellers' inventory, so it can't be shown.
 * Seller names come from the Products Cache "seller_names" tab (fill a name
 * in once and it's used everywhere); otherwise the seller ID, linked to the
 * seller's Amazon storefront.
 *
 * Only ASINs with a LIVE SKU on the master SKU list are included. Sends only
 * when there's at least one other seller.
 * Recipients: awilcox@medaltus.com gets everything; each Brand Manager
 * (master list "Brand Manager" column) gets their own SKUs only.
 *
 * Modes (same as listing-alerts-email.js):
 *   ?testTo=a@medaltus.com   send only to these @medaltus.com addresses (that address's version;
 *                            &as=someone@medaltus.com or &as=all to pick), not logged
 *   ?preview=true            return the HTML (&as=… for someone's version)
 *   ?date=YYYY-MM-DD         report on a specific day (default: today, Eastern)
 *   ?force=true              send again even if today's already went out
 *
 * Env: CRON_SECRET, ALERTS_API_KEY (Resend), SHEET_MASTER_SKU_LIST,
 *      optional SHEET_SF_PRODUCTS, FROM_EMAIL.
 */

const XLSX = require('xlsx');
const { getSheetsToken, readRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { sendCronFailureAlert } = require('../_alerts');
const { isoDate } = require('../_dates');

const SF_SHEET = process.env.SHEET_SF_PRODUCTS || '1eAkS2Jr30ewk57mP39wA9h6Z862pE1zlE9znTXsZi34';
const OFFERS_SUFFIX = ' offers';
const LOG_TAB = 'email-log-alt-sellers';
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

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const testTo = String(req.query.testTo || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (testTo.some(e => !e.endsWith('@medaltus.com'))) return res.status(400).json({ error: 'testTo addresses must be @medaltus.com' });
  const preview = req.query.preview === 'true';
  const force = req.query.force === 'true';
  const dateGiven = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''));
  const reportDate = dateGiven ? String(req.query.date) : todayEt();
  const prevDate = previousWeekday(reportDate);

  try {
    const token = await getSheetsToken('writer');
    const meta = await sheetsApi(token, 'GET', `/${SF_SHEET}?fields=sheets.properties(title)`);
    const tabs = new Set((meta.sheets || []).map(s => s.properties.title));

    if (!testTo.length && !preview && !force && tabs.has(LOG_TAB)) {
      const log = await sheetsApi(token, 'GET', `/${SF_SHEET}/values/${rng(LOG_TAB, 'A2:A')}`);
      if ((log.values || []).some(r => String(r[0] || '').slice(0, 10) === reportDate)) {
        return res.status(200).json({ skipped: true, reason: `Alternate Sellers for ${reportDate} already sent` });
      }
    }

    const master = await loadMaster();
    const names = {};
    (await readRows(sheets.products, 'seller_names').catch(() => []) || []).forEach(r => { if (r.seller_id && r.seller_name) names[String(r.seller_id).trim()] = String(r.seller_name).trim(); });

    // ── Build each ASIN's picture ───────────────────────────────────────────
    const asinCards = []; // one per ASIN with other sellers today
    for (const brand of brands.filter(b => b.active)) {
      const tab = brand.tabName + OFFERS_SUFFIX;
      if (!tabs.has(tab)) continue;
      const got = await sheetsApi(token, 'GET', `/${SF_SHEET}/values/${rng(tab, 'A1:P')}`);
      const [head = [], ...rows] = got.values || [];
      const ix = Object.fromEntries(head.map((h, i) => [String(h).trim(), i]));
      const get = (r, k) => r[ix[k]] ?? '';
      const firstSeen = {}; // asin|seller -> earliest date
      const byDay = { today: new Map(), prev: new Map() }; // asin -> rows
      for (const r of rows) {
        const d = isoDate(get(r, 'date')); const asin = String(get(r, 'asin')).trim().toUpperCase();
        if (!d || !asin) continue;
        const sid = String(get(r, 'seller_id')).trim();
        if (sid && get(r, 'is_us') !== 'TRUE') { const k = `${asin}|${sid}`; if (!firstSeen[k] || d < firstSeen[k]) firstSeen[k] = d; }
        const bucket = d === reportDate ? byDay.today : d === prevDate ? byDay.prev : null;
        if (!bucket) continue;
        if (!bucket.has(asin)) bucket.set(asin, []);
        bucket.get(asin).push(r);
      }
      for (const [asin, list] of byDay.today) {
        const others = list.filter(r => get(r, 'is_us') !== 'TRUE' && get(r, 'seller_id'));
        if (!others.length) continue;
        const skus = String(get(list[0], 'sku') || '').split('|').map(s => s.trim()).filter(Boolean);
        const m = skus.map(s => master.get(s.toUpperCase())).find(x => x && x.status === 'LIVE');
        if (!m) continue; // master list is the source of truth
        const prevSellers = new Set((byDay.prev.get(asin) || []).filter(r => get(r, 'is_us') !== 'TRUE').map(r => String(get(r, 'seller_id')).trim()));
        const todaySellers = new Set(others.map(r => String(get(r, 'seller_id')).trim()));
        const hadPrev = byDay.prev.has(asin);
        const label = id => names[id] || id;
        const sellers = others.map(r => {
          const id = String(get(r, 'seller_id')).trim();
          return {
            id, name: label(id), isNew: hadPrev ? !prevSellers.has(id) : true, firstSeen: firstSeen[`${asin}|${id}`] || reportDate,
            channel: get(r, 'fulfillment'), price: num(get(r, 'landed_price')), diff: get(r, 'price_diff') === '' ? null : num(get(r, 'price_diff')),
            buybox: get(r, 'is_buybox') === 'TRUE',
          };
        }).sort((a, b) => (b.buybox - a.buybox) || (b.isNew - a.isNew) || (a.price - b.price));
        const ourPrice = get(list[0], 'our_price') === '' ? null : num(get(list[0], 'our_price'));
        const owner = String(get(list[0], 'buybox_owner'));
        asinCards.push({
          brand: brand.displayName || brand.id, asin, sku: skus.join(', '), manager: m.manager,
          buyboxOwner: owner.startsWith('us') ? owner : owner === 'none' ? 'Nobody (suppressed)' : (names[sellers.find(s => s.buybox)?.id] || owner),
          ourBuybox: owner.startsWith('us'), ourPrice, sellers,
          gone: [...prevSellers].filter(id => !todaySellers.has(id)).map(label),
        });
      }
      await sleep(250);
    }

    if (!asinCards.length) return res.status(200).json({ sent: false, reason: 'no other sellers on any LIVE ASIN', reportDate });

    // ── Versions per recipient (same routing as Listing Alerts) ────────────
    const emailOf = n => MANAGER_EMAILS[String(n || '').trim().toLowerCase()] || null;
    const unknownManagers = [...new Set(asinCards.filter(c => c.manager && !emailOf(c.manager)).map(c => c.manager))];
    const versions = new Map(ALWAYS_TO.map(e => [e, asinCards]));
    for (const c of asinCards) {
      const e = emailOf(c.manager);
      if (!e || ALWAYS_TO.includes(e)) continue;
      if (!versions.has(e)) versions.set(e, []);
      versions.get(e).push(c);
    }
    const asParam = String(req.query.as || '').trim().toLowerCase();
    const pick = who => (who === 'all' || !versions.has(who)) ? { who: 'all', cards: asinCards } : { who, cards: versions.get(who) };

    if (preview) {
      const v = pick(asParam || 'all');
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(buildHtml(v.cards, reportDate, prevDate, v.who === 'all' ? unknownManagers : [], null, scopeNote(v.who, v.cards)));
    }
    if (!process.env.ALERTS_API_KEY) throw new Error('ALERTS_API_KEY is not set');

    const sends = testTo.length
      ? [{ to: testTo, ...pick(asParam || testTo[0]), test: true }]
      : [...versions.entries()].map(([who, cards]) => ({ to: [who], who: ALWAYS_TO.includes(who) ? 'all' : who, cards }));
    const results = [];
    for (const s of sends) {
      if (!s.cards.length) continue;
      const t = totals(s.cards);
      const realTo = s.who === 'all' ? ALWAYS_TO : [s.who];
      const html = buildHtml(s.cards, reportDate, prevDate, s.who === 'all' ? unknownManagers : [], s.test ? realTo : null, scopeNote(s.who, s.cards));
      const subject = `${s.test ? '[TEST] ' : ''}Alternate Sellers — ${t.newSellers ? `${t.newSellers} new, ` : ''}${t.sellers} on ${t.asins} ASIN${t.asins === 1 ? '' : 's'}${t.lostBuybox ? `, Buy Box with others on ${t.lostBuybox}` : ''} · ${fmtDay(reportDate)}`;
      const attachment = Buffer.from(XLSX.write(buildWorkbook(s.cards), { type: 'buffer', bookType: 'xlsx' })).toString('base64');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.ALERTS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `Medaltus Reports <${FROM_EMAIL}>`, reply_to: REPLY_TO, to: s.to, subject, html,
          attachments: [{ filename: `Alternate Sellers_${reportDate}.xlsx`, content: attachment }] }),
      });
      const body = await r.json().catch(() => ({}));
      results.push({ to: s.to, version: s.who, asins: s.cards.length, ok: r.ok, id: body.id || null, error: r.ok ? undefined : JSON.stringify(body).slice(0, 200) });
      await sleep(600);
    }
    const failed = results.filter(r => !r.ok);
    if (failed.length) await sendCronFailureAlert('alt-sellers-email', failed.map(f => `${f.to.join(',')}: ${f.error}`).join('\n'));

    if (!testTo.length && results.some(r => r.ok)) {
      if (!tabs.has(LOG_TAB)) {
        await sheetsApi(token, 'POST', `/${SF_SHEET}:batchUpdate`, { requests: [{ addSheet: { properties: { title: LOG_TAB, gridProperties: { rowCount: 1000, columnCount: 5 } } } }] });
        await sheetsApi(token, 'PUT', `/${SF_SHEET}/values/${rng(LOG_TAB, 'A1')}?valueInputOption=RAW`, { values: [['report_date', 'sent_at', 'asins', 'recipients', 'message_ids']] });
      }
      await sheetsApi(token, 'POST', `/${SF_SHEET}/values/${rng(LOG_TAB, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [[
        reportDate, new Date().toISOString(), asinCards.length, results.filter(r => r.ok).map(r => `${r.to.join(',')} (${r.asins})`).join('; '), results.map(r => r.id).filter(Boolean).join(', ')]] });
    }
    return res.status(200).json({ sent: results.some(r => r.ok), test: !!testTo.length, reportDate, emails: results, unknownManagers });
  } catch (err) {
    console.error('[alt-sellers-email]', err.message);
    await sendCronFailureAlert('alt-sellers-email', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Email ──────────────────────────────────────────────────────────────────
function totals(cards) {
  return {
    asins: cards.length,
    sellers: cards.reduce((n, c) => n + c.sellers.length, 0),
    newSellers: cards.reduce((n, c) => n + c.sellers.filter(s => s.isNew).length, 0),
    lostBuybox: cards.filter(c => !c.ourBuybox).length,
  };
}
function scopeNote(who, cards) {
  if (who === 'all') return '';
  return `Your SKUs only (${[...new Set(cards.map(c => c.brand))].sort().join(', ')}) — the full every-brand email goes to ${ALWAYS_TO.join(', ')}.`;
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = n => (n == null || Number.isNaN(n) ? '—' : `$${Number(n).toFixed(2)}`);
function diffCell(s, ourPrice) {
  if (s.diff == null || ourPrice == null) return '<span style="color:#9ba8c0;">—</span>';
  if (Math.abs(s.diff) < 0.005) return '<span style="color:#6B7BA2;">same as ours</span>';
  const pct = ourPrice ? ` (${s.diff > 0 ? '+' : ''}${Math.round(s.diff / ourPrice * 100)}%)` : '';
  return s.diff < 0
    ? `<span style="color:#C0392B;font-weight:700;">${money(-s.diff)} below ours${pct}</span>`
    : `<span style="color:#1A7F5A;">${money(s.diff)} above ours${pct}</span>`;
}

function buildHtml(cards, reportDate, prevDate, unknownManagers, wouldSendTo, scope) {
  const t = totals(cards);
  const tile = (label, n, color, sub) => `<td style="padding:0 8px 8px 0;vertical-align:top;"><div style="border:1px solid #e4e8ef;border-radius:10px;padding:10px 14px;min-width:120px;">
      <div style="font-size:11px;color:#6B7BA2;text-transform:uppercase;letter-spacing:.05em;font-weight:700;">${esc(label)}</div>
      <div style="font-size:26px;color:${color};font-weight:700;line-height:1.1;margin-top:2px;">${n}</div>${sub ? `<div style="font-size:11px;color:#6B7BA2;">${esc(sub)}</div>` : ''}</div></td>`;
  const tiles = tile('ASINs with other sellers', t.asins, '#001F60') + tile('Other sellers', t.sellers, '#001F60', `${t.newSellers} new since ${fmtDay(prevDate)}`)
    + tile('Buy Box not ours', t.lostBuybox, t.lostBuybox ? '#C0392B' : '#1A7F5A');

  const th = 'padding:7px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#fff;background:#001F60;text-align:left;font-family:Arial,sans-serif;';
  const td = 'padding:7px 10px;font-size:12px;color:#001F60;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;vertical-align:top;';
  const pill = (txt, bg, fg) => `<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:${bg};color:${fg};font-size:10px;font-weight:700;">${txt}</span>`;

  const brandsInOrder = [...new Set(cards.map(c => c.brand))].sort();
  const sections = brandsInOrder.map(brand => {
    const list = cards.filter(c => c.brand === brand)
      .sort((a, b) => (a.ourBuybox - b.ourBuybox) || (b.sellers.filter(s => s.isNew).length - a.sellers.filter(s => s.isNew).length) || a.sku.localeCompare(b.sku));
    const mgrs = [...new Set(list.map(c => c.manager).filter(Boolean))].join(', ');
    const asinBlocks = list.map(c => {
      const bb = c.ourBuybox ? pill(esc(c.buyboxOwner.replace('us', 'Ours')), '#24E9A3', '#001F60') : pill(`Buy Box: ${esc(c.buyboxOwner)}`, '#FFD2CC', '#C0392B');
      const rows = c.sellers.map((s, n) => `<tr style="background:${n % 2 ? '#F7F8FC' : '#fff'};">
          <td style="${td}white-space:nowrap;">${s.isNew ? pill('NEW', '#24E9A3', '#001F60') : `<span style="font-size:10px;color:#9ba8c0;">since ${esc(fmtDay(s.firstSeen))}</span>`}</td>
          <td style="${td}"><a href="https://www.amazon.com/sp?seller=${esc(s.id)}" style="color:#001F60;font-weight:700;text-decoration:none;">${esc(s.name)}</a>${s.name !== s.id ? `<div style="font-size:10px;color:#9ba8c0;">${esc(s.id)}</div>` : ''}</td>
          <td style="${td}">${esc(s.channel)}</td>
          <td style="${td}white-space:nowrap;">${money(s.price)}</td>
          <td style="${td}">${diffCell(s, c.ourPrice)}</td>
          <td style="${td}text-align:center;">${s.buybox ? '<span style="color:#C0392B;font-weight:700;">&#10003;</span>' : ''}</td></tr>`).join('');
      const gone = c.gone.length ? `<div style="font-size:11px;color:#6B7BA2;margin-top:4px;">No longer selling since ${esc(fmtDay(prevDate))}: ${c.gone.map(esc).join(', ')}</div>` : '';
      return `<div style="margin:14px 0 4px;">
          <span style="font-size:14px;font-weight:700;color:#001F60;">${esc(c.sku)}</span>
          <span style="font-size:11px;color:#6B7BA2;">&nbsp;${esc(c.asin)} &middot; our price ${money(c.ourPrice)} &middot; ${c.sellers.length} other seller${c.sellers.length === 1 ? '' : 's'}</span>&nbsp; ${bb}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
          <tr><th style="${th}width:90px;"></th><th style="${th}">Seller</th><th style="${th}width:60px;">Ships</th><th style="${th}width:90px;">Their price</th><th style="${th}">vs. our price</th><th style="${th}width:70px;text-align:center;">Buy Box</th></tr>
          ${rows}</table>${gone}`;
    }).join('');
    return `<tr><td style="padding:18px 32px 6px;">
        <div style="font-size:18px;font-weight:700;color:#001F60;font-family:Georgia,'Times New Roman',serif;border-bottom:2px solid #24E9A3;padding-bottom:4px;">${esc(brand)}
          <span style="font-size:11px;font-weight:400;color:#6B7BA2;font-family:Arial,sans-serif;">${mgrs ? '&nbsp;·&nbsp;' + esc(mgrs) : ''}</span></div>
        ${asinBlocks}</td></tr>`;
  }).join('');

  const notes = [
    'Prices include shipping. "NEW" = not on that ASIN at the last report. Amazon doesn\'t share other sellers\' inventory.',
    unknownManagers.length ? `Brand Manager name(s) on the master list with no email on file (not emailed): ${unknownManagers.map(esc).join(', ')}.` : '',
    wouldSendTo ? `TEST SEND — the real email would go to: ${wouldSendTo.map(esc).join(', ')}.` : '',
  ].filter(Boolean).map(n => `<div style="font-size:11px;color:#9ba8c0;margin-top:4px;">${n}</div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:32px 0;"><tr><td align="center">
    <table width="1100" cellpadding="0" cellspacing="0" style="width:1100px;max-width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <tr><td style="background:#001F60;padding:24px 32px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#24E9A3;font-weight:700;">NewDerm &middot; Amazon Offers</div>
        <div style="font-size:24px;color:#fff;font-weight:700;margin-top:6px;font-family:Georgia,'Times New Roman',serif;">Alternate Sellers</div>
        <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px;">${esc(fmtDay(reportDate))} &middot; other sellers on our ASINs today, and who holds the Buy Box</div>
        ${scope ? `<div style="font-size:12px;color:#24E9A3;margin-top:6px;">${esc(scope)}</div>` : ''}
      </td></tr>
      <tr><td style="padding:22px 32px 4px;"><table cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table></td></tr>
      ${sections}
      <tr><td style="padding:14px 32px 24px;"><div style="font-size:12px;color:#6B7BA2;">Every seller on every ASIN is in the attached Excel file.</div>${notes}</td></tr>
      <tr><td style="background:#001F60;padding:16px 32px;">
        <div style="padding-bottom:12px;"><img src="${LOGO_URL}" alt="Medaltus" height="22" style="height:22px;display:block;"></div>
        <span style="font-size:11px;color:#6B7BA2;">Medaltus automated report &middot; reports@medaltus.com</span>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function buildWorkbook(cards) {
  const wb = XLSX.utils.book_new();
  const rows = [['Brand', 'SKU', 'ASIN', 'Brand Manager', 'Buy Box', 'Our price', 'Seller', 'Seller ID', 'New?', 'First seen', 'Ships', 'Their price', 'Difference vs ours', 'Holds Buy Box', 'Storefront']];
  for (const c of cards) for (const s of c.sellers) {
    rows.push([c.brand, c.sku, c.asin, c.manager || '', c.buyboxOwner, c.ourPrice ?? '', s.name, s.id, s.isNew ? 'NEW' : 'ongoing', s.firstSeen, s.channel,
      s.price, s.diff ?? '', s.buybox ? 'YES' : '', `https://www.amazon.com/sp?seller=${s.id}`]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 16 }, { wch: 22 }, { wch: 13 }, { wch: 18 }, { wch: 22 }, { wch: 10 }, { wch: 26 }, { wch: 16 }, { wch: 9 }, { wch: 11 }, { wch: 6 }, { wch: 11 }, { wch: 12 }, { wch: 10 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Alternate sellers');
  return wb;
}

// ── Master list (same reading as listing-alerts-email.js) ───────────────────
async function loadMaster() {
  const id = process.env.SHEET_MASTER_SKU_LIST;
  if (!id) throw new Error('SHEET_MASTER_SKU_LIST env var not set');
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${MASTER_GID}`);
  if (!r.ok) throw new Error(`master SKU list CSV → ${r.status}`);
  const rows = parseCsv(await r.text());
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const col = (n, f) => { const i = head.indexOf(n.toLowerCase()); return i >= 0 ? i : f; };
  const iSku = col('SKU', 1), iStatus = col('Status', 7), iMgr = col('Brand Manager', 26), iChannel = col('Channel', 6);
  const map = new Map();
  for (const r of rows.slice(1)) {
    const sku = String(r[iSku] || '').trim().toUpperCase();
    if (!sku || !/amazon/i.test(String(r[iChannel] || ''))) continue; // Amazon rows only (column G)
    map.set(sku, { status: String(r[iStatus] || '').trim().toUpperCase(), manager: String(r[iMgr] || '').trim() });
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
const num = v => { const n = parseFloat(String(v).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function todayEt() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function previousWeekday(iso) { let d = addDays(iso, -1); while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDays(d, -1); return d; }
function fmtDay(iso) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
