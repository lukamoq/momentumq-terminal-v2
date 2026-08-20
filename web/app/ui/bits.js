/**
 * bits.js — the small, repeated pieces. Every module composes from these so
 * a hit rate, a KPI or a status chip looks and behaves the same everywhere.
 */

import { h, icon } from '../core/dom.js';
import { tone, toneColor, title as titleCase, pct, num, isNum, DASH } from '../core/fmt.js';
import { meter } from '../charts/plots.js';

/** Status chip driven by the shared tone vocabulary. */
export function chip(text, t) {
  const k = t || tone(text);
  return h('span.chip.chip--' + k, titleCase(text));
}

export function rawChip(text, kind = '') {
  return h('span.chip' + (kind ? '.chip--' + kind : ''), text);
}

/**
 * KPI tile. `sub` is where the caveat lives — a number without its baseline
 * or sample size is the main way a scorecard misleads.
 */
export function kpi({ label, value, sub, t, bar, barColor, hint }) {
  return h('div.kpi',
    h('div.kpi__label', label, hint ? h('span', { title: hint, style: { cursor: 'help', color: 'var(--ink-4)' } }, icon('info', 10)) : null),
    h('div.kpi-val' + (t ? '.' + t : ''), value ?? DASH),
    isNum(bar) ? h('div.kpi__bar', meter(bar, barColor || (t ? toneColor(t) : null))) : null,
    sub ? h('div.kpi__sub', sub) : null);
}

export function kpiGrid(cols, ...tiles) {
  return h('div.kpis', { style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } }, ...tiles);
}

/** Signed percentage with the tone already applied. */
export function delta(v, digits = 1, asRatio = true) {
  if (!isNum(v)) return h('span.na', DASH);
  const t = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const txt = asRatio ? pct(v, digits, true) : `${v > 0 ? '+' : ''}${num(v, digits)}%`;
  return h('span.' + t, txt);
}

/**
 * A hit rate printed against the baseline it has to beat.
 * A 63% hit rate in a market that rose is not skill; the edge is the number
 * that matters, so both are always shown together.
 */
export function rateVsBase(rate, base) {
  if (!isNum(rate)) return h('span.na', 'no discriminating calls');
  const edge = isNum(base) ? rate - base : null;
  return h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'baseline' } },
    h('span', { style: { color: 'var(--ink-1)' } }, pct(rate, 1)),
    isNum(base) ? h('span.dim', { style: { fontSize: 'var(--t-micro)' } }, `vs ${pct(base, 1)}`) : null,
    isNum(edge) ? h('span.' + (edge > 0 ? 'up' : edge < 0 ? 'down' : 'flat'), { style: { fontSize: 'var(--t-micro)' } }, pct(edge, 1, true)) : null);
}

/** Legend row for a chart; items may be toggled if `onToggle` is given. */
export function legend(items, onToggle) {
  return h('div.legend', ...items.map((it) => {
    const node = h('span.legend__i' + (onToggle ? '.is-toggle' : '') + (it.off ? '.is-off' : ''),
      h('span.legend__sw' + (it.box ? '.legend__sw--box' : ''), { style: { background: it.color } }),
      it.label);
    if (onToggle) {
      node.setAttribute('role', 'switch');
      node.setAttribute('aria-checked', String(!it.off));
      node.tabIndex = 0;
      const fire = () => onToggle(it, node);
      node.addEventListener('click', fire);
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } });
    }
    return node;
  }));
}

/** Methodology / caveat block. */
export function note(...kids) { return h('div.note', h('div', ...kids)); }
export function infoNote(...kids) { return h('div.note.note--info', h('div', ...kids)); }

/** Two-column labelled readout used in side panels. */
export function readout(rows) {
  const dl = h('dl.dl');
  for (const r of rows) {
    if (!r) continue;
    dl.appendChild(h('dt', r.label));
    dl.appendChild(h('dd', { class: r.t || null, title: r.title || null }, r.value?.nodeType ? r.value : (r.value ?? DASH)));
  }
  return dl;
}

/** A labelled horizontal bar — category breakdowns, weights, contributions. */
export function barRow({ label, value, ratio, color, sub }) {
  return h('div', { style: { padding: '5px 0', borderBottom: '1px solid var(--line-hair)' } },
    h('div.row', { style: { justifyContent: 'space-between', marginBottom: '4px' } },
      h('span', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-2)' } }, label),
      h('span.num', { style: { fontSize: 'var(--t-meta)', color: color || 'var(--ink-1)' } }, value)),
    meter(ratio, color),
    sub ? h('div', { style: { fontSize: 'var(--t-micro)', color: 'var(--ink-4)', marginTop: '3px' } }, sub) : null);
}

/** Rail row: rank, name, headline value, and a sub-line of context. */
export function railRow({ rank, name, value, sub, selected, onClick, title: tt }) {
  const el = h('button.rlist__item', {
    type: 'button', 'aria-selected': String(!!selected), title: tt || name, onClick,
  },
    h('span.rlist__name', rank !== undefined ? h('span.rlist__rank', rank) : null, name),
    h('span.rlist__val', value ?? ''),
    sub ? h('span.rlist__sub', sub) : null);
  return el;
}

/** Source link — every audited record can be traced back. */
export function sourceLink(url, label = 'Open source') {
  if (!url) return null;
  return h('a.btn', { href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('book', 12), label);
}

export { toneColor };
