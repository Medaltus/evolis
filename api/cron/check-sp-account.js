/**
 * api/cron/check-sp-account.js
 * ADDED 2026-10-05 — diagnostic only, not scheduled.
 *
 * Checks one seller account's SP-API setup step by step and reports exactly
 * which piece is wrong. Never returns or logs the secret values themselves —
 * only whether each is set, its length, whether it has stray whitespace, and
 * whether it has the expected prefix.
 *
 *   GET /api/cron/check-sp-account?account=hol
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Steps (stops at the first failure, since later steps depend on earlier):
 *   1. env vars — present, no stray spaces/newlines, expected format
 *   2. LWA token exchange — Amazon's own error code if it's rejected
 *   3. basic SP-API call (Sellers API) — are the credentials accepted at all
 *   4. reports access — does the app have the role order reports need
 *
 * Reminder: Vercel only picks up env var changes after a new deployment.
 */

const { spRequest } = require('../_spauth');
const { getAccount } = require('../_account');

// Env var names per account — must match api/_spauth.js's SELLER_ACCOUNTS.
const ENV_NAMES = {
  newderm: { clientId: 'SP_CLIENT_ID',     clientSecret: 'SP_CLIENT_SECRET',     refreshToken: 'SP_REFRESH_TOKEN',     sellerId: 'SP_SELLER_ID' },
  hol:     { clientId: 'SP_CLIENT_ID_HOL', clientSecret: 'SP_CLIENT_SECRET_HOL', refreshToken: 'SP_REFRESH_TOKEN_HOL', sellerId: 'SP_SELLER_ID_HOL' },
};

// Expected shapes (prefix checks only — never the values).
const EXPECTED_PREFIX = {
  clientId:     'amzn1.application-oa2-client.',
  clientSecret: 'amzn1.oa2-cs.',
  refreshToken: 'Atzr|',
};

