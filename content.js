/* Content script: mounts the overlay into a Shadow DOM host pinned to the
   viewport, toggled from the popup / Alt+P. Guarded against double-inject. */
(function () {
  "use strict";
  if (window.__PM_OVERLAY_MOUNTED__) return;
  window.__PM_OVERLAY_MOUNTED__ = true;

  var HOST_ID = "pm-overlay-host";
  var host = null, controller = null, cssText = null, visible = false;

  var storage = {
    get: function (keys) {
      return new Promise(function (resolve) {
        try { chrome.storage.local.get(keys, resolve); } catch (e) { resolve({}); }
      });
    },
    set: function (obj) {
      try { chrome.storage.local.set(obj); } catch (e) {}
    },
  };

  function loadCSS() {
    if (cssText !== null) return Promise.resolve(cssText);
    return fetch(chrome.runtime.getURL("overlay.css"))
      .then(function (r) { return r.text(); })
      .then(function (t) { cssText = t; return t; })
      .catch(function () { cssText = ""; return ""; });
  }

  function applyGeom(g) {
    host.style.width = g.w + "px";
    host.style.height = g.h + "px";
    if (g.x != null) {
      host.style.left = g.x + "px";
      host.style.top = (g.y || 0) + "px";
      host.style.right = "auto";
      host.style.bottom = "auto";
    } else {
      host.style.left = "auto";
      host.style.right = "16px";
      host.style.top = "16px";
      host.style.bottom = "auto";
    }
    host.dataset.h = host.style.height;
  }

  function clampHostIntoViewport(persist) {
    if (!host || !window.PMGeom) return;
    var r = host.getBoundingClientRect();
    if (!r.width) return;
    // Minimized = header-only bar (44px): keep its restored height, clamp position/width only.
    var minimized = r.height <= 48;
    var restoreH = parseInt(host.dataset.h, 10) || r.height;
    var g = window.PMGeom.clampGeometry(
      { x: r.left, y: r.top, w: r.width, h: minimized ? restoreH : r.height },
      window.innerWidth, window.innerHeight);
    host.style.left = g.x + "px";
    host.style.top = g.y + "px";
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.width = g.w + "px";
    host.dataset.h = g.h + "px";
    if (!minimized) host.style.height = g.h + "px";
    if (persist) storage.set({ pmGeom: g });
  }

  var clampTimer = null;
  function scheduleClamp() {
    clearTimeout(clampTimer);
    clampTimer = setTimeout(function () { if (visible) clampHostIntoViewport(true); }, 120);
  }

  function ensureHost(geom) {
    if (host) return host;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;z-index:2147483647;display:none;";
    var g = window.PMGeom
      ? window.PMGeom.clampGeometry(geom || {}, window.innerWidth, window.innerHeight)
      : { x: geom && geom.x, y: geom && geom.y, w: (geom && geom.w) || 430, h: (geom && geom.h) || 640 };
    applyGeom(g);
    (document.documentElement || document.body).appendChild(host);
    // Viewport changes (window resize, exiting/entering fullscreen, zoom)
    // must never strand the panel's resize corner off-screen.
    window.addEventListener("resize", scheduleClamp);
    document.addEventListener("fullscreenchange", scheduleClamp);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleClamp);
    return host;
  }

  function show(url) {
    return Promise.all([loadCSS(), storage.get("pmGeom")]).then(function (res) {
      var css = res[0], geom = (res[1] || {}).pmGeom;
      ensureHost(geom);
      if (!controller) {
        var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
        controller = window.PMOverlay.create(shadow, {
          standalone: false,
          frameEl: host,
          cssText: css,
          storage: storage,
          initialUrl: url || null,
          onClose: hide,
        });
      } else if (url) {
        controller.loadUrl(url);
      }
      host.style.display = "block";
      visible = true;
      clampHostIntoViewport(false); // stored geometry may predate a smaller window
      if (!url && controller) controller.focusInput();
      return { visible: true };
    });
  }

  function hide() {
    if (host) host.style.display = "none";
    visible = false;
    return { visible: false };
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== "PM_TOGGLE_OVERLAY") return false;
    if (visible && !msg.forceShow && !msg.url) {
      sendResponse(hide());
      return false;
    }
    show(msg.url || null).then(sendResponse).catch(function (e) {
      sendResponse({ visible: false, error: String(e && e.message || e) });
    });
    return true;
  });

  // If we're on a Polymarket market page, offer the overlay pre-loaded once.
  try {
    if (/^https?:\/\/([^.]+\.)?polymarket\.(com\/(event|market)|us\/(event|market|sports))/.test(location.href)) {
      storage.get("pmAutoShow").then(function (cfg) {
        if (cfg && cfg.pmAutoShow) show(location.href);
      });
    }
  } catch (e) {}
})();
