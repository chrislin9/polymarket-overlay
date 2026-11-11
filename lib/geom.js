/* Panel geometry: defaults + clamping so the panel (and its bottom-right
   resize handle) always stays reachable inside the current viewport —
   e.g. after exiting fullscreen into a smaller window.
   Loads as a classic script (window.PMGeom) and in Node for tests. */
(function (root) {
  "use strict";

  var DEFAULTS = { w: 430, h: 640 };
  var MIN_W = 320, MIN_H = 240, MARGIN = 8;

  function finite(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  /* geom: {x, y, w, h} — x/y may be null (right-anchored default position).
     Returns a new geometry guaranteed to fit inside vw x vh. */
  function clampGeometry(geom, vw, vh) {
    geom = geom || {};
    vw = Math.max(80, finite(vw) || 1280);
    vh = Math.max(80, finite(vh) || 800);
    var maxW = Math.max(40, vw - MARGIN * 2);
    var maxH = Math.max(40, vh - MARGIN * 2);
    var w = finite(geom.w) || DEFAULTS.w;
    var h = finite(geom.h) || DEFAULTS.h;
    w = Math.min(Math.max(w, Math.min(MIN_W, maxW)), maxW);
    h = Math.min(Math.max(h, Math.min(MIN_H, maxH)), maxH);
    var x = finite(geom.x), y = finite(geom.y);
    if (x !== null) x = Math.min(Math.max(x, 0), Math.max(0, vw - w));
    if (y !== null) y = Math.min(Math.max(y, 0), Math.max(0, vh - h));
    return { x: x, y: y, w: Math.round(w), h: Math.round(h) };
  }

  var api = { clampGeometry: clampGeometry, DEFAULTS: DEFAULTS, MIN_W: MIN_W, MIN_H: MIN_H };
  root.PMGeom = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
