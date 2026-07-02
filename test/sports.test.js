import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPORTS, updateElo, bootstrapElo, sportMatchProb, nextRound, fixtureOdds,
  generateSportBook, settleSportBets, sportNeedsOdds, rollSport, sameTeam,
  formString, lastMeeting, avgAgainst, betComment, diagnoseEdge, lineupDelta,
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

test('sportNeedsOdds: only locks inside 3 days of an un-booked round (after team lists)', () => {
  const rows = [row(2, 18, '2026-07-04 05:00:00Z', 'A', 'B')];
  assert.equal(sportNeedsOdds({}, rows, NOW), true, 'round within 3 days, no book');
  assert.equal(sportNeedsOdds({ book: { round: 18, bets: [] } }, rows, NOW), false, 'book already locked');
  const fiveOut = [row(2, 18, '2026-07-08 05:00:00Z', 'A', 'B')];
  assert.equal(sportNeedsOdds({}, fiveOut, NOW), false, '5 days out: team lists not named yet');
  const farRows = [row(3, 19, '2026-07-20 05:00:00Z', 'A', 'B')];
  assert.equal(sportNeedsOdds({}, farRows, NOW), false, 'round too far out');
});

test('rep window (Origin): edge bar doubles to 6%, surviving calls carry a warning', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  // even ratings at home -> prob 0.563; $1.84 -> a 3.6% edge (clears the normal 3% bar)
  const even = { elo: { Storm: 1500, Roosters: 1500 }, eloGames: 120, history: [] };
  const oddsAt = (t) => [{
    home_team: 'Melbourne Storm', away_team: 'Sydney Roosters', commence_time: t,
    bookmakers: [{ markets: [{ key: 'h2h', outcomes: [
      { name: 'Melbourne Storm', price: 1.84 }, { name: 'Sydney Roosters', price: 2.0 },
    ] }] }],
  }];
  const inside = generateSportBook(even, nrl,
    [row(2, 18, '2026-07-04 05:00:00Z', 'Storm', 'Roosters')], oddsAt('2026-07-04T05:00:00Z'), NOW);
  assert.equal(inside.bets.length, 0, 'a thin 3.6% edge is rejected during Origin');
  const outside = generateSportBook(even, nrl,
    [row(2, 18, '2026-07-14 05:00:00Z', 'Storm', 'Roosters')], oddsAt('2026-07-14T05:00:00Z'), NOW);
  assert.equal(outside.bets.length, 1, 'the same edge is fine once Origin is over');
  assert.equal(outside.bets[0].warning, undefined, 'no warning outside the window');
  // a big edge inside the window still gets through, but flagged
  const strong = { elo: { Storm: 1650, Roosters: 1450 }, eloGames: 120, history: [] };
  const flagged = generateSportBook(strong, nrl,
    [row(2, 18, '2026-07-04 05:00:00Z', 'Storm', 'Roosters')], ODDS, NOW);
  assert.ok(/State of Origin/.test(flagged.bets[0].warning), 'Origin-window calls carry the warning');
  assert.equal(flagged.bets[0].edgeCause, 'lineup', 'rep-window bets are tagged lineup');
});

test('diagnoseEdge: classifies each way a price can differ from the model', () => {
  // clean disagreement: mid-price, mature ratings, no rep/lineup/steam
  assert.equal(diagnoseEdge({ edge: 0.06, price: 2.0, oppPrice: 2.0, eloGames: 200, teams: 16 }).cause, 'model-signal');
  // a longshot needs a huge edge; a modest one is a shading artefact
  assert.equal(diagnoseEdge({ edge: 0.08, price: 4.5, oppPrice: 1.25, eloGames: 200, teams: 16 }).cause, 'longshot-bias');
  // green ratings early in the season
  assert.equal(diagnoseEdge({ edge: 0.06, price: 2.0, oppPrice: 2.0, eloGames: 10, teams: 16 }).cause, 'stale-elo');
  // edge thinner than half a wide book's margin (overround ~11%, half ~5.6%)
  const vig = diagnoseEdge({ edge: 0.04, price: 1.8, oppPrice: 1.8, eloGames: 200, teams: 16 });
  assert.equal(vig.cause, 'vig-artifact');
  // sharp money moved the price against us since it opened
  assert.equal(diagnoseEdge({ edge: 0.06, price: 2.2, oppPrice: 1.9, openingPrice: 2.0, eloGames: 200, teams: 16 }).cause, 'steam');
  // rep window (coarse lineup proxy)
  assert.equal(diagnoseEdge({ edge: 0.2, price: 1.6, oppPrice: 2.4, eloGames: 200, teams: 16, rep: { note: 'State of Origin period' } }).cause, 'lineup');
});

