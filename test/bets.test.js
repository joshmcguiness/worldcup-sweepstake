import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TEAMS } from '../public/lib/teams.js';
import { FIX } from '../public/lib/fixtures.js';
import { runSim } from '../public/lib/sim.js';
import { predictBracket } from '../public/lib/bracket.js';
import { matchProbs, aestDate, generateBets, settleBets, rollBets } from '../public/lib/bets.js';

const cfgDir = new URL('../config/', import.meta.url);
const drawCfg = JSON.parse(readFileSync(new URL('draw.json', cfgDir), 'utf-8'));
const rankings = JSON.parse(readFileSync(new URL('rankings.json', cfgDir), 'utf-8'));
const gbCandidates = JSON.parse(readFileSync(new URL('goldenboot-candidates.json', cfgDir), 'utf-8'));

function mkCtx(scores = {}) {
  return {
    teams: TEAMS, fixtures: FIX, scores,
    players: drawCfg.players, owners: drawCfg.owners,
    buyIn: drawCfg.buyIn, split: drawCfg.split,
  };
}
const SIM = runSim(mkCtx({}), { iterations: 3000, seed: 9 });
const GEN_OPTS = {
  date: aestDate(FIX[0].d), // opening matchday in AEST
  bootCandidates: gbCandidates.candidates,
  ranks: rankings.ranks,
  now: Date.parse('2026-06-11T00:00:00Z'), // before any kickoff
};

function fullGroupScores(uptoKo = 0) {
  const scores = {};
  FIX.filter((m) => m.r <= 3).forEach((m) => {
    scores[m.no] = m.h < m.a ? { h: 2, a: 0 } : { h: 0, a: 2 };
  });
  FIX.filter((m) => m.r >= 4 && m.no <= uptoKo).forEach((m) => { scores[m.no] = { h: 1, a: 0 }; });
  return scores;
}

test('matchProbs: group games can draw, knockouts cannot, favourites favoured', () => {
  const g = matchProbs(TEAMS, 'Spain', 'Cabo Verde', true);
  assert.ok(Math.abs(g.home + g.draw + g.away - 1) < 1e-9);
  assert.equal(g.draw, 0.24);
  assert.ok(g.home > g.away, 'Spain favoured');
  const k = matchProbs(TEAMS, 'Spain', 'Cabo Verde', false);
  assert.equal(k.draw, 0);
  assert.ok(Math.abs(k.home + k.away - 1) < 1e-9);
});

test('aestDate: UTC evening rolls into the next AEST day', () => {
  assert.equal(aestDate('2026-06-11T19:00:00Z'), '2026-06-12');
  assert.equal(aestDate('2026-06-11T02:00:00Z'), '2026-06-11');
});

test('generateBets: top 10, deterministic, sensible shapes, comments present', () => {
  const ctx = mkCtx({});
  const a = generateBets(ctx, SIM, GEN_OPTS);
  const b = generateBets(ctx, SIM, GEN_OPTS);
  assert.deepEqual(a, b, 'same inputs, same book');
  assert.ok(a.length > 0 && a.length <= 10);
  a.forEach((bet) => {
    assert.ok(bet.name && bet.selection && bet.comment, 'every bet is called and explained');
    assert.ok(bet.prob > 0 && bet.prob < 1);
    assert.ok(bet.fairOdds >= 1);
    assert.equal(bet.status, 'pending');
    assert.ok(['single', 'multi', 'scorer', 'wildcard'].includes(bet.type));
    assert.ok(bet.id.startsWith(GEN_OPTS.date));
  });
  // singles only on the day's slate
  a.filter((x) => x.type === 'single').forEach((x) => {
    assert.equal(aestDate(FIX.find((m) => m.no === x.matchNo).d), GEN_OPTS.date);
  });
});

