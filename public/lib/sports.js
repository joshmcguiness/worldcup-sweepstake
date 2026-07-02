// More Sports Bets — weekly AFL / NRL / NFL / EPL bet model.
//
// Built on the World Cup post-mortem (2 Jul 2026), which is baked in as law:
//  - the model NEVER prices its own bets: probabilities come from an Elo
//    rating built on real results, and a bet exists only where a real
//    bookmaker price beats it (positive edge) — self-priced fair-odds bets
//    ran -3.5% ROI at the World Cup, market-priced +5.6%
//  - payout floor 1.20, probability floor 0.45, one bet per match,
//    at most 5 calls per round, never re-take an open position
//  - books lock when generated and history is never rewritten
//
// Data: fixturedownload.com season feeds (fixtures + scores + Winner) and
// The Odds API h2h prices (region au/us). All functions here are pure;
// fetching lives in build/refresh.js.

export const SPORTS = [
  {
    key: 'afl', label: 'AFL', emoji: '🏉',
    feed: 'afl-2026', priorFeed: 'afl-2025', oddsKey: 'aussierules_afl', oddsRegions: 'au',
    drawRate: 0.005, hfa: 55, k: 40, expectedStart: 'late March 2026',
    aliases: { gwsgiants: 'Greater Western Sydney Giants', goldcoastsuns: 'Gold Coast Suns' },
  },
  {
    key: 'nrl', label: 'NRL', emoji: '🏈',
    feed: 'nrl-2026', priorFeed: 'nrl-2025', oddsKey: 'rugbyleague_nrl', oddsRegions: 'au',
    drawRate: 0.003, hfa: 45, k: 40, expectedStart: 'early March 2026',
    aliases: {},
  },
  {
    key: 'nfl', label: 'NFL', emoji: '🏈',
    feed: 'nfl-2026', priorFeed: 'nfl-2025', oddsKey: 'americanfootball_nfl', oddsRegions: 'au,us',
    drawRate: 0.003, hfa: 48, k: 32, expectedStart: '10 September 2026 (expected)',
    aliases: {},
  },
  {
    key: 'epl', label: 'EPL', emoji: '⚽',
    feed: 'epl-2026', priorFeed: 'epl-2025', oddsKey: 'soccer_epl', oddsRegions: 'au,uk',
    drawRate: 0.25, hfa: 60, k: 32, expectedStart: 'mid-August 2026 (expected)',
    aliases: {
      manutd: 'Manchester United', mancity: 'Manchester City', spurs: 'Tottenham Hotspur',
      wolves: 'Wolverhampton Wanderers', newcastle: 'Newcastle United', westham: 'West Ham United',
      brighton: 'Brighton and Hove Albion', nottmforest: 'Nottingham Forest',
    },
  },
];

const BASE_ELO = 1500;

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

// Match a fixture-feed team name against an Odds-API team name. Feeds use
// short forms ("Storm", "GWS GIANTS", "Man Utd"); the API uses full names.
export function sameTeam(feedName, apiName, aliases = {}) {
  const f = normName(aliases[normName(feedName)] || feedName);
  const a = normName(apiName);
  if (!f || !a) return false;
  return f === a || a.includes(f) || f.includes(a);
}

function played(row) {
  return row.HomeTeamScore != null && row.AwayTeamScore != null;
}

// The feed's DateUtc uses a space ("2026-07-04 05:00:00Z") which Safari (and
// strictly, the spec) won't Date.parse — normalise to ISO before parsing.
export function kickTime(row) {
  return Date.parse(String(row.DateUtc || '').replace(' ', 'T'));
}

// Incorporate any newly-final results into the Elo table (margin-agnostic,
// draw = half win). state is mutated-by-copy and returned.
export function updateElo(state, rows, cfg) {
  const elo = { ...(state.elo || {}) };
  const rated = new Set(state.rated || []);
  let n = state.eloGames || 0;
  for (const m of rows) {
    if (!played(m) || rated.has(m.MatchNumber)) continue;
    const h = m.HomeTeam, a = m.AwayTeam;
    const rh = elo[h] ?? BASE_ELO, ra = elo[a] ?? BASE_ELO;
    const eH = 1 / (1 + 10 ** (-((rh + cfg.hfa) - ra) / 400));
    const hs = Number(m.HomeTeamScore), as = Number(m.AwayTeamScore);
    const sH = hs > as ? 1 : hs < as ? 0 : 0.5;
    elo[h] = Math.round((rh + cfg.k * (sH - eH)) * 10) / 10;
    elo[a] = Math.round((ra + cfg.k * (eH - sH)) * 10) / 10;
    rated.add(m.MatchNumber);
    n++;
  }
  return { ...state, elo, rated: [...rated], eloGames: n };
}

