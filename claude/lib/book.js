// Live order books for a set of outcome tokens, fed by Polymarket's public
// CLOB market WebSocket (with REST snapshots as a fallback).
//
// WS protocol (wss://ws-subscriptions-clob.polymarket.com/ws/market):
//   -> {"assets_ids": [...], "type": "market"}
//   <- book:              full snapshot {asset_id, bids:[{price,size}], asks:[...]}
//                         (the first reply is usually an array of these)
//   <- price_change:      {price_changes:[{asset_id, price, size, side}]}  (size "0" = remove level)
//                         legacy shape: {asset_id, changes:[{price, size, side}]}
//   <- last_trade_price:  {asset_id, price, side, size}
//   -> "PING" every ~10s keeps the connection alive.

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const TOKENS_PER_SOCKET = 200;
const PING_MS = 10000;

export class Book {
  constructor(tokenId) {
    this.tokenId = tokenId;
    this.bids = new Map(); // price(number) -> size(number)
    this.asks = new Map();
    this.lastTrade = null; // {price, side, ts}
    this.ready = false;
    this.updatedAt = 0;
    this.version = 0;
  }

  applySnapshot(msg) {
    this.bids.clear();
    this.asks.clear();
    for (const l of msg.bids || []) setLevel(this.bids, l.price, l.size);
    for (const l of msg.asks || []) setLevel(this.asks, l.price, l.size);
    // Note: the snapshot's last_trade_price is market-level (it's identical for
    // both outcome tokens), so it's deliberately ignored here.
    this.ready = true;
    this.touch();
  }

  applyChange(side, price, size) {
    const s = String(side).toUpperCase();
    setLevel(s === 'BUY' || s === 'BID' ? this.bids : this.asks, price, size);
    this.touch();
  }

  touch() {
    this.updatedAt = Date.now();
    this.version++;
  }

  bestBid() {
    let best = null;
    for (const p of this.bids.keys()) if (best === null || p > best) best = p;
    return best;
  }

  bestAsk() {
    let best = null;
    for (const p of this.asks.keys()) if (best === null || p < best) best = p;
    return best;
  }

  /** Levels sorted from the spread outward. */
  sortedBids() {
    return [...this.bids].sort((a, b) => b[0] - a[0]);
  }

  sortedAsks() {
    return [...this.asks].sort((a, b) => a[0] - b[0]);
  }
}

function setLevel(map, price, size) {
  const p = Math.round(parseFloat(price) * 1e6) / 1e6;
  const s = parseFloat(size);
  if (!Number.isFinite(p)) return;
  if (!Number.isFinite(s) || s <= 0) map.delete(p);
  else map.set(p, s);
}

/**
 * Maintains Books for a set of tokens and keeps them live.
 * onUpdate(tokenIdSet) is called (batched per animation frame) with the tokens that changed.
 * onStatus(status) receives 'connecting' | 'live' | 'reconnecting' | 'offline'.
 */
export class BookFeed {
  constructor(tokenIds, { onUpdate, onStatus, onTrade, fetchSnapshot } = {}) {
    this.tokenIds = [];
    this.books = new Map();
    this.onUpdate = onUpdate || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onTrade = onTrade || (() => {});
    this.fetchSnapshot = fetchSnapshot;
    this.sockets = [];
    this.dirty = new Set();
    this.flushScheduled = false;
    this.closed = false;
    this.started = false;
    this.pending = [];
    this.add(tokenIds);
  }

  get(tokenId) {
    return this.books.get(tokenId);
  }

  has(tokenId) {
    return this.books.has(tokenId);
  }

  /** Subscribe to more tokens (opens additional sockets as needed). */
  add(tokenIds) {
    const fresh = [...new Set(tokenIds)].filter((t) => !this.books.has(t));
    for (const t of fresh) {
      this.books.set(t, new Book(t));
      this.tokenIds.push(t);
    }
    this.pending.push(...fresh);
    if (this.started) this.flushPending();
  }

  flushPending() {
    const list = this.pending;
    this.pending = [];
    for (let i = 0; i < list.length; i += TOKENS_PER_SOCKET) {
      const sock = new FeedSocket(list.slice(i, i + TOKENS_PER_SOCKET), this);
      this.sockets.push(sock);
      sock.connect();
    }
    this.reportStatus();
  }