test('generateBets: market odds produce edge numbers', () => {
  const ctx = mkCtx({});
  const slateNos = FIX.filter((m) => aestDate(m.d) === GEN_OPTS.date).map((m) => m.no);
  const marketOdds = Object.fromEntries(slateNos.map((no) => [no, { home: 1.9, away: 4.2, draw: 3.4 }]));
  const bets = generateBets(ctx, SIM, { ...GEN_OPTS, marketOdds });
  const withMkt = bets.filter((b) => b.type === 'single' && b.marketOdds);
  assert.ok(withMkt.length > 0, 'singles carry market odds');
  withMkt.forEach((b) => assert.ok(Math.abs(b.edge - (b.prob * b.marketOdds - 1)) < 1e-9));
});

test('generateBets: no knockout bets while participants are unconfirmed', () => {
  // R32 day with the group stage NOT complete -> empty match slate
  const ctx = mkCtx({ 1: { h: 1, a: 0 } });
  const bets = generateBets(ctx, SIM, { ...GEN_OPTS, date: aestDate(FIX.find((m) => m.no === 73).d) });
  bets.forEach((b) => {
    if (b.matchNo) assert.ok(FIX.find((m) => m.no === b.matchNo).r <= 3, 'no KO bets on predictions');
  });
});

test('settleBets: match single wins/loses, draws lose, pens use the feed winner', () => {
  const bets = [
    { status: 'pending', settle: { kind: 'match', no: 1, team: 'Mexico' } },
    { status: 'pending', settle: { kind: 'match', no: 1, team: 'South Africa' } },
    { status: 'pending', settle: { kind: 'match', no: 2, team: 'Korea Republic' } }, // drawn
    { status: 'pending', settle: { kind: 'match', no: 3, team: 'Canada' } }, // unplayed
  ];
  const scores = { 1: { h: 2, a: 0 }, 2: { h: 1, a: 1 } };
  const out = settleBets(bets, mkCtx(scores), {});
  assert.deepEqual(out.map((b) => b.status), ['won', 'lost', 'lost', 'pending']);
});

test('settleBets: multi loses on first busted leg, wins when all land', () => {
  const multi = (legs) => [{ status: 'pending', settle: { kind: 'multi', legs } }];
  const legs = [{ kind: 'match', no: 1, team: 'Mexico' }, { kind: 'match', no: 3, team: 'Canada' }];
  let out = settleBets(multi(legs), mkCtx({ 1: { h: 0, a: 1 } }), {});
  assert.equal(out[0].status, 'lost', 'busted leg sinks it even with one leg unplayed');
  out = settleBets(multi(legs), mkCtx({ 1: { h: 2, a: 0 } }), {});
  assert.equal(out[0].status, 'pending');
  out = settleBets(multi(legs), mkCtx({ 1: { h: 2, a: 0 }, 3: { h: 1, a: 0 } }), {});
  assert.equal(out[0].status, 'won');
});

test('settleBets: scorer settles from the ESPN goal bank', () => {
  const bet = () => [{ status: 'pending', settle: { kind: 'scorer', no: 1, team: 'Mexico', who: 'Santiago Giménez' } }];
  const scores = { 1: { h: 2, a: 0 } };
  const goals = [{ team: 'Mexico', who: 'Santiago Gimenez', ymd: '2026-06-11', eventId: 'e' }];
  // scored (diacritic-insensitive match)
  let out = settleBets(bet(), mkCtx(scores), { goalEvents: goals, fetchedDays: ['20260611'] });
  assert.equal(out[0].status, 'won');
  // team scored but not him, day harvested -> lost
  out = settleBets(bet(), mkCtx(scores), { goalEvents: [{ team: 'Mexico', who: 'Raúl Jiménez', ymd: '2026-06-11' }], fetchedDays: ['20260611'] });
  assert.equal(out[0].status, 'lost');
  // day not harvested yet -> pending
  out = settleBets(bet(), mkCtx(scores), { goalEvents: [], fetchedDays: [] });
  assert.equal(out[0].status, 'pending');
  // his side scored 0 -> lost regardless of the bank
  out = settleBets(bet(), mkCtx({ 1: { h: 0, a: 1 } }), { goalEvents: [], fetchedDays: [] });
  assert.equal(out[0].status, 'lost');
});

