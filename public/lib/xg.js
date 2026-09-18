// xG-style Poisson model for soccer — the PAPER-TRADE (18 Sep 2026).
//
// The backtest (analysis/xg-model.js, analysis/RESULTS.md) showed this model
// beats our Elo by a distance but does NOT beat the closing market (EPL 0.984
// vs 0.963; Championship 1.043 vs 1.032). One thin candidate survived: the
// Championship ">= 55% at the OPENING price" rule (+36% on 21 bets over four
// seasons — a sample, not evidence). Josh: "keep the soccer research alive".
//
// So the model runs live for both soccer codes and LOGS tips with no stake:
// whenever P(side) >= 55% and the early-week price gives >= 3% edge (<= 50%),
// a paper tip is recorded, settled from results, and scored on units + CLV.
// Judged at 40 tips per league. Nothing here touches the bet books.
//
// Team ratings come from football-data.co.uk season CSVs (goals + shots on
// target — fixturedownload has no shots), mapped to feed names via aliases.

export const XG_PARAMS = {
  // per-league parameters chosen on LOG-LOSS in the backtest (never on P/L)
  epl: { halfLife: 240, goalW: 0.7, conv: 0.32, prior: 6, hfa: 1.12, rho: -0.05, minGames: 6 },
  eflc: { halfLife: 150, goalW: 0.3, conv: 0.32, prior: 6, hfa: 1.12, rho: -0.05, minGames: 6 },
};
export const PAPER_RULE = { minProb: 0.55, minEdge: 0.03, maxEdge: 0.5, judgeAt: 40 };

// football-data.co.uk short names -> fixturedownload feed names
const FD_ALIASES = {
  qpr: 'Queens Park Rangers', wolves: 'Wolverhampton Wanderers', spurs: 'Tottenham', tottenham: 'Spurs',
  manunited: 'Man Utd', manutd: 'Man United', nottmforest: "Nott'm Forest",
};
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
export function sameClub(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ax = norm(FD_ALIASES[x] || ''), ay = norm(FD_ALIASES[y] || '');
  return (ax && (ax === y || ax.includes(y) || y.includes(ax))) || (ay && (ay === x || ay.includes(x) || x.includes(ay)));
}

