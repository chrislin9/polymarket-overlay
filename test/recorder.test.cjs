/* Durable unit tests (Node stdlib only): run with `node --test` from the repo root.
   Covers the order-book recorder added for rival-strategy analysis:
   snapshot/diff capture of aggregated L2 levels, the fill-vs-cancel
   inference (trade prints credit a level before its size drops; a print
   just AFTER a drop is linked from the trade line), wallet-fill matching
   (tx hash first, then price/size/time), the NDJSON envelope (session
   header first, session_end summary last, monotonic seq), the event cap,
   and the Data API v2 row normalization it depends on. Recorder + API
   are pure modules, so a fake clock drives everything deterministically. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const RecorderLib = require("../lib/recorder.js");
const PMAPI = require("../lib/api.js");

function harness(opts) {
  let t = 1_700_000_000_000;
  const r = RecorderLib.createRecorder(Object.assign({ now: () => t }, opts || {}));
  r.setTokenMeta("tokA", { tick: 0.01, outcome: "Yes", outcome_index: 0, market_id: "m1" });
  r.start({ source: "intl", url: "https://polymarket.com/event/x" });
  return { r, tick: (ms) => { t += ms; }, now: () => t };
}
function lines(r) {
  return r.toNDJSON().trim().split("\n").map((l) => JSON.parse(l));
}
function ofType(r, type) { return lines(r).filter((l) => l.type === type); }

/* ---------- envelope ---------- */
test("NDJSON: session header first (schema + token map + caveats), session_end last, seq monotonic", () => {
  const { r } = harness();
  r.observeBook("tokA", [{ price: 0.54, size: 100 }], [{ price: 0.56, size: 100 }], { source: "ws_book" });
  r.stop("user");
  const ls = lines(r);
  assert.equal(ls[0].type, "session");
  assert.equal(ls[0].schema, "pm-overlay-recording/1");
  assert.equal(ls[0].tokens[0].token, "tokA");
  assert.ok(ls[0].caveats.length >= 3, "limits travel with the data");
  assert.equal(ls[ls.length - 1].type, "session_end");
  for (let i = 1; i < ls.length; i++) assert.ok(ls[i].seq > ls[i - 1].seq, "seq increases");
  for (const l of ls) assert.ok(l.t_ms >= ls[0].t_ms && l.dt_ms >= 0);
});

test("nothing is emitted before start or after stop", () => {
  let t = 0;
  const r = RecorderLib.createRecorder({ now: () => t });
  r.observeBook("tokA", [{ price: 0.5, size: 10 }], [], {});
  assert.equal(r.toNDJSON(), "");
  r.start({});
  r.stop("user");
  const n = r.status().events;
  r.observeBook("tokA", [{ price: 0.5, size: 99 }], [], {});
  assert.equal(r.status().events, n);
});

/* ---------- snapshot + diff capture ---------- */
test("first book is a full snapshot; identical frame emits nothing; changed frame diffs to level_changes", () => {
  const { r, tick } = harness();
  r.observeBook("tokA", [{ price: 0.54, size: 1000 }, { price: 0.53, size: 500 }],
    [{ price: 0.56, size: 800 }], { source: "ws_book" });
  assert.equal(ofType(r, "book_snapshot").length, 1);
  tick(100);
  r.observeBook("tokA", [{ price: 0.54, size: 1000 }, { price: 0.53, size: 500 }],
    [{ price: 0.56, size: 800 }], { source: "us_book" });
  assert.equal(ofType(r, "level_change").length, 0, "no-op frame collapses");
  tick(100);
  r.observeBook("tokA", [{ price: 0.54, size: 1200 }], [{ price: 0.56, size: 800 }, { price: 0.57, size: 10 }],
    { source: "us_book" });
  const ch = ofType(r, "level_change");
  assert.equal(ch.length, 3);
  const byKey = Object.fromEntries(ch.map((c) => [c.side + "@" + c.price, c]));
  assert.equal(byKey["bids@0.54"].change, "increase");
  assert.equal(byKey["bids@0.54"].delta, 200);
  assert.equal(byKey["bids@0.53"].change, "removed");
  assert.equal(byKey["asks@0.57"].change, "new_level");
  assert.equal(byKey["bids@0.54"].book.best_bid, 0.54);
  assert.equal(byKey["bids@0.54"].level.dist_best_ticks, 0);
  assert.equal(byKey["asks@0.57"].level.ahead_shares, 800, "shares queued ahead of the new ask");
});

