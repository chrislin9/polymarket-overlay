/* Polymarket data layer for both exchanges:
   - international: Gamma + CLOB REST, live WebSocket (polymarket.com)
   - US: public gateway REST (polymarket.us, slug-based, polled book)
   Exposed as window.PMAPI; also loadable in Node for unit tests. */
(function (root) {
  "use strict";

  var GAMMA = "https://gamma-api.polymarket.com";
  var CLOB = "https://clob.polymarket.com";
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
      source: "intl",
    };
  }

  function normalizeEvent(ev, fallbackTitle) {
    var markets = (ev.markets || []).map(normalizeMarket)
      .filter(function (m) { return m.tokens.length > 0; });
    markets.sort(function (a, b) { return (b.prices[0] || 0) - (a.prices[0] || 0); });
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
      source: "us",
    };
  }

  function normalizeUSEvent(ev) {
    var markets = (ev.markets || []).map(normalizeUSMarket)
      .filter(function (m) { return !!m.usSlug; });
    markets.sort(function (a, b) { return (b.prices[0] || 0) - (a.prices[0] || 0); });
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

  /* Returns snapshots for BOTH outcome tokens (side 1 = mirrored book). */
  function fetchUSBook(usSlug) {
    return fetchJSON(US_GATEWAY + "/v1/markets/" + encodeURIComponent(usSlug) + "/book").then(function (d) {
      var md = (d && d.marketData) || {};
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
        meta: meta,
        sides: [
          { bids: bids, asks: asks, lastTradePrice: last },
          { bids: usLevels(md.offers, true), asks: usLevels(md.bids, true),
            lastTradePrice: last != null ? +(1 - last).toFixed(4) : null },
        ],
      };
    });
  }

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
    GAMMA: GAMMA, CLOB: CLOB, WS_URL: WS_URL, US_GATEWAY: US_GATEWAY,
    parsePolymarketUrl: parsePolymarketUrl,
    loadFromUrl: loadFromUrl,
    fetchBook: fetchBook,
    fetchHistory: fetchHistory,
    fetchUSBook: fetchUSBook,
    fetchUSHistory: fetchUSHistory,
    sortLevels: sortLevels,
    MarketSocket: MarketSocket,
    num: num,
  };
  root.PMAPI = PMAPI;
  if (typeof module !== "undefined" && module.exports) module.exports = PMAPI;
})(typeof window !== "undefined" ? window : globalThis);
