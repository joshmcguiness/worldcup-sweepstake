import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TEAMS } from '../public/lib/teams.js';
import { FIX, scoresFromFeed } from '../public/lib/fixtures.js';
import { runSim, groupKey } from '../public/lib/sim.js';
import { predictBracket } from '../public/lib/bracket.js';
import { resolveThirdTeams } from '../public/lib/thirds.js';
import {
  stageReached, darkHorseStanding, goldenBootRows, goldenBootPot, goldenBootGoalsFromEvents, chaosRows, STAGES,
} from '../public/lib/sidepots.js';
import { chaosFromScoreboardEvent, penaltyMissesFromSummary, goalkeeperIds, espnTeam } from '../public/lib/espn.js';

const cfgDir = new URL('../config/', import.meta.url);
const drawCfg = JSON.parse(readFileSync(new URL('draw.json', cfgDir), 'utf-8'));
const rankings = JSON.parse(readFileSync(new URL('rankings.json', cfgDir), 'utf-8'));
const sidepots = JSON.parse(readFileSync(new URL('sidepots.json', cfgDir), 'utf-8'));
const gbCandidates = JSON.parse(readFileSync(new URL('goldenboot-candidates.json', cfgDir), 'utf-8'));

function mkCtx(scores = {}) {
  return {
    teams: TEAMS, fixtures: FIX, scores,
    players: drawCfg.players, owners: drawCfg.owners,
    buyIn: drawCfg.buyIn, split: drawCfg.split,
  };
}

// All 72 group games decided by a deterministic rule, knockouts up to `uptoNo`.
function fullGroupScores(uptoKo = 0) {
  const scores = {};
  FIX.filter((m) => m.r <= 3).forEach((m) => {
    // home wins unless the away side is alphabetically later — arbitrary but fixed
    scores[m.no] = m.h < m.a ? { h: 2, a: 0 } : { h: 0, a: 2 };
  });
  FIX.filter((m) => m.r >= 4 && m.no <= uptoKo).forEach((m) => { scores[m.no] = { h: 1, a: 0 }; });
  return scores;
}

/* ---------- configs are consistent ---------- */
test('rankings cover exactly the 48 qualifiers', () => {
  const names = new Set(TEAMS.map((t) => t.n));
  const ranked = Object.keys(rankings.ranks);
  assert.equal(ranked.length, 48);
  ranked.forEach((n) => assert.ok(names.has(n), `unknown team in rankings: ${n}`));
});

test('real draw config: 13 players, 48 teams, counts within 1', () => {
  assert.equal(drawCfg.players.length, 13);
  assert.equal(Object.keys(drawCfg.owners).length, 48);
  const cnt = {};
  Object.values(drawCfg.owners).forEach((p) => { cnt[p] = (cnt[p] || 0) + 1; });
  assert.equal(Object.keys(cnt).length, 13);
  const counts = Object.values(cnt);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
});

test('golden boot: five strikers per player, all from the candidate list, no duplicates', () => {
  const a = sidepots.goldenBoot.assignments;
  assert.deepEqual(Object.keys(a).sort(), drawCfg.players.slice().sort());
  const candByName = new Map(gbCandidates.candidates.map((c) => [c.name, c]));
  const used = new Set();
  const N = drawCfg.players.length;
  Object.values(a).forEach((list) => {
    assert.ok(Array.isArray(list) && list.length === 5, 'exactly five strikers each');
    list.forEach((f, tier) => {
      assert.ok(candByName.has(f.name), `${f.name} not a candidate`);
      assert.ok(!used.has(f.name), `${f.name} assigned twice`);
      used.add(f.name);
      // tier k must come from candidate ranks [k*N, (k+1)*N)
      const idx = gbCandidates.candidates.findIndex((c) => c.name === f.name);
      assert.ok(idx >= tier * N && idx < (tier + 1) * N, `${f.name} (rank ${idx}) outside tier ${tier}`);
    });
  });
  assert.equal(used.size, N * 5);
});

