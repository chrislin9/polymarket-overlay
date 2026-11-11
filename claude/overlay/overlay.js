import { parseMarketInput, venueInfo } from '../lib/url.js';
import { resolveMarket, fetchBook, fetchHistory, INTERVALS } from '../lib/api.js';
import { BookFeed } from '../lib/book.js';
import { resolveUsMarket, fetchUsHistory, UsFeed } from '../lib/us.js';
import { LineChart } from '../lib/chart.js';
import { el, fmtCents, fmtChance, fmtPct1, fmtUsdCompact, fmtShares, fmtUsd, fmtDate } from '../lib/format.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'window' ? 'window' : 'frame';
const INPUT = params.get('url') || '';
document.documentElement.dataset.mode = MODE;

const SERIES_COLORS = ['#2D7FF9', '#F59E0B', '#A66BFF', '#EC4899'];
const MAX_CHART_SERIES = 4;
const INITIAL_LEGS = 12;
const MORE_LEGS = 20;
const MAX_LEVELS = 50; // rendered per side (the list scrolls)
const DEPTH_WINDOW = 12; // levels near the spread used to scale depth bars
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

const app = document.getElementById('app');

// Per-exchange data sources. Both feeds expose the same interface
// (get/has/add/start/stop/ensure + onUpdate/onStatus callbacks).
const ADAPTERS = {
  intl: {
    resolve: (parsed) => resolveMarket(parsed),
    createFeed: (tokens, opts) => new BookFeed(tokens, { ...opts, fetchSnapshot: (t) => fetchBook(t) }),
    history: (leg, idx, interval, startDate) => fetchHistory(leg.tokens[idx], interval, startDate),
    feedLabel: 'Live data from the Polymarket CLOB',
  },
  us: {
    resolve: (parsed) => resolveUsMarket(parsed),
    createFeed: (tokens, opts) => new UsFeed(tokens, opts),
    history: (leg, idx, interval) => fetchUsHistory(leg.slug, idx, interval),
    feedLabel: 'Live data from Polymarket US',
  },
};
let adapter = ADAPTERS.intl;
let venue = 'intl';

const state = {
  event: null,
  legs: [],
  tokenIndex: new Map(), // tokenId -> {leg, idx}
  feed: null,
  chart: null,
  chartSeries: [], // [{id, name, color, leg, idx, points, live}]
  interval: '1w',
  historySeq: 0,
  visibleLegs: INITIAL_LEGS,
  ui: {},
};

// ---------------------------------------------------------------- settings

const storage = globalThis.chrome && chrome.storage ? chrome.storage.local : null;

function applyAlpha(a) {
  const alpha = MODE === 'window' ? 1 : Math.min(1, Math.max(0, Number(a)));
  document.documentElement.style.setProperty('--bg-a', String(alpha));
  document.documentElement.classList.toggle('see-through', alpha < 0.55);
}

async function loadSettings() {
  const defaults = { bgAlpha: 0.88, chartInterval: '1w', chartHidden: false };
  const s = storage ? await storage.get(defaults) : defaults;
  applyAlpha(s.bgAlpha);
  state.interval = INTERVALS.some((i) => i.key === s.chartInterval) ? s.chartInterval : '1w';
  state.chartHidden = !!s.chartHidden;
  if (storage) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.bgAlpha) applyAlpha(changes.bgAlpha.newValue);
    });
  }
}

function save(obj) {
  if (storage) storage.set(obj).catch(() => {});
}

// ---------------------------------------------------------------- pricing

function bookFor(leg, idx) {
  return state.feed ? state.feed.get(leg.tokens[idx]) : null;
}

/** Displayed probability for outcome idx, following Polymarket's rule:
 *  midpoint when the spread is <= 10¢, otherwise the last traded price. */
function outcomePrice(leg, idx) {
  const g = leg.gamma;
  const flip = (p) => (p == null ? null : idx === 0 ? p : 1 - p);
  const book = bookFor(leg, idx);
  if (book && book.ready) {
    const bb = book.bestBid();
    const ba = book.bestAsk();
    if (bb != null && ba != null && ba - bb <= 0.1 + 1e-9) return (bb + ba) / 2;
    if (book.lastTrade) return book.lastTrade.price;
    if (g.last != null) return flip(g.last);
    if (bb != null && ba != null) return (bb + ba) / 2;
  }
  if (g.bestBid != null && g.bestAsk != null && g.bestAsk - g.bestBid <= 0.1 + 1e-9) {
    return flip((g.bestBid + g.bestAsk) / 2);
  }
  if (g.last != null) return flip(g.last);
  return g.prices[idx] ?? null;
}