function describeVar(name, kind) {
  const raw = process.env[name];
  if (raw == null || raw === '') return { name, ok: false, problem: 'not set (or not deployed yet)' };
  const info = { name, length: raw.length };
  const problems = [];
  if (raw !== raw.trim()) problems.push('has leading/trailing spaces or a newline — re-paste it without them');
  if (/^["']|["']$/.test(raw.trim())) problems.push('is wrapped in quote marks — remove them');
  const prefix = EXPECTED_PREFIX[kind];
  if (prefix && !raw.trim().startsWith(prefix)) problems.push(`doesn't start with "${prefix}" — may be the wrong value pasted into this variable`);
  if (kind === 'sellerId' && !/^A[0-9A-Z]{8,20}$/.test(raw.trim())) problems.push('doesn\'t look like a seller/merchant ID (usually starts with "A", letters and numbers only)');
  info.ok = problems.length === 0;
  if (problems.length) info.problem = problems.join('; ');
  return info;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let account;
  try { account = getAccount(req); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }

  const names = ENV_NAMES[account];
  const report = { account, steps: [] };
  const finish = (verdict) => res.status(200).json({ ...report, verdict });

  // ── 1. Env vars ──────────────────────────────────────────────────────────
  const vars = {
    clientId:     describeVar(names.clientId, 'clientId'),
    clientSecret: describeVar(names.clientSecret, 'clientSecret'),
    refreshToken: describeVar(names.refreshToken, 'refreshToken'),
    sellerId:     describeVar(names.sellerId, 'sellerId'),
  };
  // ADDED 2026-10-05 — catch a value accidentally copied from the OTHER
  // account (e.g. NewDerm's secret pasted into the HOL variable). Compares
  // values in memory and only reports true/false — never the values.
  const otherAccount = account === 'newderm' ? 'hol' : 'newderm';
  const other = ENV_NAMES[otherAccount];
  for (const kind of ['clientId', 'clientSecret', 'refreshToken', 'sellerId']) {
    const mine = (process.env[names[kind]] || '').trim();
    const theirs = (process.env[other[kind]] || '').trim();
    if (mine && theirs && mine === theirs) {
      vars[kind].ok = false;
      vars[kind].problem = [vars[kind].problem, `is IDENTICAL to ${other[kind]} — this looks like ${otherAccount}'s value pasted into the wrong variable`].filter(Boolean).join('; ');
    }
  }
  const badVars = Object.values(vars).filter(v => !v.ok);
  report.steps.push({ step: '1. env vars', ok: badVars.length === 0, vars });
  if (['clientId', 'clientSecret', 'refreshToken'].some(k => !vars[k].ok && /not set/.test(vars[k].problem || ''))) {
    return finish(`Missing: ${badVars.map(v => v.name).join(', ')}. Add it in Vercel, then redeploy.`);
  }

  // ── 2. LWA token exchange (raw, so we see Amazon's exact error code) ────
  let lwa;
  try {
    const resp = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     (process.env[names.clientId] || '').trim(),
        client_secret: (process.env[names.clientSecret] || '').trim(),
        refresh_token: (process.env[names.refreshToken] || '').trim(),
      }).toString(),
    });
    lwa = { status: resp.status, body: await resp.json().catch(() => ({})) };
  } catch (err) {
    report.steps.push({ step: '2. LWA token', ok: false, error: err.message });
    return finish('Could not reach Amazon\'s login service — network issue, try again.');
  }

  if (lwa.body.error) {
    const code = lwa.body.error;
    const hint = {
      invalid_client:         `${names.clientId} or ${names.clientSecret} is wrong. Both must be copied from the SAME app's "LWA credentials" screen (Seller Central → Apps and Services → Develop Apps → View). If the secret was rotated recently, use the current one. The refresh token hasn't been checked yet — Amazon stops at the client credentials first.`,
      invalid_grant:          `${names.refreshToken} is wrong, expired, or was generated for a DIFFERENT app than ${names.clientId}. Re-authorize the app in High On Love's Seller Central and copy the new refresh token.`,
      unauthorized_client:    `The app behind ${names.clientId} isn't allowed to use this refresh token — the token likely belongs to a different app.`,
      invalid_request:        'Something is blank or malformed — check step 1.',
    }[code] || 'See Amazon\'s error description.';
    report.steps.push({ step: '2. LWA token', ok: false, amazonError: code, amazonDescription: lwa.body.error_description });
    return finish(hint);
  }
  report.steps.push({ step: '2. LWA token', ok: true });

  // ── 3. Basic SP-API call ─────────────────────────────────────────────────
  try {
    const mp = await spRequest('GET', '/sellers/v1/marketplaceParticipations', {}, null, account);
    if (mp.errors) {
      report.steps.push({ step: '3. SP-API access', ok: false, amazonErrors: mp.errors });
      return finish('Login works but SP-API rejected the request — see amazonErrors.');
    }
    const marketplaces = (mp.payload || []).map(p => `${p.marketplace?.countryCode} (${p.marketplace?.id})${p.participation?.isParticipating ? '' : ' — not participating'}`);
    report.steps.push({ step: '3. SP-API access', ok: true, marketplaces });
  } catch (err) {
    report.steps.push({ step: '3. SP-API access', ok: false, error: err.message });
    return finish('Login works but the SP-API call failed — see error.');
  }

  // ── 4. Reports access (read-only — lists reports, creates nothing) ──────
  try {
    const r = await spRequest('GET', '/reports/2021-06-30/reports', {
      reportTypes: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      pageSize: '1',
    }, null, account);
    if (r.errors) {
      report.steps.push({ step: '4. order reports access', ok: false, amazonErrors: r.errors });
      return finish('Credentials work, but this app is not allowed to use order reports. In High On Love\'s Seller Central, edit the app\'s roles to include the one covering order reports (e.g. "Inventory and Order Tracking"), then re-authorize and update the refresh token.');
    }
    report.steps.push({ step: '4. order reports access', ok: true });
  } catch (err) {
    report.steps.push({ step: '4. order reports access', ok: false, error: err.message });
    return finish('Reports check failed — see error.');
  }

  const sellerNote = vars.sellerId.ok ? '' : ` (Note: ${names.sellerId} — ${vars.sellerId.problem}. Not needed for orders, but the ads crons will use it.)`;
  return finish(`All checks passed — this account can request order reports.${sellerNote}`);
};
