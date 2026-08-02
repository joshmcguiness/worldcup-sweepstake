import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPORTS, updateElo, bootstrapElo, sportMatchProb, nextRound, fixtureOdds,
  generateSportBook, settleSportBets, sportNeedsOdds, rollSport, sameTeam,
  formString, lastMeeting, avgAgainst, betComment, diagnoseEdge, lineupDelta,
  priceForTeam, sportNeedsClosingOdds, updateSportClosingOdds, betClv,
  roundPredictions, betStake, codeStakeFactor, sportNeedsEarlyOdds,
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

test('updateElo margin mode: a bigger win moves ratings more; draws use plain K', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl'); // has marginElo config
  const blowout = updateElo({ elo: {}, rated: [], eloGames: 0 }, [row(1, 1, '2026-03-01 05:00:00Z', 'A', 'B', 40, 0)], nrl);
  const narrow = updateElo({ elo: {}, rated: [], eloGames: 0 }, [row(1, 1, '2026-03-01 05:00:00Z', 'A', 'B', 13, 12)], nrl);
  assert.ok(blowout.elo.A > narrow.elo.A, 'a 40-0 win lifts A more than a 13-12 win');
  assert.ok(narrow.elo.A > 1500, 'even a narrow win still lifts the winner');
  // a draw carries no margin, so it must fall back to the plain K (no NaN/zero-out)
  const drawn = updateElo({ elo: {}, rated: [], eloGames: 0 }, [row(1, 1, '2026-03-01 05:00:00Z', 'C', 'D', 20, 20)], nrl);
  assert.ok(drawn.elo.C < 1500 && drawn.elo.D > 1500, 'home draw at equal ratings costs the home side, via plain K');
  assert.ok(Number.isFinite(drawn.elo.C), 'no NaN on a draw');
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
  // an established, CLV-positive record so the V4 trust loop stays out of the way
  const record = [{ bets: Array.from({ length: 6 }, (_, i) => ({ status: 'won', price: 1.6, closePrice: 1.5, team: 'X' + i })) }];
  // even ratings at home -> prob 0.563; $1.84 -> a 3.6% edge (clears the normal 3% bar)
  const even = { elo: { Storm: 1500, Roosters: 1500 }, eloGames: 120, history: record };
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
  const strong = { elo: { Storm: 1650, Roosters: 1450 }, eloGames: 120, history: record };
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
  // "too good to be true": a 60% edge is our model erring — never bet (backtest: 50%+ edges ~−18% ROI)
  const imp = diagnoseEdge({ edge: 0.6, price: 2.2, oppPrice: 1.8, eloGames: 200, teams: 16 });
  assert.equal(imp.cause, 'implausible');
  assert.equal(imp.bar, Infinity);
  // ...and it takes precedence even inside a rep window
  assert.equal(diagnoseEdge({ edge: 0.7, price: 2.4, oppPrice: 1.6, eloGames: 200, teams: 16, rep: { note: 'Origin' } }).cause, 'implausible');
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

test('roundPredictions: a winner + confidence for EVERY game in the next round', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  const state = { elo: { Storm: 1650, Roosters: 1450, Panthers: 1500, Broncos: 1500 } };
  const rows = [
    row(1, 22, '2026-08-15 05:00:00Z', 'Storm', 'Roosters'),
    row(2, 22, '2026-08-16 05:00:00Z', 'Panthers', 'Broncos'),
  ];
  const preds = roundPredictions(state, nrl, nextRound(rows, Date.parse('2026-08-13T00:00:00Z')));
  assert.equal(preds.length, 2, 'one prediction per game');
  const storm = preds.find((p) => p.home === 'Storm');
  assert.equal(storm.winner, 'Storm', 'the stronger side is the predicted winner');
  assert.ok(storm.confidence >= 50 && storm.confidence <= 100, 'confidence is the winner\'s %');
  assert.ok(preds.every((p) => p.no && p.winner && p.confidence), 'every game has no/winner/confidence for cross-ref');
  assert.equal(roundPredictions(state, nrl, null).length, 0, 'no round -> empty');
});

