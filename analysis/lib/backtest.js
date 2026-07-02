// Mission B — does the stronger SuperCoach-valued lineup win more bets?
//
// This module answers that ONE question honestly. It does not fetch data
// (that's analysis/pull-*.js); it takes an array of match records and runs the
// nested-model experiment from docs/OPUS-ROADMAP.md §2.1:
//
//   M1: home-win ~ eloDiff                 (today's engine — the baseline)
//   M2: home-win ~ eloDiff + scDiff        (does SuperCoach add anything?)
//   M3: home-win ~ marketProb + scDiff     (anything the CLOSE hasn't priced?)
//
// The verdict rules (§2.3) are deliberately strict: M2 must beat M1 on a
// held-out FUTURE season, and the scDiff coefficient must keep the same sign
// across seasons, or the answer is "no" and we say so.
//
// A match record (all fields knowable BEFORE kickoff — see leakage notes):
//   {
//     season: 2024, round: 5, date: '2024-04-01',
//     home: 'Storm', away: 'Broncos',
//     eloDiff: 78,            // (homeElo + hfa) - awayElo, entering the round
//     scDiff: 1420,           // sum(home lineup value) - sum(away), pre-round
//     marketProb: 0.62,       // de-vigged home closing prob (for M3 + profit)
//     homePrice: 1.65, awayPrice: 2.35,  // closing decimal odds
//     homeWin: 1,             // OUTCOME — the only post-match field
//     originWindow: false,    // was this a rep-football round?
//   }

import {
  fitLogistic, predictLogistic, standardise, logLoss, brierScore,
  calibrationBins, bootstrapCI, mean,
} from './stats.js';

// The three model specs: which pre-match columns feed each one.
const MODELS = {
  M1: { name: 'Elo only (baseline)', cols: ['eloDiff'] },
  M2: { name: 'Elo + SuperCoach', cols: ['eloDiff', 'scDiff'] },
  M3: { name: 'Market + SuperCoach', cols: ['marketProbLogit', 'scDiff'] },
};

// Market prob -> logit, so M3 can "start from the market" and only move on
// scDiff. A market prob already carries the vig-removed wisdom of the crowd;
// feeding its logit lets the fit keep or discount it rather than relearn it.
function withDerived(rows) {
  return rows.map((r) => ({
    ...r,
    marketProbLogit: r.marketProb == null ? 0
      : Math.log(Math.min(0.999, Math.max(0.001, r.marketProb)) / (1 - Math.min(0.999, Math.max(0.001, r.marketProb)))),
  }));
}

// Build a design matrix for one model, standardising each column on TRAIN
// statistics and replaying that exact transform on TEST (no leakage).
function design(rows, cols, scalers = null) {
  const outCols = {};
  const fitScalers = {};
  cols.forEach((c) => {
    const raw = rows.map((r) => Number(r[c]) || 0);
    const s = standardise(raw, scalers ? scalers[c] : null);
    outCols[c] = s.values;
    fitScalers[c] = { mu: s.mu, sigma: s.sigma };
  });
  const X = rows.map((_, i) => cols.map((c) => outCols[c][i]));
  return { X, scalers: fitScalers };
}

// Fit one model on train rows, score it on test rows.
export function fitAndScore(modelKey, trainRows, testRows, fitOpts = {}) {
  const spec = MODELS[modelKey];
  const yTrain = trainRows.map((r) => r.homeWin);
  const yTest = testRows.map((r) => r.homeWin);
  const { X: Xtr, scalers } = design(trainRows, spec.cols);
  const { X: Xte } = design(testRows, spec.cols, scalers);
  const model = fitLogistic(Xtr, yTrain, fitOpts);
  const pTest = predictLogistic(model, Xte);
  // report each coefficient against its ORIGINAL column, undoing the scaling,
  // so a reader sees "scDiff coef" not "standardised col 1 coef"
  const coefs = {};
  spec.cols.forEach((c, j) => { coefs[c] = model.weights[j] / scalers[c].sigma; });
  return {
    model: modelKey,
    name: spec.name,
    coefs,
    intercept: model.intercept,
    logLoss: logLoss(yTest, pTest),
    brier: brierScore(yTest, pTest),
    calibration: calibrationBins(yTest, pTest),
    pTest,
  };
}

// Time-ordered split: everything from `testSeason` is the held-out future;
// everything strictly before it trains. NEVER random splits — a random split
// lets the model peek at the future through correlated rounds.
export function seasonSplit(rows, testSeason) {
  const train = rows.filter((r) => r.season < testSeason);
  const test = rows.filter((r) => r.season === testSeason);
  return { train, test };
}

// Flat-stake profit simulation under the v2 gates, betting the blended model
// wherever it beats the CLOSING price by >= edgeThreshold. Evaluating against
// the close is the honest bar — beating a stale opener proves nothing.
export function profitSim(testRows, pModel, { stake = 100, edgeThreshold = 0.03, probFloor = 0.45, payoutFloor = 1.2 } = {}) {
  const settled = [];
  for (let i = 0; i < testRows.length; i++) {
    const r = testRows[i];
    // consider both sides; take the one (if any) that clears the gates
    const sides = [
      { pick: 'home', prob: pModel[i], price: r.homePrice, won: r.homeWin === 1 },
      { pick: 'away', prob: 1 - pModel[i], price: r.awayPrice, won: r.homeWin === 0 },
    ];
    let best = null;
    for (const s of sides) {
      if (s.prob < probFloor || !s.price || s.price < payoutFloor) continue;
      const edge = s.prob * s.price - 1;
      if (edge < edgeThreshold) continue;
      if (!best || edge > best.edge) best = { ...s, edge };
    }
    if (best) settled.push({ ...best, pnl: best.won ? stake * (best.price - 1) : -stake, stake });
  }
  const staked = settled.reduce((s, b) => s + b.stake, 0);
  const pnl = settled.reduce((s, b) => s + b.pnl, 0);
  return {
    bets: settled.length,
    wins: settled.filter((b) => b.won).length,
    staked,
    pnl,
    roi: staked ? pnl / staked : 0,
    // ROI with a bootstrap CI — a season's ROI point estimate is noise
    roiCI: settled.length
      ? bootstrapCI(settled, (sample) => {
        const st = sample.reduce((s, b) => s + b.stake, 0);
        return st ? sample.reduce((s, b) => s + b.pnl, 0) / st : 0;
      })
      : null,
  };
}

