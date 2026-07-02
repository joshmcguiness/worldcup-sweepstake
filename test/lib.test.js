import test from 'node:test';
import assert from 'node:assert/strict';

import { TEAMS, strengthOf, mapName } from '../public/lib/teams.js';
import { FIX, feedKnockoutTeams, resolveFixtures } from '../public/lib/fixtures.js';
import { doDrawCore, mulberry32 } from '../public/lib/draw.js';
import { computeStandings, teamByGroupRank, resolveSlot } from '../public/lib/standings.js';
import { predictBracket } from '../public/lib/bracket.js';
import { BONUS, computeBonus, poolRows } from '../public/lib/scoring.js';
import { runSim, assignThirds } from '../public/lib/sim.js';

const NAMES = ['Ann', 'Ben', 'Cat', 'Dan', 'Eve', 'Fox', 'Gus', 'Hal', 'Ivy', 'Jay', 'Kim', 'Lee', 'Mia'];

/* ---------- feed-resolved knockout teams (real teams override our matcher) ---------- */
test('feedKnockoutTeams: reads real knockout teams, ignores slot codes and TBA', () => {
  const rows = [
    { MatchNumber: 14, HomeTeam: 'Spain', AwayTeam: 'Cabo Verde' }, // group row, ignored (no <73 guard hit)
    { MatchNumber: 74, HomeTeam: 'Germany', AwayTeam: 'Paraguay' }, // real R32 teams
    { MatchNumber: 75, HomeTeam: '1F', AwayTeam: '2C' }, // still slot codes -> skipped
    { MatchNumber: 89, HomeTeam: 'Paraguay', AwayTeam: 'To be announced' }, // half known
  ];
  const ko = feedKnockoutTeams(rows);
  assert.deepEqual(ko[74], { home: 'Germany', away: 'Paraguay' });
  assert.equal(ko[75], undefined, 'slot codes do not resolve to teams');
  assert.deepEqual(ko[89], { home: 'Paraguay' }, 'only the known side is captured');
  assert.equal(ko[14], undefined, 'group rows (no < 73) are not knockout teams');
});

test('resolveFixtures: overrides knockout slots with feed teams, leaves groups + unknown slots', () => {
  const ko = { 74: { home: 'Germany', away: 'Paraguay' }, 89: { home: 'Paraguay' } };
  const rf = resolveFixtures(FIX, ko);
  const m74 = rf.find((m) => m.no === 74);
  assert.equal(m74.h, 'Germany');
  assert.equal(m74.a, 'Paraguay');
  const m89 = rf.find((m) => m.no === 89);
  assert.equal(m89.h, 'Paraguay');
  assert.equal(m89.a, 'W77', 'unknown away keeps its slot code for prediction (official wiring: #89 = W74 v W77)');
  // group fixtures untouched, original identity preserved
  assert.equal(rf.find((m) => m.no === 1).h, FIX.find((m) => m.no === 1).h);
  // empty koTeams returns the same array (no-op)
  assert.equal(resolveFixtures(FIX, {}), FIX);
});

test('predictBracket trusts feed teams + shootout winner (Germany 1-1 Paraguay, Paraguay on pens)', () => {
  const ko = { 74: { home: 'Germany', away: 'Paraguay' } };
  const rf = resolveFixtures(FIX, ko);
  const scores = { 74: { h: 1, a: 1, w: 'Paraguay' } };
  const sim = predictBracket(TEAMS, rf, scores);
  const r = sim.resolveMatch(74);
  assert.equal(r.home, 'Germany');
  assert.equal(r.away, 'Paraguay');
  assert.equal(r.played, true, 'level score + feed winner counts as played');
  assert.equal(r.winner, 'Paraguay');
  // and the winner propagates to the R16 slot fed by W74
  const m89 = FIX.find((x) => x.h === 'W74' || x.a === 'W74');
  if (m89) {
    const feeder = sim.resolveMatch(m89.no);
    assert.ok(feeder.home === 'Paraguay' || feeder.away === 'Paraguay');
  }
});

test('runSim still works on raw FIX slot codes after the feed-resolve change', () => {
  // sim must NOT receive resolved fixtures — guard against a regression where
  // real team names leak into the slot-code bracket walker.
  const players = ['P1', 'P2', 'P3'];
  const owners = doDrawCore(players, TEAMS, 1);
  const sim = runSim({ teams: TEAMS, fixtures: FIX, scores: {}, players, owners }, { iterations: 300, seed: 2 });
  const champSum = Object.values(sim.teams).reduce((s, x) => s + x.champion, 0);
  assert.ok(Math.abs(champSum - 1) < 1e-9, 'champion probabilities still sum to 1');
});

