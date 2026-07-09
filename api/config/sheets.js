/**
 * api/config/sheets.js
 * Google Sheet IDs for each data type.
 * Add new sheet IDs here as env vars — never hardcode them.
 *
 * ── Env var → sheet mapping ──────────────────────────────────────────────────
 * SHEET_ORDERS              sync-orders (rolling 90-day cache, per-brand tabs)
 * SHEET_ORDERS_HISTORICAL   historical orders cache (YOY comparisons)
 * SHEET_PRODUCTS            master SKU/ASIN sheet (Vine tab lives here)
 * SHEET_ADVERTISING         advertising cache (ad summary + ad orders tabs)
 * SHEET_SUBSCRIPTIONS       subscribe & save sync
 * SHEET_REVENUE             revenue history (monthly totals by brand)
 * SHEET_RETURNS             FBA customer returns (sync-returns-request/process)
 * SHEET_AD_ORDERS           ad orders cache (ASIN-level ad performance)
 * SHEET_LISTING_AUDIT       listing audit results (per-brand tabs)
 * SHEET_KEYWORD_STRATEGY    keyword strategy per brand
 * SHEET_INSIGHTS            brand insights / monthly takeaways
 * SHEET_UPLOADS             file uploads tracking (Evolis GID etc)
 */

module.exports = {
  orders:           process.env.SHEET_ORDERS,
  ordersHistorical: process.env.SHEET_ORDERS_HISTORICAL,
  products:         process.env.SHEET_PRODUCTS,
  advertising:      process.env.SHEET_ADVERTISING,
  subscriptions:    process.env.SHEET_SUBSCRIPTIONS,
  revenue:          process.env.SHEET_REVENUE,
  returns:          process.env.SHEET_RETURNS,
  adOrders:         process.env.SHEET_AD_ORDERS,
  listingAudit:     process.env.SHEET_LISTING_AUDIT,
  keywordStrategy:  process.env.SHEET_KEYWORD_STRATEGY,
  insights:         process.env.SHEET_INSIGHTS,
  uploads:          process.env.SHEET_UPLOADS,
};
