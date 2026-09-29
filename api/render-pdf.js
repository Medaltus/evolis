// api/render-pdf.js
//
// Turns the dashboard's own PDF pages (#pdfx-root, serialized client-side
// by pdfxBuildRenderDocument in index.html) into a REAL PDF with
// headless Chrome — text, KPIs and tables come out as selectable vector
// text instead of screenshots, and the file is a normal, emailable size.
// Chart images are the same PNGs the dashboard already captured.
//
// PORTED 2026-09-29 per Jaclyn — replaced verbatim with the real,
// working VBC/Dazzle Dry reference file (the canonical one, confirmed
// working there), rather than my own earlier version. My own version
// diverged in two ways that likely explain why server-side rendering
// had been silently failing on every single export since I first wrote
// it: (1) it used top-level, eager require() for @sparticuz/chromium and
// puppeteer-core — this file's own comment below explains exactly why
// that's wrong (a packaging/loading failure crashes the whole function
// with Vercel's opaque, undiagnosable error, on every request); (2) it
// expected a JSON body ({html: "..."}), not this file's real contract
// (raw, optionally gzipped HTML as application/octet-stream) — the
// client-side pdfxRenderViaServer/pdfxBuildRenderDocument have been
// updated to match this real contract, not the other way around.
//
// CANONICAL — port this file verbatim to every Medaltus dashboard repo
// (see the PDF Export build notes' "Read this first" section). Only the
// dashboard HTML differs per brand; this endpoint never does.
//
// Request:  POST, Content-Type: application/octet-stream, body = the full
//           HTML document (gzipped when header X-Pdfx-Encoding: gzip).
// Response: application/pdf on success; JSON {error} otherwise. Any
//           non-200 makes the dashboard fall back to its screenshot PDF,
//           so an export never simply fails.
//
// Security: the page may only load data: URIs, this deployment's own
// origin (the Plantin font file), Google Fonts, and Drive-hosted images
// (lh3.googleusercontent.com, used by Accomplished-card uploads). Every
// other network request is blocked.
//
// Needs in vercel.json: maxDuration 60, memory 2048, and includeFiles for
// @sparticuz/chromium's bin folder (Vercel's file tracing does not pick
// up the compressed Chromium binary on its own).

const zlib = require('zlib');

// Loaded lazily INSIDE the handler (not at the top of the file) so that a
// packaging/loading problem comes back as a readable JSON error instead of
// Vercel's opaque FUNCTION_INVOCATION_FAILED crash page — which is what the
// first deploy returned (2026-09-28), with no way to see the cause.
let puppeteerMod = null;
async function loadPuppeteer() {
  if (!puppeteerMod) {
    const mod = await import('puppeteer-core');
    puppeteerMod = mod.default || mod;
  }
  return puppeteerMod;
}

const MAX_HTML_BYTES = 60 * 1024 * 1024;     // after gunzip
const MAX_RESPONSE_BYTES = 4.4 * 1024 * 1024; // Vercel's response limit is 4.5MB
const RENDER_TIMEOUT_MS = 40000;
const ALLOWED_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'lh3.googleusercontent.com',
]);

// Reused across warm invocations so only a cold start pays Chromium's
// launch cost.
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.connected) return existing;
  }
  browserPromise = (async () => {
    const puppeteer = await loadPuppeteer();
    const { default: chromium } = await import('@sparticuz/chromium');
    return puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      defaultViewport: { width: 816, height: 1056 },
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    });
  })();
  return browserPromise;
}

async function readRawBody(req) {
  const parsed = req.body;
  if (Buffer.isBuffer(parsed)) return parsed;
  if (typeof parsed === 'string') return Buffer.from(parsed, 'utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// GET /api/render-pdf  →  self-test: launches Chromium, prints a one-line
// page, and reports each step's result as JSON. Open it in a browser tab
// after any deploy to confirm the endpoint works end to end.
async function selfTest(res) {
  const steps = { node: process.version };
  const t0 = Date.now();
  try {
    const puppeteer = await loadPuppeteer();
    steps.puppeteerLoaded = true;
    const { default: chromium } = await import('@sparticuz/chromium');
    steps.chromiumLoaded = true;
    steps.executablePath = await chromium.executablePath();
    const browser = await getBrowser();
    steps.browserVersion = await browser.version();
    const page = await browser.newPage();
    try {
      await page.setContent('<p style="font:16px sans-serif">render-pdf self-test</p>');
      const pdf = await page.pdf({ format: 'letter' });
      steps.samplePdfBytes = pdf.length;
    } finally {
      await page.close().catch(() => {});
    }
    steps.ok = true;
  } catch (err) {
    steps.ok = false;
    steps.error = String((err && err.stack) || err).slice(0, 1500);
  }
  steps.ms = Date.now() - t0;
  return res.status(steps.ok ? 200 : 500).json(steps);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return selfTest(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let page = null;
  try {
    let raw = await readRawBody(req);
    if (!raw.length) return res.status(400).json({ error: 'Empty request body' });
    if (String(req.headers['x-pdfx-encoding'] || '').toLowerCase() === 'gzip') {
      raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_HTML_BYTES });
    }
    if (raw.length > MAX_HTML_BYTES) return res.status(413).json({ error: 'HTML too large' });
    const html = raw.toString('utf8');

    const ownHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      // .catch on every continue/abort: an unhandled rejection here (e.g.
      // "Request is already handled") would crash the whole function.
      const allow = () => Promise.resolve(request.continue()).catch(() => {});
      const block = () => Promise.resolve(request.abort()).catch(() => {});
      if (url.startsWith('data:') || url.startsWith('about:')) return allow();
      let host = '';
      try { host = new URL(url).host; } catch (e) { return block(); }
      if (host === ownHost || ALLOWED_HOSTS.has(host)) return allow();
      return block();
    });

    await page.setContent(html, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS });
    await page.evaluate(() => document.fonts.ready.then(() => true));

    const pdf = Buffer.from(await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      timeout: RENDER_TIMEOUT_MS,
    }));

    if (pdf.length > MAX_RESPONSE_BYTES) {
      console.error('[api/render-pdf] PDF too large to return:', pdf.length);
      return res.status(413).json({ error: `Rendered PDF is ${(pdf.length / 1048576).toFixed(1)}MB, over the 4.4MB response limit` });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(pdf);
  } catch (err) {
    console.error('[api/render-pdf]', err);
    return res.status(500).json({ error: String((err && err.stack) || err).slice(0, 1500) });
  } finally {
    if (page) await page.close().catch(() => {});
  }
};