test("same book hash frame is skipped entirely (REST/WS dedupe)", () => {
  const { r } = harness();
  r.observeBook("tokA", [{ price: 0.54, size: 1 }], [], { hash: "abc" });
  r.observeBook("tokA", [{ price: 0.54, size: 2 }], [], { hash: "abc" });
  assert.equal(ofType(r, "level_change").length, 0);
});

test("price_change before any snapshot is recorded but flagged prev_unknown, never classified as cancel", () => {
  const { r } = harness();
  r.onPriceChange({ token: "tokA", side: "SELL", price: 0.6, size: 50 });
  r.onPriceChange({ token: "tokA", side: "SELL", price: 0.6, size: 0 });
  const ch = ofType(r, "level_change");
  assert.equal(ch[0].prev_size, null);
  assert.equal(ch[0].prev_unknown, true);
  assert.equal(ch[1].cause_inferred, "unknown_no_snapshot");
});

/* ---------- fill-vs-cancel inference ---------- */
test("decrease covered by an earlier trade print at that price is likely_fill; uncovered is likely_cancel", () => {
  const { r, tick } = harness();
  r.observeBook("tokA", [{ price: 0.54, size: 1000 }], [{ price: 0.56, size: 800 }], {});
  tick(100);
  r.onTrade({ token: "tokA", price: 0.56, size: 300, side: "BUY" });
  tick(50);
  r.onPriceChange({ token: "tokA", side: "SELL", price: 0.56, size: 500 });
  tick(50);
  r.onPriceChange({ token: "tokA", side: "BUY", price: 0.54, size: 900 });
  const ch = ofType(r, "level_change");
  assert.equal(ch[0].cause_inferred, "likely_fill");
  assert.equal(ch[0].fill_shares, 300);
  assert.equal(ch[0].fill_trade_seqs.length, 1);
  assert.equal(ch[0].ms_since_last_trade, 50, "reaction-latency join field");
  assert.equal(ch[1].cause_inferred, "likely_cancel");
  assert.equal(ch[1].cancel_shares, 100);
});

test("partial cover splits into fill + cancel quantities; expired credit does not cover", () => {
  const { r, tick } = harness();
  r.observeBook("tokA", [], [{ price: 0.56, size: 1000 }], {});
  r.onTrade({ token: "tokA", price: 0.56, size: 100, side: "BUY" });
  tick(10);
  r.onPriceChange({ token: "tokA", side: "SELL", price: 0.56, size: 600 }); // -400, credit 100
  let ch = ofType(r, "level_change");
  assert.equal(ch[0].cause_inferred, "likely_fill_partial");
  assert.equal(ch[0].fill_shares, 100);
  assert.equal(ch[0].cancel_shares, 300);
  r.onTrade({ token: "tokA", price: 0.56, size: 50, side: "BUY" });
  tick(6000); // beyond the 5s fill window
  r.onPriceChange({ token: "tokA", side: "SELL", price: 0.56, size: 590 }); // -10, stale credit
  ch = ofType(r, "level_change");
  assert.equal(ch[1].cause_inferred, "likely_cancel");
});

test("print arriving just AFTER the book drop links back via explains_decrease_seqs (feed ordering)", () => {
  const { r, tick } = harness();
  r.observeBook("tokA", [{ price: 0.54, size: 1000 }], [], {});
  tick(10);
  r.onPriceChange({ token: "tokA", side: "BUY", price: 0.54, size: 700 }); // -300 unexplained
  tick(30);
  r.onTrade({ token: "tokA", price: 0.54, size: 300, side: "SELL" });      // taker sell hits bids
  const tr = ofType(r, "trade")[0];
  const dec = ofType(r, "level_change")[0];
  assert.deepEqual(tr.explains_decrease_seqs, [dec.seq]);
  assert.equal(tr.explains_shares, 300);
  assert.equal(tr.consumed_side, "bids");
});

