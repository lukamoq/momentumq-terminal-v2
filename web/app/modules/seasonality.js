/**
 * Seasonality — the calendar record.
 *
 * Two views of the same 27 years: the month × year matrix (where the money
 * was made) and the day-of-year cumulative path (when inside the year it was
 * made). A part-finished month is drawn but hatched, and is excluded from
 * every average — counting a two-week stub as a full month moved SPY's
 * 27-year August mean by about a quarter of its own size.
 */

import { h, mount as fill, icon, onResize } from '../core/dom.js';
import { all, get } from '../core/api.js';
import { pct, num, int, isNum, MONTH_NAMES, DASH, date } from '../core/fmt.js';
import { padScroller, chartHost } from '../ui/panel.js';
import { segmented, searchBox } from '../ui/table.js';
import { kpi, kpiGrid, note, readout, railRow, legend, chip } from '../ui/bits.js';
import { subhead } from '../ui/overlays.js';
import { LineChart, BarChart } from '../charts/plots.js';
import { diverge, showTip, hideTip } from '../charts/core.js';

const SPANS = [
  { value: 'all', label: 'ALL', test: () => true },
  { value: '20y', label: '20Y', test: (y, last) => y > last - 20 },
  { value: '10y', label: '10Y', test: (y, last) => y > last - 10 },
  { value: '5y', label: '5Y', test: (y, last) => y > last - 5 },
  { value: 'covid', label: 'POST-COVID', test: (y) => y >= 2020 },
  { value: 'election', label: 'ELECTION', test: (y) => y % 4 === 0 },
  { value: 'd2020', label: "2020s", test: (y) => y >= 2020 && y < 2030 },
  { value: 'd2010', label: "2010s", test: (y) => y >= 2010 && y < 2020 },
  { value: 'd2000', label: "2000s", test: (y) => y >= 2000 && y < 2010 },
];

