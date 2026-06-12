// Monte-Carlo tournament projection (handoff §4.6).
// BUILD-JOB ONLY — do not import from app.js. Runs ~30k tournament sims and
// the cached output ships in data.json.
//
// Model:
//  - Single match: Bradley-Terry P(i beats j) = r_i/(r_i+r_j) with
//    r = strength^(1/3) (tempering — title odds are too steep for single
//    games; this lets realistic upsets happen).
//  - Group games draw with ~24% probability; top 2 + 8 best thirds advance,
//    then the real bracket is played out.
//  - Real results always take precedence over sampled ones.
import { strengthOf, teamOdds } from './teams.js';
import { mulberry32 } from './draw.js';
import { BONUS } from './scoring.js';
import { hasScore } from './fixtures.js';
import { assignThirds, thirdSlotsOf } from './thirds.js';

export { assignThirds }; // re-export — historical home of this function

const DRAW_RATE = 0.24;
const TEMPER = 1 / 3;

// Group-table ordering must agree with computeStandings (pts, then GD, then
// GF, then betting strength) so that fully-real groups seed the simulated
// bracket exactly like the site's own standings. The jitter only breaks
// genuine dead heats. Returns a precomputed key per team — comparators must
// stay pure (no rnd() inside sort callbacks).
export function groupKey(pts, gd, gf, rating, jitter) {
  return pts * 1e9 + (gd + 50) * 1e6 + gf * 1e3 + rating + jitter * 1e-3;
}

