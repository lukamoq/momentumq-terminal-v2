/**
 * Forecasts — the sell-side direction audit.
 *
 * Layout: desk rail · price path with published targets · desk dossier ·
 * call blotter. Selecting a desk anywhere filters everywhere, which is the
 * whole point of putting them on one screen instead of six sections.
 */

import { h, mount as fill, icon, onResize, s } from '../core/dom.js';
import { all, get } from '../core/api.js';
import { date, pct, num, int, compact, isNum, title as titleCase, parseList, DASH, tone } from '../core/fmt.js';
import { padScroller, chartHost } from '../ui/panel.js';
import { DataTable, searchBox, segmented, barCell } from '../ui/table.js';
import { chip, kpi, kpiGrid, delta, rateVsBase, note, readout, railRow, legend, sourceLink } from '../ui/bits.js';
import { fields, fieldSection, prose, subhead } from '../ui/overlays.js';
import { LineChart } from '../charts/plots.js';
import { linear, showTip, hideTip, Chart } from '../charts/core.js';

const DIR_COLOR = { bullish: 'var(--up)', bearish: 'var(--down)', neutral: 'var(--flat)' };

export async function mount(ctx) {
  ctx.layout({
    cols: 'minmax(0, 1fr) minmax(300px, 24%)',
    rows: 'minmax(0, 1.05fr) minmax(0, 1fr)',
    areas: '"chart side" "blot side"',
  });

  const pChart = ctx.panel({ id: 'path', index: '01', title: 'Targets vs realised path', area: 'chart', flex: true });
  const pSide  = ctx.panel({ id: 'desk', index: '03', title: 'Desk dossier', area: 'side' });
  const pBlot  = ctx.panel({ id: 'calls', index: '02', title: 'Call blotter', area: 'blot', flex: true });

  pChart.loading('chart'); pSide.loading('kpi'); pBlot.loading('rows');

  const railHead = ctx.railHead(h('span.label', 'Desks'), h('span.label', { id: 'deskCount' }, ''));
  const railBody = ctx.railBody();

  const d = await all({
    stats: '/api/stats',
    score: '/api/scorecard',
    partners: '/api/partners',
    timeline: '/api/timeline',
    calls: '/api/calls',
  });

  if (!d.timeline && !d.score) {
    const err = d.$errors[0]?.err;
    pChart.error(err, () => location.reload());
    pSide.error(err); pBlot.error(err);
    return { destroy() {} };
  }

  const stats = d.stats || {};
  const scoreRows = d.score || [];
  const partners = d.partners || [];
  const timeline = d.timeline || { market_path: [], calls: [], flips: [], institutions: [] };
  const callRows = d.calls || [];

  ctx.setStatus({ asOf: stats.as_of_date, rows: callRows.length, mode: 'Forecast audit' });

  /* ---------------------------------------------------------------- index */
  const path = timeline.market_path || [];
  const dates = path.map((p) => p.date);
  const levels = path.map((p) => p.index_level);
  const dateAt = buildDateIndex(dates);

  const scoreById = new Map(scoreRows.map((r) => [r.institution_id, r]));
  const partnerById = new Map(partners.map((r) => [r.institution_id, r]));
  const nameById = new Map(scoreRows.map((r) => [r.institution_id, r.institution_name]));
  for (const i of timeline.institutions || []) if (!nameById.has(i.id)) nameById.set(i.id, i.name);

  // Rank order: reliability where it was measured, then everything else.
  const desks = scoreRows.slice().sort((a, b) => {
    const pa = partnerById.get(a.institution_id);
    const pb = partnerById.get(b.institution_id);
    if (pa && pb) return pa.rank - pb.rank;
    if (pa) return -1;
    if (pb) return 1;
    return (b.total_calls || 0) - (a.total_calls || 0);
  });

  /* ----------------------------------------------------------------- state */
  const st = {
    desk: ctx.params.desk || null,
    view: ctx.params.view || ctx.prefs.view || 'path',
    range: ctx.params.range || ctx.prefs.range || '5y',
    dir: 'all',
    q: '',
  };

  const RANGES = [
    { value: '1y', label: '1Y', years: 1 },
    { value: '5y', label: '5Y', years: 5 },
    { value: 'audit', label: 'AUDIT', from: '2021-01-01' },
    { value: 'all', label: 'ALL', from: dates[0] },
  ];

  function rangeSlice() {
    const r = RANGES.find((x) => x.value === st.range) || RANGES[1];
    let from = r.from;
    if (r.years) {
      const end = dates[dates.length - 1] || stats.as_of_date;
      from = `${Number(end.slice(0, 4)) - r.years}${end.slice(4, 10)}`;
    }
    const i0 = Math.max(0, dateAt(from));
    return { i0, i1: dates.length - 1 };
  }

  /* ------------------------------------------------------------------ rail */
  function drawRail() {
    const list = h('div.rlist', { role: 'listbox', 'aria-label': 'Research desks' });
    list.appendChild(h('div.rlist__sep', 'Ranked by reliability'));
    desks.forEach((row) => {
      const p = partnerById.get(row.institution_id);
      // An always-bullish desk sits exactly on the baseline by construction.
      // Printing 0.0% would read as a measured result; it is the absence of one.
      const scored = !row.is_always_bullish;
      const edge = scored ? row.stance_day_edge : null;
      const selected = st.desk === row.institution_id;
      list.appendChild(railRow({
        rank: p ? String(p.rank).padStart(2, '0') : '··',
        name: row.institution_name,
        value: isNum(edge) ? pct(edge, 1, true) : 'n/d',
        sub: [
          h('span', `${row.total_calls} call${row.total_calls === 1 ? '' : 's'}`),
          scored
            ? h('span', { class: p && p.reliability_score >= 50 ? 'up' : 'down' }, p ? `rel ${num(p.reliability_score, 0)}` : '')
            : h('span.dim', 'always bullish'),
        ].filter(Boolean),
        selected,
        title: scored
          ? `${row.institution_full_name} — ${p ? p.tier : 'not ranked'}`
          : `${row.institution_full_name} — no bearish or neutral call on record, so direction cannot be scored`,
        onClick: () => selectDesk(selected ? null : row.institution_id),
      }));
      const last = list.lastChild;
      last.querySelector('.rlist__val').className = 'rlist__val ' + (isNum(edge) ? (edge > 0 ? 'up' : edge < 0 ? 'down' : 'flat') : 'na');
    });
    fill(railBody, list);
    railHead.lastChild.textContent = `${desks.length} audited`;
  }

  function selectDesk(id) {
    st.desk = id;
    ctx.patch({ desk: id || undefined });
    drawRail();
    drawSide();
    applyFilter();
    chart?.redraw();
  }

  /* ----------------------------------------------------------------- chart */
  const rangeSeg = segmented(RANGES.map((r) => ({ value: r.value, label: r.label })), st.range, (v) => {
    st.range = v; ctx.savePrefs({ range: v }); ctx.patch({ range: v }); rebuildChart();
  }, { label: 'Date range' });

  const viewSeg = segmented(
    [{ value: 'path', label: 'PATH', title: 'Index level with every published target' },
     { value: 'lanes', label: 'LANES', title: 'One lane per desk, coloured by the stance standing that day' }],
    st.view, (v) => { st.view = v; ctx.savePrefs({ view: v }); ctx.patch({ view: v }); rebuildChart(); },
    { label: 'Chart view' });

  pChart.tools.prepend(viewSeg, rangeSeg);

  const chartBox = chartHost();
  const legendBox = h('div', { style: { padding: '5px var(--panel-pad)', borderTop: '1px solid var(--line)' } });
  const chartWrap = h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, chartBox);
  pChart.render(chartWrap, legendBox);

  let chart = null;

  function rebuildChart() {
    chart?.destroy?.();
    chartBox.innerHTML = '';
    if (st.view === 'lanes') drawLanes();
    else drawPath();
  }

  function drawPath() {
    const { i0, i1 } = rangeSlice();
    const xs = dates.slice(i0, i1 + 1);
    const ys = levels.slice(i0, i1 + 1);

    const visibleCalls = (timeline.calls || []).filter((c) => {
      if (c.call_type !== 'direction' || !isNum(c.target_level)) return false;
      const i = dateAt(c.published_on);
      return i >= i0 && i <= i1;
    });

    const markers = visibleCalls.map((c) => {
      const dim = st.desk && c.institution_id !== st.desk;
      return {
        i: dateAt(c.published_on) - i0,
        y: c.target_level,
        color: dim ? 'var(--ink-4)' : (DIR_COLOR[c.direction] || 'var(--info)'),
        r: dim ? 2 : 3.4,
        title: `${nameById.get(c.institution_id) || c.institution_id} · ${date(c.published_on)} · target ${int(c.target_level)} (${titleCase(c.direction)})`,
      };
    });

    const flips = (timeline.flips || []).filter((f) => {
      const i = dateAt(f.flip_date);
      return i >= i0 && i <= i1 && (!st.desk || f.institution_id === st.desk);
    }).map((f) => ({
      i: dateAt(f.flip_date) - i0,
      y: levels[dateAt(f.flip_date)],
      shape: 'diamond',
      color: DIR_COLOR[f.to_direction] || 'var(--info)',
      title: `${nameById.get(f.institution_id) || f.institution_id} flipped ${f.from_direction} → ${f.to_direction} on ${date(f.flip_date)}`,
    }));

    const callsByIdx = new Map();
    for (const c of visibleCalls) {
      const k = dateAt(c.published_on) - i0;
      if (!callsByIdx.has(k)) callsByIdx.set(k, []);
      callsByIdx.get(k).push(c);
    }

    chart = LineChart(chartBox, {
      x: xs,
      series: [{ label: 'S&P 500', color: 'var(--ink-2)', y: ys, width: 1.4, area: 'var(--brand)', areaOpacity: 0.09 }],
      yFmt: (v) => int(v),
      xFmt: (v) => date(v, 'month'),
      tipTitle: (i) => date(xs[i], 'long'),
      extraTipRows: (i) => {
        const list = callsByIdx.get(i) || [];
        return list.slice(0, 4).map((c) => ({
          k: nameById.get(c.institution_id) || c.institution_id,
          v: `${int(c.target_level)} · ${titleCase(c.direction)}`,
          color: DIR_COLOR[c.direction],
        }));
      },
      markers: [...markers, ...flips],
      label: 'S&P 500 index level with published sell-side targets',
    });

    fill(legendBox, legend([
      { color: 'var(--ink-2)', label: 'S&P 500 (SPY×10 proxy)' },
      { color: 'var(--up)', label: 'Bullish target' },
      { color: 'var(--down)', label: 'Bearish target' },
      { color: 'var(--flat)', label: 'Neutral target' },
      { color: 'var(--info)', label: '◆ direction flip', box: true },
    ]));
    pChart.setMeta(`${visibleCalls.length} targets · ${flips.length} flips · ${date(xs[0])} → ${date(xs[xs.length - 1])}`);
  }

  /**
   * Lane view: one row per desk, filled with the stance that was standing on
   * each day. Gaps before a desk's first call are left blank rather than
   * back-filled — a desk that had not spoken yet had no stance.
   */
  function drawLanes() {
    const { i0, i1 } = rangeSlice();
    const from = dates[i0];
    const to = dates[i1];
    const asOf = stats.as_of_date || to;

    const laneDesks = desks.filter((dk) => (timeline.calls || []).some((c) => c.institution_id === dk.institution_id && c.call_type === 'direction'));
    const lanes = laneDesks.map((dk) => {
      const cs = (timeline.calls || [])
        .filter((c) => c.institution_id === dk.institution_id && c.call_type === 'direction' && c.direction)
        .sort((a, b) => a.published_on.localeCompare(b.published_on));
      const segs = cs.map((c, i) => ({
        from: c.published_on,
        to: cs[i + 1] ? cs[i + 1].published_on : asOf,
        dir: c.direction,
        call: c,
      })).filter((sg) => sg.to > from && sg.from < to);
      return { desk: dk, segs };
    }).filter((l) => l.segs.length);

    chart = Chart(chartBox, (svg, w, hgt) => {
      const padL = 96;
      const padR = 12;
      const padT = 8;
      const padB = 22;
      const x0 = padL;
      const x1 = w - padR;
      if (x1 <= x0 || lanes.length === 0) return;
      const rowH = Math.max(9, Math.min(24, (hgt - padT - padB) / lanes.length));
      const barH = Math.max(5, rowH - 3);
      const sx = linear(i0, i1, x0, x1);
      const g = s('g');
      svg.appendChild(g);

      // year gridlines
      let lastYear = null;
      for (let i = i0; i <= i1; i++) {
        const y = dates[i].slice(0, 4);
        if (y !== lastYear) {
          lastYear = y;
          const gx = Math.round(sx(i)) + 0.5;
          g.appendChild(s('line', { class: 'ax-grid', x1: gx, x2: gx, y1: padT, y2: hgt - padB }));
          g.appendChild(s('text', { class: 'ax-txt', x: gx + 3, y: hgt - padB + 13 }, y));
        }
      }

      lanes.forEach((lane, r) => {
        const y = padT + r * rowH;
        const dim = st.desk && lane.desk.institution_id !== st.desk;
        // The gutter is fixed, so the label is trimmed to fit it rather than
        // being allowed to run off the left edge of the panel.
        const maxChars = Math.max(6, Math.floor((padL - 10) / 6.1));
        const name = lane.desk.institution_name.length > maxChars
          ? lane.desk.institution_name.slice(0, maxChars - 1) + '…'
          : lane.desk.institution_name;
        const label = s('text', {
          class: 'ax-txt' + (dim ? '' : ' ax-txt--em'), x: x0 - 7, y: y + barH / 2 + 3.5, 'text-anchor': 'end',
        }, name);
        label.appendChild(s('title', {}, lane.desk.institution_full_name || lane.desk.institution_name));
        g.appendChild(label);
        g.appendChild(s('rect', { x: x0, y, width: x1 - x0, height: barH, fill: 'var(--s-input)', rx: 1 }));

        for (const sg of lane.segs) {
          const a = Math.max(i0, dateAt(sg.from));
          const b = Math.min(i1, dateAt(sg.to));
          if (b <= a) continue;
          const rx = sx(a);
          const rw = Math.max(1.5, sx(b) - rx);
          const rect = s('rect', {
            x: rx, y, width: rw, height: barH, rx: 1,
            fill: DIR_COLOR[sg.dir] || 'var(--ink-4)',
            opacity: dim ? 0.2 : 0.78,
          });
          rect.addEventListener('mousemove', (e) => showTip(e, lane.desk.institution_name, [
            { k: 'Stance', v: titleCase(sg.dir), color: DIR_COLOR[sg.dir] },
            { k: 'From', v: date(sg.from) },
            { k: 'To', v: date(sg.to) },
            { k: 'Target', v: isNum(sg.call.target_level) ? int(sg.call.target_level) : DASH },
            { k: 'Strategist', v: sg.call.strategist_name || DASH },
          ]));
          rect.addEventListener('mouseleave', hideTip);
          rect.addEventListener('click', () => openCall(sg.call));
          rect.style.cursor = 'pointer';
          g.appendChild(rect);
        }
      });
    }, { label: 'Stance lanes by desk' });

    fill(legendBox, legend([
      { color: 'var(--up)', label: 'Bullish', box: true },
      { color: 'var(--down)', label: 'Bearish', box: true },
      { color: 'var(--flat)', label: 'Neutral', box: true },
      { color: 'var(--s-input)', label: 'No stance on record', box: true },
    ]));
    pChart.setMeta(`${lanes.length} desks · ${date(from)} → ${date(to)}`);
  }

  /* ------------------------------------------------------------------ side */
  function drawSide() {
    if (!st.desk) {
      const discriminating = stats.discriminating_institutions;
      const alwaysBull = stats.always_bullish_institutions;
      const ranked = partners.filter((p) => isNum(p.stance_day_edge) && !scoreById.get(p.institution_id)?.is_always_bullish);
      const best = ranked.slice().sort((a, b) => b.stance_day_edge - a.stance_day_edge)[0];
      const beaters = ranked.filter((p) => p.stance_day_edge > 0);

      pSide.setTitle('Audit result');
      pSide.setMeta(`${stats.total_institutions || desks.length} houses`);
      pSide.render(padScroller(h('div.stack',
        kpiGrid(2,
          kpi({
            label: 'Desks beating the baseline', value: `${beaters.length} / ${ranked.length}`,
            t: beaters.length > ranked.length / 2 ? 'up' : 'down',
            bar: ranked.length ? beaters.length / ranked.length : 0,
            sub: `Stance-day hit rate above the always-bullish benchmark. ${alwaysBull ?? 0} always-bullish houses are excluded — they sit on the baseline by construction.`,
          }),
          kpi({
            label: 'Discriminating houses', value: `${discriminating ?? DASH} / ${stats.total_institutions ?? DASH}`,
            sub: `${alwaysBull ?? DASH} never published a bearish or neutral call and cannot be scored on direction.`,
          }),
          kpi({ label: 'Stance-day evaluations', value: compact(stats.direction_stance_day_evaluations), sub: `${int(stats.direction_event_evaluations)} discrete call events.` }),
          kpi({ label: 'Audited calls', value: int(stats.total_calls), sub: `Market data ${date(stats.market_data_start)} → ${date(stats.market_data_end)}.` })),

        best ? h('div',
          subhead(beaters.length ? 'Best measured edge' : 'Least negative edge'),
          h('div.row', { style: { justifyContent: 'space-between', alignItems: 'baseline' } },
            h('div', h('div', { style: { fontSize: 'var(--t-lead)', color: 'var(--ink-1)' } }, best.institution_name),
              h('div.meta', best.tier)),
            h('div.num', { class: best.stance_day_edge > 0 ? 'up' : 'down', style: { fontSize: 'var(--t-stat)' } }, pct(best.stance_day_edge, 1, true))),
          h('div.meta', { style: { marginTop: '6px' } },
            beaters.length
              ? 'Select any desk in the left rail for its full dossier.'
              : 'No audited desk beat the always-bullish baseline over this window. Select any desk for its full dossier.')) : null,

        note(h('strong', 'Anti-failure guardrail. '),
          'In a market that rose across the window, an always-bullish forecast earns a high nominal hit rate for free. ',
          'Every rate on this screen is printed beside that naive baseline, and a desk with no bearish or neutral call renders ',
          h('code', 'NO DISCRIMINATING CALLS'), ' rather than unearned accuracy.'),

        stats.spx_basis_note ? h('div.meta', stats.spx_basis_note) : null,
      )));
      return;
    }

    const row = scoreById.get(st.desk);
    const p = partnerById.get(st.desk);
    if (!row) { pSide.empty('This desk has no scored record.'); return; }

    const strengths = parseList(p?.strengths);
    const risks = parseList(p?.risks);
    const deskCalls = callRows.filter((c) => c.institution_id === st.desk);

    pSide.setTitle(row.institution_name);
    pSide.setMeta(p ? `rank ${p.rank}/${p.ranked_out_of}` : 'not ranked');
    pSide.render(padScroller(h('div.stack',
      h('div',
        h('div', { style: { fontSize: 'var(--t-lead)', color: 'var(--ink-1)' } }, row.institution_full_name),
        h('div.row', { style: { marginTop: '5px' } },
          p ? chip(p.tier.split(':')[0], p.reliability_score >= 55 ? 'up' : p.reliability_score >= 45 ? 'flat' : 'down') : null,
          row.is_always_bullish ? chip('always bullish', 'na') : null,
          h('span.chip', `${row.total_calls} calls`))),

      kpiGrid(2,
        kpi({
          label: 'Reliability', value: p ? num(p.reliability_score, 1) : DASH,
          bar: p ? p.reliability_score / 100 : null,
          barColor: p && p.reliability_score >= 50 ? 'var(--up)' : 'var(--down)',
          sub: p ? p.tier : 'Not ranked — no discriminating direction calls.',
        }),
        kpi({
          label: 'Stance-day edge',
          value: isNum(row.stance_day_edge) ? pct(row.stance_day_edge, 2, true) : DASH,
          t: isNum(row.stance_day_edge) ? (row.stance_day_edge > 0 ? 'up' : 'down') : null,
          sub: `${pct(row.stance_day_hit_rate, 1)} hit vs ${pct(row.always_bullish_stance_day_hit_rate, 1)} baseline over ${compact(row.stance_day_resolved)} days.`,
        })),

      h('div', subhead('Scored record'), readout([
        { label: 'Event hit rate', value: rateVsBase(row.event_hit_rate, row.always_bullish_event_hit_rate) },
        { label: 'Events resolved', value: `${int(row.event_hits)} hit / ${int(row.event_misses)} miss / ${int(row.event_too_early)} early` },
        { label: 'Stance-day hit rate', value: rateVsBase(row.stance_day_hit_rate, row.always_bullish_stance_day_hit_rate) },
        { label: 'Mix', value: `${row.n_bullish} bull · ${row.n_bearish} bear · ${row.n_neutral} neutral` },
        p && p.target_mape_measured ? { label: 'Target error (MAPE)', value: `${pct(p.target_mape, 1)} over ${p.target_mape_n}`, t: p.target_mape < 0.1 ? 'up' : null } : { label: 'Target error (MAPE)', value: h('span.na', 'not measured') },
        p ? { label: 'Agility', value: p.agility_label, title: `Lag ratio ${num(p.avg_lag_ratio, 2)}` } : null,
        p && isNum(p.bull_market_edge) ? { label: 'Edge in bull tape', value: delta(p.bull_market_edge), title: `${int(p.bull_market_resolved)} resolved days` } : null,
        p && isNum(p.bear_market_edge) ? { label: 'Edge in bear tape', value: delta(p.bear_market_edge), title: `${int(p.bear_market_resolved)} resolved days` } : null,
        { label: 'Latest target', value: isNum(row.latest_target) ? `${int(row.latest_target)} (${pct(row.latest_implied_return, 1, true)})` : h('span.na', DASH) },
        { label: 'Latest call', value: row.latest_published_on ? `${titleCase(row.latest_direction)} · ${date(row.latest_published_on)}` : DASH, t: tone(row.latest_direction) },
      ])),

      strengths.length ? h('div', subhead('Strengths'),
        h('ul', ...strengths.map((x) => h('li', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-2)', padding: '3px 0 3px 14px', position: 'relative' } },
          h('span', { style: { position: 'absolute', left: '0', color: 'var(--up)' } }, '▸'), x)))) : null,

      risks.length ? h('div', subhead('Risks'),
        h('ul', ...risks.map((x) => h('li', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-2)', padding: '3px 0 3px 14px', position: 'relative' } },
          h('span', { style: { position: 'absolute', left: '0', color: 'var(--down)' } }, '▸'), x)))) : null,

      h('div', subhead(`Calls on record (${deskCalls.length})`),
        h('div', ...deskCalls.slice(0, 8).map((c) => h('button', {
          type: 'button',
          style: { display: 'block', width: '100%', textAlign: 'left', padding: '5px 0', borderBottom: '1px solid var(--line-hair)' },
          onClick: () => openCall(c),
        },
          h('div.row', { style: { justifyContent: 'space-between' } },
            h('span.num', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-3)' } }, date(c.published_on)),
            chip(c.direction)),
          h('div.trunc', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-2)' } }, c.notes || c.forecast_horizon))))),

      h('button.btn', { type: 'button', onClick: () => selectDesk(null) }, icon('close', 12), 'Clear desk filter'),
    )));
  }

  /* --------------------------------------------------------------- blotter */
  const dirSeg = segmented(
    [{ value: 'all', label: 'ALL' }, { value: 'bullish', label: 'BULL' },
     { value: 'bearish', label: 'BEAR' }, { value: 'neutral', label: 'NEUT' }],
    'all', (v) => { st.dir = v; applyFilter(); }, { label: 'Direction filter' });

  const search = searchBox('Filter calls, desks, strategists…', (q) => { st.q = q.toLowerCase(); applyFilter(); });
  const countEl = h('span.tbar__count');

  const table = DataTable({
    label: 'Sell-side call blotter',
    rows: callRows,
    rowKey: (r) => r.id,
    sort: 'published_on',
    dir: -1,
    onOpen: (r) => openCall(r),
    empty: 'No calls match this filter.',
    columns: [
      { key: 'published_on', label: 'Date', width: '76px', render: (r) => date(r.published_on) },
      { key: 'institution_name', label: 'Desk', width: '128px', strong: true,
        render: (r) => r.institution_name || r.institution_id, cellTitle: (r) => r.institution_id },
      { key: 'direction', label: 'Dir', width: '74px', render: (r) => (r.direction ? chip(r.direction) : h('span.na', DASH)) },
      { key: 'target_level', label: 'Target', align: 'right', width: '68px', render: (r) => (isNum(r.target_level) ? int(r.target_level) : DASH) },
      { key: 'spot_at_publication', label: 'Spot', align: 'right', width: '72px',
        render: (r) => (isNum(r.spot_at_publication) ? num(r.spot_at_publication, 0) : DASH) },
      { key: 'implied_return', label: 'Implied', align: 'right', width: '74px',
        render: (r) => (isNum(r.implied_return)
          ? barCell(pct(r.implied_return, 1, true), Math.min(1, Math.abs(r.implied_return) / 0.25),
                    r.implied_return >= 0 ? 'var(--up-wash)' : 'var(--down-wash)')
          : DASH) },
      { key: 'forecast_horizon', label: 'Horizon', width: '84px', render: (r) => r.forecast_horizon || DASH },
      { key: 'strategist_name', label: 'Strategist', width: '132px', render: (r) => r.strategist_name || DASH },
      { key: 'ai_stance', label: 'AI', width: '68px',
        render: (r) => (r.ai_stance ? chip(r.ai_stance) : h('span.na', DASH)),
        cellTitle: (r) => r.ai_reasoning || '' },
      { key: 'ai_confidence', label: 'Conf', align: 'right', width: '58px',
        render: (r) => (isNum(r.ai_confidence) ? pct(r.ai_confidence, 0) : DASH) },
      { key: 'ai_math_agreement', label: 'Agree', width: '86px',
        render: (r) => (r.ai_math_agreement === null || r.ai_math_agreement === undefined
          ? h('span.na', DASH)
          : chip(r.ai_math_agreement ? 'match' : 'differs', r.ai_math_agreement ? 'up' : 'flat')),
        cellTitle: () => 'Whether the AI stance classifier agrees with the arithmetic direction of the target' },
      { key: 'notes', label: 'Note', wrap: false, render: (r) => r.notes || DASH, cellTitle: (r) => r.notes || '' },
    ],
  });

  pBlot.render(
    h('div.tbar', dirSeg, search, countEl,
      h('button.btn.btn--ghost', { type: 'button', title: 'Download the filtered blotter as CSV', onClick: exportCsv }, icon('book', 12), 'CSV')),
    h('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, table.el));

  function applyFilter() {
    const n = table.filter((r) => {
      if (st.desk && r.institution_id !== st.desk) return false;
      if (st.dir !== 'all' && r.direction !== st.dir) return false;
      if (!st.q) return true;
      return [r.institution_name, r.strategist_name, r.notes, r.forecast_horizon, r.direction, r.institution_id]
        .some((v) => String(v || '').toLowerCase().includes(st.q));
    });
    countEl.textContent = `${n} / ${callRows.length}`;
    pBlot.setMeta(st.desk ? `filtered to ${nameById.get(st.desk)}` : 'all desks');
    ctx.setStatus({ rows: n });
  }

  function exportCsv() {
    const cols = ['published_on', 'institution_id', 'institution_name', 'direction', 'target_level',
                  'spot_at_publication', 'implied_return', 'forecast_horizon', 'strategist_name', 'confidence', 'source_url'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...table.view.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = h('a', { href: url, download: `momentumq-calls-${stats.as_of_date || 'export'}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.toast(`Exported ${table.view.length} calls`, 'ok');
  }

  /* ---------------------------------------------------------------- drawer */
  function openCall(c) {
    const sc = scoreById.get(c.institution_id);
    const drivers = parseList(c.ai_key_drivers);
    ctx.drawer.show({
      title: `${c.institution_name || nameById.get(c.institution_id) || c.institution_id} — ${titleCase(c.direction)}`,
      sub: `${date(c.published_on, 'long')} · ${c.forecast_horizon || 'no horizon'} · ${c.confidence || 'unverified'}`,
      content: [
        h('div.stack',
          h('div.row.row--wrap',
            chip(c.direction),
            c.approximate_date ? chip('approx. date', 'flat') : null,
            c.confidence ? chip(c.confidence, c.confidence === 'verified' ? 'up' : 'flat') : null),
          fields([
            { label: 'Target level', value: isNum(c.target_level) ? int(c.target_level) : null },
            { label: 'Spot at publication', value: isNum(c.spot_at_publication) ? num(c.spot_at_publication, 2) : null },
            { label: 'Implied return', value: isNum(c.implied_return) ? pct(c.implied_return, 2, true) : null, tone: c.implied_return > 0 ? 'up' : 'down' },
            { label: 'Strategist', value: c.strategist_name },
            { label: 'Title', value: c.strategist_title },
            { label: 'Call type', value: titleCase(c.call_type) },
            { label: 'Allocation', value: c.allocation_stance ? `${titleCase(c.allocation_stance)} ${c.allocation_asset} vs ${c.allocation_benchmark}` : null },
            { label: 'Probability', value: c.probability_event ? `${c.probability_event}: ${pct(c.probability_value, 0)}` : null },
          ]),
          c.notes ? h('div', subhead('Note'), prose(c.notes)) : null,
          c.ai_stance ? h('div', subhead('AI stance classifier'),
            fields([
              { label: 'Stance', value: titleCase(c.ai_stance), tone: tone(c.ai_stance) },
              { label: 'Confidence', value: pct(c.ai_confidence, 1) },
              { label: 'Sentiment score', value: num(c.ai_sentiment_score, 3) },
              { label: 'Agrees with arithmetic', value: c.ai_math_agreement === null ? null : (c.ai_math_agreement ? 'yes' : 'no') },
            ]),
            drivers.length ? h('div.row.row--wrap', { style: { marginTop: '8px' } }, ...drivers.map((x) => h('span.chip', x))) : null,
            c.ai_reasoning ? h('div.meta', { style: { marginTop: '8px' } }, c.ai_reasoning) : null) : null,
          sc ? fieldSection('Desk record', [
            { label: 'Stance-day hit rate', value: pct(sc.stance_day_hit_rate, 1) },
            { label: 'Always-bullish baseline', value: pct(sc.always_bullish_stance_day_hit_rate, 1) },
            { label: 'Edge', value: sc.is_always_bullish ? null : pct(sc.stance_day_edge, 2, true), tone: sc.stance_day_edge > 0 ? 'up' : 'down' },
            { label: 'Direction mix', value: `${sc.n_bullish} bull · ${sc.n_bearish} bear · ${sc.n_neutral} neutral` },
            { label: 'Scoreable', value: sc.is_always_bullish ? 'no — no bearish or neutral call on record' : null },
          ]) : null),
      ],
      actions: [
        sourceLink(c.source_url),
        h('button.btn', { type: 'button', onClick: () => { ctx.drawer.close(); selectDesk(c.institution_id); } },
          icon('eye', 12), 'Isolate this desk'),
      ].filter(Boolean),
    });
  }

  /* ------------------------------------------------------------- commands */
  ctx.commands(() => [
    ...desks.map((dk) => ({
      id: 'desk:' + dk.institution_id, group: 'Desks', icon: 'target',
      title: dk.institution_full_name || dk.institution_name,
      hint: isNum(dk.stance_day_edge) ? pct(dk.stance_day_edge, 1, true) : 'unranked',
      keywords: dk.institution_id,
      run: () => selectDesk(dk.institution_id),
    })),
    { id: 'f:clear', group: 'Forecasts', icon: 'close', title: 'Clear desk filter', run: () => selectDesk(null) },
    { id: 'f:lanes', group: 'Forecasts', icon: 'chart', title: 'Chart: stance lanes', run: () => { viewSeg.setValue('lanes'); st.view = 'lanes'; rebuildChart(); } },
    { id: 'f:path', group: 'Forecasts', icon: 'chart', title: 'Chart: targets vs price path', run: () => { viewSeg.setValue('path'); st.view = 'path'; rebuildChart(); } },
    { id: 'f:csv', group: 'Forecasts', icon: 'book', title: 'Export filtered blotter to CSV', run: exportCsv },
  ]);

  ctx.bind('l', () => { const v = st.view === 'lanes' ? 'path' : 'lanes'; viewSeg.setValue(v); st.view = v; rebuildChart(); }, { label: 'Toggle lanes / price path' });
  ctx.bind('mod+f', () => search.focusInput(), { label: 'Filter the blotter' });
  ctx.bind('c', () => selectDesk(null), { label: 'Clear desk filter' });

  /* ----------------------------------------------------------------- boot */
  drawRail();
  drawSide();
  rebuildChart();
  applyFilter();
  table.el.focus?.();

  const off = onResize(chartWrap, () => chart?.redraw?.());

  return {
    destroy() { off(); chart?.destroy?.(); },
    onParams(p) {
      if (p.desk !== undefined && p.desk !== st.desk) selectDesk(p.desk || null);
    },
  };
}

/** Nearest-trading-day lookup: calls land on weekends, prices do not. */
function buildDateIndex(dates) {
  const map = new Map();
  dates.forEach((d, i) => map.set(d, i));
  return (target) => {
    if (!target) return 0;
    const t = String(target).slice(0, 10);
    if (map.has(t)) return map.get(t);
    let lo = 0;
    let hi = dates.length - 1;
    if (t <= dates[0]) return 0;
    if (t >= dates[hi]) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}
