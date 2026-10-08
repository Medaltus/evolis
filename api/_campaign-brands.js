/**
 * api/_campaign-brands.js
 * ADDED 2026-10-08 — campaign name → brand matching, shared.
 *
 * Copied EXACTLY from sync-advertising-process.js's CAMPAIGN_BRANDS /
 * identifyBrand (including the High On Love entries added 2026-10-06) so
 * sync-event-ad-orders-process.js can match Sponsored Brands campaigns
 * without depending on that file's deployed version.
 *
 * TODO when sync-advertising-process.js is next deployed: have it (and
 * sync-ad-search-terms-process.js / sync-advertising-process-ca.js, which
 * keep their own copies) require this file instead, so there is ONE list.
 * Until then, a new brand or naming pattern must be added in both places.
 */

const CAMPAIGN_BRANDS = [
  { name: 'skinuva',        tabName: 'skinuva'        },
  { name: 'the creme shop', tabName: 'creme-shop'     },
  { name: 'cloud cafe',     tabName: 'cloud-cafe'     },
  { name: 'just bjorn',     tabName: 'just-bjorn'     },
  { name: 'pb & jay',       tabName: 'pbj'            },
  { name: 'pb&jay',         tabName: 'pbj'            },
  { name: 'miguard',        tabName: 'miguard'        },
  { name: 'dearcloud',      tabName: 'dearcloud'      },
  { name: 'eraclea',        tabName: 'eraclea'        },
  { name: 'evolis',         tabName: 'evolis'         },
  { name: 'amala',          tabName: 'amala'          },
  { name: 'cimeosil',       tabName: 'cimeosil'       },
  { name: 'collagelee',     tabName: 'collagelee'     },
  { name: 'hillside',       tabName: 'hillside'       },
  { name: 'prohibition',    tabName: 'prohibition'    },
  { name: 'skinside seoul', tabName: 'skinside-seoul' },
  { name: 'skinside-seoul', tabName: 'skinside-seoul' },
  { name: 'high on love',   tabName: 'high-on-love'   }, // ADDED 2026-10-06 — see matchBrand in the handler: a High On Love run
  { name: 'highonlove',     tabName: 'high-on-love'   }, // attributes every campaign to High On Love regardless of name anyway
  { name: 'cosmette',       tabName: 'cosmette'       }, // CONFIRMED 2026-08-21 — real campaigns are "Cosmette - SP - Auto - ..." (6 campaigns, screenshot from Jaclyn)
].sort((a, b) => b.name.length - a.name.length);

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function identifyBrand(campaignName) {
  const normalized = stripAccents((campaignName || '').toLowerCase());
  if (normalized.includes('skinuva') && normalized.includes('canada')) return 'skinuva-ca';
  const match = CAMPAIGN_BRANDS.find(b => normalized.includes(b.name));
  return match ? match.tabName : null;
}

module.exports = { CAMPAIGN_BRANDS, identifyBrand };
