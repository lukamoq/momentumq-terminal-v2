/**
 * table.js — the blotter.
 *
 * Sortable, filterable, keyboard-navigable. Rows above a threshold are
 * windowed so a long call log costs the same as a short one.
 *
 * Keyboard contract (active while the table has focus):
 *   j / ArrowDown   next row        k / ArrowUp   previous row
 *   Enter           open the row    Home / End    first / last
 *   PageUp/Down     jump a screen
 */

import { h, mount, clear, icon } from '../core/dom.js';

const WINDOW_AFTER = 400;   // below this, rendering everything is cheaper
const OVERSCAN = 12;

/**
 * @param {object} o
 * @param {Array}  o.columns  {key,label,align,width,sortable,sort,render,cls,title}
 * @param {Array}  o.rows
 * @param {Function} [o.rowKey]
 * @param {Function} [o.onOpen]     Enter / click-through
 * @param {Function} [o.onSelect]   cursor moved
 * @param {string}  [o.sort]        initial column key
 * @param {number}  [o.dir]         1 asc, -1 desc
 * @param {string}  [o.empty]       empty-state copy
 */
export function DataTable(o) {
  const cols = o.columns.filter(Boolean);
  const key = o.rowKey || ((r, i) => r.id ?? i);

  let rows = o.rows || [];
  let view = rows;
  let sortKey = o.sort || null;
  let sortDir = o.dir ?? -1;
  let cursor = -1;
  let selectedKey = o.selectedKey ?? null;

  const thead = h('thead');
  const tbody = h('tbody');
  const table = h('table.tbl', thead, tbody);
  const padTop = h('tr', { style: { height: '0px' } }, h('td', { colspan: cols.length }));
  const padBot = h('tr', { style: { height: '0px' } }, h('td', { colspan: cols.length }));

  const wrap = h('div.scroll.tblwrap', { tabindex: '0', role: 'grid', 'aria-label': o.label || 'Data table' }, table);

  // ---- head -------------------------------------------------------------
  // Sorting is a primary action, so the headers are real controls: focusable,
  // activated by Enter or Space, and announced through aria-sort. Rebuilding
  // the row on every sort would drop focus, so a keyboard sort restores it.
  let refocusKey = null;

  function buildHead() {
    const tr = h('tr');
    for (const c of cols) {
      const isSorted = sortKey === c.key;
      const sortable = c.sortable !== false;
      const th = h('th' + (c.align === 'right' ? '.num' : '') + (c.cls ? '.' + c.cls : '') +
        (sortable ? '.is-sortable' : ''), {
        scope: 'col',
        role: 'columnheader',
        tabindex: sortable ? '0' : null,
        style: c.width ? { width: c.width } : null,
        title: c.title || (sortable ? `Sort by ${c.label}` : ''),
        'aria-sort': isSorted ? (sortDir === 1 ? 'ascending' : 'descending') : null,
      }, c.label,
        sortable ? h('span.sortmark', isSorted ? (sortDir === 1 ? '▲' : '▼') : '') : null);
      th.dataset.k = c.key;
      if (sortable) {
        th.addEventListener('click', () => toggleSort(c));
        th.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          // Otherwise Enter also reaches the row handler on the scroller.
          e.stopPropagation();
          refocusKey = c.key;
          toggleSort(c);
        });
      }
      tr.appendChild(th);
    }
    mount(thead, tr);
    if (refocusKey) {
      thead.querySelector(`th[data-k="${cssEscape(refocusKey)}"]`)?.focus();
      refocusKey = null;
    }
  }

  function toggleSort(c) {
    if (sortKey === c.key) sortDir = -sortDir;
    else { sortKey = c.key; sortDir = c.defaultDir ?? -1; }
    apply();
  }

  // ---- data -------------------------------------------------------------
  function valueOf(row, c) {
    if (c.sort) return c.sort(row);
    const v = row[c.key];
    return v === null || v === undefined ? null : v;
  }

  function apply() {
    view = rows.slice();
    if (sortKey) {
      const c = cols.find((x) => x.key === sortKey);
      if (c) {
        view.sort((a, b) => {
          const x = valueOf(a, c);
          const y = valueOf(b, c);
          // Missing values always sink, in either direction. A blank cell is
          // not "the smallest value", it is the absence of one.
          if (x === null && y === null) return 0;
          if (x === null) return 1;
          if (y === null) return -1;
          if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
          return String(x).localeCompare(String(y)) * sortDir;
        });
      }
    }
    buildHead();
    draw();
  }

  // ---- render -----------------------------------------------------------
  const windowed = () => view.length > WINDOW_AFTER;

  function rowHeight() {
    const px = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
    return parseInt(px, 10) || 26;
  }

  function buildRow(r, i) {
    const k = String(key(r, i));
    const tr = h('tr', {
      'data-k': k,
      role: 'row',
      tabindex: '-1',
      'aria-selected': selectedKey !== null && k === String(selectedKey) ? 'true' : null,
    });
    if (o.onOpen || o.onSelect) tr.classList.add('is-clickable');
    for (const c of cols) {
      const td = h('td' + (c.align === 'right' ? '.num' : '') + (c.strong ? '.strong' : '') +
        (c.wrap ? '.wrap' : '') + (c.cls ? '.' + c.cls : ''));
      const out = c.render ? c.render(r, i) : (r[c.key] ?? '—');
      if (out === null || out === undefined) td.textContent = '—';
      else if (out.nodeType) td.appendChild(out);
      else td.textContent = String(out);
      if (c.cellTitle) td.title = c.cellTitle(r) || '';
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => { setCursor(view.indexOf(r), false); if (o.onOpen) o.onOpen(r); });
    return tr;
  }

  function draw() {
    if (!view.length) {
      mount(tbody, h('tr', h('td', {
        colspan: cols.length,
        style: { height: '90px', textAlign: 'center', color: 'var(--ink-4)', whiteSpace: 'normal' },
      }, o.empty || 'No rows match the current filter')));
      return;
    }
    if (!windowed()) {
      const f = document.createDocumentFragment();
      view.forEach((r, i) => f.appendChild(buildRow(r, i)));
      clear(tbody);
      tbody.appendChild(f);
      return;
    }
    drawWindow();
  }

  function drawWindow() {
    const rh = rowHeight();
    const top = wrap.scrollTop;
    const vis = Math.ceil(wrap.clientHeight / rh) + OVERSCAN * 2;
    const start = Math.max(0, Math.floor(top / rh) - OVERSCAN);
    const end = Math.min(view.length, start + vis);
    const f = document.createDocumentFragment();
    padTop.firstChild.style.height = `${start * rh}px`;
    padBot.firstChild.style.height = `${(view.length - end) * rh}px`;
    f.appendChild(padTop);
    for (let i = start; i < end; i++) f.appendChild(buildRow(view[i], i));
    f.appendChild(padBot);
    clear(tbody);
    tbody.appendChild(f);
  }

  let rafPending = false;
  wrap.addEventListener('scroll', () => {
    if (!windowed() || rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; drawWindow(); });
  }, { passive: true });

  // ---- cursor -----------------------------------------------------------
  function setCursor(i, scroll = true) {
    if (!view.length) return;
    cursor = Math.max(0, Math.min(view.length - 1, i));
    const row = view[cursor];
    selectedKey = String(key(row, cursor));
    tbody.querySelectorAll('tr.is-cursor').forEach((t) => t.classList.remove('is-cursor'));
    if (windowed() && scroll) {
      const rh = rowHeight();
      const y = cursor * rh;
      if (y < wrap.scrollTop || y + rh > wrap.scrollTop + wrap.clientHeight - 24) {
        wrap.scrollTop = y - wrap.clientHeight / 2;
      }
      drawWindow();
    }
    const tr = tbody.querySelector(`tr[data-k="${cssEscape(selectedKey)}"]`);
    if (tr) {
      tr.classList.add('is-cursor');
      if (scroll && !windowed()) tr.scrollIntoView({ block: 'nearest' });
    }
    if (o.onSelect) o.onSelect(row, cursor);
  }

  function cssEscape(v) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"');
  }

  wrap.addEventListener('keydown', (e) => {
    // Row navigation is unmodified keys only. Without this guard the `k`
    // binding eats Cmd/Ctrl+K and the command palette never opens while a
    // blotter has focus — which is most of the time.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === 'j' || k === 'ArrowDown') setCursor(cursor + 1);
    else if (k === 'k' || k === 'ArrowUp') setCursor(cursor < 0 ? 0 : cursor - 1);
    else if (k === 'Home') setCursor(0);
    else if (k === 'End') setCursor(view.length - 1);
    else if (k === 'PageDown') setCursor(cursor + Math.floor(wrap.clientHeight / rowHeight()));
    else if (k === 'PageUp') setCursor(cursor - Math.floor(wrap.clientHeight / rowHeight()));
    else if (k === 'Enter' && cursor > -1 && o.onOpen) o.onOpen(view[cursor]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });

  apply();

  return {
    el: wrap,
    table,
    get view() { return view; },
    get count() { return view.length; },
    get total() { return rows.length; },
    setRows(next) { rows = next || []; cursor = -1; apply(); },
    /** Client-side filter that keeps the current sort. */
    filter(fn) {
      view = (fn ? rows.filter(fn) : rows.slice());
      if (sortKey) {
        const c = cols.find((x) => x.key === sortKey);
        if (c) view.sort((a, b) => {
          const x = valueOf(a, c); const y = valueOf(b, c);
          if (x === null && y === null) return 0;
          if (x === null) return 1;
          if (y === null) return -1;
          if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
          return String(x).localeCompare(String(y)) * sortDir;
        });
      }
      wrap.scrollTop = 0;
      draw();
      return view.length;
    },
    select(k) { selectedKey = k === null ? null : String(k); draw(); },
    focus() { wrap.focus(); if (cursor < 0 && view.length) setCursor(0); },
    next() { setCursor(cursor + 1); },
    prev() { setCursor(cursor < 0 ? 0 : cursor - 1); },
    open() { if (cursor > -1 && o.onOpen) o.onOpen(view[cursor]); },
  };
}