function bestAsk(leg, idx) {
  const book = bookFor(leg, idx);
  if (book && book.ready) return book.bestAsk();
  const g = leg.gamma;
  if (idx === 0) return g.bestAsk;
  return g.bestBid != null ? 1 - g.bestBid : null;
}

function lastTradePrice(leg, idx) {
  const book = bookFor(leg, idx);
  if (book && book.lastTrade) return book.lastTrade.price;
  const g = leg.gamma.last;
  return g == null ? null : idx === 0 ? g : 1 - g;
}

// ---------------------------------------------------------------- boot

async function boot() {
  await loadSettings();
  const parsed = parseMarketInput(INPUT);
  if (!parsed) {
    showError('That doesn’t look like a Polymarket market URL.', false);
    return;
  }
  try {
    venue = parsed.venue === 'us' ? 'us' : 'intl';
    adapter = ADAPTERS[venue];
    let result;
    try {
      result = await adapter.resolve(parsed);
    } catch (err) {
      // A bare slug could belong to either exchange: fall back to Polymarket US.
      if (!parsed.bareSlug) throw err;
      venue = 'us';
      adapter = ADAPTERS.us;
      parsed.href = `${venueInfo('us').base}/event/${parsed.eventSlug}`;
      result = await adapter.resolve(parsed);
    }
    setup(result.event, result.focusMarketId, parsed.href);
  } catch (err) {
    console.error('[pm-overlay]', err);
    showError(err && err.message ? err.message : String(err), true);
  }
}

function showError(message, retry) {
  app.replaceChildren(
    el('div', { class: 'state-card error' },
      el('div', { class: 'err-title', text: 'Couldn’t load market' }),
      el('div', { class: 'err-msg', text: message }),
      retry && el('button', { class: 'btn', text: 'Retry', onclick: () => location.reload() }),
    ),
  );
}

