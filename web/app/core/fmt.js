/**
 * fmt.js — every number the terminal prints goes through here.
 *
 * Two rules the whole UI depends on:
 *   1. A missing value renders as an em dash, never as 0, "N/A" or "null".
 *   2. Significance is fixed per unit, so columns line up down the page.
 */

export const DASH = '—';

const nf = (min, max) => new Intl.NumberFormat('en-US', {
  minimumFractionDigits: min, maximumFractionDigits: max,
});
const CACHE = new Map();
function fixed(d) {
  const k = 'f' + d;
  if (!CACHE.has(k)) CACHE.set(k, nf(d, d));
  return CACHE.get(k);
}

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Plain number with fixed decimals. */
export function num(v, d = 2) {
  return isNum(v) ? fixed(d).format(v) : DASH;
}

/** Integer with thousands separators. */
export function int(v) {
  return isNum(v) ? fixed(0).format(Math.round(v)) : DASH;
}

/** A ratio in 0..1 rendered as a percent. pct(0.1234) -> "12.3%" */
export function pct(v, d = 1, signed = false) {
  if (!isNum(v)) return DASH;
  const s = fixed(d).format(v * 100) + '%';
  return signed && v > 0 ? '+' + s : s;
}

/** A value already expressed in percent points. pp(2.48) -> "+2.5%" */
export function pp(v, d = 1, signed = true) {
  if (!isNum(v)) return DASH;
  const s = fixed(d).format(v) + '%';
  return signed && v > 0 ? '+' + s : s;
}

export function signed(v, d = 2) {
  if (!isNum(v)) return DASH;
  return (v > 0 ? '+' : '') + fixed(d).format(v);
}

/** Money with an automatic magnitude suffix. Always 3 significant-ish digits. */
export function money(v, d = 2) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e12) return `${sign}$${fixed(2).format(a / 1e12)}T`;
  if (a >= 1e9)  return `${sign}$${fixed(2).format(a / 1e9)}B`;
  if (a >= 1e6)  return `${sign}$${fixed(1).format(a / 1e6)}M`;
  if (a >= 1e4)  return `${sign}$${fixed(0).format(a)}`;
  return `${sign}$${fixed(d).format(a)}`;
}

/** Compact count: 51,284 -> "51.3K". Used where width is scarce. */
export function compact(v) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${fixed(1).format(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}${fixed(1).format(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}${fixed(1).format(a / 1e3)}K`;
  return sign + fixed(0).format(a);
}

/** Basis points from a ratio. bps(0.0025) -> "+25 bp" */
export function bps(v, d = 0) {
  if (!isNum(v)) return DASH;
  return `${v > 0 ? '+' : ''}${fixed(d).format(v * 10000)} bp`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = MONTHS;

/** '2026-08-19' -> '19 Aug 26'. Parsed as calendar text, never as UTC instants. */
export function date(v, style = 'short') {
  if (!v) return DASH;
  const m = String(v).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(v);
  const [, y, mo, d] = m;
  const mon = MONTHS[+mo - 1];
  if (style === 'iso') return `${y}-${mo}-${d}`;
  if (style === 'month') return `${mon} ${y}`;
  if (style === 'long') return `${+d} ${mon} ${y}`;
  return `${+d} ${mon} ${y.slice(2)}`;
}

/** ISO instant -> local clock. */
export function time(v) {
  if (!v) return DASH;
  const t = new Date(v);
  if (Number.isNaN(+t)) return DASH;
  return t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function ago(v) {
  if (!v) return DASH;
  const t = new Date(v);
  if (Number.isNaN(+t)) return DASH;
  const s = Math.max(0, (Date.now() - +t) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Days -> "1y 4m" for cycle and horizon readouts. */
export function dur(days) {
  if (!isNum(days)) return DASH;
  const y = Math.floor(days / 365);
  const m = Math.floor((days % 365) / 30.44);
  if (y && m) return `${y}y ${m}m`;
  if (y) return `${y}y`;
  if (m) return `${m}m`;
  return `${Math.round(days)}d`;
}

/** Direction/verdict -> the semantic class the whole UI uses. */
export function tone(v) {
  const k = String(v || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (['BULLISH', 'HIT', 'UP', 'OVERWEIGHT', 'OVER_WEIGHT', 'BULL', 'LEADING', 'BUY',
       'STRONG_BUY', 'OUTPERFORM', 'ACCUMULATE', 'POSITIVE', 'AGREES'].includes(k)) return 'up';
  if (['BEARISH', 'MISS', 'DOWN', 'UNDERWEIGHT', 'UNDER_WEIGHT', 'BEAR', 'LAGGING', 'SELL',
       'STRONG_SELL', 'UNDERPERFORM', 'REDUCE', 'NEGATIVE'].includes(k)) return 'down';
  if (['NEUTRAL', 'HOLD', 'FLAT', 'MARKETWEIGHT', 'MARKET_WEIGHT', 'EQUALWEIGHT', 'EQUAL_WEIGHT',
       'INLINE', 'IN_LINE', 'WEAKENING', 'IMPROVING'].includes(k)) return 'flat';
  if (['TOO_EARLY', 'PENDING', 'UNRESOLVED', 'NOT_MEASURED', 'NO_DATA'].includes(k)) return 'na';
  return 'info';
}

/** Numeric sign -> semantic class, with a dead zone so noise is not coloured. */
export function dirTone(v, dead = 0) {
  if (!isNum(v)) return 'na';
  if (v > dead) return 'up';
  if (v < -dead) return 'down';
  return 'flat';
}

export function toneColor(t) {
  return { up: 'var(--up)', down: 'var(--down)', flat: 'var(--flat)', na: 'var(--void-ink)', info: 'var(--info)' }[t] || 'var(--ink-2)';
}

/** SCREAMING_SNAKE -> Title Case, for labels the API sends as enums. */
export function title(v) {
  if (!v) return DASH;
  return String(v).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** Safe JSON.parse for the string-encoded arrays the API returns. */
export function parseList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}
