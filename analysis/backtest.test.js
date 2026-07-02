import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sigmoid, fitLogistic, predictLogistic, logLoss, brierScore,
  calibrationBins, bootstrapCI, rng, standardise, mean,
  matInverse, normalCdf, logisticInference,
} from './lib/stats.js';
import {
  fitAndScore, seasonSplit, profitSim, runExperiment, verdict,
} from './lib/backtest.js';

// ---- stats primitives --------------------------------------------------

test('sigmoid: monotone, symmetric, stable in both tails', () => {
  assert.equal(sigmoid(0), 0.5);
  assert.ok(sigmoid(50) > 0.999 && sigmoid(50) <= 1);
  assert.ok(sigmoid(-50) < 0.001 && sigmoid(-50) >= 0);
  assert.ok(Math.abs(sigmoid(2) + sigmoid(-2) - 1) < 1e-12);
});

test('fitLogistic: recovers a known decision boundary', () => {
  // truth: P(y=1) = sigmoid(1.5*x1 - 0.8*x2 + 0.3)
  const rand = rng(7);
  const X = [], y = [];
  for (let i = 0; i < 4000; i++) {
    const x1 = (rand() - 0.5) * 6, x2 = (rand() - 0.5) * 6;
    X.push([x1, x2]);
    y.push(rand() < sigmoid(1.5 * x1 - 0.8 * x2 + 0.3) ? 1 : 0);
  }
  const m = fitLogistic(X, y, { lr: 0.3, iters: 8000, l2: 1e-5 });
  assert.ok(Math.abs(m.weights[0] - 1.5) < 0.2, `w1=${m.weights[0]}`);
  assert.ok(Math.abs(m.weights[1] + 0.8) < 0.2, `w2=${m.weights[1]}`);
  assert.ok(Math.abs(m.intercept - 0.3) < 0.2, `b=${m.intercept}`);
});

test('logLoss & brier: perfect calibration beats hedging beats wrong', () => {
  const y = [1, 0, 1, 0];
  const good = [0.9, 0.1, 0.9, 0.1];
  const hedge = [0.5, 0.5, 0.5, 0.5];
  const bad = [0.1, 0.9, 0.1, 0.9];
  assert.ok(logLoss(y, good) < logLoss(y, hedge));
  assert.ok(logLoss(y, hedge) < logLoss(y, bad));
  assert.ok(brierScore(y, good) < brierScore(y, hedge));
  assert.equal(brierScore([1], [1]), 0);
});

test('calibrationBins: sorts predictions into reliability buckets', () => {
  const y = [1, 1, 0, 0], p = [0.95, 0.85, 0.15, 0.05];
  const bins = calibrationBins(y, p, 10);
  assert.equal(bins[9].n, 1); assert.equal(bins[9].observed, 1);
  assert.equal(bins[0].n, 1); assert.equal(bins[0].observed, 0);
  assert.equal(bins.reduce((s, b) => s + b.n, 0), 4);
});

test('bootstrapCI: reproducible under a fixed seed, brackets the mean', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ v: (i % 10) }));
  const stat = (s) => mean(s.map((r) => r.v));
  const a = bootstrapCI(rows, stat, { reps: 500, seed: 99 });
  const b = bootstrapCI(rows, stat, { reps: 500, seed: 99 });
  assert.deepEqual(a, b, 'same seed -> identical interval');
  assert.ok(a.lo < a.point && a.point < a.hi);
});

test('standardise: replays TRAIN scaling on TEST (no leakage)', () => {
  const trainCol = standardise([0, 10, 20, 30]);
  const test = standardise([40, 50], trainCol); // must use train mu/sigma
  assert.equal(test.mu, trainCol.mu);
  assert.equal(test.sigma, trainCol.sigma);
  // 40 is above the train mean by (40-15)/sigma, not re-centred on itself
  assert.ok(test.values[0] > 1);
});

test('matInverse & normalCdf: linear algebra + normal tail are correct', () => {
  const A = [[4, 3], [6, 3]];
  const inv = matInverse(A);
  // A*inv should be identity
  const I = [[0, 0], [0, 0]];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) I[i][j] += A[i][k] * inv[k][j];
  assert.ok(Math.abs(I[0][0] - 1) < 1e-9 && Math.abs(I[1][1] - 1) < 1e-9 && Math.abs(I[0][1]) < 1e-9);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 0.001, 'z=1.96 -> ~0.975');
  assert.throws(() => matInverse([[1, 2], [2, 4]]), /singular/, 'collinear -> throws');
});

test('logisticInference: real coefficient is significant, a noise column is not', () => {
  const rand = rng(4);
  const X = [], y = [];
  for (let i = 0; i < 3000; i++) {
    const real = (rand() - 0.5) * 4;   // truly drives the outcome
    const noise = (rand() - 0.5) * 4;  // irrelevant
    X.push([real, noise]);
    y.push(rand() < sigmoid(1.2 * real + 0.0 * noise) ? 1 : 0);
  }
  const inf = logisticInference(X, y, { lr: 0.3, iters: 4000 });
  const real = inf[1], noise = inf[2]; // index 0 = intercept
  assert.ok(real.coef > 0.5 && real.lo > 0, `real coef ${real.coef.toFixed(2)} CI [${real.lo.toFixed(2)},${real.hi.toFixed(2)}] must clear 0`);
  assert.ok(real.p < 0.001, `real p=${real.p} should be tiny`);
  assert.ok(noise.lo < 0 && noise.hi > 0, 'noise CI straddles 0');
  assert.ok(noise.p > 0.05, `noise p=${noise.p.toFixed(2)} should be non-significant`);
});

