// MLB pitcher-and-lineup calls (8 Oct 2026) — the judgement model, codified.
//
// Josh: "make tipping recommendations with your best available knowledge ...
// predicted pitcher and starting lineup ... and continue to do this moving
// forward." So the hand-built reasoning from the Division Series becomes a
// daily routine. Inputs are fetched in build/refresh.js from the public MLB
// Stats API (no key): probable starters + their season line and L/R splits,
// the posted lineup (handedness) or, before it is posted, the team's split
// against the starter's hand, team offence, and the last three days of
// bullpen usage from box scores. Prices come from The Odds API (or ESPN's
// scoreboard line as a fallback).
//
// PAPER ONLY. The pitcher backtest (analysis/mlb-pitcher.js) could not beat the
// closing market, so these calls carry no stake: they are logged in units,
// settled from the Stats API (postseason included — the fixture feed has no
// playoffs), and judged at 60 calls. All functions here are pure.

export const MLB_RULE = { minProb: 0.55, minEdge: 0.03, maxEdge: 0.5, judgeAt: 60 };
const LEAGUE_FIP = 4.10, LEAGUE_RPG = 4.45, HFA = 1.04;

const r3 = (x) => Math.round(x * 1000) / 1000;
function poisson(l, k) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
export function winProb(lh, la) {
  let ph = 0, pt = 0;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) { const p = poisson(lh, i) * poisson(la, j); if (i > j) ph += p; else if (i === j) pt += p; }
  return ph + 0.5 * pt;
}

// A starter's run-prevention factor from his season line (shrunk toward league
// by innings) and the share of the game he typically covers.
export function starterFactor(sp) {
  if (!sp || !(sp.ip > 0)) return { factor: 1.0, share: 0.55, fip: null, note: 'starter TBD — bullpen game assumed' };
  const fip = (13 * sp.hr + 3 * (sp.bb + (sp.hbp || 0)) - 2 * sp.so) / sp.ip + 3.1;
  const shrunk = (fip * sp.ip + LEAGUE_FIP * 60) / (sp.ip + 60);
  const share = Math.min(7, Math.max(3, sp.ip / Math.max(1, sp.gs))) / 9;
  return { factor: r3(shrunk / LEAGUE_FIP), share: r3(share), fip: r3(fip) };
}

// Platoon: how the lineup it faces hits that hand. Posted lineup -> weight the
// starter's own OPS-allowed splits by the lineup's handedness; otherwise the
// team's season OPS against that hand.
export function platoonFactor(sp, lineup, teamSplit, teamOps) {
  const base = teamOps > 0 ? teamOps : 0.72;
  if (lineup && lineup.length && sp && sp.vsL && sp.vsR) {
    const left = lineup.filter((b) => b.bats === 'L' || (b.bats === 'S' && sp.hand === 'R')).length;
    const mix = left / lineup.length;
    const opsAllowed = mix * sp.vsL.ops + (1 - mix) * sp.vsR.ops;
    const spAll = (sp.vsL.ops * sp.vsL.pa + sp.vsR.ops * sp.vsR.pa) / Math.max(1, sp.vsL.pa + sp.vsR.pa);
    return { factor: r3(spAll > 0 ? opsAllowed / spAll : 1), note: `${left} of ${lineup.length} bats from the left` };
  }
  if (teamSplit && teamSplit.ops > 0) return { factor: r3(teamSplit.ops / base), note: `team hits ${sp && sp.hand === 'L' ? 'lefties' : 'righties'} at ${teamSplit.ops.toFixed(3)}` };
  return { factor: 1, note: null };
}

// Bullpen fatigue from the last three days: arms that threw 25+ pitches
// yesterday, 15+ on each of the last two days, or appeared three days running.
export function bullpenFatigue(usage, today) {
  const DAY = 86400e3;
  const byArm = {};
  // age in US calendar days: the game's US date (kickoff minus 8h) vs the usage game's date
  const todayDay = Math.floor((today - 8 * 3600e3) / DAY);
  for (const u of usage || []) {
    if (u.role !== 'RP') continue;
    const age = todayDay - Math.floor(u.t / DAY);
    if (age < 1 || age > 3) continue;
    (byArm[u.name] = byArm[u.name] || {})[age] = (byArm[u.name][age] || 0) + (u.pitches || 0);
  }
  const tired = [];
  for (const [name, d] of Object.entries(byArm)) {
    if ((d[1] || 0) >= 25 || ((d[1] || 0) >= 15 && (d[2] || 0) >= 15) || (d[1] && d[2] && d[3])) tired.push(name);
  }
  return { factor: r3(1 + Math.min(0.15, 0.03 * tired.length)), tired };
}

