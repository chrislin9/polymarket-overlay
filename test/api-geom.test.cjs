/* Durable unit tests (Node stdlib only): run with `node --test` from the repo root.
   Covers URL parsing for polymarket.com + polymarket.us, leg ordering, the US
   realtime stream decoding, and the panel
   geometry clamp that keeps the resize corner reachable after the
   viewport shrinks (e.g. exiting fullscreen). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const PMAPI = require("../lib/api.js");
const PMGeom = require("../lib/geom.js");
const parse = PMAPI.parsePolymarketUrl;

/* ---------- URL parsing: international ---------- */
test("parses polymarket.com event URL", () => {
  const r = parse("https://polymarket.com/event/fed-decision-in-december");
  assert.equal(r.source, "intl");
  assert.equal(r.kind, "event");
  assert.equal(r.slug, "fed-decision-in-december");
});

test("parses polymarket.com event/market URL with focused market", () => {
  const r = parse("https://polymarket.com/event/us-election/will-x-win");
  assert.equal(r.kind, "event");
  assert.equal(r.slug, "us-election");
  assert.equal(r.marketSlug, "will-x-win");
});

test("parses polymarket.com market URL", () => {
  const r = parse("https://polymarket.com/market/will-x-win");
  assert.equal(r.source, "intl");
  assert.equal(r.kind, "market");
  assert.equal(r.slug, "will-x-win");
});

/* ---------- URL parsing: US ---------- */
test("parses polymarket.us event URL", () => {
  const r = parse("https://polymarket.us/event/usp-2028-11-07");
  assert.equal(r.source, "us");
  assert.equal(r.kind, "event");
  assert.equal(r.slug, "usp-2028-11-07");
});

test("parses polymarket.us sports event URL (slug is last segment)", () => {
  const r = parse("https://polymarket.us/sports/cbb/cbb-dart-albny-2026-11-11");
  assert.equal(r.source, "us");
  assert.equal(r.kind, "event");
  assert.equal(r.slug, "cbb-dart-albny-2026-11-11");
});

test("parses polymarket.us market URL", () => {
  const r = parse("https://polymarket.us/market/ewc-usp-2028-11-07-jonoss");
  assert.equal(r.source, "us");
  assert.equal(r.kind, "market");
  assert.equal(r.slug, "ewc-usp-2028-11-07-jonoss");
});

test("parses www subdomain and missing scheme", () => {
  assert.equal(parse("www.polymarket.us/event/usp-2028-11-07").source, "us");
  assert.equal(parse("polymarket.com/event/abc").source, "intl");
});

test("bare slug has no pinned source (loader tries intl, then US)", () => {
  const r = parse("usp-2028-11-07");
  assert.equal(r.kind, "event");
  assert.equal(r.slug, "usp-2028-11-07");
  assert.ok(!r.source);
});

test("rejects junk input", () => {
  assert.equal(parse(""), null);
  assert.equal(parse("   "), null);
  assert.equal(parse("not a url !!"), null);
  assert.equal(parse(null), null);
});

/* ---------- leg ordering ---------- */
function usMkt(id, title, type, line, bid, ask) {
  return {
    id, slug: "m-" + id, titleShort: title, sportsMarketTypeV2: type, line,
    bestBidQuote: { value: String(bid) }, bestAskQuote: { value: String(ask) },
  };
}

test("US event: moneyline first, then group headline lines, then ladders (not price order)", () => {
  const ev = PMAPI.normalizeUSEvent({
    slug: "nba-cle-ny", sortType: "price",
    markets: [
      usMkt("s32", "NY -32.5", "SPREAD", 32.5, 0.99, 0.99),
      usMkt("s15", "NY -1.5", "SPREAD", 1.5, 0.53, 0.54),
      usMkt("c15", "CLE -1.5", "SPREAD", -1.5, 0.46, 0.47),
      usMkt("s25", "NY -2.5", "SPREAD", 2.5, 0.57, 0.58),
      usMkt("t226", "Over 226.5", "TOTAL", 226.5, 0.5, 0.51),
      usMkt("t230", "Over 230.5", "TOTAL", 230.5, 0.3, 0.31),
      usMkt("ml", "CLE vs NY", "SPORTS_MARKET_TYPE_MONEYLINE", null, 0.48, 0.49),
      usMkt("x", "Ungrouped", "OTHER", null, 0.9, 0.91),
    ],
    marketGroups: [
      { id: "PRIMARY", order: 0, marketIds: ["ml"] },
      { id: "game-lines", order: 0, marketIds: [] },
      { id: "game-lines/totals", parentId: "game-lines", order: 1, line: 226.5, marketIds: ["t230", "t226"] },
      { id: "game-lines/spread", parentId: "game-lines", order: 0, line: 1.5, marketIds: ["s32", "s25", "s15", "c15"] },
    ],
  });
  assert.deepEqual(ev.markets.map((m) => m.usId),
    ["ml", "s15", "c15", "t226", "s25", "s32", "t230", "x"]);
});

