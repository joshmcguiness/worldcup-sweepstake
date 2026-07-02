// Zero-dependency statistics for the SuperCoach backtest (Mission B).
//
// Everything here is pure and deterministic: model fitting is plain
// gradient descent, and every random draw goes through a seeded PRNG so a
// backtest run is byte-for-byte reproducible (a non-negotiable when the whole
// point is to tell an honest "yes" from a lucky "yes").

// ---- deterministic randomness (mulberry32) -----------------------------

// A seeded PRNG. Node's Math.random() is fine for a game but useless for a
// backtest you need to reproduce; a fixed seed makes bootstrap CIs stable.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- link functions ----------------------------------------------------

export function sigmoid(z) {
  // numerically stable both tails
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

export function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// Standardise a column to mean 0 / sd 1, returning {values, mu, sigma} so the
// exact same transform can be replayed on the held-out season (never re-fit
// scaling on test data — that leaks).
export function standardise(xs, precomputed = null) {
  const mu = precomputed ? precomputed.mu : mean(xs);
  const sigma = precomputed ? precomputed.sigma : (std(xs) || 1);
  return { values: xs.map((x) => (x - mu) / sigma), mu, sigma };
}

// ---- logistic regression (batch gradient descent + L2) -----------------

// Fit P(y=1) = sigmoid(w0 + w·x). X is an array of feature rows (no intercept
// column — it's added internally). Returns {weights, intercept, iters}.
// L2 (ridge) keeps small samples from over-fitting; the intercept is never
// penalised. Deterministic: same inputs -> same weights, no RNG involved.
export function fitLogistic(X, y, { lr = 0.1, l2 = 1e-3, iters = 5000, tol = 1e-8 } = {}) {
  const n = X.length;
  if (!n) return { weights: [], intercept: 0, iters: 0 };
  const d = X[0].length;
  let w = new Array(d).fill(0);
  let b = 0;
  let prevLoss = Infinity;
  let it = 0;
  for (; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    let loss = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const p = sigmoid(z);
      const err = p - y[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      // clipped log-loss for the convergence check
      const pc = Math.min(1 - 1e-12, Math.max(1e-12, p));
      loss += -(y[i] * Math.log(pc) + (1 - y[i]) * Math.log(1 - pc));
    }
    b -= lr * (gb / n);
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    loss = loss / n + 0.5 * l2 * w.reduce((s, x) => s + x * x, 0);
    if (Math.abs(prevLoss - loss) < tol) { it++; break; }
    prevLoss = loss;
  }
  return { weights: w, intercept: b, iters: it };
}

export function predictLogistic(model, X) {
  return X.map((row) => {
    let z = model.intercept;
    for (let j = 0; j < row.length; j++) z += model.weights[j] * row[j];
    return sigmoid(z);
  });
}

// ---- scoring -----------------------------------------------------------

// Lower is better. The proper scoring rules — a model that "wins more" but is
// badly calibrated will lose here, which is exactly what we want to catch.
export function logLoss(yTrue, yProb) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, yProb[i]));
    s += -(yTrue[i] * Math.log(p) + (1 - yTrue[i]) * Math.log(1 - p));
  }
  return s / yTrue.length;
}

export function brierScore(yTrue, yProb) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) s += (yProb[i] - yTrue[i]) ** 2;
  return s / yTrue.length;
}

// Reliability curve: bin predictions and compare mean predicted vs observed
// frequency. A well-calibrated model sits on the diagonal.
export function calibrationBins(yTrue, yProb, nBins = 10) {
  const bins = Array.from({ length: nBins }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (let i = 0; i < yTrue.length; i++) {
    const idx = Math.min(nBins - 1, Math.floor(yProb[i] * nBins));
    bins[idx].n++; bins[idx].sumP += yProb[i]; bins[idx].sumY += yTrue[i];
  }
  return bins.map((b, i) => ({
    bin: i,
    lo: i / nBins,
    hi: (i + 1) / nBins,
    n: b.n,
    predicted: b.n ? b.sumP / b.n : null,
    observed: b.n ? b.sumY / b.n : null,
  }));
}

// ---- bootstrap ---------------------------------------------------------

// Resample rows with replacement `reps` times, recompute `statFn` each time,
// and return the [loPct, hiPct] percentile interval. Seeded, so the interval
// on a given dataset is identical run to run. Use this on ROI and on the
// score DIFFERENCE between two models — a single point estimate lies.
export function bootstrapCI(rows, statFn, { reps = 2000, lo = 2.5, hi = 97.5, seed = 42 } = {}) {
  const n = rows.length;
  const rand = rng(seed);
  const stats = [];
  for (let r = 0; r < reps; r++) {
    const sample = new Array(n);
    for (let i = 0; i < n; i++) sample[i] = rows[Math.floor(rand() * n)];
    stats.push(statFn(sample));
  }
  stats.sort((a, b) => a - b);
  const pick = (p) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor((p / 100) * stats.length)))];
  return { point: statFn(rows), lo: pick(lo), hi: pick(hi), reps };
}
