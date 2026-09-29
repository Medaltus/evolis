// api/render-pdf.js
//
// Ported 2026-09-28 per Jaclyn from the VBC/Dazzle Dry reference spec
// ("Real-text PDF output"). CommonJS, per spec. Prints the client-sent
// #pdfx-root HTML with headless Chrome so text/KPIs/tables come back as
// real vector text instead of a screenshot — this is what fixes the
// RangeError crash from the html2canvas/PNG approach (that was a hard
// JS string-length ceiling, not a quality tradeoff) and cuts file size
// dramatically (VBC: 155MB screenshot PDF -> 2.58MB real-text PDF).
//
// Deploy requirements (cannot be done from here — must happen in the
// real repo/Vercel project):
//   package.json:  "@sparticuz/chromium": "153.0.0", "puppeteer-core": "25.11.0"
//     (pin exactly — these two versions must match each other)
//   vercel.json entry for this function:
//     "api/render-pdf.js": { "maxDuration": 60, "memory": 2048, "includeFiles": "node_modules/@sparticuz/chromium/bin/**" }
//     (without includeFiles, Vercel does not bundle the Chromium binary)
//
// Deploy check (required after every deploy, per spec): open
// /api/render-pdf directly in a browser tab (GET). It should self-test
// (start Chromium, print a test page) and return {"ok": true}. If it
// doesn't, the client-side JPEG fallback still works — exports won't
// hard-fail either way — but real-text output won't be active until
// this passes.

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const MAX_BODY_BYTES = 4.2 * 1024 * 1024; // 4.2MB gzipped payload ceiling, per spec
const MAX_PDF_BYTES = 4.4 * 1024 * 1024;  // over this, return 413 so the client falls back

// Only these origins may be reached from inside the rendered page — the
// Chrome instance has no reason to load anything else, and blocking
// everything else is a real security boundary, not just cleanliness.
const ALLOWED_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'lh3.googleusercontent.com',
];

let _browserPromise = null; // reused across warm invocations, per spec

async function getBrowser() {
  if (_browserPromise) return _browserPromise;
  _browserPromise = (async () => {
    const executablePath = await chromium.executablePath();
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });
  })();
  return _browserPromise;
}

// Blocks every request that isn't a data: URI, this deployment's own
// host, or one of ALLOWED_HOSTS above. Applied per-page in renderHtmlToPdf.
async function lockDownRequests(page, ownHost) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    try {
      const url = req.url();
      if (url.startsWith('data:')) return req.continue().catch(() => {});
      const host = new URL(url).host;
      if (host === ownHost || ALLOWED_HOSTS.includes(host)) return req.continue().catch(() => {});
      return req.abort().catch(() => {});
    } catch (e) {
      // Any URL-parsing failure or racing-navigation error: fail closed.
      req.abort().catch(() => {});
    }
  });
}

async function renderHtmlToPdf(html, ownHost) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await lockDownRequests(page, ownHost);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    // Let web fonts actually finish loading before printing — otherwise
    // headless Chrome can print a first paint with fallback fonts still
    // showing, before the real ones swap in.
    await page.evaluateHandle('document.fonts.ready').catch(() => {});
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
    });
    return pdfBuffer;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = async (req, res) => {
  // GET = deploy self-test (per spec): starts Chromium, prints a test
  // page, confirms the whole pipeline actually works post-deploy.
  if (req.method === 'GET') {
    try {
      const testHtml = '<html><body><h1 style="font-family:sans-serif;">render-pdf self-test</h1><p>If you can read this as a real PDF page, Chromium + Puppeteer are working.</p></body></html>';
      const buf = await renderHtmlToPdf(testHtml, req.headers.host || '');
      return res.status(200).json({ ok: true, testPdfBytes: buf.length });
    } catch (err) {
      console.error('[api/render-pdf] self-test failed', err);
      return res.status(200).json({ ok: false, error: err.message || String(err) });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const bodyStr = JSON.stringify(req.body || {});
    if (Buffer.byteLength(bodyStr, 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    const { html } = req.body || {};
    if (!html || typeof html !== 'string') {
      return res.status(400).json({ error: 'html (string) is required' });
    }

    const pdfBuffer = await renderHtmlToPdf(html, req.headers.host || '');

    if (pdfBuffer.length > MAX_PDF_BYTES) {
      // Per spec: this is what triggers the client-side screenshot
      // fallback — not a hard failure of the export as a whole.
      return res.status(413).json({ error: 'Rendered PDF exceeds size limit', bytes: pdfBuffer.length });
    }

    res.setHeader('Content-Type', 'application/pdf');
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    // Every failure path returns readable JSON rather than letting
    // Vercel surface its own FUNCTION_INVOCATION_FAILED — per spec, this
    // was the actual first-deploy bug (packages must load inside the
    // handler, and every page.close()/request continue-or-abort needs
    // its own .catch, both already true above).
    console.error('[api/render-pdf]', err);
    return res.status(500).json({ error: err.message || 'Render failed' });
  }
};