test('settleBets: group and last8 wildcards', () => {
  const scores = fullGroupScores();
  const ctx = mkCtx(scores);
  const gmapWinnerA = predictBracket(TEAMS, FIX, scores).standings;
  const winnerA = Object.values(gmapWinnerA).find((x) => x.g === 'A' && x.rank === 1).n;
  const loserA = Object.values(gmapWinnerA).find((x) => x.g === 'A' && x.rank === 4).n;
  let out = settleBets([
    { status: 'pending', settle: { kind: 'group', g: 'A', team: winnerA } },
    { status: 'pending', settle: { kind: 'group', g: 'A', team: loserA } },
    { status: 'pending', settle: { kind: 'last8', team: loserA } }, // out at groups
  ], ctx, {});
  assert.deepEqual(out.map((b) => b.status), ['won', 'lost', 'lost']);
  // group bets stay pending while groups are running
  out = settleBets([{ status: 'pending', settle: { kind: 'group', g: 'A', team: winnerA } }], mkCtx({ 1: { h: 1, a: 0 } }), {});
  assert.equal(out[0].status, 'pending');
  // last8: won once a team wins its R16 tie
  const deep = fullGroupScores(96); // through R16
  const ctx2 = mkCtx(deep);
  const br = predictBracket(TEAMS, FIX, deep);
  const r16winner = br.resolveMatch(89).winner;
  const r32loser = br.resolveMatch(73).loser;
  out = settleBets([
    { status: 'pending', settle: { kind: 'last8', team: r16winner } },
    { status: 'pending', settle: { kind: 'last8', team: r32loser } },
  ], ctx2, {});
  assert.deepEqual(out.map((b) => b.status), ['won', 'lost']);
});

/* ---------- review regressions ---------- */
test('generation excludes matches that have already kicked off', () => {
  const ctx = mkCtx({});
  // generate AFTER match 1's 19:00Z kickoff but before match 2's 02:00Z
  const bets = generateBets(ctx, SIM, { ...GEN_OPTS, now: Date.parse('2026-06-11T20:00:00Z') });
  bets.forEach((b) => assert.notEqual(b.matchNo, 1, 'no after-the-fact calls'));
  const multi = bets.find((b) => b.type === 'multi');
  if (multi) multi.settle.legs.forEach((l) => assert.notEqual(l.no, 1));
});

test('scorer settlement on a night-UTC kickoff uses the EVENT date, not the ESPN page day', async () => {
  const { goalsFromScoreboardEvent } = await import('../public/lib/espn.js');
  // match 2 kicks 2026-06-12T02:00Z — ESPN lists it on its 2026-06-11 (US-Eastern) page
  const espnEvent = {
    id: '760414',
    date: '2026-06-12T02:00Z',
    status: { type: { completed: true } },
    competitions: [{
      competitors: [{ id: '1', team: { displayName: 'South Korea' } }, { id: '2', team: { displayName: 'Czech Republic' } }],
      details: [{ type: { text: 'Goal' }, team: { id: '1' }, scoringPlay: true, ownGoal: false, athletesInvolved: [{ displayName: 'Son Heung-Min' }] }],
    }],
  };
  const goals = goalsFromScoreboardEvent(espnEvent, '2026-06-11'); // page day passed as fallback
  assert.equal(goals[0].ymd, '2026-06-12', 'keyed by the event kickoff, not the page day');
  assert.equal(goals[0].team, 'Korea Republic');
  const bet = [{ status: 'pending', settle: { kind: 'scorer', no: 2, team: 'Korea Republic', who: 'Son Heung-Min' } }];
  const out = settleBets(bet, mkCtx({ 2: { h: 1, a: 0 } }), { goalEvents: goals, fetchedDays: ['20260611', '20260612'] });
  assert.equal(out[0].status, 'won');
});