/* ---------- golden boot rows ---------- */
test('goldenBootRows: totals over five strikers, override beats feed, diacritic-insensitive', () => {
  const gb = {
    entryFeeAUD: 10,
    assignments: {
      A: [{ name: 'Vinícius Júnior', team: 'Brazil' }, { name: 'Cody Gakpo', team: 'Netherlands' }],
      B: [{ name: 'Harry Kane', team: 'England' }],
    },
    goalsOverride: { 'Harry Kane': 4 },
  };
  const rows = goldenBootRows(gb, { 'Vinicius Junior': 3, 'Harry Kane': 99, 'Cody Gakpo': 2 });
  assert.equal(rows[0].participant, 'A');
  assert.equal(rows[0].total, 5, 'feed name without diacritics still matches and sums');
  assert.equal(rows[1].total, 4, 'override wins over feed');
  assert.equal(rows[1].strikers[0].goals, 4);
  assert.equal(goldenBootPot(gb), 20);
});

test('goldenBootGoalsFromEvents: tallies ESPN goal bank, feeds goldenBootRows', () => {
  // mirrors the real wiring: ESPN events -> tally -> rows
  const events = [
    { team: 'Germany', who: 'Kai Havertz', ymd: '2026-06-14' },
    { team: 'Germany', who: 'Kai Havertz', ymd: '2026-06-14' },
    { team: 'USA', who: 'Folarin Balogun', ymd: '2026-06-13' },
    { team: 'Brazil', who: 'Vinicius Junior', ymd: '2026-06-14' }, // no diacritics from feed
    { team: 'Spain', who: 'Some Other Player', ymd: '2026-06-14' },
  ];
  const tally = goldenBootGoalsFromEvents(events);
  const gb = {
    entryFeeAUD: 10,
    assignments: {
      Andy: [{ name: 'Kai Havertz', team: 'Germany' }, { name: 'Vinícius Júnior', team: 'Brazil' }],
      Ron: [{ name: 'Folarin Balogun', team: 'USA' }],
    },
  };
  const rows = goldenBootRows(gb, tally);
  const andy = rows.find((r) => r.participant === 'Andy');
  assert.equal(andy.total, 3, 'Havertz 2 + Vinícius 1 (diacritic-insensitive)');
  assert.equal(rows.find((r) => r.participant === 'Ron').total, 1);
});

/* ---------- stageReached ---------- */
test('stageReached: nothing reached before groups complete', () => {
  const stage = stageReached(TEAMS, FIX, { 1: { h: 2, a: 0 } });
  assert.ok(Object.values(stage).every((s) => s === 0));
});

test('stageReached: groups complete -> exactly 32 at Last 32; KO wins advance', () => {
  const scores = fullGroupScores(73); // + match 73 (R32) played
  const stage = stageReached(TEAMS, FIX, scores);
  const reached = Object.values(stage).filter((s) => s >= 1).length;
  assert.equal(reached, 32, '32 teams reach the knockouts');
  // match 73's winner is at Last 16 (stage 2), its loser stays at 1
  const twoCount = Object.values(stage).filter((s) => s === 2).length;
  assert.equal(twoCount, 1, 'exactly one team has won a KO tie');
});

/* ---------- dark horse ---------- */
test('darkHorse lists all 48 teams; only the 24 worst-ranked are eligible', () => {
  const dh = darkHorseStanding(mkCtx({}), rankings, sidepots.darkHorse);
  assert.equal(dh.rows.length, 48, 'every team is listed');
  const eligible = dh.rows.filter((r) => r.eligible);
  assert.equal(eligible.length, 24);
  assert.ok(eligible.every((r) => r.rank >= 28), 'Algeria (28) is the best-ranked eligible team');
  assert.ok(dh.rows.filter((r) => !r.eligible).every((r) => r.rank <= 27), 'ineligible teams are all better-ranked');
  // pre-tournament ordering: same stage, so worst rank first
  assert.equal(dh.rows[0].team, 'New Zealand');
  assert.equal(dh.leader, null, 'no leader before anyone reaches the knockouts');
  assert.equal(dh.decided, false);
});

test('darkHorse: deepest stage wins among ELIGIBLE teams, tie goes to worse rank', () => {
  const scores = fullGroupScores();
  const ctx = mkCtx(scores);
  const dh = darkHorseStanding(ctx, rankings, sidepots.darkHorse);
  const qualified = dh.rows.filter((r) => r.eligible && r.stage >= 1);
  if (qualified.length) {
    assert.equal(dh.leader.team, qualified[0].team);
    assert.ok(dh.leader.eligible, 'leader must be an eligible team');
    // every other eligible candidate at the same stage has a better (lower) rank
    qualified.slice(1).forEach((r) => {
      if (r.stage === dh.leader.stage) assert.ok(r.rank <= dh.leader.rank);
    });
  }
  // eliminated group teams are not alive
  dh.rows.filter((r) => r.stage === 0).forEach((r) => assert.equal(r.alive, false));
});