function mkCtx(scores = {}, players = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
  const owners = doDrawCore(players, TEAMS, 12345);
  return { teams: TEAMS, fixtures: FIX, players, owners, scores, buyIn: 20, split: { winner: 50, runner: 25, goals: 15, spoon: 10 } };
}

/* ---------- static data ---------- */
test('static data shape', () => {
  assert.equal(TEAMS.length, 48);
  assert.equal(FIX.length, 104);
  assert.equal(FIX[103].rn, 'Final');
  assert.equal(FIX[103].no, 104);
  // 12 groups of 4
  const byG = {};
  TEAMS.forEach((t) => { byG[t.g] = (byG[t.g] || 0) + 1; });
  assert.equal(Object.keys(byG).length, 12);
  Object.values(byG).forEach((n) => assert.equal(n, 4));
});

test('knockout wiring matches the official 2026 bracket', () => {
  const code = (no) => { const m = FIX.find((x) => x.no === no); return m.h + '/' + m.a; };
  // R16 (official, verified against the live feed + 3 independent sources)
  assert.equal(code(89), 'W74/W77');
  assert.equal(code(90), 'W73/W75');
  assert.equal(code(91), 'W76/W78');
  assert.equal(code(92), 'W79/W80');
  assert.equal(code(93), 'W83/W84');
  assert.equal(code(94), 'W81/W82');
  assert.equal(code(95), 'W86/W88');
  assert.equal(code(96), 'W85/W87');
  // QF / SF / Final
  assert.equal(code(97), 'W89/W90');
  assert.equal(code(98), 'W93/W94');
  assert.equal(code(99), 'W91/W92');
  assert.equal(code(100), 'W95/W96');
  assert.equal(code(101), 'W97/W98');
  assert.equal(code(102), 'W99/W100');
  assert.equal(code(103), 'L101/L102');
  assert.equal(code(104), 'W101/W102');
  // internal consistency: each R32 winner feeds exactly one R16 slot
  const r16 = FIX.filter((m) => m.r === 5).flatMap((m) => [m.h, m.a]).sort();
  assert.deepEqual(r16, Array.from({ length: 16 }, (_, i) => 'W' + (73 + i)).sort());
  const qf = FIX.filter((m) => m.r === 6).flatMap((m) => [m.h, m.a]).sort();
  assert.deepEqual(qf, Array.from({ length: 8 }, (_, i) => 'W' + (89 + i)).sort());
});

test('odds name mapping', () => {
  assert.equal(mapName('United States'), 'USA');
  assert.equal(mapName('South Korea'), 'Korea Republic');
  assert.equal(mapName('Turkey'), 'Türkiye');
  assert.equal(mapName('Ivory Coast'), "Côte d'Ivoire");
  assert.equal(mapName('Atlantis'), null);
});

/* ---------- draw (handoff §9: balance + EV equality across N=5..13) ---------- */
for (let N = 5; N <= 13; N++) {
  test(`draw balance and EV equality, N=${N}`, () => {
    const players = NAMES.slice(0, N);
    const owners = doDrawCore(players, TEAMS, 42 + N);
    assert.equal(Object.keys(owners).length, 48);
    const cnt = {}, ev = {};
    players.forEach((p) => { cnt[p] = 0; ev[p] = 0; });
    for (const [t, p] of Object.entries(owners)) {
      cnt[p]++;
      ev[p] += strengthOf(TEAMS.find((x) => x.n === t).o);
    }
    const counts = Object.values(cnt);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'team counts within 1');
    // Greedy balancing bounds the spread by the strongest single team
    // (with many players one Spain-sized team alone can exceed the mean hand).
    const evs = Object.values(ev);
    const spread = Math.max(...evs) - Math.min(...evs);
    const maxTeam = Math.max(...TEAMS.map((t) => strengthOf(t.o)));
    assert.ok(spread <= maxTeam + 1e-9, `EV spread ${spread.toFixed(4)} ≤ strongest team ${maxTeam.toFixed(4)}`);
  });
}

test('draw is reproducible from seed', () => {
  const a = doDrawCore(['X', 'Y', 'Z'], TEAMS, 777);
  const b = doDrawCore(['X', 'Y', 'Z'], TEAMS, 777);
  assert.deepEqual(a, b);
  const c = doDrawCore(['X', 'Y', 'Z'], TEAMS, 778);
  assert.notDeepEqual(a, c);
});

