/**
 * api/_fulfillment_brands.js
 * Brand list for the fulfillment crons (sync-fulfillment-daily-
 * shipments.js, sync-fulfillment-states.js, sync-fulfillment-kpis.js).
 *
 * Confirmed 2026-07-20: each of these 8 brands has its own dedicated
 * ShipStation store, so attribution is a direct &storeId= filter on
 * /shipments and /orders — no SKU matching or shipmentItems join needed
 * at all (an earlier version of this file attempted SKU-based
 * attribution before this was confirmed; storeId-based is simpler and
 * more reliable, since it's filtered server-side by ShipStation itself
 * rather than fetched-then-filtered).
 *
 * ONLY these 8 brands are here — NOT the full 15+HighOnLove brand list
 * used elsewhere in this project (config/brands.js). Cross-referencing
 * the full GET /stores response against every brand name turned up no
 * store at all for dearcloud, creme-shop, cloud-cafe, cimeosil, amala,
 * collagelee, pbj, or skinside-seoul — meaning those brands are almost
 * certainly Amazon-FBA-only, with no separate DTC shipping running
 * through ShipStation. There's nothing for this page to show for them,
 * so no empty placeholder tabs were created for them here.
 *
 * HighOnLove specifically: storeId 86711 is the manual ShipStation store
 * named "HighonLove Website" — NOT storeId 95134 (a Shopify store also
 * named "High on Love" that shows active:true in ShipStation's own API,
 * but confirmed 2026-07-20 to not actually be in current use). Also
 * confirmed: HighOnLove's two Amazon stores (75754 CA, 70328 .com) are
 * deliberately excluded — only the website channel is tracked here.
 */

const FULFILLMENT_BRANDS = [
  { id: 'eraclea',     tabName: 'eraclea',     storeId: 95243 },
  { id: 'evolis',      tabName: 'evolis',      storeId: 82698 },
  { id: 'high-on-love', tabName: 'high-on-love', storeId: 86711 },
  { id: 'hillside',    tabName: 'hillside',    storeId: 86113 },
  { id: 'just-bjorn',  tabName: 'just-bjorn',  storeId: 85892 },
  { id: 'miguard',     tabName: 'miguard',     storeId: 81823 },
  { id: 'prohibition', tabName: 'prohibition', storeId: 86492 },
  { id: 'skinuva',     tabName: 'skinuva',     storeId: 68797 },
];

module.exports = { FULFILLMENT_BRANDS };
