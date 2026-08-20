/**
 * overlays.js — toasts and the inspector drawer.
 *
 * The drawer is the terminal's single detail surface: any row in any module
 * opens into it, so "see everything about this record" is one keystroke and
 * one mental model rather than seven bespoke modals.
 */

import { h, mount, icon } from '../core/dom.js';
import { pushScope, popScope, bind } from '../core/keys.js';

/* --------------------------------- toasts -------------------------------- */

let host = null;
export function toast(msg, kind = 'info', ms = 3200) {
  if (!host) { host = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.appendChild(host); }
  const el = h('div.toast.toast--' + kind,
    icon(kind === 'err' ? 'warn' : kind === 'ok' ? 'bolt' : 'info', 13),
    h('span', msg));
  host.appendChild(el);
  const kill = () => { el.classList.add('is-out'); setTimeout(() => el.remove(), 200); };
  const t = setTimeout(kill, ms);
  el.addEventListener('click', () => { clearTimeout(t); kill(); });
  return kill;
}

/* --------------------------------- drawer -------------------------------- */

export function Drawer() {
  const title = h('div.drawer__title');
  const sub = h('div.meta');
  const body = h('div.drawer__body.scroll');
  const foot = h('div.drawer__foot', { hidden: true });
  const scrim = h('div.scrim', { hidden: true, onClick: () => close() });

  const el = h('aside.drawer', { hidden: true, role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Record inspector' },
    h('div.drawer__head',
      h('div.grow', title, sub),
      h('button.btn.btn--ghost.btn--icon', { onClick: () => close(), 'aria-label': 'Close inspector', title: 'Close (Esc)' }, icon('close', 13))),
    body, foot);

  let open = false;
  let lastFocus = null;

  function show(opt) {
    lastFocus = document.activeElement;
    title.textContent = opt.title || '';
    sub.textContent = opt.sub || '';
    mount(body, ...(Array.isArray(opt.content) ? opt.content : [opt.content]));
    if (opt.actions?.length) { mount(foot, ...opt.actions); foot.hidden = false; }
    else { foot.hidden = true; }
    if (!open) {
      open = true;
      scrim.hidden = false;
      el.hidden = false;
      // Force a style flush so the transition has a start value, then reveal.
      // rAF would be correct here in an active tab and never fire in a hidden
      // one, which would leave the overlay open at opacity 0.
      void el.offsetHeight;
      scrim.classList.add('is-on');
      el.classList.add('is-on');
      pushScope('drawer');
    }
    body.scrollTop = 0;
  }

  function close() {
    if (!open) return;
    open = false;
    el.classList.remove('is-on');
    scrim.classList.remove('is-on');
    popScope('drawer');
    setTimeout(() => { el.hidden = true; scrim.hidden = true; }, 240);
    lastFocus?.focus?.();
  }

  bind('drawer', 'escape', close, { hidden: true });

  return { el, scrim, show, close, get isOpen() { return open; } };
}

/* ------------------------ shared detail-view helpers --------------------- */

/** Field list for the drawer: rows are skipped entirely when the value is absent. */
export function fields(rows) {
  const dl = h('dl.dl');
  for (const r of rows) {
    if (!r) continue;
    const v = r.value;
    if (v === null || v === undefined || v === '' || v === '—') continue;
    dl.appendChild(h('dt', r.label));
    dl.appendChild(h('dd', { class: r.tone ? r.tone : null }, v.nodeType ? v : String(v)));
  }
  return dl;
}

/**
 * A titled field block that disappears entirely when every field is missing.
 * Without this, a section heading can end up standing over nothing at all.
 */
export function fieldSection(title, rows) {
  const dl = fields(rows);
  return dl.childElementCount ? h('div', subhead(title), dl) : null;
}

export function prose(text) {
  return h('p', {
    style: { fontSize: 'var(--t-body)', lineHeight: '1.6', color: 'var(--ink-2)', whiteSpace: 'pre-wrap' },
  }, text);
}

export function subhead(text, right) {
  return h('div.sub', h('span.sub__t', text), right ? h('span.sub__r', right) : null);
}

/** Minimal, dependency-free markdown for agent reports. */
export function markdown(md) {
  const wrap = h('div', { style: { fontSize: 'var(--t-body)', lineHeight: '1.65', color: 'var(--ink-2)' } });
  const lines = String(md || '').split('\n');
  let list = null;
  const flush = () => { if (list) { wrap.appendChild(list); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^#{1,6}\s/.test(line)) {
      flush();
      const level = line.match(/^#+/)[0].length;
      wrap.appendChild(h('div', {
        style: {
          fontSize: level <= 1 ? 'var(--t-lead)' : 'var(--t-body)',
          fontWeight: '600', color: level <= 2 ? 'var(--ink-1)' : 'var(--ink-2)',
          margin: '16px 0 6px', letterSpacing: level <= 1 ? '0.01em' : '0',
          borderBottom: level <= 2 ? '1px solid var(--line)' : 'none', paddingBottom: level <= 2 ? '5px' : '0',
        },
      }, inline(line.replace(/^#+\s*/, ''))));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!list) { list = h('ul', { style: { margin: '4px 0 10px', paddingLeft: '16px', listStyle: 'disc' } }); }
      list.appendChild(h('li', { style: { margin: '2px 0' } }, inline(line.replace(/^[-*]\s+/, ''))));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      if (/^[\s|:-]+$/.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      wrap.appendChild(h('div', {
        style: { display: 'flex', gap: '12px', padding: '3px 0', borderBottom: '1px solid var(--line-hair)', fontFamily: 'var(--font-mono)', fontSize: 'var(--t-meta)' },
      }, ...cells.map((c) => h('span', { style: { flex: '1 1 0', minWidth: '0' } }, inline(c)))));
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    flush();
    wrap.appendChild(h('p', { style: { margin: '0 0 8px' } }, inline(line)));
  }
  flush();
  return wrap;
}

function inline(text) {
  const f = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) f.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) f.appendChild(h('strong', { style: { color: 'var(--ink-1)' } }, tok.slice(2, -2)));
    else f.appendChild(h('code', { style: { fontFamily: 'var(--font-mono)', fontSize: '0.92em', color: 'var(--gold-fg)' } }, tok.slice(1, -1)));
    last = m.index + tok.length;
  }
  if (last < text.length) f.appendChild(document.createTextNode(text.slice(last)));
  return f;
}
