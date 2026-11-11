// Parse whatever the user pastes (full URL, partial URL, or bare slug) into
// slugs we can resolve, plus which exchange ("venue") they belong to:
//   venue 'intl' -> polymarket.com  (international, Gamma + CLOB APIs)
//   venue 'us'   -> polymarket.us   (Polymarket US, gateway.polymarket.us APIs)
//
// Supported shapes (either domain):
//   https://polymarket.com/event/<event-slug>
//   https://polymarket.com/event/<event-slug>/<market-slug>
//   https://polymarket.com/market/<market-slug>
//   https://polymarket.com/<locale>/event/<event-slug>      (locale prefix)
//   https://polymarket.us/sports/<league>/<event-slug>      (best effort: last segment)
//   polymarket.us/event/<slug>                               (no scheme)
//   <slug>                                                   (bare slug: tries international, then US)

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

const VENUES = {
  intl: { host: 'polymarket.com', base: 'https://polymarket.com', label: 'Polymarket' },
  us: { host: 'polymarket.us', base: 'https://polymarket.us', label: 'Polymarket US' },
};

export function venueInfo(venue) {
  return VENUES[venue] || VENUES.intl;
}

export function venueOfHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  for (const [key, v] of Object.entries(VENUES)) {
    if (h === v.host || h.endsWith(`.${v.host}`)) return key;
  }
  return null;
}

export function parseMarketInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (SLUG_RE.test(s) && !s.includes('.')) {
    return { venue: 'intl', eventSlug: s, marketSlug: null, guess: true, bareSlug: true, href: `${VENUES.intl.base}/event/${s}` };
  }

  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const venue = venueOfHost(url.hostname);
  if (!venue) return null;
  const base = VENUES[venue].base;

  const parts = url.pathname.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const clean = (p) => (p && SLUG_RE.test(p) ? p : null);
  const href = `${base}${url.pathname}`;

  const ei = parts.indexOf('event');
  if (ei !== -1 && clean(parts[ei + 1])) {
    return { venue, eventSlug: parts[ei + 1], marketSlug: clean(parts[ei + 2]), guess: false, href };
  }
  const mi = parts.indexOf('market');
  if (mi !== -1 && clean(parts[mi + 1])) {
    return { venue, eventSlug: null, marketSlug: parts[mi + 1], guess: false, href };
  }
  // Sports pages and other layouts: the last path segment is usually the event slug.
  const last = clean(parts[parts.length - 1]);
  if (last && parts.length > 0) {
    return { venue, eventSlug: last, marketSlug: null, guess: true, href };
  }
  return null;
}

export function isPolymarketUrl(raw) {
  try {
    return venueOfHost(new URL(raw).hostname) !== null;
  } catch {
    return false;
  }
}
