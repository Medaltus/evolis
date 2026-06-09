/**
 * api/debug-orders.js
 * GET /api/debug-orders?days=3
 * Temporary debugging endpoint â€” shows raw SKUs coming back from SP-API
 * so we can confirm the correct prefix to filter on.
 * DELETE this file once SKU prefix is confirmed.
 */

const { spRequest } = require('./_spauth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const days = parseInt(req.query.days || 3);
    const now  = new Date();
    const past = new Date(now);
    past.setDate(past.getDate() - days);

    const start = past.toISOString().slice(0, 10) + 'T00:00:00Z';
    const end   = now.toISOString().slice(0, 10)  + 'T23:59:59Z';

    // Fetch a small batch of orders
    const response = await spRequest('GET', '/orders/v0/orders', {
      MarketplaceIds:    process.env.SP_MARKETPLACE_ID,
      CreatedAfter:      start,
      CreatedBefore:     end,
      MaxResultsPerPage: '10',  // just 10 orders to inspect
    });

    const orders = (response.payload?.Orders || []).filter(o => o.OrderStatus !== 'Canceled');

    // Fetch line items for each order
    const results = [];
    for (const order of orders.slice(0, 5)) { // max 5 to stay fast
      let items = [];
      try {
        const resp = await spRequest('GET', `/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
        items = resp.payload?.OrderItems || [];
      } catch (e) {
        items = [];
      }

      results.push({
        orderId:      order.AmazonOrderId,
        date:         order.PurchaseDate?.slice(0, 10),
        status:       order.OrderStatus,
        orderTotal:   order.OrderTotal?.Amount,
        promotionIds: order.PromotionIds || [],
        items: items.map(i => ({
          asin:       i.ASIN,
          sku:        i.SellerSKU,       // <-- this is what we're filtering on
          title:      i.Title?.slice(0, 60),
          qty:        i.QuantityOrdered,
        })),
      });

      await new Promise(r => setTimeout(r, 300));
    }

    res.status(200).json({
      dateRange: { start, end },
      ordersFound: orders.length,
      sample: results,
    });
  } catch (err) {
    console.error('[debug-orders]', err);
    res.status(500).json({ error: err.message });
  }
};
