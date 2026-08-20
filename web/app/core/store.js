/**
 * store.js — durable preferences.
 *
 * Everything an operator sets by hand survives a reload: theme, density,
 * rail state, per-module selections, watchlist. State the user did not choose
 * (scroll offsets, transient filters) deliberately does not.
 */

import { bus } from './bus.js';

const KEY = 'mq.terminal.v3';

const DEFAULTS = {
  theme: 'obsidian',
  density: 'comfortable',
  rail: 'on',
  tapePaused: false,
  seenCoach: false,
  lastModule: 'forecasts',
  watch: ['SPY', 'QQQ', 'NVDA', 'BTC'],
  mod: {},            // per-module persisted selections
};

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULTS }; }
}

let writeTimer = 0;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }, 180);
}

export const store = {
  get(k) { return state[k]; },
  all() { return state; },
  set(k, v) {
    if (state[k] === v) return v;
    state[k] = v;
    persist();
    bus.emit('store:' + k, v);
    bus.emit('store', { key: k, value: v });
    return v;
  },
  /** Per-module bag: store.mod('options').u === 'SPY' */
  mod(id) {
    if (!state.mod[id]) state.mod[id] = {};
    return state.mod[id];
  },
  setMod(id, patch) {
    state.mod[id] = { ...(state.mod[id] || {}), ...patch };
    persist();
    return state.mod[id];
  },
  reset() {
    state = { ...DEFAULTS };
    persist();
    bus.emit('store', { key: '*', value: null });
  },
};

/**
 * Apply the presentation prefs that live on <html>.
 *
 * Rail state is deliberately not set here: on a narrow viewport the rail is an
 * overlay whose open/closed state is not the saved preference, so the shell
 * owns it (see syncRail in main.js) and this function must not stamp over it.
 */
export function applyChrome() {
  const el = document.documentElement;
  el.dataset.theme = store.get('theme');
  el.dataset.density = store.get('density');
}