// Season handover: carry a prior season's ratings, regressed one quarter of
// the way back to the mean (standard Elo practice — form persists, but less
// than fans think). Rated-match set resets for the new season.
export function bootstrapElo(priorRows, cfg) {
  const prior = updateElo({ elo: {}, rated: [], eloGames: 0 }, priorRows, cfg);
  const elo = {};
  Object.entries(prior.elo).forEach(([t, r]) => {
    elo[t] = Math.round((BASE_ELO + 0.75 * (r - BASE_ELO)) * 10) / 10;
  });
  return { elo, rated: [], eloGames: 0, bootstrappedFrom: cfg.priorFeed };
}

// P(team beats opp outright) — Elo two-way scaled by the code's draw rate
// (a draw loses the bet, exactly like World Cup singles).
export function sportMatchProb(state, cfg, team, opp, teamIsHome) {
  const rt = (state.elo?.[team] ?? BASE_ELO) + (teamIsHome ? cfg.hfa : 0);
  const ro = (state.elo?.[opp] ?? BASE_ELO) + (teamIsHome ? 0 : cfg.hfa);
  const p2 = 1 / (1 + 10 ** (-(rt - ro) / 400));
  return (1 - cfg.drawRate) * p2;
}

// The next round with games still to play: smallest RoundNumber that has an
// unplayed future fixture. Returns {round, matches} or null (season over /
// not started yet with no fixtures).
export function nextRound(rows, now = Date.now()) {
  const future = rows.filter((m) => !played(m) && kickTime(m) > now);
  if (!future.length) return null;
  const round = Math.min(...future.map((m) => Number(m.RoundNumber) || 0));
  return { round, matches: future.filter((m) => Number(m.RoundNumber) === round) };
}

// Average h2h price per side for one fixture from the Odds API events list.
export function fixtureOdds(row, oddsEvents, aliases) {
  const kick = kickTime(row);
  const ev = (oddsEvents || []).find((e) => Math.abs(Date.parse(e.commence_time) - kick) < 36 * 3600 * 1000
    && ((sameTeam(row.HomeTeam, e.home_team, aliases) && sameTeam(row.AwayTeam, e.away_team, aliases))
      || (sameTeam(row.HomeTeam, e.away_team, aliases) && sameTeam(row.AwayTeam, e.home_team, aliases))));
  if (!ev) return null;
  const agg = { home: [], away: [] };
  for (const bk of ev.bookmakers || []) {
    for (const mk of bk.markets || []) {
      if (mk.key !== 'h2h') continue;
      for (const o of mk.outcomes || []) {
        if (o.price <= 1) continue;
        if (sameTeam(row.HomeTeam, o.name, aliases)) agg.home.push(o.price);
        else if (sameTeam(row.AwayTeam, o.name, aliases)) agg.away.push(o.price);
      }
    }
  }
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);
  const home = avg(agg.home), away = avg(agg.away);
  return home && away ? { home, away } : null;
}

