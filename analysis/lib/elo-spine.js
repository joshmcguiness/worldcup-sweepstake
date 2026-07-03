// Rebuild the live engine's Elo over a list of matches (from pull-asb.js) and
// attach, per match, the PRE-match Elo home-win probability plus the de-vigged
// opening and closing market probabilities. Shared by the threshold analysis
// and the walk-forward sim so both see exactly the ratings the site would have.

import { SPORTS } from '../../public/lib/sports.js';

const BASE = 1500;
const K = 40;
const regress = (elo) => { const o = {}; for (const [t, r] of Object.entries(elo)) o[t] = BASE + 0.75 * (r - BASE); return o; };
const devig = (h, a) => (h > 1 && a > 1 ? Math.round(((1 / h) / ((1 / h) + (1 / a))) * 1000) / 1000 : null);
const movMult = (marginAbs, drWinner) => Math.log(marginAbs + 1) * (2.2 / (0.001 * drWinner + 2.2));

// margin normalisation constant: mean ln(|margin|+1) over 2013–2015 so the
// margin update keeps the same average learning rate as binary Elo.
function normConstFor(matches) {
  const v = matches.filter((m) => m.season >= 2013 && m.season <= 2015).map((m) => Math.log(Math.abs(m.homeScore - m.awayScore) + 1));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 1;
}

// opts.margin = true weights each rating update by the score margin (538 MoV
// multiplier, mean-normalised). Validated to beat binary Elo out-of-sample.
export function attachElo(matches, league, opts = {}) {
  const cfg = SPORTS.find((s) => s.key === league);
  const sorted = matches.slice().sort((a, b) => a.dateMs - b.dateMs);
  const nc = opts.margin ? normConstFor(sorted) : 1;
  let elo = {}; let games = 0; let season = null;
  const out = [];
  for (const m of sorted) {
    if (season !== null && m.season !== season) { elo = regress(elo); games = 0; }
    season = m.season;
    const rh = (elo[m.home] ?? BASE) + cfg.hfa;
    const ra = elo[m.away] ?? BASE;
    const e = 1 / (1 + 10 ** (-(rh - ra) / 400));
    out.push({
      ...m,
      eloProb: Math.round(e * 1000) / 1000,
      eloDiff: Math.round((rh - ra) * 10) / 10,
      eloGames: games,
      mktOpen: devig(m.homeOpen, m.awayOpen),
      mktClose: devig(m.homeClose, m.awayClose),
    });
    const s = m.homeWin;
    let k = K;
    if (opts.margin) {
      const drWinner = s === 1 ? (rh - ra) : (ra - rh);
      k = K * (movMult(Math.abs(m.homeScore - m.awayScore), drWinner) / nc);
    }
    elo[m.home] = (elo[m.home] ?? BASE) + k * (s - e);
    elo[m.away] = (elo[m.away] ?? BASE) - k * (s - e);
    games++;
  }
  return out;
}

// Cluster a season's matches into rounds: a >3.5-day gap starts a new round.
export function clusterRounds(matches) {
  const sorted = matches.slice().sort((a, b) => a.dateMs - b.dateMs);
  const groups = []; let cur = []; let last = null;
  for (const m of sorted) {
    if (last != null && m.dateMs - last > 3.5 * 86400000) { groups.push(cur); cur = []; }
    cur.push(m); last = m.dateMs;
  }
  if (cur.length) groups.push(cur);
  return groups;
}