test("US event without marketGroups still leads with the moneyline", () => {
  const ev = PMAPI.normalizeUSEvent({
    slug: "e",
    markets: [
      usMkt("a", "Spread", "SPREAD", 32.5, 0.99, 0.99),
      usMkt("ml", "A vs B", "SPORTS_MARKET_TYPE_MONEYLINE", null, 0.4, 0.41),
    ],
  });
  assert.equal(ev.markets[0].usId, "ml");
});

function intlMkt(id, type, volume, yes) {
  return { id, slug: id, sportsMarketType: type, volumeNum: volume,
    outcomePrices: JSON.stringify([String(yes), String(1 - yes)]), clobTokenIds: '["1","2"]' };
}

test("intl sports event: moneyline first, then by volume traded", () => {
  const ev = PMAPI.normalizeEvent({ markets: [
    intlMkt("sp-lo", "spreads", 10, 0.99),
    intlMkt("tot", "totals", 500, 0.5),
    intlMkt("ml", "moneyline", 100, 0.45),
    intlMkt("sp-hi", "spreads", 900, 0.4),
  ] });
  assert.deepEqual(ev.markets.map((m) => m.id), ["ml", "sp-hi", "tot", "sp-lo"]);
});

test("intl non-sports multi-outcome event keeps price order", () => {
  const ev = PMAPI.normalizeEvent({ markets: [
    intlMkt("b", null, 900, 0.2), intlMkt("a", null, 10, 0.7),
  ] });
  assert.deepEqual(ev.markets.map((m) => m.id), ["a", "b"]);
});

/* ---------- US realtime stream ---------- */
function frame(obj, flags = 0) {
  const f = PMAPI.encodeConnectFrame(obj);
  f[0] = flags;
  return f;
}

test("Connect frame decoder handles frames split across chunks and the end-stream trailer", () => {
  const a = frame({ sequence: "1" }), b = frame({ sequence: "2" }), end = frame({ error: { code: "unavailable" } }, 2);
  const all = new Uint8Array(a.length + b.length + end.length);
  all.set(a, 0); all.set(b, a.length); all.set(end, a.length + b.length);
  const dec = new PMAPI.ConnectFrameDecoder();
  const out = [];
  // feed in awkward 3-byte chunks (splits headers and bodies)
  for (let i = 0; i < all.length; i += 3) out.push(...dec.push(all.subarray(i, i + 3)));
  assert.deepEqual(out.map((f) => [f.end, f.msg.sequence || f.msg.error.code]),
    [[false, "1"], [false, "2"], [true, "unavailable"]]);
});

test("MarketData parses to long book + mirrored short book", () => {
  const r = PMAPI.parseUSMarketData({
    marketSlug: "m",
    bids: [{ px: { value: "0.5500" }, qty: "10" }],
    offers: [{ px: { value: "0.5700" }, qty: "4" }],
    stats: { lastTradePx: { value: "0.56" }, notionalTraded: { value: "123.5" } },
  });
  assert.equal(r.slug, "m");
  assert.deepEqual(r.sides[0].bids, [{ price: 0.55, size: 10 }]);
  assert.deepEqual(r.sides[1].bids, [{ price: 0.43, size: 4 }]); // 1 - best ask
  assert.deepEqual(r.sides[1].asks, [{ price: 0.45, size: 10 }]); // 1 - best bid
  assert.equal(r.sides[1].lastTradePrice, 0.44);
  assert.equal(r.meta.notionalTraded, 123.5);
});

