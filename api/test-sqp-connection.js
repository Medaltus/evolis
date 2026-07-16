/**
 * api/test-sqp-connection.js
 * Standalone diagnostic — same purpose as test-ad-connection.js /
 * test-walmart.js: isolate the raw SP-API interaction from _meta tracking
 * and sheet writes entirely, so we can see exactly what Amazon returns at
 * every step before trusting any assumed field names in the real cron.
 *
 * Requests a FRESH report every time it's called (no _meta skip logic —
 * that's deliberate, this is a throwaway diagnostic, not the production
 * path), polls for up to 2 minutes, and returns EVERY raw response body
 * (create, each poll, and either the parsed data or the FATAL error
 * document) as one JSON blob for direct inspection.
 *
 * GET /api/test-sqp-connection
 * Authorization: Bearer <CRON_SECRET>
 *
 * Optional: ?month=YYYY-MM to target a specific month instead of last full month
 * Optional: ?rawOnly=true to skip TSV parsing and just return raw text
 */

const zlib          = require('zlib');
const { spRequest } = require('./_spauth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const pad = n => String(n).padStart(2, '0');
  const trace = []; // every raw step, in order, for direct inspection

  // ── Target month ─────────────────────────────────────────────────────────
  let dataStartTime, dataEndTime, targetMonth;
  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    const [y, m] = req.query.month.split('-');
    const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
    targetMonth = req.query.month;
    dataStartTime = `${req.query.month}-01T00:00:00Z`;
    dataEndTime   = `${req.query.month}-${pad(lastDay)}T23:59:59Z`;
  } else {
    const now = new Date();
    const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const pYear = prior.getFullYear();
    const pMonth = pad(prior.getMonth() + 1);
    const pLastDay = new Date(pYear, prior.getMonth() + 1, 0).getDate();
    targetMonth = `${pYear}-${pMonth}`;
    dataStartTime = `${pYear}-${pMonth}-01T00:00:00Z`;
    dataEndTime   = `${pYear}-${pMonth}-${pad(pLastDay)}T23:59:59Z`;
  }

  // ── Step 1: request ──────────────────────────────────────────────────────
  // Amazon's own error (confirmed via a prior FATAL run's error document):
  // "This report type requires the report option(s): asin." Accept a quick
  // ?asins= query param here for testing — the real cron pulls this from
  // sheets.products instead of a hardcoded/manual list.
  const asinList = (req.query.asins || '').split(/[,\s]+/).filter(Boolean);
  if (!asinList.length) {
    return res.status(400).json({ error: 'This report requires ASINs. Pass ?asins=B0XXXXXXXX,B0YYYYYYYY (comma or space separated) to test.' });
  }

  let reportId;
  try {
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
      dataStartTime,
      dataEndTime,
      reportOptions: { reportPeriod: 'MONTH', asin: asinList.join(' ') },
    });
    trace.push({ step: 'create', request: { dataStartTime, dataEndTime, marketplaceIds: [process.env.SP_MARKETPLACE_ID], asin: asinList.join(' ') }, response: createResp });
    reportId = createResp?.reportId;
    if (!reportId) {
      return res.status(200).json({ ok: false, stoppedAt: 'create', reason: 'no reportId in create response', trace });
    }
  } catch (err) {
    trace.push({ step: 'create', error: err.message });
    return res.status(500).json({ ok: false, stoppedAt: 'create', trace });
  }

  // ── Step 2: poll (every raw response captured, not just the final one) ──
  let finalStatusBody = null;
  const deadline = Date.now() + 120_000; // 2 min — generous for a first diagnostic run
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      trace.push({ step: 'poll', response: statusResp });
      finalStatusBody = statusResp;
      if (statusResp.processingStatus === 'DONE' || statusResp.processingStatus === 'FATAL' || statusResp.processingStatus === 'CANCELLED') {
        break;
      }
    } catch (err) {
      trace.push({ step: 'poll', error: err.message });
    }
  }

  if (!finalStatusBody) {
    return res.status(200).json({ ok: false, stoppedAt: 'poll', reason: 'never got a status response', targetMonth, reportId, trace });
  }

  // ── Step 3: download whatever document exists, regardless of status ─────
  // (FATAL sometimes still carries a reportDocumentId pointing at an
  // error-detail document, not the data report — worth reading either way.)
  let documentContent = null;
  if (finalStatusBody.reportDocumentId) {
    try {
      const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${finalStatusBody.reportDocumentId}`);
      trace.push({ step: 'document-lookup', response: docResp });

      const fileResp = await fetch(docResp.url);
      if (fileResp.ok) {
        const buffer = Buffer.from(await fileResp.arrayBuffer());
        documentContent = await new Promise((resolve) => {
          zlib.gunzip(buffer, (err, result) => {
            if (err) resolve(buffer.toString('utf8'));
            else resolve(result.toString('utf8'));
          });
        });
      } else {
        trace.push({ step: 'document-download', error: `HTTP ${fileResp.status}` });
      }
    } catch (err) {
      trace.push({ step: 'document-download', error: err.message });
    }
  }

  const rawOnly = req.query.rawOnly === 'true';
  let parsedPreview = null;
  if (documentContent && !rawOnly && finalStatusBody.processingStatus === 'DONE') {
    const lines = documentContent.trim().split('\n').filter(Boolean);
    parsedPreview = {
      columnHeaders: lines[0] ? lines[0].split('\t') : [],
      rowCount: Math.max(0, lines.length - 1),
      firstDataRow: lines[1] ? lines[1].split('\t') : null,
    };
  }

  res.status(200).json({
    ok: finalStatusBody.processingStatus === 'DONE',
    targetMonth,
    reportId,
    finalStatus: finalStatusBody.processingStatus,
    documentContentRaw: rawOnly ? documentContent : (documentContent ? documentContent.slice(0, 3000) : null),
    parsedPreview,
    trace, // full step-by-step raw responses — this is the important part
  });
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
