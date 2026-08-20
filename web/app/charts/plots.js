/**
 * charts/plots.js — the chart vocabulary of the terminal.
 *
 * Every plot takes an aligned x grid and one y array per series, so a single
 * crosshair can report every series at the cursor without hit-testing paths.
 */

import { s, h } from '../core/dom.js';
import {
  Chart, linear, band, extent, ticks, logTicks, linePath, areaPath, lttb,
  axisY, axisX, crosshair, showTip, hideTip, SERIES, diverge,
} from './core.js';

const PAD = { t: 10, r: 14, b: 22, l: 48 };

/**
 * Multi-series line / area chart.
 * @param {object} cfg
 *   x        {number[]|string[]}  aligned grid
 *   series   [{label, color, y:number[], width, dash, area, ghost, hidden}]
 *   yFmt, xFmt, xTickCount, yTickCount
 *   zero, symmetric, domain
 *   refLines [{y,color,label,dash}]
 *   vLines   [{i,color,label}]
 *   markers  [{i, y, color, shape:'diamond'|'circle', title}]
 *   tipTitle (i)=>string
 *   maxPoints downsample target (default 1400)
 */
export function LineChart(host, cfg) {
  return Chart(host, (svg, w, hgt) => {
    const pad = { ...PAD, ...(cfg.pad || {}) };
    const x0 = pad.l;
    const x1 = w - pad.r;
    const y0 = pad.t;
    const y1 = hgt - pad.b;
    if (x1 <= x0 || y1 <= y0) return;

    const live = (cfg.series || []).filter((sr) => !sr.hidden && sr.y && sr.y.length);
    const n = cfg.x.length;
    if (!n || !live.length) return;

    // Downsample by index so every series stays aligned to one x grid.
    const target = Math.min(cfg.maxPoints || 1400, Math.max(120, Math.round((x1 - x0) * 2)));
    let idx = null;
    if (n > target) {
      const driver = live.reduce((a, b) => (b.y.length >= (a?.y.length || 0) ? b : a), live[0]);
      idx = lttb(
        Array.from({ length: n }, (_, i) => i), target,
        (i) => i, (i) => driver.y[i],
      );
    }
    const at = idx ? (k) => idx[k] : (k) => k;
    const count = idx ? idx.length : n;

    const all = [];
    for (const sr of live) for (const v of sr.y) if (Number.isFinite(v)) all.push(v);
    for (const r of cfg.refLines || []) if (Number.isFinite(r.y)) all.push(r.y);
    let [lo, hi] = cfg.domain || extent(all, { zero: cfg.zero, symmetric: cfg.symmetric, pad: cfg.padY ?? 0.07 });

    // A log axis is the only way overlaid cycle multiples spanning 1× to 100×
    // stay legible; a linear axis flattens three of the four curves onto zero.
    const useLog = !!cfg.logY && hi > 0;
    if (useLog) {
      const positives = all.filter((v) => v > 0);
      lo = Math.max(cfg.logMin ?? Math.min(...positives) * 0.85, 1e-6);
      hi = Math.max(hi * 1.05, lo * 1.2);
    }
    const T = useLog ? (v) => Math.log10(Math.max(v, lo)) : (v) => v;
    const valid = useLog ? (v) => Number.isFinite(v) && v > 0 : (v) => Number.isFinite(v);

    const syRaw = linear(T(lo), T(hi), y1, y0);
    const sy = (v) => syRaw(T(v));
    sy.domain = [lo, hi];
    const sx = linear(0, Math.max(1, count - 1), x0, x1);

    const g = s('g');
    svg.appendChild(g);

    // grid + axes
    axisY(g, syRaw, {
      x: x0, w: x1 - x0, fmt: cfg.yFmt || ((v) => v.toFixed(0)),
      count: cfg.yTickCount || 5,
      values: useLog ? logTicks(lo, hi, cfg.yTickCount || 6) : null,
      map: T,
    });
    g.appendChild(s('line', { class: 'ax-line', x1: x0, x2: x1, y1: y1 + 0.5, y2: y1 + 0.5 }));

    if (cfg.xTicks !== false) {
      const tc = cfg.xTickCount || Math.max(2, Math.min(9, Math.floor((x1 - x0) / 90)));
      const step = Math.max(1, Math.floor((count - 1) / tc));
      const vals = [];
      for (let k = 0; k < count; k += step) vals.push(k);
      const last = count - 1;
      if (vals[vals.length - 1] !== last) {
        // Drop the previous tick if the closing one would land on top of it.
        if (last - vals[vals.length - 1] < step * 0.6) vals.pop();
        vals.push(last);
      }
      axisX(g, sx, {
        y: y1, hgt: y1 - y0, values: vals, grid: cfg.xGrid !== false,
        fmt: (k) => (cfg.xFmt ? cfg.xFmt(cfg.x[at(k)], at(k)) : String(cfg.x[at(k)])),
      });
    }

    // shaded bands (regimes, phases)
    for (const b of cfg.bands || []) {
      const bx0 = sx(idx ? nearestK(idx, b.from) : b.from);
      const bx1 = sx(idx ? nearestK(idx, b.to) : b.to);
      g.appendChild(s('rect', { class: 'band', x: bx0, y: y0, width: Math.max(0.5, bx1 - bx0), height: y1 - y0, fill: b.color }));
    }

    // vertical reference lines
    for (const v of cfg.vLines || []) {
      const vx = Math.round(sx(idx ? nearestK(idx, v.i) : v.i)) + 0.5;
      g.appendChild(s('line', { class: 'refline', x1: vx, x2: vx, y1: y0, y2: y1, stroke: v.color || 'var(--ink-4)' }));
      if (v.label) g.appendChild(s('text', { class: 'reflabel', x: vx + 3, y: y0 + 9, fill: v.color || 'var(--ink-4)' }, v.label));
    }

    // areas first, then lines, so strokes stay legible
    for (const sr of live) {
      if (!sr.area) continue;
      const d = areaPath(Array.from({ length: count }, (_, k) => k), (k) => sx(k), (k) => {
        const v = sr.y[at(k)];
        return valid(v) ? sy(v) : null;
      }, sy(Math.max(lo, Math.min(hi, cfg.areaBase ?? lo))));
      if (d) g.appendChild(s('path.area', { d, fill: sr.area === true ? (sr.color || SERIES[0]) : sr.area, opacity: sr.areaOpacity ?? 0.14 }));
    }

    for (const sr of live) {
      const d = linePath(Array.from({ length: count }, (_, k) => k), (k) => sx(k), (k) => {
        const v = sr.y[at(k)];
        return valid(v) ? sy(v) : null;
      });
      if (!d) continue;
      g.appendChild(s('path', {
        class: `serie${sr.ghost ? ' serie--ghost' : ''}${sr.dash ? ' serie--dash' : ''}${sr.proj ? ' serie--proj' : ''}${sr.thick ? ' serie--thick' : ''}`,
        d, stroke: sr.color || SERIES[0],
        'stroke-width': sr.width || null,
        opacity: sr.opacity ?? null,
      }));
    }

    // horizontal reference lines drawn above the data
    for (const r of cfg.refLines || []) {
      if (!Number.isFinite(r.y)) continue;
      const ry = Math.round(sy(r.y)) + 0.5;
      g.appendChild(s('line', { class: 'refline', x1: x0, x2: x1, y1: ry, y2: ry, stroke: r.color || 'var(--ink-4)' }));
      if (r.label) {
        g.appendChild(s('text', {
          class: 'reflabel', x: x1 - 3, y: ry - 4, 'text-anchor': 'end', fill: r.color || 'var(--ink-4)',
        }, r.label));
      }
    }

    // event markers
    for (const m of cfg.markers || []) {
      const mk = idx ? nearestK(idx, m.i) : m.i;
      const cx = sx(mk);
      const cy = sy(m.y);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const node = m.shape === 'diamond'
        ? s('path.mark.mark--flip', { d: `M${cx} ${cy - 4}L${cx + 4} ${cy}L${cx} ${cy + 4}L${cx - 4} ${cy}Z`, fill: m.color })
        : s('circle.mark', { cx, cy, r: m.r || 3, fill: m.color });
      if (m.title) node.appendChild(s('title', {}, m.title));
      g.appendChild(node);
    }

    if (cfg.onHover !== false) {
      crosshair(svg, {
        x0, x1, y0, y1, count,
        onMove: (k, e) => {
          const i = at(k);
          const rows = live.map((sr) => {
            const v = sr.y[i];
            return Number.isFinite(v) ? { k: sr.label, v: (cfg.tipFmt || cfg.yFmt || ((x) => x.toFixed(2)))(v, sr), color: sr.color } : null;
          }).filter(Boolean).slice(0, 12);
          if (cfg.extraTipRows) rows.push(...cfg.extraTipRows(i));
          showTip(e, cfg.tipTitle ? cfg.tipTitle(i) : String(cfg.x[i]), rows);
        },
      });
    }
  }, { label: cfg.label });
}

