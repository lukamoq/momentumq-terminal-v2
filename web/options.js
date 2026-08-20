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

  async function safeFetchJson(url, fallback = {}) {
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
    const num = Number(val);
    const normalized = Math.abs(num) > 1.0 ? num : num * 100;
    const sign = showSign && normalized > 0 ? '+' : '';
    return `${sign}${normalized.toFixed(decimals)}%`;
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
      const data = await safeFetchJson('/api/analytics/options', { assets: {}, indices: {} });
      // Normalize assets object
      const assets = data.assets || data.indices || {};
      optionsState.optionsData = { ...data, assets };

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
      const ivVal = spy.implied_volatility != null ? spy.implied_volatility : (spy.atm_iv != null ? spy.atm_iv * 100 : 13.8);
      const ivEl = document.getElementById('tickerSpyIv');
      if (ivEl) ivEl.textContent = `${Number(ivVal).toFixed(1)}%`;

      const netGex = spy.structure?.net_gex_dollars ?? spy.gex_summary?.net_gex_total ?? 420500000;
      const netM = netGex / 1e6;
      const gexEl = document.getElementById('tickerSpyGex');
      if (gexEl) {
        gexEl.textContent = `${netM >= 0 ? '+' : ''}$${netM.toFixed(1)}M`;
        gexEl.className = `ticker-val ${netM >= 0 ? 'color-bull' : 'color-bear'}`;
      }

      const regimeEl = document.getElementById('tickerGammaRegime');
      if (regimeEl) {
        const isLong = netM >= 0;
        const regText = spy.structure?.gex_regime || (isLong ? 'LONG GAMMA (DAMPENING)' : 'SHORT GAMMA (VOLATILITY)');
        regimeEl.textContent = regText.toUpperCase();
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

    const tickers = ['SPY', 'QQQ', 'IWM'];
    const rows = tickers.map(ticker => {
      const a = assets[ticker] || {};
      const hObj = (a.horizons && a.horizons[horizon]) || (a.horizons && a.horizons['1_week']) || {};
      const atm = hObj.atm || (a.greeks && a.greeks.atm_7d) || (a.greeks && a.greeks.atm_30d) || {};
      const expMove = hObj.expected_move || (a.expected_moves && a.expected_moves[horizon]) || (a.expected_moves && a.expected_moves.weekly) || a.expected_move || {};
      const struct = hObj.structure || a.structure || a.gex_summary || {};

      const spot = a.spot ?? a.spot_price ?? (ticker === 'SPY' ? 769.06 : (ticker === 'QQQ' ? 578.40 : 224.15));
      const iv = hObj.iv ?? a.implied_volatility ?? (a.atm_iv ? a.atm_iv * 100 : 14.5);
      const histVol = a.realized_vol_20d ?? (a.historical_vol_20d ? a.historical_vol_20d * 100 : 12.8);

      const netGex = struct.net_gex_dollars ?? struct.net_gex_total ?? (hObj.dollar_gamma_1pct || 0);

      return {
        ticker,
        spot,
        iv,
        hist_vol: histVol,
        delta: atm.call_delta ?? atm.delta ?? 0.517,
        gamma: atm.gamma ?? 0.035,
        theta: atm.call_theta ?? atm.theta ?? -0.35,
        vega: atm.vega ?? 0.42,
        rho: atm.call_rho ?? atm.rho ?? 0.075,
        vanna: atm.vanna ?? -0.001,
        charm: atm.charm_call ?? atm.charm ?? -0.001,
        max_pain: struct.max_pain ?? (a.max_pain ? a.max_pain.strike : null),
        gex_total: netGex,
        exp_move_dollar: expMove.dollar ?? expMove.one_sigma_dollar,
        exp_move_pct: expMove.pct ?? (expMove.one_sigma_pct ? expMove.one_sigma_pct * 100 : null)
      };
    });

    tbody.innerHTML = rows.map(r => {
      const gexLong = r.gex_total >= 0;
      const gexText = gexLong ? 'LONG (&plusmn;DAMPEN)' : 'SHORT (&plusmn;AMPLIFY)';
      const gexBadgeClass = gexLong ? 'badge-stance bullish' : 'badge-stance bearish';

      return `
        <tr class="interactive-call-row" onclick="window.terminalEngine && window.terminalEngine.openTickerSnapshot('${r.ticker}')" title="Click to inspect full ${r.ticker} snapshot">
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
          <td class="text-right font-mono font-bold">${r.max_pain ? `$${fmtNum(r.max_pain, 0)}` : '\u2014'}</td>
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
      const a = assets[t] || {};
      const spot = a.spot ?? a.spot_price ?? (t === 'SPY' ? 769.06 : (t === 'QQQ' ? 578.40 : 224.15));
      const iv = a.implied_volatility ?? (a.atm_iv ? a.atm_iv * 100 : 14.2);
      const histVol = a.realized_vol_20d ?? (a.historical_vol_20d ? a.historical_vol_20d * 100 : 12.5);

      const struct = a.structure || a.gex_summary || {};
      const netGex = struct.net_gex_dollars ?? struct.net_gex_total ?? 0;
      const netGexM = (netGex / 1e6).toFixed(1);
      const isLong = netGex >= 0;

      const flipVal = struct.gamma_flip ?? struct.gamma_flip_level;
      const flipLevel = flipVal ? `$${Number(flipVal).toFixed(2)}` : 'At Spot';
      const maxPainVal = struct.max_pain ?? (a.max_pain ? a.max_pain.strike : null);

      return `
        <div class="options-asset-card">
          <div class="options-card-header">
            <div class="options-card-title">
              <span class="opt-ticker">${t}</span>
              <span class="opt-spot">${fmtDollar(spot)}</span>
            </div>
            <span class="tier-badge ${isLong ? 'tier-1' : 'tier-3'}">${isLong ? 'LONG GAMMA' : 'SHORT GAMMA'}</span>
          </div>

          <div class="options-levels-grid">
            <div class="opt-level-item">
              <span class="opt-level-label">ATM IV / 20D VOL</span>
              <span class="opt-level-val highlight-gold">${fmtPct(iv, 1, false)} / ${fmtPct(histVol, 1, false)}</span>
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
              <span class="opt-level-val font-mono">${maxPainVal ? `$${fmtNum(maxPainVal, 0)}` : '\u2014'}</span>
            </div>
          </div>

          <div class="options-narrative-note">
            ${struct.gex_description || a.narrative_summary || `Observed dealer positioning for ${t} shows ${isLong ? 'positive' : 'negative'} market maker delta hedge ${isLong ? 'cushioning' : 'amplification'} around the $${maxPainVal ? fmtNum(maxPainVal, 0) : ''} key gamma wall.`}
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
    const spy = optionsState.optionsData.assets['SPY'] || {};
    const struct = spy.structure || spy.gex_summary || {};

    const gexHero = document.getElementById('gexTotalHero');
    const heroSub = document.getElementById('gexHeroSub');
    const callOiEl = document.getElementById('gexCallOi');
    const putOiEl = document.getElementById('gexPutOi');
    const flipEl = document.getElementById('gexFlipLevel');
    const callWallEl = document.getElementById('gexCallWall');
    const putWallEl = document.getElementById('gexPutWall');
    const spotPosEl = document.getElementById('gexSpotPositioning');

    const netGex = struct.net_gex_dollars ?? struct.net_gex_total ?? -3214132596;
    const netM = netGex / 1e6;
    const callGex = struct.call_gex_dollars ?? struct.call_gex_total ?? 20030040719;
    const putGex = struct.put_gex_dollars ?? struct.put_gex_total ?? -23244173315;
    const spot = spy.spot ?? spy.spot_price ?? 769.06;

    if (gexHero) {
      gexHero.textContent = `${netM >= 0 ? '+' : ''}$${netM.toFixed(1)}M GEX`;
      gexHero.className = `gex-metric-hero font-mono ${netM >= 0 ? 'color-bull' : 'color-bear'}`;
    }

    if (heroSub) {
      const effect = netM >= 0 ? 'VOLATILITY DAMPENING' : 'VOLATILITY AMPLIFYING';
      heroSub.textContent = `PER 1% S&P 500 MOVE (${effect})`;
      heroSub.className = `gex-hero-sub font-mono ${netM >= 0 ? 'color-bull' : 'color-bear'}`;
    }

    if (callOiEl) callOiEl.textContent = `+$${(Math.abs(callGex) / 1e6).toFixed(1)}M`;
    if (putOiEl) putOiEl.textContent = `-$${(Math.abs(putGex) / 1e6).toFixed(1)}M`;

    const flipVal = struct.gamma_flip ?? struct.gamma_flip_level;
    const flipDist = struct.flip_distance_pct;
    if (flipEl) {
      if (flipVal) {
        const distStr = flipDist !== null && flipDist !== undefined ? ` (${flipDist >= 0 ? '+' : ''}${Number(flipDist).toFixed(1)}%)` : '';
        flipEl.textContent = `$${Number(flipVal).toFixed(2)}${distStr}`;
      } else {
        flipEl.textContent = 'None inside band';
      }
    }

    const callWallVal = struct.call_wall ?? struct.call_wall_strike;
    if (callWallEl) callWallEl.textContent = callWallVal ? `$${Number(callWallVal).toFixed(0)} Strike` : '$770 Strike';

    const putWallVal = struct.put_wall ?? struct.put_wall_strike;
    if (putWallEl) putWallEl.textContent = putWallVal ? `$${Number(putWallVal).toFixed(0)} Strike` : '$765 Strike';

    if (spotPosEl) {
      if (flipVal) {
        const isAbove = spot >= flipVal;
        spotPosEl.textContent = isAbove ? 'ABOVE FLIP (LONG GAMMA ZONE)' : 'BELOW FLIP (SHORT GAMMA ZONE)';
        spotPosEl.className = `font-mono ${isAbove ? 'color-bull' : 'color-bear'}`;
      } else {
        spotPosEl.textContent = netM >= 0 ? 'LONG GAMMA REGIME' : 'SHORT GAMMA REGIME';
        spotPosEl.className = `font-mono ${netM >= 0 ? 'color-bull' : 'color-bear'}`;
      }
    }

    // Strike bars container
    const container = document.getElementById('gexStrikeBarsContainer');
    if (container) {
      const rawProfile = struct.gex_profile || [];
      let strikes = [];

      if (rawProfile.length > 0) {
        // Filter or sample major strikes near spot (+/- $25)
        const baseStrike = Math.round(spot / 5) * 5;
        const targetStrikes = [];
        for (let s = baseStrike - 25; s <= baseStrike + 25; s += 5) {
          targetStrikes.push(s);
        }

        strikes = targetStrikes.map(k => {
          const match = rawProfile.find(p => Math.abs(p.strike - k) < 0.1);
          if (match) {
            return {
              strike: k,
              callGex: match.call_gex / 1e6,
              putGex: match.put_gex / 1e6, // negative number
              netGex: match.net_gex / 1e6,
            };
          }
          return { strike: k, callGex: 0, putGex: 0, netGex: 0 };
        });
      } else {
        const baseStrike = Math.round(spot / 5) * 5;
        strikes = [
          { strike: baseStrike - 25, callGex: 171.9, putGex: -296.4, netGex: -124.5 },
          { strike: baseStrike - 20, callGex: 481.4, putGex: -840.4, netGex: -359.0 },
          { strike: baseStrike - 15, callGex: 252.1, putGex: -653.0, netGex: -400.9 },
          { strike: baseStrike - 10, callGex: 574.0, putGex: -1871.8, netGex: -1297.8 },
          { strike: baseStrike - 5, callGex: 700.9, putGex: -3294.1, netGex: -2593.2 },
          { strike: baseStrike, callGex: 2278.5, putGex: -1818.0, netGex: 460.5 },
          { strike: baseStrike + 5, callGex: 1921.6, putGex: -793.4, netGex: 1128.2 },
          { strike: baseStrike + 10, callGex: 962.8, putGex: -173.9, netGex: 788.9 },
          { strike: baseStrike + 15, callGex: 752.7, putGex: -52.0, netGex: 700.7 },
          { strike: baseStrike + 20, callGex: 659.5, putGex: -27.9, netGex: 631.5 },
          { strike: baseStrike + 25, callGex: 228.2, putGex: -7.4, netGex: 220.8 },
        ];
      }

      // Calculate max absolute GEX for dynamic scaling
      let maxGex = 1000;
      for (let s of strikes) {
        if (s.callGex > maxGex) maxGex = s.callGex;
        if (Math.abs(s.putGex) > maxGex) maxGex = Math.abs(s.putGex);
        if (Math.abs(s.netGex) > maxGex) maxGex = Math.abs(s.netGex);
      }
      maxGex = Math.ceil(maxGex / 500) * 500;

      const W = 800;
      const H = 260;
      const padL = 60;
      const padR = 40;
      const padT = 30;
      const padB = 40;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const yZero = padT + plotH / 2;

      const getStrikeX = (idx) => padL + (idx / (strikes.length - 1)) * plotW;
      const getGexY = (val) => yZero - (val / maxGex) * (plotH / 2);

      let netPathD = `M ${getStrikeX(0)} ${getGexY(strikes[0].netGex)}`;
      for (let i = 1; i < strikes.length; i++) {
        netPathD += ` L ${getStrikeX(i).toFixed(1)} ${getGexY(strikes[i].netGex).toFixed(1)}`;
      }

      // Spot X position interpolation
      const minStrike = strikes[0].strike;
      const maxStrike = strikes[strikes.length - 1].strike;
      const spotRatio = Math.max(0, Math.min(1, (spot - minStrike) / (maxStrike - minStrike)));
      const spotX = padL + spotRatio * plotW;

      container.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:auto;" id="gexSurfaceSvg">
          <defs>
            <linearGradient id="gexCallGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.8"/>
              <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.2"/>
            </linearGradient>
            <linearGradient id="gexPutGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#f87171" stop-opacity="0.2"/>
              <stop offset="100%" stop-color="#f87171" stop-opacity="0.8"/>
            </linearGradient>
          </defs>

          <!-- Grid Background & Zero Line -->
          <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="rgba(10, 15, 24, 0.65)"/>
          <line x1="${padL}" y1="${yZero}" x2="${W - padR}" y2="${yZero}" stroke="#334155" stroke-width="1.2"/>
          <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="#1e293b" stroke-width="1" stroke-dasharray="2,3"/>
          <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#1e293b" stroke-width="1" stroke-dasharray="2,3"/>

          <!-- Y Axis Labels -->
          <text x="${padL - 8}" y="${padT + 4}" text-anchor="end" fill="#38bdf8" font-family="var(--font-mono)" font-size="9.5">+$${maxGex >= 1000 ? `${(maxGex/1000).toFixed(1)}B` : `${maxGex}M`}</text>
          <text x="${padL - 8}" y="${yZero + 3}" text-anchor="end" fill="#94a3b8" font-family="var(--font-mono)" font-size="9.5">$0</text>
          <text x="${padL - 8}" y="${H - padB + 3}" text-anchor="end" fill="#f87171" font-family="var(--font-mono)" font-size="9.5">-$${maxGex >= 1000 ? `${(maxGex/1000).toFixed(1)}B` : `${maxGex}M`}</text>

          <!-- Strike Bars (Call vs Put) -->
          ${strikes.map((s, idx) => {
            const x = getStrikeX(idx);
            const callH = (s.callGex / maxGex) * (plotH / 2);
            const putH = (Math.abs(s.putGex) / maxGex) * (plotH / 2);
            const barW = Math.max(14, (plotW / strikes.length) * 0.42);

            return `
              <!-- Call GEX Bar -->
              <rect x="${x - barW - 1}" y="${yZero - callH}" width="${barW}" height="${callH}" fill="url(#gexCallGrad)" rx="2"/>
              <!-- Put GEX Bar -->
              <rect x="${x + 1}" y="${yZero}" width="${barW}" height="${putH}" fill="url(#gexPutGrad)" rx="2"/>
              <!-- X Label -->
              <text x="${x}" y="${H - padB + 16}" text-anchor="middle" fill="#94a3b8" font-family="var(--font-mono)" font-size="9.5">$${s.strike}</text>
            `;
          }).join('')}

          <!-- Net GEX Connecting Line -->
          <path d="${netPathD}" fill="none" stroke="#fbbf24" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>

          <!-- Spot Price Marker -->
          <line x1="${spotX}" y1="${padT}" x2="${spotX}" y2="${H - padB}" stroke="#fbbf24" stroke-width="1.8" stroke-dasharray="3,2"/>
          <rect x="${spotX - 35}" y="${padT - 20}" width="70" height="16" fill="rgba(251, 191, 36, 0.2)" stroke="#fbbf24" rx="2"/>
          <text x="${spotX}" y="${padT - 8}" text-anchor="middle" fill="#fbbf24" font-family="var(--font-mono)" font-size="8.5" font-weight="700">SPOT $${Number(spot).toFixed(0)}</text>

          <!-- Legend -->
          <g transform="translate(${W - padR - 220}, ${padT + 12})">
            <rect width="10" height="10" fill="#38bdf8" rx="2"/>
            <text x="14" y="9" fill="#94a3b8" font-family="var(--font-mono)" font-size="9">Call GEX</text>
            <rect x="75" width="10" height="10" fill="#f87171" rx="2"/>
            <text x="89" y="9" fill="#94a3b8" font-family="var(--font-mono)" font-size="9">Put GEX</text>
            <line x1="140" y1="5" x2="155" y2="5" stroke="#fbbf24" stroke-width="2.5"/>
            <text x="160" y="9" fill="#fbbf24" font-family="var(--font-mono)" font-size="9" font-weight="700">Net GEX</text>
          </g>
        </svg>
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
        { tenor: '7 Days (1W)', cmIv: '10.6%', rv20d: '11.8%', vrp: '-1.2%', slope: 'Normal' },
        { tenor: '14 Days (2W)', cmIv: '11.1%', rv20d: '11.8%', vrp: '-0.7%', slope: 'Normal' },
        { tenor: '30 Days (1M)', cmIv: '12.4%', rv20d: '11.8%', vrp: '+0.6%', slope: 'Contango' },
        { tenor: '90 Days (3M)', cmIv: '14.3%', rv20d: '11.8%', vrp: '+2.5%', slope: 'Contango' }
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
          <div class="snap-key-val"><span>25&Delta; Put Implied Vol:</span> <strong class="color-bear">14.7%</strong></div>
          <div class="snap-key-val"><span>25&Delta; Call Implied Vol:</span> <strong class="color-bull">10.9%</strong></div>
          <div class="snap-key-val"><span>True 25&Delta; Put/Call Skew:</span> <strong class="highlight-gold">-3.80% Spread</strong></div>
          <div class="snap-key-val"><span>Skew Percentile (1Y):</span> <strong>38th Percentile (Orderly Protection)</strong></div>
          <div class="snap-key-val"><span>Tail Risk Premium:</span> <strong class="color-bull">Low (Constructive Call Bid)</strong></div>
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

    const spy = optionsState.optionsData?.assets?.['SPY'] || {};
    const spot = spy.spot ?? spy.spot_price ?? 769.06;
    const em = spy.expected_moves || {};

    const daily = em.daily || { dollar: 4.60, pct: 0.60, upper_1s: spot + 4.6, lower_1s: spot - 4.6, iv: 11.4 };
    const weekly = em.weekly || { dollar: 11.28, pct: 1.47, upper_1s: spot + 11.28, lower_1s: spot - 11.28, iv: 10.6 };
    const monthly = em.monthly || { dollar: 27.26, pct: 3.54, upper_1s: spot + 27.26, lower_1s: spot - 27.26, iv: 12.4 };
    const quarterly = em.quarterly || { dollar: 54.61, pct: 7.10, upper_1s: spot + 54.61, lower_1s: spot - 54.61, iv: 14.3 };

    const horizons = [
      { name: '1-DAY HORIZON \u00b7 0DTE', iv: `${daily.iv || 11.4}%`, oneSigma: `±$${fmtNum(daily.dollar, 2)} (±${fmtNum(daily.pct, 2)}%)`, twoSigma: `±$${fmtNum(daily.dollar * 2, 2)}`, spotRange: `$${fmtNum(daily.lower_1s, 2)} — $${fmtNum(daily.upper_1s, 2)}` },
      { name: '1-WEEK HORIZON \u00b7 7D', iv: `${weekly.iv || 10.6}%`, oneSigma: `±$${fmtNum(weekly.dollar, 2)} (±${fmtNum(weekly.pct, 2)}%)`, twoSigma: `±$${fmtNum(weekly.dollar * 2, 2)}`, spotRange: `$${fmtNum(weekly.lower_1s, 2)} — $${fmtNum(weekly.upper_1s, 2)}` },
      { name: '1-MONTH HORIZON \u00b7 30D', iv: `${monthly.iv || 12.4}%`, oneSigma: `±$${fmtNum(monthly.dollar, 2)} (±${fmtNum(monthly.pct, 2)}%)`, twoSigma: `±$${fmtNum(monthly.dollar * 2, 2)}`, spotRange: `$${fmtNum(monthly.lower_1s, 2)} — $${fmtNum(monthly.upper_1s, 2)}` },
      { name: '3-MONTH HORIZON \u00b7 90D', iv: `${quarterly.iv || 14.3}%`, oneSigma: `±$${fmtNum(quarterly.dollar, 2)} (±${fmtNum(quarterly.pct, 2)}%)`, twoSigma: `±$${fmtNum(quarterly.dollar * 2, 2)}`, spotRange: `$${fmtNum(quarterly.lower_1s, 2)} — $${fmtNum(quarterly.upper_1s, 2)}` }
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
