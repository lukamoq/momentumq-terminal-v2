/**
 * Sell-Side Direction Scorecard — Web Application Logic
 * Concept: Dark Blotter, Swiss / Industrial aesthetics, zero bare hit rates.
 * Interactive Multi-Year Timeline with Touch Swipe, Mouse Drag, and Zoom Exploration.
 * Most Reliable Partner & Trust Matrix Module with Pure AI Stance Classifier.
 */

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Format a decimal fraction as a signed percentage, or an em dash when absent. */
function fmtPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '\u2014';
  const n = Number(value) * 100;
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

let state = {
  scorecard: [],
  timeline: null,
  calls: [],
  stats: null,
  partners: [],
  macro: { allocations: [], probabilities: [] },
  partnerRegime: 'overall',
  filter: 'all',
  sortBy: 'stance_day_edge',
  sortOrder: 'desc',
  callSearchQuery: '',
  callHorizonFilter: 'all',
  callsVisibleCount: 25,
  viewport: {
    fullMinDate: 0,
    fullMaxDate: 0,
    viewMinDate: 0,
    viewMaxDate: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartMinDate: 0,
    dragStartMaxDate: 0,
    isBrushDragging: false,
    brushStartX: 0,
  },
  STORAGE_KEY: 'mq_scorecard_last_daily_sync',
  lastSyncTime: null,
  isSyncing: false,
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
  setupEventListeners();
  initDailySyncEngine();
  initSectionRail();
});

async function initApp() {
  await fetchAppData(false);
}

async function triggerLiveRecalculate() {
  if (state.isSyncing) return;
  state.isSyncing = true;

  const syncBtn = document.getElementById('syncNowBtn');
  const syncTimeEl = document.getElementById('syncTimeText');
  const syncStatusEl = document.getElementById('syncStatusText');

  if (syncBtn) {
    syncBtn.classList.add('spinning');
    syncBtn.innerHTML = '&#8635; RECALCULATING...';
    syncBtn.disabled = true;
  }
  if (syncStatusEl) syncStatusEl.textContent = 'RUNNING QUANT PIPELINE...';
  if (syncTimeEl) syncTimeEl.textContent = 'Rebuilding scoring tables & models...';

  try {
    const syncRes = await fetch('/api/pipeline/sync', { method: 'POST' }).then(r => r.json());
    await fetchAppData(true);

    if (syncStatusEl) syncStatusEl.textContent = 'QUANT ENGINE SYNCED';
    if (syncTimeEl) {
      const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      syncTimeEl.innerHTML = `<span style="color: var(--accent-green); font-weight: 600;">✓ Recalculated at ${nowStr} (${syncRes.elapsed_ms || 12}ms)</span>`;
    }
  } catch (err) {
    console.error('Failed to trigger live recalculate:', err);
    if (syncTimeEl) syncTimeEl.textContent = 'Recalculation error. Check connection.';
  } finally {
    state.isSyncing = false;
    if (syncBtn) {
      syncBtn.classList.remove('spinning');
      syncBtn.innerHTML = '&#8635; SYNC NOW';
      syncBtn.disabled = false;
    }
  }
}

let lastFocusedElement = null;

async function safeFetchJson(url, fallback) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[SafeFetch] Failed to load ${url}:`, err);
    return fallback;
  }
}

async function fetchAppData(silent = false) {
  const syncBtn = document.getElementById('syncNowBtn');
  if (syncBtn && !silent) syncBtn.classList.add('spinning');

  try {
    const [statsRes, scorecardRes, timelineRes, callsRes, partnersRes, macroRes] = await Promise.all([
      safeFetchJson('/api/stats', {}),
      safeFetchJson('/api/scorecard', []),
      safeFetchJson('/api/timeline', { market_path: [], banks: [], institutions: [] }),
      safeFetchJson('/api/calls', []),
      safeFetchJson('/api/partners', []),
      safeFetchJson('/api/macro', { allocations: [], probabilities: [] }),
    ]);

    state.stats = statsRes;
    state.scorecard = scorecardRes;
    state.timeline = timelineRes;
    state.calls = callsRes;
    state.partners = partnersRes;
    state.macro = macroRes;
    
    const now = new Date();
    state.lastSyncTime = now;
    try {
      localStorage.setItem(state.STORAGE_KEY, now.toISOString());
    } catch (_) {}

    if (!state.viewport.fullMinDate && state.timeline && state.timeline.market_path?.length) {
      initTimelineViewport();
    }

    updateHeaderTicker();
    renderFindings();
    renderTimeline();
    renderScorecard();
    renderPartnersSection();
    renderMacroSection();
    renderCallsTable();
    updateSyncStatusUI();
  } catch (err) {
    console.error('Failed to fetch scorecard data:', err);
    const syncTimeEl = document.getElementById('syncTimeText');
    if (syncTimeEl) syncTimeEl.textContent = 'Sync error (will retry at 12:00 PM)';
  } finally {
    if (syncBtn && !silent) syncBtn.classList.remove('spinning');
  }
}

/* ==========================================================================
   Daily 12:00 PM Auto-Refresh Scheduler & Persistent Storage
   ========================================================================== */

function initDailySyncEngine() {
  // Check if we missed a 12:00 PM sync since last open
  checkAndTriggerDailySync();

  // Run periodic check every 60 seconds
  setInterval(checkAndTriggerDailySync, 60000);

  // Schedule exact precision timeout for the upcoming 12:00:00 PM
  scheduleNextNoonTimer();
}

function checkAndTriggerDailySync() {
  const now = new Date();
  let lastSyncIso = null;
  try {
    lastSyncIso = localStorage.getItem(state.STORAGE_KEY);
  } catch (_) {}

  const lastSyncDate = lastSyncIso ? new Date(lastSyncIso) : null;
  const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);

  // If current time is past 12:00 PM today AND (no record of sync OR last sync occurred before today 12:00 PM)
  if (now >= todayNoon) {
    if (!lastSyncDate || lastSyncDate < todayNoon) {
      console.log('[Scorecard Daily Sync] Past 12:00 PM today without daily sync. Refreshing now...');
      fetchAppData(true);
      return;
    }
  }

  updateSyncStatusUI();
}

function scheduleNextNoonTimer() {
  const now = new Date();
  let nextNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  
  // If 12:00 PM today has already passed, schedule for tomorrow 12:00 PM
  if (now >= nextNoon) {
    nextNoon.setDate(nextNoon.getDate() + 1);
  }

  const msUntilNoon = nextNoon.getTime() - now.getTime();
  console.log(`[Scorecard Daily Sync] Next scheduled refresh in ${(msUntilNoon / (1000 * 60 * 60)).toFixed(2)} hours (at ${nextNoon.toLocaleString()})`);

  setTimeout(() => {
    console.log('[Scorecard Daily Sync] 12:00 PM reached. Executing scheduled daily refresh...');
    fetchAppData(true);
    scheduleNextNoonTimer();
  }, msUntilNoon);
}

function updateSyncStatusUI() {
  const syncTimeEl = document.getElementById('syncTimeText');
  if (!syncTimeEl) return;

  let lastSyncIso = null;
  try {
    lastSyncIso = localStorage.getItem(state.STORAGE_KEY);
  } catch (_) {}

  const lastDate = lastSyncIso ? new Date(lastSyncIso) : (state.lastSyncTime || new Date());
  const now = new Date();
  const isToday = lastDate.toDateString() === now.toDateString();

  const timePart = lastDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) {
    syncTimeEl.textContent = `Last refreshed: Today @ ${timePart}`;
  } else {
    const datePart = lastDate.toISOString().split('T')[0];
    syncTimeEl.textContent = `Last refreshed: ${datePart} ${timePart}`;
  }
}

function initTimelineViewport() {
  if (!state.timeline || !state.timeline.market_path.length) return;
  const market = state.timeline.market_path;
  const firstDate = new Date(market[0].date).getTime();
  const lastDate = new Date(market[market.length - 1].date).getTime() + (86400000 * 2);

  state.viewport.fullMinDate = firstDate;
  state.viewport.fullMaxDate = lastDate;
  state.viewport.viewMinDate = firstDate;
  state.viewport.viewMaxDate = lastDate;
}

function setupEventListeners() {
  // Scorecard filter tabs
  document.querySelectorAll('.tab-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn[data-filter]').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.filter = e.target.dataset.filter;
      renderScorecard();
    });
  });

  // Partner Regime Tabs
  document.querySelectorAll('#partnerRegimeTabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#partnerRegimeTabs .tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.partnerRegime = e.target.dataset.regime;
      renderPartnersSection();
    });
  });

  // Scorecard table sorting with keyboard accessibility
  const scorecardHeaders = document.querySelectorAll('#scorecardTable th.sortable');
  scorecardHeaders.forEach(th => {
    const triggerSort = () => {
      const sortField = th.dataset.sort;
      if (state.sortBy === sortField) {
        state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortBy = sortField;
        state.sortOrder = 'desc';
      }
      renderScorecard();
    };

    th.addEventListener('click', triggerSort);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerSort();
      }
    });
  });

  // Export Scorecard CSV
  const exportScorecardBtn = document.getElementById('exportScorecardCsvBtn');
  if (exportScorecardBtn) {
    exportScorecardBtn.addEventListener('click', () => {
      if (!state.scorecard || !state.scorecard.length) return;
      let csv = 'DESK,STANCE,TARGET_SPX,HIT_RATE,BASELINE,EDGE,LAG_RATIO,RESOLVED_CALLS\r\n';
      state.scorecard.forEach(r => {
        const row = [
          `"${r.name || ''}"`,
          r.current_stance || '',
          r.target_price || '',
          (r.stance_day_hit_rate !== null ? (r.stance_day_hit_rate * 100).toFixed(1) + '%' : ''),
          (r.always_bullish_baseline !== null ? (r.always_bullish_baseline * 100).toFixed(1) + '%' : ''),
          (r.stance_day_edge !== null ? (r.stance_day_edge * 100).toFixed(1) + '%' : ''),
          (r.lag_ratio !== null ? r.lag_ratio.toFixed(2) : ''),
          r.stance_day_count || 0
        ];
        csv += row.join(',') + '\r\n';
      });
      const encodedUri = encodeURI('data:text/csv;charset=utf-8,' + csv);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `MomentumQ_SP500_Scorecard_${new Date().toISOString().slice(0,10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }

  // Calls Log Search & Clear Button
  const searchInput = document.getElementById('callsSearchInput');
  const clearBtn = document.getElementById('callsSearchClearBtn');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.callSearchQuery = e.target.value.toLowerCase().trim();
      state.callsVisibleCount = 25;
      if (clearBtn) {
        clearBtn.classList.toggle('is-active', state.callSearchQuery.length > 0);
      }
      renderCallsTable();
    });
  }

  if (clearBtn && searchInput) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      state.callSearchQuery = '';
      clearBtn.classList.remove('is-active');
      renderCallsTable();
      searchInput.focus();
    });
  }

  document.querySelectorAll('#horizonFilterPills .pill-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#horizonFilterPills .pill-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.callHorizonFilter = e.target.dataset.horizon;
      state.callsVisibleCount = 25;
      renderCallsTable();
    });
  });

  // Range Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      setTimelineRangePreset(e.target.dataset.range);
    });
  });

  // Pan & Zoom Navigation Buttons
  document.getElementById('panLeftBtn')?.addEventListener('click', () => panTimeline(-0.25));
  document.getElementById('panRightBtn')?.addEventListener('click', () => panTimeline(0.25));
  document.getElementById('zoomInBtn')?.addEventListener('click', () => zoomTimeline(0.75));
  document.getElementById('zoomOutBtn')?.addEventListener('click', () => zoomTimeline(1.33));
  document.getElementById('panResetBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('rangeAll')?.classList.add('active');
    setTimelineRangePreset('all');
  });

  // Interactive Timeline Container Events (Mouse Drag & Touch Swipe)
  const container = document.getElementById('timelineContainer');
  if (container) {
    container.addEventListener('pointerdown', handleTimelinePointerDown);
    window.addEventListener('pointermove', handleTimelinePointerMove);
    window.addEventListener('pointerup', handleTimelinePointerUp);
    window.addEventListener('pointercancel', handleTimelinePointerUp);

    // Trackpad horizontal swipe & wheel zoom
    container.addEventListener('wheel', handleTimelineWheel, { passive: false });
    container.addEventListener('mouseleave', () => {
      const crosshair = document.getElementById('timelineCrosshair');
      const tooltip = document.getElementById('timelineTooltip');
      if (crosshair) crosshair.style.display = 'none';
      if (tooltip) tooltip.style.display = 'none';
    });
  }

  // Mini-map click & drag
  const minimapCanvas = document.getElementById('minimapContainer');
  if (minimapCanvas) {
    minimapCanvas.addEventListener('click', handleMinimapClick);
  }

  // Live Sync Now Button
  document.getElementById('syncNowBtn')?.addEventListener('click', () => {
    triggerLiveRecalculate();
  });

  // Floating Back to Top Button
  const backToTopBtn = document.getElementById('backToTopBtn');
  if (backToTopBtn) {
    window.addEventListener('scroll', () => {
      if (window.scrollY > 400) {
        backToTopBtn.classList.add('visible');
      } else {
        backToTopBtn.classList.remove('visible');
      }
    });
    backToTopBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Global Keyboard Navigation Shortcuts
  window.addEventListener('keydown', (e) => {
    // Press '/' anywhere outside input to focus search
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
      return;
    }

    // If typing in search box, handle Escape
    if (document.activeElement?.tagName === 'INPUT') {
      if (e.key === 'Escape') {
        if (searchInput && searchInput.value) {
          searchInput.value = '';
          state.callSearchQuery = '';
          if (clearBtn) clearBtn.classList.remove('is-active');
          renderCallsTable();
        }
        document.activeElement.blur();
      }
      return;
    }

    if (e.key === 'Escape') {
      closeModal();
    } else if (e.key === 'ArrowLeft') {
      panTimeline(-0.15);
    } else if (e.key === 'ArrowRight') {
      panTimeline(0.15);
    } else if (e.key === '+' || e.key === '=') {
      zoomTimeline(0.8);
    } else if (e.key === '-' || e.key === '_') {
      zoomTimeline(1.25);
    } else if (e.key === '0') {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('rangeAll')?.classList.add('active');
      setTimelineRangePreset('all');
    }
  });

  // Call log pagination
  document.getElementById('callsLoadMoreBtn')?.addEventListener('click', () => {
    state.callsVisibleCount += 25;
    renderCallsTable();
  });

  // Modal close
  document.getElementById('modalCloseBtn')?.addEventListener('click', closeModal);
  document.getElementById('modalBackdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'modalBackdrop') closeModal();
  });
}

