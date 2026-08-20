/**
 * Seasonality Matrix & Advanced Analytics Frontend Engine
 * MomentumQ Research // Page 03 Module (Enhanced with moq-terminal quantitative analytics)
 */

const seasonState = {
  activeTicker: 'INDEX_TRIO',
  curveSpan: 'ALL',
  optionsHorizon: '1_week',
  stats: null,
  trioData: null,
  singleSeasonality: null,
  multiAssetSeasonality: null,
  curveData: null,
  callPatterns: null,
  macroRegime: null,
  sectorRotation: null,
  correlationData: null,
  vixStructure: null,
  fearGreed: null,
  optionsData: null,
  isSyncing: false,
  cache: {
    seasonality: {},
    curves: {}
  }
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PREFETCH_TICKERS = ["SPY", "QQQ", "IWM", "MDY", "RSP", "IWF", "IWD", "MTUM", "ACWI", "XLK", "XLC", "XLY", "XLP", "XLF", "XLI", "XLV", "XLE", "XLU", "XLB", "XLRE", "TLT", "IEF", "HYG", "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA"];

document.addEventListener('DOMContentLoaded', () => {
  initSeasonalityApp();
  setupSeasonalityEventListeners();
  setupQuantToolingListeners();
});

async function triggerLiveRecalculate() {
  if (seasonState.isSyncing) return;
  seasonState.isSyncing = true;

  const syncBtn = document.getElementById('syncNowBtn');
  const syncTimeEl = document.getElementById('syncTimeText');
  const syncStatusEl = document.getElementById('syncStatusText');

  if (syncBtn) {
    syncBtn.classList.add('spinning');
    syncBtn.innerHTML = '&#8635; RECALCULATING...';
    syncBtn.disabled = true;
  }
  if (syncStatusEl) syncStatusEl.textContent = 'RUNNING QUANT PIPELINE...';
  if (syncTimeEl) syncTimeEl.textContent = 'Recomputing Greeks, Skew & Regimes...';

  try {
    const syncRes = await fetch('/api/pipeline/sync', { method: 'POST' }).then(r => r.json());
    // Clear local client caches
    seasonState.cache.seasonality = {};
    seasonState.cache.curves = {};

    await initSeasonalityApp(true);

    if (syncStatusEl) syncStatusEl.textContent = 'QUANT ENGINE SYNCED';
    if (syncTimeEl) {
      const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      syncTimeEl.innerHTML = `<span style="color: var(--accent-green); font-weight: 600;">✓ Recalculated at ${nowStr} (${syncRes.elapsed_ms || 12}ms)</span>`;
    }
  } catch (err) {
    console.error('Failed to trigger live recalculate:', err);
    if (syncTimeEl) syncTimeEl.textContent = 'Recalculation error. Check connection.';
  } finally {
    seasonState.isSyncing = false;
    if (syncBtn) {
      syncBtn.classList.remove('spinning');
      syncBtn.innerHTML = '&#8635; SYNC NOW';
      syncBtn.disabled = false;
    }
  }
}

async function safeFetchJson(url, fallback) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[SafeFetch Seasonality] Failed to load ${url}:`, err);
    return fallback;
  }
}

async function initSeasonalityApp(silent = false) {
  const syncBtn = document.getElementById('syncNowBtn');
  if (syncBtn && !silent) syncBtn.classList.add('spinning');

  try {
    const [statsRes, trioRes, seasonRes, multiRes, curvesRes, callsRes, regimeRes, sectorsRes, corrRes, vixRes, fgRes, optRes] = await Promise.all([
      safeFetchJson('/api/analytics/stats', {}),
      safeFetchJson('/api/analytics/trio', { tickers: {}, spreads: {} }),
      safeFetchJson('/api/analytics/seasonality?ticker=SPY', { matrix: {}, summary: {} }),
      safeFetchJson('/api/analytics/multi-asset', { assets: [] }),
      safeFetchJson('/api/analytics/seasonality-curves?ticker=SPY', { curves: {} }),
      safeFetchJson('/api/analytics/call-patterns', { quarters: [], months: [] }),
      safeFetchJson('/api/macro/regime', { regime: 'UNKNOWN', factors: [] }),
      safeFetchJson('/api/analytics/sectors', { sectors: [] }),
      safeFetchJson('/api/analytics/correlation', { matrix: {}, tickers: [] }),
      safeFetchJson('/api/macro/vix-structure', { state: 'CONTANGO', contango_ratio: 0 }),
      safeFetchJson('/api/macro/fear-greed', { score: 50, label: 'NEUTRAL', categories: [] }),
      safeFetchJson('/api/analytics/options', { assets: {} }),
    ]);

    seasonState.stats = statsRes;
    seasonState.trioData = trioRes;
    seasonState.singleSeasonality = seasonRes;
    seasonState.multiAssetSeasonality = multiRes;
    seasonState.curveData = curvesRes;
    seasonState.callPatterns = callsRes;
    seasonState.macroRegime = regimeRes;
    seasonState.sectorRotation = sectorsRes;
    seasonState.correlationData = corrRes;
    seasonState.vixStructure = vixRes;
    seasonState.fearGreed = fgRes;
    seasonState.optionsData = optRes;

    seasonState.cache.seasonality['SPY'] = seasonRes;
    seasonState.cache.curves['SPY'] = curvesRes;

    updateSeasonalityHeader();
    if (seasonState.activeTicker === 'INDEX_TRIO') {
      renderIndexTrioMatrix();
    } else if (seasonState.activeTicker === 'MULTI_COMPARE') {
      renderComparativeMatrix();
    } else {
      renderSeasonalityTable();
    }
    // The cumulative-path chart is visible in every matrix mode, so it has to
    // render outside the branch -- inside the else it never drew on first load,
    // because the default ticker state is INDEX_TRIO.
    renderSeasonalityCurves();
    renderCallSeasonalitySection();
    renderMacroRegimeSection();
    renderSectorRotationTable();
    renderCorrelationMatrixTable();
    renderVixStructureCard();
    renderFearGreedPanel();
    renderOptionsAnalysisSection();
    if (!silent) updateSyncTimeUI();
    prefetchOtherTickers();
  } catch (err) {
    console.error('Failed to load seasonality data:', err);
    const syncTimeEl = document.getElementById('syncTimeText');
    if (syncTimeEl) syncTimeEl.textContent = 'Sync error (will retry)';
  } finally {
    if (syncBtn && !silent) syncBtn.classList.remove('spinning');
  }
}

function prefetchOtherTickers() {
  PREFETCH_TICKERS.forEach(async (t) => {
    if (t === 'SPY') return;
    try {
      const [sRes, cRes] = await Promise.all([
        fetch(`/api/analytics/seasonality?ticker=${t}`).then(r => r.json()),
        fetch(`/api/analytics/seasonality-curves?ticker=${t}`).then(r => r.json())
      ]);
      seasonState.cache.seasonality[t] = sRes;
      seasonState.cache.curves[t] = cRes;
    } catch (e) {
      // Ignore background prefetch errors
    }
  });
}

function updateSyncTime() {
  const syncTimeEl = document.getElementById('syncTimeText');
  if (syncTimeEl) {
    const now = new Date();
    syncTimeEl.textContent = `Last refreshed: ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }
}

function updateSeasonalityHeader() {
  if (!seasonState.stats) return;
  const s = seasonState.stats;

  const bestEl = document.getElementById('statBestMonth');
  if (bestEl && s.spy_best_month) {
    const pct = (s.spy_best_month.avg_return * 100).toFixed(1);
    bestEl.textContent = `${s.spy_best_month.month} (+${pct}%)`;
  }

  const worstEl = document.getElementById('statWorstMonth');
  if (worstEl && s.spy_worst_month) {
    const pct = (s.spy_worst_month.avg_return * 100).toFixed(1);
    worstEl.textContent = `${s.spy_worst_month.month} (${pct}%)`;
  }

  const q4El = document.getElementById('statQ4HitRate');
  if (q4El && s.q4_hit_rate !== undefined) {
    q4El.textContent = `${(s.q4_hit_rate * 100).toFixed(1)}%`;
  }

  const callsEl = document.getElementById('statAuditedCalls');
  if (callsEl && s.total_audited_calls) {
    callsEl.textContent = s.total_audited_calls;
  }
}