test('sim darkHorse probabilities sum to 1 and concentrate on candidates', () => {
  const ctx = mkCtx({});
  const sim = runSim(ctx, { iterations: 2000, seed: 5, darkHorse: { ranks: rankings.ranks, candidateCount: 24 } });
  const teamSum = Object.values(sim.darkHorseTeams).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(teamSum - 1) < 1e-9, `team dark-horse probs sum to 1, got ${teamSum}`);
  const playerSum = Object.values(sim.players).reduce((s, x) => s + (x.pDarkHorse || 0), 0);
  assert.ok(Math.abs(playerSum - 1) < 1e-9, `player dark-horse probs sum to 1, got ${playerSum}`);
  assert.equal(Object.keys(sim.darkHorseTeams).length, 24);
});

/* ---------- chaos ---------- */
test('chaosRows: tallies points, merges auto + manual, negative count corrects', () => {
  const cfg = {
    points: { ownGoal: 3, redCard: 2, penaltyMiss: 2, gkGoal: 10 },
    events: [
      { team: 'Brazil', type: 'redCard', count: 1 },
      { team: 'Germany', type: 'gkGoal', count: -1, note: 'auto-detect was wrong' },
    ],
  };
  const auto = [
    { team: 'Brazil', type: 'ownGoal' },
    { team: 'Brazil', type: 'penaltyMiss' },
    { team: 'Germany', type: 'gkGoal' },
  ];
  const rows = chaosRows(cfg, mkCtx({}), auto);
  const brazil = rows.find((r) => r.team === 'Brazil');
  assert.equal(brazil.points, 3 + 2 + 2);
  assert.equal(brazil.owner, 'Nick');
  const germany = rows.find((r) => r.team === 'Germany');
  assert.equal(germany.points, 0, 'manual -1 cancels the wrong auto gkGoal');
  assert.equal(rows[0].team, 'Brazil', 'sorted by points desc');
});

/* ---------- espn parsers ---------- */
test('espnTeam maps ESPN display names to ours', () => {
  assert.equal(espnTeam('United States'), 'USA');
  assert.equal(espnTeam('South Korea'), 'Korea Republic');
  assert.equal(espnTeam('Ivory Coast'), "Côte d'Ivoire");
  assert.equal(espnTeam('Czech Republic'), 'Czechia');
  assert.equal(espnTeam('Mexico'), 'Mexico');
});

test('chaosFromScoreboardEvent: own goal credited to the team that scored it', () => {
  const event = {
    id: '760415',
    status: { type: { completed: true } },
    competitions: [{
      competitors: [
        { id: '1', team: { displayName: 'Mexico' } },
        { id: '2', team: { displayName: 'South Africa' } },
      ],
      details: [
        // own goal by a South African player; ESPN credits the goal to Mexico
        // (team id 1) — chaos points must go to South Africa
        { type: { text: 'Goal - Own Goal' }, team: { id: '1' }, scoringPlay: true, ownGoal: true, athletesInvolved: [{ displayName: 'SA Defender' }] },
        // red card for a Mexico player (team id 1)
        { type: { text: 'Red Card' }, team: { id: '1' }, redCard: true, athletesInvolved: [{ displayName: 'MX Midfielder' }] },
        // a normal goal by an outfielder — no chaos
        { type: { text: 'Goal' }, team: { id: '1' }, scoringPlay: true, ownGoal: false, athletesInvolved: [{ displayName: 'Striker', position: 'F' }] },
        // a goalkeeper goal for South Africa
        { type: { text: 'Goal - Penalty' }, team: { id: '2' }, scoringPlay: true, ownGoal: false, athletesInvolved: [{ displayName: 'Keeper', position: { abbreviation: 'G' } }] },
        // shootout rows are ignored
        { type: { text: 'Goal' }, team: { id: '1' }, scoringPlay: true, shootout: true, athletesInvolved: [{ displayName: 'X', position: { abbreviation: 'G' } }] },
      ],
    }],
  };
  const evs = chaosFromScoreboardEvent(event);
  assert.deepEqual(
    evs.map((e) => `${e.team}:${e.type}`).sort(),
    ['Mexico:redCard', 'South Africa:gkGoal', 'South Africa:ownGoal'],
    'own goal flips to the conceding side; red card and GK goal stay with their team');
});

