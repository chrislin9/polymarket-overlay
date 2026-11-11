// Shared helpers used by the popup and the background service worker.

export async function openOverlayInTab(tabId, url) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (u) => window.__pmOverlay.open(u),
    args: [url],
  });
  await addRecent(url);
}

export async function closeOverlaysInTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__pmOverlay && window.__pmOverlay.closeAll(),
  });
}

export async function openOverlayWindow(url, { width = 500, height = 760 } = {}) {
  await chrome.windows.create({
    url: chrome.runtime.getURL(`overlay/overlay.html?mode=window&url=${encodeURIComponent(url)}`),
    type: 'popup',
    width: Math.round(width),
    height: Math.round(height),
  });
  await addRecent(url);
}

export async function addRecent(url) {
  const { recent = [] } = await chrome.storage.local.get({ recent: [] });
  const next = [url, ...recent.filter((u) => u !== url)].slice(0, 6);
  await chrome.storage.local.set({ recent: next });
}

/** True for pages Chrome never lets extensions script. */
export function isRestrictedUrl(url) {
  return !url || /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url) ||
    /^https:\/\/chrome(webstore)?\.google\.com\/(webstore)?/i.test(url);
}