test('config draw.json owners are structurally valid', async () => {
  // NOTE: the live draw was made with an older round-robin deal, so it cannot
  // be reproduced from the seed with today's EV-balanced algorithm. The
  // explicit owners map is canonical (handoff §6) — we only validate shape.
  const { readFile } = await import('node:fs/promises');
  const cfg = JSON.parse(await readFile(new URL('../config/draw.json', import.meta.url), 'utf-8'));
  assert.equal(Object.keys(cfg.owners).length, 48);
  const teamNames = new Set(TEAMS.map((t) => t.n));
  const cnt = {};
  for (const [team, owner] of Object.entries(cfg.owners)) {
    assert.ok(teamNames.has(team), `unknown team ${team}`);
    assert.ok(cfg.players.includes(owner), `unknown owner ${owner}`);
    cnt[owner] = (cnt[owner] || 0) + 1;
  }
  const counts = Object.values(cnt);
  assert.equal(counts.length, cfg.players.length, 'every player owns at least one team');
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'team counts within 1');
});

/* ---------- standings (hand-checked mini fixture) ---------- */
test('standings: hand-checked group A', () => {
  // A: Mexico, South Africa, Korea Republic, Czechia
  // m1 Mexico 2-0 South Africa, m2 Korea 1-1 Czechia,
  // m25 Czechia 0-3 South Africa, m28 Mexico 2-2 Korea
  const scores = { 1: { h: 2, a: 0 }, 2: { h: 1, a: 1 }, 25: { h: 0, a: 3 }, 28: { h: 2, a: 2 } };
  const st = computeStandings(TEAMS, FIX, scores);
  assert.equal(st['Mexico'].pts, 4);
  assert.equal(st['Korea Republic'].pts, 2);
  assert.equal(st['South Africa'].pts, 3);
  assert.equal(st['Czechia'].pts, 1);
  assert.equal(st['Mexico'].rank, 1);
  assert.equal(st['South Africa'].rank, 2); // 3 pts beats Korea's 2
  assert.equal(st['Mexico'].gd, 2);
  assert.equal(st['South Africa'].gd, 1);
});

test('standings: before any games, groups are seeded by odds', () => {
  const st = computeStandings(TEAMS, FIX, {});
  assert.equal(st['Spain'].rank, 1); // strongest in group H
  assert.equal(st['Brazil'].rank, 1); // strongest in group C
  const gmap = teamByGroupRank(st);
  assert.equal(gmap['H1'], 'Spain');
});

test('resolveSlot codes', () => {
  const gmap = { A1: 'Mexico', B2: 'Canada' };
  assert.equal(resolveSlot('1A', gmap), 'Mexico');
  assert.equal(resolveSlot('2B', gmap), 'Canada');
  assert.equal(resolveSlot('3CEFHI', gmap), 'Best 3rd (CEFHI)');
});

/* ---------- bracket ---------- */
test('bracket resolves W/L chains and real scores take over', () => {
  // No scores: prediction by odds — match 73 is 2A v 2B
  const sim0 = predictBracket(TEAMS, FIX, {});
  const r0 = sim0.resolveMatch(104);
  assert.equal(r0.played, false);
  assert.ok(r0.winner && r0.winner !== '?');

  // Give match 73 a real score; winner must feed match 90's home (official
  // wiring: #90 = W73 v W75)
  const sim1 = predictBracket(TEAMS, FIX, { 73: { h: 0, a: 2 } });
  const m73 = sim1.resolveMatch(73);
  assert.equal(m73.played, true);
  assert.equal(m73.winner, m73.away);
  const m90 = sim1.resolveMatch(90);
  assert.equal(m90.home, m73.winner);
});

test('knockout bonus only counts played ties, with BONUS values', () => {
  const ctx = mkCtx({ 73: { h: 1, a: 0 }, 89: { h: 2, a: 1 } });
  const sim = predictBracket(TEAMS, FIX, ctx.scores);
  const w73 = sim.resolveMatch(73).winner;
  const w89 = sim.resolveMatch(89).winner;
  const tb = computeBonus(ctx);
  const expected = {};
  expected[w73] = (expected[w73] || 0) + BONUS[4];
  expected[w89] = (expected[w89] || 0) + BONUS[5];
  assert.deepEqual(tb, expected);
});

test('poolRows totals = group pts + bonus, sorted desc', () => {
  const ctx = mkCtx({ 1: { h: 2, a: 0 } });
  const rows = poolRows(ctx);
  assert.equal(rows.length, 6);
  rows.forEach((r) => assert.equal(r.total, r.gp + r.bonus));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].total >= rows[i].total);
  const mexicoOwner = ctx.owners['Mexico'];
  const owner = rows.find((r) => r.p === mexicoOwner);
  assert.ok(owner.gp >= 3, 'Mexico win counts 3 pts for its owner');
});

