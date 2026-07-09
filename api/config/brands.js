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
 */
module.exports = [
  {
    id:              'evolis',
    tabName:         'evolis',
    skuPrefix:       'EVO',
    displayName:     'Évolis',
    amazonBrandName: 'ÉVOLIS',
    active:          true,
  },
  {
    id:              'skinuva',
    tabName:         'skinuva',
    skuPrefix:       'SVA',
    displayName:     'Skinuva',
    amazonBrandName: 'SKINUVA',
    active:          true,
  },
  {
    id:              'dearcloud',
    tabName:         'dearcloud',
    skuPrefix:       'DEC',
    displayName:     'dearcloud',
    amazonBrandName: 'DEARCLOUD',
    active:          true,
  },
  {
    id:              'creme-shop',
    tabName:         'creme-shop',
    skuPrefix:       'CRE',
    displayName:     'The Crème Shop',
    amazonBrandName: 'THE CRÈME SHOP',
    active:          true,
  },
  {
    id:              'cloud-cafe',
    tabName:         'cloud-cafe',
    skuPrefix:       'CLC',
    displayName:     'Cloud Cafe',
    amazonBrandName: 'CLÖUD CAFÉ',
    active:          true,
  },
  {
    id:              'miguard',
    tabName:         'miguard',
    skuPrefix:       'MIG',
    displayName:     'MiGuard',
    amazonBrandName: 'MIGUARD',
    active:          true,
  },
  {
    id:              'cimeosil',
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
    tabName:         'just-bjorn',
    skuPrefix:       'JBJ',
    displayName:     'Just Bjorn',
    amazonBrandName: 'JUST BJÖRN',
    active:          true,
  },
  {
    id:              'amala',
    tabName:         'amala',
    skuPrefix:       'ALA',
    displayName:     'Amala',
    amazonBrandName: 'AMALA',
    active:          true,
  },
  {
    id:              'collagelee',
    tabName:         'collagelee',
    skuPrefix:       'COL',
    displayName:     'Collagelee',
    amazonBrandName: 'COLLAGELÉE',
    active:          true,
  },
  {
    id:              'hillside',
    tabName:         'hillside',
    skuPrefix:       'HIL',
    displayName:     'Hillside',
    amazonBrandName: 'HILLSIDE CANDLE',
    active:          true,
  },
  {
    id:              'prohibition',
    tabName:         'prohibition',
    skuPrefix:       'PRB',
    displayName:     'Prohibition',
    amazonBrandName: 'PROHIBITION WELLNESS',
    active:          true,
  },
  {
    id:              'eraclea',
    tabName:         'eraclea',
    skuPrefix:       'ERA',
    displayName:     'Eraclea',
    amazonBrandName: 'ERACLEA',
    active:          true,
  },
  {
    id:              'skinside-seoul',
    tabName:         'skinside-seoul',
    skuPrefix:       'SSS',
    displayName:     'skinside SEOUL',
    amazonBrandName: 'SKINSIDE SEOUL',
    active:          true,
  },
  {
    id:              'pbj',
    tabName:         'pbj',
    skuPrefix:       'PBJ',
    displayName:     'PB & Jay',
    amazonBrandName: 'PB & JAY',
    active:          true,
  },
];