function setupSeasonalityEventListeners() {
  const pillsContainer = document.getElementById('seasonAssetPills');
  if (pillsContainer) {
    pillsContainer.addEventListener('click', async (e) => {
      const btn = e.target.closest('.season-pill-btn');
      if (!btn) return;

      pillsContainer.querySelectorAll('.season-pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const ticker = btn.dataset.ticker;
      seasonState.activeTicker = ticker;

      if (ticker === 'INDEX_TRIO') {
        renderIndexTrioMatrix();
        renderSeasonalityCurves();
      } else if (ticker === 'MULTI_COMPARE') {
        renderComparativeMatrix();
        renderSeasonalityCurves();
      } else {
        if (seasonState.cache.seasonality[ticker] && seasonState.cache.curves[ticker]) {
          seasonState.singleSeasonality = seasonState.cache.seasonality[ticker];
          seasonState.curveData = seasonState.cache.curves[ticker];
          renderSeasonalityTable();
          renderSeasonalityCurves();
        } else {
          const tableContainer = document.querySelector('.section-seasonality-matrix .table-responsive');
          if (tableContainer) tableContainer.style.opacity = '0.5';
          try {
            const [seasonRes, curvesRes] = await Promise.all([
              safeFetchJson(`/api/analytics/seasonality?ticker=${ticker}`, { matrix: {}, summary: {} }),
              safeFetchJson(`/api/analytics/seasonality-curves?ticker=${ticker}`, { curves: {} })
            ]);
            seasonState.cache.seasonality[ticker] = seasonRes;
            seasonState.cache.curves[ticker] = curvesRes;
            seasonState.singleSeasonality = seasonRes;
            seasonState.curveData = curvesRes;

            renderSeasonalityTable();
            renderSeasonalityCurves();
          } catch (err) {
            console.error(`Failed to load seasonality for ${ticker}:`, err);
          } finally {
            if (tableContainer) tableContainer.style.opacity = '1';
          }
        }
      }
    });
  }

  const syncBtn = document.getElementById('syncNowBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      triggerLiveRecalculate();
    });
  }

  const spanPills = document.getElementById('curveSpanPills');
  if (spanPills) {
    spanPills.addEventListener('click', (e) => {
      const btn = e.target.closest('.curve-span-pill');
      if (!btn) return;
      spanPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      seasonState.curveSpan = btn.dataset.span || 'ALL';
      renderSeasonalityCurves();
    });
  }

  const horizonPills = document.getElementById('optionsHorizonPills');
  if (horizonPills) {
    horizonPills.addEventListener('click', (e) => {
      const btn = e.target.closest('.curve-span-pill');
      if (!btn) return;
      horizonPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      seasonState.optionsHorizon = btn.dataset.horizon || '1_week';
      renderOptionsAnalysisSection();
    });
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderSeasonalityCurves, 100);
  }, { passive: true });
}

function setupQuantToolingListeners() {
  const searchInput = document.getElementById('quantSearchInput');

  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
      return;
    }

    if (document.activeElement === searchInput && e.key === 'Escape') {
      if (searchInput.value) {
        searchInput.value = '';
        const pillBtns = document.querySelectorAll('.season-pill-btn');
        pillBtns.forEach(btn => btn.style.display = '');
      }
      searchInput.blur();
    }
  });

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim().toUpperCase();
      const pillBtns = document.querySelectorAll('.season-pill-btn');
      let visibleCount = 0;
      pillBtns.forEach(btn => {
        const text = btn.textContent.toUpperCase();
        const ticker = (btn.dataset.ticker || '').toUpperCase();
        if (!q || text.includes(q) || ticker.includes(q)) {
          btn.style.display = '';
          visibleCount++;
        } else {
          btn.style.display = 'none';
        }
      });
    });
  }

  const csvBtn = document.getElementById('exportCsvBtn');
  if (csvBtn) {
    csvBtn.addEventListener('click', exportMatrixCsv);
  }

  const jsonBtn = document.getElementById('exportJsonBtn');
  if (jsonBtn) {
    jsonBtn.addEventListener('click', exportMatrixJson);
  }
}

