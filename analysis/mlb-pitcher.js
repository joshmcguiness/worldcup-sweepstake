// MLB starting-pitcher model — the backtest harness (5 Oct 2026).
//
// Josh: "how do we build around pitchers?" This answers whether a pitcher-aware
// runs model beats (a) the team Elo we run today and (b) the closing market.
//
// Data (free, static):
//   Retrosheet game logs gl2023-gl2025.txt — every game: date, teams, scores,
//     STARTING PITCHERS (cols 102-105), team batting/pitching lines.
//   mlb_odds_dataset.json (ArnavSaraogi/mlb-odds-scraper, SportsBookReview) —
//     opening + closing money lines per book, 2021-03 .. 2025-08-16.
//
//   node analysis/mlb-pitcher.js <dir>
//
// Model (per game, fitted only from games BEFORE it, time-decayed):
//   offence_t  = team runs scored / game, shrunk to league average
//   starter_p  = runs allowed by his team in HIS starts / game, shrunk hard
//                (game logs are team-level; the starter throws ~60% of innings,
//                so this is a deliberately noisy proxy for a FIP-style rating)
//   staff_t    = team runs allowed / game overall (bullpen + defence + rotation)
//   exp runs home = L * offence_home * (w*starter_away + (1-w)*staff_away) * hfa
//   P(home) from independent Poisson run totals (ties -> extra innings, 50/50)
// w = 0 is the pitcher-blind control. Parameters chosen on LOG-LOSS, never P/L.

import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
if (!DIR) { console.error('usage: node analysis/mlb-pitcher.js <dir>'); process.exit(1); }

// Retrosheet team codes -> SportsBookReview short names
const CODE = { LAN: 'LAD', CHN: 'CHC', NYA: 'NYY', NYN: 'NYM', SLN: 'STL', SFN: 'SF', SDN: 'SD', KCA: 'KC', ANA: 'LAA', TBA: 'TB', CHA: 'CWS', WAS: 'WSH', OAK: 'OAK', ATH: 'ATH' };
const sbr = (c) => CODE[c] || c;
const ALT = { ATH: ['OAK', 'ATH'], OAK: ['OAK', 'ATH'] };

function csvLine(l) { // retrosheet: quoted strings, bare numbers
  const out = []; let cur = '', q = false;
  for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out;
}
function loadLogs() {
  const games = [];
  for (const y of [2023, 2024, 2025]) {
    const f = path.join(DIR, `gl${y}.txt`);
    if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue;
      const c = csvLine(l);
      const d = c[0];
      games.push({
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, t: Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)),
        gameNo: +c[1], away: c[3], home: c[6], as: +c[9], hs: +c[10],
        awayStarter: c[101], homeStarter: c[103], awayStarterName: c[102], homeStarterName: c[104],
      });
    }
  }
  return games.sort((a, b) => a.t - b.t || a.gameNo - b.gameNo);
}
const amer = (o) => (o == null ? null : o > 0 ? 1 + o / 100 : 1 + 100 / -o);
function loadOdds() {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'mlb_odds_dataset.json'), 'utf8'));
  const byKey = {};
  for (const [date, list] of Object.entries(raw)) {
    for (const g of list) {
      const gv = g.gameView || {};
      if (gv.gameType && gv.gameType !== 'R') continue;
      const ml = (g.odds && g.odds.moneyline) || [];
      const avg = (pick) => { const h = [], a = []; ml.forEach((b) => { const L = b[pick]; if (L && L.homeOdds != null && L.awayOdds != null) { h.push(amer(L.homeOdds)); a.push(amer(L.awayOdds)); } }); return h.length ? { home: h.reduce((x, y) => x + y) / h.length, away: a.reduce((x, y) => x + y) / a.length } : null; };
      const key = `${date}|${gv.awayTeam && gv.awayTeam.shortName}|${gv.homeTeam && gv.homeTeam.shortName}`;
      (byKey[key] = byKey[key] || []).push({ start: gv.startDate, open: avg('openingLine'), close: avg('currentLine') });
    }
  }
  for (const k of Object.keys(byKey)) byKey[k].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return byKey;
}
function oddsFor(byKey, g) {
  const aways = ALT[g.away] || [sbr(g.away)], homes = ALT[g.home] || [sbr(g.home)];
  for (const a of aways) for (const h of homes) {
    const list = byKey[`${g.date}|${a}|${h}`];
    if (list && list.length) return list[Math.min(list.length - 1, Math.max(0, g.gameNo - 1))] || list[0];
  }
  return null;
}

