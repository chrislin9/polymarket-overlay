/* Durable unit tests (Node stdlib only): run with `node --test` from the repo root.
   Covers URL parsing for polymarket.com + polymarket.us and the panel
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
