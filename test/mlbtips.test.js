import test from 'node:test';
import assert from 'node:assert/strict';
import { starterFactor, platoonFactor, bullpenFatigue, evaluateGame, rollMlbTips, winProb, MLB_RULE } from '../public/lib/mlbtips.js';

const ace = { name: 'Ace', hand: 'L', ip: 180, gs: 30, hr: 12, bb: 40, hbp: 4, so: 200, vsL: { ops: 0.55, pa: 300 }, vsR: { ops: 0.62, pa: 400 } };
const dud = { name: 'Dud', hand: 'R', ip: 150, gs: 32, hr: 25, bb: 60, hbp: 6, so: 120, vsL: { ops: 0.78, pa: 350 }, vsR: { ops: 0.72, pa: 300 } };
const team = (rpg, ops, vl, vr) => ({ rpg, ops, vs: { L: { ops: vl }, R: { ops: vr } } });

test('starterFactor: an ace prevents runs, a dud allows them, TBD is a bullpen game', () => {
  const a = starterFactor(ace), d = starterFactor(dud), t = starterFactor(null);
  assert.ok(a.factor < 0.9 && d.factor > 1.05, 'ace below league, dud above');
  assert.ok(a.share > d.share, 'ace covers more of the game');
  assert.equal(t.factor, 1); assert.ok(/TBD/.test(t.note));
});

test('platoonFactor: a lefty-heavy lineup hurts a dud righty more than a lefty ace', () => {
  const lefties = Array.from({ length: 9 }, (_, i) => ({ bats: i < 6 ? 'L' : 'R' }));
  const vsDud = platoonFactor(dud, lefties, null, 0.72), vsAce = platoonFactor(ace, lefties, null, 0.72);
  assert.ok(vsDud.factor > 1 && vsAce.factor < 1);
  // no lineup yet: fall back to the team's split against the starter's hand
  const fb = platoonFactor(ace, null, { ops: 0.66 }, 0.72);
  assert.ok(fb.factor < 1 && /lefties/.test(fb.note));
});

test('bullpenFatigue: three straight days, or 25+ pitches yesterday, flags an arm', () => {
  const today = Date.UTC(2026, 9, 8, 23); // a 7pm US-ET game on 8 Oct
  const d = (n) => Date.UTC(2026, 9, 8 - n, 12); // usage games stamped at noon UTC on their date
  const usage = [
    { role: 'RP', name: 'Everyday', t: d(1), pitches: 12 }, { role: 'RP', name: 'Everyday', t: d(2), pitches: 10 }, { role: 'RP', name: 'Everyday', t: d(3), pitches: 14 },
    { role: 'RP', name: 'Heavy', t: d(1), pitches: 40 },
    { role: 'RP', name: 'Fresh', t: d(3), pitches: 30 },
    { role: 'SP', name: 'Starter', t: d(1), pitches: 95 },
  ];
  const f = bullpenFatigue(usage, today);
  assert.deepEqual(f.tired.sort(), ['Everyday', 'Heavy']);
  assert.ok(f.factor > 1 && f.factor <= 1.15);
});

test('evaluateGame + rollMlbTips: ace at home v dud is a strong favourite; calls log once and settle', () => {
  const g = { gamePk: 1, home: 'H', away: 'A', kickoff: '2026-10-09T00:00:00Z', t: Date.UTC(2026, 9, 8), homeSP: ace, awaySP: dud,
    homeTeam: team(4.8, 0.74, 0.72, 0.75), awayTeam: team(4.2, 0.70, 0.66, 0.71), homeUsage: [], awayUsage: [], prices: { home: 1.75, away: 2.2 } };
  const ev = evaluateGame(g);
  assert.ok(ev.home > 0.6, 'ace + better offence at home -> well over 60%');
  assert.ok(ev.reasons.some((r) => /FIP/.test(r)));
  assert.ok(Math.abs(winProb(4.5, 4.5) - 0.5) < 0.01, 'even runs -> 50%');
  const now = Date.UTC(2026, 9, 8);
  const r1 = rollMlbTips(null, { games: [g], results: {}, now });
  assert.equal(r1.tips.length, 1); assert.equal(r1.tips[0].team, 'H'); assert.ok(r1.tips[0].edge >= MLB_RULE.minEdge);
  const r2 = rollMlbTips(r1, { games: [g], results: {}, now: now + 3600e3 });
  assert.equal(r2.tips.length, 1, 'never logged twice');
  const r3 = rollMlbTips(r2, { games: [], results: { 1: { final: true, hs: 5, as: 2 } }, now: now + 2 * 86400e3 });
  assert.equal(r3.tips[0].status, 'won'); assert.ok(r3.record.units > 0); assert.equal(r3.record.judgeAt, 60);
  // a tip with no price settles as right/wrong but carries no units
  const r4 = rollMlbTips({ tips: [{ id: 'm', gamePk: 2, side: 'away', team: 'A', opp: 'H', prob: 0.5, price: null, status: 'pending' }] }, { games: [], results: { 2: { final: true, hs: 1, as: 4 } }, now });
  assert.equal(r4.tips[0].status, 'won'); assert.equal(r4.record.units, 0);
});