test('CLV: bank closing price near kickoff, compute value vs the close', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  const ev = [{
    home_team: 'Melbourne Storm', away_team: 'Sydney Roosters', commence_time: '2026-08-15T05:00:00Z',
    bookmakers: [
      { markets: [{ key: 'h2h', outcomes: [{ name: 'Melbourne Storm', price: 1.5 }, { name: 'Sydney Roosters', price: 2.5 }] }] },
      { markets: [{ key: 'h2h', outcomes: [{ name: 'Melbourne Storm', price: 1.52 }, { name: 'Sydney Roosters', price: 2.6 }] }] },
    ],
  }];
  assert.equal(priceForTeam(ev, 'Storm', 'Roosters', nrl.aliases), 1.51, 'averages the books for the selection');
  assert.equal(priceForTeam(ev, 'Broncos', 'Eels', nrl.aliases), null, 'no such fixture -> null');

  const kickoff = '2026-08-15T05:00:00.000Z';
  const near = Date.parse('2026-08-15T00:00:00Z'); // 5h before kickoff
  const far = Date.parse('2026-08-10T00:00:00Z');  // days out
  assert.equal(sportNeedsClosingOdds({ book: { bets: [{ status: 'pending', kickoff }] } }, near), true, 'within 12h -> fetch close');
  assert.equal(sportNeedsClosingOdds({ book: { bets: [{ status: 'pending', kickoff }] } }, far), false, 'days out -> not yet');
  assert.equal(sportNeedsClosingOdds({ book: { bets: [{ status: 'won', kickoff }] } }, near), false, 'settled bets never need a close');

  // we locked Storm at 1.60; the market closed at 1.51 -> we beat the close
  const bets = [{ status: 'pending', team: 'Storm', opp: 'Roosters', kickoff, price: 1.6 }];
  const banked = updateSportClosingOdds(bets, ev, nrl, near);
  assert.equal(banked[0].closePrice, 1.51, 'banks the near-kickoff price');
  assert.equal(betClv(banked[0]), 0.06, 'positive CLV (1.60 vs 1.51 close), rounded to 3dp');
  // once kicked off, the last close is frozen (not overwritten)
  const after = updateSportClosingOdds(banked, [], nrl, Date.parse('2026-08-15T06:00:00Z'));
  assert.equal(after[0].closePrice, 1.51, 'closing price frozen after kickoff');
  assert.equal(betClv({ price: 1.6 }), null, 'no close banked -> null CLV');
});

test('EFL Championship config: wired like the other soccer code, V4-ready', () => {
  const eflc = SPORTS.find((s) => s.key === 'eflc');
  assert.ok(eflc, 'eflc exists in SPORTS');
  assert.equal(eflc.feed, 'championship-2026');
  assert.equal(eflc.priorFeed, 'championship-2025');
  assert.equal(eflc.oddsKey, 'soccer_efl_champ');
  assert.ok(Math.abs(eflc.drawRate - 0.26) < 0.01, 'measured 26.4% draw rate from the 2025-26 feed');
  assert.equal(eflc.marginElo, undefined, 'margin Elo only validated for AFL/NRL — soccer stays binary');
  // V4 cold start applies from the first book: no settled record -> half stakes
  assert.equal(codeStakeFactor({ history: [] }).factor, 0.5);
  // full team names in the feed match API names via the normalised matcher
  assert.ok(sameTeam('Queens Park Rangers', 'Queens Park Rangers', eflc.aliases));
  assert.ok(sameTeam('West Bromwich Albion', 'West Bromwich Albion', eflc.aliases));
  assert.ok(sameTeam('QPR', 'Queens Park Rangers', eflc.aliases), 'alias covers the short form');
});

test('V4 betStake: conviction tiers by edge', () => {
  assert.equal(betStake(0.04), 50, 'thin 3-5% edge -> half conviction');
  assert.equal(betStake(0.05), 100, 'sweet spot lower bound');
  assert.equal(betStake(0.19), 100, 'sweet spot upper bound');
  assert.equal(betStake(0.25), 50, 'suspect 20-50% band -> half conviction');
});