// ---------- model ----------
const DAY = 86400e3;
function poisson(l, k) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function winProb(lh, la) {
  let ph = 0, pt = 0;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) { const p = poisson(lh, i) * poisson(la, j); if (i > j) ph += p; else if (i === j) pt += p; }
  return ph + 0.5 * pt;
}
function run(games, byKey, P, opts = {}) {
  // running, decayed accumulators: {sum, w} keyed by team / starter
  const off = {}, staff = {}, starter = {};
  let lgSum = 0, lgW = 0;
  const acc = (o, k) => (o[k] = o[k] || { s: 0, w: 0, last: 0 });
  const decayed = (a, now) => { const f = Math.exp(-((now - a.last) / DAY) / P.halfLife * Math.LN2); return { s: a.s * f, w: a.w * f }; };
  const rate = (a, now, prior, avg) => { const d = decayed(a, now); return (d.s + prior * avg) / (d.w + prior) / avg; };
  let n = 0, ll = 0, right = 0, mll = 0, mn = 0, naiveLl = 0, homeW = 0;
  const bets = [];
  const bySeason = {};
  for (const g of games) {
    const avg = lgW ? lgSum / lgW : 4.5; // league runs per team-game
    const o = oddsFor(byKey, g);
    const ready = lgW > P.warm;
    if (ready) {
      const expH = avg * rate(acc(off, g.home), g.t, P.priorOff, avg)
        * (P.w * rate(acc(starter, g.awayStarter), g.t, P.priorSp, avg) + (1 - P.w) * rate(acc(staff, g.away), g.t, P.priorOff, avg)) * P.hfa;
      const expA = avg * rate(acc(off, g.away), g.t, P.priorOff, avg)
        * (P.w * rate(acc(starter, g.homeStarter), g.t, P.priorSp, avg) + (1 - P.w) * rate(acc(staff, g.home), g.t, P.priorOff, avg)) / P.hfa;
      const ph = winProb(expH, expA);
      const res = g.hs > g.as;
      n++; if (res) homeW++;
      ll += -Math.log(res ? ph : 1 - ph);
      if ((ph >= 0.5) === res) right++;
      naiveLl += -Math.log(res ? 0.53 : 0.47);
      const season = g.date.slice(0, 4);
      bySeason[season] = bySeason[season] || { n: 0, ll: 0, mll: 0, mn: 0, right: 0 };
      bySeason[season].n++; bySeason[season].ll += -Math.log(res ? ph : 1 - ph); if ((ph >= 0.5) === res) bySeason[season].right++;
      if (o && o.close) {
        const k = 1 / o.close.home + 1 / o.close.away;
        const mh = (1 / o.close.home) / k;
        mll += -Math.log(res ? mh : 1 - mh); mn++;
        bySeason[season].mll += -Math.log(res ? mh : 1 - mh); bySeason[season].mn++;
        const at = opts.at === 'open' && o.open ? o.open : o.close;
        for (const [side, p, price, mk] of [['home', ph, at.home, mh], ['away', 1 - ph, at.away, 1 - mh]]) {
          const edge = p * price - 1;
          let ok = false;
          if (opts.rule === 'value55') ok = p >= 0.55 && edge >= 0.03 && edge <= 0.5;
          else if (opts.rule === 'fav') ok = p >= 0.60 && mk >= 0.60 && edge >= 0.03;
          else if (opts.rule === 'value') ok = p >= 0.50 && edge >= 0.03 && edge <= 0.5;
          if (ok) bets.push({ season, side, p, price, mk, won: side === 'home' ? res : !res });
        }
      }
    }
    // update accumulators with this game (after predicting it)
    const upd = (a, v, now) => { const d = decayed(a, now); a.s = d.s + v; a.w = d.w + 1; a.last = now; };
    upd(acc(off, g.home), g.hs, g.t); upd(acc(off, g.away), g.as, g.t);
    upd(acc(staff, g.home), g.as, g.t); upd(acc(staff, g.away), g.hs, g.t);
    upd(acc(starter, g.homeStarter), g.as, g.t); upd(acc(starter, g.awayStarter), g.hs, g.t);
    const lf = Math.exp(-((g.t - (run.lgLast || g.t)) / DAY) / P.halfLife * Math.LN2);
    lgSum = lgSum * lf + g.hs + g.as; lgW = lgW * lf + 2; run.lgLast = g.t;
  }
  const w = bets.filter((b) => b.won).length;
  const pl = bets.reduce((s, b) => s + (b.won ? b.price - 1 : -1), 0);
  return { n, ll: ll / n, acc: right / n, mll: mn ? mll / mn : null, mn, naive: naiveLl / n, home: homeW / n, bets: bets.length, w, pl, roi: bets.length ? pl / bets.length : 0, bySeason };
}

