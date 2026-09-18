import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFootballData, fitXg, predictXg, rollPaperTrade, sameClub, XG_PARAMS, PAPER_RULE } from '../public/lib/xg.js';

const CSV = `Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HST,AST
E1,01/08/2026,Strong,Weak,3,0,9,1
E1,08/08/2026,Weak,Strong,0,2,2,7
E1,15/08/2026,Strong,Mid,2,1,6,3
E1,15/08/2026,Weak,Mid,0,1,2,4
E1,22/08/2026,Mid,Strong,1,3,3,8
E1,22/08/2026,Mid,Weak,2,0,6,1
E1,29/08/2026,Strong,Weak,4,0,10,1
E1,29/08/2026,Mid,Weak,1,0,5,2
E1,05/09/2026,Weak,Strong,0,1,1,6
E1,05/09/2026,Strong,Mid,1,1,5,4
E1,12/09/2026,Weak,Mid,1,2,3,5
E1,12/09/2026,Mid,Strong,0,2,2,6`;

test('parseFootballData: dd/mm/yyyy rows with goals and shots on target', () => {
  const rows = parseFootballData(CSV);
  assert.equal(rows.length, 12);
  assert.equal(rows[0].home, 'Strong'); assert.equal(rows[0].hst, 9);
  assert.ok(rows[11].t > rows[0].t, 'sorted by date');
});

test('xG model: strong side favoured, probabilities sum to 1, ready only with enough games', () => {
  const rows = parseFootballData(CSV);
  const P = XG_PARAMS.eflc;
  const model = fitXg(rows, Date.UTC(2026, 8, 18), P);
  const p = predictXg(model, 'Strong', 'Weak', P);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 0.005);
  assert.ok(p.home > 0.6, 'dominant home side well over 60%');
  assert.ok(p.xgHome > p.xgAway);
  assert.ok(p.ready);
  assert.equal(predictXg(model, 'Nobody', 'Weak', P).ready, false, 'unknown team is not ready');
});

test('sameClub: football-data short names map to feed names', () => {
  assert.ok(sameClub('QPR', 'Queens Park Rangers'));
  assert.ok(sameClub('Wolves', 'Wolverhampton Wanderers'));
  assert.ok(sameClub('Man United', 'Man Utd'));
  assert.ok(sameClub("Nott'm Forest", "Nott'm Forest"));
  assert.ok(!sameClub('Bristol City', 'Cardiff'));
});

test('rollPaperTrade: logs the 55% rule at the early price, one per match, settles from results, no stake', () => {
  const rows = parseFootballData(CSV);
  const P = XG_PARAMS.eflc;
  const now = Date.UTC(2026, 8, 18);
  const matches = [
    { MatchNumber: 501, DateUtc: '2026-09-19 14:00:00Z', HomeTeam: 'Strong', AwayTeam: 'Weak' },
    { MatchNumber: 502, DateUtc: '2026-09-19 14:00:00Z', HomeTeam: 'Mid', AwayTeam: 'Strong' },
  ];
  const priceFor = (m) => (m.MatchNumber === 501 ? { home: 1.6, draw: 4.2, away: 6.0 } : { home: 3.4, draw: 3.5, away: 2.0 });
  const pp = rollPaperTrade(null, { history: rows, matches, priceFor, results: [], now, P, code: 'eflc' });
  assert.equal(pp.predictions.length, 2);
  const t = pp.tips.find((x) => x.no === 501);
  assert.ok(t && t.team === 'Strong', 'strong favourite at a value price is logged');
  assert.ok(t.prob >= PAPER_RULE.minProb && t.edge >= PAPER_RULE.minEdge);
  assert.equal(pp.tips.filter((x) => x.no === 501).length, 1, 'one tip per match');
  assert.ok(!('stake' in t), 'paper tips carry no stake');
  // re-roll: no duplicate; then settle
  const again = rollPaperTrade(pp, { history: rows, matches, priceFor, results: [], now: now + 3600e3, P, code: 'eflc' });
  assert.equal(again.tips.filter((x) => x.no === 501).length, 1, 'never re-logged');
  const results = [{ MatchNumber: 501, HomeTeam: 'Strong', AwayTeam: 'Weak', HomeTeamScore: 2, AwayTeamScore: 0 }];
  const settled = rollPaperTrade(again, { history: rows, matches: [], priceFor: null, results, now: now + 2 * 86400e3, P, code: 'eflc' });
  const st = settled.tips.find((x) => x.no === 501);
  assert.equal(st.status, 'won');
  assert.ok(settled.record.n >= 1 && settled.record.units > 0, 'record in units');
  assert.equal(settled.record.judgeAt, 40);
});
