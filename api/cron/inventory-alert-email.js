// api/onhold-sync.js
// Hardened version: retries with backoff, atomic tab writes (no clear-then-write gap),
// per-store isolation, a second pass for failed stores, and last-good data kept on failure.
const SHEET_ID = '1OnIJ2Ppolp9ZSdK987XsuvYMESyn2iTPiT1KzHqbgmE';
const { ssFetch, STORE_ID_MAP } = require('./_ss');
const { sendCronFailureAlert } = require('./_alerts');

const delay = ms => new Promise(r => setTimeout(r, ms));

const TAB_MAP = {
  'PRO':      'VBC - PRO',
  'DTC':      'VBC - DTC',
  'VVSC':     'VBC - VVSC',
  'Employee': 'VBC - Employee',
};

const HEADER = ['Order Number', 'Bill To Name', 'Custom Field 3', 'Last Updated'];
const MAX_ATTEMPTS = 4;          // 1 try + 3 retries per call
const BASE_DELAY_MS = 1500;      // 1.5s → 3s → 6s
const SECOND_PASS_DELAY_MS = 5000;
const MAX_PAGES = 20;

// ── Retry helper ────────────────────────────────────────────────────────────
async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.retryable === false) break;
      if (attempt < MAX_ATTEMPTS) {
        const wait = err.status === 429 ? BASE_DELAY_MS * 2 ** attempt : BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`[onhold-sync] ${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message} — retrying in ${wait}ms`);
        await delay(wait);
      }
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

// Throws on non-OK responses; 4xx (other than 408/429) are marked non-retryable.
async function checkedFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${body.slice(0, 300)}`);
    err.status = res.status;
    err.retryable = !(res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
    throw err;
  }
  return res;
}

// ── Google auth ─────────────────────────────────────────────────────────────
async function getGoogleToken() {
  const email  = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const now    = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const jwt = `${signingInput}.${sign.sign(rawKey, 'base64url')}`;

  return withRetry('Google token', async () => {
    const tokenRes = await checkedFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const d = await tokenRes.json();
    if (!d.access_token) throw new Error('No access_token in Google response');
    return d.access_token;
  });
}

// ── ShipStation ─────────────────────────────────────────────────────────────
async function fetchStoreOrders(storeId, label) {
  const all = [];
  let page = 1, hasMore = true;
  while (hasMore) {
    const data = await withRetry(`ShipStation ${label} page ${page}`, async () => {
      const d = await ssFetch(`/orders?orderStatus=on_hold&storeId=${storeId}&pageSize=500&page=${page}`);
      // Never treat a malformed/error response as "zero orders" — that would wipe the tab.
      if (!d || !Array.isArray(d.orders)) {
        throw new Error(`Unexpected ShipStation response: ${JSON.stringify(d).slice(0, 200)}`);
      }
      return d;
    });
    data.orders.forEach(o => all.push(o));
    hasMore = page < (data.pages || 1);
    page++;
    if (page > MAX_PAGES) break;
    if (hasMore) await delay(300);
  }
  return all;
}

// ── Sheets ──────────────────────────────────────────────────────────────────
async function getExistingRowCount(tabName, token) {
  const encoded = encodeURIComponent(`${tabName}!A1:A10000`);
  return withRetry(`Read ${tabName}`, async () => {
    const res = await checkedFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encoded}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const d = await res.json();
    return (d.values || []).length;
  });
}

// Single PUT that overwrites old rows with blanks — the tab is never empty mid-run.
async function writeTab(tabName, rows, token) {
  const existing = await getExistingRowCount(tabName, token);
  const values = [HEADER, ...rows];
  while (values.length < existing) values.push(['', '', '', '']);

  const range = `${tabName}!A1:D${values.length}`;
  return withRetry(`Write ${tabName}`, async () => {
    const res = await checkedFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range, majorDimension: 'ROWS', values })
      }
    );
    const d = await res.json();
    if ((d.updatedRows || 0) !== values.length) {
      throw new Error(`Write mismatch: expected ${values.length} rows, Sheets reported ${d.updatedRows}`);
    }
    return d;
  });
}

// ── One store, end to end ───────────────────────────────────────────────────
async function syncStore(storeId, label, token, stamp) {
  const tabName = TAB_MAP[label];
  if (!tabName) throw new Error(`No tab mapped for store label "${label}"`);
  const orders = await fetchStoreOrders(storeId, label);
  const rows = orders.map(o => [
    o.orderNumber                    || '',
    o.billTo?.name                   || '',
    (o.advancedOptions?.customField3 || '').replace(/[\r\n]+/g, ' ').trim(),
    stamp
  ]);
  await writeTab(tabName, rows, token);
  return { tab: tabName, rows: rows.length };
}

// ── Handler ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (process.env.SKIP_ONHOLD_SYNC === 'true') {
    console.log('[onhold-sync] Skipped — SKIP_ONHOLD_SYNC=true on this project');
    return res.status(200).json({ success: true, skipped: true });
  }

  let token;
  try {
    token = await getGoogleToken();
  } catch (err) {
    console.error('[onhold-sync]', err.message);
    await sendCronFailureAlert('onhold-sync', `Could not authenticate with Google after ${MAX_ATTEMPTS} attempts. Sheet left unchanged (last good data kept). ${err.message}`);
    return res.status(500).json({ error: err.message });
  }

  const stamp = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });

  const results = [];
  let failed = [];

  // Pass 1: every store independently
  for (const [storeId, label] of Object.entries(STORE_ID_MAP)) {
    try {
      results.push(await syncStore(storeId, label, token, stamp));
    } catch (err) {
      console.error(`[onhold-sync] ${label} failed on pass 1:`, err.message);
      failed.push({ storeId, label, error: err.message });
    }
    await delay(300);
  }

  // Pass 2: retry only the stores that failed
  if (failed.length) {
    await delay(SECOND_PASS_DELAY_MS);
    const stillFailed = [];
    for (const f of failed) {
      try {
        results.push(await syncStore(f.storeId, f.label, token, stamp));
        console.log(`[onhold-sync] ${f.label} recovered on pass 2`);
      } catch (err) {
        console.error(`[onhold-sync] ${f.label} failed on pass 2:`, err.message);
        stillFailed.push({ ...f, error: err.message });
      }
    }
    failed = stillFailed;
  }

  const summary = {
    total_orders: results.reduce((s, r) => s + r.rows, 0),
    tabs_written: results,
    refreshed_at: new Date().toISOString()
  };

  if (failed.length) {
    const msg = failed.map(f => `${TAB_MAP[f.label] || f.label}: ${f.error}`).join('\n');
    await sendCronFailureAlert(
      'onhold-sync',
      `${failed.length} store(s) failed after all retries. Those tabs still show their last good data; other stores updated normally.\n\n${msg}`
    );
    return res.status(500).json({ success: false, failed_tabs: failed.map(f => TAB_MAP[f.label] || f.label), ...summary });
  }

  return res.status(200).json({ success: true, ...summary });
};
