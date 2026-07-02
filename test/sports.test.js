import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPORTS, updateElo, bootstrapElo, sportMatchProb, nextRound, fixtureOdds,
  generateSportBook, settleSportBets, sportNeedsOdds, rollSport, sameTeam,
} from '../public/lib/sports.js';

const AFL = SPORTS.find((s) => s.key === 'afl');
const EPL = SPORTS.find((s) => s.key === 'epl');
const NOW = Date.parse('2026-07-03T00:00:00Z');

const row = (no, round, d, h, a, hs = null, as = null, winner = '') => ({
  MatchNumber: no, RoundNumber: round, DateUtc: d, Location: 'X',
  HomeTeam: h, AwayTeam: a, HomeTeamScore: hs, AwayTeamScore: as, Winner: winner,
});

test('sameTeam: feed short names match API full names, aliases work', () => {
  assert.ok(sameTeam('Storm', 'Melbourne Storm', {}));
  assert.ok(sameTeam('GWS GIANTS', 'Greater Western Sydney Giants', AFL.aliases));
  assert.ok(sameTeam('Man Utd', 'Manchester United', EPL.aliases));
  assert.ok(!sameTeam('Storm', 'Sydney Roosters', {}));
});

test('updateElo: winners gain, losers lose, draws split, results rated once', () => {
  const rows = [row(1, 1, '2026-06-01 05:00:00Z', 'A', 'B', 100, 60)];
  let s = updateElo({ elo: {}, rated: [], eloGames: 0 }, rows, AFL);
  assert.ok(s.elo.A > 1500 && s.elo.B < 1500);
  assert.equal(s.eloGames, 1);
  const again = updateElo(s, rows, AFL);
  assert.equal(again.eloGames, 1, 'same result never rated twice');
  const drawn = updateElo(s, [row(2, 1, '2026-06-02 05:00:00Z', 'C', 'D', 70, 70)], AFL);
  // home side expected to win at equal ratings, so a draw costs the home team
  assert.ok(drawn.elo.C < 1500 && drawn.elo.D > 1500);
});

test('bootstrapElo: prior-season ratings regress 25% to the mean, rated set resets', () => {
  const prior = [row(1, 1, '2025-06-01 05:00:00Z', 'A', 'B', 100, 60)];
  const full = updateElo({ elo: {}, rated: [], eloGames: 0 }, prior, AFL);
  const boot = bootstrapElo(prior, AFL);
  assert.ok(Math.abs((boot.elo.A - 1500) - 0.75 * (full.elo.A - 1500)) < 0.2);
  assert.equal(boot.rated.length, 0);
});

test('sportMatchProb: stronger team favoured, home advantage counts, EPL draws priced in', () => {
  const s = { elo: { A: 1600, B: 1500 } };
  assert.ok(sportMatchProb(s, AFL, 'A', 'B', true) > 0.6);
  const homeP = sportMatchProb({ elo: {} }, AFL, 'X', 'Y', true);
  assert.ok(homeP > 0.5, 'even teams: home side favoured');
  assert.ok(sportMatchProb(s, EPL, 'A', 'B', true) < sportMatchProb(s, AFL, 'A', 'B', true),
    'EPL outright prob shrunk by the ~25% draw rate');
});

test('nextRound: earliest round with unplayed future games', () => {
  const rows = [
    row(1, 17, '2026-07-01 05:00:00Z', 'A', 'B', 80, 70),
    row(2, 18, '2026-07-04 05:00:00Z', 'C', 'D'),
    row(3, 19, '2026-07-11 05:00:00Z', 'E', 'F'),
  ];
  const nr = nextRound(rows, NOW);
  assert.equal(nr.round, 18);
  assert.equal(nr.matches.length, 1);
  assert.equal(nextRound([rows[0]], NOW), null, 'season over -> null');
});

const ODDS = [{
  home_team: 'Melbourne Storm', away_team: 'Sydney Roosters',
  commence_time: '2026-07-04T05:00:00Z',
  bookmakers: [{ markets: [{ key: 'h2h', outcomes: [
    { name: 'Melbourne Storm', price: 1.6 }, { name: 'Sydney Roosters', price: 2.4 },
  ] }] }],
}];

test('fixtureOdds: maps feed short names to API prices', () => {
  const m = row(2, 18, '2026-07-04 05:00:00Z', 'Storm', 'Roosters');
  const prices = fixtureOdds(m, ODDS, {});
  assert.deepEqual(prices, { home: 1.6, away: 2.4 });
});