test('chaosFromScoreboardEvent: incomplete match yields nothing', () => {
  assert.deepEqual(chaosFromScoreboardEvent({ status: { type: { completed: false } }, competitions: [{}] }), []);
});

/* ---------- review regressions ---------- */
test('scoresFromFeed captures the Winner field for shootout ties', () => {
  const scores = scoresFromFeed([
    { MatchNumber: 104, HomeTeamScore: 3, AwayTeamScore: 3, Winner: 'Argentina' },
    { MatchNumber: 1, HomeTeamScore: 2, AwayTeamScore: 0 },
    { MatchNumber: 89, HomeTeamScore: 1, AwayTeamScore: 1, Winner: 'South Korea' }, // feed spelling
  ]);
  assert.equal(scores[104].w, 'Argentina');
  assert.equal(scores[89].w, 'Korea Republic', 'winner name is normalised to ours');
  assert.equal(scores[1].w, undefined);
});

test('bracket: level KO score counts as played only with a known shootout winner', () => {
  const base = fullGroupScores();
  // match 73 = 2A v 2B; find the real participants first
  const probe = predictBracket(TEAMS, FIX, base);
  const { home, away } = probe.resolveMatch(73);
  // level, no winner -> still a prediction
  const noW = predictBracket(TEAMS, FIX, { ...base, 73: { h: 1, a: 1 } });
  assert.equal(noW.resolveMatch(73).played, false);
  // level + shootout winner (the away side) -> played, away advances
  const withW = predictBracket(TEAMS, FIX, { ...base, 73: { h: 1, a: 1, w: away } });
  const r = withW.resolveMatch(73);
  assert.equal(r.played, true);
  assert.equal(r.winner, away);
  assert.equal(r.loser, home);
});

test('bracket resolves best-third slots to real teams once groups are complete', () => {
  const scores = fullGroupScores();
  const thirds = resolveThirdTeams(TEAMS, FIX, scores);
  assert.equal(Object.keys(thirds).length, 8);
  const sim = predictBracket(TEAMS, FIX, scores);
  const teamNames = new Set(TEAMS.map((t) => t.n));
  // every R32 match with a '3' slot must now name a real team
  for (const no of [74, 77, 79, 80, 81, 82, 85, 87]) {
    const r = sim.resolveMatch(no);
    assert.ok(teamNames.has(r.away), `match ${no} away is a real team, got ${r.away}`);
    assert.equal(r.away, thirds[no]);
  }
});

test('stageReached: full tournament yields the exact stage histogram', () => {
  const scores = fullGroupScores(104); // all KO home wins, decisive
  const stage = stageReached(TEAMS, FIX, scores);
  const hist = {};
  Object.values(stage).forEach((s) => { hist[s] = (hist[s] || 0) + 1; });
  assert.deepEqual(hist, { 0: 16, 1: 16, 2: 8, 3: 4, 4: 2, 5: 1, 6: 1 });
});

test('stageReached: KO scores are ignored while the group stage is incomplete', () => {
  const scores = { 1: { h: 2, a: 0 }, 73: { h: 1, a: 0 } }; // a KO score with groups unfinished
  const stage = stageReached(TEAMS, FIX, scores);
  assert.ok(Object.values(stage).every((s) => s === 0), 'no knockout credit from partial standings');
});

test('darkHorse: drawn final without a shootout winner does NOT settle the pot', () => {
  const scores = fullGroupScores(102); // through the semis
  scores[104] = { h: 1, a: 1 }; // final level, winner unknown
  const dh = darkHorseStanding(mkCtx(scores), rankings, sidepots.darkHorse);
  assert.equal(dh.decided, false, 'no champion yet — keep the pot open');
  // now the feed names the winner
  const sim = predictBracket(TEAMS, FIX, scores);
  const fin = sim.resolveMatch(104);
  scores[104] = { h: 1, a: 1, w: fin.home };
  const dh2 = darkHorseStanding(mkCtx(scores), rankings, sidepots.darkHorse);
  assert.equal(dh2.decided, true);
});