function nearestK(idx, i) {
  // idx is ascending; find the sampled position closest to source index i
  let lo = 0;
  let hi = idx.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx[mid] < i) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(idx[lo - 1] - i) <= Math.abs(idx[lo] - i)) return lo - 1;
  return lo;
}

/**
 * Vertical bar chart with a diverging or fixed fill.
 * cfg: {labels, values, color(v,i), yFmt, zero, refLines, onClick, tip(i)}
 */
export function BarChart(host, cfg) {
  return Chart(host, (svg, w, hgt) => {
    const pad = { ...PAD, b: 26, ...(cfg.pad || {}) };
    const x0 = pad.l; const x1 = w - pad.r; const y0 = pad.t; const y1 = hgt - pad.b;
    if (x1 <= x0 || y1 <= y0) return;
    const vals = cfg.values || [];
    if (!vals.length) return;
    const [lo, hi] = cfg.domain || extent(vals, { zero: true, pad: 0.1 });
    const sy = linear(lo, hi, y1, y0);
    const sx = band(vals.length, x0, x1, cfg.padInner ?? 0.25);
    const g = s('g');
    svg.appendChild(g);

    axisY(g, sy, { x: x0, w: x1 - x0, fmt: cfg.yFmt || ((v) => v.toFixed(0)), count: cfg.yTickCount || 5 });
    const zeroY = Math.round(sy(Math.max(lo, Math.min(hi, 0)))) + 0.5;
    g.appendChild(s('line', { class: 'ax-line', x1: x0, x2: x1, y1: zeroY, y2: zeroY }));

    vals.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const bx = sx(i);
      const by = sy(Math.max(v, 0));
      const bh = Math.max(1, Math.abs(sy(v) - sy(0)));
      const rect = s('rect', {
        x: bx, y: by, width: sx.bandwidth, height: bh,
        fill: cfg.color ? cfg.color(v, i) : (v >= 0 ? 'var(--up)' : 'var(--down)'),
        opacity: cfg.opacity ?? 0.85, rx: 1,
      });
      if (cfg.tip) {
        rect.style.cursor = 'default';
        rect.addEventListener('mousemove', (e) => { const t = cfg.tip(i); showTip(e, t.title, t.rows); });
        rect.addEventListener('mouseleave', hideTip);
      }
      if (cfg.onClick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', () => cfg.onClick(i)); }
      g.appendChild(rect);
    });

    if (cfg.labels) {
      const skip = Math.ceil((cfg.labels.length * 34) / Math.max(1, x1 - x0));
      cfg.labels.forEach((lbl, i) => {
        if (i % skip) return;
        g.appendChild(s('text', {
          class: 'ax-txt', x: sx(i) + sx.bandwidth / 2, y: y1 + 14, 'text-anchor': 'middle',
        }, lbl));
      });
    }
    for (const r of cfg.refLines || []) {
      if (!Number.isFinite(r.y)) continue;
      const ry = Math.round(sy(r.y)) + 0.5;
      g.appendChild(s('line', { class: 'refline', x1: x0, x2: x1, y1: ry, y2: ry, stroke: r.color || 'var(--ink-4)' }));
      if (r.label) g.appendChild(s('text', { class: 'reflabel', x: x1 - 2, y: ry - 4, 'text-anchor': 'end', fill: r.color || 'var(--ink-4)' }, r.label));
    }
  }, { label: cfg.label });
}

