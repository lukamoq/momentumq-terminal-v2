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
    const topEowBtn = document.getElementById('generateEowTopBtn');
    const contentEl = document.getElementById('agentReportContent');
    const titleEl = document.getElementById('viewerReportTitle');
    const metaEl = document.getElementById('viewerReportMeta');

    if (submitBtn) submitBtn.classList.add('spinning');
    if (topEowBtn) topEowBtn.classList.add('spinning');
    if (submitBtnText) submitBtnText.textContent = 'SYNTHESIZING...';
    if (contentEl) contentEl.textContent = 'Ingesting observed SQLite market bars, macro regimes, and options GEX surfaces...\nSynthesizing multi-agent quantitative brief with Gemini 3.7 Flash...';

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

      if (contentEl) contentEl.textContent = res.content;
      if (titleEl) titleEl.textContent = res.report_title || 'Quantitative Intelligence Dossier';
      if (metaEl) {
        const genTime = new Date(res.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        metaEl.textContent = `GENERATED AT ${genTime} // ENGINE: ${res.model.toUpperCase()} // ${res.mode.toUpperCase()}`;
      }

      // Add to local archive
      agentState.reportsArchive.unshift({
        id: 'rep_' + Date.now(),
        timestamp: res.generated_at,
        type: reportType,
        title: res.report_title || 'Quantitative Intelligence Dossier',
        mode: res.mode,
        content: res.content,
      });

      // Keep last 25 reports
      agentState.reportsArchive = agentState.reportsArchive.slice(0, 25);
      localStorage.setItem('mq_agent_reports', JSON.stringify(agentState.reportsArchive));

      renderReportsArchiveTable();
    } catch (err) {
      console.error('Agent synthesis failed:', err);
      if (contentEl) contentEl.textContent = `Error generating report: ${err.message}`;
    } finally {
      agentState.isLoading = false;
      if (submitBtn) submitBtn.classList.remove('spinning');
      if (topEowBtn) topEowBtn.classList.remove('spinning');
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
          const contentEl = document.getElementById('agentReportContent');
          const titleEl = document.getElementById('viewerReportTitle');
          const metaEl = document.getElementById('viewerReportMeta');
          if (contentEl) contentEl.textContent = rep.content;
          if (titleEl) titleEl.textContent = rep.title;
          if (metaEl) metaEl.textContent = `ARCHIVED DOSSIER // GENERATED ${rep.timestamp}`;
          document.getElementById('secReportViewer')?.scrollIntoView({ behavior: 'smooth' });
        }
      });
    });
  }

  /* ==========================================================================
     Event Listeners Setup
     ========================================================================== */

  function setupAgentEventListeners() {
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

    // Top EOW button
    document.getElementById('generateEowTopBtn')?.addEventListener('click', () => {
      generateReport('eow_dossier');
    });

    // Custom query submit
    const promptInput = document.getElementById('agentPromptInput');
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
      const content = document.getElementById('agentReportContent')?.textContent || '';
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
      const content = document.getElementById('agentReportContent')?.textContent || '';
      if (!content) return;
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `MomentumQ_Dossier_${new Date().toISOString().substring(0, 10)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    // Suggestion chips
    document.querySelectorAll('.agent-chip-btn').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.dataset.query;
        if (promptInput && q) {
          promptInput.value = q;
          generateReport('custom_inquiry', q);
        }
      });
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
    // Auto-generate initial EOW report if none exists
    if (agentState.reportsArchive.length === 0) {
      generateReport('eow_dossier');
    } else {
      const latest = agentState.reportsArchive[0];
      agentState.activeReport = latest;
      const contentEl = document.getElementById('agentReportContent');
      const titleEl = document.getElementById('viewerReportTitle');
      const metaEl = document.getElementById('viewerReportMeta');
      if (contentEl) contentEl.textContent = latest.content;
      if (titleEl) titleEl.textContent = latest.title;
      if (metaEl) metaEl.textContent = `LATEST DOSSIER // GENERATED ${latest.timestamp}`;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAgentsApp);
  } else {
    initAgentsApp();
  }

})();
