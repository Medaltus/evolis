/**
 * api/config/brands.js
 * Central brand registry for Newderm seller account.
 * Add a new brand here and the next cron run automatically
 * creates its tab in all sheets.
 *
 * skuPrefix: first 3 chars of all SKUs for this brand
 * tabName:   slug used as the Google Sheet tab name
 * active:    set false to pause syncing without deleting config
 */
module.exports = [
  {
    id:          'evolis',
    tabName:     'evolis',
    skuPrefix:   'EVO',
    displayName: 'Évolis',
    active:      true,
  },
  {
    id:          'skinuva',
    tabName:     'skinuva',
    skuPrefix:   'SVA',
    displayName: 'Skinuva',
    active:      true,
  },
  {
    id:          'dearcloud',
    tabName:     'dearcloud',
    skuPrefix:   'DEC',
    displayName: 'dearcloud',
    active:      true,
  },
  {
    id:          'creme-shop',
    tabName:     'creme-shop',
    skuPrefix:   'CRE',
    displayName: 'The Crème Shop',
    active:      true,
  },
  {
    id:          'cloud-cafe',
    tabName:     'cloud-cafe',
    skuPrefix:   'CLC',
    displayName: 'Cloud Cafe',
    active:      true,
  },
  {
    id:          'miguard',
    tabName:     'miguard',
    skuPrefix:   'MIG',
    displayName: 'MiGuard',
    active:      true,
  },
  {
    id:          'cimeosil',
    tabName:     'cimeosil',
    skuPrefix:   'CIM',
    displayName: 'Cimeosil',
    active:      true,
  },
  {
    id:          'just-bjorn',
    tabName:     'just-bjorn',
    skuPrefix:   'JBJ',
    displayName: 'Just Bjorn',
    active:      true,
  },
  {
    id:          'amala',
    tabName:     'amala',
    skuPrefix:   'ALA',
    displayName: 'Amala',
    active:      true,
  },
  {
    id:          'collagelee',
    tabName:     'collagelee',
    skuPrefix:   'COL',
    displayName: 'Collagelee',
    active:      true,
  },
  {
    id:          'hillside',
    tabName:     'hillside',
    skuPrefix:   'HIL',
    displayName: 'Hillside',
    active:      true,
  },
  {
    id:          'prohibition',
    tabName:     'prohibition',
    skuPrefix:   'PRB',
    displayName: 'Prohibition',
    active:      true,
  },
  {
    id:          'eraclea',
    tabName:     'eraclea',
    skuPrefix:   'ERA',
    displayName: 'Eraclea',
    active:      true,
  },
  {
    id:          'skinside-seoul',
    tabName:     'skinside-seoul',
    skuPrefix:   'SSS',
    displayName: 'skinside SEOUL',
    active:      true,
  },
  {
    id:          'pbj',
    tabName:     'pbj',
    skuPrefix:   'PBJ',
    displayName: 'PB & Jay',
    active:      true,
  },
];
