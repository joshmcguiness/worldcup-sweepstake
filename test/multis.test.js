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
  // modest per-leg edges (~4-5%) so every rung stays under the 50% joint cap
  const legs = candidateLegs(sportsWith(
    [bet('n1', 'nrl', 'A', 0.75, 1.4), bet('n2', 'nrl', 'B', 0.72, 1.45), bet('n3', 'nrl', 'C', 0.7, 1.5)],
    [bet('a1', 'afl', 'D', 0.68, 1.53), bet('a2', 'afl', 'E', 0.66, 1.56)],
  ), NOW);
  const ms = generateMultis(legs, NOW);
  assert.deepEqual(ms.map((m) => m.size), [3, 4, 5], 'all three ladder rungs offered');
  const three = ms[0];
  assert.ok(Math.abs(three.prob - 0.75 * 0.72 * 0.7) < 0.002, 'joint prob = product');
  assert.ok(Math.abs(three.price - 1.4 * 1.45 * 1.5) < 0.01, 'combined price = product');
  assert.ok(three.edge > 0.1, 'edges compound (each leg ~+5% -> joint >10%)');
  assert.ok(ms[2].prob >= JOINT_FLOORS[5], '5-leg clears its floor');
  assert.ok(ms.every((m) => m.prob * m.price - 1 <= 0.5), 'every rung respects the joint 50% cap');
  // ladder labels: exactly one best-value rung and one most-likely rung
  assert.equal(ms.filter((m) => m.bestValue).length, 1, 'one statistically-best rung');
  assert.equal(ms.filter((m) => m.mostLikely).length, 1, 'one most-likely rung');
  assert.ok(ms.find((m) => m.mostLikely).size === 3, 'fewest legs = highest joint probability');
  const maxEdge = Math.max(...ms.map((m) => m.edge));
  assert.equal(ms.find((m) => m.bestValue).edge, maxEdge, 'best-value = highest joint edge');
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

test('Aug post-mortem rules: steam legs excluded, joint-edge cap, no re-parlay while legs live', () => {
  // steam-cause legs never parlay
  const steamy = sportsWith(
    [bet('n1', 'nrl', 'A', 0.75, 1.5), bet('n2', 'nrl', 'B', 0.72, 1.55, 'pending', { edgeCause: 'steam' })],
    [bet('a1', 'afl', 'C', 0.7, 1.6)],
  );
  const legs = candidateLegs(steamy, NOW);
  assert.ok(!legs.some((l) => l.team === 'B'), 'steam leg excluded from the pool');
  assert.equal(legs.length, 2, 'only clean signals remain -> under 3 legs, no ladder');
  // soccer kinds: win-or-draw legs parlay, draw legs never do
  const soccer = { eflc: { book: { bets: [
    bet('e1', 'eflc', 'Charlton', 0.68, 1.7, 'pending', { kind: 'dc' }),
    bet('e2', 'eflc', 'Burnley', 0.3, 3.6, 'pending', { kind: 'draw' }),
    bet('e3', 'eflc', 'Millwall', 0.5, 2.1, 'pending', { kind: 'win' }),
  ] }, history: [] } };
  assert.deepEqual(candidateLegs(soccer, NOW).map((l) => l.team), ['Charlton', 'Millwall'], 'dc in, draw out');
  // joint too-good-to-be-true cap: legs that compound past +50% joint edge are not offered
  const juiced = ['A', 'B', 'C'].map((t, i) => bet('j' + i, 'nrl', t, 0.7, 2.4)); // each leg edge +68%... blocked upstream, use realistic: prob .7 @1.9 = +33% per leg
  const juiced2 = ['A', 'B', 'C'].map((t, i) => bet('k' + i, 'nrl', t, 0.7, 1.9));
  const msJ = generateMultis(candidateLegs({ nrl: { book: { bets: juiced2 }, history: [] } }, NOW), NOW);
  assert.ok(!msJ.length || msJ.every((m) => m.prob * m.price - 1 <= 0.5), 'no rung ships with a joint edge over 50%');
  // the re-bet bug: multis all lost early, but a leg still pending -> ladder NOT archived, no regeneration
  const b1 = bet('n1', 'nrl', 'A', 0.75, 1.5);
  const b2 = bet('a1', 'afl', 'B', 0.7, 1.6);
  const b3 = bet('a2', 'afl', 'C', 0.7, 1.6);
  const w1 = rollMultis(null, sportsWith([b1], [b2, b3]), NOW);
  assert.ok(w1.current, 'ladder generated');
  const oneLostRestPending = sportsWith([{ ...b1, status: 'lost' }], [b2, b3]); // multis all lost, legs B/C still live
  const w2 = rollMultis(w1, oneLostRestPending, NOW + 3600e3);
  assert.ok(w2.current, 'ladder stays open while its legs are live — NOT archived');
  assert.equal(w2.current.generatedAt, w1.current.generatedAt, 'and no new ladder re-parlays the same legs');
  assert.ok(w2.current.multis.every((m) => m.status === 'lost'), 'the multis themselves are honestly marked lost');
});

test('deadlock fix: a lost multi keeps refreshing its legs so the ladder can archive', () => {
  const b1 = bet('n1', 'nrl', 'A', 0.75, 1.5);
  const b2 = bet('a1', 'afl', 'B', 0.7, 1.6);
  const b3 = bet('a2', 'afl', 'C', 0.7, 1.6);
  const w1 = rollMultis(null, sportsWith([b1], [b2, b3]), NOW);
  // one leg loses early -> multis lost, other legs still pending -> stays open
  const early = rollMultis(w1, sportsWith([b1], [{ ...b2, status: 'lost' }, b3]), NOW + 1e6);
  assert.ok(early.current, 'ladder open while legs pending');
  assert.ok(early.current.multis.every((m) => m.status === 'lost'));
  // remaining legs settle LATER: legs must refresh inside the lost multis...
  const later = rollMultis(early, sportsWith([{ ...b1, status: 'won' }], [{ ...b2, status: 'lost' }, { ...b3, status: 'won' }]), NOW + 2e6);
  // ...which finally lets the ladder archive (and a new one could generate)
  assert.equal(later.current, null, 'all legs settled -> ladder archived at last');
  assert.equal(later.history.length, 1);
  const archived = later.history[0].multis[0];
  assert.ok(archived.legs.every((l) => l.status !== 'pending'), 'no leg left frozen as pending');
  assert.equal(archived.status, 'lost', 'the settled multi status stands');
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