function updateHeaderTicker() {
  if (!state.stats || !state.timeline) return;
  const market = state.timeline.market_path;
  if (market && market.length > 0) {
    const latest = market[market.length - 1];
    const first2026 = market.find(m => m.date >= '2026-01-01') || market[0];
    const ytd = ((latest.index_level / first2026.index_level) - 1.0) * 100;

    document.getElementById('tickerSpx').textContent = Number(latest.index_level).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('tickerYtd').textContent = `${ytd >= 0 ? '+' : ''}${ytd.toFixed(1)}%`;
  }
  document.getElementById('tickerDesks').textContent = state.stats.total_institutions || '10';
  document.getElementById('tickerObs').textContent = (state.stats.direction_stance_day_evaluations || 43000).toLocaleString() + '+';
}

/* ==========================================================================
   Section 01: Findings
   The page's result, computed from the same rows the evidence sections show.
   Nothing here is hardcoded — if the data changes, the claim changes.
   ========================================================================== */

function renderFindings() {
  const grid = document.getElementById('findingsGrid');
  if (!grid || !state.scorecard.length) return;

  const desks = state.scorecard;
  // Only desks that actually publish index targets belong in a direction tally.
  const directionDesks = desks.filter(d => d.total_calls > 0);
  const rated = directionDesks.filter(d => d.stance_day_edge !== null && d.stance_day_edge !== undefined);
  const permabulls = directionDesks.filter(d => d.is_always_bullish === 1);

  const beatBaseline = rated.filter(d => d.stance_day_edge > 0.0005);
  const best = rated.slice().sort((a, b) => b.stance_day_edge - a.stance_day_edge)[0];
  const worst = rated.slice().sort((a, b) => a.stance_day_edge - b.stance_day_edge)[0];

  const flips = (state.timeline && state.timeline.flips) || [];
  const resolvedFlips = flips.filter(f => f.is_resolved === 1 && f.lag_ratio !== null);
  const fastest = resolvedFlips.slice().sort((a, b) => a.lag_ratio - b.lag_ratio)[0];
  const deskName = id => (desks.find(d => d.institution_id === id) || {}).institution_name || id;

  const evals = (state.stats && state.stats.direction_stance_day_evaluations) || 0;

  const cards = [
    {
      value: `${beatBaseline.length}<span class="fv-den"> / ${rated.length}</span>`,
      tone: beatBaseline.length ? 'is-accent' : '',
      claim: 'desks beat an always-bullish baseline over the same windows.',
      evidence: best
        ? `Best on record is <strong>${escapeHtml(best.institution_name)}</strong> at ${fmtPct(best.stance_day_edge, 1)} edge, measured across ${evals.toLocaleString()} stance-days.`
        : 'No desk has a resolved stance-day window yet.',
    },
    {
      value: fmtPct(worst ? worst.stance_day_edge : null, 1),
      tone: 'is-bearish',
      claim: 'worst stance-day edge — the cost of taking a non-consensus view and being wrong.',
      evidence: worst
        ? `<strong>${escapeHtml(worst.institution_name)}</strong> hit ${fmtPct(worst.stance_day_hit_rate, 1).replace('+', '')} against a ${fmtPct(worst.always_bullish_stance_day_hit_rate, 1).replace('+', '')} baseline.`
        : '&mdash;',
    },
    {
      value: `${permabulls.length}<span class="fv-den"> / ${directionDesks.length}</span>`,
      tone: '',
      claim: 'desks published no bearish or neutral call at all.',
      evidence: permabulls.length
        ? `${permabulls.map(d => escapeHtml(d.institution_name)).join(', ')} render <strong>NO DISCRIMINATING CALLS</strong> — a perfect hit rate on undiscriminating calls is not skill.`
        : 'Every desk took at least one non-bullish position.',
    },
    {
      value: String(flips.length),
      tone: '',
      claim: 'scored direction flips, with the lag behind the move that preceded them.',
      evidence: fastest
        ? `Fastest pivot: <strong>${escapeHtml(deskName(fastest.institution_id))}</strong> at a ${fastest.lag_ratio.toFixed(2)} lag ratio &mdash; it turned before the move, not after.`
        : 'No flip has a resolved 30-day window yet.',
    },
  ];

  grid.innerHTML = cards.map((c, i) => `
    <article class="finding-card">
      <span class="finding-index">${String(i + 1).padStart(2, '0')}</span>
      <span class="finding-value ${c.tone}">${c.value}</span>
      <p class="finding-claim">${c.claim}</p>
      <p class="finding-evidence">${c.evidence}</p>
    </article>
  `).join('');
}

/* Filter tab counts must come from the data — they were hardcoded to
   "(10) / (2) / (8)" while the real split had moved to 8 / 2. */
function updateScorecardFilterCounts() {
  const desks = state.scorecard || [];
  const counts = {
    all: desks.length,
    discriminating: desks.filter(d => d.is_always_bullish === 0).length,
    always_bullish: desks.filter(d => d.is_always_bullish === 1).length,
  };
  document.querySelectorAll('#scorecardFilterTabs .tab-btn').forEach(btn => {
    const key = btn.dataset.filter;
    if (counts[key] === undefined) return;
    const label = btn.textContent.replace(/\s*\(\d+\)\s*$/, '');
    btn.textContent = `${label} (${counts[key]})`;
  });
}

/* Highlight the section currently in view in the sticky rail.
   Position-based rather than IntersectionObserver: a section taller than the
   viewport never re-fires an intersection event, so the highlight would stick
   on whichever section happened to cross the observer band last. */
function initSectionRail() {
  const links = Array.from(document.querySelectorAll('.rail-link'));
  if (!links.length) return;

  const targets = links
    .map(l => ({ link: l, el: document.querySelector(l.getAttribute('href')) }))
    .filter(t => t.el);
  if (!targets.length) return;

  let ticking = false;
  let activeHref = null;

  const sync = () => {
    ticking = false;
    // The section whose top has most recently passed under the rail wins.
    const probe = window.scrollY + 140;
    let current = targets[0];
    for (const t of targets) {
      if (t.el.offsetTop <= probe) current = t;
    }
    // At the very bottom of the page the last section is the one being read.
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 8) {
      current = targets[targets.length - 1];
    }
    const href = current.link.getAttribute('href');
    if (href === activeHref) return;
    activeHref = href;
    targets.forEach(t => t.link.classList.toggle('is-active', t === current));
  };

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(sync);
  }, { passive: true });
  window.addEventListener('resize', sync, { passive: true });
  sync();
}

/* ==========================================================================
   Interactive Timeline Controls & Range Presets
   ========================================================================== */

function setTimelineRangePreset(preset) {
  if (!state.timeline || !state.timeline.market_path.length) return;
  const market = state.timeline.market_path;
  const latestDateMs = new Date(market[market.length - 1].date).getTime();

  let newMin = state.viewport.fullMinDate;
  let newMax = state.viewport.fullMaxDate;

  if (preset === 'all') {
    // "ALL" means all of the SCORED record, not all of the price history. The
    // market path reaches back to 2000 for chart context, but the desk stance
    // lanes only start at the first published call -- anchoring to fullMinDate
    // squeezed every lane into the right-hand sliver of the chart.
    const callDates = (state.timeline.calls || [])
      .map(c => new Date(c.published_on).getTime())
      .filter(t => !isNaN(t));
    if (callDates.length) {
      newMin = Math.min(...callDates) - (120 * 86400000);  // a little breathing room
    }
  } else if (preset === '2026') {
    newMin = new Date('2025-11-15').getTime();
    newMax = state.viewport.fullMaxDate;
  } else if (preset === '2025') {
    newMin = new Date('2024-11-15').getTime();
    newMax = new Date('2025-12-31').getTime();
  } else if (preset === '2024') {
    newMin = new Date('2023-11-01').getTime();
    newMax = new Date('2024-12-31').getTime();
  } else if (preset === '2023') {
    newMin = new Date('2022-11-01').getTime();
    newMax = new Date('2023-12-31').getTime();
  } else if (preset === '2022') {
    newMin = new Date('2021-11-01').getTime();
    newMax = new Date('2022-12-31').getTime();
  } else if (preset === '6m') {
    newMin = latestDateMs - (180 * 86400000);
    newMax = state.viewport.fullMaxDate;
  }

  state.viewport.viewMinDate = Math.max(state.viewport.fullMinDate, newMin);
  state.viewport.viewMaxDate = Math.min(state.viewport.fullMaxDate, newMax);
  renderTimeline();
}

