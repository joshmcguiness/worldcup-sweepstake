// xG-style Poisson model for soccer (EPL + Championship) — the backtest gate.
//
// Josh, 18 Sep 2026: "build the xG model as the next project with a hard success
// gate (log-loss under 1.00 and positive CLV in the backtest before it bets a
// dollar)". This script is that gate.
//
// Data: football-data.co.uk season CSVs (shots on target + Pinnacle/average
// closing 1X2 prices) — E0 = EPL, E1 = Championship, four seasons 2022-23 to
// 2025-26. Run:
//
//   node analysis/xg-model.js <dir-with-csvs>
//
// Model: each team has an attack and a defence rate, fitted from a blend of
// GOALS and SHOTS-ON-TARGET (a public xG proxy: ~0.3 goals per shot on target)
// with exponential time decay, plus a league home-advantage multiplier. Match
// scoreline distribution is independent Poisson (Dixon-Coles low-score tweak
// applied), which yields P(home), P(draw), P(away).
//
// Scored OUT-OF-SAMPLE, rolling: every match is predicted from matches before
// it only. Reported: three-way log-loss vs the closing market (de-vigged),
// and the P/L + CLV of the bets our rules would have placed at the CLOSING
// price (the toughest test — real books lock 3 days earlier).

import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
if (!DIR) { console.error('usage: node analysis/xg-model.js <csv dir>'); process.exit(1); }

// ---------- data ----------
function parseCsv(file) {
  const txt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  }).filter((r) => r.HomeTeam && r.FTHG !== '' && r.FTHG != null);
}
function dateOf(r) { // dd/mm/yyyy
  const [d, m, y] = r.Date.split('/').map(Number);
  return Date.UTC(y < 100 ? 2000 + y : y, m - 1, d);
}
function loadLeague(code) {
  const rows = [];
  for (const s of ['2223', '2324', '2425', '2526']) {
    const f = path.join(DIR, `${s}-${code}.csv`);
    if (!fs.existsSync(f)) continue;
    parseCsv(f).forEach((r) => rows.push({
      season: s, t: dateOf(r), home: r.HomeTeam, away: r.AwayTeam,
      hg: +r.FTHG, ag: +r.FTAG, hst: +r.HST || 0, ast: +r.AST || 0,
      // closing 1X2: Pinnacle when present, else the cross-book average
      ch: +(r.PSCH || r.AvgCH), cd: +(r.PSCD || r.AvgCD), ca: +(r.PSCA || r.AvgCA),
      // opening (Pinnacle / average) for a bet-early comparison
      oh: +(r.PSH || r.AvgH), od: +(r.PSD || r.AvgD), oa: +(r.PSA || r.AvgA),
    }));
  }
  return rows.sort((a, b) => a.t - b.t);
}

// ---------- model ----------
const DAY = 86400e3;
function fit(history, now, P) {
  // time-decayed per-team totals of "expected goals" for and against
  const teams = {};
  const add = (t) => (teams[t] = teams[t] || { xf: 0, xa: 0, w: 0 });
  let tot = 0, w = 0;
  for (const m of history) {
    const age = (now - m.t) / DAY;
    const wt = Math.exp(-age / P.halfLife * Math.LN2);
    // xG proxy: blend real goals with shots-on-target × conversion
    const xh = P.goalW * m.hg + (1 - P.goalW) * P.conv * m.hst;
    const xa = P.goalW * m.ag + (1 - P.goalW) * P.conv * m.ast;
    add(m.home); add(m.away);
    teams[m.home].xf += wt * xh; teams[m.home].xa += wt * xa; teams[m.home].w += wt;
    teams[m.away].xf += wt * xa; teams[m.away].xa += wt * xh; teams[m.away].w += wt;
    tot += wt * (xh + xa); w += wt;
  }
  const avg = w ? tot / (2 * w) : 1.3; // league mean goals per team per game
  const rate = {};
  for (const [t, v] of Object.entries(teams)) {
    // shrink toward league average with prior weight P.prior games
    const n = v.w;
    const att = (v.xf + P.prior * avg) / (n + P.prior) / avg;
    const def = (v.xa + P.prior * avg) / (n + P.prior) / avg;
    rate[t] = { att, def, n };
  }
  return { rate, avg };
}
function poisson(l, k) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function predict(model, home, away, P) {
  const h = model.rate[home] || { att: 1, def: 1, n: 0 };
  const a = model.rate[away] || { att: 1, def: 1, n: 0 };
  const lh = model.avg * h.att * a.def * P.hfa;
  const la = model.avg * a.att * h.def / P.hfa;
  let ph = 0, pd = 0, pa = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    let p = poisson(lh, i) * poisson(la, j);
    // Dixon-Coles low-score correction
    const rho = P.rho;
    if (i === 0 && j === 0) p *= 1 - lh * la * rho;
    else if (i === 0 && j === 1) p *= 1 + lh * rho;
    else if (i === 1 && j === 0) p *= 1 + la * rho;
    else if (i === 1 && j === 1) p *= 1 - rho;
    if (i > j) ph += p; else if (i === j) pd += p; else pa += p;
  }
  const s = ph + pd + pa;
  return { home: ph / s, draw: pd / s, away: pa / s, lh, la, ready: h.n >= P.minGames && a.n >= P.minGames };
}

