/**
 * api/config/brands.js
 * Central brand registry for Newderm seller account.
 * Add a new brand here and the next cron run automatically
 * creates its tab in all sheets.
 *
 * skuPrefix:       first 3 chars of all SKUs for this brand
 * tabName:         slug used as the Google Sheet tab name
 * active:          set false to pause syncing without deleting config
 * amazonBrandName: EXACT string as registered in Amazon Brand Registry,
 *                   in ALL CAPS. Confirmed 2026-07-09: the Replenishment
 *                   API's SUBSCRIBER_RETENTION brandNames filter requires
 *                   uppercase (accents preserved, e.g. "ÉVOLIS" not
 *                   "évolis" or "Évolis") — verified against Seller
 *                   Central's own retention widget, which returned the
 *                   exact same 70.4% figure once queried in uppercase.
 *                   Mixed-case values silently returned empty results
 *                   with no error, which is what made this hard to spot.
 *                   Used by sync-subscriptions.js's SUBSCRIBER_RETENTION
 *                   call (asins filter, used by active_subscriptions,
 *                   does not have this same casing requirement).
 *
 * cimeosil — REMOVED then RESTORED, both 2026-07-09. Initially dropped on
 * the assumption it wasn't a real registered brand (absent from the Brand
 * Registry checklist AND the master ASIN sheet). That assumption was
 * wrong — confirmed via Seller Central's Subscriber Retention widget that
 * "CIMEOSIL" returns real data (78.6% 90-day retention). It's a genuine
 * active brand; it's the master ASIN sheet that's incomplete, not this
 * brand's registration. See the inline note on its entry below.
 *
 * high-on-love — ADDED 2026-07-21, active:false. On a SEPARATE Amazon
 * seller account from the rest of this project — no SP-API/Ads API
 * connection has been set up for it yet ("eventually," per Jaclyn,
 * 2026-07-21). Added now to the registry ahead of that setup so it
 * doesn't need to be re-added later, but kept inactive specifically so
 * it doesn't get picked up by every cron that loops
 * brands.filter(b => b.active) and fail against a seller account with no
 * real connection configured. Flip to active:true once that setup is
 * actually done. amazonBrandName below is inferred from ShipStation's own
 * store naming ("HIGHONLOVE @ Amazon.com" / "HIGHONLOVE @ Amazon.CA") —
 * NOT independently verified against Brand Registry directly, unlike
 * every other entry in this file. Confirm the real registered string
 * before this brand's own Amazon-side crons (Replenishment API /
 * SUBSCRIBER_RETENTION in particular) go live, in case ShipStation's
 * store name doesn't exactly match Brand Registry's own casing/spacing.
 */