test('V4 codeStakeFactor: cold start and the rolling CLV gate', () => {
  assert.equal(codeStakeFactor({}).factor, 0.5, 'no record -> cold start half stakes');
  const mk = (clvs) => ({ history: [{ bets: clvs.map((c, i) => ({ status: 'won', price: 1.6, closePrice: 1.6 / (1 + c), team: 'T' + i })) }] });
  assert.equal(codeStakeFactor(mk([0.02, 0.03, 0.01, 0.02, 0.04])).factor, 1, 'positive rolling CLV -> full stakes');
  const gated = codeStakeFactor(mk([-0.03, -0.02, -0.04, -0.01, -0.05]));
  assert.equal(gated.factor, 0.5, 'negative rolling CLV -> stakes halve');
  assert.ok(/CLV/.test(gated.reason), 'carries the reason');
  // fewer than 5 CLV readings: not enough evidence to gate an established code
  assert.equal(codeStakeFactor(mk([-0.05, -0.05])).factor, 1, 'gate needs >=5 CLV readings');
});

test('V4 generateSportBook: stakes tiered, suspect band warned, trust factor applied', () => {
  const nrl = SPORTS.find((s) => s.key === 'nrl');
  const now = Date.parse('2026-08-13T00:00:00Z');
  const rows = [
    row(1, 22, '2026-08-15 05:00:00Z', 'Storm', 'Roosters'),
    row(2, 22, '2026-08-16 05:00:00Z', 'Panthers', 'Broncos'),
  ];
  const ev = (h, hn, hp, a, an, ap, t) => ({ home_team: hn, away_team: an, commence_time: t,
    bookmakers: [{ markets: [{ key: 'h2h', outcomes: [{ name: hn, price: hp }, { name: an, price: ap }] }] }] });
  const odds = [
    ev(1, 'Melbourne Storm', 1.6, 2, 'Sydney Roosters', 2.4, '2026-08-15T05:00:00Z'),   // Storm edge ~28% -> suspect band
    ev(2, 'Penrith Panthers', 1.7, 3, 'Brisbane Broncos', 2.1, '2026-08-16T05:00:00Z'), // Panthers edge ~10% -> sweet spot
  ];
  // established, CLV-positive record -> full trust
  const good = { elo: { Storm: 1650, Roosters: 1450, Panthers: 1560, Broncos: 1500 }, eloGames: 200,
    history: [{ bets: Array.from({ length: 6 }, (_, i) => ({ status: 'won', price: 1.6, closePrice: 1.5, team: 'X' + i })) }] };
  const book = generateSportBook(good, nrl, rows, odds, now);
  const storm = book.bets.find((b) => b.team === 'Storm');
  const pens = book.bets.find((b) => b.team === 'Panthers');
  assert.equal(storm.stake, 50, '28% edge -> suspect-band half stake');
  assert.ok(/20–50% band/.test(storm.warning), 'suspect band carries a warning');
  assert.equal(pens.stake, 100, '10% edge -> full sweet-spot stake');
  assert.equal(pens.warning, undefined, 'clean sweet-spot bet carries no warning');
  // cold-start code: everything halves again
  const cold = { elo: good.elo, eloGames: 200, history: [] };
  const cbook = generateSportBook(cold, nrl, rows, odds, now);
  assert.equal(cbook.bets.find((b) => b.team === 'Panthers').stake, 50, 'cold start halves the sweet-spot stake');
  assert.ok(/cold start/.test(cbook.bets.find((b) => b.team === 'Panthers').warning), 'cold start warns');
});

test('V4 sportNeedsEarlyOdds: fires once, 3-6 days out, before the book exists', () => {
  const rows = [row(2, 18, '2026-07-08 05:00:00Z', 'A', 'B')]; // 5 days out from NOW (3 Jul)
  assert.equal(sportNeedsEarlyOdds({}, rows, NOW), true, '5 days out, no snapshot -> fetch');
  assert.equal(sportNeedsEarlyOdds({ earlyOdds: { round: 18 } }, rows, NOW), false, 'already banked this round');
  assert.equal(sportNeedsEarlyOdds({ book: { round: 18 } }, rows, NOW), false, 'book already locked');
  const near = [row(2, 18, '2026-07-04 05:00:00Z', 'A', 'B')];
  assert.equal(sportNeedsEarlyOdds({}, near, NOW), false, 'inside 3 days: the lock fetch handles it');
  const far = [row(2, 18, '2026-07-12 05:00:00Z', 'A', 'B')];
  assert.equal(sportNeedsEarlyOdds({}, far, NOW), false, 'beyond 6 days: too early to mean anything');
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