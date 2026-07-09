/**
 * api/test-subscriptions-filter.js
 * ONE-OFF DIAGNOSTIC — not a cron, not scheduled. Answers one question:
 * does getSellingPartnerMetrics' documented `filters.asins` parameter
 * actually narrow results per brand, or does it return the same
 * whole-account numbers regardless (like our unfiltered test showed)?
 *
 * Reuses the ASIN→brand map sync-advertising-process.js already reads
 * from the master SKU/ASIN sheet, so there's no guessing at Amazon's
 * registered Brand Registry display name / casing — ASINs are exact.
 *
 * Calls getSellingPartnerMetrics three times:
 *   1. No filter at all      (baseline — should match the identical-
 *                              across-brands numbers we saw before)
 *   2. filters.asins = brandA's ASINs only
 *   3. filters.asins = brandB's ASINs only
 *
 * If (2) and (3) differ from each other and from (1), the filter works
 * and sync-subscriptions.js can be fixed to use it directly. If all three
 * are identical, filters.asins doesn't narrow anything for this endpoint
 * and we need the offer-level listOfferMetrics endpoint instead.
 *
 * DELETE this file once the real fix in sync-subscriptions.js is confirmed
 * working — this only exists to answer one question.
 *
 * GET or POST /api/test-subscriptions-filter?brandA=evolis&brandB=skinuva
 * Authorization: Bearer <CRON_SECRET>
 */

const { spRequest } = require('./_spauth');
const brands         = require('./config/brands');

const PRODUCT_SHEET_ID   = '1NNRTRQxQl2r4XivAvH700CC39p49GD2xfZlyRNqahGA';
const PRODUCT_SHEET_GID  = '164358627';
const REPLENISHMENT_BASE = '/replenishment/2022-11-07';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const brandAId = req.query.brandA || 'evolis';
  const brandBId = req.query.brandB || 'skinuva';

  try {
    const asinBrandMap = await fetchAsinBrandMap();
    const asinsA = Object.entries(asinBrandMap).filter(([, tabName]) => tabName === brandAId).map(([asin]) => asin);
    const asinsB = Object.entries(asinBrandMap).filter(([, tabName]) => tabName === brandBId).map(([asin]) => asin);

    if (asinsA.length === 0) return res.status(400).json({ error: `No ASINs found for brandA="${brandAId}" in the master sheet — check the brand id/tabName` });
    if (asinsB.length === 0) return res.status(400).json({ error: `No ASINs found for brandB="${brandBId}" in the master sheet — check the brand id/tabName` });

    const { startDate, endDate } = lastThreeMonthsRange();

    const baseBody = {
      aggregationFrequency: 'MONTH',
      timeInterval: { startDate, endDate },
      metrics: ['ACTIVE_SUBSCRIPTIONS'],
      timePeriodType: 'PERFORMANCE',
      marketplaceId: process.env.SP_MARKETPLACE_ID,
      programTypes: ['SUBSCRIBE_AND_SAVE'],
    };

    const [unfiltered, filteredA, filteredB] = await Promise.all([
      spRequest('POST', `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`, {}, baseBody),
      spRequest('POST', `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`, {}, { ...baseBody, filters: { asins: asinsA } }),
      spRequest('POST', `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`, {}, { ...baseBody, filters: { asins: asinsB } }),
    ]);

    const aMatchesUnfiltered = JSON.stringify(filteredA) === JSON.stringify(unfiltered);
    const aMatchesB          = JSON.stringify(filteredA) === JSON.stringify(filteredB);

    return res.status(200).json({
      brandA: brandAId, brandAAsinCount: asinsA.length,
      brandB: brandBId, brandBAsinCount: asinsB.length,
      verdict: (!aMatchesUnfiltered && !aMatchesB)
        ? 'DIFFERENT — filters.asins appears to actually narrow results. Safe to build the real fix around it.'
        : 'IDENTICAL — filters.asins does NOT narrow anything here. Need listOfferMetrics instead.',
      unfiltered,
      filteredA,
      filteredB,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

// Same logic as sync-advertising-process.js's ASIN→brand lookup, so brandA/
// brandB here line up with the same tabNames used everywhere else.
async function fetchAsinBrandMap() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${PRODUCT_SHEET_ID}/export?format=csv&gid=${PRODUCT_SHEET_GID}`;
  const resp   = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`Failed to fetch master ASIN sheet: ${resp.status}`);
  const csv = await resp.text();
  const map = {};
  csv.trim().split('\n').slice(1).forEach(line => {
    const cols      = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    const asin      = (cols[0] || '').toUpperCase();
    const brandName = (cols[3] || '').toLowerCase().trim();
    if (!asin || !brandName) return;
    const matched = brands.find(b =>
      b.active && (
        brandName === b.id.toLowerCase() ||
        brandName === b.displayName?.toLowerCase() ||
        brandName.includes(b.id.toLowerCase())
      )
    );
    if (matched) map[asin] = matched.tabName;
  });
  return map;
}

function lastThreeMonthsRange() {
  const now = new Date();
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
  return {
    startDate: start.toISOString().slice(0, 19) + 'Z',
    endDate:   new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z',
  };
}
