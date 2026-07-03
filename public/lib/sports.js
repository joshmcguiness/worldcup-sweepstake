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
    // margin-aware Elo: norm = mean ln(|margin|+1) over 2013–15 (analysis/margin-elo.js)
    marginElo: { k: 40, norm: 3.30 },
  },
  {
    key: 'nrl', label: 'NRL', emoji: '🏈',
    feed: 'nrl-2026', priorFeed: 'nrl-2025', oddsKey: 'rugbyleague_nrl', oddsRegions: 'au',
    drawRate: 0.003, hfa: 45, k: 40, expectedStart: 'early March 2026',
    aliases: {},
    // margin-aware Elo: norm = mean ln(|margin|+1) over 2013–15 (analysis/margin-elo.js)
    marginElo: { k: 40, norm: 2.40 },
    // Representative windows: club line-ups are gutted by Origin camps and
    // team-level Elo cannot see who's missing (the market can). Inside these
    // windows the edge requirement DOUBLES and every call carries a warning.
    repWindows: [{ from: '2026-05-25', to: '2026-07-12', note: 'State of Origin period' }],
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

// The margin-of-victory multiplier (FiveThirtyEight form): a bigger win moves
// ratings more, log-damped so blowouts don't run away, and shrunk when a strong
// favourite wins (the second term) to curb autocorrelation. Normalised by
// cfg.marginElo.norm so the average update keeps the same learning rate as the
// binary K. Validated to beat binary Elo out-of-sample (analysis/margin-elo.js).
function marginMultiplier(marginAbs, drWinner, cfg) {
  return (Math.log(marginAbs + 1) * (2.2 / (0.001 * drWinner + 2.2))) / cfg.marginElo.norm;
}

// Incorporate any newly-final results into the Elo table. When cfg.marginElo is
// set the update is weighted by the score margin; a draw (no margin) always uses
// the plain K. state is mutated-by-copy and returned.
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
    let k = cfg.k;
    if (cfg.marginElo && sH !== 0.5) {
      const drWinner = sH === 1 ? ((rh + cfg.hfa) - ra) : (ra - (rh + cfg.hfa));
      k = cfg.marginElo.k * marginMultiplier(Math.abs(hs - as), drWinner, cfg);
    }
    elo[h] = Math.round((rh + k * (sH - eH)) * 10) / 10;
    elo[a] = Math.round((ra + k * (eH - sH)) * 10) / 10;
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

/* ---------- comment ingredients (all from the fixtures feed) ---------- */

// A team's last-n results, oldest -> newest, e.g. 'WLWWW'.
export function formString(rows, team, n = 5) {
  return rows
    .filter((m) => played(m) && (m.HomeTeam === team || m.AwayTeam === team))
    .sort((a, b) => kickTime(a) - kickTime(b))
    .slice(-n)
    .map((m) => {
      const mine = m.HomeTeam === team ? m.HomeTeamScore : m.AwayTeamScore;
      const theirs = m.HomeTeam === team ? m.AwayTeamScore : m.HomeTeamScore;
      return mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
    })
    .join('');
}

// The most recent completed meeting between two teams this season, or null.
export function lastMeeting(rows, a, b) {
  const met = rows
    .filter((m) => played(m) && ((m.HomeTeam === a && m.AwayTeam === b) || (m.HomeTeam === b && m.AwayTeam === a)))
    .sort((x, y) => kickTime(y) - kickTime(x))[0];
  if (!met) return null;
  const hs = Number(met.HomeTeamScore), as = Number(met.AwayTeamScore);
  const winner = hs > as ? met.HomeTeam : as > hs ? met.AwayTeam : null;
  return { winner, margin: Math.abs(hs - as), round: met.RoundNumber };
}

// Average points against (the defensive stat that reads well in a sentence).
export function avgAgainst(rows, team) {
  let pts = 0, n = 0;
  rows.forEach((m) => {
    if (!played(m)) return;
    if (m.HomeTeam === team) { pts += Number(m.AwayTeamScore); n++; }
    else if (m.AwayTeam === team) { pts += Number(m.HomeTeamScore); n++; }
  });
  return n ? Math.round((pts / n) * 10) / 10 : null;
}

// Why this is a good bet vs the market, in ≤50 words: Elo standing + one
// concrete form/head-to-head fact + model % vs market-implied % + what the
// price means — with honest framing when the model is sticking its neck out.
export function betComment(cfg, state, rows, { team, opp, home, prob, price, edge }) {
  const rank = 1 + Object.entries(state.elo || {}).filter(([, r]) => r > (state.elo?.[team] ?? BASE_ELO)).length;
  const implied = Math.round(100 / price);
  const model = Math.round(prob * 100);
  const edgeTxt = Math.round(edge * 100);
  const fTeam = formString(rows, team), fOpp = formString(rows, opp);
  const wTeam = (fTeam.match(/W/g) || []).length, lOpp = (fOpp.match(/L/g) || []).length;
  const met = lastMeeting(rows, team, opp);
  // pick ONE colour fact, best first: a head-to-head result, the opponent's
  // slump, or the team's own run
  let colour;
  if (met && met.winner === team) colour = `beat ${opp} by ${met.margin} in Round ${met.round}`;
  else if (lOpp >= 3 && fTeam.length >= 5) colour = `have won ${wTeam} of their last 5 while ${opp} lost ${lOpp} of 5`;
  else if (wTeam >= 4) colour = `have won ${wTeam} of their last 5`;
  else colour = `sit #${rank} on Elo after ${state.eloGames || 0} rated results`;
  const caveat = met && met.winner === opp ? ` (despite losing the Round ${met.round} meeting by ${met.margin})` : '';
  const an = /^(8($|\d)|11$|18($|\d))/.test(String(edgeTxt)) ? 'an' : 'a'; // "an 8% edge", "an 11% edge"
  if (edge >= 0.25) {
    return `The model's boldest call: ${team} ${colour}${caveat}, yet the market rates them just ${implied}%. Elo says ${model}%. At $${price.toFixed(2)} that's ${an} ${edgeTxt}% edge — real value, or the market knows something Elo can't.`;
  }
  if (prob >= 0.6) {
    const def = avgAgainst(rows, team);
    return `Elo's #${rank} side${def != null ? `, conceding ${def} a game,` : ''} against ${opp}, who've lost ${lOpp} of their last 5${caveat}. The market prices this ${implied}%; the ratings say ${model}%. At $${price.toFixed(2)}, ${an} ${edgeTxt}% edge.`;
  }
  return `${team} ${colour}${caveat} and sit #${rank} on Elo, but the books${home ? '' : ` lean on ${opp}'s home ground and`} pay $${price.toFixed(2)} — an implied ${implied}%. Our number is ${model}%: ${an} ${edgeTxt}% edge the market hasn't priced yet.`;
}

/* ---------- Mission A: why is this price different? ----------
 *
 * Every candidate that clears the base v2 gates has its disagreement with the
 * market CLASSIFIED before it is bet. The bookmaker's price is the best public
 * forecast of a match: when our Elo number beats it there are only two
 * explanations — we know something it doesn't (rare for a public rating), or it
 * knows something we don't (usually team news). Each cause carries the minimum
 * edge we'll accept for it (Infinity = never bet). See docs/OPUS-ROADMAP.md §1.
 */
export const EDGE_CAUSES = {
  'model-signal': { bar: 0.03, warn: false, label: 'model signal' },
  'longshot-bias': { bar: 0.12, warn: false, label: 'longshot bias' },
  steam: { bar: 0.06, warn: true, label: 'steam against us' },
  lineup: { bar: 0.06, warn: true, label: 'rep-window lineup risk' },
  'stale-elo': { bar: Infinity, warn: true, label: 'immature ratings' },
  'vig-artifact': { bar: Infinity, warn: false, label: 'inside the vig' },
  'lineup-blocked': { bar: Infinity, warn: true, label: 'our side is depleted' },
  implausible: { bar: Infinity, warn: true, label: 'too good to be true' },
};

const STALE_ELO_GAMES_PER_TEAM = 1.5; // < this many rated games/team ⇒ green
const LONGSHOT_PRICE = 3.5;           // above here, books shade underdogs
const IMPLAUSIBLE_EDGE = 0.5;         // 50%+ edge vs a real price ⇒ our error (threshold backtest: ~−18% ROI)

function decide(cause, note) {
  const c = EDGE_CAUSES[cause];
  return { cause, bar: c.bar, note, warn: c.warn };
}

// Pull one match's named-lineup value split out of a lineups map (or null).
// Shape: lineups[teamName] = { outValue, totalValue } — the fantasy-valued
// worth of the players missing from the named side vs the full-strength side.
export function lineupDelta(lineups, team, opp) {
  if (!lineups) return null;
  const t = lineups[team], o = lineups[opp];
  if (!t || !o || !(t.totalValue > 0) || !(o.totalValue > 0)) return null;
  return { teamValue: t.totalValue, teamOutValue: t.outValue || 0, oppValue: o.totalValue, oppOutValue: o.outValue || 0 };
}

// Classify one candidate edge. ctx carries the core price/prob plus optional
// context the live engine may or may not have yet: an earlier price snapshot
// (steam), named-lineup value deltas (lineup), and ratings maturity.
export function diagnoseEdge(ctx) {
  const { edge, price, oppPrice, openingPrice = null, lineup = null, eloGames = 0, teams = 0, rep = null } = ctx;

  // 0) IMPLAUSIBLE — an edge this large against a real market price is almost
  // always OUR model erring, not value the market missed. The threshold backtest
  // (analysis/thresholds.js) showed 50%+ edges returned ~−18% ROI in both codes.
  // The clearest "too good to be true" signal (roadmap §3.0) — never bet it.
  if (edge > IMPLAUSIBLE_EDGE)
    return decide('implausible', `${Math.round(edge * 100)}% edge is too good to be true — almost certainly our model erring, not the market`);

  // 1) LINEUP — the market has priced players the model can't see.
  if (lineup) {
    const ourLoss = lineup.teamOutValue / lineup.teamValue;
    const theirLoss = lineup.oppOutValue / lineup.oppValue;
    if (ourLoss >= 0.10 && ourLoss > theirLoss)
      return decide('lineup-blocked', `our side is missing ${Math.round(ourLoss * 100)}% of its value — the market knows, we don't`);
    if (Math.max(ourLoss, theirLoss) >= 0.10)
      return decide('lineup', `named lineups swing ${Math.round(Math.max(ourLoss, theirLoss) * 100)}% of a side's value — treat the edge with suspicion`);
  }
  if (rep) return decide('lineup', `${rep.note}: rep call-ups may strip either squad and Elo can't see it — edge held to a doubled 6% bar`);

  // 2) STEAM — the price drifted AGAINST us since it opened (sharp money).
  if (openingPrice && price >= openingPrice * 1.05)
    return decide('steam', `our price drifted ${openingPrice.toFixed(2)}→${price.toFixed(2)} since open — money came the other way`);

  // 3) STALE ELO — ratings too green to trust (early season / heavy churn).
  if (teams > 0 && eloGames < STALE_ELO_GAMES_PER_TEAM * teams)
    return decide('stale-elo', `only ${eloGames} rated games across ${teams} teams — ratings not settled`);

  // 4) LONGSHOT BIAS — books shade underdogs; small edges there are artefacts.
  if (price > LONGSHOT_PRICE)
    return decide('longshot-bias', `${price.toFixed(2)} is a longshot — needs a big edge to overcome the shade`);

  // 5) VIG ARTIFACT — the edge is thinner than half the book's own margin.
  const overround = (1 / price) + (1 / oppPrice) - 1;
  if (edge < overround / 2)
    return decide('vig-artifact', `${(edge * 100).toFixed(1)}% edge sits inside the book's ${(overround * 100).toFixed(1)}% margin`);

  // 6) MODEL SIGNAL — a clean disagreement we're willing to back.
  return decide('model-signal', 'lineups as-rated, price steady, edge clear of the vig — a genuine model call');
}