test("trade on the wrong price or side never credits a decrease", () => {
  const { r, tick } = harness();
  r.observeBook("tokA", [{ price: 0.54, size: 1000 }], [{ price: 0.56, size: 1000 }], {});
  r.onTrade({ token: "tokA", price: 0.56, size: 500, side: "BUY" });  // credits asks@0.56
  tick(10);
  r.onPriceChange({ token: "tokA", side: "BUY", price: 0.54, size: 500 }); // bids drop: no credit there
  assert.equal(ofType(r, "level_change")[0].cause_inferred, "likely_cancel");
});

/* ---------- wallet fills ---------- */
test("wallet trade matches its WS print by tx hash, else by price+size+time; unmatched stays explicit", () => {
  const { r, tick, now } = harness();
  r.observeBook("tokA", [{ price: 0.54, size: 100 }], [{ price: 0.56, size: 100 }], {});
  r.onTrade({ token: "tokA", price: 0.56, size: 300, side: "BUY", txHash: "0xaaa", serverTs: now() });
  tick(2000);
  r.onWalletTrade({ wallet: "0xW1", side: "BUY", token: "tokA", price: 0.56, size: 300,
    tsMs: now() - 2000, txHash: "0xaaa", pseudonym: "Alpha" });
  r.onTrade({ token: "tokA", price: 0.54, size: 25, side: "SELL", serverTs: now() });
  r.onWalletTrade({ wallet: "0xW2", side: "SELL", token: "tokA", price: 0.54, size: 25,
    tsMs: now(), txHash: null });
  r.onWalletTrade({ wallet: "0xW3", side: "BUY", token: "tokA", price: 0.9, size: 7,
    tsMs: now(), txHash: "0xzzz" });
  const wt = ofType(r, "wallet_trade");
  assert.equal(wt[0].match.method, "tx_hash");
  assert.equal(wt[0].lag_ms, 2000);
  assert.equal(wt[1].match.method, "price_size_time");
  assert.equal(wt[2].match.method, null);
  r.stop("user");
  const end = ofType(r, "session_end")[0];
  assert.equal(end.wallets["0xW1"].buy_shares, 300);
  assert.deepEqual(end.wallets["0xW1"].pseudonyms, ["Alpha"]);
  assert.equal(end.wallets["0xW2"].sell_shares, 25);
  assert.equal(end.wallet_count, 3);
});

test("session_end aggregates per-token fill/cancel shares and busiest levels", () => {
  const { r, tick } = harness();
  r.observeBook("tokA", [{ price: 0.54, size: 1000 }], [{ price: 0.56, size: 800 }], {});
  r.onTrade({ token: "tokA", price: 0.56, size: 300, side: "BUY" });
  tick(10);
  r.onPriceChange({ token: "tokA", side: "SELL", price: 0.56, size: 500 });
  r.onPriceChange({ token: "tokA", side: "BUY", price: 0.54, size: 900 });
  r.stop("user");
  const end = ofType(r, "session_end")[0];
  assert.equal(end.tokens.tokA.likely_fill_shares, 300);
  assert.equal(end.tokens.tokA.likely_cancel_shares, 100);
  assert.equal(end.tokens.tokA.trades, 1);
  assert.ok(end.levels_by_churn.length >= 2);
  assert.equal(end.reason, "user");
});

/* ---------- quotes, US stats, cap ---------- */
test("bbo_change emits once per actual change, not per repeated quote", () => {
  const { r } = harness();
  r.onQuote({ token: "tokA", bid: 0.54, ask: 0.56, source: "us_lite" });
  r.onQuote({ token: "tokA", bid: 0.54, ask: 0.56, source: "us_lite" });
  r.onQuote({ token: "tokA", bid: 0.55, ask: 0.56, source: "us_lite" });
  const bbo = ofType(r, "bbo_change");
  assert.equal(bbo.length, 2);
  assert.equal(bbo[1].mid, 0.555);
  assert.equal(bbo[1].spread, 0.01);
});

