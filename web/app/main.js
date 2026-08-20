/**
 * main.js — the shell.
 *
 * Owns the frame (tape, command bar, rail, panel grid, status bar), the global
 * keyboard map, and the module lifecycle. Modules are loaded on demand and get
 * a context object; they never touch the shell directly.
 */

import { h, mount, clear, icon, qs } from './core/dom.js';
import { bus } from './core/bus.js';
import { store, applyChrome } from './core/store.js';
import * as api from './core/api.js';
import * as router from './core/router.js';
import { bind, clearScope, install as installKeys, describe, keycaps, IS_MAC } from './core/keys.js';
import { Panel } from './ui/panel.js';
import { Tape } from './ui/tape.js';
import { Palette, Sheet } from './ui/palette.js';
import { NavMenu } from './ui/navmenu.js';
import { Drawer, toast } from './ui/overlays.js';
import { date, ago, num } from './core/fmt.js';

/* ------------------------------ module registry --------------------------
   Order here is the tab order and the 1..7 key order. `endpoints` drives
   hover-prefetch: pointing at a tab warms everything that tab will ask for,
   so the switch itself is a render rather than a round trip. */

const MODULES = [
  { id: 'forecasts',   title: 'Forecasts',   short: 'FCST', icon: 'target', blurb: 'Sell-side price targets scored against what the market did',   fkey: 'f3',
    load: () => import('./modules/forecasts.js'),
    endpoints: ['/api/stats', '/api/scorecard', '/api/partners', '/api/timeline', '/api/calls'] },
  { id: 'mag7',        title: 'Mag 7',       short: 'MAG7', icon: 'layers', blurb: 'Big-tech calls audited for alpha against SPY',   fkey: 'f4',
    load: () => import('./modules/mag7.js'),
    endpoints: ['/api/mag7/stats', '/api/mag7/stocks', '/api/mag7/scorecard', '/api/mag7/themes', '/api/mag7/market-series'] },
  { id: 'seasonality', title: 'Seasonality', short: 'SEAS', icon: 'calendar', blurb: '27 years of monthly returns and day-of-year paths', fkey: 'f5',
    load: () => import('./modules/seasonality.js'),
    endpoints: ['/api/analytics/multi-asset', '/api/analytics/seasonality', '/api/analytics/seasonality-curves', '/api/analytics/call-patterns'] },
  { id: 'options',     title: 'Options',     short: 'OPT',  icon: 'sliders', blurb: 'Greeks, skew and dealer gamma from the observed chain',  fkey: 'f6',
    load: () => import('./modules/options.js'),
    endpoints: ['/api/analytics/options'] },
  { id: 'macro',       title: 'Macro',       short: 'MACR', icon: 'radio', blurb: 'Regime, fear & greed, rotation and the volatility curve',    fkey: 'f7',
    load: () => import('./modules/macro.js'),
    endpoints: ['/api/macro/regime', '/api/macro/fear-greed', '/api/macro/vix-structure', '/api/macro/commodities', '/api/analytics/sectors', '/api/analytics/correlation', '/api/macro/history'] },
  { id: 'agents',      title: 'AI Desk',     short: 'AI',   icon: 'cpu', blurb: 'News wire, insider flow and the research desk',      fkey: 'f8',
    load: () => import('./modules/agents.js'),
    endpoints: ['/api/agents/status', '/api/news/feed', '/api/news/market-wraps', '/api/alpha/insider-trades', '/api/alpha/smart-money'] },
  { id: 'crypto',      title: 'Crypto',      short: 'CRYP', icon: 'coin', blurb: 'Spot, ETF flows and the Bitcoin halving cycle',     fkey: 'f9',
    load: () => import('./modules/crypto.js'),
    endpoints: ['/api/crypto/overview', '/api/crypto/sentiment', '/api/crypto/halving-cycles', '/api/crypto/correlations', '/api/crypto/history'] },
];
const byId = new Map(MODULES.map((m) => [m.id, m]));

/* --------------------------------- chrome -------------------------------- */

applyChrome();

const tape = Tape();
const palette = Palette();
const drawer = Drawer();
const sheet = Sheet(describe);

const tabsEl = h('nav.tabs', { role: 'tablist', 'aria-label': 'Modules' });
const tabNodes = new Map();

