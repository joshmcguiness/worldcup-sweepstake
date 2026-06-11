// Group-stage standings, ported verbatim from the prototype's computeStandings.
import { strengthOf } from './teams.js';

// scores: {matchNo: {h, a}} — group rank by composite:
// pts, then GD, then GF, then betting strength (so pre-tournament tables are
// seeded by the bookies), with a tiny per-team epsilon for a stable order.
export function computeStandings(teams, fixtures, scores) {
  const st = {};
  teams.forEach((t, idx) => {
    st[t.n] = { n: t.n, g: t.g, o: t.o, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, eps: idx };
  });
  fixtures.forEach((m) => {
    if (m.r > 3) return;
    const s = scores[m.no]; if (!s) return;
    let h = s.h, a = s.a;
    if (h === '' || a === '' || h == null || a == null) return;
    h = Number(h); a = Number(a); if (isNaN(h) || isNaN(a)) return;
    const H = st[m.h], A = st[m.a]; if (!H || !A) return;
    H.p++; A.p++; H.gf += h; H.ga += a; A.gf += a; A.ga += h;
    if (h > a) { H.w++; A.l++; } else if (h < a) { A.w++; H.l++; } else { H.d++; A.d++; }
  });
  Object.keys(st).forEach((k) => {
    const x = st[k];
    x.gd = x.gf - x.ga; x.pts = 3 * x.w + x.d;
    x.comp = x.pts * 1e6 + (x.gd + 50) * 1e3 + x.gf * 10 + strengthOf(x.o) - x.eps * 1e-6;
  });
  const byG = {};
  Object.keys(st).forEach((k) => { const x = st[k]; (byG[x.g] = byG[x.g] || []).push(x); });
  Object.keys(byG).forEach((g) => {
    byG[g].sort((a, b) => b.comp - a.comp);
    byG[g].forEach((x, i) => { x.rank = i + 1; });
  });
  return st;
}

export function teamByGroupRank(st) {
  const map = {};
  Object.keys(st).forEach((k) => { const x = st[k]; map[x.g + x.rank] = x.n; });
  return map;
}

export function resolveSlot(code, gmap) {
  if (/^[12][A-L]$/.test(code)) { const rank = +code[0], g = code.slice(1); return gmap[g + rank] || code; }
  if (code.charAt(0) === '3') return 'Best 3rd (' + code.slice(1) + ')';
  return code;
}
