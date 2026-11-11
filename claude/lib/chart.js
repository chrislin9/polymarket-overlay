// Minimal dependency-free SVG line chart for outcome probabilities (0..1).

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = { l: 4, r: 40, t: 10, b: 22 };
const STEPS = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25];

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function niceStep(range) {
  for (const s of STEPS) if (range / s <= 5) return s;
  return 0.25;
}

function fmtTick(t, span) {
  const d = new Date(t);
  if (span <= 2 * 86400e3) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (span <= 120 * 86400e3) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).replace(' ', " '");
}

function fmtTooltipDate(t, span) {
  const d = new Date(t);
  const opts = span <= 7 * 86400e3
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleString('en-US', opts);
}

// Index of the last point with t <= target.
function bisect(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0 || points[0].t > t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class LineChart {
  constructor(container) {
    this.container = container;
    this.series = [];
    this.loading = false;
    this.message = '';
    this.width = 0;
    this.height = 0;
    this.hoverX = null;

    container.classList.add('chart');
    this.svg = svg('svg', { class: 'chart-svg' });
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tip';
    this.overlayMsg = document.createElement('div');
    this.overlayMsg.className = 'chart-msg';
    container.append(this.svg, this.tooltip, this.overlayMsg);

    this.svg.addEventListener('pointermove', (e) => {
      const r = this.svg.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.render();
    });
    this.svg.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.render();
    });

    this.ro = new ResizeObserver(() => {
      const w = Math.floor(container.clientWidth);
      const h = Math.floor(container.clientHeight);
      if (w !== this.width || h !== this.height) {
        this.width = w;
        this.height = h;
        this.render();
      }
    });
    this.ro.observe(container);
  }

  /** series: [{id, name, color, points: [{t, p}], live: {t, p} | null}] */
  setSeries(series) {
    this.series = series;
    this.render();
  }

  setStatus({ loading = false, message = '' } = {}) {
    this.loading = loading;
    this.message = message;
    this.render();
  }

  pointsOf(s) {
    if (!s.live) return s.points;
    const last = s.points[s.points.length - 1];
    if (last && last.t >= s.live.t) return s.points;
    return [...s.points, s.live];
  }

  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  draw() {
    const { width: W, height: H } = this;
    const root = this.svg;
    root.replaceChildren();
    root.setAttribute('viewBox', `0 0 ${Math.max(W, 1)} ${Math.max(H, 1)}`);
    root.setAttribute('width', W);
    root.setAttribute('height', H);

    const all = this.series.map((s) => ({ ...s, pts: this.pointsOf(s) })).filter((s) => s.pts.length);
    this.overlayMsg.textContent = this.loading ? 'Loading chart…' : this.message || (all.length ? '' : 'No price history');
    this.overlayMsg.style.display = this.overlayMsg.textContent ? '' : 'none';
    if (!all.length || W < 60 || H < 40) {
      this.tooltip.style.display = 'none';
      return;
    }

    let t0 = Infinity;
    let t1 = -Infinity;
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const s of all) {
      t0 = Math.min(t0, s.pts[0].t);
      t1 = Math.max(t1, s.pts[s.pts.length - 1].t);
      for (const pt of s.pts) {
        if (pt.p < pMin) pMin = pt.p;
        if (pt.p > pMax) pMax = pt.p;
      }
    }
    if (t1 <= t0) t1 = t0 + 60000;
    const pad = Math.max(0.01, (pMax - pMin) * 0.12);
    let lo = Math.max(0, pMin - pad);
    let hi = Math.min(1, pMax + pad);
    const step = niceStep(hi - lo);
    lo = Math.max(0, Math.floor(lo / step) * step);
    hi = Math.min(1, Math.ceil(hi / step) * step);
    if (hi - lo < step) hi = Math.min(1, lo + step);

    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const x = (t) => PAD.l + ((t - t0) / (t1 - t0)) * iw;
    const y = (p) => PAD.t + (1 - (p - lo) / (hi - lo)) * ih;

    // Grid + y labels
    const grid = svg('g', { class: 'grid' });
    for (let v = lo; v <= hi + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      grid.append(svg('line', { x1: PAD.l, x2: W - PAD.r, y1: yy, y2: yy }));
      const label = svg('text', { x: W - PAD.r + 6, y: yy + 3.5, class: 'ylab' });
      label.textContent = `${Number((v * 100).toFixed(step < 0.05 ? 1 : 0))}%`;
      grid.append(label);
    }
    // X labels
    const span = t1 - t0;
    const nX = Math.max(2, Math.min(6, Math.floor(iw / 90)));
    for (let i = 0; i <= nX; i++) {
      const t = t0 + (span * i) / nX;
      const label = svg('text', {
        x: x(t),
        y: H - 6,
        class: 'xlab',
        'text-anchor': i === 0 ? 'start' : i === nX ? 'end' : 'middle',
      });
      label.textContent = fmtTick(t, span);
      grid.append(label);
    }
    root.append(grid);

    // Lines
    for (const s of all) {
      let d = '';
      for (let i = 0; i < s.pts.length; i++) {
        const pt = s.pts[i];
        d += `${i ? 'L' : 'M'}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`;
      }
      root.append(svg('path', { d, class: 'line', stroke: s.color }));
      const last = s.pts[s.pts.length - 1];
      const cx = x(last.t);
      const cy = y(last.p);
      root.append(svg('circle', { cx, cy, r: 7, class: 'pulse', fill: s.color }));
      root.append(svg('circle', { cx, cy, r: 3.5, fill: s.color, class: 'dot' }));
    }

    // Hover crosshair + tooltip
    if (this.hoverX != null && this.hoverX >= PAD.l && this.hoverX <= W - PAD.r) {
      const t = t0 + ((this.hoverX - PAD.l) / iw) * span;
      const hx = Math.round(this.hoverX) + 0.5;
      root.append(svg('line', { x1: hx, x2: hx, y1: PAD.t, y2: H - PAD.b, class: 'cross' }));
      const rows = [];
      for (const s of all) {
        const i = bisect(s.pts, t);
        if (i < 0) continue;
        const p = s.pts[i].p;
        root.append(svg('circle', { cx: hx, cy: y(p), r: 4, fill: s.color, class: 'hover-dot' }));
        rows.push({ s, p });
      }
      rows.sort((a, b) => b.p - a.p);
      this.tooltip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'tip-date';
      head.textContent = fmtTooltipDate(t, span);
      this.tooltip.append(head);
      for (const { s, p } of rows) {
        const row = document.createElement('div');
        row.className = 'tip-row';
        const dot = document.createElement('i');
        dot.style.background = s.color;
        const name = document.createElement('span');
        name.textContent = all.length > 1 ? s.name : '';
        const val = document.createElement('b');
        val.textContent = `${Number((p * 100).toFixed(1))}%`;
        row.append(dot, name, val);
        this.tooltip.append(row);
      }
      this.tooltip.style.display = 'block';
      const tw = this.tooltip.offsetWidth;
      const left = this.hoverX + 12 + tw > W - PAD.r ? this.hoverX - 12 - tw : this.hoverX + 12;
      this.tooltip.style.left = `${Math.max(0, left)}px`;
    } else {
      this.tooltip.style.display = 'none';
    }
  }

  destroy() {
    this.ro.disconnect();
  }
}