function setup(event, focusMarketId, href) {
  state.event = event;

  let legs = event.markets.filter((m) => m.active && !m.closed);
  const resolved = legs.length === 0;
  if (resolved) legs = event.markets.slice();
  if (legs.length > 1 && (event.negRisk || event.sortBy === 'price')) {
    legs.sort((a, b) => (outcomePrice(b, 0) ?? 0) - (outcomePrice(a, 0) ?? 0));
  }
  state.legs = legs.map((m) => ({ ...m, resolved: m.closed, view: null }));
  for (const leg of state.legs) leg.tokens.forEach((t, idx) => state.tokenIndex.set(t, { leg, idx }));

  const single = state.legs.length === 1;
  state.single = single;
  const vinfo = venueInfo(venue);
  const eventUrl = `${vinfo.base}/event/${event.slug}`;
  app.dataset.venue = venue;

  document.title = event.title;
  try {
    window.parent.postMessage({ source: 'pm-overlay', type: 'title', title: event.title }, '*');
  } catch {}

  // ---- header
  const status = el('span', { class: 'status connecting', title: 'Order book feed status' }, el('i'), el('span', { text: 'Connecting' }));
  const chartToggle = el('button', {
    class: 'icon-btn',
    title: 'Show/hide chart',
    onclick: () => {
      state.chartHidden = !state.chartHidden;
      save({ chartHidden: state.chartHidden });
      app.classList.toggle('chart-hidden', state.chartHidden);
    },
  }, chartIcon());
  const header = el('header', { class: 'ev-head' },
    event.image && el('img', { class: 'ev-img', src: event.image, alt: '', onerror: hideImg }),
    el('div', { class: 'ev-text' },
      el('a', { class: 'ev-title', href: href || eventUrl, target: '_blank', rel: 'noopener', text: event.title, title: `Open on ${vinfo.label}` }),
      el('div', { class: 'ev-meta' },
        venue === 'us' && el('span', { class: 'venue-badge', text: 'US', title: 'Polymarket US (polymarket.us)' }),
        event.volume > 0 && el('span', { text: `${fmtUsdCompact(event.volume)} Vol.` }),
        event.endDate && el('span', { class: 'dot-sep', text: resolved ? 'Resolved' : `Ends ${fmtDate(event.endDate)}` }),
        status,
      ),
    ),
    chartToggle,
  );

  // ---- chart section
  const chartTop = el('div', { class: 'chart-top' });
  const chartBox = el('div', { class: 'chart-box' });
  const ranges = el('div', { class: 'ranges' },
    INTERVALS.map((iv) =>
      el('button', {
        class: `range${iv.key === state.interval ? ' active' : ''}`,
        'data-key': iv.key,
        text: iv.label,
        onclick: () => setInterval_(iv.key),
      }),
    ),
  );
  const chartSection = el('section', { class: 'chart-section' }, chartTop, chartBox, ranges);

  // ---- legs
  const legsHead = el('div', { class: 'legs-head' },
    el('span', { text: single ? '' : 'Outcome' }),
    !single && el('span', { class: 'lh-chance', text: '% Chance' }),
  );
  const legsList = el('div', { class: 'legs' });
  const moreBtn = el('button', { class: 'more-btn', onclick: () => { state.visibleLegs += MORE_LEGS; renderLegList(); } });
  const footer = el('footer', { class: 'foot' },
    el('a', { href: eventUrl, target: '_blank', rel: 'noopener', text: `Open on ${vinfo.label} ↗` }),
    el('span', { text: adapter.feedLabel }),
  );

  app.replaceChildren(header, chartSection, legsHead, legsList, moreBtn, footer);
  app.classList.toggle('single', single);
  app.classList.toggle('chart-hidden', state.chartHidden);
  state.ui = { status, chartTop, legsList, moreBtn };

  // ---- chart series
  if (single) {
    const leg = state.legs[0];
    const isYesNo = /^yes$/i.test(leg.outcomes[0]) && /^no$/i.test(leg.outcomes[1]);
    const idxs = isYesNo ? [0] : [0, 1];
    state.chartSeries = idxs.map((idx, i) => ({
      id: leg.tokens[idx],
      name: leg.outcomes[idx],
      color: SERIES_COLORS[i],
      leg,
      idx,
      points: [],
      live: null,
    }));
  } else {
    state.chartSeries = state.legs
      .filter((l) => !l.resolved)
      .slice(0, MAX_CHART_SERIES)
      .map((leg, i) => ({ id: leg.tokens[0], name: leg.title, color: SERIES_COLORS[i], leg, idx: 0, points: [], live: null }));
  }
  state.chart = new LineChart(chartBox);
  renderChartTop();
  loadHistory();
  setInterval(() => loadHistory(), HISTORY_REFRESH_MS);
  // Keep the live point creeping forward even when the price is quiet.
  setInterval(() => updateLivePoints(null), 15000);

  // ---- legs + feed
  const focus = focusMarketId ? state.legs.find((l) => l.id === focusMarketId) : null;
  if (focus) state.visibleLegs = Math.max(state.visibleLegs, state.legs.indexOf(focus) + 1);
  renderLegList();
  if (single) toggleLeg(state.legs[0], 0, true);
  else if (focus) {
    toggleLeg(focus, 0, true);
    requestAnimationFrame(() => focus.view.root.scrollIntoView({ block: 'center' }));
  }

  // Subscribe only to legs that are on screen (plus charted ones); "Show more"
  // subscribes the rest incrementally. Sports events can have 500+ markets.
  if (state.legs.some((l) => !l.resolved)) {
    state.feed = adapter.createFeed(subscribableTokens(), {
      onUpdate: onBooksUpdated,
      onStatus: setStatus,
      onTrade: onTrade,
    });
    state.feed.start();
    for (const leg of state.legs) if (leg.view) updateLegRow(leg);
    // Expanded legs whose WS snapshot hasn't arrived get a REST snapshot.
    setTimeout(() => {
      for (const leg of state.legs) if (leg.view && leg.view.expanded) leg.tokens.forEach((t) => state.feed.ensure(t));
    }, 3000);
  } else {
    setStatus('closed');
  }
}

function subscribableTokens() {
  const legs = new Set(state.legs.slice(0, state.visibleLegs));
  for (const s of state.chartSeries) legs.add(s.leg);
  return [...legs].filter((l) => !l.resolved).flatMap((l) => l.tokens);
}

function setStatus(s) {
  const labels = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', offline: 'Offline', closed: 'Closed' };
  const node = state.ui.status;
  if (!node) return;
  node.className = `status ${s}`;
  node.lastChild.textContent = labels[s] || s;
}

