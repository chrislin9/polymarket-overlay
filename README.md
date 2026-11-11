# Polymarket Overlay — Live Order Book (Chrome Extension)

Paste any live Polymarket market URL — **polymarket.com or polymarket.us** — and pin a **transparent, draggable, resizable overlay** of that market on top of any web page. The overlay mirrors Polymarket's own event page: headline with volume/liquidity, a live price chart, and every market leg as an expandable row — expanding a leg reveals its **order book, updating live** (CLOB WebSocket internationally; the US gateway is polled, since the US streaming API needs account API keys).

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension, then click its icon on any tab

## Use

- **Popup:** paste a Polymarket URL (`polymarket.com/event/…`, `/market/…`, or `polymarket.us/event/…`, `/sports/<league>/…`) and hit **Overlay**. If the current tab is a Polymarket (either site) market page, one click overlays that market. Recent markets are remembered.
- **`Alt+P`** toggles the overlay on the current page.
- **In the overlay:**
  - Paste a different URL in the top field to switch markets without reopening.
  - **Chart** — price history for the focused leg (1H / 6H / 1D / 1W / 1M / ALL), hover for values; expanding a leg focuses the chart on it. The dashed line tracks the live price.
  - **Legs** — click any row to expand its order book: depth bars, shares, cumulative total, spread / mid / last trade, Yes/No book toggle, 5/8/15 depth. Book levels flash as orders change — **green** when a level grows (or a bid level appears), **red** when it shrinks (filled or cancelled) or an ask level appears; a fresh trade also flashes the last price green (buy) / red (sell). Multi-outcome events get a filter box and a "show all" expander (sorted by chance, like Polymarket).
  - **Drag** the header to move, drag **⤡** (bottom-right) to resize — position, size, opacity, range and depth persist across pages. The panel re-clamps itself into the viewport whenever the window changes (resize, entering/exiting fullscreen, zoom), so the resize corner is always reachable; **double-click the header** to reset size/position to the default dock.
  - **Opacity slider** (footer) runs the full **0–100%** range + **◐ glass mode** for extra transparency. At low opacity the backdrop blur fades out with it, so at ~0% the panel is essentially clear text over the page — readable via a soft text shadow while a video plays underneath.
  - **Ghost mode** (ghost icon, header) makes the panel **click-through**: clicks and scrolling reach the page underneath, and only the header bar still captures the mouse (drag to move, or click the icon again to exit — the dashed border marks the mode). Not persisted; a fresh panel always starts solid.
  - **–** minimizes to just the header (handy as a price ticker); **✕** hides it (`Alt+P` brings it back).

On pages where injection isn't possible (e.g. `chrome://`), the same UI opens as a full-page tab instead.

## How it works

| Piece | International (polymarket.com) | US (polymarket.us) |
|---|---|---|
| Market metadata | Gamma API `gamma-api.polymarket.com` (`/events/slug/…`, `/markets/slug/…`) | Gateway `gateway.polymarket.us` (`/v1/events?slug=…`, `/v1/markets?slug=…`) |
| Order book + history | CLOB API `clob.polymarket.com` (`/book`, `/prices-history`) | Gateway (`/v1/markets/{slug}/book`, `/v1/price-history`); one book per market — the "No" book is the mirror of the "Yes" book |
| Live updates | CLOB WebSocket `wss://ws-subscriptions-clob.polymarket.com/ws/market` (`book`, `price_change`, `last_trade_price`); REST fallback | Book polled every ~3s (rotating across open legs); the US streaming API requires Ed25519 account keys, so polling is the public live feed |

- The content script renders into a **Shadow DOM**, so host-page CSS can't break the overlay (and vice versa).
- REST calls are proxied through the background service worker (`host_permissions`), so page CORS policies never block them.
- Subscriptions are capped to visible/expanded legs to stay light on 100+-outcome events.
- No build step, no dependencies, no accounts or API keys — read-only public data. Trading links out to Polymarket.

## Files

- [manifest.json](manifest.json) — MV3 manifest (popup, background, content script, `Alt+P`)
- [popup.html](popup.html) / [popup.js](popup.js) — URL entry, recents, launch
- [background.js](background.js) — fetch proxy + show/toggle routing + fallback tab
- [content.js](content.js) — Shadow-DOM mount on any page
- [overlay.js](overlay.js) — the widget: headline, chart, legs, live books
- [overlay.css](overlay.css) — Polymarket-dark translucent styling
- [overlay.html](overlay.html) + [overlay-page.js](overlay-page.js) — full-page mode (`?url=…`, `?sample=1`)
- [lib/api.js](lib/api.js) — URL parsing (.com + .us), Gamma/CLOB REST + WebSocket, US gateway REST
- [lib/chart.js](lib/chart.js) — canvas price chart
- [lib/geom.js](lib/geom.js) — panel geometry clamping (keeps the resize corner on-screen after viewport changes)
- [test/api-geom.test.cjs](test/api-geom.test.cjs) — unit tests for URL parsing + geometry clamp (`node --test`)
- [test/overlay-fx.test.cjs](test/overlay-fx.test.cjs) — unit tests for book-flash classification, full-range opacity state, and ghost-mode pointer-events
- [demo.html](demo.html) — try it without installing: serve this folder (`python3 -m http.server`) and open `demo.html?url=<polymarket-url>` (or `?sample=1` for simulated data)
