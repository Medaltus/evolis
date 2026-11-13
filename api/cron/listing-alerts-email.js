/**
 * api/cron/listing-alerts-email.js
 * GET /api/cron/listing-alerts-email
 *
 * Daily "Listing Alerts" email (per Jaclyn 2026-11-13), styled like the VBC
 * onhold-email.js. Sends ONLY when there is something to report.
 *
 * Compares the Products Cache (written daily by sync-products.js) for
 * YESTERDAY (Eastern; the last fully-synced day) against:
 *   1. CONTRIBUTIONS — the master SKU list is the source of truth. For each
 *      LIVE master SKU, every contribution field FILLED IN on the master list
 *      (Title, Item Highlights, Bullets 1–5, Product Description, Backend
 *      Keywords) is compared with what's live. Blank master cells are never
 *      checked. Spacing, curly quotes, dashes and HTML entities are ignored;
 *      Backend Keywords match if they equal Backend OR Seasonal Backend
 *      Keywords (word order and case ignored).
 *   2. CATEGORY CHANGES — Amazon's category names (sales_ranks, ranks
 *      ignored) and item_type_keyword, yesterday vs the day before. A day
 *      Amazon returns no categories never counts as a change.
 *   3. SUPPRESSIONS — the listing not DISCOVERABLE, not BUYABLE while in
 *      stock, or any issue Amazon enforced as a suppression
 *      ({LISTING_SUPPRESSED}, {ATTRIBUTE_SUPPRESSED}, … — tags written by
 *      sync-products.js since 2026-11-13), plus any other ERROR issue.
 *   4. IMAGE CHANGES (FYI) — any image slot whose Amazon image ID changed
 *      (the images column, sync-products.js since 2026-11-13).
 * Only SKUs on the master list with Status LIVE are ever included.
 * Each item is marked NEW (not present the day before) or ongoing.
 *
 * Recipients: awilcox@medaltus.com always, plus the Brand Manager (master
 * list "Brand Manager" column, AA) of every SKU in the email.
 * Organized by brand. Full detail is also attached as an Excel file.
 *
 * Modes:
 *   ?testTo=a@medaltus.com        send only to these @medaltus.com addresses;
 *                                 not logged, ignores the once-a-day check
 *   ?preview=true                 return the email HTML instead of sending
 *   ?date=YYYY-MM-DD              report on a specific day (default: yesterday ET)
 *   ?force=true                   send again even if today's already went out
 *
 * Env: CRON_SECRET, ALERTS_API_KEY (Resend), SHEET_MASTER_SKU_LIST,
 *      optional FROM_EMAIL.
 */

const XLSX = require('xlsx');
const { readRows, ensureTab, appendRows } = require('../config/_sheets_client');
const brands = require('../config/brands');
const sheets = require('../config/sheets');
const { sendCronFailureAlert } = require('../_alerts');
const { normalizeOrderDate } = require('../_dates');

const MASTER_GID = '164358627'; // master SKU list tab (by ID — safe to rename the tab)
const ALWAYS_TO = ['awilcox@medaltus.com'];
const MANAGER_EMAILS = {
  'jaclyn sonberg': 'jsonberg@medaltus.com',
  'isabella fernandez': 'ifernandez@medaltus.com',
  'lindsay rohde': 'lrohde@medaltus.com',
};
const FROM_EMAIL = process.env.FROM_EMAIL || 'reports@medaltus.com';
const REPLY_TO = 'reports@medaltus.com';
const LOGO_URL = 'https://vbcosmeticsreport.medaltus.com/api/medaltus-logo';
const LOG_TAB = 'email-log-listing-alerts';
const ROWS_PER_SECTION = 25; // per brand per section in the email body; the Excel has everything

