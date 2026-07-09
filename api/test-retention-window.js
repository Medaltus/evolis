/**
 * api/test-retention-window.js
 * ONE-OFF DIAGNOSTIC — not a cron. SUBSCRIBER_RETENTION returned real data
 * for a 13-month-wide window, but empty {"metrics":[]} for just "last full
 * month" — most likely because a 90-day retention rate for a cohort from
 * last month genuinely doesn't exist yet (90 days haven't elapsed). This
 * tests several single-month windows at increasing distance from today
 * against ONE confirmed-good brand name, to find how far back is actually
 * "old enough" for Amazon to have a real number — rather than guessing a
 * third time on this metric.
 *
 * DELETE once sync-subscriptions.js's retention window is confirmed correct.
 *
 * GET or POST /api/test-retention-window?brand=evolis
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
  if (!brand.amazonBrandName) return res.status(400).json({ error: `No amazonBrandName set for "${brandId}"` });

  // Test single-month windows at 1, 2, 3, 4, 5, and 6 months back.
  const offsets = [1, 2, 3, 4, 5, 6];
  const results = {};

  try {
    for (let i = 0; i < offsets.length; i++) {
      if (i > 0) await sleep(1100); // respect 1 req/sec rate limit
      const offset = offsets[i];
      const { startDate, endDate, label } = monthWindow(offset);

      const body = {
        aggregationFrequency: 'MONTH',
        timeInterval: { startDate, endDate },
        metrics: ['SUBSCRIBER_RETENTION'],
        timePeriodType: 'PERFORMANCE',
        marketplaceId: process.env.SP_MARKETPLACE_ID,
        programTypes: ['SUBSCRIBE_AND_SAVE'],
        filters: { brandNames: [brand.amazonBrandName] },
      };

      try {
        const resp = await spRequest('POST', `${REPLENISHMENT_BASE}/sellingPartners/metrics/search`, {}, body);
        const period = resp?.metrics?.[0];
        results[`${offset}_months_back_(${label})`] = {
          hasData: period?.subscriberRetentionFor90Days != null,
          value: period?.subscriberRetentionFor90Days ?? null,
          raw: resp,
        };
      } catch (err) {
        results[`${offset}_months_back_(${label})`] = { error: err.message };
      }
    }

    return res.status(200).json({
      brand: brandId,
      note: 'Look for the SMALLEST offset where hasData=true — that is the minimum recency that actually has measurable 90-day retention data.',
      results,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Single-calendar-month window, `offset` months before the current month.
function monthWindow(offset) {
  const now   = new Date();
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  return {
    startDate: start.toISOString().slice(0, 19) + 'Z',
    endDate:   end.toISOString().slice(0, 19) + 'Z',
    label:     start.toISOString().slice(0, 7),
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
