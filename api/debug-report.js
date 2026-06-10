/**
 * api/debug-report.js
 * Fetches the flat file orders report and shows the first 3 rows
 * so we can confirm the exact column names.
 * DELETE after debugging.
 */

const { spRequest } = require('./_spauth');
const https = require('https');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const year  = parseInt(req.query.year  || 2026);
    const month = parseInt(req.query.month || 5);
    const pad   = n => String(n).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();

    const start = `${year}-${pad(month)}-01T00:00:00Z`;
    const end   = `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z`;

    // Request report
    const createResp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      dataStartTime:  start,
      dataEndTime:    end,
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
    });

    const reportId = createResp.reportId;
    if (!reportId) return res.status(500).json({ error: 'No reportId', resp: createResp });

    console.log(`[debug-report] created: ${reportId}`);

    // Poll
    const deadline = Date.now() + 270_000;
    let meta;
    while (Date.now() < deadline) {
      const poll = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
      console.log(`[debug-report] status: ${poll.processingStatus}`);
      if (poll.processingStatus === 'DONE') { meta = poll; break; }
      if (['FATAL','CANCELLED'].includes(poll.processingStatus)) {
        return res.status(500).json({ error: `Report ${poll.processingStatus}` });
      }
      await sleep(8000);
    }
    if (!meta) return res.status(500).json({ error: 'Timed out' });

    // Download
    const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${meta.reportDocumentId}`);
    const text    = await downloadText(docResp.url);

    // Parse just headers + first 3 data rows
    const lines   = text.trim().split('\n');
    const headers = lines[0].split('\t').map(h => h.trim());
    const sample  = lines.slice(1, 4).map(line => {
      const cols = line.split('\t');
      return Object.fromEntries(headers.map((h, i) => [h, (cols[i] || '').trim()]));
    });

    res.status(200).json({
      reportId,
      totalLines: lines.length - 1,
      headers,     // <-- this is what we need to see
      sample,      // first 3 rows as objects
    });

  } catch (err) {
    console.error('[debug-report]', err);
    res.status(500).json({ error: err.message });
  }
};


function downloadText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Check for gzip magic bytes
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
