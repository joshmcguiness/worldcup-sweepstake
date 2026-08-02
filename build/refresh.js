// Cron entrypoint: fetch fixtures (+odds) -> compute everything -> write
// public/data.json. Run by GitHub Actions 3x/day and on manual dispatch.
//
//   node build/refresh.js
//
// Env:
//   ODDS_API_KEY      optional — The Odds API key for live tournament-winner
//                     odds. Without it the static snapshot in teams.js is used.
//   FOOTBALL_DATA_KEY optional — football-data.org key for live Golden Boot
//                     scorer tallies. Without it goalsOverride in
//                     config/sidepots.json is the only goals source.
//   CHAOS_AUTO        set to '0' to disable the ESPN chaos-event harvest.
//   REFRESH_SOURCE    'scheduled' | 'manual' | 'deploy' (log attribution;
//                     default 'local'). 'manual' also bypasses the
//                     finished-freeze so a dispatch can re-harvest.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TEAMS, mapName } from '../public/lib/teams.js';
import { FIX, TOTAL_MATCHES, scoresFromFeed, feedKnockoutTeams, resolveFixtures } from '../public/lib/fixtures.js';
import { computeStandings } from '../public/lib/standings.js';
import { bracketSnapshot } from '../public/lib/bracket.js';
import { poolRows, wildRows, winRows, prizeTable } from '../public/lib/scoring.js';
import { runSim } from '../public/lib/sim.js';
import { darkHorseStanding, goldenBootRows, goldenBootPot, goldenBootGoalsFromEvents, chaosRows, CHAOS_DEFAULT_POINTS } from '../public/lib/sidepots.js';
import { chaosFromScoreboardEvent, penaltyMissesFromSummary, goalkeeperIds, goalsFromScoreboardEvent } from '../public/lib/espn.js';
import { rollBets, aestDate, updateClosingOdds } from '../public/lib/bets.js';
import { modelMarket } from '../public/lib/modelmarket.js';
import { SPORTS, rollSport, sportNeedsOdds, sportNeedsClosingOdds, sportNeedsEarlyOdds, updateSportClosingOdds, bootstrapElo, nextRound } from '../public/lib/sports.js';
import { rollMultis } from '../public/lib/multis.js';
import { predictBracket } from '../public/lib/bracket.js';
import { mapName as mapTeamName } from '../public/lib/teams.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = join(ROOT, 'public', 'data.json');
const CONFIG_PATH = join(ROOT, 'config', 'draw.json');
const SIDEPOTS_PATH = join(ROOT, 'config', 'sidepots.json');
const RANKINGS_PATH = join(ROOT, 'config', 'rankings.json');

const FEED = 'https://fixturedownload.com/feed/json/fifa-world-cup-2026';
// Final = MatchNumber 104, 2026-07-19. Generous buffer (the finished flag
// normally stops refreshes much earlier) so a failed side-pot harvest on the
// tournament-completing run still has retry headroom; then stop forever — the
// last-built data.json keeps showing the final result.
const TOURNAMENT_OVER_AFTER = Date.parse('2026-07-22T12:00:00Z');

function loadPrevious() {
  try { return JSON.parse(readFileSync(DATA_PATH, 'utf-8')); } catch { return null; }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function fetchJson(url, { timeoutMs = 20000, retries = 2, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'worldcup-sweepstake-build', ...headers } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(t);
    }
  }
}

async function fetchOddsOverride(apiKey) {
  const url = 'https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup_winner/odds/'
    + '?regions=us&oddsFormat=decimal&markets=outrights&apiKey=' + encodeURIComponent(apiKey);
  const data = await fetchJson(url);
  if (!Array.isArray(data) || !data.length) throw new Error('empty odds response');
  const agg = {};
  for (const ev of data) {
    for (const bk of ev.bookmakers || []) {
      for (const mk of bk.markets || []) {
        if (mk.key !== 'outrights') continue;
        for (const o of mk.outcomes || []) {
          if (o.price > 1) (agg[o.name] = agg[o.name] || []).push(o.price);
        }
      }
    }
  }
  const override = {};
  for (const nm of Object.keys(agg)) {
    const our = mapName(nm);
    if (!our) continue;
    const dec = agg[nm].reduce((a, b) => a + b, 0) / agg[nm].length;
    override[our] = Math.max(1, Math.round((dec - 1) * 100));
  }
  return override;
}