// ---- synthetic league generator ----------------------------------------

// Build seasons of matches where home-win truly depends on eloDiff and,
// optionally, scDiff. `betaSC` = 0 makes SuperCoach pure noise (the null).
function makeSeasons(seasons, perSeason, betaSC, seed = 3) {
  const rand = rng(seed);
  const rows = [];
  for (const season of seasons) {
    for (let i = 0; i < perSeason; i++) {
      const eloDiff = (rand() - 0.5) * 300;        // +-150
      const scDiff = (rand() - 0.5) * 6000;        // +-3000, independent of elo
      const trueLogit = 0.012 * eloDiff + betaSC * 0.0006 * scDiff + 0.15;
      const pTrue = sigmoid(trueLogit);
      const homeWin = rand() < pTrue ? 1 : 0;
      // the market knows elo + home edge but NOT scDiff
      const mp = sigmoid(0.012 * eloDiff + 0.15);
      const vig = 1.05;
      rows.push({
        season, round: 1 + (i % 24), date: `${season}-01-01`,
        home: `H${i}`, away: `A${i}`,
        eloDiff, scDiff, marketProb: mp,
        homePrice: Math.round((1 / (mp * vig)) * 100) / 100 || 1.01,
        awayPrice: Math.round((1 / ((1 - mp) * vig)) * 100) / 100 || 1.01,
        homeWin,
        originWindow: (i % 24) >= 12 && (i % 24) <= 14, // a handful per season
      });
    }
  }
  return rows;
}

// ---- backtest harness --------------------------------------------------

test('seasonSplit: trains on the past, tests on the held-out future only', () => {
  const rows = makeSeasons([2022, 2023, 2024], 5, 0);
  const { train, test } = seasonSplit(rows, 2024);
  assert.ok(train.every((r) => r.season < 2024));
  assert.ok(test.every((r) => r.season === 2024));
  assert.equal(test.length, 5);
});

test('profitSim: bets only when the model beats the closing price, P/L is right', () => {
  const rows = [
    { home: 'A', away: 'B', homePrice: 3.0, awayPrice: 1.4, homeWin: 1 }, // model loves home
    { home: 'C', away: 'D', homePrice: 1.2, awayPrice: 4.5, homeWin: 0 }, // no edge either side
  ];
  // home 0.6@3.0 -> edge +0.8; row2 home 0.7@1.2 (edge<0) and away 0.3 (below 0.45 floor) -> no bet
  const pModel = [0.6, 0.7];
  const sim = profitSim(rows, pModel, { stake: 100, edgeThreshold: 0.03 });
  assert.equal(sim.bets, 1, 'only the +edge home bet clears the gates');
  assert.equal(sim.wins, 1);
  assert.equal(Math.round(sim.pnl), 200, '100 @ 3.0 winner returns +200 profit');
});

test('MISSION B — signal case: harness detects a real SuperCoach edge', () => {
  const rows = makeSeasons([2022, 2023, 2024, 2025], 260, 1.0, 11); // scDiff matters
  const exp = runExperiment(rows, 2025);
  assert.ok(exp.ok);
  // adding scDiff must lower held-out log-loss vs Elo-only...
  assert.ok(exp.scored.M2.logLoss < exp.scored.M1.logLoss, 'M2 beats M1 on held-out loss');
  // ...with the improvement's CI clear of zero...
  assert.ok(exp.lossImprovementM2overM1.lo > 0, `loss gain CI lo=${exp.lossImprovementM2overM1.lo}`);
  // ...and a positive scDiff coefficient (more value -> more likely to win)
  assert.ok(exp.scDiffCoef.M2 > 0, `scDiff coef=${exp.scDiffCoef.M2}`);
  const v = verdict([exp]);
  assert.ok(v.answer.startsWith('yes'), `verdict=${v.answer}: ${v.reason}`);
});

test('MISSION B — null case: harness returns an honest NO on noise', () => {
  const rows = makeSeasons([2022, 2023, 2024, 2025], 260, 0.0, 22); // scDiff is noise
  const exp = runExperiment(rows, 2025);
  assert.ok(exp.ok);
  // with a noise feature and L2, M2 must NOT show a CI-clear improvement
  assert.ok(exp.lossImprovementM2overM1.lo <= 0, `noise should not clear zero: lo=${exp.lossImprovementM2overM1.lo}`);
  const v = verdict([exp]);
  assert.equal(v.answer, 'no', `verdict=${v.answer}: ${v.reason}`);
});

test('runExperiment: refuses to run without a trainable past', () => {
  const rows = makeSeasons([2025], 20, 1.0);
  const exp = runExperiment(rows, 2025);
  assert.equal(exp.ok, false, 'no prior season to train on');
});

test('fitAndScore: reports scDiff coef on the ORIGINAL scale, not standardised', () => {
  const rows = makeSeasons([2022, 2023], 200, 1.0, 5);
  const { train, test } = seasonSplit(rows, 2023);
  // withDerived is applied inside runExperiment; emulate the marketProbLogit need
  const withLogit = rows.map((r) => ({ ...r, marketProbLogit: Math.log(r.marketProb / (1 - r.marketProb)) }));
  const tr = withLogit.filter((r) => r.season < 2023), te = withLogit.filter((r) => r.season === 2023);
  const m2 = fitAndScore('M2', tr, te);
  // scDiff coef should be tiny in raw units (~0.0006) because scDiff spans thousands
  assert.ok(Math.abs(m2.coefs.scDiff) < 0.01, `raw-scale coef=${m2.coefs.scDiff}`);
  assert.ok(m2.coefs.scDiff > 0, 'positive in the signal case');
});
