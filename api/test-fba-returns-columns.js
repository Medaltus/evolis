/**
 * api/test-fba-returns-columns.js
 * ONE-OFF diagnostic — directly checks GET_FBA_FULFILLMENT_CUSTOMER_
 * RETURNS_DATA's real, current column list against fresh data, rather
 * than continuing to trust a comment in sync-revenue-process.js /
 * sync-returns-process.js (dated 2026-08-05, predating this entire
 * session) claiming this report has no dollar/refund field at all.
 *
 * WHY THIS IS WORTH RE-CHECKING NOW: that claim has never been directly
 * re-verified in this project — it's been repeated and built on top of,
 * not confirmed. Given how many other long-standing assumptions turned
 * out wrong once actually checked this session (Vine cost calculations,
 * guessed campaign names, an assumed FBA/FBM returns overlap that turned
 * out not to exist), and given Amazon does periodically add fields to
 * existing reports over time, this is worth a direct, fresh look rather
 * than continuing to propagate an old comment.
 *
 * Reuses the exact same report type sync-returns-request.js already
 * requests successfully — this isn't testing a new report, just looking
 * at its real current header row directly instead of through the lens
 * of the existing hardcoded column mapping.
 *
 * Writes nothing anywhere.
 *
 * Usage — two-step, same as every other reporting-API diagnostic:
 *   Step 1:
 *     GET /api/test-fba-returns-columns?step=request
 *     Authorization: Bearer <CRON_SECRET>
 *
 *   Step 2, a few minutes later:
 *     GET /api/test-fba-returns-columns?step=check&reportId=...
 *     Authorization: Bearer <CRON_SECRET>
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
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z';

      const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
        reportType:     'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
        marketplaceIds: [process.env.SP_MARKETPLACE_ID],
        dataStartTime:  start,
        dataEndTime:    safeBefore,
      });

      if (!createResp?.reportId) {
        return res.status(500).json({ error: 'No reportId in response', detail: createResp });
      }

      return res.status(200).json({
        reportId: createResp.reportId,
        note: 'Wait a few minutes, then ?step=check&reportId=... to see the real current column list.',
      });
    }

    // step === 'check'
    const { reportId } = req.query;
    if (!reportId) return res.status(400).json({ error: 'Provide ?reportId=...' });

    const statusResp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
    if (statusResp.processingStatus !== 'DONE') {
      return res.status(200).json({
        status: statusResp.processingStatus,
        note: 'Not ready yet — try ?step=check again shortly.',
      });
    }

    const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${statusResp.reportDocumentId}`);
    const text = await downloadText(docResp.url, docResp.compressionAlgorithm);

    const lines = text.trim().split('\n');
    const headerLine = lines[0] || '';
    const columns = headerLine.split('\t');
    const dollarLikeColumns = columns.filter(c =>
      /amount|refund|price|reimburse|value|cost|payment/i.test(c)
    );

    return res.status(200).json({
      status: 'DONE',
      totalRows: lines.length - 1,
      realColumnNames: columns,
      dollarLikeColumnsFound: dollarLikeColumns,
      sampleRow: lines[1] ? Object.fromEntries(columns.map((c, i) => [c, (lines[1].split('\t')[i] || '').trim()])) : null,
      note: dollarLikeColumns.length > 0
        ? 'Found column name(s) that look money-related — check sampleRow to see if they actually carry real values or are blank/always-zero.'
        : 'No column name looks money-related at all — this directly confirms the report genuinely has no dollar field, rather than continuing to assume it from an old comment.',
    });
  } catch (err) {
    console.error('[test-fba-returns-columns] fatal:', err.message);
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
