/* Polymarket data layer for both exchanges:
   - international: Gamma + CLOB REST, live WebSocket (polymarket.com)
   - US: public gateway REST (polymarket.us, slug-based, polled book)
   Exposed as window.PMAPI; also loadable in Node for unit tests. */
(function (root) {
  "use strict";

  var GAMMA = "https://gamma-api.polymarket.com";
  var CLOB = "https://clob.polymarket.com";
  var DATA_API = "https://data-api.polymarket.com";
  var WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  var US_GATEWAY = "https://gateway.polymarket.us";

  /* ---------- fetch: via background proxy when available ---------- */
  function fetchJSON(url) {
    var viaBg =
      typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage &&
      !root.__PM_DIRECT_FETCH__;
    if (viaBg) {
      return new Promise(function (resolve, reject) {
        try {
          chrome.runtime.sendMessage({ type: "PM_FETCH", url: url }, function (res) {
            var err = chrome.runtime.lastError;
            if (err) return directFetch(url).then(resolve, reject);
            if (res && res.ok) resolve(res.data);
            else reject(new Error((res && res.error) || "Fetch failed"));
          });
        } catch (e) {
          directFetch(url).then(resolve, reject);
        }
      });
    }
    return directFetch(url);
  }

  function directFetch(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url.split("?")[0]);
      return r.json();
    });
  }

  /* ---------- URL parsing ---------- */
  /* Accepts (source "intl" = polymarket.com, "us" = polymarket.us):
       polymarket.com/event/<event-slug>[/<market-slug>]
       polymarket.com/market/<market-slug>
       polymarket.us/event/<event-slug>
       polymarket.us/sports/<league>/<event-slug>
       polymarket.us/market/<market-slug>
       a bare slug (source unset: loader tries intl, then US). */
  function parsePolymarketUrl(input) {
    if (!input) return null;
    var s = String(input).trim();
    if (!s) return null;
    if (/^[a-z0-9][a-z0-9\-]*$/i.test(s)) return { source: null, kind: "event", slug: s };
    var u;
    try {
      u = new URL(s.indexOf("://") === -1 ? "https://" + s : s);
    } catch (e) {
      return null;
    }
    var host = u.hostname.toLowerCase();
    var source = /(^|\.)polymarket\.us$/.test(host) ? "us"
      : /(^|\.)polymarket\.com$/.test(host) ? "intl" : null;
    var parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 0) return null;
    if (parts[0] === "event" && parts[1]) {
      return { source: source, kind: "event", slug: parts[1], marketSlug: parts[2] || null };
    }
    if (parts[0] === "market" && parts[1]) {
      return { source: source, kind: "market", slug: parts[1] };
    }
    if (parts[0] === "sports" && parts.length >= 2) {
      return { source: source || "us", kind: "event", slug: parts[parts.length - 1] };
    }
    return { source: source, kind: "event", slug: parts[parts.length - 1] };
  }

  function toArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try { var p = JSON.parse(v); return Array.isArray(p) ? p : []; }
      catch (e) { return []; }
    }
    return [];
  }

  function num(v, fallback) {
    var n = typeof v === "string" ? parseFloat(v) : v;
    return typeof n === "number" && isFinite(n) ? n : (fallback || 0);
  }

  function normalizeMarket(m) {
    var outcomes = toArray(m.outcomes);
    var prices = toArray(m.outcomePrices).map(function (p) { return num(p); });
    var tokens = toArray(m.clobTokenIds).map(String);
    return {
      id: String(m.id || m.conditionId || m.slug || ""),
      conditionId: m.conditionId || null,
      tick: m.orderPriceMinTickSize != null ? num(m.orderPriceMinTickSize) : null,
      slug: m.slug || "",
      question: m.question || "",
      label: m.groupItemTitle || m.question || m.slug || "Market",
      image: m.image || m.icon || null,
      outcomes: outcomes.length ? outcomes : ["Yes", "No"],
      prices: prices,
      tokens: tokens,
      volume: num(m.volumeNum != null ? m.volumeNum : m.volume),
      volume24hr: num(m.volume24hr),
      liquidity: num(m.liquidityNum != null ? m.liquidityNum : m.liquidity),
      bestBid: m.bestBid != null ? num(m.bestBid) : null,
      bestAsk: m.bestAsk != null ? num(m.bestAsk) : null,
      lastTradePrice: m.lastTradePrice != null ? num(m.lastTradePrice) : null,
      spread: m.spread != null ? num(m.spread) : null,
      active: m.active !== false,
      closed: !!m.closed,
      acceptingOrders: m.acceptingOrders !== false,
      oneDayPriceChange: m.oneDayPriceChange != null ? num(m.oneDayPriceChange) : null,
      marketType: m.sportsMarketType || null,
      source: "intl",
    };
  }

  /* Leg order for intl events. Sports events (markets tagged with
     sportsMarketType) list the moneyline first, then by volume traded;
     everything else is sorted by price like polymarket.com. */
  function orderIntlMarkets(markets) {
    var sports = markets.some(function (m) { return !!m.marketType; });
    var idx = new Map(markets.map(function (m, i) { return [m, i]; }));
    return markets.slice().sort(sports
      ? function (a, b) {
        var ma = a.marketType === "moneyline" ? 0 : 1, mb = b.marketType === "moneyline" ? 0 : 1;
        return ma - mb || (b.volume || 0) - (a.volume || 0) || idx.get(a) - idx.get(b);
      }
      : function (a, b) {
        return (b.prices[0] || 0) - (a.prices[0] || 0) || idx.get(a) - idx.get(b);
      });
  }

  function normalizeEvent(ev, fallbackTitle) {
    var markets = orderIntlMarkets((ev.markets || []).map(normalizeMarket)
      .filter(function (m) { return m.tokens.length > 0; }));
    return {
      id: String(ev.id || ""),
      slug: ev.slug || "",
      title: ev.title || fallbackTitle || "Polymarket market",
      image: ev.image || ev.icon || (markets[0] && markets[0].image) || null,
      volume: num(ev.volume),
      liquidity: num(ev.liquidity),
      endDate: ev.endDate || ev.end_date || null,
      closed: !!ev.closed,
      markets: markets,
      source: "intl",
    };
  }

  /* ---------- Gamma lookups ---------- */
  function fetchEventBySlug(slug) {
    return fetchJSON(GAMMA + "/events/slug/" + encodeURIComponent(slug)).then(function (ev) {
      if (!ev || !ev.markets) throw new Error("Event not found: " + slug);
      return normalizeEvent(ev);
    });
  }

  function fetchMarketBySlug(slug) {
    return fetchJSON(GAMMA + "/markets/slug/" + encodeURIComponent(slug)).then(function (m) {
      if (!m || !m.id) throw new Error("Market not found: " + slug);
      var market = normalizeMarket(m);
      if (Array.isArray(m.events) && m.events[0] && m.events[0].slug) {
        return fetchEventBySlug(m.events[0].slug).then(function (ev) {
          ev.focusSlug = slug;
          return ev;
        }).catch(function () { return singleMarketEvent(market); });
      }
      return singleMarketEvent(market);
    });
  }

  function singleMarketEvent(market) {
    return {
      id: market.id, slug: market.slug, title: market.question || market.label,
      image: market.image, volume: market.volume, liquidity: market.liquidity,
      endDate: null, closed: market.closed, markets: [market],
      source: market.source || "intl",
    };
  }

  /* ================= US (polymarket.us, public gateway) =================
     Slug-based, single book per market (bids/offers on the long side);
     the short side is the mirror book. No public WebSocket (the authed
     API needs Ed25519 keys), so the overlay polls the book. */
  function moneyVal(m) {
    if (m == null) return null;
    if (typeof m === "object") return m.value != null ? num(m.value) : null;
    return num(m);
  }

  function normalizeUSMarket(m) {
    var sides = (m.marketSides || []).slice().sort(function (a, b) {
      return (b.long ? 1 : 0) - (a.long ? 1 : 0);
    });
    var outcomes = sides.length
      ? sides.map(function (s) { return s.description || (s.long ? "Yes" : "No"); })
      : toArray(m.outcomes);
    if (!outcomes.length) outcomes = ["Yes", "No"];
    // outcomePrices is [bestBid, bestAsk] of the long book on live markets
    // (it sums to ~1 only on settled ones, where it is [1, 0] / [0, 1]).
    var raw = toArray(m.outcomePrices).map(function (p) { return num(p); });
    var bid = moneyVal(m.bestBidQuote), ask = moneyVal(m.bestAskQuote);
    var yes = null;
    if (bid != null && ask != null && (bid > 0 || ask > 0)) yes = (bid + ask) / 2;
    else if (raw.length >= 2) {
      var sum = raw[0] + raw[1];
      yes = sum >= 0.95 && sum <= 1.05 ? raw[0] : (raw[0] + raw[1]) / 2;
      if (!(sum >= 0.95 && sum <= 1.05)) { bid = raw[0]; ask = raw[1]; }
    } else if (raw.length === 1) yes = raw[0];
    if (yes != null) yes = Math.min(1, Math.max(0, yes));
    var slug = m.slug || "";
    return {
      id: "us:" + String(m.id || slug),
      slug: slug,
      usSlug: slug,
      question: m.question || "",
      label: m.titleShort || m.title || m.question || slug || "Market",
      image: m.image || null,
      outcomes: outcomes,
      prices: yes != null ? [yes, 1 - yes] : [],
      tokens: ["us:" + slug + ":0", "us:" + slug + ":1"],
      volume: null,          // filled from book stats (notionalTraded) when fetched
      volume24hr: null,
      liquidity: null,
      bestBid: bid, bestAsk: ask,
      lastTradePrice: null,
      spread: bid != null && ask != null ? ask - bid : null,
      tick: m.orderPriceMinTickSize != null ? num(m.orderPriceMinTickSize) : null,
      active: m.active !== false,
      closed: !!m.closed,
      acceptingOrders: m.active !== false && !m.closed,
      oneDayPriceChange: null,
      usId: m.id != null ? String(m.id) : null,
      marketType: m.sportsMarketTypeV2 || m.marketType || null,
      line: m.line != null ? num(m.line) : null,
      source: "us",
    };
  }

  function isUSMoneyline(m) {
    return m.marketType === "SPORTS_MARKET_TYPE_MONEYLINE" || m.marketType === "moneyline";
  }

  /* Leg order for US events, following the polymarket.us page layout via
     the event's marketGroups tree (PRIMARY = moneyline, then Game Lines,
     Player Props, ...). Pass 1 takes each leaf group's headline market(s):
     the line(s) nearest the group's main `line`, or every market when the
     group has no main line. Pass 2 adds the rest of each group's ladder,
     nearest-to-main first. Ungrouped markets follow. Without marketGroups:
     moneyline first, then API order (or price, if the event sorts by price). */
  function orderUSMarkets(markets, groups, sortType) {
    var byId = new Map();
    markets.forEach(function (m) { if (m.usId) byId.set(m.usId, m); });
    var out = [], seen = new Set();
    function add(m) { if (m && !seen.has(m)) { seen.add(m); out.push(m); } }

    if (Array.isArray(groups) && groups.length) {
      var kids = new Map();
      groups.forEach(function (g, i) {
        var k = g.parentId || "";
        if (!kids.has(k)) kids.set(k, []);
        kids.get(k).push({ g: g, i: i });
      });
      var leaves = [];
      (function walk(parent) {
        (kids.get(parent) || []).sort(function (a, b) {
          return (a.g.order || 0) - (b.g.order || 0) || a.i - b.i;
        }).forEach(function (n) {
          var ms = (n.g.marketIds || []).map(function (id) { return byId.get(String(id)); })
            .filter(Boolean);
          if (ms.length) leaves.push({ g: n.g, ms: ms });
          walk(n.g.id);
        });
      })("");
      leaves.forEach(function (leaf) {
        var main = leaf.g.line;
        if (main == null) { leaf.rest = []; leaf.ms.forEach(add); return; }
        var dist = function (m) { return m.line == null ? Infinity : Math.abs(Math.abs(m.line) - main); };
        var ranked = leaf.ms.map(function (m, i) { return { m: m, d: dist(m), i: i }; })
          .sort(function (a, b) { return a.d - b.d || a.i - b.i; });
        var best = ranked[0].d;
        ranked.forEach(function (r) { if (r.d === best) add(r.m); });
        leaf.rest = ranked.map(function (r) { return r.m; });
      });
      leaves.forEach(function (leaf) { leaf.rest.forEach(add); });
    }

    var restList = markets.filter(function (m) { return !seen.has(m); });
    if (!out.length && sortType === "price") {
      restList.sort(function (a, b) { return (b.prices[0] || 0) - (a.prices[0] || 0); });
    }
    restList.filter(isUSMoneyline).forEach(add);
    restList.forEach(add);
    return out;
  }

  function normalizeUSEvent(ev) {
    var markets = orderUSMarkets((ev.markets || []).map(normalizeUSMarket)
      .filter(function (m) { return !!m.usSlug; }), ev.marketGroups, ev.sortType);
    return {
      id: "us:" + String(ev.id || ev.slug || ""),
      slug: ev.slug || "",
      title: ev.title || "Polymarket US market",
      image: ev.image || (markets[0] && markets[0].image) || null,
      volume: null,
      liquidity: null,
      endDate: ev.endDate || null,
      closed: !!ev.closed,
      markets: markets,
      source: "us",
      sourceUrl: ev.slug ? "https://polymarket.us/event/" + encodeURIComponent(ev.slug) : "https://polymarket.us",
    };
  }

  function fetchUSEventBySlug(slug) {
    return fetchJSON(US_GATEWAY + "/v1/events?slug=" + encodeURIComponent(slug)).then(function (d) {
      var ev = d && d.events && d.events[0];
      if (!ev) throw new Error("US event not found: " + slug);
      return normalizeUSEvent(ev);
    });
  }

  function fetchUSMarketBySlug(slug) {
    return fetchJSON(US_GATEWAY + "/v1/markets?slug=" + encodeURIComponent(slug)).then(function (d) {
      var m = d && d.markets && d.markets[0];
      if (!m) throw new Error("US market not found: " + slug);
      var market = normalizeUSMarket(m);
      var ev = singleMarketEvent(market);
      ev.title = market.question && market.question !== market.label
        ? market.question : market.label;
      ev.sourceUrl = "https://polymarket.us";
      return ev;
    });
  }

  function usLevels(levels, mirror) {
    return (levels || []).map(function (l) {
      var p = moneyVal(l.px);
      return { price: mirror && p != null ? +(1 - p).toFixed(4) : p, size: num(l.qty) };
    }).filter(function (l) { return l.price != null && l.size > 0; });
  }

  /* MarketData (REST /book or the realtime MARKET_DATA channel) ->
     snapshots for BOTH outcome tokens (side 1 = mirrored book). */
  function parseUSMarketData(md) {
    md = md || {};
    var stats = md.stats || {};
    var last = moneyVal(stats.lastTradePx);
    var meta = {
      notionalTraded: moneyVal(stats.notionalTraded),
      sharesTraded: stats.sharesTraded != null ? num(stats.sharesTraded) : null,
      openInterest: stats.openInterest != null ? num(stats.openInterest) : null,
      state: md.state || null,
    };
    var bids = usLevels(md.bids, false), asks = usLevels(md.offers, false);
    return {
      slug: md.marketSlug || null,
      meta: meta,
      sides: [
        { bids: bids, asks: asks, lastTradePrice: last },
        { bids: usLevels(md.offers, true), asks: usLevels(md.bids, true),
          lastTradePrice: last != null ? +(1 - last).toFixed(4) : null },
      ],
    };
  }

  /* REST fallback. The gateway sits behind a 30s Cloudflare cache
     (cache-control: public, max-age=30), so bust it or we poll stale books. */
  function fetchUSBook(usSlug) {
    return fetchJSON(US_GATEWAY + "/v1/markets/" + encodeURIComponent(usSlug) + "/book?_=" + Date.now())
      .then(function (d) { return parseUSMarketData(d && d.marketData); });
  }

  /* MarketDataLite (realtime MARKET_DATA_LITE channel) -> top of book. */
  function parseUSMarketDataLite(p) {
    p = p || {};
    return {
      slug: p.marketSlug || null,
      bestBid: moneyVal(p.bestBid),
      bestAsk: moneyVal(p.bestAsk),
      last: moneyVal(p.lastTradePx),
      current: moneyVal(p.currentPx),
      sharesTraded: p.sharesTraded != null ? num(p.sharesTraded) : null,
    };
  }

  /* ---------- US realtime stream ----------
     The same anonymous feed polymarket.us uses for logged-out visitors:
     a Connect-protocol server stream (JSON codec) of
     gateway.realtime.v1.RealtimeService/Stream. Each frame is
     [flags:u8][len:u32be][json]; flags&2 marks the end-of-stream trailer.
     MARKET_DATA pushes the full book (~10/s while active), MARKET_DATA_LITE
     pushes top of book. Anonymous sessions can't edit channels, so a
     channel change reopens the stream (debounced), like the site does. */
  var US_REALTIME = "https://gateway-ws-markets.polymarket.us";
  var US_STREAM_PATH = "/gateway.realtime.v1.RealtimeService/Stream";

  function uuid4() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }

  function usChannel(type, slug) {
    return { id: { value: type + ":" + slug }, type: type, resource: slug };
  }

  function encodeConnectFrame(obj) {
    var body = new TextEncoder().encode(JSON.stringify(obj));
    var out = new Uint8Array(5 + body.length);
    new DataView(out.buffer).setUint32(1, body.length);
    out.set(body, 5);
    return out;
  }

  /* Incremental frame decoder: push(bytes) -> [{end, msg}] for each
     complete frame; partial frames are buffered for the next chunk. */
  function ConnectFrameDecoder() {
    this.buf = new Uint8Array(0);
    this.td = new TextDecoder();
  }
  ConnectFrameDecoder.prototype.push = function (chunk) {
    var b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf, 0); b.set(chunk, this.buf.length);
    var out = [], off = 0;
    while (b.length - off >= 5) {
      var len = new DataView(b.buffer, b.byteOffset + off + 1, 4).getUint32(0);
      if (b.length - off - 5 < len) break;
      var flags = b[off];
      var text = this.td.decode(b.subarray(off + 5, off + 5 + len));
      var msg = null;
      try { msg = text ? JSON.parse(text) : {}; } catch (e) { msg = null; }
      out.push({ end: !!(flags & 2), msg: msg });
      off += 5 + len;
    }
    this.buf = b.slice(off);
    return out;
  };

  function USMarketStream(onMessage, onStatus) {
    this.onMessage = onMessage;            // ({kind:"book"|"lite", ...parsed})
    this.onStatus = onStatus || function () {};
    this.book = [];                        // slugs with full-book channel
    this.lite = [];                        // slugs with top-of-book channel
    this.key = "";
    this.abort = null;
    this.closed = false;
    this.gen = 0;
    this.backoffMs = 800;
    this.reopenTimer = null;
    this.watchdog = null;
    this.live = false;
  }

  USMarketStream.MAX_CHANNELS = 60;
  USMarketStream.STALL_MS = 45000;   // server heartbeats every 30s

  /* Desired channels; reopens (debounced) only when the set changes. */
  USMarketStream.prototype.setChannels = function (bookSlugs, liteSlugs) {
    var book = Array.from(new Set((bookSlugs || []).filter(Boolean).map(String)));
    var bookSet = new Set(book);
    var lite = Array.from(new Set((liteSlugs || []).filter(Boolean).map(String)))
      .filter(function (s) { return !bookSet.has(s); }); // full book already carries top of book
    lite = lite.slice(0, Math.max(0, USMarketStream.MAX_CHANNELS - book.length));
    var key = book.slice().sort().join(",") + "|" + lite.slice().sort().join(",");
    if (key === this.key) return;
    this.key = key; this.book = book; this.lite = lite;
    this.scheduleOpen(this.abort ? 250 : 0);
  };

  USMarketStream.prototype.scheduleOpen = function (ms) {
    var self = this;
    if (this.closed) return;
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(function () { self.open(); }, ms);
  };

  USMarketStream.prototype.setLive = function (on, status) {
    this.live = on;
    this.onStatus(status || (on ? "live" : "reconnecting"));
  };

  USMarketStream.prototype.kick = function (gen) {
    var self = this;
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(function () {
      if (gen !== self.gen || self.closed) return;
      if (self.abort) self.abort.abort();   // stalled: the read loop reconnects
    }, USMarketStream.STALL_MS);
  };

  USMarketStream.prototype.open = function () {
    var self = this;
    if (this.closed) return;
    var gen = ++this.gen;
    if (this.abort) { try { this.abort.abort(); } catch (e) {} }
    clearTimeout(this.watchdog);
    if (!this.book.length && !this.lite.length) { this.abort = null; this.setLive(false, "idle"); return; }
    var ctl = new AbortController();
    this.abort = ctl;
    var channels = this.book.map(function (s) { return usChannel("CHANNEL_TYPE_MARKET_DATA", s); })
      .concat(this.lite.map(function (s) { return usChannel("CHANNEL_TYPE_MARKET_DATA_LITE", s); }));
    var gotData = false;
    this.kick(gen);
    fetch(US_REALTIME + US_STREAM_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/connect+json", "Connect-Protocol-Version": "1" },
      body: encodeConnectFrame({ sessionId: { value: uuid4() }, initialChannels: channels }),
      signal: ctl.signal,
      cache: "no-store",
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error("US stream HTTP " + res.status);
      var reader = res.body.getReader();
      var dec = new ConnectFrameDecoder();
      function pump() {
        return reader.read().then(function (r) {
          if (gen !== self.gen) { try { reader.cancel(); } catch (e) {} return; }
          if (r.done) throw new Error("US stream ended");
          self.kick(gen);
          var frames = dec.push(r.value);
          for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            if (f.end) throw new Error("US stream closed" + (f.msg && f.msg.error ? ": " + (f.msg.error.message || f.msg.error.code) : ""));
            if (!f.msg) continue;
            if (!gotData) { gotData = true; self.backoffMs = 800; self.setLive(true); }
            self.handle(f.msg);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      if (gen !== self.gen || self.closed) return;   // superseded by a reopen
      self.setLive(false);
      self.scheduleOpen(self.backoffMs);
      self.backoffMs = Math.min(self.backoffMs * 2, 15000);
    });
  };

  USMarketStream.prototype.handle = function (m) {
    var u = m.update;
    if (u && u.payload) {
      try {
        if (u.type === "UPDATE_TYPE_MARKET_DATA") {
          var b = parseUSMarketData(u.payload); b.kind = "book"; this.onMessage(b);
        } else if (u.type === "UPDATE_TYPE_MARKET_DATA_LITE") {
          var l = parseUSMarketDataLite(u.payload); l.kind = "lite"; this.onMessage(l);
        }
      } catch (e) { /* keep the stream alive */ }
    } else if (m.control && (m.control.type === "CONTROL_TYPE_STREAM_REPLACED" ||
                             m.control.type === "CONTROL_TYPE_RESYNC_REQUIRED")) {
      this.scheduleOpen(0);
    }
  };

  USMarketStream.prototype.close = function () {
    this.closed = true;
    this.gen++;
    clearTimeout(this.reopenTimer);
    clearTimeout(this.watchdog);
    if (this.abort) { try { this.abort.abort(); } catch (e) {} this.abort = null; }
  };

  var US_HISTORY_PARAMS = {
    "1H": { interval: "INTERVAL_1H", fidelity: 2 },
    "6H": { interval: "INTERVAL_6H", fidelity: 10 },
    "1D": { interval: "INTERVAL_1D", fidelity: 15 },
    "1W": { interval: "INTERVAL_1W", fidelity: 60 },
    "1M": { interval: "INTERVAL_1M", fidelity: 240 },
    "ALL": { interval: "INTERVAL_ALL", fidelity: 720 },
  };

  function fetchUSHistory(usSlug, range, sideIdx) {
    var p = US_HISTORY_PARAMS[range] || US_HISTORY_PARAMS["1D"];
    var url = US_GATEWAY + "/v1/price-history?symbol=" + encodeURIComponent(usSlug) +
      "&fidelity=" + p.fidelity + "&fixed_interval=" + p.interval;
    return fetchJSON(url).then(function (d) {
      return (d.history || []).map(function (pt) {
        return { t: pt.timestamp * 1000, p: num(sideIdx === 1 ? pt.shortPrice : pt.longPrice) };
      }).filter(function (pt) { return pt.p > 0 && pt.p < 1 || pt.p === 0 || pt.p === 1; });
    });
  }

  /* ---------- unified loader ---------- */
  function loadIntl(parsed) {
    if (parsed.kind === "market") return fetchMarketBySlug(parsed.slug);
    return fetchEventBySlug(parsed.slug).then(function (ev) {
      if (parsed.marketSlug) ev.focusSlug = parsed.marketSlug;
      ev.sourceUrl = "https://polymarket.com/event/" + encodeURIComponent(ev.slug || parsed.slug);
      return ev;
    }).catch(function () {
      return fetchMarketBySlug(parsed.slug).then(function (ev) {
        if (!ev.sourceUrl) ev.sourceUrl = "https://polymarket.com";
        return ev;
      });
    });
  }

  function loadUS(parsed) {
    if (parsed.kind === "market") return fetchUSMarketBySlug(parsed.slug);
    return fetchUSEventBySlug(parsed.slug).then(function (ev) {
      if (parsed.marketSlug) ev.focusSlug = parsed.marketSlug;
      return ev;
    }).catch(function () {
      return fetchUSMarketBySlug(parsed.slug);
    });
  }

  function loadFromUrl(input) {
    var parsed = parsePolymarketUrl(input);
    if (!parsed) return Promise.reject(new Error("That doesn't look like a Polymarket URL."));
    if (parsed.source === "us") return loadUS(parsed);
    if (parsed.source === "intl") return loadIntl(parsed);
    return loadIntl(parsed).catch(function () { return loadUS(parsed); });
  }

  /* ---------- CLOB REST ---------- */
  function sortLevels(levels, side) {
    var out = (levels || []).map(function (l) {
      return { price: num(l.price), size: num(l.size) };
    }).filter(function (l) { return l.size > 0; });
    out.sort(function (a, b) { return side === "bids" ? b.price - a.price : a.price - b.price; });
    return out;
  }

  function fetchBook(tokenId) {
    return fetchJSON(CLOB + "/book?token_id=" + encodeURIComponent(tokenId)).then(function (b) {
      return {
        assetId: String(b.asset_id || tokenId),
        bids: sortLevels(b.bids, "bids"),
        asks: sortLevels(b.asks, "asks"),
        tickSize: num(b.tick_size, 0.01),
        lastTradePrice: b.last_trade_price != null ? num(b.last_trade_price) : null,
        hash: b.hash || null,             // book content hash (frame dedupe)
        market: b.market || null,         // conditionId
        serverTs: b.timestamp != null ? num(b.timestamp) : null,
        ts: Date.now(),
      };
    });
  }

  var HISTORY_PARAMS = {
    "1H": { interval: "1h", fidelity: 1 },
    "6H": { interval: "6h", fidelity: 5 },
    "1D": { interval: "1d", fidelity: 15 },
    "1W": { interval: "1w", fidelity: 60 },
    "1M": { interval: "1m", fidelity: 240 },
    "ALL": { interval: "max", fidelity: 720 },
  };

  function fetchHistory(tokenId, range) {
    var p = HISTORY_PARAMS[range] || HISTORY_PARAMS["1D"];
    var url = CLOB + "/prices-history?market=" + encodeURIComponent(tokenId) +
      "&interval=" + p.interval + "&fidelity=" + p.fidelity;
    return fetchJSON(url).then(function (d) {
      return (d.history || []).map(function (pt) { return { t: pt.t * 1000, p: num(pt.p) }; });
    });
  }

  /* ---------- Data API v2: public fills with wallet attribution ----------
     GET /v2/trades?condition=<conditionId,...> (max 20 per call) returns
     {data: [...], pagination}, newest first. Each row is one wallet's
     executed trade: proxy_wallet + pseudonym + transaction_hash. It does
     not say whether the wallet was maker or taker, and rows land seconds
     after the match. (v1 /trades retired 2026-11-02; do not use it.)
     No polymarket.us equivalent exists. */
  function pickField(row, snake, camel) {
    return row[snake] != null ? row[snake] : row[camel];
  }

  function normalizeWalletTrade(row) {
    if (!row || typeof row !== "object") return null;
    var wallet = pickField(row, "proxy_wallet", "proxyWallet");
    var ts = row.timestamp;
    return {
      wallet: wallet ? String(wallet) : null,
      side: row.side || null,
      token: String(pickField(row, "token_id", "asset") || ""),
      conditionId: pickField(row, "condition_id", "conditionId") || null,
      size: num(row.size),
      price: num(row.price),
      tsMs: ts != null ? num(ts) * 1000 : null,   // API timestamps are seconds
      outcome: row.outcome != null ? row.outcome : null,
      outcomeIndex: pickField(row, "outcome_index", "outcomeIndex") != null
        ? num(pickField(row, "outcome_index", "outcomeIndex")) : null,
      name: row.name || null,
      pseudonym: row.pseudonym || null,
      txHash: pickField(row, "transaction_hash", "transactionHash") || null,
    };
  }

  function fetchWalletTrades(conditionIds, limit) {
    var ids = Array.from(new Set((conditionIds || []).filter(Boolean).map(String)));
    if (!ids.length) return Promise.resolve({ trades: [], hasMore: false });
    var chunks = [];
    for (var i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
    var lim = limit || 100;
    return Promise.all(chunks.map(function (chunk) {
      var url = DATA_API + "/v2/trades?condition=" +
        encodeURIComponent(chunk.join(",")) + "&limit=" + lim;
      return fetchJSON(url).then(function (d) {
        var rows = Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : []);
        return {
          trades: rows.map(normalizeWalletTrade).filter(function (r) { return r && r.wallet; }),
          hasMore: !!(d && d.pagination && d.pagination.has_more),
        };
      });
    })).then(function (parts) {
      var trades = [], hasMore = false;
      parts.forEach(function (p) { trades = trades.concat(p.trades); hasMore = hasMore || p.hasMore; });
      trades.sort(function (a, b) { return (a.tsMs || 0) - (b.tsMs || 0); });
      return { trades: trades, hasMore: hasMore };
    });
  }

  /* ---------- Live WebSocket (CLOB market channel) ---------- */
  function MarketSocket(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus || function () {};
    this.ws = null;
    this.assets = new Set();
    this.closed = false;
    this.reconnectMs = 800;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  MarketSocket.prototype.connect = function () {
    if (this.ws || this.closed) return;
    var self = this;
    var ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = function () {
      self.reconnectMs = 800;
      self.onStatus("live");
      if (self.assets.size) {
        ws.send(JSON.stringify({ assets_ids: Array.from(self.assets), type: "market" }));
      }
      clearInterval(self.pingTimer);
      self.pingTimer = setInterval(function () {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10000);
    };
    ws.onmessage = function (ev) {
      if (ev.data === "PONG") return;
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      (Array.isArray(data) ? data : [data]).forEach(function (m) {
        try { self.onMessage(m); } catch (e) { /* keep socket alive */ }
      });
    };
    ws.onclose = function () {
      clearInterval(self.pingTimer);
      self.ws = null;
      if (!self.closed) { self.onStatus("reconnecting"); self.scheduleReconnect(); }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  };

  MarketSocket.prototype.scheduleReconnect = function () {
    var self = this;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(function () { self.connect(); }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, 15000);
  };

  MarketSocket.prototype.subscribe = function (ids) {
    var fresh = [];
    var self = this;
    ids.forEach(function (id) {
      id = String(id);
      if (!self.assets.has(id)) { self.assets.add(id); fresh.push(id); }
    });
    if (!fresh.length) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ assets_ids: fresh, operation: "subscribe" }));
    } else {
      this.connect();
    }
  };

  MarketSocket.prototype.unsubscribe = function (ids) {
    var gone = [];
    var self = this;
    ids.forEach(function (id) {
      id = String(id);
      if (self.assets.delete(id)) gone.push(id);
    });
    if (gone.length && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ assets_ids: gone, operation: "unsubscribe" }));
    }
  };

  MarketSocket.prototype.close = function () {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
  };

  var PMAPI = {
    GAMMA: GAMMA, CLOB: CLOB, WS_URL: WS_URL, US_GATEWAY: US_GATEWAY, DATA_API: DATA_API,
    parsePolymarketUrl: parsePolymarketUrl,
    loadFromUrl: loadFromUrl,
    fetchBook: fetchBook,
    fetchWalletTrades: fetchWalletTrades,
    normalizeWalletTrade: normalizeWalletTrade,
    fetchHistory: fetchHistory,
    fetchUSBook: fetchUSBook,
    fetchUSHistory: fetchUSHistory,
    parseUSMarketData: parseUSMarketData,
    parseUSMarketDataLite: parseUSMarketDataLite,
    ConnectFrameDecoder: ConnectFrameDecoder,
    encodeConnectFrame: encodeConnectFrame,
    USMarketStream: USMarketStream,
    US_REALTIME: US_REALTIME,
    sortLevels: sortLevels,
    normalizeEvent: normalizeEvent,
    normalizeUSEvent: normalizeUSEvent,
    MarketSocket: MarketSocket,
    num: num,
  };
  root.PMAPI = PMAPI;
  if (typeof module !== "undefined" && module.exports) module.exports = PMAPI;
})(typeof window !== "undefined" ? window : globalThis);