test('darkHorse: settled after a decisive full tournament', () => {
  const dh = darkHorseStanding(mkCtx(fullGroupScores(104)), rankings, sidepots.darkHorse);
  assert.equal(dh.decided, true);
  assert.ok(dh.leader, 'a leader exists');
  assert.ok(dh.leader.stage >= 1);
});

test('sim: drawn KO score without winner is sampled, not handed to the away side', () => {
  const scores = fullGroupScores(102);
  scores[104] = { h: 1, a: 1 }; // level final, no winner known
  const sim = runSim(mkCtx(scores), { iterations: 400, seed: 11 });
  const champs = Object.values(sim.teams).map((t) => t.champion);
  assert.ok(Math.max(...champs) < 1, 'no team wins 100% of simulations off a level score');
  // with the shootout winner known, that team is champion with certainty
  const fin = predictBracket(TEAMS, FIX, fullGroupScores(104)).resolveMatch(104);
  scores[104] = { h: 1, a: 1, w: fin.home };
  const sim2 = runSim(mkCtx(scores), { iterations: 200, seed: 11 });
  assert.equal(sim2.teams[fin.home].champion, 1, 'feed winner is champion in every iteration');
});

test('sim groupKey: GF breaks pts/GD ties regardless of rating or jitter', () => {
  // stronger rating + max jitter must NOT outrank one extra goal scored
  assert.ok(groupKey(5, 1, 7, 0.05, 0.0) > groupKey(5, 1, 4, 0.99, 0.999));
  assert.ok(groupKey(5, 2, 0, 0.05, 0.0) > groupKey(5, 1, 30, 0.99, 0.999), 'GD beats GF');
  assert.ok(groupKey(6, -10, 0, 0.05, 0.0) > groupKey(5, 10, 30, 0.99, 0.999), 'pts beat GD');
});

test('goalkeeperIds: roster positions including subbed-on keepers', () => {
  const summary = {
    rosters: [
      { roster: [
        { athlete: { id: 1 }, position: { abbreviation: 'G' } },
        { athlete: { id: 2 }, position: { abbreviation: 'F' } },
      ] },
      { roster: [{ athlete: { id: 9 }, position: 'G' }] },
    ],
  };
  assert.deepEqual([...goalkeeperIds(summary)].sort(), ['1', '9']);
});

test('chaosFromScoreboardEvent: subbed-on keeper goal detected via roster ids', () => {
  const event = {
    id: 'e2',
    status: { type: { completed: true } },
    competitions: [{
      competitors: [{ id: '1', team: { displayName: 'Brazil' } }, { id: '2', team: { displayName: 'Ghana' } }],
      details: [
        // scorer's lineup position is SUB but the roster says keeper
        { type: { text: 'Goal' }, team: { id: '2' }, scoringPlay: true, ownGoal: false, athletesInvolved: [{ id: 77, displayName: 'Backup Keeper', position: 'SUB' }] },
      ],
    }],
  };
  const evs = chaosFromScoreboardEvent(event, new Set(['77']));
  assert.deepEqual(evs.map((e) => `${e.team}:${e.type}`), ['Ghana:gkGoal']);
  assert.deepEqual(chaosFromScoreboardEvent(event), [], 'without roster ids the SUB position is not enough');
});

test('penaltyMissesFromSummary: regulation only, by id or text', () => {
  const summary = {
    keyEvents: [
      { type: { id: '114', text: 'Penalty - Saved' }, team: { displayName: 'England' }, participants: [{ athlete: { displayName: 'H. Kane' } }] },
      { type: { id: '999', text: 'Penalty - Missed' }, team: { displayName: 'Brazil' } },
      { type: { id: '114', text: 'Penalty - Saved' }, team: { displayName: 'France' }, shootout: true },
      { type: { id: '70', text: 'Goal' }, team: { displayName: 'Spain' } },
    ],
  };
  const evs = penaltyMissesFromSummary(summary, 'e1');
  assert.deepEqual(evs.map((e) => e.team).sort(), ['Brazil', 'England']);
  assert.equal(evs.find((e) => e.team === 'England').who, 'H. Kane');
});
