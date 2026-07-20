import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateLegs, generateMultis, settleMultis, rollMultis, multiPnl, multiClv,
  JOINT_FLOORS,
} from '../public/lib/multis.js';

const NOW = Date.parse('2026-07-20T00:00:00Z');
const FUT = '2026-07-24T09:00:00.000Z';
const bet = (id, sport, team, prob, price, status = 'pending', extra = {}) => ({
  id, team, opp: 'Opp-' + team, selection: `${team} to beat Opp-${team}`,
  prob, price, edge: Math.round((prob * price - 1) * 1000) / 1000,
  kickoff: FUT, round: 20, status, edgeCause: 'model-signal', ...extra,
});
const sportsWith = (nrlBets, aflBets) => ({
  nrl: { book: { round: 20, bets: nrlBets }, history: [] },
  afl: { book: { round: 19, bets: aflBets }, history: [] },
});

test('candidateLegs: pending future book bets from both codes, sorted by probability', () => {
  const sports = sportsWith(
    [bet('nrl-1', 'nrl', 'Panthers', 0.75, 1.5), bet('nrl-2', 'nrl', 'Storm', 0.6, 1.8, 'won')],
    [bet('afl-1', 'afl', 'Adelaide', 0.8, 1.4), bet('afl-2', 'afl', 'Hawthorn', 0.55, 2.0, 'pending', { kickoff: '2026-07-01T00:00:00.000Z' })],
  );
  const legs = candidateLegs(sports, NOW);
  assert.deepEqual(legs.map((l) => l.team), ['Adelaide', 'Panthers'], 'settled + already-kicked-off legs excluded; sorted by prob');
  assert.equal(legs[0].sport, 'afl');
});

test('generateMultis: sizes with enough legs + joint floors; edge compounds', () => {
  const legs = candidateLegs(sportsWith(
    [bet('n1', 'nrl', 'A', 0.75, 1.5), bet('n2', 'nrl', 'B', 0.72, 1.55), bet('n3', 'nrl', 'C', 0.7, 1.6)],
    [bet('a1', 'afl', 'D', 0.68, 1.65), bet('a2', 'afl', 'E', 0.66, 1.7)],
  ), NOW);
  const ms = generateMultis(legs, NOW);
  assert.deepEqual(ms.map((m) => m.size), [3, 4, 5], 'all three ladder rungs offered');
  const three = ms[0];
  assert.ok(Math.abs(three.prob - 0.75 * 0.72 * 0.7) < 0.002, 'joint prob = product');
  assert.ok(Math.abs(three.price - 1.5 * 1.55 * 1.6) < 0.01, 'combined price = product');
  assert.ok(three.edge > 0.2, 'edges compound (each leg ~+12% -> joint >20%)');
  assert.ok(ms[2].prob >= JOINT_FLOORS[5], '5-leg clears its floor');
  // coin-flip legs: every rung fails its joint floor (0.5^3=12.5%<25% etc.)
  const longshots = ['A', 'B', 'C', 'D', 'E'].map((t, i) => bet('l' + i, 'nrl', t, 0.5, 2.2));
  const ms2 = generateMultis(candidateLegs({ nrl: { book: { bets: longshots }, history: [] } }, NOW), NOW);
  assert.equal(ms2.length, 0, 'a stack of coin-flips is never offered');
});

test('generateMultis: 3-leg floor enforced too', () => {
  const legs = ['A', 'B', 'C'].map((t, i) => bet('x' + i, 'nrl', t, 0.55, 2.0));
  const ms = generateMultis(candidateLegs({ nrl: { book: { bets: legs }, history: [] } }, NOW), NOW);
  assert.equal(ms.length, 0, '0.55^3=16.6% < 25% floor -> no 3-leg offered');
});

test('settleMultis: lost on any lost leg, won only when all won, close prices flow through', () => {
  const b1 = bet('n1', 'nrl', 'A', 0.75, 1.5);
  const b2 = bet('a1', 'afl', 'B', 0.7, 1.6);
  const b3 = bet('a2', 'afl', 'C', 0.7, 1.6);
  const sports0 = sportsWith([b1], [b2, b3]);
  const [m] = generateMultis(candidateLegs(sports0, NOW), NOW);
  assert.equal(m.size, 3);
  // one leg loses -> multi lost even with a leg still pending
  const sportsLost = sportsWith([{ ...b1, status: 'lost' }], [{ ...b2, status: 'won' }, b3]);
  assert.equal(settleMultis([m], sportsLost)[0].status, 'lost');
  // all legs win -> won, and banked closePrices arrive for CLV
  const sportsWon = sportsWith([{ ...b1, status: 'won', closePrice: 1.4 }], [{ ...b2, status: 'won', closePrice: 1.5 }, { ...b3, status: 'won', closePrice: 1.55 }]);
  const won = settleMultis([m], sportsWon)[0];
  assert.equal(won.status, 'won');
  assert.equal(won.stake, 10, 'multis carry a $10 stake (a tenth of a single)');
  assert.ok(Math.abs(multiPnl(won) - won.stake * (won.price - 1)) < 1e-6, 'pays stake x (price-1)');
  const clv = multiClv(won);
  assert.ok(Math.abs(clv - (won.price / (1.4 * 1.5 * 1.55) - 1)) < 0.002, 'CLV compounds vs combined close');
  assert.equal(multiClv(m), null, 'no close banked -> null CLV');
});

test('rollMultis: generates once, freezes while open, archives when settled', () => {
  const b = (id, t, p, pr, st = 'pending') => bet(id, 'nrl', t, p, pr, st);
  const open = sportsWith([b('n1', 'A', 0.75, 1.5), b('n2', 'B', 0.72, 1.55)], [bet('a1', 'afl', 'C', 0.7, 1.6)]);
  const w1 = rollMultis(null, open, NOW);
  assert.ok(w1.current && w1.current.multis.length >= 1, 'ladder generated from 3 qualifying legs');
  // next run with different (better) legs: current is FROZEN, not rewritten
  const w2 = rollMultis(w1, open, NOW + 3600e3);
  assert.equal(w2.current.generatedAt, w1.current.generatedAt, 'open ladder never regenerated');
  // all legs settle -> archived, and a new week with no open books -> current null
  const done = sportsWith(
    [{ ...b('n1', 'A', 0.75, 1.5), status: 'won' }, { ...b('n2', 'B', 0.72, 1.55), status: 'won' }],
    [{ ...bet('a1', 'afl', 'C', 0.7, 1.6), status: 'lost' }],
  );
  const w3 = rollMultis(w2, done, NOW + 86400e3);
  assert.equal(w3.history.length, 1, 'settled ladder archived');
  // with no fresh pending legs, the new current can only come from... the same
  // (now settled) books -> candidateLegs is empty -> no current
  assert.equal(w3.current, null, 'no new ladder without fresh qualifying legs');
  // fewer than 3 legs -> nothing generated
  const thin = sportsWith([b('n9', 'Z', 0.8, 1.4)], []);
  assert.equal(rollMultis(null, thin, NOW).current, null, '<3 legs -> empty week (rule 5)');
});
