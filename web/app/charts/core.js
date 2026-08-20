/**
 * charts/core.js — scales, axes, downsampling and the shared crosshair.
 *
 * Hand-rolled SVG, no chart library. Every chart measures its own container
 * and redraws on resize, so panel maximise, rail collapse and density changes
 * all reflow correctly without a window listener.
 */

import { s, h, onResize } from '../core/dom.js';

/* -------------------------------------------------------------------------
   Scales
   ------------------------------------------------------------------------- */

export function linear(d0, d1, r0, r1) {
  const span = (d1 - d0) || 1;
  const f = (v) => r0 + ((v - d0) / span) * (r1 - r0);
  f.invert = (px) => d0 + ((px - r0) / ((r1 - r0) || 1)) * span;
  f.domain = [d0, d1];
  f.range = [r0, r1];
  return f;
}

export function band(n, r0, r1, pad = 0.15) {
  const step = (r1 - r0) / Math.max(1, n);
  const w = step * (1 - pad);
  const f = (i) => r0 + i * step + (step - w) / 2;
  f.bandwidth = w;
  f.step = step;
  f.invert = (px) => Math.floor((px - r0) / step);
  return f;
}

/** Domain padded to a readable extent; `zero` pins one edge to 0. */
export function extent(values, { pad = 0.06, zero = false, symmetric = false } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return [0, 1];
  if (symmetric) { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
  if (zero) { if (lo > 0) lo = 0; if (hi < 0) hi = 0; }
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

/** Human tick values — 1/2/5 × 10ⁿ. */
export function ticks(lo, hi, count = 5) {
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return [lo];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) {
    out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return out;
}

/** Decade ticks for a log axis: 1, 2, 5 × 10ⁿ, thinned to what fits. */
export function logTicks(lo, hi, max = 6) {
  const out = [];
  const start = Math.floor(Math.log10(Math.max(lo, 1e-9)));
  const end = Math.ceil(Math.log10(Math.max(hi, 1e-9)));
  for (let e = start; e <= end; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  if (out.length <= max) return out;
  const step = Math.ceil(out.length / max);
  return out.filter((_, i) => i % step === 0 || i === out.length - 1);
}

/* -------------------------------------------------------------------------
   Downsampling — Largest-Triangle-Three-Buckets.
   6,697-point series drawn into a 700px panel are visually identical at
   ~1,400 points and cost a fifth of the path data.
   ------------------------------------------------------------------------- */
export function lttb(data, target, xOf = (d, i) => i, yOf = (d) => d) {
  const n = data.length;
  if (target >= n || target < 3) return data;
  const every = (n - 2) / (target - 2);
  const out = [data[0]];
  let a = 0;
  for (let i = 0; i < target - 2; i++) {
    const rangeStart = Math.floor((i + 1) * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const len = Math.max(1, rangeEnd - rangeStart);
    for (let j = rangeStart; j < rangeEnd; j++) { avgX += xOf(data[j], j); avgY += yOf(data[j], j) || 0; }
    avgX /= len; avgY /= len;

    const from = Math.floor(i * every) + 1;
    const to = Math.floor((i + 1) * every) + 1;
    const ax = xOf(data[a], a);
    const ay = yOf(data[a], a) || 0;
    let best = -1;
    let bestArea = -1;
    for (let j = from; j < Math.min(to, n); j++) {
      const area = Math.abs((ax - avgX) * ((yOf(data[j], j) || 0) - ay) - (ax - xOf(data[j], j)) * (avgY - ay));
      if (area > bestArea) { bestArea = area; best = j; }
    }
    if (best > -1) { out.push(data[best]); a = best; }
  }
  out.push(data[n - 1]);
  return out;
}

/* -------------------------------------------------------------------------
   Path builders
   ------------------------------------------------------------------------- */

/** Line path. Null y values break the line rather than interpolating a lie. */
export function linePath(points, xs, ys) {
  let d = '';
  let pen = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const y = ys(p, i);
    if (y === null || y === undefined || !Number.isFinite(y)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${xs(p, i).toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

export function areaPath(points, xs, ys, baseY) {
  const top = linePath(points, xs, ys);
  if (!top) return '';
  const first = points.findIndex((p, i) => Number.isFinite(ys(p, i)));
  let last = -1;
  for (let i = points.length - 1; i >= 0; i--) if (Number.isFinite(ys(points[i], i))) { last = i; break; }
  if (first < 0 || last < 0) return '';
  return `${top}L${xs(points[last], last).toFixed(1)} ${baseY.toFixed(1)}L${xs(points[first], first).toFixed(1)} ${baseY.toFixed(1)}Z`;
}

/* -------------------------------------------------------------------------
   Colour ramps
   ------------------------------------------------------------------------- */

export const SERIES = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)',
                       'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];

/** Diverging red→neutral→green, used by every returns heatmap. */
export function diverge(v, max) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'var(--s-input)';
  const t = Math.max(-1, Math.min(1, v / (max || 1)));
  const a = Math.abs(t);
  const alpha = 0.1 + a * 0.62;
  return t >= 0 ? `rgba(52, 211, 153, ${alpha.toFixed(3)})` : `rgba(248, 113, 113, ${alpha.toFixed(3)})`;
}

/** Sequential cobalt ramp for magnitude-only matrices. */
export function sequential(t) {
  const a = 0.06 + Math.max(0, Math.min(1, t)) * 0.7;
  return `rgba(122, 154, 255, ${a.toFixed(3)})`;
}

/* -------------------------------------------------------------------------
   Chart host — measures, draws, redraws.
   ------------------------------------------------------------------------- */

export function Chart(host, draw, opt = {}) {
  let svg = null;
  let dispose = null;
  const state = { w: 0, hh: 0 };

  function paint(w, hgt) {
    if (w < 8 || hgt < 8) return;
    state.w = w; state.hh = hgt;
    const next = s('svg', {
      viewBox: `0 0 ${w} ${hgt}`,
      width: w, height: hgt,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': opt.label || 'chart',
    });
    try {
      draw(next, w, hgt);
    } catch (err) {
      console.error('[chart]', err);
      next.appendChild(s('text', { x: w / 2, y: hgt / 2, 'text-anchor': 'middle', class: 'ax-txt' }, 'chart failed to render'));
    }
    if (svg) svg.replaceWith(next);
    else host.appendChild(next);
    svg = next;
  }

  dispose = onResize(host, paint);
  return {
    redraw: () => paint(state.w || host.clientWidth, state.hh || host.clientHeight),
    destroy: () => { dispose?.(); host.innerHTML = ''; },
    get svg() { return svg; },
  };
}

/* -------------------------------------------------------------------------
   Axes
   ------------------------------------------------------------------------- */

export function axisY(g, scale, { x = 0, w = 0, fmt = (v) => v, count = 5, grid = true, zeroLine = true, side = 'left', values = null, map = (v) => v } = {}) {
  const [lo, hi] = scale.domain;
  for (const t of (values || ticks(lo, hi, count))) {
    const y = Math.round(scale(map(t))) + 0.5;
    if (grid) g.appendChild(s('line', { class: t === 0 && zeroLine ? 'ax-grid ax-grid--zero' : 'ax-grid', x1: x, x2: x + w, y1: y, y2: y }));
    g.appendChild(s('text', {
      class: 'ax-txt', x: side === 'left' ? x - 6 : x + w + 6, y: y + 3,
      'text-anchor': side === 'left' ? 'end' : 'start',
    }, fmt(t)));
  }
}

export function axisX(g, scale, { y = 0, hgt = 0, values = [], fmt = (v) => v, grid = false, anchor = 'middle' } = {}) {
  values.forEach((v, i) => {
    const x = Math.round(scale(v)) + 0.5;
    if (grid) g.appendChild(s('line', { class: 'ax-grid', x1: x, x2: x, y1: y - hgt, y2: y }));
    // The first and last labels anchor inward so they never spill out of the
    // plot box and get clipped by the panel edge.
    const a = i === 0 ? 'start' : i === values.length - 1 ? 'end' : anchor;
    g.appendChild(s('text', { class: 'ax-txt', x, y: y + 13, 'text-anchor': a }, fmt(v)));
  });
}

/* -------------------------------------------------------------------------
   Tooltip — one instance for the whole app, moved and refilled.
   ------------------------------------------------------------------------- */

let tipEl = null;
function tipNode() {
  if (!tipEl) { tipEl = h('div.tip', { role: 'tooltip' }); document.body.appendChild(tipEl); }
  return tipEl;
}

export function showTip(evt, title, rowsIn) {
  const el = tipNode();
  el.innerHTML = '';
  if (title) el.appendChild(h('div.tip__h', title));
  for (const r of rowsIn) {
    if (!r) continue;
    el.appendChild(h('div.tip__r',
      h('span.tip__k', r.color ? h('i', { style: { width: '7px', height: '7px', borderRadius: '99px', background: r.color, display: 'inline-block' } }) : null, r.k),
      h('span.tip__v', { style: r.tone ? { color: r.tone } : null }, r.v)));
  }
  el.classList.add('is-on');
  place(el, evt);
}

function place(el, evt) {
  const pad = 14;
  const r = el.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  el.style.left = `${Math.max(6, x)}px`;
  el.style.top = `${Math.max(6, y)}px`;
}

export function hideTip() { if (tipEl) tipEl.classList.remove('is-on'); }

/**
 * Attach a vertical crosshair over a plot area.
 * `onMove(index, event)` receives the nearest datum index, or -1 on exit.
 */
export function crosshair(svg, { x0, x1, y0, y1, count, onMove, onLeave }) {
  const line = s('line', { class: 'crosshair', y1: y0, y2: y1, x1: x0, x2: x0, opacity: 0 });
  const hit = s('rect', { class: 'hitarea', x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) });
  svg.appendChild(line);
  svg.appendChild(hit);

  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * (svg.viewBox.baseVal.width || box.width);
    const t = (px - x0) / Math.max(1, x1 - x0);
    const i = Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))));
    const cx = x0 + (i / Math.max(1, count - 1)) * (x1 - x0);
    line.setAttribute('x1', cx);
    line.setAttribute('x2', cx);
    line.setAttribute('opacity', 1);
    onMove(i, e);
  });
  hit.addEventListener('mouseleave', () => {
    line.setAttribute('opacity', 0);
    hideTip();
    onLeave?.();
  });
  return line;
}