test('diagnoseEdge + lineupDelta: precise named-lineup value blocks a depleted side', () => {
  const lineups = {
    Storm: { totalValue: 10000, outValue: 2500 },   // Storm gutted (25% out)
    Roosters: { totalValue: 10000, outValue: 200 },
  };
  const d = lineupDelta(lineups, 'Storm', 'Roosters');
  assert.deepEqual(d, { teamValue: 10000, teamOutValue: 2500, oppValue: 10000, oppOutValue: 200 });
  // backing depleted Storm: the market knows something we don't -> never bet
  const blocked = diagnoseEdge({ edge: 0.2, price: 1.6, oppPrice: 2.4, lineup: d, eloGames: 200, teams: 16 });
  assert.equal(blocked.cause, 'lineup-blocked');
  assert.equal(blocked.bar, Infinity);
  // backing the healthy Roosters against a gutted Storm: flagged but bettable
  const dOpp = lineupDelta(lineups, 'Roosters', 'Storm');
  const flagged = diagnoseEdge({ edge: 0.2, price: 2.4, oppPrice: 1.6, lineup: dOpp, eloGames: 200, teams: 16 });
  assert.equal(flagged.cause, 'lineup');
  assert.ok(flagged.bar < Infinity);
});

test('generateSportBook: tags each bet with its edgeCause and reports diagnostics', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  const state = { elo: { Storm: 1650, Roosters: 1450 }, eloGames: 200, history: [] };
  // out of the Origin window so we exercise the clean-signal path
  const rows = [row(2, 22, '2026-08-15 05:00:00Z', 'Storm', 'Roosters')];
  const odds = [{
    home_team: 'Melbourne Storm', away_team: 'Sydney Roosters', commence_time: '2026-08-15T05:00:00Z',
    bookmakers: [{ markets: [{ key: 'h2h', outcomes: [
      { name: 'Melbourne Storm', price: 1.6 }, { name: 'Sydney Roosters', price: 2.4 },
    ] }] }],
  }];
  const book = generateSportBook(state, nrl, rows, odds, Date.parse('2026-08-13T00:00:00Z'));
  assert.equal(book.bets.length, 1);
  assert.equal(book.bets[0].edgeCause, 'model-signal');
  assert.ok(book.bets[0].causeNote.length > 0, 'carries a plain-English reason');
  assert.equal(book.diagnostics.byCause['model-signal'], 1, 'diagnostics tally the accepted cause');
});

test('generateSportBook: slate lists every game with model vs market, value flagged', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  const state = { elo: { Storm: 1650, Roosters: 1450, Panthers: 1500, Broncos: 1500 }, eloGames: 200, history: [] };
  const rows = [
    row(1, 22, '2026-08-15 05:00:00Z', 'Storm', 'Roosters'),
    row(2, 22, '2026-08-16 05:00:00Z', 'Panthers', 'Broncos'),
  ];
  const odds = [
    { home_team: 'Melbourne Storm', away_team: 'Sydney Roosters', commence_time: '2026-08-15T05:00:00Z',
      bookmakers: [{ markets: [{ key: 'h2h', outcomes: [{ name: 'Melbourne Storm', price: 1.6 }, { name: 'Sydney Roosters', price: 2.4 }] }] }] },
    { home_team: 'Penrith Panthers', away_team: 'Brisbane Broncos', commence_time: '2026-08-16T05:00:00Z',
      bookmakers: [{ markets: [{ key: 'h2h', outcomes: [{ name: 'Penrith Panthers', price: 1.7 }, { name: 'Brisbane Broncos', price: 2.1 }] }] }] },
  ];
  const book = generateSportBook(state, nrl, rows, odds, Date.parse('2026-08-13T00:00:00Z'));
  assert.equal(book.slate.length, 2, 'every game appears on the slate');
  assert.ok(book.slate.every((g) => typeof g.homeProb === 'number' && typeof g.awayProb === 'number'), 'model prob on every game');
  const storm = book.slate.find((g) => g.home === 'Storm');
  const pens = book.slate.find((g) => g.home === 'Panthers');
  assert.ok(storm.marketProb > 0 && storm.marketProb < 1, 'de-vigged market prob present');
  assert.ok(storm.homeProb > storm.marketProb, 'model rates the underpriced favourite above the market');
  assert.ok(storm.value && storm.picked, 'the value game is flagged AND picked into the book');
  assert.ok(!pens.value && !pens.picked, 'the fairly-priced game is neither value nor picked');
});

