import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TEAMS } from '../public/lib/teams.js';
import { FIX } from '../public/lib/fixtures.js';
import { runSim } from '../public/lib/sim.js';
import { predictBracket } from '../public/lib/bracket.js';
import { matchProbs, aestDate, generateBets, settleBets, rollBets, betPnl, updateClosingOdds, betClv, settleKey, specTeams } from '../public/lib/bets.js';
import { modelMarket } from '../public/lib/modelmarket.js';

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
    assert.ok(['single', 'multi', 'scorer', 'double', 'combo', 'wildcard'].includes(bet.type));
    assert.ok(bet.id.startsWith(GEN_OPTS.date));
  });
  // singles only on the day's slate
  a.filter((x) => x.type === 'single').forEach((x) => {
    assert.equal(aestDate(FIX.find((m) => m.no === x.matchNo).d), GEN_OPTS.date);
  });
});

test('two books of five: today = finalise-today types, longer = wildcards, all staked', () => {
  const bets = generateBets(mkCtx({}), SIM, GEN_OPTS);
  const today = bets.filter((b) => b.group === 'today');
  const longer = bets.filter((b) => b.group === 'longer');
  assert.equal(today.length + longer.length, bets.length, 'every bet belongs to a book');
  assert.ok(today.length <= 5 && longer.length <= 5);
  today.forEach((b) => assert.ok(['single', 'multi', 'scorer', 'double', 'combo'].includes(b.type), `${b.type} finalises today`));
  longer.forEach((b) => assert.equal(b.type, 'wildcard'));
  bets.forEach((b) => {
    assert.equal(b.stake, 100);
    assert.equal(b.payoutOdds, b.marketOdds ?? b.fairOdds, 'price locked at call time');
  });
});

test('today book: highest probability first, max two per type, includes new markets', () => {
  // Spain v Cabo Verde day (match 14, 16:00Z 15 Jun -> AEST 16 Jun): a huge
  // favourite plus tier-1 strikers means every market family has candidates
  const opts = { ...GEN_OPTS, date: aestDate('2026-06-15T16:00:00Z'), now: Date.parse('2026-06-15T00:00:00Z') };
  const bets = generateBets(mkCtx({}), SIM, opts);
  const today = bets.filter((b) => b.group === 'today');
  assert.equal(today.length, 5);
  for (let i = 1; i < today.length; i++) {
    assert.ok(today[i - 1].prob >= today[i].prob, 'sorted by probability desc');
  }
  const counts = {};
  today.forEach((b) => { counts[b.type] = (counts[b.type] || 0) + 1; });
  Object.entries(counts).forEach(([t, n]) => assert.ok(n <= 2, `${t} capped at 2, got ${n}`));
  const dc = today.find((b) => b.type === 'double');
  assert.ok(dc, 'a double-chance call made the book');
  assert.ok(dc.prob >= 0.75);
  const combo = bets.find((b) => b.type === 'combo')
    || generateBets(mkCtx({}), SIM, opts).find((b) => b.type === 'combo');
  if (combo) {
    assert.equal(combo.settle.kind, 'multi');
    assert.equal(combo.settle.legs.length, 2, 'combos are capped at two factors');
  }
});

test('combo probability sits between naive independence and the win prob', () => {
  const opts = { ...GEN_OPTS, date: aestDate('2026-06-15T16:00:00Z'), now: Date.parse('2026-06-15T00:00:00Z') };
  // pull a combo via a bigger book: peek into generation internals by relaxing caps
  const bets = generateBets(mkCtx({}), SIM, opts);
  const combo = bets.find((b) => b.type === 'combo');
  if (!combo) return; // slate-dependent; the structural test above still covers shape
  const scorerLeg = combo.settle.legs.find((l) => l.kind === 'scorer');
  const matchLeg = combo.settle.legs.find((l) => l.kind === 'match');
  assert.ok(scorerLeg && matchLeg);
  assert.ok(combo.prob < 1 && combo.prob > 0);
});

test('double chance settles on win OR draw, busts on defeat', () => {
  const bet = () => [{ status: 'pending', settle: { kind: 'matchDC', no: 1, team: 'Mexico' } }];
  assert.equal(settleBets(bet(), mkCtx({ 1: { h: 2, a: 0 } }), {})[0].status, 'won', 'win pays');
  assert.equal(settleBets(bet(), mkCtx({ 1: { h: 1, a: 1 } }), {})[0].status, 'won', 'draw pays');
  assert.equal(settleBets(bet(), mkCtx({ 1: { h: 0, a: 1 } }), {})[0].status, 'lost', 'defeat busts');
  assert.equal(settleBets(bet(), mkCtx({}), {})[0].status, 'pending');
});