test("MarketDataLite parses top of book", () => {
  const r = PMAPI.parseUSMarketDataLite({ marketSlug: "m", bestBid: { value: "0.5" }, bestAsk: { value: "0.52" }, lastTradePx: { value: "0.51" } });
  assert.deepEqual([r.slug, r.bestBid, r.bestAsk, r.last], ["m", 0.5, 0.52, 0.51]);
});

test("stream channels: book slugs drop out of lite, unchanged sets don't reopen", () => {
  const st = new PMAPI.USMarketStream(() => {});
  let opens = 0;
  st.scheduleOpen = () => { opens++; };
  st.setChannels(["a", "a"], ["a", "b", "c"]);
  assert.deepEqual([st.book, st.lite], [["a"], ["b", "c"]]);
  st.setChannels(["a"], ["c", "b"]); // same set, different order
  assert.equal(opens, 1);
  st.setChannels(["b"], ["a"]);
  assert.equal(opens, 2);
  st.close();
});

test("stream lite channels are capped", () => {
  const st = new PMAPI.USMarketStream(() => {});
  st.scheduleOpen = () => {};
  const many = Array.from({ length: 200 }, (_, i) => "m" + i);
  st.setChannels(["x"], many);
  assert.equal(st.book.length + st.lite.length, PMAPI.USMarketStream.MAX_CHANNELS);
  st.close();
});

/* ---------- geometry clamp ---------- */
const clamp = PMGeom.clampGeometry;

test("fullscreen exit: oversized panel is pulled fully into the smaller viewport", () => {
  // Sized/positioned on a 1920x1080 fullscreen, now back in a 1280x800 window.
  const g = clamp({ x: 900, y: 500, w: 1000, h: 700 }, 1280, 800);
  assert.ok(g.x >= 0 && g.y >= 0, "top-left on screen");
  assert.ok(g.x + g.w <= 1280, "right edge (resize corner) reachable, got " + (g.x + g.w));
  assert.ok(g.y + g.h <= 800, "bottom edge (resize corner) reachable, got " + (g.y + g.h));
  assert.ok(g.w >= 320 && g.h >= 240, "still at least minimum size");
});

test("panel larger than the viewport is shrunk to fit", () => {
  const g = clamp({ x: 0, y: 0, w: 2400, h: 1400 }, 1280, 800);
  assert.ok(g.w <= 1280 && g.h <= 800);
  assert.ok(g.x + g.w <= 1280 && g.y + g.h <= 800);
});

test("panel hanging off the right/bottom edges is moved back, size kept when it fits", () => {
  const g = clamp({ x: 1200, y: 700, w: 430, h: 300 }, 1400, 900);
  assert.equal(g.w, 430);
  assert.equal(g.h, 300);
  assert.ok(g.x + g.w <= 1400 && g.y + g.h <= 900);
});

test("negative position is pulled back on screen", () => {
  const g = clamp({ x: -300, y: -50, w: 430, h: 640 }, 1400, 900);
  assert.ok(g.x >= 0 && g.y >= 0);
});

test("normal geometry is unchanged", () => {
  const g = clamp({ x: 100, y: 50, w: 430, h: 640 }, 1400, 900);
  assert.deepEqual(g, { x: 100, y: 50, w: 430, h: 640 });
});

test("right-anchored default (x null) keeps anchor, only size is clamped", () => {
  const g = clamp({ x: null, y: null, w: 2400, h: 1400 }, 1280, 800);
  assert.equal(g.x, null);
  assert.ok(g.w <= 1280 && g.h <= 800);
});

test("tiny viewport never yields negative or zero size", () => {
  const g = clamp({ x: 10, y: 10, w: 430, h: 640 }, 300, 200);
  assert.ok(g.w > 0 && g.h > 0);
  assert.ok(g.x + g.w <= 300 && g.y + g.h <= 200);
});

test("missing/garbage geometry falls back to defaults that fit", () => {
  for (const bad of [null, undefined, {}, { w: "abc", h: NaN }]) {
    const g = clamp(bad, 1400, 900);
    assert.ok(g.w > 0 && g.h > 0 && g.w <= 1400 && g.h <= 900, JSON.stringify(bad));
  }
});
