/* Background service worker.
   - Proxies REST fetches to Polymarket (host_permissions bypass page CORS).
   - Routes overlay show/toggle commands from the popup and Alt+P. */
"use strict";

const ALLOWED_HOSTS = new Set([
  "gamma-api.polymarket.com",
  "clob.polymarket.com",
  "gateway.polymarket.us",
  "data-api.polymarket.com",
]);

async function proxyFetch(url) {
  const u = new URL(url);
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error("Host not allowed: " + u.hostname);
  }
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
  if (!res.ok) {
    throw new Error("HTTP " + res.status + (text ? " — " + text.slice(0, 160) : ""));
  }
  return json === null ? text : json;
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return { ok: false, error: "No active tab" };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, message);
    return { ok: true, tabId: tab.id, res };
  } catch (e) {
    // Content script not present (e.g. chrome:// page or pre-install tab): try injecting.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["lib/geom.js", "lib/api.js", "lib/chart.js", "lib/recorder.js", "overlay.js", "content.js"],
      });
      const res = await chrome.tabs.sendMessage(tab.id, message);
      return { ok: true, tabId: tab.id, res };
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.message) || e2) };
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "PM_FETCH") {
    proxyFetch(msg.url)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }

  if (msg.type === "PM_SHOW_OVERLAY") {
    sendToActiveTab({ type: "PM_TOGGLE_OVERLAY", url: msg.url || null, forceShow: !msg.toggle })
      .then((r) => {
        if (!r.ok) {
          // Fallback: standalone full-page overlay.
          const page = chrome.runtime.getURL("overlay.html") +
            (msg.url ? "?url=" + encodeURIComponent(msg.url) : "");
          chrome.tabs.create({ url: page });
        }
        sendResponse(r);
      });
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-overlay") return;
  const r = await sendToActiveTab({ type: "PM_TOGGLE_OVERLAY" });
  if (!r.ok) {
    const { pmLastUrl } = await chrome.storage.local.get("pmLastUrl");
    const page = chrome.runtime.getURL("overlay.html") +
      (pmLastUrl ? "?url=" + encodeURIComponent(pmLastUrl) : "");
    chrome.tabs.create({ url: page });
  }
});
