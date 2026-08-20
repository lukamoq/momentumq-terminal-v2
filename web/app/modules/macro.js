/**
 * Macro — regime, sentiment, volatility term structure, rotation, commodities.
 *
 * The regime call sits above the evidence, and every category that could not
 * be measured says so and scores a neutral 50 rather than quietly dropping
 * out of the weighted average.
 */

import { h, mount as fill, icon, onResize } from '../core/dom.js';
import { all } from '../core/api.js';
import { pct, num, int, isNum, title as titleCase, date, DASH, compact } from '../core/fmt.js';
import { padScroller, chartHost } from '../ui/panel.js';
import { segmented } from '../ui/table.js';
import { kpi, kpiGrid, note, readout, railRow, legend, chip, barRow } from '../ui/bits.js';
import { subhead } from '../ui/overlays.js';
import { LineChart, QuadrantChart, Gauge, sparkline } from '../charts/plots.js';
import { diverge, sequential, showTip, hideTip } from '../charts/core.js';

function posture(v) {
  const s = String(v || '').toUpperCase();
  if (s.includes('BULL') || s.includes('BREAKOUT') || s.includes('RECOVERY')) return 'up';
  if (s.includes('BEAR') || s.includes('BREAKDOWN')) return 'down';
  return 'flat';
}

const REGIME_COLOR = {
  BULL_TRENDING: 'var(--up)', BULL_EXUBERANT: 'var(--gold)',
  VOLATILE_CORRECTION: 'var(--flat)', BEAR_CONTRACTION: 'var(--down)',
  RANGEBOUND: 'var(--ink-4)',
};