test('generateSportBook: v2 gates — positive edge only, price floor, one per match, max 5', () => {
  const state = { elo: { Storm: 1650, Roosters: 1450 }, eloGames: 120, history: [] };
  const rows = [row(2, 18, '2026-07-04 05:00:00Z', 'Storm', 'Roosters')];
  const book = generateSportBook(state, SPORTS.find((s) => s.key === 'nrl'), rows, ODDS, NOW);
  assert.equal(book.round, 18);
  assert.equal(book.bets.length, 1, 'one bet per match');
  const b = book.bets[0];
  assert.equal(b.team, 'Storm');
  assert.ok(b.edge >= 0.03 && b.price >= 1.2 && b.prob >= 0.45);
  assert.equal(b.payoutOdds, b.price, 'paid at the real market price');
  // near-even ratings with tight prices: NEITHER side clears the edge floor
  const even = { elo: { Storm: 1500, Roosters: 1500 }, eloGames: 120, history: [] };
  const tightOdds = [{
    ...ODDS[0],
    bookmakers: [{ markets: [{ key: 'h2h', outcomes: [
      { name: 'Melbourne Storm', price: 1.55 }, { name: 'Sydney Roosters', price: 2.2 },
    ] }] }],
  }];
  const empty = generateSportBook(even, SPORTS.find((s) => s.key === 'nrl'), rows, tightOdds, NOW);
  assert.equal(empty.bets.length, 0, 'no positive edge -> honest empty book');
});

test('generateSportBook: never bets a team that already has an open position', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  const state = {
    elo: { Storm: 1650, Roosters: 1450 }, eloGames: 120,
    history: [{ round: 17, bets: [{ status: 'pending', team: 'Storm', opp: 'Broncos', no: 99 }] }],
  };
  const rows = [row(2, 18, '2026-07-04 05:00:00Z', 'Storm', 'Roosters')];
  const book = generateSportBook(state, nrl, rows, ODDS, NOW);
  assert.equal(book.bets.length, 0, 'open Storm position blocks a new Storm call');
});

test('settleSportBets: win pays, draw loses, golden-point Winner honoured', () => {
  const bets = [
    { status: 'pending', no: 1, team: 'A' },
    { status: 'pending', no: 2, team: 'C' },
    { status: 'pending', no: 3, team: 'E' },
    { status: 'pending', no: 4, team: 'G' },
  ];
  const rows = [
    row(1, 1, '2026-07-01 05:00:00Z', 'A', 'B', 80, 70),        // A won
    row(2, 1, '2026-07-01 05:00:00Z', 'C', 'D', 70, 70),        // draw -> lost
    row(3, 1, '2026-07-01 05:00:00Z', 'E', 'F', 20, 20, 'E'),   // golden point, E named
    row(4, 1, '2026-07-01 05:00:00Z', 'G', 'H'),                // unplayed
  ];
  const out = settleSportBets(bets, rows);
  assert.deepEqual(out.map((b) => b.status), ['won', 'lost', 'won', 'pending']);
});

test('sportNeedsOdds: only inside the week of an un-booked round', () => {
  const rows = [row(2, 18, '2026-07-04 05:00:00Z', 'A', 'B')];
  assert.equal(sportNeedsOdds({}, rows, NOW), true, 'round within 6 days, no book');
  assert.equal(sportNeedsOdds({ book: { round: 18, bets: [] } }, rows, NOW), false, 'book already locked');
  const farRows = [row(3, 19, '2026-07-20 05:00:00Z', 'A', 'B')];
  assert.equal(sportNeedsOdds({}, farRows, NOW), false, 'round too far out');
});

test('rollSport: rates, settles, archives finished rounds, flags pre-season', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  const rows = [
    row(1, 17, '2026-07-01 05:00:00Z', 'Storm', 'Roosters', 30, 10),
    row(2, 18, '2026-07-04 05:00:00Z', 'Storm', 'Roosters'),
  ];
  // seed established ratings so the round-18 tie clears the edge floor
  const seeded = { elo: { Storm: 1650, Roosters: 1450 }, rated: [], eloGames: 119 };
  const s1 = rollSport(seeded, nrl, rows, ODDS, NOW);
  assert.equal(s1.started, true);
  assert.equal(s1.eloGames, 120);
  assert.ok(s1.book && s1.book.round === 18, 'book generated for the upcoming round');
  // round 18 finishes: bets settle and the book archives to history
  const rows2 = [rows[0], row(2, 18, '2026-07-04 05:00:00Z', 'Storm', 'Roosters', 24, 12)];
  const s2 = rollSport(s1, nrl, rows2, null, NOW + 5 * 86400000);
  assert.equal(s2.book, null, 'finished book archived');
  assert.equal(s2.history.length, 1);
  assert.equal(s2.history[0].bets[0].status, 'won');
  // pre-season: fixtures exist but nothing played and first game far away
  const pre = [row(1, 1, '2026-09-10 00:00:00Z', 'A', 'B')];
  const s3 = rollSport(null, nrl, pre, null, NOW);
  assert.equal(s3.started, false, 'no bets before the season starts');
  assert.equal(s3.book, null);
});