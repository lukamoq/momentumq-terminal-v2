/**
 * Autonomous Quantitative Agents Controller (agents.js)
 * Gemini 3.7 Flash autonomous multi-agent quantitative synthesis,
 * weekly dossiers, strategic briefs, and interactive research terminal.
 */

(function () {
  'use strict';

  const agentState = {
    apiKey: localStorage.getItem('gemini_api_key') || '',
    activeType: 'eow_dossier',
    activeReport: null,
    reportsArchive: JSON.parse(localStorage.getItem('mq_agent_reports') || '[]'),
    viewMode: 'rendered', // 'rendered' | 'raw'
    isLoading: false,
  };

  async function safeFetchJson(url, options = {}) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[SafeFetch Agents] Failed on ${url}:`, err);
      return null;
    }
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

  function parseInlineFormatting(str) {
    let s = escapeHtml(str);
    s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.*?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code class="font-mono">$1</code>');
    return s;
  }

  function renderMarkdownHtml(md) {
    if (!md) return '';
    const lines = md.split('\n');
    const html = [];
    let inList = false;

    for (let rawLine of lines) {
      const line = rawLine.trimEnd();

      if (line.startsWith('# ')) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<h1>${escapeHtml(line.substring(2))}</h1>`);
      } else if (line.startsWith('## ')) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<h2>${escapeHtml(line.substring(3))}</h2>`);
      } else if (line.startsWith('### ')) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<h3>${escapeHtml(line.substring(4))}</h3>`);
      } else if (line.startsWith('#### ')) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<h4>${escapeHtml(line.substring(5))}</h4>`);
      } else if (line.startsWith('---')) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push('<hr>');
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        if (!inList) { html.push('<ul>'); inList = true; }
        html.push(`<li>${parseInlineFormatting(line.substring(2))}</li>`);
      } else if (line.startsWith('> ')) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<blockquote>${parseInlineFormatting(line.substring(2))}</blockquote>`);
      } else if (line.trim() === '') {
        if (inList) { html.push('</ul>'); inList = false; }
      } else {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<p>${parseInlineFormatting(line)}</p>`);
      }
    }
    if (inList) html.push('</ul>');
    return html.join('\n');
  }

  function updateDossierDisplay(content, title, timestamp, model, mode) {
    const renderedEl = document.getElementById('agentRenderedContainer');
    const rawEl = document.getElementById('agentRawContainer');
    const titleEl = document.getElementById('viewerReportTitle');
    const metaEl = document.getElementById('viewerReportMeta');

    if (renderedEl) renderedEl.innerHTML = renderMarkdownHtml(content);
    if (rawEl) rawEl.textContent = content;
    if (titleEl) titleEl.textContent = title || 'Quantitative Intelligence Dossier';
    if (metaEl) {
      const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'LIVE';
      metaEl.textContent = `GENERATED ${timeStr} // ${model ? model.toUpperCase() : 'GEMINI 3.7 FLASH'} // ${mode ? mode.toUpperCase() : 'OBSERVED TAPE'}`;
    }
  }

  /* ==========================================================================
     Agent Status & Key Binding
     ========================================================================== */

  async function refreshAgentStatus() {
    const statusData = await safeFetchJson('/api/agents/status');
    const bindStatusText = document.getElementById('bindKeyStatusText');
    const syncStatusText = document.getElementById('syncStatusText');
    const statusBadge = document.getElementById('agentStatusBadge');
    const tickerEngineMode = document.getElementById('tickerEngineMode');
    const tickerAgentModel = document.getElementById('tickerAgentModel');
    const hudEngineModel = document.getElementById('hudEngineModel');

    const isBound = Boolean(agentState.apiKey || (statusData && statusData.api_bound));

    if (bindStatusText) {
      bindStatusText.textContent = isBound ? 'KEY: GEMINI BOUND' : 'KEY: LOCAL ENGINE';
      bindStatusText.className = isBound ? 'font-mono color-bull' : 'font-mono text-muted';
    }

    if (syncStatusText) {
      syncStatusText.textContent = isBound ? 'API: GEMINI LIVE' : 'API: LOCAL SYNTHESIS';
    }

    if (tickerEngineMode) {
      tickerEngineMode.textContent = isBound ? 'GEMINI 3.7 FLASH LIVE' : 'QUANT SYNTHESIS';
      tickerEngineMode.className = `ticker-val ${isBound ? 'color-bull font-bold' : 'highlight-gold'}`;
    }

    if (tickerAgentModel) {
      tickerAgentModel.textContent = isBound ? 'GEMINI 3.7 FLASH' : 'GEMINI 3.7 (SYNTH)';
    }

    if (hudEngineModel) {
      hudEngineModel.textContent = isBound ? 'GEMINI 3.7 FLASH' : 'GEMINI 3.7 (SYNTH)';
    }

    if (statusBadge) {
      statusBadge.textContent = isBound
        ? 'Engine: Gemini 3.7 Flash (Live Active)'
        : 'Engine: Quantitative Synthesis (Offline)';
    }
  }

  /* ==========================================================================
     Report Generation Engine
     ========================================================================== */

  async function generateReport(reportType = 'eow_dossier', customQuery = null) {
    if (agentState.isLoading) return;
    agentState.isLoading = true;

    const submitBtn = document.getElementById('agentSubmitBtn');
    const submitBtnText = document.getElementById('agentSubmitBtnText');
    const renderedEl = document.getElementById('agentRenderedContainer');
    const rawEl = document.getElementById('agentRawContainer');

    if (submitBtn) submitBtn.classList.add('spinning');
    if (submitBtnText) submitBtnText.textContent = 'SYNTHESIZING...';
    if (renderedEl) renderedEl.innerHTML = '<div style="color:var(--text-muted); font-family:var(--font-mono); padding:20px 0;"><span class="sync-dot pulsing"></span> Ingesting observed SQLite market bars, macro regimes, and options GEX surfaces...<br>Synthesizing multi-agent quantitative brief with Gemini 3.7 Flash...</div>';
    if (rawEl) rawEl.textContent = 'Synthesizing quantitative brief with Gemini 3.7 Flash...';

    try {
      const res = await safeFetchJson('/api/agents/generate-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_type: reportType,
          user_query: customQuery,
          api_key: agentState.apiKey || null,
        }),
      });

      if (!res || !res.content) {
        throw new Error('Failed to generate agent report');
      }

      agentState.activeReport = res;
      updateDossierDisplay(res.content, res.report_title, res.generated_at, res.model, res.mode);

      // Add to local archive
      agentState.reportsArchive.unshift({
        id: 'rep_' + Date.now(),
        timestamp: res.generated_at,
        type: reportType,
        title: res.report_title || 'Quantitative Intelligence Dossier',
        mode: res.mode,
        content: res.content,
      });

      agentState.reportsArchive = agentState.reportsArchive.slice(0, 25);
      localStorage.setItem('mq_agent_reports', JSON.stringify(agentState.reportsArchive));

      renderReportsArchiveTable();
    } catch (err) {
      console.error('Agent synthesis failed:', err);
      if (renderedEl) renderedEl.innerHTML = `<div style="color:var(--color-bear); padding:20px 0;">Error generating report: ${escapeHtml(err.message)}</div>`;
    } finally {
      agentState.isLoading = false;
      if (submitBtn) submitBtn.classList.remove('spinning');
      if (submitBtnText) submitBtnText.textContent = 'RUN AGENT SYNTHESIS';
    }
  }

  /* ==========================================================================
     Reports & Market Wraps Store (SQLite Vault)
     ========================================================================== */

  async function renderReportsArchiveTable() {
    const tbody = document.getElementById('agentReportsTbody');
    if (!tbody) return;

    let dbWraps = [];
    try {
      const wrapsRes = await safeFetchJson('/api/news/market-wraps?limit=30');
      if (Array.isArray(wrapsRes)) {
        dbWraps = wrapsRes.map(w => ({
          id: w.id,
          timestamp: w.created_at || w.session_date,
          session_date: w.session_date,
          type: w.wrap_type || 'eod_news_wrap',
          title: w.title,
          verdict: w.session_verdict || 'BULLISH',
          confidence: w.confidence_pct || 85.0,
          mode: w.model_used || 'gemini-3.7-flash',
          content: w.report_markdown,
          isDb: true,
        }));
      }
    } catch (_) {}

    // Merge session reports with persistent DB wraps
    const sessionReports = (agentState.reportsArchive || []).map(r => ({
      id: r.id || `sess-${r.timestamp}`,
      timestamp: r.timestamp,
      session_date: r.timestamp ? r.timestamp.substring(0, 10) : '2026-08-20',
      type: r.type || 'eow_dossier',
      title: r.title,
      verdict: r.type.includes('eod') ? 'BULLISH' : 'CONSTRUCTIVE',
      confidence: 88.0,
      mode: r.mode || 'gemini-3.7-flash',
      content: r.content,
      isDb: false,
    }));

    // Deduplicate by title/date
    const combined = [...dbWraps];
    for (let s of sessionReports) {
      if (!combined.some(c => c.title === s.title)) {
        combined.push(s);
      }
    }

    if (combined.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding:24px; color:var(--text-muted);">No archived dossiers or market wraps found in database store.</td></tr>`;
      return;
    }

    tbody.innerHTML = combined.map((rep, idx) => {
      const timeStr = rep.session_date || (rep.timestamp ? rep.timestamp.substring(0, 10) : '\u2014');
      const modeLabel = rep.mode && (rep.mode.includes('live') || rep.mode.includes('gemini')) ? 'GEMINI FLASH' : 'LOCAL ENGINE';
      const modeClass = rep.mode && (rep.mode.includes('live') || rep.mode.includes('gemini')) ? 'verdict-pill hit' : 'verdict-pill too_early';

      let verdictClass = 'verdict-pill hit';
      if (rep.verdict.includes('BEAR')) verdictClass = 'verdict-pill miss';
      else if (rep.verdict.includes('NEUTRAL')) verdictClass = 'verdict-pill too_early';

      return `
        <tr class="interactive-call-row">
          <td class="font-mono text-muted" style="font-size:11px;">
            <strong>${timeStr}</strong>
            ${rep.isDb ? '<span class="status-badge live" style="font-size:9px; margin-left:4px; padding:1px 4px;">SQLITE</span>' : ''}
          </td>
          <td><span class="ticker-pill font-mono">${rep.type.toUpperCase().replace(/_/g, ' ')}</span></td>
          <td><strong style="color:var(--text-primary); font-size:12.5px;">${escapeHtml(rep.title)}</strong></td>
          <td class="text-center">
            <span class="${verdictClass}" style="font-size:11px; padding:3px 8px; font-weight:700;">
              ${rep.verdict}
            </span>
          </td>
          <td class="text-center font-mono font-bold highlight-gold">${Number(rep.confidence).toFixed(1)}%</td>
          <td class="text-center"><span class="${modeClass}">${modeLabel}</span></td>
          <td class="text-center">
            <button class="btn btn-secondary load-report-btn" data-idx="${idx}" style="padding:4px 10px; font-size:10.5px; font-family:var(--font-mono);">
              LOAD DOSSIER
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.load-report-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const rep = combined[idx];
        if (rep) {
          agentState.activeReport = rep;
          updateDossierDisplay(rep.content, rep.title, rep.timestamp, rep.mode, rep.mode);
          document.getElementById('secReportViewer')?.scrollIntoView({ behavior: 'smooth' });
        }
      });
    });
  }

  /* ==========================================================================
     Event Listeners Setup
     ========================================================================== */

  function setupAgentEventListeners() {
    // View mode toggle (Rendered vs Raw)
    const viewRenderedBtn = document.getElementById('viewModeRenderedBtn');
    const viewRawBtn = document.getElementById('viewModeRawBtn');
    const renderedContainer = document.getElementById('agentRenderedContainer');
    const rawContainer = document.getElementById('agentRawContainer');

    viewRenderedBtn?.addEventListener('click', () => {
      viewRenderedBtn.classList.add('active');
      viewRawBtn?.classList.remove('active');
      if (renderedContainer) renderedContainer.style.display = 'block';
      if (rawContainer) rawContainer.style.display = 'none';
      agentState.viewMode = 'rendered';
    });

    viewRawBtn?.addEventListener('click', () => {
      viewRawBtn.classList.add('active');
      viewRenderedBtn?.classList.remove('active');
      if (renderedContainer) renderedContainer.style.display = 'none';
      if (rawContainer) rawContainer.style.display = 'block';
      agentState.viewMode = 'raw';
    });

    // Quick report pills
    const pills = document.getElementById('reportTemplatePills');
    if (pills) {
      pills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        pills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        agentState.activeType = btn.dataset.type || 'eow_dossier';
        generateReport(agentState.activeType);
      });
    }

    // Node query buttons
    document.querySelectorAll('.agent-query-node-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.query;
        const promptInput = document.getElementById('agentPromptInput');
        if (promptInput && q) {
          promptInput.value = q;
          generateReport('custom_inquiry', q);
        }
      });
    });

    // Suggestion chips
    const promptInput = document.getElementById('agentPromptInput');
    document.querySelectorAll('.agent-chip-btn').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.dataset.query;
        if (promptInput && q) {
          promptInput.value = q;
          generateReport('custom_inquiry', q);
        }
      });
    });

    // Custom query submit
    const submitBtn = document.getElementById('agentSubmitBtn');
    const handleCustomQuery = () => {
      const q = (promptInput?.value || '').trim();
      if (!q) {
        generateReport(agentState.activeType);
      } else {
        generateReport('custom_inquiry', q);
      }
    };

    submitBtn?.addEventListener('click', handleCustomQuery);
    promptInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleCustomQuery();
    });

    // Copy report
    document.getElementById('copyReportBtn')?.addEventListener('click', () => {
      const content = agentState.activeReport ? agentState.activeReport.content : (document.getElementById('agentRawContainer')?.textContent || '');
      if (!content) return;
      navigator.clipboard.writeText(content).then(() => {
        const btn = document.getElementById('copyReportBtn');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = 'COPIED TO CLIPBOARD';
          setTimeout(() => { btn.textContent = orig; }, 1800);
        }
      });
    });

    // Export report (.md)
    document.getElementById('exportReportBtn')?.addEventListener('click', () => {
      const content = agentState.activeReport ? agentState.activeReport.content : (document.getElementById('agentRawContainer')?.textContent || '');
      if (!content) return;
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `MoQ_Dossier_${new Date().toISOString().substring(0, 10)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    // News Sentiment Category Pills
    const newsCatPills = document.getElementById('newsCategoryPills');
    if (newsCatPills) {
      newsCatPills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        newsCatPills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        newsState.categoryFilter = btn.dataset.cat || 'all';
        fetchNewsFeed();
      });
    }

    // News Sentiment Stance Pills
    const newsStancePills = document.getElementById('newsStancePills');
    if (newsStancePills) {
      newsStancePills.addEventListener('click', (e) => {
        const btn = e.target.closest('.curve-span-pill');
        if (!btn) return;
        newsStancePills.querySelectorAll('.curve-span-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        newsState.stanceFilter = btn.dataset.stance || 'all';
        renderNewsFeedTable();
      });
    }

    // Custom Headline Analyzer
    const analyzeBtn = document.getElementById('analyzeHeadlineBtn');
    const headlineInput = document.getElementById('customHeadlineInput');
    if (analyzeBtn && headlineInput) {
      analyzeBtn.addEventListener('click', () => {
        analyzeCustomHeadline();
      });
      headlineInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          analyzeCustomHeadline();
        }
      });
    }

    // API Key Modal
    const apiKeyModal = document.getElementById('apiKeyModal');
    const apiKeyInput = document.getElementById('modalApiKeyInput');

    document.getElementById('bindApiKeyBtn')?.addEventListener('click', () => {
      if (apiKeyInput) apiKeyInput.value = agentState.apiKey || '';
      if (apiKeyModal) apiKeyModal.style.display = 'flex';
      apiKeyInput?.focus();
    });

    document.getElementById('apiKeyModalCloseBtn')?.addEventListener('click', () => {
      if (apiKeyModal) apiKeyModal.style.display = 'none';
    });

    document.getElementById('saveApiKeyBtn')?.addEventListener('click', () => {
      const key = (apiKeyInput?.value || '').trim();
      agentState.apiKey = key;
      if (key) {
        localStorage.setItem('gemini_api_key', key);
      } else {
        localStorage.removeItem('gemini_api_key');
      }
      if (apiKeyModal) apiKeyModal.style.display = 'none';
      refreshAgentStatus();
    });

    document.getElementById('clearApiKeyBtn')?.addEventListener('click', () => {
      agentState.apiKey = '';
      localStorage.removeItem('gemini_api_key');
      if (apiKeyInput) apiKeyInput.value = '';
      if (apiKeyModal) apiKeyModal.style.display = 'none';
      refreshAgentStatus();
    });

    // Generate EOD Market Wrap Button
    document.getElementById('generateEodWrapBtn')?.addEventListener('click', async () => {
      const btnText = document.getElementById('eodWrapBtnText');
      if (btnText) btnText.textContent = 'SYNTHESIZING EOD BATCH...';

      try {
        const res = await fetch('/api/news/eod-wrap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: agentState.apiKey || undefined })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Update Dossier Viewer with EOD Wrap
        const title = `End-of-Day Market News & Sentiment Synthesis (${data.session_date})`;
        const item = {
          id: `eod-${Date.now()}`,
          timestamp: new Date().toISOString(),
          type: 'eod_news_wrap',
          title: title,
          model: 'gemini-3.7-flash',
          mode: data.mode,
          content: data.report_markdown
        };

        agentState.activeReport = item;
        agentState.reportsArchive.unshift(item);
        if (agentState.reportsArchive.length > 20) agentState.reportsArchive.pop();
        localStorage.setItem('mq_agent_reports', JSON.stringify(agentState.reportsArchive));

        updateDossierDisplay(item.content, item.title, item.timestamp, item.model, item.mode);
        renderReportsArchiveTable();

        // Scroll to viewer
        document.getElementById('secReportViewer')?.scrollIntoView({ behavior: 'smooth' });
      } catch (err) {
        console.error('Failed to generate EOD wrap:', err);
      } finally {
        if (btnText) btnText.innerHTML = '&#9889; GENERATE EOD MARKET WRAP';
      }
    });
  }

  /* ==========================================================================
     Section 06: Live News Feed & Bull/Bear Classifier Logic
     ========================================================================== */

  const newsState = {
    feed: [],
    barometer: null,
    categoryFilter: 'all',
    stanceFilter: 'all',
  };

  async function fetchNewsFeed() {
    const tbody = document.getElementById('newsFeedTbody');
    if (!tbody) return;

    try {
      const url = `/api/news/feed?category=${encodeURIComponent(newsState.categoryFilter)}`;
      const data = await safeFetchJson(url);
      if (!data) return;

      newsState.feed = data.feed || [];
      newsState.barometer = data.barometer || {};

      renderNewsBarometer();
      renderNewsFeedTable();
    } catch (err) {
      console.error('Failed to load news feed:', err);
    }
  }

  function renderNewsBarometer() {
    const b = newsState.barometer;
    if (!b) return;

    const bullEl = document.getElementById('newsBullPct');
    const stanceEl = document.getElementById('newsNetStance');
    const barEl = document.getElementById('newsBarometerBar');
    const bearLabel = document.getElementById('newsBearPctLabel');
    const neutLabel = document.getElementById('newsNeutralPctLabel');
    const bullLabel = document.getElementById('newsBullPctLabel');
    const narrative = document.getElementById('newsBarometerNarrative');

    if (bullEl) bullEl.textContent = `${b.bullish_pct}%`;
    if (stanceEl) {
      stanceEl.textContent = b.net_stance || 'BULLISH';
      stanceEl.className = `fg-hero-label font-mono ${b.net_score >= 0.2 ? 'color-bull' : (b.net_score <= -0.2 ? 'color-bear' : 'highlight-gold')}`;
    }
    if (barEl) {
      barEl.style.width = `${b.bullish_pct}%`;
      barEl.style.background = b.net_score >= 0.2 ? '#34d399' : (b.net_score <= -0.2 ? '#f87171' : '#fbbf24');
    }
    if (bearLabel) bearLabel.textContent = `${b.bearish_pct}% BEARISH`;
    if (neutLabel) neutLabel.textContent = `${b.neutral_pct}% NEUTRAL`;
    if (bullLabel) bullLabel.textContent = `${b.bullish_pct}% BULLISH`;

    if (narrative) {
      narrative.textContent = `Aggregated multi-agent order flow score: ${b.net_score >= 0 ? '+' : ''}${b.net_score} (${b.net_stance}). Monitored ${b.total_items_analyzed} breaking market wire events with velocity status: ${b.velocity}.`;
    }
  }

  function renderNewsFeedTable() {
    const tbody = document.getElementById('newsFeedTbody');
    if (!tbody) return;

    let items = newsState.feed;
    if (newsState.stanceFilter !== 'all') {
      items = items.filter(i => i.sentiment === newsState.stanceFilter);
    }

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted font-mono" style="padding:24px;">No breaking news items found for selected filter criteria.</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(item => {
      let badgeClass = 'verdict-pill hit';
      let badgeColor = 'color-bull';
      if (item.sentiment === 'BEARISH') {
        badgeClass = 'verdict-pill miss';
        badgeColor = 'color-bear';
      } else if (item.sentiment === 'NEUTRAL') {
        badgeClass = 'verdict-pill too_early';
        badgeColor = 'text-muted';
      }

      const tickerPills = (item.tickers || []).map(t => `<span class="ticker-pill font-mono" style="font-size:10px; margin-right:3px;">${t}</span>`).join('');
      const timeStr = item.timestamp ? item.timestamp.replace('T', ' ').substring(5, 16) : '\u2014';

      return `
        <tr class="interactive-call-row">
          <td>
            <div class="font-mono font-bold" style="font-size:11px;">${timeStr} UTC</div>
            <div style="font-size:10px; color:var(--text-muted);">${escapeHtml(item.source)}</div>
          </td>
          <td>
            <span class="badge-stance neutral" style="font-size:10px;">${escapeHtml(item.category)}</span>
          </td>
          <td>
            <strong style="color:var(--text-primary); font-size:12.5px; display:block; margin-bottom:3px;">${escapeHtml(item.headline)}</strong>
            <span style="font-size:11px; color:var(--text-muted); line-height:1.4; display:block;">${escapeHtml(item.summary)}</span>
          </td>
          <td class="text-center">${tickerPills || '<span class="text-muted">\u2014</span>'}</td>
          <td class="text-center">
            <span class="${badgeClass}" style="font-size:11px; padding:3px 8px; font-weight:700;">
              ${item.sentiment}
            </span>
            <div class="font-mono ${badgeColor}" style="font-size:10px; margin-top:2px;">${item.confidence_pct}% CONF</div>
          </td>
          <td class="text-center font-mono" style="font-size:10.5px; color:var(--text-secondary);">
            ${item.impact_horizon.replace('_', ' ')}
          </td>
          <td>
            <div style="font-size:11px; color:var(--text-secondary); line-height:1.4;">
              ${escapeHtml(item.agent_thesis || item.catalysts[0] || 'Quantitative flow analysis')}
            </div>
            <div style="font-size:9.5px; color:var(--text-dim); margin-top:2px; font-family:var(--font-mono);">
              EVALUATED BY: ${escapeHtml(item.evaluated_by)}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function analyzeCustomHeadline() {
    const input = document.getElementById('customHeadlineInput');
    const resultBox = document.getElementById('customHeadlineResultBox');
    const btnText = document.getElementById('analyzeHeadlineBtnText');
    if (!input || !resultBox) return;

    const headline = input.value.trim();
    if (!headline) return;

    if (btnText) btnText.textContent = 'AGENT REASONING...';

    try {
      const res = await fetch('/api/news/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headline: headline,
          summary: headline,
          api_key: agentState.apiKey || undefined
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      let badgeClass = 'verdict-pill hit';
      let badgeColor = '#34d399';
      if (data.sentiment === 'BEARISH') {
        badgeClass = 'verdict-pill miss';
        badgeColor = '#f87171';
      } else if (data.sentiment === 'NEUTRAL') {
        badgeClass = 'verdict-pill too_early';
        badgeColor = '#fbbf24';
      }

      resultBox.style.display = 'block';
      resultBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
          <div>
            <span class="card-kicker font-mono" style="color:${badgeColor};">AI AGENT CLASSIFICATION VERDICT</span>
            <div style="font-size:14px; font-weight:700; color:var(--text-primary); margin-top:2px;">
              ${escapeHtml(data.headline)}
            </div>
          </div>
          <div style="text-align:right;">
            <span class="${badgeClass}" style="font-size:12px; font-weight:800; padding:4px 10px;">
              ${data.sentiment}
            </span>
            <div class="font-mono font-bold" style="font-size:11px; color:${badgeColor}; margin-top:2px;">
              ${data.confidence_pct}% CONFIDENCE
            </div>
          </div>
        </div>
        <p style="font-size:12px; color:var(--text-secondary); margin-bottom:6px; line-height:1.4;">
          <strong>Thesis:</strong> ${escapeHtml(data.agent_thesis)}
        </p>
        <div style="display:flex; gap:12px; font-family:var(--font-mono); font-size:10.5px; color:var(--text-muted);">
          <span>Impact: <strong>${data.impact_horizon.replace('_', ' ')}</strong></span>
          <span>Assets: <strong>${(data.tickers || []).join(', ') || 'SPY'}</strong></span>
          <span>Engine: <strong>${escapeHtml(data.evaluated_by)}</strong></span>
        </div>
      `;
    } catch (err) {
      resultBox.style.display = 'block';
      resultBox.innerHTML = `<span style="color:#f87171; font-size:11px;">Failed to analyze custom headline: ${escapeHtml(err.message)}</span>`;
    } finally {
      if (btnText) btnText.textContent = 'CLASSIFY BULL / BEAR';
    }
  }

  /* ==========================================================================
     Initialization
     ========================================================================== */

  function initAgentsApp() {
    setupAgentEventListeners();
    refreshAgentStatus();
    renderReportsArchiveTable();
    fetchNewsFeed();
    if (agentState.reportsArchive.length === 0) {
      generateReport('eow_dossier');
    } else {
      const latest = agentState.reportsArchive[0];
      agentState.activeReport = latest;
      updateDossierDisplay(latest.content, latest.title, latest.timestamp, 'gemini-3.7-flash', latest.mode);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAgentsApp);
  } else {
    initAgentsApp();
  }

})();

