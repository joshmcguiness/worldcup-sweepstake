// Threshold analysis — which model edges are GOOD bets and which are traps.
// For every match 2016-2025 (post Elo warm-up) we take each side where our Elo
// prob beats the OPENING bookmaker price, bucket by edge size, and measure what
// actually happened: hit rate, ROI betting $1 at the open, ROI at the close, and
// average CLV. This tells us where to set the bar. Bookmaker odds carry vig, so
// break-even ROI is 0 (not −vig): a positive-ROI bucket is genuinely +EV.
//
//   node analysis/thresholds.js

import { pullAsb } from './pull-asb.js';
import { attachElo } from './lib/elo-spine.js';

const BUCKETS = [
  [-1, 0, 'negative (model below market)'],
  [0, 0.03, '0–3% (below our live bar)'],
  [0.03, 0.05, '3–5%'],
  [0.05, 0.10, '5–10%'],
  [0.10, 0.20, '10–20%'],
  [0.20, 0.50, '20–50%'],
  [0.50, 99, '50%+ (extreme)'],
];

function analyse(rows, { probFloor = 0 } = {}) {
  const ops = [];
  for (const m of rows) {
    for (const side of ['home', 'away']) {
      const prob = side === 'home' ? m.eloProb : Math.round((1 - m.eloProb) * 1000) / 1000;
      const price = side === 'home' ? m.homeOpen : m.awayOpen;
      const close = side === 'home' ? m.homeClose : m.awayClose;
      const won = side === 'home' ? m.homeWin === 1 : m.homeWin === 0;
      if (!(price > 1) || prob < probFloor) continue;
      const edge = prob * price - 1;
      ops.push({ edge, won, price, close, pnlOpen: won ? price - 1 : -1, pnlClose: close > 1 ? (won ? close - 1 : -1) : null, clv: close > 1 ? price / close - 1 : null });
    }
  }
  return BUCKETS.map(([lo, hi, label]) => {
    const b = ops.filter((o) => o.edge >= lo && o.edge < hi);
    const staked = b.length;
    const roiOpen = staked ? b.reduce((s, o) => s + o.pnlOpen, 0) / staked : 0;
    const closeB = b.filter((o) => o.pnlClose != null);
    const roiClose = closeB.length ? closeB.reduce((s, o) => s + o.pnlClose, 0) / closeB.length : 0;
    const clvB = b.filter((o) => o.clv != null);
    const avgClv = clvB.length ? clvB.reduce((s, o) => s + o.clv, 0) / clvB.length : 0;
    return {
      label, n: staked,
      hit: staked ? b.filter((o) => o.won).length / staked : 0,
      roiOpen, roiClose, avgClv,
    };
  });
}

const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
function printTable(title, rows) {
  console.log(`\n### ${title}`);
  console.log('edge bucket'.padEnd(30), 'n'.padStart(6), 'hit'.padStart(7), 'ROI@open'.padStart(10), 'ROI@close'.padStart(11), 'avgCLV'.padStart(9));
  for (const r of rows) {
    console.log(r.label.padEnd(30), String(r.n).padStart(6), (r.hit * 100).toFixed(0).padStart(6) + '%',
      pct(r.roiOpen).padStart(10), pct(r.roiClose).padStart(11), pct(r.avgClv).padStart(9));
  }
}

const out = { generatedNote: 'ROI is per $1 staked at the opening bookmaker price; break-even = 0.' };
for (const lg of ['nrl', 'afl']) {
  const rows = (await attachElo(await pullAsb(lg), lg)).filter((m) => m.season >= 2016 && m.season <= 2025 && m.eloGames > 30);
  const all = analyse(rows);
  const floored = analyse(rows, { probFloor: 0.45 });
  printTable(`${lg.toUpperCase()} — all positive-edge sides (2016–2025, n_matches=${rows.length})`, all);
  printTable(`${lg.toUpperCase()} — with the live prob≥0.45 floor (favourites only)`, floored);
  out[lg] = { all, floored };
}

console.log('\nRead: a bucket is a GOOD bet only if ROI@open is clearly positive with a real n.');
console.log('If ROI climbs then falls as edge grows, the sweet spot is the middle — the biggest');
console.log('"edges" are usually the model being wrong, not the market (see roadmap §3.0).');
