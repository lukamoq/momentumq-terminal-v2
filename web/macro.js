/**
 * Macro Regime, VIX Term Structure & Fear/Greed 2.0 Controller (macro.js)
 * 5-state regime classifier, 10-factor sentiment, CBOE variance, sector breadth, and correlation matrix
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
    fgHistory: null,
    fgHistoryDays: 300
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
      const [regimeRes, fgRes, vixRes, sectorsRes, corrRes, fgHistRes] = await Promise.all([
        safeFetchJson('/api/macro/regime', { regime: 'BULL_EXUBERANT', confidence_pct: 88, factors: [] }),
        safeFetchJson('/api/macro/fear-greed', { score: 68, label: 'GREED', categories: [] }),
        safeFetchJson('/api/macro/vix-structure', { state: 'CONTANGO', contango_ratio: 1.09, vix_9d: 13.4, vix_30d: 14.82, vix_90d: 16.15 }),
        safeFetchJson('/api/analytics/sectors', { sectors: [] }),
        safeFetchJson(`/api/analytics/correlation?lookback=${macroState.corrLookback}`, { matrix: {}, tickers: [] }),
        safeFetchJson('/api/macro/fear-greed/history?lookback=500', [])
      ]);

      macroState.regime = regimeRes;
      macroState.fearGreed = fgRes;
      macroState.vixStructure = vixRes;
      macroState.sectors = sectorsRes;
      macroState.correlation = corrRes;
      macroState.fgHistory = (fgHistRes && fgHistRes.length > 0) ? fgHistRes : (fgRes.history || []);

      updateMacroHeaderStats();
      renderMacroRegimeSection();
      renderFearGreedSection();
      renderFearGreedHistoryChart();
      renderFearGreedHistoryTable();
      renderVixStructureSection();
      renderSectorRotationTable();
      renderCorrelationMatrix();

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

    // Factors checklist
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
     Fear & Greed Historical Dual Chart & Table
     ========================================================================== */

  function renderFearGreedHistoryChart() {
    const container = document.getElementById('fgSvgChartContainer');
    if (!container) return;

    const rawData = macroState.fgHistory;
    if (!rawData || rawData.length === 0) {
      container.innerHTML = `<div style="padding:40px; color:var(--text-muted); font-family:var(--font-mono); font-size:12px;">Loading historical price and sentiment time-series...</div>`;
      return;
    }

    const data = rawData.slice(-macroState.fgHistoryDays);
    if (data.length < 2) {
      container.innerHTML = `<div style="padding:40px; color:var(--text-muted); font-family:var(--font-mono); font-size:12px;">Insufficient data points for chosen timeframe.</div>`;
      return;
    }

    const W = 1000;
    const H = 340;
    const padL = 55;
    const padR = 60;
    const plotW = W - padL - padR;

    // Pane 1: SPY Price (Y: 25 to 175)
    const pTop = 25;
    const pBottom = 175;
    const pH = pBottom - pTop;

    // Pane 2: Fear & Greed (Y: 210 to 310)
    const fgTop = 210;
    const fgBottom = 310;
    const fgH = fgBottom - fgTop;

    const prices = data.map(d => d.spy_close);
    const minP = Math.min(...prices) * 0.985;
    const maxP = Math.max(...prices) * 1.015;

    const getX = (i) => padL + (i / (data.length - 1)) * plotW;
    const getYPrice = (p) => pTop + (1.0 - (p - minP) / (maxP - minP)) * pH;
    const getYFG = (s) => fgTop + (1.0 - s / 100.0) * fgH;

    // Price line and area path
    let priceLineD = `M ${getX(0)} ${getYPrice(data[0].spy_close)}`;
    let priceAreaD = `M ${getX(0)} ${pBottom} L ${getX(0)} ${getYPrice(data[0].spy_close)}`;

    // FG line path
    let fgLineD = `M ${getX(0)} ${getYFG(data[0].score)}`;

    for (let i = 1; i < data.length; i++) {
      const x = getX(i);
      const yP = getYPrice(data[i].spy_close);
      const yF = getYFG(data[i].score);
      priceLineD += ` L ${x.toFixed(1)} ${yP.toFixed(1)}`;
      priceAreaD += ` L ${x.toFixed(1)} ${yP.toFixed(1)}`;
      fgLineD += ` L ${x.toFixed(1)} ${yF.toFixed(1)}`;
    }
    priceAreaD += ` L ${getX(data.length - 1)} ${pBottom} Z`;

    // Price Gridlines (4 levels)
    const priceTicks = [0, 0.33, 0.66, 1.0].map(ratio => {
      const val = minP + ratio * (maxP - minP);
      const y = getYPrice(val);
      return { val: val.toFixed(1), y };
    });

    // Date ticks (5 to 7 dates)
    const step = Math.max(1, Math.floor(data.length / 6));
    const dateTicks = [];
    for (let i = 0; i < data.length; i += step) {
      dateTicks.push({ label: data[i].date, x: getX(i) });
    }
    if (dateTicks.length > 0 && dateTicks[dateTicks.length - 1].x < W - padR - 50) {
      dateTicks.push({ label: data[data.length - 1].date, x: getX(data.length - 1) });
    }

    const svgHtml = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:auto;" id="fgDualSvg">
        <defs>
          <linearGradient id="priceAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ffaa00" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#ffaa00" stop-opacity="0.0"/>
          </linearGradient>
          <linearGradient id="fgLineGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#38bdf8"/>
            <stop offset="100%" stop-color="#38bdf8"/>
          </linearGradient>
        </defs>

        <!-- Pane 1: SPY Price Gridlines -->
        ${priceTicks.map(t => `
          <line x1="${padL}" y1="${t.y}" x2="${W - padR}" y2="${t.y}" stroke="#1f2838" stroke-width="1" stroke-dasharray="2,3"/>
          <text x="${W - padR + 6}" y="${t.y + 4}" fill="#718096" font-family="var(--font-mono)" font-size="10">$${t.val}</text>
        `).join('')}

        <!-- Price Area & Line -->
        <path d="${priceAreaD}" fill="url(#priceAreaGrad)" />
        <path d="${priceLineD}" fill="none" stroke="#ffaa00" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        <text x="${padL + 8}" y="${pTop + 14}" fill="#ffaa00" font-family="var(--font-mono)" font-size="11" font-weight="700">S&amp;P 500 ETF (SPY) CLOSE PRICE ($)</text>

        <!-- Pane Divider -->
        <line x1="${padL}" y1="192" x2="${W - padR}" y2="192" stroke="#263449" stroke-width="1.2"/>

        <!-- Pane 2: Fear & Greed Sentiment Background Bands -->
        <rect x="${padL}" y="${getYFG(100)}" width="${plotW}" height="${getYFG(75) - getYFG(100)}" fill="rgba(16, 185, 129, 0.09)"/>
        <rect x="${padL}" y="${getYFG(75)}" width="${plotW}" height="${getYFG(60) - getYFG(75)}" fill="rgba(52, 211, 153, 0.04)"/>
        <rect x="${padL}" y="${getYFG(60)}" width="${plotW}" height="${getYFG(40) - getYFG(60)}" fill="rgba(251, 191, 36, 0.02)"/>
        <rect x="${padL}" y="${getYFG(40)}" width="${plotW}" height="${getYFG(25) - getYFG(40)}" fill="rgba(249, 115, 22, 0.04)"/>
        <rect x="${padL}" y="${getYFG(25)}" width="${plotW}" height="${getYFG(0) - getYFG(25)}" fill="rgba(239, 68, 68, 0.09)"/>

        <!-- Sentiment Zone Reference Lines -->
        <line x1="${padL}" y1="${getYFG(75)}" x2="${W - padR}" y2="${getYFG(75)}" stroke="rgba(16, 185, 129, 0.35)" stroke-width="1" stroke-dasharray="3,3"/>
        <text x="${W - padR + 6}" y="${getYFG(75) + 3}" fill="#34d399" font-family="var(--font-mono)" font-size="9.5">75 (GREED)</text>

        <line x1="${padL}" y1="${getYFG(50)}" x2="${W - padR}" y2="${getYFG(50)}" stroke="rgba(251, 191, 36, 0.3)" stroke-width="1" stroke-dasharray="2,2"/>
        <text x="${W - padR + 6}" y="${getYFG(50) + 3}" fill="#fbbf24" font-family="var(--font-mono)" font-size="9.5">50 (NEUTRAL)</text>

        <line x1="${padL}" y1="${getYFG(25)}" x2="${W - padR}" y2="${getYFG(25)}" stroke="rgba(239, 68, 68, 0.35)" stroke-width="1" stroke-dasharray="3,3"/>
        <text x="${W - padR + 6}" y="${getYFG(25) + 3}" fill="#ef4444" font-family="var(--font-mono)" font-size="9.5">25 (FEAR)</text>

        <!-- FG Indicator Line -->
        <path d="${fgLineD}" fill="none" stroke="#38bdf8" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round"/>
        <text x="${padL + 8}" y="${fgTop + 14}" fill="#38bdf8" font-family="var(--font-mono)" font-size="11" font-weight="700">MoQ FEAR &amp; GREED COMPOSITE SCORE (0–100)</text>

        <!-- Date Ticks -->
        ${dateTicks.map(t => `
          <line x1="${t.x}" y1="${fgBottom}" x2="${t.x}" y2="${fgBottom + 4}" stroke="#4a5568" stroke-width="1"/>
          <text x="${t.x}" y="${fgBottom + 16}" text-anchor="middle" fill="#718096" font-family="var(--font-mono)" font-size="9.5">${t.label}</text>
        `).join('')}

        <!-- Dynamic Hover Tracking Guides -->
        <g id="fgHoverGroup" style="display:none;">
          <line id="fgHoverLine" x1="0" y1="${pTop}" x2="0" y2="${fgBottom}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3,3" opacity="0.75"/>
          <circle id="fgHoverPriceDot" cx="0" cy="0" r="4.5" fill="#ffaa00" stroke="#0e131e" stroke-width="2"/>
          <circle id="fgHoverFgDot" cx="0" cy="0" r="4.5" fill="#38bdf8" stroke="#0e131e" stroke-width="2"/>
        </g>

        <!-- Invisible Mouse Target Layer -->
        <rect id="fgMouseOverlay" x="${padL}" y="${pTop}" width="${plotW}" height="${fgBottom - pTop}" fill="transparent" style="cursor:crosshair; pointer-events:all;"/>
      </svg>
    `;

    container.innerHTML = svgHtml;

    // Attach interactive hover listener
    const overlay = document.getElementById('fgMouseOverlay');
    const hoverGroup = document.getElementById('fgHoverGroup');
    const hoverLine = document.getElementById('fgHoverLine');
    const priceDot = document.getElementById('fgHoverPriceDot');
    const fgDot = document.getElementById('fgHoverFgDot');
    const readout = document.getElementById('fgChartHoverReadout');

    if (overlay && hoverGroup && readout) {
      overlay.addEventListener('mousemove', (e) => {
        const rect = overlay.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const normX = Math.max(0, Math.min(1, mouseX / rect.width));
        const idx = Math.round(normX * (data.length - 1));
        const item = data[idx];
        if (!item) return;

        const x = getX(idx);
        const yP = getYPrice(item.spy_close);
        const yF = getYFG(item.score);

        hoverGroup.style.display = 'block';
        hoverLine.setAttribute('x1', x);
        hoverLine.setAttribute('x2', x);
        priceDot.setAttribute('cx', x);
        priceDot.setAttribute('cy', yP);
        fgDot.setAttribute('cx', x);
        fgDot.setAttribute('cy', yF);

        const chgSign = item.pct_change >= 0 ? '+' : '';
        const chgColor = item.pct_change >= 0 ? '#34d399' : '#ef4444';

        readout.innerHTML = `
          <strong>${item.date}</strong> &bull; SPY: <strong style="color:#ffaa00;">$${item.spy_close}</strong> (<span style="color:${chgColor};">${chgSign}${item.pct_change}%</span>) &bull; F&amp;G: <strong style="color:${item.bar_color};">${item.score} (${item.label.toUpperCase()})</strong> &bull; RSI: <strong>${item.rsi}</strong>
        `;
      });

      overlay.addEventListener('mouseleave', () => {
        hoverGroup.style.display = 'none';
        readout.textContent = 'Hover over chart to inspect daily values';
      });
    }
  }

  function renderFearGreedHistoryTable() {
    const tbody = document.getElementById('fgHistoryTbody');
    const countEl = document.getElementById('fgHistoryRecordCount');
    if (!tbody) return;

    const rawData = macroState.fgHistory;
    if (!rawData || rawData.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding:24px; color:var(--text-muted);">No historical records available.</td></tr>`;
      return;
    }

    const data = rawData.slice(-macroState.fgHistoryDays);
    if (countEl) countEl.textContent = `Showing ${data.length} Trading Sessions`;

    const reversed = [...data].reverse();

    tbody.innerHTML = reversed.map(r => {
      const isPos = r.pct_change >= 0;
      const chgColor = isPos ? 'color-bull' : 'color-bear';
      const chgSign = isPos ? '+' : '';

      // Sentiment badge
      let badgeClass = 'verdict-pill hit';
      if (r.score <= 25) badgeClass = 'verdict-pill miss';
      else if (r.score <= 40) badgeClass = 'badge-stance bearish';
      else if (r.score <= 60) badgeClass = 'verdict-pill too_early';
      else if (r.score <= 75) badgeClass = 'badge-stance bullish';

      // Market inflection signal note
      let signal = '🟢 Normal Risk-On Carry';
      if (r.score <= 25 && r.rsi <= 40) {
        signal = '🚨 <strong class="color-bear">CAPITULATION PANIC (CONTRARIAN BUY)</strong>';
      } else if (r.score <= 35) {
        signal = '⚠️ <span class="color-bear">Risk-Off Deleveraging</span>';
      } else if (r.score >= 75 && r.rsi >= 65) {
        signal = '⚡ <strong class="highlight-gold">EXUBERANCE / FROTH OVERBOUGHT</strong>';
      } else if (r.score >= 60) {
        signal = '🟢 Favorable Equity Carry';
      } else {
        signal = '🟡 Consolidation / Equilibrium';
      }

      return `
        <tr>
          <td class="font-mono font-bold">${r.date}</td>
          <td class="text-right font-mono font-bold highlight-gold">$${r.spy_close.toFixed(2)}</td>
          <td class="text-right font-mono ${chgColor}">${chgSign}${r.pct_change}%</td>
          <td class="text-center">
            <div style="display:flex; align-items:center; justify-content:center; gap:8px;">
              <div style="width:40px; height:5px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden;">
                <div style="width:${r.score}%; height:100%; background:${r.bar_color}; border-radius:3px;"></div>
              </div>
              <strong class="font-mono" style="color:${r.bar_color};">${r.score}</strong>
            </div>
          </td>
          <td class="text-center"><span class="${badgeClass}">${r.label.toUpperCase()}</span></td>
          <td class="text-center font-mono">${r.rsi}</td>
          <td class="text-center font-mono text-muted">${r.realized_vol_21d}%</td>
          <td style="font-size:11px;">${signal}</td>
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
                // Approximate realistic default
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

    const fgLookbackPills = document.getElementById('fgLookbackPills');
    if (fgLookbackPills) {
      fgLookbackPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        fgLookbackPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        macroState.fgHistoryDays = parseInt(btn.dataset.days || '300', 10);
        renderFearGreedHistoryChart();
        renderFearGreedHistoryTable();
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
