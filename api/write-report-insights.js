/**
 * api/write-report-insights.js — évolis
 * POST /api/write-report-insights
 *
 * Backend for the dashboard's editable report content (Executive Summary,
 * Amazon/Website/Walmart Key Insights, Ad Impressions Note, Category Key
 * Insight, What's Been Accomplished cards + images, Future Opportunity
 * cards, and the per-event summaries on the Events pages).
 *   - UPSERTS, never blind-appends: reads existing rows, finds the matching
 *     key, merges in only the fields provided, writes the full set back.
 *   - Any content save reverts an Approved row to Draft; only
 *     action:'approve' sets Approved.
 *
 * Reads/writes the shared "Report Insights" spreadsheet: the brand's
 * monthly tab (brand.tabName) and its events tab (brand.tabName + '_events').
 *
 * PORTED 2026-10-06 from Just Bjorn's fixed version. MONTHLY_HEADERS matches
 * the evolis tab's real header row exactly (58 columns, per Jaclyn).
 * replaceRows() writes POSITIONALLY against this array, so any mismatch in
 * order or count puts data in the wrong cells, and any field name not in
 * this array is silently dropped on save. A new field ALWAYS goes at the
 * end of this array AND the end of the sheet's header row at the same time.
 *
 * POST body:
 *   Monthly: { brand, scope:'monthly', year, month, fields:{...}, action:'save'|'approve', actor }
 *   Event:   { brand, scope:'event', eventName, eventYear, fields:{...}, action:'save'|'approve', actor }
 */

const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const sheets = require('./config/sheets');
const brands = require('./config/brands');

const MONTHLY_HEADERS = [
  // Exact column order of the evolis tab's header row (58 columns).
  'year', 'month', 'exec_summary_title', 'exec_summary_left', 'exec_summary_right',
  'amazon_key_insight', 'website_key_insight', 'walmart_key_insight', 'opp1_title',
  'opp1_subtitle', 'opp1_body', 'opp2_title', 'opp2_subtitle', 'opp2_body',
  'opp3_title', 'opp3_subtitle', 'opp3_body', 'opp4_title', 'opp4_subtitle',
  'opp4_body', 'status', 'approved_by', 'approved_at', 'last_updated',
  'last_updated_by', 'ad_impressions_note', 'category_key_insight', 'accomplished1_title',
  'accomplished1_subtitle', 'accomplished1_body', 'accomplished1_image1',
  'accomplished1_image2', 'accomplished1_image3', 'accomplished2_title',
  'accomplished2_subtitle', 'accomplished2_body', 'accomplished2_image1',
  'accomplished2_image2', 'accomplished3_title', 'accomplished3_subtitle',
  'accomplished3_body', 'accomplished4_title', 'accomplished4_subtitle',
  'accomplished4_body', 'opp5_title', 'opp5_subtitle', 'opp5_body', 'opp6_title',
  'opp6_subtitle', 'opp6_body', 'accomplished1_image4', 'accomplished1_image5',
  'accomplished1_image6', 'accomplished2_image3', 'accomplished2_image4',
  'accomplished2_image5', 'accomplished2_image6', 'subscriptions_key_insight',
];

const EVENT_HEADERS = [
  'event_name', 'event_year',
  'summary_title', 'summary_body',
  'status', 'approved_by', 'approved_at', 'last_updated', 'last_updated_by',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand: brandId, scope, year, month, eventName, eventYear, fields, action, actor } = req.body || {};

  const brand = brands.find(b => b.id === brandId && b.active);
  if (!brand) return res.status(400).json({ error: `Brand '${brandId}' not found or not active` });

  if (scope !== 'monthly' && scope !== 'event') {
    return res.status(400).json({ error: "scope must be 'monthly' or 'event'" });
  }
  if (action !== 'save' && action !== 'approve') {
    return res.status(400).json({ error: "action must be 'save' or 'approve'" });
  }

  try {
    if (scope === 'monthly') {
      const yearStr = String(year ?? '').trim();
      const monthStr = String(month ?? '').trim();
      if (!yearStr || !monthStr) return res.status(400).json({ error: 'year and month are required for scope=monthly' });
      // Extra sanity check: month should be a real 1-12 value. Catches
      // anything that survived the trim (e.g. a non-numeric string)
      // before it gets written to the sheet, rather than silently
      // upserting a row keyed on garbage.
      const monthNum = Number(monthStr);
      if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
        return res.status(400).json({ error: `month must be an integer 1-12, got '${month}'` });
      }
      const result = await upsertRow({
        tabName: brand.tabName,
        headers: MONTHLY_HEADERS,
        matchFields: { year: yearStr, month: monthStr },
        fields, action, actor,
      });
      return res.status(200).json({ ok: true, row: result });
    } else {
      const eventNameStr = String(eventName ?? '').trim();
      const eventYearStr = String(eventYear ?? '').trim();
      if (!eventNameStr || !eventYearStr) return res.status(400).json({ error: 'eventName and eventYear are required for scope=event' });
      const result = await upsertRow({
        tabName: `${brand.tabName}_events`,
        headers: EVENT_HEADERS,
        matchFields: { event_name: eventNameStr, event_year: eventYearStr },
        fields, action, actor,
      });
      return res.status(200).json({ ok: true, row: result });
    }
  } catch (err) {
    console.error('[write-report-insights] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function upsertRow({ tabName, headers, matchFields, fields, action, actor }) {
  const token = await ensureTab(sheets.reportInsights, tabName, headers);
  const existing = await readRows(sheets.reportInsights, tabName);

  const matchKeys = Object.keys(matchFields);
  const idx = existing.findIndex(r => matchKeys.every(k => String(r[k] || '') === matchFields[k]));

  let row;
  if (idx === -1) {
    row = {};
    headers.forEach(h => { row[h] = ''; });
    Object.assign(row, matchFields);
  } else {
    row = { ...existing[idx] }; // copy — don't mutate the object still sitting in `existing`
  }

  if (fields) {
    Object.entries(fields).forEach(([k, v]) => {
      if (headers.includes(k)) row[k] = v == null ? '' : String(v);
    });
  }

  const nowIso = new Date().toISOString();
  if (action === 'approve') {
    row.status = 'Approved';
    row.approved_by = actor || '';
    row.approved_at = nowIso;
  } else {
    // Any content save reverts an already-approved row to Draft — see
    // the ASSUMPTION note in the file header. Approving is a separate,
    // explicit action.
    row.status = row.status === 'Approved' ? 'Draft' : (row.status || 'Draft');
  }
  row.last_updated = nowIso;
  row.last_updated_by = actor || '';

  const updatedRows = idx === -1 ? [...existing, row] : existing.map((r, i) => (i === idx ? row : r));
  const rowArrays = updatedRows.map(r => headers.map(h => r[h] ?? ''));
  await replaceRows(sheets.reportInsights, tabName, headers, rowArrays, token);
  return row;
}