// Tournament top scorers from football-data.org (free tier covers the World
// Cup). Returns {playerName: goals}; throws on any failure so the caller can
// fall back to previous data. limit=500 is the API max — a 104-match
// tournament easily exceeds 100 distinct scorers, and our drawn striker might
// sit in the 1-goal tail.
async function fetchScorers(apiKey) {
  const data = await fetchJson('https://api.football-data.org/v4/competitions/WC/scorers?limit=500', {
    headers: { 'X-Auth-Token': apiKey },
  });
  const goals = {};
  for (const s of data.scorers || []) {
    if (s.player?.name != null && s.goals != null) goals[s.player.name] = Number(s.goals);
  }
  return goals;
}

// Auto-detect Chaos Pot events from ESPN, incrementally. Completed matches
// are immutable, so once an event id is harvested its events are banked in
// data.json and never re-fetched; whole days are skipped once every match on
// them has been harvested (with a 48h safety margin for late corrections).
// This keeps steady-state runs to a handful of requests, makes degraded
// responses additive-only (they can never wipe banked events), and means a
// single failed request only delays the *new* matches' events.
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';
async function fetchEspnChaos(previousChaos) {
  const banked = previousChaos?.autoEvents || [];
  const bankedGoals = previousChaos?.goalEvents || [];
  const fetched = new Set(previousChaos?.fetchedEventIds || []);
  const doneDays = new Set(previousChaos?.fetchedDays || []);
  const events = banked.slice();
  const goalEvents = bankedGoals.slice();
  const start = Date.parse('2026-06-11T00:00:00Z');
  const end = Math.min(Date.now(), Date.parse('2026-07-19T23:59:59Z'));
  for (let t = start; t <= end; t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const ymd = iso.replace(/-/g, '');
    if (doneDays.has(ymd)) continue;
    const sb = await fetchJson(`${ESPN_BASE}/scoreboard?dates=${ymd}`);
    if (!sb || !Array.isArray(sb.events)) throw new Error(`scoreboard ${ymd} missing events array`);
    let allDone = sb.events.length > 0;
    for (const ev of sb.events) {
      if (!ev?.status?.type?.completed) { allDone = false; continue; }
      if (fetched.has(ev.id)) continue;
      const summary = await fetchJson(`${ESPN_BASE}/summary?event=${ev.id}`);
      events.push(...chaosFromScoreboardEvent(ev, goalkeeperIds(summary)));
      events.push(...penaltyMissesFromSummary(summary, ev.id));
      goalEvents.push(...goalsFromScoreboardEvent(ev, iso));
      fetched.add(ev.id);
    }
    // A day is settled once all its matches are harvested and it's 48h+ old.
    if (allDone && Date.now() - t > 48 * 3600 * 1000) doneDays.add(ymd);
  }
  return { autoEvents: events, goalEvents, fetchedEventIds: [...fetched], fetchedDays: [...doneDays] };
}

