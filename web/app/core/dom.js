/**
 * dom.js — a 2 KB hyperscript. No virtual DOM, no diffing.
 *
 * Panels re-render by replacing their own subtree, which for a terminal is
 * both faster and simpler than reconciliation: the data arrives in one shot
 * from the API and the whole panel is a pure function of it.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('div.cls#id', {attrs}, ...children) */
export function h(spec, props, ...kids) {
  const [tag, cls, id] = parseSpec(spec);
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (id) node.id = id;
  applyProps(node, props, kids);
  return node;
}

/** s('path.serie', {d, stroke}) — same, in the SVG namespace. */
export function s(spec, props, ...kids) {
  const [tag, cls, id] = parseSpec(spec);
  const node = document.createElementNS(SVG_NS, tag);
  if (cls) node.setAttribute('class', cls);
  if (id) node.setAttribute('id', id);
  applyProps(node, props, kids, true);
  return node;
}

function parseSpec(spec) {
  const hashAt = spec.indexOf('#');
  const id = hashAt > -1 ? spec.slice(hashAt + 1) : '';
  const head = hashAt > -1 ? spec.slice(0, hashAt) : spec;
  const parts = head.split('.');
  return [parts[0] || 'div', parts.slice(1).join(' '), id];
}

function applyProps(node, props, kids, isSvg) {
  if (props && (props.nodeType || Array.isArray(props) || typeof props === 'string' || typeof props === 'number')) {
    kids.unshift(props);
    props = null;
  }
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); continue; }
      if (k === 'dataset') { Object.assign(node.dataset, v); continue; }
      if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
        continue;
      }
      if (k === 'html') { node.innerHTML = v; continue; }
      if (k === 'text') { node.textContent = v; continue; }
      if (!isSvg && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected')) {
        node[k] = v;
        continue;
      }
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  add(node, kids);
  return node;
}