// Contribution fields: [master header, Products Cache column, label]
const FIELDS = [
  ['Title', 'title', 'Title'],
  ['Item Highlights', 'item_highlights', 'Item Highlights'],
  ['Bullet 1', 'bullet_1', 'Bullet 1'],
  ['Bullet 2', 'bullet_2', 'Bullet 2'],
  ['Bullet 3', 'bullet_3', 'Bullet 3'],
  ['Bullet 4', 'bullet_4', 'Bullet 4'],
  ['Bullet 5', 'bullet_5', 'Bullet 5'],
  ['Product Description', 'description', 'Description'],
  ['Backend Keywords', 'backend_keywords', 'Backend Keywords'],
];
const SUPPRESSION_TAGS = ['LISTING_SUPPRESSED', 'ATTRIBUTE_SUPPRESSED', 'CATALOG_ITEM_REMOVED', 'SEARCH_SUPPRESSED', 'LISTING_REMOVED'];

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const testTo = String(req.query.testTo || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (testTo.some(e => !e.endsWith('@medaltus.com'))) return res.status(400).json({ error: 'testTo addresses must be @medaltus.com' });
  const preview = req.query.preview === 'true';
  const force = req.query.force === 'true';

  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : addDays(todayEt(), -1);
  const prevDate = addDays(reportDate, -1);

  try {
    // ── Once a day ──────────────────────────────────────────────────────
    if (!testTo.length && !preview && !force) {
      const log = await readRows(sheets.products, LOG_TAB).catch(() => []);
      if ((log || []).some(r => String(r.report_date || '').slice(0, 10) === reportDate)) {
        return res.status(200).json({ skipped: true, reason: `Listing Alerts for ${reportDate} already sent` });
      }
    }

    // ── Master SKU list ─────────────────────────────────────────────────
    const master = await loadMaster();

    // ── Products Cache: yesterday + the day before, every active brand ──
    const found = [];       // alert rows
    const unknownManagers = new Set();
    for (const brand of brands.filter(b => b.active)) {
      const rows = await readRows(sheets.products, brand.tabName).catch(err => { throw new Error(`Products Cache tab "${brand.tabName}": ${err.message}`); });
      const day = {}, prev = {};
      for (const r of rows || []) {
        const d = normalizeOrderDate(r.date).iso;
        const sku = String(r.sku || '').replace(/^'/, '').trim().toUpperCase();
        if (!sku) continue;
        if (d === reportDate) day[sku] = r; else if (d === prevDate) prev[sku] = r;
      }
      for (const [sku, cur] of Object.entries(day)) {
        const m = master.get(sku);
        if (!m || m.status !== 'LIVE') continue; // master list is the source of truth
        const before = prev[sku] || null;
        const base = { brand: brand.displayName || brand.id, sku, asin: m.asin || cur.asin || '', manager: m.manager };
        for (const a of checkSku(cur, before, m)) found.push({ ...base, ...a });
      }
      await sleep(400); // spread reads (shared Sheets quota)
    }

    if (!found.length) return res.status(200).json({ sent: false, reason: 'nothing to report', reportDate });

    // ── Recipients ──────────────────────────────────────────────────────
    const managerEmails = new Set();
    for (const f of found) {
      const key = String(f.manager || '').trim().toLowerCase();
      if (!key) continue;
      if (MANAGER_EMAILS[key]) managerEmails.add(MANAGER_EMAILS[key]); else unknownManagers.add(f.manager);
    }
    const realTo = [...new Set([...ALWAYS_TO, ...managerEmails])];
    const to = testTo.length ? testTo : realTo;

    const html = buildHtml(found, reportDate, prevDate, [...unknownManagers], testTo.length ? realTo : null);
    if (preview) { res.setHeader('Content-Type', 'text/html'); return res.status(200).send(html); }

    if (!process.env.ALERTS_API_KEY) throw new Error('ALERTS_API_KEY is not set');
    const counts = countByType(found);
    const subject = `${testTo.length ? '[TEST] ' : ''}Listing Alerts — ${summaryLine(counts)} · ${fmtDay(reportDate)}`;
    const attachment = Buffer.from(XLSX.write(buildWorkbook(found), { type: 'buffer', bookType: 'xlsx' })).toString('base64');
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ALERTS_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Medaltus Reports <${FROM_EMAIL}>`, reply_to: REPLY_TO, to, subject, html,
        attachments: [{ filename: `Listing Alerts_${reportDate}.xlsx`, content: attachment }],
      }),
    });
    const sendBody = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) throw new Error(`Resend ${sendRes.status}: ${JSON.stringify(sendBody).slice(0, 200)}`);

    if (!testTo.length) {
      const token = await ensureTab(sheets.products, LOG_TAB, ['report_date', 'sent_at', 'items', 'recipients', 'message_id']);
      await appendRows(sheets.products, LOG_TAB, [[reportDate, new Date().toISOString(), found.length, to.join(', '), sendBody.id || '']], token);
    }
    return res.status(200).json({ sent: true, test: !!testTo.length, to, reportDate, counts, unknownManagers: [...unknownManagers] });
  } catch (err) {
    console.error('[listing-alerts-email]', err.message);
    await sendCronFailureAlert('listing-alerts-email', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Checks ─────────────────────────────────────────────────────────────────
function checkSku(cur, before, m) {
  const out = [];

  // 1. Contributions (only fields filled in on the master list)
  for (const [, col, label] of FIELDS) {
    const want = col === 'backend_keywords' ? [m.backend, m.seasonalBackend].filter(Boolean) : [m.fields[col]].filter(Boolean);
    if (!want.length) continue;
    const mismatch = row => !row ? null : !want.some(w => sameText(w, row[col], col === 'backend_keywords'));
    if (mismatch(cur)) {
      out.push({ type: 'contribution', field: label, isNew: !(before && mismatch(before)),
        expected: want[0], live: String(cur[col] || '') || '(blank on Amazon)' });
    }
  }

  // 2. Category changes (both days must have categories)
  if (before) {
    const c1 = categories(before), c2 = categories(cur);
    if (c1 && c2 && c1 !== c2) out.push({ type: 'category', field: 'Category', isNew: true, expected: c1, live: c2 });
    const k1 = String(before.item_type_keyword || '').trim(), k2 = String(cur.item_type_keyword || '').trim();
    if (k1 && k2 && k1 !== k2) out.push({ type: 'category', field: 'Item type keyword', isNew: true, expected: k1, live: k2 });
  }

  // 3. Suppressions / errors
  const sup = row => !row ? [] : suppressionFindings(row);
  const prevKeys = new Set(sup(before).map(s => s.key));
  for (const s of sup(cur)) out.push({ type: s.kind, field: s.field, isNew: !prevKeys.has(s.key), expected: '', live: s.detail });

  // 4. Image changes (FYI)
  if (before) {
    const a = slots(before.images), b = slots(cur.images);
    if (Object.keys(a).length && Object.keys(b).length) {
      const changes = [];
      for (const v of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[v] && !b[v]) changes.push(`${v} removed`);
        else if (!a[v] && b[v]) changes.push(`${v} added`);
        else if (a[v] !== b[v]) changes.push(`${v} replaced`);
      }
      if (changes.length) out.push({ type: 'image', field: 'Images', isNew: true, expected: before.images, live: changes.join(', ') });
    }
  }
  return out;
}

function suppressionFindings(row) {
  const out = [];
  const status = String(row.status || '').toUpperCase();
  const inStock = (parseInt(row.fulfillable_quantity, 10) || 0) + (parseInt(row.seller_fulfilled_quantity, 10) || 0) > 0;
  if (status && !status.includes('DISCOVERABLE')) out.push({ kind: 'suppression', key: 'status:discoverable', field: 'Listing status', detail: `Not discoverable on Amazon (status: ${status || 'none'})` });
  else if (status && !status.includes('BUYABLE') && inStock) out.push({ kind: 'suppression', key: 'status:buyable', field: 'Listing status', detail: `Not buyable while in stock (status: ${status})` });
  for (const issue of String(row.issues || '').split(' | ').map(s => s.trim()).filter(Boolean)) {
    const tags = (issue.match(/\{([^}]*)\}\s*$/) || [, ''])[1].split(';').map(t => t.trim()).filter(Boolean);
    const suppressed = tags.some(t => SUPPRESSION_TAGS.includes(t));
    const isError = /^\[ERROR\]/i.test(issue);
    if (!suppressed && !isError) continue;
    const attrs = (issue.match(/^\[[A-Z]+\]\s*([^:]*):/) || [, ''])[1];
    const image = /image/i.test(attrs) || tags.includes('INVALID_IMAGE');
    out.push({ kind: suppressed ? 'suppression' : 'error', key: 'issue:' + issue.replace(/\s+/g, ' ').slice(0, 160),
      field: suppressed ? (image ? 'Image suppressed' : 'Suppressed') : (image ? 'Image error' : 'Listing error'), detail: issue });
  }
  return out;
}

const categories = row => {
  const names = String(row.sales_ranks || '').split(';').map(s => s.replace(/\(#[\d,]+\)/g, '').trim()).filter(Boolean);
  return names.length ? [...new Set(names)].sort().join(' · ') : '';
};
const slots = cell => Object.fromEntries(String(cell || '').split('|').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; }));

function norm(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}
function sameText(expected, live, keywords) {
  if (!keywords) return norm(expected) === norm(live);
  const words = s => [...new Set(norm(s).toLowerCase().split(/[\s,;]+/).filter(Boolean))].sort().join(' ');
  return words(expected) === words(live);
}

// ── Master list ────────────────────────────────────────────────────────────
async function loadMaster() {
  const id = process.env.SHEET_MASTER_SKU_LIST;
  if (!id) throw new Error('SHEET_MASTER_SKU_LIST env var not set');
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${MASTER_GID}`);
  if (!r.ok) throw new Error(`master SKU list CSV → ${r.status}`);
  const rows = parseCsv(await r.text());
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const col = (name, fallback) => { const i = head.indexOf(name.toLowerCase()); return i >= 0 ? i : fallback; };
  const iAsin = col('ASIN', 0), iSku = col('SKU', 1), iStatus = col('Status', 7), iMgr = col('Brand Manager', 26);
  const iBackend = col('Backend Keywords', -1), iSeasonal = col('Seasonal Backend Keywords', -1);
  const fieldIdx = Object.fromEntries(FIELDS.filter(f => f[1] !== 'backend_keywords').map(([h, c]) => [c, col(h, -1)]));
  const map = new Map();
  for (const r of rows.slice(1)) {
    const sku = String(r[iSku] || '').trim().toUpperCase();
    if (!sku) continue;
    const get = i => (i >= 0 ? String(r[i] || '').trim() : '');
    map.set(sku, {
      asin: get(iAsin), status: get(iStatus).toUpperCase(), manager: get(iMgr),
      fields: Object.fromEntries(Object.entries(fieldIdx).map(([c, i]) => [c, get(i)])),
      backend: get(iBackend), seasonalBackend: get(iSeasonal),
    });
  }
  return map;
}
function parseCsv(text) {
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

// ── Email ──────────────────────────────────────────────────────────────────
const TYPES = [
  ['suppression', 'Suppressions', '#C0392B'],
  ['error', 'Listing errors', '#D35400'],
  ['contribution', 'Contribution mismatches', '#001F60'],
  ['category', 'Category changes', '#6B4FBB'],
  ['image', 'Image changes (FYI)', '#1A7F5A'],
];
const countByType = found => Object.fromEntries(TYPES.map(([t]) => [t, { all: found.filter(f => f.type === t).length, new: found.filter(f => f.type === t && f.isNew).length }]));
const summaryLine = c => TYPES.filter(([t]) => c[t].all).map(([t, label]) => `${c[t].all} ${label.replace(' (FYI)', '').toLowerCase()}`).join(', ');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const clip = (s, n = 180) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; };

function buildHtml(found, reportDate, prevDate, unknownManagers, wouldSendTo) {
  const counts = countByType(found);
  const tiles = TYPES.filter(([t]) => counts[t].all).map(([t, label, color]) => `
    <td style="padding:0 8px 8px 0;vertical-align:top;">
      <div style="border:1px solid #e4e8ef;border-radius:10px;padding:10px 14px;min-width:110px;">
        <div style="font-size:11px;color:#6B7BA2;text-transform:uppercase;letter-spacing:.05em;font-weight:700;">${escapeHtml(label)}</div>
        <div style="font-size:26px;color:${color};font-weight:700;line-height:1.1;margin-top:2px;">${counts[t].all}</div>
        <div style="font-size:11px;color:#6B7BA2;">${counts[t].new} new</div>
      </div></td>`).join('');

  const th = 'padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#fff;background:#001F60;text-align:left;font-family:Arial,sans-serif;';
  const td = 'padding:8px 10px;font-size:12px;color:#001F60;border-bottom:1px solid #e4e8ef;font-family:Arial,sans-serif;vertical-align:top;';
  const newPill = isNew => isNew ? '<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:#24E9A3;color:#001F60;font-size:10px;font-weight:700;">NEW</span>' : '<span style="font-size:10px;color:#9ba8c0;">ongoing</span>';

  const brandsInOrder = [...new Set(found.map(f => f.brand))].sort();
  const brandSections = brandsInOrder.map(brand => {
    const items = found.filter(f => f.brand === brand);
    const mgrs = [...new Set(items.map(i => i.manager).filter(Boolean))].join(', ');
    const sections = TYPES.map(([t, label, color]) => {
      const list = items.filter(i => i.type === t).sort((a, b) => (b.isNew - a.isNew) || a.sku.localeCompare(b.sku));
      if (!list.length) return '';
      const showExpected = t === 'contribution' || t === 'category';
      const rows = list.slice(0, ROWS_PER_SECTION).map((i, n) => `<tr style="background:${n % 2 ? '#F7F8FC' : '#ffffff'};">
          <td style="${td}white-space:nowrap;">${newPill(i.isNew)}</td>
          <td style="${td}font-weight:700;white-space:nowrap;">${escapeHtml(i.sku)}<div style="font-weight:400;color:#6B7BA2;font-size:11px;">${escapeHtml(i.asin)}</div></td>
          <td style="${td}">${escapeHtml(i.field)}</td>
          ${showExpected ? `<td style="${td}">${escapeHtml(clip(i.expected))}</td>` : ''}
          <td style="${td}">${escapeHtml(clip(i.live))}</td></tr>`).join('');
      const more = list.length > ROWS_PER_SECTION ? `<div style="font-size:11px;color:#6B7BA2;margin-top:6px;">+ ${list.length - ROWS_PER_SECTION} more in the attached Excel</div>` : '';
      return `<div style="margin:14px 0 4px;font-size:13px;font-weight:700;color:${color};">${escapeHtml(label)} &middot; ${list.length}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e8ef;">
          <tr><th style="${th}"></th><th style="${th}">SKU</th><th style="${th}">What</th>${showExpected ? `<th style="${th}">${t === 'category' ? 'Before' : 'Master list (expected)'}</th>` : ''}<th style="${th}">${t === 'category' ? 'Now' : t === 'contribution' ? 'Live on Amazon' : 'Detail'}</th></tr>
          ${rows}</table>${more}`;
    }).join('');
    return `<tr><td style="padding:18px 32px 6px;">
        <div style="font-size:18px;font-weight:700;color:#001F60;font-family:Georgia,'Times New Roman',serif;border-bottom:2px solid #24E9A3;padding-bottom:4px;">${escapeHtml(brand)}
          <span style="font-size:11px;font-weight:400;color:#6B7BA2;font-family:Arial,sans-serif;">${mgrs ? '&nbsp;·&nbsp;' + escapeHtml(mgrs) : ''}</span></div>
        ${sections}
      </td></tr>`;
  }).join('');

  const notes = [
    unknownManagers.length ? `Brand Manager name(s) on the master list with no email on file (not emailed): ${unknownManagers.map(escapeHtml).join(', ')}.` : '',
    wouldSendTo ? `TEST SEND — the real email would go to: ${wouldSendTo.map(escapeHtml).join(', ')}.` : '',
  ].filter(Boolean).map(n => `<div style="font-size:11px;color:#9ba8c0;margin-top:4px;">${n}</div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:32px 0;">
    <tr><td align="center">
      <table width="760" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#001F60;padding:24px 32px;">
            <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#24E9A3;font-weight:700;">NewDerm &middot; Amazon Listings</div>
            <div style="font-size:24px;color:#ffffff;font-weight:700;margin-top:6px;font-family:Georgia,'Times New Roman',serif;">Listing Alerts</div>
            <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px;">${escapeHtml(fmtDay(reportDate))} &middot; compared with the master SKU list and ${escapeHtml(fmtDay(prevDate))}</div>
          </td>
        </tr>
        <tr><td style="padding:22px 32px 4px;"><table cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table></td></tr>
        ${brandSections}
        <tr><td style="padding:14px 32px 24px;">
          <div style="font-size:12px;color:#6B7BA2;">The full list, every brand and every item, is attached as an Excel file.</div>
          ${notes}
        </td></tr>
        <tr>
          <td style="background:#001F60;padding:16px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding-bottom:12px;"><img src="${LOGO_URL}" alt="Medaltus" height="22" style="height:22px;display:block;"></td></tr>
              <tr><td><span style="font-size:11px;color:#6B7BA2;">Medaltus automated report &middot; reports@medaltus.com</span></td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildWorkbook(found) {
  const wb = XLSX.utils.book_new();
  for (const [t, label] of TYPES) {
    const list = found.filter(f => f.type === t);
    if (!list.length) continue;
    const ws = XLSX.utils.aoa_to_sheet([
      ['Brand', 'SKU', 'ASIN', 'Brand Manager', 'New?', 'What', t === 'category' ? 'Before' : 'Master list (expected)', t === 'category' ? 'Now' : 'Live / detail'],
      ...list.map(i => [i.brand, i.sku, i.asin, i.manager || '', i.isNew ? 'NEW' : 'ongoing', i.field, i.expected || '', i.live || '']),
    ]);
    ws['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 13 }, { wch: 18 }, { wch: 8 }, { wch: 20 }, { wch: 70 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws, label.replace(/[()]/g, '').slice(0, 31));
  }
  return wb;
}

// ── Dates ──────────────────────────────────────────────────────────────────
function todayEt() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fmtDay(iso) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
