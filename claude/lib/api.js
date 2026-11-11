// REST access to Polymarket's public Gamma (metadata) and CLOB (books/history) APIs.
// These calls run from extension pages, so host_permissions in the manifest let
// them bypass CORS.

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

async function getJson(url, { signal } = {}) {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Normalize a Gamma market into the shape the overlay works with.
export function normalizeMarket(m) {
  const outcomes = parseJsonArray(m.outcomes);
  const tokens = parseJsonArray(m.clobTokenIds).map(String);
  const prices = parseJsonArray(m.outcomePrices).map(num);
  return {
    id: String(m.id),
    slug: m.slug,
    title: m.groupItemTitle || m.question || m.slug,
    question: m.question || '',
    image: m.icon || m.image || '',
    outcomes: outcomes.length === 2 ? outcomes : ['Yes', 'No'],
    tokens,
    gamma: {
      prices,
      bestBid: num(m.bestBid),
      bestAsk: num(m.bestAsk),
      last: num(m.lastTradePrice),
      spread: num(m.spread),
      dayChange: num(m.oneDayPriceChange),
    },
    volume: num(m.volumeNum ?? m.volume) || 0,
    liquidity: num(m.liquidityNum ?? m.liquidity) || 0,
    tick: num(m.orderPriceMinTickSize) || 0.01,
    active: m.active !== false,
    closed: !!m.closed,
    acceptingOrders: m.acceptingOrders !== false,
    startDate: m.startDate || m.createdAt || null,
    endDate: m.endDate || null,
  };
}

export function normalizeEvent(e) {
  const markets = (e.markets || []).map(normalizeMarket).filter((m) => m.tokens.length === 2);
  return {
    id: String(e.id),
    slug: e.slug,
    title: e.title || e.slug,
    description: e.description || '',
    image: e.icon || e.image || '',
    volume: num(e.volume) || markets.reduce((s, m) => s + m.volume, 0),
    liquidity: num(e.liquidity) || 0,
    startDate: e.startDate || e.creationDate || e.createdAt || null,
    endDate: e.endDate || null,
    negRisk: !!e.negRisk,
    sortBy: e.sortBy || null,
    markets,
  };
}

const getEventBySlug = (slug, o) => getJson(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`, o);
const getMarketBySlug = (slug, o) => getJson(`${GAMMA}/markets/slug/${encodeURIComponent(slug)}`, o);

async function eventFromMarket(market, o) {
  const parentSlug = market.events && market.events[0] && market.events[0].slug;
  if (parentSlug) {
    try {
      return await getEventBySlug(parentSlug, o);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
  }
  // No parent event: wrap the lone market in a pseudo-event.
  return {
    id: market.id,
    slug: market.slug,
    title: market.question,
    description: market.description,
    image: market.icon || market.image,
    volume: market.volumeNum ?? market.volume,
    liquidity: market.liquidityNum ?? market.liquidity,
    startDate: market.startDate,
    endDate: market.endDate,
    markets: [market],
  };
}

/**
 * Resolve parsed URL slugs into { event, focusMarketId }.
 * @param {{eventSlug: string|null, marketSlug: string|null, guess: boolean}} parsed
 */
export async function resolveMarket(parsed, opts = {}) {
  let rawEvent = null;
  let focusSlug = parsed.marketSlug;

  if (parsed.eventSlug) {
    try {
      rawEvent = await getEventBySlug(parsed.eventSlug, opts);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
      // A guessed slug may actually be a market slug.
      if (!parsed.marketSlug) {
        try {
          const m = await getMarketBySlug(parsed.eventSlug, opts);
          rawEvent = await eventFromMarket(m, opts);
          focusSlug = m.slug;
        } catch (err2) {
          if (!(err2 instanceof HttpError && err2.status === 404)) throw err2;
        }
      }
    }
  }
  if (!rawEvent && parsed.marketSlug) {
    const m = await getMarketBySlug(parsed.marketSlug, opts);
    rawEvent = await eventFromMarket(m, opts);
  }
  if (!rawEvent) throw new Error('Market not found. Check that the URL points to a Polymarket event or market.');

  const event = normalizeEvent(rawEvent);
  if (!event.markets.length) throw new Error('This event has no order-book markets.');
  const focus = focusSlug ? event.markets.find((m) => m.slug === focusSlug) : null;
  return { event, focusMarketId: focus ? focus.id : null };
}

/** Full order book snapshot for one outcome token. */
export function fetchBook(tokenId, opts) {
  return getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, opts);
}

export const INTERVALS = [
  { key: '1h', label: '1H', minutes: 60 },
  { key: '6h', label: '6H', minutes: 360 },
  { key: '1d', label: '1D', minutes: 1440 },
  { key: '1w', label: '1W', minutes: 10080 },
  { key: '1m', label: '1M', minutes: 43200 },
  { key: 'max', label: 'ALL', minutes: null },
];

/**
 * Price history for an outcome token. Returns [{t: ms, p: 0..1}].
 * Fidelity (minutes per point) is chosen to give roughly 300-400 points.
 */
export async function fetchHistory(tokenId, intervalKey, startDate, opts) {
  const iv = INTERVALS.find((i) => i.key === intervalKey) || INTERVALS[INTERVALS.length - 1];
  let minutes = iv.minutes;
  if (minutes == null) {
    const start = startDate ? Date.parse(startDate) : NaN;
    minutes = Number.isFinite(start) ? Math.max(60, (Date.now() - start) / 60000) : 525600;
  }
  const fidelity = Math.max(1, Math.floor(minutes / 360));
  const url = `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${iv.key}&fidelity=${fidelity}`;
  const data = await getJson(url, opts);
  const hist = Array.isArray(data) ? data : data.history || [];
  return hist
    .map((pt) => ({ t: Number(pt.t) * 1000, p: Number(pt.p) }))
    .filter((pt) => Number.isFinite(pt.t) && Number.isFinite(pt.p))
    .sort((a, b) => a.t - b.t);
}
