/**
 * api/test-retention-filter.js
 * ONE-OFF DIAGNOSTIC — not a cron. SUBSCRIBER_RETENTION only supports
 * filters.brandNames (not filters.asins — confirmed via Amazon's own
 * validation error on 2026-07-09). This tests several candidate brand-name
 * strings against the real API in one shot, so we find Amazon's exact
 * registered value instead of guessing and redeploying repeatedly.
 *
 * Tries: an unfiltered baseline (confirms the metric itself works at all
 * for this account), then each candidate string as a brandNames filter,
 * returning every result side by side.
 *
 * DELETE this file once the real brandNames value is confirmed and wired
 * into sync-subscriptions.js.
 *
 * GET or POST /api/test-retention-filter?brand=evolis
 *   optional: &candidates=Evolis,Évolis,EVOLIS
 * Authorization: Bearer <CRON_SECRET>
 */

const { spRequest } = require('./_spauth');
const brands         = require('./config/brands');

const REPLENISHMENT_BASE = '/replenishment/2022-11-07';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const brandId = req.query.brand || 'evolis';
  const brand   = brands.find(b => b.id === brandId);
  if (!brand) return res.status(400).json({ error: `Unknown brand id "${brandId}"` });

  // Reasonable default candidates from what we already know about this
  // brand's config, plus anything explicitly passed via ?candidates=
  const defaultCandidates = [
    brand.displayName,
    brand.id,
    brand.id.toUpperCase(),
    brand.id.charAt(0).toUpperCase() + brand.id.slice(1),
  ].filter(Boolean);

  const candidates = req.query.candidates
    ? req.query.candidates.split(',').map(s => s.trim())
    : [...new Set(defaultCandidates)];

  const { startDate, endDate } = lastThreeMonthsRange();
  const baseBody = {
    aggregationFrequency: 'MONTH',
    timeInterval: { startDate, endDate },
    metrics: ['SUBSCRIBER_RETENTION'],
    timePeriodType: 'PERFORMANCE',
    marketplaceId: process.env.SP_MARKETPLACE_ID,
    programTypes: ['SUBSCRIBE_AND_SAVE'],
  };

  try {
    // Baseline — confirms SUBSCRIBER_RETENTION works at all for this
    // account before we go chasing filter values.
    const unfiltered = await spRequest('POST', `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`, {}, baseBody);

    const candidateResults = {};
    for (let i = 0; i < candidates.length; i++) {
      if (i > 0) await sleep(1100); // respect 1 req/sec rate limit between calls
      const candidate = candidates[i];
      try {
        const resp = await spRequest('POST', `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`, {}, {
          ...baseBody,
          filters: { brandNames: [candidate] },
        });
        candidateResults[candidate] = { success: true, response: resp };
      } catch (err) {
        candidateResults[candidate] = { success: false, error: err.message };
      }
    }

    return res.status(200).json({
      brand: brandId,
      note: 'Compare candidateResults against unfiltered — a working candidate should return DIFFERENT (smaller, brand-specific) numbers than the whole-account baseline, same pattern as the asins filter test.',
      unfiltered,
      candidateResults,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function lastThreeMonthsRange() {
  const now   = new Date();
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
  return {
    startDate: start.toISOString().slice(0, 19) + 'Z',
    endDate:   new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19) + 'Z',
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
