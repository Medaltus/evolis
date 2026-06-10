/**
 * api/cron/sync-orders-backfill.js
 * Runs on the 5th of each month — backfills prior month into historical sheet.
 * Can also be triggered manually for any month.
 *
 * Uses GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL report —
 * one API call per month instead of per-order fetching. Scales to any volume.
 *
 * Writes to: amazon-orders-historical (SHEET_ORDERS_HISTORICAL)
 * Keeps up to 18 months of data per brand tab.
 * Also writes/updates a "Summary" tab with one row per brand per month.
 *
 * Auto-trigger: 5th of month at 4:00 AM UTC (pulls prior month)
 * Manual:  ?year=2026&month=5
 */

const { spRequest }                                = require('../_spauth');
const { ensureTab, replaceRows, readRows }         = require('../config/_sheets_client');
const brands                                       = require('../config/brands');
const sheets                                       = require('../config/sheets');
const https                                        = require('https');

const HEADERS = [
  'order_id', 'date', 'status', 'order_total',
  'promotion_ids', 'is_premium_order', 'promotion_discount',
  'item_price', 'quantity_ordered', 'quantity_shipped',
  'unit_count', 'skus', 'asin', 'brand', 'last_updated',
];

const SUMMARY_HEADERS = [
  'brand', 'brand_name', 'month', 'year',
  'total_orders', 'total_units_sold', 'total_canceled_units', 'total_revenue',
  'last_updated',
];

// Brand display name lookup
const BRAND_NAMES = {
  EVO: 'Évolis',
  SVA: 'Skinuva',
  DEC: 'dearcloud',
  CRE: 'The Crème Shop',
  CLC: 'Cloud Cafe',
  MIG: 'MiGuard',
  CIM: 'Cimeosil',
  JBJ: 'Just Bjorn',
  ALA: 'Amala',
  COL: 'Collagelee',
  HIL: 'Hillside',
  PRB: 'Prohibition',
  ERA: 'Eraclea',
  SSS: 'skinside SEOUL',
  PBJ: 'PBJ',
};

