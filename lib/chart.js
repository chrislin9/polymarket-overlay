/* Minimal canvas price chart (Polymarket-style): gradient area line,
   gridlines with % labels, dashed live-price line, hover crosshair. */
(function () {
  "use strict";

  function fmtPct(p) {
    if (p == null || !isFinite(p)) return "—";
    var v = p * 100;
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "%";
  }

  function fmtTime(ts, range) {
    var d = new Date(ts);
    if (range === "1H" || range === "6H" || range === "1D") {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      (range === "1W" ? " " + d.toLocaleTimeString([], { hour: "numeric" }) : "");
  }

  /* points: [{t, p}] with p in 0..1. opts: {color, livePrice, hoverIndex, range} */
  function draw(canvas, points, opts) {
    opts = opts || {};
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!points || points.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No price history yet", w / 2, h / 2);
      return null;
    }

    var color = opts.color || "#2e9e5b";
    var padL = 4, padR = 38, padT = 10, padB = 18;
    var iw = w - padL - padR, ih = h - padT - padB;
    var min = Infinity, max = -Infinity;
    points.forEach(function (pt) { min = Math.min(min, pt.p); max = Math.max(max, pt.p); });
    if (opts.livePrice != null) { min = Math.min(min, opts.livePrice); max = Math.max(max, opts.livePrice); }
    var span = Math.max(max - min, 0.02);
    min -= span * 0.12; max += span * 0.12;
    min = Math.max(0, min); max = Math.min(1, max);
    if (max - min < 0.01) { max = Math.min(1, min + 0.01); }

    var t0 = points[0].t, t1 = points[points.length - 1].t;
    var x = function (t) { return padL + (t1 === t0 ? iw : ((t - t0) / (t1 - t0)) * iw); };
    var y = function (p) { return padT + (1 - (p - min) / (max - min)) * ih; };

    // gridlines + y labels
    ctx.font = "9.5px system-ui, sans-serif";
    ctx.textAlign = "left";
    for (var i = 0; i <= 3; i++) {
      var p = min + ((max - min) * i) / 3;
      var yy = y(p);
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fillText(fmtPct(p), padL + iw + 5, yy + 3);
    }
    // x labels (first / mid / last)
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.textAlign = "left";
    ctx.fillText(fmtTime(t0, opts.range), padL, h - 5);
    ctx.textAlign = "center";
    ctx.fillText(fmtTime((t0 + t1) / 2, opts.range), padL + iw / 2, h - 5);
    ctx.textAlign = "right";
    ctx.fillText(fmtTime(t1, opts.range), padL + iw, h - 5);

    // area + line
    var grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, hexA(color, 0.32));
    grad.addColorStop(1, hexA(color, 0.0));
    ctx.beginPath();
    points.forEach(function (pt, idx) {
      var px = x(pt.t), py = y(pt.p);
      if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineTo(x(t1), padT + ih);
    ctx.lineTo(x(t0), padT + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // live dashed line + end dot
    var last = points[points.length - 1];
    var liveP = opts.livePrice != null ? opts.livePrice : last.p;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y(liveP)); ctx.lineTo(padL + iw, y(liveP)); ctx.stroke();
    ctx.setLineDash([]);
    dot(ctx, x(last.t), y(liveP), color);

    // hover crosshair
    var hover = null;
    if (opts.hoverX != null) {
      var hx = Math.max(padL, Math.min(padL + iw, opts.hoverX));
      var best = null, bestD = Infinity;
      points.forEach(function (pt) {
        var d = Math.abs(x(pt.t) - hx);
        if (d < bestD) { bestD = d; best = pt; }
      });
      if (best) {
        hover = best;
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.beginPath(); ctx.moveTo(x(best.t), padT); ctx.lineTo(x(best.t), padT + ih); ctx.stroke();
        dot(ctx, x(best.t), y(best.p), "#fff");
      }
    }
    return { hover: hover, min: min, max: max };
  }

  function dot(ctx, cx, cy, color) {
    ctx.beginPath();
    ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "rgba(10,12,16,0.9)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  window.PMChart = { draw: draw, fmtPct: fmtPct, fmtTime: fmtTime };
})();