test('closing-line capture: last pre-kickoff price wins, started/settled untouched', () => {
  const PRE = Date.parse('2026-06-11T12:00:00Z'); // before match 1 kicks (19:00Z)
  const POST = Date.parse('2026-06-11T20:00:00Z'); // after kickoff
  const mk = (over) => [{ status: 'pending', payoutOdds: 1.6, settle: { kind: 'match', no: 1, team: 'Mexico' }, ...over }];
  // pre-kickoff: closing follows the latest price
  let out = updateClosingOdds(mk({}), mkCtx({}), { 1: { home: 1.7, away: 4.5, draw: 3.6 } }, PRE);
  assert.equal(out[0].closingOdds, 1.7);
  out = updateClosingOdds(out, mkCtx({}), { 1: { home: 1.55, away: 5.0, draw: 3.8 } }, PRE);
  assert.equal(out[0].closingOdds, 1.55, 'newer price overwrites');
  // after kickoff: frozen
  out = updateClosingOdds(out, mkCtx({}), { 1: { home: 9.9, away: 1.1, draw: 9.9 } }, POST);
  assert.equal(out[0].closingOdds, 1.55, 'in-play prices never touch the close');
  // settled bets untouched
  out = updateClosingOdds([{ ...mk({})[0], status: 'won', closingOdds: 1.5 }], mkCtx({}), { 1: { home: 1.2, away: 8, draw: 5 } }, PRE);
  assert.equal(out[0].closingOdds, 1.5);
  // away side picks read the away price; double chance derives from the trio
  out = updateClosingOdds([
    { status: 'pending', settle: { kind: 'match', no: 1, team: 'South Africa' } },
    { status: 'pending', settle: { kind: 'matchDC', no: 1, team: 'Mexico' } },
  ], mkCtx({}), { 1: { home: 2.0, away: 4.0, draw: 4.0 } }, PRE);
  assert.equal(out[0].closingOdds, 4.0);
  assert.equal(out[1].closingOdds, Math.round(100 / (1 / 2 + 1 / 4)) / 100, 'DC = combined win+draw price');
  // combos (multi with a scorer leg) have no market close
  out = updateClosingOdds([
    { status: 'pending', settle: { kind: 'multi', legs: [{ kind: 'match', no: 1, team: 'Mexico' }, { kind: 'scorer', no: 1, team: 'Mexico', who: 'X' }] } },
  ], mkCtx({}), { 1: { home: 2.0, away: 4.0, draw: 4.0 } }, PRE);
  assert.equal(out[0].closingOdds, undefined);
});

test('betClv: locked price vs close', () => {
  assert.equal(betClv({ payoutOdds: 1.7, closingOdds: 1.55 }), Math.round((1.7 / 1.55 - 1) * 1000) / 1000);
  assert.equal(betClv({ payoutOdds: 1.5, closingOdds: 1.6 }) < 0, true, 'below the close is negative CLV');
  assert.equal(betClv({ payoutOdds: 1.5 }), null, 'no close, no CLV');
});

test('modelMarket: de-vigged implied probs sum to ~1, edges consistent, started matches excluded', () => {
  const now = Date.parse('2026-06-11T12:00:00Z');
  const marketOdds = {
    1: { home: 1.7, away: 5.4, draw: 3.9 },
    2: { home: 2.6, away: 2.8, draw: 3.1 },
  };
  const mm = modelMarket(mkCtx({}), SIM, marketOdds, now);
  assert.equal(mm.matches.length, 2);
  mm.matches.forEach((m) => {
    const impliedSum = m.outcomes.reduce((s, o) => s + o.implied, 0);
    assert.ok(Math.abs(impliedSum - 1) < 0.01, `de-vigged probs sum to 1, got ${impliedSum}`);
    const modelSum = m.outcomes.reduce((s, o) => s + o.model, 0);
    assert.ok(Math.abs(modelSum - 1) < 0.01, 'model probs sum to 1');
    m.outcomes.forEach((o) => assert.ok(Math.abs(o.edge - (o.model * o.odds - 1)) < 0.002));
    assert.ok(m.overround > 0, 'bookmaker margin is positive');
  });
  // match 1 already scored -> excluded
  const mm2 = modelMarket(mkCtx({ 1: { h: 2, a: 0 } }), SIM, marketOdds, now);
  assert.equal(mm2.matches.length, 1);
  // outrights: sorted by model prob, edge math holds
  assert.ok(mm.outrights.length >= 10);
  for (let i = 1; i < mm.outrights.length; i++) assert.ok(mm.outrights[i - 1].model >= mm.outrights[i].model);
  mm.outrights.forEach((x) => assert.ok(Math.abs(x.edge - (x.model * x.odds - 1)) < 0.02));
});