export function add(node, kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue;
    if (Array.isArray(kid)) { add(node, kid); continue; }
    node.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function frag(...kids) { return add(document.createDocumentFragment(), kids); }

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace a node's content in one paint. */
export function mount(node, ...kids) {
  const f = frag(...kids);
  clear(node);
  node.appendChild(f);
  return node;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Inline icon set. Stroked, 14px grid, currentColor. */
const ICONS = {
  search: 'M6.5 1a5.5 5.5 0 1 0 3.4 9.8l3.1 3.2.7-.7-3.1-3.2A5.5 5.5 0 0 0 6.5 1Zm0 1a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z',
  chevron: 'M5.5 3.5 10 8l-4.5 4.5',
  arrowUp: 'M8 12.5v-9M4 7.5 8 3.5l4 4',
  arrowDown: 'M8 3.5v9M4 8.5l4 4 4-4',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.7-4M13.5 2v3.5H10',
  expand: 'M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9',
  collapse: 'M13 3.5H9.5v-3.5M3 12.5h3.5v3.5M9.5 6.5 13.5 2.5M6.5 9.5 2.5 13.5',
  warn: 'M8 2.5 15 14H1L8 2.5ZM8 6.5v4M8 12h.01',
  info: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 7.5v4M8 4.8h.01',
  layers: 'M8 1.5 1.5 5 8 8.5 14.5 5 8 1.5ZM1.5 11 8 14.5 14.5 11M1.5 8 8 11.5 14.5 8',
  grid: 'M2 2h5v5H2V2Zm7 0h5v5H9V2ZM2 9h5v5H2V9Zm7 0h5v5H9V9Z',
  chart: 'M1.5 13.5h13M3.5 11V6M6.5 11V3M9.5 11V8M12.5 11V5',
  table: 'M1.5 2.5h13v11h-13v-11ZM1.5 6h13M6 6v7.5',
  bolt: 'M9 1.5 3 9h4l-1 5.5L13 7H9l1-5.5Z',
  radio: 'M8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10',
  coin: 'M8 1.8c3.4 0 6.2 1.4 6.2 3.1S11.4 8 8 8 1.8 6.6 1.8 4.9 4.6 1.8 8 1.8ZM1.8 4.9v6.2c0 1.7 2.8 3.1 6.2 3.1s6.2-1.4 6.2-3.1V4.9',
  calendar: 'M2.5 3.5h11v11h-11v-11ZM2.5 7h11M5.5 1.5v3M10.5 1.5v3',
  target: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M8 4.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z',
  book: 'M2 2.5h4.5A1.5 1.5 0 0 1 8 4v9.5A1.5 1.5 0 0 0 6.5 12H2v-9.5ZM14 2.5H9.5A1.5 1.5 0 0 0 8 4v9.5A1.5 1.5 0 0 1 9.5 12H14v-9.5Z',
  cpu: 'M4.5 4.5h7v7h-7v-7ZM6.5 1.5v3M9.5 1.5v3M6.5 11.5v3M9.5 11.5v3M1.5 6.5h3M1.5 9.5h3M11.5 6.5h3M11.5 9.5h3',
  sliders: 'M2 4.5h12M2 11.5h12M6 2.5v4M10.5 9.5v4',
  keyboard: 'M1.5 4h13v8h-13V4ZM4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7',
  moon: 'M13.5 9.3A5.8 5.8 0 0 1 6.7 2.5a5.8 5.8 0 1 0 6.8 6.8Z',
  eye: 'M8 3.5c-3.5 0-6 4.5-6 4.5s2.5 4.5 6 4.5 6-4.5 6-4.5-2.5-4.5-6-4.5Zm0 2.6a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z',
  empty: 'M2.5 4.5h11v9h-11v-9ZM2.5 4.5 8 9l5.5-4.5',
};

export function icon(name, size = 14) {
  const path = ICONS[name] || ICONS.info;
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('width', size);
  node.setAttribute('height', size);
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.3');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  node.appendChild(p);
  return node;
}

/**
 * Observe an element's box and call back at most once per frame.
 * Charts use this instead of a window resize listener so they also react to
 * panel maximise, rail collapse and density changes.
 */
export function onResize(el, fn) {
  let raf = 0;
  let last = '';
  let first = true;
  const ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (key === last) return;
    last = key;
    // The first measurement paints straight away. Deferring it to a frame
    // callback means a chart built in response to a click has to wait for the
    // next paint, and never arrives at all if the tab is not being rendered.
    // Later resizes stay debounced, which is what the frame callback is for.
    if (first) { first = false; fn(r.width, r.height); return; }
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { raf = 0; fn(r.width, r.height); });
  });
  ro.observe(el);
  return () => { if (raf) cancelAnimationFrame(raf); ro.disconnect(); };
}

/** Fuzzy subsequence match. Returns null, or {score, ranges} for highlighting. */
export function fuzzy(needle, hay) {
  if (!needle) return { score: 0, ranges: [] };
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const direct = h.indexOf(n);
  if (direct > -1) {
    return { score: 1000 - direct * 2 - (hay.length - n.length) * 0.1, ranges: [[direct, direct + n.length]] };
  }
  let i = 0;
  let score = 0;
  const ranges = [];
  let runStart = -1;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) {
      if (runStart === -1) runStart = j;
      score += runStart === j ? 4 : 8;
      if (j === 0 || h[j - 1] === ' ' || h[j - 1] === '/' || h[j - 1] === '-') score += 12;
      i++;
    } else if (runStart > -1) {
      ranges.push([runStart, j]);
      runStart = -1;
      score -= 1;
    }
  }
  if (runStart > -1) ranges.push([runStart, h.length]);
  if (i < n.length) return null;
  return { score, ranges };
}

/** Render a string with fuzzy match ranges wrapped in <mark>. */
export function highlight(text, ranges) {
  if (!ranges || !ranges.length) return document.createTextNode(text);
  const out = document.createDocumentFragment();
  let cur = 0;
  for (const [a, b] of ranges) {
    if (a > cur) out.appendChild(document.createTextNode(text.slice(cur, a)));
    const m = document.createElement('mark');
    m.textContent = text.slice(a, b);
    out.appendChild(m);
    cur = b;
  }
  if (cur < text.length) out.appendChild(document.createTextNode(text.slice(cur)));
  return out;
}