const games = loadLogs();
const byKey = loadOdds();
const matched = games.filter((g) => oddsFor(byKey, g)).length;
console.log(`games ${games.length} (2023-25) · with odds ${matched} · odds data ends 2025-08-16`);

const BASE = { halfLife: 365, priorOff: 30, priorSp: 12, hfa: 1.04, w: 0.6, warm: 400 };
let best = null;
const grid = [];
for (const w of [0, 0.4, 0.6, 0.8]) for (const priorSp of [6, 12, 25]) for (const halfLife of [180, 365, 730]) {
  const P = { ...BASE, w, priorSp, halfLife };
  const r = run(games, byKey, P);
  grid.push({ P, r });
  if (!best || r.ll < best.r.ll) best = { P, r };
}
const blind = grid.filter((x) => x.P.w === 0).reduce((a, b) => (b.r.ll < a.r.ll ? b : a));
console.log(`\nPITCHER-BLIND control (w=0): log-loss ${blind.r.ll.toFixed(4)} · picks ${(blind.r.acc * 100).toFixed(1)}%`);
console.log(`BEST pitcher-aware: w ${best.P.w} starterPrior ${best.P.priorSp} halfLife ${best.P.halfLife}d -> log-loss ${best.r.ll.toFixed(4)} · picks ${(best.r.acc * 100).toFixed(1)}%  (n=${best.r.n})`);
console.log(`CLOSING MARKET (de-vigged, ${best.r.mn} games): log-loss ${best.r.mll.toFixed(4)} · naive ${best.r.naive.toFixed(4)} · home win ${(best.r.home * 100).toFixed(1)}%`);
console.log('by season:', Object.entries(best.r.bySeason).map(([s, v]) => `${s} model ${(v.ll / v.n).toFixed(4)} (${(v.right / v.n * 100).toFixed(1)}%) mkt ${v.mn ? (v.mll / v.mn).toFixed(4) : '—'}`).join(' | '));
console.log('w sweep (best per w):', [0, 0.4, 0.6, 0.8].map((w) => { const b = grid.filter((x) => x.P.w === w).reduce((a, c) => (c.r.ll < a.r.ll ? c : a)); return `w=${w}: ${b.r.ll.toFixed(4)}`; }).join(' · '));
console.log(`\nGATE: beats the closing market -> ${best.r.ll < best.r.mll ? 'YES' : 'NO (market is ' + (best.r.ll - best.r.mll).toFixed(4) + ' better)'}`);
for (const at of ['close', 'open']) for (const rule of ['fav', 'value55', 'value']) {
  const b = run(games, byKey, best.P, { rule, at });
  console.log(`  bets @ ${at.toUpperCase()} '${rule}': ${b.bets} bets, ${b.w}W-${b.bets - b.w}L, P/L ${b.pl.toFixed(1)}u, ROI ${(b.roi * 100).toFixed(1)}%`);
}
console.log('\nCaveat: starter ratings here are team-runs-in-his-starts (game logs have no per-pitcher lines). A true FIP/xFIP rating from play-by-play or Savant would be the next step IF this shows a pulse.');
