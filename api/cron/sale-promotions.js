/**
 * api/cron/sale-promotions.js
 * Independently-scheduled job — computes "Amazon Sale Promotions" (the
 * seller-funded event discount: (regular_price - item_price) × units) for
 * any row that's missing it and falls inside a known event window, across
 * every active brand. Runs completely separately from sync-orders-process.js
 * and fees-estimate.js — a problem here can never block basic order data
 * from syncing or fees from being computed, and vice versa.
 *
 * Unlike fees-estimate.js, this job makes NO external API calls — it's pure
 * in-memory math over data already in Sheets (the Events + Product Short
 * Name tabs, loaded once per run). So it doesn't need per-run budgets or a
 * resumable cursor the way fee/SKU lookups do; it sweeps every brand fully
 * each run. rowLimit below is just a safety valve, not a real constraint
 * under normal conditions.
 *
 * Manual:
 *   GET /api/cron/sale-promotions
 *   Authorization: Bearer <CRON_SECRET>
 *   &brand=evolis   — restrict to one brand
 *   &dryRun=true    — report what WOULD be updated without writing anything
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const brandsConfig                         = require('../config/brands');
const sheets                               = require('../config/sheets');

// Must match sync-orders-process.js's HEADERS exactly — same tab, same shape.
const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'sku', 'asin', 'brand', 'last_updated',
  'Amazon Estimated fees',
  'Amazon Sale Promotions',
];

// Safety valve only — normal runs won't get anywhere near this.
const DEFAULT_ROW_LIMIT_PER_BRAND = 20_000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun    = req.query.dryRun === 'true';
  const onlyBrand = req.query.brand || null;
  const rowLimit  = parseInt(req.query.rowLimit, 10) || DEFAULT_ROW_LIMIT_PER_BRAND;

  // ── Load Events + price reference (same source as the old inline logic) ──
  const PRODUCTS_SHEET_ID = process.env.SHEET_MASTER_SKU_LIST;
  const EVENTS_GID        = '347530381';
  const PROD_NAMES_GID    = '164358627';

  let eventWindows = [];
  let priceRef     = new Map();

  try {
    if (!PRODUCTS_SHEET_ID) throw new Error('SHEET_MASTER_SKU_LIST env var not set');

    const [eventsCsv, prodCsv] = await Promise.all([
      fetchCsv(PRODUCTS_SHEET_ID, EVENTS_GID),
      fetchCsv(PRODUCTS_SHEET_ID, PROD_NAMES_GID),
    ]);

    const evRows = parseCsvRows(eventsCsv);
    const rawEvents = evRows.map(r => ({
      name:      (r['Event Name'] || '').trim(),
      startDate: (r['start_date'] || '').trim(),
      endDate:   (r['end_date']   || '').trim(),
    })).filter(ev => ev.startDate && ev.endDate);

    // Regular prices keyed by ASIN (safer than SKU — each product has an FBA
    // SKU and a seller-fulfilled SKU, e.g. EVO0001 / EVO0001-SF, but only the
    // FBA SKU is listed in Product Short Name. ASIN covers both.)
    const prodRows = parseCsvRows(prodCsv);
    prodRows.forEach(r => {
      const asinKey = (r['ASIN'] || '').trim().toUpperCase();
      const price   = parseFloat((r['Price'] || r['price'] || '').replace(/[$,]/g, '')) || 0;
      if (asinKey && price > 0) priceRef.set(asinKey, price);
    });

    const allPricedAsins = new Set(priceRef.keys());
    rawEvents.forEach(ev => {
      eventWindows.push({ asinSet: allPricedAsins, startDate: ev.startDate, endDate: ev.endDate });
    });

    console.log(`[sale-promotions] events loaded: ${eventWindows.length}, prices: ${priceRef.size}`);
  } catch (err) {
    console.error('[sale-promotions] failed to load events/prices — aborting run:', err.message);
    return res.status(500).json({ error: 'Failed to load events/price reference', detail: err.message });
  }

  const activeBrands = brandsConfig.filter(b => b.active && (!onlyBrand || b.id === onlyBrand));
  const results = [];

  for (const brand of activeBrands) {
    try {
      const outcome = await processBrandPromos({ brand, eventWindows, priceRef, rowLimit, dryRun });
      results.push({ brand: brand.id, status: 'ok', ...outcome });
    } catch (err) {
      console.error(`[sale-promotions] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  res.status(200).json({ dryRun, results });
};

// ── Per-brand core logic ─────────────────────────────────────────────────────

async function processBrandPromos({ brand, eventWindows, priceRef, rowLimit, dryRun }) {
  const token           = await ensureTab(sheets.orders, brand.tabName, HEADERS);
  const existingRowsRaw = await readRows(sheets.orders, brand.tabName);
  const existingRowsObj = (existingRowsRaw || []).map(normalizeRow);
  const workingRows      = existingRowsObj.map(r => HEADERS.map(h => r[h] ?? ''));

  let filledCount = 0;
  let skippedCount = 0;
  const scanLimit = Math.min(rowLimit, existingRowsObj.length);

  for (let i = 0; i < scanLimit; i++) {
    const row = existingRowsObj[i];
    const storedPromo = row['Amazon Sale Promotions'];
    if (storedPromo !== '' && storedPromo != null) continue; // already filled

    const date  = row.date || '';
    const asin  = (row.asin || '').toUpperCase();
    const price = parseFloat(row.item_price || '0');
    const qty   = parseInt(row.unit_count || row.quantity_ordered || '0', 10);

    if (!date || !asin || !qty || qty <= 0) {
      skippedCount++;
      continue;
    }

    let salePromos = null;
    for (const ev of eventWindows) {
      if (date >= ev.startDate && date <= ev.endDate && ev.asinSet.has(asin)) {
        const regularPrice = priceRef.get(asin);
        if (regularPrice && regularPrice > price) {
          salePromos = round2((regularPrice - price) * qty);
        }
        break;
      }
    }

    if (salePromos != null) {
      filledCount++;
      if (!dryRun) {
        workingRows[i][HEADERS.indexOf('Amazon Sale Promotions')] = salePromos;
      }
    }
    // Not in an event window, or no discount applied — correctly leave blank.
    // Not a failure, nothing to retry; this row just isn't a promo row.
  }

  if (!dryRun && filledCount > 0) {
    await replaceRows(sheets.orders, brand.tabName, HEADERS, workingRows, token);
  }

  return { filled: filledCount, skippedNoData: skippedCount, totalRows: existingRowsObj.length };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeRow(r) {
  if (Array.isArray(r)) {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  }
  return r;
}

const round2 = n => Math.round(n * 100) / 100;

async function fetchCsv(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetchCsv failed: ${resp.status} ${url}`);
  return resp.text();
}

// Minimal CSV parser for Google Sheets exports (handles quoted fields).
function parseCsvRows(text) {
  if (!text || !text.trim()) return [];
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = splitLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
    return obj;
  });
}

function splitLine(line, delimiter = ',') {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; cur += c; }
    else if (c === delimiter && !inQuote) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}