export async function mount(ctx) {
  ctx.layout({
    cols: 'minmax(0, 1fr) minmax(320px, 26%)',
    rows: 'minmax(0, 1.1fr) minmax(0, 1fr)',
    areas: '"path side" "cross side"',
  });

  const pPath = ctx.panel({ id: 'path', index: '01', title: 'Regime history', area: 'path', flex: true });
  const pCross = ctx.panel({ id: 'cross', index: '02', title: 'Cross-asset', area: 'cross', flex: true });
  const pSide = ctx.panel({ id: 'now', index: '03', title: 'Current reading', area: 'side' });
  pPath.loading('chart'); pCross.loading('chart'); pSide.loading('kpi');

  const railHead = ctx.railHead(h('span.label', 'Signals'), h('span.label', ''));
  const railBody = ctx.railBody();

  const d = await all({
    regime: '/api/macro/regime',
    fg: '/api/macro/fear-greed',
    vix: '/api/macro/vix-structure',
    cmd: '/api/macro/commodities',
    sectors: '/api/analytics/sectors',
    corr: '/api/analytics/correlation',
    hist: '/api/macro/history',
  });

  if (!d.regime && !d.fg) {
    const err = d.$errors[0]?.err;
    pPath.error(err); pCross.error(err); pSide.error(err);
    return { destroy() {} };
  }

  const regime = d.regime || {};
  const fg = d.fg || {};
  const vix = d.vix || {};
  const cmd = d.cmd || {};
  const sectors = d.sectors || {};
  const corr = d.corr || {};
  const hist = d.hist || {};

  ctx.setStatus({ asOf: regime.as_of_date || fg.as_of_date, rows: (hist.dates || []).length, mode: 'Macro regime' });

  const st = {
    path: ctx.prefs.path || 'price',
    cross: ctx.prefs.cross || 'rotation',
  };

  /* -------------------------------------------------------------- rail */
  function drawRail() {
    const list = h('div.rlist');
    list.appendChild(h('div.rlist__sep', 'Regime signals'));
    for (const sig of regime.signals || []) {
      const t = sig.status === 'BULL' ? 'up' : sig.status === 'BEAR' ? 'down' : 'flat';
      list.appendChild(h('div.rlist__item', { style: { cursor: 'default' }, title: `${sig.name}: ${sig.value}` },
        h('span.rlist__name', sig.name),
        h('span.rlist__val', h('span.chip.chip--' + t, sig.status)),
        h('span.rlist__sub', h('span.' + t, sig.value))));
    }
    list.appendChild(h('div.rlist__sep', 'Fear & greed categories'));
    for (const key of fg.category_order || []) {
      const c = fg.categories?.[key];
      if (!c) continue;
      const t = c.score >= 60 ? 'up' : c.score <= 40 ? 'down' : 'flat';
      const row = h('button.rlist__item', {
        type: 'button', title: c.description,
        onClick: () => openCategory(c),
      },
        h('span.rlist__name', c.label),
        h('span.rlist__val.' + t, num(c.score, 1)),
        h('span.rlist__sub',
          h('span.dim', `w ${c.weight}%`),
          h('span', `contributes ${num(c.contribution, 1)}`),
          c.measured ? null : h('span.chip.chip--na', 'not measured')));
      list.appendChild(row);
    }
    fill(railBody, list);
    railHead.lastChild.textContent = `${(regime.signals || []).length + (fg.category_order || []).length}`;
  }

  function openCategory(c) {
    ctx.drawer.show({
      title: `${c.label} — ${num(c.score, 1)} / 100`,
      sub: `weight ${c.weight}% · contributes ${num(c.contribution, 1)} points to the composite`,
      content: [h('div.stack',
        c.measured ? null : h('div.note', h('div', h('strong', 'Not measured. '),
          'This category could not be computed from the available data, so it scores a neutral 50 and is flagged rather than dropped.')),
        h('div.meta', c.description),
        readout(Object.entries(c.details || {}).map(([k, v]) => ({
          label: titleCase(k),
          value: isNum(v) ? num(v, Math.abs(v) < 10 ? 2 : 1) : (v === null ? h('span.na', 'not available') : String(v)),
        })))),
      ],
    });
  }

  /* -------------------------------------------------------------- path */
  const pathSeg = segmented([
    { value: 'price', label: 'PRICE' },
    { value: 'drawdown', label: 'DRAWDOWN' },
    { value: 'fg', label: 'FEAR/GREED' },
    { value: 'trio', label: 'TRIO' },
  ], st.path, (v) => { st.path = v; ctx.savePrefs({ path: v }); drawPath(); }, { label: 'Series' });
  pPath.tools.prepend(pathSeg);

  const pathBox = chartHost();
  const pathLegend = h('div', { style: { padding: '5px var(--panel-pad)', borderTop: '1px solid var(--line)' } });
  const pathWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, pathBox);
  let pathChart = null;

  function drawPath() {
    pathChart?.destroy?.();
    pathBox.innerHTML = '';
    const dates = hist.dates || [];
    if (!dates.length) { pPath.empty('No price history available.'); return; }
    pPath.render(pathWrap, pathLegend);

    // Regime bands: contiguous runs of the same classification.
    // The daily classification flips around its own thresholds, and painting
    // every flip turns five years of history into a barcode. Shade by the
    // state that held for most of each rolling month instead: full coverage,
    // no flicker, and nothing invented — every band is a real majority.
    const regs = hist.indicators?.regimes || [];
    const smooth = regs.length === dates.length ? majority(regs, 21) : [];
    const bands = [];
    let bandStart = 0;
    for (let i = 1; i <= smooth.length; i++) {
      if (i === smooth.length || smooth[i] !== smooth[bandStart]) {
        const key = String(smooth[bandStart] || '').toUpperCase().replace(/\s+/g, '_');
        bands.push({ from: bandStart, to: i - 1, color: REGIME_COLOR[key] || 'var(--ink-4)' });
        bandStart = i;
      }
    }

    let cfg;
    if (st.path === 'drawdown') {
      cfg = {
        series: [{ label: 'Drawdown from high', color: 'var(--down)', y: hist.spy.drawdown, area: 'var(--down)', areaOpacity: 0.18, thick: true }],
        yFmt: (v) => `${num(v, 0)}%`, areaBase: 0, tipFmt: (v) => `${num(v, 2)}%`,
      };
    } else if (st.path === 'fg') {
      cfg = {
        series: [
          { label: 'Fear & greed', color: 'var(--gold)', y: hist.indicators.fear_greed, thick: true },
          { label: 'RSI 14', color: 'var(--c6)', y: hist.spy.rsi_14, ghost: true },
        ],
        yFmt: (v) => num(v, 0), domain: [0, 100],
        refLines: [
          { y: 75, color: 'var(--up)', label: 'extreme greed' },
          { y: 50, color: 'var(--ink-4)', label: 'neutral' },
          { y: 25, color: 'var(--down)', label: 'extreme fear' },
        ],
        tipFmt: (v) => num(v, 1),
      };
    } else if (st.path === 'trio') {
      cfg = {
        series: [
          { label: 'SPY', color: 'var(--c1)', y: hist.index_trio.spy_rebased, thick: true },
          { label: 'QQQ', color: 'var(--c2)', y: hist.index_trio.qqq_rebased },
          { label: 'IWM', color: 'var(--c3)', y: hist.index_trio.iwm_rebased },
        ],
        yFmt: (v) => num(v, 0), tipFmt: (v) => `${num(v - 100, 1)}%`,
      };
    } else {
      cfg = {
        series: [
          { label: 'SPY', color: 'var(--ink-1)', y: hist.spy.close, thick: true },
          { label: '50D SMA', color: 'var(--c2)', y: hist.spy.sma_50, width: 1 },
          { label: '200D SMA', color: 'var(--c4)', y: hist.spy.sma_200, width: 1 },
        ],
        yFmt: (v) => num(v, 0), tipFmt: (v) => num(v, 2),
      };
    }

    pathChart = LineChart(pathBox, {
      x: dates,
      bands: st.path === 'fg' ? [] : bands,
      xFmt: (v) => date(v, 'month'),
      tipTitle: (i) => `${date(dates[i], 'long')} · ${titleCase(regs[i] || '')}`,
      label: 'Macro history',
      ...cfg,
    });

    fill(pathLegend, h('div.row', { style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
      legend(cfg.series.map((s) => ({ color: s.color, label: s.label }))),
      st.path === 'fg' ? null : legend(Object.entries(REGIME_COLOR).map(([k, v]) => ({ color: v, label: titleCase(k), box: true })))));

    const ss = hist.summary_stats || {};
    pPath.setFoot(
      h('span', `${int(ss.total_bars)} bars`),
      h('span', `52w range ${num(ss.low_52w, 2)} – ${num(ss.high_52w, 2)}`),
      h('span', `max drawdown ${num(ss.max_drawdown, 1)}%`),
      h('span', `CAGR ${num(ss.cagr, 1)}%`),
      h('span', `vol ${num(ss.annualized_vol, 1)}%`),
      h('span', `Sharpe ${num(ss.sharpe_ratio, 2)}`));
    pPath.setMeta(`${date(dates[0])} → ${date(dates[dates.length - 1])}`);
    if (st.path !== 'fg' && bands.length) {
      pPath.foot.appendChild(h('span', { style: { marginLeft: 'auto' } },
        'shading = regime holding the majority of each rolling month'));
    }
  }

  /* ------------------------------------------------------------- cross */
  const crossSeg = segmented([
    { value: 'rotation', label: 'ROTATION' },
    { value: 'corr', label: 'CORRELATION' },
    { value: 'cmd', label: 'COMMODITIES' },
  ], st.cross, (v) => { st.cross = v; ctx.savePrefs({ cross: v }); drawCross(); }, { label: 'Cross-asset view' });
  pCross.tools.prepend(crossSeg);

  const crossBox = chartHost();
  const crossWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, crossBox);
  let crossChart = null;

  function drawCross() {
    crossChart?.destroy?.();
    crossBox.innerHTML = '';

    if (st.cross === 'rotation') {
      const rows = sectors.sectors || [];
      if (!rows.length) { pCross.empty('No sector data available.'); return; }
      pCross.render(crossWrap);
      crossChart = QuadrantChart(crossBox, {
        points: rows.map((s) => ({
          x: (s.alpha_3m || 0) * 100,
          y: (s.alpha_1m || 0) * 100,
          short: s.ticker,
          label: `${s.ticker} — ${s.name}`,
          color: s.quadrant === 'LEADING' ? 'var(--up)' : s.quadrant === 'LAGGING' ? 'var(--down)'
            : s.quadrant === 'IMPROVING' ? 'var(--c6)' : 'var(--flat)',
          r: 4.5,
          rows: [
            { k: 'Quadrant', v: titleCase(s.quadrant) },
            { k: '1M return', v: pct(s.return_1m, 2, true) },
            { k: '3M return', v: pct(s.return_3m, 2, true) },
            { k: '1Y return', v: pct(s.return_1y, 2, true) },
            { k: '1M alpha', v: pct(s.alpha_1m, 2, true) },
            { k: '3M alpha', v: pct(s.alpha_3m, 2, true) },
          ],
        })),
        xFmt: (v) => `${num(v, 0)}%`,
        yFmt: (v) => `${num(v, 0)}%`,
        quadrants: [
          { label: 'Leading', right: true },
          { label: 'Lagging', bottom: true },
        ],
        label: 'Sector rotation: 1-month alpha against 3-month alpha',
      });
      pCross.setMeta('alpha vs SPY — horizontal 3M, vertical 1M');
      pCross.setFoot(h('span', `benchmark SPY  1M ${pct(sectors.benchmark?.return_1m, 2, true)} · 3M ${pct(sectors.benchmark?.return_3m, 2, true)} · 1Y ${pct(sectors.benchmark?.return_1y, 2, true)}`));
      return;
    }

    if (st.cross === 'corr') {
      const syms = corr.symbols || [];
      const m = corr.matrix || [];
      if (!syms.length) { pCross.empty('No correlation matrix available.'); return; }
      pCross.render(
        h('div.tbar',
          h('span.tbar__count', `${corr.lookback_days}-day window`),
          h('span.chip', `mean ρ ${num(corr.avg_correlation, 3)}`),
          h('span.chip' + (corr.diversification_score >= 60 ? '.chip--up' : '.chip--flat'), `diversification ${num(corr.diversification_score, 1)}`),
          h('div.grow'),
          ...(corr.clusters || []).map((c) => h('span.chip.chip--flat', { title: c.symbols.join(', ') }, c.warning))),
        h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0', padding: '0 var(--panel-pad) var(--panel-pad)' } },
          matrixTable(syms, (i, j) => m[i]?.[j], { cell: 34 })));
      pCross.setMeta(`${syms.length} assets`);
      pCross.setFoot();
      return;
    }

    const assets = cmd.assets || [];
    if (!assets.length) { pCross.empty('No commodity data available.'); return; }

    const sign = (v, d) => h('td.num', { class: v > 0 ? 'up' : v < 0 ? 'down' : '' },
      isNum(v) ? `${v > 0 ? '+' : ''}${num(v, d)}%` : DASH);

    const rows = assets.map((a) => h('tr',
      h('td.strong', { title: a.name }, a.ticker),
      h('td.dim', a.category),
      h('td.num', isNum(a.spot) ? '$' + num(a.spot, 2) : DASH),
      sign(a.chg_1d_pct, 2),
      sign(a.ret_1m_pct, 1),
      sign(a.ret_3m_pct, 1),
      sign(a.ret_1y_pct, 1),
      h('td.num', isNum(a.pct_from_52w_high) ? `${num(a.pct_from_52w_high, 1)}%` : DASH),
      h('td.num', { class: a.rsi_14 > 70 ? 'up' : a.rsi_14 < 30 ? 'down' : '' }, num(a.rsi_14, 1)),
      h('td.num', isNum(a.rvol_21d) ? `${num(a.rvol_21d, 1)}%` : DASH),
      h('td', chip(a.trend_posture, posture(a.trend_posture)))));

    const head = h('tr',
      h('th', 'Asset'), h('th', 'Category'), h('th.num', 'Spot'), h('th.num', '1D'),
      h('th.num', '1M'), h('th.num', '3M'), h('th.num', '1Y'), h('th.num', 'vs 52w hi'),
      h('th.num', 'RSI'), h('th.num', 'RVol 21D'), h('th', 'Posture'));

    pCross.render(
      h('div.tbar',
        h('span.chip.chip--brand', titleCase(cmd.macro_stance || '')),
        h('span.tbar__count', cmd.stance_description || '')),
      h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } },
        h('table.tbl', h('thead', head), h('tbody', ...rows))));
    pCross.setMeta(`${assets.length} assets · ${date(cmd.as_of_date)}`);
    pCross.setFoot(...Object.entries(cmd.cross_ratios || {}).slice(0, 6).map(([k, v]) => h('span', `${titleCase(k)} ${num(v, 2)}`)));
  }

  /* -------------------------------------------------------------- side */
  function drawSide() {
    const gaugeHost = h('div', { style: { position: 'relative', height: '124px' } });
    pSide.setTitle('Current reading');
    pSide.setMeta(date(regime.as_of_date || fg.as_of_date));
    pSide.render(padScroller(h('div.stack',
      h('div',
        h('div.row', { style: { justifyContent: 'space-between', alignItems: 'baseline' } },
          h('div.label', 'Regime'),
          h('span.chip', `${num(regime.confidence_pct, 1)}% confidence`)),
        h('div', { style: { fontSize: 'var(--t-stat)', color: regime.regime_color || 'var(--ink-1)', lineHeight: '1.2', marginTop: '3px' } },
          regime.regime_label || DASH),
        h('div.kpi__bar', { style: { marginTop: '7px' } },
          h('div.meter', h('i', { style: { width: `${regime.confidence_pct || 0}%`, background: regime.regime_color || 'var(--brand-fg)' } })))),

      h('div', subhead('Fear & greed 2.0'), gaugeHost,
        fg.degraded_categories?.length
          ? h('div.note', h('div', h('strong', 'Degraded. '), `${fg.degraded_categories.length} categories could not be measured and score a neutral 50: ${fg.degraded_categories.join(', ')}.`))
          : h('div.meta', 'All ten categories measured.')),

      h('div', subhead('Composite weights'),
        h('div.cats', ...(fg.category_order || []).map((k) => {
          const c = fg.categories?.[k];
          if (!c) return null;
          return barRow({
            label: c.label,
            value: `${num(c.score, 1)}`,
            ratio: c.score / 100,
            color: c.bar_color,
            sub: `weight ${c.weight}% → contributes ${num(c.contribution, 1)}${c.measured ? '' : ' · not measured'}`,
          });
        }).filter(Boolean))),

      h('div', subhead('Volatility term structure'), readout([
        { label: 'State', value: chip(`${vix.current_state} (${vix.severity})`, vix.contango_ratio > 1 ? 'up' : 'down') },
        { label: '9D implied', value: isNum(vix.curve?.iv_9d) ? `${num(vix.curve.iv_9d, 2)}%` : DASH },
        { label: '30D implied', value: isNum(vix.curve?.iv_30d) ? `${num(vix.curve.iv_30d, 2)}%` : DASH },
        { label: '90D implied', value: isNum(vix.curve?.iv_90d) ? `${num(vix.curve.iv_90d, 2)}%` : DASH },
        { label: 'Contango ratio', value: num(vix.contango_ratio, 3) },
        { label: 'Realised 21D', value: isNum(vix.realized_vol_21d) ? `${num(vix.realized_vol_21d, 2)}%` : DASH },
        { label: 'Implied premium', value: isNum(vix.iv_premium) ? `${num(vix.iv_premium, 2)} pts` : DASH, t: vix.iv_premium > 0 ? 'down' : 'up' },
        { label: 'Implied percentile', value: isNum(vix.iv_percentile) ? pct(vix.iv_percentile / 100, 0) : h('span.na', 'not enough snapshots') },
      ]),
        vix.percentile_basis ? h('div.meta', { style: { marginTop: '6px' } }, vix.percentile_basis) : null),

      h('div', subhead('Trend factors'), readout([
        { label: 'SPY spot', value: num(regime.factors?.spy_spot, 2) },
        { label: 'vs 50D SMA', value: `${num(regime.factors?.dist_50d_pct, 2)}%`, t: regime.factors?.dist_50d_pct > 0 ? 'up' : 'down' },
        { label: 'vs 200D SMA', value: `${num(regime.factors?.dist_200d_pct, 2)}%`, t: regime.factors?.dist_200d_pct > 0 ? 'up' : 'down' },
        { label: 'Realised vol', value: `${num(regime.factors?.realized_vol_pct, 1)}%` },
        { label: 'Breadth spread', value: `${num(regime.factors?.breadth_spread_pct, 2)}%` },
        { label: 'Credit signal', value: chip(regime.factors?.credit_signal, regime.factors?.credit_signal === 'STABLE' ? 'up' : 'flat') },
      ])),

      note(h('strong', 'A category that cannot be measured scores 50. '),
        'It is flagged rather than dropped, because silently renormalising the weights would make a degraded reading look like a confident one.'),
    )));

    Gauge(gaugeHost, {
      value: fg.composite_score ?? 0,
      display: num(fg.composite_score, 1),
      label: fg.label,
      color: fg.bar_color || 'var(--brand-fg)',
      label_: 'Fear and greed composite',
    });
  }

  /* ---------------------------------------------------------- commands */
  ctx.commands(() => [
    { id: 'm:price', group: 'Macro', icon: 'chart', title: 'History: price and moving averages', run: () => { pathSeg.setValue('price'); st.path = 'price'; drawPath(); } },
    { id: 'm:dd', group: 'Macro', icon: 'chart', title: 'History: drawdown from high', run: () => { pathSeg.setValue('drawdown'); st.path = 'drawdown'; drawPath(); } },
    { id: 'm:fg', group: 'Macro', icon: 'chart', title: 'History: fear & greed', run: () => { pathSeg.setValue('fg'); st.path = 'fg'; drawPath(); } },
    { id: 'm:trio', group: 'Macro', icon: 'chart', title: 'History: SPY / QQQ / IWM', run: () => { pathSeg.setValue('trio'); st.path = 'trio'; drawPath(); } },
    { id: 'm:rot', group: 'Macro', icon: 'grid', title: 'Cross-asset: sector rotation', run: () => { crossSeg.setValue('rotation'); st.cross = 'rotation'; drawCross(); } },
    { id: 'm:corr', group: 'Macro', icon: 'grid', title: 'Cross-asset: correlation matrix', run: () => { crossSeg.setValue('corr'); st.cross = 'corr'; drawCross(); } },
    { id: 'm:cmd', group: 'Macro', icon: 'table', title: 'Cross-asset: commodities', run: () => { crossSeg.setValue('cmd'); st.cross = 'cmd'; drawCross(); } },
    ...(fg.category_order || []).map((k) => ({
      id: 'fgc:' + k, group: 'Fear & greed', icon: 'info',
      title: `${fg.categories[k]?.label} detail`, hint: num(fg.categories[k]?.score, 1),
      run: () => openCategory(fg.categories[k]),
    })),
  ]);

  drawRail(); drawPath(); drawCross(); drawSide();
  const off1 = onResize(pathWrap, () => pathChart?.redraw?.());
  const off2 = onResize(crossWrap, () => crossChart?.redraw?.());
  return { destroy() { off1(); off2(); pathChart?.destroy?.(); crossChart?.destroy?.(); } };
}