module.exports = [
  {
    id:              'evolis',
    productsSyncGroup: 'B', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'evolis',
    skuPrefix:       'EVO',
    displayName:     'Évolis',
    amazonBrandName: 'ÉVOLIS',
    active:          true,
  },
  {
    id:              'skinuva',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'skinuva',
    skuPrefix:       'SVA',
    displayName:     'Skinuva',
    amazonBrandName: 'SKINUVA',
    active:          true,
    // ADDED 2026-08-13 — skinuva-ca (below) shares this exact SKU prefix,
    // since it's the same physical products sold through a different
    // storefront (Amazon.ca), not a separate product line. skuPrefix alone
    // can no longer disambiguate the two — salesChannel is the tiebreaker.
    // Every other brand in this file has no salesChannel field and their
    // matching is completely unaffected; this only matters for brands that
    // share a prefix. See sync-orders-process.js / sync-revenue-process.js
    // for where this is actually checked.
    salesChannel:    'Amazon.com',
  },
  {
    id:              'skinuva-ca',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'skinuva-ca',
    skuPrefix:       'SVA',
    displayName:     'Skinuva (Canada)',
    amazonBrandName: 'SKINUVA',
    active:          true,
    // ADDED 2026-08-13 per Jaclyn — skinuva sells on both Amazon.com and
    // Amazon.ca under the SAME seller account (confirmed: both FBA and
    // Merchant-fulfilled Canadian orders were found mixed into skinuva's
    // regular US data, not just Remote-Fulfillment-with-FBA cross-border
    // orders, which would be FBA-only — this points to skinuva's account
    // being enrolled in some form of NA multi-marketplace selling, not
    // independently confirmed). All requests are still scoped to
    // SP_MARKETPLACE_ID only (sync-orders-request.js / sync-revenue-
    // request.js were NOT changed) — Amazon.ca activity already arrives in
    // that same report via the flat file's `sales-channel` field
    // ("Amazon.ca" vs "Amazon.com"), which is what this entry's
    // salesChannel is matched against. No new report request needed.
    salesChannel:    'Amazon.ca',
  },
  {
    id:              'dearcloud',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'dearcloud',
    skuPrefix:       'DEC',
    displayName:     'dearcloud',
    amazonBrandName: 'DEARCLOUD',
    active:          true,
  },
  {
    id:              'creme-shop',
    productsSyncGroup: 'B', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'creme-shop',
    skuPrefix:       'CRE',
    displayName:     'The Crème Shop',
    amazonBrandName: 'THE CRÈME SHOP',
    active:          true,
  },
  {
    id:              'cloud-cafe',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'cloud-cafe',
    skuPrefix:       'CLC',
    displayName:     'Cloud Cafe',
    amazonBrandName: 'CLÖUD CAFÉ',
    active:          true,
  },
  {
    id:              'miguard',
    productsSyncGroup: 'B', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'miguard',
    skuPrefix:       'MIG',
    displayName:     'MiGuard',
    amazonBrandName: 'MIGUARD',
    active:          true,
  },
  {
    id:              'cimeosil',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'cimeosil',
    skuPrefix:       'CIM',
    displayName:     'Cimeosil',
    amazonBrandName: 'CIMEOSIL',
    active:          true,
    // RESTORED 2026-07-09 — earlier removed on the assumption it wasn't a
    // real registered brand (absent from the Brand Registry checklist AND
    // the master ASIN sheet). That assumption was wrong: confirmed via
    // Seller Central's Subscriber Retention widget that "CIMEOSIL" (all
    // caps) returns real data (78.6% 90-day retention). It's a genuine
    // active brand — just still missing from the master ASIN sheet, which
    // means it'll keep showing "no ASINs found, skipping" for
    // active_subscriptions in sync-subscriptions.js until those ASINs are
    // added there. Retention (brandNames-based) works right now regardless.
  },
  {
    id:              'just-bjorn',
    productsSyncGroup: 'B', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'just-bjorn',
    skuPrefix:       'JBJ',
    displayName:     'Just Bjorn',
    amazonBrandName: 'JUST BJÖRN',
    active:          true,
  },
  {
    id:              'amala',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'amala',
    skuPrefix:       'ALA',
    displayName:     'Amala',
    amazonBrandName: 'AMALA',
    active:          true,
  },
  {
    id:              'collagelee',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'collagelee',
    skuPrefix:       'COL',
    displayName:     'Collagelee',
    amazonBrandName: 'COLLAGELÉE',
    active:          true,
  },
  {
    id:              'hillside',
    productsSyncGroup: 'B', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'hillside',
    skuPrefix:       'HIL',
    displayName:     'Hillside',
    amazonBrandName: 'HILLSIDE CANDLE',
    active:          true,
  },
  {
    id:              'prohibition',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'prohibition',
    skuPrefix:       'PRB',
    displayName:     'Prohibition',
    amazonBrandName: 'PROHIBITION WELLNESS',
    active:          true,
  },
  {
    id:              'eraclea',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'eraclea',
    skuPrefix:       'ERA',
    displayName:     'Eraclea',
    amazonBrandName: 'ERACLEA',
    active:          true,
  },
  {
    id:              'skinside-seoul',
    productsSyncGroup: 'B', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'skinside-seoul',
    skuPrefix:       'SSS',
    displayName:     'skinside SEOUL',
    amazonBrandName: 'SKINSIDE SEOUL',
    active:          true,
  },
  {
    id:              'pbj',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'pbj',
    skuPrefix:       'PBJ',
    displayName:     'PB & Jay',
    amazonBrandName: 'PB & JAY',
    active:          true,
  },
  {
    id:              'cosmette',
    productsSyncGroup: 'A', // used by sync-products.js's ?group= split — see that file's header comment
    tabName:         'cosmette',
    skuPrefix:       'COS',
    displayName:     'Cosmette',
    amazonBrandName: 'COSMETTE', // UNCONFIRMED — placeholder guess (uppercase, no accents). This specifically affects sync-subscriptions.js's Replenishment API call (SUBSCRIBER_RETENTION), which silently returns empty data on a wrong casing/accent match, no error — verify the exact Brand Registry string when convenient, doesn't block everything else.
    active:          true, // CONFIRMED active 2026-08-13 per Jaclyn — Amazon-side SP-API/Ads connection is live.
  },
  {
    id:              'high-on-love',
    tabName:         'high-on-love',
    skuPrefix:       'HOL',
    displayName:     'High On Love',
    amazonBrandName: 'HIGHONLOVE',
    active:          false,
  },
];