function panTimeline(fraction) {
  const span = state.viewport.viewMaxDate - state.viewport.viewMinDate;
  const shift = span * fraction;
  let newMin = state.viewport.viewMinDate + shift;
  let newMax = state.viewport.viewMaxDate + shift;

  if (newMin < state.viewport.fullMinDate) {
    newMin = state.viewport.fullMinDate;
    newMax = newMin + span;
  }
  if (newMax > state.viewport.fullMaxDate) {
    newMax = state.viewport.fullMaxDate;
    newMin = Math.max(state.viewport.fullMinDate, newMax - span);
  }

  state.viewport.viewMinDate = newMin;
  state.viewport.viewMaxDate = newMax;
  renderTimeline();
}

function zoomTimeline(factor) {
  const center = (state.viewport.viewMinDate + state.viewport.viewMaxDate) / 2;
  const span = (state.viewport.viewMaxDate - state.viewport.viewMinDate) * factor;
  const minAllowedSpan = 30 * 86400000; // minimum 1 month span
  const maxAllowedSpan = state.viewport.fullMaxDate - state.viewport.fullMinDate;

  const finalSpan = Math.max(minAllowedSpan, Math.min(maxAllowedSpan, span));
  let newMin = center - finalSpan / 2;
  let newMax = center + finalSpan / 2;

  if (newMin < state.viewport.fullMinDate) {
    newMin = state.viewport.fullMinDate;
    newMax = Math.min(state.viewport.fullMaxDate, newMin + finalSpan);
  }
  if (newMax > state.viewport.fullMaxDate) {
    newMax = state.viewport.fullMaxDate;
    newMin = Math.max(state.viewport.fullMinDate, newMax - finalSpan);
  }

  state.viewport.viewMinDate = newMin;
  state.viewport.viewMaxDate = newMax;
  renderTimeline();
}

function handleTimelinePointerDown(e) {
  if (e.target.tagName === 'circle' || e.target.tagName === 'polygon' || e.target.tagName === 'a') return;

  state.viewport.isDragging = true;
  state.viewport.dragStartX = e.clientX;
  state.viewport.dragStartMinDate = state.viewport.viewMinDate;
  state.viewport.dragStartMaxDate = state.viewport.viewMaxDate;

  const container = document.getElementById('timelineContainer');
  container.classList.add('is-dragging');
  container.setPointerCapture(e.pointerId);
}

function handleTimelinePointerMove(e) {
  const container = document.getElementById('timelineContainer');
  if (!container) return;
  const innerW = container.clientWidth - 120;

  if (state.viewport.isDragging) {
    const deltaX = e.clientX - state.viewport.dragStartX;
    const span = state.viewport.dragStartMaxDate - state.viewport.dragStartMinDate;
    const deltaTime = (deltaX / innerW) * span;

    let newMin = state.viewport.dragStartMinDate - deltaTime;
    let newMax = state.viewport.dragStartMaxDate - deltaTime;

    if (newMin < state.viewport.fullMinDate) {
      newMin = state.viewport.fullMinDate;
      newMax = newMin + span;
    }
    if (newMax > state.viewport.fullMaxDate) {
      newMax = state.viewport.fullMaxDate;
      newMin = Math.max(state.viewport.fullMinDate, newMax - span);
    }

    state.viewport.viewMinDate = newMin;
    state.viewport.viewMaxDate = newMax;
    renderTimeline();
  } else {
    handleTimelineCrosshair(e);
  }
}

function handleTimelinePointerUp(e) {
  if (state.viewport.isDragging) {
    state.viewport.isDragging = false;
    const container = document.getElementById('timelineContainer');
    container.classList.remove('is-dragging');
    try {
      container.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }
}

function handleTimelineWheel(e) {
  e.preventDefault();
  const container = document.getElementById('timelineContainer');
  const innerW = container.clientWidth - 120;
  const span = state.viewport.viewMaxDate - state.viewport.viewMinDate;

  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const deltaTime = (e.deltaX / innerW) * span * 0.75;
    let newMin = state.viewport.viewMinDate + deltaTime;
    let newMax = state.viewport.viewMaxDate + deltaTime;

    if (newMin < state.viewport.fullMinDate) {
      newMin = state.viewport.fullMinDate;
      newMax = newMin + span;
    }
    if (newMax > state.viewport.fullMaxDate) {
      newMax = state.viewport.fullMaxDate;
      newMin = Math.max(state.viewport.fullMinDate, newMax - span);
    }

    state.viewport.viewMinDate = newMin;
    state.viewport.viewMaxDate = newMax;
    renderTimeline();
  } else {
    const rect = container.getBoundingClientRect();
    const cursorX = e.clientX - rect.left - 90;
    const cursorRatio = Math.max(0, Math.min(1, cursorX / innerW));
    const cursorTime = state.viewport.viewMinDate + cursorRatio * span;

    const factor = e.deltaY > 0 ? 1.15 : 0.85;
    const newSpan = Math.max(30 * 86400000, Math.min(state.viewport.fullMaxDate - state.viewport.fullMinDate, span * factor));

    let newMin = cursorTime - cursorRatio * newSpan;
    let newMax = newMin + newSpan;

    if (newMin < state.viewport.fullMinDate) {
      newMin = state.viewport.fullMinDate;
      newMax = newMin + newSpan;
    }
    if (newMax > state.viewport.fullMaxDate) {
      newMax = state.viewport.fullMaxDate;
      newMin = Math.max(state.viewport.fullMinDate, newMax - newSpan);
    }

    state.viewport.viewMinDate = newMin;
    state.viewport.viewMaxDate = newMax;
    renderTimeline();
  }
}

function handleTimelineCrosshair(e) {
  const container = document.getElementById('timelineContainer');
  const crosshair = document.getElementById('timelineCrosshair');
  const tooltip = document.getElementById('timelineTooltip');
  if (!container || !crosshair || !tooltip) return;
  if (!state.timeline || !state.timeline.market_path.length) return;

  const rect = container.getBoundingClientRect();
  const margin = { left: 90, right: 30 };
  const innerW = rect.width - margin.left - margin.right;
  const mouseX = e.clientX - rect.left;

  if (mouseX < margin.left || mouseX > rect.width - margin.right) {
    crosshair.style.display = 'none';
    tooltip.style.display = 'none';
    return;
  }

  const ratio = (mouseX - margin.left) / innerW;
  const hoverTime = state.viewport.viewMinDate + ratio * (state.viewport.viewMaxDate - state.viewport.viewMinDate);
  const hoverDateStr = new Date(hoverTime).toISOString().split('T')[0];

  const market = state.timeline.market_path;
  const closestMarket = market.reduce((prev, curr) => {
    return (Math.abs(new Date(curr.date).getTime() - hoverTime) < Math.abs(new Date(prev.date).getTime() - hoverTime)) ? curr : prev;
  }, market[0]);

  crosshair.style.display = 'block';
  crosshair.style.left = `${mouseX}px`;

  const institutions = state.timeline.institutions;
  const calls = state.timeline.calls.filter(c => c.call_type === 'direction');
  let stanceSummary = '';

  institutions.slice(0, 6).forEach(inst => {
    const active = calls.filter(c => c.institution_id === inst.id && c.published_on <= hoverDateStr).sort((a, b) => b.published_on.localeCompare(a.published_on))[0];
    const stance = active ? active.direction : 'neutral';
    const target = active && active.target_level ? active.target_level.toLocaleString() : 'N/A';
    stanceSummary += `<div style="display:flex; justify-content:space-between; margin-top:2px;"><span>${escapeHtml(inst.id)}:</span> <span class="badge-stance ${escapeHtml(stance)}">${escapeHtml(stance.toUpperCase())} (${escapeHtml(target)})</span></div>`;
  });

  tooltip.innerHTML = `
    <div style="font-weight:700; color:var(--accent-gold); margin-bottom:4px;">${hoverDateStr}</div>
    <div>SPX Proxy: <strong>${closestMarket ? Number(closestMarket.index_level).toFixed(1) : 'N/A'}</strong></div>
    <div style="margin-top:6px; font-size:10px; color:var(--text-muted); border-top:1px solid var(--border-subtle); padding-top:4px;">ACTIVE DESK STANCES (2% BAND):</div>
    <div style="font-size:10px;">${stanceSummary}</div>
  `;
  tooltip.style.display = 'block';
  tooltip.style.left = `${Math.min(rect.width - 260, mouseX + 16)}px`;
  tooltip.style.top = `40px`;
}

function handleMinimapClick(e) {
  const container = document.getElementById('minimapContainer');
  const rect = container.querySelector('.minimap-canvas-box').getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, clickX / rect.width));

  const totalSpan = state.viewport.fullMaxDate - state.viewport.fullMinDate;
  const currentSpan = state.viewport.viewMaxDate - state.viewport.viewMinDate;
  const targetCenter = state.viewport.fullMinDate + ratio * totalSpan;

  let newMin = targetCenter - currentSpan / 2;
  let newMax = targetCenter + currentSpan / 2;

  if (newMin < state.viewport.fullMinDate) {
    newMin = state.viewport.fullMinDate;
    newMax = newMin + currentSpan;
  }
  if (newMax > state.viewport.fullMaxDate) {
    newMax = state.viewport.fullMaxDate;
    newMin = Math.max(state.viewport.fullMinDate, newMax - currentSpan);
  }

  state.viewport.viewMinDate = newMin;
  state.viewport.viewMaxDate = newMax;
  renderTimeline();
}

/* ==========================================================================
   Hero Stance Timeline (SVG Canvas Rendering)
   ========================================================================== */

