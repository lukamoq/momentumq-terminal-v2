/**
 * AI Desk — news wire, alpha signals, and the agent console.
 *
 * The desk states plainly whether it is bound to a live model or running the
 * deterministic engine, because a synthesised report and a model-generated
 * one are not the same artefact and should never be mistaken for each other.
 */

import { h, mount as fill, icon, onResize } from '../core/dom.js';
import { all, get, post } from '../core/api.js';
import { pct, num, int, money, compact, isNum, title as titleCase, date, time, ago, DASH, tone } from '../core/fmt.js';
import { padScroller, chartHost } from '../ui/panel.js';
import { segmented, searchBox, DataTable, barCell } from '../ui/table.js';
import { kpi, kpiGrid, note, readout, railRow, legend, chip, barRow } from '../ui/bits.js';
import { subhead, markdown, prose, fields } from '../ui/overlays.js';

const REPORT_TYPES = [
  { id: 'eow_dossier', label: 'End-of-week dossier' },
  { id: 'market_open_memo', label: 'Market-open memo' },
  { id: 'gex_note', label: 'Dealer gamma note' },
  { id: 'commodity_note', label: 'Commodity & real-rate note' },
];

export async function mount(ctx) {
  ctx.layout({
    cols: 'minmax(0, 1fr) minmax(330px, 27%)',
    rows: 'minmax(0, 1.15fr) minmax(0, 1fr)',
    areas: '"wire desk" "alpha desk"',
  });

  const pWire = ctx.panel({ id: 'wire', index: '01', title: 'News wire', area: 'wire', flex: true });
  const pAlpha = ctx.panel({ id: 'alpha', index: '02', title: 'Alpha signals', area: 'alpha', flex: true });
  const pDesk = ctx.panel({ id: 'desk', index: '03', title: 'Desk', area: 'desk', flex: true });
  pWire.loading('rows'); pAlpha.loading('rows'); pDesk.loading('kpi');

  const railHead = ctx.railHead(h('span.label', 'Roster'), h('span.label', ''));
  const railBody = ctx.railBody();

  const d = await all({
    status: '/api/agents/status',
    feed: '/api/news/feed',
    wraps: '/api/news/market-wraps',
    insider: '/api/alpha/insider-trades',
    whales: '/api/alpha/smart-money',
  });

  const status = d.status || {};
  const feed = d.feed || {};
  let wraps = d.wraps || [];
  const insider = d.insider || {};
  const whales = d.whales || {};

  ctx.setStatus({ asOf: insider.as_of_date, rows: (feed.feed || []).length, mode: 'AI desk' });

  const st = {
    alphaView: ctx.prefs.alphaView || 'insider',
    deskView: ctx.prefs.deskView || 'console',
    q: '',
    sentiment: 'all',
    messages: [],
    busy: false,
  };

  /* -------------------------------------------------------------- rail */
  function drawRail() {
    const list = h('div.rlist');
    list.appendChild(h('div.rlist__sep', `Model: ${status.model || 'unknown'}`));
    for (const a of status.agents || []) {
      list.appendChild(h('div.rlist__item', { style: { cursor: 'default' }, title: a.role },
        h('span.rlist__name', a.name),
        h('span.rlist__val', h('span.chip.chip--' + (a.status === 'ONLINE' ? 'up' : 'na'), a.status)),
        h('span.rlist__sub', a.role)));
    }
    list.appendChild(h('div.rlist__sep', 'Capabilities'));
    for (const c of status.capabilities || []) {
      list.appendChild(h('div.rlist__item', { style: { cursor: 'default' }, title: c }, h('span.rlist__name', c), h('span')));
    }
    fill(railBody, list);
    railHead.lastChild.textContent = `${(status.agents || []).length} agents`;

    fill(ctx.railFoot(),
      status.api_bound
        ? h('div.row', h('span.chip.chip--up', 'live model bound'), h('span.meta', 'Reports call the model.'))
        : h('div',
            h('span.chip.chip--flat', 'deterministic engine'),
            h('div.meta', { style: { marginTop: '5px' } },
              'No model key is configured, so reports are synthesised from the observed tables rather than generated. Every figure is still computed, none is written by a model.')));
  }

  /* -------------------------------------------------------------- wire */
  const sentSeg = segmented(
    [{ value: 'all', label: 'ALL' }, { value: 'BULLISH', label: 'BULL' },
     { value: 'BEARISH', label: 'BEAR' }, { value: 'NEUTRAL', label: 'NEUT' }],
    'all', (v) => { st.sentiment = v; drawWire(); }, { label: 'Sentiment filter' });
  const wireSearch = searchBox('Filter headlines, tickers…', (q) => { st.q = q.toLowerCase(); drawWire(); });
  pWire.tools.prepend(sentSeg);

  function drawWire() {
    const b = feed.barometer || {};
    const items = (feed.feed || []).filter((x) => {
      if (st.sentiment !== 'all' && x.sentiment !== st.sentiment) return false;
      if (!st.q) return true;
      return [x.headline, x.summary, x.source, x.category, ...(x.tickers || [])]
        .some((v) => String(v || '').toLowerCase().includes(st.q));
    });

    const list = h('div.wire');
    for (const x of items) {
      const t = tone(x.sentiment);
      list.appendChild(h('button.wire__i', {
        type: 'button', onClick: () => openWire(x),
      },
        h('span.wire__t', time(x.timestamp)),
        h('span.wire__h', x.headline),
        h('span.wire__s', h('span.chip.chip--' + t, `${x.sentiment} ${num(x.confidence_pct, 0)}%`)),
        h('span.wire__m',
          h('span', x.source), h('span', '·'), h('span', x.category), h('span', '·'),
          h('span', titleCase(x.impact_horizon)),
          ...(x.tickers || []).map((tk) => h('span.chip', tk)))));
    }
    if (!items.length) list.appendChild(h('div.state__msg', { style: { padding: '30px', textAlign: 'center' } }, 'No wires match this filter.'));

    pWire.render(
      h('div.verdict',
        h('div',
          h('div.verdict__l', 'Wire barometer'),
          h('div.verdict__v', { class: tone(b.net_stance) }, `${b.net_score > 0 ? '+' : ''}${num(b.net_score, 2)}`)),
        h('div', { style: { minWidth: '0', flex: '1 1 auto' } },
          h('div.row', { style: { gap: '6px', marginBottom: '5px' } },
            chip(b.net_stance),
            h('span.chip.chip--up', `${num(b.bullish_pct, 0)}% bull`),
            h('span.chip.chip--down', `${num(b.bearish_pct, 0)}% bear`),
            h('span.chip', `${num(b.neutral_pct, 0)}% neutral`),
            h('span.chip.chip--info', titleCase(b.velocity))),
          h('div.meter', { title: `${b.total_items_analyzed} wires analysed` },
            h('i', { style: { width: `${b.bullish_pct}%`, background: 'var(--up)' } })))),
      h('div.tbar', wireSearch, h('span.tbar__count', `${items.length} / ${(feed.feed || []).length} wires`)),
      h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } }, list));
    pWire.setMeta(`analysed by ${(feed.feed || [])[0]?.evaluated_by || 'the wire classifier'}`);
    ctx.setStatus({ rows: items.length });
  }

  function openWire(x) {
    ctx.drawer.show({
      title: x.headline,
      sub: `${x.source} · ${date(x.timestamp)} ${time(x.timestamp)} · ${x.category}`,
      content: [h('div.stack',
        h('div.row.row--wrap',
          chip(x.sentiment),
          h('span.chip', `${num(x.confidence_pct, 0)}% confidence`),
          h('span.chip', titleCase(x.impact_horizon)),
          ...(x.tickers || []).map((t) => h('span.chip.chip--brand', t))),
        prose(x.summary),
        x.catalysts?.length ? h('div', subhead('Catalysts'),
          h('ul', ...x.catalysts.map((c) => h('li', { style: { fontSize: 'var(--t-meta)', color: 'var(--ink-2)', padding: '3px 0 3px 14px', position: 'relative' } },
            h('span', { style: { position: 'absolute', left: '0', color: 'var(--brand-fg)' } }, '▸'), c)))) : null,
        h('div', subhead('Classifier'), fields([
          { label: 'Bull/bear score', value: num(x.bull_bear_score, 2), tone: x.bull_bear_score > 0 ? 'up' : 'down' },
          { label: 'Evaluated by', value: x.evaluated_by },
        ]), x.agent_thesis ? prose(x.agent_thesis) : null))],
    });
  }

  /* ------------------------------------------------------------- alpha */
  const alphaSeg = segmented(
    [{ value: 'insider', label: 'INSIDERS' }, { value: 'clusters', label: 'CLUSTERS' }, { value: 'whales', label: '13F WHALES' }],
    st.alphaView, (v) => { st.alphaView = v; ctx.savePrefs({ alphaView: v }); drawAlpha(); }, { label: 'Signal set' });
  pAlpha.tools.prepend(alphaSeg);

  function drawAlpha() {
    if (st.alphaView === 'whales') {
      const rows = whales.consensus_overweights || [];
      if (!rows.length) { pAlpha.empty('No 13F consensus data available.'); return; }
      pAlpha.render(
        h('div.tbar', h('span.chip.chip--brand', whales.as_of_quarter || ''), h('span.tbar__count', `${whales.whales_tracked_count} funds tracked`)),
        h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } },
          h('table.tbl',
            h('thead', h('tr', h('th', 'Ticker'), h('th.num', 'Total value'), h('th.num', 'Funds'))),
            h('tbody', ...rows.map((r) => h('tr',
              h('td.strong', r.ticker),
              h('td.num', money((r.total_value_m || 0) * 1e6)),
              h('td.num', int(r.funds_count))))))));
      pAlpha.setMeta('consensus overweights');
      return;
    }

    if (st.alphaView === 'clusters') {
      const rows = insider.cluster_buy_signals || [];
      if (!rows.length) { pAlpha.empty('No cluster-buy signals in the current filing window.'); return; }
      pAlpha.render(
        h('div.tbar', h('span.tbar__count', `${rows.length} clustered purchases`)),
        h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } },
          h('div.cards', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' } },
            ...rows.map((r) => h('div.card',
              h('div.card__k', `${titleCase(r.cluster_tag)} · ${date(r.filing_date)}`),
              h('div.card__t', `${r.ticker} — ${money(r.value_dollar)}`),
              h('div.card__b', `${r.insider_name}, ${r.insider_title}`),
              h('div.row', { style: { marginTop: '7px' } },
                h('span.chip.chip--up', titleCase(r.conviction_rating)),
                h('span.chip', `@ $${num(r.price, 2)}`)))))));
      pAlpha.setMeta(`as of ${date(insider.as_of_date)}`);
      return;
    }

    const rows = insider.recent_transactions || [];
    if (!rows.length) { pAlpha.empty('No Form 4 transactions in the audited window.'); return; }
    const s = insider.summary || {};
    pAlpha.render(
      h('div.tbar',
        chip(s.sentiment_label, s.sentiment_score >= 60 ? 'up' : s.sentiment_score <= 40 ? 'down' : 'flat'),
        h('span.chip.chip--up', `buys ${money(s.opportunistic_buy_dollars)}`),
        h('span.chip.chip--flat', `10b5-1 sells ${money(s.routine_10b5_1_sell_dollars)}`),
        h('div.grow'),
        h('span.tbar__count', `${int(s.total_filings_audited)} filings · top ${s.top_accumulated_ticker || DASH}`)),
      h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } },
        h('table.tbl',
          h('thead', h('tr',
            h('th', 'Filed'), h('th', 'Ticker'), h('th', 'Insider'), h('th', 'Type'),
            h('th.num', 'Price'), h('th.num', 'Qty'), h('th.num', 'Value'), h('th.num', 'Δ holding'), h('th', 'Conviction'))),
          h('tbody', ...rows.map((r) => h('tr',
            h('td', date(r.filing_date)),
            h('td.strong', { title: r.company_name }, r.ticker),
            h('td', { title: r.insider_title }, r.insider_name),
            h('td', chip(r.trade_type?.startsWith('P') ? 'purchase' : 'sale', r.trade_type?.startsWith('P') ? 'up' : 'down')),
            h('td.num', '$' + num(r.price, 2)),
            h('td.num', int(r.qty)),
            h('td.num', money(r.value_dollar)),
            h('td.num', { class: r.pct_change_holdings > 0 ? 'up' : 'down' }, isNum(r.pct_change_holdings) ? `${r.pct_change_holdings > 0 ? '+' : ''}${num(r.pct_change_holdings, 2)}%` : DASH),
            h('td', h('span.chip' + (r.is_10b5_1 ? '.chip--na' : '.chip--up'), r.is_10b5_1 ? 'scheduled 10b5-1' : titleCase(r.conviction_rating)))))))));
    pAlpha.setMeta(`Form 4 · as of ${date(insider.as_of_date)}`);
  }

  /* -------------------------------------------------------------- desk */
  const deskSeg = segmented(
    [{ value: 'console', label: 'CONSOLE' }, { value: 'reports', label: 'ARCHIVE' }],
    st.deskView, (v) => { st.deskView = v; ctx.savePrefs({ deskView: v }); drawDesk(); }, { label: 'Desk view' });
  pDesk.tools.prepend(deskSeg);

  const log = h('div.console');
  const logScroll = h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0', padding: 'var(--panel-pad)' } }, log);
  const input = h('textarea', {
    rows: 1, placeholder: 'Ask the desk…',
    'aria-label': 'Message the agent desk',
  });
  const sendBtn = h('button.btn', { type: 'button', onClick: send, title: 'Send (Enter)' }, icon('bolt', 12), 'Ask');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(108, input.scrollHeight) + 'px';
  });

  function drawDesk() {
    if (st.deskView === 'reports') {
      pDesk.render(
        h('div.tbar',
          h('button.btn', { type: 'button', onClick: newWrap, title: 'Generate a fresh end-of-day wrap' }, icon('bolt', 12), 'New EOD wrap'),
          h('div.grow'),
          h('span.tbar__count', `${wraps.length} archived`)),
        h('div.scroll', { style: { position: 'relative', flex: '1 1 auto', minHeight: '0' } },
          h('div', ...wraps.map((w) => h('button.wire__i', {
            type: 'button', style: { gridTemplateColumns: '1fr auto' }, onClick: () => openWrap(w),
          },
            h('span.wire__h', w.title || titleCase(w.wrap_type)),
            h('span', chip(w.session_verdict)),
            h('span.wire__m',
              h('span', date(w.session_date)),
              h('span', '·'), h('span', `${w.total_wires} wires`),
              h('span', '·'), h('span', `${w.confidence_pct}% confidence`),
              h('span', '·'), h('span', w.model_used === 'deterministic_eod_engine' ? 'synthesised' : w.model_used)))))));
      pDesk.setMeta('end-of-day wraps');
      return;
    }

    pDesk.render(
      h('div.tbar',
        ...REPORT_TYPES.slice(0, 2).map((r) => h('button.btn.btn--ghost', { type: 'button', onClick: () => runReport(r) }, r.label.split(' ')[0])),
        h('div.grow'),
        h('button.btn.btn--ghost.btn--icon', { type: 'button', title: 'Clear the console', onClick: () => { st.messages = []; paintLog(); } }, icon('close', 12))),
      logScroll,
      h('div.composer', input, sendBtn));
    pDesk.setMeta(status.api_bound ? 'live model' : 'deterministic engine');
    paintLog();
  }

  function paintLog() {
    if (!st.messages.length) {
      fill(log, h('div.stack',
        h('div.meta', 'Ask the desk a question, or run one of the standing reports.'),
        h('div.row.row--wrap', ...REPORT_TYPES.map((r) =>
          h('button.btn', { type: 'button', onClick: () => runReport(r) }, r.label))),
        status.api_bound ? null : note(h('strong', 'Deterministic mode. '),
          'No model key is configured. Answers are composed from the observed tables — the regime classifier, the option chain, the audit record — rather than generated by a language model.')));
      return;
    }
    fill(log, ...st.messages.map((m) => h('div.msg' + (m.role === 'me' ? '.msg--me' : ''),
      h('div.msg__b',
        h('div.msg__k', m.role === 'me' ? 'you' : (m.title || 'desk')),
        m.role === 'me' ? h('div', m.text) : markdown(m.text),
        m.role !== 'me' && m.meta ? h('div.meta', { style: { marginTop: '8px', paddingTop: '6px', borderTop: '1px solid var(--line)' } }, m.meta) : null))));
    logScroll.scrollTop = logScroll.scrollHeight;
  }

  async function send() {
    const q = input.value.trim();
    if (!q || st.busy) return;
    input.value = '';
    input.style.height = 'auto';
    st.messages.push({ role: 'me', text: q });
    st.messages.push({ role: 'desk', text: '_Working…_', pending: true });
    st.busy = true;
    sendBtn.disabled = true;
    paintLog();
    try {
      const res = await post('/api/agents/chat', { report_type: 'chat_query', user_query: q });
      st.messages.pop();
      st.messages.push({
        role: 'desk', title: res.report_title, text: res.content || 'No content returned.',
        meta: `${res.mode === 'deterministic_quantitative_engine' ? 'Synthesised from observed tables' : res.model} · ${date(res.generated_at)} ${time(res.generated_at)}`,
      });
    } catch (err) {
      st.messages.pop();
      st.messages.push({ role: 'desk', title: 'error', text: `The desk could not answer: ${err.message}` });
      ctx.toast('Agent request failed', 'err');
    } finally {
      st.busy = false;
      sendBtn.disabled = false;
      paintLog();
    }
  }

  async function runReport(r) {
    if (st.busy) return;
    st.busy = true;
    const kill = ctx.toast(`Generating ${r.label.toLowerCase()}…`, 'info', 60000);
    try {
      const res = await post('/api/agents/generate-report', { report_type: r.id });
      kill();
      ctx.drawer.show({
        title: res.report_title || r.label,
        sub: `${res.mode === 'deterministic_quantitative_engine' ? 'Synthesised from observed tables' : res.model} · ${date(res.generated_at)} ${time(res.generated_at)}`,
        content: [h('div.report', markdown(res.content || ''))],
        actions: [h('button.btn', { type: 'button', onClick: () => copy(res.content) }, icon('book', 12), 'Copy markdown')],
      });
    } catch (err) {
      kill();
      ctx.toast(`Report failed: ${err.message}`, 'err', 5000);
    } finally { st.busy = false; }
  }

  async function newWrap() {
    const kill = ctx.toast('Building end-of-day wrap…', 'info', 60000);
    try {
      const res = await post('/api/news/eod-wrap');
      kill();
      wraps = await get('/api/news/market-wraps', null, { force: true });
      drawDesk();
      ctx.toast(`Wrap complete — ${res.session_verdict}`, 'ok');
    } catch (err) {
      kill();
      ctx.toast(`Wrap failed: ${err.message}`, 'err', 5000);
    }
  }

  async function openWrap(w) {
    let full = w;
    if (!w.report_markdown) {
      try { full = await get(`/api/news/market-wraps/${w.id}`); } catch { /* fall back to the list row */ }
    }
    ctx.drawer.show({
      title: full.title || 'Market wrap',
      sub: `${date(full.session_date, 'long')} · ${full.total_wires} wires · ${full.confidence_pct}% confidence`,
      content: [h('div.stack',
        h('div.row.row--wrap',
          chip(full.session_verdict),
          h('span.chip.chip--up', `${full.bull_pct}% bull`),
          h('span.chip.chip--down', `${full.bear_pct}% bear`),
          h('span.chip.chip--info', titleCase(full.velocity)),
          h('span.chip', full.model_used === 'deterministic_eod_engine' ? 'synthesised' : full.model_used)),
        h('div.report', markdown(full.report_markdown || '')))],
      actions: [h('button.btn', { type: 'button', onClick: () => copy(full.report_markdown) }, icon('book', 12), 'Copy markdown')],
    });
  }

  function copy(text) {
    navigator.clipboard?.writeText(text || '').then(
      () => ctx.toast('Copied to clipboard', 'ok', 1500),
      () => ctx.toast('Clipboard unavailable', 'err'));
  }

  /* ---------------------------------------------------------- commands */
  ctx.commands(() => [
    ...REPORT_TYPES.map((r) => ({ id: 'rep:' + r.id, group: 'Reports', icon: 'cpu', title: `Generate: ${r.label}`, run: () => runReport(r) })),
    { id: 'a:wrap', group: 'Reports', icon: 'bolt', title: 'Generate a fresh end-of-day wrap', run: newWrap },
    { id: 'a:console', group: 'AI desk', icon: 'cpu', title: 'Open the agent console', run: () => { deskSeg.setValue('console'); st.deskView = 'console'; drawDesk(); input.focus(); } },
    { id: 'a:archive', group: 'AI desk', icon: 'book', title: 'Open the report archive', run: () => { deskSeg.setValue('reports'); st.deskView = 'reports'; drawDesk(); } },
    ...wraps.slice(0, 10).map((w) => ({ id: 'wrap:' + w.id, group: 'Archive', icon: 'book', title: `${w.title || 'Wrap'} — ${date(w.session_date)}`, hint: w.session_verdict, run: () => openWrap(w) })),
  ]);
  ctx.bind('a', () => { deskSeg.setValue('console'); st.deskView = 'console'; drawDesk(); input.focus(); }, { label: 'Focus the agent console' });
  ctx.bind('mod+f', () => wireSearch.focusInput(), { label: 'Filter the wire' });

  drawRail(); drawWire(); drawAlpha(); drawDesk();
  return { destroy() {} };
}
