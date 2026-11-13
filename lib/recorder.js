/* Order-book session recorder: turns the overlay's live feeds into an
   NDJSON time series for offline strategy analysis.

   One line per event (JSONL): a `session` header (market/token map,
   schema, caveats), then `book_snapshot` / `level_change` / `trade` /
   `wallet_trade` / `bbo_change` / `market_stats` / `note` lines with
   monotonic `seq` and millisecond timestamps, then a `session_end`
   summary (per-token, per-level and per-wallet aggregates).

   What the public feeds can and cannot show (also embedded in every
   export so the limits travel with the data):
   - Books are aggregated Level-2 (shares per price). Individual resting
     orders and their owners are NOT observable on any public feed, so a
     level that grows by 500 cannot be split into orders or wallets.
   - A level shrinking is labelled `likely_fill` only when trade prints
     at that price cover the shrinkage within a short window; otherwise
     `likely_cancel`. That is an inference over aggregated sizes, never a
     fact about a specific order. Raw deltas + trade prints are kept so
     the classification can be re-derived offline with other rules.
   - Fills CAN be attributed on polymarket.com: the public Data API v2
     trades feed names the wallet + pseudonym + transaction hash of each
     executed trade. Rows arrive seconds late and do not say whether the
     wallet was maker or taker. polymarket.us has no equivalent.

   Pure logic only (no DOM, no fetch): overlay.js feeds it, Node tests it.
   Exposed as window.PMRecorder; also loadable in Node. */