test("market_stats records traded-share deltas (the only US fill signal), silent when unchanged", () => {
  const { r } = harness();
  r.onMarketStats("tokA", { sharesTraded: 1000, notionalTraded: 500 }, "us_book");
  r.onMarketStats("tokA", { sharesTraded: 1000, notionalTraded: 500 }, "us_book");
  r.onMarketStats("tokA", { sharesTraded: 1250, notionalTraded: 650 }, "us_book");
  const st = ofType(r, "market_stats");
  assert.equal(st.length, 1);
  assert.equal(st[0].d_shares_traded, 250);
  assert.equal(st[0].d_notional_traded, 150);
});

test("event cap truncates with a note but session_end still lands", () => {
  const { r, tick } = harness({ maxEvents: 6 });
  r.observeBook("tokA", [{ price: 0.54, size: 1000 }], [], {});
  for (let i = 0; i < 20; i++) {
    tick(1);
    r.onPriceChange({ token: "tokA", side: "BUY", price: 0.54, size: 1000 - i });
  }
  assert.equal(r.status().truncated, true);
  r.stop("event_cap");
  const ls = lines(r);
  assert.equal(ls[ls.length - 1].type, "session_end");
  assert.equal(ls[ls.length - 1].truncated, true);
  assert.ok(ls.some((l) => l.kind === "recorder_truncated"));
});

test("stop() merges caller coverage stats into session_end", () => {
  const { r } = harness();
  r.stop("user", { wallet_coverage: { polls: 9, fills_recorded: 3, newest_fill_server_ms: 123 } });
  const end = ofType(r, "session_end")[0];
  assert.equal(end.wallet_coverage.polls, 9);
  assert.equal(end.wallet_coverage.newest_fill_server_ms, 123);
});

test("mid-session token registration emits a token_meta line", () => {
  const { r } = harness();
  r.setTokenMeta("tokB", { outcome: "No" });
  const tm = ofType(r, "token_meta");
  assert.equal(tm.length, 1);
  assert.equal(tm[0].token, "tokB");
});

/* ---------- Data API v2 normalization (what the poller feeds in) ---------- */
test("normalizeWalletTrade maps snake_case v2 rows (and tolerates camelCase), seconds -> ms", () => {
  const v2 = PMAPI.normalizeWalletTrade({
    proxy_wallet: "0xW", side: "SELL", token_id: "123", condition_id: "0xc",
    size: 10, price: 0.4, timestamp: 1700000000, outcome: "No", outcome_index: 1,
    pseudonym: "Raw-Clearing", transaction_hash: "0xtx",
  });
  assert.equal(v2.wallet, "0xW");
  assert.equal(v2.token, "123");
  assert.equal(v2.tsMs, 1700000000000);
  assert.equal(v2.txHash, "0xtx");
  const v1 = PMAPI.normalizeWalletTrade({
    proxyWallet: "0xW", asset: "99", conditionId: "0xc", size: "5", price: "0.5",
    timestamp: 1700000000, transactionHash: "0xt2",
  });
  assert.equal(v1.token, "99");
  assert.equal(v1.size, 5);
  assert.equal(PMAPI.normalizeWalletTrade(null), null);
});

test("normalizeMarket now carries conditionId + tick for the wallet poller", () => {
  const ev = PMAPI.normalizeEvent({
    id: "1", slug: "e", title: "t",
    markets: [{ id: "9", conditionId: "0xcond", slug: "m", question: "q?",
      outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]',
      clobTokenIds: '["11","22"]', orderPriceMinTickSize: 0.001 }],
  });
  assert.equal(ev.markets[0].conditionId, "0xcond");
  assert.equal(ev.markets[0].tick, 0.001);
});

/* ---------- wiring the pure module cannot prove ---------- */
test("overlay has a header record button; manifest + background register recorder and data-api host", () => {
  const overlay = fs.readFileSync(require.resolve("../overlay.js"), "utf8");
  assert.match(overlay, /data-act="record"/);
  assert.match(overlay, /startRecording/);
  assert.match(overlay, /stopRecording\("market_switch"/, "market switch saves the recording");
  const manifest = fs.readFileSync(require.resolve("../manifest.json"), "utf8");
  assert.match(manifest, /lib\/recorder\.js/);
  assert.match(manifest, /data-api\.polymarket\.com/);
  const bg = fs.readFileSync(require.resolve("../background.js"), "utf8");
  assert.match(bg, /data-api\.polymarket\.com/);
});
