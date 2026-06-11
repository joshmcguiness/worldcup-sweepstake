// Pool scoring, wild-card tallies, win odds and prize table — ported from the
// prototype. All functions take a `ctx`:
//   { teams, fixtures, players, owners, scores, buyIn, split }
import { strengthOf, teamOdds } from './teams.js';
import { computeStandings } from './standings.js';
import { predictBracket } from './bracket.js';

// Knockout bonus per WIN, keyed by round number:
// R32 +4, R16 +6, QF +8, SF +10, 3rd-place +5, Final +12.
export const BONUS = { 4: 4, 5: 6, 6: 8, 7: 10, 8: 5, 9: 12 };
export const BONUS_LABEL = { 4: 'Win R32', 5: 'Win R16', 6: 'Win QF', 7: 'Win SF', 8: 'Win 3rd-place', 9: 'Win Final' };

export function teamsOf(ctx, p) {
  return ctx.teams.map((t) => t.n).filter((n) => ctx.owners[n] === p);
}

// Bonus points per team from knockout ties that have actually been played.
export function computeBonus(ctx) {
  const sim = predictBracket(ctx.teams, ctx.fixtures, ctx.scores);
  const tb = {};
  ctx.fixtures.forEach((m) => {
    if (m.r >= 4) {
      const r = sim.resolveMatch(m.no);
      if (r.played && BONUS[m.r]) tb[r.winner] = (tb[r.winner] || 0) + BONUS[m.r];
    }
  });
  return tb;
}

// Player total = sum of their teams' group points + knockout bonus.
export function poolRows(ctx) {
  const st = computeStandings(ctx.teams, ctx.fixtures, ctx.scores);
  const tb = computeBonus(ctx);
  return ctx.players.map((p) => {
    const ts = teamsOf(ctx, p);
    let gp = 0, gd = 0, gf = 0, ga = 0, adv = 0, bonus = 0;
    ts.forEach((t) => {
      const x = st[t];
      gp += x.pts; gd += x.gd; gf += x.gf; ga += x.ga;
      if (x.rank <= 2) adv++;
      bonus += tb[t] || 0;
    });
    return { p, n: ts.length, gp, bonus, total: gp + bonus, gd, gf, ga, adv };
  }).sort((a, b) => b.total - a.total || b.gd - a.gd);
}

export function wildRows(ctx) {
  const st = computeStandings(ctx.teams, ctx.fixtures, ctx.scores);
  return ctx.players.map((p) => {
    let gf = 0, ga = 0;
    teamsOf(ctx, p).forEach((t) => { if (st[t]) { gf += st[t].gf; ga += st[t].ga; } });
    return { p, gf, ga };
  });
}

// Bookmaker-implied chance each player owns the tournament winner,
// normalised so the whole pool adds up to 100%.
export function winRows(ctx) {
  const raw = {};
  let total = 0;
  ctx.teams.forEach((t) => { raw[t.n] = strengthOf(t.o); total += raw[t.n]; });
  return ctx.players.map((p) => {
    let r = 0, best = null;
    teamsOf(ctx, p).forEach((t) => {
      r += raw[t];
      if (best === null || teamOdds(ctx.teams, t) < teamOdds(ctx.teams, best)) best = t;
    });
    return { p, n: teamsOf(ctx, p).length, best, prob: total ? r / total : 0 };
  }).sort((a, b) => b.prob - a.prob);
}

export function rankIn(arr, p) {
  for (let i = 0; i < arr.length; i++) if (arr[i].p === p) return i + 1;
  return '-';
}

export function prizeTable(ctx) {
  const pot = (Number(ctx.buyIn) || 0) * ctx.players.length;
  const pr = poolRows(ctx);
  const wf = wildRows(ctx).slice().sort((a, b) => b.gf - a.gf);
  const sp = ctx.split;
  return [
    { key: 'winner', label: '🥇 Winner (top of Pool)', pct: sp.winner, amount: pot * sp.winner / 100, leader: pr[0] ? pr[0].p : '' },
    { key: 'runner', label: '🥈 Runner-up', pct: sp.runner, amount: pot * sp.runner / 100, leader: pr[1] ? pr[1].p : '' },
    { key: 'goals', label: '⚽ Most Goals For', pct: sp.goals, amount: pot * sp.goals / 100, leader: (wf[0] && wf[0].gf > 0) ? wf[0].p : '' },
    { key: 'spoon', label: '🥄 Wooden spoon (last)', pct: sp.spoon, amount: pot * sp.spoon / 100, leader: pr.length ? pr[pr.length - 1].p : '' },
  ];
}

/* ---------- display helpers shared by frontend ---------- */
export function probFrac(p) {
  if (!p) return '—';
  const net = 1 / p - 1;
  const t = Math.round(net * 2);
  if (t <= 0) return 'odds-on';
  return t % 2 === 0 ? t / 2 + '-1' : t + '-2';
}

export function amer(o) {
  if (!o) return '';
  const t = Math.round(o / 50);
  if (t <= 0) return 'odds-on';
  return t % 2 === 0 ? t / 2 + '-1' : t + '-2';
}

export function aud(x) {
  return 'A$' + (Number(x) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
