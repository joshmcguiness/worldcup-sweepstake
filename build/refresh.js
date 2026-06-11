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
import { FIX, TOTAL_MATCHES, scoresFromFeed } from '../public/lib/fixtures.js';
import { computeStandings } from '../public/lib/standings.js';
import { bracketSnapshot } from '../public/lib/bracket.js';
import { poolRows, wildRows, winRows, prizeTable } from '../public/lib/scoring.js';
import { runSim } from '../public/lib/sim.js';
import { darkHorseStanding, goldenBootRows, goldenBootPot, chaosRows, CHAOS_DEFAULT_POINTS } from '../public/lib/sidepots.js';
import { chaosFromScoreboardEvent, penaltyMissesFromSummary, goalkeeperIds } from '../public/lib/espn.js';

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
  const fetched = new Set(previousChaos?.fetchedEventIds || []);
  const doneDays = new Set(previousChaos?.fetchedDays || []);
  const events = banked.slice();
  const start = Date.parse('2026-06-11T00:00:00Z');
  const end = Math.min(Date.now(), Date.parse('2026-07-19T23:59:59Z'));
  for (let t = start; t <= end; t += 86400000) {
    const ymd = new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
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
      fetched.add(ev.id);
    }
    // A day is settled once all its matches are harvested and it's 48h+ old.
    if (allDone && Date.now() - t > 48 * 3600 * 1000) doneDays.add(ymd);
  }
  return { autoEvents: events, fetchedEventIds: [...fetched], fetchedDays: [...doneDays] };
}

async function main() {
  const previous = loadPrevious();
  const source = process.env.REFRESH_SOURCE || 'local';

  if (Date.now() > TOURNAMENT_OVER_AFTER && previous) {
    console.log('Tournament over — skipping refresh.');
    return;
  }
  // 'manual' bypasses the freeze so a workflow_dispatch can re-harvest
  // anything that failed on the tournament-completing run.
  if (previous && previous.finished && source !== 'manual') {
    console.log('All matches have scores and the build is marked finished — skipping refresh.');
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
  const prevCount = Object.keys(scores).length;
  let scoresOk = false;
  try {
    const feed = await fetchJson(FEED);
    scores = scoresFromFeed(feed);
    scoresOk = true;
    notes.push(`${Object.keys(scores).length} scores from feed`);
  } catch (e) {
    notes.push(`feed failed (${e.message}) — kept previous scores`);
  }

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

  // --- compute ---
  const ctx = {
    teams, fixtures: FIX, scores,
    players: config.players, owners: config.owners,
    buyIn: config.buyIn, split: config.split,
  };
  const standings = computeStandings(teams, FIX, scores);
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
    standings,
    pool: poolRows(ctx),
    wild: wildRows(ctx),
    winOdds: winRows(ctx),
    prizes: prizeTable(ctx),
    bracket: bracketSnapshot(teams, FIX, scores),
    sim: runSim(ctx, rankings ? { darkHorse: { ranks: rankings.ranks, candidateCount: sidepots.darkHorse.candidateCount } } : {}),
    sidePots: {
      goldenBoot: {
        entryFeeAUD: sidepots.goldenBoot.entryFeeAUD,
        pot: goldenBootPot(sidepots.goldenBoot),
        rows: goldenBootRows(sidepots.goldenBoot, scorerGoals),
        scorerGoals,
        live: Boolean(footballDataKey),
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