// ---------------------------------------------------------------- chart

function setInterval_(key) {
  if (key === state.interval) return;
  state.interval = key;
  save({ chartInterval: key });
  for (const b of document.querySelectorAll('.range')) b.classList.toggle('active', b.dataset.key === key);
  for (const s of state.chartSeries) s.points = [];
  loadHistory();
}

async function loadHistory(attempt = 0) {
  const seq = ++state.historySeq;
  const series = state.chartSeries;
  if (!series.length) {
    state.chart.setStatus({ message: 'No active outcomes' });
    return;
  }
  if (!series.some((s) => s.points.length)) state.chart.setStatus({ loading: true });
  const start = state.event.startDate;
  const results = await Promise.allSettled(series.map((s) => adapter.history(s.leg, s.idx, state.interval, s.leg.startDate || start)));
  if (seq !== state.historySeq) return;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') series[i].points = r.value;
  });
  const failed = results.every((r) => r.status === 'rejected');
  if (results.some((r) => r.status === 'rejected') && attempt < 3) {
    setTimeout(() => {
      if (seq === state.historySeq) loadHistory(attempt + 1);
    }, 2000 * (attempt + 1));
  }
  updateLivePoints(null, false);
  state.chart.setStatus({ message: failed ? 'Chart unavailable' : '' });
  state.chart.setSeries(series);
  renderChartTop();
}

function updateLivePoints(tokens, redraw = true) {
  let changed = false;
  const now = Date.now();
  for (const s of state.chartSeries) {
    if (tokens && !tokens.has(s.id)) continue;
    const p = outcomePrice(s.leg, s.idx);
    if (p == null) continue;
    // Book churn that doesn't move the displayed price shouldn't redraw the chart.
    if (tokens && s.live && s.live.p === p) continue;
    s.live = { t: now, p };
    changed = true;
  }
  if (changed && redraw) {
    state.chart.setSeries(state.chartSeries);
    renderChartTop();
  }
}

function renderChartTop() {
  const top = state.ui.chartTop;
  if (!top) return;
  const series = state.chartSeries;
  const key = [state.interval, ...series.map((s) => `${s.name}:${s.live ? s.live.p : ''}:${s.points.length ? s.points[0].p : ''}`)].join('|');
  if (key === state.chartTopKey) return;
  state.chartTopKey = key;
  if (state.single && series.length === 1) {
    const s = series[0];
    const cur = s.live ? s.live.p : outcomePrice(s.leg, s.idx);
    const first = s.points[0] ? s.points[0].p : null;
    const delta = cur != null && first != null ? cur - first : null;
    const ivLabel = (INTERVALS.find((i) => i.key === state.interval) || {}).label;
    top.replaceChildren(
      el('div', { class: 'big-chance', style: { color: s.color } },
        el('span', { class: 'big-num', text: fmtChance(cur) }),
        el('span', { class: 'big-label', text: /^yes$/i.test(s.name) ? 'chance' : s.name }),
        delta != null && Math.abs(delta) >= 0.0005 &&
          el('span', { class: `delta ${delta > 0 ? 'up' : 'down'}`, text: `${delta > 0 ? '▲' : '▼'} ${fmtPct1(Math.abs(delta))} ${ivLabel}` }),
      ),
    );
    return;
  }
  top.replaceChildren(
    el('div', { class: 'legend' },
      series.map((s) => {
        const cur = s.live ? s.live.p : outcomePrice(s.leg, s.idx);
        return el('span', { class: 'lg-item' },
          el('i', { style: { background: s.color } }),
          el('span', { class: 'lg-name', text: s.name }),
          el('b', { text: fmtPct1(cur) }),
        );
      }),
    ),
  );
}

// ---------------------------------------------------------------- legs

function renderLegList() {
  const { legsList, moreBtn } = state.ui;
  const visible = state.legs.slice(0, state.visibleLegs);
  if (state.feed) state.feed.add(subscribableTokens());
  for (const leg of visible) {
    if (!leg.view) leg.view = buildLeg(leg);
    if (leg.view.root.parentNode !== legsList) legsList.append(leg.view.root);
    updateLegRow(leg);
  }
  const hidden = state.legs.length - visible.length;
  moreBtn.hidden = hidden <= 0;
  moreBtn.textContent = `Show ${Math.min(hidden, MORE_LEGS)} more${hidden > MORE_LEGS ? ` (of ${hidden})` : ''}`;
}