// Live per-match h2h odds from The Odds API (optional — needs ODDS_API_KEY).
// Returns {matchNo: {home, away, draw}} in decimal, averaged across books,
// where home/away refer to OUR fixture's sides.
async function fetchMatchOdds(apiKey, scores, fixtures) {
  const url = 'https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/'
    + '?regions=au,us&markets=h2h&oddsFormat=decimal&apiKey=' + encodeURIComponent(apiKey);
  const data = await fetchJson(url);
  if (!Array.isArray(data)) throw new Error('unexpected match-odds response');
  const bracket = predictBracket(TEAMS, fixtures, scores);
  const out = {};
  for (const ev of data) {
    const h = mapTeamName(ev.home_team || ''), a = mapTeamName(ev.away_team || '');
    if (!h || !a) continue;
    const kick = Date.parse(ev.commence_time);
    const m = fixtures.find((x) => {
      // never pair odds with a started match — in-play prices are not
      // pre-match value, and the bets engine excludes started matches anyway
      if (hasOurScore(scores, x.no) || Date.parse(x.d) <= Date.now()
        || Math.abs(Date.parse(x.d) - kick) > 36 * 3600 * 1000) return false;
      const r = x.r <= 3 ? { home: x.h, away: x.a } : bracket.resolveMatch(x.no);
      return (r.home === h && r.away === a) || (r.home === a && r.away === h);
    });
    if (!m) continue;
    const sides = m.r <= 3 ? { home: m.h, away: m.a } : bracket.resolveMatch(m.no);
    const agg = {};
    for (const bk of ev.bookmakers || []) {
      for (const mk of bk.markets || []) {
        if (mk.key !== 'h2h') continue;
        for (const o of mk.outcomes || []) {
          const team = o.name === 'Draw' ? 'draw' : mapTeamName(o.name);
          const key = team === 'draw' ? 'draw' : team === sides.home ? 'home' : team === sides.away ? 'away' : null;
          if (key && o.price > 1) (agg[key] = agg[key] || []).push(o.price);
        }
      }
    }
    if (agg.home && agg.away) {
      const avg = (arr) => Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 100) / 100;
      out[m.no] = { home: avg(agg.home), away: avg(agg.away), draw: agg.draw ? avg(agg.draw) : null };
    }
  }
  return out;
}

function hasOurScore(scores, no) {
  const s = scores[no];
  return Boolean(s) && s.h !== '' && s.a !== '' && s.h != null && s.a != null;
}