// Build the round's book of up to five calls under the v2 + Mission-A rules.
// opts may carry { openingOdds, lineups } — an earlier odds snapshot (for steam
// detection) and named-lineup value deltas (for the lineup cause). Both are
// optional; absent, the diagnosis degrades gracefully to the coarse rep window.
export function generateSportBook(state, cfg, rows, oddsEvents, now = Date.now(), opts = {}) {
  const nr = nextRound(rows, now);
  if (!nr) return null;
  const openTeams = new Set();
  (state.book?.bets || []).concat((state.history || []).flatMap((d) => d.bets))
    .filter((b) => b.status === 'pending')
    .forEach((b) => { openTeams.add(b.team); openTeams.add(b.opp); });
  const teams = Object.keys(state.elo || {}).length;
  const eloGames = state.eloGames || 0;

  // Evaluate one side of one match: model prob, market price, edge, and the
  // Mission-A diagnosis. `bettable` = it clears the base gates AND its cause's
  // bar (i.e. genuine value vs the market), regardless of whether we already
  // hold that team — that open-position rule only blocks BETTING, not value.
  const evalSide = (m, side, prices, openPrices, rep) => {
    const team = side === 'home' ? m.HomeTeam : m.AwayTeam;
    const opp = side === 'home' ? m.AwayTeam : m.HomeTeam;
    const prob = Math.round(sportMatchProb(state, cfg, team, opp, side === 'home') * 1000) / 1000;
    const price = prices ? prices[side] : null;
    const oppPrice = prices ? prices[side === 'home' ? 'away' : 'home'] : null;
    const edge = price ? Math.round((prob * price - 1) * 1000) / 1000 : null;
    const diag = price ? diagnoseEdge({
      edge, price, oppPrice, openingPrice: openPrices ? openPrices[side] : null,
      lineup: lineupDelta(opts.lineups, team, opp), eloGames, teams, rep,
    }) : null;
    const baseOk = price != null && prob >= 0.45 && price >= 1.2 && edge >= 0.03;
    return { team, opp, side, prob, price, oppPrice, edge, diag, baseOk, bettable: baseOk && edge >= diag.bar };
  };

  const candidates = [];
  const rejectedByCause = {};
  const slate = [];
  for (const m of nr.matches) {
    const prices = fixtureOdds(m, oddsEvents, cfg.aliases);
    const rep = inRepWindow(cfg, kickTime(m));
    const openPrices = opts.openingOdds ? fixtureOdds(m, opts.openingOdds, cfg.aliases) : null;
    const h = evalSide(m, 'home', prices, openPrices, rep);
    const a = evalSide(m, 'away', prices, openPrices, rep);
    // de-vigged market probability (home) for a clean model-vs-market column
    const marketProb = (h.price > 1 && a.price > 1)
      ? Math.round(((1 / h.price) / ((1 / h.price) + (1 / a.price))) * 1000) / 1000 : null;
    const best = (h.edge ?? -9) >= (a.edge ?? -9) ? h : a; // the side our model most likes
    slate.push({
      no: m.MatchNumber, home: m.HomeTeam, away: m.AwayTeam,
      kickoff: new Date(kickTime(m)).toISOString(),
      homeProb: h.prob, awayProb: a.prob, marketProb,
      homePrice: h.price, awayPrice: a.price, homeEdge: h.edge, awayEdge: a.edge,
      bestTeam: best.team, bestEdge: best.edge, edgeCause: best.diag ? best.diag.cause : null,
      value: h.bettable || a.bettable, picked: false,
      warning: rep ? rep.note : null,
    });
    // book candidates: bettable sides we don't already hold a position on
    for (const s of [h, a]) {
      if (!s.baseOk) continue;
      if (openTeams.has(s.team) || openTeams.has(s.opp)) continue;
      if (s.edge < s.diag.bar) { rejectedByCause[s.diag.cause] = (rejectedByCause[s.diag.cause] || 0) + 1; continue; }
      candidates.push({
        id: `${cfg.key}-r${nr.round}-${m.MatchNumber}`,
        round: nr.round, no: m.MatchNumber, team: s.team, opp: s.opp,
        home: s.side === 'home', kickoff: new Date(kickTime(m)).toISOString(),
        prob: s.prob, price: s.price, edge: s.edge, stake: 100, payoutOdds: s.price,
        name: `${s.team} Value Call`,
        selection: `${s.team} to beat ${s.opp}${s.side === 'home' ? '' : ' (away)'}`,
        comment: betComment(cfg, state, rows, { team: s.team, opp: s.opp, home: s.side === 'home', prob: s.prob, price: s.price, edge: s.edge }),
        edgeCause: s.diag.cause, causeNote: s.diag.note,
        ...(s.diag.warn ? { warning: s.diag.note } : {}),
        status: 'pending',
      });
    }
  }
  // one bet per match (better side only), then top five by edge
  const byMatch = {};
  candidates.forEach((c) => { if (!byMatch[c.no] || c.edge > byMatch[c.no].edge) byMatch[c.no] = c; });
  const bets = Object.values(byMatch).sort((a, b) => b.edge - a.edge).slice(0, 5)
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const pickedNos = new Set(bets.map((b) => b.no));
  slate.forEach((r) => { if (pickedNos.has(r.no)) r.picked = true; });
  const byCause = {};
  bets.forEach((b) => { byCause[b.edgeCause] = (byCause[b.edgeCause] || 0) + 1; });
  slate.sort((x, y) => Date.parse(x.kickoff) - Date.parse(y.kickoff));
  return { round: nr.round, bets, slate, diagnostics: { byCause, rejectedByCause } };
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
// The 3-day window matters: NRL/AFL team lists are named Tuesday/Thursday,
// so locking any earlier would price bets BEFORE the market has absorbed who
// is actually playing (Origin outs, injuries, rests) — Elo can't see those,
// but a post-team-list market can, which keeps our edge calculation honest.
export function sportNeedsOdds(state, rows, now = Date.now()) {
  const nr = nextRound(rows, now);
  if (!nr) return false;
  if (state.book && state.book.round === nr.round) return false; // book already locked
  const firstKick = Math.min(...nr.matches.map((m) => kickTime(m)));
  return firstKick - now < 3 * 86400000; // lock inside 3 days — after team lists
}

// Is this kickoff inside a representative-football window (Origin etc.)?
export function inRepWindow(cfg, kickMs) {
  return (cfg.repWindows || []).find((w) => kickMs >= Date.parse(w.from + 'T00:00:00Z') && kickMs <= Date.parse(w.to + 'T23:59:59Z')) || null;
}

/* ---------- Closing Line Value ----------
 * CLV is the hobby-scale skill metric: beating the price the market settles on
 * detects an edge in ~50 bets where raw P/L needs thousands (roadmap §3.0). We
 * lock a bet 3 days out, then bank the LAST price before kickoff as the close;
 * if we locked a longer price than the close, that's positive CLV. */

// Current average h2h price for one selection, matched by team names.
export function priceForTeam(oddsEvents, team, opp, aliases = {}) {
  const ev = (oddsEvents || []).find((e) => (sameTeam(team, e.home_team, aliases) && sameTeam(opp, e.away_team, aliases))
    || (sameTeam(team, e.away_team, aliases) && sameTeam(opp, e.home_team, aliases)));
  if (!ev) return null;
  const prices = [];
  for (const bk of ev.bookmakers || []) {
    for (const mk of bk.markets || []) {
      if (mk.key !== 'h2h') continue;
      for (const o of mk.outcomes || []) if (o.price > 1 && sameTeam(team, o.name, aliases)) prices.push(o.price);
    }
  }
  return prices.length ? Math.round((prices.reduce((s, x) => s + x, 0) / prices.length) * 100) / 100 : null;
}

// Should we spend a credit to bank closing prices? Only when a still-pending
// bet is within 12h of its kickoff, so the banked price is genuinely near close.
export function sportNeedsClosingOdds(state, now = Date.now()) {
  const future = (state.book?.bets || []).filter((b) => b.status === 'pending' && Date.parse(b.kickoff) > now);
  if (!future.length) return false;
  return Math.min(...future.map((b) => Date.parse(b.kickoff))) - now < 12 * 3600 * 1000;
}

// Bank the latest pre-kickoff price on each still-pending bet (overwrites each
// run, so the final value is the price closest before that bet kicked off).
export function updateSportClosingOdds(bets, oddsEvents, cfg, now = Date.now()) {
  return (bets || []).map((b) => {
    if (b.status !== 'pending' || Date.parse(b.kickoff) <= now) return b;
    const cp = priceForTeam(oddsEvents, b.team, b.opp, cfg.aliases);
    return cp ? { ...b, closePrice: cp } : b;
  });
}

// CLV for a settled/priced bet: how much longer our locked price was than the
// close, as a fraction. Positive = we beat the closing line. null if no close.
export function betClv(b) {
  if (!b || !b.closePrice || !(b.closePrice > 1) || !(b.price > 1)) return null;
  return Math.round((b.price / b.closePrice - 1) * 1000) / 1000;
}

// One sport's full weekly cycle: rate new results, settle, archive finished
// rounds, and lock the next round's book when due (oddsEvents may be null if
// no fetch was needed/possible this run).
export function rollSport(prevState, cfg, rows, oddsEvents, now = Date.now(), opts = {}) {
  let state = { elo: {}, rated: [], eloGames: 0, ...(prevState || {}) };
  state = updateElo(state, rows, cfg);
  let book = state.book ? { ...state.book, bets: settleSportBets(state.book.bets, rows) } : null;
  let history = (state.history || []).map((h) => ({ ...h, bets: settleSportBets(h.bets, rows) }));
  if (book && book.bets.every((b) => b.status !== 'pending')) {
    history = [...history, book].slice(-30);
    book = null;
  }
  if (!book && oddsEvents) {
    const fresh = generateSportBook({ ...state, book, history }, cfg, rows, oddsEvents, now, opts);
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
