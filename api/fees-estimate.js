/**
 * api/debug/fees-estimate.js
 * One-off diagnostic endpoint — NOT part of the regular cron chain.
 * Calls the exact same Amazon Product Fees API v0 endpoint that
 * sync-orders-process.js's getFeesEstimate() calls, but dumps the FULL
 * raw response (including result.Error, which the cron path discards)
 * so we can see the actual reason behind a non-Success Status.
 *
 * Usage:
 *   GET /api/debug/fees-estimate?asin=B0H3CLS4XW&price=113.39
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Optional:
 *   &fulfilled=false   — test as merchant-fulfilled instead of FBA (default true)
 */

const { spRequest } = require('../_spauth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const asin = req.query.asin;
  const price = parseFloat(req.query.price);
  const isAmazonFulfilled = req.query.fulfilled !== 'false';

  if (!asin || !price || price <= 0) {
    return res.status(400).json({ error: 'Provide ?asin=...&price=... (price > 0)' });
  }

  const body = {
    FeesEstimateRequest: {
      MarketplaceId: process.env.SP_MARKETPLACE_ID,
      IsAmazonFulfilled: isAmazonFulfilled,
      PriceToEstimateFees: {
        ListingPrice: { CurrencyCode: 'USD', Amount: price },
        Shipping:     { CurrencyCode: 'USD', Amount: 0 },
      },
      Identifier: `debug-${asin}-${price}`,
    },
  };

  console.log(`[debug/fees-estimate] request → asin=${asin} price=${price} isAmazonFulfilled=${isAmazonFulfilled}`);
  console.log(`[debug/fees-estimate] marketplaceId=${process.env.SP_MARKETPLACE_ID || 'MISSING'}`);
  console.log(`[debug/fees-estimate] request body: ${JSON.stringify(body)}`);

  try {
    const resp = await spRequest('POST', `/products/fees/v0/items/${asin}/feesEstimate`, {}, body);

    // Dump absolutely everything — this is the whole point of this endpoint.
    console.log(`[debug/fees-estimate] FULL raw response: ${JSON.stringify(resp)}`);

    const result = resp?.payload?.FeesEstimateResult;

    return res.status(200).json({
      requestSent:   body,
      fullResponse:  resp,          // entire raw payload from Amazon
      status:        result?.Status ?? null,
      error:         result?.Error ?? null,     // <-- the field the cron job never looks at
      feesEstimate:  result?.FeesEstimate ?? null,
    });
  } catch (err) {
    // If spRequest/httpRequest itself threw (network error, non-JSON body,
    // etc.) — note _spauth.js's httpRequest doesn't surface HTTP status
    // codes either, so if this fires we may need a follow-up to add that.
    console.error(`[debug/fees-estimate] request threw: ${err.message}`);
    return res.status(500).json({ error: 'Request threw', detail: err.message, stack: err.stack });
  }
};
