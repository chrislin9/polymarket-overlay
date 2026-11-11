# Polymarket Live Overlay (Chrome extension)

Paste a Polymarket market URL (from **polymarket.com** or **polymarket.us**) and get a floating, transparent, resizable overlay
on whatever page you're on. It shows the market's headline, a price chart, and
each leg of the market; click a leg to expand its live order book.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin the extension, click it, paste a URL such as
   `https://polymarket.com/event/presidential-election-winner-2028`, and press **Open overlay**.

No build step and no dependencies.

## Features

- **Both exchanges**: international `polymarket.com` and **Polymarket US** `polymarket.us`
  (shown with a `US` badge). Accepts `/event/<slug>`, `/event/<slug>/<market>` (that leg
  auto-expands), `/market/<slug>`, locale-prefixed URLs, sports game URLs, or a bare slug
  (tries international first, then US).
- **Polymarket-style UI**: event header, multi-outcome chart (top 4 outcomes, or both sides for
  head-to-head markets) with hover tooltips and 1H/6H/1D/1W/1M/ALL ranges, plus outcome rows with
  % chance and Buy Yes / Buy No prices.
- **Live order books**: click a row (or a Buy button) to expand it. Asks and bids show depth bars,
  cumulative totals, spread, and last trade. Changed levels flash. Data streams from Polymarket's
  public CLOB WebSocket, with auto-reconnect and a REST snapshot fallback.
- **Overlay window**: drag by the title bar; resize from any edge or corner; set background
  opacity (text stays legible); **click-through (ghost) mode** so you can use the page underneath;
  minimize (or double-click the bar); reload; **pop out** into a separate window. Position, size,
  and opacity are remembered. You can open several overlays at once.
- **Full screen**: if the window shrinks (e.g. leaving full screen), the panel shrinks to fit and
  keeps its resize corner on screen, then grows back to your chosen size when there's room. With
  element full screen (e.g. a video player's full-screen button), the overlay moves into the
  full-screen element so it stays visible.
- **Right-click** any Polymarket link, or a Polymarket page, → *Open in Polymarket overlay*.
- Pages where Chrome blocks extensions (`chrome://`, the Web Store) fall back to a pop-out window.

## How it works

| File | Role |
| --- | --- |
| `popup/` | URL input, opacity, recent markets |
| `background.js` | Context menu, pop-out windows |
| `content/content.js` | Injected on demand (`activeTab`). Draws the draggable/resizable shell in a closed Shadow DOM and hosts `overlay.html` in an iframe |
| `overlay/` | The market UI. Runs on the extension origin, so the page's CSP and CORS don't apply |
| `lib/api.js` | polymarket.com: Gamma API (`/events/slug`, `/markets/slug`) + CLOB `/book`, `/prices-history` |
| `lib/book.js` | Order book state and the polymarket.com WebSocket feed (`wss://ws-subscriptions-clob.polymarket.com/ws/market`) |
| `lib/us.js` | polymarket.us: `gateway.polymarket.us` metadata, books, and price history, plus the live Connect-RPC book stream |
| `lib/chart.js` | Dependency-free SVG line chart |

**Polymarket US notes.** Each US market is a single instrument. The Yes book is the instrument's
book, and the No book is its mirror image (No bid = 1 − Yes ask). Live US books come from
`gateway-ws-markets.polymarket.us`, the anonymous stream polymarket.us itself uses. The documented
US WebSocket requires an API key. That stream is undocumented and could change. If it stops
working, books still load from the public REST API (CDN-cached, ~30s), but they won't update live.
The US API doesn't expose per-market volume, so US rows don't show it.

Displayed probability follows Polymarket's rule: the midpoint when the spread is ≤ 10¢,
otherwise the last trade. Large events (sports games can have 500+ markets) only subscribe
to legs that are visible; **Show more** pages in more.

Read-only. No wallet, no trading, no API keys. Not affiliated with Polymarket.

`scripts/gen_icons.py` regenerates the icons.
