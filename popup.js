/* Popup: URL entry, recents, launch controls. */
"use strict";

const $ = (s) => document.querySelector(s);
const msg = $("#msg");

function setMsg(t) { msg.textContent = t || ""; }

async function getStore(keys) {
  return chrome.storage.local.get(keys);
}
async function setStore(obj) {
  return chrome.storage.local.set(obj);
}

function looksLikePolymarket(url) {
  return /^https?:\/\/([^.]+\.)?polymarket\.(com\/(event|market)|us\/(event|market|sports))/.test(url || "");
}

async function pushRecent(url) {
  const { pmRecents = [] } = await getStore("pmRecents");
  const next = [url, ...pmRecents.filter((u) => u !== url)].slice(0, 6);
  await setStore({ pmRecents: next, pmLastUrl: url });
}

async function launch(url) {
  setMsg("");
  if (url) await pushRecent(url);
  const res = await chrome.runtime.sendMessage({ type: "PM_SHOW_OVERLAY", url: url || null });
  if (res && res.ok) {
    window.close();
  } else if (!res) {
    window.close(); // background opened the fallback tab
  } else {
    // background already falls back to a full-page tab when injection fails
    window.close();
  }
}

function renderRecents(list) {
  const ul = $("#recent");
  ul.innerHTML = "";
  if (!list || !list.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No markets yet — paste a URL above.";
    ul.appendChild(li);
    return;
  }
  list.forEach((u) => {
    const li = document.createElement("li");
    li.textContent = u.replace(/^https?:\/\//, "");
    li.title = u;
    li.addEventListener("click", () => launch(u));
    ul.appendChild(li);
  });
}

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#url").value.trim();
  if (!url) { setMsg("Paste a Polymarket market URL first."); return; }
  await launch(url);
});

$("#toggleBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "PM_SHOW_OVERLAY", toggle: true });
  window.close();
});

$("#fullBtn").addEventListener("click", async () => {
  const url = $("#url").value.trim();
  const { pmLastUrl } = await getStore("pmLastUrl");
  const target = url || pmLastUrl || "";
  if (target) await pushRecent(target);
  chrome.tabs.create({
    url: chrome.runtime.getURL("overlay.html") + (target ? "?url=" + encodeURIComponent(target) : ""),
  });
  window.close();
});

$("#autoShow").addEventListener("change", (e) => setStore({ pmAutoShow: e.target.checked }));

(async function init() {
  const { pmRecents = [], pmLastUrl, pmAutoShow } = await getStore(["pmRecents", "pmLastUrl", "pmAutoShow"]);
  renderRecents(pmRecents);
  $("#autoShow").checked = !!pmAutoShow;
  if (pmLastUrl && !$("#url").value) $("#url").placeholder = pmLastUrl.replace(/^https?:\/\//, "");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && looksLikePolymarket(tab.url)) {
    const b = $("#detected");
    b.style.display = "block";
    b.textContent = "📍 Overlay the market on this page: " + tab.url.replace(/^https?:\/\/([^/]+)/, "").slice(0, 60);
    b.addEventListener("click", () => launch(tab.url));
    $("#url").value = tab.url;
  }
})();