MODULES.forEach((m, i) => {
  const a = h('a.tab', {
    href: router.build(m.id, {}),
    role: 'tab',
    id: `tab-${m.id}`,
    title: `${m.title} — press ${i + 1}`,
    onMouseEnter: () => api.prefetch(m.endpoints),
    onFocus: () => api.prefetch(m.endpoints),
  }, h('span.tab__n', String(i + 1).padStart(2, '0')),
     h('span.tab__label', m.title),
     h('span.tab__short', m.short),
     h('span.tab__dot'));
  tabsEl.appendChild(a);
  tabNodes.set(m.id, a);
});

const asOfEl = h('b', '—');
const latencyEl = h('b', '—');
const rowsEl = h('b', '—');
const syncEl = h('b', 'checking');
const modeEl = h('b', '—');

const omnibox = h('button.omnibox', {
  type: 'button', 'aria-label': 'Open command palette',
  onClick: () => palette.show(),
},
  icon('search', 13),
  h('span', 'Search or run a command'),
  h('kbd', IS_MAC ? '⌘K' : 'Ctrl K'));

const liveDot = h('span.dot.dot--live');
const livePill = h('span.pill', liveDot, h('span', 'LIVE'));

const navMenu = NavMenu({
  modules: MODULES,
  isCurrent: (id) => router.route().id === id,
  onPick: (id) => router.go(id, {}),
  onSearch: () => palette.show(),
});

const bar = h('header.bar',
  h('div.bar__brand',
    h('img', { src: 'images/logo.png', alt: 'MomentumQ', height: 18 }),
    h('span.bar__brand-mark', 'TERMINAL'),
    navMenu.trigger),
  tabsEl,
  h('div.bar__right',
    omnibox,
    h('button.btn.btn--ghost.btn--icon', { type: 'button', title: 'Refresh this module (R)', 'aria-label': 'Refresh', onClick: () => refresh() }, icon('refresh', 13)),
    h('button.btn.btn--ghost.btn--icon', { type: 'button', title: 'Keyboard shortcuts (?)', 'aria-label': 'Shortcuts', onClick: () => sheet.show() }, icon('keyboard', 13)),
    livePill));

const rail = h('aside.rail', { 'aria-label': 'Module controls' });
const grid = h('div.grid', { id: 'grid' });
const work = h('div.work', rail, grid);

const status = h('footer.status', { role: 'contentinfo' },
  h('div.status__group', 'AS OF', asOfEl),
  h('div.status__group', 'SYNC', syncEl),
  h('div.status__group', 'VIEW', modeEl),
  h('div.status__group', 'ROWS', rowsEl),
  h('div.status__spacer'),
  h('div.status__group.status__hint.status__hint--wide', h('kbd', '1'), '–', h('kbd', '7'), 'module'),
  h('div.status__group.status__hint.status__hint--wide', h('kbd', 'J'), h('kbd', 'K'), 'rows'),
  h('div.status__group.status__hint', h('kbd', 'F'), 'zoom'),
  h('div.status__group.status__hint', h('kbd', '?'), 'keys'),
  h('div.status__group', 'API', latencyEl));

const shell = h('div#shell', tape.el, bar, work, status);

document.body.append(shell, navMenu.el, palette.scrim, palette.el, drawer.scrim, drawer.el, sheet.scrim, sheet.el);

/* ------------------------------ module lifecycle ------------------------- */

let active = null;         // {id, mod, instance}
let loadToken = 0;

