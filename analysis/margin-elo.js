// Does a MARGIN-aware Elo beat the binary win/loss Elo? (Part-2 Q1 said recent
// scoring margin is a significant predictor beyond binary Elo, so folding margin
// into the rating update should help.) We compare the two ratings out-of-sample.
//
// Fairness: the margin update uses the FiveThirtyEight margin-of-victory
// multiplier — ln(|margin|+1) × 2.2/(0.001·Δrating_winner + 2.2), which dampens
// blowouts and the favourite-autocorrelation — NORMALISED to mean 1 on 2013–2015
// so it carries the SAME average learning rate as binary Elo (same K). That
// isolates the one question: does weighting updates by margin help? No test-set
// tuning. `node analysis/margin-elo.js`.

import { pullAsb } from './pull-asb.js';
import { SPORTS } from '../public/lib/sports.js';
import { logLoss, brierScore, calibrationBins } from './lib/stats.js';

const BASE = 1500;
const regress = (e) => { const o = {}; for (const [t, r] of Object.entries(e)) o[t] = BASE + 0.75 * (r - BASE); return o; };
const movMult = (marginAbs, drWinner) => Math.log(marginAbs + 1) * (2.2 / (0.001 * drWinner + 2.2));

// normalisation constant: mean MoV multiplier over a training window (uses
// dr=0, since the dr term is ~symmetric across games — this is just a scale).
function normConstFor(matches) {
  const tr = matches.filter((m) => m.season >= 2013 && m.season <= 2015);
  const vals = tr.map((m) => Math.log(Math.abs(m.homeScore - m.awayScore) + 1));
  return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 1;
}

// Build pre-match home-win probs with either binary or margin-weighted updates.
function buildProbs(matches, cfg, { margin = false, K = 40, normConst = 1 }) {
  const sorted = matches.slice().sort((a, b) => a.dateMs - b.dateMs);
  let elo = {}; let season = null;
  const out = [];
  for (const m of sorted) {
    if (season !== null && m.season !== season) elo = regress(elo);
    season = m.season;
    const rh = (elo[m.home] ?? BASE) + cfg.hfa;
    const ra = elo[m.away] ?? BASE;
    const e = 1 / (1 + 10 ** (-(rh - ra) / 400));
    out.push({ ...m, p: Math.round(e * 1000) / 1000 });
    const s = m.homeWin;
    let k = K;
    if (margin) {
      const marginAbs = Math.abs(m.homeScore - m.awayScore);
      const drWinner = s === 1 ? (rh - ra) : (ra - rh);
      k = K * (movMult(marginAbs, drWinner) / normConst);
    }
    elo[m.home] = (elo[m.home] ?? BASE) + k * (s - e);
    elo[m.away] = (elo[m.away] ?? BASE) - k * (s - e);
  }
  return out;
}

const r4 = (x) => (Math.round(x * 10000) / 10000).toFixed(4);
function score(rows) {
  const y = rows.map((r) => r.homeWin), p = rows.map((r) => r.p);
  return { n: rows.length, logLoss: logLoss(y, p), brier: brierScore(y, p) };
}

for (const lg of ['nrl', 'afl']) {
  const cfg = SPORTS.find((s) => s.key === lg);
  const matches = await pullAsb(lg);
  const nc = normConstFor(matches);
  const binary = buildProbs(matches, cfg, { margin: false });
  const margin = buildProbs(matches, cfg, { margin: true, normConst: nc });
  const evalWin = (r) => r.season >= 2016 && r.season <= 2026;
  const b = score(binary.filter(evalWin)), mg = score(margin.filter(evalWin));
  console.log(`\n### ${lg.toUpperCase()} — binary vs margin Elo (eval 2016–2026, n=${b.n}, normConst=${nc.toFixed(2)})`);
  console.log(`  binary Elo: log-loss ${r4(b.logLoss)}  Brier ${r4(b.brier)}`);
  console.log(`  margin Elo: log-loss ${r4(mg.logLoss)}  Brier ${r4(mg.brier)}   ${mg.logLoss < b.logLoss ? '✓ better' : '✗ worse'} (Δ ${r4(mg.logLoss - b.logLoss)})`);
  // per held-out season
  console.log('  by season:  ', [...new Set(binary.filter(evalWin).map((r) => r.season))].sort().map((yr) => {
    const bs = score(binary.filter((r) => r.season === yr)).logLoss;
    const ms = score(margin.filter((r) => r.season === yr)).logLoss;
    return `${yr}:${ms < bs ? '+' : '−'}`;
  }).join(' '));
}
console.log('\n(+ = margin Elo had the lower log-loss that season. Same K and average learning');
console.log('rate for both, so any gain is from weighting updates by score margin.)');