/**
 * Horizontal profile — one bar per strike, signed left/right of a centre axis.
 * This is the honest shape for gamma exposure: magnitude and side at once.
 */
export function ProfileChart(host, cfg) {
  return Chart(host, (svg, w, hgt) => {
    const pad = { t: 10, r: 12, b: 22, l: 54, ...(cfg.pad || {}) };
    const x0 = pad.l; const x1 = w - pad.r; const y0 = pad.t; const y1 = hgt - pad.b;
    const rows = cfg.rows || [];
    if (!rows.length || x1 <= x0 || y1 <= y0) return;

    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value) || 0), 1);
    const sx = linear(-maxAbs, maxAbs, x0, x1);
    const step = (y1 - y0) / rows.length;
    const bh = Math.max(1.5, step - 1);
    // Strikes read upward, the way a ladder does. rows[] arrives ascending.
    const yFor = (i) => y1 - (i + 1) * step;
    const g = s('g');
    svg.appendChild(g);

    const zx = Math.round(sx(0)) + 0.5;
    g.appendChild(s('line', { class: 'ax-line', x1: zx, x2: zx, y1: y0, y2: y1 }));

    rows.forEach((r, i) => {
      const y = yFor(i);
      const v = r.value || 0;
      const bx = v >= 0 ? zx : sx(v);
      const bw = Math.max(1, Math.abs(sx(v) - zx));
      const rect = s('rect', {
        x: bx, y, width: bw, height: bh,
        fill: v >= 0 ? 'var(--up)' : 'var(--down)', opacity: r.dim ? 0.35 : 0.8, rx: 1,
      });
      rect.addEventListener('mousemove', (e) => showTip(e, r.title, r.rows || []));
      rect.addEventListener('mouseleave', hideTip);
      g.appendChild(rect);
    });

    // strike labels — every nth so they never collide
    const labelEvery = Math.max(1, Math.ceil(rows.length / Math.max(3, Math.floor((y1 - y0) / 18))));
    rows.forEach((r, i) => {
      if (i % labelEvery) return;
      g.appendChild(s('text', {
        class: 'ax-txt', x: x0 - 6, y: yFor(i) + bh / 2 + 3, 'text-anchor': 'end',
      }, r.label));
    });

    // Marker lines cluster around spot — spread their labels so every one of
    // them stays readable instead of overprinting into a smear.
    const marks = (cfg.lines || [])
      .filter((m) => Number.isFinite(m.at))
      .map((m) => {
        const i = rows.findIndex((r) => r.key >= m.at);
        return i < 0 ? null : { ...m, y: Math.round(yFor(i)) + 0.5 };
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);

    let lastLabelY = -Infinity;
    for (const m of marks) {
      g.appendChild(s('line', { class: 'refline', x1: x0, x2: x1, y1: m.y, y2: m.y, stroke: m.color }));
      const ly = Math.max(m.y - 3, lastLabelY + 11);
      lastLabelY = ly;
      g.appendChild(s('text', { class: 'reflabel', x: x1 - 2, y: ly, 'text-anchor': 'end', fill: m.color }, m.label));
    }
  }, { label: cfg.label });
}