function buildLeg(leg) {
  const [o0, o1] = leg.outcomes;
  const pct = el('span', { class: 'pct' });
  const chg = el('span', { class: 'chg' });
  const yesPx = el('b');
  const noPx = el('b');
  const yesBtn = el('button', { class: 'buy yes', title: `Show ${o0} order book` }, el('span', { class: 'buy-label' }, el('span', { class: 'buy-verb', text: 'Buy ' }), o0), yesPx);
  const noBtn = el('button', { class: 'buy no', title: `Show ${o1} order book` }, el('span', { class: 'buy-label' }, el('span', { class: 'buy-verb', text: 'Buy ' }), o1), noPx);
  const chev = el('span', { class: 'chev', 'aria-hidden': 'true' });
  const row = el('div', { class: 'leg-row', role: 'button', tabindex: '0', 'aria-expanded': 'false' },
    leg.image && !state.single ? el('img', { class: 'leg-img', src: leg.image, alt: '', loading: 'lazy', onerror: hideImg }) : el('span', { class: 'leg-img-pad' }),
    el('div', { class: 'leg-name' },
      el('div', { class: 'leg-title', text: state.single ? 'Order Book' : leg.title, title: leg.question }),
      !state.single && el('div', { class: 'leg-vol', text: [leg.volume != null && `${fmtUsdCompact(leg.volume)} Vol.`, leg.resolved && 'Resolved'].filter(Boolean).join(' · ') }),
    ),
    el('div', { class: 'leg-chance' }, pct, chg),
    el('div', { class: 'leg-btns' }, yesBtn, noBtn),
    chev,
  );
  const body = el('div', { class: 'leg-body', hidden: true });
  const root = el('div', { class: 'leg' }, row, body);

  const onRow = (e) => {
    if (e.target.closest('.buy')) return;
    toggleLeg(leg, leg.view.tab);
  };
  row.addEventListener('click', onRow);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleLeg(leg, leg.view.tab);
    }
  });
  yesBtn.addEventListener('click', () => openTab(leg, 0));
  noBtn.addEventListener('click', () => openTab(leg, 1));

  return { root, row, body, pct, chg, yesPx, noPx, expanded: false, tab: 0, book: null, lastPct: null };
}

function openTab(leg, idx) {
  const v = leg.view;
  if (v.expanded && v.tab === idx) toggleLeg(leg, idx, false);
  else toggleLeg(leg, idx, true);
}

function toggleLeg(leg, tab = 0, force) {
  const v = leg.view;
  if (!v) return;
  const expand = force ?? !v.expanded;
  v.expanded = expand;
  v.root.classList.toggle('open', expand);
  v.row.setAttribute('aria-expanded', String(expand));
  v.body.hidden = !expand;
  if (expand) {
    if (!v.book) v.book = buildBook(leg);
    setTab(leg, tab);
    if (state.feed) leg.tokens.forEach((t) => {
      const b = state.feed.get(t);
      if (b && !b.ready) setTimeout(() => state.feed.ensure(t), 2500);
    });
  }
}

function updateLegRow(leg) {
  const v = leg.view;
  if (!v) return;
  const p = outcomePrice(leg, 0);
  const pctText = leg.resolved ? resolvedLabel(leg) : fmtChance(p);
  if (v.pct.textContent !== pctText) {
    if (v.lastPct != null && p != null && Math.round(p * 100) !== Math.round(v.lastPct * 100)) {
      flash(v.pct, p > v.lastPct ? 'up' : 'down');
    }
    v.pct.textContent = pctText;
  }
  if (p != null) v.lastPct = p;
  const dc = leg.gamma.dayChange;
  if (!leg.resolved && dc != null && Math.abs(dc) >= 0.005) {
    v.chg.className = `chg ${dc > 0 ? 'up' : 'down'}`;
    setText(v.chg, `${dc > 0 ? '▲' : '▼'}${Math.round(Math.abs(dc) * 100)}`);
  } else {
    setText(v.chg, '');
  }
  setText(v.yesPx, leg.resolved ? '' : fmtCents(bestAsk(leg, 0)));
  setText(v.noPx, leg.resolved ? '' : fmtCents(bestAsk(leg, 1)));
}

function resolvedLabel(leg) {
  const [a, b] = leg.gamma.prices;
  if (a != null && a >= 0.99) return leg.outcomes[0];
  if (b != null && b >= 0.99) return leg.outcomes[1];
  return fmtChance(a);
}

