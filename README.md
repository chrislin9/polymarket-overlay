# Polymarket Overlay — Live Order Book (Chrome Extension)

Paste any live Polymarket market URL — **polymarket.com or polymarket.us** — and pin a **transparent, draggable, resizable overlay** of that market on top of any web page. The overlay mirrors Polymarket's own event page: headline with volume/liquidity, a live price chart, and every market leg as an expandable row — expanding a leg reveals its **order book, updating live** (CLOB WebSocket internationally; on polymarket.us, the same anonymous realtime stream the website uses for logged-out visitors).

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
  - **Legs** — click any row to expand its order book: depth bars, shares, cumulative total, spread / mid / last trade, Yes/No book toggle, 5/8/15 depth. Book levels flash as orders change — **green** when a level grows (or a bid level appears), **red** when it shrinks (filled or cancelled) or an ask level appears; a fresh trade also flashes the last price green (buy) / red (sell). Multi-outcome events get a filter box and a "show all" expander (sorted by chance, like Polymarket). Sports events lead with the **moneyline** (who wins) as the default leg: polymarket.us legs follow the site's own layout (moneyline → main spread/total lines → full ladders → props), and polymarket.com sports legs go moneyline first, then by volume traded.
  - **Drag** the header to move, drag **⤡** (bottom-right) to resize — position, size, opacity, range and depth persist across pages. The panel re-clamps itself into the viewport whenever the window changes (resize, entering/exiting fullscreen, zoom), so the resize corner is always reachable; **double-click the header** to reset size/position to the default dock.
  - **Opacity slider** (footer) runs the full **0–100%** range + **◐ glass mode** for extra transparency. At low opacity the backdrop blur fades out with it, so at ~0% the panel is essentially clear text over the page — readable via a soft text shadow while a video plays underneath.
  - **Ghost mode** (ghost icon, header) makes the panel **click-through**: clicks and scrolling reach the page underneath, and only the header bar still captures the mouse (drag to move, or click the icon again to exit — the dashed border marks the mode). Not persisted; a fresh panel always starts solid.
  - **● REC** (header) records everything on screen — every order-book level change, trade print and (on polymarket.com) which wallet filled — to an NDJSON file for offline analysis of rival quoting behavior. Click again to stop and download. See **Recording** below.
  - **–** minimizes to just the header (handy as a price ticker); **✕** hides it (`Alt+P` brings it back).

On pages where injection isn't possible (e.g. `chrome://`), the same UI opens as a full-page tab instead.

## Recording (order-book capture for strategy analysis)

The **● REC** pill in the header captures everything the overlay is subscribed to while you watch: full-depth books for expanded legs (on polymarket.com the feed also sends full books for every *visible* leg, so those are captured too), top-of-book for the rest, every trade print, and — polymarket.com only — the public **Data API v2 trades feed** polled every ~4s, which names the **wallet, pseudonym and transaction hash behind each fill**. Clicking REC again stops and downloads one file, `polymarket-book-<event>-<timestamp>.jsonl`. Switching markets mid-recording saves the current file first. A failed download keeps the recording in memory behind a **↓ SAVE** retry (plus a footer re-download button), and recordings auto-save at a 750k-event safety cap.

**Format — NDJSON (one JSON object per line, ordered by `seq`), schema `pm-overlay-recording/1`:**

| Line `type` | What it carries |
|---|---|
| `session` | First line: event/markets, token→market/outcome/tick map, capture scope, inference method, and the caveats below (so they travel with the data) |
| `token_meta` | A leg subscribed mid-session (identity for late tokens) |
| `book_snapshot` | Full book per token: first sight + periodic checkpoints. Ground truth — snapshots + later deltas replay the book exactly (verified: 90/90 snapshot reconstructions on a live in-play capture) |
| `level_change` | The core series: one delta per price level (`prev_size → size`, `delta_usd`, `new_level`/`increase`/`decrease`/`removed`), book context after the change (`best_bid/ask/mid/spread`), level position (`dist_best_ticks`, `dist_mid_ticks`, `ahead_shares` = queue ahead, side depth), `ms_since_last_trade` + `last_trade_seq` for reaction-latency joins, and `cause_inferred` (below) |
| `trade` | Trade print: price/size, taker side, consumed book side, `tx_hash`, fee bps, book at print time; `explains_decrease_seqs` when the print lands just after the book drop it caused |
| `wallet_trade` | One wallet's fill (Data API v2): `wallet`, `pseudonym`, `name`, side, price/size, `tx_hash`, feed lag, and `match` to the WS print (`tx_hash`, else price+size+time, else explicit `null`) |
| `bbo_change` | Top-of-book moves for legs without a full book (US lite feed) |
| `market_stats` | US only: `shares_traded`/`notional_traded` deltas — the only fill-volume signal polymarket.us exposes publicly |
| `note` | Lifecycle + data quality: subscription changes, reconnects, wallet-poll errors/gaps, truncation |
| `session_end` | Last line: per-token aggregates (added/removed/likely-fill/likely-cancel shares, trade volume), busiest-100 price levels by churn, per-wallet buy/sell totals, counts, and `wallet_coverage` (polls, newest indexed fill, unattributed tail) |

