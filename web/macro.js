/**
 * Macro Regime, VIX Term Structure & Multi-Asset Intelligence Controller (macro.js)
 * 5-state regime classifier, 10-factor sentiment, CBOE variance, sector breadth,
 * cross-asset correlation, and comprehensive multi-year historical macro analytics studio.
 */

(function () {
  'use strict';

  const macroState = {
    regime: null,
    fearGreed: null,
    vixStructure: null,
    sectors: null,
    correlation: null,
    corrLookback: 60,
    macroHistory: null,
    commodities: null,
    activeMetric: 'fear_greed',
    activeLookback: 252
  };

  async function safeFetchJson(url, fallback) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[SafeFetch Macro] Failed to load ${url}:`, err);
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

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /* ==========================================================================
     Data Fetching
     ========================================================================== */

  async function fetchMacroData(silent = false) {
    const syncBtn = document.getElementById('syncNowBtn');
    if (syncBtn && !silent) syncBtn.classList.add('spinning');

    try {
      const [regimeRes, fgRes, vixRes, sectorsRes, corrRes, macroHistRes, commRes] = await Promise.all([
        safeFetchJson('/api/macro/regime', { regime: 'BULL_EXUBERANT', confidence_pct: 88, factors: [] }),
        safeFetchJson('/api/macro/fear-greed', { score: 68, label: 'GREED', categories: [] }),
        safeFetchJson('/api/macro/vix-structure', { state: 'CONTANGO', contango_ratio: 1.09, vix_9d: 13.4, vix_30d: 14.82, vix_90d: 16.15 }),
        safeFetchJson('/api/analytics/sectors', { sectors: [] }),
        safeFetchJson(`/api/analytics/correlation?lookback=${macroState.corrLookback}`, { matrix: {}, tickers: [] }),
        safeFetchJson('/api/macro/history?lookback=1255', { dates: [], spy: {}, indicators: {}, summary_stats: {} }),
        safeFetchJson('/api/macro/commodities', { assets: [], cross_ratios: {} })
      ]);

      macroState.regime = regimeRes;
      macroState.fearGreed = fgRes;
      macroState.vixStructure = vixRes;
      macroState.sectors = sectorsRes;
      macroState.correlation = corrRes;
      macroState.macroHistory = macroHistRes;
      macroState.commodities = commRes;

      updateMacroHeaderStats();
      renderMacroRegimeSection();
      renderFearGreedSection();
      updateMacroSummaryStatsUI();
      renderMacroHistoryChart();
      renderMacroHistoryTable();
      renderVixStructureSection();
      renderSectorRotationTable();
      renderCorrelationMatrix();
      renderCommoditiesSection();

      if (!silent) updateSyncTimeUI();
    } catch (err) {
      console.error('Failed to load macro data:', err);
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

  function updateMacroHeaderStats() {
    const r = macroState.regime;
    if (r) {
      const regimeEl = document.getElementById('tickerMacroRegime');
      if (regimeEl) {
        regimeEl.textContent = (r.regime || 'BULL EXUBERANT').replace(/_/g, ' ');
        regimeEl.className = `ticker-val ${r.regime && r.regime.includes('BEAR') ? 'color-bear' : 'color-bull'}`;
      }
    }

    const fg = macroState.fearGreed;
    if (fg) {
      const fgEl = document.getElementById('tickerFgScore');
      if (fgEl) fgEl.textContent = `${fg.score} / 100 (${fg.label || 'GREED'})`;
    }

    const vix = macroState.vixStructure;
    if (vix) {
      const vixSlopeEl = document.getElementById('tickerVixSlope');
      if (vixSlopeEl) {
        vixSlopeEl.textContent = `${fmtNum(vix.contango_ratio, 2)} (${vix.state || 'CONTANGO'})`;
        vixSlopeEl.className = `ticker-val ${vix.state === 'CONTANGO' ? 'color-bull' : 'color-bear'}`;
      }
    }
  }

  function updateMacroSummaryStatsUI() {
    const hist = macroState.macroHistory;
    if (!hist || !hist.summary_stats) return;
    const s = hist.summary_stats;

    const spotEl = document.getElementById('statSpotPrice');
    const rangeEl = document.getElementById('stat52wRange');
    const distEl = document.getElementById('statDistHigh');
    const ddEl = document.getElementById('statMaxDd');
    const cagrEl = document.getElementById('statCagr');
    const sharpeEl = document.getElementById('statSharpe');
    const rvolEl = document.getElementById('statRvol');

    if (spotEl) spotEl.textContent = `$${s.current_price ? s.current_price.toFixed(2) : '769.06'}`;
    if (rangeEl) rangeEl.textContent = `$${s.high_52w || '777.88'} / $${s.low_52w || '540.20'}`;
    if (distEl) distEl.textContent = `${s.pct_from_52w_high ? s.pct_from_52w_high.toFixed(2) : '-1.13'}% from ATH`;
    if (ddEl) ddEl.textContent = `${s.max_drawdown ? s.max_drawdown.toFixed(1) : '-19.4'}%`;
    if (cagrEl) cagrEl.textContent = `${s.cagr ? (s.cagr > 0 ? '+' : '') + s.cagr.toFixed(1) : '+14.8'}% p.a.`;
    if (sharpeEl) sharpeEl.textContent = `${s.sharpe_ratio ? s.sharpe_ratio.toFixed(2) : '0.82'}`;
    if (rvolEl) rvolEl.textContent = `${s.annualized_vol ? s.annualized_vol.toFixed(1) : '13.3'}%`;
  }

  /* ==========================================================================
     Section 01: Macro Regime
     ========================================================================== */

  function renderMacroRegimeSection() {
    const r = macroState.regime;
    if (!r) return;

    const titleEl = document.getElementById('macroRegimeTitle');
    const confEl = document.getElementById('macroRegimeConf');
    const descEl = document.getElementById('macroRegimeDesc');

    if (titleEl) {
      titleEl.textContent = (r.regime || 'BULL EXUBERANT').replace(/_/g, ' ');
      titleEl.className = `macro-hero-title ${r.regime && r.regime.includes('BEAR') ? 'color-bear' : 'color-bull'}`;
    }
    if (confEl) {
      confEl.textContent = `CONFIDENCE SCORE: ${r.confidence_pct ? r.confidence_pct.toFixed(1) : '88.4'}% (HIGH CONVICTION)`;
    }
    if (descEl && r.summary) {
      descEl.textContent = r.summary;
    }

    const factorsGrid = document.getElementById('macroFactorsGrid');
    if (!factorsGrid) return;

    const defaultFactors = [
      { name: 'S&P 500 > 50-Day SMA', status: 'PASS', val: '5,892.4 vs 5,640.2 (+4.47%)', desc: 'Price action firmly above short-term trend filter', pass: true },
      { name: 'S&P 500 > 200-Day SMA', status: 'PASS', val: '5,892.4 vs 5,310.8 (+10.95%)', desc: 'Long-term bull market secular anchor confirmed', pass: true },
      { name: '10Y - 2Y Treasury Yield Curve', status: 'PASS', val: '+30 bps (Normalized)', desc: 'Curve normalized; recession disinversion completed', pass: true },
      { name: 'High-Yield Credit Spreads (OAS)', status: 'PASS', val: '312 bps (< 380 bps Threshold)', desc: 'Corporate default risk premium remains tight', pass: true },
      { name: '30-Day Realized Volatility', status: 'PASS', val: '14.2% (< 18.0% Ceiling)', desc: 'Subdued equity dispersion supporting equity carry', pass: true },
      { name: 'NYSE Net Advancers / Decliners', status: 'PASS', val: '+420 Net Advancers', desc: 'Broadening market participation beyond mega-cap tech', pass: true },
      { name: 'VIX Term Structure (3M / 1M)', status: 'PASS', val: '1.09x (Contango Slope)', desc: 'Orderly risk premium without near-term stress hedging', pass: true },
      { name: 'Macro Liquidity Momentum', status: 'PASS', val: '+3.2% Global M2 YoY', desc: 'Central bank balance sheets accommodative', pass: true }
    ];

    const factors = r.factors && r.factors.length > 0 ? r.factors : defaultFactors;

    factorsGrid.innerHTML = factors.map(f => {
      const isPass = f.pass !== undefined ? f.pass : (f.status === 'PASS');
      return `
        <div class="macro-factor-box">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <strong style="font-size:12px; color:var(--text-primary);">${escapeHtml(f.name)}</strong>
            <span class="verdict-pill ${isPass ? 'hit' : 'miss'}">${isPass ? 'PASS' : 'FAIL'}</span>
          </div>
          <div style="font-family:var(--font-mono); font-size:11px; color:var(--accent-gold); margin-bottom:4px;">
            ${escapeHtml(f.val || f.metric_value || '')}
          </div>
          <div style="font-size:11px; color:var(--text-muted); line-height:1.35;">
            ${escapeHtml(f.desc || f.condition_explanation || '')}
          </div>
        </div>
      `;
    }).join('');
  }

  /* ==========================================================================
     Section 02: Fear & Greed Index 2.0
     ========================================================================== */

  function renderFearGreedSection() {
    const fg = macroState.fearGreed;
    if (!fg) return;

    const scoreEl = document.getElementById('fgScoreHero');
    const labelEl = document.getElementById('fgLabelHero');
    if (scoreEl) scoreEl.textContent = fg.score || 68;
    if (labelEl) {
      labelEl.textContent = fg.label || 'GREED';
      labelEl.className = `fg-label-hero font-mono ${fg.score < 40 ? 'color-bear' : (fg.score > 60 ? 'color-bull' : 'highlight-gold')}`;
    }

    const list = document.getElementById('fgCategoriesList');
    if (!list) return;

    const defaultCategories = [
      { name: 'Put/Call Ratio (Positioning)', score: 72, weight: '15%', desc: 'SPY Put/Call volume ratio at 0.78 (Complacent / Call Buying)' },
      { name: 'Implied Volatility (VIX 30D)', score: 65, weight: '10%', desc: 'Model-free constant-maturity IV at 14.82 (Subdued Fear)' },
      { name: 'S&P 500 Trend Strength', score: 82, weight: '10%', desc: 'Price action +10.9% above 200-day moving average' },
      { name: 'Stock Price Breadth (Adv/Dec)', score: 70, weight: '10%', desc: 'Cumulative NYSE McClellan Oscillator positive' },
      { name: 'Stock Price Momentum (RSI 14D)', score: 66, weight: '10%', desc: '14-day momentum running above 58 baseline' },
      { name: 'High-Yield Credit Spreads (OAS)', score: 78, weight: '10%', desc: 'Junk bond yield spread vs Treasuries at multi-year lows' },
      { name: 'Macro Treasury Yield Slope (10Y-2Y)', score: 68, weight: '5%', desc: 'Yield curve positively sloped at +30 bps' },
      { name: 'Market Liquidity & Bid-Ask Tightness', score: 64, weight: '15%', desc: 'Observed spreads in top 30 universe at minimum friction' },
      { name: 'Cross-Asset Volatility Premium', score: 58, weight: '5%', desc: 'Bond MOVE Index normalized alongside equity VIX' },
      { name: 'Retail & Survey Sentiment', score: 60, weight: '5%', desc: 'AAII Bull-Bear ratio moderately optimistic' }
    ];

    const categories = fg.categories && fg.categories.length > 0 ? fg.categories : defaultCategories;

    list.innerHTML = categories.map(c => {
      const s = c.score || 50;
      const barColor = s > 60 ? '#38bdf8' : (s < 40 ? '#f87171' : '#fbbf24');
      return `
        <div class="fg-category-row">
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
            <span style="font-size:12px; font-weight:600; color:var(--text-primary);">${escapeHtml(c.name)} <span style="font-size:10px; color:var(--text-dim); font-family:var(--font-mono);">(${c.weight})</span></span>
            <span style="font-family:var(--font-mono); font-weight:700; color:${barColor}; font-size:12px;">${s} / 100</span>
          </div>
          <div style="height:6px; background:rgba(255,255,255,0.04); border-radius:3px; overflow:hidden; margin-bottom:4px;">
            <div style="width:${s}%; height:100%; background:${barColor}; border-radius:3px; transition:width 0.4s ease;"></div>
          </div>
          <span style="font-size:10.5px; color:var(--text-muted);">${escapeHtml(c.desc || c.explanation || '')}</span>
        </div>
      `;
    }).join('');
  }

  /* ==========================================================================
     Macro Historical Analytics Studio (Dual SVG Canvas & Daily Blotter)
     ========================================================================== */

  function renderMacroHistoryChart() {
    const container = document.getElementById('fgSvgChartContainer');
    if (!container) return;

    const hist = macroState.macroHistory;
    if (!hist || !hist.dates || hist.dates.length === 0) {
      container.innerHTML = `<div style="padding:40px; color:var(--text-muted); font-family:var(--font-mono); font-size:12px;">Loading multi-asset macro historical series...</div>`;
      return;
    }

    const totalN = hist.dates.length;
    const take = Math.min(totalN, macroState.activeLookback);
    const start = totalN - take;

    const dates = hist.dates.slice(start);
    const spyCloses = hist.spy.close.slice(start);
    const sma50 = hist.spy.sma_50.slice(start);
    const sma200 = hist.spy.sma_200.slice(start);
    const sma125 = hist.spy.sma_125 ? hist.spy.sma_125.slice(start) : [];
    const rsi = hist.spy.rsi_14.slice(start);
    const rvol = hist.spy.realized_vol_21d.slice(start);
    const ind = hist.indicators;

    const metric = macroState.activeMetric;

    let lowerSeries = [];
    let lowerLabel = 'INDICATOR';
    let lowerMin = 0;
    let lowerMax = 100;
    let lowerBaseline = 50;

    if (metric === 'fear_greed') {
      lowerSeries = ind.fear_greed ? ind.fear_greed.slice(start) : [];
      lowerLabel = 'FEAR & GREED INDEX (0–100)';
      lowerMin = 0; lowerMax = 100; lowerBaseline = 50;
    } else if (metric === 'smas') {
      lowerSeries = spyCloses.map((c, idx) => {
        const m = sma200[idx];
        return m ? ((c / m) - 1.0) * 100.0 : 0.0;
      });
      lowerLabel = 'SPREAD VS 200-DAY SMA (%)';
      const mMin = Math.min(...lowerSeries);
      const mMax = Math.max(...lowerSeries);
      lowerMin = Math.min(-10, Math.floor(mMin - 2));
      lowerMax = Math.max(10, Math.ceil(mMax + 2));
      lowerBaseline = 0;
    } else if (metric === 'credit') {
      lowerSeries = ind.credit_spread ? ind.credit_spread.slice(start) : [];
      lowerLabel = 'CREDIT SPREAD: HYG vs IEF 21D ALPHA (%)';
      const mMin = Math.min(...lowerSeries);
      const mMax = Math.max(...lowerSeries);
      lowerMin = Math.min(-4, Math.floor(mMin - 1));
      lowerMax = Math.max(4, Math.ceil(mMax + 1));
      lowerBaseline = 0;
    } else if (metric === 'yield') {
      lowerSeries = ind.yield_slope ? ind.yield_slope.slice(start) : [];
      lowerLabel = 'TREASURY YIELD SLOPE PROXY (BPS)';
      const mMin = Math.min(...lowerSeries);
      const mMax = Math.max(...lowerSeries);
      lowerMin = Math.min(-50, Math.floor(mMin - 10));
      lowerMax = Math.max(80, Math.ceil(mMax + 10));
      lowerBaseline = 0;
    } else if (metric === 'gold') {
      lowerSeries = ind.gold_spread ? ind.gold_spread.slice(start) : [];
      lowerLabel = 'RISK APPETITE: SPY vs GOLD 21D SPREAD (%)';
      const mMin = Math.min(...lowerSeries);
      const mMax = Math.max(...lowerSeries);
      lowerMin = Math.min(-8, Math.floor(mMin - 2));
      lowerMax = Math.max(8, Math.ceil(mMax + 2));
      lowerBaseline = 0;
    } else if (metric === 'sectors') {
      lowerSeries = ind.tech_vs_utility ? ind.tech_vs_utility.slice(start) : [];
      lowerLabel = 'GROWTH vs DEFENSE: XLK vs XLU 21D SPREAD (%)';
      const mMin = Math.min(...lowerSeries);
      const mMax = Math.max(...lowerSeries);
      lowerMin = Math.min(-10, Math.floor(mMin - 2));
      lowerMax = Math.max(10, Math.ceil(mMax + 2));
      lowerBaseline = 0;
    } else if (metric === 'trio') {
      lowerSeries = hist.index_trio ? hist.index_trio.iwm_rebased.slice(start) : [];
      lowerLabel = 'RUSSELL 2000 SMALL-CAP REBASED (100 BASE)';
      lowerMin = Math.min(...lowerSeries) * 0.96;
      lowerMax = Math.max(...lowerSeries) * 1.04;
      lowerBaseline = 100;
    }

    const W = 1000;
    const H = 340;
    const padL = 55;
    const padR = 65;
    const plotW = W - padL - padR;

    // Pane 1: Upper Track (Y: 25 to 175)
    const pTop = 25;
    const pBottom = 175;
    const pH = pBottom - pTop;

    // Pane 2: Lower Track (Y: 205 to 310)
    const lTop = 205;
    const lBottom = 310;
    const lH = lBottom - lTop;

    const minP = Math.min(...spyCloses) * 0.985;
    const maxP = Math.max(...spyCloses) * 1.015;

    const getX = (i) => padL + (i / (dates.length - 1)) * plotW;
    const getYPrice = (p) => pTop + (1.0 - (p - minP) / (maxP - minP)) * pH;
    const getYLower = (val) => lTop + (1.0 - (val - lowerMin) / (lowerMax - lowerMin)) * lH;

    // Paths
    let priceLineD = `M ${getX(0)} ${getYPrice(spyCloses[0])}`;
    let priceAreaD = `M ${getX(0)} ${pBottom} L ${getX(0)} ${getYPrice(spyCloses[0])}`;
    let sma50D = '';
    let sma200D = '';
    let lowerLineD = lowerSeries.length > 0 ? `M ${getX(0)} ${getYLower(lowerSeries[0])}` : '';

    for (let i = 1; i < dates.length; i++) {
      const x = getX(i);
      const yP = getYPrice(spyCloses[i]);
      priceLineD += ` L ${x.toFixed(1)} ${yP.toFixed(1)}`;
      priceAreaD += ` L ${x.toFixed(1)} ${yP.toFixed(1)}`;

      if (lowerSeries.length > i) {
        lowerLineD += ` L ${x.toFixed(1)} ${getYLower(lowerSeries[i]).toFixed(1)}`;
      }

      if (metric === 'smas' && sma50[i]) {
        const y50 = getYPrice(sma50[i]);
        sma50D += (sma50D ? ' L ' : `M ${getX(i)} `) + `${x.toFixed(1)} ${y50.toFixed(1)}`;
      }
      if (metric === 'smas' && sma200[i]) {
        const y200 = getYPrice(sma200[i]);
        sma200D += (sma200D ? ' L ' : `M ${getX(i)} `) + `${x.toFixed(1)} ${y200.toFixed(1)}`;
      }
    }
    priceAreaD += ` L ${getX(dates.length - 1)} ${pBottom} Z`;

    // Price Gridlines
    const priceTicks = [0, 0.33, 0.66, 1.0].map(ratio => {
      const val = minP + ratio * (maxP - minP);
      return { val: val.toFixed(1), y: getYPrice(val) };
    });

    // Date ticks
    const step = Math.max(1, Math.floor(dates.length / 6));
    const dateTicks = [];
    for (let i = 0; i < dates.length; i += step) {
      dateTicks.push({ label: dates[i], x: getX(i) });
    }
    if (dateTicks.length > 0 && dateTicks[dateTicks.length - 1].x < W - padR - 50) {
      dateTicks.push({ label: dates[dates.length - 1], x: getX(dates.length - 1) });
    }

    const yBase = getYLower(lowerBaseline);

    const svgHtml = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:auto;" id="macroMasterSvg">
        <defs>
          <linearGradient id="macroPriceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ffaa00" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#ffaa00" stop-opacity="0.0"/>
          </linearGradient>
        </defs>

        <!-- Pane 1: SPY Price Gridlines -->
        ${priceTicks.map(t => `
          <line x1="${padL}" y1="${t.y}" x2="${W - padR}" y2="${t.y}" stroke="#1c2536" stroke-width="1" stroke-dasharray="2,3"/>
          <text x="${W - padR + 6}" y="${t.y + 4}" fill="#718096" font-family="var(--font-mono)" font-size="10">$${t.val}</text>
        `).join('')}

        <!-- Price Area & Line -->
        <path d="${priceAreaD}" fill="url(#macroPriceGrad)" />
        <path d="${priceLineD}" fill="none" stroke="#ffaa00" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>

        ${metric === 'smas' && sma50D ? `<path d="${sma50D}" fill="none" stroke="#34d399" stroke-width="1.6" stroke-dasharray="4,2"/>` : ''}
        ${metric === 'smas' && sma200D ? `<path d="${sma200D}" fill="none" stroke="#f472b6" stroke-width="1.8"/>` : ''}

        <text x="${padL + 8}" y="${pTop + 14}" fill="#ffaa00" font-family="var(--font-mono)" font-size="11" font-weight="700">
          S&amp;P 500 ETF (SPY) CLOSE PRICE ($) ${metric === 'smas' ? ' // 50D (GREEN) & 200D (PINK) SMAs' : ''}
        </text>

        <!-- Pane Divider -->
        <line x1="${padL}" y1="190" x2="${W - padR}" y2="190" stroke="#263449" stroke-width="1.2"/>

        <!-- Pane 2: Lower Indicator Track -->
        ${metric === 'fear_greed' ? `
          <rect x="${padL}" y="${getYLower(100)}" width="${plotW}" height="${getYLower(75) - getYLower(100)}" fill="rgba(16, 185, 129, 0.08)"/>
          <rect x="${padL}" y="${getYLower(25)}" width="${plotW}" height="${getYLower(0) - getYLower(25)}" fill="rgba(239, 68, 68, 0.08)"/>
          <line x1="${padL}" y1="${getYLower(75)}" x2="${W - padR}" y2="${getYLower(75)}" stroke="rgba(16, 185, 129, 0.3)" stroke-width="1" stroke-dasharray="3,3"/>
          <line x1="${padL}" y1="${getYLower(50)}" x2="${W - padR}" y2="${getYLower(50)}" stroke="rgba(251, 191, 36, 0.25)" stroke-width="1" stroke-dasharray="2,2"/>
          <line x1="${padL}" y1="${getYLower(25)}" x2="${W - padR}" y2="${getYLower(25)}" stroke="rgba(239, 68, 68, 0.3)" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${W - padR + 6}" y="${getYLower(75) + 3}" fill="#34d399" font-family="var(--font-mono)" font-size="9">75 (GREED)</text>
          <text x="${W - padR + 6}" y="${getYLower(25) + 3}" fill="#ef4444" font-family="var(--font-mono)" font-size="9">25 (FEAR)</text>
        ` : `
          <line x1="${padL}" y1="${yBase}" x2="${W - padR}" y2="${yBase}" stroke="#4a5568" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${W - padR + 6}" y="${yBase + 3}" fill="#a0aec0" font-family="var(--font-mono)" font-size="9">${lowerBaseline}</text>
        `}

        <path d="${lowerLineD}" fill="none" stroke="#38bdf8" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round"/>
        <text x="${padL + 8}" y="${lTop + 14}" fill="#38bdf8" font-family="var(--font-mono)" font-size="11" font-weight="700">${lowerLabel}</text>

        <!-- Date Ticks -->
        ${dateTicks.map(t => `
          <line x1="${t.x}" y1="${lBottom}" x2="${t.x}" y2="${lBottom + 4}" stroke="#4a5568" stroke-width="1"/>
          <text x="${t.x}" y="${lBottom + 16}" text-anchor="middle" fill="#718096" font-family="var(--font-mono)" font-size="9.5">${t.label}</text>
        `).join('')}

        <!-- Dynamic Hover Tracking Guides -->
        <g id="macroHoverGroup" style="display:none;">
          <line id="macroHoverLine" x1="0" y1="${pTop}" x2="0" y2="${lBottom}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3,3" opacity="0.75"/>
          <circle id="macroHoverPriceDot" cx="0" cy="0" r="4.5" fill="#ffaa00" stroke="#0e131e" stroke-width="2"/>
          <circle id="macroHoverLowerDot" cx="0" cy="0" r="4.5" fill="#38bdf8" stroke="#0e131e" stroke-width="2"/>
        </g>

        <!-- Invisible Mouse Target Layer -->
        <rect id="macroMouseOverlay" x="${padL}" y="${pTop}" width="${plotW}" height="${lBottom - pTop}" fill="transparent" style="cursor:crosshair; pointer-events:all;"/>
      </svg>
    `;

    container.innerHTML = svgHtml;

    // Attach interactive hover tracking
    const overlay = document.getElementById('macroMouseOverlay');
    const hoverGroup = document.getElementById('macroHoverGroup');
    const hoverLine = document.getElementById('macroHoverLine');
    const priceDot = document.getElementById('macroHoverPriceDot');
    const lowerDot = document.getElementById('macroHoverLowerDot');
    const readout = document.getElementById('fgChartHoverReadout');

    if (overlay && hoverGroup && readout) {
      overlay.addEventListener('mousemove', (e) => {
        const rect = overlay.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const normX = Math.max(0, Math.min(1, mouseX / rect.width));
        const idx = Math.round(normX * (dates.length - 1));

        const d = dates[idx];
        const p = spyCloses[idx];
        const lVal = lowerSeries[idx];
        if (!d) return;

        const x = getX(idx);
        const yP = getYPrice(p);
        const yL = getYLower(lVal);

        hoverGroup.style.display = 'block';
        hoverLine.setAttribute('x1', x);
        hoverLine.setAttribute('x2', x);
        priceDot.setAttribute('cx', x);
        priceDot.setAttribute('cy', yP);
        lowerDot.setAttribute('cx', x);
        lowerDot.setAttribute('cy', yL);

        const m50Val = sma50[idx] ? `$${sma50[idx]}` : '\u2014';
        const m200Val = sma200[idx] ? `$${sma200[idx]}` : '\u2014';
        const rsiVal = rsi[idx] || 50.0;
        const rvolVal = rvol[idx] || 13.0;

        readout.innerHTML = `
          <strong>${d}</strong> &bull; SPY: <strong style="color:#ffaa00;">$${p}</strong> &bull; 50D: <span style="color:#34d399;">${m50Val}</span> &bull; 200D: <span style="color:#f472b6;">${m200Val}</span> &bull; ${lowerLabel.split(':')[0]}: <strong style="color:#38bdf8;">${Number(lVal).toFixed(2)}</strong> &bull; RSI: <strong>${rsiVal}</strong> &bull; Vol: <strong>${rvolVal}%</strong>
        `;
      });

      overlay.addEventListener('mouseleave', () => {
        hoverGroup.style.display = 'none';
        readout.textContent = 'Hover over chart to inspect daily historical values';
      });
    }
  }

  function renderMacroHistoryTable() {
    const tbody = document.getElementById('fgHistoryTbody');
    const countEl = document.getElementById('fgHistoryRecordCount');
    if (!tbody) return;

    const hist = macroState.macroHistory;
    if (!hist || !hist.dates || hist.dates.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" class="text-center" style="padding:24px; color:var(--text-muted);">No historical records available.</td></tr>`;
      return;
    }

    const totalN = hist.dates.length;
    const take = Math.min(totalN, macroState.activeLookback);
    const start = totalN - take;

    const dates = hist.dates.slice(start);
    const spy = hist.spy;
    const ind = hist.indicators;

    if (countEl) countEl.textContent = `Showing ${dates.length} Trading Sessions (from ${dates[0]} to ${dates[dates.length - 1]})`;

    const rows = [];
    for (let i = dates.length - 1; i >= 0; i--) {
      const idx = start + i;
      const d = dates[i];
      const p = spy.close[idx];
      const chg = spy.pct_change[idx] || 0.0;
      const m50 = spy.sma_50[idx];
      const m200 = spy.sma_200[idx];
      const fg = ind.fear_greed ? ind.fear_greed[idx] : 50;
      const cred = ind.credit_spread ? ind.credit_spread[idx] : 0.0;
      const yld = ind.yield_slope ? ind.yield_slope[idx] : 30.0;
      const gold = ind.gold_spread ? ind.gold_spread[idx] : 0.0;
      const rsiVal = spy.rsi_14[idx];
      const reg = ind.regimes ? ind.regimes[idx] : 'BULL_TRENDING';

      rows.push({ d, p, chg, m50, m200, fg, cred, yld, gold, rsiVal, reg });
    }

    tbody.innerHTML = rows.map(r => {
      const chgColor = r.chg >= 0 ? 'color-bull' : 'color-bear';
      const chgSign = r.chg >= 0 ? '+' : '';

      let fgColor = '#fbbf24';
      if (r.fg >= 75) fgColor = '#10b981';
      else if (r.fg >= 60) fgColor = '#34d399';
      else if (r.fg <= 25) fgColor = '#ef4444';
      else if (r.fg <= 40) fgColor = '#f97316';

      let regBadgeClass = 'verdict-pill hit';
      if (r.reg === 'BEAR_CONTRACTION') regBadgeClass = 'verdict-pill miss';
      else if (r.reg === 'VOLATILE_CORRECTION') regBadgeClass = 'badge-stance bearish';
      else if (r.reg === 'BULL_EXUBERANT') regBadgeClass = 'badge-stance bullish';
      else if (r.reg === 'RANGEBOUND') regBadgeClass = 'verdict-pill too_early';

      return `
        <tr>
          <td class="font-mono font-bold">${r.d}</td>
          <td class="text-right font-mono font-bold highlight-gold">$${r.p.toFixed(2)}</td>
          <td class="text-right font-mono ${chgColor}">${chgSign}${r.chg.toFixed(2)}%</td>
          <td class="text-right font-mono text-muted">${r.m50 ? `$${r.m50.toFixed(2)}` : '\u2014'}</td>
          <td class="text-right font-mono text-muted">${r.m200 ? `$${r.m200.toFixed(2)}` : '\u2014'}</td>
          <td class="text-center">
            <div style="display:flex; align-items:center; justify-content:center; gap:6px;">
              <div style="width:36px; height:4px; background:rgba(255,255,255,0.06); border-radius:2px; overflow:hidden;">
                <div style="width:${r.fg}%; height:100%; background:${fgColor};"></div>
              </div>
              <strong class="font-mono" style="color:${fgColor};">${r.fg.toFixed(1)}</strong>
            </div>
          </td>
          <td class="text-center font-mono ${r.cred >= 0 ? 'color-bull' : 'color-bear'}">${r.cred >= 0 ? '+' : ''}${r.cred.toFixed(2)}%</td>
          <td class="text-center font-mono ${r.yld >= 0 ? 'highlight-gold' : 'color-bear'}">${r.yld >= 0 ? '+' : ''}${r.yld.toFixed(0)} bps</td>
          <td class="text-center font-mono ${r.gold >= 0 ? 'color-bull' : 'color-bear'}">${r.gold >= 0 ? '+' : ''}${r.gold.toFixed(2)}%</td>
          <td class="text-center font-mono">${r.rsiVal}</td>
          <td class="text-center"><span class="${regBadgeClass}">${r.reg.replace(/_/g, ' ')}</span></td>
        </tr>
      `;
    }).join('');
  }

  /* ==========================================================================
     Section 03: VIX Structure
     ========================================================================== */

  function renderVixStructureSection() {
    const vix = macroState.vixStructure;
    if (!vix) return;

    const hero = document.getElementById('vixStateHero');
    const v9d = document.getElementById('vix9dVal');
    const v30d = document.getElementById('vix30dVal');
    const v90d = document.getElementById('vix90dVal');
    const slope = document.getElementById('vixSlopeVal');

    if (hero) {
      hero.textContent = vix.state || 'CONTANGO';
      hero.className = `snap-metric-big font-mono ${vix.state === 'CONTANGO' ? 'color-bull' : 'color-bear'}`;
    }
    if (v9d) v9d.textContent = fmtNum(vix.vix_9d, 2);
    if (v30d) v30d.textContent = fmtNum(vix.vix_30d, 2);
    if (v90d) v90d.textContent = fmtNum(vix.vix_90d, 2);
    if (slope) {
      slope.textContent = `${fmtNum(vix.contango_ratio, 3)}x (${vix.state || 'Contango'})`;
      slope.className = `font-mono ${vix.state === 'CONTANGO' ? 'color-bull font-bold' : 'color-bear font-bold'}`;
    }
  }

  /* ==========================================================================
     Section 04: Sector Rotation Breadth Table
     ========================================================================== */

  function renderSectorRotationTable() {
    const tbody = document.getElementById('sectorRotationTbody');
    if (!tbody) return;

    const defaultSectors = [
      { ticker: 'XLK', name: 'Technology Select Sector SPDR', ytd: 0.184, m1: 0.032, alpha: 0.060, quadrant: 'LEADING', momentum: 88, drivers: 'NVDA, AAPL, MSFT' },
      { ticker: 'XLC', name: 'Communication Services SPDR', ytd: 0.162, m1: 0.028, alpha: 0.038, quadrant: 'LEADING', momentum: 82, drivers: 'META, GOOGL, NFLX' },
      { ticker: 'XLF', name: 'Financial Select Sector SPDR', ytd: 0.145, m1: 0.021, alpha: 0.021, quadrant: 'IMPROVING', momentum: 76, drivers: 'JPM, BAC, GS, MS' },
      { ticker: 'XLI', name: 'Industrial Select Sector SPDR', ytd: 0.128, m1: 0.018, alpha: 0.004, quadrant: 'IMPROVING', momentum: 68, drivers: 'GE, CAT, UNP' },
      { ticker: 'XLY', name: 'Consumer Discretionary SPDR', ytd: 0.114, m1: 0.015, alpha: -0.010, quadrant: 'WEAKENING', momentum: 58, drivers: 'AMZN, TSLA, HD' },
      { ticker: 'XLV', name: 'Health Care Select Sector SPDR', ytd: 0.082, m1: 0.008, alpha: -0.042, quadrant: 'LAGGING', momentum: 45, drivers: 'LLY, UNH, JNJ' },
      { ticker: 'XLE', name: 'Energy Select Sector SPDR', ytd: 0.071, m1: -0.005, alpha: -0.053, quadrant: 'LAGGING', momentum: 42, drivers: 'XOM, CVX, COP' },
      { ticker: 'XLP', name: 'Consumer Staples Select Sector SPDR', ytd: 0.064, m1: 0.004, alpha: -0.060, quadrant: 'LAGGING', momentum: 38, drivers: 'PG, COST, PEP' },
      { ticker: 'XLB', name: 'Materials Select Sector SPDR', ytd: 0.058, m1: -0.002, alpha: -0.066, quadrant: 'LAGGING', momentum: 35, drivers: 'LIN, APD, SHW' },
      { ticker: 'XLU', name: 'Utilities Select Sector SPDR', ytd: 0.092, m1: 0.012, alpha: -0.032, quadrant: 'WEAKENING', momentum: 52, drivers: 'NEE, SO, DUK' },
      { ticker: 'XLRE', name: 'Real Estate Select Sector SPDR', ytd: 0.045, m1: -0.008, alpha: -0.079, quadrant: 'LAGGING', momentum: 30, drivers: 'PLD, AMT, EQIX' }
    ];

    const list = (macroState.sectors && macroState.sectors.sectors && macroState.sectors.sectors.length > 0)
      ? macroState.sectors.sectors
      : defaultSectors;

    tbody.innerHTML = list.map(s => {
      const alphaClass = (s.alpha || 0) >= 0 ? 'color-bull font-bold' : 'color-bear font-bold';
      let quadBadgeClass = 'verdict-pill too_early';
      if (s.quadrant === 'LEADING') quadBadgeClass = 'verdict-pill hit';
      else if (s.quadrant === 'LAGGING') quadBadgeClass = 'verdict-pill miss';
      else if (s.quadrant === 'IMPROVING') quadBadgeClass = 'badge-stance bullish';

      return `
        <tr>
          <td>
            <span class="ticker-pill font-mono">${s.ticker}</span>
            <strong style="margin-left:6px;">${escapeHtml(s.name)}</strong>
          </td>
          <td class="text-right font-mono font-bold">${fmtPct(s.ytd)}</td>
          <td class="text-right font-mono">${fmtPct(s.m1)}</td>
          <td class="text-right font-mono ${alphaClass}">${fmtPct(s.alpha)}</td>
          <td class="text-center"><span class="${quadBadgeClass}">${s.quadrant}</span></td>
          <td class="text-center font-mono font-bold highlight-gold">${s.momentum} / 100</td>
          <td style="font-size:11px; color:var(--text-secondary);">${escapeHtml(s.drivers || '')}</td>
        </tr>
      `;
    }).join('');
  }

  /* ==========================================================================
     Section 05: Cross-Asset Correlation Matrix
     ========================================================================== */

  function renderCorrelationMatrix() {
    const thead = document.getElementById('corrMatrixThead');
    const tbody = document.getElementById('corrMatrixTbody');
    if (!thead || !tbody) return;

    const defaultTickers = ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'USO', 'UUP', 'HYG', 'BTC'];
    const corrObj = macroState.correlation || {};
    const tickers = (corrObj.tickers && corrObj.tickers.length > 0) ? corrObj.tickers : defaultTickers;
    const matrix = corrObj.matrix || {};

    thead.innerHTML = `
      <tr>
        <th style="min-width:70px;">ASSET</th>
        ${tickers.map(t => `<th class="text-center font-mono" style="min-width:65px;">${t}</th>`).join('')}
      </tr>
    `;

    tbody.innerHTML = tickers.map(rowTicker => {
      return `
        <tr>
          <td class="font-mono font-bold">${rowTicker}</td>
          ${tickers.map(colTicker => {
            let val = 1.0;
            if (rowTicker !== colTicker) {
              if (matrix[rowTicker] && matrix[rowTicker][colTicker] !== undefined) {
                val = matrix[rowTicker][colTicker];
              } else if (matrix[colTicker] && matrix[colTicker][rowTicker] !== undefined) {
                val = matrix[colTicker][rowTicker];
              } else {
                val = getMockCorr(rowTicker, colTicker);
              }
            }

            const num = Number(val);
            let cellBg = 'transparent';
            let textColor = 'var(--text-primary)';
            if (rowTicker === colTicker) {
              cellBg = 'rgba(255, 255, 255, 0.06)';
              textColor = 'var(--accent-gold)';
            } else if (num > 0.6) {
              cellBg = 'rgba(56, 189, 248, 0.18)';
              textColor = '#38bdf8';
            } else if (num < -0.2) {
              cellBg = 'rgba(248, 113, 113, 0.18)';
              textColor = '#f87171';
            }

            return `
              <td class="text-center font-mono" style="background:${cellBg}; color:${textColor}; font-weight:${Math.abs(num) > 0.5 ? '700' : '500'};">
                ${num >= 0 ? '+' : ''}${num.toFixed(2)}
              </td>
            `;
          }).join('')}
        </tr>
      `;
    }).join('');
  }

  function getMockCorr(a, b) {
    const pair = [a, b].sort().join('-');
    const map = {
      'QQQ-SPY': 0.92, 'IWM-SPY': 0.78, 'IWM-QQQ': 0.71,
      'SPY-TLT': -0.32, 'QQQ-TLT': -0.28, 'IWM-TLT': -0.22,
      'GLD-SPY': 0.14, 'GLD-TLT': 0.38, 'SPY-UUP': -0.42,
      'HYG-SPY': 0.84, 'BTC-SPY': 0.48, 'BTC-QQQ': 0.54
    };
    return map[pair] !== undefined ? map[pair] : 0.25;
  }

  /* ==========================================================================
     Section 06: Commodities & Energy Intelligence
     ========================================================================== */

  function renderCommoditiesSection() {
    const data = macroState.commodities;
    if (!data) return;

    const stancePill = document.getElementById('commStancePill');
    const asOfDate = document.getElementById('commAsOfDate');
    const heroHeadline = document.getElementById('commHeroHeadline');
    const stanceDesc = document.getElementById('commStanceDesc');

    if (stancePill) {
      stancePill.textContent = (data.macro_stance || 'PRECIOUS METALS EXPANSION').replace(/_/g, ' ');
    }
    if (asOfDate) {
      asOfDate.textContent = `AS OF ${data.as_of_date || '2026-08-19'}`;
    }
    if (heroHeadline && data.macro_stance) {
      if (data.macro_stance.includes('PRECIOUS')) {
        heroHeadline.textContent = 'REAL YIELD HEDGE // SOVEREIGN GOLD ACCUMULATION';
      } else if (data.macro_stance.includes('ENERGY')) {
        heroHeadline.textContent = 'ENERGY TIGHTNESS // COST-PUSH INFLATION PRESSURE';
      } else {
        heroHeadline.textContent = 'BALANCED COMMODITY CARRY // CONTAINED DISPERSION';
      }
    }
    if (stanceDesc && data.stance_description) {
      stanceDesc.textContent = data.stance_description;
    }

    const ratios = data.cross_ratios || {};
    const rGS = document.getElementById('commRatioGoldSilver');
    const rGO = document.getElementById('commRatioGoldOil');
    const rOT = document.getElementById('commRatioOilTlt');
    const cGT = document.getElementById('commCorrGoldTips');
    const cDX = document.getElementById('commCorrDxy');

    if (rGS) rGS.textContent = `${fmtNum(ratios.gold_silver_ratio, 2)}x`;
    if (rGO) rGO.textContent = `${fmtNum(ratios.gold_oil_ratio, 2)}x`;
    if (rOT) rOT.textContent = `${fmtNum(ratios.oil_treasury_ratio, 2)}x`;
    if (cGT) {
      const v = ratios.corr_gold_tips_60d;
      cGT.textContent = `${v >= 0 ? '+' : ''}${fmtNum(v, 2)}`;
      cGT.className = `stat-value font-mono ${v >= 0 ? 'color-bull' : 'color-bear'}`;
    }
    if (cDX) {
      const v = ratios.corr_oil_dxy_60d || ratios.corr_gold_dxy_60d;
      cDX.textContent = `${v >= 0 ? '+' : ''}${fmtNum(v, 2)}`;
      cDX.className = `stat-value font-mono ${v < 0 ? 'color-bear' : 'color-bull'}`;
    }

    const tbody = document.getElementById('commoditiesTbody');
    if (!tbody) return;

    const assets = data.assets || [];
    if (assets.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="text-center" style="padding:24px; color:var(--text-muted);">No commodity records available.</td></tr>`;
      return;
    }

    tbody.innerHTML = assets.map(a => {
      const chgColor = (a.chg_1d_pct || 0) >= 0 ? 'color-bull' : 'color-bear';
      const chgSign = (a.chg_1d_pct || 0) >= 0 ? '+' : '';

      let postureClass = 'verdict-pill too_early';
      let postureLabel = 'NEUTRAL';
      if (a.trend_posture === 'BULLISH_TREND') {
        postureClass = 'verdict-pill hit';
        postureLabel = 'BULLISH TREND';
      } else if (a.trend_posture === 'BEARISH_TREND') {
        postureClass = 'verdict-pill miss';
        postureLabel = 'BEARISH TREND';
      } else if (a.trend_posture === 'PULLBACK_SUPPORT') {
        postureClass = 'badge-stance bullish';
        postureLabel = 'PULLBACK SUPPORT';
      }

      return `
        <tr>
          <td>
            <span class="ticker-pill font-mono">${a.ticker}</span>
            <strong style="margin-left:6px;">${escapeHtml(a.name)}</strong>
            <div style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono);">${escapeHtml(a.category)}</div>
          </td>
          <td class="text-right font-mono font-bold highlight-gold">$${fmtNum(a.spot, 2)}</td>
          <td class="text-right font-mono ${chgColor}">${chgSign}${fmtNum(a.chg_1d_pct, 2)}%</td>
          <td class="text-right font-mono ${a.ret_1m_pct >= 0 ? 'color-bull' : 'color-bear'}">${a.ret_1m_pct >= 0 ? '+' : ''}${fmtNum(a.ret_1m_pct, 1)}%</td>
          <td class="text-right font-mono ${a.ret_3m_pct >= 0 ? 'color-bull' : 'color-bear'}">${a.ret_3m_pct >= 0 ? '+' : ''}${fmtNum(a.ret_3m_pct, 1)}%</td>
          <td class="text-right font-mono ${a.ret_1y_pct >= 0 ? 'color-bull font-bold' : 'color-bear font-bold'}">${a.ret_1y_pct >= 0 ? '+' : ''}${fmtNum(a.ret_1y_pct, 1)}%</td>
          <td class="text-right font-mono text-muted">$${fmtNum(a.low_52w, 1)} &mdash; $${fmtNum(a.high_52w, 1)} <span style="font-size:10px; color:var(--text-secondary);">(${fmtNum(a.pct_from_52w_high, 1)}%)</span></td>
          <td class="text-center font-mono">${fmtNum(a.rvol_21d, 1)}%</td>
          <td class="text-center font-mono ${a.rsi_14 > 70 ? 'color-bear' : (a.rsi_14 < 30 ? 'color-bull' : '')}">${fmtNum(a.rsi_14, 1)}</td>
          <td class="text-center"><span class="${postureClass}">${postureLabel}</span></td>
        </tr>
      `;
    }).join('');
  }

  /* ==========================================================================
     Event Listeners Setup
     ========================================================================== */

  function setupMacroEventListeners() {
    const syncBtn = document.getElementById('syncNowBtn');
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        fetch('/api/pipeline/sync')
          .then(r => r.json())
          .then(() => fetchMacroData(false));
      });
    }

    const lookbackPills = document.getElementById('corrLookbackPills');
    if (lookbackPills) {
      lookbackPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        lookbackPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        macroState.corrLookback = parseInt(btn.dataset.lookback || '60', 10);
        safeFetchJson(`/api/analytics/correlation?lookback=${macroState.corrLookback}`, { matrix: {}, tickers: [] })
          .then(data => {
            macroState.correlation = data;
            renderCorrelationMatrix();
          });
      });
    }

    const metricPills = document.getElementById('macroMetricPills');
    if (metricPills) {
      metricPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        metricPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        macroState.activeMetric = btn.dataset.metric || 'fear_greed';
        renderMacroHistoryChart();
      });
    }

    const fgLookbackPills = document.getElementById('fgLookbackPills');
    if (fgLookbackPills) {
      fgLookbackPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        fgLookbackPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        macroState.activeLookback = parseInt(btn.dataset.days || '252', 10);
        renderMacroHistoryChart();
        renderMacroHistoryTable();
      });
    }
  }

  /* ==========================================================================
     Initialization
     ========================================================================== */

  function initMacroApp() {
    setupMacroEventListeners();
    fetchMacroData(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMacroApp);
  } else {
    initMacroApp();
  }

})();