/** A numeric cell backed by an inline magnitude bar. */
export function barCell(text, ratio, color) {
  return h('span.cellbar', {
    style: { '--w': `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`, '--bar-c': color || 'var(--brand-wash)' },
  }, h('span', text));
}

/** Toolbar search box wired to a callback, debounced to a frame. */
export function searchBox(placeholder, onInput) {
  const input = h('input.input', { type: 'search', placeholder, 'aria-label': placeholder });
  let t = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => onInput(input.value.trim()), 90);
  });
  const box = h('div.search.grow', icon('search', 12), input);
  box.focusInput = () => { input.focus(); input.select(); };
  box.clear = () => { input.value = ''; onInput(''); };
  return box;
}

/** Exclusive segmented control. */
export function segmented(items, value, onChange, opt = {}) {
  const el = h('div.seg', { role: 'tablist', 'aria-label': opt.label || 'Options' });
  const btns = items.map((it) => {
    const b = h('button', {
      type: 'button', role: 'tab',
      'aria-selected': String(it.value === value),
      title: it.title || it.label,
      onClick: () => {
        if (it.value === value) return;
        value = it.value;
        btns.forEach((x) => x.setAttribute('aria-selected', String(x.dataset.v === String(value))));
        onChange(value);
      },
    }, it.label);
    b.dataset.v = String(it.value);
    el.appendChild(b);
    return b;
  });
  el.setValue = (v) => { value = v; btns.forEach((x) => x.setAttribute('aria-selected', String(x.dataset.v === String(v)))); };
  return el;
}
