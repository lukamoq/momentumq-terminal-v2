/**
 * Crypto — spot universe, institutional flows and the halving cycle.
 *
 * The cycle panel overlays the four post-halving trajectories on one
 * day-since-halving axis with the current cycle marked, which is the only
 * honest way to compare "where we are" against "where we were".
 */

import { h, mount as fill, icon, onResize } from '../core/dom.js';
import { all, get } from '../core/api.js';
import { pct, num, int, money, compact, isNum, title as titleCase, date, dur, DASH } from '../core/fmt.js';
import { padScroller, chartHost } from '../ui/panel.js';
import { segmented } from '../ui/table.js';
import { kpi, kpiGrid, note, readout, railRow, legend, chip, barRow } from '../ui/bits.js';
import { subhead, fields, prose } from '../ui/overlays.js';
import { LineChart, Gauge } from '../charts/plots.js';
import { matrixTable } from './macro.js';

export async function mount(ctx) {
  ctx.layout({
    cols: 'minmax(0, 1fr) minmax(320px, 26%)',
    rows: 'minmax(0, 1fr) minmax(0, 1.05fr)',
    areas: '"price side" "cycle side"',
  });

  const pPrice = ctx.panel({ id: 'price', index: '01', title: 'Price history', area: 'price', flex: true });
  const pCycle = ctx.panel({ id: 'cycle', index: '02', title: 'Halving cycle', area: 'cycle', flex: true });
  const pSide = ctx.panel({ id: 'side', index: '03', title: 'Asset dossier', area: 'side' });
  pPrice.loading('chart'); pCycle.loading('chart'); pSide.loading('kpi');

  const railHead = ctx.railHead(h('span.label', 'Universe'), h('span.label', ''));
  const railBody = ctx.railBody();

  const d = await all({
    overview: '/api/crypto/overview',
    sentiment: '/api/crypto/sentiment',
    cycles: '/api/crypto/halving-cycles',
    corr: '/api/crypto/correlations',
  });

  if (!d.overview) {
    const err = d.$errors[0]?.err;
    pPrice.error(err); pCycle.error(err); pSide.error(err);
    return { destroy() {} };
  }

  const ov = d.overview;
  const sent = d.sentiment || {};
  const cyc = d.cycles || {};
  const corr = d.corr || {};
  const assets = ov.assets || [];

  ctx.setStatus({ asOf: ov.as_of_date, rows: assets.length, mode: 'Crypto' });

  const st = {
    ticker: ctx.params.t || ctx.prefs.ticker || assets[0]?.ticker || 'BTC',
    priceView: ctx.prefs.priceView || 'price',
    cycleView: ctx.prefs.cycleView || 'curves',
    hist: null,
  };

  /* -------------------------------------------------------------- rail */
  function drawRail() {
    const list = h('div.rlist', { role: 'listbox', 'aria-label': 'Crypto assets' });
    list.appendChild(h('div.rlist__sep', 'Spot'));
    for (const a of assets) {
      const sel = a.ticker === st.ticker;
      list.appendChild(railRow({
        name: a.ticker,
        value: isNum(a.spot) ? '$' + num(a.spot, a.spot > 500 ? 0 : 2) : DASH,
        sub: [
          h('span', { class: a.chg_24h_pct > 0 ? 'up' : 'down' }, `${a.chg_24h_pct > 0 ? '+' : ''}${num(a.chg_24h_pct, 2)}% 24h`),
          h('span.dim', money((a.market_cap_billions || 0) * 1e9)),
        ],
        selected: sel,
        title: `${a.name} — ${a.category}`,
        onClick: () => select(a.ticker),
      }));
    }
    list.appendChild(h('div.rlist__sep', 'Spot ETFs'));
    for (const e of ov.etfs || []) {
      list.appendChild(h('div.rlist__item', { style: { cursor: 'default' }, title: `${e.name} — custodian ${e.custodian}` },
        h('span.rlist__name', e.ticker),
        h('span.rlist__val', isNum(e.spot) ? '$' + num(e.spot, 2) : DASH),
        h('span.rlist__sub',
          h('span.dim', `AUM ${money((e.aum_billions || 0) * 1e9)}`),
          h('span', { class: e.net_inflows_30d_millions >= 0 ? 'up' : 'down' },
            `${e.net_inflows_30d_millions >= 0 ? '+' : ''}${money((e.net_inflows_30d_millions || 0) * 1e6)} 30d`))));
    }
    fill(railBody, list);
    railHead.lastChild.textContent = `${assets.length} assets`;

    const hl = ov.headline || {};
    fill(ctx.rail.querySelector('.rail__foot') || ctx.railFoot(),
      readout([
        { label: 'Total market cap', value: isNum(hl.total_crypto_market_cap_trillions) ? `$${num(hl.total_crypto_market_cap_trillions, 2)}T` : DASH },
        { label: 'BTC dominance', value: `${num(hl.btc_dominance_pct, 1)}%` },
        { label: 'ETH dominance', value: `${num(hl.eth_dominance_pct, 1)}%` },
        { label: 'ETH/BTC', value: num(hl.eth_btc_ratio, 5) },
        { label: 'ETF net inflow 30d', value: isNum(hl.net_etf_inflows_30d_billions) ? `$${num(hl.net_etf_inflows_30d_billions, 2)}B` : DASH, t: hl.net_etf_inflows_30d_billions > 0 ? 'up' : 'down' },
      ]));
  }

  async function select(t) {
    if (st.ticker === t && st.hist) return;
    st.ticker = t;
    ctx.savePrefs({ ticker: t });
    ctx.patch({ t });
    drawRail(); drawSide();
    await loadHistory();
  }

  /* ------------------------------------------------------------- price */
  const priceSeg = segmented(
    [{ value: 'price', label: 'PRICE' }, { value: 'rsi', label: 'RSI' }, { value: 'vol', label: 'VOL' }],
    st.priceView, (v) => { st.priceView = v; ctx.savePrefs({ priceView: v }); drawPrice(); }, { label: 'Series' });
  pPrice.tools.prepend(priceSeg);

  const priceBox = chartHost();
  const priceLegend = h('div', { style: { padding: '5px var(--panel-pad)', borderTop: '1px solid var(--line)' } });
  const priceWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, priceBox);
  let priceChart = null;

  async function loadHistory() {
    pPrice.loading('chart');
    try {
      st.hist = await get('/api/crypto/history', { ticker: st.ticker, lookback: 365 });
      drawPrice();
    } catch (err) {
      pPrice.error(err, loadHistory);
    }
  }

  function drawPrice() {
    const hst = st.hist;
    if (!hst?.dates?.length) { pPrice.empty(`No price history stored for ${st.ticker}.`); return; }
    priceChart?.destroy?.();
    priceBox.innerHTML = '';
    pPrice.render(priceWrap, priceLegend);

    let series;
    let yFmt;
    let refLines = [];
    if (st.priceView === 'rsi') {
      series = [{ label: 'RSI 14', color: 'var(--c6)', y: hst.rsi_14, thick: true }];
      yFmt = (v) => num(v, 0);
      refLines = [
        { y: 70, color: 'var(--down)', label: 'overbought' },
        { y: 50, color: 'var(--ink-4)', label: '' },
        { y: 30, color: 'var(--up)', label: 'oversold' },
      ];
    } else if (st.priceView === 'vol') {
      series = [{ label: 'Realised vol 21D', color: 'var(--flat)', y: hst.realized_vol_21d, thick: true, area: 'var(--flat)', areaOpacity: 0.12 }];
      yFmt = (v) => `${num(v, 0)}%`;
    } else {
      series = [
        { label: st.ticker, color: 'var(--gold)', y: hst.close, thick: true },
        { label: '50D SMA', color: 'var(--c1)', y: hst.sma_50, width: 1 },
        { label: '200D SMA', color: 'var(--c4)', y: hst.sma_200, width: 1 },
      ];
      yFmt = (v) => (v >= 1000 ? compact(v) : num(v, 2));
    }

    priceChart = LineChart(priceBox, {
      x: hst.dates,
      series,
      yFmt,
      refLines,
      domain: st.priceView === 'rsi' ? [0, 100] : undefined,
      xFmt: (v) => date(v, 'month'),
      tipTitle: (i) => date(hst.dates[i], 'long'),
      tipFmt: (v) => (st.priceView === 'price' ? num(v, 2) : num(v, 2)),
      label: `${st.ticker} history`,
    });
    fill(priceLegend, legend(series.map((s) => ({ color: s.color, label: s.label }))));
    pPrice.setTitle(`${st.ticker} price history`);
    pPrice.setMeta(`${hst.dates.length} sessions · ${date(hst.dates[0])} → ${date(hst.dates[hst.dates.length - 1])}`);
  }

  /* ------------------------------------------------------------- cycle */
  const cycleSeg = segmented(
    [{ value: 'curves', label: 'CURVES' }, { value: 'phases', label: 'PHASES' },
     { value: 'ledger', label: 'LEDGER' }, { value: 'corr', label: 'CORRELATION' }],
    st.cycleView, (v) => { st.cycleView = v; ctx.savePrefs({ cycleView: v }); drawCycle(); }, { label: 'Cycle view' });
  pCycle.tools.prepend(cycleSeg);

  const cycleBox = chartHost();
  const cycleLegend = h('div', { style: { padding: '5px var(--panel-pad)', borderTop: '1px solid var(--line)' } });
  const cycleWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, cycleBox);
  let cycleChart = null;

  function drawCycle() {
    cycleChart?.destroy?.();
    cycleBox.innerHTML = '';

    if (st.cycleView === 'corr') {
      const tickers = corr.tickers || [];
      if (!tickers.length) { pCycle.empty('No correlation matrix available.'); return; }
      pCycle.render(
        h('div.tbar', h('span.tbar__count', `${corr.lookback_days}-day window · ${tickers.length} assets`)),
        h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0', padding: '0 var(--panel-pad) var(--panel-pad)' } },
          matrixTable(tickers, (i, j) => corr.matrix?.[tickers[i]]?.[tickers[j]], { cell: 36 })));
      pCycle.setMeta('crypto against equities, gold and treasuries');
      return;
    }

    if (st.cycleView === 'phases') {
      const phases = cyc.phases || [];
      const hud = cyc.active_cycle_hud || {};
      if (!phases.length) { pCycle.empty('No phase model available.'); return; }
      pCycle.render(
        h('div.verdict',
          h('div', h('div.verdict__l', 'Day since halving'), h('div.verdict__v', int(hud.days_elapsed))),
          h('div', { style: { minWidth: '0' } },
            h('div.row', { style: { gap: '6px', marginBottom: '3px' } },
              chip(hud.current_phase, 'brand'),
              h('span.chip', `next: ${hud.next_major_milestone} ${date(hud.next_major_date)}`),
              h('span.chip', `halving 5: ${date(hud.next_halving_date)}`)),
            h('div.meta.clamp-2', hud.key_takeaway))),
        h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0', padding: 'var(--panel-pad)' } },
          h('div', ...phases.map((p) => h('div.phase' + (p.status === 'ACTIVE' || p.status === 'IN_PROGRESS' ? '.is-live' : p.progress_pct >= 100 ? '.is-done' : ''),
            h('div.phase__n', String(p.phase_num)),
            h('div',
              h('div.row', { style: { justifyContent: 'space-between', gap: '8px' } },
                h('span.phase__t', p.phase_name),
                h('span.chip' + (p.status === 'ACTIVE' ? '.chip--brand' : ''), `${p.day_range} · ${titleCase(p.status)}`)),
              h('div.meter', { style: { margin: '5px 0' } }, h('i', { style: { width: `${Math.min(100, p.progress_pct || 0)}%`, background: p.progress_pct >= 100 ? 'var(--up)' : 'var(--brand-fg)' } })),
              h('div.phase__d', p.historical_behavior),
              h('div.phase__d.dim', p.market_mechanics),
              p.inflection_point ? h('div.meta', { style: { marginTop: '4px', color: 'var(--gold-fg)' } }, `Inflection: ${p.inflection_point}`) : null))))));
      pCycle.setMeta(cyc.active_cycle?.cycle_name || 'active cycle');
      return;
    }

    if (st.cycleView === 'ledger') {
      const ledger = cyc.milestones_ledger || [];
      const flows = cyc.full_cycle_flows || [];
      if (!ledger.length) { pCycle.empty('No milestone ledger available.'); return; }
      pCycle.render(
        h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } },
          h('table.tbl',
            h('thead', h('tr',
              h('th', 'Cycle'), h('th', 'Halving'), h('th.num', 'Price'),
              h('th', 'Breakout'), h('th.num', 'Days'), h('th.num', 'Months'), h('th.num', 'Price'),
              h('th', 'Peak'), h('th.num', 'Days'), h('th.num', 'Months'), h('th.num', 'Price'))),
            h('tbody', ...ledger.map((m) => h('tr',
              h('td.strong', m.cycle_label),
              h('td', date(m.halving_date)),
              h('td.num', money(m.halving_price)),
              h('td', date(m.breakout_date)),
              h('td.num', int(m.breakout_days)),
              h('td.num', num(m.breakout_months, 1)),
              h('td.num', money(m.breakout_price)),
              h('td', date(m.peak_date)),
              h('td.num', int(m.peak_days)),
              h('td.num', num(m.peak_months, 1)),
              h('td.num.up', money(m.peak_price)))))),
          flows.length ? h('div', { style: { padding: 'var(--panel-pad)' } },
            h('div.label', { style: { marginBottom: '8px' } }, 'End-to-end lifecycle'),
            ...flows.map((f) => h('div', { style: { marginBottom: '10px' } },
              h('div.row', { style: { justifyContent: 'space-between', marginBottom: '4px' } },
                h('span', { style: { color: 'var(--ink-1)', fontSize: 'var(--t-meta)' } }, f.cycle_title),
                h('span.chip' + (f.status === 'ACTIVE' ? '.chip--brand' : ''), f.timeframe)),
              h('div.flow',
                ...['start_halving', 'chop_phase', 'breakout', 'macro_peak', 'bear_trough', 'winter_base', 'rises_again', 'next_halving']
                  .filter((k) => f[k])
                  .map((k) => h('div.flow__s' + (f.status === 'ACTIVE' && k === 'chop_phase' ? '.is-now' : ''),
                    h('div.flow__k', titleCase(k)),
                    h('div.flow__v', String(f[k]))))))) ) : null));
      pCycle.setMeta(`${ledger.length} cycles`);
      return;
    }

    // Curves — the default view.
    const curves = cyc.cycle_curves || [];
    if (!curves.length) { pCycle.empty('No cycle trajectory data available.'); return; }
    pCycle.render(cycleWrap, cycleLegend);

    const keys = [
      { k: 'cycle1', label: '2012 cycle', color: 'var(--c8)' },
      { k: 'cycle2', label: '2016 cycle', color: 'var(--c6)' },
      { k: 'cycle3', label: '2020 cycle', color: 'var(--c5)' },
      { k: 'cycle4', label: '2024 cycle (live)', color: 'var(--gold)', thick: true },
      { k: 'cycle4_proj', label: '2024 projection', color: 'var(--gold)', proj: true },
      { k: 'median', label: 'Median path', color: 'var(--up)', thick: true },
    ].filter((s) => curves.some((p) => isNum(p[s.k])));

    const active = cyc.active_cycle || {};
    const nowIdx = curves.findIndex((p) => p.day >= (active.days_post_halving || 0));

    cycleChart = LineChart(cycleBox, {
      x: curves.map((p) => p.day),
      series: keys.map((s) => ({ label: s.label, color: s.color, thick: s.thick, proj: s.proj, y: curves.map((p) => p[s.k]) })),
      logY: true,
      logMin: 0.5,
      yFmt: (v) => `${v >= 10 ? num(v, 0) : num(v, 1)}×`,
      xFmt: (v) => `D${v}`,
      xTickCount: 8,
      refLines: [{ y: 1, color: 'var(--ink-4)', label: 'halving price' }],
      vLines: nowIdx > -1 ? [{ i: nowIdx, color: 'var(--brand-fg)', label: `today · D${active.days_post_halving}` }] : [],
      tipTitle: (i) => `Day ${curves[i].day} — ${curves[i].month} · ${titleCase(curves[i].phase || '')}`,
      tipFmt: (v) => `${num(v, 2)}× halving price`,
      maxPoints: 400,
      label: 'Bitcoin post-halving trajectories, indexed to the halving price',
    });

    fill(cycleLegend, h('div.row', { style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
      legend(keys.map((s) => ({ color: s.color, label: s.label }))),
      h('span.tbar__count', cyc.timing_roadmap
        ? `median peak D${cyc.timing_roadmap.days_to_peak_median} (${cyc.timing_roadmap.peak_window})`
        : '')));
    pCycle.setMeta(`${active.cycle_name || 'active cycle'} · day ${int(active.days_post_halving)} · ${titleCase(active.cycle_phase || '')}`);
    pCycle.setFoot(h('span.clamp-2', cyc.structural_takeaway || ''));
  }

  /* -------------------------------------------------------------- side */
  function drawSide() {
    const a = assets.find((x) => x.ticker === st.ticker) || assets[0];
    const gaugeHost = h('div', { style: { position: 'relative', height: '124px' } });
    if (!a) { pSide.empty('No asset selected.'); return; }

    pSide.setTitle(a.ticker);
    pSide.setMeta(a.category);
    pSide.render(padScroller(h('div.stack',
      h('div',
        h('div', { style: { fontSize: 'var(--t-lead)', color: 'var(--ink-1)' } }, a.name),
        h('div.row', { style: { marginTop: '5px' } },
          chip(a.trend_posture, a.trend_posture?.includes('BULL') || a.trend_posture?.includes('RECOVERY') ? 'up' : a.trend_posture?.includes('BEAR') ? 'down' : 'flat'),
          h('span.chip', `${num(a.dominance_pct, 1)}% dominance`))),

      kpiGrid(2,
        kpi({ label: 'Spot', value: isNum(a.spot) ? '$' + num(a.spot, a.spot > 500 ? 0 : 2) : DASH,
              t: a.chg_24h_pct > 0 ? 'up' : 'down',
              sub: `24h ${a.chg_24h_pct > 0 ? '+' : ''}${num(a.chg_24h_pct, 2)}% · 7d ${a.chg_7d_pct > 0 ? '+' : ''}${num(a.chg_7d_pct, 2)}%` }),
        kpi({ label: 'From all-time high', value: `${num(a.pct_from_ath, 1)}%`,
              t: a.pct_from_ath > -10 ? 'up' : 'down', bar: Math.max(0, 1 + (a.pct_from_ath || 0) / 100), barColor: 'var(--gold)',
              sub: `ATH ${money(a.ath)}` })),

      h('div', subhead('Market'), readout([
        { label: 'Market cap', value: money((a.market_cap_billions || 0) * 1e9) },
        { label: '30d change', value: `${a.chg_30d_pct > 0 ? '+' : ''}${num(a.chg_30d_pct, 2)}%`, t: a.chg_30d_pct > 0 ? 'up' : 'down' },
        { label: '1y change', value: `${a.chg_1y_pct > 0 ? '+' : ''}${num(a.chg_1y_pct, 2)}%`, t: a.chg_1y_pct > 0 ? 'up' : 'down' },
        { label: '52w range', value: `${money(a.low_52w)} – ${money(a.high_52w)}` },
        { label: '50D SMA', value: money(a.sma_50), t: a.spot > a.sma_50 ? 'up' : 'down' },
        { label: '200D SMA', value: money(a.sma_200), t: a.spot > a.sma_200 ? 'up' : 'down' },
        { label: 'RSI 14', value: num(a.rsi_14, 1), t: a.rsi_14 > 70 ? 'up' : a.rsi_14 < 30 ? 'down' : null },
        { label: 'Realised vol 30d', value: `${num(a.rvol_30d, 1)}%` },
      ])),

      h('div', subhead('Crypto fear & greed'), gaugeHost,
        h('div.cats', ...(sent.categories || []).map((c) => barRow({
          label: c.name, value: num(c.score, 0), ratio: c.score / 100,
          color: c.score >= 60 ? 'var(--up)' : c.score <= 40 ? 'var(--down)' : 'var(--flat)',
          sub: `weight ${c.weight}% · ${c.desc}`,
        })))),

      cyc.active_cycle ? h('div', subhead('Active halving cycle'), readout([
        { label: 'Cycle', value: cyc.active_cycle.cycle_name },
        { label: 'Halving', value: `${date(cyc.active_cycle.halving_date)} @ ${money(cyc.active_cycle.halving_price)}` },
        { label: 'Days elapsed', value: `${int(cyc.active_cycle.days_post_halving)} (${dur(cyc.active_cycle.days_post_halving)})` },
        { label: 'Multiple of halving price', value: `${num(cyc.active_cycle.current_multiple, 2)}×`, t: cyc.active_cycle.current_multiple > 1 ? 'up' : 'down' },
        { label: 'Phase', value: titleCase(cyc.active_cycle.cycle_phase) },
        { label: 'Projected peak window', value: cyc.active_cycle.projected_peak_window },
        { label: 'Projected trough window', value: cyc.active_cycle.projected_trough_window },
      ])) : null,

      cyc.calculation_formulas?.length ? h('div', subhead('How the projections are derived'),
        ...cyc.calculation_formulas.map((f) => h('div', { style: { padding: '6px 0', borderBottom: '1px solid var(--line-hair)' } },
          h('div', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-1)' } }, f.milestone),
          h('div.meta', { style: { fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' } }, f.formula),
          h('div.meta', `${f.historical_data} → median ${f.median_metric}`),
          f.next_target_date ? h('div.meta', { style: { color: 'var(--gold-fg)' } }, `Next target: ${f.next_target_date}`) : null))) : null,

      note(h('strong', 'A four-cycle sample is a small sample. '),
        'The projected windows are the median of three completed cycles carried forward from the 2024 halving. They describe what happened before, not what must happen next.'),
    )));

    Gauge(gaugeHost, {
      value: sent.score ?? 0,
      display: num(sent.score, 1),
      label: sent.label,
      color: sent.score >= 60 ? 'var(--up)' : sent.score <= 40 ? 'var(--down)' : 'var(--flat)',
    });
  }

  /* ---------------------------------------------------------- commands */
  ctx.commands(() => [
    ...assets.map((a) => ({ id: 'c:' + a.ticker, group: 'Crypto', icon: 'coin', title: `${a.ticker} — ${a.name}`, hint: `$${num(a.spot, 0)}`, run: () => select(a.ticker) })),
    { id: 'c:curves', group: 'Cycle', icon: 'chart', title: 'Cycle: overlaid trajectories', run: () => { cycleSeg.setValue('curves'); st.cycleView = 'curves'; drawCycle(); } },
    { id: 'c:phases', group: 'Cycle', icon: 'layers', title: 'Cycle: phase ladder', run: () => { cycleSeg.setValue('phases'); st.cycleView = 'phases'; drawCycle(); } },
    { id: 'c:ledger', group: 'Cycle', icon: 'table', title: 'Cycle: milestone ledger', run: () => { cycleSeg.setValue('ledger'); st.cycleView = 'ledger'; drawCycle(); } },
    { id: 'c:corr', group: 'Cycle', icon: 'grid', title: 'Cross-asset correlation', run: () => { cycleSeg.setValue('corr'); st.cycleView = 'corr'; drawCycle(); } },
  ]);

  drawRail(); drawSide(); drawCycle();
  await loadHistory();
  const off1 = onResize(priceWrap, () => priceChart?.redraw?.());
  const off2 = onResize(cycleWrap, () => cycleChart?.redraw?.());
  return { destroy() { off1(); off2(); priceChart?.destroy?.(); cycleChart?.destroy?.(); } };
}
