/**
 * api/config/sheets.js
 * Google Sheet IDs for each data type.
 * Add new sheet IDs here as env vars — never hardcode them.
 */

module.exports = {
  orders:           process.env.SHEET_ORDERS,
  ordersHistorical: process.env.SHEET_ORDERS_HISTORICAL,
  products:         process.env.SHEET_PRODUCTS,
  advertising:      process.env.SHEET_ADVERTISING,
  subscriptions:    process.env.SHEET_SUBSCRIPTIONS,
  revenue:          process.env.SHEET_REVENUE,
};