// The whole experiment for one held-out season: fit M1/M2/M3 on prior seasons,
// score on the held-out one, simulate profit, and repeat on the Origin subset.
export function runExperiment(rawRows, testSeason, opts = {}) {
  const rows = withDerived(rawRows);
  const { train, test } = seasonSplit(rows, testSeason);
  if (!train.length || !test.length) {
    return { ok: false, reason: `need seasons before ${testSeason} to train and ${testSeason} to test`, train: train.length, test: test.length };
  }
  const scored = {};
  for (const k of Object.keys(MODELS)) scored[k] = fitAndScore(k, train, test, opts.fit);

  const profit = {
    M1: profitSim(test, scored.M1.pTest, opts.sim),
    M2: profitSim(test, scored.M2.pTest, opts.sim),
    M3: profitSim(test, scored.M3.pTest, opts.sim),
  };

  // The headline test: does adding scDiff lower held-out log-loss, and is the
  // improvement's CI clear of zero? Bootstrap the per-match log-loss delta.
  const perMatchLoss = (p, i, y) => {
    const pc = Math.min(1 - 1e-12, Math.max(1e-12, p[i]));
    return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  };
  const lossDeltaRows = test.map((r, i) => ({
    d: perMatchLoss(scored.M1.pTest, i, r.homeWin) - perMatchLoss(scored.M2.pTest, i, r.homeWin),
  }));
  const lossDelta = bootstrapCI(lossDeltaRows, (s) => mean(s.map((x) => x.d)));

  const originTest = test.filter((r) => r.originWindow);
  const originResult = originTest.length >= 8 ? {
    n: originTest.length,
    M1logLoss: logLoss(originTest.map((r) => r.homeWin), originTest.map((r) => scored.M1.pTest[test.indexOf(r)])),
    M2logLoss: logLoss(originTest.map((r) => r.homeWin), originTest.map((r) => scored.M2.pTest[test.indexOf(r)])),
  } : { n: originTest.length, note: 'too few Origin-window matches to judge (need >=8)' };

  return {
    ok: true,
    testSeason,
    trainSeasons: [...new Set(train.map((r) => r.season))].sort(),
    n: { train: train.length, test: test.length },
    scored,
    profit,
    // scDiff verdict inputs, ready for §2.3 rules
    scDiffCoef: { M2: scored.M2.coefs.scDiff, M3: scored.M3.coefs.scDiff },
    lossImprovementM2overM1: lossDelta, // positive = M2 better; CI must clear 0
    origin: originResult,
  };
}

// Apply the §2.3 verdict rules across every held-out season and return a
// plain-English yes/no plus the evidence. A clean "no" is a success.
export function verdict(experiments) {
  const ok = experiments.filter((e) => e.ok);
  if (!ok.length) return { answer: 'inconclusive', reason: 'no runnable held-out seasons', experiments };
  const improves = ok.every((e) => e.lossImprovementM2overM1.lo > 0);
  const coefSigns = ok.map((e) => Math.sign(e.scDiffCoef.M2));
  const stableSign = coefSigns.every((s) => s === coefSigns[0]) && coefSigns[0] !== 0;
  const beatsMarket = ok.every((e) => e.scored.M3.logLoss < e.scored.M1.logLoss);

  let answer, reason;
  if (improves && stableSign) {
    answer = beatsMarket ? 'yes-beats-market' : 'yes-vs-elo';
    reason = beatsMarket
      ? 'SuperCoach lineup strength improved held-out log-loss over Elo in every season with a CI clear of zero, a stable coefficient sign, AND carried information the closing price had not — treat the market-beating result with suspicion and re-check for leakage before trusting it.'
      : 'SuperCoach lineup strength improved held-out log-loss over Elo in every season (CI clear of zero, stable sign), but did not beat the closing market — useful as an Elo adjustment, not as a market-beater.';
  } else {
    answer = 'no';
    reason = `SuperCoach lineup strength did not clear the bar (${improves ? 'improved loss but' : 'did not consistently improve held-out log-loss'}${stableSign ? '' : '; coefficient sign flipped across seasons'}). Per §2.3 this is a valid negative result: publish it and do not wire scDiff into the engine.`;
  }
  return {
    answer,
    reason,
    perSeason: ok.map((e) => ({
      season: e.testSeason,
      M1logLoss: round(e.scored.M1.logLoss), M2logLoss: round(e.scored.M2.logLoss), M3logLoss: round(e.scored.M3.logLoss),
      scDiffCoefM2: round(e.scDiffCoef.M2, 5),
      lossGainCI: [round(e.lossImprovementM2overM1.lo, 4), round(e.lossImprovementM2overM1.hi, 4)],
      m2Roi: round(e.profit.M2.roi, 4), m2RoiCI: e.profit.M2.roiCI ? [round(e.profit.M2.roiCI.lo, 4), round(e.profit.M2.roiCI.hi, 4)] : null,
    })),
  };
}

function round(x, dp = 4) { const f = 10 ** dp; return Math.round(x * f) / f; }
