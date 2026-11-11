import { parseMarketInput, isPolymarketUrl } from '../lib/url.js';
import { openOverlayInTab, openOverlayWindow, closeOverlaysInTab, isRestrictedUrl } from '../lib/inject.js';

const $ = (id) => document.getElementById(id);
const input = $('url');
const msg = $('msg');

function setMsg(text, isError = false) {
  msg.textContent = text;
  msg.classList.toggle('error', isError);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function readUrl() {
  const raw = input.value.trim();
  const parsed = parseMarketInput(raw);
  if (!parsed) {
    setMsg('Paste a Polymarket event or market URL.', true);
    input.focus();
    return null;
  }
  return parsed.href;
}

async function openInPage(url) {
  const tab = await activeTab();
  if (!tab || isRestrictedUrl(tab.url)) {
    setMsg('Chrome doesn’t allow overlays on this page — opening a window instead.');
    await openOverlayWindow(url);
    window.close();
    return;
  }
  try {
    await openOverlayInTab(tab.id, url);
    window.close();
  } catch (err) {
    console.error(err);
    setMsg(`Couldn’t attach to this page (${err.message || err}). Try “Window”.`, true);
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = readUrl();
  if (url) await openInPage(url);
});

$('window').addEventListener('click', async () => {
  const url = readUrl();
  if (!url) return;
  await openOverlayWindow(url);
  window.close();
});

$('closeAll').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || isRestrictedUrl(tab.url)) return;
  try {
    await closeOverlaysInTab(tab.id);
    setMsg('Closed.');
  } catch {
    setMsg('No overlays on this page.');
  }
});

// Opacity
const alpha = $('alpha');
const alphaVal = $('alphaVal');
function showAlpha(v) {
  alpha.value = String(v);
  alphaVal.textContent = `${Math.round(v * 100)}%`;
}
alpha.addEventListener('input', () => {
  const v = Number(alpha.value);
  showAlpha(v);
  chrome.storage.local.set({ bgAlpha: v });
});

function prettySlug(url) {
  const p = parseMarketInput(url);
  const slug = p ? p.marketSlug || p.eventSlug : url;
  return slug.replace(/-/g, ' ').replace(/\b\w/, (c) => c.toUpperCase());
}

async function init() {
  const { bgAlpha, recent, lastUrl } = await chrome.storage.local.get({ bgAlpha: 0.88, recent: [], lastUrl: '' });
  showAlpha(bgAlpha);

  const tab = await activeTab();
  if (tab && isPolymarketUrl(tab.url) && parseMarketInput(tab.url)) input.value = tab.url;
  else input.value = lastUrl || '';
  input.select();
  input.addEventListener('input', () => {
    setMsg('');
    chrome.storage.local.set({ lastUrl: input.value.trim() });
  });

  if (recent.length) {
    $('recentWrap').hidden = false;
    const list = $('recent');
    for (const url of recent) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = prettySlug(url);
      b.title = url;
      b.addEventListener('click', () => {
        input.value = url;
        openInPage(url);
      });
      li.append(b);
      list.append(li);
    }
  }
}

init();
