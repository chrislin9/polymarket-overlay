/* Polymarket Overlay UI.
   PMOverlay.create(container, opts) renders the whole widget inside
   `container` (a ShadowRoot when injected on a page, a plain div on the
   standalone page). opts: {standalone, frameEl, storage:{get,set}, onClose,
   initialUrl, cssText}. Returns {loadUrl, loadSample, destroy, root}. */
(function () {
  "use strict";
  var API = window.PMAPI;
  var Chart = window.PMChart;
  var Geom = window.PMGeom;

  /* ---------- formatting ---------- */
  function fmtMoney(v) {
    if (v == null || !isFinite(v)) return "—";
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + v.toFixed(0);
  }
  function fmtShares(v) {
    if (v == null || !isFinite(v)) return "—";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e4) return (v / 1e3).toFixed(1) + "K";
    return v.toLocaleString(undefined, { maximumFractionDigits: v < 100 ? 1 : 0 });
  }
  function fmtCents(p) {
    if (p == null || !isFinite(p)) return "—";
    var c = Math.round(p * 1000) / 10;
    return (Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1)) + "¢";
  }
  function fmtPct(p, dec) {
    if (p == null || !isFinite(p)) return "—";
    var v = p * 100;
    return v.toFixed(dec != null ? dec : (v >= 10 || v === 0 ? 0 : 1)) + "%";
  }
  function fmtDelta(d) {
    if (d == null || !isFinite(d)) return "";
    var v = d * 100;
    return (v > 0 ? "▲ " : v < 0 ? "▼ " : "") + Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1) + "%";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(root, sel) { return root.querySelector(sel); }

  var RANGES = ["1H", "6H", "1D", "1W", "1M", "ALL"];
  var TOP_N = 12;          // legs shown before "show all"
  var MAX_SUBS = 90;       // cap on live token subscriptions

  function create(container, opts) {
    opts = opts || {};
    var storage = opts.storage || { get: function () { return Promise.resolve({}); }, set: function () {} };

    if (opts.cssText) {
      var style = document.createElement("style");
      style.textContent = opts.cssText;
      container.appendChild(style);
    }
    var root = document.createElement("div");
    root.className = "pm-root" + (opts.standalone ? " pm-standalone" : "");
    root.innerHTML =
      '<div class="pm-bar">' +
        '<span class="pm-logo"><span class="pm-logo-mark">P</span>Polymarket</span>' +
        '<span class="pm-live"><span class="dot"></span><span class="pm-live-txt">Idle</span></span>' +
        '<span class="pm-bar-spacer"></span>' +
        '<button class="pm-icon-btn" data-act="glass" title="Extra transparency">◐</button>' +
        '<button class="pm-icon-btn" data-act="min" title="Minimize">–</button>' +
        '<button class="pm-icon-btn" data-act="close" title="Close overlay (Alt+P)">✕</button>' +
      "</div>" +
      '<form class="pm-loader"><input type="text" spellcheck="false" placeholder="Paste a polymarket.com or polymarket.us URL…">' +
        '<button class="pm-go" type="submit">Load</button></form>' +
      '<div class="pm-status"></div>' +
      '<div class="pm-body"></div>' +
      '<div class="pm-foot">' +
        '<label>Opacity <input type="range" min="25" max="100" value="88"></label>' +
        '<span class="pm-src">Gamma + CLOB · live via WebSocket</span>' +
      "</div>" +
      '<div class="pm-resize" title="Drag to resize">⤡</div>';
    container.appendChild(root);

    var el = {
      bar: root.querySelector(".pm-bar"),
      live: root.querySelector(".pm-live"),
      liveTxt: root.querySelector(".pm-live-txt"),
      form: root.querySelector(".pm-loader"),
      input: root.querySelector(".pm-loader input"),
      go: root.querySelector(".pm-go"),
      status: root.querySelector(".pm-status"),
      body: root.querySelector(".pm-body"),
      opacity: root.querySelector('.pm-foot input[type="range"]'),
      resize: root.querySelector(".pm-resize"),
      src: root.querySelector(".pm-src"),
    };

    /* ---------- state ---------- */
    var S = {
      url: null, ev: null, legs: [], sample: false,
      books: new Map(),        // tokenId -> {bids:Map, asks:Map, tick, last, ts}
      quotes: new Map(),       // tokenId -> {bid, ask, last}
      livePx: new Map(),       // tokenId -> display price (last trade or mid)
      legEls: new Map(),       // leg.key -> dom refs
      openLegs: new Set(),
      bookTokenIdx: new Map(), // leg.key -> 0|1
      depth: 8,
      range: "1D",
      chartLegKey: null,
      history: [], historyToken: null,
      showAll: false, filter: "",
      socket: null, socketLive: false,
      timers: [], rafBooks: new Set(), rafPending: false,
      destroyed: false, sampleTimer: null,
      chartHoverX: null,
      gen: 0, // bumped on every load; guards the async init below
    };

    function every(ms, fn) { var t = setInterval(fn, ms); S.timers.push(t); return t; }

    function setStatus(msg, isError) {
      el.status.textContent = msg || "";
      el.status.className = "pm-status" + (isError ? " error" : "");
    }
    function setLive(mode, txt) {
      el.live.className = "pm-live" + (mode === "live" ? " on" : mode === "reconnecting" ? " reconnecting" : "");
      el.liveTxt.textContent = txt;
      S.socketLive = mode === "live";
    }

    /* ---------- legs ---------- */
    function buildLegs(ev) {
      var legs = [];
      if (ev.markets.length === 1) {
        var m = ev.markets[0];
        m.outcomes.forEach(function (name, i) {
          if (!m.tokens[i]) return;
          legs.push({
            key: m.id + ":" + i, market: m, tokenIdx: i, fixedSide: true,
            label: name, sub: m.question,
          });
        });
      } else {
        ev.markets.forEach(function (m) {
          legs.push({
            key: m.id, market: m, tokenIdx: 0, fixedSide: false,
            label: m.label, sub: m.volume != null ? fmtMoney(m.volume) + " Vol." : "",
          });
        });
      }
      return legs;
    }

    function legToken(leg) {
      var idx = leg.fixedSide ? leg.tokenIdx : (S.bookTokenIdx.get(leg.key) || 0);
      return leg.market.tokens[idx];
    }

    /* Display price for a token: live last-trade/mid first, else Gamma price. */
    function tokenPrice(market, idx) {
      var tok = market.tokens[idx];
      if (tok && S.livePx.has(tok)) return S.livePx.get(tok);
      if (tok && S.quotes.has(tok)) {
        var q = S.quotes.get(tok);
        if (q.bid != null && q.ask != null) return (q.bid + q.ask) / 2;
      }
      return market.prices[idx] != null ? market.prices[idx] : null;
    }

    function visibleLegs() {
      var list = S.legs;
      if (S.filter) {
        var f = S.filter.toLowerCase();
        list = list.filter(function (l) { return l.label.toLowerCase().indexOf(f) !== -1; });
        return list;
      }
      return S.showAll ? list : list.slice(0, TOP_N);
    }

    /* ---------- main render ---------- */
    function renderEvent() {
      var ev = S.ev;
      S.legEls.clear();
      var srcUrl = ev.sourceUrl || (ev.slug
        ? (ev.source === "us" ? "https://polymarket.us/event/" : "https://polymarket.com/event/") + encodeURIComponent(ev.slug)
        : (ev.source === "us" ? "https://polymarket.us" : "https://polymarket.com"));
      var endTxt = ev.endDate ? new Date(ev.endDate).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : null;
      var html =
        '<div class="pm-head">' +
          (ev.image ? '<img src="' + esc(ev.image) + '" alt="" onerror="this.style.display=\'none\'">' : "") +
          "<div><div class=\"pm-title\"><a href=\"" + esc(srcUrl) + '" target="_blank" rel="noopener">' + esc(ev.title) + "</a>" +
          (S.sample ? ' <span class="pm-sample-tag">SAMPLE DATA</span>' : "") +
          (ev.source === "us" ? ' <span class="pm-us-tag">US</span>' : "") + "</div>" +
          '<div class="pm-meta">' +
            (ev.volume != null ? "<span>Vol <b>" + fmtMoney(ev.volume) + "</b></span>" : "") +
            (ev.liquidity != null ? "<span>Liquidity <b>" + fmtMoney(ev.liquidity) + "</b></span>" : "") +
            (endTxt ? "<span>Ends <b>" + endTxt + "</b></span>" : "") +
            (ev.closed ? "<span><b>Closed</b></span>" : "") +
          "</div></div></div>" +
        '<div class="pm-chart-wrap">' +
          '<div class="pm-chart-head"><span class="pm-chart-name"></span>' +
          '<span class="pm-chart-price"></span><span class="pm-delta"></span>' +
          '<span class="pm-chart-hover"></span></div>' +
          '<canvas class="pm-chart"></canvas>' +
          '<div class="pm-ranges">' + RANGES.map(function (r) {
            return '<button class="pm-range' + (r === S.range ? " active" : "") + '" data-range="' + r + '">' + r + "</button>";
          }).join("") + "</div>" +
        "</div>" +
        '<div class="pm-legs-head"><h3>Order book · click a leg to expand</h3>' +
          (S.legs.length > 8 ? '<input class="pm-search" type="text" placeholder="Filter legs…">' : "") +
        "</div>" +
        '<div class="pm-cols"><span>Outcome</span><span class="r">Chance</span><span class="r">' +
          (S.legs.length && S.legs[0].fixedSide ? "Price" : esc((S.legs[0] && S.legs[0].market.outcomes[0]) || "Yes") + " / " + esc((S.legs[0] && S.legs[0].market.outcomes[1]) || "No")) +
          '</span><span></span></div>' +
        '<div class="pm-legs"></div>' +
        (S.legs.length > TOP_N ? '<button class="pm-showall"></button>' : "");
      el.body.innerHTML = html;

      el.body.querySelectorAll(".pm-range").forEach(function (b) {
        b.addEventListener("click", function () {
          S.range = b.dataset.range;
          el.body.querySelectorAll(".pm-range").forEach(function (x) { x.classList.toggle("active", x === b); });
          storage.set({ pmRange: S.range });
          loadHistory();
        });
      });
      var search = el.body.querySelector(".pm-search");
      if (search) search.addEventListener("input", function () { S.filter = search.value.trim(); renderLegs(); });
      var showAllBtn = el.body.querySelector(".pm-showall");
      if (showAllBtn) showAllBtn.addEventListener("click", function () { S.showAll = !S.showAll; renderLegs(); subscribeVisible(); });
      wireChartHover();
      renderLegs();
      updateShowAllBtn();
    }

    function updateShowAllBtn() {
      var b = el.body.querySelector(".pm-showall");
      if (!b) return;
      b.textContent = S.showAll ? "Show fewer outcomes" : "Show all " + S.legs.length + " outcomes";
      b.style.display = S.filter ? "none" : "";
    }

    function renderLegs() {
      var wrap = el.body.querySelector(".pm-legs");
      if (!wrap) return;
      wrap.innerHTML = "";
      S.legEls.clear();
      visibleLegs().forEach(function (leg) { wrap.appendChild(buildLegEl(leg)); });
      S.openLegs.forEach(function (key) {
        var refs = S.legEls.get(key);
        if (refs) { refs.legEl.classList.add("open"); mountBook(refs.leg); }
      });
      updateShowAllBtn();
    }

    function buildLegEl(leg) {
      var m = leg.market;
      var d = document.createElement("div");
      d.className = "pm-leg";
      d.dataset.key = leg.key;
      var yesName = m.outcomes[0] || "Yes", noName = m.outcomes[1] || "No";
      var yn = leg.fixedSide
        ? '<span class="' + (leg.tokenIdx === 0 ? "pm-yes" : "pm-no") + '" data-r="px"></span>'
        : '<span class="pm-yes" data-r="yes">' + esc(yesName) + ' <b data-r="yesPx"></b></span>' +
          '<span class="pm-no" data-r="no">' + esc(noName) + ' <b data-r="noPx"></b></span>';
      d.innerHTML =
        '<button class="pm-leg-row" type="button">' +
          '<span class="pm-leg-name"><span class="pm-leg-label">' + esc(leg.label) + "</span>" +
          '<span class="pm-leg-sub">' + esc(leg.sub || "") + "</span></span>" +
          '<span class="pm-chance"><span class="pct" data-r="pct"></span><span class="chg" data-r="chg"></span></span>' +
          '<span class="pm-yn">' + yn + "</span>" +
          '<span class="pm-chev">▾</span>' +
        "</button>" +
        '<div class="pm-book-slot"></div>';
      var refs = {
        leg: leg, legEl: d,
        pct: d.querySelector('[data-r="pct"]'),
        chg: d.querySelector('[data-r="chg"]'),
        yesPx: d.querySelector('[data-r="yesPx"]'),
        noPx: d.querySelector('[data-r="noPx"]'),
        px: d.querySelector('[data-r="px"]'),
        slot: d.querySelector(".pm-book-slot"),
        sub: d.querySelector(".pm-leg-sub"),
        lastPct: null,
      };
      S.legEls.set(leg.key, refs);
      d.querySelector(".pm-leg-row").addEventListener("click", function () { toggleLeg(leg); });
      paintLegPrices(refs, false);
      return d;
    }

    function paintLegPrices(refs, flash) {
      var leg = refs.leg, m = leg.market;
      var p0 = tokenPrice(m, 0), p1 = tokenPrice(m, 1);
      var mainPx = leg.fixedSide ? tokenPrice(m, leg.tokenIdx) : p0;
      if (refs.pct) {
        refs.pct.textContent = fmtPct(mainPx);
        if (flash && refs.lastPct != null && mainPx != null && mainPx !== refs.lastPct) {
          refs.pct.classList.remove("pm-flash-up", "pm-flash-down");
          void refs.pct.offsetWidth;
          refs.pct.classList.add(mainPx > refs.lastPct ? "pm-flash-up" : "pm-flash-down");
        }
        refs.lastPct = mainPx;
      }
      if (refs.chg) {
        var d = m.oneDayPriceChange;
        refs.chg.textContent = d != null ? fmtDelta(leg.fixedSide && leg.tokenIdx === 1 ? -d : d) : "";
        refs.chg.className = "chg" + (d > 0 ? " up" : d < 0 ? " down" : "");
        if (leg.fixedSide && leg.tokenIdx === 1) refs.chg.className = "chg" + (d > 0 ? " down" : d < 0 ? " up" : "");
      }
      if (refs.yesPx) refs.yesPx.textContent = fmtCents(tokenAsk(m, 0, p0));
      if (refs.noPx) refs.noPx.textContent = fmtCents(tokenAsk(m, 1, p1));
      if (refs.px) refs.px.textContent = (leg.label) + " " + fmtCents(mainPx);
    }

    function tokenAsk(market, idx, fallback) {
      var tok = market.tokens[idx];
      var q = tok && S.quotes.get(tok);
      if (q && q.ask != null && q.ask > 0) return q.ask;
      if (idx === 0 && market.bestAsk != null) return market.bestAsk;
      // US: single book — the short side's ask is the mirror of the long bid.
      if (market.source === "us" && idx === 1 && market.bestBid != null) return 1 - market.bestBid;
      return fallback;
    }

    function paintAllLegs(flash) {
      S.legEls.forEach(function (refs) { paintLegPrices(refs, flash); });
    }

    /* ---------- expand / order book ---------- */
    function toggleLeg(leg) {
      var refs = S.legEls.get(leg.key);
      if (!refs) return;
      if (S.openLegs.has(leg.key)) {
        S.openLegs.delete(leg.key);
        refs.legEl.classList.remove("open");
        refs.slot.innerHTML = "";
        refs.bookRefs = null;
      } else {
        S.openLegs.add(leg.key);
        refs.legEl.classList.add("open");
        mountBook(leg);
        setChartLeg(leg.key);
      }
    }

    function mountBook(leg) {
      var refs = S.legEls.get(leg.key);
      if (!refs) return;
      var m = leg.market;
      var curIdx = leg.fixedSide ? leg.tokenIdx : (S.bookTokenIdx.get(leg.key) || 0);
      var toggle = leg.fixedSide ? "" :
        '<span class="pm-side-toggle">' + m.outcomes.map(function (name, i) {
          return '<button type="button" data-side="' + i + '"' + (i === curIdx ? ' class="active"' : "") + ">" + esc(name) + "</button>";
        }).join("") + "</span>";
      refs.slot.innerHTML =
        '<div class="pm-book">' +
          '<div class="pm-book-head"><span class="t">Order Book</span>' +
            '<span class="pm-depth-sel">' + [5, 8, 15].map(function (n) {
              return '<button type="button" data-depth="' + n + '"' + (n === S.depth ? ' class="active"' : "") + ">" + n + "</button>";
            }).join("") + "</span>" + toggle + "</div>" +
          '<div class="pm-book-cols"><span>Price</span><span></span><span class="r">Shares</span><span class="r">Total</span></div>' +
          '<div class="pm-asks"></div><div class="pm-spread"></div><div class="pm-bids"></div>' +
          '<div class="pm-book-foot"><span data-r="bookMeta">Loading book…</span>' +
            '<a class="pm-trade-link" target="_blank" rel="noopener" href="' +
              esc(S.ev.sourceUrl || (S.ev.source === "us" ? "https://polymarket.us" : "https://polymarket.com")) +
              '">Trade on Polymarket' + (S.ev.source === "us" ? " US" : "") + ' ↗</a></div>' +
        "</div>";
      refs.bookRefs = {
        asks: refs.slot.querySelector(".pm-asks"),
        bids: refs.slot.querySelector(".pm-bids"),
        spread: refs.slot.querySelector(".pm-spread"),
        meta: refs.slot.querySelector('[data-r="bookMeta"]'),
        prevSizes: new Map(),
      };
      refs.slot.querySelectorAll(".pm-depth-sel button").forEach(function (b) {
        b.addEventListener("click", function () {
          S.depth = parseInt(b.dataset.depth, 10);
          storage.set({ pmDepth: S.depth });
          S.openLegs.forEach(function (k) { var r = S.legEls.get(k); if (r && r.bookRefs) renderBook(r.leg); });
          refs.slot.querySelectorAll(".pm-depth-sel button").forEach(function (x) { x.classList.toggle("active", x === b); });
        });
      });
      refs.slot.querySelectorAll(".pm-side-toggle button").forEach(function (b) {
        b.addEventListener("click", function () {
          S.bookTokenIdx.set(leg.key, parseInt(b.dataset.side, 10));
          mountBook(leg);
          ensureBook(leg);
          setChartLeg(leg.key);
        });
      });
      renderBook(leg);
      ensureBook(leg);
    }

    function bookLevels(book, side) {
      var arr = Array.from(book[side].entries()).map(function (e) { return { price: e[0], size: e[1] }; });
      arr.sort(function (a, b) { return side === "bids" ? b.price - a.price : a.price - b.price; });
      return arr;
    }

    function renderBook(leg) {
      var refs = S.legEls.get(leg.key);
      if (!refs || !refs.bookRefs) return;
      var tok = legToken(leg);
      var book = tok && S.books.get(tok);
      var br = refs.bookRefs;
      if (!book) {
        br.asks.innerHTML = '<div class="pm-book-empty">Waiting for book…</div>';
        br.bids.innerHTML = "";
        br.spread.innerHTML = "";
        return;
      }
      var asks = bookLevels(book, "asks").slice(0, S.depth);
      var bids = bookLevels(book, "bids").slice(0, S.depth);
      // cum = cumulative shares for the depth bar; cumUsd = Σ price·size (cost to sweep here)
      var maxCum = 0, cum = 0, cumUsd = 0;
      asks.forEach(function (l) { cum += l.size; l.cum = cum; cumUsd += l.price * l.size; l.cumUsd = cumUsd; });
      maxCum = Math.max(maxCum, cum); cum = 0; cumUsd = 0;
      bids.forEach(function (l) { cum += l.size; l.cum = cum; cumUsd += l.price * l.size; l.cumUsd = cumUsd; });
      maxCum = Math.max(maxCum, cum, 1);

      function row(l, side) {
        var key = side + "@" + l.price;
        var changed = br.prevSizes.has(key) && br.prevSizes.get(key) !== l.size;
        br.prevSizes.set(key, l.size);
        var pctW = Math.max(1.5, (l.cum / maxCum) * 100);
        return '<div class="pm-lvl ' + (side === "asks" ? "ask" : "bid") + (changed ? " changed" : "") + '">' +
          '<span class="bar" style="width:' + pctW.toFixed(1) + '%"></span>' +
          '<span class="px">' + fmtCents(l.price) + "</span><span></span>" +
          '<span class="sz">' + fmtShares(l.size) + "</span>" +
          '<span class="tot">' + fmtMoney(l.cumUsd) + "</span></div>";
      }
      br.asks.innerHTML = asks.length
        ? asks.slice().reverse().map(function (l) { return row(l, "asks"); }).join("")
        : '<div class="pm-book-empty">No asks</div>';
      br.bids.innerHTML = bids.length
        ? bids.map(function (l) { return row(l, "bids"); }).join("")
        : '<div class="pm-book-empty">No bids</div>';

      var bestBid = bids[0] && bids[0].price, bestAsk = asks[0] && asks[0].price;
      var spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
      var mid = spread != null ? (bestBid + bestAsk) / 2 : null;
      br.spread.innerHTML =
        "<span>Spread <b>" + (spread != null ? fmtCents(spread) : "—") + "</b></span>" +
        "<span>Mid <b>" + (mid != null ? fmtCents(mid) : "—") + "</b></span>" +
        "<span>Last <b>" + (book.last != null ? fmtCents(book.last) : "—") + "</b></span>";
      br.meta.textContent = "Tick " + fmtCents(book.tick || 0.01) + " · " +
        (S.sample ? "simulated" : leg.market.source === "us" ? "US · polling" : S.socketLive ? "live" : "REST") +
        " · updated " + new Date(book.ts).toLocaleTimeString([], { hour12: false });
    }

    function queueBookRender(tokenId) {
      S.rafBooks.add(String(tokenId));
      if (S.rafPending) return;
      S.rafPending = true;
      requestAnimationFrame(function () {
        S.rafPending = false;
        var toks = S.rafBooks; S.rafBooks = new Set();
        S.openLegs.forEach(function (key) {
          var refs = S.legEls.get(key);
          if (refs && toks.has(String(legToken(refs.leg)))) renderBook(refs.leg);
        });
        paintAllLegs(true);
        paintChartHead();
        drawChart();
      });
    }

    /* ---------- book state + live feed ---------- */
    function levelsToMap(levels) {
      var map = new Map();
      (levels || []).forEach(function (l) {
        var p = API.num(l.price), s = API.num(l.size);
        if (s > 0) map.set(p, s);
      });
      return map;
    }

    function applyBookSnapshot(tokenId, snap) {
      tokenId = String(tokenId);
      S.books.set(tokenId, {
        bids: snap.bids instanceof Map ? snap.bids : levelsToMap(snap.bids),
        asks: snap.asks instanceof Map ? snap.asks : levelsToMap(snap.asks),
        tick: snap.tickSize || snap.tick || 0.01,
        last: snap.lastTradePrice != null ? snap.lastTradePrice : (snap.last != null ? snap.last : null),
        ts: Date.now(),
      });
      syncQuoteFromBook(tokenId);
      queueBookRender(tokenId);
    }

    function syncQuoteFromBook(tokenId) {
      var book = S.books.get(String(tokenId));
      if (!book) return;
      var bids = bookLevels(book, "bids"), asks = bookLevels(book, "asks");
      var q = S.quotes.get(String(tokenId)) || {};
      if (bids[0]) q.bid = bids[0].price;
      if (asks[0]) q.ask = asks[0].price;
      if (book.last != null) q.last = book.last;
      S.quotes.set(String(tokenId), q);
      updateLivePx(String(tokenId));
    }

    function updateLivePx(tokenId) {
      var q = S.quotes.get(tokenId);
      if (!q) return;
      if (q.last != null) S.livePx.set(tokenId, q.last);
      else if (q.bid != null && q.ask != null) S.livePx.set(tokenId, (q.bid + q.ask) / 2);
    }

    function onWsMessage(msg) {
      if (!msg || S.destroyed) return;
      var type = msg.event_type || msg.type;
      if (type === "book") {
        applyBookSnapshot(msg.asset_id, {
          bids: msg.bids, asks: msg.asks,
          lastTradePrice: msg.last_trade_price != null ? API.num(msg.last_trade_price) : null,
        });
      } else if (type === "price_change") {
        (msg.price_changes || []).forEach(function (c) {
          var tok = String(c.asset_id);
          var book = S.books.get(tok);
          if (book) {
            var side = String(c.side).toUpperCase() === "BUY" ? "bids" : "asks";
            var p = API.num(c.price), s = API.num(c.size);
            if (s > 0) book[side].set(p, s); else book[side].delete(p);
            book.ts = Date.now();
          }
          var q = S.quotes.get(tok) || {};
          if (c.best_bid != null && c.best_bid !== "") q.bid = API.num(c.best_bid);
          if (c.best_ask != null && c.best_ask !== "") q.ask = API.num(c.best_ask);
          S.quotes.set(tok, q);
          if (book) syncQuoteFromBook(tok); else updateLivePx(tok);
          queueBookRender(tok);
        });
      } else if (type === "last_trade_price") {
        var t2 = String(msg.asset_id);
        var q2 = S.quotes.get(t2) || {};
        q2.last = API.num(msg.price);
        S.quotes.set(t2, q2);
        var b2 = S.books.get(t2);
        if (b2) { b2.last = q2.last; b2.ts = Date.now(); }
        updateLivePx(t2);
        queueBookRender(t2);
      } else if (type === "tick_size_change") {
        var b3 = S.books.get(String(msg.asset_id));
        if (b3) b3.tick = API.num(msg.new_tick_size, b3.tick);
        queueBookRender(msg.asset_id);
      }
    }

    function isUS() { return !!(S.ev && S.ev.source === "us"); }

    function ensureSocket() {
      if (S.socket || S.sample || isUS()) return;
      S.socket = new API.MarketSocket(onWsMessage, function (status) {
        if (status === "live") setLive("live", "Live");
        else setLive("reconnecting", "Reconnecting…");
      });
    }

    function subscribeVisible() {
      if (S.sample || isUS()) return;
      ensureSocket();
      var ids = [];
      visibleLegs().forEach(function (leg) {
        leg.market.tokens.forEach(function (t) { if (t) ids.push(t); });
      });
      S.openLegs.forEach(function (key) {
        var refs = S.legEls.get(key);
        if (refs) refs.leg.market.tokens.forEach(function (t) { if (t) ids.push(t); });
      });
      var chartRefs = S.chartLegKey && S.legEls.get(S.chartLegKey);
      if (chartRefs) chartRefs.leg.market.tokens.forEach(function (t) { if (t) ids.push(t); });
      var uniq = Array.from(new Set(ids.map(String))).slice(0, MAX_SUBS);
      if (uniq.length) S.socket.subscribe(uniq);
    }

    /* US: one gateway fetch yields both outcome books (side 1 mirrored). */
    function refreshUSBook(leg) {
      var m = leg.market;
      if (!m.usSlug) return Promise.resolve();
      return API.fetchUSBook(m.usSlug).then(function (res) {
        if (S.destroyed) return;
        m.tokens.forEach(function (tok, i) {
          var s = res.sides && res.sides[i];
          if (s) applyBookSnapshot(tok, { bids: s.bids, asks: s.asks, tick: m.tick || 0.01, last: s.lastTradePrice });
        });
        if (res.meta && res.meta.notionalTraded != null) {
          m.volume = res.meta.notionalTraded;
          var refs = S.legEls.get(leg.key);
          if (refs && refs.sub && !leg.fixedSide) refs.sub.textContent = fmtMoney(m.volume) + " Vol.";
        }
        renderBook(leg);
      }).catch(function () { /* next poll retries */ });
    }

    function ensureBook(leg) {
      var tok = legToken(leg);
      if (!tok) return;
      if (S.sample) { if (!S.books.has(tok)) seedSampleBook(tok); renderBook(leg); return; }
      if (leg.market.source === "us") {
        if (S.books.has(String(tok))) renderBook(leg);
        refreshUSBook(leg);
        return;
      }
      ensureSocket();
      S.socket.subscribe([tok]);
      if (!S.books.has(String(tok))) {
        API.fetchBook(tok).then(function (snap) {
          if (!S.destroyed) applyBookSnapshot(tok, snap);
        }).catch(function () { /* WS snapshot will fill it */ });
      } else {
        renderBook(leg);
      }
    }

    /* ---------- chart ---------- */
    function chartLeg() {
      var refs = S.chartLegKey && S.legEls.get(S.chartLegKey);
      if (refs) return refs.leg;
      return S.legs[0] || null;
    }

    function setChartLeg(key) {
      if (S.chartLegKey === key) { paintChartHead(); return; }
      S.chartLegKey = key;
      loadHistory();
    }

    function loadHistory() {
      var leg = chartLeg();
      if (!leg) return;
      var tok = leg.fixedSide ? leg.market.tokens[leg.tokenIdx]
        : leg.market.tokens[S.bookTokenIdx.get(leg.key) || 0];
      S.historyToken = tok;
      paintChartHead();
      if (S.sample) { S.history = sampleHistory(tok); drawChart(); return; }
      if (!tok) return;
      var histP = leg.market.source === "us"
        ? API.fetchUSHistory(leg.market.usSlug, S.range, leg.market.tokens.indexOf(tok))
        : API.fetchHistory(tok, S.range);
      histP.then(function (pts) {
        if (S.destroyed || S.historyToken !== tok) return;
        S.history = pts;
        paintChartHead();
        drawChart();
      }).catch(function () { S.history = []; drawChart(); });
    }

    function chartLivePrice() {
      var leg = chartLeg();
      if (!leg) return null;
      var idx = leg.fixedSide ? leg.tokenIdx : (S.bookTokenIdx.get(leg.key) || 0);
      return tokenPrice(leg.market, idx);
    }

    function paintChartHead() {
      var nameEl = el.body.querySelector(".pm-chart-name");
      if (!nameEl) return;
      var leg = chartLeg();
      var priceEl = el.body.querySelector(".pm-chart-price");
      var deltaEl = el.body.querySelector(".pm-delta");
      if (!leg) { nameEl.textContent = ""; priceEl.textContent = ""; deltaEl.textContent = ""; return; }
      var idx = leg.fixedSide ? leg.tokenIdx : (S.bookTokenIdx.get(leg.key) || 0);
      var outcome = leg.market.outcomes[idx] || "";
      nameEl.textContent = leg.fixedSide ? leg.label : leg.label + " · " + outcome;
      var live = chartLivePrice();
      priceEl.innerHTML = fmtPct(live) + ' <small>chance · ' + fmtCents(live) + "</small>";
      var pts = S.history;
      if (pts && pts.length > 1 && live != null) {
        var d = live - pts[0].p;
        deltaEl.textContent = fmtDelta(d) + " (" + S.range + ")";
        deltaEl.className = "pm-delta" + (d > 0 ? " up" : d < 0 ? " down" : "");
      } else deltaEl.textContent = "";
    }

    function drawChart() {
      var canvas = el.body.querySelector(".pm-chart");
      if (!canvas || !S.ev) return;
      var live = chartLivePrice();
      var pts = S.history ? S.history.slice() : [];
      if (live != null && pts.length) {
        var last = pts[pts.length - 1];
        if (Date.now() - last.t > 5000) pts.push({ t: Date.now(), p: live });
        else pts[pts.length - 1] = { t: last.t, p: live };
      }
      var up = pts.length > 1 ? pts[pts.length - 1].p >= pts[0].p : true;
      var info = Chart.draw(canvas, pts, {
        color: up ? "#27c46a" : "#e6484d",
        livePrice: live, range: S.range, hoverX: S.chartHoverX,
      });
      var hov = el.body.querySelector(".pm-chart-hover");
      if (hov) {
        hov.textContent = info && info.hover
          ? fmtPct(info.hover.p) + " · " + Chart.fmtTime(info.hover.t, S.range) + " " +
            new Date(info.hover.t).toLocaleDateString([], { month: "short", day: "numeric" })
          : "";
      }
    }

    function wireChartHover() {
      var canvas = el.body.querySelector(".pm-chart");
      if (!canvas) return;
      canvas.addEventListener("pointermove", function (e) {
        var r = canvas.getBoundingClientRect();
        S.chartHoverX = e.clientX - r.left;
        drawChart();
      });
      canvas.addEventListener("pointerleave", function () { S.chartHoverX = null; drawChart(); });
    }

    /* ---------- loading ---------- */
    function resetMarketState() {
      if (S.socket) { S.socket.close(); S.socket = null; }
      if (S.sampleTimer) { clearInterval(S.sampleTimer); S.sampleTimer = null; }
      S.timers.forEach(clearInterval); S.timers = [];
      S.books.clear(); S.quotes.clear(); S.livePx.clear();
      S.openLegs.clear(); S.bookTokenIdx.clear();
      S.chartLegKey = null; S.history = []; S.showAll = false; S.filter = "";
      S.sample = false;
      setLive("idle", "Idle");
    }

    function startPolling() {
      // Intl REST safety net: refresh books for open legs if the socket is down.
      every(4000, function () {
        if (S.sample || S.socketLive || !S.ev || isUS()) return;
        S.openLegs.forEach(function (key) {
          var refs = S.legEls.get(key);
          if (!refs) return;
          var tok = legToken(refs.leg);
          if (tok) API.fetchBook(tok).then(function (s) { applyBookSnapshot(tok, s); }).catch(function () {});
        });
      });
      // US has no public WebSocket: polling the gateway book IS the live feed.
      // Rotate through open legs (+ chart leg), at most 2 fetches per 3s tick.
      var usTick = 0;
      every(3000, function () {
        if (S.sample || !S.ev || !isUS()) return;
        var targets = [];
        S.openLegs.forEach(function (key) {
          var refs = S.legEls.get(key);
          if (refs) targets.push(refs.leg);
        });
        var cl = chartLeg();
        if (cl && targets.indexOf(cl) === -1) targets.push(cl);
        if (!targets.length && S.legs[0]) targets.push(S.legs[0]);
        for (var i = 0; i < Math.min(2, targets.length); i++) {
          refreshUSBook(targets[(usTick + i) % targets.length]);
        }
        usTick++;
      });
      // Periodic metadata refresh (prices/volumes) for both sources.
      every(30000, function () {
        if (S.sample || !S.url) return;
        API.loadFromUrl(S.url).then(function (fresh) {
          if (S.destroyed || !S.ev) return;
          var byId = new Map(fresh.markets.map(function (m) { return [m.id, m]; }));
          if (fresh.volume != null) S.ev.volume = fresh.volume;
          if (fresh.liquidity != null) S.ev.liquidity = fresh.liquidity;
          S.legs.forEach(function (leg) {
            var f = byId.get(leg.market.id);
            if (f) { leg.market.prices = f.prices;
                     if (f.volume != null) leg.market.volume = f.volume;
                     leg.market.bestBid = f.bestBid; leg.market.bestAsk = f.bestAsk;
                     leg.market.oneDayPriceChange = f.oneDayPriceChange; }
          });
          paintAllLegs(true); paintChartHead();
        }).catch(function () {});
      });
    }

    function applyLoadedEvent(ev, url) {
      S.ev = ev;
      S.legs = buildLegs(ev);
      renderEvent();
      var focus = null;
      if (ev.focusSlug) focus = S.legs.find(function (l) { return l.market.slug === ev.focusSlug; });
      var first = focus || S.legs[0];
      if (first) {
        S.chartLegKey = first.key;
        toggleLeg(first); // auto-expand the leading leg so a book is visible
      }
      loadHistory();
      subscribeVisible();
      startPolling();
      if (url) storage.set({ pmLastUrl: url });
      setStatus(S.sample ? "Sample market — simulated live feed." : "");
      if (el.src) el.src.textContent = S.sample ? "Simulated feed"
        : ev.source === "us" ? "Polymarket US gateway · live polling"
        : "Gamma + CLOB · live via WebSocket";
      if (!S.sample && ev.source === "us") setLive("live", "Live");
      else if (!S.sample) setLive("reconnecting", "Connecting…");
    }

    function loadUrl(url) {
      S.gen++;
      url = String(url || "").trim();
      if (!url) { setStatus("Paste a Polymarket market or event URL first.", true); return Promise.resolve(); }
      resetMarketState();
      S.url = url;
      el.input.value = url;
      el.go.disabled = true;
      setStatus("Loading market…");
      el.body.innerHTML = '<div class="pm-spinner"></div>';
      return API.loadFromUrl(url).then(function (ev) {
        el.go.disabled = false;
        if (S.destroyed) return;
        if (!ev.markets.length) throw new Error("No tradable markets found at that URL.");
        applyLoadedEvent(ev, url);
      }).catch(function (e) {
        el.go.disabled = false;
        if (S.destroyed) return;
        setStatus("Could not load that market: " + (e && e.message || e) + " — check the URL and try again.", true);
        renderEmpty(true);
      });
    }

    function renderEmpty(withRetry) {
      el.body.innerHTML =
        '<div class="pm-empty"><b>No market loaded.</b><br>' +
        "Paste any live polymarket.com or polymarket.us event/market URL above.<br>" +
        "The overlay pins on top of this page — drag the header to move it," +
        " drag ⤡ to resize, double-click the header to reset, <b>Alt+P</b> toggles it." +
        (withRetry ? "" : '<br><button class="pm-sample" type="button">Preview with a sample market</button>') +
        "</div>";
      var b = el.body.querySelector(".pm-sample");
      if (b) b.addEventListener("click", loadSample);
    }

    /* ---------- sample (offline preview) ---------- */
    function sampleHistory(tok) {
      var seed = 0; String(tok).split("").forEach(function (c) { seed = (seed * 31 + c.charCodeAt(0)) % 9973; });
      var rnd = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      var leg = chartLeg();
      var idx = leg ? leg.market.tokens.indexOf(tok) : 0;
      var end = leg ? (tokenPrice(leg.market, idx < 0 ? 0 : idx) || 0.5) : 0.5;
      var pts = [], p = Math.min(0.95, Math.max(0.05, end + (rnd() - 0.5) * 0.2));
      var now = Date.now(), span = { "1H": 36e5, "6H": 216e5, "1D": 864e5, "1W": 6048e5, "1M": 2592e6, "ALL": 7776e6 }[S.range] || 864e5;
      for (var i = 0; i <= 60; i++) {
        pts.push({ t: now - span + (span * i) / 60, p: Math.min(0.99, Math.max(0.01, p)) });
        p += (end - p) * 0.06 + (rnd() - 0.5) * 0.02;
      }
      pts[60].p = end;
      return pts;
    }

    function seedSampleBook(tok) {
      var leg = S.legs.find(function (l) { return l.market.tokens.indexOf(tok) !== -1; });
      var idx = leg ? leg.market.tokens.indexOf(tok) : 0;
      var mid = leg ? (leg.market.prices[idx] || 0.5) : 0.5;
      var bids = new Map(), asks = new Map();
      for (var i = 1; i <= 12; i++) {
        var bp = Math.max(0.01, +(mid - i * 0.01).toFixed(3));
        var ap = Math.min(0.99, +(mid + i * 0.01).toFixed(3));
        bids.set(bp, Math.round(200 + Math.random() * 4000));
        asks.set(ap, Math.round(200 + Math.random() * 4000));
      }
      applyBookSnapshot(tok, { bids: bids, asks: asks, tick: 0.01, last: mid });
    }

    function loadSample() {
      S.gen++;
      resetMarketState();
      S.sample = true;
      S.url = null;
      var mk = function (id, label, yes) {
        return { id: "sample-" + id, slug: "sample", question: "Will " + label + " happen?",
          label: label, outcomes: ["Yes", "No"], prices: [yes, +(1 - yes).toFixed(3)],
          tokens: ["smp-" + id + "-yes", "smp-" + id + "-no"], image: null,
          volume: Math.round(yes * 4e6), volume24hr: 120000, liquidity: 850000,
          bestBid: null, bestAsk: null, lastTradePrice: yes, spread: 0.02,
          active: true, closed: false, acceptingOrders: true, oneDayPriceChange: +((Math.random() - 0.4) * 0.06).toFixed(3) };
      };
      var ev = { id: "sample", slug: "sample", title: "Sample: Who wins the big race?",
        image: null, volume: 12400000, liquidity: 2100000, endDate: new Date(Date.now() + 864e7).toISOString(),
        closed: false, markets: [mk(1, "Alpha", 0.54), mk(2, "Bravo", 0.31), mk(3, "Charlie", 0.11), mk(4, "Delta", 0.04)] };
      setLive("live", "Simulated");
      applyLoadedEvent(ev, null);
      S.sampleTimer = setInterval(function () {
        if (S.destroyed || !S.sample) return;
        S.legs.forEach(function (leg) {
          var m = leg.market;
          var drift = (Math.random() - 0.5) * 0.006;
          m.prices[0] = Math.min(0.98, Math.max(0.02, m.prices[0] + drift));
          m.prices[1] = +(1 - m.prices[0]).toFixed(4);
          S.livePx.set(m.tokens[0], m.prices[0]);
          S.livePx.set(m.tokens[1], m.prices[1]);
          queueBookRender(m.tokens[0]);
        });
        S.openLegs.forEach(function (key) {
          var refs = S.legEls.get(key);
          if (!refs) return;
          seedSampleBook(legToken(refs.leg));
        });
      }, 1200);
    }

    /* ---------- chrome (bar buttons, form, opacity, drag/resize) ---------- */
    el.form.addEventListener("submit", function (e) { e.preventDefault(); loadUrl(el.input.value); });
    el.opacity.addEventListener("input", function () {
      root.style.setProperty("--pm-alpha", (el.opacity.value / 100).toFixed(2));
      storage.set({ pmOpacity: +el.opacity.value });
    });
    root.querySelector('[data-act="glass"]').addEventListener("click", function (e) {
      root.classList.toggle("pm-glass");
      e.currentTarget.classList.toggle("active", root.classList.contains("pm-glass"));
    });
    root.querySelector('[data-act="min"]').addEventListener("click", function () {
      root.classList.toggle("pm-minimized");
      if (opts.frameEl) opts.frameEl.style.height = root.classList.contains("pm-minimized") ? "44px" : (opts.frameEl.dataset.h || "640px");
    });
    root.querySelector('[data-act="close"]').addEventListener("click", function () {
      if (opts.onClose) opts.onClose();
      else root.style.display = "none";
    });

    function dragHandle(handle, mode) {
      if (!opts.frameEl) return;
      handle.addEventListener("pointerdown", function (e) {
        if (mode === "move" && (e.target.closest("button") || e.target.closest("input"))) return;
        e.preventDefault();
        var f = opts.frameEl, r = f.getBoundingClientRect();
        var sx = e.clientX, sy = e.clientY, x0 = r.left, y0 = r.top, w0 = r.width, h0 = r.height;
        f.style.left = x0 + "px"; f.style.top = y0 + "px"; f.style.right = "auto"; f.style.bottom = "auto";
        function mv(ev) {
          if (mode === "move") {
            f.style.left = Math.min(window.innerWidth - 60, Math.max(-r.width + 80, x0 + ev.clientX - sx)) + "px";
            f.style.top = Math.min(window.innerHeight - 30, Math.max(0, y0 + ev.clientY - sy)) + "px";
          } else {
            f.style.width = Math.max(320, Math.min(window.innerWidth - 16, w0 + ev.clientX - sx)) + "px";
            f.style.height = Math.max(240, Math.min(window.innerHeight - 16, h0 + ev.clientY - sy)) + "px";
            f.dataset.h = f.style.height;
            drawChart();
          }
        }
        function up() {
          window.removeEventListener("pointermove", mv);
          window.removeEventListener("pointerup", up);
          var fr = f.getBoundingClientRect();
          var g = Geom ? Geom.clampGeometry(
            { x: fr.left, y: fr.top, w: fr.width, h: fr.height },
            window.innerWidth, window.innerHeight)
            : { x: Math.round(fr.left), y: Math.round(fr.top), w: Math.round(fr.width), h: Math.round(fr.height) };
          f.style.left = g.x + "px"; f.style.top = g.y + "px";
          f.style.width = g.w + "px"; f.style.height = g.h + "px";
          if (mode === "size") f.dataset.h = f.style.height;
          storage.set({ pmGeom: g });
          drawChart();
        }
        window.addEventListener("pointermove", mv);
        window.addEventListener("pointerup", up);
      });
    }
    dragHandle(el.bar, "move");
    dragHandle(el.resize, "size");
    if (opts.standalone) el.resize.style.display = "none";

    /* Rescue gesture: double-click the header resets size + position,
       so the panel can always be recovered even if it ends up off-screen.
       Detected on pointerdown (capture on the root) because the drag
       handler's preventDefault suppresses the native dblclick event;
       the second tap's drag is stopped so the reset sticks. */
    el.bar.title = "Drag to move · double-click to reset size & position";
    var lastBarTap = { t: 0, x: 0, y: 0 };
    root.addEventListener("pointerdown", function (e) {
      if (!opts.frameEl || !el.bar.contains(e.target)) return;
      if (e.target.closest("button") || e.target.closest("input")) return;
      var now = Date.now();
      var isDouble = now - lastBarTap.t < 420 &&
        Math.abs(e.clientX - lastBarTap.x) < 10 && Math.abs(e.clientY - lastBarTap.y) < 10;
      lastBarTap = { t: now, x: e.clientX, y: e.clientY };
      if (!isDouble) return;
      e.stopPropagation();
      e.preventDefault();
      var f = opts.frameEl;
      var g = Geom ? Geom.clampGeometry({ x: null, y: null, w: Geom.DEFAULTS.w, h: Geom.DEFAULTS.h },
        window.innerWidth, window.innerHeight) : { w: 430, h: 640 };
      f.style.width = g.w + "px"; f.style.height = g.h + "px";
      f.style.left = "auto"; f.style.right = "16px"; f.style.top = "16px"; f.style.bottom = "auto";
      f.dataset.h = f.style.height;
      root.classList.remove("pm-minimized");
      storage.set({ pmGeom: { x: null, y: null, w: g.w, h: g.h } });
      drawChart();
    }, true);

    window.addEventListener("resize", drawChart);

    /* ---------- init ---------- */
    storage.get(["pmOpacity", "pmRange", "pmDepth", "pmLastUrl"]).then(function (cfg) {
      cfg = cfg || {};
      if (cfg.pmOpacity) { el.opacity.value = cfg.pmOpacity; root.style.setProperty("--pm-alpha", (cfg.pmOpacity / 100).toFixed(2)); }
      if (cfg.pmRange && RANGES.indexOf(cfg.pmRange) !== -1) S.range = cfg.pmRange;
      if (cfg.pmDepth) S.depth = cfg.pmDepth;
      if (S.gen !== 0 || S.ev) return; // a load already started before settings resolved
      var initial = opts.initialUrl || cfg.pmLastUrl;
      if (initial) loadUrl(initial);
      else renderEmpty(false);
    }).catch(function () { if (S.gen === 0 && !S.ev) renderEmpty(false); });

    return {
      root: root,
      loadUrl: loadUrl,
      loadSample: loadSample,
      focusInput: function () { el.input.focus(); el.input.select(); },
      destroy: function () {
        S.destroyed = true;
        resetMarketState();
        window.removeEventListener("resize", drawChart);
        root.remove();
      },
      _state: S,
    };
  }

  window.PMOverlay = { create: create };
})();