Timestamps are `t_ms`/`dt_ms` (recorder receive clock, ms) plus `t_server_ms` copied from the feed when present; skew between them is not corrected.

**What the data can and cannot say (also embedded in every file):**

- Order books on every public Polymarket feed are **aggregated Level-2** (shares per price). Individual resting orders — and **which wallet owns a resting order — are not observable anywhere**. Rival behavior is visible as level dynamics (quote lifetimes, sizes, distances from mid, cancel/replace cadence, queue position), not as named orders.
- `cause_inferred` is a documented heuristic over those aggregates: a shrinking level is `likely_fill` when same-token/side/price trade prints within 5s cover the shrinkage, `likely_fill_partial` (with `fill_shares`/`cancel_shares` split) when they cover part, else `likely_cancel`. Raw deltas and prints are kept so you can re-derive it with your own rules. One live in-play capture showed why this matters: **~4.6M shares cancelled vs ~165 shares filled at-level** around 104 prints — quote flicker, not flow, dominates that book.
- Fills **can** be wallet-attributed on polymarket.com, but the trades feed **indexes in bursts (observed minutes apart)** and does not say maker vs taker. Short recordings may end before fills are indexed; `wallet_coverage.newest_fill_server_ms` tells you exactly how far attribution is current. For complete attribution, keep recording a few minutes past the action, or backfill later from `GET https://data-api.polymarket.com/v2/trades?condition=<conditionId>` and join on `tx_hash`. polymarket.us has no equivalent feed — US fills stay anonymous; US "No" books are derived mirrors (lines carry `source: "*_mirror"`), not independent liquidity.

**Analysis starter:**

```python
import pandas as pd
rows = pd.read_json("polymarket-book-....jsonl", lines=True)
ch = rows[rows.type == "level_change"]                     # rival quoting dynamics
react = ch[ch.ms_since_last_trade <= 250]                  # what rivals do within 250ms of a print
fills = rows[rows.type == "wallet_trade"]                  # who actually got filled
print(rows.iloc[-1].wallets)                               # per-wallet session totals
```

Sizes: a busy in-play event produced ~24k events / ~14 MB per minute across 24 tokens; quiet markets are far smaller. Events are held in memory until you stop (nothing is uploaded anywhere; the only extra network traffic is the trades poll).

## How it works

| Piece | International (polymarket.com) | US (polymarket.us) |
|---|---|---|
| Market metadata | Gamma API `gamma-api.polymarket.com` (`/events/slug/…`, `/markets/slug/…`) | Gateway `gateway.polymarket.us` (`/v1/events?slug=…`, `/v1/markets?slug=…`) |
| Order book + history | CLOB API `clob.polymarket.com` (`/book`, `/prices-history`) | Gateway (`/v1/markets/{slug}/book`, `/v1/price-history`); one book per market — the "No" book is the mirror of the "Yes" book |
| Fill attribution (recording only) | Data API `data-api.polymarket.com/v2/trades` (public; wallet + pseudonym + tx hash per fill) | None available publicly |
| Live updates | CLOB WebSocket `wss://ws-subscriptions-clob.polymarket.com/ws/market` (`book`, `price_change`, `last_trade_price`); REST fallback | Realtime stream `gateway-ws-markets.polymarket.us` (`gateway.realtime.v1.RealtimeService/Stream`, Connect protocol, JSON codec, no account needed): full book (~10 updates/s) for open legs + the chart leg, top of book for visible rows. Undocumented — it's what polymarket.us itself uses when logged out. While it's down, books are polled every ~3s with a cache-buster (the gateway REST sits behind a 30s Cloudflare cache) |

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
- [lib/recorder.js](lib/recorder.js) — NDJSON session recorder: book diffs, fill-vs-cancel inference, wallet-fill matching, session summary
- [lib/chart.js](lib/chart.js) — canvas price chart
- [lib/geom.js](lib/geom.js) — panel geometry clamping (keeps the resize corner on-screen after viewport changes)
- [test/api-geom.test.cjs](test/api-geom.test.cjs) — unit tests for URL parsing + geometry clamp (`node --test`)
- [test/overlay-fx.test.cjs](test/overlay-fx.test.cjs) — unit tests for book-flash classification, full-range opacity state, and ghost-mode pointer-events
- [test/recorder.test.cjs](test/recorder.test.cjs) — unit tests for recorder diffs, fill-vs-cancel inference, wallet matching, NDJSON envelope, and Data API v2 normalization
- [demo.html](demo.html) — try it without installing: serve this folder (`python3 -m http.server`) and open `demo.html?url=<polymarket-url>` (or `?sample=1` for simulated data)
