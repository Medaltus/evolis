/**
 * amazon-page.js
 * Drop-in module for the Évolis report.
 * Replaces static Amazon Sales page content with live SP-API data.
 *
 * Usage: <script src="/amazon-page.js"></script>
 * (or inline the contents into the main HTML <script> block)
 *
 * Expects these elements to already exist in the DOM (from the main report HTML):
 *   #page-amazon         — the page container
 *   All kpi/chart/table elements listed below
 */

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  const NOW = new Date();
  const YEAR  = NOW.getFullYear();
  const MONTH = NOW.getMonth() + 1; // current month; override as needed

  const ENDPOINTS = {
    sales:    `/api/sales?year=${YEAR}&month=${MONTH}`,
    products: `/api/products?year=${YEAR}&month=${MONTH}&limit=10`,
    ads:      `/api/advertising?year=${YEAR}&month=${MONTH}`,
    subs:     `/api/subscriptions?year=${YEAR}&month=${MONTH}`,
  };

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  // Called by the main nav() function when the Amazon page is first opened.
  window.initAmazonLive = async function () {
    if (window._amazonLiveInit) return;
    window._amazonLiveInit = true;

    showSkeleton();

    try {
      const [salesData, productsData, adsData, subsData] = await Promise.all([
        apiFetch(ENDPOINTS.sales),
        apiFetch(ENDPOINTS.products),
        apiFetch(ENDPOINTS.ads),
        apiFetch(ENDPOINTS.subs),
      ]);

      renderKPIs(salesData, adsData);
      renderRevenueChart(salesData);
      renderTopSellers(productsData);
      renderAdMetrics(adsData);
      renderSubscriptions(subsData);
      hideSkeleton();
    } catch (err) {
      showError(err.message);
    }
  };

  // ── Skeleton / loading states ─────────────────────────────────────────────
  function showSkeleton() {
    document.querySelectorAll('#page-amazon .kpi-value').forEach(el => {
      el.dataset.original = el.textContent;
      el.innerHTML = '<span class="skeleton-val">—</span>';
    });
    document.querySelectorAll('#page-amazon .kpi-mom').forEach(el => {
      el.dataset.original = el.textContent;
      el.textContent = '...';
      el.className = 'kpi-mom flat';
    });
  }

  function hideSkeleton() {
    // Skeletons already replaced by render functions — just remove any remaining
    document.querySelectorAll('#page-amazon .skeleton-val').forEach(el => {
      el.closest('.kpi-value').textContent = el.closest('.kpi-value').dataset.original || '—';
    });
  }

  function showError(msg) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#fff0f0;border-left:3px solid #e05252;padding:14px 18px;border-radius:0 6px 6px 0;font-size:12px;color:#c0392b;margin-bottom:20px;';
    banner.innerHTML = `<strong>Error loading live data:</strong> ${msg}<br><span style="color:#888;font-size:11px;">Displaying last cached data. Check Vercel function logs for details.</span>`;
    document.getElementById('page-amazon').prepend(banner);
    hideSkeleton();
  }

  // ── KPI Cards ─────────────────────────────────────────────────────────────
  function renderKPIs(sales, ads) {
    const c = sales.current;
    const m = sales.mom;
    const adM = ads.mom;

    setKPI('kpi-total-units',    fmt(c.totalUnits),     m?.units,        false);
    setKPI('kpi-total-orders',   fmt(c.totalOrders),    m?.orders,       false);
    setKPI('kpi-avg-order',      '$' + fmt2(c.avgOrder), m?.avgOrder,    false);
    setKPI('kpi-units-ads',      fmt(c.adUnits),        adM?.clicks,     false);
    setKPI('kpi-units-organic',  fmt(c.organicUnits),   m?.organicUnits, false);

    // Also update the ad metrics row if it exists
    if (ads.current) {
      const a = ads.current;
      setKPI('kpi-impressions', fmtK(a.impressions), adM?.impressions, false);
      setKPI('kpi-clicks',      fmt(a.clicks),       adM?.clicks,      false);
      setKPI('kpi-spend',       '$' + fmt2(a.spend), adM?.spend,       true); // lower is better
      setKPI('kpi-acos',        a.acos != null ? a.acos + '%' : 'N/A', adM?.acos, true);
    }
  }

  function setKPI(id, value, momPct, invertColors) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector('.kpi-value').textContent = value;
    const momEl = el.querySelector('.kpi-mom');
    if (!momEl || momPct == null) return;
    const isPositive = invertColors ? momPct < 0 : momPct > 0;
    const cls = momPct === 0 ? 'flat' : isPositive ? 'up' : 'dn';
    momEl.className = `kpi-mom ${cls}`;
    momEl.textContent = Math.abs(momPct) + '% MOM';
  }

  // ── Revenue Chart ─────────────────────────────────────────────────────────
  function renderRevenueChart(sales) {
    const canvas = document.getElementById('chart-amazon');
    if (!canvas) return;

    // Destroy previous Chart instance if any
    if (window._amazonChartInstance) {
      window._amazonChartInstance.destroy();
    }

    const monthly = sales.monthly || [];
    const labels  = monthly.map(d => d.label);
    const data26  = monthly.map(d => d.year === YEAR ? d.revenue : null);
    const data25  = monthly.map(d => d.year === YEAR - 1 ? d.revenue : null);

    window._amazonChartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: String(YEAR),
            data: data26,
            borderColor: '#24e9a3',
            backgroundColor: 'rgba(36,233,163,0.08)',
            fill: true,
            borderWidth: 2.5,
            pointRadius: 3,
            tension: 0.3,
          },
          {
            label: String(YEAR - 1),
            data: data25,
            borderColor: '#f4dfd0',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 2,
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 20, padding: 12 } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y.toLocaleString()}`,
            },
          },
        },
        scales: {
          x: { grid: { color: 'rgba(0,0,0,0.04)' } },
          y: {
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'K' },
          },
        },
      },
    });
  }

  // ── Top Sellers Table ─────────────────────────────────────────────────────
  function renderTopSellers(data) {
    const tbody = document.querySelector('#amazon-top-sellers tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    (data.products || []).forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${p.rank}.</td>
        <td>
          ${escHtml(p.name)}
          ${p.asin ? `<span style="display:block;font-size:10px;color:var(--slate);margin-top:2px;">${p.asin}</span>` : ''}
        </td>
        <td>${fmt(p.unitsSold)}</td>
        <td>$${fmt2(p.revenue)}</td>
        ${p.conversionRate != null
          ? `<td>${p.conversionRate.toFixed(1)}%</td>`
          : '<td style="color:var(--slate);">—</td>'}
      `;
      tbody.appendChild(tr);
    });

    // Update source label
    const srcEl = document.getElementById('amazon-products-source');
    if (srcEl) {
      srcEl.textContent = data.source === 'report'
        ? `Data from Sales & Traffic report · ${data.reportDate}`
        : `Aggregated from order items · ${data.reportDate}`;
    }
  }

  // ── Ad Metrics ────────────────────────────────────────────────────────────
  function renderAdMetrics(ads) {
    const canvas = document.getElementById('chart-ad-impressions');
    if (!canvas || !ads.daily?.length) return;

    if (window._adChartInstance) window._adChartInstance.destroy();

    const labels = ads.daily.map(d => d.date.slice(5)); // MM-DD
    window._adChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Impressions',
            data: ads.daily.map(d => d.impressions),
            backgroundColor: 'rgba(0,31,96,0.7)',
            yAxisID: 'y',
          },
          {
            label: 'Spend ($)',
            data: ads.daily.map(d => d.spend),
            type: 'line',
            borderColor: '#24e9a3',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.3,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 12, padding: 12 } } },
        scales: {
          x: { grid: { display: false } },
          y:  { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { callback: v => fmtK(v) }, position: 'left' },
          y2: { grid: { display: false }, ticks: { callback: v => '$' + v }, position: 'right' },
        },
      },
    });
  }

  // ── Subscribe & Save ──────────────────────────────────────────────────────
  function renderSubscriptions(subs) {
    // Update KPI values on the Opportunities page (they share this data)
    const activeEl = document.getElementById('sns-active-count');
    if (activeEl) activeEl.textContent = fmt(subs.activeSubscriptions);

    const retEl = document.getElementById('sns-retention');
    if (retEl) retEl.textContent = subs.retention90Day != null ? subs.retention90Day + '%' : '—';

    // Re-render SNS chart with live data
    const canvas = document.getElementById('chart-sns');
    if (!canvas || !subs.monthly?.length) return;

    if (window._snsChart) window._snsChart.destroy();

    const labels = subs.monthly.map(d => d.label);
    const data   = subs.monthly.map(d => d.active);
    const colors = subs.monthly.map(d => d.year === YEAR ? '#001f60' : '#6b7ba2');

    window._snsChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Active Subscriptions',
          data,
          backgroundColor: colors,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(0,0,0,0.04)' }, min: 0 },
        },
      },
    });
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  async function apiFetch(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`${url} → ${resp.status}: ${body.slice(0, 120)}`);
    }
    return resp.json();
  }

  const fmt  = n => (n ?? 0).toLocaleString();
  const fmt2 = n => (n ?? 0).toFixed(2);
  const fmtK = n => n >= 1000 ? (n / 1000).toFixed(0) + 'K' : String(n);
  const escHtml = s => s.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

})();