export async function mount(ctx) {
  ctx.layout({
    cols: 'minmax(0, 1fr) minmax(300px, 24%)',
    rows: 'minmax(0, 1.15fr) minmax(0, 1fr)',
    areas: '"matrix side" "curves side"',
  });

  const pMx = ctx.panel({ id: 'matrix', index: '01', title: 'Monthly return matrix', area: 'matrix', flex: true });
  const pCv = ctx.panel({ id: 'curves', index: '02', title: 'Day-of-year path', area: 'curves', flex: true });
  const pSide = ctx.panel({ id: 'stats', index: '03', title: 'Calendar statistics', area: 'side' });
  pMx.loading('rows'); pCv.loading('chart'); pSide.loading('kpi');

  const railHead = ctx.railHead(h('span.label', 'Universe'), h('span.label', ''));
  const railSearch = h('div', { style: { padding: 'var(--sp-2) var(--sp-4)', borderBottom: '1px solid var(--line)' } });
  ctx.rail.appendChild(railSearch);
  const railBody = ctx.railBody();

  const base = await all({ multi: '/api/analytics/multi-asset', patterns: '/api/analytics/call-patterns' });
  if (!base.multi) {
    const err = base.$errors[0]?.err;
    pMx.error(err); pCv.error(err); pSide.error(err);
    return { destroy() {} };
  }

  const assets = base.multi.assets || [];
  const patterns = base.patterns;

  const st = {
    ticker: ctx.params.t || ctx.prefs.ticker || 'SPY',
    span: ctx.params.span || ctx.prefs.span || 'all',
    curveMode: ctx.prefs.curveMode || 'all',
    q: '',
    data: null,
    curves: null,
  };

  /* -------------------------------------------------------------- rail */
  const search = searchBox('Filter tickers…', (q) => { st.q = q.toLowerCase(); drawRail(); });
  railSearch.appendChild(search);

  function drawRail() {
    const list = h('div.rlist', { role: 'listbox', 'aria-label': 'Assets' });
    const shown = assets.filter((a) => !st.q || a.ticker.toLowerCase().includes(st.q));
    for (const a of shown) {
      const sel = a.ticker === st.ticker;
      list.appendChild(railRow({
        name: a.ticker,
        value: isNum(a.avg_annual_return) ? pct(a.avg_annual_return, 1, true) : DASH,
        sub: [
          h('span.dim', `${a.years_count}y`),
          a.best_month ? h('span.up', `best ${a.best_month.month}`) : null,
          a.worst_month ? h('span.down', `worst ${a.worst_month.month}`) : null,
        ].filter(Boolean),
        selected: sel,
        title: `${a.ticker} — mean annual ${pct(a.avg_annual_return, 1, true)} over ${a.years_count} years`,
        onClick: () => select(a.ticker),
      }));
      list.lastChild.querySelector('.rlist__val').className =
        'rlist__val ' + (isNum(a.avg_annual_return) ? (a.avg_annual_return > 0 ? 'up' : 'down') : 'na');
    }
    if (!shown.length) list.appendChild(h('div.rlist__sep', 'No ticker matches'));
    fill(railBody, list);
    railHead.lastChild.textContent = `${shown.length} / ${assets.length}`;
  }

  async function select(t) {
    if (st.ticker === t && st.data) return;
    st.ticker = t;
    ctx.savePrefs({ ticker: t });
    ctx.patch({ t });
    drawRail();
    await load();
  }

  /* -------------------------------------------------------------- load */
  async function load() {
    pMx.loading('rows'); pCv.loading('chart'); pSide.loading('kpi');
    try {
      const [data, curves] = await Promise.all([
        get('/api/analytics/seasonality', { ticker: st.ticker }),
        get('/api/analytics/seasonality-curves', { ticker: st.ticker }),
      ]);
      st.data = data; st.curves = curves;
      ctx.setStatus({ rows: (data.years || []).length, mode: `${st.ticker} seasonality` });
      drawMatrix(); drawCurves(); drawSide();
    } catch (err) {
      pMx.error(err, load); pCv.error(err, load); pSide.error(err, load);
    }
  }

  /* ------------------------------------------------------------ matrix */
  const spanSeg = segmented(SPANS.map((s) => ({ value: s.value, label: s.label })), st.span,
    (v) => { st.span = v; ctx.savePrefs({ span: v }); ctx.patch({ span: v }); drawMatrix(); drawCurves(); drawSide(); },
    { label: 'Cycle span' });
  pMx.tools.prepend(spanSeg);

  function visibleYears() {
    const years = (st.data?.years || []).slice();
    const last = years[years.length - 1] || new Date().getFullYear();
    const spec = SPANS.find((s) => s.value === st.span) || SPANS[0];
    return years.filter((y) => spec.test(y, last));
  }

  function drawMatrix() {
    const d = st.data;
    if (!d) return;
    const years = visibleYears();
    if (!years.length) { pMx.empty('No years in this span.'); return; }

    const flat = years.flatMap((y) => (d.matrix[y] || []).filter((v, i) => isNum(v) && d.month_complete?.[y]?.[i] !== false));
    const scale = Math.max(0.02, quantile(flat.map(Math.abs), 0.92));

    const head = h('tr', h('th', { scope: 'col' }, 'Year'),
      ...MONTH_NAMES.map((m) => h('th', { scope: 'col' }, m)),
      h('th', { scope: 'col', style: { borderLeft: '1px solid var(--line-strong)' } }, 'Year'));

    const body = h('tbody');
    for (const y of years.slice().reverse()) {
      const row = h('tr', h('th', { scope: 'row' }, String(y)));
      (d.matrix[y] || []).forEach((v, i) => {
        const complete = d.month_complete?.[y]?.[i] !== false;
        const td = h('td' + (isNum(v) ? (complete ? '' : '.mtx--partial') : '.mtx--void'), {
          style: { background: isNum(v) ? diverge(v, scale) : undefined },
        }, isNum(v) ? num(v * 100, 1) : DASH);
        if (isNum(v)) {
          td.addEventListener('mousemove', (e) => showTip(e, `${st.ticker} · ${MONTH_NAMES[i]} ${y}`, [
            { k: 'Return', v: pct(v, 2, true), tone: v > 0 ? 'var(--up)' : 'var(--down)' },
            complete ? null : { k: 'Status', v: 'month still running — excluded from averages' },
          ].filter(Boolean)));
          td.addEventListener('mouseleave', hideTip);
        }
        row.appendChild(td);
      });
      const fy = d.full_year_returns?.[y];
      row.appendChild(h('td' + (isNum(fy) ? '' : '.mtx--void') + (d.year_complete?.[y] === false ? '.mtx--partial' : ''), {
        style: { borderLeft: '1px solid var(--line-strong)', background: isNum(fy) ? diverge(fy, scale * 3) : undefined, fontWeight: '600' },
      }, isNum(fy) ? num(fy * 100, 1) : DASH));
      body.appendChild(row);
    }

    // Column summary computed over the visible span only.
    const avgRow = h('tr', h('th', { scope: 'row', style: { color: 'var(--ink-1)' } }, 'Mean'));
    const winRow = h('tr', h('th', { scope: 'row', style: { color: 'var(--ink-1)' } }, 'Win %'));
    const stats = monthStats(d, years);
    stats.forEach((m) => {
      avgRow.appendChild(h('td', { title: `Mean of ${m.n} complete ${MONTH_NAMES[stats.indexOf(m)]} months in this span` },
        h('i', { style: { background: isNum(m.mean) ? diverge(m.mean, scale) : undefined } },
          isNum(m.mean) ? num(m.mean * 100, 1) : DASH)));
      winRow.appendChild(h('td', { class: m.win >= 0.6 ? 'up' : m.win < 0.45 ? 'down' : '' },
        h('i', isNum(m.win) ? num(m.win * 100, 0) : DASH)));
    });
    avgRow.appendChild(h('td', { style: { borderLeft: '1px solid var(--line-strong)' } }, h('i', '')));
    winRow.appendChild(h('td', { style: { borderLeft: '1px solid var(--line-strong)' } }, h('i', '')));

    const table = h('table.mtx', h('thead', head), body, h('tfoot', avgRow, winRow));
    pMx.render(
      h('div.tbar',
        h('span.tbar__count', `${years.length} years · scale ±${num(scale * 100, 1)}%`),
        h('div.grow'),
        h('div.hlegend',
          h('span.label', '−'),
          h('div.hlegend__ramp', ...[-1, -0.66, -0.33, 0, 0.33, 0.66, 1].map((t) => h('i', { style: { background: diverge(t * scale, scale) } }))),
          h('span.label', '+')),
        h('span.chip', { title: 'A month that has not finished is drawn hatched and excluded from every average' }, 'hatched = incomplete')),
      h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0', padding: '0 var(--panel-pad) var(--panel-pad)' } }, table));
    pMx.setMeta(`${st.ticker} · ${years[0]}–${years[years.length - 1]}`);
  }

  /* ------------------------------------------------------------ curves */
  const curveSeg = segmented(
    [{ value: 'all', label: 'ALL YEARS' }, { value: 'mean', label: 'MEAN ONLY' }, { value: 'recent', label: 'LAST 5' }],
    st.curveMode, (v) => { st.curveMode = v; ctx.savePrefs({ curveMode: v }); drawCurves(); }, { label: 'Curve set' });
  pCv.tools.prepend(curveSeg);

  const curveBox = chartHost();
  const curveLegend = h('div', { style: { padding: '5px var(--panel-pad)', borderTop: '1px solid var(--line)' } });
  const curveWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, curveBox);
  let curveChart = null;

  function drawCurves() {
    const c = st.curves;
    if (!c) return;
    curveChart?.destroy?.();
    curveBox.innerHTML = '';
    pCv.render(curveWrap, curveLegend);

    const years = visibleYears().filter((y) => c.yearly_curves?.[y]);
    const maxDay = c.max_trading_days || 252;
    const x = Array.from({ length: maxDay }, (_, i) => i + 1);

    const pick = st.curveMode === 'recent' ? years.slice(-5) : st.curveMode === 'mean' ? [] : years;
    const thisYear = years[years.length - 1];

    const seriesList = pick.map((y) => ({
      label: String(y),
      color: y === thisYear ? 'var(--gold)' : 'var(--c1)',
      ghost: y !== thisYear && st.curveMode === 'all',
      thick: y === thisYear,
      y: toDayArray(c.yearly_curves[y], maxDay),
    }));

    if (c.average_curve) {
      seriesList.push({ label: `Mean (${years.length}y)`, color: 'var(--up)', thick: true, y: toDayArray(c.average_curve, maxDay) });
    }

    curveChart = LineChart(curveBox, {
      x,
      series: seriesList,
      yFmt: (v) => num(v, 0),
      xFmt: (v) => `D${v}`,
      xTickCount: 8,
      refLines: [{ y: 100, color: 'var(--ink-4)', label: 'flat' }],
      tipTitle: (i) => `Trading day ${x[i]}`,
      tipFmt: (v) => `${num(v - 100, 2)}%`,
      maxPoints: 300,
      label: 'Cumulative return by trading day of the year',
    });

    fill(curveLegend, legend([
      { color: 'var(--up)', label: 'Mean path across the span' },
      thisYear ? { color: 'var(--gold)', label: `${thisYear} to date` } : null,
      st.curveMode === 'all' ? { color: 'var(--c1)', label: 'Individual years' } : null,
    ].filter(Boolean)));
    pCv.setMeta(`indexed to 100 at day 1 · ${seriesList.length} curves`);
  }

  /* -------------------------------------------------------------- side */
  function drawSide() {
    const d = st.data;
    if (!d) return;
    const years = visibleYears();
    const stats = monthStats(d, years);
    const best = stats.reduce((a, b) => (isNum(b.mean) && (!a || b.mean > a.mean) ? b : a), null);
    const worst = stats.reduce((a, b) => (isNum(b.mean) && (!a || b.mean < a.mean) ? b : a), null);
    const annual = years.map((y) => d.full_year_returns?.[y]).filter(isNum);
    const meanAnnual = annual.length ? annual.reduce((a, b) => a + b, 0) / annual.length : null;
    const posYears = annual.filter((v) => v > 0).length;

    pSide.setTitle(`${st.ticker} statistics`);
    pSide.setMeta(`${years.length} years`);
    pSide.render(padScroller(h('div.stack',
      kpiGrid(2,
        kpi({ label: 'Best month', value: best ? best.name : DASH, t: 'up',
              sub: best ? `${pct(best.mean, 2, true)} mean · ${pct(best.win, 0)} positive · n=${best.n}` : null }),
        kpi({ label: 'Worst month', value: worst ? worst.name : DASH, t: 'down',
              sub: worst ? `${pct(worst.mean, 2, true)} mean · ${pct(worst.win, 0)} positive · n=${worst.n}` : null }),
        kpi({ label: 'Mean year', value: isNum(meanAnnual) ? pct(meanAnnual, 1, true) : DASH,
              t: meanAnnual > 0 ? 'up' : 'down', sub: `${annual.length} complete years in span` }),
        kpi({ label: 'Positive years', value: annual.length ? `${posYears} / ${annual.length}` : DASH,
              bar: annual.length ? posYears / annual.length : null, barColor: 'var(--up)' })),

      h('div', subhead('Month by month'),
        h('div', { id: 'monthBars', style: { position: 'relative', height: '150px' } })),

      h('div', subhead('Detail'), h('div.scroll', { style: { maxHeight: '260px' } },
        h('table.tbl', h('thead', h('tr',
          h('th', 'Month'), h('th.num', 'Mean'), h('th.num', 'Median'), h('th.num', 'Win'), h('th.num', 'Vol'), h('th.num', 'n'))),
          h('tbody', ...stats.map((m) => h('tr',
            h('td.strong', m.name),
            h('td.num', { class: m.mean > 0 ? 'up' : m.mean < 0 ? 'down' : '' }, isNum(m.mean) ? pct(m.mean, 1, true) : DASH),
            h('td.num', isNum(m.median) ? pct(m.median, 1, true) : DASH),
            h('td.num', isNum(m.win) ? pct(m.win, 0) : DASH),
            h('td.num', isNum(m.vol) ? pct(m.vol, 1) : DASH),
            h('td.num.dim', { title: `${m.n} complete months in this span` }, m.n)))))))
      ,
      patterns ? h('div', subhead('When the street publishes'),
        h('div.scroll', h('table.tbl', h('thead', h('tr',
          h('th', 'Qtr'), h('th.num', 'Calls'), h('th.num', 'Bullish'), h('th.num', 'Hit rate'))),
          h('tbody', ...(patterns.quarters || []).map((q) => h('tr',
            h('td.strong', { title: q.name }, q.quarter),
            h('td.num', int(q.total_calls)),
            h('td.num', pct(q.bullish_ratio, 0)),
            h('td.num', { class: q.hit_rate >= 0.5 ? 'up' : 'down' }, pct(q.hit_rate, 0)))))))) : null,

      note(h('strong', 'Complete months only. '),
        'The live, part-finished month is drawn in the grid but excluded from every average, median, win rate and volatility figure. ',
        'Each month reports the sample size behind it, and an annual return is measured from the prior year’s final close — the same base January uses — so the twelve monthly returns multiply out to the annual figure.'),
    )));

    const host = pSide.body.querySelector('#monthBars');
    if (host) {
      BarChart(host, {
        values: stats.map((m) => (isNum(m.mean) ? m.mean * 100 : 0)),
        labels: MONTH_NAMES,
        yFmt: (v) => `${num(v, 1)}%`,
        color: (v) => (v >= 0 ? 'var(--up)' : 'var(--down)'),
        pad: { t: 8, r: 8, b: 22, l: 38 },
        tip: (i) => ({
          title: `${MONTH_NAMES[i]} · ${st.ticker}`,
          rows: [
            { k: 'Mean', v: pct(stats[i].mean, 2, true) },
            { k: 'Median', v: pct(stats[i].median, 2, true) },
            { k: 'Win rate', v: pct(stats[i].win, 0) },
            { k: 'Sample', v: `${stats[i].n} years` },
          ],
        }),
      });
    }
  }

  /* ---------------------------------------------------------- commands */
  ctx.commands(() => [
    ...assets.slice(0, 60).map((a) => ({
      id: 'seas:' + a.ticker, group: 'Seasonality', icon: 'calendar',
      title: `${a.ticker} seasonality`, hint: pct(a.avg_annual_return, 0, true),
      run: () => select(a.ticker),
    })),
    ...SPANS.map((sp) => ({
      id: 'span:' + sp.value, group: 'Cycle span', icon: 'sliders', title: `Span: ${sp.label}`,
      run: () => { spanSeg.setValue(sp.value); st.span = sp.value; ctx.savePrefs({ span: sp.value }); drawMatrix(); drawCurves(); drawSide(); },
    })),
  ]);
  ctx.bind('mod+f', () => search.focusInput(), { label: 'Filter the universe' });

  drawRail();
  await load();
  const off = onResize(curveWrap, () => curveChart?.redraw?.());
  return { destroy() { off(); curveChart?.destroy?.(); } };
}

/* ------------------------------- helpers -------------------------------- */

/** Recompute the column statistics over the visible span, complete months only. */
function monthStats(d, years) {
  return MONTH_NAMES.map((name, i) => {
    const vals = [];
    for (const y of years) {
      const v = d.matrix?.[y]?.[i];
      if (!isNum(v)) continue;
      if (d.month_complete?.[y]?.[i] === false) continue;
      vals.push(v);
    }
    if (!vals.length) return { name, mean: null, median: null, win: null, vol: null, n: 0 };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sorted = vals.slice().sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const win = vals.filter((v) => v > 0).length / vals.length;
    const vol = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1));
    return { name, mean, median, win, vol, n: vals.length };
  });
}

function toDayArray(curve, maxDay) {
  const out = new Array(maxDay).fill(null);
  for (const p of curve || []) {
    const i = (p.day || 0) - 1;
    if (i >= 0 && i < maxDay) out[i] = p.normalized;
  }
  return out;
}

function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return 0;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
