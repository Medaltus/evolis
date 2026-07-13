/**
 * api/cron/sync-shopify-subscriptions.js
 * Daily — counts ACTIVE subscription contracts via Shopify's native GraphQL
 * Admin API (subscriptionContracts connection) and writes that single
 * number into column L ("website_subscriptions") of the current month's
 * row on the Stewardship Summary sheet.
 *
 * IMPORTANT SCOPE: this cron writes to EXACTLY ONE cell — column L of the
 * row matching the current year/month. It never touches columns A-K, and
 * never touches any other row. If that row doesn't exist yet (shouldn't
 * happen in practice, since sync-stewardship-summary.js creates it first),
 * this cron creates a new row with A-K blank and only L filled in, rather
 * than guessing at any other column's value.
 *
 * Reuses the exact same Shopify auth pattern as sync-shopify-orders.js
 * (client_credentials grant, same env vars) — no separate Appstle API key
 * needed, since Appstle Subscriptions is built directly on top of
 * Shopify's own native Subscription Contract objects.
 *
 * Shopify's GraphQL connections don't expose a plain "total count" field —
 * this pages through every ACTIVE contract and counts them.
 *
 * Sheet: SHEET_STEWARDSHIP_SUMMARY (16QNnDh7-dTDzI-O7UI-WlzMtOmovssV23nd-quiYPR0)
 * Tab: brand.tabName (e.g. 'evolis')
 * Schedule: daily, e.g. "30 7 * * *" — after sync-shopify-orders (7:00) so
 * both Shopify-sourced crons don't hit the API in the same instant.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');

const STORE_DOMAIN  = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION   = '2025-01';

const SUMMARY_SHEET_ID = process.env.SHEET_STEWARDSHIP_SUMMARY;
const TAB_NAME          = 'evolis'; // matches brand.tabName used by sync-stewardship-summary.js

// Full header list INCLUDING the new column L. Must match exactly what
// sync-stewardship-summary.js uses (also updated to include this column),
// or the two crons will disagree about which column index is which.
const HEADERS = [
  'year', 'month',
  'ads_spend', 'impressions', 'clicks', 'ad_units',
  'promos_total', 'vine_total',
  'revenue', 'units',
  'last_updated',
  'website_subscriptions', // column L — the ONLY column this cron writes
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!STORE_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Shopify env vars not set' });
  }
  if (!SUMMARY_SHEET_ID) {
    return res.status(500).json({ error: 'SHEET_STEWARDSHIP_SUMMARY not set' });
  }

  let accessToken;
  try {
    accessToken = await getShopifyToken();
  } catch (err) {
    console.error('[sync-shopify-subscriptions] token failed:', err.message);
    return res.status(500).json({ error: 'Token request failed', detail: err.message });
  }

  // ── Count ACTIVE subscription contracts, paging through all of them ──────
  let activeCount = 0;
  let cursor = null;
  let page = 0;

  const query = `
    query GetActiveSubscriptions($first: Int!, $after: String) {
      subscriptionContracts(first: $first, after: $after, query: "status:ACTIVE") {
        edges { cursor node { id } }
        pageInfo { hasNextPage }
      }
    }
  `;

  do {
    page++;
    try {
      const resp = await shopifyGraphQL(accessToken, query, { first: 250, after: cursor });
      const edges = resp?.subscriptionContracts?.edges || [];
      activeCount += edges.length;
      if (edges.length) cursor = edges[edges.length - 1].cursor;

      const hasNextPage = resp?.subscriptionContracts?.pageInfo?.hasNextPage;
      console.log(`[sync-shopify-subscriptions] page ${page}: +${edges.length} (running total: ${activeCount})`);

      if (!hasNextPage) break;
      if (page >= 100) { console.warn('[sync-shopify-subscriptions] hit page cap'); break; }
    } catch (err) {
      console.error(`[sync-shopify-subscriptions] page ${page} failed:`, err.message);
      return res.status(500).json({ error: 'GraphQL fetch failed', detail: err.message });
    }
  } while (true);

  console.log(`[sync-shopify-subscriptions] total ACTIVE contracts: ${activeCount}`);

  // ── Write ONLY column L for the current year/month row ────────────────────
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  try {
    const token = await ensureTab(SUMMARY_SHEET_ID, TAB_NAME, HEADERS);
    const existing = await readRows(SUMMARY_SHEET_ID, TAB_NAME);

    let found = false;
    const updated = existing.map(r => {
      const rowCopy = { ...r };
      if (parseInt(r.year, 10) === year && parseInt(r.month, 10) === month) {
        rowCopy.website_subscriptions = activeCount;
        found = true;
      }
      return rowCopy;
    });

    if (!found) {
      // No row for this month yet (shouldn't normally happen, since
      // sync-stewardship-summary.js creates the month's row first) —
      // add a new row with ONLY year/month/website_subscriptions filled,
      // everything else blank rather than guessed at.
      const blankRow = {};
      HEADERS.forEach(h => { blankRow[h] = ''; });
      blankRow.year = year;
      blankRow.month = month;
      blankRow.website_subscriptions = activeCount;
      updated.push(blankRow);
      console.log(`[sync-shopify-subscriptions] no existing row for ${year}-${month} — created one with only year/month/website_subscriptions set`);
    }

    const outRows = updated.map(r => HEADERS.map(h => r[h] ?? ''));
    await replaceRows(SUMMARY_SHEET_ID, TAB_NAME, HEADERS, outRows, token);

    return res.status(200).json({
      activeSubscriptions: activeCount,
      year, month,
      rowFoundExisting: found,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[sync-shopify-subscriptions] sheet write failed:', err.message);
    return res.status(500).json({ error: 'Sheet write failed', detail: err.message });
  }
};

// ── Shopify auth (identical pattern to sync-shopify-orders.js) ────────────

async function getShopifyToken() {
  const resp = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`Token request failed: ${resp.status}`);
  const { access_token } = await resp.json();
  if (!access_token) throw new Error('No access_token in response');
  return access_token;
}

async function shopifyGraphQL(token, query, variables = {}) {
  const resp = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!resp.ok) throw new Error(`GraphQL request failed: ${resp.status}`);
  const { data, errors } = await resp.json();
  if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}
