// Model vs Market — the value scanner. For every upcoming priced match it
// lays the model's probabilities next to the bookmakers' (margin removed),
// and for the outright market it compares the sim's bracket-aware champion
// odds with the raw market-implied numbers. This is the "is the price right?"
// view: positive edge means the model thinks the market is paying too much.
import { strengthOf, decOdds } from './teams.js';
import { hasScore } from './fixtures.js';
import { predictBracket } from './bracket.js';
import { matchProbs } from './bets.js';

export function modelMarket(ctx, sim, marketOdds, now = Date.now()) {
  const { teams, fixtures, scores } = ctx;
  const bracket = predictBracket(teams, fixtures, scores);
  const matches = [];
  for (const m of fixtures) {
    if (hasScore(scores, m.no) || Date.parse(m.d) <= now) continue;
    const mkt = marketOdds[m.no];
    if (!mkt) continue;
    const isGroup = m.r <= 3;
    const r = isGroup ? { home: m.h, away: m.a } : bracket.resolveMatch(m.no);
    if (r.home === '?' || r.away === '?' || r.home.includes('Best 3rd') || r.away.includes('Best 3rd')) continue;
    const p = matchProbs(teams, r.home, r.away, isGroup);
    if (!p) continue;
    // strip the bookmaker margin: fair implied prob = (1/odds) / overround
    const inv = 1 / mkt.home + 1 / mkt.away + (isGroup && mkt.draw ? 1 / mkt.draw : 0);
    const out = [];
    const push = (label, prob, odds) => {
      if (!odds) return;
      const model = Math.round(prob * 1000) / 1000;
      out.push({
        pick: label,
        model,
        odds,
        implied: Math.round((1 / odds / inv) * 1000) / 1000,
        edge: Math.round((model * odds - 1) * 1000) / 1000, // from the displayed prob, so the table is self-consistent
      });
    };
    push(r.home, p.home, mkt.home);
    if (isGroup && mkt.draw) push('Draw', p.draw, mkt.draw);
    push(r.away, p.away, mkt.away);
    matches.push({
      no: m.no, rn: m.rn, g: m.g, d: m.d,
      match: `${r.home} v ${r.away}`,
      overround: Math.round((inv - 1) * 1000) / 1000,
      outcomes: out,
    });
  }
  matches.sort((a, b) => Date.parse(a.d) - Date.parse(b.d));

  // Outrights: sim (knows the bracket paths) vs the market's implied chance.
  const totalStrength = teams.reduce((s, t) => s + strengthOf(t.o), 0);
  const outrights = teams
    .map((t) => {
      const model = Math.round((sim?.teams?.[t.n]?.champion ?? 0) * 1000) / 1000;
      const odds = Math.round(decOdds(t.o) * 100) / 100;
      return {
        team: t.n,
        odds,
        model,
        implied: Math.round((strengthOf(t.o) / totalStrength) * 1000) / 1000,
        edge: Math.round((model * odds - 1) * 1000) / 1000,
      };
    })
    .filter((x) => x.model >= 0.004 || x.implied >= 0.004)
    .sort((a, b) => b.model - a.model);

  return { matches, outrights };
}