// Weekly AFL / NRL / NFL / EPL books. fixturedownload's league feeds 403
// non-browser user agents (verified), so these fetches masquerade as Chrome.
// Odds are fetched per sport ONLY when a new round's book is due (~1 credit
// per sport per week); pre-season codes (no fixtures yet) show their expected
// start and cost nothing.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Shrink an Odds API events list to one synthetic bookmaker carrying the
// average h2h price per team — same shape fixtureOdds() reads, a fraction of
// the bytes (the early-odds steam baseline persists in data.json for days).
function slimOddsEvents(events) {
  return (events || []).map((e) => {
    const acc = {};
    for (const bk of e.bookmakers || []) {
      for (const mk of bk.markets || []) {
        if (mk.key !== 'h2h') continue;
        for (const o of mk.outcomes || []) if (o.price > 1) (acc[o.name] ??= []).push(o.price);
      }
    }
    const outcomes = Object.entries(acc).map(([name, ps]) => ({ name, price: Math.round((ps.reduce((a, b) => a + b, 0) / ps.length) * 100) / 100 }));
    return { home_team: e.home_team, away_team: e.away_team, commence_time: e.commence_time, bookmakers: [{ markets: [{ key: 'h2h', outcomes }] }] };
  });
}
async function refreshSports(previousSports, oddsApiKey, notes) {
  const out = {};
  for (const cfg of SPORTS) {
    const prev = previousSports?.[cfg.key] || null;
    try {
      let rows = null;
      try {
        rows = await fetchJson(`https://fixturedownload.com/feed/json/${cfg.feed}`, { headers: { 'user-agent': BROWSER_UA } });
      } catch { /* feed not published yet (pre-season) or transient */ }
      if (!Array.isArray(rows) || !rows.length) {
        out[cfg.key] = { ...(prev || {}), inSeason: false, started: false, awaitingFixtures: true, expectedStart: cfg.expectedStart };
        continue;
      }
      let state = prev;
      if (!state || !Object.keys(state.elo || {}).length) {
        // one-time rating bootstrap from last season, regressed to the mean
        try {
          const priorRows = await fetchJson(`https://fixturedownload.com/feed/json/${cfg.priorFeed}`, { headers: { 'user-agent': BROWSER_UA } });
          if (Array.isArray(priorRows) && priorRows.length) state = { ...(prev || {}), ...bootstrapElo(priorRows, cfg) };
        } catch { /* start everyone at 1500 */ }
      }
      // Odds fetches, three occasions: an EARLY snapshot 3–6 days out (V4 steam
      // detection baseline), the BOOK-LOCK fetch inside 3 days, and CLOSING
      // fetches near kickoff (CLV banking). One call serves lock+close.
      const needEarly = sportNeedsEarlyOdds(state || {}, rows);
      if (oddsApiKey && needEarly) {
        try {
          const ev = await fetchJson(`https://api.the-odds-api.com/v4/sports/${cfg.oddsKey}/odds/?regions=${cfg.oddsRegions}&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(oddsApiKey)}`);
          const nr = nextRound(rows);
          state = { ...(state || {}), earlyOdds: { round: nr ? nr.round : null, fetchedAt: new Date().toISOString(), events: slimOddsEvents(ev) } };
          notes.push(`${cfg.label} early odds banked (steam baseline)`);
        } catch (e) { notes.push(`${cfg.label} early odds failed (${e.message})`); }
      }
      const needBook = sportNeedsOdds(state || {}, rows);
      const needClose = sportNeedsClosingOdds(state || {});
      let oddsEvents = null;
      if (oddsApiKey && (needBook || needClose)) {
        try {
          oddsEvents = await fetchJson(`https://api.the-odds-api.com/v4/sports/${cfg.oddsKey}/odds/?regions=${cfg.oddsRegions}&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(oddsApiKey)}`);
          notes.push(`${cfg.label} odds fetched${needBook ? '' : ' (closing)'}`);
        } catch (e) {
          notes.push(`${cfg.label} odds failed (${e.message})`);
        }
      }
      let rolled = rollSport(state, cfg, rows, needBook ? oddsEvents : null, Date.now(),
        { openingOdds: (state && state.earlyOdds && state.earlyOdds.events) || null });
      // bank closing prices on the (already-locked) book without regenerating it
      if (oddsEvents && rolled.book) {
        rolled = { ...rolled, book: { ...rolled.book, bets: updateSportClosingOdds(rolled.book.bets, oddsEvents, cfg) } };
      }
      // the steam baseline has served its purpose once its round's book exists
      if (rolled.book && rolled.earlyOdds && rolled.earlyOdds.round === rolled.book.round) rolled = { ...rolled, earlyOdds: null };
      out[cfg.key] = { ...rolled, expectedStart: cfg.expectedStart, awaitingFixtures: false };
    } catch (e) {
      notes.push(`${cfg.label} failed (${e.message}) — kept previous`);
      out[cfg.key] = prev || { inSeason: false, awaitingFixtures: true, expectedStart: cfg.expectedStart };
    }
  }
  return out;
}