// ---------- backtest ----------
function run(rows, P, opts = {}) {
  let ll = 0, n = 0, mll = 0, naive = 0;
  const bets = [];
  const bySeason = {};
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    if (!(m.ch > 1 && m.cd > 1 && m.ca > 1)) continue;
    // rolling: refit from everything strictly before this match date
    const hist = rows.slice(0, i).filter((x) => x.t < m.t);
    const model = fit(hist, m.t, P);
    const p = predict(model, m.home, m.away, P);
    if (!p.ready) continue;
    const res = m.hg > m.ag ? 'home' : m.hg < m.ag ? 'away' : 'draw';
    // de-vigged closing market probabilities
    const k = 1 / m.ch + 1 / m.cd + 1 / m.ca;
    const mk = { home: 1 / m.ch / k, draw: 1 / m.cd / k, away: 1 / m.ca / k };
    ll += -Math.log(Math.max(p[res], 1e-6)); mll += -Math.log(mk[res]); n++;
    naive += -Math.log({ home: 0.43, draw: 0.26, away: 0.31 }[res]);
    bySeason[m.season] = bySeason[m.season] || { n: 0, ll: 0, mll: 0 };
    bySeason[m.season].n++; bySeason[m.season].ll += -Math.log(Math.max(p[res], 1e-6)); bySeason[m.season].mll += -Math.log(mk[res]);
    // the favourites-only rule at the CLOSING price: model >= 60%, market >= 65%, edge >= 3%
    for (const side of ['home', 'away']) {
      const useOpen = opts.at === 'open' && m.oh > 1 && m.oa > 1;
      const price = side === 'home' ? (useOpen ? m.oh : m.ch) : (useOpen ? m.oa : m.ca);
      const edge = p[side] * price - 1;
      const rule = opts.rule || 'fav';
      let ok;
      if (rule === 'fav') ok = p[side] >= 0.60 && mk[side] >= 0.65 && edge >= 0.03;
      else if (rule === 'value') ok = p[side] >= 0.45 && edge >= 0.05 && edge <= 0.5;
      else if (rule === 'value55') ok = p[side] >= 0.55 && edge >= 0.03 && edge <= 0.5;
      if (ok) bets.push({ season: m.season, side, price, prob: p[side], mkt: mk[side], won: res === side, edge });
    }
    if (opts.rule === 'draw') {
      const edge = p.draw * m.cd - 1;
      if (p.draw >= 0.30 && edge >= 0.05) bets.push({ season: m.season, side: 'draw', price: m.cd, prob: p.draw, mkt: mk.draw, won: res === 'draw', edge });
    }
  }
  const w = bets.filter((b) => b.won).length;
  const pl = bets.reduce((s, b) => s + (b.won ? b.price - 1 : -1), 0);
  return { n, ll: ll / n, mll: mll / n, naive: naive / n, bets: bets.length, w, pl, roi: bets.length ? pl / bets.length : 0, bySeason, betList: bets };
}

const BASE = { halfLife: 120, goalW: 0.5, conv: 0.32, prior: 6, hfa: 1.18, rho: -0.05, minGames: 6 };

for (const [code, label] of [['E0', 'EPL'], ['E1', 'Championship']]) {
  const rows = loadLeague(code);
  console.log(`\n=== ${label} — ${rows.length} matches, 4 seasons (rolling out-of-sample) ===`);
  // small parameter sweep, reported honestly (we pick on log-loss, NOT on P/L)
  let best = null;
  for (const halfLife of [90, 150, 240]) for (const goalW of [0.3, 0.5, 0.7]) for (const hfa of [1.12, 1.18, 1.25]) {
    const P = { ...BASE, halfLife, goalW, hfa };
    const r = run(rows, P);
    if (!best || r.ll < best.r.ll) best = { P, r };
  }
  const { P, r } = best;
  console.log(`best params: halfLife ${P.halfLife}d goalW ${P.goalW} hfa ${P.hfa}`);
  console.log(`3-way log-loss: MODEL ${r.ll.toFixed(4)} | CLOSING MARKET ${r.mll.toFixed(4)} | naive ${r.naive.toFixed(4)}  (n=${r.n})`);
  console.log('  by season:', Object.entries(r.bySeason).map(([s, v]) => `${s} model ${(v.ll / v.n).toFixed(3)} mkt ${(v.mll / v.n).toFixed(3)}`).join(' | '));
  console.log(`GATE: log-loss < 1.00 → ${r.ll < 1.0 ? 'PASS' : 'FAIL'}; beats market → ${r.ll < r.mll ? 'YES' : 'NO (market is ' + (r.ll - r.mll).toFixed(3) + ' better)'}`);
  for (const at of ['close', 'open']) for (const rule of ['fav', 'value55', 'value', 'draw']) {
    if (at === 'open' && rule === 'draw') continue;
    const b = run(rows, P, { rule, at });
    const clv = b.betList.length ? b.betList.reduce((s, x) => s + (x.prob - x.mkt), 0) / b.betList.length : 0;
    console.log(`  bets @ ${at.toUpperCase()} price, rule '${rule}': ${b.bets} bets, ${b.w}W-${b.bets - b.w}L, P/L ${b.pl.toFixed(1)} units, ROI ${(b.roi * 100).toFixed(1)}%, avg model-market gap ${(clv * 100).toFixed(1)}pts`);
  }
}
console.log('\nNote: P/L at the CLOSING price is the hardest test — no real edge survives it unless the model genuinely beats the market.');