function renderTimeline() {
  const container = document.getElementById('timelineContainer');
  const svg = document.getElementById('timelineSvg');
  if (!state.timeline || !state.timeline.market_path.length) return;

  const marketPath = state.timeline.market_path;
  const calls = state.timeline.calls.filter(c => c.call_type === 'direction');
  const flips = state.timeline.flips;
  // Only desks that actually took a direction stance get a lane. Desks whose
  // record is purely probability calls (recession odds and the like) have no
  // stance to draw, and a permanently blank lane reads as a rendering fault
  // rather than as the absence of a call. They stay scored on the Brier path.
  const deskWithStance = new Set(calls.map(c => c.institution_id));
  const institutions = state.timeline.institutions.filter(i => deskWithStance.has(i.id));

  const width = Math.max(1000, container.clientWidth - 32);
  const institutionCount = Math.max(1, institutions.length);
  // Lanes need ~26px each to stay legible; the price path gets a real band
  // rather than being squeezed into a sliver at the top.
  const priceH = 150;
  const laneBandH = institutionCount * 28;
  const margin = { top: 44, right: 30, bottom: 44, left: 96 };
  const height = margin.top + priceH + 44 + laneBandH + margin.bottom;
  const innerW = width - margin.left - margin.right;

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.innerHTML = '';

  const minDate = state.viewport.viewMinDate;
  const maxDate = state.viewport.viewMaxDate;
  const minDateStr = new Date(minDate).toISOString().split('T')[0];
  const maxDateStr = new Date(maxDate).toISOString().split('T')[0];

  const badgeText = document.getElementById('rangeBadgeText');
  if (badgeText) {
    badgeText.textContent = `VIEWING: ${minDateStr} \u2192 ${maxDateStr} (Drag / Swipe to Explore \u2022 Use Shortcuts [\u2190/\u2192/+/0])`;
  }

  const timeToX = (dStr) => {
    const t = new Date(dStr).getTime();
    return margin.left + ((t - minDate) / (maxDate - minDate)) * innerW;
  };

  const visibleMarket = marketPath.filter(m => {
    const t = new Date(m.date).getTime();
    return t >= minDate - (86400000 * 7) && t <= maxDate + (86400000 * 7);
  });

  const visibleCallsWithTarget = calls.filter(c => {
    const t = new Date(c.published_on).getTime();
    return t >= minDate && t <= maxDate && c.target_level;
  });

  const allPrices = [
    ...(visibleMarket.length > 0 ? visibleMarket.map(m => Number(m.index_level)) : marketPath.map(m => Number(m.index_level))),
    ...visibleCallsWithTarget.map(c => Number(c.target_level))
  ];
  const minPrice = Math.floor(Math.min(...allPrices) / 200) * 200;
  const maxPrice = Math.ceil(Math.max(...allPrices) / 200) * 200;
  const priceToY = (p) => margin.top + priceH - ((p - minPrice) / Math.max(1, (maxPrice - minPrice))) * priceH;

  const spanDays = (maxDate - minDate) / 86400000;
  const startYear = new Date(minDate).getFullYear();
  const endYear = new Date(maxDate).getFullYear();
  const gridDates = [];

  for (let y = startYear; y <= endYear; y++) {
    const monthsList = spanDays > 400 ? ['01-01', '04-01', '07-01', '10-01'] : ['01-01', '02-01', '03-01', '04-01', '05-01', '06-01', '07-01', '08-01', '09-01', '10-01', '11-01', '12-01'];
    monthsList.forEach(md => {
      const dStr = `${y}-${md}`;
      const t = new Date(dStr).getTime();
      if (t >= minDate && t <= maxDate) {
        gridDates.push(dStr);
      }
    });
  }

  gridDates.forEach(mStr => {
    const x = timeToX(mStr);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', margin.top);
    line.setAttribute('x2', x);
    line.setAttribute('y2', height - margin.bottom);
    line.setAttribute('stroke', 'var(--border-subtle)');
    line.setAttribute('stroke-dasharray', '2,4');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', height - 15);
    text.setAttribute('fill', 'var(--text-muted)');
    text.setAttribute('font-family', 'var(--font-mono)');
    text.setAttribute('font-size', '10px');
    text.setAttribute('text-anchor', 'middle');
    const d = new Date(mStr);
    text.textContent = d.toLocaleString('en-US', { month: 'short', year: spanDays > 300 ? '2-digit' : undefined });
    svg.appendChild(text);
  });

  const priceTicks = [minPrice, minPrice + (maxPrice - minPrice) * 0.25, (minPrice + maxPrice) / 2,
                      minPrice + (maxPrice - minPrice) * 0.75, maxPrice];
  priceTicks.forEach(p => {
    const y = priceToY(p);
    const gl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    gl.setAttribute('x1', margin.left);
    gl.setAttribute('x2', margin.left + innerW);
    gl.setAttribute('y1', y);
    gl.setAttribute('y2', y);
    gl.setAttribute('stroke', 'var(--border-subtle)');
    gl.setAttribute('stroke-opacity', '0.5');
    svg.appendChild(gl);
    const pText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    pText.setAttribute('x', margin.left - 8);
    pText.setAttribute('y', y + 3);
    pText.setAttribute('fill', 'var(--text-dim)');
    pText.setAttribute('font-family', 'var(--font-mono)');
    pText.setAttribute('font-size', '9px');
    pText.setAttribute('text-anchor', 'end');
    pText.textContent = Math.round(p).toLocaleString();
    svg.appendChild(pText);
  });

  if (visibleMarket.length > 1) {
    let pathD = '';
    visibleMarket.forEach((pt, i) => {
      const x = timeToX(pt.date);
      const y = priceToY(pt.index_level);
      if (i === 0) pathD += `M ${x} ${y}`;
      else pathD += ` L ${x} ${y}`;
    });

    const pricePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pricePath.setAttribute('d', pathD);
    pricePath.setAttribute('fill', 'none');
    pricePath.setAttribute('stroke', 'var(--text-muted)');
    pricePath.setAttribute('stroke-width', '1.75');
    pricePath.setAttribute('stroke-linejoin', 'round');
    pricePath.setAttribute('opacity', '0.95');
    svg.appendChild(pricePath);
  }

  // Draw Vertical Target Stalk Lines on General Market (S&P 500) Curve
  const targetsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  targetsGroup.setAttribute('class', 'timeline-target-lines');

  // Label placement: 84 calls in one band will always collide, so badges are
  // placed greedily against a list of occupied rects. A call that cannot find
  // clear space keeps its stalk and pin (and its tooltip) but drops the badge —
  // an unreadable pile of overlapping labels carries less information than none.
  const placedLabels = [];
  const overlaps = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Marks are small, so they use a lighter tint of the lane/legend stance hue —
  // the spec'd Okabe-Ito values read below 3:1 at 4px on this canvas.
  const MARK_COLORS = { bullish: '#3d9fe0', bearish: '#ef7d43', neutral: '#d4c67f' };

  // Newest calls get first claim on the scarce label space.
  const labelOrder = [...visibleCallsWithTarget].sort((a, b) => b.published_on.localeCompare(a.published_on));

  labelOrder.forEach(c => {
    const cx = timeToX(c.published_on);
    const closest = visibleMarket.reduce((prev, curr) => {
      return (Math.abs(new Date(curr.date).getTime() - new Date(c.published_on).getTime()) < Math.abs(new Date(prev.date).getTime() - new Date(c.published_on).getTime())) ? curr : prev;
    }, visibleMarket[0]);
    const spotLevel = c.spot_at_publication || (closest ? Number(closest.index_level) : minPrice);
    const cySpot = priceToY(spotLevel);
    const cyTarget = priceToY(c.target_level);

    const color = MARK_COLORS[c.direction] || MARK_COLORS.neutral;

    // 1. Vertical Target Stalk Line
    const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    vLine.setAttribute('x1', cx);
    vLine.setAttribute('y1', cySpot);
    vLine.setAttribute('x2', cx);
    vLine.setAttribute('y2', cyTarget);
    vLine.setAttribute('stroke', color);
    vLine.setAttribute('stroke-width', '1');
    vLine.setAttribute('stroke-opacity', '0.55');
    vLine.setAttribute('stroke-dasharray', '2,3');
    vLine.setAttribute('class', 'chart-target-vline');
    vLine.setAttribute('data-call-id', c.id);
    vLine.style.cursor = 'pointer';
    vLine.addEventListener('click', (e) => { e.stopPropagation(); openCallModal(c.id); });
    targetsGroup.appendChild(vLine);

    // 2. Target Diamond Pin
    const pin = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    const pSize = 4;
    pin.setAttribute('points', `${cx},${cyTarget - pSize} ${cx + pSize},${cyTarget} ${cx},${cyTarget + pSize} ${cx - pSize},${cyTarget}`);
    pin.setAttribute('fill', color);
    pin.setAttribute('stroke', '#090c10');
    pin.setAttribute('stroke-width', '1');
    pin.setAttribute('class', 'chart-target-pin');
    pin.setAttribute('data-call-id', c.id);
    pin.style.cursor = 'pointer';
    pin.addEventListener('click', (e) => { e.stopPropagation(); openCallModal(c.id); });
    targetsGroup.appendChild(pin);

    // 3. Target Label Badge — placed only where it does not collide
    const isUpside = cyTarget <= cySpot;
    const badgeText = `${c.institution_id} ${Number(c.target_level).toLocaleString()}`;
    const approxW = badgeText.length * 5.4 + 8;
    const badgeH = 13;

    // Try the preferred side first, then step away from the pin.
    const dir = isUpside ? -1 : 1;
    let badgeY = null;
    for (let step = 0; step < 5; step++) {
      const candidateY = isUpside
        ? cyTarget - 17 - step * (badgeH + 2) * 1
        : cyTarget + 6 + step * (badgeH + 2);
      const rect = { x: cx - approxW / 2, y: candidateY, w: approxW, h: badgeH };
      if (rect.y < margin.top - 4 || rect.y + rect.h > margin.top + priceH + 6) continue;
      if (placedLabels.some(r => overlaps(rect, r))) continue;
      badgeY = candidateY;
      placedLabels.push(rect);
      break;
    }
    if (badgeY === null) return;

    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('x', cx - approxW / 2);
    bgRect.setAttribute('y', badgeY);
    bgRect.setAttribute('width', approxW);
    bgRect.setAttribute('height', String(badgeH));
    bgRect.setAttribute('rx', '2');
    bgRect.setAttribute('fill', '#090c10');
    bgRect.setAttribute('stroke', color);
    bgRect.setAttribute('stroke-width', '0.75');
    bgRect.setAttribute('opacity', '0.94');

    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', cx);
    txt.setAttribute('y', badgeY + 9);
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('font-family', 'var(--font-mono)');
    txt.setAttribute('font-size', '9px');
    txt.setAttribute('font-weight', '700');
    txt.setAttribute('fill', color);
    txt.textContent = badgeText;

    const badgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    badgeGroup.setAttribute('class', 'chart-target-badge');
    badgeGroup.style.cursor = 'pointer';
    badgeGroup.appendChild(bgRect);
    badgeGroup.appendChild(txt);
    badgeGroup.addEventListener('click', (e) => { e.stopPropagation(); openCallModal(c.id); });
    targetsGroup.appendChild(badgeGroup);
  });

  svg.appendChild(targetsGroup);

  if (placedLabels.length < visibleCallsWithTarget.length) {
    const hidden = visibleCallsWithTarget.length - placedLabels.length;
    const note = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    note.setAttribute('x', margin.left + innerW);
    note.setAttribute('y', margin.top - 12);
    note.setAttribute('text-anchor', 'end');
    note.setAttribute('fill', 'var(--text-dim)');
    note.setAttribute('font-family', 'var(--font-mono)');
    note.setAttribute('font-size', '9px');
    note.setAttribute('letter-spacing', '0.08em');
    note.textContent = `${hidden} MORE TARGET${hidden === 1 ? '' : 'S'} — ZOOM IN TO LABEL`;
    svg.appendChild(note);
  }

  const spxLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  spxLabel.setAttribute('x', margin.left);
  spxLabel.setAttribute('y', margin.top - 12);
  spxLabel.setAttribute('fill', 'var(--text-secondary)');
  spxLabel.setAttribute('font-family', 'var(--font-mono)');
  spxLabel.setAttribute('font-size', '10px');
  spxLabel.setAttribute('font-weight', '600');
  spxLabel.textContent = 'S&P 500 LEVEL & SELL-SIDE TARGET TRAILS';
  svg.appendChild(spxLabel);

  const swimlaneTop = margin.top + priceH + 44;
  const swimlaneH = laneBandH / institutionCount;

  // Divider between the price band and the stance lanes.
  const bandRule = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  bandRule.setAttribute('x1', margin.left);
  bandRule.setAttribute('x2', margin.left + innerW);
  bandRule.setAttribute('y1', swimlaneTop - 16);
  bandRule.setAttribute('y2', swimlaneTop - 16);
  bandRule.setAttribute('stroke', 'var(--border-subtle)');
  svg.appendChild(bandRule);

  const laneLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  laneLabel.setAttribute('x', margin.left);
  laneLabel.setAttribute('y', swimlaneTop - 24);
  laneLabel.setAttribute('fill', 'var(--text-dim)');
  laneLabel.setAttribute('font-family', 'var(--font-mono)');
  laneLabel.setAttribute('font-size', '10px');
  laneLabel.setAttribute('letter-spacing', '0.14em');
  laneLabel.textContent = 'STANCE STANDING, BY DESK';
  svg.appendChild(laneLabel);

  institutions.forEach((inst, idx) => {
    const y = swimlaneTop + idx * swimlaneH;
    const instCalls = calls.filter(c => c.institution_id === inst.id);
    instCalls.sort((a, b) => a.published_on.localeCompare(b.published_on));

    const rowBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rowBg.setAttribute('x', margin.left);
    rowBg.setAttribute('y', y);
    rowBg.setAttribute('width', innerW);
    rowBg.setAttribute('height', swimlaneH - 4);
    rowBg.setAttribute('fill', idx % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent');
    rowBg.setAttribute('rx', '2');
    svg.appendChild(rowBg);

    const nameText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    nameText.setAttribute('x', margin.left - 10);
    nameText.setAttribute('y', y + swimlaneH / 2);
    nameText.setAttribute('fill', 'var(--text-secondary)');
    nameText.setAttribute('font-family', 'var(--font-mono)');
    nameText.setAttribute('font-size', '11px');
    nameText.setAttribute('font-weight', '600');
    nameText.setAttribute('letter-spacing', '0.06em');
    nameText.setAttribute('text-anchor', 'end');
    nameText.setAttribute('dominant-baseline', 'middle');
    nameText.textContent = inst.id;
    const nameTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    nameTitle.textContent = inst.name || inst.id;
    nameText.appendChild(nameTitle);
    svg.appendChild(nameText);

    for (let i = 0; i < instCalls.length; i++) {
      const c = instCalls[i];
      const nextDate = (i + 1 < instCalls.length) ? instCalls[i + 1].published_on : maxDateStr;

      const callTime = new Date(c.published_on).getTime();
      const nextTime = new Date(nextDate).getTime();

      if (nextTime < minDate || callTime > maxDate) continue;

      const x1 = Math.max(margin.left, timeToX(c.published_on));
      const x2 = Math.min(margin.left + innerW, timeToX(nextDate));
      const segW = Math.max(2, x2 - x1);

      let color = 'var(--stance-bullish)';
      if (c.direction === 'bearish') color = 'var(--stance-bearish)';
      else if (c.direction === 'neutral') color = 'var(--stance-neutral)';

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x1);
      rect.setAttribute('y', y + 3);
      rect.setAttribute('width', segW);
      rect.setAttribute('height', swimlaneH - 10);
      rect.setAttribute('fill', color);
      rect.setAttribute('opacity', '0.8');
      rect.setAttribute('rx', '2');
      rect.style.cursor = 'pointer';
      rect.addEventListener('click', (e) => { e.stopPropagation(); openCallModal(c.id); });
      svg.appendChild(rect);

      if (callTime >= minDate && callTime <= maxDate) {
        const dotX = timeToX(c.published_on);
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', dotX);
        dot.setAttribute('cy', y + (swimlaneH - 4) / 2);
        dot.setAttribute('r', '4');
        dot.setAttribute('fill', '#ffffff');
        dot.setAttribute('stroke', '#090c10');
        dot.setAttribute('stroke-width', '1.5');
        dot.style.cursor = 'pointer';
        dot.addEventListener('click', (e) => { e.stopPropagation(); openCallModal(c.id); });
        svg.appendChild(dot);
      }
    }
  });

  flips.forEach(flip => {
    const flipTime = new Date(flip.flip_date).getTime();
    if (flipTime < minDate || flipTime > maxDate) return;

    const instIdx = institutions.findIndex(i => i.id === flip.institution_id);
    if (instIdx < 0) return;

    const y = swimlaneTop + instIdx * swimlaneH;
    const x = timeToX(flip.flip_date);

    const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    const size = 5;
    const cy = y + (swimlaneH - 4) / 2;
    diamond.setAttribute('points', `${x},${cy-size} ${x+size},${cy} ${x},${cy+size} ${x-size},${cy}`);
    diamond.setAttribute('fill', 'var(--accent-gold)');
    diamond.setAttribute('stroke', '#000');
    diamond.setAttribute('stroke-width', '1');
    diamond.style.cursor = 'pointer';
    diamond.addEventListener('click', (e) => { e.stopPropagation(); openCallModal(flip.call_id); });
    svg.appendChild(diamond);
  });

  renderMinimap();
}

