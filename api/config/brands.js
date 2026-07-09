/**
 * api/config/brands.js
 * Central brand registry for Newderm seller account.
 * Add a new brand here and the next cron run automatically
 * creates its tab in all sheets.
 *
 * skuPrefix:       first 3 chars of all SKUs for this brand
 * tabName:         slug used as the Google Sheet tab name
 * active:          set false to pause syncing without deleting config
 * amazonBrandName: EXACT string as registered in Amazon Brand Registry.
 *                   Confirmed directly from Seller Central (2026-07-09) —
 *                   do not guess/normalize casing or accents here, several
 *                   differ from `displayName` (e.g. evolis is lowercase
 *                   "évolis" on Amazon but "Évolis" in displayName).
 *                   Used by sync-subscriptions.js's SUBSCRIBER_RETENTION
 *                   call, which only supports a brandNames filter (not
 *                   asins) and requires Amazon's exact registered value.
 *
 * cimeosil — REMOVED 2026-07-09. Confirmed not a registered Amazon Brand
 * Registry entry (absent from the full brand checklist in Seller Central).
 * This also explains why it always had 0 ASINs in the master SKU/ASIN
 * sheet and was being skipped by sync-subscriptions.js.
 */
module.exports = [
  {
    id:              'evolis',
    tabName:         'evolis',
    skuPrefix:       'EVO',
    displayName:     'Évolis',
    amazonBrandName: 'évolis',
    active:          true,
  },
  {
    id:              'skinuva',
    tabName:         'skinuva',
    skuPrefix:       'SVA',
    displayName:     'Skinuva',
    amazonBrandName: 'Skinuva',
    active:          true,
  },
  {
    id:              'dearcloud',
    tabName:         'dearcloud',
    skuPrefix:       'DEC',
    displayName:     'dearcloud',
    amazonBrandName: 'dearcloud',
    active:          true,
  },
  {
    id:              'creme-shop',
    tabName:         'creme-shop',
    skuPrefix:       'CRE',
    displayName:     'The Crème Shop',
    amazonBrandName: 'The Crème Shop',
    active:          true,
  },
  {
    id:              'cloud-cafe',
    tabName:         'cloud-cafe',
    skuPrefix:       'CLC',
    displayName:     'Cloud Cafe',
    amazonBrandName: 'Clöud Café',
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
    id:              'just-bjorn',
    tabName:         'just-bjorn',
    skuPrefix:       'JBJ',
    displayName:     'Just Bjorn',
    amazonBrandName: 'just björn',
    active:          true,
  },
  {
    id:              'amala',
    tabName:         'amala',
    skuPrefix:       'ALA',
    displayName:     'Amala',
    amazonBrandName: 'Amala',
    active:          true,
  },
  {
    id:              'collagelee',
    tabName:         'collagelee',
    skuPrefix:       'COL',
    displayName:     'Collagelee',
    amazonBrandName: 'Collagelée',
    active:          true,
  },
  {
    id:              'hillside',
    tabName:         'hillside',
    skuPrefix:       'HIL',
    displayName:     'Hillside',
    amazonBrandName: 'Hillside Candle',
    active:          true,
  },
  {
    id:              'prohibition',
    tabName:         'prohibition',
    skuPrefix:       'PRB',
    displayName:     'Prohibition',
    amazonBrandName: 'Prohibition Wellness',
    active:          true,
  },
  {
    id:              'eraclea',
    tabName:         'eraclea',
    skuPrefix:       'ERA',
    displayName:     'Eraclea',
    amazonBrandName: 'eraclea',
    active:          true,
  },
  {
    id:              'skinside-seoul',
    tabName:         'skinside-seoul',
    skuPrefix:       'SSS',
    displayName:     'skinside SEOUL',
    amazonBrandName: 'skinside SEOUL',
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