/**
 * Semicircular gauge for a 0..100 composite score.
 * The arc is segmented so the zones are readable without a legend.
 */
export function Gauge(host, cfg) {
  return Chart(host, (svg, w, hgt) => {
    const cx = w / 2;
    const r = Math.min(w / 2 - 14, hgt - 26);
    if (r < 20) return;
    const cy = hgt - 14;
    const g = s('g');
    svg.appendChild(g);

    const zones = cfg.zones || [
      { to: 25, color: 'var(--down)' }, { to: 45, color: 'var(--flat)' },
      { to: 55, color: 'var(--ink-4)' }, { to: 75, color: 'var(--up)' }, { to: 100, color: '#10b981' },
    ];
    let from = 0;
    for (const z of zones) {
      g.appendChild(s('path', {
        d: arc(cx, cy, r, from, z.to), fill: 'none', stroke: z.color,
        'stroke-width': 9, opacity: 0.24, 'stroke-linecap': 'butt',
      }));
      from = z.to;
    }
    const v = Math.max(0, Math.min(100, cfg.value ?? 0));
    g.appendChild(s('path', {
      d: arc(cx, cy, r, 0, v), fill: 'none', stroke: cfg.color || 'var(--brand-fg)',
      'stroke-width': 9, 'stroke-linecap': 'round',
    }));

    // The marker is a tick inside the ring, not a needle to the hub: a needle
    // at a mid-range score draws straight through the number it is reporting.
    const a = Math.PI * (1 - v / 100);
    const inner = r - 16;
    const outer = r + 5;
    g.appendChild(s('line', {
      x1: cx + Math.cos(a) * inner, y1: cy - Math.sin(a) * inner,
      x2: cx + Math.cos(a) * outer, y2: cy - Math.sin(a) * outer,
      stroke: 'var(--ink-1)', 'stroke-width': 2, 'stroke-linecap': 'round',
    }));

    g.appendChild(s('text.gauge__val', { x: cx, y: cy - r * 0.34, 'text-anchor': 'middle' }, String(cfg.display ?? Math.round(v))));
    if (cfg.label) {
      g.appendChild(s('text.gauge__lbl', {
        x: cx, y: cy - r * 0.34 + 15, 'text-anchor': 'middle', fill: cfg.color || 'var(--ink-3)',
      }, cfg.label));
    }
    g.appendChild(s('text', { class: 'ax-txt', x: cx - r, y: cy + 13, 'text-anchor': 'middle' }, cfg.min || '0'));
    g.appendChild(s('text', { class: 'ax-txt', x: cx + r, y: cy + 13, 'text-anchor': 'middle' }, cfg.max || '100'));
  }, { label: cfg.label });
}

