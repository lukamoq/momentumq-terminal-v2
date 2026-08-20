/**
 * router.js — hash routing with typed params.
 *
 * The URL is the terminal's shareable state: '#/options?u=QQQ&h=1_month'
 * reopens exactly the view someone was looking at. Params round-trip through
 * every module, so "send me this screen" is a copy of the address bar.
 */

import { bus } from './bus.js';

let current = { id: '', params: {} };
let suppress = false;

export function parse(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const params = {};
  if (query) for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { id: path || '', params };
}

export function build(id, params) {
  const q = new URLSearchParams();
  for (const k in params || {}) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  }
  const s = q.toString();
  return `#/${id}${s ? '?' + s : ''}`;
}

export const route = () => current;

/** Navigate. `replace` keeps the back button meaningful for view tweaks. */
export function go(id, params, { replace = false } = {}) {
  const href = build(id, params);
  if (href === location.hash) return;
  suppress = false;
  if (replace) history.replaceState(null, '', href);
  else location.hash = href;
  if (replace) read();
}

/** Update params of the current module without adding a history entry. */
export function patch(params, { replace = true } = {}) {
  go(current.id, { ...current.params, ...params }, { replace });
}

function read() {
  const next = parse();
  const changed = next.id !== current.id;
  current = next;
  bus.emit('route', { ...current, changed });
}

export function start(fallback) {
  window.addEventListener('hashchange', () => {
    if (suppress) { suppress = false; return; }
    read();
  });
  if (!location.hash || !parse().id) {
    history.replaceState(null, '', build(fallback, {}));
  }
  read();
}