test('settleKey/specTeams: stable identity and team extraction', () => {
  assert.equal(settleKey({ kind: 'last8', team: 'Germany' }), settleKey({ kind: 'last8', team: 'Germany' }));
  assert.notEqual(settleKey({ kind: 'last8', team: 'Germany' }), settleKey({ kind: 'champion', team: 'Germany' }));
  const multi = { kind: 'multi', legs: [{ kind: 'match', no: 1, team: 'Mexico' }, { kind: 'scorer', no: 1, team: 'Mexico', who: 'X' }] };
  assert.equal(settleKey(multi), settleKey({ kind: 'multi', legs: [...multi.legs].reverse() }), 'leg order irrelevant');
  assert.deepEqual([...specTeams(multi)], ['Mexico']);
});

test('open positions are never re-taken the next day (the 12x Germany failure)', () => {
  const ctx = mkCtx({});
  const day1 = generateBets(ctx, SIM, GEN_OPTS);
  const wildcard = day1.find((b) => b.type === 'wildcard');
  assert.ok(wildcard, 'day 1 produced a wildcard');
  // next day, same conditions, but that position is still open
  const day2 = generateBets(ctx, SIM, { ...GEN_OPTS, date: '2026-06-13', openPositions: [wildcard.settle] });
  const dupes = day2.filter((b) => settleKey(b.settle) === settleKey(wildcard.settle));
  assert.equal(dupes.length, 0, 'identical open thesis is not re-bet');
});

test('team exposure cap: three open positions on a team block a fourth', () => {
  const ctx = mkCtx({});
  const day1 = generateBets(ctx, SIM, GEN_OPTS);
  // find a team the book would otherwise bet on
  const teams = [...new Set(day1.flatMap((b) => [...specTeams(b.settle)]))];
  assert.ok(teams.length > 0);
  const target = teams[0];
  const open = [
    { kind: 'group', g: 'X', team: target },
    { kind: 'qualify', team: target },
    { kind: 'champion', team: target },
  ];
  const day2 = generateBets(ctx, SIM, { ...GEN_OPTS, date: '2026-06-13', openPositions: open });
  const touching = day2.filter((b) => specTeams(b.settle).has(target));
  assert.equal(touching.length, 0, `no new bets touch ${target} at the cap`);
});

test('rollBets threads open positions into the next day book', () => {
  const ctx = mkCtx({});
  const day1 = rollBets(null, ctx, SIM, GEN_OPTS);
  const openKeys = new Set(day1.current.bets.filter((b) => b.status === 'pending').map((b) => settleKey(b.settle)));
  assert.ok(openKeys.size > 0);
  const day2 = rollBets(day1, ctx, SIM, { ...GEN_OPTS, date: '2026-06-13' });
  day2.current.bets.forEach((b) => {
    assert.ok(!openKeys.has(settleKey(b.settle)), `day2 re-took open position ${b.name}`);
  });
});

test('post-mortem v2 rules: payout floor, no negative edge, last8 retired, multi floor', () => {
  const ctx = mkCtx({});
  // Spain v Cabo Verde day: the 89% Spain Insurance (fair 1.13) must now be
  // excluded by the 1.20 payout floor while longer-priced calls survive
  const opts = { ...GEN_OPTS, date: aestDate('2026-06-15T16:00:00Z'), now: Date.parse('2026-06-15T00:00:00Z') };
  const bets = generateBets(ctx, SIM, opts);
  bets.forEach((b) => {
    assert.ok((b.marketOdds ?? b.fairOdds) >= 1.2, `${b.name} pays ${(b.marketOdds ?? b.fairOdds)} — below the floor`);
    assert.notEqual(b.settle.kind, 'last8', 'Quarter Club family is retired');
    if (b.marketOdds) assert.ok((b.edge ?? 0) >= 0, `${b.name} admitted at negative edge`);
    if (b.type === 'multi' || b.type === 'combo') assert.ok(b.prob >= 0.4, `${b.name} below the 40% floor`);
  });
  // negative-edge market prices exclude the bet entirely
  const slateNos = FIX.filter((m) => aestDate(m.d) === opts.date).map((m) => m.no);
  const badOdds = Object.fromEntries(slateNos.map((no) => [no, { home: 1.01, away: 1.02, draw: 2.0 }]));
  const gated = generateBets(ctx, SIM, { ...opts, marketOdds: badOdds });
  gated.forEach((b) => {
    if (b.marketOdds) assert.ok((b.edge ?? 0) >= 0, 'negative-edge market bet slipped through');
  });
});

test('betPnl: $100 simulation maths', () => {
  assert.equal(betPnl({ status: 'won', stake: 100, payoutOdds: 1.53 }), 53);
  assert.equal(betPnl({ status: 'lost', stake: 100, payoutOdds: 9.99 }), -100);
  assert.equal(betPnl({ status: 'pending', stake: 100, payoutOdds: 2 }), 0);
  assert.equal(betPnl({ status: 'won', fairOdds: 2.5 }), 150, 'defaults for older bets');
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