// Flat file TSV column names
const COL = {
  orderId:         'amazon-order-id',
  date:            'purchase-date',
  status:          'order-status',
  promotionIds:    'promotion-ids',
  promoDiscount:   'item-promotion-discount',
  itemPrice:       'item-price',
  qtyOrdered:      'quantity',         // flat file uses 'quantity', not 'quantity-purchased'
  qtyShipped:      'quantity-shipped',
  sku:             'sku',
  asin:            'asin',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Default: prior month. On the 5th cron run this is always last month.
  const now          = new Date();
  const defaultYear  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const defaultMonth = now.getMonth() === 0 ? 12 : now.getMonth();

  const year  = parseInt(req.query.year  || defaultYear);
  const month = parseInt(req.query.month || defaultMonth);

  console.log(`[backfill] starting for ${year}-${String(month).padStart(2,'0')}`);

  // ── Request report ─────────────────────────────────────────────────────────
  const { start, end } = monthRange(year, month);
  let reportId;

  try {
    const resp = await spRequest('POST', '/reports/2021-06-30/reports', {}, {
      reportType:     'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      dataStartTime:  start,
      dataEndTime:    end,
      marketplaceIds: [process.env.SP_MARKETPLACE_ID],
    });
    reportId = resp.reportId;
    if (!reportId) throw new Error(`No reportId: ${JSON.stringify(resp)}`);
    console.log(`[backfill] report created: ${reportId}`);
  } catch (err) {
    return res.status(500).json({ error: `Report creation failed: ${err.message}` });
  }

  // ── Poll until ready ────────────────────────────────────────────────────────
  let reportMeta;
  try {
    reportMeta = await pollReport(reportId, 270_000);
    console.log(`[backfill] report ready`);
  } catch (err) {
    return res.status(500).json({ error: `Poll failed: ${err.message}`, reportId });
  }

  // ── Download TSV ───────────────────────────────────────────────────────────
  let tsvText;
  try {
    const docResp = await spRequest('GET', `/reports/2021-06-30/documents/${reportMeta.reportDocumentId}`);
    tsvText = await downloadText(docResp.url);
    console.log(`[backfill] downloaded ${tsvText.length} bytes`);
  } catch (err) {
    return res.status(500).json({ error: `Download failed: ${err.message}` });
  }

  // ── Parse TSV ──────────────────────────────────────────────────────────────
  const lines      = tsvText.trim().split('\n');
  const tsvHeaders = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const allRows    = lines.slice(1).map(line => line.split('\t'));

  // Log headers once for debugging
  console.log(`[backfill] TSV headers: ${tsvHeaders.join(' | ')}`);

  const get = (row, colName) => {
    const idx = tsvHeaders.indexOf(colName.toLowerCase());
    return idx >= 0 ? (row[idx] || '').trim() : '';
  };

  // ── Write per brand ────────────────────────────────────────────────────────
  const results    = [];
  const summaryRows = [];
  const syncTime   = new Date().toISOString();

  for (const brand of brands.filter(b => b.active)) {
    try {
      // Group line items by order, filter to this brand's SKU prefix
      const orderMap = {};

      for (const row of allRows) {
        const sku = get(row, COL.sku);
        if (!sku.toUpperCase().startsWith(brand.skuPrefix.toUpperCase())) continue;

        const orderId = get(row, COL.orderId);
        if (!orderId) continue;

        if (!orderMap[orderId]) {
          orderMap[orderId] = {
            order_id:           orderId,
            date:               get(row, COL.date).slice(0, 10),
            status:             get(row, COL.status),
            order_total:        0,  // summed from item_price below
            promotion_ids:      '',
            is_premium_order:   'FALSE', // not in flat file
            promotion_discount: 0,
            item_price:         0,
            quantity_ordered:   0,
            quantity_shipped:   0,
            skus:               new Set(),
            asins:              new Set(),
          };
        }

        const o = orderMap[orderId];
        const linePrice = parseFloat(get(row, COL.itemPrice) || 0);
        o.promotion_discount = round2(o.promotion_discount + parseFloat(get(row, COL.promoDiscount) || 0));
        o.item_price         = round2(o.item_price + linePrice);
        o.order_total        = o.item_price; // order_total = sum of item_price across brand SKUs
        o.quantity_ordered  += parseInt(get(row, COL.qtyOrdered)  || 0);
        o.quantity_shipped  += parseInt(get(row, COL.qtyShipped)  || 0);
        o.skus.add(sku);

        const asin = get(row, COL.asin);
        if (asin) o.asins.add(asin);

        // Merge promotion IDs across line items
        const linePromos = get(row, COL.promotionIds);
        if (linePromos) {
          const merged = new Set([
            ...o.promotion_ids.split(',').map(s => s.trim()).filter(Boolean),
            ...linePromos.split(',').map(s => s.trim()).filter(Boolean),
          ]);
          o.promotion_ids = [...merged].join(', ');
        }
      }

      const orders = Object.values(orderMap);

      const sheetRows = orders.map(o => [
        o.order_id, o.date, o.status, o.order_total,
        o.promotion_ids, o.is_premium_order, o.promotion_discount,
        o.item_price, o.quantity_ordered, o.quantity_shipped,
        o.quantity_ordered,             // unit_count = quantity_ordered
        [...o.skus].join(', '),
        [...o.asins].join(', '),        // asin column
        brand.id, syncTime,
      ]);

      console.log(`[backfill] ${brand.id} — ${sheetRows.length} orders`);

      if (sheetRows.length > 0) {
        const token = await ensureTab(sheets.ordersHistorical, brand.tabName, HEADERS);
        await replaceMonth(sheets.ordersHistorical, brand.tabName, sheetRows, token, year, month);
        await pruneOldMonths(sheets.ordersHistorical, brand.tabName, token, 18);
      }

      // ── Build summary stats for this brand/month ─────────────────────────
      const nonCanceled  = orders.filter(o => (o.status || '').toLowerCase() !== 'cancelled');
      const canceled     = orders.filter(o => (o.status || '').toLowerCase() === 'cancelled');

      const totalOrders        = nonCanceled.length;
      const totalUnitsSold     = nonCanceled.reduce((s, o) => s + o.quantity_ordered, 0);
      const totalCanceledUnits = canceled.reduce((s, o) => s + o.quantity_ordered, 0);
      const totalRevenue       = round2(nonCanceled.reduce((s, o) => s + o.order_total, 0));
      const brandName          = BRAND_NAMES[brand.skuPrefix.toUpperCase()] || brand.id;

      summaryRows.push({
        brand:                brand.id,
        brand_name:           brandName,
        month,
        year,
        total_orders:         totalOrders,
        total_units_sold:     totalUnitsSold,
        total_canceled_units: totalCanceledUnits,
        total_revenue:        totalRevenue,
        last_updated:         syncTime,
      });

      results.push({ brand: brand.id, status: 'ok', rows: sheetRows.length, year, month });
    } catch (err) {
      console.error(`[backfill] ${brand.id} failed:`, err.message);
      results.push({ brand: brand.id, status: 'error', error: err.message });
    }
  }

  // ── Upsert Summary tab ────────────────────────────────────────────────────
  try {
    await upsertSummary(sheets.ordersHistorical, summaryRows, year, month, syncTime);
    console.log(`[backfill] Summary tab updated — ${summaryRows.length} brand rows for ${year}-${month}`);
  } catch (err) {
    console.error(`[backfill] Summary tab failed:`, err.message);
    // Non-fatal — don't fail the whole job over summary
  }

  res.status(200).json({ synced: results, reportId, year, month, timestamp: syncTime });
};

