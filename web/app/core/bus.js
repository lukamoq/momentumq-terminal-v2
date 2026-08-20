/** bus.js — a 20-line event bus. Modules never reach into each other. */

const handlers = new Map();

export const bus = {
  on(evt, fn) {
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => bus.off(evt, fn);
  },
  off(evt, fn) { handlers.get(evt)?.delete(fn); },
  emit(evt, payload) {
    const set = handlers.get(evt);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (e) { console.error(`[bus:${evt}]`, e); }
    }
  },
};