test('generateSportBook: steam against us needs the doubled bar (via openingOdds)', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  const state = { elo: { Storm: 1510, Roosters: 1490 }, eloGames: 200, history: [] };
  const rows = [row(2, 22, '2026-08-15 05:00:00Z', 'Storm', 'Roosters')];
  const ev = (hp, ap) => [{
    home_team: 'Melbourne Storm', away_team: 'Sydney Roosters', commence_time: '2026-08-15T05:00:00Z',
    bookmakers: [{ markets: [{ key: 'h2h', outcomes: [
      { name: 'Melbourne Storm', price: hp }, { name: 'Sydney Roosters', price: ap },
    ] }] }],
  }];
  // Storm drifted 1.62 -> 1.76 since open: money came for Roosters. A ~4% edge
  // that would pass normally is now held to the 6% steam bar and rejected.
  const now = Date.parse('2026-08-13T00:00:00Z');
  const book = generateSportBook(state, nrl, rows, ev(1.76, 2.30), now, { openingOdds: ev(1.62, 2.55) });
  const stormBet = book.bets.find((b) => b.team === 'Storm');
  assert.ok(!stormBet, 'steamed-against Storm edge is rejected');
  assert.ok(book.diagnostics.rejectedByCause.steam >= 1, 'the rejection is logged as steam');
});

test('comment ingredients: form, last meeting, defence average', () => {
  const rows = [
    row(1, 1, '2026-06-01 05:00:00Z', 'Storm', 'Roosters', 30, 10),
    row(2, 2, '2026-06-08 05:00:00Z', 'Roosters', 'Storm', 12, 20),
    row(3, 3, '2026-06-15 05:00:00Z', 'Storm', 'Broncos', 14, 14),
  ];
  assert.equal(formString(rows, 'Storm'), 'WWD');
  assert.equal(formString(rows, 'Roosters'), 'LL');
  const met = lastMeeting(rows, 'Storm', 'Roosters');
  assert.equal(met.winner, 'Storm');
  assert.equal(met.margin, 8);
  assert.equal(met.round, 2);
  assert.equal(avgAgainst(rows, 'Storm'), Math.round(((10 + 12 + 14) / 3) * 10) / 10);
});

test('betComment: <=50 words, cites model vs market and the edge, honest on bold calls', () => {
  const rows = [
    row(1, 1, '2026-06-01 05:00:00Z', 'Storm', 'Roosters', 30, 10),
    row(2, 2, '2026-06-08 05:00:00Z', 'Panthers', 'Storm', 22, 8),
  ];
  const state = { elo: { Storm: 1650, Roosters: 1450, Panthers: 1700 }, eloGames: 120 };
  const cfg = SPORTS.find((s) => s.key === 'nrl');
  const cases = [
    { team: 'Storm', opp: 'Roosters', home: true, prob: 0.75, price: 1.54, edge: 0.155 },  // favourite
    { team: 'Storm', opp: 'Panthers', home: false, prob: 0.47, price: 2.95, edge: 0.39 },  // bold + lost h2h
    { team: 'Roosters', opp: 'Storm', home: false, prob: 0.5, price: 2.1, edge: 0.05 },    // value
  ];
  cases.forEach((c) => {
    const txt = betComment(cfg, state, rows, c);
    const words = txt.trim().split(/\s+/).length;
    assert.ok(words <= 50, `comment is ${words} words: ${txt}`);
    assert.ok(txt.includes(`${Math.round(c.prob * 100)}%`), 'cites the model probability');
    assert.ok(txt.includes(`${Math.round(100 / c.price)}%`), 'cites the market-implied probability');
    assert.ok(txt.includes(`${Math.round(c.edge * 100)}% edge`), 'cites the edge');
  });
  const bold = betComment(cfg, state, rows, cases[1]);
  assert.ok(/boldest call/.test(bold), 'big-edge calls get the bold framing');
  assert.ok(/losing the Round 2 meeting by 14/.test(bold), 'honest about the lost head-to-head');
  const gen = generateSportBook(state, cfg, [row(9, 18, '2026-07-04 05:00:00Z', 'Storm', 'Roosters')], ODDS, NOW);
  assert.ok(gen.bets[0].comment.split(/\s+/).length <= 50, 'generated books use the new comments');
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