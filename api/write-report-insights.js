/**
 * api/write-report-insights.js
 * POST /api/write-report-insights
 *
 * Backend for the internal dashboard's editable report content (Executive
 * Summary, Amazon/Website/Walmart Key Insights, Opportunity cards, and the
 * per-event summaries on the Events page). Reads/writes SHEET_REPORT_INSIGHTS,
 * one pair of tabs per brand:
 *   {brand}         — one row per month.  Exec Summary, 3 Key Insights,
 *                     4 Opportunity card slots, plus status/approval.
 *   {brand}_events  — one row per (event_name, event_year). Per-event
 *                     summary title/body, plus its own status/approval.
 *
 * Per Jaclyn 2026-07-17/18:
 * - No staging/live workflow on individual content blocks — just Edit, add
 *   content, Save. The only approval gate is a single "Approved & Ready"
 *   button per scope (once on the Sales Overview tab for the monthly row,
 *   once per event tab for that event's row).
 * - Multiple months/events can sit at status=Approved simultaneously — the
 *   (not-yet-built) external dashboard is responsible for picking the most
 *   recent Approved row for whatever it's displaying.
 * - This endpoint UPSERTS — every save reads the existing rows for that
 *   brand tab, finds the matching key (year+month, or event_name+event_year),
 *   merges in only the fields provided, and writes the full set back. It
 *   does NOT blind-append, since the same month/event gets edited repeatedly
 *   before it's ever approved.
 * - ASSUMPTION (flag if wrong): saving any field via action:'save' resets
 *   status back to 'Draft', even if that row was previously Approved. This
 *   is deliberate — an edit after approval shouldn't silently stay live
 *   without a fresh review. Only action:'approve' sets status to 'Approved'.
 *
 * POST body:
 *   Monthly: { brand, scope:'monthly', year, month, fields:{...}, action:'save'|'approve' }
 *   Event:   { brand, scope:'event', eventName, eventYear, fields:{...}, action:'save'|'approve' }
 *   fields is optional on action:'approve' (approving doesn't require new content).
 */

const { ensureTab, readRows, replaceRows } = require('./config/_sheets_client');
const sheets = require('./config/sheets');
const brands = require('./config/brands');

const MONTHLY_HEADERS = [
  'year', 'month',
  'exec_summary_title', 'exec_summary_left', 'exec_summary_right',
  'amazon_key_insight', 'website_key_insight', 'walmart_key_insight',
  'opp1_title', 'opp1_subtitle', 'opp1_body',
  'opp2_title', 'opp2_subtitle', 'opp2_body',
  'opp3_title', 'opp3_subtitle', 'opp3_body',
  'opp4_title', 'opp4_subtitle', 'opp4_body',
  'status', 'approved_by', 'approved_at', 'last_updated', 'last_updated_by',
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
      if (!year || !month) return res.status(400).json({ error: 'year and month are required for scope=monthly' });
      const result = await upsertRow({
        tabName: brand.tabName,
        headers: MONTHLY_HEADERS,
        matchFields: { year: String(year), month: String(month) },
        fields, action, actor,
      });
      return res.status(200).json({ ok: true, row: result });
    } else {
      if (!eventName || !eventYear) return res.status(400).json({ error: 'eventName and eventYear are required for scope=event' });
      const result = await upsertRow({
        tabName: `${brand.tabName}_events`,
        headers: EVENT_HEADERS,
        matchFields: { event_name: String(eventName), event_year: String(eventYear) },
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
    // Any content save reverts an already-approved row to Draft — see the
    // ASSUMPTION note in the file header. Approving is a separate, explicit action.
    row.status = row.status === 'Approved' ? 'Draft' : (row.status || 'Draft');
  }
  row.last_updated = nowIso;
  row.last_updated_by = actor || '';

  const updatedRows = idx === -1 ? [...existing, row] : existing.map((r, i) => (i === idx ? row : r));
  const rowArrays = updatedRows.map(r => headers.map(h => r[h] ?? ''));
  await replaceRows(sheets.reportInsights, tabName, headers, rowArrays, token);
  return row;
}
