export function fmtCents(p) {
  if (p == null || !Number.isFinite(p)) return '–';
  const c = p * 100;
  return `${Number(c.toFixed(c < 1 ? 2 : 1))}¢`;
}

export function fmtChance(p) {
  if (p == null || !Number.isFinite(p)) return '–';
  if (p > 0 && p < 0.005) return '<1%';
  if (p < 1 && p > 0.995) return '>99%';
  return `${Math.round(p * 100)}%`;
}

export function fmtPct1(p) {
  if (p == null || !Number.isFinite(p)) return '–';
  return `${Number((p * 100).toFixed(1))}%`;
}

export function fmtUsdCompact(n) {
  if (!Number.isFinite(n)) return '$0';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `$${Math.round(n)}`;
}

const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtShares(n) {
  return n >= 100000 ? nf0.format(n) : nf2.format(n);
}

export function fmtUsd(n) {
  return `$${n >= 100000 ? nf0.format(n) : nf2.format(n)}`;
}

export function fmtDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
