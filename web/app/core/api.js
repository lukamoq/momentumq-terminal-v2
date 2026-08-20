/**
 * api.js — the single door to the backend.
 *
 * Three behaviours that carry most of the terminal's perceived speed:
 *   · in-flight de-duplication — a panel and a prefetch asking for the same
 *     endpoint share one request;
 *   · stale-while-revalidate — a cached payload renders immediately and the
 *     network result patches it in when it differs;
 *   · prefetch — hovering a tab warms every endpoint that tab needs, so the
 *     switch is a render, not a round trip.
 */

import { bus } from './bus.js';

const BASE = '';
const TTL = 120_000;          // payloads are daily-batch; 2 min is generous
const cache = new Map();      // url -> {t, data, bytes}
const inflight = new Map();   // url -> Promise

export const stats = { requests: 0, hits: 0, bytes: 0, lastMs: 0, errors: 0 };

function qsFrom(params) {
  if (!params) return '';
  const q = new URLSearchParams();
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') q.set(k, params[k]);
  }
  const str = q.toString();
  return str ? '?' + str : '';
}

/**
 * @param {string} path      e.g. '/api/scorecard'
 * @param {object} [params]  query string values
 * @param {object} [opt]     {force, signal, ttl}
 */
export function get(path, params, opt = {}) {
  const url = BASE + path + qsFrom(params);
  const now = Date.now();
  const hit = cache.get(url);

  if (!opt.force && hit && now - hit.t < (opt.ttl ?? TTL)) {
    stats.hits++;
    return Promise.resolve(hit.data);
  }
  if (inflight.has(url)) return inflight.get(url);

  const t0 = performance.now();
  const p = fetch(url, { signal: opt.signal, headers: { accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ApiError(res.status, `${res.status} ${res.statusText}`, path, body.slice(0, 240));
      }
      return res.json();
    })
    .then((data) => {
      stats.requests++;
      stats.lastMs = Math.round(performance.now() - t0);
      cache.set(url, { t: Date.now(), data });
      bus.emit('api:done', { url, ms: stats.lastMs });
      return data;
    })
    .catch((err) => {
      if (err.name === 'AbortError') throw err;
      stats.errors++;
      bus.emit('api:error', { url, err });
      // A stale payload beats an empty panel when the network blips.
      if (hit) return hit.data;
      throw err instanceof ApiError ? err : new ApiError(0, err.message || 'Network unreachable', path, '');
    })
    .finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}

export function post(path, body) {
  const t0 = performance.now();
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    stats.lastMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ApiError(res.status, `${res.status} ${res.statusText}`, path, t.slice(0, 240));
    }
    return res.json();
  });
}

export class ApiError extends Error {
  constructor(status, message, path, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

/** Load several endpoints at once; one rejection does not sink the rest. */
export async function all(spec) {
  const keys = Object.keys(spec);
  const settled = await Promise.allSettled(keys.map((k) => {
    const v = spec[k];
    return Array.isArray(v) ? get(v[0], v[1], v[2]) : get(v);
  }));
  const out = {};
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out[keys[i]] = r.value;
    else { out[keys[i]] = null; errors.push({ key: keys[i], err: r.reason }); }
  });
  out.$errors = errors;
  return out;
}

/** Warm the cache without blocking anything or surfacing failures. */
export function prefetch(paths) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => paths.forEach((p) => get(p).catch(() => {})), { timeout: 1200 });
  } else {
    setTimeout(() => paths.forEach((p) => get(p).catch(() => {})), 60);
  }
}

export function invalidate(prefix) {
  for (const k of cache.keys()) if (!prefix || k.startsWith(BASE + prefix)) cache.delete(k);
}

export function cacheSize() { return cache.size; }
