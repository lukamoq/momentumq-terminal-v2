/**
 * palette.js — the command runner (⌘K).
 *
 * Everything reachable in the terminal is reachable from here: modules,
 * instruments, settings, and every panel action the active module registers.
 * Commands are contributed at runtime, so a module's own actions appear in the
 * palette without the palette knowing what modules exist.
 */

import { h, mount, icon, fuzzy, highlight } from '../core/dom.js';
import { bind, pushScope, popScope, keycaps } from '../core/keys.js';

export function Palette() {
  const input = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Search modules, instruments and commands…',
    'aria-label': 'Command palette', 'aria-controls': 'palList', 'aria-expanded': 'true',
  });
  const mode = h('span.pal__mode', { hidden: true });
  const list = h('div.pal__list.scroll#palList', { role: 'listbox' });
  const scrim = h('div.scrim', { hidden: true, onClick: () => close() });

  const el = h('div.pal', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    h('div.pal__in', icon('search', 15), input, mode),
    list,
    h('div.pal__foot',
      h('span', h('kbd', '↑'), h('kbd', '↓'), 'navigate'),
      h('span', h('kbd', '↵'), 'run'),
      h('span', h('kbd', 'Esc'), 'close'),
      h('span', { style: { marginLeft: 'auto' } }, h('kbd', '?'), 'all shortcuts')));

  /** @type {Array<{id,title,group,hint,icon,run,keywords}>} */
  let sources = [];
  let results = [];
  let sel = 0;
  let open = false;

  /** Providers are functions returning command arrays; modules add and remove. */
  const providers = new Map();
  function collect() {
    const out = [];
    for (const fn of providers.values()) {
      try { out.push(...(fn() || [])); } catch (e) { console.error('[palette provider]', e); }
    }
    return out;
  }

  function score(q) {
    if (!q) {
      // With no query, show a sensible starting set rather than everything.
      return sources
        .filter((c) => c.group !== 'Instruments' || c.pinned)
        .slice(0, 40)
        .map((c) => ({ c, ranges: [] }));
    }
    const scored = [];
    for (const c of sources) {
      const m = fuzzy(q, c.title);
      const km = !m && c.keywords ? fuzzy(q, c.keywords) : null;
      if (!m && !km) continue;
      scored.push({ c, ranges: m ? m.ranges : [], s: (m ? m.score : km.score - 40) + (c.boost || 0) });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 60);
  }

  function draw() {
    const q = input.value.trim();
    results = score(q);
    if (!results.length) {
      mount(list, h('div.pal__empty', `Nothing matches “${q}”`));
      return;
    }
    sel = Math.min(sel, results.length - 1);
    const f = document.createDocumentFragment();
    let group = null;
    results.forEach((r, i) => {
      if (r.c.group !== group) {
        group = r.c.group;
        f.appendChild(h('div.pal__grp', group));
      }
      const row = h('button.pal__i', {
        type: 'button', role: 'option', 'aria-selected': String(i === sel),
        onClick: () => run(i),
        onMouseEnter: () => select(i, false),
      },
        h('span.pal__ico', icon(r.c.icon || 'chevron', 13)),
        h('span.pal__t', highlight(r.c.title, r.ranges)),
        r.c.hint ? h('span.pal__d', r.c.hint) : null);
      row.dataset.i = String(i);
      f.appendChild(row);
    });
    mount(list, f);
  }

  function select(i, scroll = true) {
    if (!results.length) return;
    sel = (i + results.length) % results.length;
    list.querySelectorAll('.pal__i').forEach((n) => n.setAttribute('aria-selected', String(+n.dataset.i === sel)));
    if (scroll) list.querySelector(`.pal__i[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function run(i) {
    const r = results[i ?? sel];
    if (!r) return;
    close();
    // Let the overlay finish closing before the action moves focus.
    requestAnimationFrame(() => r.c.run());
  }

  function show(prefill = '') {
    if (open) { input.select(); return; }
    sources = collect();
    open = true;
    scrim.hidden = false;
    el.hidden = false;
    input.value = prefill;
    sel = 0;
    draw();
    // Force a style flush so the transition has a start value, then reveal.
    // rAF would be correct here in an active tab and never fire in a hidden
    // one, which would leave the overlay open at opacity 0.
    void el.offsetHeight;
    scrim.classList.add('is-on');
    el.classList.add('is-on');
    input.focus();
    input.select();
    pushScope('palette');
  }

  function close() {
    if (!open) return;
    open = false;
    el.classList.remove('is-on');
    scrim.classList.remove('is-on');
    popScope('palette');
    setTimeout(() => { el.hidden = true; scrim.hidden = true; }, 160);
  }

  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); select(sel + (e.shiftKey ? -1 : 1)); }
  });

  bind('palette', 'escape', close, { hidden: true });

  return {
    el, scrim, show, close,
    get isOpen() { return open; },
    /** Register a provider under a key; call again to replace, or remove. */
    provide(key, fn) { providers.set(key, fn); return () => providers.delete(key); },
    unprovide(key) { providers.delete(key); },
    setMode(text) { mode.textContent = text || ''; mode.hidden = !text; },
  };
}

/** Shortcut sheet — rendered from the live binding registry, never a hardcoded list. */
export function Sheet(describe) {
  const body = h('div.sheet__body');
  const scrim = h('div.scrim', { hidden: true, onClick: () => close() });
  const el = h('div.sheet', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' },
    h('div.sheet__head',
      icon('keyboard', 15),
      h('div', { style: { fontSize: 'var(--t-lead)', color: 'var(--ink-1)', fontWeight: '600' } }, 'Keyboard shortcuts'),
      h('button.btn.btn--ghost.btn--icon', { style: { marginLeft: 'auto' }, onClick: () => close(), 'aria-label': 'Close' }, icon('close', 13))),
    body);

  let open = false;

  function draw() {
    const groups = describe();
    const f = document.createDocumentFragment();
    for (const [name, rows] of groups) {
      const keys = h('div.keys');
      for (const r of rows) {
        keys.appendChild(h('div.keys__r',
          h('span', r.label),
          h('span.keys__k', ...keycaps(r.combo).map((k) => h('kbd', k)))));
      }
      f.appendChild(h('div', h('div.label', { style: { marginBottom: '8px' } }, name), keys));
    }
    mount(body, f);
  }

  function show() {
    if (open) return close();
    open = true;
    draw();
    scrim.hidden = false;
    el.hidden = false;
    // Force a style flush so the transition has a start value, then reveal.
    // rAF would be correct here in an active tab and never fire in a hidden
    // one, which would leave the overlay open at opacity 0.
    void el.offsetHeight;
    scrim.classList.add('is-on');
    el.classList.add('is-on');
    pushScope('sheet');
  }
  function close() {
    if (!open) return;
    open = false;
    el.classList.remove('is-on');
    scrim.classList.remove('is-on');
    popScope('sheet');
    setTimeout(() => { el.hidden = true; scrim.hidden = true; }, 160);
  }
  bind('sheet', 'escape', close, { hidden: true });
  bind('sheet', '?', close, { hidden: true });

  return { el, scrim, show, close, get isOpen() { return open; } };
}