// Parse a football-data.co.uk CSV into match rows (played games only).
export function parseFootballData(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',');
  const out = [];
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    const r = {}; head.forEach((h, i) => { r[h] = c[i]; });
    if (!r.HomeTeam || r.FTHG === '' || r.FTHG == null) continue;
    const [d, m, y] = String(r.Date).split('/').map(Number);
    out.push({ t: Date.UTC(y < 100 ? 2000 + y : y, m - 1, d), home: r.HomeTeam, away: r.AwayTeam,
      hg: +r.FTHG, ag: +r.FTAG, hst: +r.HST || 0, ast: +r.AST || 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

const DAY = 86400e3;
export function fitXg(history, now, P) {
  const teams = {};
  const add = (t) => (teams[t] = teams[t] || { xf: 0, xa: 0, w: 0 });
  let tot = 0, w = 0;
  for (const m of history) {
    if (m.t >= now) continue;
    const wt = Math.exp(-((now - m.t) / DAY) / P.halfLife * Math.LN2);
    const xh = P.goalW * m.hg + (1 - P.goalW) * P.conv * m.hst;
    const xa = P.goalW * m.ag + (1 - P.goalW) * P.conv * m.ast;
    add(m.home); add(m.away);
    teams[m.home].xf += wt * xh; teams[m.home].xa += wt * xa; teams[m.home].w += wt;
    teams[m.away].xf += wt * xa; teams[m.away].xa += wt * xh; teams[m.away].w += wt;
    tot += wt * (xh + xa); w += wt;
  }
  const avg = w ? tot / (2 * w) : 1.3;
  const rate = {};
  for (const [t, v] of Object.entries(teams)) {
    rate[t] = { att: (v.xf + P.prior * avg) / (v.w + P.prior) / avg, def: (v.xa + P.prior * avg) / (v.w + P.prior) / avg, n: v.w };
  }
  return { rate, avg };
}
function poisson(l, k) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function lookup(model, name) {
  if (model.rate[name]) return model.rate[name];
  const k = Object.keys(model.rate).find((t) => sameClub(t, name));
  return k ? model.rate[k] : { att: 1, def: 1, n: 0 };
}
export function predictXg(model, home, away, P) {
  const h = lookup(model, home), a = lookup(model, away);
  const lh = model.avg * h.att * a.def * P.hfa;
  const la = model.avg * a.att * h.def / P.hfa;
  let ph = 0, pd = 0, pa = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    let p = poisson(lh, i) * poisson(la, j);
    if (i === 0 && j === 0) p *= 1 - lh * la * P.rho;
    else if (i === 0 && j === 1) p *= 1 + lh * P.rho;
    else if (i === 1 && j === 0) p *= 1 + la * P.rho;
    else if (i === 1 && j === 1) p *= 1 - P.rho;
    if (i > j) ph += p; else if (i === j) pd += p; else pa += p;
  }
  const s = ph + pd + pa;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { home: r3(ph / s), draw: r3(pd / s), away: r3(pa / s), xgHome: r3(lh), xgAway: r3(la), ready: h.n >= P.minGames && a.n >= P.minGames };
}

// Roll the paper trade for one soccer code: settle open tips from results,
// then log new tips for the next round's games that have a price and no tip
// yet. `matches` = nextRound matches (feed rows), `priceFor(m)` returns
// {home, away, draw} or null (the EARLY price when we have one — the backtest
// edge lives at the open, so that's what we log against).
export function rollPaperTrade(prev, { history, matches, priceFor, results, now = Date.now(), P, code }) {
  const tips = (prev && prev.tips ? prev.tips : []).map((t) => {
    if (t.status !== 'pending') return t;
    const m = (results || []).find((r) => r.MatchNumber === t.no);
    if (!m || m.HomeTeamScore == null || m.AwayTeamScore == null) return t;
    const hs = Number(m.HomeTeamScore), as = Number(m.AwayTeamScore);
    const winner = hs > as ? m.HomeTeam : as > hs ? m.AwayTeam : 'Draw';
    return { ...t, status: winner === t.team ? 'won' : 'lost', finalScore: `${m.HomeTeam} ${hs}–${as} ${m.AwayTeam}` };
  });
  const model = fitXg(history || [], now, P);
  const have = new Set(tips.map((t) => t.no));
  const predictions = [];
  for (const m of matches || []) {
    const p = predictXg(model, m.HomeTeam, m.AwayTeam, P);
    predictions.push({ no: m.MatchNumber, home: m.HomeTeam, away: m.AwayTeam, ...p });
    if (!p.ready || have.has(m.MatchNumber)) continue;
    const prices = priceFor ? priceFor(m) : null;
    if (!prices) continue;
    for (const side of ['home', 'away']) {
      const price = prices[side];
      if (!(price > 1)) continue;
      const edge = Math.round((p[side] * price - 1) * 1000) / 1000;
      if (p[side] >= PAPER_RULE.minProb && edge >= PAPER_RULE.minEdge && edge <= PAPER_RULE.maxEdge) {
        tips.push({
          id: `xg-${code}-${m.MatchNumber}`, no: m.MatchNumber, team: side === 'home' ? m.HomeTeam : m.AwayTeam,
          opp: side === 'home' ? m.AwayTeam : m.HomeTeam, side, prob: p[side], price, edge,
          xg: `${p.xgHome} v ${p.xgAway}`, kickoff: String(m.DateUtc || '').replace(' ', 'T'),
          loggedAt: new Date(now).toISOString(), status: 'pending',
        });
        break; // one tip per match
      }
    }
  }
  const settled = tips.filter((t) => t.status !== 'pending');
  const won = settled.filter((t) => t.status === 'won').length;
  const units = settled.reduce((s, t) => s + (t.status === 'won' ? t.price - 1 : -1), 0);
  const clvs = settled.filter((t) => t.closePrice > 1).map((t) => t.price / t.closePrice - 1);
  return {
    tips: tips.slice(-200), predictions,
    record: { n: settled.length, won, units: Math.round(units * 100) / 100, roi: settled.length ? Math.round(units / settled.length * 1000) / 10 : null,
      clv: clvs.length ? Math.round(clvs.reduce((a, b) => a + b, 0) / clvs.length * 1000) / 10 : null, judgeAt: PAPER_RULE.judgeAt },
    modelGames: Object.values(model.rate).length, updatedAt: new Date(now).toISOString(),
  };
}
