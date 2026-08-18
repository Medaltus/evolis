/**
 * api/test-fbm-returns.js
 * ONE-OFF diagnostic — requests GET_XML_RETURNS_DATA_BY_RETURN_DATE (per
 * Amazon's own report-type reference, this sits in the general "Returns
 * Reports" category, separate from "Fulfillment By Amazon (FBA) Reports"
 * where the already-in-use GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA
 * lives — a real signal this is the right report for merchant-fulfilled
 * (FBM) returns, but NOT yet confirmed against real data) and returns the
 * RAW XML so we can see its actual structure before writing any real
 * ingestion logic.
 *
 * TWO THINGS DELIBERATELY NOT ASSUMED HERE, both need real data to answer:
 *   1. This report's name has "XML" in it, unlike every other report this
 *      codebase parses (all TSV/flat-file or JSON so far) — genuinely new
 *      parsing territory, not something to guess the schema of.
 *   2. Whether this report includes FBA returns mixed in alongside FBM
 *      ones, or is cleanly FBM-only — if mixed, real ingestion would need
 *      to filter to avoid double-counting against the existing FBA
 *      returns cron (sync-returns-request.js / sync-returns-process.js).
 *
 * Writes nothing anywhere. Returns raw XML text (truncated to a safe
 * preview length) plus a naive tag-name extraction as a rough guide —
 * NOT a real parse, just enough to see what elements actually exist.
 *
 * Usage — two-step, since this is an async SP-API report like every
 * other one in this codebase:
 *   Step 1 — request the report for a short recent window:
 *     GET /api/test-fbm-returns?step=request
 *     Authorization: Bearer <CRON_SECRET>
 *     → returns { reportId }
 *
 *   Step 2 — wait a few minutes, then check status and see the raw XML:
 *     GET /api/test-fbm-returns?step=check&reportId=...
 *     Authorization: Bearer <CRON_SECRET>
 *     → returns { status, rawXmlPreview, distinctTagNames }
 */

const { spRequest } = require('./_spauth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const step = req.query.step;
  if (step !== 'request' && step !== 'check') {
    return res.status(400).json({ error: 'Required: ?step=request or ?step=check' });
  }

  try {
    if (step === 'request') {
      const now = new Date();
      const safeBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
      // Short, recent window — this diagnostic just needs to see the
      // shape of the data, not a full real sync range. Report supports
      // up to 60 days per Amazon's own docs; 14 is plenty here.
      const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_XML_RETURNS_DATA_BY_RETURN_DATE',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  start,
        dataEndTime:    safeBefore,
      });

      if (!createResp?.reportId) {
        return res.status(500).json({ error: 'No reportId in response', detail: createResp });
      }

      return res.status(200).json({
        reportId: createResp.reportId,
        start, end: safeBefore,
        note: 'Wait a few minutes, then call ?step=check&reportId=... to see the real XML structure.',
      });
    }

    // step === 'check'
    const { reportId } = req.query;
    if (!reportId) return res.status(400).json({ error: 'Provide ?reportId=...' });

    const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
    if (statusResp.processingStatus !== 'DONE') {
      return res.status(200).json({
        status: statusResp.processingStatus,
        note: statusResp.processingStatus === 'FATAL' || statusResp.processingStatus === 'CANCELLED'
          ? 'Report failed — check the raw response below for why.'
          : 'Not ready yet — try ?step=check again shortly.',
        raw: statusResp,
      });
    }

    const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${statusResp.reportDocumentId}`);
    const xmlText = await downloadText(docResp.url, docResp.compressionAlgorithm);

    // Rough, non-authoritative tag-name scan — just to see what elements
    // exist before writing a real parser against confirmed structure.
    const tagMatches = xmlText.match(/<([a-zA-Z][\w-]*)[ >]/g) || [];
    const distinctTagNames = [...new Set(tagMatches.map(t => t.replace(/[<> ]/g, '')))].sort();

    // ADDED 2026-08-18 — a single 4000-char preview only ever showed 2
    // sample records, not enough to confidently check for FBA/FBM overlap
    // against the existing FBA returns sheet (per Jaclyn, only 2 known
    // order IDs weren't enough to conclude either way, especially since
    // the FBA sheet only tracks partnered brands, not the whole seller
    // account). This does a rough, regex-based split of every
    // <return_details>...</return_details> block (NOT a real XML parse —
    // still just enough to extract a handful of full candidate records,
    // same "look before building the real parser" spirit as the preview
    // above) and surfaces every one whose merchant_sku matches a known
    // active brand prefix, so there's more than 2 order IDs to check.
    const brands = require('./config/brands');
    const activeBrandPrefixes = brands.filter(b => b.active).map(b => b.skuPrefix.toUpperCase());

    const returnBlocks = xmlText.match(/<return_details>[\s\S]*?<\/return_details>/g) || [];
    const candidates = [];
    for (const block of returnBlocks) {
      const skuMatch    = block.match(/<merchant_sku>(.*?)<\/merchant_sku>/);
      const orderMatch  = block.match(/<order_id>(.*?)<\/order_id>/);
      const refundMatch = block.match(/<refund_amount>(.*?)<\/refund_amount>/);
      const dateMatch   = block.match(/<return_request_date>(.*?)<\/return_request_date>/);
      if (!skuMatch || !orderMatch) continue;
      const sku = skuMatch[1].toUpperCase();
      const matchedPrefix = activeBrandPrefixes.find(p => sku.startsWith(p));
      if (matchedPrefix) {
        candidates.push({
          orderId: orderMatch[1],
          sku,
          matchedBrandPrefix: matchedPrefix,
          refundAmount: refundMatch ? refundMatch[1] : null,
          returnRequestDate: dateMatch ? dateMatch[1] : null,
        });
      }
    }

    return res.status(200).json({
      status: 'DONE',
      byteLength: xmlText.length,
      totalReturnRecordsInReport: returnBlocks.length,
      distinctTagNames,
      trackedBrandCandidates: candidates,
      note: `Found ${candidates.length} return record(s) matching a tracked brand's SKU prefix out of ${returnBlocks.length} total records in this report (most records are likely for brands you don't track at all — expected, given this covers the whole seller account). Check each orderId in trackedBrandCandidates against the existing FBA returns sheet — if ANY of these already exist there, this report includes FBA returns and overlaps with the existing cron; if NONE do, it's cleanly FBM-only.`,
    });
  } catch (err) {
    console.error('[test-fbm-returns] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function downloadText(url, compressionAlgorithm) {
  return new Promise((resolve, reject) => {
    require('https').get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (compressionAlgorithm === 'GZIP') {
          require('zlib').gunzip(buf, (err, decoded) => {
            if (err) return reject(err);
            resolve(decoded.toString('utf8'));
          });
        } else {
          resolve(buf.toString('utf8'));
        }
      });
    }).on('error', reject);
  });
}
