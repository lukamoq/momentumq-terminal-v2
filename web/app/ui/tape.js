/**
 * tape.js — the global market tape.
 *
 * Every quote on it is read from the same endpoints the modules use. The
 * legacy tape shipped hardcoded prices; a terminal that prints a number it
 * did not measure is worse than one that prints nothing, so this one renders
 * only what the API returned and drops the rest.
 */

import { h, mount, icon } from '../core/dom.js';
import { all } from '../core/api.js';
import { pp, num, money, isNum } from '../core/fmt.js';
import { store } from '../core/store.js';
import { bus } from '../core/bus.js';

export function Tape() {
  const track = h('div.tape__track', { 'aria-hidden': 'false' });
  const el = h('div.tape', { role: 'marquee', 'aria-label': 'Market tape' }, track);

  if (store.get('tapePaused')) el.classList.add('tape--paused');

  // Click toggles the crawl — a moving target is the classic tape complaint.
  el.addEventListener('click', () => {
    const paused = el.classList.toggle('tape--paused');
    store.set('tapePaused', paused);
  });
  el.title = 'Click to pause / resume the tape';

  function item(q) {
    const t = isNum(q.chg) ? (q.chg > 0 ? 'up' : q.chg < 0 ? 'down' : 'flat') : 'flat';
    return h('span.tape__item' + (q.vol ? '.tape__item--vol' : ''),
      h('span.tape__sym', q.sym),
      h('span.tape-val', q.val),
      q.chgText ? h('span.tape__chg.' + t, q.chgText) : null);
  }

  function paint(quotes) {
    if (!quotes.length) {
      mount(track, h('span.tape__item', h('span.tape__sym', 'TAPE'), h('span.tape-val.dim', 'no live quotes available')));
      return;
    }
    // Two copies so the -50% translate loop is seamless.
    const once = quotes.map(item);
    const twice = quotes.map(item);
    mount(track, ...once, ...twice);
  }

  async function load() {
    const d = await all({
      regime: '/api/macro/regime',
      fg: '/api/macro/fear-greed',
      vix: '/api/macro/vix-structure',
      stocks: '/api/mag7/stocks',
      crypto: '/api/crypto/overview',
      cmd: '/api/macro/commodities',
    });

    const q = [];
    const spot = d.regime?.factors?.spy_spot;
    if (isNum(spot)) {
      q.push({ sym: 'SPX PROXY', val: num(spot * 10, 0), chg: d.regime.factors.dist_50d_pct, chgText: pp(d.regime.factors.dist_50d_pct, 2) + ' vs 50D' });
    }
    if (d.regime?.regime_label) q.push({ sym: 'REGIME', val: d.regime.regime_label, chg: 0, chgText: `${num(d.regime.confidence_pct, 0)}% conf` });
    if (isNum(d.fg?.composite_score)) q.push({ sym: 'FEAR/GREED', val: `${num(d.fg.composite_score, 1)} / 100`, chg: d.fg.composite_score - 50, chgText: String(d.fg.label || '').toUpperCase() });
    if (isNum(d.vix?.iv_30d)) q.push({ sym: 'IV 30D', val: num(d.vix.iv_30d, 2) + '%', chg: -(d.vix.iv_premium || 0), chgText: `RV ${num(d.vix.realized_vol_21d, 1)}%`, vol: true });

    for (const st of (d.stocks || []).slice(0, 7)) {
      if (!isNum(st.latest_price)) continue;
      q.push({ sym: st.ticker, val: '$' + num(st.latest_price, 2), chg: st.return_ytd_2026, chgText: pp((st.return_ytd_2026 || 0) * 100, 2) + ' YTD' });
    }
    for (const c of (d.crypto?.assets || []).slice(0, 3)) {
      if (!isNum(c.spot)) continue;
      q.push({ sym: c.ticker, val: '$' + num(c.spot, c.spot > 500 ? 0 : 2), chg: c.chg_24h_pct, chgText: pp(c.chg_24h_pct, 2) });
    }
    for (const a of (d.cmd?.assets || []).slice(0, 3)) {
      if (!isNum(a.spot)) continue;
      q.push({ sym: a.ticker, val: '$' + num(a.spot, 2), chg: a.chg_1d_pct, chgText: pp(a.chg_1d_pct, 2) });
    }
    if (isNum(d.crypto?.headline?.total_crypto_market_cap_trillions)) {
      q.push({ sym: 'CRYPTO MCAP', val: '$' + num(d.crypto.headline.total_crypto_market_cap_trillions, 2) + 'T', chg: 0, chgText: `BTC DOM ${num(d.crypto.headline.btc_dominance_pct, 1)}%` });
    }

    paint(q);
    // Longer tapes need proportionally longer loops or they scroll like a strobe.
    track.style.animationDuration = `${Math.max(45, q.length * 5.5)}s`;
    bus.emit('tape:loaded', q.length);
  }

  paint([]);
  load().catch(() => paint([]));

  return { el, reload: () => load().catch(() => {}) };
}