// ---------------------------------------------------------------- order book

function buildBook(leg) {
  const tabs = leg.outcomes.map((o, idx) =>
    el('button', { class: `tab t${idx}`, text: `Trade ${o}`, onclick: (e) => { e.stopPropagation(); setTab(leg, idx); } }),
  );
  const lastTrade = el('span', { class: 'bk-last' });
  const asks = el('div', { class: 'side asks' });
  const bids = el('div', { class: 'side bids' });
  const spreadLast = el('span');
  const spreadVal = el('span');
  const empty = el('div', { class: 'bk-empty', text: 'Loading order book…' });
  const root = el('div', { class: 'book' },
    el('div', { class: 'bk-tabs' }, tabs, el('span', { class: 'bk-spacer' }), lastTrade),
    el('div', { class: 'bk-cols' }, el('span', { text: 'Price' }), el('span', { text: 'Shares' }), el('span', { text: 'Total' })),
    el('div', { class: 'bk-levels' },
      asks,
      el('div', { class: 'spread-row' }, spreadLast, spreadVal),
      bids,
      empty,
    ),
  );
  leg.view.body.append(root);
  return { root, tabs, asks, bids, spreadLast, spreadVal, lastTrade, empty, rows: { asks: new Map(), bids: new Map() }, primed: false, lastTradeTs: 0 };
}

function setTab(leg, idx) {
  const v = leg.view;
  v.tab = idx;
  const bk = v.book;
  bk.tabs.forEach((t, i) => t.classList.toggle('active', i === idx));
  bk.root.dataset.tab = String(idx);
  bk.asks.replaceChildren();
  bk.bids.replaceChildren();
  bk.rows.asks.clear();
  bk.rows.bids.clear();
  bk.primed = false;
  bk.lastTradeTs = 0;
  renderBook(leg);
  // Start the asks list scrolled to the spread.
  requestAnimationFrame(() => {
    bk.asks.scrollTop = bk.asks.scrollHeight;
    bk.bids.scrollTop = 0;
  });
}

