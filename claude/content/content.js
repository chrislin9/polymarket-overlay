// Injected on demand into the active tab. Creates floating, draggable,
// resizable, semi-transparent overlay windows that host overlay.html in an
// iframe. Safe to inject repeatedly: it only initializes once per page.
(() => {
  if (window.__pmOverlay) return;

  const MIN_W = 300;
  const MIN_H = 160;
  const BAR_H = 30;
  const EDGE = 8; // minimum gap kept between the panel and the window edge when fitting
  const DEFAULT_GEOM = { width: 560, height: 680, right: 24, top: 24 };
  const overlays = new Set();
  let zTop = 2147483000;

  const store = chrome.storage.local;
  const settings = { bgAlpha: 0.88 };
  store.get({ bgAlpha: 0.88 }).then((s) => {
    settings.bgAlpha = s.bgAlpha;
    overlays.forEach((o) => o.applyAlpha());
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bgAlpha) {
      settings.bgAlpha = changes.bgAlpha.newValue;
      overlays.forEach((o) => o.applyAlpha());
    }
  });

  const CSS = `
    :host { all: initial; position: fixed; z-index: 2147483000; display: block; color-scheme: light; }
    * { box-sizing: border-box; }
    .wrap { position: absolute; inset: 0; }
    .frame {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      border-radius: 12px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 12px 40px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.25);
      font: 12px/1 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #e8ebee;
    }
    .bar {
      height: ${BAR_H}px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 6px 0 10px;
      background: rgba(14, 19, 25, var(--a)); cursor: grab; user-select: none; touch-action: none;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    .dragging .bar { cursor: grabbing; }
    .logo { width: 14px; height: 14px; flex: none; }
    .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #c9d0d7; }
    .ctl { display: flex; align-items: center; gap: 2px; flex: none; }
    button {
      all: unset; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 5px;
      color: #8b95a1; cursor: pointer;
    }
    button:hover { background: rgba(255,255,255,0.08); color: #fff; }
    button.on { color: #2d7ff9; background: rgba(45,127,249,0.15); }
    button.close:hover { background: #e5484d; color: #fff; }
    svg { width: 14px; height: 14px; display: block; }
    .alpha { display: flex; align-items: center; gap: 4px; color: #8b95a1; margin-right: 4px; }
    input[type=range] { -webkit-appearance: none; appearance: none; width: 64px; height: 4px; border-radius: 4px; background: rgba(255,255,255,0.18); outline: none; margin: 0; cursor: pointer; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #e8ebee; border: 0; }
    iframe { flex: 1; width: 100%; border: 0; display: block; background: transparent; color-scheme: light; }
    .busy iframe { pointer-events: none; }
    .ghost iframe { pointer-events: none; }
    .ghost .frame { border-style: dashed; box-shadow: none; }
    .minimized iframe, .minimized .rz { display: none; }
    .rz { position: absolute; z-index: 2; touch-action: none; }
    .rz.n, .rz.s { left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
    .rz.e, .rz.w { top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
    .rz.n { top: -3px; } .rz.s { bottom: -3px; } .rz.e { right: -3px; } .rz.w { left: -3px; }
    .rz.ne, .rz.nw, .rz.se, .rz.sw { width: 14px; height: 14px; }
    .rz.ne { top: -3px; right: -3px; cursor: nesw-resize; }
    .rz.sw { bottom: -3px; left: -3px; cursor: nesw-resize; }
    .rz.nw { top: -3px; left: -3px; cursor: nwse-resize; }
    .rz.se { bottom: -3px; right: -3px; cursor: nwse-resize; }
    .grip { position: absolute; right: 3px; bottom: 3px; width: 10px; height: 10px; pointer-events: none; opacity: 0.45;
      background: linear-gradient(135deg, transparent 0 55%, #8b95a1 55% 62%, transparent 62% 72%, #8b95a1 72% 79%, transparent 79%); }
    .minimized .grip, .ghost .grip { display: none; }
  `;

  const ICONS = {
    logo: '<svg viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#2d7ff9"/><rect x="4" y="4" width="8" height="2" rx="1" fill="#ff6b6b"/><rect x="4" y="7" width="5.5" height="2" rx="1" fill="#fff"/><rect x="4" y="10" width="7" height="2" rx="1" fill="#4ade80"/></svg>',
    alpha: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11A5.5 5.5 0 0 0 8 2.5z" fill="currentColor"/></svg>',
    ghost: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 14V7a5 5 0 0 1 10 0v7l-2-1.5L9.5 14 8 12.5 6.5 14 5 12.5z"/><circle cx="6.2" cy="7" r=".8" fill="currentColor"/><circle cx="9.8" cy="7" r=".8" fill="currentColor"/></svg>',
    min: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h8"/></svg>',
    restore: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>',
    popout: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5"/></svg>',
    reload: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/></svg>',
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  };

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

  async function loadGeom() {
    const { geom } = await store.get({ geom: null });
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const g = geom || {};
    const width = clamp(g.width || DEFAULT_GEOM.width, MIN_W, vw - 16);
    const height = clamp(g.height || DEFAULT_GEOM.height, MIN_H, vh - 16);
    let left = g.left != null ? g.left : vw - width - DEFAULT_GEOM.right;
    let top = g.top != null ? g.top : DEFAULT_GEOM.top;
    // Cascade additional overlays.
    left += overlays.size * 28;
    top += overlays.size * 28;
    return { left: clamp(left, 0, vw - width), top: clamp(top, 0, vh - BAR_H), width, height };
  }

  class Overlay {
    constructor(url, geom) {
      this.url = url;
      this.geom = geom;
      // The size the user chose. The live size can shrink below this to fit a
      // smaller window (e.g. after leaving full screen) and grows back later.
      this.pref = { width: geom.width, height: geom.height };
      this.minimized = false;
      this.ghost = false;

      this.host = document.createElement('pm-live-overlay');
      const root = this.host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS;

      // Resize handles live outside .frame so its rounded overflow clip
      // doesn't swallow the corners. State classes go on .wrap.
      this.wrap = document.createElement('div');
      this.wrap.className = 'wrap';
      this.frame = document.createElement('div');
      this.frame.className = 'frame';
      this.wrap.append(this.frame);
      this.frame.innerHTML = `
        <div class="bar" part="bar">
          <span class="logo">${ICONS.logo}</span>
          <span class="title">Polymarket</span>
          <span class="alpha" title="Background opacity">${ICONS.alpha}<input type="range" min="0" max="1" step="0.02"></span>
          <span class="ctl">
            <button class="ghost-btn" title="Click-through mode: interact with the page underneath">${ICONS.ghost}</button>
            <button class="reload" title="Reload">${ICONS.reload}</button>
            <button class="popout" title="Open in a separate window">${ICONS.popout}</button>
            <button class="min" title="Minimize">${ICONS.min}</button>
            <button class="close" title="Close">${ICONS.close}</button>
          </span>
        </div>`;
      this.iframe = document.createElement('iframe');
      this.iframe.setAttribute('allowtransparency', 'true');
      this.iframe.title = 'Polymarket live overlay';
      this.iframe.src = chrome.runtime.getURL(`overlay/overlay.html?url=${encodeURIComponent(url)}`);
      this.frame.append(this.iframe);
      const grip = document.createElement('div');
      grip.className = 'grip';
      this.frame.append(grip);
      for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const h = document.createElement('div');
        h.className = `rz ${dir}`;
        h.dataset.dir = dir;
        this.wrap.append(h);
        this.bindResize(h, dir);
      }
      root.append(style, this.wrap);

      this.q = (sel) => this.frame.querySelector(sel);
      this.titleEl = this.q('.title');
      this.alphaInput = this.q('input[type=range]');
      this.alphaInput.value = String(settings.bgAlpha);
      this.alphaInput.addEventListener('input', () => {
        settings.bgAlpha = Number(this.alphaInput.value);
        overlays.forEach((o) => o.applyAlpha());
        store.set({ bgAlpha: settings.bgAlpha });
      });
      this.q('.ghost-btn').addEventListener('click', () => this.setGhost(!this.ghost));
      this.q('.reload').addEventListener('click', () => {
        this.iframe.src = this.iframe.src;
      });
      this.q('.popout').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'pm-overlay:popout', url: this.url, width: this.geom.width, height: this.geom.height });
        this.close();
      });
      this.q('.min').addEventListener('click', () => this.setMinimized(!this.minimized));
      this.q('.close').addEventListener('click', () => this.close());
      this.bindDrag(this.q('.bar'));
      this.host.addEventListener('pointerdown', () => this.raise(), true);

      this.onMessage = (e) => {
        if (e.source !== this.iframe.contentWindow) return;
        const d = e.data;
        if (d && d.source === 'pm-overlay' && d.type === 'title' && typeof d.title === 'string') {
          this.titleEl.textContent = d.title;
          this.titleEl.title = d.title;
        }
      };
      window.addEventListener('message', this.onMessage);

      this.applyAlpha();
      this.layout();
      this.raise();
      overlayParent().append(this.host);
    }

    applyAlpha() {
      this.alphaInput.value = String(settings.bgAlpha);
      // The bar stays a bit more opaque than the content so it's always findable.
      const a = Math.min(1, Number(settings.bgAlpha) * 0.9 + 0.15);
      this.frame.style.setProperty('--a', String(a));
      const visibleBorder = settings.bgAlpha < 0.25 ? 'rgba(255,255,255,0.22)' : '';
      this.frame.style.borderColor = visibleBorder;
    }

    layout() {
      const { left, top, width, height } = this.geom;
      Object.assign(this.host.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${this.minimized ? BAR_H + 2 : height}px`,
      });
    }

    raise() {
      this.host.style.zIndex = String(++zTop);
    }

    persist() {
      store.set({ geom: { left: this.geom.left, top: this.geom.top, ...this.pref } });
    }

    setGhost(on) {
      this.ghost = on;
      this.wrap.classList.toggle('ghost', on);
      this.q('.ghost-btn').classList.toggle('on', on);
      // In ghost mode only the title bar captures the mouse.
      this.host.style.pointerEvents = on ? 'none' : '';
      this.q('.bar').style.pointerEvents = on ? 'auto' : '';
    }

    setMinimized(on) {
      this.minimized = on;
      this.wrap.classList.toggle('minimized', on);
      const b = this.q('.min');
      b.innerHTML = on ? ICONS.restore : ICONS.min;
      b.title = on ? 'Restore' : 'Minimize';
      this.fitToViewport();
    }

    bindDrag(bar) {
      let start = null;
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button, input')) return;
        e.preventDefault();
        bar.setPointerCapture(e.pointerId);
        start = { x: e.clientX, y: e.clientY, left: this.geom.left, top: this.geom.top };
        this.wrap.classList.add('busy', 'dragging');
      });
      bar.addEventListener('pointermove', (e) => {
        if (!start) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Keep at least part of the bar on screen.
        this.geom.left = clamp(start.left + e.clientX - start.x, 80 - this.geom.width, vw - 80);
        this.geom.top = clamp(start.top + e.clientY - start.y, 0, vh - BAR_H);
        this.layout();
      });
      const end = () => {
        if (!start) return;
        start = null;
        this.wrap.classList.remove('busy', 'dragging');
        this.persist();
      };
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);
      bar.addEventListener('dblclick', (e) => {
        if (!e.target.closest('button, input')) this.setMinimized(!this.minimized);
      });
    }

    bindResize(handle, dir) {
      let start = null;
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        start = { x: e.clientX, y: e.clientY, ...this.geom };
        this.wrap.classList.add('busy');
      });
      handle.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const g = { ...start };
        // Never let an edge be dragged past the window, or its handle becomes unreachable.
        if (dir.includes('e')) g.width = clamp(start.width + dx, MIN_W, vw - start.left);
        if (dir.includes('s')) g.height = clamp(start.height + dy, MIN_H, vh - start.top);
        if (dir.includes('w')) {
          g.width = clamp(start.width - dx, MIN_W, start.left + start.width);
          g.left = start.left + (start.width - g.width);
        }
        if (dir.includes('n')) {
          g.height = Math.max(MIN_H, start.height - dy);
          g.top = Math.max(0, start.top + (start.height - g.height));
          if (g.top === 0) g.height = start.top + start.height;
        }
        this.geom = { left: g.left, top: g.top, width: g.width, height: g.height };
        this.layout();
      });
      const end = () => {
        if (!start) return;
        start = null;
        this.wrap.classList.remove('busy');
        this.pref = { width: this.geom.width, height: this.geom.height };
        this.persist();
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    /** Fit the panel to the current window: size toward the user's preferred
     *  size (capped by the window), then move it so the bottom-right resize
     *  corner is on screen. Runs whenever the viewport changes. */
    fitToViewport() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const g = this.geom;
      g.width = clamp(this.pref.width, MIN_W, vw - 2 * EDGE);
      g.height = clamp(this.pref.height, MIN_H, vh - 2 * EDGE);
      const shownH = this.minimized ? BAR_H + 2 : g.height;
      g.left = clamp(g.left, Math.min(0, 80 - g.width), vw - g.width);
      g.top = clamp(g.top, 0, vh - shownH);
      this.layout();
    }

    close() {
      window.removeEventListener('message', this.onMessage);
      this.host.remove();
      overlays.delete(this);
    }
  }

  window.addEventListener('resize', () => overlays.forEach((o) => o.fitToViewport()));

  // Element full screen (e.g. a video player's full-screen button) renders only
  // the full-screen element, so move overlays into it and back out afterwards.
  // moveBefore() relocates without reloading the iframe; append() is the fallback.
  const NO_CHILDREN = new Set(['VIDEO', 'IMG', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT']);
  function overlayParent() {
    const fs = document.fullscreenElement;
    return fs && !NO_CHILDREN.has(fs.tagName) ? fs : document.documentElement;
  }
  function moveTo(parent, node) {
    if (node.parentNode === parent) return;
    if (typeof parent.moveBefore === 'function') {
      try {
        parent.moveBefore(node, null);
        return;
      } catch {}
    }
    parent.append(node);
  }
  document.addEventListener('fullscreenchange', () => {
    const parent = overlayParent();
    overlays.forEach((o) => moveTo(parent, o.host));
    // The viewport size settles after the transition; refit then.
    requestAnimationFrame(() => overlays.forEach((o) => o.fitToViewport()));
  });

  async function open(url) {
    const geom = await loadGeom();
    const o = new Overlay(url, geom);
    overlays.add(o);
    return true;
  }

  function closeAll() {
    [...overlays].forEach((o) => o.close());
  }

  window.__pmOverlay = { open, closeAll, count: () => overlays.size };
})();