function setTab(id) {
  for (const [mid, node] of tabNodes) {
    if (mid === id) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
}

function busy(id, on) {
  tabNodes.get(id)?.classList.toggle('is-loading', on);
  liveDot.className = 'dot' + (on ? ' dot--warn' : ' dot--live');
}

/** The context every module receives. It is the only shell surface they see. */
function makeCtx(m) {
  const panels = [];
  return {
    id: m.id,
    rail,
    grid,
    drawer,
    toast,
    get params() { return router.route().params; },
    patch: (p) => router.patch(p),
    go: (id, p) => router.go(id, p),
    prefs: store.mod(m.id),
    savePrefs: (p) => store.setMod(m.id, p),

    /** Declare the panel grid. Areas are plain CSS grid template strings. */
    layout({ cols, rows, areas }) {
      grid.style.setProperty('--grid-cols', cols);
      grid.style.setProperty('--grid-rows', rows);
      grid.style.setProperty('--grid-areas', areas);
    },
    panel(opt) {
      const p = Panel(opt);
      grid.appendChild(p.el);
      panels.push(p);
      return p;
    },
    /** Rail content, with an optional header row. */
    railHead(...kids) {
      const head = h('div.rail__head', ...kids);
      rail.appendChild(head);
      return head;
    },
    railBody(...kids) {
      const b = h('div.rail__body.scroll', ...kids);
      rail.appendChild(b);
      return b;
    },
    railFoot(...kids) {
      const f = h('div.rail__foot', ...kids);
      rail.appendChild(f);
      return f;
    },
    bind: (combo, fn, meta) => bind('module', combo, fn, { group: m.title, ...meta }),
    setStatus({ asOf, rows, mode }) {
      if (asOf !== undefined) asOfEl.textContent = asOf ? date(asOf) : '—';
      if (rows !== undefined) rowsEl.textContent = rows === null ? '—' : num(rows, 0);
      if (mode !== undefined) modeEl.textContent = mode || '—';
    },
    /** Contribute commands to the palette for as long as this module lives. */
    commands(fn) { palette.provide('module:' + m.id, fn); },
    panels,
  };
}

async function activate(id, params) {
  const m = byId.get(id) || MODULES[0];
  const token = ++loadToken;

  if (active?.id === m.id) {
    active.instance?.onParams?.(params);
    return;
  }

  // Tear down cleanly: panels, rail, module keybindings and palette commands.
  if (active) {
    try { active.instance?.destroy?.(); } catch (e) { console.error(e); }
    palette.unprovide('module:' + active.id);
  }
  clearScope('module');
  clear(grid);
  clear(rail);
  grid.classList.remove('is-zoomed');
  drawer.close();

  setTab(m.id);
  busy(m.id, true);
  store.set('lastModule', m.id);
  document.title = `${m.title} — MomentumQ Terminal`;

  const ctx = makeCtx(m);
  ctx.setStatus({ asOf: null, rows: null, mode: m.title });

  try {
    const mod = await m.load();
    if (token !== loadToken) return;                 // a newer switch won
    const instance = await mod.mount(ctx);
    if (token !== loadToken) { instance?.destroy?.(); return; }
    active = { id: m.id, mod, instance, ctx };
  } catch (err) {
    console.error('[module]', m.id, err);
    clear(grid);
    grid.style.setProperty('--grid-cols', '1fr');
    grid.style.setProperty('--grid-rows', '1fr');
    grid.style.setProperty('--grid-areas', '"a"');
    const p = Panel({ id: 'err', title: m.title, zoomable: false });
    grid.appendChild(p.el);
    p.error(err, () => activate(m.id, params));
    active = { id: m.id, instance: null };
  } finally {
    if (token === loadToken) busy(m.id, false);
  }

  // Warm the neighbouring tabs once this one has settled.
  const i = MODULES.indexOf(m);
  api.prefetch([...(MODULES[i + 1]?.endpoints || []), ...(MODULES[i - 1]?.endpoints || [])].slice(0, 6));
}

function refresh() {
  const id = active?.id;
  if (!id) return;
  const m = byId.get(id);
  m.endpoints.forEach((e) => api.invalidate(e));
  api.invalidate('/api/pipeline');
  const inst = active.instance;
  if (inst?.reload) { inst.reload(); toast(`${m.title} reloaded`, 'ok', 1600); }
  else { active = null; activate(id, router.route().params); }
  tape.reload();
}

/* --------------------------------- keys ---------------------------------- */

installKeys();

bind('global', 'mod+k', () => (palette.isOpen ? palette.close() : palette.show()), { label: 'Command palette', group: 'Global' });
bind('global', '/', () => palette.show(), { label: 'Search', group: 'Global', hidden: true });
bind('global', '?', () => sheet.show(), { label: 'Keyboard shortcuts', group: 'Global' });
bind('global', 'm', () => navMenu.show(), { label: 'Browse all modules', group: 'Navigation' });

MODULES.forEach((m, i) => {
  bind('global', [String(i + 1), m.fkey], () => router.go(m.id, {}), {
    label: `Go to ${m.title}`, group: 'Navigation',
  });
});

bind('global', 'r', () => refresh(), { label: 'Refresh module', group: 'Global' });
/* The rail is a fixed column on a wide screen and an overlay on a narrow one.
   The preference is only persisted from the wide case, so summoning the
   overlay on a laptop-sized window does not force the rail open next time
   someone opens the terminal on a monitor.

   The breakpoint itself is never written here: `--narrow` is set by the same
   media query that restyles the rail, so this code cannot disagree with the
   stylesheet about which layout is on screen. */
const isNarrow = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--narrow').trim() === '1';

function setRail(next) {
  document.documentElement.dataset.rail = next;
  if (!isNarrow()) store.set('rail', next);
  bus.emit('layout');
}
function syncRail() {
  document.documentElement.dataset.rail = isNarrow() ? 'off' : store.get('rail');
  bus.emit('layout');
}

let wasNarrow = isNarrow();
window.addEventListener('resize', () => {
  const now = isNarrow();
  if (now === wasNarrow) return;   // also stops layout events re-entering here
  wasNarrow = now;
  syncRail();
});
syncRail();

// On the overlay layout, choosing something in the rail dismisses it.
rail.addEventListener('click', (e) => {
  if (isNarrow() && e.target.closest('button')) setRail('off');
});

bind('global', 'backslash', () => {
  setRail(document.documentElement.dataset.rail === 'on' ? 'off' : 'on');
}, { label: 'Toggle side rail', group: 'View' });
bind('global', 'd', () => {
  const next = store.get('density') === 'compact' ? 'comfortable' : 'compact';
  store.set('density', next);
  applyChrome();
  toast(`Density: ${next}`, 'info', 1400);
  bus.emit('layout');
}, { label: 'Toggle density', group: 'View' });
bind('global', 't', () => {
  const order = ['obsidian', 'amber', 'phosphor'];
  const next = order[(order.indexOf(store.get('theme')) + 1) % order.length];
  store.set('theme', next);
  applyChrome();
  toast(`Theme: ${next}`, 'info', 1400);
  bus.emit('layout');
}, { label: 'Cycle theme', group: 'View' });

bind('global', 'f', () => {
  const p = active?.ctx?.panels?.find((x) => x.el.matches(':hover')) ||
            active?.ctx?.panels?.find((x) => x.el.contains(document.activeElement)) ||
            active?.ctx?.panels?.[0];
  if (!p) return;
  const on = !p.isZoomed;
  active.ctx.panels.forEach((x) => x.isZoomed && x.zoom(false));
  if (on) p.zoom(true);
  bus.emit('layout');
}, { label: 'Maximise panel under cursor', group: 'View' });

bind('global', 'escape', () => {
  const z = active?.ctx?.panels?.find((p) => p.isZoomed);
  if (z) { z.zoom(false); bus.emit('layout'); return; }
  if (drawer.isOpen) drawer.close();
}, { label: 'Close / restore', group: 'Global' });

bind('global', 'bracketright', () => cycleModule(1), { label: 'Next module', group: 'Navigation' });
bind('global', 'bracketleft', () => cycleModule(-1), { label: 'Previous module', group: 'Navigation' });

function cycleModule(step) {
  const i = MODULES.findIndex((m) => m.id === active?.id);
  const next = MODULES[(i + step + MODULES.length) % MODULES.length];
  router.go(next.id, {});
}

/* Documentation-only entries. They live on a scope that is never pushed, so
   they never fire — they exist so the shortcut sheet describes behaviour that
   components own (table row navigation) rather than the shell. */
const doc = (combo, label, group) => bind('docs', combo, () => {}, { label, group });
doc('j', 'Next row', 'Tables & lists');
doc('k', 'Previous row', 'Tables & lists');
doc('enter', 'Open the selected row', 'Tables & lists');
doc('home', 'First row', 'Tables & lists');
doc('end', 'Last row', 'Tables & lists');
doc('mod+f', 'Focus the panel filter', 'Tables & lists');

/* ------------------------- global palette commands ----------------------- */

palette.provide('shell', () => {
  const cmds = MODULES.map((m, i) => ({
    id: 'go:' + m.id, group: 'Modules', title: m.title, icon: m.icon,
    hint: String(i + 1), keywords: m.short + ' ' + m.id,
    boost: 40, pinned: true,
    run: () => router.go(m.id, {}),
  }));
  cmds.push(
    { id: 'x:density', group: 'View', title: 'Toggle density (compact / comfortable)', icon: 'sliders', hint: 'D', pinned: true,
      run: () => { store.set('density', store.get('density') === 'compact' ? 'comfortable' : 'compact'); applyChrome(); bus.emit('layout'); } },
    { id: 'x:theme', group: 'View', title: 'Cycle theme (obsidian / amber / phosphor)', icon: 'moon', hint: 'T', pinned: true,
      run: () => { const o = ['obsidian', 'amber', 'phosphor']; store.set('theme', o[(o.indexOf(store.get('theme')) + 1) % o.length]); applyChrome(); bus.emit('layout'); } },
    { id: 'x:rail', group: 'View', title: 'Toggle side rail', icon: 'table', hint: '\\', pinned: true,
      run: () => setRail(document.documentElement.dataset.rail === 'on' ? 'off' : 'on') },
    { id: 'x:tape', group: 'View', title: 'Pause / resume the market tape', icon: 'radio', pinned: true,
      run: () => { const p = tape.el.classList.toggle('tape--paused'); store.set('tapePaused', p); } },
    { id: 'x:refresh', group: 'Data', title: 'Refresh this module', icon: 'refresh', hint: 'R', pinned: true, run: refresh },
    { id: 'x:sync', group: 'Data', title: 'Run pipeline sync now', icon: 'bolt', pinned: true, run: runSync },
    { id: 'x:keys', group: 'Help', title: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', pinned: true, run: () => sheet.show() },
    { id: 'x:menu', group: 'Help', title: 'Browse all modules', icon: 'grid', hint: 'M', pinned: true, run: () => navMenu.show() },
    { id: 'x:reset', group: 'Help', title: 'Reset saved layout and preferences', icon: 'warn', pinned: true,
      run: () => { store.reset(); applyChrome(); toast('Preferences reset', 'ok'); location.reload(); } },
  );
  return cmds;
});

/* --------------------------------- sync ---------------------------------- */

async function runSync() {
  syncEl.textContent = 'running…';
  liveDot.className = 'dot dot--warn';
  const done = toast('Pipeline sync started…', 'info', 30000);
  try {
    const res = await api.post('/api/pipeline/sync');
    api.invalidate();
    done();
    toast(res?.status === 'success' ? 'Sync complete — data refreshed' : `Sync: ${res?.status || 'done'}`, 'ok');
    syncEl.textContent = 'just now';
    tape.reload();
    refresh();
  } catch (err) {
    done();
    toast(`Sync failed: ${err.message}`, 'err', 6000);
    syncEl.textContent = 'failed';
  } finally {
    liveDot.className = 'dot dot--live';
  }
}

/* -------------------------------- status --------------------------------- */

bus.on('api:done', () => { latencyEl.textContent = `${api.stats.lastMs} ms`; });
bus.on('api:error', () => { liveDot.className = 'dot dot--err'; setTimeout(() => { liveDot.className = 'dot dot--live'; }, 2500); });

api.get('/api/stats').then((s) => {
  asOfEl.textContent = date(s.as_of_date);
  syncEl.textContent = s.option_chain?.snapshot_date ? `chain ${date(s.option_chain.snapshot_date)}` : 'daily 12:00';
}).catch(() => { syncEl.textContent = 'unavailable'; });

/* ------------------------------- first run ------------------------------- */

if (!store.get('seenCoach')) {
  const coach = h('div.coach',
    icon('keyboard', 14),
    h('span', 'Press '), h('kbd', IS_MAC ? '⌘' : 'Ctrl'), h('kbd', 'K'),
    h('span', ' for anything, '), h('kbd', '1'), h('span', '–'), h('kbd', '7'), h('span', ' to switch module, '),
    h('kbd', '?'), h('span', ' for all shortcuts'),
    h('button.btn.btn--ghost.btn--icon', { onClick: () => { coach.remove(); store.set('seenCoach', true); }, 'aria-label': 'Dismiss' }, icon('close', 12)));
  document.body.appendChild(coach);
  setTimeout(() => { coach.remove(); store.set('seenCoach', true); }, 14000);
}

/* --------------------------------- boot ---------------------------------- */

bus.on('route', ({ id, params }) => activate(id, params));
router.start(store.get('lastModule') || 'forecasts');

// Re-measure charts after any layout-affecting change.
bus.on('layout', () => window.dispatchEvent(new Event('resize')));

window.MQ = { api, store, router, toast, MODULES };
