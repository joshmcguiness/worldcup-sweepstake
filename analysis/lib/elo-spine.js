// Rebuild the live engine's Elo over a list of matches (from pull-asb.js) and
// attach, per match, the PRE-match Elo home-win probability plus the de-vigged
// opening and closing market probabilities. Shared by the threshold analysis
// and the walk-forward sim so both see exactly the ratings the site would have.

import { SPORTS, updateElo } from '../../public/lib/sports.js';

const BASE = 1500;
const regress = (elo) => { const o = {}; for (const [t, r] of Object.entries(elo)) o[t] = BASE + 0.75 * (r - BASE); return o; };
const devig = (h, a) => (h > 1 && a > 1 ? Math.round(((1 / h) / ((1 / h) + (1 / a))) * 1000) / 1000 : null);

export function attachElo(matches, league) {
  const cfg = SPORTS.find((s) => s.key === league);
  const sorted = matches.slice().sort((a, b) => a.dateMs - b.dateMs);
  let state = { elo: {}, rated: [], eloGames: 0 };
  let season = null; let idx = 0;
  const out = [];
  for (const m of sorted) {
    if (season !== null && m.season !== season) state = { elo: regress(state.elo), rated: [], eloGames: 0 };
    season = m.season;
    const rh = (state.elo[m.home] ?? BASE) + cfg.hfa;
    const ra = state.elo[m.away] ?? BASE;
    out.push({
      ...m,
      eloProb: Math.round((1 / (1 + 10 ** (-(rh - ra) / 400))) * 1000) / 1000,
      eloDiff: Math.round((rh - ra) * 10) / 10,
      eloGames: state.eloGames,
      mktOpen: devig(m.homeOpen, m.awayOpen),
      mktClose: devig(m.homeClose, m.awayClose),
    });
    state = updateElo(state, [{ MatchNumber: idx++, HomeTeam: m.home, AwayTeam: m.away, HomeTeamScore: m.homeScore, AwayTeamScore: m.awayScore }], cfg);
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
