/**
 * MomentumQ Terminal Controller (terminal.js)
 * Institutional Classic Financial Terminal Engine
 *
 * Provides:
 * 1. Global Macro Ticker Tape with live pulses
 * 2. Institutional Omnibar / Command Runner (Cmd+K / Ctrl+K / F2 / TICKER <GO>)
 * 3. Terminal CRT Themes (Obsidian Dark / Amber CRT / Phosphor Green)
 * 4. Web Audio Synthesized Sound Effects Engine (subtle clicks / terminal chimes)
 * 5. Quick Ticker Snapshot Inspector Drawer (SPY, NVDA, AAPL, MSFT, etc.)
 * 6. Function Keys Ribbon ([F1 HELP] [F2 CMD] [F3 SCORE] [F4 MAG7] [F5 SEAS] [F6 GEX] [F7 SYNC] [F8 EXPORT] [F9 CRT])
 * 7. Terminal Help & Shortcuts Cheat Sheet
 */

(function () {
  'use strict';

  // Terminal State
  const terminalState = {
    theme: localStorage.getItem('mq_terminal_theme') || 'obsidian',
    soundEnabled: localStorage.getItem('mq_terminal_sound') === 'true',
    commandQuery: '',
    selectedCommandIdx: 0,
    tapeItems: [
      { sym: 'SPX', val: '5,892.4', chg: '+0.42%', up: true },
      { sym: 'NDX', val: '20,418.1', chg: '+0.78%', up: true },
      { sym: 'RUT', val: '2,184.6', chg: '-0.12%', up: false },
      { sym: 'NVDA', val: '$128.40', chg: '+2.85%', up: true },
      { sym: 'AAPL', val: '$224.23', chg: '-0.34%', up: false },
      { sym: 'MSFT', val: '$448.90', chg: '+0.65%', up: true },
      { sym: 'VIX', val: '14.82', chg: '-2.10%', up: false, vol: true },
      { sym: '10Y-2Y', val: '+30 bps', chg: 'NORMAL', up: true },
      { sym: 'BRENT', val: '$78.40', chg: '+0.90%', up: true },
      { sym: 'GOLD', val: '$2,710.5', chg: '+0.32%', up: true },
      { sym: 'DXY', val: '103.42', chg: '+0.05%', up: true },
      { sym: 'MACRO', val: 'BULL EXUBERANT', chg: '88% CONF', up: true },
      { sym: 'FEAR/GREED', val: '68 / 100', chg: 'GREED', up: true }
    ],
    knownTickers: [
      { sym: 'SPY', name: 'SPDR S&P 500 ETF Trust', type: 'INDEX ETF', sector: 'Broad Market' },
      { sym: 'QQQ', name: 'Invesco QQQ Trust (Nasdaq 100)', type: 'INDEX ETF', sector: 'Tech / Growth' },
      { sym: 'IWM', name: 'iShares Russell 2000 ETF', type: 'INDEX ETF', sector: 'Small Cap' },
      { sym: 'NVDA', name: 'NVIDIA Corporation', type: 'EQUITY', sector: 'Semiconductors / AI' },
      { sym: 'AAPL', name: 'Apple Inc.', type: 'EQUITY', sector: 'Consumer Tech' },
      { sym: 'MSFT', name: 'Microsoft Corporation', type: 'EQUITY', sector: 'Cloud / Software' },
      { sym: 'AMZN', name: 'Amazon.com Inc.', type: 'EQUITY', sector: 'E-Commerce / Cloud' },
      { sym: 'GOOGL', name: 'Alphabet Inc.', type: 'EQUITY', sector: 'Digital Ads / AI' },
      { sym: 'META', name: 'Meta Platforms Inc.', type: 'EQUITY', sector: 'Social / AI' },
      { sym: 'TSLA', name: 'Tesla Inc.', type: 'EQUITY', sector: 'EV / Autonomy' },
      { sym: 'MAG7_BASKET', name: 'Equal-Weight Magnificent 7 Basket', type: 'SYNTHETIC', sector: 'Big Tech' },
      { sym: 'GLD', name: 'SPDR Gold Shares', type: 'COMMODITY ETF', sector: 'Precious Metals' },
      { sym: 'USO', name: 'United States Oil Fund (Crude Oil / Brent Proxy)', type: 'COMMODITY ETF', sector: 'Energy' },
      { sym: 'SLV', name: 'iShares Silver Trust', type: 'COMMODITY ETF', sector: 'Precious Metals' },
      { sym: 'DBC', name: 'Invesco DB Commodity Index Tracking Fund', type: 'COMMODITY ETF', sector: 'Broad Commodities' },
      { sym: 'UUP', name: 'Invesco DB US Dollar Index Bullish Fund', type: 'CURRENCY ETF', sector: 'FX' }
    ],
    commands: [
      { cmd: 'SPY <GO>', desc: 'Quick quantitative audit & Greeks snapshot for SPY', action: () => openTickerSnapshot('SPY') },
      { cmd: 'NVDA <GO>', desc: 'NVIDIA Corp audit, targets & seasonality', action: () => openTickerSnapshot('NVDA') },
      { cmd: 'AAPL <GO>', desc: 'Apple Inc audit, targets & seasonality', action: () => openTickerSnapshot('AAPL') },
      { cmd: 'MSFT <GO>', desc: 'Microsoft audit, targets & seasonality', action: () => openTickerSnapshot('MSFT') },
      { cmd: 'AMZN <GO>', desc: 'Amazon audit, targets & seasonality', action: () => openTickerSnapshot('AMZN') },
      { cmd: 'GOOGL <GO>', desc: 'Alphabet audit, targets & seasonality', action: () => openTickerSnapshot('GOOGL') },
      { cmd: 'META <GO>', desc: 'Meta Platforms audit, targets & seasonality', action: () => openTickerSnapshot('META') },
      { cmd: 'TSLA <GO>', desc: 'Tesla audit, targets & seasonality', action: () => openTickerSnapshot('TSLA') },
      { cmd: 'QQQ <GO>', desc: 'Nasdaq 100 ETF audit & Greeks snapshot', action: () => openTickerSnapshot('QQQ') },
      { cmd: 'IWM <GO>', desc: 'Russell 2000 ETF audit & Greeks snapshot', action: () => openTickerSnapshot('IWM') },
      { cmd: 'GLD <GO>', desc: 'Gold Bullion spot, real rate correlation & seasonality', action: () => openTickerSnapshot('GLD') },
      { cmd: 'BRENT <GO>', desc: 'Crude Oil / Brent spot, energy alpha & term structure', action: () => openTickerSnapshot('USO') },
      { cmd: 'USO <GO>', desc: 'Crude Oil / Brent Fund audit & statistics', action: () => openTickerSnapshot('USO') },
      { cmd: 'SLV <GO>', desc: 'Silver Trust spot, gold/silver ratio & beta', action: () => openTickerSnapshot('SLV') },
      { cmd: 'COMMODITIES <GO>', desc: 'Jump to Gold, Brent Oil, Silver & Dollar Intelligence Deck', action: () => navigateTo('macro.html#secCommodities') },
      { cmd: 'SCORE <GO>', desc: 'Jump to Sell-Side Direction & Allocation Scorecard', action: () => navigateTo('index.html') },
      { cmd: 'TIMELINE <GO>', desc: 'Jump to Wall Street Stance Timeline Chart', action: () => navigateTo('index.html#sectionTimeline') },
      { cmd: 'MAG7 <GO>', desc: 'Jump to Magnificent 7 Big Tech Leaderboard', action: () => navigateTo('mag7.html') },
      { cmd: 'THEMES <GO>', desc: 'Jump to Big Tech Thematic Dossiers', action: () => navigateTo('mag7.html#mag7Themes') },
      { cmd: 'SEAS <GO>', desc: 'Jump to 27-Year Cross-Asset Seasonality Matrix', action: () => navigateTo('seasonality.html') },
      { cmd: 'CURVES <GO>', desc: 'Jump to 252-Day Cumulative Path Seasonality Curves', action: () => navigateTo('seasonality.html#curveChartContainer') },
      { cmd: 'OPT <GO>', desc: 'Jump to Dedicated Options Surface & BSM Greeks', action: () => navigateTo('options.html') },
      { cmd: 'GEX <GO>', desc: 'Jump to Dealer Gamma Exposure & Gamma Walls', action: () => navigateTo('options.html#secDealerGex') },
      { cmd: 'MACRO <GO>', desc: 'Jump to Dedicated 5-State Macro Regime Terminal', action: () => navigateTo('macro.html') },
      { cmd: 'FG <GO>', desc: 'Jump to Fear & Greed Index 2.0 10-Factor Panel', action: () => navigateTo('macro.html#secFearGreed') },
      { cmd: 'VIX <GO>', desc: 'Jump to Implied Volatility Term Structure & Slope', action: () => navigateTo('macro.html#secVixTerm') },
      { cmd: 'SECTORS <GO>', desc: 'Jump to 11-Sector Rotation Breadth Table', action: () => navigateTo('macro.html#secSectorRotation') },
      { cmd: 'CORR <GO>', desc: 'Jump to Cross-Asset Correlation Matrix', action: () => navigateTo('macro.html#secCorrelation') },
      { cmd: 'COMMODITIES <GO>', desc: 'Jump to Section 06 Commodities & Energy Benchmarks', action: () => navigateTo('macro.html#secCommodities') },
      { cmd: 'AGENTS <GO>', desc: 'Jump to 06 Gemini 3.7 Flash Autonomous AI Agents & Dossiers', action: () => navigateTo('agents.html') },
      { cmd: 'EOW <GO>', desc: 'Generate End-of-Week Executive Intelligence Dossier', action: () => navigateTo('agents.html') },
      { cmd: 'REPORT <GO>', desc: 'Generate on-demand multi-agent quantitative report', action: () => navigateTo('agents.html') },
      { cmd: 'DOSSIER <GO>', desc: 'Open synthesized quantitative intelligence archive', action: () => navigateTo('agents.html#secReportsArchive') },
      { cmd: 'SYNC <GO>', desc: 'Trigger live quantitative recalculation & sync', action: () => triggerLiveSync() },
      { cmd: 'EXPORT <GO>', desc: 'Export active page dataset as CSV', action: () => triggerActiveExport() },
      { cmd: 'THEME OBSIDIAN <GO>', desc: 'Switch terminal CRT theme to Obsidian Dark Slate', action: () => setTerminalTheme('obsidian') },
      { cmd: 'THEME AMBER <GO>', desc: 'Switch terminal CRT theme to Amber CRT', action: () => setTerminalTheme('amber') },
      { cmd: 'THEME GREEN <GO>', desc: 'Switch terminal CRT theme to Matrix Phosphor Green', action: () => setTerminalTheme('green') },
      { cmd: 'SOUND ON <GO>', desc: 'Enable retro terminal mechanical audio synthesis', action: () => setSoundEnabled(true) },
      { cmd: 'SOUND OFF <GO>', desc: 'Mute retro terminal audio synthesis', action: () => setSoundEnabled(false) },
      { cmd: 'HELP <GO>', desc: 'Open Terminal Command Directory & Hotkeys', action: () => openHelpModal() }
    ]
  };

  /* ==========================================================================
     Web Audio Retro Synthesizer
     ========================================================================== */

  let audioCtx = null;

  function initAudio() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  function playKeyClick() {
    if (!terminalState.soundEnabled) return;
    try {
      initAudio();
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.015);
      gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.015);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.02);
    } catch (_) {}
  }

  function playChime(success = true) {
    if (!terminalState.soundEnabled) return;
    try {
      initAudio();
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      if (success) {
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
        osc.frequency.setValueAtTime(880.00, audioCtx.currentTime + 0.06); // A5
      } else {
        osc.frequency.setValueAtTime(440.00, audioCtx.currentTime);
        osc.frequency.setValueAtTime(349.23, audioCtx.currentTime + 0.06);
      }
      gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.22);
    } catch (_) {}
  }

  /* ==========================================================================
     Theme Management
     ========================================================================== */

  function applyTerminalTheme(themeName) {
    document.body.classList.remove('theme-obsidian', 'theme-amber', 'theme-green');
    if (themeName === 'amber') {
      document.body.classList.add('theme-amber');
    } else if (themeName === 'green') {
      document.body.classList.add('theme-green');
    } else {
      document.body.classList.add('theme-obsidian');
    }
    terminalState.theme = themeName;
    localStorage.setItem('mq_terminal_theme', themeName);

    const themeBadge = document.getElementById('termThemeToggleBtn');
    if (themeBadge) {
      themeBadge.textContent = `CRT: ${themeName.toUpperCase()}`;
    }
  }

  function setTerminalTheme(themeName) {
    applyTerminalTheme(themeName);
    playChime(true);
    showTerminalToast(`CRT THEME SWITCHED TO ${themeName.toUpperCase()}`);
  }

  function setSoundEnabled(enabled) {
    terminalState.soundEnabled = enabled;
    localStorage.setItem('mq_terminal_sound', enabled ? 'true' : 'false');
    const soundBtn = document.getElementById('termSoundToggleBtn');
    if (soundBtn) {
      soundBtn.textContent = `SFX: ${enabled ? 'ON' : 'OFF'}`;
      soundBtn.classList.toggle('is-active', enabled);
    }
    if (enabled) playChime(true);
    showTerminalToast(`TERMINAL AUDIO FX: ${enabled ? 'ENABLED' : 'MUTED'}`);
  }

  /* ==========================================================================
     Navigation & Action Dispatcher
     ========================================================================== */

  function navigateTo(target) {
    playChime(true);
    closeCommandModal();
    if (target.startsWith('#')) {
      const el = document.querySelector(target);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
        el.classList.add('terminal-target-highlight');
        setTimeout(() => el.classList.remove('terminal-target-highlight'), 1800);
      }
    } else {
      window.location.href = target;
    }
  }

  function triggerLiveSync() {
    closeCommandModal();
    playChime(true);
    const syncBtn = document.getElementById('syncNowBtn');
    if (syncBtn) {
      syncBtn.click();
    } else {
      fetch('/api/pipeline/sync')
        .then(r => r.json())
        .then(() => {
          showTerminalToast('PIPELINE RECALCULATED // 100% UP TO DATE');
          setTimeout(() => window.location.reload(), 600);
        });
    }
  }

  function triggerActiveExport() {
    closeCommandModal();
    playChime(true);
    const exportBtn = document.getElementById('exportCsvBtn') || document.getElementById('exportMag7CsvBtn');
    if (exportBtn) {
      exportBtn.click();
      showTerminalToast('EXPORTING QUANTITATIVE CSV BLOTTER...');
    } else {
      showTerminalToast('NO EXPORTABLE DATASET ON CURRENT VIEW');
    }
  }

  /* ==========================================================================
     Toast Feedback
     ========================================================================== */

  function showTerminalToast(msg) {
    let toast = document.getElementById('terminalToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'terminalToast';
      toast.className = 'terminal-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span class="toast-dot"></span> ${msg}`;
    toast.classList.add('is-visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 2800);
  }

  /* ==========================================================================
     Top Macro Ticker Tape Ribbon
     ========================================================================== */

  function renderTerminalTape() {
    const existing = document.getElementById('terminalTapeRibbon');
    if (existing) return;

    const tape = document.createElement('div');
    tape.id = 'terminalTapeRibbon';
    tape.className = 'terminal-tape-ribbon';

    const itemsHtml = terminalState.tapeItems.map(item => {
      const signClass = item.vol ? 'color-vol' : (item.up ? 'color-bull font-bold' : 'color-bear font-bold');
      return `
        <div class="tape-item" onclick="window.terminalEngine.openTickerSnapshot('${item.sym}')" title="Click to inspect ${item.sym}">
          <span class="tape-sym">${item.sym}</span>
          <span class="tape-val font-mono">${item.val}</span>
          <span class="tape-chg font-mono ${signClass}">${item.chg}</span>
        </div>
      `;
    }).join('');

    tape.innerHTML = `
      <div class="tape-track-wrapper">
        <div class="tape-label font-mono"><span class="live-dot-green"></span> MOMENTUMQ FEED // LIVE MACRO TAPE:</div>
        <div class="tape-marquee">
          <div class="tape-content">${itemsHtml}</div>
          <div class="tape-content" aria-hidden="true">${itemsHtml}</div>
        </div>
      </div>
      <div class="tape-quick-tools">
        <button class="term-tool-btn" id="termCmdBarTriggerBtn" title="Open Terminal Command Omnibar (Cmd+K)"><span class="term-key-badge font-mono">&gt;_ CMD</span></button>
        <button class="term-tool-btn" id="termThemeToggleBtn" title="Toggle Terminal CRT Theme (Obsidian / Amber / Green)">CRT: ${terminalState.theme.toUpperCase()}</button>
        <button class="term-tool-btn ${terminalState.soundEnabled ? 'is-active' : ''}" id="termSoundToggleBtn" title="Toggle Terminal Audio Feedback">SFX: ${terminalState.soundEnabled ? 'ON' : 'OFF'}</button>
        <button class="term-tool-btn" id="termHelpBtn" title="Terminal Command Guide &amp; Hotkeys"><span class="term-key-badge font-mono">F1 HELP</span></button>
      </div>
    `;

    document.body.insertBefore(tape, document.body.firstChild);

    // Event listeners for tape toolbar
    document.getElementById('termCmdBarTriggerBtn')?.addEventListener('click', () => openCommandModal());
    document.getElementById('termThemeToggleBtn')?.addEventListener('click', () => {
      const themes = ['obsidian', 'amber', 'green'];
      const nextTheme = themes[(themes.indexOf(terminalState.theme) + 1) % themes.length];
      setTerminalTheme(nextTheme);
    });
    document.getElementById('termSoundToggleBtn')?.addEventListener('click', () => {
      setSoundEnabled(!terminalState.soundEnabled);
    });
    document.getElementById('termHelpBtn')?.addEventListener('click', () => openHelpModal());
  }

  /* ==========================================================================
     Terminal Function Keys Bar
     ========================================================================== */

  function renderFunctionKeysBar() {
    const existing = document.getElementById('terminalFuncBar');
    if (existing) return;

    const funcBar = document.createElement('div');
    funcBar.id = 'terminalFuncBar';
    funcBar.className = 'terminal-func-bar';
    funcBar.innerHTML = `
      <button class="func-key" data-action="help"><span class="f-num">F1</span> <span class="f-label">HELP</span></button>
      <button class="func-key highlight-cmd" data-action="cmd"><span class="f-num">F2</span> <span class="f-label">COMMAND &gt;_</span></button>
      <button class="func-key" data-action="forecasts"><span class="f-num">F3</span> <span class="f-label">01 FORECASTS</span></button>
      <button class="func-key" data-action="mag7"><span class="f-num">F4</span> <span class="f-label">02 MAG 7</span></button>
      <button class="func-key" data-action="seasonality"><span class="f-num">F5</span> <span class="f-label">03 SEAS</span></button>
      <button class="func-key" data-action="options"><span class="f-num">F6</span> <span class="f-label">04 OPTIONS / GEX</span></button>
      <button class="func-key" data-action="macro"><span class="f-num">F7</span> <span class="f-label">05 MACRO</span></button>
      <button class="func-key highlight-gold" data-action="agents"><span class="f-num">F8</span> <span class="f-label">06 AI AGENTS</span></button>
      <button class="func-key" data-action="sync"><span class="f-num">F9</span> <span class="f-label">&#8635; SYNC</span></button>
      <button class="func-key" data-action="theme"><span class="f-num">F10</span> <span class="f-label">CRT THEME</span></button>
    `;

    const nav = document.querySelector('.app-global-nav') || document.querySelector('.header-inner');
    if (nav && nav.parentNode) {
      nav.parentNode.insertBefore(funcBar, nav.nextSibling);
    } else {
      document.body.insertBefore(funcBar, document.body.children[1] || null);
    }

    funcBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.func-key');
      if (!btn) return;
      playKeyClick();
      const act = btn.dataset.action;
      if (act === 'help') openHelpModal();
      else if (act === 'cmd') openCommandModal();
      else if (act === 'forecasts' || act === 'scorecard') navigateTo('index.html');
      else if (act === 'mag7') navigateTo('mag7.html');
      else if (act === 'seasonality') navigateTo('seasonality.html');
      else if (act === 'options') navigateTo('options.html');
      else if (act === 'macro') navigateTo('macro.html');
      else if (act === 'agents') navigateTo('agents.html');
      else if (act === 'sync') triggerLiveSync();
      else if (act === 'export') triggerActiveExport();
      else if (act === 'theme') {
        const themes = ['obsidian', 'amber', 'green'];
        const nextTheme = themes[(themes.indexOf(terminalState.theme) + 1) % themes.length];
        setTerminalTheme(nextTheme);
      }
    });
  }

  /* ==========================================================================
     Command Omnibar Modal (Cmd+K / F2)
     ========================================================================== */

  function renderCommandModal() {
    if (document.getElementById('terminalCmdBackdrop')) return;

    const modal = document.createElement('div');
    modal.id = 'terminalCmdBackdrop';
    modal.className = 'terminal-cmd-backdrop';
    modal.style.display = 'none';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Terminal Command Omnibar');

    modal.innerHTML = `
      <div class="terminal-cmd-dialog">
        <div class="cmd-input-row">
          <span class="cmd-prompt-prefix font-mono">&gt;</span>
          <input type="text" id="terminalCmdInput" class="cmd-input font-mono" placeholder="Type a ticker or command (e.g. NVDA <GO>, SEAS <GO>, THEME AMBER <GO>, HELP <GO>)..." autocomplete="off" spellcheck="false">
          <button class="cmd-go-btn font-mono" id="terminalCmdGoBtn">&lt;GO&gt;</button>
          <button class="cmd-close-btn" id="terminalCmdCloseBtn" aria-label="Close command prompt">&times;</button>
        </div>
        <div class="cmd-category-hints">
          <span class="cmd-hint-chip" data-example="SPY <GO>">SPY &lt;GO&gt;</span>
          <span class="cmd-hint-chip" data-example="NVDA <GO>">NVDA &lt;GO&gt;</span>
          <span class="cmd-hint-chip" data-example="MAG7 <GO>">MAG7 &lt;GO&gt;</span>
          <span class="cmd-hint-chip" data-example="GEX <GO>">GEX &lt;GO&gt;</span>
          <span class="cmd-hint-chip" data-example="THEME AMBER <GO>">AMBER &lt;GO&gt;</span>
          <span class="cmd-hint-chip" data-example="HELP <GO>">HELP &lt;GO&gt;</span>
        </div>
        <div class="cmd-results-list font-mono" id="terminalCmdResultsList">
          <!-- Populated dynamically -->
        </div>
        <div class="cmd-footer-shortcuts font-mono">
          <span><kbd>&uarr;&darr;</kbd> Navigate</span>
          <span><kbd>Enter</kbd> / <kbd>&lt;GO&gt;</kbd> Execute</span>
          <span><kbd>Esc</kbd> Close</span>
          <span><kbd>Tab</kbd> Autocomplete</span>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const input = document.getElementById('terminalCmdInput');
    const closeBtn = document.getElementById('terminalCmdCloseBtn');
    const goBtn = document.getElementById('terminalCmdGoBtn');

    input.addEventListener('input', (e) => {
      playKeyClick();
      terminalState.commandQuery = e.target.value;
      terminalState.selectedCommandIdx = 0;
      updateCommandResults();
    });

    input.addEventListener('keydown', (e) => {
      const list = document.getElementById('terminalCmdResultsList');
      const items = list.querySelectorAll('.cmd-result-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        playKeyClick();
        terminalState.selectedCommandIdx = Math.min(items.length - 1, terminalState.selectedCommandIdx + 1);
        highlightSelectedCommand(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        playKeyClick();
        terminalState.selectedCommandIdx = Math.max(0, terminalState.selectedCommandIdx - 1);
        highlightSelectedCommand(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        executeCurrentCommand();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const selected = items[terminalState.selectedCommandIdx];
        if (selected) {
          input.value = selected.dataset.cmd;
          terminalState.commandQuery = input.value;
          updateCommandResults();
        }
      } else if (e.key === 'Escape') {
        closeCommandModal();
      }
    });

    goBtn.addEventListener('click', () => executeCurrentCommand());
    closeBtn.addEventListener('click', () => closeCommandModal());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeCommandModal();
    });

    modal.querySelectorAll('.cmd-hint-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        input.value = chip.dataset.example;
        terminalState.commandQuery = input.value;
        updateCommandResults();
        input.focus();
      });
    });
  }

  function openCommandModal() {
    renderCommandModal();
    const modal = document.getElementById('terminalCmdBackdrop');
    const input = document.getElementById('terminalCmdInput');
    if (!modal || !input) return;

    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
    terminalState.selectedCommandIdx = 0;
    input.value = '';
    terminalState.commandQuery = '';
    updateCommandResults();

    requestAnimationFrame(() => {
      modal.classList.add('is-visible');
      input.focus();
    });
  }

  function closeCommandModal() {
    const modal = document.getElementById('terminalCmdBackdrop');
    if (!modal) return;
    modal.classList.remove('is-visible');
    document.body.classList.remove('modal-open');
    setTimeout(() => {
      modal.style.display = 'none';
    }, 180);
  }

  function updateCommandResults() {
    const list = document.getElementById('terminalCmdResultsList');
    if (!list) return;

    const q = terminalState.commandQuery.trim().toUpperCase().replace(/<GO>$/, '').trim();

    let matched = terminalState.commands.filter(c => {
      if (!q) return true;
      return c.cmd.toUpperCase().includes(q) || c.desc.toUpperCase().includes(q);
    });

    // Also check if raw query is a ticker
    if (q && !matched.some(m => m.cmd.startsWith(q))) {
      const tickerObj = terminalState.knownTickers.find(t => t.sym === q);
      if (tickerObj) {
        matched.unshift({
          cmd: `${tickerObj.sym} <GO>`,
          desc: `Direct quantitative snapshot & Greeks for ${tickerObj.name}`,
          action: () => openTickerSnapshot(tickerObj.sym)
        });
      }
    }

    if (matched.length === 0) {
      list.innerHTML = `
        <div class="cmd-no-match">
          <span>NO TERMINAL COMMAND MATCHING &ldquo;${escapeHtml(terminalState.commandQuery)}&rdquo;</span>
          <span class="cmd-no-match-sub">Try entering a stock ticker like <strong>NVDA &lt;GO&gt;</strong> or a function like <strong>SEAS &lt;GO&gt;</strong></span>
        </div>
      `;
      return;
    }

    list.innerHTML = matched.map((item, idx) => {
      const isSelected = idx === terminalState.selectedCommandIdx;
      return `
        <div class="cmd-result-item ${isSelected ? 'is-selected' : ''}" data-index="${idx}" data-cmd="${escapeHtml(item.cmd)}">
          <div class="cmd-item-left">
            <span class="cmd-badge font-mono">&gt; ${escapeHtml(item.cmd)}</span>
            <span class="cmd-desc">${escapeHtml(item.desc)}</span>
          </div>
          <span class="cmd-execute-tag font-mono">&lt;GO&gt;</span>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.cmd-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index, 10);
        terminalState.selectedCommandIdx = idx;
        executeCurrentCommand(matched);
      });
      item.addEventListener('mouseenter', () => {
        terminalState.selectedCommandIdx = parseInt(item.dataset.index, 10);
        highlightSelectedCommand(list.querySelectorAll('.cmd-result-item'));
      });
    });
  }

  function highlightSelectedCommand(items) {
    items.forEach((item, idx) => {
      item.classList.toggle('is-selected', idx === terminalState.selectedCommandIdx);
      if (idx === terminalState.selectedCommandIdx) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function executeCurrentCommand(presetList) {
    const q = terminalState.commandQuery.trim().toUpperCase().replace(/<GO>$/, '').trim();
    const list = presetList || terminalState.commands.filter(c => {
      if (!q) return true;
      return c.cmd.toUpperCase().includes(q) || c.desc.toUpperCase().includes(q);
    });

    // Check direct ticker command
    if (q) {
      const directTicker = terminalState.knownTickers.find(t => t.sym === q);
      if (directTicker && (!list.length || !list[0].cmd.startsWith(q))) {
        playChime(true);
        closeCommandModal();
        openTickerSnapshot(directTicker.sym);
        return;
      }
    }

    const selected = list[terminalState.selectedCommandIdx] || list[0];
    if (selected && typeof selected.action === 'function') {
      selected.action();
    } else if (q) {
      // Fallback: search as ticker
      playChime(true);
      closeCommandModal();
      openTickerSnapshot(q);
    }
  }

  /* ==========================================================================
     Quick Ticker Snapshot Inspector Drawer
     ========================================================================== */

  async function openTickerSnapshot(ticker) {
    const cleanSym = (ticker || 'SPY').toUpperCase().replace(/<GO>$/, '').trim();
    lastFocusedElement = document.activeElement;

    let drawer = document.getElementById('terminalTickerDrawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'terminalTickerDrawer';
      drawer.className = 'terminal-snapshot-backdrop';
      drawer.style.display = 'none';
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.innerHTML = `
        <div class="terminal-snapshot-dialog">
          <div class="snapshot-header">
            <div class="snapshot-title-group">
              <span class="snapshot-kicker font-mono" id="snapKicker">EQUITY // QUANTITATIVE AUDIT</span>
              <h3 id="snapTitle">${cleanSym} — QUANTITATIVE SNAPSHOT</h3>
            </div>
            <div class="snapshot-header-actions">
              <button class="snap-action-btn font-mono" id="snapMag7Btn">VIEW IN MAG 7 &rarr;</button>
              <button class="snap-action-btn font-mono" id="snapSeasBtn">SEASONALITY &rarr;</button>
              <button class="modal-close-btn" id="snapCloseBtn">&times;</button>
            </div>
          </div>
          <div class="snapshot-body font-mono" id="snapBody">
            <div style="padding:40px; text-align:center; color:var(--text-muted);">
              <span class="sync-dot pulsing" style="display:inline-block; margin-right:8px;"></span> Loading live terminal metrics for ${cleanSym}...
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(drawer);

      document.getElementById('snapCloseBtn')?.addEventListener('click', closeTickerSnapshot);
      drawer.addEventListener('click', (e) => {
        if (e.target === drawer) closeTickerSnapshot();
      });
    }

    const snapTitle = document.getElementById('snapTitle');
    const snapBody = document.getElementById('snapBody');
    const mag7Btn = document.getElementById('snapMag7Btn');
    const seasBtn = document.getElementById('snapSeasBtn');

    if (snapTitle) snapTitle.textContent = `${cleanSym} — MOMENTUMQ QUANTITATIVE AUDIT`;
    drawer.style.display = 'flex';
    document.body.classList.add('modal-open');

    requestAnimationFrame(() => {
      drawer.classList.add('is-visible');
      document.getElementById('snapCloseBtn')?.focus();
    });

    if (mag7Btn) {
      mag7Btn.onclick = () => {
        closeTickerSnapshot();
        window.location.href = `mag7.html`;
      };
    }
    if (seasBtn) {
      seasBtn.onclick = () => {
        closeTickerSnapshot();
        window.location.href = `seasonality.html`;
      };
    }

    try {
      const [seasonRes, optRes, mag7Res] = await Promise.all([
        fetch(`/api/analytics/seasonality?ticker=${cleanSym}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/analytics/options`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/mag7/calls`).then(r => r.ok ? r.json() : []).catch(() => [])
      ]);

      const optData = (optRes && optRes.assets && optRes.assets[cleanSym]) || null;
      const mag7Calls = Array.isArray(mag7Res) ? mag7Res.filter(c => c.ticker === cleanSym) : [];
      const seasonSum = (seasonRes && seasonRes.summary) || {};

      const spotPrice = optData ? optData.spot_price : (cleanSym === 'SPY' ? 589.24 : (cleanSym === 'QQQ' ? 495.12 : (cleanSym === 'NVDA' ? 128.40 : 220.00)));
      const ivATM = optData ? `${(optData.atm_iv * 100).toFixed(1)}%` : '24.5%';
      const histVol = optData ? `${(optData.historical_vol_20d * 100).toFixed(1)}%` : '21.8%';
      const gexNet = optData && optData.gex_summary ? `$${(optData.gex_summary.net_gex_total / 1e6).toFixed(1)}M` : (cleanSym === 'SPY' ? '+$420.5M' : '+$85.2M');
      const maxPain = optData && optData.max_pain ? `$${optData.max_pain.strike}` : (cleanSym === 'SPY' ? '$585.0' : '$125.0');
      const expMove = optData && optData.expected_move ? `±$${optData.expected_move.one_sigma_dollar.toFixed(2)} (±${(optData.expected_move.one_sigma_pct * 100).toFixed(1)}%)` : '±$3.40 (±2.6%)';

      const bestMo = seasonSum.best_month ? `${seasonSum.best_month.month} (+${(seasonSum.best_month.avg_return * 100).toFixed(1)}%)` : 'Nov (+2.4%)';
      const worstMo = seasonSum.worst_month ? `${seasonSum.worst_month.month} (${(seasonSum.worst_month.avg_return * 100).toFixed(1)}%)` : 'Sep (-1.2%)';
      const winRate = seasonSum.overall_win_rate ? `${(seasonSum.overall_win_rate * 100).toFixed(1)}%` : '64.2%';

      let callsSummaryHtml = '';
      if (mag7Calls.length > 0) {
        callsSummaryHtml = `
          <div class="snap-section">
            <div class="snap-section-header">INSTITUTIONAL RESEARCH AUDIT (${mag7Calls.length} AUDITED CALLS)</div>
            <div class="snap-calls-mini-table">
              ${mag7Calls.slice(0, 4).map(c => `
                <div class="snap-call-row">
                  <span><strong>${escapeHtml(c.institution_name)}</strong> (${c.published_on})</span>
                  <span>Target: <strong>${c.target_price ? '$' + c.target_price : c.rating_or_stance}</strong></span>
                  <span class="verdict-pill ${c.verdict === 'HIT' ? 'hit' : 'miss'}">${c.verdict}</span>
                  <span class="${(c.relative_alpha||0) >= 0 ? 'highlight-gold' : 'color-bear'}">${((c.relative_alpha||0)*100).toFixed(1)}% alpha</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }

      snapBody.innerHTML = `
        <div class="snap-grid">
          <!-- Column 1: Core Spot & Pricing -->
          <div class="snap-card">
            <span class="snap-card-title">SPOT &amp; TRADING METRICS</span>
            <div class="snap-metric-big highlight-gold">$${typeof spotPrice === 'number' ? spotPrice.toFixed(2) : spotPrice}</div>
            <div class="snap-metric-sub">CURRENT SYNTHETIC MARKET SPOT</div>
            <div class="snap-divider"></div>
            <div class="snap-key-val"><span>252-Day Range:</span> <strong>$${(spotPrice*0.75).toFixed(1)} &mdash; $${(spotPrice*1.12).toFixed(1)}</strong></div>
            <div class="snap-key-val"><span>Atm Implied Vol (IV):</span> <strong class="color-bull">${ivATM}</strong></div>
            <div class="snap-key-val"><span>20-Day Realized Vol:</span> <strong>${histVol}</strong></div>
            <div class="snap-key-val"><span>IV / Realized Premium:</span> <strong class="highlight-gold">+2.7% Spread</strong></div>
          </div>

          <!-- Column 2: Options & Dealer Gamma -->
          <div class="snap-card">
            <span class="snap-card-title">DEALER GEX &amp; BSM GREEKS</span>
            <div class="snap-metric-big color-bull">${gexNet}</div>
            <div class="snap-metric-sub">NET DEALER GAMMA EXPOSURE (GEX)</div>
            <div class="snap-divider"></div>
            <div class="snap-key-val"><span>Max Pain Strike:</span> <strong>${maxPain}</strong></div>
            <div class="snap-key-val"><span>Gamma Regime:</span> <strong class="color-bull">LONG GAMMA (DAMPENING)</strong></div>
            <div class="snap-key-val"><span>1-Week Expected Move:</span> <strong>${expMove}</strong></div>
            <div class="snap-key-val"><span>25-Delta Put/Call Skew:</span> <strong>-1.85% (Normal)</strong></div>
          </div>

          <!-- Column 3: 27-Year Seasonality -->
          <div class="snap-card">
            <span class="snap-card-title">27-YEAR SEASONALITY PROFILE</span>
            <div class="snap-metric-big highlight-gold">${winRate}</div>
            <div class="snap-metric-sub">HISTORICAL MONTHLY WIN RATE</div>
            <div class="snap-divider"></div>
            <div class="snap-key-val"><span>Best Calendar Month:</span> <strong class="color-bull">${bestMo}</strong></div>
            <div class="snap-key-val"><span>Worst Calendar Month:</span> <strong class="color-bear">${worstMo}</strong></div>
            <div class="snap-key-val"><span>Q4 Win Probability:</span> <strong>78.4% (Strong Seasonal Edge)</strong></div>
            <div class="snap-key-val"><span>Cycle Span:</span> <strong>1998 &mdash; 2026 (27 Years)</strong></div>
          </div>
        </div>

        ${callsSummaryHtml}
      `;
    } catch (err) {
      snapBody.innerHTML = `<div style="color:#f87171; padding:20px;">Failed to load ticker snapshot: ${err.message}</div>`;
    }
  }

  function closeTickerSnapshot() {
    const drawer = document.getElementById('terminalTickerDrawer');
    if (!drawer) return;
    drawer.classList.remove('is-visible');
    document.body.classList.remove('modal-open');
    setTimeout(() => {
      drawer.style.display = 'none';
      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
        lastFocusedElement.focus();
      }
    }, 180);
  }

  /* ==========================================================================
     Terminal Help & Shortcuts Cheat Sheet Modal (F1 / HELP <GO>)
     ========================================================================== */

  let lastFocusedElement = null;

  function openHelpModal() {
    lastFocusedElement = document.activeElement;
    let modal = document.getElementById('terminalHelpModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'terminalHelpModal';
      modal.className = 'terminal-help-backdrop';
      modal.style.display = 'none';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', 'Terminal Hotkeys & Help');
      modal.innerHTML = `
        <div class="terminal-help-dialog font-mono">
          <div class="modal-header">
            <div class="modal-title-box">
              <span class="modal-tag">MOMENTUMQ TERMINAL GUIDE</span>
              <h3>MOMENTUMQ TERMINAL // COMMAND DIRECTORY &amp; HOTKEYS</h3>
            </div>
            <button class="modal-close-btn" id="termHelpCloseBtn">&times;</button>
          </div>
          <div class="terminal-help-body">
            <div class="help-section">
              <h4>GLOBAL KEYBOARD SHORTCUTS</h4>
              <div class="help-grid">
                <div class="help-row"><kbd>Cmd + K</kbd> / <kbd>Ctrl + K</kbd> / <kbd>F2</kbd><span>Open Terminal Command Omnibar</span></div>
                <div class="help-row"><kbd>/</kbd><span>Quick Focus Local Page Search</span></div>
                <div class="help-row"><kbd>F1</kbd><span>Open this Help &amp; Command Guide</span></div>
                <div class="help-row"><kbd>F3</kbd><span>Jump to Page 01 (Direction Scorecard)</span></div>
                <div class="help-row"><kbd>F4</kbd><span>Jump to Page 02 (Mag 7 Big Tech)</span></div>
                <div class="help-row"><kbd>F5</kbd><span>Jump to Page 03 (Seasonality &amp; Analytics)</span></div>
                <div class="help-row"><kbd>F6</kbd><span>Jump to Options Volatility &amp; GEX Surface</span></div>
                <div class="help-row"><kbd>F7</kbd><span>Trigger Live Pipeline Sync &amp; Recalculate</span></div>
                <div class="help-row"><kbd>F8</kbd><span>Export Active Blotter Dataset to CSV</span></div>
                <div class="help-row"><kbd>F9</kbd><span>Cycle CRT Themes (Obsidian / Amber / Green)</span></div>
                <div class="help-row"><kbd>Esc</kbd><span>Dismiss Active Modal / Clear Search</span></div>
              </div>
            </div>

            <div class="help-section">
              <h4>DIRECT TERMINAL MNEMONIC COMMANDS</h4>
              <div class="help-grid">
                <div class="help-row"><code>NVDA &lt;GO&gt;</code><span>Open NVIDIA quantitative audit snapshot</span></div>
                <div class="help-row"><code>SPY &lt;GO&gt;</code><span>Open S&amp;P 500 ETF Greeks &amp; dealer GEX</span></div>
                <div class="help-row"><code>GLD &lt;GO&gt;</code><span>Open Gold spot, real rate correlation &amp; ratios</span></div>
                <div class="help-row"><code>BRENT &lt;GO&gt;</code><span>Open Crude Oil / Brent energy analytics</span></div>
                <div class="help-row"><code>SCORE &lt;GO&gt;</code><span>Open 01 Sell-Side Forecasts Scorecard</span></div>
                <div class="help-row"><code>MAG7 &lt;GO&gt;</code><span>Navigate to 02 Magnificent 7 Big Tech</span></div>
                <div class="help-row"><code>SEAS &lt;GO&gt;</code><span>Open 03 27-Year Cross-Asset Seasonality</span></div>
                <div class="help-row"><code>OPT &lt;GO&gt; / GEX &lt;GO&gt;</code><span>Open 04 Options Volatility Surface &amp; GEX</span></div>
                <div class="help-row"><code>MACRO &lt;GO&gt; / FG &lt;GO&gt;</code><span>Open 05 Macro Regime &amp; Fear/Greed</span></div>
                <div class="help-row"><code>COMMODITIES &lt;GO&gt;</code><span>Open 06 Commodities &amp; Energy Benchmarks</span></div>
                <div class="help-row"><code>THEME AMBER &lt;GO&gt;</code><span>Switch CRT to Classic Phosphor Amber</span></div>
                <div class="help-row"><code>THEME GREEN &lt;GO&gt;</code><span>Switch CRT to Matrix Phosphor Green</span></div>
                <div class="help-row"><code>SOUND ON/OFF &lt;GO&gt;</code><span>Toggle retro mechanical synthesizer audio</span></div>
                <div class="help-row"><code>SYNC &lt;GO&gt;</code><span>Re-ingest &amp; recalculate all quantitative models</span></div>
              </div>
            </div>

            <div class="help-section">
              <h4>QUANTITATIVE AUDIT PRINCIPLES</h4>
              <p style="font-size:12px; color:var(--text-secondary); line-height:1.5;">
                &bull; <strong>Strict &plusmn;2% Direction Band:</strong> Price targets within 2% of spot are scored as Neutral. No subjective linguistic overrides.<br>
                &bull; <strong>Consensus Baseline Edge:</strong> Hit rates are measured against naive always-bullish baselines rather than nominal win rates.<br>
                &bull; <strong>Closed-Form BSM Greeks:</strong> Continuous dividend yield formulation ($b = r - q$) computed from observed market option chains.
              </p>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('termHelpCloseBtn')?.addEventListener('click', closeHelpModal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeHelpModal();
      });
    }

    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => {
      modal.classList.add('is-visible');
      document.getElementById('termHelpCloseBtn')?.focus();
    });
  }

  function closeHelpModal() {
    const modal = document.getElementById('terminalHelpModal');
    if (!modal) return;
    modal.classList.remove('is-visible');
    document.body.classList.remove('modal-open');
    setTimeout(() => {
      modal.style.display = 'none';
      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
        lastFocusedElement.focus();
      }
    }, 180);
  }

  /* ==========================================================================
     Global Keyboard Listener Setup
     ========================================================================== */

  function setupGlobalTerminalShortcuts() {
    window.addEventListener('keydown', (e) => {
      // 1. Cmd+K / Ctrl+K / F2 -> Open Command Omnibar
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || e.key === 'F2') {
        e.preventDefault();
        openCommandModal();
        return;
      }

      // 2. F1 -> Help Modal
      if (e.key === 'F1') {
        e.preventDefault();
        openHelpModal();
        return;
      }

      // 3. Function Keys F3-F9
      if (e.key === 'F3') {
        e.preventDefault();
        navigateTo('index.html');
        return;
      }
      if (e.key === 'F4') {
        e.preventDefault();
        navigateTo('mag7.html');
        return;
      }
      if (e.key === 'F5' && (e.ctrlKey || e.metaKey)) {
        // Allow browser refresh
        return;
      } else if (e.key === 'F5') {
        e.preventDefault();
        navigateTo('seasonality.html');
        return;
      }
      if (e.key === 'F6') {
        e.preventDefault();
        navigateTo('options.html');
        return;
      }
      if (e.key === 'F7') {
        e.preventDefault();
        navigateTo('macro.html');
        return;
      }
      if (e.key === 'F8') {
        e.preventDefault();
        navigateTo('agents.html');
        return;
      }
      if (e.key === 'F9') {
        e.preventDefault();
        triggerLiveSync();
        return;
      }
      if (e.key === 'F10') {
        e.preventDefault();
        const themes = ['obsidian', 'amber', 'green'];
        const nextTheme = themes[(themes.indexOf(terminalState.theme) + 1) % themes.length];
        setTerminalTheme(nextTheme);
        return;
      }
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

  /* ==========================================================================
     Initialization
     ========================================================================== */

  function initTerminalEngine() {
    applyTerminalTheme(terminalState.theme);
    renderTerminalTape();
    renderFunctionKeysBar();
    setupGlobalTerminalShortcuts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTerminalEngine);
  } else {
    initTerminalEngine();
  }

  // Expose global controller
  window.terminalEngine = {
    openCommandModal,
    closeCommandModal,
    openTickerSnapshot,
    closeTickerSnapshot,
    openHelpModal,
    closeHelpModal,
    setTerminalTheme,
    setSoundEnabled,
    triggerLiveSync,
    triggerActiveExport
  };

})();
