/**
 * Mag 7 — the big-tech call audit.
 *
 * Rail selects an instrument; the chart, the dossier and the blotter all
 * follow it. Returns are drawn rebased to the selected window rather than to
 * a fixed 2012 epoch, because "up 14,000% since inception" tells you nothing
 * about whether a 2024 call was right.
 */

import { h, mount as fill, icon, onResize } from '../core/dom.js';
import { all } from '../core/api.js';
import { date, pct, num, int, isNum, title as titleCase, DASH, tone, money } from '../core/fmt.js';
import { padScroller, chartHost } from '../ui/panel.js';
import { DataTable, searchBox, segmented, barCell } from '../ui/table.js';
import { chip, kpi, kpiGrid, note, readout, railRow, legend, sourceLink } from '../ui/bits.js';
import { fields, fieldSection, prose, subhead } from '../ui/overlays.js';
import { LineChart } from '../charts/plots.js';
import { SERIES } from '../charts/core.js';

const BENCH = ['SPY', 'QQQ', 'RSP'];

export async function mount(ctx) {
  ctx.layout({
    cols: 'minmax(0, 1fr) minmax(300px, 24%)',
    rows: 'minmax(0, 1.05fr) minmax(0, 1fr)',
    areas: '"chart side" "blot side"',
  });

  const pChart = ctx.panel({ id: 'perf', index: '01', title: 'Relative performance', area: 'chart', flex: true });
  const pSide = ctx.panel({ id: 'dossier', index: '03', title: 'Instrument dossier', area: 'side' });
  const pBlot = ctx.panel({ id: 'calls', index: '02', title: 'Call blotter', area: 'blot', flex: true });
  pChart.loading('chart'); pSide.loading('kpi'); pBlot.loading('rows');

  const railHead = ctx.railHead(h('span.label', 'Instruments'), h('span.label', ''));
  const railBody = ctx.railBody();

  const d = await all({
    stats: '/api/mag7/stats',
    stocks: '/api/mag7/stocks',
    desks: '/api/mag7/scorecard',
    themes: '/api/mag7/themes',
    series: '/api/mag7/market-series',
  });

  if (!d.stocks) {
    const err = d.$errors[0]?.err;
    pChart.error(err); pSide.error(err); pBlot.error(err);
    return { destroy() {} };
  }

  const stats = d.stats || {};
  const stocks = d.stocks || [];
  const desks = d.desks || [];
  const themes = d.themes || [];
  const series = d.series?.series || {};

  const calls = stocks.flatMap((s) => (s.calls || []).map((c) => ({ ...c, _ticker: s.ticker })));
  const deskById = new Map(desks.map((x) => [x.institution_id, x]));

  ctx.setStatus({ asOf: stats.as_of_date, rows: calls.length, mode: 'Mag 7 audit' });

  const st = {
    ticker: ctx.params.t || ctx.prefs.ticker || null,
    range: ctx.params.range || ctx.prefs.range || '3y',
    q: '',
    verdict: 'all',
  };

  /* ------------------------------------------------------------- series */
  const dates = (series.SPY || []).map((p) => p.date);
  const dateAt = buildDateIndex(dates);
  const RANGES = [
    { value: '1y', label: '1Y', years: 1 },
    { value: '3y', label: '3Y', years: 3 },
    { value: '5y', label: '5Y', years: 5 },
    { value: 'all', label: 'ALL', years: 99 },
  ];

  function window_() {
    const r = RANGES.find((x) => x.value === st.range) || RANGES[1];
    const end = dates[dates.length - 1];
    if (!end || r.years > 50) return { i0: 0, i1: dates.length - 1 };
    const from = `${Number(end.slice(0, 4)) - r.years}${end.slice(4)}`;
    return { i0: Math.max(0, dateAt(from)), i1: dates.length - 1 };
  }

  /** The basket is audited as MAG7_BASKET but published as the MAG7 series. */
  const seriesKey = (t) => (series[t] ? t : t === 'MAG7_BASKET' ? 'MAG7' : t);

  /** Rebase a series to 100 at the first bar of the visible window. */
  function rebased(ticker, i0, i1) {
    const raw = series[seriesKey(ticker)];
    if (!raw) return null;
    const closes = raw.map((p) => p.close);
    // Series start at different dates; align on the shared date axis.
    const own = new Map(raw.map((p, i) => [p.date, i]));
    const out = new Array(i1 - i0 + 1).fill(null);
    let base = null;
    for (let i = i0; i <= i1; i++) {
      const j = own.get(dates[i]);
      if (j === undefined) continue;
      const v = closes[j];
      if (!isNum(v)) continue;
      if (base === null) base = v;
      out[i - i0] = (v / base) * 100;
    }
    return base === null ? null : out;
  }

  /* -------------------------------------------------------------- rail */
  /** Return over the currently visible window — the same basis the chart draws. */
  function windowReturn(ticker) {
    const { i0, i1 } = window_();
    const r = rebased(ticker, i0, i1);
    if (!r) return null;
    for (let i = r.length - 1; i >= 0; i--) if (isNum(r[i])) return (r[i] - 100) / 100;
    return null;
  }

  function drawRail() {
    const list = h('div.rlist', { role: 'listbox', 'aria-label': 'Instruments' });
    const label = (RANGES.find((r) => r.value === st.range) || {}).label || '';
    list.appendChild(h('div.rlist__sep', `Constituents · ${label} return`));
    for (const s of stocks) {
      const sel = st.ticker === s.ticker;
      const ret = windowReturn(s.ticker);
      list.appendChild(railRow({
        name: s.ticker,
        value: isNum(ret) ? pct(ret, 1, true) : DASH,
        sub: [
          h('span.trunc', { style: { maxWidth: '92px' } }, s.name),
          isNum(s.hit_rate) ? h('span', { class: s.hit_rate >= 0.5 ? 'up' : 'down' }, `${pct(s.hit_rate, 0)} hit`) : null,
        ].filter(Boolean),
        selected: sel,
        title: `${s.name} — ${s.sector}. ${label} return ${pct(ret, 1, true)}, year to date ${pct(s.return_ytd_2026, 1, true)}.`,
        onClick: () => select(sel ? null : s.ticker),
      }));
      list.lastChild.querySelector('.rlist__val').className =
        'rlist__val ' + (isNum(ret) ? (ret > 0 ? 'up' : 'down') : 'na');
    }
    list.appendChild(h('div.rlist__sep', 'Benchmarks'));
    for (const b of BENCH) {
      if (!series[b]) continue;
      const ret = windowReturn(b);
      list.appendChild(railRow({
        name: b, value: isNum(ret) ? pct(ret, 1, true) : DASH,
        sub: [h('span.dim', b === 'RSP' ? 'S&P 500 equal weight' : b === 'QQQ' ? 'Nasdaq 100' : 'S&P 500')],
        selected: false, onClick: () => select(null),
        title: `${b} — always drawn as a comparison line`,
      }));
      list.lastChild.querySelector('.rlist__val').className =
        'rlist__val ' + (isNum(ret) ? (ret > 0 ? 'up' : 'down') : 'na');
    }
    fill(railBody, list);
    railHead.lastChild.textContent = `${stocks.length} tracked`;
  }

  function select(t) {
    st.ticker = t;
    ctx.savePrefs({ ticker: t });
    ctx.patch({ t: t || undefined });
    drawRail(); drawSide(); drawChart(); applyFilter();
  }

  /* ------------------------------------------------------------- chart */
  const rangeSeg = segmented(RANGES.map((r) => ({ value: r.value, label: r.label })), st.range,
    (v) => { st.range = v; ctx.savePrefs({ range: v }); drawChart(); drawRail(); }, { label: 'Range' });
  pChart.tools.prepend(rangeSeg);

  const chartBox = chartHost();
  const legendBox = h('div', { style: { padding: '5px var(--panel-pad)', borderTop: '1px solid var(--line)' } });
  const chartWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, chartBox);
  pChart.render(chartWrap, legendBox);

  let chart = null;
  const hidden = new Set(ctx.prefs.hidden || []);

  function drawChart() {
    chart?.destroy?.();
    chartBox.innerHTML = '';
    const { i0, i1 } = window_();
    const xs = dates.slice(i0, i1 + 1);

    const focus = st.ticker && series[seriesKey(st.ticker)]
      ? [seriesKey(st.ticker)]
      : stocks.filter((s) => !s.is_basket).map((s) => s.ticker);
    const names = [...focus.filter((t) => series[t]), 'MAG7', ...BENCH.filter((b) => series[b])];
    const uniq = [...new Set(names)];

    const built = uniq.map((t, i) => {
      const stock = stocks.find((x) => x.ticker === t);
      const isBench = BENCH.includes(t);
      return {
        key: t,
        label: t,
        color: stock?.color || (t === 'MAG7' ? 'var(--gold)' : isBench ? 'var(--ink-4)' : SERIES[i % SERIES.length]),
        y: rebased(t, i0, i1),
        dash: isBench,
        thick: st.ticker === t || t === 'MAG7',
        hidden: hidden.has(t),
      };
    }).filter((sr) => sr.y);

    chart = LineChart(chartBox, {
      x: xs,
      series: built,
      yFmt: (v) => num(v, 0),
      xFmt: (v) => date(v, 'month'),
      tipTitle: (i) => date(xs[i], 'long'),
      tipFmt: (v) => `${num(v, 1)} (${num(v - 100, 1)}%)`,
      label: 'Total return rebased to 100 at the start of the window',
    });

    fill(legendBox, legend(built.map((sr) => ({ color: sr.color, label: sr.label, off: hidden.has(sr.key), key: sr.key })),
      (item) => {
        if (hidden.has(item.key)) hidden.delete(item.key); else hidden.add(item.key);
        ctx.savePrefs({ hidden: [...hidden] });
        drawChart();
      }));
    pChart.setMeta(`rebased to 100 at ${date(xs[0])} · ${built.length} series`);
  }

  /* -------------------------------------------------------------- side */
  function drawSide() {
    if (!st.ticker) {
      pSide.setTitle('Audit result');
      pSide.setMeta(`${stats.total_institutions || desks.length} houses`);
      const ranked = desks.slice().sort((a, b) => (b.avg_alpha ?? -9) - (a.avg_alpha ?? -9));
      pSide.render(padScroller(h('div.stack',
        kpiGrid(2,
          kpi({ label: 'Overall hit rate', value: pct(stats.overall_hit_rate, 1),
                t: stats.overall_hit_rate >= 0.5 ? 'up' : 'down', bar: stats.overall_hit_rate,
                sub: `${int(stats.total_hits)} hit · ${int(stats.total_misses)} miss · ${int(stats.total_too_early)} still open.` }),
          kpi({ label: 'Basket market cap', value: stats.mag7_aggregate_market_cap ?? DASH,
                sub: `SPY ${pct(stats.spy_ytd_return, 1, true)} year to date.` })),

        h('div', subhead('Desk league table'),
          h('div', ...ranked.map((x) => h('button', {
            type: 'button',
            style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 0', borderBottom: '1px solid var(--line-hair)' },
            onClick: () => openDesk(x),
          },
            h('div.row', { style: { justifyContent: 'space-between' } },
              h('span', { style: { color: 'var(--ink-1)' } }, h('span.num', { style: { color: 'var(--ink-4)', marginRight: '6px', fontSize: 'var(--t-micro)' } }, x.grade), x.institution_name),
              h('span.num', { class: (x.avg_alpha ?? 0) > 0 ? 'up' : 'down' }, isNum(x.avg_alpha) ? pct(x.avg_alpha, 0, true) : DASH)),
            h('div.meta', `${x.hits}/${x.resolved} resolved${x.curated_verdict_disagreements ? ` · ${x.curated_verdict_disagreements} contested` : ''}`))))),

        themes.length ? h('div', subhead('Thematic dossiers'),
          h('div.cards', { style: { gridTemplateColumns: '1fr' } },
            ...themes.map((t) => h('button.card', {
              type: 'button', style: { textAlign: 'left' }, onClick: () => openTheme(t),
            },
              h('div.card__k', (t.hero_stocks || []).join(' · ')),
              h('div.card__t', titleCase(t.title)),
              h('div.card__b.clamp-3', t.subtitle || t.narrative))))) : null,

        note(h('strong', 'Alpha is relative. '), 'Every verdict is scored against ',
          h('code', 'SPY'), ' over the same window, and targets are restated for splits before comparison. ',
          'An open window renders ', h('code', 'TOO_EARLY'), ' rather than a provisional verdict.'),
      )));
      return;
    }

    const s = stocks.find((x) => x.ticker === st.ticker);
    if (!s) { pSide.empty('No record for this instrument.'); return; }
    const stockCalls = calls.filter((c) => c.ticker === s.ticker);

    pSide.setTitle(s.ticker);
    pSide.setMeta(s.sector);
    pSide.render(padScroller(h('div.stack',
      h('div',
        h('div', { style: { fontSize: 'var(--t-lead)', color: 'var(--ink-1)' } }, s.name),
        h('div.row.row--wrap', { style: { marginTop: '5px' } },
          h('span.chip.chip--brand', s.market_cap_measured ? s.market_cap : `${s.market_cap} (est.)`),
          h('span.chip', { title: s.key_theme }, s.key_theme))),

      kpiGrid(2,
        kpi({ label: 'Last price', value: isNum(s.latest_price) ? '$' + num(s.latest_price, 2) : DASH,
              sub: `${pct(s.return_ytd_2026, 1, true)} year to date` }),
        kpi({ label: 'Street hit rate', value: isNum(s.hit_rate) ? pct(s.hit_rate, 0) : DASH,
              t: s.hit_rate >= 0.5 ? 'up' : 'down', bar: s.hit_rate,
              sub: `${s.hits} hit · ${s.misses} miss of ${s.total_calls} calls` })),

      h('div', subhead('Record'), readout([
        { label: 'Return since 2023', value: isNum(s.return_since_2023) ? pct(s.return_since_2023, 0, true) : DASH, t: s.return_since_2023 > 0 ? 'up' : 'down' },
        { label: 'Return YTD', value: isNum(s.return_ytd_2026) ? pct(s.return_ytd_2026, 1, true) : DASH, t: s.return_ytd_2026 > 0 ? 'up' : 'down' },
        { label: 'Calls audited', value: int(s.total_calls) },
      ])),

      (s.bull_banks?.length || s.bear_banks?.length) ? h('div', subhead('Who took which side'),
        s.bull_banks?.length ? h('div', { style: { marginBottom: '8px' } },
          h('div.label', { style: { marginBottom: '4px', color: 'var(--up)' } }, 'Constructive'),
          h('div.row.row--wrap', ...s.bull_banks.map((b) => h('span.chip.chip--up', b)))) : null,
        s.bear_banks?.length ? h('div',
          h('div.label', { style: { marginBottom: '4px', color: 'var(--down)' } }, 'Cautious'),
          h('div.row.row--wrap', ...s.bear_banks.map((b) => h('span.chip.chip--down', b)))) : null) : null,

      h('div', subhead(`Calls (${stockCalls.length})`),
        h('div', ...stockCalls.slice(0, 10).map((c) => h('button', {
          type: 'button',
          style: { display: 'block', width: '100%', textAlign: 'left', padding: '5px 0', borderBottom: '1px solid var(--line-hair)' },
          onClick: () => openCall(c),
        },
          h('div.row', { style: { justifyContent: 'space-between' } },
            h('span.num', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-3)' } }, `${date(c.published_on)} · ${c.institution_id}`),
            chip(c.verdict)),
          h('div.trunc', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-2)' } }, c.thesis_summary || c.key_quote_or_headline || ''))))),

      h('button.btn', { type: 'button', onClick: () => select(null) }, icon('close', 12), 'Clear instrument filter'),
    )));
  }

  /* ----------------------------------------------------------- blotter */
  const verdictSeg = segmented(
    [{ value: 'all', label: 'ALL' }, { value: 'HIT', label: 'HIT' },
     { value: 'MISS', label: 'MISS' }, { value: 'TOO_EARLY', label: 'OPEN' }],
    'all', (v) => { st.verdict = v; applyFilter(); }, { label: 'Verdict filter' });
  const search = searchBox('Filter by desk, analyst, thesis…', (q) => { st.q = q.toLowerCase(); applyFilter(); });
  const countEl = h('span.tbar__count');

  const table = DataTable({
    label: 'Mag 7 call blotter',
    rows: calls,
    rowKey: (r) => r.id,
    sort: 'published_on',
    dir: -1,
    onOpen: openCall,
    columns: [
      { key: 'published_on', label: 'Date', width: '76px', render: (r) => date(r.published_on) },
      { key: 'ticker', label: 'Ticker', width: '76px', strong: true },
      { key: 'institution_id', label: 'Desk', width: '68px' },
      { key: 'rating_or_stance', label: 'Stance', width: '104px',
        render: (r) => chip(r.rating_or_stance, tone(r.rating_or_stance)) },
      { key: 'target_price_adjusted', label: 'Target*', align: 'right', width: '74px',
        title: 'Published target restated for subsequent splits',
        render: (r) => (isNum(r.target_price_adjusted) ? '$' + num(r.target_price_adjusted, 2) : DASH) },
      { key: 'spot_at_publication', label: 'Spot', align: 'right', width: '78px',
        render: (r) => (isNum(r.spot_at_publication) ? '$' + num(r.spot_at_publication, 2) : DASH) },
      { key: 'realized_stock_return', label: 'Realised', align: 'right', width: '84px',
        render: (r) => (isNum(r.realized_stock_return)
          ? barCell(pct(r.realized_stock_return, 0, true), Math.min(1, Math.abs(r.realized_stock_return) / 3),
                    r.realized_stock_return >= 0 ? 'var(--up-wash)' : 'var(--down-wash)') : DASH) },
      { key: 'relative_alpha', label: 'Alpha vs SPY', align: 'right', width: '96px',
        render: (r) => (isNum(r.relative_alpha)
          ? h('span', { class: r.relative_alpha > 0 ? 'up' : 'down' }, pct(r.relative_alpha, 0, true)) : DASH) },
      { key: 'verdict', label: 'Verdict', width: '86px', render: (r) => chip(r.verdict) },
      { key: 'curated_verdict_agrees', label: 'Review', width: '96px',
        title: 'The curated editorial verdict, shown when it differs from the automated one',
        render: (r) => {
          if (r.curated_verdict_agrees === null || r.curated_verdict_agrees === undefined) return h('span.na', DASH);
          if (r.curated_verdict_agrees) return chip('agrees', 'up');
          // An open window is not a disagreement about the outcome: the
          // automated verdict simply has not been allowed to resolve yet.
          const open = r.verdict === 'TOO_EARLY';
          return chip(open ? `${r.curated_verdict} so far` : `review: ${r.curated_verdict}`, open ? 'na' : 'flat');
        },
        cellTitle: (r) => (r.curated_verdict_agrees === 0
          ? `Curated review says ${r.curated_verdict}; the automated verdict is ${r.verdict}${r.verdict === 'TOO_EARLY' ? ' because the evaluation window has not closed' : ''}.`
          : '') },
      { key: 'strategist_or_analyst', label: 'Analyst', width: '128px', render: (r) => r.strategist_or_analyst || DASH },
      { key: 'thesis_summary', label: 'Thesis', render: (r) => r.thesis_summary || DASH, cellTitle: (r) => r.thesis_summary || '' },
    ],
  });

  pBlot.render(
    h('div.tbar', verdictSeg, search, countEl),
    h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, table.el));

  function applyFilter() {
    const n = table.filter((r) => {
      if (st.ticker && r.ticker !== st.ticker) return false;
      if (st.verdict !== 'all' && r.verdict !== st.verdict) return false;
      if (!st.q) return true;
      return [r.institution_id, r.strategist_or_analyst, r.thesis_summary, r.key_quote_or_headline, r.ticker, r.company_name]
        .some((v) => String(v || '').toLowerCase().includes(st.q));
    });
    countEl.textContent = `${n} / ${calls.length}`;
    pBlot.setMeta(st.ticker ? `filtered to ${st.ticker}` : 'all instruments');
    ctx.setStatus({ rows: n });
  }

  /* ------------------------------------------------------------ drawer */
  function openCall(c) {
    const desk = deskById.get(c.institution_id);
    ctx.drawer.show({
      title: `${c.institution_id} on ${c.ticker} — ${titleCase(c.verdict)}`,
      sub: `${date(c.published_on, 'long')} · ${c.forecast_horizon || 'no horizon'} · ${c.strategist_or_analyst || 'unattributed'}`,
      content: [h('div.stack',
        h('div.row.row--wrap',
          chip(c.rating_or_stance, tone(c.rating_or_stance)),
          chip(c.verdict),
          c.is_window_complete ? null : chip('window open', 'flat'),
          c.curated_verdict_agrees === 0 ? chip('contested by review', 'flat') : null),
        c.key_quote_or_headline ? h('div.note.note--info', h('div', h('em', `“${c.key_quote_or_headline}”`))) : null,
        fields([
          { label: 'Target (as published)', value: isNum(c.target_price) ? '$' + num(c.target_price, 2) : null },
          { label: 'Target (split-adjusted)', value: isNum(c.target_price_adjusted) ? '$' + num(c.target_price_adjusted, 2) : null },
          { label: 'Split factor', value: c.split_adjustment_factor > 1 ? `${c.split_adjustment_factor}×` : null },
          { label: 'Spot at publication', value: isNum(c.spot_at_publication) ? '$' + num(c.spot_at_publication, 2) : null },
          { label: 'Implied return', value: isNum(c.target_implied_return) ? pct(c.target_implied_return, 1, true) : null },
          { label: 'Exit date', value: c.exit_date ? date(c.exit_date, 'long') : null },
          { label: 'Exit spot', value: isNum(c.exit_spot) ? '$' + num(c.exit_spot, 2) : null },
          { label: 'Realised stock return', value: isNum(c.realized_stock_return) ? pct(c.realized_stock_return, 1, true) : null, tone: c.realized_stock_return > 0 ? 'up' : 'down' },
          { label: `Realised ${c.benchmark_ticker || 'SPY'} return`, value: isNum(c.realized_spy_return) ? pct(c.realized_spy_return, 1, true) : null },
          { label: 'Relative alpha', value: isNum(c.relative_alpha) ? pct(c.relative_alpha, 1, true) : null, tone: c.relative_alpha > 0 ? 'up' : 'down' },
          { label: 'Target error', value: isNum(c.target_error) ? pct(c.target_error, 1) : null },
        ]),
        c.thesis_summary ? h('div', subhead('Thesis'), prose(c.thesis_summary)) : null,
        c.verdict_explanation ? h('div', subhead('Verdict'), prose(c.verdict_explanation)) : null,
        c.market_outcome ? h('div', subhead('What happened'), prose(c.market_outcome)) : null,
        c.has_switched === 0 && isNum(c.switch_alpha) ? fieldSection('Standing position to date', [
          { label: 'Held for', value: `${int(c.switch_duration_days)} days` },
          { label: 'Return if still held', value: pct(c.switch_stock_return, 1, true), tone: c.switch_stock_return > 0 ? 'up' : 'down' },
          { label: 'Alpha if still held', value: pct(c.switch_alpha, 1, true), tone: c.switch_alpha > 0 ? 'up' : 'down' },
        ]) : null,
        desk ? fieldSection('Desk record on Mag 7', [
          { label: 'Grade', value: desk.grade },
          { label: 'Hit rate', value: pct(desk.hit_rate, 0) },
          { label: 'Average alpha', value: pct(desk.avg_alpha, 0, true) },
        ]) : null)],
      actions: [sourceLink(c.source_url),
        h('button.btn', { type: 'button', onClick: () => { ctx.drawer.close(); select(c.ticker); } }, icon('eye', 12), `Isolate ${c.ticker}`)].filter(Boolean),
    });
  }

  function openDesk(x) {
    ctx.drawer.show({
      title: `${x.institution_full_name} — grade ${x.grade}`,
      sub: `${x.hits} hit · ${x.misses} miss · ${x.too_early} open of ${x.total_calls} calls`,
      content: [h('div.stack',
        fields([
          { label: 'Hit rate', value: pct(x.hit_rate, 1) },
          { label: 'Average alpha vs SPY', value: pct(x.avg_alpha, 1, true), tone: x.avg_alpha > 0 ? 'up' : 'down' },
          { label: 'Contested verdicts', value: x.curated_verdict_disagreements || '0' },
        ]),
        x.narrative ? h('div', subhead('Assessment'), prose(x.narrative)) : null,
        x.standout_win ? h('div', subhead('Standout call'),
          h('button.card', { type: 'button', style: { textAlign: 'left', width: '100%', border: '1px solid var(--up-line)', borderRadius: 'var(--r-2)' }, onClick: () => openCall(x.standout_win) },
            h('div.card__k', `${x.standout_win.ticker} · ${date(x.standout_win.published_on)}`),
            h('div.card__t', x.standout_win.key_quote_or_headline || x.standout_win.thesis_summary),
            h('div.card__b', `Alpha ${pct(x.standout_win.relative_alpha, 0, true)}`))) : null,
        x.biggest_blunder ? h('div', subhead('Worst call'),
          h('button.card', { type: 'button', style: { textAlign: 'left', width: '100%', border: '1px solid var(--down-line)', borderRadius: 'var(--r-2)' }, onClick: () => openCall(x.biggest_blunder) },
            h('div.card__k', `${x.biggest_blunder.ticker} · ${date(x.biggest_blunder.published_on)}`),
            h('div.card__t', x.biggest_blunder.key_quote_or_headline || x.biggest_blunder.thesis_summary),
            h('div.card__b', `Alpha ${pct(x.biggest_blunder.relative_alpha, 0, true)}`))) : null)],
    });
  }

  function openTheme(t) {
    ctx.drawer.show({
      title: titleCase(t.title),
      sub: t.subtitle,
      content: [h('div.stack',
        h('div.row.row--wrap', ...(t.hero_stocks || []).map((x) => h('span.chip.chip--brand', x))),
        prose(t.narrative),
        t.key_winners?.length ? h('div', subhead('Got it right'),
          ...t.key_winners.map((w) => h('div', { style: { padding: '7px 0', borderBottom: '1px solid var(--line-hair)' } },
            h('div.row', { style: { justifyContent: 'space-between' } },
              h('span', { style: { color: 'var(--ink-1)' } }, `${w.bank} · ${w.strategist}`),
              h('span.num.up', isNum(w.record?.avg_alpha) ? pct(w.record.avg_alpha, 0, true) : DASH)),
            h('div.meta', w.call),
            w.contradicted ? h('div.meta.down', 'Contradicted by the audited record') : null))) : null,
        t.key_losers?.length ? h('div', subhead('Got it wrong'),
          ...t.key_losers.map((w) => h('div', { style: { padding: '7px 0', borderBottom: '1px solid var(--line-hair)' } },
            h('div.row', { style: { justifyContent: 'space-between' } },
              h('span', { style: { color: 'var(--ink-1)' } }, `${w.bank} · ${w.strategist}`),
              h('span.num.down', isNum(w.record?.avg_alpha) ? pct(w.record.avg_alpha, 0, true) : DASH)),
            h('div.meta', w.call)))) : null)],
    });
  }

  /* ---------------------------------------------------------- commands */
  ctx.commands(() => [
    ...stocks.map((s) => ({
      id: 'mag7:' + s.ticker, group: 'Instruments', icon: 'layers',
      title: `${s.ticker} — ${s.name}`, hint: pct(s.return_ytd_2026, 0, true),
      keywords: s.sector, run: () => select(s.ticker),
    })),
    ...themes.map((t) => ({ id: 'theme:' + t.id, group: 'Dossiers', icon: 'book', title: titleCase(t.title), run: () => openTheme(t) })),
    { id: 'mag7:clear', group: 'Mag 7', icon: 'close', title: 'Clear instrument filter', run: () => select(null) },
  ]);
  ctx.bind('c', () => select(null), { label: 'Clear instrument filter' });
  ctx.bind('mod+f', () => search.focusInput(), { label: 'Filter the blotter' });

  drawRail(); drawSide(); drawChart(); applyFilter();
  const off = onResize(chartWrap, () => chart?.redraw?.());
  return { destroy() { off(); chart?.destroy?.(); } };
}

function buildDateIndex(dates) {
  const map = new Map();
  dates.forEach((d, i) => map.set(d, i));
  return (t) => {
    if (!t) return 0;
    if (map.has(t)) return map.get(t);
    if (!dates.length) return 0;
    if (t <= dates[0]) return 0;
    if (t >= dates[dates.length - 1]) return dates.length - 1;
    let lo = 0; let hi = dates.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] < t) lo = m + 1; else hi = m; }
    return lo;
  };
}