function arc(cx, cy, r, from, to) {
  const a0 = Math.PI * (1 - from / 100);
  const a1 = Math.PI * (1 - to / 100);
  const x0 = cx + Math.cos(a0) * r;
  const y0 = cy - Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r;
  const y1 = cy - Math.sin(a1) * r;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Quadrant scatter — relative strength vs momentum for sector rotation.
 */
export function QuadrantChart(host, cfg) {
  return Chart(host, (svg, w, hgt) => {
    const pad = { t: 16, r: 16, b: 26, l: 44, ...(cfg.pad || {}) };
    const x0 = pad.l; const x1 = w - pad.r; const y0 = pad.t; const y1 = hgt - pad.b;
    const pts = cfg.points || [];
    if (!pts.length || x1 <= x0 || y1 <= y0) return;

    const [xlo, xhi] = extent(pts.map((p) => p.x), { symmetric: true, pad: 0.22 });
    const [ylo, yhi] = extent(pts.map((p) => p.y), { symmetric: true, pad: 0.22 });
    const sx = linear(xlo, xhi, x0, x1);
    const sy = linear(ylo, yhi, y1, y0);
    const g = s('g');
    svg.appendChild(g);

    const zx = Math.round(sx(0)) + 0.5;
    const zy = Math.round(sy(0)) + 0.5;
    g.appendChild(s('rect.quad-bg', { x: zx, y: y0, width: x1 - zx, height: zy - y0, fill: 'var(--up)' }));
    g.appendChild(s('rect.quad-bg', { x: x0, y: zy, width: zx - x0, height: y1 - zy, fill: 'var(--down)' }));

    axisY(g, sy, { x: x0, w: x1 - x0, fmt: cfg.yFmt, count: 4 });
    const xt = ticks(xlo, xhi, 4);
    axisX(g, sx, { y: y1, hgt: y1 - y0, values: xt, grid: true, fmt: cfg.xFmt });

    g.appendChild(s('line', { class: 'ax-grid ax-grid--zero', x1: zx, x2: zx, y1: y0, y2: y1 }));
    g.appendChild(s('line', { class: 'ax-grid ax-grid--zero', x1: x0, x2: x1, y1: zy, y2: zy }));

    (cfg.quadrants || []).forEach((q) => {
      g.appendChild(s('text.quad-lbl', {
        x: q.right ? x1 - 5 : x0 + 5, y: q.bottom ? y1 - 5 : y0 + 11,
        'text-anchor': q.right ? 'end' : 'start',
      }, q.label));
    });

    for (const p of pts) {
      const cx = sx(p.x);
      const cy = sy(p.y);
      const dot = s('circle', { cx, cy, r: p.r || 4, fill: p.color || 'var(--brand-fg)', opacity: 0.9, stroke: 'var(--s-panel)', 'stroke-width': 1 });
      dot.addEventListener('mousemove', (e) => showTip(e, p.label, p.rows || []));
      dot.addEventListener('mouseleave', hideTip);
      g.appendChild(dot);
      g.appendChild(s('text.pt-lbl', { x: cx + 7, y: cy + 3.5 }, p.short || p.label));
    }
  }, { label: cfg.label });
}

/** Tiny inline sparkline for rails and table cells. */
export function sparkline(values, { color = 'var(--brand-fg)', w = 54, hgt = 15, fill = false } = {}) {
  const svg = s('svg.spark', { viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return svg;
  const [lo, hi] = extent(clean, { pad: 0.08 });
  const sy = linear(lo, hi, hgt - 1.5, 1.5);
  const sx = linear(0, values.length - 1, 0.5, w - 0.5);
  const d = linePath(values, (v, i) => sx(i), (v) => (Number.isFinite(v) ? sy(v) : null));
  if (fill) {
    const a = areaPath(values, (v, i) => sx(i), (v) => (Number.isFinite(v) ? sy(v) : null), hgt);
    if (a) svg.appendChild(s('path', { d: a, fill: color, opacity: 0.16, stroke: 'none' }));
  }
  svg.appendChild(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.25, 'stroke-linejoin': 'round' }));
  return svg;
}

/** A horizontal 0..1 meter used in KPI stacks and category breakdowns. */
export function meter(ratio, color) {
  return h('div.meter', h('i', { style: { width: `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`, background: color || 'var(--brand-fg)' } }));
}

export { diverge };
