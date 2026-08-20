/**
 * MomentumQ Terminal - Page 07: Crypto & Digital Assets Institutional Studio
 */

(function () {
  'use strict';

  const cryptoState = {
    overview: null,
    sentiment: null,
    halving: null,
    correlations: null,
    history: null,
    activeTicker: 'BTC',
    activeLookback: 365,
  };

  async function safeFetchJson(url, fallback) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[SafeFetch Crypto] Failed to load ${url}:`, err);
      return fallback;
    }
  }

  function fmtPct(val, decimals = 1, showSign = true) {
    if (val === null || val === undefined || isNaN(val)) return '\u2014';
    const sign = showSign && val > 0 ? '+' : '';
    return `${sign}${(Number(val)).toFixed(decimals)}%`;
  }

  function fmtNum(val, decimals = 2) {
    if (val === null || val === undefined || isNaN(val)) return '\u2014';
    return Number(val).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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

  async function fetchCryptoData(silent = false) {
    try {
      const [overviewRes, sentimentRes, halvingRes, corrRes, histRes] = await Promise.all([
        safeFetchJson('/api/crypto/overview', { headline: {}, assets: [], etfs: [] }),
        safeFetchJson('/api/crypto/sentiment', { score: 76.8, label: 'EXTREME GREED', categories: [] }),
        safeFetchJson('/api/crypto/halving-cycles', { active_cycle: {}, historical_cycles: [] }),
        safeFetchJson('/api/crypto/correlations', { matrix: {}, tickers: [] }),
        safeFetchJson(`/api/crypto/history?ticker=${cryptoState.activeTicker}&lookback=${cryptoState.activeLookback}`, { dates: [], close: [], sma_50: [], sma_200: [], rsi_14: [], realized_vol_21d: [] })
      ]);

      cryptoState.overview = overviewRes;
      cryptoState.sentiment = sentimentRes;
      cryptoState.halving = halvingRes;
      cryptoState.correlations = corrRes;
      cryptoState.history = histRes;

      updateCryptoHeaderKPIs();
      renderCryptoSpotTable();
      renderCryptoChart();
      renderCryptoSentimentSection();
      renderInstitutionalEtfsTable();
      renderHalvingCyclesCards();
      renderCryptoCorrelationMatrix();
    } catch (err) {
      console.error('Failed to load crypto data:', err);
    }
  }

  function updateCryptoHeaderKPIs() {
    const o = cryptoState.overview;
    if (o && o.headline) {
      const capEl = document.getElementById('kpiCryptoCap');
      const btcDomEl = document.getElementById('kpiBtcDom');
      const etfEl = document.getElementById('kpiEtfInflows');

      if (capEl) capEl.textContent = `$${o.headline.total_crypto_market_cap_trillions || '3.08'}T`;
      if (btcDomEl) btcDomEl.textContent = `${o.headline.btc_dominance_pct || '58.4'}%`;
      if (etfEl) etfEl.textContent = `+$${o.headline.net_etf_inflows_30d_billions || '6.66'}B`;
    }

    const s = cryptoState.sentiment;
    if (s) {
      const scoreEl = document.getElementById('kpiCryptoScore');
      const labelEl = document.getElementById('kpiCryptoLabel');

      if (scoreEl) scoreEl.textContent = `${s.score} / 100`;
      if (labelEl) {
        labelEl.textContent = s.label || 'EXTREME GREED';
        labelEl.className = `kpi-sub ${s.score >= 60 ? 'color-bull font-bold' : (s.score <= 40 ? 'color-bear font-bold' : 'highlight-gold')}`;
      }
    }
  }

  /* ==========================================================================
     Section 01: Spot Crypto Table
     ========================================================================== */

  function renderCryptoSpotTable() {
    const tbody = document.getElementById('cryptoSpotTbody');
    if (!tbody || !cryptoState.overview) return;

    const assets = cryptoState.overview.assets || [];
    tbody.innerHTML = assets.map(a => {
      const chgColor = (a.chg_24h_pct || 0) >= 0 ? 'color-bull' : 'color-bear';
      const chgSign = (a.chg_24h_pct || 0) >= 0 ? '+' : '';

      let postureClass = 'verdict-pill hit';
      if (a.trend_posture.includes('AGGRESSIVE') || a.trend_posture.includes('DISCOVERY')) postureClass = 'verdict-pill hit';
      else if (a.trend_posture.includes('HIGH_VOLATILITY')) postureClass = 'badge-stance bullish';
      else if (a.trend_posture.includes('RECOVERY')) postureClass = 'verdict-pill too_early';

      return `
        <tr class="interactive-call-row">
          <td>
            <span class="ticker-pill font-mono">${a.ticker}</span>
            <strong style="margin-left:6px;">${escapeHtml(a.name)}</strong>
            <div style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono);">${escapeHtml(a.category)}</div>
          </td>
          <td class="text-right font-mono font-bold highlight-gold">$${fmtNum(a.spot, a.spot < 10 ? 4 : 2)}</td>
          <td class="text-right font-mono ${chgColor}">${chgSign}${fmtNum(a.chg_24h_pct, 2)}%</td>
          <td class="text-right font-mono ${a.chg_7d_pct >= 0 ? 'color-bull' : 'color-bear'}">${fmtPct(a.chg_7d_pct, 1)}</td>
          <td class="text-right font-mono ${a.chg_30d_pct >= 0 ? 'color-bull' : 'color-bear'}">${fmtPct(a.chg_30d_pct, 1)}</td>
          <td class="text-right font-mono font-bold ${a.chg_1y_pct >= 0 ? 'color-bull' : 'color-bear'}">${fmtPct(a.chg_1y_pct, 1)}</td>
          <td class="text-right font-mono">$${fmtNum(a.market_cap_billions, 1)}B <span style="font-size:10px; color:var(--text-muted);">(${a.dominance_pct}%)</span></td>
          <td class="text-right font-mono text-muted">${fmtNum(a.pct_from_ath, 1)}%</td>
          <td class="text-center font-mono">${fmtNum(a.rvol_30d, 1)}%</td>
          <td class="text-center font-mono ${a.rsi_14 > 70 ? 'color-bear' : (a.rsi_14 < 30 ? 'color-bull' : '')}">${fmtNum(a.rsi_14, 1)}</td>
          <td class="text-center"><span class="${postureClass}">${a.trend_posture.replace(/_/g, ' ')}</span></td>
        </tr>
      `;
    }).join('');
  }

  /* ==========================================================================
     Section 02: Dual-Pane CRT Chart
     ========================================================================== */

  function renderCryptoChart() {
    const container = document.getElementById('cryptoSvgChartContainer');
    if (!container) return;

    const hist = cryptoState.history;
    if (!hist || !hist.dates || hist.dates.length === 0) {
      container.innerHTML = `<div style="padding:40px; color:var(--text-muted); font-family:var(--font-mono); font-size:12px;"><span class="sync-dot pulsing"></span> Ingesting digital assets time-series...</div>`;
      return;
    }

    const dates = hist.dates;
    const closes = hist.close;
    const sma50 = hist.sma_50;
    const sma200 = hist.sma_200;
    const rsi = hist.rsi_14;
    const rvol = hist.realized_vol_21d;

    const W = 1000;
    const H = 380;
    const padL = 65;
    const padR = 75;
    const plotW = W - padL - padR;

    const pTop = 25;
    const pBottom = 185;
    const pH = pBottom - pTop;

    const lTop = 220;
    const lBottom = 330;
    const lH = lBottom - lTop;

    const minP = Math.min(...closes) * 0.95;
    const maxP = Math.max(...closes) * 1.05;

    const getX = (i) => padL + (i / Math.max(1, dates.length - 1)) * plotW;
    const getYPrice = (p) => pTop + (1.0 - (p - minP) / Math.max(1, (maxP - minP))) * pH;
    const getYRsi = (val) => lTop + (1.0 - val / 100.0) * lH;

    // Paths
    let priceLineD = `M ${getX(0)} ${getYPrice(closes[0])}`;
    let priceAreaD = `M ${getX(0)} ${pBottom} L ${getX(0)} ${getYPrice(closes[0])}`;
    let sma50D = `M ${getX(0)} ${getYPrice(sma50[0])}`;
    let sma200D = `M ${getX(0)} ${getYPrice(sma200[0])}`;
    let rsiLineD = `M ${getX(0)} ${getYRsi(rsi[0])}`;

    for (let i = 1; i < dates.length; i++) {
      const x = getX(i);
      priceLineD += ` L ${x.toFixed(1)} ${getYPrice(closes[i]).toFixed(1)}`;
      priceAreaD += ` L ${x.toFixed(1)} ${getYPrice(closes[i]).toFixed(1)}`;
      sma50D += ` L ${x.toFixed(1)} ${getYPrice(sma50[i]).toFixed(1)}`;
      sma200D += ` L ${x.toFixed(1)} ${getYPrice(sma200[i]).toFixed(1)}`;
      rsiLineD += ` L ${x.toFixed(1)} ${getYRsi(rsi[i]).toFixed(1)}`;
    }
    priceAreaD += ` L ${getX(dates.length - 1)} ${pBottom} Z`;

    const priceTicks = [0, 0.25, 0.5, 0.75, 1.0].map(ratio => {
      const val = minP + ratio * (maxP - minP);
      return { val: val >= 1000 ? `$${Math.round(val).toLocaleString()}` : `$${val.toFixed(2)}`, y: getYPrice(val) };
    });

    const step = Math.max(1, Math.floor(dates.length / 6));
    const dateTicks = [];
    for (let i = 0; i < dates.length; i += step) {
      dateTicks.push({ label: dates[i], x: getX(i) });
    }

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:auto;" id="cryptoMasterSvg">
        <defs>
          <linearGradient id="cryptoPriceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ffaa00" stop-opacity="0.35"/>
            <stop offset="60%" stop-color="#ffaa00" stop-opacity="0.08"/>
            <stop offset="100%" stop-color="#ffaa00" stop-opacity="0.0"/>
          </linearGradient>
          <filter id="neonCryptoGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.8" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        <rect x="${padL}" y="${pTop}" width="${plotW}" height="${pBottom - pTop}" fill="rgba(10, 15, 24, 0.65)"/>
        <rect x="${padL}" y="${lTop}" width="${plotW}" height="${lBottom - lTop}" fill="rgba(10, 15, 24, 0.65)"/>

        <!-- Gridlines -->
        ${priceTicks.map(t => `
          <line x1="${padL}" y1="${t.y}" x2="${W - padR}" y2="${t.y}" stroke="#172234" stroke-width="1" stroke-dasharray="2,3"/>
          <text x="${W - padR + 6}" y="${t.y + 4}" fill="#94a3b8" font-family="var(--font-mono)" font-size="10">${t.val}</text>
        `).join('')}

        <!-- Price Area & Lines -->
        <path d="${priceAreaD}" fill="url(#cryptoPriceGrad)" />
        <path d="${priceLineD}" fill="none" stroke="#ffaa00" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" filter="url(#neonCryptoGlow)"/>
        <path d="${sma50D}" fill="none" stroke="#34d399" stroke-width="1.6" stroke-dasharray="4,2"/>
        <path d="${sma200D}" fill="none" stroke="#f472b6" stroke-width="1.8"/>

        <!-- Header Tag -->
        <rect x="${padL + 6}" y="${pTop + 4}" width="360" height="18" fill="rgba(15, 23, 34, 0.85)" rx="3" stroke="#1e293b"/>
        <text x="${padL + 12}" y="${pTop + 16}" fill="#fbbf24" font-family="var(--font-mono)" font-size="10" font-weight="700">
          ${cryptoState.activeTicker}/USD SPOT // 50D (GREEN) & 200D (PINK) SMAs
        </text>

        <!-- Lower Track (RSI) -->
        <line x1="${padL}" y1="202" x2="${W - padR}" y2="202" stroke="#263449" stroke-width="1.2"/>
        <rect x="${padL}" y="${getYRsi(100)}" width="${plotW}" height="${getYRsi(70) - getYRsi(100)}" fill="rgba(239, 68, 68, 0.08)"/>
        <rect x="${padL}" y="${getYRsi(30)}" width="${plotW}" height="${getYRsi(0) - getYRsi(30)}" fill="rgba(34, 197, 94, 0.08)"/>
        <line x1="${padL}" y1="${getYRsi(70)}" x2="${W - padR}" y2="${getYRsi(70)}" stroke="rgba(239, 68, 68, 0.35)" stroke-width="1" stroke-dasharray="3,3"/>
        <line x1="${padL}" y1="${getYRsi(50)}" x2="${W - padR}" y2="${getYRsi(50)}" stroke="rgba(251, 191, 36, 0.25)" stroke-width="1" stroke-dasharray="2,2"/>
        <line x1="${padL}" y1="${getYRsi(30)}" x2="${W - padR}" y2="${getYRsi(30)}" stroke="rgba(34, 197, 94, 0.35)" stroke-width="1" stroke-dasharray="3,3"/>
        <text x="${W - padR + 6}" y="${getYRsi(70) + 3}" fill="#f87171" font-family="var(--font-mono)" font-size="9">70 (OVERBOUGHT)</text>
        <text x="${W - padR + 6}" y="${getYRsi(50) + 3}" fill="#fbbf24" font-family="var(--font-mono)" font-size="9">50 (NEUTRAL)</text>
        <text x="${W - padR + 6}" y="${getYRsi(30) + 3}" fill="#4ade80" font-family="var(--font-mono)" font-size="9">30 (OVERSOLD)</text>

        <path d="${rsiLineD}" fill="none" stroke="#38bdf8" stroke-width="2.0" stroke-linejoin="round" stroke-linecap="round" filter="url(#neonCryptoGlow)"/>

        <rect x="${padL + 6}" y="${lTop + 4}" width="320" height="18" fill="rgba(15, 23, 34, 0.85)" rx="3" stroke="#1e293b"/>
        <text x="${padL + 12}" y="${lTop + 16}" fill="#38bdf8" font-family="var(--font-mono)" font-size="10" font-weight="700">14-DAY RELATIVE STRENGTH INDEX (RSI)</text>

        <!-- Date Ticks -->
        ${dateTicks.map(t => `
          <line x1="${t.x}" y1="${lBottom}" x2="${t.x}" y2="${lBottom + 4}" stroke="#4a5568" stroke-width="1"/>
          <text x="${t.x}" y="${lBottom + 14}" text-anchor="middle" fill="#718096" font-family="var(--font-mono)" font-size="9.5">${t.label}</text>
        `).join('')}

        <!-- Hover Tracking -->
        <g id="cryptoHoverGroup" style="display:none;">
          <line id="cryptoHoverLine" x1="0" y1="${pTop}" x2="0" y2="${lBottom}" stroke="#f8fafc" stroke-width="1" stroke-dasharray="2,2" opacity="0.75"/>
          <circle id="cryptoHoverPriceDot" cx="0" cy="0" r="5" fill="#fbbf24" stroke="#090d13" stroke-width="2"/>
          <circle id="cryptoHoverRsiDot" cx="0" cy="0" r="5" fill="#38bdf8" stroke="#090d13" stroke-width="2"/>
        </g>

        <rect id="cryptoMouseOverlay" x="${padL}" y="${pTop}" width="${plotW}" height="${lBottom - pTop}" fill="transparent" style="cursor:crosshair; pointer-events:all;"/>
      </svg>
    `;

    // Crosshair hover tracking
    const overlay = document.getElementById('cryptoMouseOverlay');
    const hoverGroup = document.getElementById('cryptoHoverGroup');
    const hoverLine = document.getElementById('cryptoHoverLine');
    const priceDot = document.getElementById('cryptoHoverPriceDot');
    const rsiDot = document.getElementById('cryptoHoverRsiDot');
    const readout = document.getElementById('cryptoChartReadout');

    if (overlay && hoverGroup && readout) {
      overlay.addEventListener('mousemove', (e) => {
        const rect = overlay.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const normX = Math.max(0, Math.min(1, mouseX / rect.width));
        const idx = Math.round(normX * (dates.length - 1));

        const d = dates[idx];
        const p = closes[idx];
        const rVal = rsi[idx];
        if (!d) return;

        const x = getX(idx);
        const yP = getYPrice(p);
        const yR = getYRsi(rVal);

        hoverGroup.style.display = 'block';
        hoverLine.setAttribute('x1', x);
        hoverLine.setAttribute('x2', x);
        priceDot.setAttribute('cx', x);
        priceDot.setAttribute('cy', yP);
        rsiDot.setAttribute('cx', x);
        rsiDot.setAttribute('cy', yR);

        const m50 = sma50[idx] ? `$${Number(sma50[idx]).toLocaleString()}` : '\u2014';
        const m200 = sma200[idx] ? `$${Number(sma200[idx]).toLocaleString()}` : '\u2014';
        const dist200 = sma200[idx] ? (((p / sma200[idx]) - 1.0) * 100.0).toFixed(1) : '0.0';

        readout.innerHTML = `
          <strong>${d}</strong> &bull; ${cryptoState.activeTicker}: <strong class="highlight-gold">$${Number(p).toLocaleString()}</strong> &bull; 50D: <span class="color-bull">${m50}</span> &bull; 200D: <span style="color:#f472b6;">${m200} (${dist200 >= 0 ? '+' : ''}${dist200}%)</span> &bull; RSI: <strong class="color-bull">${rVal}</strong> &bull; 21D Vol: <strong>${rvol[idx]}%</strong>
        `;
      });

      overlay.addEventListener('mouseleave', () => {
        hoverGroup.style.display = 'none';
        readout.textContent = 'Hover over chart to inspect daily historical crypto price & indicators';
      });
    }
  }

  /* ==========================================================================
     Section 03: Crypto Fear & Greed Index 2.0
     ========================================================================== */

  function renderCryptoSentimentSection() {
    const s = cryptoState.sentiment;
    if (!s) return;

    const scoreEl = document.getElementById('cryptoSentimentScore');
    const labelEl = document.getElementById('cryptoSentimentLabel');
    const barEl = document.getElementById('cryptoSentimentDialBar');
    const list = document.getElementById('cryptoCategoriesList');

    if (scoreEl) scoreEl.textContent = s.score;
    if (labelEl) {
      labelEl.textContent = s.label;
      labelEl.className = `fg-hero-label font-mono ${s.score >= 60 ? 'color-bull' : (s.score <= 40 ? 'color-bear' : 'highlight-gold')}`;
    }
    if (barEl) {
      barEl.style.width = `${s.score}%`;
      barEl.style.background = s.score >= 60 ? '#38bdf8' : (s.score <= 40 ? '#f87171' : '#fbbf24');
    }

    if (list && s.categories) {
      list.innerHTML = s.categories.map(c => {
        const barColor = c.score > 60 ? '#38bdf8' : (c.score < 40 ? '#f87171' : '#fbbf24');
        return `
          <div class="fg-category-row">
            <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
              <span style="font-size:12px; font-weight:600; color:var(--text-primary);">
                ${escapeHtml(c.name)} <span style="font-size:10px; color:var(--text-dim); font-family:var(--font-mono);">(${c.weight}%)</span>
              </span>
              <span style="font-family:var(--font-mono); font-weight:700; color:${barColor}; font-size:12px;">${c.score} / 100</span>
            </div>
            <div style="height:6px; background:rgba(255,255,255,0.04); border-radius:3px; overflow:hidden; margin-bottom:4px;">
              <div style="width:${c.score}%; height:100%; background:${barColor}; border-radius:3px;"></div>
            </div>
            <span style="font-size:10.5px; color:var(--text-muted);">${escapeHtml(c.desc)}</span>
          </div>
        `;
      }).join('');
    }
  }

  /* ==========================================================================
     Section 04: Institutional Spot ETFs & Proxies
     ========================================================================== */

  function renderInstitutionalEtfsTable() {
    const tbody = document.getElementById('etfTbody');
    if (!tbody || !cryptoState.overview) return;

    const etfs = cryptoState.overview.etfs || [];
    tbody.innerHTML = etfs.map(e => {
      const inflowColor = e.net_inflows_30d_millions >= 0 ? 'color-bull font-bold' : 'color-bear font-bold';
      return `
        <tr class="interactive-call-row">
          <td>
            <span class="ticker-pill font-mono">${e.ticker}</span>
            <strong style="margin-left:6px;">${escapeHtml(e.name)}</strong>
          </td>
          <td>${escapeHtml(e.issuer)}</td>
          <td class="text-right font-mono font-bold highlight-gold">$${fmtNum(e.spot, 2)}</td>
          <td class="text-right font-mono font-bold">$${fmtNum(e.aum_billions, 1)}B</td>
          <td class="text-right font-mono ${inflowColor}">+$${fmtNum(e.net_inflows_30d_millions, 1)}M</td>
          <td class="text-right font-mono">${e.premium_nav_pct > 1 ? `${e.premium_nav_pct}x mNAV` : `${e.premium_nav_pct >= 0 ? '+' : ''}${(e.premium_nav_pct * 100).toFixed(2)}%`}</td>
          <td class="text-right font-mono text-muted">${Number(e.volume_shares).toLocaleString()}</td>
          <td class="text-center font-mono">${e.expense_ratio}</td>
          <td class="text-center font-mono" style="font-size:11px; color:var(--text-secondary);">${escapeHtml(e.custodian)}</td>
        </tr>
      `;
    }).join('');
  }

  /* ==========================================================================
     Section 05: Bitcoin 4-Year Halving Cycle Cards
     ========================================================================== */

  function renderHalvingCyclesCards() {
    const grid = document.getElementById('halvingCardsGrid');
    if (!grid || !cryptoState.halving) return;

    const cycles = cryptoState.halving.historical_cycles || [];
    grid.innerHTML = cycles.map(c => {
      const isActive = c.cycle_phase !== undefined;
      return `
        <div class="whale-card" style="${isActive ? 'border-color:rgba(251,191,36,0.5); background:linear-gradient(180deg, rgba(251,191,36,0.08) 0%, var(--bg-surface) 100%);' : ''}">
          <div>
            <div class="whale-card-header">
              <div>
                <div class="whale-fund-name">${escapeHtml(c.cycle_name)}</div>
                <div class="whale-manager-sub">Halving Date: ${c.halving_date}</div>
              </div>
              <span class="whale-aum-badge">${isActive ? 'ACTIVE CYCLE' : `${c.peak_multiple}x PEAK`}</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:6px; font-family:var(--font-mono); font-size:11px; margin-top:8px;">
              <div style="display:flex; justify-content:space-between;">
                <span class="text-muted">Halving Price:</span>
                <strong>$${fmtNum(c.halving_price, 2)}</strong>
              </div>
              <div style="display:flex; justify-content:space-between;">
                <span class="text-muted">${isActive ? 'Current Price:' : 'Peak Price:'}</span>
                <strong class="highlight-gold">$${fmtNum(isActive ? c.current_price : c.peak_price, 2)}</strong>
              </div>
              <div style="display:flex; justify-content:space-between;">
                <span class="text-muted">${isActive ? 'Current Multiplier:' : 'Peak Multiplier:'}</span>
                <strong class="color-bull">${isActive ? `${c.current_multiple}x` : `${c.peak_multiple}x`}</strong>
              </div>
              <div style="display:flex; justify-content:space-between;">
                <span class="text-muted">${isActive ? 'Days Post Halving:' : 'Peak Timing:'}</span>
                <span>${isActive ? `${c.days_post_halving} Days` : `Day ${c.peak_days_post}`}</span>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  /* ==========================================================================
     Section 06: Cross-Asset Correlation Matrix
     ========================================================================== */

  function renderCryptoCorrelationMatrix() {
    const thead = document.getElementById('cryptoCorrThead');
    const tbody = document.getElementById('cryptoCorrTbody');
    if (!thead || !tbody || !cryptoState.correlations) return;

    const tickers = cryptoState.correlations.tickers || [];
    const matrix = cryptoState.correlations.matrix || {};

    thead.innerHTML = `
      <tr>
        <th style="min-width:70px;">ASSET</th>
        ${tickers.map(t => `<th class="text-center font-mono" style="min-width:65px;">${t}</th>`).join('')}
      </tr>
    `;

    tbody.innerHTML = tickers.map(rowTicker => {
      const row = matrix[rowTicker] || {};
      return `
        <tr>
          <td><span class="ticker-pill font-mono">${rowTicker}</span></td>
          ${tickers.map(colTicker => {
            const val = row[colTicker] !== undefined ? row[colTicker] : 0.0;
            const isSelf = rowTicker === colTicker;
            
            let color = '#94a3b8';
            let bg = 'transparent';
            if (!isSelf) {
              if (val >= 0.7) { color = '#38bdf8'; bg = 'rgba(56, 189, 248, 0.15)'; }
              else if (val >= 0.3) { color = '#4ade80'; bg = 'rgba(74, 222, 128, 0.08)'; }
              else if (val <= -0.3) { color = '#f87171'; bg = 'rgba(248, 113, 113, 0.12)'; }
            }

            return `
              <td class="text-center font-mono" style="color:${color}; background:${bg}; font-weight:${isSelf ? '700' : '500'};">
                ${val.toFixed(2)}
              </td>
            `;
          }).join('')}
        </tr>
      `;
    }).join('');
  }

  /* ==========================================================================
     Event Listeners
     ========================================================================== */

  function setupCryptoEventListeners() {
    const assetPills = document.getElementById('cryptoAssetPills');
    if (assetPills) {
      assetPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        assetPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cryptoState.activeTicker = btn.dataset.ticker || 'BTC';
        safeFetchJson(`/api/crypto/history?ticker=${cryptoState.activeTicker}&lookback=${cryptoState.activeLookback}`, { dates: [], close: [] })
          .then(data => {
            cryptoState.history = data;
            renderCryptoChart();
          });
      });
    }

    const lookbackPills = document.getElementById('cryptoLookbackPills');
    if (lookbackPills) {
      lookbackPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        lookbackPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cryptoState.activeLookback = parseInt(btn.dataset.days || '365', 10);
        safeFetchJson(`/api/crypto/history?ticker=${cryptoState.activeTicker}&lookback=${cryptoState.activeLookback}`, { dates: [], close: [] })
          .then(data => {
            cryptoState.history = data;
            renderCryptoChart();
          });
      });
    }
  }

  /* ==========================================================================
     Initialization
     ========================================================================== */

  function initCryptoApp() {
    setupCryptoEventListeners();
    fetchCryptoData(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCryptoApp);
  } else {
    initCryptoApp();
  }

})();
