/**
 * Options & dealer positioning.
 *
 * Every figure is computed from the observed chain — real strikes, real
 * settles, exchange-reported open interest. Where a chain has not been
 * ingested the panels say so and render dashes rather than a modelled guess.
 */

import { h, mount as fill, icon, onResize } from '../core/dom.js';
import { get } from '../core/api.js';
import { pct, num, int, money, compact, isNum, title as titleCase, date, DASH } from '../core/fmt.js';
import { padScroller, chartHost } from '../ui/panel.js';
import { segmented } from '../ui/table.js';
import { kpi, kpiGrid, note, readout, railRow, legend, chip, barRow } from '../ui/bits.js';
import { subhead } from '../ui/overlays.js';
import { LineChart, ProfileChart } from '../charts/plots.js';
import { showTip, hideTip } from '../charts/core.js';

const HORIZONS = [
  { value: '1_week', label: '7D' },
  { value: 'next_week', label: '14D' },
  { value: '1_month', label: '30D' },
];

export async function mount(ctx) {
  ctx.layout({
    cols: 'minmax(0, 1fr) minmax(320px, 26%)',
    rows: 'minmax(0, 1.1fr) minmax(0, 1fr)',
    areas: '"gex side" "vol side"',
  });

  const pGex = ctx.panel({ id: 'gex', index: '01', title: 'Dealer gamma by strike', area: 'gex', flex: true });
  const pVol = ctx.panel({ id: 'vol', index: '02', title: 'Volatility surface', area: 'vol', flex: true });
  const pSide = ctx.panel({ id: 'greeks', index: '03', title: 'Greeks & expected move', area: 'side' });
  pGex.loading('chart'); pVol.loading('chart'); pSide.loading('kpi');

  const railHead = ctx.railHead(h('span.label', 'Underlyings'), h('span.label', ''));
  const railBody = ctx.railBody();

  let data;
  try {
    data = await get('/api/analytics/options');
  } catch (err) {
    pGex.error(err); pVol.error(err); pSide.error(err);
    return { destroy() {} };
  }

  const indices = data.indices || data.assets || {};
  const tickers = Object.keys(indices);
  if (!tickers.length) {
    const msg = 'No option chain has been ingested. Run `python -m scorecard options` to populate the observed chain, then refresh.';
    pGex.empty(msg, 'No chain available'); pVol.empty(msg, 'No chain available'); pSide.empty(msg, 'No chain available');
    return { destroy() {} };
  }

  // A URL is typed and shared by hand, so every param is validated against the
  // values that actually exist. An unrecognised one falls back rather than
  // rendering a panel full of dashes.
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const hzKeys = HORIZONS.map((x) => x.value).filter((k) => Object.keys(indices[tickers[0]]?.horizons || {}).includes(k));
  const validHz = hzKeys.length ? hzKeys : HORIZONS.map((x) => x.value);

  const st = {
    u: pick(ctx.params.u, tickers, pick(ctx.prefs.u, tickers, tickers[0])),
    hz: pick(ctx.params.h, validHz, pick(ctx.prefs.hz, validHz, validHz[validHz.length - 1])),
    volView: pick(ctx.prefs.volView, ['smile', 'term'], 'smile'),
  };

  const cur = () => indices[st.u] || {};
  ctx.setStatus({ asOf: cur().as_of_date, rows: cur().contracts_observed, mode: 'Options & GEX' });

  /* -------------------------------------------------------------- rail */
  function drawRail() {
    const list = h('div.rlist', { role: 'listbox', 'aria-label': 'Underlyings' });
    for (const t of tickers) {
      const x = indices[t];
      const sel = t === st.u;
      const gexNeg = (x.structure?.net_gex_dollars ?? 0) < 0;
      list.appendChild(railRow({
        name: t,
        value: isNum(x.spot) ? '$' + num(x.spot, 2) : DASH,
        sub: [
          h('span', `IV ${num(x.vol_index_30d ?? x.implied_volatility, 1)}%`),
          h('span', { class: gexNeg ? 'down' : 'up' }, gexNeg ? 'short γ' : 'long γ'),
          h('span.dim', `${compact(x.contracts_observed)} ctr`),
        ],
        selected: sel,
        title: `${t} — ${x.expiries_observed} expiries, ${int(x.contracts_observed)} contracts observed`,
        onClick: () => select(t),
      }));
    }
    fill(railBody, list);
    railHead.lastChild.textContent = `${tickers.length} chains`;

    const x = cur();
    fill(ctx.rail.querySelector('.rail__foot') || ctx.railFoot(),
      h('div.stack', { style: { gap: 'var(--sp-2)' } },
        h('div.label', 'Chain inputs'),
        readout([
          { label: 'Snapshot', value: date(x.chain_snapshot_date) },
          { label: 'Contracts', value: int(x.contracts_observed) },
          { label: 'Expiries', value: int(x.expiries_observed) },
          { label: 'Risk-free', value: isNum(x.risk_free_rate) ? `${num(x.risk_free_rate, 2)}%` : DASH },
          { label: 'Dividend yield', value: isNum(x.dividend_yield) ? `${num(x.dividend_yield, 2)}%` : DASH },
        ])));
  }

  function select(t) {
    st.u = t;
    ctx.savePrefs({ u: t });
    ctx.patch({ u: t });
    drawRail(); drawGex(); drawVol(); drawSide();
    ctx.setStatus({ asOf: cur().as_of_date, rows: cur().contracts_observed });
  }

  /* --------------------------------------------------------------- gex */
  const gexBox = chartHost();
  const gexLegend = h('div', { style: { padding: '5px var(--panel-pad)', borderTop: '1px solid var(--line)' } });
  const gexWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, gexBox);
  let gexChart = null;

  function drawGex() {
    const x = cur();
    const stt = x.structure;
    gexChart?.destroy?.();
    gexBox.innerHTML = '';

    if (!stt || !stt.gex_profile?.length) {
      pGex.empty('Gamma exposure needs exchange-reported open interest, which this chain snapshot does not carry.');
      return;
    }

    pGex.render(
      h('div.verdict',
        h('div', h('div.verdict__l', 'Net GEX'),
          h('div.verdict__v', { style: { color: stt.gex_color || 'var(--ink-1)' } },
            `${stt.net_gex_dollars >= 0 ? '+' : '−'}$${num(Math.abs(stt.net_gex_dollars) / 1e9, 2)}B`)),
        h('div', { style: { minWidth: '0' } },
          h('div.row', { style: { gap: '6px', marginBottom: '3px' } },
            chip(stt.gex_regime, stt.net_gex_dollars >= 0 ? 'up' : 'down'),
            isNum(stt.gamma_flip) ? h('span.chip', `flip ${num(stt.gamma_flip, 2)} (${pct((stt.flip_distance_pct || 0) / 100, 2, true)})`) : h('span.chip.chip--na', 'flip not found'),
            h('span.chip', `max pain ${num(stt.max_pain, 0)}`)),
          h('div.meta.clamp-2', stt.gex_description))),
      gexWrap, gexLegend);

    // Focus the profile on the strikes that matter — the deep wings are noise.
    const rows = stt.gex_profile
      .filter((p) => Math.abs(p.moneyness_pct) <= 8)
      .map((p) => ({
        key: p.strike,
        label: num(p.strike, 0),
        value: p.net_gex,
        dim: Math.abs(p.moneyness_pct) > 5,
        title: `Strike ${num(p.strike, 0)} · ${pct(p.moneyness_pct / 100, 2, true)}`,
        rows: [
          { k: 'Net GEX', v: money(p.net_gex), tone: p.net_gex >= 0 ? 'var(--up)' : 'var(--down)' },
          { k: 'Call GEX', v: money(p.call_gex) },
          { k: 'Put GEX', v: money(p.put_gex) },
          { k: 'Call OI', v: int(p.call_oi) },
          { k: 'Put OI', v: int(p.put_oi) },
        ],
      }));

    gexChart = ProfileChart(gexBox, {
      rows,
      lines: [
        isNum(x.spot) ? { at: x.spot, color: 'var(--ink-1)', label: `spot ${num(x.spot, 2)}` } : null,
        isNum(stt.gamma_flip) ? { at: stt.gamma_flip, color: 'var(--gold)', label: 'gamma flip' } : null,
        isNum(stt.call_wall) ? { at: stt.call_wall, color: 'var(--up)', label: 'call wall' } : null,
        isNum(stt.put_wall) ? { at: stt.put_wall, color: 'var(--down)', label: 'put wall' } : null,
        isNum(stt.max_pain) ? { at: stt.max_pain, color: 'var(--info)', label: 'max pain' } : null,
      ].filter(Boolean),
      label: 'Net dealer gamma exposure by strike',
    });

    fill(gexLegend, h('div.row', { style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
      legend([
        { color: 'var(--up)', label: 'Positive net gamma', box: true },
        { color: 'var(--down)', label: 'Negative net gamma', box: true },
        { color: 'var(--gold)', label: 'Gamma flip' },
        { color: 'var(--info)', label: 'Max pain' },
      ]),
      h('span.tbar__count', stt.gex_basis_note || `${stt.gex_basis} · call OI ${compact(stt.total_call_oi)} / put OI ${compact(stt.total_put_oi)}`)));
    pGex.setMeta(`${rows.length} strikes within ±8% · ${date(x.chain_snapshot_date)}`);
  }

  /* --------------------------------------------------------------- vol */
  const volSeg = segmented(
    [{ value: 'smile', label: 'SKEW' }, { value: 'term', label: 'TERM' }],
    st.volView, (v) => { st.volView = v; ctx.savePrefs({ volView: v }); drawVol(); }, { label: 'Surface view' });
  pVol.tools.prepend(volSeg);

  const volBox = chartHost();
  const volLegend = h('div', { style: { padding: '5px var(--panel-pad)', borderTop: '1px solid var(--line)' } });
  const volWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, volBox);
  let volChart = null;

  function drawVol() {
    const x = cur();
    volChart?.destroy?.();
    volBox.innerHTML = '';
    pVol.render(volWrap, volLegend);

    if (st.volView === 'smile') {
      const smile = x.skew?.smile || [];
      if (!smile.length) { pVol.empty('No smile could be read off this chain at the required deltas.'); return; }
      // The smile belongs to one observed expiry. Marking the selected tenor's
      // own measured points on it shows how the skew moves with maturity, and
      // makes the tenor control visibly drive this chart rather than only the
      // side panel.
      const hz = x.horizons?.[st.hz];
      const tenorMarks = [];
      if (hz && isNum(x.spot)) {
        const pt = (g, name, mny, iv) => {
          if (!isNum(iv)) return;
          tenorMarks.push({
            xv: mny, y: iv, color: 'var(--gold)', r: 3.6,
            title: `${hz.dte}D ${name} — IV ${num(iv, 2)}%`,
          });
        };
        if (hz.put_25d) pt(hz.put_25d, '25Δ put', (hz.put_25d.strike / x.spot - 1) * 100, hz.put_25d.iv);
        pt(hz.atm, 'ATM', 0, hz.iv);
        if (hz.call_25d) pt(hz.call_25d, '25Δ call', (hz.call_25d.strike / x.spot - 1) * 100, hz.call_25d.iv);
      }

      volChart = LineChart(volBox, {
        x: smile.map((p) => p.moneyness_pct),
        series: [{ label: 'Implied vol', color: 'var(--brand-fg)', y: smile.map((p) => p.iv), thick: true, area: 'var(--brand)', areaOpacity: 0.1 }],
        markers: tenorMarks,
        yFmt: (v) => `${num(v, 0)}%`,
        xFmt: (v) => `${v > 0 ? '+' : ''}${v}%`,
        vLines: [{ i: smile.findIndex((p) => p.is_atm), color: 'var(--ink-3)', label: 'ATM' }],
        tipTitle: (i) => `Strike ${num(smile[i].strike, 2)} · ${pct(smile[i].moneyness_pct / 100, 1, true)}`,
        extraTipRows: (i) => [
          { k: 'Call Δ', v: num(smile[i].call_delta, 3) },
          { k: 'Put Δ', v: num(smile[i].put_delta, 3) },
          { k: 'Gamma', v: num(smile[i].gamma, 5) },
          { k: 'Vega', v: num(smile[i].vega, 3) },
        ],
        tipFmt: (v) => `${num(v, 2)}%`,
        label: 'Implied volatility across moneyness',
      });
      fill(volLegend, h('div.row', { style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
        legend([
          { color: 'var(--brand-fg)', label: `${st.u} smile — observed expiry ${date(x.skew?.expiry)}` },
          tenorMarks.length ? { color: 'var(--gold)', label: `${hz.dte}D constant-maturity points`, box: true } : null,
        ].filter(Boolean)),
        h('span.tbar__count', x.skew?.measured
          ? `25Δ skew ${num(x.skew.skew_25d, 2)} pts · put ${num(x.skew.put_25d_iv, 2)}% vs call ${num(x.skew.call_25d_iv, 2)}% · expiry ${date(x.skew.expiry)}`
          : 'skew not measurable on this chain')));
      pVol.setMeta(x.skew?.regime ? `${x.skew.regime}` : 'observed chain');
      return;
    }

    // Term structure: three constant-maturity points interpolated in variance.
    const curve = [
      { d: 9, v: x.vol_index_30d ? x.horizons?.['1_week']?.iv : null },
      { d: 30, v: x.vol_index_30d },
    ];
    const pts = [];
    if (isNum(x.horizons?.['1_week']?.iv)) pts.push({ d: 7, v: x.horizons['1_week'].iv, label: '7D' });
    if (isNum(x.horizons?.['next_week']?.iv)) pts.push({ d: 14, v: x.horizons['next_week'].iv, label: '14D' });
    if (isNum(x.horizons?.['1_month']?.iv)) pts.push({ d: 30, v: x.horizons['1_month'].iv, label: '30D' });
    if (!pts.length) { pVol.empty('No constant-maturity term structure available for this underlying.'); return; }

    volChart = LineChart(volBox, {
      x: pts.map((p) => p.d),
      series: [
        { label: 'Implied (constant maturity)', color: 'var(--brand-fg)', y: pts.map((p) => p.v), thick: true },
        { label: 'Realised 20D', color: 'var(--ink-4)', dash: true, y: pts.map(() => x.realized_vol_20d) },
      ],
      yFmt: (v) => `${num(v, 1)}%`,
      xFmt: (v) => `${v}D`,
      xTickCount: pts.length,
      vLines: (() => {
        const i = pts.findIndex((p) => p.d === (x.horizons?.[st.hz]?.dte));
        return i > -1 ? [{ i, color: 'var(--gold)', label: 'selected tenor' }] : [];
      })(),
      tipTitle: (i) => `${pts[i].label} tenor`,
      tipFmt: (v) => `${num(v, 2)}%`,
      label: 'Implied volatility term structure',
    });
    fill(volLegend, h('div.row', { style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
      legend([
        { color: 'var(--brand-fg)', label: 'Implied, interpolated in total variance' },
        { color: 'var(--ink-4)', label: `Realised 20D (${num(x.realized_vol_20d, 2)}%)` },
      ]),
      h('span.tbar__count', `IV premium ${num(x.iv_premium, 2)} pts`)));
    pVol.setMeta('interpolated linearly in σ²T — the only arbitrage-consistent choice in time');
  }

  /* -------------------------------------------------------------- side */
  const hzSeg = segmented(HORIZONS, st.hz, (v) => {
    st.hz = v;
    ctx.savePrefs({ hz: v });
    ctx.patch({ h: v });
    drawSide();
    drawVol();   // the surface marks the selected tenor, so it moves too
  }, { label: 'Horizon' });
  pSide.tools.prepend(h('span.label', { style: { flex: 'none' } }, 'Tenor'), hzSeg);

  function drawSide() {
    const x = cur();
    const hz = x.horizons?.[st.hz];
    const em = x.expected_moves || {};
    const pos = x.positioning || {};

    const emKey = st.hz === '1_week' ? 'weekly' : st.hz === 'next_week' ? 'next_week' : 'monthly';
    const move = em[emKey];

    pSide.setTitle(hz ? `${st.u} greeks · ${hz.dte}D` : `${st.u} greeks`);
    pSide.setMeta(hz ? `constant maturity ${hz.dte} DTE` : 'no horizon data');
    pSide.render(padScroller(h('div.stack',
      kpiGrid(2,
        kpi({ label: 'Spot', value: isNum(x.spot) ? '$' + num(x.spot, 2) : DASH, sub: `as of ${date(x.as_of_date)}` }),
        kpi({ label: hz ? `${hz.dte}D implied vol` : 'Implied vol',
              value: isNum(hz?.iv) ? `${num(hz.iv, 2)}%` : DASH,
              t: hz && x.realized_vol_20d > hz.iv ? 'up' : 'down',
              sub: `30D index ${num(x.vol_index_30d, 2)}% · realised 20D ${num(x.realized_vol_20d, 2)}%` })),

      move ? h('div', subhead(`Expected move · ${st.hz.replace('_', ' ')}`),
        h('div.flow',
          h('div.flow__s', h('div.flow__k', '−2σ'), h('div.flow__v.down', num(move.lower_2s ?? (x.spot - 2 * (move.dollar || 0)), 2))),
          h('div.flow__s', h('div.flow__k', '−1σ'), h('div.flow__v.down', num(move.lower_1s, 2))),
          h('div.flow__s.is-now', h('div.flow__k', 'spot'), h('div.flow__v', num(x.spot, 2))),
          h('div.flow__s', h('div.flow__k', '+1σ'), h('div.flow__v.up', num(move.upper_1s, 2))),
          h('div.flow__s', h('div.flow__k', '+2σ'), h('div.flow__v.up', num(move.upper_2s ?? (x.spot + 2 * (move.dollar || 0)), 2)))),
        h('div.meta', { style: { marginTop: '6px' } },
          `±${num(move.dollar, 2)} (${num(move.pct, 2)}%) priced at this tenor's own implied volatility of ${num(move.iv, 2)}%, not one level fanned out by √t.`)) : null,

      hz ? h('div', subhead('At-the-money'), greekTable(hz.atm)) : null,
      hz?.call_25d ? h('div', subhead(`25Δ call — strike ${num(hz.call_25d.strike, 0)}, IV ${num(hz.call_25d.iv, 2)}%`), greekTable(hz.call_25d)) : null,
      hz?.put_25d ? h('div', subhead(`25Δ put — strike ${num(hz.put_25d.strike, 0)}, IV ${num(hz.put_25d.iv, 2)}%`), greekTable(hz.put_25d)) : null,

      h('div', subhead('Positioning'), readout([
        { label: 'Put/call — volume', value: num(pos.pcr_volume, 3), t: pos.pcr_volume > 1 ? 'down' : 'up' },
        { label: 'Put/call — open interest', value: num(pos.pcr_oi, 3), t: pos.pcr_oi > 1 ? 'down' : 'up' },
        { label: 'Call open interest', value: compact(pos.call_oi) },
        { label: 'Put open interest', value: compact(pos.put_oi) },
        { label: 'Hedging bias', value: pos.hedging_bias },
      ])),

      note(h('strong', 'Observed inputs only. '),
        'Implied volatility is read off the surface at the forward, open interest is the exchange print, the discount rate is the constant-maturity Treasury curve interpolated at each option’s own maturity, and the dividend yield is trailing twelve-month cash dividends over spot. Greeks are closed-form Black-Scholes-Merton with cost of carry ',
        h('code', 'b = r − q'), '.'),
    )));
  }

  function greekTable(g) {
    if (!g) return h('div.meta', 'not available at this tenor');
    return readout([
      { label: 'Call / put price', value: `${num(g.call_price, 2)} / ${num(g.put_price, 2)}` },
      { label: 'Delta (call / put)', value: `${num(g.call_delta, 3)} / ${num(g.put_delta, 3)}` },
      { label: 'Gamma', value: num(g.gamma, 5) },
      { label: 'Vega (per 1% IV)', value: num(g.vega, 3) },
      { label: 'Theta (call / put, per day)', value: `${num(g.call_theta, 3)} / ${num(g.put_theta, 3)}`, t: 'down' },
      { label: 'Rho (call / put)', value: `${num(g.call_rho, 3)} / ${num(g.put_rho, 3)}` },
      { label: 'Vanna (∂Δ/∂σ)', value: num(g.vanna, 4) },
      { label: 'Charm (∂Δ/∂t)', value: num(g.charm_call, 4) },
    ]);
  }

  /* ---------------------------------------------------------- commands */
  ctx.commands(() => [
    ...tickers.map((t) => ({ id: 'opt:' + t, group: 'Underlyings', icon: 'sliders', title: `${t} option chain`, hint: `$${num(indices[t].spot, 2)}`, run: () => select(t) })),
    ...HORIZONS.map((x) => ({ id: 'hz:' + x.value, group: 'Horizon', icon: 'calendar', title: `Horizon: ${x.label}`, run: () => { hzSeg.setValue(x.value); st.hz = x.value; drawSide(); } })),
    { id: 'vol:smile', group: 'Options', icon: 'chart', title: 'Surface: volatility skew', run: () => { volSeg.setValue('smile'); st.volView = 'smile'; drawVol(); } },
    { id: 'vol:term', group: 'Options', icon: 'chart', title: 'Surface: term structure', run: () => { volSeg.setValue('term'); st.volView = 'term'; drawVol(); } },
  ]);

  drawRail(); drawGex(); drawVol(); drawSide();
  const off1 = onResize(gexWrap, () => gexChart?.redraw?.());
  const off2 = onResize(volWrap, () => volChart?.redraw?.());
  return { destroy() { off1(); off2(); gexChart?.destroy?.(); volChart?.destroy?.(); } };
}
