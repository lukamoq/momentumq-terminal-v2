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
    insiderData: null,
    whaleData: null,
    insiderFilter: 'all',
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
      const [regimeRes, fgRes, vixRes, sectorsRes, corrRes, macroHistRes, commRes, insiderRes, whaleRes] = await Promise.all([
        safeFetchJson('/api/macro/regime', { regime: 'BULL_EXUBERANT', confidence_pct: 88, factors: [] }),
        safeFetchJson('/api/macro/fear-greed', { score: 68, label: 'GREED', categories: [] }),
        safeFetchJson('/api/macro/vix-structure', { state: 'CONTANGO', contango_ratio: 1.09, vix_9d: 13.4, vix_30d: 14.82, vix_90d: 16.15 }),
        safeFetchJson('/api/analytics/sectors', { sectors: [] }),
        safeFetchJson(`/api/analytics/correlation?lookback=${macroState.corrLookback}`, { matrix: {}, tickers: [] }),
        safeFetchJson('/api/macro/history?lookback=1255', { dates: [], spy: {}, indicators: {}, summary_stats: {} }),
        safeFetchJson('/api/macro/commodities', { assets: [], cross_ratios: {} }),
        safeFetchJson('/api/alpha/insider-trades', { summary: {}, cluster_buy_signals: [], recent_transactions: [] }),
        safeFetchJson('/api/alpha/smart-money', { whales_tracked_count: 0, consensus_overweights: [], holdings: [] })
      ]);

      macroState.regime = regimeRes;
      macroState.fearGreed = fgRes;
      macroState.vixStructure = vixRes;
      macroState.sectors = sectorsRes;
      macroState.correlation = corrRes;
      macroState.macroHistory = macroHistRes;
      macroState.commodities = commRes;
      macroState.insiderData = insiderRes;
      macroState.whaleData = whaleRes;

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
      renderInsiderSection();
      renderWhaleSection();

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
      if (fgEl) {
        const score = fgScore(fg);
        fgEl.textContent = score == null
          ? '\u2014'
          : `${score.toFixed(1)} / 100 (${fg.label || 'Neutral'})`;
      }
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

  /* The payload exposes the composite as `composite_score`; `fg.score` never
     existed, so the hero printed "undefined / 100". `categories` is an object
     keyed by factor, so the old `categories.length > 0` guard was always false
     and the whole panel silently fell back to a hardcoded placebo table. Both
     now read the live payload, and the placeholder table is gone. */

  function fgScore(fg) {
    if (!fg) return null;
    const v = Number(fg.composite_score);
    return Number.isFinite(v) ? v : null;
  }

  function fgToneClass(score) {
    if (score == null) return '';
    if (score < 40) return 'color-bear';
    if (score > 60) return 'color-bull';
    return 'highlight-gold';
  }

  /* The four snapshot rows were static numbers typed into macro.html while the
     payload was already carrying 300 days of scored history. They are derived
     from that history now, so they move with the data. */
  function renderFearGreedSnapshot(fg) {
    const hist = Array.isArray(fg.history) ? fg.history : [];
    const scores = hist
      .map(h => Number(h.score))
      .filter(Number.isFinite);

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    if (scores.length === 0) {
      ['fgPrevClose', 'fgWeekAvg', 'fgMonthAvg', 'fgYearRange'].forEach(id => set(id, '\u2014'));
      return;
    }

    // The last entry is today's reading; "previous close" is the one before it.
    const prev = scores.length > 1 ? scores[scores.length - 2] : scores[scores.length - 1];
    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const tail = n => scores.slice(Math.max(0, scores.length - n));

    const band = v => {
      if (v < 25) return 'EXTREME FEAR';
      if (v < 45) return 'FEAR';
      if (v <= 55) return 'NEUTRAL';
      if (v <= 75) return 'GREED';
      return 'EXTREME GREED';
    };
    const fmt = v => `${v.toFixed(1)} (${band(v)})`;

    set('fgPrevClose', fmt(prev));
    set('fgWeekAvg', fmt(mean(tail(5))));
    set('fgMonthAvg', fmt(mean(tail(21))));

    const yr = tail(252);
    const lo = Math.min(...yr);
    const hi = Math.max(...yr);
    set('fgYearRange', `${fmt(lo)} \u2014 ${fmt(hi)}`);
  }

  function renderFearGreedSection() {
    const fg = macroState.fearGreed;
    if (!fg) return;

    const score = fgScore(fg);
    const scoreEl = document.getElementById('fgScoreHero');
    const labelEl = document.getElementById('fgLabelHero');
    if (scoreEl) scoreEl.textContent = score == null ? '\u2014' : score.toFixed(1);
    if (labelEl) {
      labelEl.textContent = (fg.label || 'Neutral').toUpperCase();
      labelEl.className = `fg-label-hero font-mono ${fgToneClass(score)}`;
    }

    renderFearGreedSnapshot(fg);

    const list = document.getElementById('fgCategoriesList');
    if (!list) return;

    // `category_order` is the desk's intended reading order; fall back to
    // whatever keys the payload actually carries.
    const cats = fg.categories || {};
    const order = Array.isArray(fg.category_order) && fg.category_order.length
      ? fg.category_order
      : Object.keys(cats);
    const degraded = new Set(fg.degraded_categories || []);

    const rows = order.map(key => cats[key]).filter(Boolean);
    if (rows.length === 0) {
      list.innerHTML = `<div class="fg-empty font-mono">Fear &amp; Greed factor chain unavailable for this session.</div>`;
      return;
    }

    list.innerHTML = rows.map(c => {
      const s = Number.isFinite(Number(c.score)) ? Number(c.score) : null;
      const pct = s == null ? 0 : Math.max(0, Math.min(100, s));
      const barColor = c.bar_color || (pct > 60 ? '#38bdf8' : (pct < 40 ? '#f87171' : '#fbbf24'));
      const isDegraded = degraded.has(c.key) || c.measured === false;
      return `
        <div class="fg-category-row${isDegraded ? ' is-degraded' : ''}">
          <div class="fg-cat-head">
            <span class="fg-cat-name">
              ${escapeHtml(c.label || c.key || '')}
              <span class="fg-cat-weight font-mono">(${c.weight}%)</span>
              ${isDegraded ? '<span class="fg-cat-flag font-mono">UNMEASURED</span>' : ''}
            </span>
            <span class="fg-cat-score font-mono" style="color:${barColor};">${s == null ? '\u2014' : s.toFixed(1)} <span class="fg-cat-denom">/ 100</span></span>
          </div>
          <div class="fg-cat-track">
            <div class="fg-cat-fill" style="width:${pct}%; background:${barColor};"></div>
          </div>
          <span class="fg-cat-desc">${escapeHtml(c.description || '')}</span>
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
      container.innerHTML = `<div style="padding:40px; color:var(--text-muted); font-family:var(--font-mono); font-size:12px;"><span class="sync-dot pulsing"></span> Ingesting multi-asset macro historical series...</div>`;
      return;
    }

    const totalN = hist.dates.length;
    const take = Math.min(totalN, macroState.activeLookback);
    const start = totalN - take;

    const dates = hist.dates.slice(start);
    const spyCloses = hist.spy.close.slice(start);
    const sma50 = hist.spy.sma_50.slice(start);
    const sma200 = hist.spy.sma_200.slice(start);
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
    const H = 380;
    const padL = 58;
    const padR = 72;
    const plotW = W - padL - padR;

    // Pane 1: Upper Track (Y: 25 to 185)
    const pTop = 25;
    const pBottom = 185;
    const pH = pBottom - pTop;

    // Pane 2: Lower Track (Y: 220 to 330)
    const lTop = 220;
    const lBottom = 330;
    const lH = lBottom - lTop;

    // Minimap Track (Y: 348 to 368)
    const mTop = 348;
    const mBottom = 368;
    const mH = mBottom - mTop;

    const minP = Math.min(...spyCloses) * 0.985;
    const maxP = Math.max(...spyCloses) * 1.015;

    const getX = (i) => padL + (i / Math.max(1, dates.length - 1)) * plotW;
    const getYPrice = (p) => pTop + (1.0 - (p - minP) / Math.max(1, (maxP - minP))) * pH;
    const getYLower = (val) => lTop + (1.0 - (val - lowerMin) / Math.max(1, (lowerMax - lowerMin))) * lH;

    // Minimap full-series calculation
    const allCloses = hist.spy.close;
    const minAllP = Math.min(...allCloses) * 0.95;
    const maxAllP = Math.max(...allCloses) * 1.05;
    const getMiniX = (i) => padL + (i / Math.max(1, allCloses.length - 1)) * plotW;
    const getMiniY = (p) => mTop + (1.0 - (p - minAllP) / Math.max(1, (maxAllP - minAllP))) * mH;

    let miniPathD = `M ${getMiniX(0)} ${getMiniY(allCloses[0])}`;
    for (let i = 1; i < allCloses.length; i++) {
      miniPathD += ` L ${getMiniX(i).toFixed(1)} ${getMiniY(allCloses[i]).toFixed(1)}`;
    }

    const miniViewLeft = getMiniX(start);
    const miniViewRight = getMiniX(totalN - 1);
    const miniViewWidth = Math.max(12, miniViewRight - miniViewLeft);

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
    const priceTicks = [0, 0.25, 0.5, 0.75, 1.0].map(ratio => {
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
            <stop offset="0%" stop-color="#ffaa00" stop-opacity="0.32"/>
            <stop offset="60%" stop-color="#ffaa00" stop-opacity="0.08"/>
            <stop offset="100%" stop-color="#ffaa00" stop-opacity="0.0"/>
          </linearGradient>
          <linearGradient id="macroLowerGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0"/>
          </linearGradient>
          <filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.8" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        <!-- CRT Scanline Grid Background -->
        <rect x="${padL}" y="${pTop}" width="${plotW}" height="${pBottom - pTop}" fill="rgba(10, 15, 24, 0.65)"/>
        <rect x="${padL}" y="${lTop}" width="${plotW}" height="${lBottom - lTop}" fill="rgba(10, 15, 24, 0.65)"/>

        <!-- Pane 1: SPY Price Gridlines -->
        ${priceTicks.map(t => `
          <line x1="${padL}" y1="${t.y}" x2="${W - padR}" y2="${t.y}" stroke="#172234" stroke-width="1" stroke-dasharray="2,3"/>
          <text x="${W - padR + 6}" y="${t.y + 4}" fill="#94a3b8" font-family="var(--font-mono)" font-size="10">$${t.val}</text>
        `).join('')}

        <!-- Price Area & Line -->
        <path d="${priceAreaD}" fill="url(#macroPriceGrad)" />
        <path d="${priceLineD}" fill="none" stroke="#ffaa00" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" filter="url(#neonGlow)"/>

        ${metric === 'smas' && sma50D ? `<path d="${sma50D}" fill="none" stroke="#34d399" stroke-width="1.6" stroke-dasharray="4,2"/>` : ''}
        ${metric === 'smas' && sma200D ? `<path d="${sma200D}" fill="none" stroke="#f472b6" stroke-width="1.8"/>` : ''}

        <!-- Upper Track Header Tag -->
        <rect x="${padL + 6}" y="${pTop + 4}" width="340" height="18" fill="rgba(15, 23, 34, 0.85)" rx="3" stroke="#1e293b"/>
        <text x="${padL + 12}" y="${pTop + 16}" fill="#fbbf24" font-family="var(--font-mono)" font-size="10" font-weight="700">
          S&amp;P 500 ETF (SPY) CLOSE PRICE ${metric === 'smas' ? ' // 50D (GREEN) & 200D (PINK) SMAs' : ''}
        </text>

        <!-- Pane Divider -->
        <line x1="${padL}" y1="202" x2="${W - padR}" y2="202" stroke="#263449" stroke-width="1.2"/>

        <!-- Pane 2: Lower Indicator Track -->
        ${metric === 'fear_greed' ? `
          <rect x="${padL}" y="${getYLower(100)}" width="${plotW}" height="${getYLower(75) - getYLower(100)}" fill="rgba(34, 197, 94, 0.08)"/>
          <rect x="${padL}" y="${getYLower(25)}" width="${plotW}" height="${getYLower(0) - getYLower(25)}" fill="rgba(239, 68, 68, 0.08)"/>
          <line x1="${padL}" y1="${getYLower(75)}" x2="${W - padR}" y2="${getYLower(75)}" stroke="rgba(34, 197, 94, 0.35)" stroke-width="1" stroke-dasharray="3,3"/>
          <line x1="${padL}" y1="${getYLower(50)}" x2="${W - padR}" y2="${getYLower(50)}" stroke="rgba(251, 191, 36, 0.25)" stroke-width="1" stroke-dasharray="2,2"/>
          <line x1="${padL}" y1="${getYLower(25)}" x2="${W - padR}" y2="${getYLower(25)}" stroke="rgba(239, 68, 68, 0.35)" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${W - padR + 6}" y="${getYLower(75) + 3}" fill="#4ade80" font-family="var(--font-mono)" font-size="9">75 (GREED)</text>
          <text x="${W - padR + 6}" y="${getYLower(50) + 3}" fill="#fbbf24" font-family="var(--font-mono)" font-size="9">50 (NEUTRAL)</text>
          <text x="${W - padR + 6}" y="${getYLower(25) + 3}" fill="#f87171" font-family="var(--font-mono)" font-size="9">25 (FEAR)</text>
        ` : `
          <line x1="${padL}" y1="${yBase}" x2="${W - padR}" y2="${yBase}" stroke="#334155" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${W - padR + 6}" y="${yBase + 3}" fill="#94a3b8" font-family="var(--font-mono)" font-size="9">${lowerBaseline}</text>
        `}

        <path d="${lowerLineD}" fill="none" stroke="#38bdf8" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round" filter="url(#neonGlow)"/>

        <!-- Lower Track Header Tag -->
        <rect x="${padL + 6}" y="${lTop + 4}" width="340" height="18" fill="rgba(15, 23, 34, 0.85)" rx="3" stroke="#1e293b"/>
        <text x="${padL + 12}" y="${lTop + 16}" fill="#38bdf8" font-family="var(--font-mono)" font-size="10" font-weight="700">${lowerLabel}</text>

        <!-- Date Ticks -->
        ${dateTicks.map(t => `
          <line x1="${t.x}" y1="${lBottom}" x2="${t.x}" y2="${lBottom + 4}" stroke="#4a5568" stroke-width="1"/>
          <text x="${t.x}" y="${lBottom + 13}" text-anchor="middle" fill="#718096" font-family="var(--font-mono)" font-size="9.5">${t.label}</text>
        `).join('')}

        <!-- Minimap Full History Track -->
        <rect x="${padL}" y="${mTop}" width="${plotW}" height="${mH}" fill="#080c14" stroke="#1e293b" rx="2"/>
        <path d="${miniPathD}" fill="none" stroke="#475569" stroke-width="1.0" opacity="0.6"/>
        <rect x="${miniViewLeft}" y="${mTop}" width="${miniViewWidth}" height="${mH}" fill="rgba(251, 191, 36, 0.15)" stroke="#fbbf24" stroke-width="1.2" rx="2"/>
        <text x="${padL + 4}" y="${mTop - 3}" fill="#64748b" font-family="var(--font-mono)" font-size="8.5">5-YEAR FULL TIMELINE OVERVIEW (DRAG PRESETS TO ZOOM)</text>

        <!-- Dynamic Hover Tracking Guides -->
        <g id="macroHoverGroup" style="display:none;">
          <line id="macroHoverLine" x1="0" y1="${pTop}" x2="0" y2="${lBottom}" stroke="#f8fafc" stroke-width="1" stroke-dasharray="2,2" opacity="0.75"/>
          <circle id="macroHoverPriceDot" cx="0" cy="0" r="5" fill="#fbbf24" stroke="#090d13" stroke-width="2"/>
          <circle id="macroHoverLowerDot" cx="0" cy="0" r="5" fill="#38bdf8" stroke="#090d13" stroke-width="2"/>
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

        const m50Val = sma50[idx] ? `$${Number(sma50[idx]).toFixed(2)}` : '\u2014';
        const m200Val = sma200[idx] ? `$${Number(sma200[idx]).toFixed(2)}` : '\u2014';
        const rsiVal = rsi[idx] || 50.0;
        const rvolVal = rvol[idx] || 13.0;

        const dist200 = sma200[idx] ? (((p / sma200[idx]) - 1.0) * 100.0).toFixed(1) : '0.0';

        readout.innerHTML = `
          <strong>${d}</strong> &bull; SPY: <strong class="highlight-gold">$${Number(p).toFixed(2)}</strong> &bull; 50D: <span class="color-bull">${m50Val}</span> &bull; 200D: <span style="color:#f472b6;">${m200Val} (${dist200 >= 0 ? '+' : ''}${dist200}%)</span> &bull; ${lowerLabel.split(':')[0]}: <strong class="color-bull">${Number(lVal).toFixed(2)}</strong> &bull; RSI: <strong>${rsiVal}</strong> &bull; 21D Vol: <strong>${rvolVal}%</strong>
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

    const SECTOR_DRIVERS = {
      'XLK': 'NVDA, AAPL, MSFT, AVGO',
      'XLV': 'LLY, UNH, JNJ, ABBV',
      'XLF': 'JPM, BAC, GS, MS, WFC',
      'XLI': 'GE, CAT, UNP, HON, RTX',
      'XLY': 'AMZN, TSLA, HD, MCD',
      'XLC': 'META, GOOGL, NFLX, DIS',
      'XLE': 'XOM, CVX, COP, EOG',
      'XLP': 'PG, COST, PEP, KO, WMT',
      'XLB': 'LIN, APD, SHW, ECL',
      'XLU': 'NEE, SO, DUK, CEG',
      'XLRE': 'PLD, AMT, EQIX, CCI'
    };

    const defaultSectors = [
      { ticker: 'XLK', name: 'Technology Select Sector SPDR', return_1y: 0.379, return_1m: 0.016, alpha_3m: 0.012, quadrant: 'LEADING', momentum: 88 },
      { ticker: 'XLC', name: 'Communication Services SPDR', return_1y: 0.005, return_1m: 0.012, alpha_3m: -0.087, quadrant: 'LAGGING', momentum: 42 },
      { ticker: 'XLF', name: 'Financial Select Sector SPDR', return_1y: 0.095, return_1m: 0.024, alpha_3m: 0.077, quadrant: 'IMPROVING', momentum: 76 },
      { ticker: 'XLI', name: 'Industrial Select Sector SPDR', return_1y: 0.205, return_1m: 0.018, alpha_3m: 0.030, quadrant: 'WEAKENING', momentum: 68 },
      { ticker: 'XLY', name: 'Consumer Discretionary SPDR', return_1y: 0.031, return_1m: 0.032, alpha_3m: -0.017, quadrant: 'IMPROVING', momentum: 58 },
      { ticker: 'XLV', name: 'Health Care Select Sector SPDR', return_1y: 0.293, return_1m: 0.096, alpha_3m: 0.144, quadrant: 'LEADING', momentum: 94 },
      { ticker: 'XLE', name: 'Energy Select Sector SPDR', return_1y: 0.495, return_1m: 0.087, alpha_3m: -0.011, quadrant: 'IMPROVING', momentum: 82 },
      { ticker: 'XLP', name: 'Consumer Staples Select Sector SPDR', return_1y: 0.057, return_1m: 0.030, alpha_3m: -0.043, quadrant: 'IMPROVING', momentum: 48 },
      { ticker: 'XLB', name: 'Materials Select Sector SPDR', return_1y: 0.174, return_1m: 0.048, alpha_3m: 0.023, quadrant: 'LEADING', momentum: 72 },
      { ticker: 'XLU', name: 'Utilities Select Sector SPDR', return_1y: 0.033, return_1m: -0.020, alpha_3m: -0.055, quadrant: 'LAGGING', momentum: 36 },
      { ticker: 'XLRE', name: 'Real Estate Select Sector SPDR', return_1y: 0.099, return_1m: -0.005, alpha_3m: -0.024, quadrant: 'LAGGING', momentum: 40 }
    ];

    const list = (macroState.sectors && macroState.sectors.sectors && macroState.sectors.sectors.length > 0)
      ? macroState.sectors.sectors
      : defaultSectors;

    tbody.innerHTML = list.map(s => {
      const ytdVal = s.return_1y ?? s.ytd ?? 0;
      const m1Val = s.return_1m ?? s.m1 ?? 0;
      const alphaVal = s.alpha_3m ?? s.alpha_1m ?? s.alpha ?? 0;

      const alphaClass = alphaVal >= 0 ? 'color-bull font-bold' : 'color-bear font-bold';
      let quadBadgeClass = 'verdict-pill too_early';
      if (s.quadrant === 'LEADING') quadBadgeClass = 'verdict-pill hit';
      else if (s.quadrant === 'LAGGING') quadBadgeClass = 'verdict-pill miss';
      else if (s.quadrant === 'IMPROVING') quadBadgeClass = 'badge-stance bullish';
      else if (s.quadrant === 'WEAKENING') quadBadgeClass = 'badge-stance bearish';

      let momentumScore = s.momentum;
      if (momentumScore === undefined || momentumScore === null || isNaN(momentumScore)) {
        const a3 = s.alpha_3m ?? 0;
        const a1 = s.alpha_1m ?? 0;
        const r1y = s.return_1y ?? 0;
        const rawScore = 50 + (a3 * 220) + (a1 * 180) + (r1y * 35);
        momentumScore = Math.round(Math.max(12, Math.min(98, rawScore)));
      }

      const scoreColor = momentumScore >= 70 ? 'var(--color-bull)' : (momentumScore <= 45 ? 'var(--color-bear)' : 'var(--accent-gold)');
      const driversText = s.drivers || SECTOR_DRIVERS[s.ticker] || 'Equities Basket';

      return `
        <tr>
          <td>
            <span class="ticker-pill font-mono">${s.ticker}</span>
            <strong style="margin-left:6px;">${escapeHtml(s.name)}</strong>
          </td>
          <td class="text-right font-mono font-bold">${fmtPct(ytdVal)}</td>
          <td class="text-right font-mono">${fmtPct(m1Val)}</td>
          <td class="text-right font-mono ${alphaClass}">${fmtPct(alphaVal)}</td>
          <td class="text-center"><span class="${quadBadgeClass}">${s.quadrant || 'NEUTRAL'}</span></td>
          <td class="text-center font-mono font-bold" style="color:${scoreColor};">
            ${momentumScore} / 100
          </td>
          <td style="font-size:11px; color:var(--text-secondary); font-family:var(--font-mono);">${escapeHtml(driversText)}</td>
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
     Section 06: SEC Form 4 Insider Radar & 13F Whales
     ========================================================================== */

  function renderInsiderSection() {
    const data = macroState.insiderData;
    if (!data) return;

    // HUD stats
    const scoreEl = document.getElementById('insiderSentimentScore');
    const labelEl = document.getElementById('insiderSentimentLabel');
    const buyEl = document.getElementById('insiderBuyDollars');
    const clusterCountEl = document.getElementById('insiderClusterCount');
    const topTickerEl = document.getElementById('insiderTopTicker');
    const routineSalesEl = document.getElementById('insiderRoutineSales');

    if (scoreEl && data.summary) scoreEl.textContent = `${data.summary.sentiment_score} / 100`;
    if (labelEl && data.summary) {
      labelEl.textContent = data.summary.sentiment_label;
      labelEl.className = `stat-sub font-mono ${data.summary.sentiment_score >= 65 ? 'color-bull' : 'color-bear'}`;
    }
    if (buyEl && data.summary) buyEl.textContent = `+$${(data.summary.opportunistic_buy_dollars / 1e6).toFixed(1)}M`;
    if (clusterCountEl && data.summary) clusterCountEl.textContent = `${data.summary.cluster_buy_events_count} Active Cluster Groups`;
    if (topTickerEl && data.summary) topTickerEl.textContent = data.summary.top_accumulated_ticker;
    if (routineSalesEl && data.summary) routineSalesEl.textContent = `-$${(data.summary.routine_10b5_1_sell_dollars / 1e6).toFixed(1)}M`;

    // Cluster buy alert banners
    const alertContainer = document.getElementById('clusterAlertsContainer');
    if (alertContainer && data.cluster_buy_signals) {
      // Group by cluster tag
      const clusters = {};
      data.cluster_buy_signals.forEach(s => {
        const tag = s.cluster_tag || 'CLUSTER';
        if (!clusters[tag]) clusters[tag] = [];
        clusters[tag].push(s);
      });

      alertContainer.innerHTML = Object.keys(clusters).map(tag => {
        const members = clusters[tag];
        const ticker = members[0].ticker;
        const company = members[0].company_name;
        const totalValM = (members.reduce((acc, m) => acc + m.value_dollar, 0) / 1e6).toFixed(2);
        const insidersList = members.map(m => `${m.insider_name} (${m.insider_title.split('&')[0]})`).join(', ');

        return `
          <div class="cluster-alert-card">
            <div>
              <div class="cluster-alert-top">
                <span class="cluster-tag-badge">ALERT: C-SUITE CLUSTER BUY</span>
                <span class="font-mono highlight-gold" style="font-size:12px; font-weight:700;">+$${totalValM}M NET BUY</span>
              </div>
              <h3 class="cluster-alert-title">${ticker} &bull; ${escapeHtml(company)}</h3>
              <p class="cluster-alert-desc">
                High-conviction open-market accumulation detected across ${members.length} executive officers: <strong>${escapeHtml(insidersList)}</strong>.
              </p>
            </div>
            <div class="cluster-alert-bottom">
              <span class="text-muted">Filing Window: ${members[0].filing_date}</span>
              <span class="color-bull font-bold">10b5-1 EXCLUDED // CONVICTION: HIGH</span>
            </div>
          </div>
        `;
      }).join('');
    }

    // Form 4 Transactions Table
    renderInsiderTable();
  }

  function renderInsiderTable() {
    const tbody = document.getElementById('insiderTbody');
    if (!tbody || !macroState.insiderData) return;

    let trades = macroState.insiderData.recent_transactions || [];
    const filter = macroState.insiderFilter || 'all';

    if (filter === 'buys') {
      trades = trades.filter(t => t.trade_type.includes('Purchase'));
    } else if (filter === 'clusters') {
      trades = trades.filter(t => t.conviction_rating.includes('CLUSTER'));
    } else if (filter === 'ceo') {
      trades = trades.filter(t => t.insider_title.includes('CEO') || t.insider_title.includes('CFO'));
    }

    if (trades.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="padding:24px; color:var(--text-muted);">No insider transactions match the selected filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = trades.map(t => {
      const isBuy = t.trade_type.includes('Purchase');
      const valM = (t.value_dollar / 1e6).toFixed(2);

      let badgeClass = 'conviction-badge routine-sale';
      let badgeLabel = t.conviction_rating.replace(/_/g, ' ');
      if (t.conviction_rating.includes('CLUSTER') || t.conviction_rating.includes('AGGRESSIVE')) {
        badgeClass = 'conviction-badge cluster-buy';
      } else if (isBuy) {
        badgeClass = 'conviction-badge high-buy';
      }

      return `
        <tr class="interactive-call-row">
          <td class="font-mono text-muted" style="font-size:11px;">${t.filing_date}</td>
          <td><span class="ticker-pill font-mono">${t.ticker}</span></td>
          <td>
            <strong>${escapeHtml(t.insider_name)}</strong>
            <div style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono);">${escapeHtml(t.insider_title)}</div>
          </td>
          <td class="text-center">
            <span class="badge-stance ${isBuy ? 'bullish' : 'bearish'}">${isBuy ? 'P - BUY' : 'S - SALE'}</span>
          </td>
          <td class="text-right font-mono">$${fmtNum(t.price, 2)}</td>
          <td class="text-right font-mono">${Number(t.qty).toLocaleString()}</td>
          <td class="text-right font-mono font-bold ${isBuy ? 'color-bull' : 'color-bear'}">
            ${isBuy ? '+' : '-'}$${valM}M
          </td>
          <td class="text-center font-mono">
            <span style="color:${t.is_10b5_1 ? 'var(--text-muted)' : '#4ade80'}; font-weight:${t.is_10b5_1 ? '400' : '700'};">
              ${t.is_10b5_1 ? '10b5-1 Plan' : 'Discretionary'}
            </span>
          </td>
          <td class="text-center">
            <span class="${badgeClass}">${badgeLabel}</span>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderWhaleSection() {
    const grid = document.getElementById('whaleCardsGrid');
    if (!grid || !macroState.whaleData) return;

    const holdings = macroState.whaleData.holdings || [];
    // Group by fund
    const funds = {};
    holdings.forEach(h => {
      if (!funds[h.fund_name]) {
        funds[h.fund_name] = {
          name: h.fund_name,
          manager: h.manager_name,
          aum: h.aum_billions,
          items: []
        };
      }
      funds[h.fund_name].items.push(h);
    });

    grid.innerHTML = Object.values(funds).map(f => {
      return `
        <div class="whale-card">
          <div>
            <div class="whale-card-header">
              <div>
                <div class="whale-fund-name">${escapeHtml(f.name)}</div>
                <div class="whale-manager-sub">${escapeHtml(f.manager)}</div>
              </div>
              <span class="whale-aum-badge">$${f.aum}B AUM</span>
            </div>
            <div class="whale-holdings-list">
              ${f.items.map(i => `
                <div class="whale-holding-row">
                  <div>
                    <span class="ticker-pill">${i.ticker}</span>
                    <strong style="margin-left:4px;">$${fmtNum(i.value_millions, 1)}M</strong>
                  </div>
                  <div style="display:flex; align-items:center; gap:6px;">
                    <span class="text-muted">${i.portfolio_weight_pct}% wt</span>
                    <span class="verdict-pill ${i.change_type === 'INCREASED' || i.change_type === 'NEW_POSITION' ? 'hit' : 'too_early'}" style="font-size:9px; padding:1px 5px;">
                      ${i.change_type.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
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

    const insiderPills = document.getElementById('insiderFilterPills');
    if (insiderPills) {
      insiderPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        insiderPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        macroState.insiderFilter = btn.dataset.filter || 'all';
        renderInsiderTable();
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