function renderBook(leg) {
  const v = leg.view;
  const bk = v.book;
  if (!v.expanded || !bk) return;
  const idx = v.tab;
  const book = bookFor(leg, idx);

  if (leg.resolved || !book || !book.ready) {
    bk.empty.hidden = false;
    bk.empty.textContent = leg.resolved ? 'This market is resolved — no order book.' : 'Loading order book…';
    bk.root.classList.add('is-empty');
    const lt = lastTradePrice(leg, idx);
    bk.spreadLast.textContent = lt != null ? `Last: ${fmtCents(lt)}` : '';
    bk.spreadVal.textContent = '';
    return;
  }
  bk.empty.hidden = true;
  bk.root.classList.remove('is-empty');

  const asks = book.sortedAsks().slice(0, MAX_LEVELS);
  const bids = book.sortedBids().slice(0, MAX_LEVELS);
  const depthMax = Math.max(cumUsdAt(asks, DEPTH_WINDOW), cumUsdAt(bids, DEPTH_WINDOW), 1e-9);

  renderSide(bk, 'asks', asks, depthMax);
  renderSide(bk, 'bids', bids, depthMax);
  bk.primed = true;

  const ba = asks.length ? asks[0][0] : null;
  const bb = bids.length ? bids[0][0] : null;
  const lt = lastTradePrice(leg, idx);
  setText(bk.spreadLast, `Last: ${fmtCents(lt)}`);
  setText(bk.spreadVal, ba != null && bb != null ? `Spread: ${fmtCents(ba - bb)}` : '');

  const trade = book.lastTrade;
  if (trade && trade.ts && trade.ts !== bk.lastTradeTs) {
    bk.lastTradeTs = trade.ts;
    const side = String(trade.side || '').toUpperCase() === 'SELL' ? 'sell' : 'buy';
    bk.lastTrade.className = `bk-last ${side}`;
    bk.lastTrade.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${fmtShares(trade.size || 0)} @ ${fmtCents(trade.price)}`;
    flash(bk.lastTrade, side === 'buy' ? 'up' : 'down');
  }
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function cumUsdAt(levels, n) {
  let sum = 0;
  for (let i = 0; i < Math.min(n, levels.length); i++) sum += levels[i][0] * levels[i][1];
  return sum;
}

function renderSide(bk, side, levels, depthMax) {
  const container = bk[side];
  const rows = bk.rows[side];
  const seen = new Set();
  const ordered = [];
  let cumUsd = 0;
  for (let i = 0; i < levels.length; i++) {
    const [price, size] = levels[i];
    cumUsd += price * size;
    let r = rows.get(price);
    const isNew = !r;
    if (isNew) {
      r = makeLevelRow(side);
      rows.set(price, r);
      r.px.textContent = fmtCents(price);
    }
    if (bk.primed) {
      if (isNew) flash(r.flash, side === 'asks' ? 'down' : 'up');
      else if (r.size !== size) flash(r.flash, size > r.size ? 'up' : 'down');
    }
    if (r.size !== size) {
      r.size = size;
      r.sz.textContent = fmtShares(size);
    }
    setText(r.tot, fmtUsd(cumUsd));
    const w = `${Math.min(100, (cumUsd / depthMax) * 100).toFixed(1)}%`;
    if (r.barW !== w) {
      r.barW = w;
      r.bar.style.width = w;
    }
    if (r.best !== (i === 0)) {
      r.best = i === 0;
      r.el.classList.toggle('best', r.best);
    }
    seen.add(price);
    ordered.push(r.el);
  }
  for (const [price, r] of rows) {
    if (!seen.has(price)) {
      r.el.remove();
      rows.delete(price);
    }
  }
  // Reorder with minimal DOM moves so running flash animations survive.
  let ref = container.firstChild;
  for (const node of ordered) {
    if (node === ref) ref = ref.nextSibling;
    else container.insertBefore(node, ref);
  }
  if (!levels.length) {
    container.replaceChildren(el('div', { class: 'lvl none', text: side === 'asks' ? 'No asks' : 'No bids' }));
    rows.clear();
  } else {
    const none = container.querySelector('.none');
    if (none) none.remove();
  }
}

function makeLevelRow(side) {
  const bar = el('div', { class: 'bar' });
  const fl = el('div', { class: 'fl' });
  const px = el('span', { class: 'px' });
  const sz = el('span', { class: 'sz' });
  const tot = el('span', { class: 'tot' });
  const node = el('div', { class: `lvl ${side === 'asks' ? 'ask' : 'bid'}` }, bar, fl, px, sz, tot);
  return { el: node, bar, flash: fl, px, sz, tot, size: null };
}

const FLASH = {
  up: { bg: 'rgba(61, 180, 104, 0.38)', fg: '#4ade80' },
  down: { bg: 'rgba(229, 72, 77, 0.38)', fg: '#ff6b6b' },
};

function flash(node, dir) {
  const c = FLASH[dir] || FLASH.up;
  if (node.classList.contains('fl')) {
    node.animate({ opacity: [1, 0], backgroundColor: [c.bg, c.bg] }, { duration: 900, easing: 'ease-out' });
  } else {
    node.animate({ color: [c.fg, getComputedStyle(node).color] }, { duration: 1200, easing: 'ease-out' });
  }
}

// ---------------------------------------------------------------- live updates

function onBooksUpdated(tokens) {
  const legs = new Set();
  for (const t of tokens) {
    const ref = state.tokenIndex.get(t);
    if (ref) legs.add(ref.leg);
  }
  for (const leg of legs) {
    updateLegRow(leg);
    const v = leg.view;
    if (v && v.expanded && tokens.has(leg.tokens[v.tab])) renderBook(leg);
  }
  updateLivePoints(tokens);
}

// A trade on one outcome token implies the complementary price on the other.
function onTrade(tokenId, trade) {
  const ref = state.tokenIndex.get(tokenId);
  if (!ref || !state.feed) return;
  const sib = state.feed.get(ref.leg.tokens[1 - ref.idx]);
  if (!sib || (sib.lastTrade && sib.lastTrade.ts === trade.ts)) return;
  const side = trade.side ? (String(trade.side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY') : null;
  sib.lastTrade = { price: Math.round((1 - trade.price) * 1e6) / 1e6, side, size: trade.size, ts: trade.ts };
  sib.touch();
  state.feed.markDirty(sib.tokenId);
}

function hideImg(e) {
  e.target.style.visibility = 'hidden';
}

function chartIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', '14');
  s.setAttribute('height', '14');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M1.5 13.5h13M2.5 10.5l3.5-4 3 2.5 4.5-6');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}

boot();
