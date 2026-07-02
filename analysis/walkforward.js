// Walk-forward simulation — "if you'd run the model over the first 16 rounds of
// the 2026 AFL & NRL seasons, how would you have done?" We rebuild Elo up to
// each round, apply the ACTUAL live strategy (v2 gates + Mission-A diagnosis,
// one bet per match, top 5 by edge per round), stake $100 at the OPENING
// bookmaker price, and settle from the real result. We also report the same
// picks bet at the CLOSE (to show the value of betting early = CLV) and a
// "capped" variant that skips implausible >20% edges (the threshold finding).
//
//   node analysis/walkforward.js

import { pullAsb } from './pull-asb.js';
import { attachElo, clusterRounds } from './lib/elo-spine.js';
import { SPORTS, diagnoseEdge, inRepWindow } from '../public/lib/sports.js';

const WEEKS = 16;
const STAKE = 100;
const TEAMS = { nrl: 17, afl: 18 };

// Faithful generateSportBook logic for one round, on ASB opening prices.
function pickRound(matches, league, { edgeCap = Infinity } = {}) {
  const cfg = SPORTS.find((s) => s.key === league);
  const cands = [];
  for (const m of matches) {
    const rep = inRepWindow(cfg, m.dateMs);
    for (const side of ['home', 'away']) {
      const prob = side === 'home' ? m.eloProb : Math.round((1 - m.eloProb) * 1000) / 1000;
      const price = side === 'home' ? m.homeOpen : m.awayOpen;
      const oppPrice = side === 'home' ? m.awayOpen : m.homeOpen;
      const close = side === 'home' ? m.homeClose : m.awayClose;
      const won = side === 'home' ? m.homeWin === 1 : m.homeWin === 0;
      if (!(price > 1) || prob < 0.45 || price < 1.2) continue;
      const edge = Math.round((prob * price - 1) * 1000) / 1000;
      if (edge < 0.03 || edge > edgeCap) continue;
      const diag = diagnoseEdge({ edge, price, oppPrice, eloGames: m.eloGames, teams: TEAMS[league], rep });
      if (edge < diag.bar) continue;
      cands.push({ no: m.date + m.home, team: side === 'home' ? m.home : m.away, edge, price, close, won, cause: diag.cause });
    }
  }
  const byMatch = {};
  cands.forEach((c) => { if (!byMatch[c.no] || c.edge > byMatch[c.no].edge) byMatch[c.no] = c; });
  return Object.values(byMatch).sort((a, b) => b.edge - a.edge).slice(0, 5);
}

function simulate(rows, league, opts = {}) {
  const season2026 = rows.filter((m) => m.season === 2026);
  const rounds = clusterRounds(season2026).slice(0, WEEKS);
  const bets = [];
  for (const r of rounds) for (const b of pickRound(r, league, opts)) bets.push(b);
  const wins = bets.filter((b) => b.won).length;
  const staked = bets.length * STAKE;
  const pnlOpen = bets.reduce((s, b) => s + (b.won ? STAKE * (b.price - 1) : -STAKE), 0);
  const closeBets = bets.filter((b) => b.close > 1);
  const pnlClose = closeBets.reduce((s, b) => s + (b.won ? STAKE * (b.close - 1) : -STAKE), 0);
  const clv = closeBets.length ? closeBets.reduce((s, b) => s + (b.price / b.close - 1), 0) / closeBets.length : 0;
  return {
    rounds: rounds.length, bets: bets.length, wins,
    hit: bets.length ? wins / bets.length : 0,
    staked, pnlOpen, roiOpen: staked ? pnlOpen / staked : 0,
    pnlClose, roiClose: closeBets.length * STAKE ? pnlClose / (closeBets.length * STAKE) : 0,
    avgClv: clv,
  };
}

const money = (x) => (x >= 0 ? '+$' : '−$') + Math.abs(x).toFixed(0);
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

const results = {};
for (const lg of ['nrl', 'afl']) {
  const rows = await attachElo(await pullAsb(lg), lg);
  const base = simulate(rows, lg);
  const capped = simulate(rows, lg, { edgeCap: 0.20 });
  results[lg] = { base, capped };
  console.log(`\n### ${lg.toUpperCase()} — first ${base.rounds} rounds of 2026, $100/bet at the OPENING price`);
  console.log(`  bets ${base.bets} · record ${base.wins}-${base.bets - base.wins} (${(base.hit * 100).toFixed(0)}%) · staked $${base.staked}`);
  console.log(`  P/L at open:  ${money(base.pnlOpen)}  (ROI ${pct(base.roiOpen)})`);
  console.log(`  P/L at close: ${money(base.pnlClose)}  (ROI ${pct(base.roiClose)})   <- betting late kills it`);
  console.log(`  average CLV:  ${pct(base.avgClv)}   <- did we beat the closing line?`);
  console.log(`  capped ≤20% edge:  ${capped.bets} bets, P/L ${money(capped.pnlOpen)} (ROI ${pct(capped.roiOpen)}), CLV ${pct(capped.avgClv)}`);
}

// combined
const tot = (k, f) => ['nrl', 'afl'].reduce((s, lg) => s + f(results[lg][k]), 0);
console.log('\n### COMBINED (both codes, first 16 rounds, at open)');
console.log(`  bets ${tot('base', (r) => r.bets)} · staked $${tot('base', (r) => r.staked)} · P/L ${money(tot('base', (r) => r.pnlOpen))} (ROI ${pct(tot('base', (r) => r.pnlOpen) / tot('base', (r) => r.staked))})`);
console.log(`  capped ≤20%: P/L ${money(tot('capped', (r) => r.pnlOpen))} (ROI ${pct(tot('capped', (r) => r.pnlOpen) / tot('capped', (r) => r.staked))})`);
console.log('\nNote: bet at the OPENING bookmaker price (what we lock 3 days out), settled on real');
console.log('results. CLV vs the close is the skill signal; the raw P/L over ~16 rounds is small-n.');
