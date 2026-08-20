/**
 * keys.js — one keyboard map for the whole terminal.
 *
 * Bindings are registered with a scope. Only the top-most active scope plus
 * 'global' ever fire, which is what stops a table's j/k from stealing keys
 * while the command palette is open.
 *
 * Typing in a field suppresses everything except Escape and the palette
 * chord, so a search box never eats a shortcut and a shortcut never eats a
 * character.
 */

const bindings = new Map();   // scope -> Map(combo -> {fn, label, group, hidden})
const stack = ['module'];     // 'module' is the base scope; overlays push on top

function normalize(combo) {
  return combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .sort((a, b) => rank(a) - rank(b))
    .join('+');
}
const ORDER = { mod: 0, ctrl: 1, alt: 2, shift: 3 };
const rank = (p) => (p in ORDER ? ORDER[p] : 9);

// Punctuation gets a spoken name so bindings stay readable and escape-free.
const PUNCT = {
  ' ': 'space', '\\': 'backslash', '[': 'bracketleft', ']': 'bracketright',
  '/': 'slash', ',': 'comma', '.': 'period', ';': 'semicolon', "'": 'quote',
  '`': 'backtick', '-': 'minus', '=': 'equals',
};

function comboOf(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key;
  if (k in PUNCT) k = PUNCT[k];
  else k = k.toLowerCase();
  // Shift is implied by the printed character for punctuation like '?'.
  if (parts.includes('shift') && e.key.length === 1 && /[^a-z0-9]/i.test(e.key)) {
    parts.splice(parts.indexOf('shift'), 1);
  }
  parts.push(k);
  return parts.join('+');
}

export function bind(scope, combo, fn, meta = {}) {
  if (!bindings.has(scope)) bindings.set(scope, new Map());
  const map = bindings.get(scope);
  const keys = Array.isArray(combo) ? combo : [combo];
  for (const c of keys) map.set(normalize(c), { fn, ...meta, combo: keys[0] });
  return () => keys.forEach((c) => map.delete(normalize(c)));
}

/** Drop every binding a scope owns — modules call this on teardown. */
export function clearScope(scope) { bindings.delete(scope); }

export function pushScope(scope) {
  stack.push(scope);
  return () => popScope(scope);
}
export function popScope(scope) {
  const i = stack.lastIndexOf(scope);
  if (i > 0) stack.splice(i, 1);
}
export const topScope = () => stack[stack.length - 1];

const TYPING = /^(input|textarea|select)$/i;
function isTyping(el) {
  return !!el && (TYPING.test(el.tagName) || el.isContentEditable);
}

export function install() {
  window.addEventListener('keydown', (e) => {
    const combo = comboOf(e);
    const typing = isTyping(e.target);
    // While typing, only Escape and the palette chord may pass.
    if (typing && combo !== 'escape' && combo !== 'mod+k') return;

    const scopes = [stack[stack.length - 1], 'global'];
    for (const scope of scopes) {
      const entry = bindings.get(scope)?.get(combo);
      if (entry) {
        e.preventDefault();
        entry.fn(e);
        return;
      }
    }
  });
}

/** Everything currently bound, grouped — the shortcut sheet reads this. */
export function describe() {
  const groups = new Map();
  for (const [scope, map] of bindings) {
    for (const [, meta] of map) {
      if (!meta.label || meta.hidden) continue;
      const g = meta.group || (scope === 'global' ? 'Global' : 'Module');
      if (!groups.has(g)) groups.set(g, []);
      const list = groups.get(g);
      if (!list.some((x) => x.label === meta.label)) list.push({ combo: meta.combo, label: meta.label });
    }
  }
  return groups;
}

/** '⌘K' on a Mac, 'Ctrl K' elsewhere. */
export const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
export function keycaps(combo) {
  return combo.split('+').map((p) => {
    if (p === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
    if (p === 'shift') return IS_MAC ? '⇧' : 'Shift';
    if (p === 'alt') return IS_MAC ? '⌥' : 'Alt';
    if (p === 'escape') return 'Esc';
    if (p === 'backslash') return '\\';
    if (p === 'bracketleft') return '[';
    if (p === 'bracketright') return ']';
    if (p === 'slash') return '/';
    if (p === 'comma') return ',';
    if (p === 'period') return '.';
    if (p === 'minus') return '-';
    if (p === 'equals') return '=';
    if (p === 'arrowup') return '↑';
    if (p === 'arrowdown') return '↓';
    if (p === 'arrowleft') return '←';
    if (p === 'arrowright') return '→';
    if (p === 'enter') return '↵';
    if (p === 'space') return 'Space';
    if (p === 'home') return 'Home';
    if (p === 'end') return 'End';
    if (p === 'pageup') return 'PgUp';
    if (p === 'pagedown') return 'PgDn';
    if (p === 'tab') return 'Tab';
    return p.length === 1 ? p.toUpperCase() : p;
  });
}