test('a teammate with the same surname does not settle a scorer bet', () => {
  const bet = () => [{ status: 'pending', settle: { kind: 'scorer', no: 19, team: 'Argentina', who: 'Lautaro Martínez' } }];
  const scores = { 19: { h: 1, a: 0 } }; // Argentina home in match 19
  const day = '2026-06-17';
  // Lisandro's goal must NOT pay Lautaro's bet (full different given name)
  let out = settleBets(bet(), mkCtx(scores), { goalEvents: [{ team: 'Argentina', who: 'Lisandro Martínez', ymd: day }], fetchedDays: ['20260617'] });
  assert.equal(out[0].status, 'lost');
  // an initial-abbreviated feed name with the right initial still pays
  out = settleBets(bet(), mkCtx(scores), { goalEvents: [{ team: 'Argentina', who: 'L. Martínez', ymd: day }], fetchedDays: [] });
  assert.equal(out[0].status, 'won');
  // wrong initial does not
  out = settleBets(bet(), mkCtx(scores), { goalEvents: [{ team: 'Argentina', who: 'E. Martínez', ymd: day }], fetchedDays: ['20260617'] });
  assert.equal(out[0].status, 'lost');
});

test('a pts/GD/GF dead heat for the group crown stays pending, not settled by odds', () => {
  // Group A engineered so Mexico and Korea Republic tie exactly: both 7 pts,
  // GF 5, GA 1 — FIFA would split them on head-to-head/fair play, we cannot.
  const scores = fullGroupScores();
  Object.assign(scores, {
    1: { h: 2, a: 0 },   // Mexico 2-0 South Africa
    2: { h: 2, a: 0 },   // Korea 2-0 Czechia
    25: { h: 1, a: 1 },  // Czechia 1-1 South Africa
    28: { h: 1, a: 1 },  // Mexico 1-1 Korea
    53: { h: 0, a: 2 },  // Czechia 0-2 Mexico
    54: { h: 0, a: 2 },  // South Africa 0-2 Korea
  });
  const out = settleBets([
    { status: 'pending', settle: { kind: 'group', g: 'A', team: 'Mexico' } },
    { status: 'pending', settle: { kind: 'group', g: 'A', team: 'Korea Republic' } },
  ], mkCtx(scores), {});
  assert.deepEqual(out.map((b) => b.status), ['pending', 'pending']);
});

test('a corrected feed score re-settles an already-settled bet', () => {
  const bet = [{ status: 'pending', settle: { kind: 'match', no: 1, team: 'Mexico' } }];
  // glitched feed: 1-1 -> bet busts
  let out = settleBets(bet, mkCtx({ 1: { h: 1, a: 1 } }), {});
  assert.equal(out[0].status, 'lost');
  // feed corrected to 2-0 next refresh -> bet self-heals
  out = settleBets(out, mkCtx({ 1: { h: 2, a: 0 } }), {});
  assert.equal(out[0].status, 'won');
  // feed drops the score entirely -> settled status survives
  out = settleBets(out, mkCtx({}), {});
  assert.equal(out[0].status, 'won');
});

test('rollBets: freezes the day, archives, settles, caps history', () => {
  const ctx = mkCtx({});
  const day1 = rollBets(null, ctx, SIM, GEN_OPTS);
  assert.equal(day1.current.date, GEN_OPTS.date);
  assert.equal(day1.history.length, 0);
  // same day again: book unchanged
  const day1b = rollBets(day1, ctx, SIM, GEN_OPTS);
  assert.deepEqual(day1b.current.bets.map((b) => b.id), day1.current.bets.map((b) => b.id));
  // next day: archive + new book; old single settles from the new score
  const scores = { 1: { h: 2, a: 0 } };
  const ctx2 = mkCtx(scores);
  const day2 = rollBets(day1, ctx2, SIM, { ...GEN_OPTS, date: '2026-06-13' });
  assert.equal(day2.current.date, '2026-06-13');
  assert.equal(day2.history.length, 1);
  const archived = day2.history[0].bets.find((b) => b.settle.kind === 'match' && b.settle.no === 1);
  if (archived) assert.notEqual(archived.status, 'pending', 'match 1 result settles the archived bet');
});
