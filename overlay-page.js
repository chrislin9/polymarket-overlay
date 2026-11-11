/* Boot for overlay.html (full-page mode). Separate file because MV3
   extension pages forbid inline scripts. */
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var storage = {
    get: function (keys) {
      if (typeof chrome !== "undefined" && chrome.storage) {
        return new Promise(function (r) { chrome.storage.local.get(keys, r); });
      }
      var out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
        try { var v = localStorage.getItem(k); if (v !== null) out[k] = JSON.parse(v); } catch (e) {}
      });
      return Promise.resolve(out);
    },
    set: function (obj) {
      if (typeof chrome !== "undefined" && chrome.storage) { chrome.storage.local.set(obj); return; }
      Object.keys(obj).forEach(function (k) {
        try { localStorage.setItem(k, JSON.stringify(obj[k])); } catch (e) {}
      });
    }
  };
  fetch("overlay.css").then(function (r) { return r.text(); }).then(function (css) {
    window.__pm = window.PMOverlay.create(document.getElementById("app"), {
      standalone: true,
      cssText: css,
      storage: storage,
      initialUrl: params.get("url") || null,
      onClose: function () { window.close(); }
    });
    if (params.get("sample") === "1") window.__pm.loadSample();
  });
})();
