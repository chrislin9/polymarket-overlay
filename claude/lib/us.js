// Polymarket US (polymarket.us) support.
//
// Polymarket US is a separate, CFTC-regulated exchange with its own markets,
// slugs and APIs:
//   - Metadata + REST books:  https://gateway.polymarket.us/v1/...   (public, no key)
//   - Live books:             https://gateway-ws-markets.polymarket.us  Connect-RPC
//                             server stream (the same anonymous feed polymarket.us
//                             itself uses; the documented WebSocket needs an API key)
//
// Each US market is a single instrument: the order book is for "Yes" (long);
// "No" (short) is its mirror image (No bid = 1 - Yes ask, No ask = 1 - Yes bid).
// To reuse the overlay's two-book model we expose two virtual token ids per
// market: `${slug}|0` (Yes) and `${slug}|1` (No).

import { Book } from './book.js';

const GATEWAY = 'https://gateway.polymarket.us';
const STREAM_URL = 'https://gateway-ws-markets.polymarket.us/gateway.realtime.v1.RealtimeService/Stream';
const CHANNEL_MARKET_DATA = 3;
const SLUGS_PER_STREAM = 40;
const HEARTBEAT_TIMEOUT_MS = 75000; // server heartbeats every ~30s
const SNAPSHOT_CONCURRENCY = 4; // stay well under the 20 req/s public limit

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const amount = (a) => (a && typeof a === 'object' ? num(a.value) : num(a));
const round6 = (p) => Math.round(p * 1e6) / 1e6;