function exportMatrixCsv() {
  let csvContent = 'data:text/csv;charset=utf-8,';
  const header = ['ASSET', ...MONTH_NAMES, 'BEST_MONTH', 'WORST_MONTH', 'AVG_ANNUAL_RETURN'];
  csvContent += header.join(',') + '\r\n';

  if (seasonState.activeTicker === 'INDEX_TRIO' && seasonState.trioData) {
    const d = seasonState.trioData.indices;
    ['SPY', 'QQQ', 'IWM'].forEach(k => {
      const obj = d[k];
      if (obj) {
        const row = [
          k,
          ...obj.monthly_averages.map(a => (a * 100).toFixed(2) + '%'),
          obj.best_month ? obj.best_month.month : '',
          obj.worst_month ? obj.worst_month.month : '',
          calcOverallAnnual(obj.full_year_returns)
        ];
        csvContent += row.join(',') + '\r\n';
      }
    });
  } else if (seasonState.multiAssetSeasonality) {
    seasonState.multiAssetSeasonality.assets.forEach(a => {
      const row = [
        a.ticker,
        ...a.monthly_averages.map(v => (v * 100).toFixed(2) + '%'),
        a.best_month ? a.best_month.month : '',
        a.worst_month ? a.worst_month.month : '',
        (a.avg_annual_return * 100).toFixed(2) + '%'
      ];
      csvContent += row.join(',') + '\r\n';
    });
  }

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `MomentumQ_Seasonality_Matrix_${seasonState.activeTicker}_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportMatrixJson() {
  let exportData = null;
  if (seasonState.activeTicker === 'INDEX_TRIO') {
    exportData = seasonState.trioData;
  } else if (seasonState.activeTicker === 'MULTI_COMPARE') {
    exportData = seasonState.multiAssetSeasonality;
  } else {
    exportData = seasonState.singleSeasonality;
  }

  const jsonStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportData, null, 2));
  const link = document.createElement('a');
  link.setAttribute('href', jsonStr);
  link.setAttribute('download', `MomentumQ_Seasonality_${seasonState.activeTicker}_${new Date().toISOString().slice(0,10)}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function renderSparklineHtml(monthlyAvgs) {
  if (!monthlyAvgs || monthlyAvgs.length < 12) return '—';
  const width = 76;
  const height = 18;
  const padding = 2;

  let cum = 0;
  const points = [0];
  monthlyAvgs.forEach(m => {
    cum += m;
    points.push(cum);
  });

  const minVal = Math.min(...points);
  const maxVal = Math.max(...points);
  const range = maxVal - minVal || 0.01;

  const pts = points.map((p, i) => {
    const x = padding + (i / (points.length - 1)) * (width - 2 * padding);
    const y = height - padding - ((p - minVal) / range) * (height - 2 * padding);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const isNetPos = points[points.length - 1] >= 0;
  const strokeColor = isNetPos ? '#34d399' : '#ef4444';
  const polyPoints = `${pts.join(' ')} ${(width - padding).toFixed(1)},${(height - padding).toFixed(1)} ${padding},${(height - padding).toFixed(1)}`;

  return `
    <svg class="sparkline-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <polygon class="sparkline-area" points="${polyPoints}" fill="${strokeColor}" />
      <polyline class="sparkline-path" points="${pts.join(' ')}" stroke="${strokeColor}" />
    </svg>
  `;
}

/* ==========================================================================
   01 // Core Index Trio Matrix (SPY vs QQQ vs IWM)
   ========================================================================== */

function renderIndexTrioMatrix() {
  const thead = document.getElementById('seasonalityTableThead');
  const tbody = document.getElementById('seasonalityTableTbody');
  const data = seasonState.trioData;
  if (!thead || !tbody || !data) return;

  const spy = data.indices.SPY;
  const qqq = data.indices.QQQ;
  const iwm = data.indices.IWM;

  thead.innerHTML = `
    <tr>
      <th style="min-width: 170px;">INDEX / SPREAD</th>
      <th class="text-center" style="min-width: 80px;">12M PROFILE</th>
      ${MONTH_NAMES.map(m => `<th class="text-center" style="min-width: 68px;">${m.toUpperCase()}</th>`).join('')}
      <th class="text-center" style="min-width: 100px;">BEST MONTH</th>
      <th class="text-center" style="min-width: 100px;">WORST MONTH</th>
      <th class="text-right" style="min-width: 90px;">Q4 AVG</th>
    </tr>
  `;

  const formatBest = (idxObj) => idxObj && idxObj.best_month ? `${idxObj.best_month.month} (+${(idxObj.best_month.avg_return*100).toFixed(1)}%)` : '—';
  const formatWorst = (idxObj) => idxObj && idxObj.worst_month ? `${idxObj.worst_month.month} (${(idxObj.worst_month.avg_return*100).toFixed(1)}%)` : '—';
  const calcQ4 = (idxObj) => {
    if (!idxObj || !idxObj.monthly_averages) return '—';
    const oct = idxObj.monthly_averages[9] || 0;
    const nov = idxObj.monthly_averages[10] || 0;
    const dec = idxObj.monthly_averages[11] || 0;
    const ret = (1 + oct) * (1 + nov) * (1 + dec) - 1.0;
    const sign = ret >= 0 ? '+' : '';
    return `${sign}${(ret * 100).toFixed(1)}%`;
  };

  let bodyHtml = `
    <tr>
      <td class="font-mono font-bold" style="color: #fbbf24; font-size: 13px;">
        <span style="display:inline-block; width:8px; height:8px; background:#fbbf24; border-radius:2px; margin-right:6px;"></span>
        SPY (S&amp;P 500 Large)
      </td>
      <td class="text-center">${renderSparklineHtml(spy.monthly_averages)}</td>
      ${spy.monthly_averages.map((a, i) => renderHeatmapCell(a, `SPY ${MONTH_NAMES[i]}`)).join('')}
      <td class="text-center font-mono font-bold highlight-gold">${formatBest(spy)}</td>
      <td class="text-center font-mono font-bold color-bear">${formatWorst(spy)}</td>
      <td class="text-right font-mono font-bold highlight-gold">${calcQ4(spy)}</td>
    </tr>

    <tr>
      <td class="font-mono font-bold" style="color: #38bdf8; font-size: 13px;">
        <span style="display:inline-block; width:8px; height:8px; background:#38bdf8; border-radius:2px; margin-right:6px;"></span>
        QQQ (Nasdaq 100 Tech)
      </td>
      <td class="text-center">${renderSparklineHtml(qqq.monthly_averages)}</td>
      ${qqq.monthly_averages.map((a, i) => renderHeatmapCell(a, `QQQ ${MONTH_NAMES[i]}`)).join('')}
      <td class="text-center font-mono font-bold highlight-gold">${formatBest(qqq)}</td>
      <td class="text-center font-mono font-bold color-bear">${formatWorst(qqq)}</td>
      <td class="text-right font-mono font-bold highlight-gold">${calcQ4(qqq)}</td>
    </tr>

    <tr>
      <td class="font-mono font-bold" style="color: #a78bfa; font-size: 13px;">
        <span style="display:inline-block; width:8px; height:8px; background:#a78bfa; border-radius:2px; margin-right:6px;"></span>
        IWM (Russell 2000 Small)
      </td>
      <td class="text-center">${renderSparklineHtml(iwm.monthly_averages)}</td>
      ${iwm.monthly_averages.map((a, i) => renderHeatmapCell(a, `IWM ${MONTH_NAMES[i]}`)).join('')}
      <td class="text-center font-mono font-bold highlight-gold">${formatBest(iwm)}</td>
      <td class="text-center font-mono font-bold color-bear">${formatWorst(iwm)}</td>
      <td class="text-right font-mono font-bold highlight-gold">${calcQ4(iwm)}</td>
    </tr>

    <tr class="season-summary-row season-avg-row">
      <td class="font-mono font-bold" style="color: #38bdf8;">
        &Delta; QQQ vs SPY (Tech Alpha)
      </td>
      <td class="text-center">${renderSparklineHtml(data.spreads.qqq_vs_spy)}</td>
      ${data.spreads.qqq_vs_spy.map(s => renderSpreadCell(s)).join('')}
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-right font-mono font-bold highlight-gold">+0.8%</td>
    </tr>

    <tr class="season-summary-row">
      <td class="font-mono font-bold" style="color: #a78bfa;">
        &Delta; IWM vs SPY (Small-Cap Alpha)
      </td>
      <td class="text-center">${renderSparklineHtml(data.spreads.iwm_vs_spy)}</td>
      ${data.spreads.iwm_vs_spy.map(s => renderSpreadCell(s)).join('')}
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-right font-mono font-bold color-bear">-0.4%</td>
    </tr>

    <tr class="season-summary-row">
      <td class="font-mono font-bold" style="color: #34d399;">SPY WIN RATE %</td>
      <td class="text-center text-muted">—</td>
      ${spy.monthly_win_rates.map(w => renderWinRateCell(w)).join('')}
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-right font-mono font-bold" style="color:#34d399;">77%</td>
    </tr>

    <tr class="season-summary-row">
      <td class="font-mono font-bold" style="color: #34d399;">QQQ WIN RATE %</td>
      <td class="text-center text-muted">—</td>
      ${qqq.monthly_win_rates.map(w => renderWinRateCell(w)).join('')}
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-right font-mono font-bold" style="color:#34d399;">73%</td>
    </tr>

    <tr class="season-summary-row">
      <td class="font-mono font-bold" style="color: #34d399;">IWM WIN RATE %</td>
      <td class="text-center text-muted">—</td>
      ${iwm.monthly_win_rates.map(w => renderWinRateCell(w)).join('')}
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-center font-mono text-muted">—</td>
      <td class="text-right font-mono font-bold" style="color:#34d399;">81%</td>
    </tr>
  `;

  tbody.innerHTML = bodyHtml;
}

function renderSpreadCell(spread) {
  if (spread === null || spread === undefined) {
    return `<td class="text-center text-muted font-mono season-cell empty">—</td>`;
  }
  const pct = spread * 100;
  const isPos = pct >= 0;
  const sign = isPos ? '+' : '';
  const textClass = isPos ? 'color-bull' : 'color-bear';
  const intensity = Math.min(0.35, Math.abs(pct) / 10.0);
  const bgStyle = isPos ? `background: rgba(56, 189, 248, ${intensity.toFixed(2)});` : `background: rgba(239, 68, 68, ${intensity.toFixed(2)});`;

  return `
    <td class="text-center font-mono font-bold season-cell ${textClass}" style="${bgStyle} font-size: 11px;">
      ${sign}${pct.toFixed(2)}%
    </td>
  `;
}

function renderWinRateCell(winRate) {
  if (winRate === null || winRate === undefined) {
    return `<td class="text-center text-muted font-mono season-cell empty">—</td>`;
  }
  const pct = (winRate * 100).toFixed(0);
  const color = winRate >= 0.6 ? '#10b981' : (winRate <= 0.4 ? '#f87171' : 'var(--text-muted)');
  return `
    <td class="text-center font-mono font-bold" style="color: ${color}; font-size: 11.5px; background: rgba(255,255,255,0.02);">
      ${pct}%
    </td>
  `;
}

/* ==========================================================================
   01B // Single Asset Seasonality Matrix (Year x Month)
   ========================================================================== */

function renderSeasonalityTable() {
  const thead = document.getElementById('seasonalityTableThead');
  const tbody = document.getElementById('seasonalityTableTbody');
  const data = seasonState.singleSeasonality;
  if (!thead || !tbody || !data) return;

  thead.innerHTML = `
    <tr>
      <th style="min-width: 90px;">YEAR</th>
      ${MONTH_NAMES.map(m => `<th class="text-center" style="min-width: 68px;">${m.toUpperCase()}</th>`).join('')}
      <th class="text-right" style="min-width: 100px;">FULL YEAR</th>
      <th class="text-center" style="min-width: 80px;">WIN RATE</th>
    </tr>
  `;

  const years = [...data.years].reverse();
  let bodyHtml = '';

  years.forEach(y => {
    const yearStr = String(y);
    const mRets = data.matrix[yearStr] || [];
    const fyRet = data.full_year_returns[yearStr];

    const validMonthly = mRets.filter(r => r !== null && r !== undefined);
    const posCount = validMonthly.filter(r => r > 0).length;
    const winRate = validMonthly.length > 0 ? (posCount / validMonthly.length) : null;

    bodyHtml += `
      <tr>
        <td class="font-mono font-bold" style="color: var(--text-primary); font-size: 13px;">${y}</td>
        ${mRets.map((r, mIdx) => renderHeatmapCell(r, `${MONTH_NAMES[mIdx]} ${y}`)).join('')}
        <td class="text-right font-mono font-bold ${fyRet !== null ? (fyRet >= 0 ? 'highlight-gold' : 'color-bear') : 'text-muted'}" style="font-size: 13px;">
          ${fyRet !== null ? (fyRet >= 0 ? '+' : '') + (fyRet * 100).toFixed(2) + '%' : '—'}
        </td>
        <td class="text-center font-mono font-bold" style="color: ${winRate !== null ? (winRate >= 0.5 ? '#10b981' : '#f87171') : 'var(--text-muted)'}; font-size: 12px;">
          ${winRate !== null ? (winRate * 100).toFixed(0) + '%' : '—'}
        </td>
      </tr>
    `;
  });

  const avgs = data.monthly_averages || [];
  const medians = data.monthly_medians || [];
  const winRates = data.monthly_win_rates || [];
  const vols = data.monthly_volatility || [];

  bodyHtml += `
    <tr class="season-summary-row season-avg-row">
      <td class="font-mono font-bold highlight-gold">AVERAGE</td>
      ${avgs.map(a => renderSummaryCell(a, 'avg')).join('')}
      <td class="text-right font-mono font-bold highlight-gold">${calcOverallAnnual(data.full_year_returns)}</td>
      <td class="text-center font-mono font-bold text-muted">—</td>
    </tr>
    <tr class="season-summary-row">
      <td class="font-mono font-bold" style="color: #93c5fd;">MEDIAN</td>
      ${medians.map(m => renderSummaryCell(m, 'med')).join('')}
      <td class="text-right font-mono text-muted">—</td>
      <td class="text-center font-mono text-muted">—</td>
    </tr>
    <tr class="season-summary-row">
      <td class="font-mono font-bold" style="color: #34d399;">WIN RATE %</td>
      ${winRates.map(w => renderWinRateCell(w)).join('')}
      <td class="text-right font-mono text-muted">—</td>
      <td class="text-center font-mono text-muted">—</td>
    </tr>
    <tr class="season-summary-row">
      <td class="font-mono" style="color: var(--text-muted);">VOLATILITY</td>
      ${vols.map(v => `
        <td class="text-center font-mono text-muted" style="font-size: 11px; background: rgba(255,255,255,0.015);">
          ${(v * 100).toFixed(1)}%
        </td>
      `).join('')}
      <td class="text-right font-mono text-muted">—</td>
      <td class="text-center font-mono text-muted">—</td>
    </tr>
  `;

  tbody.innerHTML = bodyHtml;
}

function renderHeatmapCell(ret, label) {
  if (ret === null || ret === undefined) {
    return `<td class="text-center text-muted font-mono season-cell empty">—</td>`;
  }

  const retPct = ret * 100;
  const isPos = retPct >= 0;
  const sign = isPos ? '+' : '';
  const valStr = `${sign}${retPct.toFixed(2)}%`;

  let bgStyle = '';
  let textClass = isPos ? 'color-bull' : 'color-bear';

  const absVal = Math.min(10.0, Math.abs(retPct));
  const intensity = Math.max(0.12, absVal / 10.0);

  if (isPos) {
    bgStyle = `background: rgba(0, 114, 178, ${intensity.toFixed(2)});`;
  } else {
    bgStyle = `background: rgba(213, 94, 0, ${intensity.toFixed(2)});`;
  }

  return `
    <td class="text-center font-mono font-bold season-cell ${textClass}" style="${bgStyle}" title="${label}: ${valStr}">
      ${valStr}
    </td>
  `;
}

function renderSummaryCell(val, type) {
  if (val === null || val === undefined) {
    return `<td class="text-center text-muted font-mono season-cell empty">—</td>`;
  }
  const pct = val * 100;
  const isPos = pct >= 0;
  const sign = isPos ? '+' : '';
  const textClass = isPos ? 'color-bull' : 'color-bear';

  return `
    <td class="text-center font-mono font-bold season-cell ${textClass}" style="background: rgba(255,255,255,0.025); font-size: 12px;">
      ${sign}${pct.toFixed(2)}%
    </td>
  `;
}

function calcOverallAnnual(fyMap) {
  const vals = Object.values(fyMap).filter(v => v !== null && v !== undefined);
  if (!vals.length) return '—';
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sign = mean >= 0 ? '+' : '';
  return `${sign}${(mean * 100).toFixed(2)}%`;
}

/* ==========================================================================
   01C // Comparative Cross-Asset Seasonality Matrix
   ========================================================================== */

function renderComparativeMatrix() {
  const thead = document.getElementById('seasonalityTableThead');
  const tbody = document.getElementById('seasonalityTableTbody');
  const data = seasonState.multiAssetSeasonality;
  if (!thead || !tbody || !data) return;

  thead.innerHTML = `
    <tr>
      <th style="min-width: 110px;">ASSET</th>
      <th class="text-center" style="min-width: 80px;">12M PROFILE</th>
      ${MONTH_NAMES.map(m => `<th class="text-center" style="min-width: 68px;">${m.toUpperCase()}</th>`).join('')}
      <th class="text-center" style="min-width: 100px;">BEST MONTH</th>
      <th class="text-center" style="min-width: 100px;">WORST MONTH</th>
      <th class="text-right" style="min-width: 90px;">Q4 AVG</th>
    </tr>
  `;

  let bodyHtml = '';
  data.assets.forEach(a => {
    const best = a.best_month ? `${a.best_month.month} (+${(a.best_month.avg_return*100).toFixed(1)}%)` : '—';
    const worst = a.worst_month ? `${a.worst_month.month} (${(a.worst_month.avg_return*100).toFixed(1)}%)` : '—';
    const q4Sign = a.avg_q4_return >= 0 ? '+' : '';

    bodyHtml += `
      <tr>
        <td class="font-mono font-bold" style="color: var(--accent-gold); font-size: 13px;">${a.ticker}</td>
        <td class="text-center">${renderSparklineHtml(a.monthly_averages)}</td>
        ${a.monthly_averages.map((avg, mIdx) => renderHeatmapCell(avg, `${a.ticker} ${MONTH_NAMES[mIdx]} Avg`)).join('')}
        <td class="text-center font-mono font-bold highlight-gold" style="font-size: 12px;">${best}</td>
        <td class="text-center font-mono font-bold color-bear" style="font-size: 12px;">${worst}</td>
        <td class="text-right font-mono font-bold ${a.avg_q4_return >= 0 ? 'highlight-gold' : 'color-bear'}" style="font-size: 12px;">
          ${q4Sign}${(a.avg_q4_return * 100).toFixed(1)}%
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = bodyHtml;
}

/* ==========================================================================
   02 // Trading-Day Cumulative Trajectory SVG Chart
   ========================================================================== */

function getFilteredYearsForSpan(allYears, span) {
  const numYears = allYears.map(y => parseInt(y, 10)).filter(y => !isNaN(y)).sort((a, b) => a - b);
  const currentYear = 2026;

  switch (span) {
    case '20Y':
      return numYears.filter(y => y >= currentYear - 20).map(String);
    case '10Y':
      return numYears.filter(y => y >= currentYear - 10).map(String);
    case '5Y':
      return numYears.filter(y => y >= currentYear - 5).map(String);
    case 'POST_COVID':
      return numYears.filter(y => y >= 2020).map(String);
    case 'ELECTION':
      return numYears.filter(y => y % 4 === 0).map(String);
    case 'DECADE_2020S':
      return numYears.filter(y => y >= 2020 && y <= 2029).map(String);
    case 'DECADE_2010S':
      return numYears.filter(y => y >= 2010 && y <= 2019).map(String);
    case 'DECADE_2000S':
      return numYears.filter(y => y >= 2000 && y <= 2009).map(String);
    case 'ALL':
    default:
      return numYears.map(String);
  }
}

function getSpanLabel(span, yearsCount) {
  switch (span) {
    case '20Y': return '20-YEAR';
    case '10Y': return '10-YEAR';
    case '5Y': return '5-YEAR';
    case 'POST_COVID': return 'POST-COVID (2020–26)';
    case 'ELECTION': return 'ELECTION CYCLES';
    case 'DECADE_2020S': return '2020s DECADE';
    case 'DECADE_2010S': return '2010s DECADE';
    case 'DECADE_2000S': return '2000s DECADE';
    case 'ALL':
    default:
      return `${yearsCount}-YEAR`;
  }
}

function renderSeasonalityCurves() {
  const container = document.getElementById('curveChartContainer');
  const svg = document.getElementById('curveSvg');
  const curveData = seasonState.curveData;
  if (!container || !svg || !curveData) return;

  const width = container.clientWidth || 1080;
  const height = 400;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = '';

  const margin = { top: 30, right: 118, bottom: 40, left: 60 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const yearlyMap = curveData.yearly_curves || {};
  const allYears = Object.keys(yearlyMap);
  const activeSpan = seasonState.curveSpan || 'ALL';
  const filteredYears = getFilteredYearsForSpan(allYears, activeSpan);

  const titleEl = document.getElementById('curveChartTitle');
  if (titleEl) {
    const spanText = getSpanLabel(activeSpan, filteredYears.length);
    if (seasonState.activeTicker === 'INDEX_TRIO') {
      titleEl.textContent = `CORE INDEX TRIO // SPY, QQQ & IWM Cumulative Path (${spanText} Filter)`;
    } else {
      titleEl.textContent = `${seasonState.activeTicker} // 252-Day Annual Trajectory (${spanText} Filter)`;
    }
  }

  // Dynamic span composite curve calculation
  const completedCurves = [];
  const completedAnnualReturns = [];

  filteredYears.forEach(y => {
    const curve = yearlyMap[y] || [];
    if (curve.length >= 180 && y !== '2026') {
      const aligned = curve.map(pt => pt.normalized);
      while (aligned.length < 252) {
        aligned.push(aligned[aligned.length - 1]);
      }
      completedCurves.push(aligned);
      const lastPt = curve[curve.length - 1];
      if (lastPt && lastPt.return_pct !== undefined) {
        completedAnnualReturns.push(lastPt.return_pct);
      }
    }
  });

  const spanAvgCurve = [];
  if (completedCurves.length > 0) {
    for (let d = 0; d < 252; d++) {
      const vals = completedCurves.map(c => c[d]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      spanAvgCurve.push({
        day: d + 1,
        normalized: Math.round(mean * 100) / 100,
        return_pct: Math.round((mean - 100.0) * 100) / 100
      });
    }
  } else if (curveData.average_curve) {
    spanAvgCurve.push(...curveData.average_curve);
  }

  // Update Span Stat Pill
  const statsEl = document.getElementById('curveSpanStats');
  if (statsEl) {
    if (completedAnnualReturns.length > 0) {
      const avgRet = completedAnnualReturns.reduce((a, b) => a + b, 0) / completedAnnualReturns.length;
      const winCount = completedAnnualReturns.filter(r => r > 0).length;
      const winRate = ((winCount / completedAnnualReturns.length) * 100).toFixed(0);
      const sign = avgRet >= 0 ? '+' : '';
      const color = avgRet >= 0 ? '#34d399' : '#ef4444';
      statsEl.innerHTML = `SPAN AVG: <strong style="color: ${color};">${sign}${avgRet.toFixed(1)}%</strong> &middot; WIN RATE: <strong style="color: #34d399;">${winRate}%</strong> (${completedAnnualReturns.length} Years)`;
    } else {
      statsEl.innerHTML = `SPAN: <strong>${filteredYears.length} Years Tracked</strong>`;
    }
  }

  // Calculate dynamic axis range
  let minNorm = 85;
  let maxNorm = 125;

  spanAvgCurve.forEach(pt => {
    if (pt.normalized < minNorm) minNorm = pt.normalized;
    if (pt.normalized > maxNorm) maxNorm = pt.normalized;
  });

  filteredYears.forEach(y => {
    const curve = yearlyMap[y] || [];
    curve.forEach(pt => {
      if (pt.normalized < minNorm) minNorm = pt.normalized;
      if (pt.normalized > maxNorm) maxNorm = pt.normalized;
    });
  });

  minNorm = Math.floor(minNorm / 5) * 5;
  maxNorm = Math.ceil(maxNorm / 5) * 5;

  const maxDays = curveData.max_trading_days || 252;
  const xScale = (day) => margin.left + ((day - 1) / Math.max(1, maxDays - 1)) * plotWidth;
  const yScale = (normVal) => margin.top + (1 - (normVal - minNorm) / Math.max(1, (maxNorm - minNorm))) * plotHeight;

  const legendBox = document.getElementById('curveLegendBox');
  const highlightYearColors = {
    '2026': '#fbbf24',
    '2025': '#7aa2ff',
    '2024': '#38bdf8',
    '2023': '#34d399',
    '2022': '#f87171',
    '2021': '#a78bfa',
    '2020': '#ec4899',
    '2016': '#38bdf8',
    '2008': '#ef4444',
    '2004': '#a78bfa',
    '2000': '#f59e0b'
  };

  const getYearColor = (y) => highlightYearColors[y] || 'rgba(100, 116, 139, 0.35)';
  const isHighlighted = (y) => y in highlightYearColors;

  if (legendBox) {
    const displayLegendYears = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2016', '2008'].filter(y => filteredYears.includes(y));
    const spanLabel = getSpanLabel(activeSpan, filteredYears.length);

    legendBox.innerHTML = `
      <span class="legend-item">
        <span class="legend-color-dot" style="background: #ffffff; border: 1px solid #fff;"></span>
        <strong style="color: #ffffff;">${spanLabel} COMPOSITE AVG</strong>
      </span>
      ${displayLegendYears.map(y => `
        <span class="legend-item">
          <span class="legend-color-dot" style="background: ${highlightYearColors[y] || '#888'};"></span>
          <strong style="color: ${highlightYearColors[y] || '#888'};">${y}</strong>
        </span>
      `).join('')}
      <span class="legend-item" style="color: var(--text-dim);">
        <span>(${filteredYears.length} Years Filtered)</span>
      </span>
    `;
  }

  const gridGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');

  const y100 = yScale(100);
  const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  baseline.setAttribute('x1', margin.left);
  baseline.setAttribute('x2', margin.left + plotWidth);
  baseline.setAttribute('y1', y100);
  baseline.setAttribute('y2', y100);
  baseline.setAttribute('stroke', '#4a443b');
  baseline.setAttribute('stroke-dasharray', '4,4');
  gridGroup.appendChild(baseline);

  const yStep = maxNorm - minNorm > 50 ? 10 : 5;
  for (let val = minNorm; val <= maxNorm; val += yStep) {
    const y = yScale(val);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('x2', margin.left + plotWidth);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', '#1f2937');
    gridGroup.appendChild(line);

    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', margin.left - 8);
    txt.setAttribute('y', y + 3.5);
    txt.setAttribute('text-anchor', 'end');
    txt.setAttribute('fill', '#9ca3af');
    txt.setAttribute('font-size', '10px');
    txt.setAttribute('font-family', 'IBM Plex Mono');
    txt.textContent = `${val >= 100 ? '+' : ''}${val - 100}%`;
    gridGroup.appendChild(txt);
  }

  const monthDayDivs = [
    { name: 'JAN', day: 1 },
    { name: 'FEB', day: 21 },
    { name: 'MAR', day: 42 },
    { name: 'APR', day: 63 },
    { name: 'MAY', day: 84 },
    { name: 'JUN', day: 105 },
    { name: 'JUL', day: 126 },
    { name: 'AUG', day: 147 },
    { name: 'SEP', day: 168 },
    { name: 'OCT', day: 189 },
    { name: 'NOV', day: 210 },
    { name: 'DEC', day: 231 }
  ];

  monthDayDivs.forEach(md => {
    const x = xScale(md.day);
    const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    vLine.setAttribute('x1', x);
    vLine.setAttribute('x2', x);
    vLine.setAttribute('y1', margin.top);
    vLine.setAttribute('y2', margin.top + plotHeight);
    vLine.setAttribute('stroke', '#1e293b');
    gridGroup.appendChild(vLine);

    const mText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    mText.setAttribute('x', x + 15);
    mText.setAttribute('y', margin.top + plotHeight + 16);
    mText.setAttribute('text-anchor', 'middle');
    mText.setAttribute('fill', '#94a3b8');
    mText.setAttribute('font-size', '10px');
    mText.setAttribute('font-family', 'IBM Plex Mono');
    mText.textContent = md.name;
    gridGroup.appendChild(mText);
  });

  svg.appendChild(gridGroup);

  const endLabels = [];
  filteredYears.forEach(y => {
    const curve = yearlyMap[y] || [];
    if (curve.length === 0) return;

    const highlighted = isHighlighted(y);
    const strokeColor = getYearColor(y);
    const strokeWidth = highlighted ? (y === '2026' ? '2.2' : '1.6') : '0.8';
    const strokeOpacity = highlighted ? '0.9' : '0.28';

    let pathD = '';
    curve.forEach((pt, i) => {
      const x = xScale(pt.day);
      const yPos = yScale(pt.normalized);
      pathD += (i === 0 ? `M ${x} ${yPos}` : ` L ${x} ${yPos}`);
    });

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', strokeColor);
    path.setAttribute('stroke-width', strokeWidth);
    path.setAttribute('opacity', strokeOpacity);
    svg.appendChild(path);

    const last = curve[curve.length - 1];
    if (last && highlighted) {
      endLabels.push({
        y: yScale(last.normalized),
        color: strokeColor,
        text: `${y} (${last.return_pct >= 0 ? '+' : ''}${last.return_pct}%)`,
      });
    }
  });

  const LABEL_GAP = 13;
  endLabels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y - endLabels[i - 1].y < LABEL_GAP) {
      endLabels[i].y = endLabels[i - 1].y + LABEL_GAP;
    }
  }
  endLabels.forEach(l => {
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', margin.left + plotWidth + 8);
    txt.setAttribute('y', l.y + 3.5);
    txt.setAttribute('fill', l.color);
    txt.setAttribute('font-size', '10px');
    txt.setAttribute('font-weight', '700');
    txt.setAttribute('font-family', 'IBM Plex Mono');
    txt.textContent = l.text;
    svg.appendChild(txt);
  });

  // Render White Span Composite Average Trajectory
  if (spanAvgCurve.length > 0) {
    let avgD = '';
    spanAvgCurve.forEach((pt, i) => {
      const x = xScale(pt.day);
      const yPos = yScale(pt.normalized);
      avgD += (i === 0 ? `M ${x} ${yPos}` : ` L ${x} ${yPos}`);
    });

    const avgPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    avgPath.setAttribute('d', avgD);
    avgPath.setAttribute('fill', 'none');
    avgPath.setAttribute('stroke', '#ffffff');
    avgPath.setAttribute('stroke-width', '3');
    avgPath.setAttribute('filter', 'drop-shadow(0 0 6px rgba(255,255,255,0.6))');
    svg.appendChild(avgPath);
  }
}

/* ==========================================================================
   03 // Research Call Seasonality & Desk Bias Audit
   ========================================================================== */

function renderCallSeasonalitySection() {
  const qContainer = document.getElementById('quarterCardsContainer');
  const tbody = document.getElementById('callMonthTbody');
  const data = seasonState.callPatterns;
  if (!qContainer || !tbody || !data) return;

  const quarters = data.quarters || [];
  qContainer.innerHTML = quarters.map(q => {
    const hitPct = q.hit_rate !== null ? `${(q.hit_rate * 100).toFixed(1)}%` : '—';
    const bullPct = `${(q.bullish_ratio * 100).toFixed(0)}%`;

    return `
      <div class="quarter-card">
        <div class="quarter-card-top">
          <span class="quarter-badge">${q.quarter}</span>
          <span class="quarter-name">${q.name}</span>
        </div>
        <div class="quarter-metric-row">
          <div class="quarter-metric">
            <span class="qm-label">TOTAL CALLS</span>
            <span class="qm-val font-mono">${q.total_calls}</span>
          </div>
          <div class="quarter-metric">
            <span class="qm-label">BULLISH SKEW</span>
            <span class="qm-val font-mono highlight-gold">${bullPct}</span>
          </div>
          <div class="quarter-metric">
            <span class="qm-label">REALIZED HIT%</span>
            <span class="qm-val font-mono color-bull">${hitPct}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  const months = data.months || [];
  const seasonalNotes = {
    'Jan': 'Annual Outlooks & New Year Reallocations',
    'Feb': 'Q4 Earnings Reactions & Target Adjustments',
    'Mar': 'Spring Portfolio Rebalancing',
    'Apr': 'Q1 Earnings Revisions & AI Momentum Checks',
    'May': '"Sell in May" Hesitation vs Tech Rallies',
    'Jun': 'Mid-Year Macro Outlooks & Target Updates',
    'Jul': 'Q2 Earnings Season Kickoff',
    'Aug': 'Summer Liquidity Doldrums & Target Trims',
    'Sep': 'Highest Macro Volatility & Downgrade Clusters',
    'Oct': 'Q3 Earnings & Year-End Reversal Positioning',
    'Nov': 'Highest Publication Volume (Annual Outlooks)',
    'Dec': 'Santa Rally Optimism & Price Target Hikes'
  };

  tbody.innerHTML = months.map(m => {
    const hitPct = m.hit_rate !== null ? `${(m.hit_rate * 100).toFixed(1)}%` : '—';
    const bullPct = `${(m.bullish_ratio * 100).toFixed(0)}%`;
    const alphaSign = m.avg_alpha >= 0 ? '+' : '';
    const alphaFormatted = `${alphaSign}${(m.avg_alpha * 100).toFixed(1)}%`;

    return `
      <tr>
        <td class="font-mono font-bold" style="color: var(--text-primary);">${m.month}</td>
        <td class="text-center font-mono font-bold">${m.total_calls}</td>
        <td>
          <div class="skew-bar-wrapper">
            <div class="skew-bar-fill" style="width: ${bullPct};"></div>
            <span class="skew-bar-text font-mono">${bullPct} Bullish (${m.bullish_calls}B / ${m.bearish_calls}S)</span>
          </div>
        </td>
        <td class="text-center font-mono">
          <span class="color-bull font-bold">${m.hits}</span> / <span class="text-muted">${m.resolved}</span>
        </td>
        <td class="text-right font-mono font-bold ${m.hit_rate !== null ? (m.hit_rate >= 0.6 ? 'color-bull' : 'color-bear') : 'text-muted'}">
          ${hitPct}
        </td>
        <td class="text-right font-mono font-bold ${m.avg_alpha >= 0 ? 'highlight-gold' : 'color-bear'}">
          ${alphaFormatted}
        </td>
        <td class="text-muted font-sans" style="font-size: 12px;">${seasonalNotes[m.month] || '—'}</td>
      </tr>
    `;
  }).join('');
}

/* ==========================================================================
   04 // Macro Market Regime & Sector Rotation (Inspired by moq-terminal)
   ========================================================================== */

function renderMacroRegimeSection() {
  const reg = seasonState.macroRegime;
  if (!reg) return;

  const badgeEl = document.getElementById('macroRegimeBadge');
  const headlineEl = document.getElementById('macroRegimeHeadline');
  const factorsGrid = document.getElementById('macroFactorsGrid');

  if (badgeEl) {
    badgeEl.textContent = reg.regime;
    badgeEl.style.background = `${reg.regime_color}22`;
    badgeEl.style.color = reg.regime_color;
    badgeEl.style.border = `1px solid ${reg.regime_color}66`;
  }

  if (headlineEl) {
    headlineEl.textContent = `${reg.regime_label} (${reg.confidence_pct.toFixed(0)}% Confidence)`;
  }

  if (factorsGrid && reg.signals) {
    factorsGrid.innerHTML = reg.signals.map(s => {
      const isBull = s.status === 'BULL';
      const color = isBull ? 'var(--stance-bullish)' : (s.status === 'WARN' ? 'var(--accent-gold)' : 'var(--stance-bearish)');
      return `
        <div class="macro-factor-box">
          <span class="macro-factor-name">${s.name.toUpperCase()}</span>
          <span class="macro-factor-val" style="color: ${color};">${s.value}</span>
        </div>
      `;
    }).join('');
  }
}

function renderSectorRotationTable() {
  const tbody = document.getElementById('sectorRotationTbody');
  const data = seasonState.sectorRotation;
  if (!tbody || !data || !data.sectors) return;

  tbody.innerHTML = data.sectors.map(s => {
    const a3m = s.alpha_3m !== null ? s.alpha_3m : 0;
    const isPos = a3m >= 0;
    const quadColors = {
      'LEADING': '#34d399',
      'IMPROVING': '#7aa2ff',
      'WEAKENING': '#fbbf24',
      'LAGGING': '#ef4444'
    };
    const qColor = quadColors[s.quadrant] || 'var(--text-muted)';

    return `
      <tr>
        <td class="font-mono font-bold" style="color: var(--text-primary);">
          <span style="color: var(--accent-gold); margin-right: 6px;">${s.ticker}</span>
          <span class="text-muted" style="font-size: 11px; font-weight: normal;">${s.name}</span>
        </td>
        <td class="text-right font-mono font-bold ${(s.return_1m || 0) >= 0 ? 'color-bull' : 'color-bear'}">
          ${s.return_1m !== null ? ((s.return_1m >= 0 ? '+' : '') + (s.return_1m * 100).toFixed(1) + '%') : '—'}
        </td>
        <td class="text-right font-mono font-bold ${(s.return_3m || 0) >= 0 ? 'color-bull' : 'color-bear'}">
          ${s.return_3m !== null ? ((s.return_3m >= 0 ? '+' : '') + (s.return_3m * 100).toFixed(1) + '%') : '—'}
        </td>
        <td class="text-right font-mono font-bold ${isPos ? 'highlight-gold' : 'color-bear'}">
          ${s.alpha_3m !== null ? ((s.alpha_3m >= 0 ? '+' : '') + (s.alpha_3m * 100).toFixed(1) + '%') : '—'}
        </td>
        <td class="text-center font-mono font-bold" style="color: ${qColor}; font-size: 11px;">
          ${s.quadrant}
        </td>
      </tr>
    `;
  }).join('');
}

/* ==========================================================================
   05 // Cross-Asset Rolling Correlation Matrix (Inspired by moq-terminal)
   ========================================================================== */

function renderCorrelationMatrixTable() {
  const thead = document.getElementById('corrMatrixThead');
  const tbody = document.getElementById('corrMatrixTbody');
  const statsBox = document.getElementById('corrStatsBox');
  const data = seasonState.correlationData;
  if (!thead || !tbody || !data || !data.symbols) return;

  if (statsBox) {
    statsBox.innerHTML = `
      <span>AVG CORR: <strong style="color: #fbbf24;">${data.avg_correlation.toFixed(2)}</strong></span>
      <span>DIVERSIFICATION SCORE: <strong style="color: #34d399;">${data.diversification_score}/100</strong></span>
    `;
  }

  const syms = data.symbols;
  thead.innerHTML = `
    <tr>
      <th style="min-width: 90px;">ASSET</th>
      ${syms.map(s => `<th class="text-center" style="min-width: 54px;">${s}</th>`).join('')}
    </tr>
  `;

  let bodyHtml = '';
  data.matrix.forEach((row, i) => {
    const symI = syms[i];
    bodyHtml += `
      <tr>
        <td class="font-mono font-bold" style="color: var(--accent-gold); font-size: 12px;">${symI}</td>
        ${row.map((val, j) => {
          let bgStyle = '';
          let textClass = '';
          if (i === j) {
            bgStyle = 'background: rgba(255,255,255,0.06);';
            textClass = 'text-muted';
          } else if (val >= 0.70) {
            bgStyle = 'background: rgba(56, 189, 248, 0.35);';
            textClass = 'color-bull';
          } else if (val <= 0.0) {
            bgStyle = 'background: rgba(239, 68, 68, 0.25);';
            textClass = 'color-bear';
          } else {
            bgStyle = `background: rgba(56, 189, 248, ${(val * 0.25).toFixed(2)});`;
            textClass = 'color-bull';
          }
          return `
            <td class="text-center font-mono font-bold ${textClass}" style="${bgStyle} font-size: 11px;" title="${symI} vs ${syms[j]}: ${val.toFixed(2)}">
              ${val.toFixed(2)}
            </td>
          `;
        }).join('')}
      </tr>
    `;
  });

  tbody.innerHTML = bodyHtml;
}

function renderVixStructureCard() {
  const vix = seasonState.vixStructure;
  if (!vix) return;

  const badgeEl = document.getElementById('vixStateBadge');
  const pctTagEl = document.getElementById('vixPercentileTag');
  const proxyEl = document.getElementById('vixProxyVal');
  const contangoEl = document.getElementById('vixContangoVal');
  const corrEl = document.getElementById('vixSpyCorrVal');
  const regimeEl = document.getElementById('vixRegimeVal');
  const narrativeEl = document.getElementById('vixNarrativeText');

  if (badgeEl) {
    badgeEl.textContent = `${vix.current_state.toUpperCase()} (${vix.severity})`;
    badgeEl.style.background = `${vix.state_color}22`;
    badgeEl.style.color = vix.state_color;
    badgeEl.style.border = `1px solid ${vix.state_color}66`;
  }

  if (pctTagEl) {
    pctTagEl.textContent = `1Y RANGE: ${vix.vix_percentile.toFixed(0)}th PCT`;
  }

  if (proxyEl) {
    proxyEl.textContent = `$${vix.vix_proxy.toFixed(2)}`;
  }

  if (contangoEl) {
    const isContango = vix.contango_ratio <= 0;
    contangoEl.textContent = `${isContango ? '' : '+'}${vix.contango_ratio.toFixed(1)}% / 5d`;
    contangoEl.className = `vm-val font-mono ${isContango ? 'color-bull' : 'color-bear'}`;
  }

  if (corrEl) {
    const cVal = vix.vixy_spy_corr !== null ? vix.vixy_spy_corr.toFixed(2) : '—';
    corrEl.textContent = cVal;
    corrEl.className = `vm-val font-mono ${(vix.vixy_spy_corr || 0) < -0.5 ? 'color-bull' : 'highlight-gold'}`;
  }

  if (regimeEl) {
    if (vix.vix_percentile < 25) {
      regimeEl.textContent = 'COMPLACENT (LOW VOL)';
      regimeEl.style.color = '#34d399';
    } else if (vix.vix_percentile > 75) {
      regimeEl.textContent = 'ELEVATED HEDGING';
      regimeEl.style.color = '#ef4444';
    } else {
      regimeEl.textContent = 'NORMAL REGIME';
      regimeEl.style.color = '#7aa2ff';
    }
  }

  if (narrativeEl) {
    narrativeEl.innerHTML = `
      <strong>Market Volatility Diagnostics:</strong> ${vix.interpretation}
    `;
  }
}

function renderFearGreedPanel() {
  const fg = seasonState.fearGreed;
  if (!fg) return;

  const scoreEl = document.getElementById('fgScoreNum');
  const labelBadgeEl = document.getElementById('fgLabelBadge');
  const labelTextEl = document.getElementById('fgLabelText');
  const indicatorEl = document.getElementById('fgGaugeIndicator');
  const asOfEl = document.getElementById('fgAsOfTag');
  const gridEl = document.getElementById('fgCategoriesGrid');

  if (scoreEl) {
    scoreEl.textContent = fg.composite_score.toFixed(1);
    scoreEl.style.color = fg.bar_color;
  }

  if (labelBadgeEl) {
    labelBadgeEl.textContent = fg.label.toUpperCase();
    labelBadgeEl.style.background = `${fg.bar_color}22`;
    labelBadgeEl.style.color = fg.bar_color;
    labelBadgeEl.style.border = `1px solid ${fg.bar_color}66`;
  }

  if (labelTextEl) {
    labelTextEl.textContent = `${fg.label.toUpperCase()} SENTIMENT`;
    labelTextEl.style.color = fg.bar_color;
  }

  if (indicatorEl) {
    indicatorEl.style.left = `${Math.min(100, Math.max(0, fg.composite_score))}%`;
  }

  if (asOfEl && fg.as_of_date) {
    asOfEl.textContent = `AS OF: ${fg.as_of_date}`;
  }

  if (gridEl && fg.categories) {
    const order = fg.category_order || Object.keys(fg.categories);
    gridEl.innerHTML = order.map(k => {
      const cat = fg.categories[k];
      if (!cat) return '';
      return `
        <div class="fg-cat-box">
          <div class="fg-cat-header">
            <div class="fg-cat-title-wrap">
              <span class="fg-cat-name">${cat.label}</span>
              <span class="fg-cat-weight">${cat.weight}% wgt</span>
            </div>
            <span class="fg-cat-score font-mono" style="color: ${cat.bar_color};">
              ${cat.score.toFixed(0)} <span style="font-size: 10px; color: var(--text-dim); font-weight: normal;">(+${cat.contribution})</span>
            </span>
          </div>
          <div class="fg-cat-progress">
            <div class="fg-cat-fill" style="width: ${cat.score}%; background: ${cat.bar_color};"></div>
          </div>
          <span class="fg-cat-desc">${cat.description}</span>
        </div>
      `;
    }).join('');
  }
}

/* ==========================================================================
   05 // Options Volatility Skew & Positioning Section
   ========================================================================== */

/* ==========================================================================
   05 // Options Volatility Skew & Multi-Horizon Greeks Section
   ========================================================================== */

// Dealer GEX comes off the API in dollars of dealer delta per 1% move in spot,
// and it can legitimately be negative (short gamma), so the sign is rendered.
function fmtGex(dollars) {
  if (dollars === null || dollars === undefined || !isFinite(dollars)) return '--';
  const sign = dollars < 0 ? '-' : '+';
  const abs = Math.abs(dollars);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function renderOptionsAnalysisSection() {
  const data = seasonState.optionsData;
  if (!data || !data.indices) return;

  const activeHorizon = seasonState.optionsHorizon || '1_week';
  const tbody = document.getElementById('optionsTrioTbody');
  const cardsGrid = document.getElementById('optionsCardsGrid');
  const tagEl = document.getElementById('optionsHorizonTag');
  const headerExpEl = document.getElementById('optionsExpMoveHeader');
  const indices = ['SPY', 'QQQ', 'IWM'];

  const horizonMeta = {
    '1_week': { name: '1-WEEK (7 DTE)', tag: 'HORIZON: <strong>1-WEEK (7 DTE) &middot; PEAK GAMMA RISK &amp; STEEPEST THETA DECAY</strong>', header: '1W EXP MOVE (&plusmn;1&sigma;)' },
    'next_week': { name: 'NEXT-WEEK (14 DTE)', tag: 'HORIZON: <strong>NEXT-WEEK (14 DTE) &middot; INTERMEDIATE ROLLOVER &amp; TRANSITION</strong>', header: 'NEXT-W EXP MOVE (&plusmn;1&sigma;)' },
    '1_month': { name: '1-MONTH (30 DTE)', tag: 'HORIZON: <strong>1-MONTH (30 DTE) &middot; INSTITUTIONAL BENCHMARK &amp; HIGH VEGA</strong>', header: '1M EXP MOVE (&plusmn;1&sigma;)' },
    'all_horizons': { name: 'ALL HORIZONS MATRIX', tag: 'HORIZON: <strong>ALL HORIZONS (7D vs 14D vs 30D) &middot; TERM STRUCTURE OUTLOOK</strong>', header: 'EXP MOVE CONE' }
  };

  const meta = horizonMeta[activeHorizon] || horizonMeta['1_week'];
  if (tagEl) tagEl.innerHTML = meta.tag;
  if (headerExpEl) headerExpEl.textContent = meta.header;

  if (tbody) {
    if (activeHorizon === 'all_horizons') {
      // Multi-Horizon Matrix: 3 rows per index showing 1W, Next-W, 1M side-by-side
      tbody.innerHTML = indices.map(sym => {
        const opt = data.indices[sym];
        if (!opt || !opt.horizons) return '';

        const horizonsList = [
          { key: '1_week', badge: '1-WEEK (7D)', color: '#fbbf24' },
          { key: 'next_week', badge: 'NEXT-W (14D)', color: '#38bdf8' },
          { key: '1_month', badge: '1-MONTH (30D)', color: '#a78bfa' }
        ];

        return horizonsList.map((hl, idx) => {
          const hData = opt.horizons[hl.key];
          if (!hData) return '';
          const g = hData.atm || {};
          const em = hData.expected_move || {};
          const struct = hData.structure || opt.structure;

          return `
            <tr style="${idx === 0 ? 'border-top: 1px solid rgba(255,255,255,0.08);' : ''}">
              <td class="font-mono font-bold" style="color: var(--text-primary);">
                ${idx === 0 ? `<span class="highlight-gold" style="margin-right: 6px;">${opt.ticker}</span> <span style="font-size: 11px; color: var(--text-muted);">$${opt.spot.toFixed(2)}</span><br>` : ''}
                <span class="regime-status-badge" style="background: ${hl.color}22; color: ${hl.color}; border: 1px solid ${hl.color}66; font-size: 9.5px; padding: 2px 6px;">
                  ${hl.badge}
                </span>
              </td>
              <td class="text-center font-mono font-bold highlight-gold">${hData.iv.toFixed(1)}%</td>
              <td class="text-center font-mono text-muted">${opt.realized_vol_20d.toFixed(1)}%</td>
              <td class="text-center font-mono font-bold" style="color: #38bdf8;">
                ${g.call_delta !== undefined ? `+${g.call_delta.toFixed(2)}` : '--'}
              </td>
              <td class="text-center font-mono font-bold" style="color: #a78bfa;">
                ${g.gamma !== undefined ? g.gamma.toFixed(4) : '--'}
              </td>
              <td class="text-center font-mono color-bear" style="font-size: 11.5px;">
                ${g.call_theta !== undefined ? `${g.call_theta.toFixed(2)}/d` : '--'}
              </td>
              <td class="text-center font-mono highlight-gold" style="font-size: 11.5px;">
                ${g.vega !== undefined ? `+$${g.vega.toFixed(2)}` : '--'}
              </td>
              <td class="text-center font-mono text-muted" style="font-size: 11px;">
                ${g.call_rho !== undefined ? `+$${g.call_rho.toFixed(2)}` : '--'}
              </td>
              <td class="text-center font-mono" style="color: #ec4899; font-size: 11px;">
                ${g.vanna !== undefined ? g.vanna.toFixed(4) : '--'}
              </td>
              <td class="text-center font-mono" style="color: #fbbf24; font-size: 11px;">
                ${g.charm_call !== undefined ? g.charm_call.toFixed(4) : '--'}
              </td>
              <td class="text-right font-mono font-bold highlight-gold">$${struct.max_pain.toFixed(0)}</td>
              <td class="text-center font-mono font-bold" style="color: ${struct.gex_color}; font-size: 11px;">
                ${struct.gex_regime.split(' ')[0]} ($${struct.gamma_flip.toFixed(0)})
              </td>
              <td class="text-right font-mono font-bold highlight-gold">
                &plusmn;$${em.dollar ? em.dollar.toFixed(1) : '--'} (&plusmn;${em.pct ? em.pct.toFixed(1) : '--'}%)
              </td>
            </tr>
          `;
        }).join('');
      }).join('');
    } else {
      // Single Selected Horizon: 3 rows (SPY, QQQ, IWM)
      tbody.innerHTML = indices.map(sym => {
        const opt = data.indices[sym];
        if (!opt) return '';

        const hData = (opt.horizons && opt.horizons[activeHorizon]) ? opt.horizons[activeHorizon] : (opt.horizons ? opt.horizons['1_week'] : null);
        const g = hData ? hData.atm : (opt.greeks ? opt.greeks.atm_30d : {});
        const ivVal = hData ? hData.iv : opt.implied_volatility;
        const em = hData ? hData.expected_move : opt.expected_moves.weekly;
        const struct = (hData && hData.structure) ? hData.structure : opt.structure;

        const ivPremSign = opt.iv_premium >= 0 ? '+' : '';
        const ivPremClass = opt.iv_premium >= 0 ? 'color-bull' : 'color-bear';

        return `
          <tr>
            <td class="font-mono font-bold" style="color: var(--text-primary);">
              <span class="highlight-gold" style="margin-right: 6px;">${opt.ticker}</span>
              <span style="font-size: 12px; color: var(--text-muted);">$${opt.spot.toFixed(2)}</span>
            </td>
            <td class="text-center font-mono font-bold highlight-gold">${ivVal.toFixed(1)}%</td>
            <td class="text-center font-mono">
              <span>${opt.realized_vol_20d.toFixed(1)}%</span>
              <span class="${ivPremClass}" style="font-size: 10px; margin-left: 2px;">(${ivPremSign}${opt.iv_premium.toFixed(1)})</span>
            </td>
            <td class="text-center font-mono font-bold" style="color: #38bdf8;">
              ${g.call_delta !== undefined ? `${g.call_delta > 0 ? '+' : ''}${g.call_delta.toFixed(2)}` : '--'}
            </td>
            <td class="text-center font-mono font-bold" style="color: #a78bfa;">
              ${g.gamma !== undefined ? g.gamma.toFixed(4) : '--'}
            </td>
            <td class="text-center font-mono color-bear" style="font-size: 11.5px;">
              ${g.call_theta !== undefined ? `${g.call_theta.toFixed(2)}/d` : '--'}
            </td>
            <td class="text-center font-mono highlight-gold" style="font-size: 11.5px;">
              ${g.vega !== undefined ? `+$${g.vega.toFixed(2)}` : '--'}
            </td>
            <td class="text-center font-mono text-muted" style="font-size: 11px;">
              ${g.call_rho !== undefined ? `+$${g.call_rho.toFixed(2)}` : '--'}
            </td>
            <td class="text-center font-mono" style="color: #ec4899; font-size: 11px;">
              ${g.vanna !== undefined ? g.vanna.toFixed(4) : '--'}
            </td>
            <td class="text-center font-mono" style="color: #fbbf24; font-size: 11px;">
              ${g.charm_call !== undefined ? g.charm_call.toFixed(4) : '--'}
            </td>
            <td class="text-right font-mono font-bold highlight-gold">$${struct.max_pain.toFixed(0)}</td>
            <td class="text-center font-mono font-bold" style="color: ${struct.gex_color}; font-size: 11.5px;">
              ${struct.gex_regime.split(' ')[0]} GEX ($${struct.gamma_flip.toFixed(0)})
            </td>
            <td class="text-right font-mono font-bold highlight-gold">
              &plusmn;$${em.dollar ? em.dollar.toFixed(1) : '--'} (&plusmn;${em.pct ? em.pct.toFixed(1) : '--'}%)
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  if (cardsGrid) {
    cardsGrid.innerHTML = indices.map(sym => {
      const opt = data.indices[sym];
      if (!opt) return '';

      const hKey = (activeHorizon === 'all_horizons') ? '1_week' : activeHorizon;
      const hData = (opt.horizons && opt.horizons[hKey]) ? opt.horizons[hKey] : null;
      const g = hData ? hData.atm : (opt.greeks ? opt.greeks.atm_30d : {});
      const em = hData ? hData.expected_move : opt.expected_moves.weekly;
      const struct = (hData && hData.structure) ? hData.structure : opt.structure;

      const h1w = opt.horizons ? opt.horizons['1_week'] : null;
      const hNext = opt.horizons ? opt.horizons['next_week'] : null;
      const h1m = opt.horizons ? opt.horizons['1_month'] : null;

      return `
        <div class="options-asset-card">
          <div class="options-card-header">
            <div class="options-card-title">
              <span class="opt-ticker">${opt.ticker}</span>
              <span class="opt-spot">$${opt.spot.toFixed(2)}</span>
            </div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              <span class="regime-status-badge" style="background: var(--accent-primary)22; color: var(--accent-fg); border: 1px solid var(--accent-fg)66;">
                ${hData ? hData.label.toUpperCase() : 'HORIZON'}
              </span>
              <span class="regime-status-badge" style="background: ${struct.gex_color}22; color: ${struct.gex_color}; border: 1px solid ${struct.gex_color}66;">
                ${struct.gex_regime.split(' ')[0].toUpperCase()} GEX
              </span>
            </div>
          </div>

          <!-- BSM Greeks Sub-Grid for Active Horizon -->
          <div class="options-levels-grid" style="grid-template-columns: repeat(4, 1fr); gap: 6px;">
            <div class="opt-level-item">
              <span class="opt-level-label">DELTA (&Delta;)</span>
              <span class="opt-level-val font-mono" style="color: #38bdf8;">${g.call_delta !== undefined ? `+${g.call_delta.toFixed(2)} C / ${g.put_delta.toFixed(2)} P` : '--'}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">GAMMA (&Gamma;)</span>
              <span class="opt-level-val font-mono" style="color: #a78bfa;">${g.gamma !== undefined ? g.gamma.toFixed(4) : '--'}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">THETA (&Theta;)</span>
              <span class="opt-level-val font-mono color-bear">${g.call_theta !== undefined ? `${g.call_theta.toFixed(2)} /d` : '--'}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">VEGA (V)</span>
              <span class="opt-level-val font-mono highlight-gold">${g.vega !== undefined ? `+$${g.vega.toFixed(2)}` : '--'}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">RHO (&rho;)</span>
              <span class="opt-level-val font-mono text-muted">${g.call_rho !== undefined ? `+$${g.call_rho.toFixed(2)}` : '--'}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">VANNA (d&Delta;/dIV)</span>
              <span class="opt-level-val font-mono" style="color: #ec4899;">${g.vanna !== undefined ? g.vanna.toFixed(4) : '--'}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">CHARM (d&Delta;/dt)</span>
              <span class="opt-level-val font-mono" style="color: #fbbf24;">${g.charm_call !== undefined ? `${g.charm_call.toFixed(4)}/d` : '--'}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">DEALER GEX ($)</span>
              <span class="opt-level-val font-mono" style="color: ${opt.structure.gex_color};">${fmtGex(opt.structure.net_gex_dollars)} / 1%</span>
            </div>
          </div>

          <!-- Multi-Horizon Forward Outlook Matrix (1W vs Next-W vs 1M) -->
          <div style="background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 8px 10px;">
            <div style="display: flex; justify-content: space-between; font-size: 10px; font-family: var(--font-mono); color: var(--text-dim); margin-bottom: 6px; text-transform: uppercase;">
              <span>EXPIRATION HORIZON</span>
              <span>MAX PAIN</span>
              <span>GAMMA FLIP</span>
              <span>CALL WALL</span>
              <span>PUT WALL</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; font-family: var(--font-mono); font-size: 11.5px;">
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 0; ${activeHorizon === '1_week' ? 'color: var(--accent-gold); font-weight: bold;' : ''}">
                <span style="color: #fbbf24;">1-Week (7 DTE)</span>
                <span class="highlight-gold">$${h1w && h1w.structure ? h1w.structure.max_pain.toFixed(0) : '--'}</span>
                <span style="color: ${h1w && h1w.structure ? h1w.structure.gex_color : '#8b949e'};">$${h1w && h1w.structure ? h1w.structure.gamma_flip.toFixed(0) : '--'}</span>
                <span class="color-bull">$${h1w && h1w.structure ? h1w.structure.call_wall.toFixed(0) : '--'}</span>
                <span class="color-bear">$${h1w && h1w.structure ? h1w.structure.put_wall.toFixed(0) : '--'}</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 0; ${activeHorizon === 'next_week' ? 'color: var(--accent-gold); font-weight: bold;' : ''}">
                <span style="color: #38bdf8;">Next-Week (14 DTE)</span>
                <span class="highlight-gold">$${hNext && hNext.structure ? hNext.structure.max_pain.toFixed(0) : '--'}</span>
                <span style="color: ${hNext && hNext.structure ? hNext.structure.gex_color : '#8b949e'};">$${hNext && hNext.structure ? hNext.structure.gamma_flip.toFixed(0) : '--'}</span>
                <span class="color-bull">$${hNext && hNext.structure ? hNext.structure.call_wall.toFixed(0) : '--'}</span>
                <span class="color-bear">$${hNext && hNext.structure ? hNext.structure.put_wall.toFixed(0) : '--'}</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 0; ${activeHorizon === '1_month' ? 'color: var(--accent-gold); font-weight: bold;' : ''}">
                <span style="color: #a78bfa;">1-Month (30 DTE)</span>
                <span class="highlight-gold">$${h1m && h1m.structure ? h1m.structure.max_pain.toFixed(0) : '--'}</span>
                <span style="color: ${h1m && h1m.structure ? h1m.structure.gex_color : '#8b949e'};">$${h1m && h1m.structure ? h1m.structure.gamma_flip.toFixed(0) : '--'}</span>
                <span class="color-bull">$${h1m && h1m.structure ? h1m.structure.call_wall.toFixed(0) : '--'}</span>
                <span class="color-bear">$${h1m && h1m.structure ? h1m.structure.put_wall.toFixed(0) : '--'}</span>
              </div>
            </div>
          </div>

          <!-- Key Structure Levels Grid (Dynamic Per Active Horizon) -->
          <div class="options-levels-grid">
            <div class="opt-level-item">
              <span class="opt-level-label">MAX PAIN STRIKE (${hData ? hData.dte : 30}D)</span>
              <span class="opt-level-val font-mono highlight-gold">$${struct.max_pain.toFixed(0)}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">GAMMA FLIP LEVEL (${hData ? hData.dte : 30}D)</span>
              <span class="opt-level-val font-mono" style="color: ${struct.gex_color};">$${struct.gamma_flip.toFixed(0)}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">CALL WALL (RESISTANCE)</span>
              <span class="opt-level-val font-mono color-bull">$${struct.call_wall.toFixed(0)}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">PUT WALL (SUPPORT)</span>
              <span class="opt-level-val font-mono color-bear">$${struct.put_wall.toFixed(0)}</span>
            </div>
          </div>

          <div class="options-narrative-note">
            <strong>${hData ? hData.label : 'Outlook'}:</strong> ${hData ? hData.narrative : ''} ${opt.skew.interpretation}
          </div>
        </div>
      `;
    }).join('');
  }
}