// One game -> probability + the reasons, from pre-fetched inputs.
export function evaluateGame(g) {
  const sh = starterFactor(g.homeSP), sa = starterFactor(g.awaySP);
  const ph = platoonFactor(g.awaySP, g.homeLineup, g.homeTeam.vs[g.awaySP && g.awaySP.hand === 'L' ? 'L' : 'R'], g.homeTeam.ops);
  const pa = platoonFactor(g.homeSP, g.awayLineup, g.awayTeam.vs[g.homeSP && g.homeSP.hand === 'L' ? 'L' : 'R'], g.awayTeam.ops);
  const bh = bullpenFatigue(g.homeUsage, g.t), ba = bullpenFatigue(g.awayUsage, g.t);
  const offH = (g.homeTeam.rpg || LEAGUE_RPG) / LEAGUE_RPG, offA = (g.awayTeam.rpg || LEAGUE_RPG) / LEAGUE_RPG;
  const expH = LEAGUE_RPG * offH * ph.factor * (sa.share * sa.factor + (1 - sa.share) * ba.factor) * HFA;
  const expA = LEAGUE_RPG * offA * pa.factor * (sh.share * sh.factor + (1 - sh.share) * bh.factor) / HFA;
  const p = winProb(expH, expA);
  const name = (sp) => (sp ? sp.name : 'TBD');
  const reasons = [
    `${name(g.homeSP)}${sh.fip != null ? ` (FIP ${sh.fip.toFixed(2)}, ${(sh.share * 9).toFixed(1)} IP/start)` : ''} v ${name(g.awaySP)}${sa.fip != null ? ` (FIP ${sa.fip.toFixed(2)}, ${(sa.share * 9).toFixed(1)} IP/start)` : ''}`,
    ph.note ? `${g.home} lineup: ${ph.note}` : null, pa.note ? `${g.away} lineup: ${pa.note}` : null,
    bh.tired.length ? `${g.home} pen tired: ${bh.tired.join(', ')}` : null, ba.tired.length ? `${g.away} pen tired: ${ba.tired.join(', ')}` : null,
    `offence ${g.home} ${(g.homeTeam.rpg || 0).toFixed(2)} R/G, ${g.away} ${(g.awayTeam.rpg || 0).toFixed(2)} R/G`,
  ].filter(Boolean);
  return { home: r3(p), away: r3(1 - p), expHome: r3(expH), expAway: r3(expA), reasons };
}

// Daily roll: settle pending calls from results, add calls for upcoming games
// (one per game, once), keep a record in units.
export function rollMlbTips(prev, { games, results, now = Date.now() }) {
  const tips = (prev && prev.tips ? prev.tips : []).map((t) => {
    if (t.status !== 'pending') return t;
    const r = (results || {})[t.gamePk];
    if (!r || !r.final) return t;
    if (r.hs === r.as) return { ...t, status: 'void', finalScore: `${r.hs}–${r.as}` };
    const winner = r.hs > r.as ? 'home' : 'away';
    return { ...t, status: winner === t.side ? 'won' : 'lost', finalScore: `${t.side === 'home' ? t.opp : t.team} ${r.as}–${r.hs} ${t.side === 'home' ? t.team : t.opp}`.replace(/^(.*) (\d+)–(\d+) (.*)$/, (m, a, x, y, b) => `${a} ${x}–${y} ${b}`) };
  });
  const have = new Set(tips.map((t) => t.gamePk));
  const preview = [];
  for (const g of games || []) {
    const ev = evaluateGame(g);
    const side = ev.home >= ev.away ? 'home' : 'away';
    const prob = ev[side];
    const price = g.prices ? g.prices[side] : null;
    const edge = price > 1 ? r3(prob * price - 1) : null;
    const qualifies = prob >= MLB_RULE.minProb && edge != null && edge >= MLB_RULE.minEdge && edge <= MLB_RULE.maxEdge;
    preview.push({ gamePk: g.gamePk, home: g.home, away: g.away, kickoff: g.kickoff, pick: side === 'home' ? g.home : g.away, prob, price, edge, qualifies, reasons: ev.reasons });
    if (have.has(g.gamePk) || !qualifies || Date.parse(g.kickoff) <= now) continue;
    tips.push({
      id: `mlb-sp-${g.gamePk}`, gamePk: g.gamePk, side, team: side === 'home' ? g.home : g.away, opp: side === 'home' ? g.away : g.home,
      prob, price, edge, kickoff: g.kickoff, reasons: ev.reasons, source: 'model', loggedAt: new Date(now).toISOString(), status: 'pending',
    });
  }
  const settled = tips.filter((t) => t.status === 'won' || t.status === 'lost');
  const won = settled.filter((t) => t.status === 'won').length;
  const staked = settled.filter((t) => t.price > 1);
  const units = staked.reduce((s, t) => s + (t.status === 'won' ? t.price - 1 : -1), 0);
  return {
    tips: tips.slice(-300), preview,
    record: { n: settled.length, won, units: r3(units), roi: staked.length ? Math.round(units / staked.length * 1000) / 10 : null, judgeAt: MLB_RULE.judgeAt },
    updatedAt: new Date(now).toISOString(),
  };
}