export const usToken = (slug, idx) => `${slug}|${idx}`;
const slugOf = (token) => token.slice(0, token.lastIndexOf('|'));

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, { signal: opts.signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

// ---------------------------------------------------------------- metadata

const teamName = (side) => (side && side.team && typeof side.team === 'object' ? side.team.name || null : null);

// Side labels: spreads -> "Dartmouth +20.50", moneylines -> "Dartmouth",
// totals (incl. team totals, where both sides share a team) -> "Over"/"Under".
function sideLabel(side, other, fallback) {
  if (!side) return fallback;
  const desc = (side.description || '').trim();
  const team = teamName(side);
  if (team && team !== teamName(other)) {
    return desc && desc !== team && /^[+-]?\d/.test(desc) ? `${team} ${desc}` : team;
  }
  return desc || fallback;
}

function normalizeUsMarket(m) {
  const sides = Array.isArray(m.marketSides) ? m.marketSides : [];
  const long = sides.find((s) => s.long === true) || sides[0];
  const short = sides.find((s) => s.long === false) || sides[1];
  const outcomes = [sideLabel(long, short, 'Yes'), sideLabel(short, long, 'No')];
  // US spread titles name the favourite covering ("UAlbany wins by over 20.5"),
  // which may be the No side. Title spreads after the Yes side, whose
  // probability is what the row displays.
  const isSpread = teamName(long) && teamName(short) && teamName(long) !== teamName(short) && /^[+-]?\d/.test((long.description || '').trim());
  const bestBid = amount(m.bestBidQuote);
  const bestAsk = amount(m.bestAskQuote);
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestAsk ?? bestBid;
  return {
    id: String(m.id),
    slug: m.slug,
    title: isSpread ? `Spread: ${outcomes[0]}` : m.title || m.titleShort || m.question || m.slug,
    question: m.question || m.title || '',
    image: m.image || '',
    outcomes,
    tokens: [usToken(m.slug, 0), usToken(m.slug, 1)],
    gamma: {
      prices: mid != null ? [mid, 1 - mid] : [],
      bestBid,
      bestAsk,
      last: null,
      spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
      dayChange: null,
    },
    volume: null, // not exposed per market by the US gateway
    liquidity: 0,
    tick: num(m.orderPriceMinTickSize) || 0.01,
    active: m.active !== false && !m.hidden,
    closed: !!m.closed,
    acceptingOrders: m.active !== false,
    startDate: m.startDate || m.createdAt || null,
    endDate: m.endDate || null,
  };
}

function normalizeUsEvent(e) {
  const markets = (e.markets || []).map(normalizeUsMarket);
  const isTeamEvent = Array.isArray(e.teams) && e.teams.length > 0;
  return {
    venue: 'us',
    id: String(e.id),
    slug: e.slug,
    title: e.title || e.slug,
    description: e.description || '',
    image: e.image || '',
    volume: num(e.volume) || 0,
    liquidity: num(e.liquidity) || 0,
    startDate: e.startDate || e.creationDate || e.createdAt || null,
    endDate: e.endDate || null,
    negRisk: false,
    // Sports events list spreads/totals in a meaningful order; don't re-sort those.
    sortBy: e.sortType === 'price' && !isTeamEvent ? 'price' : null,
    markets,
  };
}

/** Resolve parsed polymarket.us URL slugs into { event, focusMarketId }. */
export async function resolveUsMarket(parsed, opts = {}) {
  let rawEvent = null;
  let focusSlug = parsed.marketSlug;
  const tryEvent = async (slug) => {
    try {
      const d = await getJson(`${GATEWAY}/v1/events/slug/${encodeURIComponent(slug)}`, opts);
      return d.event || null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  };
  const tryMarket = async (slug) => {
    try {
      const d = await getJson(`${GATEWAY}/v1/market/slug/${encodeURIComponent(slug)}`, opts);
      return d.market || null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  };

  if (parsed.eventSlug) rawEvent = await tryEvent(parsed.eventSlug);
  if (!rawEvent) {
    const slug = parsed.marketSlug || parsed.eventSlug;
    const m = slug ? await tryMarket(slug) : null;
    if (m) {
      // The market endpoint doesn't link back to its event; show it on its own.
      focusSlug = m.slug;
      rawEvent = {
        id: m.id,
        slug: m.slug,
        title: m.title && m.question && m.title !== m.question ? `${m.question}: ${m.title}` : m.question || m.title,
        description: m.description,
        image: m.image,
        startDate: m.startDate,
        endDate: m.endDate,
        markets: [m],
      };
    }
  }
  if (!rawEvent) throw new Error('Market not found on Polymarket US. Check that the URL points to a polymarket.us event.');

  const event = normalizeUsEvent(rawEvent);
  if (!event.markets.length) throw new Error('This event has no markets.');
  const focus = focusSlug ? event.markets.find((m) => m.slug === focusSlug) : null;
  return { event, focusMarketId: focus ? focus.id : null };
}

// ---------------------------------------------------------------- history

const US_INTERVALS = {
  '1h': ['INTERVAL_1H', 1],
  '6h': ['INTERVAL_6H', 1],
  '1d': ['INTERVAL_1D', 5],
  '1w': ['INTERVAL_1W', 180],
  '1m': ['INTERVAL_1M', 180],
  max: ['INTERVAL_ALL', 180],
};

/**
 * Price history for one side of a US market, as [{t: ms, p}].
 * The API returns longPrice (Yes ask) and shortPrice (No ask = 1 - Yes bid);
 * we convert to the midpoint so it lines up with the live display price.
 */
export async function fetchUsHistory(slug, idx, intervalKey, opts) {
  const [iv, fidelity] = US_INTERVALS[intervalKey] || US_INTERVALS.max;
  const url = `${GATEWAY}/v1/price-history?symbol=${encodeURIComponent(slug)}&fixedInterval=${iv}&fidelity=${fidelity}`;
  const data = await getJson(url, opts);
  const out = [];
  for (const pt of data.history || []) {
    const t = Number(pt.timestamp) * 1000;
    const long = num(pt.longPrice);
    const short = num(pt.shortPrice);
    let yes = null;
    if (long != null && short != null && long > 0 && short > 0) yes = (long + (1 - short)) / 2;
    else if (long != null && long > 0) yes = long;
    else if (short != null && short > 0) yes = 1 - short;
    if (!Number.isFinite(t) || yes == null) continue;
    out.push({ t, p: idx === 0 ? yes : 1 - yes });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- protobuf

// Just enough protobuf to build the subscription request and read MarketData.
const te = new TextEncoder();
const td = new TextDecoder();

function varint(n) {
  const out = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return out;
}
const pbBytes = (no, bytes) => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
const pbString = (no, s) => pbBytes(no, [...te.encode(s)]);
const pbInt = (no, n) => [...varint(no << 3), ...varint(n)];

/** StreamRequest { 1: {1: clientId}, 3: repeated Subscription{1: {1: "type:slug"}, 2: type, 3: slug} } */
function encodeStreamRequest(slugs) {
  const msg = [...pbBytes(1, pbString(1, crypto.randomUUID()))];
  for (const slug of slugs) {
    const key = `${CHANNEL_MARKET_DATA}:${slug}`;
    msg.push(...pbBytes(3, [...pbBytes(1, pbString(1, key)), ...pbInt(2, CHANNEL_MARKET_DATA), ...pbString(3, slug)]));
  }
  const env = new Uint8Array(5 + msg.length); // Connect envelope: flags(1) + length(4, BE)
  new DataView(env.buffer).setUint32(1, msg.length);
  env.set(msg, 5);
  return env;
}

function* fields(buf) {
  let i = 0;
  const readVarint = () => {
    let r = 0;
    let s = 0;
    let b;
    do {
      if (i >= buf.length) throw new Error('truncated varint');
      b = buf[i++];
      r += (b & 127) * 2 ** s;
      s += 7;
    } while (b & 128);
    return r;
  };
  while (i < buf.length) {
    const key = readVarint();
    const no = Math.floor(key / 8);
    const wt = key & 7;
    if (wt === 0) yield [no, readVarint()];
    else if (wt === 2) {
      const len = readVarint();
      yield [no, buf.subarray(i, i + len)];
      i += len;
    } else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else throw new Error(`unsupported wire type ${wt}`);
  }
}

function decodeAmount(buf) {
  for (const [no, v] of fields(buf)) if (no === 1) return num(td.decode(v));
  return null;
}

function decodeEntry(buf) {
  let price = null;
  let size = null;
  for (const [no, v] of fields(buf)) {
    if (no === 1) price = decodeAmount(v);
    else if (no === 2) size = num(td.decode(v));
  }
  return { price, size };
}

function decodeTimestamp(buf) {
  let s = 0;
  let n = 0;
  for (const [no, v] of fields(buf)) {
    if (no === 1) s = v;
    else if (no === 2) n = v;
  }
  return s * 1000 + Math.floor(n / 1e6);
}

/** shared.market_data.v1.MarketData (field numbers match the public REST schema order). */
function decodeMarketData(buf) {
  const md = { slug: null, bids: [], offers: [], state: null, lastTradePx: null, lastTradeQty: null, ts: 0 };
  for (const [no, v] of fields(buf)) {
    if (no === 1) md.slug = td.decode(v);
    else if (no === 2) md.bids.push(decodeEntry(v));
    else if (no === 3) md.offers.push(decodeEntry(v));
    else if (no === 4) md.state = v;
    else if (no === 5) {
      for (const [sno, sv] of fields(v)) {
        if (sno === 5) md.lastTradePx = decodeAmount(sv);
        else if (sno === 10) md.lastTradeQty = num(td.decode(sv));
      }
    } else if (no === 6) md.ts = decodeTimestamp(v);
  }
  return md;
}

/** StreamResponse: field 5 carries {2: google.protobuf.Any{1: type_url, 2: value}}. */
function decodeStreamMessage(buf) {
  for (const [no, v] of fields(buf)) {
    if (no !== 5) continue;
    for (const [pno, pv] of fields(v)) {
      if (pno !== 2) continue;
      let typeUrl = '';
      let value = null;
      for (const [ano, av] of fields(pv)) {
        if (ano === 1) typeUrl = td.decode(av);
        else if (ano === 2) value = av;
      }
      if (value && typeUrl.endsWith('shared.market_data.v1.MarketData')) return decodeMarketData(value);
    }
  }
  return null;
}

// ---------------------------------------------------------------- live feed

/** Same interface as BookFeed (lib/book.js), backed by the US gateway. */
export class UsFeed {
  constructor(tokenIds, { onUpdate, onStatus } = {}) {
    this.onUpdate = onUpdate || (() => {});
    this.onStatus = onStatus || (() => {});
    this.books = new Map();
    this.markets = new Map(); // slug -> {ts, lastTradePx}
    this.streams = [];
    this.pending = [];
    this.dirty = new Set();
    this.flushScheduled = false;
    this.started = false;
    this.closed = false;
    this.snapshotQueue = [];
    this.snapshotActive = 0;
    this.snapshotFailures = new Map();
    this.add(tokenIds);
  }

  get(tokenId) {
    return this.books.get(tokenId);
  }

  has(tokenId) {
    return this.books.has(tokenId);
  }

  add(tokenIds) {
    const fresh = [];
    for (const t of new Set(tokenIds)) {
      if (this.books.has(t)) continue;
      this.books.set(t, new Book(t));
      const slug = slugOf(t);
      if (!this.markets.has(slug)) {
        this.markets.set(slug, { ts: 0, lastTradePx: null });
        fresh.push(slug);
      }
    }
    this.pending.push(...fresh);
    if (this.started) this.flushPending();
  }

  flushPending() {
    const slugs = this.pending;
    this.pending = [];
    for (let i = 0; i < slugs.length; i += SLUGS_PER_STREAM) {
      const s = new UsStream(slugs.slice(i, i + SLUGS_PER_STREAM), this);
      this.streams.push(s);
      s.connect();
    }
    // The stream only sends changes, so seed every book from REST.
    for (const slug of slugs) this.queueSnapshot(slug);
    this.reportStatus();
  }

  start() {
    this.started = true;
    this.flushPending();
  }

  stop() {
    this.closed = true;
    for (const s of this.streams) s.close();
  }

  ensure(tokenId) {
    const book = this.books.get(tokenId);
    if (book && !book.ready) this.queueSnapshot(slugOf(tokenId));
  }

  queueSnapshot(slug) {
    if (!this.snapshotQueue.includes(slug)) this.snapshotQueue.push(slug);
    this.pumpSnapshots();
  }

  pumpSnapshots() {
    while (this.snapshotActive < SNAPSHOT_CONCURRENCY && this.snapshotQueue.length && !this.closed) {
      const slug = this.snapshotQueue.shift();
      this.snapshotActive++;
      getJson(`${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`)
        .then((d) => {
          this.snapshotFailures.delete(slug);
          const md = d.marketData || {};
          this.apply({
            slug,
            bids: (md.bids || []).map((e) => ({ price: amount(e.px), size: num(e.qty) })),
            offers: (md.offers || []).map((e) => ({ price: amount(e.px), size: num(e.qty) })),
            lastTradePx: md.stats ? amount(md.stats.lastTradePx) : null,
            lastTradeQty: md.stats ? num(md.stats.lastTradeQty) : null,
            ts: Date.parse(md.transactTime) || 1,
            fromRest: true,
          });
        })
        .catch((err) => {
          // Retry transient failures with backoff; the stream may never send this market otherwise.
          const n = (this.snapshotFailures.get(slug) || 0) + 1;
          this.snapshotFailures.set(slug, n);
          if (n <= 5 && !this.closed) setTimeout(() => this.queueSnapshot(slug), 1000 * 2 ** (n - 1));
          else console.warn('[pm-overlay] US book snapshot failed', slug, err);
        })
        .finally(() => {
          this.snapshotActive--;
          this.pumpSnapshots();
        });
    }
  }

  /** Apply a full Yes-book snapshot and derive the mirrored No book. */
  apply(md) {
    const meta = this.markets.get(md.slug);
    if (!meta) return;
    // REST responses are CDN-cached (~30s); never let one overwrite newer stream data.
    if (md.fromRest && meta.ts && md.ts <= meta.ts) return;
    if (md.ts) meta.ts = Math.max(meta.ts, md.ts);
    const yes = this.books.get(usToken(md.slug, 0));
    const no = this.books.get(usToken(md.slug, 1));
    const valid = (e) => e.price != null && e.size != null && e.size > 0;
    const bids = md.bids.filter(valid);
    const offers = md.offers.filter(valid);
    if (yes) yes.applySnapshot({ bids: bids.map((e) => ({ price: e.price, size: e.size })), asks: offers.map((e) => ({ price: e.price, size: e.size })) });
    if (no) no.applySnapshot({ bids: offers.map((e) => ({ price: round6(1 - e.price), size: e.size })), asks: bids.map((e) => ({ price: round6(1 - e.price), size: e.size })) });

    if (md.lastTradePx != null) {
      const changed = meta.lastTradePx != null && meta.lastTradePx !== md.lastTradePx && !md.fromRest;
      const ts = changed ? Date.now() : 0;
      if (yes && (changed || !yes.lastTrade)) yes.lastTrade = { price: md.lastTradePx, side: null, size: md.lastTradeQty || 0, ts };
      if (no && (changed || !no.lastTrade)) no.lastTrade = { price: round6(1 - md.lastTradePx), side: null, size: md.lastTradeQty || 0, ts };
      meta.lastTradePx = md.lastTradePx;
    }
    if (yes) this.markDirty(yes.tokenId);
    if (no) this.markDirty(no.tokenId);
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
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') requestAnimationFrame(flush);
    else setTimeout(flush, 250);
  }

  reportStatus() {
    const states = this.streams.map((s) => s.state);
    let status = 'connecting';
    if (states.length && states.every((s) => s === 'live')) status = 'live';
    else if (states.some((s) => s === 'reconnecting')) status = 'reconnecting';
    else if (states.length && states.every((s) => s === 'offline')) status = 'offline';
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.onStatus(status);
    }
  }
}

class UsStream {
  constructor(slugs, feed) {
    this.slugs = slugs;
    this.feed = feed;
    this.state = 'connecting';
    this.attempt = 0;
    this.ctrl = null;
    this.retryTimer = null;
    this.staleTimer = null;
    this.everConnected = false;
  }

  setState(s) {
    this.state = s;
    this.feed.reportStatus();
  }

  bumpStale() {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.ctrl && this.ctrl.abort(), HEARTBEAT_TIMEOUT_MS);
  }

  async connect() {
    if (this.feed.closed) return;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    try {
      const res = await fetch(STREAM_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/connect+proto', 'connect-protocol-version': '1' },
        body: encodeStreamRequest(this.slugs),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
      this.attempt = 0;
      this.setState('live');
      this.bumpStale();
      // After a reconnect, refresh books that may have changed while we were away.
      if (this.everConnected) for (const slug of this.slugs) this.feed.queueSnapshot(slug);
      this.everConnected = true;
      await this.read(res.body.getReader());
      throw new Error('stream ended');
    } catch (err) {
      if (this.feed.closed) return;
      if (err && err.name !== 'AbortError') console.warn('[pm-overlay] US stream:', err.message || err);
      this.scheduleRetry();
    } finally {
      clearTimeout(this.staleTimer);
    }
  }

  async read(reader) {
    let buf = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      this.bumpStale();
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
      while (buf.length >= 5) {
        const flags = buf[0];
        const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1);
        if (buf.length < 5 + len) break;
        const body = buf.slice(5, 5 + len);
        buf = buf.slice(5 + len);
        if (flags & 2) {
          // End-of-stream frame (JSON); an error here means the request was rejected.
          throw new Error(`end of stream: ${td.decode(body).slice(0, 200)}`);
        }
        let md = null;
        try {
          md = decodeStreamMessage(body);
        } catch (err) {
          console.warn('[pm-overlay] US stream decode failed', err);
        }
        if (md && md.slug) this.feed.apply(md);
      }
    }
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.attempt++;
    this.setState(this.attempt > 8 ? 'offline' : 'reconnecting');
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.attempt, 6)) + Math.random() * 500;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.staleTimer);
    if (this.ctrl) this.ctrl.abort();
  }
}