function renderMinimap() {
  const minimapSvg = document.getElementById('minimapSvg');
  const brush = document.getElementById('minimapBrush');
  if (!state.timeline || !state.timeline.market_path.length || !minimapSvg) return;

  const marketPath = state.timeline.market_path;
  const fullMin = state.viewport.fullMinDate;
  const fullMax = state.viewport.fullMaxDate;
  const totalSpan = fullMax - fullMin;

  const width = minimapSvg.clientWidth || 900;
  const height = 38;

  minimapSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  minimapSvg.innerHTML = '';

  const allPrices = marketPath.map(m => Number(m.index_level));
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);

  let pathD = '';
  marketPath.forEach((pt, i) => {
    const t = new Date(pt.date).getTime();
    const x = ((t - fullMin) / totalSpan) * width;
    const y = height - 4 - ((pt.index_level - minP) / (maxP - minP)) * (height - 8);
    if (i === 0) pathD += `M ${x} ${y}`;
    else pathD += ` L ${x} ${y}`;
  });

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#475569');
  path.setAttribute('stroke-width', '1.2');
  minimapSvg.appendChild(path);

  const leftPct = ((state.viewport.viewMinDate - fullMin) / totalSpan) * 100;
  const widthPct = ((state.viewport.viewMaxDate - state.viewport.viewMinDate) / totalSpan) * 100;

  brush.style.left = `${Math.max(0, leftPct)}%`;
  brush.style.width = `${Math.min(100 - leftPct, widthPct)}%`;
}

/* ==========================================================================
   Section 02: Scorecard Blotter Table
   ========================================================================== */