/* ---------- sim ---------- */
test('assignThirds finds a valid matching', () => {
  const slots = [
    { no: 74, allowed: ['A', 'B', 'C', 'D', 'F'] },
    { no: 77, allowed: ['C', 'D', 'F', 'G', 'H'] },
    { no: 79, allowed: ['C', 'E', 'F', 'H', 'I'] },
    { no: 80, allowed: ['E', 'H', 'I', 'J', 'K'] },
    { no: 81, allowed: ['B', 'E', 'F', 'I', 'J'] },
    { no: 82, allowed: ['A', 'E', 'H', 'I', 'J'] },
    { no: 85, allowed: ['E', 'F', 'G', 'I', 'J'] },
    { no: 87, allowed: ['D', 'E', 'I', 'J', 'L'] },
  ];
  const thirds = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'L'];
  const got = assignThirds(slots, thirds);
  assert.equal(Object.keys(got).length, 8);
  assert.deepEqual(Object.values(got).sort(), thirds.slice().sort(), 'each third used exactly once');
  slots.forEach((s) => assert.ok(s.allowed.includes(got[s.no]), `slot ${s.no} got allowed group`));
});

test('sim sanity: probabilities behave', () => {
  const ctx = mkCtx({});
  const sim = runSim(ctx, { iterations: 2000, seed: 7 });
  const t = sim.teams;
  // all probabilities in [0,1], monotonically non-increasing through stages
  for (const n of Object.keys(t)) {
    const x = t[n];
    for (const k of ['last32', 'last16', 'last8', 'last4', 'final', 'champion']) {
      assert.ok(x[k] >= 0 && x[k] <= 1, `${n}.${k} in range`);
    }
    assert.ok(x.last32 >= x.last16 && x.last16 >= x.last8 && x.last8 >= x.last4 && x.last4 >= x.final && x.final >= x.champion, `${n} stages monotonic`);
  }
  // champion probabilities sum to 1
  const champSum = Object.values(t).reduce((s, x) => s + x.champion, 0);
  assert.ok(Math.abs(champSum - 1) < 1e-9, `champion probs sum to 1, got ${champSum}`);
  // exactly 32 teams reach last32, 8 reach last8 per iteration
  const l32 = Object.values(t).reduce((s, x) => s + x.last32, 0);
  assert.ok(Math.abs(l32 - 32) < 1e-9, `last32 sums to 32, got ${l32}`);
  const l8 = Object.values(t).reduce((s, x) => s + x.last8, 0);
  assert.ok(Math.abs(l8 - 8) < 1e-9, `last8 sums to 8, got ${l8}`);
  // favourites beat minnows
  assert.ok(t['Spain'].champion > t['South Africa'].champion, 'Spain >> South Africa');
  assert.ok(t['France'].last8 > t['Haiti'].last8, 'France >> Haiti for last 8');
  // player expectations consistent
  const expSum = Object.values(sim.players).reduce((s, x) => s + x.expLast8, 0);
  assert.ok(Math.abs(expSum - 8) < 1e-9, `player expected last-8 teams sum to 8, got ${expSum}`);
  const pChampSum = Object.values(sim.players).reduce((s, x) => s + x.pChampion, 0);
  assert.ok(Math.abs(pChampSum - 1) < 1e-9, 'owner-of-champion probs sum to 1');
  // exactly one pool winner and one wooden spoon per iteration
  const pTopSum = Object.values(sim.players).reduce((s, x) => s + x.pTopPool, 0);
  assert.ok(Math.abs(pTopSum - 1) < 1e-9, `pTopPool sums to 1, got ${pTopSum}`);
  const pSpoonSum = Object.values(sim.players).reduce((s, x) => s + x.pSpoon, 0);
  assert.ok(Math.abs(pSpoonSum - 1) < 1e-9, `pSpoon sums to 1, got ${pSpoonSum}`);
  Object.values(sim.players).forEach((x) => {
    assert.ok(x.pTopPool >= 0 && x.pTopPool <= 1 && x.pSpoon >= 0 && x.pSpoon <= 1);
  });
});

test('sim respects real results', () => {
  // Mexico loses all three group games — it can never reach the knockouts
  const scores = { 1: { h: 0, a: 1 }, 28: { h: 0, a: 1 }, 53: { h: 1, a: 0 } };
  const ctx = mkCtx(scores);
  const sim = runSim(ctx, { iterations: 500, seed: 3 });
  assert.equal(sim.teams['Mexico'].last32, 0);
});

test('rng is deterministic', () => {
  const a = mulberry32(99), b = mulberry32(99);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});
