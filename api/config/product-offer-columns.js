/**
 * api/config/product-offer-columns.js
 * ADDED 2026-10-20 — the Products Cache columns owned by
 * api/cron/sync-product-offers.js, placed after sync-products.js's own
 * columns (after qty_on_hand). Shared so sync-products.js knows they exist:
 * its header check expects an exact match, and its ?force=true clear step
 * must keep these columns instead of wiping them.
 */
module.exports = {
  OFFER_HEADERS: [
    'alt_seller_count',   // other sellers on this ASIN (excludes NewDerm / High On Love)
    'alt_sellers',        // their names (from the seller_names tab) or seller IDs, " | "-separated
    'alt_seller_links',   // storefront links for each, same order
    'buybox_owner',       // "us", another seller's name/ID, or "none" (no Buy Box shown)
    'lowest_alt_price',   // lowest other-seller price incl. shipping
    'offers_synced_at',   // when this row's offer data was written (Eastern)
  ],
};
