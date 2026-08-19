/**
 * Magnificent 7 & Big Tech Scorecard — Web Logic
 * Concept: Swiss / Industrial Dark Blotter, Tabular Precision, Verified Citations.
 */

/** Format a decimal fraction as a signed percentage, or an em dash when absent. */
function fmtPct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '\u2014';
  const n = Number(value) * 100;
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

let mag7State = {
  stats: null,
  banks: [],
  stocks: [],
  themes: [],
  calls: [],
  marketSeries: {},
  marketBaseDate: null,
  bankFilter: 'all',
  bankSortBy: 'hit_rate',
  bankSortOrder: 'desc',
  activeChartTicker: 'ALL',
  callSearchQuery: '',
  callTickerFilter: 'all',
  callVerdictFilter: 'all',
  stockExitMode: 'dual',
  callExitFilter: 'dual',
  isSyncing: false,
};

document.addEventListener('DOMContentLoaded', () => {
  initMag7App();
  setupMag7EventListeners();
  initSectionRail();
});

/* Highlight the section currently in view in the sticky rail. Position-based:
   a section taller than the viewport never re-fires an intersection event. */
function initSectionRail() {
  const links = Array.from(document.querySelectorAll('.rail-link'));
  if (!links.length) return;

  const targets = links
    .map(l => ({ link: l, el: document.querySelector(l.getAttribute('href')) }))
    .filter(t => t.el);
  if (!targets.length) return;

  let ticking = false;
  let activeHref = null;

  const sync = () => {
    ticking = false;
    const probe = window.scrollY + 140;
    let current = targets[0];
    for (const t of targets) {
      if (t.el.offsetTop <= probe) current = t;
    }
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 8) {
      current = targets[targets.length - 1];
    }
    const href = current.link.getAttribute('href');
    if (href === activeHref) return;
    activeHref = href;
    targets.forEach(t => t.link.classList.toggle('is-active', t === current));
  };

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(sync);
  }, { passive: true });
  window.addEventListener('resize', sync, { passive: true });
  sync();
}

async function initMag7App() {
  await fetchMag7Data();
}

async function triggerLiveRecalculate() {
  if (mag7State.isSyncing) return;
  mag7State.isSyncing = true;

  const syncBtn = document.getElementById('syncNowBtn');
  const syncTimeEl = document.getElementById('syncTimeText');
  const syncStatusEl = document.getElementById('syncStatusText');

  if (syncBtn) {
    syncBtn.classList.add('spinning');
    syncBtn.innerHTML = '&#8635; RECALCULATING...';
    syncBtn.disabled = true;
  }
  if (syncStatusEl) syncStatusEl.textContent = 'RUNNING MAG 7 PIPELINE...';
  if (syncTimeEl) syncTimeEl.textContent = 'Rebuilding dossiers & alpha rankings...';

  try {
    const syncRes = await fetch('/api/pipeline/sync', { method: 'POST' }).then(r => r.json());
    await fetchMag7Data(true);

    if (syncStatusEl) syncStatusEl.textContent = 'MAG 7 DATA SYNCED';
    if (syncTimeEl) {
      const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      syncTimeEl.innerHTML = `<span style="color: var(--accent-green); font-weight: 600;">✓ Recalculated at ${nowStr} (${syncRes.elapsed_ms || 12}ms)</span>`;
    }
  } catch (err) {
    console.error('Failed to recalculate Mag 7 data:', err);
    if (syncTimeEl) syncTimeEl.textContent = 'Recalculation error. Check connection.';
  } finally {
    mag7State.isSyncing = false;
    if (syncBtn) {
      syncBtn.classList.remove('spinning');
      syncBtn.innerHTML = '&#8635; SYNC NOW';
      syncBtn.disabled = false;
    }
  }
}

async function fetchMag7Data(silent = false) {
  const syncBtn = document.getElementById('syncNowBtn');
  if (syncBtn && !silent) syncBtn.classList.add('spinning');

  try {
    const [statsRes, banksRes, stocksRes, themesRes, callsRes, seriesRes] = await Promise.all([
      fetch('/api/mag7/stats').then(r => r.json()),
      fetch('/api/mag7/scorecard').then(r => r.json()),
      fetch('/api/mag7/stocks').then(r => r.json()),
      fetch('/api/mag7/themes').then(r => r.json()),
      fetch('/api/mag7/calls').then(r => r.json()),
      fetch('/api/mag7/market-series').then(r => r.json()),
    ]);

    mag7State.stats = statsRes;
    mag7State.banks = banksRes;
    mag7State.stocks = stocksRes;
    mag7State.themes = themesRes;
    mag7State.calls = callsRes;
    mag7State.marketSeries = (seriesRes && seriesRes.series) || {};
    mag7State.marketBaseDate = (seriesRes && seriesRes.base_date) || null;

    updateMag7HeaderTicker();
    renderMag7BankLeaderboard();
    renderMag7Chart();
    renderMag7StocksGrid();
    renderMag7Themes();
    renderMag7CallsTable();
    if (!silent) updateSyncTimeText();
  } catch (err) {
    console.error('Failed to load Mag 7 data:', err);
    const syncTimeEl = document.getElementById('syncTimeText');
    if (syncTimeEl) syncTimeEl.textContent = 'Sync error (will retry)';
  } finally {
    if (syncBtn && !silent) syncBtn.classList.remove('spinning');
  }
}

