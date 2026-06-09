/**
 * api/config/brands.js
 * Central brand registry. Add a new brand here and the next cron run
 * automatically creates its tab in all 4 sheets.
 *
 * skuPrefix: first 3 chars of all SKUs for this brand (e.g. EVO matches EVO0001, EVO0047)
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
  // Add future brands here — cron creates the tab automatically on first run:
  // {
  //   id:          'dazzle-dry',
  //   tabName:     'dazzle-dry',
  //   skuPrefix:   'DDY',
  //   displayName: 'Dazzle Dry',
  //   active:      false,
  // },
];
