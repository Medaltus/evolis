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
    id:          'clc',
    tabName:     'clc',
    skuPrefix:   'CLC',
    displayName: 'Clöud Café',
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