function updateSyncTimeText() {
  const syncTimeEl = document.getElementById('syncTimeText');
  if (syncTimeEl) {
    const now = new Date();
    syncTimeEl.textContent = `Last refreshed: ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }
}

function updateMag7HeaderTicker() {
  if (!mag7State.stats) return;
  const s = mag7State.stats;
  
  const capEl = document.getElementById('tickerMag7Cap');
  if (capEl) capEl.textContent = s.mag7_aggregate_market_cap || '$16.2T';

  const spyEl = document.getElementById('tickerSpyYtd');
  if (spyEl) {
    spyEl.textContent = fmtPct(s.spy_ytd_return);
    spyEl.className = `ticker-val ${(s.spy_ytd_return ?? 0) >= 0 ? 'highlight-gold' : 'color-bear'}`;
  }

  const banksEl = document.getElementById('tickerBanks');
  if (banksEl) banksEl.textContent = s.total_institutions || '10';

  const callsEl = document.getElementById('tickerCalls');
  if (callsEl) callsEl.textContent = s.total_calls || '50';
}

/* ==========================================================================
   01 // Bank-by-Bank Mag 7 Leaderboard
   ========================================================================== */

function renderMag7BankLeaderboard() {
  const tbody = document.getElementById('mag7BankTbody');
  if (!tbody) return;

  let list = [...mag7State.banks];

  // Filter
  if (mag7State.bankFilter === 'top_tier') {
    list = list.filter(b => b.grade === 'A+' || b.grade === 'A' || b.grade === 'A-');
  } else if (mag7State.bankFilter === 'mixed') {
    list = list.filter(b => b.grade !== 'A+' && b.grade !== 'A' && b.grade !== 'A-');
  }

  // Sort
  list.sort((a, b) => {
    let valA, valB;
    if (mag7State.bankSortBy === 'name') {
      valA = a.institution_name.toLowerCase();
      valB = b.institution_name.toLowerCase();
      return mag7State.bankSortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else if (mag7State.bankSortBy === 'avg_alpha') {
      valA = a.avg_alpha;
      valB = b.avg_alpha;
    } else {
      // hit_rate
      valA = a.hit_rate;
      valB = b.hit_rate;
    }
    return mag7State.bankSortOrder === 'asc' ? (valA - valB) : (valB - valA);
  });

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center empty-state">No institutions match the selected filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((b, idx) => {
    const hitPct = b.hit_rate !== null && b.hit_rate !== undefined
      ? `${(b.hit_rate * 100).toFixed(1)}%`
      : 'N/R';
    const alphaClass = b.avg_alpha > 0.05 ? 'highlight-gold font-mono-bold' : (b.avg_alpha < -0.05 ? 'color-bear font-mono-bold' : 'font-mono');

    let gradeBadgeClass = 'grade-b';
    if (b.grade.startsWith('A')) gradeBadgeClass = 'grade-a';
    if (b.grade.startsWith('C')) gradeBadgeClass = 'grade-c';
    if (b.grade.startsWith('D')) gradeBadgeClass = 'grade-d';

    // Flag desks whose curated notes disagreed with their realized numbers.
    const disagreeBadge = b.curated_verdict_disagreements > 0
      ? `<span class="curated-flag" title="Hand-written verdicts that the realized numbers did not support; the scorecard uses the realized numbers.">${b.curated_verdict_disagreements} curated verdict${b.curated_verdict_disagreements === 1 ? '' : 's'} overruled by data</span>`
      : '';

    const bestCallHtml = b.standout_win ? `
      <div class="call-preview-box hit" onclick="openMag7CallModal('${b.standout_win.id}')" style="cursor:pointer;" title="Click to inspect call">
        <span class="preview-tag tag-hit">HIT // ${b.standout_win.ticker}</span>
        <span class="preview-headline">${escapeHtml(b.standout_win.key_quote_or_headline || b.standout_win.thesis_summary)}</span>
        <span class="preview-meta">
          <span class="meta-date-flow">Said: <span class="date-said">${b.standout_win.published_on}</span> &rarr; Happened: <span class="date-happened">${b.standout_win.exit_date}</span></span>
          &middot; Alpha: <strong class="highlight-gold">${fmtPct(b.standout_win.relative_alpha)}</strong>
        </span>
      </div>
    ` : `<div class="call-preview-box empty"><span class="text-muted">&mdash; None on record</span></div>`;

    const worstCallHtml = b.biggest_blunder ? `
      <div class="call-preview-box miss" onclick="openMag7CallModal('${b.biggest_blunder.id}')" style="cursor:pointer;" title="Click to inspect call">
        <span class="preview-tag tag-miss">MISS // ${b.biggest_blunder.ticker}</span>
        <span class="preview-headline">${escapeHtml(b.biggest_blunder.key_quote_or_headline || b.biggest_blunder.thesis_summary)}</span>
        <span class="preview-meta">
          <span class="meta-date-flow">Said: <span class="date-said">${b.biggest_blunder.published_on}</span> &rarr; Happened: <span class="date-happened">${b.biggest_blunder.exit_date}</span></span>
          &middot; Alpha: <strong class="color-bear">${fmtPct(b.biggest_blunder.relative_alpha)}</strong>
        </span>
      </div>
    ` : `<div class="call-preview-box empty"><span class="text-muted">&mdash; None on record</span></div>`;

    return `
      <tr class="mag7-bank-row" data-bank-id="${b.institution_id}">
        <td class="font-bold">
          <div class="bank-name-cell">
            <span class="bank-rank-num">#${idx + 1}</span>
            <div>
              <span class="bank-main-name">${escapeHtml(b.institution_name)}</span>
              <span class="bank-full-sub">${escapeHtml(b.institution_full_name)}</span>
            </div>
          </div>
        </td>
        <td class="text-center">
          <span class="grade-badge ${gradeBadgeClass}">${b.grade}</span>
        </td>
        <td class="text-right font-mono font-bold">
          <span class="${b.hit_rate >= 0.75 ? 'highlight-gold' : (b.hit_rate !== null && b.hit_rate < 0.5 ? 'color-bear' : '')}">${hitPct}</span>
        </td>
        <td class="text-right ${alphaClass}">
          ${fmtPct(b.avg_alpha)}
        </td>
        <td class="text-center font-mono font-bold">
          <span class="color-bull">${b.hits}</span> / <span class="text-muted">${b.resolved}</span>
          ${b.too_early ? `<span class="text-muted" style="font-size:10px;"> (+${b.too_early} open)</span>` : ''}
          ${disagreeBadge}
        </td>
        <td>${bestCallHtml}</td>
        <td>${worstCallHtml}</td>
        <td class="narrative-cell">
          <p class="narrative-text">${escapeHtml(b.narrative)}</p>
        </td>
      </tr>
    `;
  }).join('');
}

/* ==========================================================================
   02 // Interactive Mag 7 Chart & Call Overlays
   ========================================================================== */

function renderMag7Chart() {
  const container = document.getElementById('mag7ChartContainer');
  const svg = document.getElementById('mag7Svg');
  if (!container || !svg || !mag7State.marketSeries) return;

  const width = container.clientWidth || 1080;
  const height = 440;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = '';

  const margin = { top: 25, right: 90, bottom: 40, left: 60 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  // Filter series to render based on activeChartTicker
  const activeTicker = mag7State.activeChartTicker;
  let tickersToDraw = [];

  if (activeTicker === 'ALL') {
    tickersToDraw = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA'];
  } else if (activeTicker === 'BENCHMARKS') {
    tickersToDraw = ['MAG7', 'SPY', 'QQQ', 'RSP'];
  } else {
    tickersToDraw = [activeTicker, 'SPY'];
  }

  // Collect all data points
  let allDates = [];
  let minNorm = 100, maxNorm = 100;

  tickersToDraw.forEach(t => {
    const series = mag7State.marketSeries[t] || [];
    series.forEach(pt => {
      allDates.push(pt.date);
      if (pt.normalized < minNorm) minNorm = pt.normalized;
      if (pt.normalized > maxNorm) maxNorm = pt.normalized;
    });
  });

  if (allDates.length === 0) return;

  const uniqueDates = Array.from(new Set(allDates)).sort();
  // indexOf per point was O(dates) inside an O(points) loop — ~9M comparisons a redraw.
  const dateIndex = new Map(uniqueDates.map((d, i) => [d, i]));
  minNorm = Math.max(20, Math.floor(minNorm / 10) * 10);
  maxNorm = Math.ceil(maxNorm / 50) * 50;

  // Scale functions
  const xScale = (dStr) => {
    const idx = dateIndex.get(dStr) ?? 0;
    return margin.left + (idx / Math.max(1, uniqueDates.length - 1)) * plotWidth;
  };

  const yScale = (normVal) => {
    return margin.top + (1 - (normVal - minNorm) / (maxNorm - minNorm)) * plotHeight;
  };

  // Color mapping
  const tickerColors = {
    'NVDA': '#76B900',
    'AAPL': '#A2AAAD',
    'MSFT': '#00A4EF',
    'AMZN': '#FF9900',
    'GOOGL': '#4285F4',
    'META': '#0081FB',
    'TSLA': '#E82127',
    'SPY': '#C4B56A',
    'QQQ': '#9B51E0',
    'RSP': '#27AE60',
    'MAG7': '#E0C877',
  };

  const baseLabel = document.getElementById('chartBaseLabel');
  if (baseLabel && mag7State.marketBaseDate) {
    baseLabel.textContent = `Normalized Price Returns (Base 100 = ${mag7State.marketBaseDate}) with Sell-Side Entry & Exit Markers`;
  }

  // Update Legend Box
  const legendBox = document.getElementById('chartLegendBox');
  if (legendBox) {
    legendBox.innerHTML = tickersToDraw.map(t => `
      <span class="legend-item">
        <span class="legend-color-dot" style="background-color: ${tickerColors[t] || '#fff'};"></span>
        <strong style="color: ${tickerColors[t] || '#fff'};">${t}</strong>
        <span class="legend-ret">${getLatestReturnText(t)}</span>
      </span>
    `).join('');
  }

  // Draw Grid Lines
  const gridGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  gridGroup.setAttribute('class', 'chart-grid');

  // Baseline 100
  const y100 = yScale(100);
  const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  baseline.setAttribute('x1', margin.left);
  baseline.setAttribute('x2', margin.left + plotWidth);
  baseline.setAttribute('y1', y100);
  baseline.setAttribute('y2', y100);
  baseline.setAttribute('stroke', '#4a443b');
  baseline.setAttribute('stroke-dasharray', '4,4');
  gridGroup.appendChild(baseline);

  // Y-axis grid ticks
  const yTicks = [50, 100, 200, 300, 500, 800, 1200].filter(v => v >= minNorm && v <= maxNorm);
  yTicks.forEach(val => {
    const y = yScale(val);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('x2', margin.left + plotWidth);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', '#26221d');
    gridGroup.appendChild(line);

    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', margin.left - 8);
    txt.setAttribute('y', y + 4);
    txt.setAttribute('text-anchor', 'end');
    txt.setAttribute('fill', '#888');
    txt.setAttribute('font-size', '11px');
    txt.setAttribute('font-family', 'IBM Plex Mono');
    txt.textContent = `${val >= 100 ? '+' : ''}${val - 100}%`;
    gridGroup.appendChild(txt);
  });

  // X-axis year ticks (2022, 2023, 2024, 2025, 2026)
  const years = [uniqueDates[0], '2023-01-03', '2024-01-02', '2025-01-02', '2026-01-02', uniqueDates[uniqueDates.length - 1]]
    .filter((d, i, arr) => d && arr.indexOf(d) === i);
  years.forEach(dStr => {
    const idx = uniqueDates.findIndex(d => d >= dStr);
    if (idx !== -1) {
      const x = margin.left + (idx / (uniqueDates.length - 1)) * plotWidth;
      const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      vLine.setAttribute('x1', x);
      vLine.setAttribute('x2', x);
      vLine.setAttribute('y1', margin.top);
      vLine.setAttribute('y2', margin.top + plotHeight);
      vLine.setAttribute('stroke', '#221f1a');
      gridGroup.appendChild(vLine);

      const yrText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      yrText.setAttribute('x', x);
      yrText.setAttribute('y', margin.top + plotHeight + 18);
      yrText.setAttribute('text-anchor', 'middle');
      yrText.setAttribute('fill', '#999');
      yrText.setAttribute('font-size', '11px');
      yrText.setAttribute('font-family', 'IBM Plex Mono');
      yrText.textContent = dStr.split('-')[0];
      if (dStr === uniqueDates[0]) yrText.textContent = dStr;
      gridGroup.appendChild(yrText);
    }
  });

  svg.appendChild(gridGroup);

  // Draw Line Paths for each ticker
  tickersToDraw.forEach(t => {
    const series = mag7State.marketSeries[t] || [];
    if (series.length === 0) return;

    let pathD = '';
    series.forEach((pt, i) => {
      const x = xScale(pt.date);
      const y = yScale(pt.normalized);
      pathD += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
    });

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', tickerColors[t] || '#fff');
    path.setAttribute('stroke-width', (t === activeTicker || activeTicker === 'ALL') ? '2.2' : '1.5');
    path.setAttribute('opacity', (activeTicker !== 'ALL' && activeTicker !== 'BENCHMARKS' && t === 'SPY') ? '0.6' : '0.9');
    svg.appendChild(path);

    // Label at end of line
    const lastPt = series[series.length - 1];
    if (lastPt) {
      const lx = margin.left + plotWidth + 6;
      const ly = yScale(lastPt.normalized);
      const lText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lText.setAttribute('x', lx);
      lText.setAttribute('y', ly + 4);
      lText.setAttribute('fill', tickerColors[t] || '#fff');
      lText.setAttribute('font-size', '11px');
      lText.setAttribute('font-weight', 'bold');
      lText.setAttribute('font-family', 'IBM Plex Mono');
      lText.textContent = `${t} (${lastPt.return_pct >= 0 ? '+' : ''}${lastPt.return_pct}%)`;
      svg.appendChild(lText);
    }
  });

  // Draw Research Call Markers & Target Price Lines Overlay
  const callsToDraw = mag7State.calls.filter(c => {
    if (activeTicker === 'ALL') return true;
    if (activeTicker === 'BENCHMARKS') return c.ticker === 'MAG7_BASKET';
    return c.ticker === activeTicker;
  });

  const targetsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  targetsGroup.setAttribute('class', 'chart-target-lines');

  const markersGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  markersGroup.setAttribute('class', 'chart-call-markers');

  callsToDraw.forEach(c => {
    const series = mag7State.marketSeries[c.ticker === 'MAG7_BASKET' ? 'MAG7' : c.ticker] || [];
    const pt = series.find(p => p.date >= c.published_on) || series[0];
    if (!pt) return;

    const cx = xScale(pt.date);
    const cy = yScale(pt.normalized);

    // Calculate Target Price Y Level
    let targetImplied = c.target_implied_return;
    if (targetImplied === null || targetImplied === undefined) {
      if (c.target_price_adjusted && c.spot_at_publication) {
        targetImplied = (c.target_price_adjusted / c.spot_at_publication) - 1.0;
      } else if (c.target_price && c.spot_at_publication) {
        targetImplied = (c.target_price / c.spot_at_publication) - 1.0;
      } else {
        targetImplied = c.rating_or_stance === 'OVERWEIGHT' ? 0.30 : (c.rating_or_stance === 'UNDERWEIGHT' ? -0.20 : 0.0);
      }
    }

    const targetNorm = pt.normalized * (1 + targetImplied);
    let ty = yScale(targetNorm);
    ty = Math.max(margin.top + 8, Math.min(margin.top + plotHeight - 8, ty));

    const isUpside = ty <= cy;
    const lineColor = c.verdict === 'HIT' ? '#38bdf8' : (c.verdict === 'MISS' ? '#f87171' : '#c4b56a');
    const sign = targetImplied >= 0 ? '+' : '';
    const retPctStr = `${sign}${(targetImplied * 100).toFixed(0)}%`;
    const targetLabelText = c.target_price ? `${c.institution_id} $${c.target_price} (${retPctStr})` : `${c.institution_id} (${c.rating_or_stance})`;

    // 1. Vertical Target Stalk Line
    const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    vLine.setAttribute('x1', cx);
    vLine.setAttribute('y1', cy);
    vLine.setAttribute('x2', cx);
    vLine.setAttribute('y2', ty);
    vLine.setAttribute('stroke', lineColor);
    vLine.setAttribute('stroke-width', activeTicker === 'ALL' ? '1.2' : '1.6');
    vLine.setAttribute('stroke-dasharray', '3,3');
    vLine.setAttribute('opacity', activeTicker === 'ALL' ? '0.7' : '0.9');
    vLine.setAttribute('class', 'chart-target-vline');
    vLine.setAttribute('data-call-id', c.id);
    targetsGroup.appendChild(vLine);

    // 2. Target Diamond Pin
    const pin = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    const pSize = activeTicker === 'ALL' ? 3.5 : 4.5;
    pin.setAttribute('points', `${cx},${ty - pSize} ${cx + pSize},${ty} ${cx},${ty + pSize} ${cx - pSize},${ty}`);
    pin.setAttribute('fill', lineColor);
    pin.setAttribute('stroke', '#0c1017');
    pin.setAttribute('stroke-width', '1');
    pin.setAttribute('class', 'chart-target-pin');
    pin.setAttribute('data-call-id', c.id);
    targetsGroup.appendChild(pin);

    // 3. Target Label Badge (Shown on single stock views or hover)
    if (activeTicker !== 'ALL') {
      const badgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      badgeGroup.setAttribute('class', 'chart-target-badge');
      badgeGroup.setAttribute('data-call-id', c.id);

      const approxW = targetLabelText.length * 5.8 + 8;
      const badgeY = isUpside ? ty - 18 : ty + 6;

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', cx - approxW / 2);
      rect.setAttribute('y', badgeY);
      rect.setAttribute('width', approxW);
      rect.setAttribute('height', '13');
      rect.setAttribute('rx', '3');
      rect.setAttribute('fill', '#070b12');
      rect.setAttribute('stroke', lineColor);
      rect.setAttribute('stroke-width', '0.75');
      rect.setAttribute('opacity', '0.92');

      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', cx);
      txt.setAttribute('y', badgeY + 9.5);
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('font-family', 'IBM Plex Mono');
      txt.setAttribute('font-size', '8.5px');
      txt.setAttribute('font-weight', '700');
      txt.setAttribute('fill', lineColor);
      txt.textContent = targetLabelText;

      badgeGroup.appendChild(rect);
      badgeGroup.appendChild(txt);
      targetsGroup.appendChild(badgeGroup);

      badgeGroup.addEventListener('mouseenter', (e) => showChartCallTooltip(e, c, pt));
      badgeGroup.addEventListener('mouseleave', hideChartTooltip);
      badgeGroup.addEventListener('click', () => openMag7CallModal(c.id));
    }

    [vLine, pin].forEach(el => {
      el.addEventListener('mouseenter', (e) => showChartCallTooltip(e, c, pt));
      el.addEventListener('mouseleave', hideChartTooltip);
      el.addEventListener('click', () => openMag7CallModal(c.id));
    });

    // 4. Spot Publication Marker (Circle at entry point cx, cy)
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', activeTicker === 'ALL' ? '4.5' : '5.5');
    circle.setAttribute('fill', c.verdict === 'HIT' ? '#0072B2' : (c.verdict === 'MISS' ? '#D55E00' : '#C4B56A'));
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', '1.5');
    circle.setAttribute('class', 'chart-marker-interactive');
    circle.setAttribute('data-call-id', c.id);

    circle.addEventListener('mouseenter', (e) => showChartCallTooltip(e, c, pt));
    circle.addEventListener('mouseleave', hideChartTooltip);
    circle.addEventListener('click', () => openMag7CallModal(c.id));

    markersGroup.appendChild(circle);
  });

  svg.appendChild(targetsGroup);
  svg.appendChild(markersGroup);
}

function getLatestReturnText(ticker) {
  const series = mag7State.marketSeries[ticker] || [];
  if (series.length === 0) return '';
  const last = series[series.length - 1];
  return `${last.return_pct >= 0 ? '+' : ''}${last.return_pct}%`;
}

function showChartCallTooltip(e, call, point) {
  const tooltip = document.getElementById('chartTooltip');
  if (!tooltip) return;

  const hitClass = call.verdict === 'HIT' ? 'tag-hit' : (call.verdict === 'MISS' ? 'tag-miss' : 'tag-neutral');
  const targetFormatted = call.target_price ? `$${call.target_price}` : call.rating_or_stance;
  const impliedReturnFormatted = call.target_implied_return !== null ? `${call.target_implied_return >= 0 ? '+' : ''}${(call.target_implied_return * 100).toFixed(1)}%` : '—';

  tooltip.innerHTML = `
    <div class="chart-tt-header">
      <span class="preview-tag ${hitClass}">${call.verdict} // ${call.ticker}</span>
      <span class="chart-tt-date font-mono">${call.published_on} &rarr; ${call.exit_date}</span>
    </div>
    <div class="chart-tt-body">
      <div class="chart-tt-inst">
        <strong>${escapeHtml(call.institution_name)}</strong> &middot; <span>${escapeHtml(call.strategist_or_analyst || 'Research')}</span>
      </div>
      <p class="chart-tt-headline">"${escapeHtml(call.key_quote_or_headline || call.thesis_summary)}"</p>
      <div class="chart-tt-journey">
        <div class="tt-journey-item">
          <span class="tt-j-label">1 // WHEN SAID (SPOT)</span>
          <span class="tt-j-val font-mono">${call.published_on}</span>
          <span class="tt-j-sub font-mono">Spot: $${call.spot_at_publication.toFixed(2)}</span>
        </div>
        <div class="tt-journey-arrow">&rarr;</div>
        <div class="tt-journey-item">
          <span class="tt-j-label">REPORT TARGET</span>
          <span class="tt-j-val font-mono color-switch">${targetFormatted}</span>
          <span class="tt-j-sub font-mono">Implied: ${impliedReturnFormatted}</span>
        </div>
        <div class="tt-journey-arrow">&rarr;</div>
        <div class="tt-journey-item">
          <span class="tt-j-label">2 // REALIZED EXIT</span>
          <span class="tt-j-val font-mono highlight-gold">${call.exit_date}</span>
          <span class="tt-j-sub font-mono">Exit: $${call.exit_spot ? call.exit_spot.toFixed(2) : '—'}</span>
        </div>
      </div>
      <div class="chart-tt-metrics">
        <span>Stance: <strong>${call.rating_or_stance}</strong></span>
        <span>Target: <strong class="color-switch">${targetFormatted}</strong></span>
        <span>Alpha: <strong class="${(call.relative_alpha||0) >= 0 ? 'highlight-gold' : 'color-bear'}">${((call.relative_alpha||0)*100).toFixed(1)}%</strong></span>
      </div>
      <div class="chart-tt-outcome-box">
        <span class="tt-outcome-label">MARKET OUTCOME:</span>
        <p class="tt-outcome-text">${escapeHtml(call.market_outcome)}</p>
      </div>
      <span class="chart-tt-click-note">Click marker or target line to inspect complete call audit &nearr;</span>
    </div>
  `;

  tooltip.style.display = 'block';
  tooltip.style.left = `${e.pageX + 15}px`;
  tooltip.style.top = `${e.pageY - 20}px`;
}

function hideChartTooltip() {
  const tooltip = document.getElementById('chartTooltip');
  if (tooltip) tooltip.style.display = 'none';
}

/* ==========================================================================
   03 // Stock-by-Stock Deep Dive Matrix
   ========================================================================== */

function renderMag7StocksGrid() {
  const grid = document.getElementById('mag7StocksGrid');
  if (!grid) return;

  const mode = mag7State.stockExitMode || 'dual';

  grid.innerHTML = mag7State.stocks.map(s => {
    const ytdSign = s.return_ytd_2026 >= 0 ? '+' : '';
    const ytdClass = s.return_ytd_2026 >= 0 ? 'highlight-gold' : 'color-bear';
    const hitPct = (s.hit_rate * 100).toFixed(1);

    const bullTags = s.bull_banks.map(b => `<span class="badge-bull-bank">${b}</span>`).join(' ');
    const bearTags = s.bear_banks.map(b => `<span class="badge-bear-bank">${b}</span>`).join(' ');

    const callsList = s.calls || [];
    const displayTicker = s.ticker === 'MAG7_BASKET' ? 'BASKET' : s.ticker;

    const callsTimelineHtml = callsList.map(c => {
      const verdictClass = c.verdict === 'HIT' ? 'tag-hit' : (c.verdict === 'MISS' ? 'tag-miss' : 'tag-neutral');
      const retStock = fmtPct(c.realized_stock_return);
      const alphaVal = fmtPct(c.relative_alpha);
      const alphaClass = (c.relative_alpha||0) > 0.02 ? 'highlight-gold' : ((c.relative_alpha||0) < -0.02 ? 'color-bear' : '');

      const retSwitchStock = fmtPct(c.switch_stock_return);
      const alphaSwitchVal = fmtPct(c.switch_alpha);
      const alphaSwitchClass = (c.switch_alpha||0) > 0.02 ? 'highlight-gold' : ((c.switch_alpha||0) < -0.02 ? 'color-bear' : '');

      const targetText = c.target_price ? `$${c.target_price}` : c.rating_or_stance;

      let trackHtml = '';
      if (mode === 'dual') {
        trackHtml = `
          <div class="sct-timeline-dual-track">
            <div class="sct-dual-entry-row font-mono">
              <div class="sct-entry-left">
                <span class="sct-step-badge">1 // WHEN SAID</span>
                <span class="sct-step-date font-bold">${c.published_on}</span>
              </div>
              <span class="sct-step-price text-muted">Spot: $${c.spot_at_publication.toFixed(2)}</span>
            </div>

            <div class="sct-dual-realizations-grid">
              <div class="sct-dual-step horizon">
                <div class="sct-step-badge">2A // HORIZON EXIT (${c.forecast_horizon})</div>
                <div class="sct-step-date font-mono highlight-gold">${c.exit_date}</div>
                <div class="sct-step-price font-mono">Exit: $${c.exit_spot ? c.exit_spot.toFixed(2) : '\u2014'}</div>
                <div class="sct-step-mini-ret font-mono">
                  Stock: <strong class="${(c.realized_stock_return||0)>=0?'color-bull':'color-bear'}">${retStock}</strong> &middot; Alpha: <strong class="${alphaClass}">${alphaVal}</strong>
                </div>
              </div>

              <div class="sct-dual-step switch">
                <div class="sct-step-badge">2B // POSITION SWITCH EXIT</div>
                <div class="sct-step-date font-mono color-switch">${c.switch_date} <span class="sct-days-tag">${c.switch_duration_days}d</span></div>
                <div class="sct-step-price font-mono">Exit: $${c.switch_spot ? c.switch_spot.toFixed(2) : '\u2014'}</div>
                <div class="sct-step-mini-ret font-mono">
                  Stock: <strong class="${(c.switch_stock_return||0)>=0?'color-bull':'color-bear'}">${retSwitchStock}</strong> &middot; Alpha: <strong class="${alphaSwitchClass}">${alphaSwitchVal}</strong>
                </div>
              </div>
            </div>
          </div>
        `;
      } else if (mode === 'switch') {
        trackHtml = `
          <div class="sct-timeline-track">
            <div class="sct-time-step said">
              <div class="sct-step-badge">1 // WHEN SAID</div>
              <div class="sct-step-date font-mono">${c.published_on}</div>
              <div class="sct-step-price font-mono text-muted">Entry: $${c.spot_at_publication.toFixed(2)}</div>
            </div>

            <div class="sct-time-connector">
              <span class="sct-horizon-tag switch-tag font-mono">${c.switch_duration_days}d HELD</span>
              <div class="sct-line"></div>
              <span class="sct-arrow">&rarr;</span>
            </div>

            <div class="sct-time-step happened">
              <div class="sct-step-badge">2 // POSITION SWITCH</div>
              <div class="sct-step-date font-mono color-switch">${c.switch_date}</div>
              <div class="sct-step-price font-mono font-bold">Exit: $${c.switch_spot ? c.switch_spot.toFixed(2) : '\u2014'}</div>
            </div>
          </div>

          <div class="sct-returns-row">
            <span class="sct-ret-item">Stock: <strong class="${(c.switch_stock_return||0) >= 0 ? 'color-bull' : 'color-bear'} font-mono">${retSwitchStock}</strong></span>
            <span class="sct-ret-item">SPY: <strong class="text-muted font-mono">${((c.switch_spy_return||0)*100).toFixed(1)}%</strong></span>
            <span class="sct-ret-item">Alpha: <strong class="${alphaSwitchClass} font-mono">${alphaSwitchVal}</strong></span>
          </div>
        `;
      } else {
        // horizon mode
        trackHtml = `
          <div class="sct-timeline-track">
            <div class="sct-time-step said">
              <div class="sct-step-badge">1 // WHEN SAID</div>
              <div class="sct-step-date font-mono">${c.published_on}</div>
              <div class="sct-step-price font-mono text-muted">Entry: $${c.spot_at_publication.toFixed(2)}</div>
            </div>

            <div class="sct-time-connector">
              <span class="sct-horizon-tag font-mono">${c.forecast_horizon}</span>
              <div class="sct-line"></div>
              <span class="sct-arrow">&rarr;</span>
            </div>

            <div class="sct-time-step happened">
              <div class="sct-step-badge">2 // REALIZED HORIZON</div>
              <div class="sct-step-date font-mono highlight-gold">${c.exit_date}</div>
              <div class="sct-step-price font-mono font-bold">Exit: $${c.exit_spot ? c.exit_spot.toFixed(2) : '\u2014'}</div>
            </div>
          </div>

          <div class="sct-returns-row">
            <span class="sct-ret-item">Stock: <strong class="${(c.realized_stock_return||0) >= 0 ? 'color-bull' : 'color-bear'} font-mono">${retStock}</strong></span>
            <span class="sct-ret-item">SPY: <strong class="text-muted font-mono">${((c.realized_spy_return||0)*100).toFixed(1)}%</strong></span>
            <span class="sct-ret-item">Alpha: <strong class="${alphaClass} font-mono">${alphaVal}</strong></span>
          </div>
        `;
      }

      return `
        <div class="stock-call-timeline-item" onclick="openMag7CallModal('${c.id}')" title="Click to inspect full audit modal">
          <div class="sct-header">
            <div class="sct-inst-box">
              <span class="sct-inst-name font-bold">${escapeHtml(c.institution_name)}</span>
              <span class="sct-analyst text-muted">&middot; ${escapeHtml(c.strategist_or_analyst || 'Desk')}</span>
            </div>
            <div class="sct-badge-box">
              <span class="preview-tag ${verdictClass}">${c.verdict}</span>
              <span class="sct-stance-pill font-mono">${escapeHtml(c.rating_or_stance)} (${targetText})</span>
            </div>
          </div>

          ${trackHtml}

          <div class="sct-switch-status">
            <span class="switch-pill ${c.has_switched ? 'pill-switched' : 'pill-active'}">${c.has_switched ? 'POSITION REVISED' : 'ACTIVE STANDING'}</span>
            <span class="switch-desc">${escapeHtml(c.switch_reason)}</span>
          </div>

          <div class="sct-narrative-box">
            <p class="sct-quote">"${escapeHtml(c.key_quote_or_headline || c.thesis_summary)}"</p>
            <p class="sct-outcome"><strong>Market Event:</strong> ${escapeHtml(c.market_outcome)}</p>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="stock-card" data-ticker="${s.ticker}">
        <div class="stock-card-header">
          <div class="stock-card-title-box">
            <span class="stock-ticker-badge ${s.ticker === 'MAG7_BASKET' ? 'badge-basket' : ''}" style="border-color: ${s.color}; color: ${s.color};">${displayTicker}</span>
            <div class="stock-name-box">
              <h3>${escapeHtml(s.name)}</h3>
              <span class="stock-sector">${escapeHtml(s.sector)}</span>
            </div>
          </div>
          <div class="stock-cap-badge">
            <span class="stock-cap-label">MKT CAP</span>
            <span class="stock-cap-val">${s.market_cap}</span>
          </div>
        </div>

        <div class="stock-price-row">
          <div class="stock-price-box">
            <span class="stock-price-label">${s.is_basket ? 'EQUAL-WEIGHT INDEX (BASE 1000)' : 'MASSIVE CLOSE'}</span>
            <span class="stock-price-val">${s.is_basket ? '' : '$'}${s.latest_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div class="stock-price-box text-right">
            <span class="stock-price-label">2026 YTD</span>
            <span class="stock-price-val ${ytdClass}">${fmtPct(s.return_ytd_2026)}</span>
          </div>
        </div>

        <div class="stock-theme-box">
          <span class="theme-tag-label">KEY WALL ST DEBATE:</span>
          <p class="theme-text">${escapeHtml(s.key_theme)}</p>
        </div>

        <div class="stock-audited-stats">
          <div class="audited-stat-box">
            <span class="stat-mini-label">AUDITED CALLS</span>
            <span class="stat-mini-val font-mono">${s.total_calls}</span>
          </div>
          <div class="audited-stat-box">
            <span class="stat-mini-label">WALL ST HIT RATE</span>
            <span class="stat-mini-val font-mono ${s.hit_rate >= 0.7 ? 'highlight-gold' : ''}">${hitPct}%</span>
          </div>
          <div class="audited-stat-box">
            <span class="stat-mini-label">HITS / MISSES</span>
            <span class="stat-mini-val font-mono"><strong class="color-bull">${s.hits}</strong> / <strong class="color-bear">${s.misses}</strong></span>
          </div>
        </div>

        <div class="stock-bank-camps">
          <div class="camp-row">
            <span class="camp-label">BULL DESKS:</span>
            <div class="camp-tags">${bullTags || '<span class="text-muted">None</span>'}</div>
          </div>
          <div class="camp-row">
            <span class="camp-label">SKEPTIC / HOLD:</span>
            <div class="camp-tags">${bearTags || '<span class="text-muted">None</span>'}</div>
          </div>
        </div>

        <!-- Section: Audited Research Calls Timeline (When Said -> When Happened) -->
        <div class="stock-calls-section">
          <div class="stock-calls-header">
            <span class="stock-calls-title">AUDITED CALLS // ${callsList.length} CALLS</span>
            <span class="stock-calls-badge font-mono">${mode.toUpperCase()} VIEW</span>
          </div>
          <div class="stock-calls-timeline-list">
            ${callsTimelineHtml}
          </div>
        </div>

        <div class="stock-card-footer">
          <button class="view-stock-calls-btn" onclick="filterCallsByStock('${s.ticker}')">
            FILTER BLOTTER BY ${s.ticker} (${s.total_calls} CALLS) &rarr;
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/* ==========================================================================
   04 // The 4 Big Tech Thematic Audits
   ========================================================================== */

function renderMag7Themes() {
  const container = document.getElementById('themesContainer');
  if (!container) return;

  container.innerHTML = mag7State.themes.map((t, idx) => {
    // Editorial claims are shown with the desk's actual scored record on this
    // dossier's hero stocks, and flagged when the two disagree.
    const recordLine = (e) => {
      const r = e.record;
      if (!r) return '';
      const alpha = r.avg_alpha !== null && r.avg_alpha !== undefined ? ` \u00B7 avg alpha ${fmtPct(r.avg_alpha)}` : '';
      const flag = e.contradicted
        ? `<span class="curated-flag">scored record does not support this</span>`
        : '';
      return `<div class="party-record font-mono">${r.hits}H / ${r.misses}M${r.too_early ? ` / ${r.too_early} open` : ''}${alpha} ${flag}</div>`;
    };

    const winnersHtml = t.key_winners.map(w => `
      <div class="theme-party winner${w.contradicted ? ' contradicted' : ''}">
        <div class="party-badge tag-hit">&check; RIGHT // ${escapeHtml(w.bank)}</div>
        <div class="party-meta">${escapeHtml(w.strategist)}: ${escapeHtml(w.call)}</div>
        ${recordLine(w)}
      </div>
    `).join('');

    const losersHtml = t.key_losers.map(l => `
      <div class="theme-party loser${l.contradicted ? ' contradicted' : ''}">
        <div class="party-badge tag-miss">&cross; WRONG // ${escapeHtml(l.bank)}</div>
        <div class="party-meta">${escapeHtml(l.strategist)}: ${escapeHtml(l.call)}</div>
        ${recordLine(l)}
      </div>
    `).join('');

    return `
      <div class="theme-dossier-card">
        <div class="theme-dossier-header">
          <span class="dossier-num">DOSSIER 0${idx + 1}</span>
          <h3>${escapeHtml(t.title)}</h3>
          <span class="dossier-subtitle">${escapeHtml(t.subtitle)}</span>
        </div>
        <div class="theme-dossier-body">
          <p class="dossier-narrative">${escapeHtml(t.narrative)}</p>
          <div class="dossier-verdicts-grid">
            <div class="verdicts-col">
              <h4>PRESCIENT CALLS (HITS)</h4>
              ${winnersHtml}
            </div>
            <div class="verdicts-col">
              <h4>FAILED WARNINGS &amp; SKEPTICISM (MISSES)</h4>
              ${losersHtml}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/* ==========================================================================
   05 // Complete Mag 7 Calls Blotter
   ========================================================================== */

function renderMag7CallsTable() {
  const tbody = document.getElementById('mag7CallsTbody');
  if (!tbody) return;

  let list = [...mag7State.calls];

  // Search Filter
  if (mag7State.callSearchQuery) {
    const q = mag7State.callSearchQuery.toLowerCase();
    list = list.filter(c => 
      c.institution_name.toLowerCase().includes(q) ||
      (c.strategist_or_analyst && c.strategist_or_analyst.toLowerCase().includes(q)) ||
      c.ticker.toLowerCase().includes(q) ||
      (c.key_quote_or_headline && c.key_quote_or_headline.toLowerCase().includes(q)) ||
      (c.thesis_summary && c.thesis_summary.toLowerCase().includes(q)) ||
      (c.market_outcome && c.market_outcome.toLowerCase().includes(q)) ||
      (c.switch_reason && c.switch_reason.toLowerCase().includes(q)) ||
      c.published_on.includes(q) ||
      c.exit_date.includes(q) ||
      (c.switch_date && c.switch_date.includes(q))
    );
  }

  // Ticker Filter
  if (mag7State.callTickerFilter !== 'all') {
    list = list.filter(c => c.ticker === mag7State.callTickerFilter);
  }

  // Verdict Filter
  if (mag7State.callVerdictFilter !== 'all') {
    list = list.filter(c => c.verdict === mag7State.callVerdictFilter);
  }

  // Exit Mode Filter
  const exitFilter = mag7State.callExitFilter || 'dual';
  if (exitFilter === 'switch') {
    list = list.filter(c => c.has_switched === 1 || c.switch_date);
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="text-center empty-state">No research calls match your search and filter criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(c => {
    const retStock = fmtPct(c.realized_stock_return);
    const retSpy = fmtPct(c.realized_spy_return);
    const alphaVal = fmtPct(c.relative_alpha);
    const alphaClass = (c.relative_alpha||0) > 0.02 ? 'highlight-gold font-mono-bold' : ((c.relative_alpha||0) < -0.02 ? 'color-bear font-mono-bold' : 'font-mono');

    const retSwitch = fmtPct(c.switch_stock_return);
    const alphaSwitch = fmtPct(c.switch_alpha);
    const alphaSwitchClass = (c.switch_alpha||0) > 0.02 ? 'highlight-gold font-mono-bold' : ((c.switch_alpha||0) < -0.02 ? 'color-bear font-mono-bold' : 'font-mono');

    const verdictTagClass = c.verdict === 'HIT' ? 'tag-hit' : (c.verdict === 'MISS' ? 'tag-miss' : 'tag-neutral');

    const isBasket = c.ticker === 'MAG7_BASKET';
    const unit = isBasket ? '' : '$';
    const targetText = c.target_price ? `$${c.target_price}` : (c.rating_or_stance || 'OVERWEIGHT');

    let exitCellHtml = '';
    if (exitFilter === 'switch') {
      exitCellHtml = `
        <div class="when-happened-cell">
          <span class="date-main color-switch font-bold">${c.switch_date}</span>
          <span class="horizon-badge switch-badge font-mono">${c.switch_duration_days}d HELD</span>
        </div>
      `;
    } else if (exitFilter === 'horizon') {
      exitCellHtml = `
        <div class="when-happened-cell">
          <span class="date-main highlight-gold font-bold">${c.exit_date}</span>
          <span class="horizon-badge font-mono">${c.forecast_horizon}</span>
        </div>
      `;
    } else {
      // dual
      exitCellHtml = `
        <div class="when-happened-cell">
          <div class="exit-line-item"><span class="exit-type-tag">HORIZON:</span> <span class="date-main highlight-gold font-bold">${c.exit_date}</span> <span class="horizon-badge font-mono">${c.forecast_horizon}</span></div>
          <div class="exit-line-item"><span class="exit-type-tag">SWITCH:</span> <span class="date-main color-switch font-bold">${c.switch_date}</span> <span class="horizon-badge switch-badge font-mono">${c.switch_duration_days}d</span></div>
        </div>
      `;
    }

    const displayedReturn = exitFilter === 'switch' ? retSwitch : retStock;
    const displayedReturnRaw = exitFilter === 'switch' ? c.switch_stock_return : c.realized_stock_return;
    const displayedAlpha = exitFilter === 'switch' ? alphaSwitch : alphaVal;
    const displayedAlphaClass = exitFilter === 'switch' ? alphaSwitchClass : alphaClass;
    const displayedExitSpot = exitFilter === 'switch' ? c.switch_spot : c.exit_spot;

    return `
      <tr class="interactive-call-row" onclick="openMag7CallModal('${c.id}')" title="Click row to inspect full call audit">
        <td class="font-mono">
          <div class="when-said-cell">
            <span class="date-main font-bold">${c.published_on}</span>
            <span class="date-sub text-muted">Published</span>
          </div>
        </td>
        <td class="font-mono">
          ${exitCellHtml}
        </td>
        <td class="font-bold">${escapeHtml(c.institution_name)}</td>
        <td>
          <span class="ticker-pill">${c.ticker}</span>
        </td>
        <td>${escapeHtml(c.strategist_or_analyst || 'Research Desk')}</td>
        <td class="font-mono font-bold">${escapeHtml(c.rating_or_stance)} (${targetText})</td>
        <td class="font-mono text-right">
          <div class="spot-journey-cell">
            <span class="spot-entry text-muted">${unit}${c.spot_at_publication.toFixed(2)}</span>
            <span class="spot-arrow">&rarr;</span>
            <span class="spot-exit font-bold">${displayedExitSpot ? unit + displayedExitSpot.toFixed(2) : '\u2014'}</span>
          </div>
        </td>
        <td class="font-mono text-right ${displayedReturnRaw === null || displayedReturnRaw === undefined ? 'text-muted' : (displayedReturnRaw >= 0 ? 'color-bull font-bold' : 'color-bear font-bold')}">${displayedReturn}</td>
        <td class="font-mono text-right text-muted">${retSpy}</td>
        <td class="text-right ${displayedAlphaClass}">${displayedAlpha}</td>
        <td class="text-center">
          <span class="preview-tag ${verdictTagClass}">${c.verdict}</span>
        </td>
        <td class="citation-cell">
          <span class="citation-headline">"${escapeHtml(c.key_quote_or_headline || c.thesis_summary)}"</span>
          <span class="switch-status-inline ${c.has_switched ? 'text-switched' : 'text-active'}">${escapeHtml(c.switch_reason)}</span>
          <span class="citation-link">&nearr; Citation Source</span>
        </td>
      </tr>
    `;
  }).join('');
}

/* ==========================================================================
   Modal Call Inspector
   ========================================================================== */

function openMag7CallModal(callId) {
  const call = mag7State.calls.find(c => c.id === callId);
  if (!call) return;

  const backdrop = document.getElementById('mag7ModalBackdrop');
  const title = document.getElementById('mag7ModalTitle');
  const tag = document.getElementById('mag7ModalTag');
  const body = document.getElementById('mag7ModalBody');

  if (!backdrop || !body) return;

  tag.textContent = `MAG 7 AUDIT // ${call.ticker} // ${call.institution_name}`;
  title.textContent = `${call.institution_name} — ${call.company_name} (${call.published_on} ➔ ${call.exit_date} / Switch: ${call.switch_date})`;

  const verdictClass = call.verdict === 'HIT' ? 'tag-hit' : (call.verdict === 'MISS' ? 'tag-miss' : 'tag-neutral');
  const alphaClass = (call.relative_alpha||0) >= 0 ? 'highlight-gold font-bold' : 'color-bear font-bold';
  const alphaSwitchClass = (call.switch_alpha||0) >= 0 ? 'highlight-gold font-bold' : 'color-bear font-bold';

  body.innerHTML = `
    <div class="modal-audit-summary">
      <div class="modal-verdict-banner ${call.verdict === 'HIT' ? 'banner-hit' : 'banner-miss'}">
        <span class="preview-tag ${verdictClass}">VERDICT: ${call.verdict}</span>
        <span class="modal-verdict-title">${escapeHtml(call.verdict_explanation || '')}</span>
      </div>

      <!-- Hero Call Journey: When Said -> Horizon & Position Switch Options -->
      <div class="modal-journey-card">
        <div class="journey-header">CALL REALIZATION JOURNEY // DUAL EXIT PATHWAYS</div>
        <div class="journey-dual-grid">
          <!-- Step 1: When Said -->
          <div class="journey-step-box said">
            <span class="j-step-num">STEP 01</span>
            <span class="j-step-title">WHEN THEY SAID IT</span>
            <span class="j-step-date font-mono">${call.published_on}</span>
            <div class="j-step-details">
              <span>Stance: <strong>${call.rating_or_stance}</strong></span>
              <span>Target: <strong>${call.target_price ? `$${call.target_price}` : 'Macro Stance'}</strong></span>
              <span>Entry Spot: <strong>$${call.spot_at_publication.toFixed(2)}</strong></span>
            </div>
          </div>

          <!-- Step 2A: Horizon Exit -->
          <div class="journey-step-box happened">
            <span class="j-step-num">STEP 02A</span>
            <span class="j-step-title">HORIZON EXIT (${call.forecast_horizon})</span>
            <span class="j-step-date font-mono highlight-gold">${call.exit_date}</span>
            <div class="j-step-details">
              <span>Exit Spot: <strong>$${call.exit_spot ? call.exit_spot.toFixed(2) : '\u2014'}</strong></span>
              <span>Stock Return: <strong class="${(call.realized_stock_return||0) >= 0 ? 'color-bull' : 'color-bear'}">${((call.realized_stock_return||0)*100).toFixed(1)}%</strong></span>
              <span>SPY Return: <strong class="text-muted">${((call.realized_spy_return||0)*100).toFixed(1)}%</strong></span>
              <span>Alpha vs SPY: <strong class="${alphaClass}">${((call.relative_alpha||0)*100).toFixed(1)}%</strong></span>
            </div>
          </div>

          <!-- Step 2B: Position Switch Exit -->
          <div class="journey-step-box switch-box">
            <span class="j-step-num">STEP 02B</span>
            <span class="j-step-title">POSITION SWITCH EXIT (${call.switch_duration_days}d HELD)</span>
            <span class="j-step-date font-mono color-switch">${call.switch_date}</span>
            <div class="j-step-details">
              <span>Exit Spot: <strong>$${call.switch_spot ? call.switch_spot.toFixed(2) : '\u2014'}</strong></span>
              <span>Stock Return: <strong class="${(call.switch_stock_return||0) >= 0 ? 'color-bull' : 'color-bear'}">${((call.switch_stock_return||0)*100).toFixed(1)}%</strong></span>
              <span>Alpha vs SPY: <strong class="${alphaSwitchClass}">${((call.switch_alpha||0)*100).toFixed(1)}%</strong></span>
              <span class="switch-note">${escapeHtml(call.switch_reason)}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-grid-stats">
        <div class="modal-stat-item">
          <span class="modal-label">INSTITUTION</span>
          <span class="modal-val font-bold">${escapeHtml(call.institution_name)}</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">ANALYST / STRATEGIST</span>
          <span class="modal-val">${escapeHtml(call.strategist_or_analyst || 'Equity Research Desk')}</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">WHEN SAID (PUBLISHED)</span>
          <span class="modal-val font-mono">${call.published_on}</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">HORIZON REALIZATION DATE</span>
          <span class="modal-val font-mono highlight-gold">${call.exit_date} (${call.forecast_horizon})</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">POSITION SWITCH / REVISION DATE</span>
          <span class="modal-val font-mono color-switch">${call.switch_date} (${call.switch_duration_days} days held)</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">RECOMMENDED STANCE</span>
          <span class="modal-val font-bold">${call.rating_or_stance}</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">PRICE TARGET</span>
          <span class="modal-val font-mono">${call.target_price ? `$${call.target_price}` : 'Thematic Stance'}</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">SPOT AT PUBLICATION</span>
          <span class="modal-val font-mono">$${call.spot_at_publication.toFixed(2)}</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">EXIT SPOT (HORIZON / SWITCH)</span>
          <span class="modal-val font-mono font-bold">$${call.exit_spot ? call.exit_spot.toFixed(2) : '\u2014'} / $${call.switch_spot ? call.switch_spot.toFixed(2) : '\u2014'}</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">HORIZON ALPHA VS SPY</span>
          <span class="modal-val font-mono ${alphaClass}">${((call.relative_alpha||0)*100).toFixed(1)}%</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">SWITCH ALPHA VS SPY</span>
          <span class="modal-val font-mono ${alphaSwitchClass}">${((call.switch_alpha||0)*100).toFixed(1)}%</span>
        </div>
        <div class="modal-stat-item">
          <span class="modal-label">POSITION STATUS</span>
          <span class="modal-val font-mono font-bold">${call.has_switched ? 'REVISED / FLIPPED' : 'ACTIVE STANDING'}</span>
        </div>
      </div>

      <div class="modal-section-box">
        <h4>ANALYST THESIS &amp; RATIONALE (WHEN THEY SAID IT &middot; ${call.published_on})</h4>
        <p class="modal-thesis-text">${escapeHtml(call.thesis_summary)}</p>
      </div>

      <div class="modal-section-box">
        <h4>POSITION SWITCH / REVISION DETAILS (WHEN THEY SWITCHED &middot; ${call.switch_date})</h4>
        <p class="modal-thesis-text"><strong>${call.has_switched ? 'Position Action:' : 'Standing Status:'}</strong> ${escapeHtml(call.switch_reason)} &mdash; The desk maintained this standing position for <strong>${call.switch_duration_days} days</strong>, generating <strong>${((call.switch_stock_return||0)*100).toFixed(1)}%</strong> stock return and <strong>${((call.switch_alpha||0)*100).toFixed(1)}%</strong> relative alpha over SPY.</p>
      </div>

      <div class="modal-section-box">
        <h4>REALIZED MARKET OUTCOME (WHEN IT HAPPENED &middot; ${call.exit_date})</h4>
        <p class="modal-thesis-text">${escapeHtml(call.market_outcome)}</p>
      </div>

      <div class="modal-section-box">
        <h4>PRIMARY SOURCE CITATION &amp; VERIFICATION</h4>
        <div class="source-citation-box">
          <span class="citation-title">${escapeHtml(call.key_quote_or_headline || call.thesis_summary)}</span>
          <a href="${call.source_url}" target="_blank" rel="noopener noreferrer" class="source-link-btn">
            OPEN PRIMARY CITATION SOURCE &nearr;
          </a>
        </div>
      </div>
    </div>
  `;

  backdrop.style.display = 'flex';
}

function closeMag7Modal() {
  const backdrop = document.getElementById('mag7ModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function filterCallsByStock(ticker) {
  mag7State.callTickerFilter = ticker;
  
  // Update pills UI
  const pills = document.querySelectorAll('#tickerFilterPills button');
  pills.forEach(p => {
    if (p.getAttribute('data-filter-ticker') === ticker) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });

  renderMag7CallsTable();

  // Scroll to calls table
  const section = document.querySelector('.section-mag7-calls');
  if (section) section.scrollIntoView({ behavior: 'smooth' });
}

/* ==========================================================================
   Event Listeners Setup
   ========================================================================== */

function setupMag7EventListeners() {
  // Sync Now Button
  const syncBtn = document.getElementById('syncNowBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => triggerLiveRecalculate());
  }

  // Bank Filter Tabs
  const bankTabs = document.querySelectorAll('[data-bank-filter]');
  bankTabs.forEach(t => {
    t.addEventListener('click', () => {
      bankTabs.forEach(tab => tab.classList.remove('active'));
      t.classList.add('active');
      mag7State.bankFilter = t.getAttribute('data-bank-filter');
      renderMag7BankLeaderboard();
    });
  });

  // Export Mag 7 Leaderboard CSV
  const exportMag7Btn = document.getElementById('exportMag7CsvBtn');
  if (exportMag7Btn) {
    exportMag7Btn.addEventListener('click', () => {
      if (!mag7State.banks || !mag7State.banks.length) return;
      let csv = 'INSTITUTION,GRADE,HIT_RATE,AVG_ALPHA_SPY,TOTAL_CALLS,HITS,STANDOUT_HIT,BIGGEST_BLUNDER\r\n';
      mag7State.banks.forEach(b => {
        const best = b.standout_hit ? `"${b.standout_hit.ticker} ${b.standout_hit.published_on} (${b.standout_hit.verdict_realised_alpha_pct >= 0 ? '+' : ''}${b.standout_hit.verdict_realised_alpha_pct}%)"` : '""';
        const worst = b.biggest_blunder ? `"${b.biggest_blunder.ticker} ${b.biggest_blunder.published_on} (${b.biggest_blunder.verdict_realised_alpha_pct >= 0 ? '+' : ''}${b.biggest_blunder.verdict_realised_alpha_pct}%)"` : '""';
        const row = [
          `"${b.institution_name || ''}"`,
          b.grade || '',
          (b.hit_rate !== null ? (b.hit_rate * 100).toFixed(1) + '%' : ''),
          (b.avg_alpha !== null ? (b.avg_alpha * 100).toFixed(1) + '%' : ''),
          b.total_calls || 0,
          b.hit_count || 0,
          best,
          worst
        ];
        csv += row.join(',') + '\r\n';
      });
      const encodedUri = encodeURI('data:text/csv;charset=utf-8,' + csv);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `MomentumQ_Mag7_Leaderboard_${new Date().toISOString().slice(0,10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }

  // Bank Sort Headers
  const bankTableHeaders = document.querySelectorAll('#mag7BankTable th.sortable');
  bankTableHeaders.forEach(th => {
    th.addEventListener('click', () => {
      const field = th.getAttribute('data-sort');
      if (mag7State.bankSortBy === field) {
        mag7State.bankSortOrder = mag7State.bankSortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        mag7State.bankSortBy = field;
        mag7State.bankSortOrder = 'desc';
      }
      renderMag7BankLeaderboard();
    });
  });

  // Chart Stock Selector Pills
  const chartPills = document.querySelectorAll('.stock-pill-btn');
  chartPills.forEach(btn => {
    btn.addEventListener('click', () => {
      chartPills.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      mag7State.activeChartTicker = btn.getAttribute('data-ticker');
      renderMag7Chart();
    });
  });

  // Stock Exit Mode Toggle (Section 03)
  const stockExitBtns = document.querySelectorAll('[data-stock-exit-mode]');
  stockExitBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      stockExitBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mag7State.stockExitMode = btn.getAttribute('data-stock-exit-mode');
      renderMag7StocksGrid();
    });
  });

  // Calls Search Input
  const searchInput = document.getElementById('mag7SearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      mag7State.callSearchQuery = e.target.value;
      renderMag7CallsTable();
    });
  }

  // Ticker Filter Pills in Calls Blotter
  const tickerPills = document.querySelectorAll('#tickerFilterPills button');
  tickerPills.forEach(p => {
    p.addEventListener('click', () => {
      tickerPills.forEach(pill => pill.classList.remove('active'));
      p.classList.add('active');
      mag7State.callTickerFilter = p.getAttribute('data-filter-ticker');
      renderMag7CallsTable();
    });
  });

  // Verdict Filter Pills
  const verdictPills = document.querySelectorAll('#verdictFilterPills button');
  verdictPills.forEach(p => {
    p.addEventListener('click', () => {
      verdictPills.forEach(pill => pill.classList.remove('active'));
      p.classList.add('active');
      mag7State.callVerdictFilter = p.getAttribute('data-filter-verdict');
      renderMag7CallsTable();
    });
  });

  // Exit Mode Filter Pills in Blotter (Section 05)
  const exitFilterPills = document.querySelectorAll('#exitFilterPills button');
  exitFilterPills.forEach(p => {
    p.addEventListener('click', () => {
      exitFilterPills.forEach(pill => pill.classList.remove('active'));
      p.classList.add('active');
      mag7State.callExitFilter = p.getAttribute('data-filter-exit');
      renderMag7CallsTable();
    });
  });

  // Modal Close
  const closeBtn = document.getElementById('mag7ModalCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeMag7Modal);

  const backdrop = document.getElementById('mag7ModalBackdrop');
  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeMag7Modal();
    });
  }

  // Back to Top Button
  const bttBtn = document.getElementById('backToTopBtn');
  if (bttBtn) {
    window.addEventListener('scroll', () => {
      if (window.scrollY > 300) {
        bttBtn.classList.add('visible');
      } else {
        bttBtn.classList.remove('visible');
      }
    });
    bttBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Window Resize re-render SVG Chart (debounced — a full redraw per resize
  // event repainted ~8k path points on every pixel of a drag).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderMag7Chart, 120);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