// opts.darkHorse: {ranks: {team: fifaRank}, candidateCount} — when provided,
// each iteration also crowns a Dark Horse (the deepest-running candidate among
// the candidateCount worst-ranked qualifiers, ties to the worse rank) and the
// result includes per-team and per-player Dark Horse win probabilities.
export function runSim(ctx, { iterations = 30000, seed = 20260611, darkHorse = null } = {}) {
  const { teams, fixtures, scores, players, owners } = ctx;
  const rnd = mulberry32(seed);

  let dhCandidates = null;
  if (darkHorse && darkHorse.ranks) {
    dhCandidates = teams
      .map((t) => ({ team: t.n, rank: darkHorse.ranks[t.n] ?? 999 }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, darkHorse.candidateCount || 24);
  }
  const dhTeamWins = {}, dhPlayerWins = {};

  const r = {}; // tempered Bradley-Terry rating per team
  teams.forEach((t) => { r[t.n] = Math.pow(strengthOf(t.o), TEMPER); });
  const beats = (a, b) => rnd() < r[a] / (r[a] + r[b]);

  const groupMatches = fixtures.filter((m) => m.r <= 3);
  const koMatches = fixtures.filter((m) => m.r >= 4).sort((a, b) => a.no - b.no);
  const thirdSlots = thirdSlotsOf(fixtures);
  const groups = {};
  teams.forEach((t) => { (groups[t.g] = groups[t.g] || []).push(t.n); });
  const stageKeys = ['winGroup', 'last32', 'last16', 'last8', 'last4', 'final', 'champion'];

  const teamCount = {};
  teams.forEach((t) => { teamCount[t.n] = { winGroup: 0, last32: 0, last16: 0, last8: 0, last4: 0, final: 0, champion: 0 }; });
  const playerCount = {};
  players.forEach((p) => { playerCount[p] = { sumLast8: 0, atLeastOneLast8: 0, champion: 0, topPool: 0, spoon: 0 }; });
  const teamsByPlayer = {};
  players.forEach((p) => { teamsByPlayer[p] = teams.map((t) => t.n).filter((n) => owners[n] === p); });

  for (let it = 0; it < iterations; it++) {
    // --- group stage ---
    const pts = {}, gd = {}, gf = {};
    teams.forEach((t) => { pts[t.n] = 0; gd[t.n] = 0; gf[t.n] = 0; });
    for (const m of groupMatches) {
      if (hasScore(scores, m.no)) {
        const s = scores[m.no], h = Number(s.h), a = Number(s.a);
        gd[m.h] += h - a; gd[m.a] += a - h;
        gf[m.h] += h; gf[m.a] += a;
        if (h > a) pts[m.h] += 3; else if (a > h) pts[m.a] += 3; else { pts[m.h]++; pts[m.a]++; }
      } else if (rnd() < DRAW_RATE) {
        pts[m.h]++; pts[m.a]++; gf[m.h]++; gf[m.a]++; // nominal 1-1
      } else if (beats(m.h, m.a)) {
        pts[m.h] += 3; gd[m.h]++; gd[m.a]--; gf[m.h]++; // nominal 1-0
      } else {
        pts[m.a] += 3; gd[m.a]++; gd[m.h]--; gf[m.a]++;
      }
    }
    const key = {}; // precomputed pure sort key per team (jitter drawn once)
    teams.forEach((t) => { key[t.n] = groupKey(pts[t.n], gd[t.n], gf[t.n], r[t.n], rnd()); });
    const gmap = {}; // 'A1' -> team
    const thirds = [];
    for (const g of Object.keys(groups)) {
      const order = groups[g].slice().sort((a, b) => key[b] - key[a]);
      gmap[g + '1'] = order[0]; gmap[g + '2'] = order[1];
      thirds.push({ g, t: order[2] });
    }
    thirds.sort((a, b) => key[b.t] - key[a.t]);
    const best8 = thirds.slice(0, 8);
    const slotGroup = assignThirds(thirdSlots, best8.map((x) => x.g));
    const thirdByGroup = {};
    best8.forEach((x) => { thirdByGroup[x.g] = x.t; });

    // --- knockout ---
    const winner = {}, loser = {};
    const iterStage = {}; // team -> deepest stage this iteration (dark horse)
    if (dhCandidates) {
      for (const k of Object.keys(gmap)) iterStage[gmap[k]] = 1;
      best8.forEach((x) => { iterStage[x.t] = 1; });
    }
    const participant = (code, matchNo) => {
      if (/^W\d+$/.test(code)) return winner[+code.slice(1)];
      if (/^L\d+$/.test(code)) return loser[+code.slice(1)];
      if (code.charAt(0) === '3') return thirdByGroup[slotGroup[matchNo]];
      return gmap[code[1] + code[0]]; // '1A' -> gmap['A1']
    };
    for (const m of koMatches) {
      const home = participant(m.h, m.no), away = participant(m.a, m.no);
      let w, l;
      if (hasScore(scores, m.no)) {
        const s = scores[m.no], hh = Number(s.h), aa = Number(s.a);
        if (hh > aa) { w = home; l = away; }
        else if (aa > hh) { w = away; l = home; }
        else if (s.w && (s.w === home || s.w === away)) {
          w = s.w; l = s.w === home ? away : home; // shootout winner from the feed
        } else if (beats(home, away)) {
          w = home; l = away; // level, winner unknown — propagate the uncertainty
        } else { w = away; l = home; }
      } else if (beats(home, away)) { w = home; l = away; } else { w = away; l = home; }
      winner[m.no] = w; loser[m.no] = l;
      // progression: winning R32 (r=4) -> last16, R16 -> last8, QF -> last4,
      // SF -> final, Final (r=9) -> champion. 3rd-place match (r=8) ignored.
      if (m.r === 4) teamCount[w].last16++;
      else if (m.r === 5) teamCount[w].last8++;
      else if (m.r === 6) teamCount[w].last4++;
      else if (m.r === 7) teamCount[w].final++;
      else if (m.r === 9) teamCount[w].champion++;
      // winner of round r reaches stage r-2 (R32 win -> Last 16 = 2 ... SF win
      // -> Final = 5); the final's winner is Champion = 6. 3rd place ignored.
      if (dhCandidates && m.r !== 8) iterStage[w] = m.r === 9 ? 6 : m.r - 2;
    }
    if (dhCandidates) {
      let dh = null, dhKey = -Infinity;
      for (const c of dhCandidates) {
        const key = (iterStage[c.team] || 0) * 1e4 + c.rank;
        if (key > dhKey) { dhKey = key; dh = c; }
      }
      dhTeamWins[dh.team] = (dhTeamWins[dh.team] || 0) + 1;
      const o = owners[dh.team];
      if (o) dhPlayerWins[o] = (dhPlayerWins[o] || 0) + 1;
    }
    for (const k of Object.keys(gmap)) {
      teamCount[gmap[k]].last32++;
      if (k[1] === '1') teamCount[gmap[k]].winGroup++;
    }
    best8.forEach((x) => { teamCount[x.t].last32++; });

    // --- per-player tallies ---
    const last8ByPlayer = {};
    koMatches.forEach((m) => { if (m.r === 5) { const o = owners[winner[m.no]]; if (o) last8ByPlayer[o] = (last8ByPlayer[o] || 0) + 1; } });
    players.forEach((p) => {
      const c = last8ByPlayer[p] || 0;
      playerCount[p].sumLast8 += c;
      if (c > 0) playerCount[p].atLeastOneLast8++;
    });
    const champOwner = owners[winner[104]];
    if (champOwner && playerCount[champOwner]) playerCount[champOwner].champion++;

    // Pool outcome: total = group pts + knockout bonus (same scoring as
    // poolRows), tie-break on summed GD then a coin flip. Top wins the main
    // prize, bottom takes the wooden spoon.
    const bonusByPlayer = {};
    koMatches.forEach((m) => { if (BONUS[m.r]) { const o = owners[winner[m.no]]; if (o) bonusByPlayer[o] = (bonusByPlayer[o] || 0) + BONUS[m.r]; } });
    let top = null, bot = null, topKey = -Infinity, botKey = Infinity;
    players.forEach((p) => {
      let gp = 0, pgd = 0;
      teamsByPlayer[p].forEach((t) => { gp += pts[t]; pgd += gd[t]; });
      const key = (gp + (bonusByPlayer[p] || 0)) * 1e6 + pgd * 1e3 + rnd();
      if (key > topKey) { topKey = key; top = p; }
      if (key < botKey) { botKey = key; bot = p; }
    });
    playerCount[top].topPool++;
    playerCount[bot].spoon++;
  }

  const simTeams = {};
  teams.forEach((t) => {
    simTeams[t.n] = { owner: owners[t.n] || '', odds: teamOdds(teams, t.n) };
    stageKeys.forEach((k) => { simTeams[t.n][k] = teamCount[t.n][k] / iterations; });
  });
  const simPlayers = {};
  players.forEach((p) => {
    simPlayers[p] = {
      expLast8: playerCount[p].sumLast8 / iterations,
      pAtLeastOneLast8: playerCount[p].atLeastOneLast8 / iterations,
      pChampion: playerCount[p].champion / iterations,
      pTopPool: playerCount[p].topPool / iterations,
      pSpoon: playerCount[p].spoon / iterations,
    };
    if (dhCandidates) simPlayers[p].pDarkHorse = (dhPlayerWins[p] || 0) / iterations;
  });
  const out = { iterations, seed, teams: simTeams, players: simPlayers };
  if (dhCandidates) {
    out.darkHorseTeams = {};
    dhCandidates.forEach((c) => { out.darkHorseTeams[c.team] = (dhTeamWins[c.team] || 0) / iterations; });
  }
  return out;
}