function renderScorecard() {
  const tbody = document.getElementById('scorecardTbody');
  if (!tbody) return;
  updateScorecardFilterCounts();

  let data = [...state.scorecard];

  if (state.filter === 'discriminating') {
    data = data.filter(d => d.is_always_bullish === 0);
  } else if (state.filter === 'always_bullish') {
    data = data.filter(d => d.is_always_bullish === 1);
  }

  const scorecardHeaders = document.querySelectorAll('#scorecardTable th.sortable');
  scorecardHeaders.forEach(th => {
    const field = th.dataset.sort;
    if (field === state.sortBy) {
      th.setAttribute('aria-sort', state.sortOrder === 'asc' ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  });

  data.sort((a, b) => {
    let valA = a[state.sortBy];
    let valB = b[state.sortBy];
    if (valA === null || valA === undefined) valA = -999;
    if (valB === null || valB === undefined) valB = -999;
    if (typeof valA === 'string') {
      return state.sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return state.sortOrder === 'asc' ? valA - valB : valB - valA;
  });

  // Bars are scaled to the widest edge on screen, so the chart reads as a
  // comparison between these desks rather than against an arbitrary constant.
  const maxAbsEdge = Math.max(
    0.01,
    ...data.map(r => Math.abs(pickEdge(r) ?? 0))
  );

  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:2rem; color:var(--text-muted);">No desks match this filter.</td></tr>`;
    return;
  }

  data.forEach(row => {
    const tr = document.createElement('tr');
    const edge = pickEdge(row);
    const hitRate = row.stance_day_hit_rate !== null ? row.stance_day_hit_rate : row.event_hit_rate;
    const baseline = row.always_bullish_stance_day_hit_rate !== null
      ? row.always_bullish_stance_day_hit_rate
      : row.always_bullish_event_hit_rate;
    const observations = row.stance_day_resolved || row.event_resolved || 0;

    // Edge bar: anchored at zero, growing left for negative and right for positive.
    let barClass = 'is-zero';
    let barStyle = '';
    if (edge !== null && edge > 0.0005) {
      barClass = 'is-positive';
      barStyle = `width:${(Math.abs(edge) / maxAbsEdge) * 50}%;`;
    } else if (edge !== null && edge < -0.0005) {
      barClass = 'is-negative';
      barStyle = `width:${(Math.abs(edge) / maxAbsEdge) * 50}%;`;
    }

    let edgeClass = 'edge-zero';
    if (edge > 0.0005) edgeClass = 'edge-positive';
    else if (edge < -0.0005) edgeClass = 'edge-negative';

    let findingBadge;
    if (row.total_calls === 0) {
      findingBadge = `<span class="badge-stance too_early">NO DIRECTION CALLS</span>`;
    } else if (row.is_always_bullish === 1) {
      findingBadge = `<span class="badge-no-discrim">NO DISCRIMINATING CALLS</span>`;
    } else {
      findingBadge = `<span class="badge-evaluated">${row.n_bearish}&nbsp;BEAR / ${row.n_neutral}&nbsp;NEUTRAL / ${row.n_bullish}&nbsp;BULL</span>`;
    }

    const directionBadge = row.latest_direction
      ? `<span class="badge-stance ${escapeHtml(row.latest_direction)}">${escapeHtml(row.latest_direction.toUpperCase())}</span>`
      : '';

    const lagDisplay = row.avg_lag_ratio !== null && row.avg_lag_ratio !== undefined
      ? Number(row.avg_lag_ratio).toFixed(2)
      : '\u2014';
    const lagNote = row.avg_lag_ratio === null || row.avg_lag_ratio === undefined
      ? 'no flips'
      : (row.avg_lag_ratio < 1 ? 'led the move' : 'chased the move');

    tr.innerHTML = `
      <td>
        <div class="desk-cell">
          <span class="desk-name">${escapeHtml(row.institution_name)}</span>
          <span class="desk-id">${escapeHtml(row.institution_id)} &middot; ${row.total_calls} calls</span>
        </div>
      </td>
      <td>
        <div class="call-cell">
          <span class="call-target">${row.latest_target ? Number(row.latest_target).toLocaleString() : '\u2014'} ${directionBadge}</span>
          <span class="call-implied">${row.latest_implied_return !== null ? `${fmtPct(row.latest_implied_return, 1)} implied` : 'no target'}</span>
        </div>
      </td>
      <td class="text-right group-start">
        <div class="edge-cell">
          <div class="edge-figure ${edgeClass}">${edge !== null ? fmtPct(edge, 1) : '\u2014'}</div>
          <div class="edge-bar-track"><span class="edge-bar ${barClass}" style="${barStyle}"></span></div>
        </div>
      </td>
      <td class="text-right">
        <div class="rate-pair">
          <span class="rate-row is-desk"><span class="rate-key">DESK</span><span class="rate-val">${hitRate !== null && hitRate !== undefined ? (hitRate * 100).toFixed(1) + '%' : '\u2014'}</span></span>
          <span class="rate-row is-baseline"><span class="rate-key">BASELINE</span><span class="rate-val">${baseline !== null && baseline !== undefined ? (baseline * 100).toFixed(1) + '%' : '\u2014'}</span></span>
          <span class="obs-count">${Number(observations).toLocaleString()} obs</span>
        </div>
      </td>
      <td class="text-right group-start">
        <div class="rate-pair">
          <span class="rate-val" style="color:var(--text-primary); font-weight:600;">${lagDisplay}</span>
          <span class="rate-key">${lagNote}</span>
        </div>
      </td>
      <td>${findingBadge}</td>
    `;

    tr.addEventListener('click', () => {
      const bankCalls = state.calls.filter(c => c.institution_id === row.institution_id);
      if (bankCalls.length > 0) {
        openCallModal(bankCalls[0].id);
      }
    });

    tbody.appendChild(tr);
  });
}

/** Stance-day edge is the headline metric; event edge is the fallback. */
function pickEdge(row) {
  if (row.stance_day_edge !== null && row.stance_day_edge !== undefined) return row.stance_day_edge;
  if (row.event_edge !== null && row.event_edge !== undefined) return row.event_edge;
  return null;
}

/* ==========================================================================
   Section 03: Most Reliable Partner & Trust Matrix
   ========================================================================== */

function renderPartnersSection() {
  const spotlightContainer = document.getElementById('spotlightPartnerBox');
  const cardsContainer = document.getElementById('partnerCardsGrid');
  if (!state.partners || !state.partners.length || !spotlightContainer || !cardsContainer) return;

  let sortedPartners = [...state.partners];

  // Regime-specific sorting
  if (state.partnerRegime === 'bear') {
    sortedPartners.sort((a, b) => b.bear_market_edge - a.bear_market_edge || b.bear_market_hit_rate - a.bear_market_hit_rate);
  } else if (state.partnerRegime === 'bull') {
    sortedPartners.sort((a, b) => b.bull_market_edge - a.bull_market_edge || b.bull_market_hit_rate - a.bull_market_hit_rate);
  } else if (state.partnerRegime === 'agility') {
    sortedPartners.sort((a, b) => (a.avg_lag_ratio || 99) - (b.avg_lag_ratio || 99));
  } else {
    sortedPartners.sort((a, b) => b.reliability_score - a.reliability_score);
  }

  const topPartner = sortedPartners[0];
  const regimeNote = {
    overall: 'Composite reliability index',
    bear: 'Ranked on 2022 bear-market edge',
    bull: 'Ranked on 2023\u201326 bull-run edge',
    agility: 'Ranked on lag ratio \u2014 lower turned earlier',
  }[state.partnerRegime] || '';

  // Print the sample behind the error; a 2.0% MAPE from one resolved year-end
  // is not the same claim as 10.2% from nine, and the card must not imply it is.
  const mapeText = (p) => (p.target_mape_measured && p.target_mape !== null)
    ? `${(p.target_mape * 100).toFixed(1)}%${p.target_mape_n ? ` (n=${p.target_mape_n})` : ''}`
    : 'n/a';

  // 1. Render Spotlight #1 Hero Box
  spotlightContainer.innerHTML = `
    <div class="spotlight-header-row">
      <div>
        <div class="spotlight-rank-tag">\u2605 #1 &mdash; ${escapeHtml(regimeNote)}</div>
        <div class="spotlight-title">${topPartner.institution_name} &mdash; ${topPartner.institution_full_name}</div>
        <div class="spotlight-subtitle">Lead Strategy Desk &middot; ${topPartner.total_calls} Curated Year-End Target Revisions</div>
      </div>
      <div class="spotlight-score-badge">
        <div class="spotlight-score-val">${topPartner.reliability_score}</div>
        <div class="spotlight-score-label">RELIABILITY INDEX / 100</div>
      </div>
    </div>

    <div class="spotlight-body-grid">
      <div class="spotlight-metric-item">
        <span class="spotlight-metric-label">PARTNER CLASSIFICATION</span>
        <span class="spotlight-metric-value"><span class="tier-badge tier-2">${topPartner.tier}</span></span>
      </div>
      <div class="spotlight-metric-item">
        <span class="spotlight-metric-label">TARGET REALIZATION ERROR</span>
        <span class="spotlight-metric-value" style="color:var(--accent-gold);">${mapeText(topPartner)}${topPartner.target_mape_measured ? ' MAPE' : ' — no resolved year-end'}</span>
      </div>
      <div class="spotlight-metric-item">
        <span class="spotlight-metric-label">PIVOT AGILITY (SPEED)</span>
        <span class="spotlight-metric-value">${topPartner.agility_label} (${topPartner.avg_lag_ratio ? topPartner.avg_lag_ratio.toFixed(2) : 'N/A'})</span>
      </div>
      <div class="spotlight-metric-item">
        <span class="spotlight-metric-label">STANCE CONVICTION</span>
        <span class="spotlight-metric-value">${topPartner.n_bearish} Bearish / ${topPartner.n_bullish} Bullish</span>
      </div>
    </div>

    <div class="spotlight-insights-row">
      <div class="spotlight-insights-col">
        <h4>PROVEN STRENGTHS &amp; VALUE ADD</h4>
        <div class="chips-list">
          ${topPartner.strengths.map(s => `
            <div class="chip-item strength"><span class="chip-dot"></span> ${s}</div>
          `).join('')}
        </div>
      </div>
      <div class="spotlight-insights-col">
        <h4>WATCHPOINTS &amp; MODEL LIMITATIONS</h4>
        <div class="chips-list">
          ${topPartner.risks.map(r => `
            <div class="chip-item risk"><span class="chip-dot"></span> ${r}</div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  // 2. Render Partner Cards Grid
  const excluded = (topPartner && topPartner.excluded_houses) || [];
  const noteEl = document.getElementById('partnerExclusionNote');
  if (noteEl) {
    noteEl.innerHTML = excluded.length
      ? `Ranking covers the ${sortedPartners.length} houses with a direction record. `
        + `${excluded.map(e => escapeHtml(e.institution_name)).join(', ')} `
        + `${excluded.length === 1 ? 'is' : 'are'} excluded \u2014 no index targets on record to score.`
      : '';
  }

  cardsContainer.innerHTML = '';
  sortedPartners.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'partner-card';

    let tierClass = 'tier-3';
    if (p.tier.includes('Tier 1')) tierClass = 'tier-1';
    else if (p.tier.includes('Tier 2')) tierClass = 'tier-2';
    else if (p.tier.includes('Tier 4')) tierClass = 'tier-4';
    else if (p.tier.includes('Tier 5')) tierClass = 'tier-5';

    card.innerHTML = `
      <div>
        <div class="partner-card-header">
          <div>
            <span class="partner-rank-num">#${idx + 1}</span>
            <span class="partner-card-name">${p.institution_name}</span>
            <div><span class="tier-badge ${tierClass}">${p.tier}</span></div>
          </div>
          <div class="partner-card-score">${p.reliability_score}</div>
        </div>

        <div class="partner-metrics-table">
          <div class="pm-item">
            <span class="pm-label">TARGET ERROR (MAPE)</span>
            <span class="pm-value">${mapeText(p)}</span>
          </div>
          <div class="pm-item">
            <span class="pm-label">STANCE EDGE</span>
            <span class="pm-value ${p.stance_day_edge >= 0 ? 'edge-positive' : 'edge-negative'}">${p.stance_day_edge !== null ? (p.stance_day_edge >= 0 ? '+' : '') + (p.stance_day_edge * 100).toFixed(1) + '%' : '0.0%'}</span>
          </div>
          <div class="pm-item">
            <span class="pm-label">AGILITY / LAG</span>
            <span class="pm-value">${p.avg_lag_ratio ? p.avg_lag_ratio.toFixed(2) : '\u2014'}</span>
          </div>
          <div class="pm-item">
            <span class="pm-label">CALLS / CONVICTION</span>
            <span class="pm-value">${p.total_calls} (${p.n_bearish}B / ${p.n_bullish}L)</span>
          </div>
        </div>

        <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">KEY INSIGHT:</div>
        <div style="font-size:11px; color:var(--text-secondary); line-height:1.4;">
          ${p.strengths[0] || 'Standard consensus tracker.'}
        </div>
      </div>

      <div class="partner-card-footer">
        <span>Click to audit track record &rarr;</span>
        <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-muted);">${p.institution_id}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      const bankCalls = state.calls.filter(c => c.institution_id === p.institution_id);
      if (bankCalls.length > 0) {
        openCallModal(bankCalls[0].id);
      }
    });

    cardsContainer.appendChild(card);
  });
}

/* ==========================================================================
   Section 04: Allocation & Macro Calls
   ========================================================================== */

function renderMacroSection() {
  const allocTbody = document.getElementById('allocationTbody');
  if (allocTbody) {
    const allocations = (state.macro && state.macro.allocations) || [];
    allocTbody.innerHTML = '';

    if (allocations.length === 0) {
      allocTbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted);">No allocation calls scored.</td></tr>`;
    }

    allocations.forEach(a => {
      const tr = document.createElement('tr');
      const hz = a.horizons || {};

      // Spreads for every horizon that has actually resolved.
      const spreadParts = ['1M', '3M', '6M', 'YE']
        .filter(h => hz[h] && hz[h].spread_return !== null && hz[h].spread_return !== undefined)
        .map(h => `${h} ${fmtPct(hz[h].spread_return, 2)}`);
      const spreadText = spreadParts.length ? spreadParts.join('  \u00B7  ') : 'Unresolved';

      // Headline verdict = the shortest resolved window; otherwise too_early.
      const firstResolved = ['1M', '3M', '6M', 'YE'].map(h => hz[h]).find(x => x && x.is_resolved === 1);
      const verdict = firstResolved ? firstResolved.verdict : 'too_early';
      const bench = a.allocation_benchmark || 'ACWI';
      const verdictLabel = verdict === 'hit'
        ? 'HIT'
        : (verdict === 'miss' ? 'MISS' : 'TOO EARLY');
      const verdictTitle = verdict === 'hit'
        ? `Beat ${bench} over the first resolved window`
        : (verdict === 'miss' ? `Lagged ${bench} over the first resolved window` : 'No window has resolved yet');

      const record = `${a.hits}H / ${a.misses}M / ${a.too_early}E`;

      tr.innerHTML = `
        <td><strong>${escapeHtml(a.institution_name)}</strong></td>
        <td style="font-family:var(--font-mono); font-size:11px;">${escapeHtml(a.published_on)}</td>
        <td><span class="badge-stance ${escapeHtml(a.allocation_stance)}">${escapeHtml(String(a.allocation_stance).toUpperCase())}</span></td>
        <td style="font-family:var(--font-mono); font-size:11px;">${escapeHtml(a.allocation_asset)} / ${escapeHtml(bench)}</td>
        <td style="font-family:var(--font-mono); font-size:10px; white-space:normal; line-height:1.5;">${escapeHtml(spreadText)}<br><span style="color:var(--text-muted);">${record}</span></td>
        <td><span class="verdict-pill ${verdict}" title="${escapeHtml(verdictTitle)}">${verdictLabel}</span></td>
      `;
      tr.addEventListener('click', () => openCallModal(a.call_id));
      allocTbody.appendChild(tr);
    });
  }

  const probTbody = document.getElementById('probabilityTbody');
  if (probTbody) {
    const probabilities = (state.macro && state.macro.probabilities) || [];
    probTbody.innerHTML = '';

    if (probabilities.length === 0) {
      probTbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted);">No probability calls scored.</td></tr>`;
    }

    probabilities.forEach(pr => {
      const tr = document.createElement('tr');
      const verdict = pr.verdict || 'too_early';
      const outcomeText = pr.is_resolved === 1 && pr.actual_outcome !== null
        ? (Number(pr.actual_outcome) === 1 ? 'Occurred' : 'Did not occur')
        : 'Unresolved';
      const brierText = pr.brier_score !== null && pr.brier_score !== undefined
        ? `${Number(pr.brier_score).toFixed(4)} vs ${Number(pr.brier_climatology).toFixed(4)}`
        : '\u2014';

      tr.innerHTML = `
        <td><strong>${escapeHtml(pr.institution_name)}</strong></td>
        <td style="font-family:var(--font-mono); font-size:11px;">${escapeHtml(pr.probability_event)}</td>
        <td style="font-family:var(--font-mono); font-weight:600; color:var(--accent-gold);">${(Number(pr.probability_value) * 100).toFixed(0)}%</td>
        <td style="font-family:var(--font-mono); color:var(--text-muted);">${(Number(pr.climatology_prior) * 100).toFixed(1)}%</td>
        <td style="font-family:var(--font-mono); color:var(--text-muted);">${escapeHtml(outcomeText)} <span style="font-size:10px;">${escapeHtml(brierText)}</span></td>
        <td><span class="verdict-pill ${verdict}">${escapeHtml(verdict.replace('_', ' ').toUpperCase())}</span></td>
      `;
      tr.addEventListener('click', () => openCallModal(pr.call_id));
      probTbody.appendChild(tr);
    });
  }
}