// ── Upsert Summary tab — one row per brand per month ─────────────────────────
// Finds existing rows for this brand+month+year and replaces them,
// or appends if not found. Never wipes other months' data.
async function upsertSummary(sheetId, newSummaryRows, year, month, syncTime) {
  const token    = await ensureTab(sheetId, 'Summary', SUMMARY_HEADERS);
  const existing = await readRows(sheetId, 'Summary');

  // Remove any existing rows for this exact year+month (all brands being refreshed)
  const brandIds = new Set(newSummaryRows.map(r => r.brand));
  const keep     = existing.filter(row => {
    const sameMonth = parseInt(row.month) === month && parseInt(row.year) === year;
    const thisBrand = brandIds.has(row.brand);
    return !(sameMonth && thisBrand);
  });

  const keepArrays = keep.map(row => SUMMARY_HEADERS.map(h => row[h] ?? ''));
  const newArrays  = newSummaryRows.map(r => SUMMARY_HEADERS.map(h => r[h] ?? ''));

  // Sort combined rows by year desc, month desc, brand asc for readability
  const allArrays = [...keepArrays, ...newArrays];
  allArrays.sort((a, b) => {
    const yearDiff  = parseInt(b[3]) - parseInt(a[3]); // year col index 3
    if (yearDiff !== 0) return yearDiff;
    const monthDiff = parseInt(b[2]) - parseInt(a[2]); // month col index 2
    if (monthDiff !== 0) return monthDiff;
    return (a[0] || '').localeCompare(b[0] || '');     // brand col index 0
  });

  await replaceRows(sheetId, 'Summary', SUMMARY_HEADERS, allArrays, token);
}

// ── replaceMonth — only replaces rows for target year/month ──────────────────
async function replaceMonth(sheetId, tabName, newRows, token, year, month) {
  const existing   = await readRows(sheetId, tabName);
  const keepRows   = existing.filter(row => {
    const d        = row.date || '';
    const rowYear  = parseInt(d.slice(0, 4));
    const rowMonth = parseInt(d.slice(5, 7));
    return !(rowYear === year && rowMonth === month);
  });
  const keptArrays = keepRows.map(row => HEADERS.map(h => row[h] ?? ''));
  await replaceRows(sheetId, tabName, HEADERS, [...keptArrays, ...newRows], token);
  console.log(`[backfill] kept ${keptArrays.length} existing rows, added ${newRows.length} for ${year}-${month}`);
}

// ── Prune rows older than maxMonths ───────────────────────────────────────────
async function pruneOldMonths(sheetId, tabName, token, maxMonths) {
  const now      = new Date();
  const cutoff   = new Date(now.getFullYear(), now.getMonth() - maxMonths, 1);
  const existing = await readRows(sheetId, tabName);
  const keep     = existing.filter(row => {
    const d = new Date(row.date || '2000-01-01');
    return d >= cutoff;
  });

  if (keep.length < existing.length) {
    const pruned = existing.length - keep.length;
    console.log(`[backfill] pruning ${pruned} rows older than ${maxMonths} months`);
    const keepArrays = keep.map(row => HEADERS.map(h => row[h] ?? ''));
    await replaceRows(sheetId, tabName, HEADERS, keepArrays, token);
  }
}

// ── Report polling ────────────────────────────────────────────────────────────
async function pollReport(reportId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`);
    console.log(`[backfill] status: ${resp.processingStatus}`);
    if (resp.processingStatus === 'DONE') return resp;
    if (['FATAL', 'CANCELLED'].includes(resp.processingStatus)) {
      throw new Error(`Report ${resp.processingStatus}`);
    }
    await sleep(8000);
  }
  throw new Error('Report timed out');
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Check for gzip magic bytes
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
          require('zlib').gunzip(buf, (err, decoded) => {
            if (err) return reject(err);
            resolve(decoded.toString('utf8'));
          });
        } else {
          resolve(buf.toString('utf8'));
        }
      });
    }).on('error', reject);
  });
}

function monthRange(year, month) {
  const pad     = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${pad(month)}-01T00:00:00Z`,
    end:   `${year}-${pad(month)}-${pad(lastDay)}T23:59:59Z`,
  };
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const round2 = n  => Math.round(n * 100) / 100;