async function main() {
  const previous = loadPrevious();
  const source = process.env.REFRESH_SOURCE || 'local';

  // BETTING ERA: once the World Cup is finished (or past its hard end date),
  // every WC field is frozen exactly as it stands — but the live-betting state
  // (NRL/AFL/NFL/EPL books, closing-price banking for CLV, the multi ladder)
  // must keep refreshing on every scheduled run. Fast path: refresh only that.
  if (previous && (previous.finished || Date.now() > TOURNAMENT_OVER_AFTER)) {
    const notes = [];
    let sports = previous.sports;
    try {
      sports = await refreshSports(previous.sports, (process.env.ODDS_API_KEY || '').trim(), notes);
    } catch (e) { notes.push(`sports refresh failed (${e.message}) — kept previous`); }
    let multis = previous.multis || { current: null, history: [] };
    try { multis = rollMultis(previous.multis, sports); } catch (e) { notes.push(`multis failed (${e.message}) — kept previous`); }
    const data = {
      ...previous,
      updatedAt: new Date().toISOString(),
      sports, multis,
      log: [...(previous.log || []), { ts: new Date().toISOString(), source, note: 'betting-era refresh — ' + (notes.join('; ') || 'books rolled') }].slice(-60),
    };
    writeFileSync(DATA_PATH, JSON.stringify(data, null, 1));
    console.log('Betting-era refresh complete (WC frozen).', notes.join('; '));
    return;
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const notes = [];

  // --- side-pot config (admin-edited repeatedly — degrade, never crash) ---
  let sidepots;
  try {
    sidepots = JSON.parse(readFileSync(SIDEPOTS_PATH, 'utf-8'));
  } catch (e) {
    notes.push(`sidepots.json unreadable (${e.message}) — using defaults`);
    sidepots = {};
  }
  sidepots.goldenBoot ??= { entryFeeAUD: 0, assignments: {}, goalsOverride: {} };
  sidepots.darkHorse ??= { prizeAUD: null, candidateCount: 24 };
  sidepots.chaos ??= { prizeAUD: null, points: CHAOS_DEFAULT_POINTS, events: [] };
  let rankings = null;
  try {
    if (existsSync(RANKINGS_PATH)) {
      const rk = JSON.parse(readFileSync(RANKINGS_PATH, 'utf-8'));
      if (rk && rk.ranks) rankings = rk;
      else notes.push('rankings.json has no ranks — dark horse disabled');
    }
  } catch (e) {
    notes.push(`rankings.json unreadable (${e.message}) — dark horse disabled`);
  }

  // --- fixtures + scores ---
  let scores = previous ? previous.scores || {} : {};
  let koTeams = previous?.koTeams || {}; // real knockout teams, once the feed knows them
  const prevCount = Object.keys(scores).length;
  let scoresOk = false;
  try {
    const feed = await fetchJson(FEED);
    scores = scoresFromFeed(feed);
    koTeams = feedKnockoutTeams(feed);
    scoresOk = true;
    notes.push(`${Object.keys(scores).length} scores from feed`);
    const koCount = Object.keys(koTeams).length;
    if (koCount) notes.push(`${koCount} knockout fixtures resolved`);
  } catch (e) {
    notes.push(`feed failed (${e.message}) — kept previous scores`);
  }
  // Trust the feed's real knockout teams over our own best-third allocation
  // (FIFA's official allocation differs from any home-grown matcher). Sim keeps
  // raw FIX — it re-simulates the bracket from slot codes each iteration.
  const RFIX = resolveFixtures(FIX, koTeams);

  // --- odds ---
  const teams = TEAMS.map((t) => ({ ...t }));
  let oddsOverride = previous?.oddsOverride || {};
  if ((process.env.ODDS_API_KEY || '').trim()) {
    try {
      oddsOverride = await fetchOddsOverride(process.env.ODDS_API_KEY.trim());
      notes.push(`${Object.keys(oddsOverride).length} live odds`);
    } catch (e) {
      notes.push(`odds failed (${e.message}) — kept previous odds`);
    }
  }
  teams.forEach((t) => { if (oddsOverride[t.n] != null) t.o = oddsOverride[t.n]; });

  // --- side-pot feeds ---
  const footballDataKey = (process.env.FOOTBALL_DATA_KEY || '').trim();
  let scorerGoals = previous?.sidePots?.goldenBoot?.scorerGoals || {};
  let scorersOk = !footballDataKey; // nothing to fetch counts as healthy
  if (footballDataKey && Object.keys(sidepots.goldenBoot.assignments || {}).length) {
    try {
      // merge: goals are monotonically non-decreasing, so a name that drops
      // out of the feed window keeps its last-known tally
      scorerGoals = { ...scorerGoals, ...(await fetchScorers(footballDataKey)) };
      scorersOk = true;
      notes.push(`${Object.keys(scorerGoals).length} scorers`);
    } catch (e) {
      notes.push(`scorers failed (${e.message}) — kept previous`);
    }
  } else if (footballDataKey) {
    scorersOk = true; // key set but no assignments yet
  }
  let chaos = {
    autoEvents: previous?.sidePots?.chaos?.autoEvents || [],
    goalEvents: previous?.sidePots?.chaos?.goalEvents || [],
    fetchedEventIds: previous?.sidePots?.chaos?.fetchedEventIds || [],
    fetchedDays: previous?.sidePots?.chaos?.fetchedDays || [],
  };
  let chaosOk = process.env.CHAOS_AUTO === '0';
  if (process.env.CHAOS_AUTO !== '0') {
    try {
      chaos = await fetchEspnChaos(previous?.sidePots?.chaos);
      chaosOk = true;
      notes.push(`${chaos.autoEvents.length} chaos events`);
    } catch (e) {
      notes.push(`chaos feed failed (${e.message}) — kept previous`);
    }
  }
  // Golden Boot goals: the free ESPN goal bank is the base tally; the
  // football-data.org feed (if a key is set, held in scorerGoals) overrides on
  // name collisions. Recomputed fresh from the cumulative bank each run, so it
  // is never stale. THIS is the fix for goals stuck on 0 — neither the (unset)
  // key nor manual overrides supplied any goals, while the ESPN bank had them.
  // Only the football tally is persisted as scorerGoals; ESPN is merged here.
  const espnGoals = goldenBootGoalsFromEvents(chaos.goalEvents || []);
  const bootGoals = { ...espnGoals, ...scorerGoals };
  const goldenBootLive = Boolean(footballDataKey) || process.env.CHAOS_AUTO !== '0';
  if (Object.keys(espnGoals).length) notes.push(`${Object.keys(espnGoals).length} boot scorers (ESPN)`);

  // --- High Risk Curnow Bets: optional live match odds, then roll the book ---
  let matchOdds = {};
  if ((process.env.ODDS_API_KEY || '').trim()) {
    try {
      matchOdds = await fetchMatchOdds(process.env.ODDS_API_KEY.trim(), scores, RFIX);
      notes.push(`${Object.keys(matchOdds).length} match odds`);
    } catch (e) {
      notes.push(`match odds failed (${e.message})`);
    }
  }
  let bootCandidates = [];
  try {
    bootCandidates = JSON.parse(readFileSync(join(ROOT, 'config', 'goldenboot-candidates.json'), 'utf-8')).candidates || [];
  } catch { /* bets degrade to no scorer angles */ }

  // --- compute ---
  // ctx uses the feed-resolved fixtures (real knockout teams) for the bracket,
  // standings, side pots and bets. Sim alone keeps raw FIX slot codes.
  const ctx = {
    teams, fixtures: RFIX, scores,
    players: config.players, owners: config.owners,
    buyIn: config.buyIn, split: config.split,
  };
  const standings = computeStandings(teams, RFIX, scores);
  const simOut = runSim({ ...ctx, fixtures: FIX }, rankings ? { darkHorse: { ranks: rankings.ranks, candidateCount: sidepots.darkHorse.candidateCount } } : {});
  let bets = previous?.bets || { current: null, history: [] };
  try {
    bets = rollBets(bets, ctx, simOut, {
      date: aestDate(Date.now()),
      bootCandidates,
      ranks: rankings?.ranks || {},
      marketOdds: matchOdds,
      goalEvents: chaos.goalEvents || [],
      fetchedDays: chaos.fetchedDays || [],
    });
  } catch (e) {
    notes.push(`bets engine failed (${e.message}) — kept previous book`);
  }
  try {
    // closing-line capture for CLV: last pre-kickoff price wins
    bets = {
      current: bets.current ? { ...bets.current, bets: updateClosingOdds(bets.current.bets, ctx, matchOdds) } : null,
      history: (bets.history || []).map((d) => ({ ...d, bets: updateClosingOdds(d.bets, ctx, matchOdds) })),
    };
  } catch (e) {
    notes.push(`closing-odds update failed (${e.message})`);
  }
  let mvm = previous?.modelMarket || { matches: [], outrights: [] };
  try {
    mvm = modelMarket(ctx, simOut, matchOdds);
  } catch (e) {
    notes.push(`model-vs-market failed (${e.message})`);
  }
  let sports = previous?.sports || {};
  try {
    sports = await refreshSports(previous?.sports, (process.env.ODDS_API_KEY || '').trim(), notes);
  } catch (e) {
    notes.push(`sports refresh failed (${e.message}) — kept previous`);
  }
  // Multi Wild Card: the weekly cross-code 3/4/5-leg ladder, built only from
  // legs that already passed the singles gates (see public/lib/multis.js rules)
  let multis = previous?.multis || { current: null, history: [] };
  try {
    multis = rollMultis(previous?.multis, sports);
  } catch (e) {
    notes.push(`multis failed (${e.message}) — kept previous`);
  }
  const allScoresIn = Object.keys(scores).length >= TOTAL_MATCHES;
  const data = {
    updatedAt: new Date().toISOString(),
    // Only freeze once the side-pot harvests have also succeeded for the
    // complete tournament — otherwise the next run retries.
    finished: allScoresIn && scoresOk && chaosOk && scorersOk,
    config: {
      players: config.players, owners: config.owners, locked: config.locked,
      buyIn: config.buyIn, split: config.split, visibleTabs: config.visibleTabs,
    },
    teams,
    oddsOverride,
    scores,
    koTeams,
    standings,
    pool: poolRows(ctx),
    wild: wildRows(ctx),
    winOdds: winRows(ctx),
    prizes: prizeTable(ctx),
    bracket: bracketSnapshot(teams, RFIX, scores),
    sim: simOut,
    bets,
    modelMarket: mvm,
    sports,
    multis,
    sidePots: {
      goldenBoot: {
        entryFeeAUD: sidepots.goldenBoot.entryFeeAUD,
        pot: goldenBootPot(sidepots.goldenBoot),
        rows: goldenBootRows(sidepots.goldenBoot, bootGoals),
        scorerGoals,
        live: goldenBootLive,
      },
      darkHorse: rankings ? {
        prizeAUD: sidepots.darkHorse.prizeAUD,
        rankingsAsOf: rankings.asOf,
        ...darkHorseStanding(ctx, rankings, sidepots.darkHorse),
      } : null,
      chaos: {
        prizeAUD: sidepots.chaos.prizeAUD,
        points: sidepots.chaos.points || CHAOS_DEFAULT_POINTS,
        rows: chaosRows(sidepots.chaos, ctx, chaos.autoEvents),
        autoEvents: chaos.autoEvents,
        goalEvents: chaos.goalEvents || [],
        fetchedEventIds: chaos.fetchedEventIds,
        fetchedDays: chaos.fetchedDays,
        manualEvents: sidepots.chaos.events,
      },
    },
    log: (previous?.log || []).slice(-200),
  };

  const newScores = Object.keys(scores).length - prevCount;
  data.log.push({
    ts: Date.now(),
    source,
    matchesUpdated: Math.max(0, newScores),
    note: notes.join(' · '),
  });
  if (data.finished) data.log.push({ ts: Date.now(), source: 'system', matchesUpdated: 0, note: 'Tournament complete — refreshes stop here. 🏆' });

  writeFileSync(DATA_PATH, JSON.stringify(data, null, 1));
  console.log(`Wrote public/data.json — ${notes.join(' · ')} — finished=${data.finished}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