  start() {
    this.started = true;
    this.flushPending();
  }

  stop() {
    this.closed = true;
    for (const s of this.sockets) s.close();
  }

  /** Ensure a book has data; fetch a REST snapshot if the WS hasn't delivered one. */
  async ensure(tokenId) {
    const book = this.books.get(tokenId);
    if (!book || book.ready || !this.fetchSnapshot) return;
    try {
      const snap = await this.fetchSnapshot(tokenId);
      if (!book.ready) {
        book.applySnapshot(snap);
        this.markDirty(tokenId);
      }
    } catch (err) {
      console.warn('[pm-overlay] snapshot failed', tokenId, err);
    }
  }

  reportStatus() {
    const states = this.sockets.map((s) => s.state);
    let status = 'connecting';
    if (states.length && states.every((s) => s === 'live')) status = 'live';
    else if (states.some((s) => s === 'reconnecting')) status = 'reconnecting';
    else if (states.length && states.every((s) => s === 'offline')) status = 'offline';
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.onStatus(status);
    }
  }

  markDirty(tokenId) {
    this.dirty.add(tokenId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const flush = () => {
      this.flushScheduled = false;
      const set = this.dirty;
      this.dirty = new Set();
      if (set.size) this.onUpdate(set);
    };
    // rAF is paused in hidden tabs; fall back to a timer so state stays current.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') requestAnimationFrame(flush);
    else setTimeout(flush, 250);
  }

  handleMessage(msg) {
    if (Array.isArray(msg)) {
      for (const m of msg) this.handleMessage(m);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const type = msg.event_type || msg.type;
    if (type === 'book') {
      const book = this.books.get(String(msg.asset_id));
      if (!book) return;
      book.applySnapshot(msg);
      this.markDirty(book.tokenId);
    } else if (type === 'price_change') {
      if (Array.isArray(msg.price_changes)) {
        for (const c of msg.price_changes) {
          const book = this.books.get(String(c.asset_id));
          if (!book) continue;
          book.applyChange(c.side, c.price, c.size);
          this.markDirty(book.tokenId);
        }
      } else if (Array.isArray(msg.changes)) {
        const book = this.books.get(String(msg.asset_id));
        if (!book) return;
        for (const c of msg.changes) book.applyChange(c.side, c.price, c.size);
        this.markDirty(book.tokenId);
      }
    } else if (type === 'last_trade_price') {
      const book = this.books.get(String(msg.asset_id));
      const p = parseFloat(msg.price);
      if (!book || !Number.isFinite(p)) return;
      book.lastTrade = { price: p, side: msg.side || null, size: parseFloat(msg.size) || 0, ts: Date.now() };
      book.touch();
      this.markDirty(book.tokenId);
      this.onTrade(book.tokenId, book.lastTrade);
    }
  }
}

class FeedSocket {
  constructor(tokenIds, feed) {
    this.tokenIds = tokenIds;
    this.feed = feed;
    this.ws = null;
    this.state = 'connecting';
    this.attempt = 0;
    this.pingTimer = null;
    this.retryTimer = null;
    this.staleTimer = null;
  }

  setState(s) {
    this.state = s;
    this.feed.reportStatus();
  }

  connect() {
    if (this.feed.closed) return;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.warn('[pm-overlay] websocket failed', err);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ assets_ids: this.tokenIds, type: 'market' }));
      this.attempt = 0;
      this.setState('live');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, PING_MS);
      this.bumpStale();
    };
    ws.onmessage = (ev) => {
      this.bumpStale();
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data || data === 'PONG' || data[0] !== '{' && data[0] !== '[') return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      this.feed.handleMessage(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      clearTimeout(this.staleTimer);
      if (this.ws === ws) this.ws = null;
      if (!this.feed.closed) this.scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  // If nothing (not even PONG) arrives for a while, assume the socket is dead.
  bumpStale() {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      if (this.ws) this.ws.close();
    }, PING_MS * 3);
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.attempt++;
    this.setState(this.attempt > 8 ? 'offline' : 'reconnecting');
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.attempt, 6)) + Math.random() * 500;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.staleTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