// Build the round's book of up to five calls under the v2 rules.
export function generateSportBook(state, cfg, rows, oddsEvents, now = Date.now()) {
  const nr = nextRound(rows, now);
  if (!nr) return null;
  const openTeams = new Set();
  (state.book?.bets || []).concat((state.history || []).flatMap((d) => d.bets))
    .filter((b) => b.status === 'pending')
    .forEach((b) => { openTeams.add(b.team); openTeams.add(b.opp); });
  const candidates = [];
  for (const m of nr.matches) {
    const prices = fixtureOdds(m, oddsEvents, cfg.aliases);
    if (!prices) continue;
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? m.HomeTeam : m.AwayTeam;
      const opp = side === 'home' ? m.AwayTeam : m.HomeTeam;
      const prob = Math.round(sportMatchProb(state, cfg, team, opp, side === 'home') * 1000) / 1000;
      const price = prices[side];
      const edge = Math.round((prob * price - 1) * 1000) / 1000;
      // v2 law: probability floor, payout floor, POSITIVE edge only, and no
      // piling onto a team that already carries an open position
      if (prob < 0.45 || price < 1.2 || edge < 0.03) continue;
      if (openTeams.has(team) || openTeams.has(opp)) continue;
      candidates.push({
        id: `${cfg.key}-r${nr.round}-${m.MatchNumber}`,
        round: nr.round,
        no: m.MatchNumber,
        team, opp,
        home: side === 'home',
        kickoff: new Date(kickTime(m)).toISOString(),
        prob, price, edge,
        stake: 100,
        payoutOdds: price,
        name: `${team} Value Call`,
        selection: `${team} to beat ${opp}${side === 'home' ? '' : ' (away)'}`,
        comment: `Elo (built from ${state.eloGames || 0} real results) makes ${team} ${Math.round((state.elo?.[team] ?? BASE_ELO) - (state.elo?.[opp] ?? BASE_ELO))} points ${((state.elo?.[team] ?? BASE_ELO) >= (state.elo?.[opp] ?? BASE_ELO)) ? 'stronger' : 'weaker — but home advantage flips it'} → ${(prob * 100).toFixed(0)}% to win. The books pay ${price.toFixed(2)}, a ${(edge * 100).toFixed(0)}% edge. Positive-edge-only, price ≥ 1.20 — the World Cup rules.`,
        status: 'pending',
      });
    }
  }
  // one bet per match (better side only), then top five by edge
  const byMatch = {};
  candidates.forEach((c) => { if (!byMatch[c.no] || c.edge > byMatch[c.no].edge) byMatch[c.no] = c; });
  const bets = Object.values(byMatch).sort((a, b) => b.edge - a.edge).slice(0, 5)
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  return { round: nr.round, bets };
}

// Settle from the feed: draws lose (like World Cup singles); an equal score
// with a named Winner (golden point etc.) follows the Winner.
export function settleSportBets(bets, rows) {
  const byNo = {};
  rows.forEach((m) => { byNo[m.MatchNumber] = m; });
  return (bets || []).map((b) => {
    if (b.status !== 'pending') return b;
    const m = byNo[b.no];
    if (!m || !played(m)) return b;
    const hs = Number(m.HomeTeamScore), as = Number(m.AwayTeamScore);
    let winner = hs > as ? m.HomeTeam : as > hs ? m.AwayTeam : (m.Winner || null);
    return { ...b, status: winner === b.team ? 'won' : 'lost' };
  });
}

// Does this sport need a (1-credit) odds fetch this run? Only when a new
// round's book is due — keeps all four codes to a few credits a week.
export function sportNeedsOdds(state, rows, now = Date.now()) {
  const nr = nextRound(rows, now);
  if (!nr) return false;
  if (state.book && state.book.round === nr.round) return false; // book already locked
  const firstKick = Math.min(...nr.matches.map((m) => kickTime(m)));
  return firstKick - now < 6 * 86400000; // lock the book inside 6 days of the round
}

// One sport's full weekly cycle: rate new results, settle, archive finished
// rounds, and lock the next round's book when due (oddsEvents may be null if
// no fetch was needed/possible this run).
export function rollSport(prevState, cfg, rows, oddsEvents, now = Date.now()) {
  let state = { elo: {}, rated: [], eloGames: 0, ...(prevState || {}) };
  state = updateElo(state, rows, cfg);
  let book = state.book ? { ...state.book, bets: settleSportBets(state.book.bets, rows) } : null;
  let history = (state.history || []).map((h) => ({ ...h, bets: settleSportBets(h.bets, rows) }));
  if (book && book.bets.every((b) => b.status !== 'pending')) {
    history = [...history, book].slice(-30);
    book = null;
  }
  if (!book && oddsEvents) {
    const fresh = generateSportBook({ ...state, book, history }, cfg, rows, oddsEvents, now);
    if (fresh && fresh.bets.length) book = { ...fresh, generatedAt: new Date(now).toISOString() };
  }
  const nr = nextRound(rows, now);
  const started = rows.some(played);
  return {
    ...state,
    book,
    history,
    inSeason: started || Boolean(nr),
    started,
    nextKickoff: nr ? new Date(Math.min(...nr.matches.map((m) => kickTime(m)))).toISOString() : null,
    nextRoundNumber: nr ? nr.round : null,
    teams: Object.keys(state.elo).length,
  };
}
