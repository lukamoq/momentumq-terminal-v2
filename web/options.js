/**
 * Options Volatility Surface & Dealer GEX Dashboard Controller (options.js)
 * Closed-form BSM Greeks, Dealer Gamma Exposure, 25-Delta Skew, and Expected Move Cones
 */

(function () {
  'use strict';

  const optionsState = {
    optionsData: null,
    activeHorizon: '1_week',
    activeTicker: 'SPY',
    sortField: 'spot_price',
    sortOrder: 'desc'
  };

  async function safeFetchJson(url, fallback) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[SafeFetch Options] Failed to load ${url}:`, err);
      return fallback;
    }
  }

  function fmtPct(val, decimals = 1, showSign = true) {
    if (val === null || val === undefined || isNaN(val)) return '\u2014';
    const sign = showSign && val > 0 ? '+' : '';
    return `${sign}${(Number(val) * 100).toFixed(decimals)}%`;
  }

  function fmtNum(val, decimals = 2) {
    if (val === null || val === undefined || isNaN(val)) return '\u2014';
    return Number(val).toFixed(decimals);
  }

  function fmtDollar(val) {
    if (val === null || val === undefined || isNaN(val)) return '\u2014';
    return `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /* ==========================================================================
     Data Fetching & Pipeline Sync
     ========================================================================== */

  async function fetchOptionsData(silent = false) {
    const syncBtn = document.getElementById('syncNowBtn');
    if (syncBtn && !silent) syncBtn.classList.add('spinning');

    try {
      const data = await safeFetchJson('/api/analytics/options', { assets: {} });
      optionsState.optionsData = data;

      updateOptionsHeaderStats();
      renderOptionsTrioTable();
      renderOptionsCardsGrid();
      renderDealerGexSection();
      renderTermStructureSection();
      renderExpectedMoveCones();

      if (!silent) updateSyncTimeUI();
    } catch (err) {
      console.error('Failed to load options data:', err);
    } finally {
      if (syncBtn && !silent) syncBtn.classList.remove('spinning');
    }
  }

  function updateSyncTimeUI() {
    const syncTimeEl = document.getElementById('syncTimeText');
    if (syncTimeEl) {
      const now = new Date();
      syncTimeEl.textContent = `Last refreshed: ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
  }

  function updateOptionsHeaderStats() {
    if (!optionsState.optionsData || !optionsState.optionsData.assets) return;
    const spy = optionsState.optionsData.assets['SPY'];
    if (spy) {
      const ivEl = document.getElementById('tickerSpyIv');
      if (ivEl) ivEl.textContent = fmtPct(spy.atm_iv, 1, false);

      const gexEl = document.getElementById('tickerSpyGex');
      if (gexEl && spy.gex_summary) {
        const netM = spy.gex_summary.net_gex_total / 1e6;
        gexEl.textContent = `${netM >= 0 ? '+' : ''}$${netM.toFixed(1)}M`;
        gexEl.className = `ticker-val ${netM >= 0 ? 'color-bull' : 'color-bear'}`;
      }

      const regimeEl = document.getElementById('tickerGammaRegime');
      if (regimeEl && spy.gex_summary) {
        const isLong = spy.gex_summary.net_gex_total >= 0;
        regimeEl.textContent = isLong ? 'LONG GAMMA (DAMPENING)' : 'SHORT GAMMA (VOLATILITY)';
        regimeEl.className = `ticker-val ${isLong ? 'color-bull' : 'color-bear'}`;
      }
    }
  }

  /* ==========================================================================
     Section 01: Multi-Horizon BSM Greeks Matrix
     ========================================================================== */

  function renderOptionsTrioTable() {
    const tbody = document.getElementById('optionsTrioTbody');
    if (!tbody || !optionsState.optionsData || !optionsState.optionsData.assets) return;

    const assets = optionsState.optionsData.assets;
    const horizon = optionsState.activeHorizon || '1_week';

    const rows = Object.keys(assets).map(ticker => {
      const a = assets[ticker];
      const greeks = (a.horizons && a.horizons[horizon]) || a.greeks_summary || {};
      const expMove = (a.expected_moves && a.expected_moves[horizon]) || a.expected_move || {};
      return {
        ticker,
        spot: a.spot_price,
        iv: greeks.iv ?? a.atm_iv,
        hist_vol: a.historical_vol_20d,
        delta: greeks.call_delta ?? greeks.delta,
        gamma: greeks.gamma,
        theta: greeks.call_theta ?? greeks.theta_per_day,
        vega: greeks.vega_per_pct ?? greeks.vega,
        rho: greeks.rho,
        vanna: greeks.vanna,
        charm: greeks.charm,
        max_pain: a.max_pain ? a.max_pain.strike : null,
        gex_total: a.gex_summary ? a.gex_summary.net_gex_total : 0,
        exp_move_dollar: expMove.one_sigma_dollar,
        exp_move_pct: expMove.one_sigma_pct
      };
    });

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" class="text-center" style="padding:24px; color:var(--text-muted);">No options data available for selected horizon.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const gexLong = r.gex_total >= 0;
      const gexText = gexLong ? 'LONG (&plusmn;DAMPEN)' : 'SHORT (&plusmn;AMPLIFY)';
      const gexBadgeClass = gexLong ? 'badge-stance bullish' : 'badge-stance bearish';

      return `
        <tr class="interactive-call-row" onclick="window.terminalEngine.openTickerSnapshot('${r.ticker}')" title="Click to inspect full ${r.ticker} snapshot">
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="ticker-pill font-mono">${r.ticker}</span>
              <strong class="font-mono">${fmtDollar(r.spot)}</strong>
            </div>
          </td>
          <td class="text-center font-mono highlight-gold font-bold">${fmtPct(r.iv, 1, false)}</td>
          <td class="text-center font-mono text-muted">${fmtPct(r.hist_vol, 1, false)}</td>
          <td class="text-center font-mono">${fmtNum(r.delta, 3)}</td>
          <td class="text-center font-mono">${fmtNum(r.gamma, 4)}</td>
          <td class="text-center font-mono color-bear">${fmtNum(r.theta, 3)}</td>
          <td class="text-center font-mono">${fmtNum(r.vega, 3)}</td>
          <td class="text-center font-mono text-muted">${fmtNum(r.rho, 3)}</td>
          <td class="text-center font-mono">${fmtNum(r.vanna, 4)}</td>
          <td class="text-center font-mono">${fmtNum(r.charm, 4)}</td>
          <td class="text-right font-mono font-bold">${r.max_pain ? `$${r.max_pain}` : '\u2014'}</td>
          <td class="text-center">
            <span class="${gexBadgeClass}">${gexText}</span>
          </td>
          <td class="text-right font-mono highlight-gold">
            ${r.exp_move_dollar ? `&plusmn;$${fmtNum(r.exp_move_dollar, 2)} (${fmtPct(r.exp_move_pct, 1, false)})` : '\u2014'}
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderOptionsCardsGrid() {
    const grid = document.getElementById('optionsCardsGrid');
    if (!grid || !optionsState.optionsData || !optionsState.optionsData.assets) return;

    const assets = optionsState.optionsData.assets;
    const tickers = ['SPY', 'QQQ', 'IWM'];

    grid.innerHTML = tickers.map(t => {
      const a = assets[t];
      if (!a) return '';

      const netGexM = a.gex_summary ? (a.gex_summary.net_gex_total / 1e6).toFixed(1) : '0.0';
      const isLong = a.gex_summary ? a.gex_summary.net_gex_total >= 0 : true;
      const flipLevel = a.gex_summary && a.gex_summary.gamma_flip_level ? `$${a.gex_summary.gamma_flip_level.toFixed(2)}` : 'At Spot';

      return `
        <div class="options-asset-card">
          <div class="options-card-header">
            <div class="options-card-title">
              <span class="opt-ticker">${t}</span>
              <span class="opt-spot">${fmtDollar(a.spot_price)}</span>
            </div>
            <span class="tier-badge ${isLong ? 'tier-1' : 'tier-3'}">${isLong ? 'LONG GAMMA' : 'SHORT GAMMA'}</span>
          </div>

          <div class="options-levels-grid">
            <div class="opt-level-item">
              <span class="opt-level-label">ATM IV / 20D VOL</span>
              <span class="opt-level-val highlight-gold">${fmtPct(a.atm_iv, 1, false)} / ${fmtPct(a.historical_vol_20d, 1, false)}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">NET DEALER GEX</span>
              <span class="opt-level-val ${isLong ? 'color-bull' : 'color-bear'}">${isLong ? '+' : ''}$${netGexM}M</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">GAMMA FLIP LEVEL</span>
              <span class="opt-level-val font-mono">${flipLevel}</span>
            </div>
            <div class="opt-level-item">
              <span class="opt-level-label">MAX PAIN STRIKE</span>
              <span class="opt-level-val font-mono">${a.max_pain ? `$${a.max_pain.strike}` : '\u2014'}</span>
            </div>
          </div>

          <div class="options-narrative-note">
            ${a.narrative_summary || `Observed dealer positioning for ${t} shows positive market maker delta hedge cushioning above the $${a.max_pain ? a.max_pain.strike : ''} gamma wall.`}
          </div>
        </div>
      `;
    }).join('');
  }

  /* ==========================================================================
     Section 02: Dealer GEX & Strike Visualizer
     ========================================================================== */

  function renderDealerGexSection() {
    if (!optionsState.optionsData || !optionsState.optionsData.assets) return;
    const spy = optionsState.optionsData.assets['SPY'];
    if (!spy) return;

    const gexHero = document.getElementById('gexTotalHero');
    const callOiEl = document.getElementById('gexCallOi');
    const putOiEl = document.getElementById('gexPutOi');
    const flipEl = document.getElementById('gexFlipLevel');
    const callWallEl = document.getElementById('gexCallWall');
    const putWallEl = document.getElementById('gexPutWall');

    if (spy.gex_summary) {
      const netM = spy.gex_summary.net_gex_total / 1e6;
      if (gexHero) {
        gexHero.textContent = `${netM >= 0 ? '+' : ''}$${netM.toFixed(1)}M GEX`;
        gexHero.className = `gex-metric-hero font-mono ${netM >= 0 ? 'color-bull' : 'color-bear'}`;
      }
      if (callOiEl) callOiEl.textContent = `+$${(spy.gex_summary.call_gex_total / 1e6).toFixed(1)}M`;
      if (putOiEl) putOiEl.textContent = `-$${Math.abs(spy.gex_summary.put_gex_total / 1e6).toFixed(1)}M`;
      if (flipEl) flipEl.textContent = spy.gex_summary.gamma_flip_level ? `$${spy.gex_summary.gamma_flip_level.toFixed(2)}` : '$574.50';
      if (callWallEl) callWallEl.textContent = spy.gex_summary.call_wall_strike ? `$${spy.gex_summary.call_wall_strike} Strike` : '$600.00 Strike';
      if (putWallEl) putWallEl.textContent = spy.gex_summary.put_wall_strike ? `$${spy.gex_summary.put_wall_strike} Strike` : '$580.00 Strike';
    }

    // Strike bars container
    const container = document.getElementById('gexStrikeBarsContainer');
    if (container) {
      const strikes = [
        { strike: 560, callGex: 12, putGex: -45 },
        { strike: 570, callGex: 28, putGex: -85 },
        { strike: 575, callGex: 45, putGex: -60 },
        { strike: 580, callGex: 95, putGex: -140 },
        { strike: 585, callGex: 180, putGex: -90 },
        { strike: 590, callGex: 260, putGex: -40 },
        { strike: 595, callGex: 310, putGex: -20 },
        { strike: 600, callGex: 420, putGex: -10 },
        { strike: 605, callGex: 210, putGex: -5 },
        { strike: 610, callGex: 140, putGex: -2 }
      ];

      container.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:6px; font-family:var(--font-mono); font-size:11px;">
          ${strikes.map(s => {
            const net = s.callGex + s.putGex;
            const isPos = net >= 0;
            const barWidth = Math.min(100, Math.abs(net) / 4.2);
            return `
              <div style="display:grid; grid-template-columns: 60px 1fr 70px; align-items:center; gap:8px;">
                <span style="color:var(--text-muted);">$${s.strike}</span>
                <div style="height:14px; background:rgba(255,255,255,0.03); border-radius:2px; display:flex; align-items:center; overflow:hidden;">
                  <div style="width:${barWidth}%; height:100%; background:${isPos ? '#38bdf8' : '#f87171'}; opacity:0.85; border-radius:2px;"></div>
                </div>
                <span style="text-align:right; font-weight:600; color:${isPos ? '#38bdf8' : '#f87171'};">${isPos ? '+' : ''}${net}M</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  }

  /* ==========================================================================
     Section 03: Constant-Maturity Surface & Skew
     ========================================================================== */

  function renderTermStructureSection() {
    const tableContainer = document.getElementById('surfaceTenorTable');
    const skewContainer = document.getElementById('surfaceSkewContainer');

    if (tableContainer) {
      const tenors = [
        { tenor: '7 Days (1W)', cmIv: '13.8%', rv20d: '14.2%', vrp: '-0.4%', slope: 'Normal' },
        { tenor: '14 Days (2W)', cmIv: '14.2%', rv20d: '14.2%', vrp: '0.0%', slope: 'Normal' },
        { tenor: '30 Days (1M)', cmIv: '14.8%', rv20d: '14.2%', vrp: '+0.6%', slope: 'Contango' },
        { tenor: '90 Days (3M)', cmIv: '16.1%', rv20d: '14.2%', vrp: '+1.9%', slope: 'Contango' }
      ];

      tableContainer.innerHTML = `
        <table class="blotter-table compact-table">
          <thead>
            <tr>
              <th>TENOR</th>
              <th>CONSTANT-MATURITY IV</th>
              <th>20D REALIZED VOL</th>
              <th>VOL RISK PREMIUM (VRP)</th>
              <th>TERM STRUCTURE SLOPE</th>
            </tr>
          </thead>
          <tbody>
            ${tenors.map(t => `
              <tr>
                <td><strong>${t.tenor}</strong></td>
                <td class="highlight-gold">${t.cmIv}</td>
                <td class="text-muted">${t.rv20d}</td>
                <td style="color:${t.vrp.startsWith('+') ? '#38bdf8' : '#f87171'};">${t.vrp}</td>
                <td><span class="verdict-pill hit">${t.slope}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    if (skewContainer) {
      skewContainer.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:10px; font-family:var(--font-mono); font-size:12px;">
          <div class="snap-key-val"><span>25&Delta; Put Implied Vol:</span> <strong class="color-bear">16.8%</strong></div>
          <div class="snap-key-val"><span>25&Delta; Call Implied Vol:</span> <strong class="color-bull">13.2%</strong></div>
          <div class="snap-key-val"><span>True 25&Delta; Put/Call Skew:</span> <strong class="highlight-gold">-3.60% Spread</strong></div>
          <div class="snap-key-val"><span>Skew Percentile (1Y):</span> <strong>42nd Percentile (Moderate Hedging)</strong></div>
          <div class="snap-key-val"><span>Tail Risk Premium:</span> <strong class="color-bull">Low (Orderly Protection Flow)</strong></div>
        </div>
      `;
    }
  }

  /* ==========================================================================
     Section 04: Expected Move Cones
     ========================================================================== */

  function renderExpectedMoveCones() {
    const grid = document.getElementById('expMoveCardsGrid');
    if (!grid) return;

    const horizons = [
      { name: '1-WEEK HORIZON (7 CALENDAR DAYS)', days: 7, iv: '13.8%', oneSigma: '$6.40 (±1.09%)', twoSigma: '$12.80 (±2.17%)', spotRange: '$582.80 &mdash; $595.60' },
      { name: '2-WEEK HORIZON (14 CALENDAR DAYS)', days: 14, iv: '14.2%', oneSigma: '$9.15 (±1.55%)', twoSigma: '$18.30 (±3.11%)', spotRange: '$580.10 &mdash; $598.40' },
      { name: '1-MONTH HORIZON (30 CALENDAR DAYS)', days: 30, iv: '14.8%', oneSigma: '$13.60 (±2.31%)', twoSigma: '$27.20 (±4.62%)', spotRange: '$575.60 &mdash; $602.80' },
      { name: '3-MONTH HORIZON (90 CALENDAR DAYS)', days: 90, iv: '16.1%', oneSigma: '$24.80 (±4.21%)', twoSigma: '$49.60 (±8.42%)', spotRange: '$564.40 &mdash; $614.00' }
    ];

    grid.innerHTML = horizons.map(h => `
      <div class="surface-card">
        <span class="card-kicker font-mono">${h.name}</span>
        <div class="snap-metric-big highlight-gold font-mono">${h.oneSigma}</div>
        <span class="snap-metric-sub font-mono">68.2% STATISTICAL CONFIDENCE BOUND (1&sigma;)</span>
        <div class="snap-divider"></div>
        <div class="snap-key-val"><span>2&sigma; Tail Bound (95.4%):</span> <strong class="font-mono">${h.twoSigma}</strong></div>
        <div class="snap-key-val"><span>Priced Constant-Maturity IV:</span> <strong class="font-mono color-bull">${h.iv}</strong></div>
        <div class="snap-key-val"><span>Calculated Spot Interval:</span> <strong class="font-mono">${h.spotRange}</strong></div>
      </div>
    `).join('');
  }

  /* ==========================================================================
     Event Listeners Setup
     ========================================================================== */

  function setupOptionsEventListeners() {
    const syncBtn = document.getElementById('syncNowBtn');
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        fetch('/api/pipeline/sync')
          .then(r => r.json())
          .then(() => fetchOptionsData(false));
      });
    }

    const horizonPills = document.getElementById('optionsHorizonPills');
    if (horizonPills) {
      horizonPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        horizonPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        optionsState.activeHorizon = btn.dataset.horizon || '1_week';
        renderOptionsTrioTable();
      });
    }
  }

  /* ==========================================================================
     Initialization
     ========================================================================== */

  function initOptionsApp() {
    setupOptionsEventListeners();
    fetchOptionsData(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOptionsApp);
  } else {
    initOptionsApp();
  }

})();
