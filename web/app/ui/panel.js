/**
 * panel.js — the terminal's only container.
 *
 * A panel is always in exactly one of four states and says which. There is no
 * path through this code that leaves an empty rectangle on screen: if data is
 * missing the panel explains that it is missing, and if a request failed it
 * offers the retry rather than a console message nobody reads.
 */

import { h, icon, mount, clear } from '../core/dom.js';

let seq = 0;

export function Panel(opt = {}) {
  const id = opt.id || `p${++seq}`;
  const idxEl = opt.index ? h('span.panel__idx', opt.index) : null;
  const titleEl = h('span', opt.title || '');
  const metaEl = h('span.panel__meta', opt.meta || '');
  const tools = h('div.panel__tools');
  const body = h('div.panel__body' + (opt.pad ? '.panel__body--pad' : '') + (opt.flex ? '.panel__body--flex' : ''));
  const foot = opt.foot === false ? null : h('div.panel__foot', { hidden: true });

  const head = h('div.panel__head',
    h('div.panel__title', idxEl, titleEl),
    metaEl,
    tools);

  const el = h('section.panel', {
    id: `panel-${id}`,
    style: opt.area ? { gridArea: opt.area } : null,
    tabindex: '-1',
    role: 'region',
    'aria-label': opt.title || id,
  }, head, body, foot);

  if (opt.tools) opt.tools.forEach((t) => t && tools.appendChild(t));

  // Maximise — the panel fills the workspace, the rest of the grid is hidden.
  // Layout underneath is untouched, so restoring keeps every scroll offset.
  let zoomed = false;
  const zoomBtn = h('button.btn.btn--ghost.btn--icon', {
    type: 'button',
    title: 'Maximise panel (F)',
    'aria-label': 'Maximise panel',
    onClick: () => api.zoom(!zoomed),
  }, icon('expand', 13));
  if (opt.zoomable !== false) tools.appendChild(zoomBtn);

  let stateEl = null;
  function setState(node) {
    if (stateEl) stateEl.remove();
    stateEl = node;
    if (node) body.appendChild(node);
  }

  const api = {
    id, el, head, body, foot, tools,

    setTitle(t) { titleEl.textContent = t; el.setAttribute('aria-label', t); return api; },
    setMeta(t) { metaEl.textContent = t || ''; return api; },

    /** Replace the body content and clear any state overlay. */
    render(...kids) {
      setState(null);
      mount(body, ...kids);
      return api;
    },
    /** Add to the body without clearing (used for header + scroller pairs). */
    append(...kids) { setState(null); kids.forEach((k) => k && body.appendChild(k)); return api; },
    clear() { clear(body); stateEl = null; return api; },

    loading(shape = 'rows') {
      clear(body);
      const sk = h('div.sk-stack');
      if (shape === 'chart') {
        sk.append(h('div.sk.sk-row', { style: { width: '32%' } }), h('div.sk.sk-chart'));
      } else if (shape === 'kpi') {
        for (let i = 0; i < 4; i++) sk.append(h('div.sk', { style: { height: '46px' } }));
      } else {
        for (let i = 0; i < 9; i++) sk.append(h('div.sk.sk-row', { style: { width: `${94 - i * 4}%` } }));
      }
      stateEl = sk;
      body.appendChild(sk);
      return api;
    },

    empty(msg, title = 'No data for this selection') {
      clear(body);
      setState(h('div.state',
        h('div.state__icon', icon('empty', 22)),
        h('div.state__title', title),
        msg ? h('div.state__msg', msg) : null));
      return api;
    },

    /**
     * Errors name the endpoint and offer the retry. A terminal that silently
     * renders nothing on a 500 is worse than one that says so.
     */
    error(err, retry) {
      clear(body);
      const detail = err?.path ? `${err.path} — ${err.message}` : (err?.message || String(err));
      setState(h('div.state.state--error',
        h('div.state__icon', icon('warn', 22)),
        h('div.state__title', 'Could not load'),
        h('div.state__msg', detail),
        retry ? h('button.btn', { type: 'button', onClick: retry }, icon('refresh', 12), 'Retry') : null));
      return api;
    },

    setFoot(...kids) {
      if (!foot) return api;
      mount(foot, ...kids);
      foot.hidden = kids.filter(Boolean).length === 0;
      return api;
    },

    zoom(on) {
      const grid = el.parentElement;
      if (!grid) return api;
      zoomed = on;
      el.classList.toggle('is-zoomed', on);
      grid.classList.toggle('is-zoomed', on);
      // The area is an inline style, so it wins over any stylesheet rule —
      // it has to be swapped here rather than overridden in CSS.
      el.style.gridArea = on ? '1 / 1 / -1 / -1' : (opt.area || '');
      if (!on) {
        grid.querySelectorAll('.panel.is-zoomed').forEach((p) => p.classList.remove('is-zoomed'));
      }
      clear(zoomBtn);
      zoomBtn.appendChild(icon(on ? 'collapse' : 'expand', 13));
      zoomBtn.title = on ? 'Restore panel (Esc)' : 'Maximise panel (F)';
      el.dispatchEvent(new CustomEvent('panel:zoom', { bubbles: true, detail: { on, id } }));
      return api;
    },
    get isZoomed() { return zoomed; },
  };

  return api;
}

/** A scrolling region inside a panel body. */
export function scroller(...kids) {
  return h('div.scroll', { style: { position: 'absolute', inset: '0' } }, ...kids);
}

/** A padded scrolling region — the default for read-heavy side panels. */
export function padScroller(...kids) {
  return h('div.scroll', {
    style: { position: 'absolute', inset: '0', padding: 'var(--panel-pad)' },
  }, ...kids);
}

/** Chart host: absolutely positioned so the SVG measures the real box. */
export function chartHost() {
  return h('div.chart');
}
