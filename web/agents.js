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
     Reports Archive Table
     ========================================================================== */

  function renderReportsArchiveTable() {
    const tbody = document.getElementById('agentReportsTbody');
    if (!tbody) return;

    if (agentState.reportsArchive.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding:24px; color:var(--text-muted);">No archived dossiers generated in this session.</td></tr>`;
      return;
    }

    tbody.innerHTML = agentState.reportsArchive.map((rep, idx) => {
      const d = new Date(rep.timestamp);
      const timeStr = d.toISOString().replace('T', ' ').substring(0, 19);
      const modeLabel = rep.mode && rep.mode.includes('live') ? 'GEMINI LIVE' : 'SYNTHESIS';
      const modeClass = rep.mode && rep.mode.includes('live') ? 'verdict-pill hit' : 'verdict-pill too_early';

      return `
        <tr>
          <td class="font-mono text-muted" style="font-size:11px;">${timeStr}</td>
          <td><span class="ticker-pill font-mono">${rep.type.toUpperCase().replace(/_/g, ' ')}</span></td>
          <td><strong>${escapeHtml(rep.title)}</strong></td>
          <td class="text-center"><span class="${modeClass}">${modeLabel}</span></td>
          <td class="text-center">
            <button class="btn btn-secondary load-report-btn" data-idx="${idx}" style="padding:4px 8px; font-size:10px;">VIEW</button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.load-report-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx, 10);
        const rep = agentState.reportsArchive[idx];
        if (rep) {
          agentState.activeReport = rep;
          updateDossierDisplay(rep.content, rep.title, rep.timestamp, 'gemini-3.7-flash', rep.mode);
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
  }

  /* ==========================================================================
     Initialization
     ========================================================================== */

  function initAgentsApp() {
    setupAgentEventListeners();
    refreshAgentStatus();
    renderReportsArchiveTable();
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