/* ==========================================================================
   Section 05: Curated Calls Table with Real-Time Filtering
   ========================================================================== */

function renderCallsTable() {
  const tbody = document.getElementById('callsTbody');
  tbody.innerHTML = '';

  let filteredCalls = [...state.calls];

  // 1. Filter by Horizon
  if (state.callHorizonFilter !== 'all') {
    filteredCalls = filteredCalls.filter(c => c.forecast_horizon === state.callHorizonFilter);
  }

  // 2. Filter by Search Query
  if (state.callSearchQuery) {
    const q = state.callSearchQuery;
    filteredCalls = filteredCalls.filter(c => {
      const matchInst = (c.institution_name || '').toLowerCase().includes(q) || (c.institution_id || '').toLowerCase().includes(q);
      const matchStrat = (c.strategist_name || '').toLowerCase().includes(q);
      const matchNotes = (c.notes || '').toLowerCase().includes(q);
      const matchTarget = (c.target_level ? String(c.target_level) : '').includes(q);
      const matchDate = (c.published_on || '').includes(q);
      const matchStance = (c.direction || '').toLowerCase().includes(q);
      return matchInst || matchStrat || matchNotes || matchTarget || matchDate || matchStance;
    });
  }

  const countEl = document.getElementById('callsResultCount');
  const moreBtn = document.getElementById('callsLoadMoreBtn');

  if (filteredCalls.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9">
          <div class="empty-state-card">
            <div class="empty-state-icon">⌕</div>
            <div class="empty-state-title">No Matching Research Calls Found</div>
            <div class="empty-state-desc">No curated institutional forecasts match "${escapeHtml(state.callSearchQuery || state.callHorizonFilter)}". Try adjusting your search term or reset the horizon pill.</div>
            <button class="empty-state-reset-btn" id="emptyStateResetBtn">Reset Search &amp; Filters</button>
          </div>
        </td>
      </tr>
    `;
    document.getElementById('emptyStateResetBtn')?.addEventListener('click', () => {
      state.callSearchQuery = '';
      state.callHorizonFilter = 'all';
      const sInput = document.getElementById('callsSearchInput');
      const cBtn = document.getElementById('callsSearchClearBtn');
      if (sInput) sInput.value = '';
      if (cBtn) cBtn.classList.remove('is-active');
      document.querySelectorAll('#horizonFilterPills .pill-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.horizon === 'all');
      });
      renderCallsTable();
    });
    if (countEl) countEl.textContent = '0 OF 0 CALLS';
    if (moreBtn) moreBtn.hidden = true;
    return;
  }

  const shown = Math.min(state.callsVisibleCount, filteredCalls.length);
  const pageCalls = filteredCalls.slice(0, shown);

  if (countEl) {
    countEl.textContent = `SHOWING ${shown} OF ${filteredCalls.length} CALLS`;
  }
  if (moreBtn) {
    moreBtn.hidden = shown >= filteredCalls.length;
    moreBtn.textContent = `SHOW ${Math.min(25, filteredCalls.length - shown)} MORE`;
  }

  pageCalls.forEach(c => {
    const tr = document.createElement('tr');
    const targetDisplay = c.target_level ? c.target_level.toLocaleString() : (c.allocation_stance ? c.allocation_stance.toUpperCase() : `${(c.probability_value * 100)}% prob`);
    const spotDisplay = c.spot_at_publication ? Number(c.spot_at_publication).toFixed(1) : '\u2014';
    const impliedDisplay = c.implied_return !== null ? `${c.implied_return >= 0 ? '+' : ''}${(c.implied_return * 100).toFixed(1)}%` : '\u2014';

    // Scored stance is the band arithmetic. The linguistic read is shown beside
    // it and flagged when the two disagree — never in place of it.
    const scored = c.direction || c.allocation_stance || '\u2014';
    const scoredBadge = c.direction || c.allocation_stance
      ? `<span class="badge-stance ${escapeHtml(scored)}">${escapeHtml(String(scored).toUpperCase())}</span>`
      : '\u2014';
    const aiStance = c.ai_stance || null;
    const aiDisagrees = c.ai_math_agreement === 0;
    const aiBadge = aiStance
      ? `<span class="ai-read ${aiDisagrees ? 'ai-read-conflict' : ''}" title="${aiDisagrees ? 'Linguistic read disagrees with the band arithmetic; the scorecard uses the arithmetic.' : 'Linguistic read agrees with the band arithmetic.'}">${escapeHtml(aiStance.toUpperCase())}${aiDisagrees ? ' \u26A0' : ''}</span>`
      : '\u2014';

    const sourceBtn = c.source_url
      ? `<a href="${encodeURI(c.source_url)}" target="_blank" rel="noopener noreferrer" class="source-link" onclick="event.stopPropagation()">Source &nearr;</a>`
      : '\u2014';

    tr.innerHTML = `
      <td style="font-family:var(--font-mono); font-size:11px;">${escapeHtml(c.published_on)}</td>
      <td><strong>${escapeHtml(c.institution_name)}</strong> ${c.strategist_name ? `<span style="color:var(--text-muted); font-size:11px;">(${escapeHtml(c.strategist_name)})</span>` : ''}</td>
      <td><span style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${escapeHtml(c.call_type)} (${escapeHtml(c.forecast_horizon)})</span></td>
      <td style="font-family:var(--font-mono); font-weight:600;">${targetDisplay}</td>
      <td style="font-family:var(--font-mono);">${spotDisplay}</td>
      <td style="font-family:var(--font-mono); font-size:12px;">${impliedDisplay}</td>
      <td>${scoredBadge}</td>
      <td>${aiBadge}</td>
      <td>${sourceBtn}</td>
    `;

    tr.addEventListener('click', () => openCallModal(c.id));
    tbody.appendChild(tr);
  });
}

/* ==========================================================================
   Call Detail Modal / Drawer
   ========================================================================== */

async function openCallModal(callId) {
  lastFocusedElement = document.activeElement;
  const modal = document.getElementById('modalBackdrop');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  const tag = document.getElementById('modalTag');

  body.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted); font-family:var(--font-mono);"><span class="sync-dot pulsing" style="display:inline-block; margin-right:8px;"></span> Loading call details...</div>';
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    modal.classList.add('is-visible');
    document.getElementById('modalCloseBtn')?.focus();
  });

  try {
    const res = await fetch(`/api/calls/${callId}`);
    const data = await res.json();
    const c = data.call;

    const instName = (c.institution_name || c.institution_id || 'DESK').toUpperCase();
    const callTypeStr = (c.call_type || 'CALL').toUpperCase();
    tag.textContent = `${instName} // ${callTypeStr} AUDIT`;
    title.textContent = `${c.institution_full_name || c.institution_name || c.institution_id} (${c.published_on})`;

    // Multi-horizon / evaluation matrix based on call type
    let multiHorizonHtml = '';
    if (c.call_type === 'direction' && data.direction_scores && data.direction_scores.length > 0) {
      multiHorizonHtml = `
        <div class="section-drawer">
          <h4>MULTI-HORIZON REALIZATION MATRIX</h4>
          <table class="blotter-table compact-table">
            <thead>
              <tr>
                <th>HORIZON</th>
                <th>WINDOW</th>
                <th>START SPOT</th>
                <th>END SPOT</th>
                <th>REALISED RETURN</th>
                <th>REALISED DIR</th>
                <th>VERDICT</th>
              </tr>
            </thead>
            <tbody>
              ${data.direction_scores.map(s => `
                <tr>
                  <td><strong>+${s.horizon}</strong></td>
                  <td style="font-family:var(--font-mono); font-size:11px;">${s.window_start_date} &rarr; ${s.window_end_date}</td>
                  <td style="font-family:var(--font-mono);">${s.start_price ? Number(s.start_price).toFixed(1) : '\u2014'}</td>
                  <td style="font-family:var(--font-mono);">${s.end_price ? Number(s.end_price).toFixed(1) : '\u2014'}</td>
                  <td style="font-family:var(--font-mono);">${s.realised_return !== null ? (s.realised_return >= 0 ? '+' : '') + (s.realised_return * 100).toFixed(1) + '%' : '\u2014'}</td>
                  <td>${s.realised_direction ? `<span class="badge-stance ${s.realised_direction}">${String(s.realised_direction).toUpperCase()}</span>` : '\u2014'}</td>
                  <td><span class="verdict-pill ${s.verdict || 'unresolved'}">${String(s.verdict || 'UNRESOLVED').toUpperCase()}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (c.call_type === 'allocation' && data.allocation_scores && data.allocation_scores.length > 0) {
      multiHorizonHtml = `
        <div class="section-drawer">
          <h4>RELATIVE BENCHMARK SPREAD MATRIX (${c.allocation_asset || 'SPX'} VS ${c.allocation_benchmark || 'ACWI'})</h4>
          <table class="blotter-table compact-table">
            <thead>
              <tr>
                <th>HORIZON</th>
                <th>WINDOW</th>
                <th>ASSET RETURN</th>
                <th>BENCH RETURN</th>
                <th>SPREAD (DIFF)</th>
                <th>VERDICT</th>
              </tr>
            </thead>
            <tbody>
              ${data.allocation_scores.map(s => `
                <tr>
                  <td><strong>+${s.horizon}</strong></td>
                  <td style="font-family:var(--font-mono); font-size:11px;">${s.window_start_date} &rarr; ${s.window_end_date}</td>
                  <td style="font-family:var(--font-mono);">${fmtPct(s.asset_return)}</td>
                  <td style="font-family:var(--font-mono);">${fmtPct(s.bench_return)}</td>
                  <td style="font-family:var(--font-mono); font-weight:700; color:${s.spread_return >= 0 ? '#38bdf8' : '#f87171'};">${fmtPct(s.spread_return)}</td>
                  <td><span class="verdict-pill ${s.verdict || 'unresolved'}">${String(s.verdict || 'UNRESOLVED').toUpperCase()}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (c.call_type === 'probability' && data.probability_scores && data.probability_scores.length > 0) {
      multiHorizonHtml = `
        <div class="section-drawer">
          <h4>PROBABILITY &amp; BRIER SKILL SCORE AUDIT</h4>
          <table class="blotter-table compact-table">
            <thead>
              <tr>
                <th>EVENT KEY</th>
                <th>FORECAST PROB</th>
                <th>CLIMATOLOGY PRIOR</th>
                <th>REALIZED OUTCOME</th>
                <th>BRIER SCORE</th>
                <th>SKILL SCORE</th>
                <th>VERDICT</th>
              </tr>
            </thead>
            <tbody>
              ${data.probability_scores.map(s => `
                <tr>
                  <td><strong>${s.event_key}</strong></td>
                  <td style="font-family:var(--font-mono);">${s.probability_value !== null && s.probability_value !== undefined ? (s.probability_value * 100).toFixed(1) + '%' : '\u2014'}</td>
                  <td style="font-family:var(--font-mono);">${s.climatology_prior !== null ? (s.climatology_prior * 100).toFixed(1) + '%' : '16.7%'}</td>
                  <td style="font-family:var(--font-mono);">${s.is_resolved === 1 && s.actual_outcome !== null && s.actual_outcome !== undefined ? (Number(s.actual_outcome) === 1 ? 'Occurred' : 'Did not occur') : 'Unresolved'}</td>
                  <td style="font-family:var(--font-mono);">${s.brier_score !== null ? Number(s.brier_score).toFixed(4) : '\u2014'}</td>
                  <td style="font-family:var(--font-mono);">${s.brier_skill_score !== null && s.brier_skill_score !== undefined ? Number(s.brier_skill_score).toFixed(4) : '\u2014'}</td>
                  <td><span class="verdict-pill ${s.verdict || 'too_early'}">${String(s.verdict || 'TOO_EARLY').toUpperCase()}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    let ladderHtml = '';
    if (data.supersession_chain && data.supersession_chain.length > 1) {
      ladderHtml = `
        <div class="section-drawer">
          <h4>SUPERSESSION LINEAGE (${data.supersession_chain.length} CALLS IN CHAIN)</h4>
          <div class="ladder-chain">
            ${data.supersession_chain.map(step => {
              const stepStance = step.direction || step.allocation_stance || 'neutral';
              const stepTarget = step.target_level
                ? `Target: <strong>${Number(step.target_level).toLocaleString()}</strong> (Spot: ${step.spot_at_publication ? Number(step.spot_at_publication).toFixed(1) : '\u2014'}, Implied: ${step.implied_return !== null ? (step.implied_return >= 0 ? '+' : '') + (step.implied_return * 100).toFixed(1) + '%' : '\u2014'})`
                : (step.allocation_stance ? `Stance: <strong>${String(step.allocation_stance).toUpperCase()}</strong>` : `Prob: <strong>${step.probability_value !== null ? (step.probability_value * 100).toFixed(0) + '%' : '\u2014'}</strong>`);

              return `
                <div class="ladder-step ${step.id === c.id ? 'current' : ''}">
                  <div>
                    <strong>${step.published_on}</strong> &mdash; ${stepTarget}
                  </div>
                  <div>
                    <span class="badge-stance ${stepStance}">${String(stepStance).toUpperCase()}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    // AI Audit Drawer Component. `scoredStance` is what the scorecard used;
    // `aiStance` is the linguistic read shown alongside it.
    const scoredStance = c.direction || c.allocation_stance || 'neutral';
    const aiStance = c.ai_stance || scoredStance;
    const aiDisagrees = c.ai_math_agreement === 0;
    const aiConfPct = c.ai_confidence ? (c.ai_confidence * 100).toFixed(0) : '85';
    let rawDrivers = [];
    try {
      if (typeof c.ai_key_drivers === 'string') rawDrivers = JSON.parse(c.ai_key_drivers);
      else if (Array.isArray(c.ai_key_drivers)) rawDrivers = c.ai_key_drivers;
    } catch (_) {}

    const driversHtml = rawDrivers.length > 0
      ? `<div class="ai-drivers-tags">
          ${rawDrivers.map(d => `<span class="ai-driver-tag">\u2022 ${d}</span>`).join('')}
        </div>`
      : `<span style="font-size:11px; color:var(--text-muted); font-style:italic;">Standard macro trend model</span>`;

    const aiAuditHtml = `
      <div class="section-drawer ai-audit-drawer">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h4 style="margin:0; border:none; padding:0; color:var(--accent-gold); display:flex; align-items:center; gap:6px;">
            \u2728 AI STANCE &amp; LINGUISTIC AUDIT
          </h4>
          <span class="tier-badge tier-2">${aiConfPct}% AI CONFIDENCE</span>
        </div>

        <div class="ai-audit-box">
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:8px;">
            <div>
              <span class="detail-label">Linguistic Read${aiDisagrees ? ' (conflicts with band)' : ''}</span>
              <div style="margin-top:4px;">
                <span class="badge-stance ${escapeHtml(aiStance)}">${escapeHtml(String(aiStance).toUpperCase())}</span>
                ${aiDisagrees ? `<span class="curated-flag">band scores this ${escapeHtml(String(scoredStance).toUpperCase())}</span>` : ''}
              </div>
            </div>
            <div>
              <span class="detail-label">Linguistic Sentiment</span>
              <div style="margin-top:4px; font-family:var(--font-mono); font-weight:700; color:${c.ai_sentiment_score > 0 ? '#58a6ff' : (c.ai_sentiment_score < 0 ? '#ff7b72' : '#cbd5e1')}">
                ${c.ai_sentiment_score !== null && c.ai_sentiment_score !== undefined ? (c.ai_sentiment_score > 0 ? '+' : '') + Number(c.ai_sentiment_score).toFixed(2) : '0.00'} / 1.00
              </div>
            </div>
            <div>
              <span class="detail-label">Model Confidence</span>
              <div style="margin-top:4px; font-family:var(--font-mono); font-size:13px; font-weight:700; color:var(--accent-gold);">
                ${aiConfPct}% High Conviction
              </div>
            </div>
          </div>

          <div style="font-size:12px; line-height:1.5; color:var(--text-primary); background:var(--bg-canvas); padding:10px 12px; border-radius:4px; border:1px solid var(--border-subtle);">
            <strong style="color:var(--accent-gold);">AI Model Reasoning:</strong> ${c.ai_reasoning || 'AI stance evaluated from strategist commentary and target return vector.'}
          </div>

          <div>
            <div style="font-size:10px; font-family:var(--font-mono); color:var(--text-muted); margin-bottom:4px; text-transform:uppercase;">Identified Macro &amp; Risk Drivers:</div>
            ${driversHtml}
          </div>
        </div>
      </div>
    `;

    // Target Level / Primary Stance Display
    let targetDisplay = '\u2014';
    if (c.target_level) {
      targetDisplay = Number(c.target_level).toLocaleString();
    } else if (c.allocation_stance) {
      targetDisplay = `${String(c.allocation_stance).toUpperCase()} (${c.allocation_asset || 'SPX'} vs ${c.allocation_benchmark || 'ACWI'})`;
    } else if (c.probability_value !== null && c.probability_value !== undefined) {
      targetDisplay = `${(Number(c.probability_value) * 100).toFixed(0)}% Probability (${c.probability_event || 'Recession'})`;
    }

    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">Target / Stance Level</span>
          <div class="detail-value">${targetDisplay}</div>
        </div>
        <div class="detail-item">
          <span class="detail-label">Spot at Publication</span>
          <div class="detail-value">${c.spot_at_publication ? Number(c.spot_at_publication).toFixed(2) : '\u2014'}</div>
        </div>
        <div class="detail-item">
          <span class="detail-label">Scored Stance (2% band)</span>
          <div class="detail-value">
            <span class="badge-stance ${escapeHtml(scoredStance)}">${escapeHtml(String(scoredStance).toUpperCase())}</span>
          </div>
        </div>
        <div class="detail-item">
          <span class="detail-label">Implied Return / Spread</span>
          <div class="detail-value" style="color:var(--accent-gold);">
            ${c.implied_return !== null && c.implied_return !== undefined ? `${c.implied_return >= 0 ? '+' : ''}${(c.implied_return * 100).toFixed(2)}%` : '\u2014'}
          </div>
        </div>
        <div class="detail-item">
          <span class="detail-label">Strategist Byline</span>
          <div class="detail-value" style="font-size:12px;">${c.strategist_name || 'Desk Team'}</div>
        </div>
        <div class="detail-item">
          <span class="detail-label">Confidence &amp; Horizon</span>
          <div class="detail-value" style="font-size:12px;">${c.confidence || 'verified'} (${c.forecast_horizon || 'YE_2026'})</div>
        </div>
      </div>

      ${aiAuditHtml}
      ${multiHorizonHtml}
      ${ladderHtml}

      <div class="section-drawer">
        <h4>SOURCE &amp; CITATION</h4>
        <div class="source-box">
          ${c.notes ? `<p style="margin-bottom:8px;"><strong>Desk Note:</strong> ${c.notes}</p>` : ''}
          ${c.source_title ? `<p><strong>Headline:</strong> ${c.source_title}</p>` : ''}
          ${c.source_snippet ? `<p style="margin-top:6px; font-style:italic;">&ldquo;${c.source_snippet}&rdquo;</p>` : ''}
          ${c.source_url ? `<a href="${c.source_url}" target="_blank" rel="noopener noreferrer" class="source-link">Read full publisher article &nearr;</a>` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div style="color:#f87171; padding:20px;">Failed to load call detail: ${err.message}</div>`;
  }
}

function closeModal() {
  const modal = document.getElementById('modalBackdrop');
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
