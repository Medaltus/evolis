/**
 * api/test-subscription-contract-fields.js
 * ONE-OFF DIAGNOSTIC — not a cron. Two-part discovery:
 *   1. Introspects Shopify's GraphQL schema for the SubscriptionContract
 *      type, listing every field name + type it actually has.
 *   2. Fetches ONE real contract with a broad (educated-guess) set of
 *      commonly-useful fields, to see real sample data/values, not just
 *      field names in the abstract.
 *
 * Reuses the same Shopify auth as sync-shopify-orders.js.
 *
 * DELETE once we've decided what sync-shopify-subscriptions.js should
 * actually pull.
 *
 * GET or POST /api/test-subscription-contract-fields
 * Authorization: Bearer <CRON_SECRET>
 */

const STORE_DOMAIN  = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION   = '2025-01';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getShopifyToken();

    // ── 1. Introspection: what fields does SubscriptionContract actually have? ──
    const introspectionQuery = `
      query {
        __type(name: "SubscriptionContract") {
          name
          fields {
            name
            description
            type {
              name
              kind
              ofType { name kind ofType { name kind } }
            }
          }
        }
      }
    `;
    const introspectionResult = await shopifyGraphQL(token, introspectionQuery, {});
    const fieldList = (introspectionResult?.__type?.fields || []).map(f => ({
      name: f.name,
      type: describeType(f.type),
      description: f.description || '',
    }));

    // ── 2. One real contract, broad guessed field set. Some of these may
    //    not exist / may error — that's fine, it tells us what's real. ──
    const sampleQuery = `
      query GetSomeContracts {
        subscriptionContracts(first: 50) {
          edges {
            node {
              id
              status
              createdAt
              updatedAt
              nextBillingDate
              currencyCode
              customer { id firstName lastName email }
              deliveryPolicy { interval intervalCount }
              billingPolicy { interval intervalCount }
              lines(first: 10) {
                edges { node { id title quantity currentPrice { amount currencyCode } } }
              }
              originOrder { id name }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;
    let rawSubscriptionContractsResponse = null;
    let sampleError = null;
    try {
      const sampleResult = await shopifyGraphQL(token, sampleQuery, {});
      rawSubscriptionContractsResponse = sampleResult?.subscriptionContracts ?? 'FIELD_ITSELF_WAS_NULL_OR_UNDEFINED';
    } catch (err) {
      sampleError = err.message;
    }

    return res.status(200).json({
      availableFields: fieldList,
      rawSubscriptionContractsResponse,
      edgeCount: Array.isArray(rawSubscriptionContractsResponse?.edges) ? rawSubscriptionContractsResponse.edges.length : 'N/A',
      sampleQueryError: sampleError,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function describeType(t) {
  if (!t) return '';
  if (t.kind === 'NON_NULL') return describeType(t.ofType) + '!';
  if (t.kind === 'LIST') return '[' + describeType(t.ofType) + ']';
  return t.name || t.kind;
}

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
