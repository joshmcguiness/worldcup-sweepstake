// Knockout bracket resolution, ported from the prototype's predictBracket.
// Resolves the real knockout tree: 1A/2B -> group winner/runner-up from
// standings; 3XXXX -> the actual best third once the group stage is complete
// (a 'Best 3rd (…)' placeholder before then); W##/L## -> winner/loser of an
// earlier match. For an unplayed tie the predicted winner is the team with
// shorter odds; once a real score exists it takes over. A LEVEL real score
// (extra time, then penalties) counts as played only when the feed names the
// shootout winner (scores[no].w) — otherwise it stays a prediction.
import { strengthOf, teamOdds } from './teams.js';
import { computeStandings, teamByGroupRank, resolveSlot } from './standings.js';
import { resolveThirdTeams } from './thirds.js';

export function predictBracket(teams, fixtures, scores) {
  const st = computeStandings(teams, fixtures, scores);
  const gmap = teamByGroupRank(st);
  const thirdsByMatch = resolveThirdTeams(teams, fixtures, scores); // null until groups done
  const byNo = {};
  fixtures.forEach((m) => { byNo[m.no] = m; });
  const cache = {};
  function strength(team) { const o = teamOdds(teams, team); return o ? strengthOf(o) : 0; }
  function participant(code, matchNo) {
    if (/^W\d+$/.test(code)) return resolveMatch(+code.slice(1)).winner;
    if (/^L\d+$/.test(code)) return resolveMatch(+code.slice(1)).loser;
    if (code.charAt(0) === '3' && thirdsByMatch && thirdsByMatch[matchNo]) return thirdsByMatch[matchNo];
    return resolveSlot(code, gmap);
  }
  function resolveMatch(no) {
    if (cache[no]) return cache[no];
    cache[no] = { home: '?', away: '?', winner: '?', loser: '?', played: false }; // guard
    const m = byNo[no]; if (!m) return cache[no];
    const home = participant(m.h, no), away = participant(m.a, no);
    let played = false, w, l;
    const s = scores[no];
    if (s && s.h !== '' && s.a !== '' && s.h != null && s.a != null) {
      const hh = Number(s.h), aa = Number(s.a);
      if (hh > aa) { w = home; l = away; played = true; }
      else if (aa > hh) { w = away; l = home; played = true; }
      else if (s.w && (s.w === home || s.w === away)) {
        w = s.w; l = s.w === home ? away : home; played = true; // shootout winner from the feed
      }
    }
    if (!played) {
      if (strength(home) >= strength(away)) { w = home; l = away; }
      else { w = away; l = home; }
    }
    cache[no] = { home, away, winner: w, loser: l, played };
    return cache[no];
  }
  return { resolveMatch, standings: st };
}

// Serializable snapshot of every knockout match, for data.json.
export function bracketSnapshot(teams, fixtures, scores) {
  const sim = predictBracket(teams, fixtures, scores);
  const rounds = {};
  fixtures.filter((m) => m.r >= 4).forEach((m) => {
    const r = sim.resolveMatch(m.no);
    (rounds[m.r] = rounds[m.r] || []).push({
      no: m.no, rn: m.rn, d: m.d, v: m.v,
      home: r.home, away: r.away, winner: r.winner, played: r.played,
    });
  });
  return rounds;
}