(function (root) {
  "use strict";

  var SCHEMA = "pm-overlay-recording/1";
  var DEFAULT_MAX_EVENTS = 750000;
  var FILL_WINDOW_MS = 5000;      // trade credit / unexplained-decrease memory
  var CHECKPOINT_MS = 60000;      // min spacing of full snapshot lines per token
  var RECENT_TRADES_KEEP = 2000;  // for wallet-trade matching

  function num(v, fallback) {
    var n = typeof v === "string" ? parseFloat(v) : v;
    return typeof n === "number" && isFinite(n) ? n : (fallback || 0);
  }
  function r6(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6; }
  function levelsToMap(levels) {
    var map = new Map();
    (levels || []).forEach(function (l) {
      if (!l) return;
      var p = num(l.price), s = num(l.size);
      if (s > 0) map.set(p, s);
    });
    return map;
  }
  function mapToLevels(map, side) {
    var out = [];
    map.forEach(function (size, price) { out.push({ price: price, size: size }); });
    out.sort(function (a, b) { return side === "bids" ? b.price - a.price : a.price - b.price; });
    return out;
  }
  /* Dedupe key for Data API trade rows (one row per wallet per fill). */
  function walletTradeKey(r) {
    return [r.txHash || "", r.wallet || "", r.token || "", r.tsMs || 0,
      r.size || 0, r.price || 0, r.side || ""].join("|");
  }

  function Recorder(opts) {
    opts = opts || {};
    this.now = opts.now || function () { return Date.now(); };
    this.maxEvents = opts.maxEvents || DEFAULT_MAX_EVENTS;
    this.fillWindowMs = opts.fillWindowMs || FILL_WINDOW_MS;
    this.recording = false;
    this.truncated = false;
    this.seq = 0;
    this.lines = [];
    this.bytes = 0;
    this.startedAtMs = null;
    this.endedAtMs = null;
    this.tokenMeta = new Map();   // token -> meta object
    this.books = new Map();       // token -> {bids:Map, asks:Map, tick, last, lastHash, lastSnapshotMs}
    this.quotes = new Map();      // token -> {bid, ask, last}
    this.credits = new Map();     // token|side|price -> [{amt, seq, t}]
    this.recentDecreases = [];    // [{seq, token, side, price, unexplained, t}]
    this.recentTrades = [];       // WS trades for wallet matching
    this.lastTradeByToken = new Map();
    this.statsBaseline = new Map(); // marketToken -> last market_stats values
    this.counts = {};
    this.tokenAgg = new Map();
    this.levelAgg = new Map();    // token|side|price -> aggregate
    this.walletAgg = new Map();
  }

  Recorder.prototype.emit = function (ev) {
    if (!this.recording) return null;
    if (this.lines.length >= this.maxEvents && ev.type !== "session_end") {
      if (!this.truncated) {
        this.truncated = true;
        var stop = { type: "note", kind: "recorder_truncated",
          max_events: this.maxEvents };
        stop.seq = ++this.seq;
        stop.t_ms = this.now();
        stop.dt_ms = stop.t_ms - this.startedAtMs;
        var s0 = JSON.stringify(stop);
        this.lines.push(s0); this.bytes += s0.length + 1;
        this.counts.note = (this.counts.note || 0) + 1;
      }
      return null;
    }
    var t = this.now();
    ev.seq = ++this.seq;
    ev.t_ms = t;
    ev.dt_ms = t - this.startedAtMs;
    var s = JSON.stringify(ev);
    this.lines.push(s);
    this.bytes += s.length + 1;
    this.counts[ev.type] = (this.counts[ev.type] || 0) + 1;
    return ev;
  };

  Recorder.prototype.agg = function (token) {
    var a = this.tokenAgg.get(token);
    if (!a) {
      a = { snapshots: 0, level_changes: 0, new_levels: 0, increases: 0,
        decreases: 0, removed: 0, added_shares: 0, removed_shares: 0,
        likely_fill_shares: 0, likely_cancel_shares: 0,
        trades: 0, trade_shares: 0, trade_usd: 0,
        first_ms: null, last_ms: null };
      this.tokenAgg.set(token, a);
    }
    var t = this.now();
    if (a.first_ms == null) a.first_ms = t;
    a.last_ms = t;
    return a;
  };

  /* Register a token's identity (market, outcome, tick). Before start()
     it lands in the session header; mid-session it becomes its own line
     so late-subscribed legs are still self-describing. */
  Recorder.prototype.setTokenMeta = function (token, meta) {
    token = String(token);
    var prev = this.tokenMeta.get(token) || {};
    var merged = Object.assign({}, prev, meta || {});
    var isNew = !this.tokenMeta.has(token);
    this.tokenMeta.set(token, merged);
    var book = this.books.get(token);
    if (book && merged.tick) book.tick = merged.tick;
    if (this.recording && isNew) {
      this.emit(Object.assign({ type: "token_meta", token: token }, merged));
    }
  };

  Recorder.prototype.start = function (meta) {
    meta = meta || {};
    this.recording = true;
    this.startedAtMs = this.now();
    var tokens = [];
    this.tokenMeta.forEach(function (m, token) {
      tokens.push(Object.assign({ token: token }, m));
    });
    this.emit({
      type: "session",
      schema: SCHEMA,
      started_at: new Date(this.startedAtMs).toISOString(),
      source: meta.source || null,          // "intl" | "us"
      sample: !!meta.sample,
      url: meta.url || null,
      event: meta.event || null,            // {id, slug, title, source_url}
      markets: meta.markets || [],          // [{id, slug, condition_id, question, tick}]
      tokens: tokens,                       // [{token, market_id, condition_id, outcome, tick}]
      scope: meta.scope || "on_screen",
      inference: {
        method: "aggregated L2: a decrease is likely_fill when unconsumed trade prints " +
          "at the same token/side/price within fill_window_ms cover it, likely_fill_partial " +
          "when they cover part, else likely_cancel",
        fill_window_ms: this.fillWindowMs,
      },
      caveats: [
        "Books are aggregated shares-per-price (Level-2). Individual resting orders and their owners are not observable on public feeds.",
        "cause_inferred is a heuristic over aggregated sizes, not a fact about any single order.",
        "wallet_trade rows come from the public Data API v2 trades feed (polymarket.com only), can arrive minutes late (the feed indexes in bursts, so the tail of a short recording may lack attribution — see wallet_coverage in session_end), and do not identify maker vs taker.",
        "t_ms is the recorder's receive clock; t_server_ms is copied from the feed when present. Clock skew between them is not corrected.",
      ],
    });
    return this;
  };

  Recorder.prototype.note = function (kind, data) {
    this.emit(Object.assign({ type: "note", kind: kind }, data || {}));
  };

  Recorder.prototype.status = function () {
    return {
      recording: this.recording,
      truncated: this.truncated,
      events: this.lines.length,
      bytes: this.bytes,
      startedAtMs: this.startedAtMs,
      elapsedMs: this.startedAtMs == null ? 0 : this.now() - this.startedAtMs,
      tokens: this.books.size,
      counts: Object.assign({}, this.counts),
    };
  };

  /* ---------- book context ---------- */
  Recorder.prototype.bookState = function (token) {
    var b = this.books.get(token);
    if (!b) {
      var meta = this.tokenMeta.get(token) || {};
      b = { bids: new Map(), asks: new Map(), tick: meta.tick || null,
        last: null, lastHash: null, lastSnapshotMs: 0 };
      this.books.set(token, b);
    }
    return b;
  };

  function bookContext(book) {
    var bestBid = null, bestAsk = null;
    book.bids.forEach(function (_s, p) { if (bestBid == null || p > bestBid) bestBid = p; });
    book.asks.forEach(function (_s, p) { if (bestAsk == null || p < bestAsk) bestAsk = p; });
    var spread = bestBid != null && bestAsk != null ? r6(bestAsk - bestBid) : null;
    return {
      best_bid: bestBid, best_ask: bestAsk,
      mid: spread != null ? r6((bestBid + bestAsk) / 2) : null,
      spread: spread,
    };
  }

  function levelContext(book, side, price) {
    var ahead = 0, sideUsd = 0, sideShares = 0;
    book[side].forEach(function (size, p) {
      sideShares += size;
      sideUsd += p * size;
      var better = side === "bids" ? p > price : p < price;
      if (better) ahead += size;
    });
    return { ahead_shares: r6(ahead), side_shares: r6(sideShares), side_usd: r6(sideUsd) };
  }

  Recorder.prototype.tickOf = function (token, book) {
    if (book && book.tick) return book.tick;
    var meta = this.tokenMeta.get(token);
    return (meta && meta.tick) || 0.01;
  };

  /* ---------- fill-vs-cancel credit ---------- */
  Recorder.prototype.creditKey = function (token, side, price) {
    return token + "|" + side + "|" + price;
  };

  Recorder.prototype.addCredit = function (token, side, price, amt, seq) {
    if (!(amt > 0)) return;
    var key = this.creditKey(token, side, price);
    var q = this.credits.get(key);
    if (!q) { q = []; this.credits.set(key, q); }
    q.push({ amt: amt, seq: seq, t: this.now() });
  };

  /* Consume trade credit against a decrease of `amt`. Returns
     {filled, tradeSeqs}; leftover credit stays for later decrements. */
  Recorder.prototype.consumeCredit = function (token, side, price, amt) {
    var key = this.creditKey(token, side, price);
    var q = this.credits.get(key);
    if (!q || !q.length) return { filled: 0, tradeSeqs: [] };
    var now = this.now(), filled = 0, seqs = [];
    q = q.filter(function (c) { return now - c.t <= this.fillWindowMs; }, this);
    while (q.length && filled < amt) {
      var c = q[0];
      var take = Math.min(c.amt, amt - filled);
      c.amt -= take; filled += take;
      if (seqs.indexOf(c.seq) === -1) seqs.push(c.seq);
      if (c.amt <= 1e-9) q.shift();
    }
    if (q.length) this.credits.set(key, q); else this.credits.delete(key);
    return { filled: filled, tradeSeqs: seqs };
  };

  Recorder.prototype.levelAggFor = function (token, side, price) {
    var key = token + "|" + side + "|" + price;
    var a = this.levelAgg.get(key);
    if (!a) {
      a = { token: token, side: side, price: price, changes: 0,
        added_shares: 0, removed_shares: 0, peak_size: 0,
        likely_fill_shares: 0, likely_cancel_shares: 0,
        first_ms: this.now(), last_ms: this.now() };
      this.levelAgg.set(key, a);
    }
    a.last_ms = this.now();
    return a;
  };

  /* Core: apply one absolute level update (newSize is the aggregate size
     now resting at price, 0 = gone) to recorder state and emit the delta.
     `known` is false when the token's book was never snapshotted: the
     update is still recorded but flagged prev_unknown. */
  Recorder.prototype.applyLevel = function (token, side, price, newSize, opts) {
    opts = opts || {};
    var book = this.bookState(token);
    var sideMap = book[side];
    var known = book.seenSnapshot === true;
    var had = sideMap.has(price);
    var prev = had ? sideMap.get(price) : 0;
    if (newSize > 0) sideMap.set(price, newSize); else sideMap.delete(price);
    if ((!had && newSize === 0) || (had && prev === newSize)) return null;

    var delta = newSize - prev;
    var change = !had && known ? "new_level"
      : newSize === 0 ? "removed"
      : delta > 0 ? "increase" : "decrease";
    var agg = this.agg(token);
    agg.level_changes++;
    var la = this.levelAggFor(token, side, price);
    la.changes++;
    if (newSize > la.peak_size) la.peak_size = newSize;

    var ctx = bookContext(book);
    var tick = this.tickOf(token, book);
    var best = side === "bids" ? ctx.best_bid : ctx.best_ask;
    var ev = {
      type: "level_change", token: token, side: side, price: price,
      prev_size: had || known ? prev : null,
      size: newSize, delta: r6(delta), delta_usd: r6(delta * price),
      change: change,
      book: ctx,
      level: Object.assign(levelContext(book, side, price), {
        dist_best_ticks: best != null && tick > 0
          ? Math.round(Math.abs(price - best) / tick) : null,
        dist_mid_ticks: ctx.mid != null && tick > 0
          ? r6((price - ctx.mid) / tick) : null,
      }),
      source: opts.source || null,
    };
    if (opts.serverTs != null) ev.t_server_ms = opts.serverTs;
    if (!known) ev.prev_unknown = true;
    var lt = this.lastTradeByToken.get(token);
    if (lt) { ev.ms_since_last_trade = this.now() - lt.t; ev.last_trade_seq = lt.seq; }

    if (delta > 0) {
      agg.added_shares += delta; la.added_shares += delta;
      if (change === "new_level") agg.new_levels++; else agg.increases++;
    } else {
      var amt = -delta;
      agg.removed_shares += amt; la.removed_shares += amt;
      if (change === "removed") agg.removed++; else agg.decreases++;
      var credit = this.consumeCredit(token, side, price, amt);
      var eps = Math.max(0.01, amt * 0.001);
      if (!known) {
        ev.cause_inferred = "unknown_no_snapshot";
      } else if (credit.filled >= amt - eps) {
        ev.cause_inferred = "likely_fill";
        ev.fill_shares = r6(amt);
      } else if (credit.filled > 0) {
        ev.cause_inferred = "likely_fill_partial";
        ev.fill_shares = r6(credit.filled);
        ev.cancel_shares = r6(amt - credit.filled);
      } else {
        ev.cause_inferred = "likely_cancel";
        ev.cancel_shares = r6(amt);
      }
      if (credit.tradeSeqs.length) ev.fill_trade_seqs = credit.tradeSeqs;
      var fillQty = ev.fill_shares || 0, cancelQty = ev.cancel_shares || 0;
      agg.likely_fill_shares += fillQty; agg.likely_cancel_shares += cancelQty;
      la.likely_fill_shares += fillQty; la.likely_cancel_shares += cancelQty;
      var unexplained = amt - credit.filled;
      if (unexplained > eps) {
        // Remembered briefly: a trade print arriving just after the book
        // update (feed ordering) can still be linked from the trade line.
        this.recentDecreases.push({ seq: null, token: token, side: side,
          price: price, unexplained: unexplained, t: this.now(), evRef: ev });
      }
    }
    var emitted = this.emit(ev);
    // Back-fill the seq on the pending-decrease record (same object).
    if (emitted && delta < 0) {
      for (var i = this.recentDecreases.length - 1; i >= 0; i--) {
        if (this.recentDecreases[i].evRef === ev) {
          this.recentDecreases[i].seq = emitted.seq;
          delete this.recentDecreases[i].evRef;
          break;
        }
      }
    }
    return emitted;
  };

  Recorder.prototype.emitSnapshot = function (token, book, opts) {
    book.lastSnapshotMs = this.now();
    this.agg(token).snapshots++;
    var ev = {
      type: "book_snapshot", token: token,
      bids: mapToLevels(book.bids, "bids"),
      asks: mapToLevels(book.asks, "asks"),
      tick: this.tickOf(token, book),
      last: book.last,
      book: bookContext(book),
      source: opts.source || null,
      checkpoint: !!opts.checkpoint,
    };
    if (opts.hash) ev.hash = opts.hash;
    if (opts.serverTs != null) ev.t_server_ms = opts.serverTs;
    return this.emit(ev);
  };

  /* Feed a full book (WS `book`, REST /book, US stream frame, sample seed).
     First sight -> snapshot line. Afterwards the frame is diffed into
     level_change lines, plus a fresh snapshot line at most every
     CHECKPOINT_MS when `checkpoint` is set (authoritative frames) or the
     checkpoint spacing has elapsed (stream frames), so long recordings
     stay replayable from any checkpoint without snapshot spam. */
  Recorder.prototype.observeBook = function (token, bids, asks, opts) {
    if (!this.recording) return;
    token = String(token);
    opts = opts || {};
    var book = this.bookState(token);
    if (opts.hash && opts.hash === book.lastHash) return; // identical frame
    if (opts.hash) book.lastHash = opts.hash;
    if (opts.tick) book.tick = opts.tick;
    if (opts.last != null) book.last = opts.last;

    var newBids = levelsToMap(bids), newAsks = levelsToMap(asks);
    if (!book.seenSnapshot) {
      book.bids = newBids; book.asks = newAsks;
      book.seenSnapshot = true;
      var self0 = this;
      [["bids", newBids], ["asks", newAsks]].forEach(function (pair) {
        pair[1].forEach(function (size, p) {
          var la = self0.levelAggFor(token, pair[0], p);
          if (size > la.peak_size) la.peak_size = size;
        });
      });
      this.emitSnapshot(token, book, opts);
      return;
    }
    var self = this;
    [["bids", newBids], ["asks", newAsks]].forEach(function (pair) {
      var side = pair[0], next = pair[1], cur = book[side];
      var prices = new Set();
      cur.forEach(function (_s, p) { prices.add(p); });
      next.forEach(function (_s, p) { prices.add(p); });
      // Best-first so fills at the top of book are diffed before depth.
      var ordered = Array.from(prices).sort(function (a, b) {
        return side === "bids" ? b - a : a - b;
      });
      ordered.forEach(function (p) {
        var ns = next.has(p) ? next.get(p) : 0;
        // applyLevel mutates book[side]; read `next` sizes, not live map.
        self.applyLevel(token, side, p, ns, opts);
      });
    });
    var sinceSnap = this.now() - book.lastSnapshotMs;
    if ((opts.checkpoint && sinceSnap >= 1000) || sinceSnap >= CHECKPOINT_MS) {
      this.emitSnapshot(token, book, opts);
    }
  };

  /* CLOB price_change: `size` is the new aggregate size at the level. */
  Recorder.prototype.onPriceChange = function (c) {
    if (!this.recording || !c) return;
    var token = String(c.token || c.asset_id || "");
    if (!token) return;
    var sideRaw = String(c.side || "").toUpperCase();
    var side = sideRaw === "BUY" || sideRaw === "BIDS" ? "bids" : "asks";
    this.applyLevel(token, side, num(c.price), num(c.size), {
      source: c.source || "ws_price_change", serverTs: c.serverTs,
    });
    // The envelope's best_bid/best_ask doubles as a quote for this token.
    if (c.bestBid != null || c.bestAsk != null) {
      this.onQuote({ token: token, bid: c.bestBid, ask: c.bestAsk,
        source: "ws_price_change", serverTs: c.serverTs, quiet: true });
    }
  };

  /* Top-of-book update (US lite channel, pollers). Emits only on change;
     `quiet` updates state without a line (level_change already carries
     the same context when it comes from price_change). */
  Recorder.prototype.onQuote = function (q) {
    if (!this.recording || !q || q.token == null) return;
    var token = String(q.token);
    var prev = this.quotes.get(token) || {};
    var next = {
      bid: q.bid != null ? num(q.bid) : (prev.bid != null ? prev.bid : null),
      ask: q.ask != null ? num(q.ask) : (prev.ask != null ? prev.ask : null),
      last: q.last != null ? num(q.last) : (prev.last != null ? prev.last : null),
    };
    var changed = next.bid !== prev.bid || next.ask !== prev.ask || next.last !== prev.last;
    this.quotes.set(token, next);
    if (!changed || q.quiet) return;
    var ev = {
      type: "bbo_change", token: token,
      bid: next.bid, ask: next.ask, last: next.last,
      mid: next.bid != null && next.ask != null ? r6((next.bid + next.ask) / 2) : null,
      spread: next.bid != null && next.ask != null ? r6(next.ask - next.bid) : null,
      source: q.source || null,
    };
    if (q.serverTs != null) ev.t_server_ms = q.serverTs;
    var lt = this.lastTradeByToken.get(token);
    if (lt) { ev.ms_since_last_trade = this.now() - lt.t; ev.last_trade_seq = lt.seq; }
    this.emit(ev);
  };

  Recorder.prototype.pruneRecent = function () {
    var cutoff = this.now() - this.fillWindowMs;
    while (this.recentDecreases.length && this.recentDecreases[0].t < cutoff) {
      this.recentDecreases.shift();
    }
    if (this.recentTrades.length > RECENT_TRADES_KEEP) {
      this.recentTrades.splice(0, this.recentTrades.length - RECENT_TRADES_KEEP);
    }
  };

  /* Trade print (WS last_trade_price). `side` is the taker side; the
     consumed book side is the opposite. Grants fill credit at the trade
     price and links any still-unexplained decrease there (feed order
     can put the book update a few ms before the print). */
  Recorder.prototype.onTrade = function (tr) {
    if (!this.recording || !tr) return;
    var token = String(tr.token || tr.asset_id || "");
    if (!token) return;
    var price = num(tr.price), size = num(tr.size);
    var taker = String(tr.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
    var consumed = taker === "BUY" ? "asks" : "bids";
    var book = this.bookState(token);
    book.last = price;
    this.pruneRecent();
    var linked = [], linkedQty = 0, remaining = size;
    for (var i = 0; i < this.recentDecreases.length && remaining > 0; i++) {
      var d = this.recentDecreases[i];
      if (d.token !== token || d.side !== consumed || d.price !== price) continue;
      var take = Math.min(d.unexplained, remaining);
      d.unexplained -= take; remaining -= take; linkedQty += take;
      if (d.seq != null && linked.indexOf(d.seq) === -1) linked.push(d.seq);
    }
    this.recentDecreases = this.recentDecreases.filter(function (x) {
      return x.unexplained > 0.01;
    });
    var ev = {
      type: "trade", token: token, price: price, size: size,
      size_usd: r6(price * size), taker_side: taker, consumed_side: consumed,
      book: bookContext(book),
      source: tr.source || "ws_last_trade_price",
    };
    if (tr.feeRateBps != null) ev.fee_rate_bps = num(tr.feeRateBps);
    if (tr.txHash) ev.tx_hash = tr.txHash;
    if (tr.serverTs != null) ev.t_server_ms = tr.serverTs;
    if (linked.length) { ev.explains_decrease_seqs = linked; ev.explains_shares = r6(linkedQty); }
    var agg = this.agg(token);
    agg.trades++; agg.trade_shares += size; agg.trade_usd += price * size;
    var emitted = this.emit(ev);
    if (emitted) {
      this.lastTradeByToken.set(token, { seq: emitted.seq, t: this.now() });
      this.recentTrades.push({ seq: emitted.seq, token: token, price: price,
        size: size, t: this.now(), serverTs: tr.serverTs || null,
        txHash: tr.txHash || null });
      // Remaining (not already seen as a decrease) credits future deltas.
      this.addCredit(token, consumed, price, remaining, emitted.seq);
    }
    return emitted;
  };

  /* US gateway stats ride along with book frames. A jump in sharesTraded
     is the only fill signal polymarket.us exposes publicly (no per-trade
     prints, no wallets), so deltas are recorded as their own lines. */
  Recorder.prototype.onMarketStats = function (marketToken, stats, source) {
    if (!this.recording || !stats) return;
    var key = String(marketToken);
    var prev = this.statsBaseline.get(key) || {};
    var ev = { type: "market_stats", token: key, source: source || "us_gateway" };
    var changed = false;
    [["sharesTraded", "shares_traded"], ["notionalTraded", "notional_traded"],
     ["openInterest", "open_interest"]].forEach(function (pair) {
      var v = stats[pair[0]];
      if (v == null) return;
      ev[pair[1]] = num(v);
      if (prev[pair[0]] != null && num(v) !== num(prev[pair[0]])) {
        ev["d_" + pair[1]] = r6(num(v) - num(prev[pair[0]]));
        changed = true;
      }
    });
    if (stats.state) { ev.state = stats.state; if (stats.state !== prev.state) changed = true; }
    this.statsBaseline.set(key, {
      sharesTraded: stats.sharesTraded != null ? stats.sharesTraded : prev.sharesTraded,
      notionalTraded: stats.notionalTraded != null ? stats.notionalTraded : prev.notionalTraded,
      openInterest: stats.openInterest != null ? stats.openInterest : prev.openInterest,
      state: stats.state || prev.state,
    });
    if (changed) this.emit(ev);
  };

  /* One Data API fill row (normalized by PMAPI.fetchWalletTrades).
     Matched to a WS trade print by transaction hash when both carry it,
     else by token + price + size + a 15s server-time window. The row's
     `side` is that wallet's own buy/sell; maker vs taker is not exposed. */
  Recorder.prototype.onWalletTrade = function (r) {
    if (!this.recording || !r || !r.wallet) return;
    var token = String(r.token || "");
    var match = { method: null, trade_seq: null };
    for (var i = this.recentTrades.length - 1; i >= 0; i--) {
      var t = this.recentTrades[i];
      if (t.token !== token) continue;
      if (r.txHash && t.txHash && r.txHash === t.txHash) {
        match = { method: "tx_hash", trade_seq: t.seq }; break;
      }
      if (match.method) continue;
      var tRef = t.serverTs != null ? t.serverTs : t.t;
      var close = r.tsMs != null && Math.abs(tRef - r.tsMs) <= 15000;
      if (close && t.price === num(r.price) &&
          Math.abs(t.size - num(r.size)) <= Math.max(0.01, num(r.size) * 0.001)) {
        match = { method: "price_size_time", trade_seq: t.seq };
        // Keep scanning: an exact tx match further back beats this.
        if (!r.txHash) break;
      }
    }
    var ev = {
      type: "wallet_trade", token: token,
      wallet: String(r.wallet),
      side: String(r.side || "").toUpperCase() || null,
      price: num(r.price), size: num(r.size), size_usd: r6(num(r.price) * num(r.size)),
      condition_id: r.conditionId || null,
      outcome: r.outcome != null ? r.outcome : null,
      outcome_index: r.outcomeIndex != null ? r.outcomeIndex : null,
      name: r.name || null, pseudonym: r.pseudonym || null,
      tx_hash: r.txHash || null,
      match: match,
      source: "data_api_v2_trades",
    };
    if (r.tsMs != null) { ev.t_server_ms = r.tsMs; ev.lag_ms = this.now() - r.tsMs; }
    var w = this.walletAgg.get(ev.wallet);
    if (!w) {
      w = { trades: 0, buy_shares: 0, buy_usd: 0, sell_shares: 0, sell_usd: 0,
        pseudonyms: {}, names: {}, tokens: {}, first_ms: this.now(), last_ms: this.now() };
      this.walletAgg.set(ev.wallet, w);
    }
    w.trades++;
    w.last_ms = this.now();
    if (ev.pseudonym) w.pseudonyms[ev.pseudonym] = 1;
    if (ev.name) w.names[ev.name] = 1;
    if (token) w.tokens[token] = 1;
    if (ev.side === "BUY") { w.buy_shares += ev.size; w.buy_usd += ev.size_usd; }
    else if (ev.side === "SELL") { w.sell_shares += ev.size; w.sell_usd += ev.size_usd; }
    return this.emit(ev);
  };

  /* ---------- summary + export ---------- */
  Recorder.prototype.summarize = function () {
    var tokens = {};
    this.tokenAgg.forEach(function (a, token) {
      tokens[token] = {
        meta: this.tokenMeta.get(token) || null,
        snapshots: a.snapshots, level_changes: a.level_changes,
        new_levels: a.new_levels, increases: a.increases,
        decreases: a.decreases, removed: a.removed,
        added_shares: r6(a.added_shares), removed_shares: r6(a.removed_shares),
        likely_fill_shares: r6(a.likely_fill_shares),
        likely_cancel_shares: r6(a.likely_cancel_shares),
        trades: a.trades, trade_shares: r6(a.trade_shares),
        trade_usd: r6(a.trade_usd),
        first_ms: a.first_ms, last_ms: a.last_ms,
      };
    }, this);
    var levels = Array.from(this.levelAgg.values()).map(function (a) {
      return { token: a.token, side: a.side, price: a.price, changes: a.changes,
        added_shares: r6(a.added_shares), removed_shares: r6(a.removed_shares),
        peak_size: a.peak_size, likely_fill_shares: r6(a.likely_fill_shares),
        likely_cancel_shares: r6(a.likely_cancel_shares),
        first_ms: a.first_ms, last_ms: a.last_ms };
    });
    levels.sort(function (x, y) { return y.changes - x.changes; });
    var wallets = {};
    this.walletAgg.forEach(function (w, addr) {
      wallets[addr] = {
        trades: w.trades,
        buy_shares: r6(w.buy_shares), buy_usd: r6(w.buy_usd),
        sell_shares: r6(w.sell_shares), sell_usd: r6(w.sell_usd),
        pseudonyms: Object.keys(w.pseudonyms), names: Object.keys(w.names),
        tokens: Object.keys(w.tokens), first_ms: w.first_ms, last_ms: w.last_ms,
      };
    });
    return {
      tokens: tokens,
      levels_by_churn: levels.slice(0, 100),
      levels_tracked: levels.length,
      wallets: wallets,
      wallet_count: Object.keys(wallets).length,
    };
  };

  Recorder.prototype.stop = function (reason, extra) {
    if (!this.recording) return null;
    this.endedAtMs = this.now();
    var summary = this.summarize();
    // Emit while still recording so the line gets seq/timestamps. `extra`
    // carries caller-owned coverage stats (e.g. wallet-poll freshness).
    this.emit(Object.assign({
      type: "session_end",
      ended_at: new Date(this.endedAtMs).toISOString(),
      duration_ms: this.endedAtMs - this.startedAtMs,
      reason: reason || "user",
      truncated: this.truncated,
      counts: Object.assign({}, this.counts, { session_end: 1 }),
      events: this.lines.length + 1,
    }, summary, extra || {}));
    this.recording = false;
    return summary;
  };

  Recorder.prototype.toNDJSON = function () {
    return this.lines.join("\n") + (this.lines.length ? "\n" : "");
  };

  var PMRecorder = {
    SCHEMA: SCHEMA,
    Recorder: Recorder,
    createRecorder: function (opts) { return new Recorder(opts); },
    walletTradeKey: walletTradeKey,
    _test: { levelsToMap: levelsToMap, mapToLevels: mapToLevels, r6: r6 },
  };
  root.PMRecorder = PMRecorder;
  if (typeof module !== "undefined" && module.exports) module.exports = PMRecorder;
})(typeof window !== "undefined" ? window : globalThis);
