import { openOverlayInTab, openOverlayWindow, isRestrictedUrl } from './lib/inject.js';
import { parseMarketInput } from './lib/url.js';

const PM_PATTERNS = ['https://polymarket.com/*', 'https://*.polymarket.com/*', 'https://polymarket.us/*', 'https://*.polymarket.us/*'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pm-overlay-link',
      title: 'Open in Polymarket overlay',
      contexts: ['link'],
      targetUrlPatterns: PM_PATTERNS,
    });
    chrome.contextMenus.create({
      id: 'pm-overlay-page',
      title: 'Open this market in an overlay',
      contexts: ['page'],
      documentUrlPatterns: PM_PATTERNS,
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'pm-overlay-link' ? info.linkUrl : info.pageUrl;
  if (!url || !parseMarketInput(url)) return;
  if (tab && tab.id != null && !isRestrictedUrl(tab.url)) {
    try {
      await openOverlayInTab(tab.id, url);
      return;
    } catch (err) {
      console.warn('[pm-overlay] inject failed, using a window', err);
    }
  }
  openOverlayWindow(url);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'pm-overlay:popout' && typeof msg.url === 'string' && parseMarketInput(msg.url)) {
    openOverlayWindow(msg.url, { width: msg.width || 500, height: (msg.height || 730) + 30 });
  }
});
