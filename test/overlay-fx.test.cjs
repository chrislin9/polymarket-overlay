/* Durable unit tests (Node stdlib only): run with `node --test` from the repo root.
   Covers the pure logic behind three overlay features ported from the
   alternate build: order-book flash classification (size up/down/new level),
   full-range opacity state (0% floor, glass factor, blur ramp, see-through
   threshold), and ghost-mode pointer-events. overlay.js is a browser IIFE;
   it only touches the DOM inside create(), so loading it with a `window`
   stub exposes PMOverlay._test without a DOM. DOM wiring that the pure
   helpers cannot prove (slider floor, ghost button, persisted-0 restore)
   is pinned with minimal source checks and exercised in demo.html. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

globalThis.window = {};
require("../overlay.js");
const T = window.PMOverlay._test;
const SRC = fs.readFileSync(require.resolve("../overlay.js"), "utf8");

/* ---------- flash classification ---------- */
test("first sight of a book primes without flashing (no snapshot strobe)", () => {
  const prev = new Map(), flashes = new Map();
  T.classifyLevelChanges(prev, flashes, "bids", [{ price: 0.54, size: 100 }], false, 1000);
  assert.equal(flashes.size, 0);
  assert.equal(prev.get("bids@0.54"), 100);
});

test("shrinking size (fill or cancel) flashes down; growing size flashes up", () => {
  const prev = new Map([["asks@0.56", 500]]), flashes = new Map();
  T.classifyLevelChanges(prev, flashes, "asks", [{ price: 0.56, size: 200 }], true, 2000);
  assert.deepEqual(flashes.get("asks@0.56"), { dir: "down", t: 2000 });
  T.classifyLevelChanges(prev, flashes, "asks", [{ price: 0.56, size: 700 }], true, 3000);
  assert.deepEqual(flashes.get("asks@0.56"), { dir: "up", t: 3000 });
});

test("new level flashes by side: bids up (green), asks down (red)", () => {
  const prev = new Map(), flashes = new Map();
  T.classifyLevelChanges(prev, flashes, "bids", [{ price: 0.5, size: 10 }], true, 0);
  T.classifyLevelChanges(prev, flashes, "asks", [{ price: 0.6, size: 10 }], true, 0);
  assert.equal(flashes.get("bids@0.5").dir, "up");
  assert.equal(flashes.get("asks@0.6").dir, "down");
});

test("unchanged size does not re-flash; vanished level is pruned so a return counts as new", () => {
  const prev = new Map(), flashes = new Map();
  const lvl = [{ price: 0.54, size: 100 }];
  T.classifyLevelChanges(prev, flashes, "bids", lvl, false, 0);
  T.classifyLevelChanges(prev, flashes, "bids", lvl, true, 100);
  assert.equal(flashes.size, 0, "same size, no flash");
  T.classifyLevelChanges(prev, flashes, "bids", [], true, 200);
  assert.equal(prev.has("bids@0.54"), false, "cancelled level pruned");
  T.classifyLevelChanges(prev, flashes, "bids", lvl, true, 300);
  assert.equal(flashes.get("bids@0.54").dir, "up", "reappearing level is new again");
});

test("expired flashes are dropped after FLASH_MS", () => {
  const prev = new Map(), flashes = new Map();
  T.classifyLevelChanges(prev, flashes, "bids", [{ price: 0.5, size: 1 }], true, 0);
  assert.equal(flashes.size, 1);
  T.classifyLevelChanges(prev, flashes, "bids", [{ price: 0.5, size: 1 }], true, T.FLASH_MS);
  assert.equal(flashes.size, 0);
});

/* ---------- opacity state ---------- */
test("opacity reaches fully translucent: 0% gives alpha 0, no blur, see-through", () => {
  const s = T.opacityState(0, false);
  assert.equal(s.alpha, 0);
  assert.equal(s.effective, 0);
  assert.equal(s.blurPx, 0);
  assert.equal(s.seeThrough, true);
});

test("default 88% keeps the current look: 14px blur, not see-through", () => {
  const s = T.opacityState(88, false);
  assert.equal(s.alpha, 0.88);
  assert.equal(s.blurPx, 14);
  assert.equal(s.seeThrough, false);
});

test("blur ramps down with low opacity so video underneath stays watchable", () => {
  assert.equal(T.opacityState(25, false).blurPx, 7);
  assert.ok(T.opacityState(10, false).blurPx <= 3);
});

test("glass multiplies effective alpha and can enter see-through", () => {
  const s = T.opacityState(100, true);
  assert.equal(s.effective, 0.55);
  assert.equal(s.seeThrough, false, "exactly 0.55 is not below the threshold");
  assert.equal(T.opacityState(50, true).seeThrough, true);
});

test("opacity percent is clamped to 0..100", () => {
  assert.equal(T.opacityState(-5, false).alpha, 0);
  assert.equal(T.opacityState(150, false).alpha, 1);
});

/* ---------- ghost mode ---------- */
test("ghost mode lets clicks through the frame but keeps the header bar clickable", () => {
  assert.deepEqual(T.ghostPointerEvents(true), { frame: "none", bar: "auto" });
  assert.deepEqual(T.ghostPointerEvents(false), { frame: "", bar: "" });
});

/* ---------- DOM wiring the pure helpers cannot prove ---------- */
test("opacity slider floor is 0 (was 25)", () => {
  assert.match(SRC, /type="range" min="0" max="100"/);
});

test("header has a ghost toggle button", () => {
  assert.match(SRC, /data-act="ghost"/);
});

test("persisted 0% opacity restores (null check, not truthiness)", () => {
  assert.match(SRC, /cfg\.pmOpacity != null/);
});