/** Centred majority filter — removes single-session flicker from a label series. */
function majority(labels, window) {
  const half = window >> 1;
  const out = new Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const counts = new Map();
    const lo = Math.max(0, i - half);
    const hi = Math.min(labels.length - 1, i + half);
    for (let j = lo; j <= hi; j++) counts.set(labels[j], (counts.get(labels[j]) || 0) + 1);
    let best = labels[i];
    let n = -1;
    for (const [k, v] of counts) if (v > n) { best = k; n = v; }
    out[i] = best;
  }
  return out;
}

/**
 * Correlation matrix. Sign is carried by hue and magnitude by opacity, so a
 * strongly negative pair does not read as "empty".
 */
export function matrixTable(syms, valueAt, { cell = 34 } = {}) {
  const table = h('table.mtx', { style: { '--cell-size': `${cell}px` } });
  table.appendChild(h('thead', h('tr', h('th', ''), ...syms.map((s) => h('th', { scope: 'col' }, s)))));
  const body = h('tbody');
  syms.forEach((rs, i) => {
    const tr = h('tr', h('th', { scope: 'row' }, rs));
    syms.forEach((cs, j) => {
      const v = valueAt(i, j);
      const td = h('td' + (isNum(v) ? '' : '.mtx--void'), {
        style: { background: isNum(v) ? diverge(v, 1) : undefined, color: i === j ? 'var(--ink-4)' : undefined },
      }, isNum(v) ? num(v, 2) : DASH);
      if (isNum(v) && i !== j) {
        td.addEventListener('mousemove', (e) => showTip(e, `${rs} × ${cs}`, [
          { k: 'Correlation', v: num(v, 3), tone: v > 0 ? 'var(--up)' : 'var(--down)' },
        ]));
        td.addEventListener('mouseleave', hideTip);
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);
  return table;
}
