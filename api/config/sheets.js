/**
 * api/config/sheets.js
 * Google Sheet IDs for each data type.
 * Add new sheet IDs here as env vars â€” never hardcode them.
 */

module.exports = {
  orders:        process.env.SHEET_ORDERS,        // amazon-orders
  products:      process.env.SHEET_PRODUCTS,      // amazon-products
  advertising:   process.env.SHEET_ADVERTISING,   // amazon-advertising
  subscriptions: process.env.SHEET_SUBSCRIPTIONS, // amazon-subscriptions
};
