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

const DRAW_RATE = 0.24;
const TEMPER = 1 / 3;

function hasScore(scores, no) {
  const s = scores[no];
  return s && s.h !== '' && s.a !== '' && s.h != null && s.a != null;
}

// Assign the 8 best thirds to the 8 third-place slots, honouring each slot's
// allowed groups (e.g. '3CEFHI'). Backtracking finds a perfect matching when
// one exists; if the drawn combination has none, fall back to greedy.
export function assignThirds(slots, thirdGroups) {
  const remaining = new Set(thirdGroups);
  const order = slots.slice().sort((a, b) => a.allowed.length - b.allowed.length);
  const assignment = {};
  function bt(i) {
    if (i === order.length) return true;
    const slot = order[i];
    for (const g of slot.allowed) {
      if (remaining.has(g)) {
        remaining.delete(g);
        assignment[slot.no] = g;
        if (bt(i + 1)) return true;
        remaining.add(g);
        delete assignment[slot.no];
      }
    }
    return false;
  }
  if (!bt(0)) {
    // No perfect matching for this combination — greedy fallback.
    const left = Array.from(remaining);
    order.forEach((slot) => {
      if (assignment[slot.no]) return;
      const pick = slot.allowed.find((g) => left.includes(g)) ?? left[0];
      assignment[slot.no] = pick;
      left.splice(left.indexOf(pick), 1);
    });
  }
  return assignment;
}

export function runSim(ctx, { iterations = 30000, seed = 20260611 } = {}) {
  const { teams, fixtures, scores, players, owners } = ctx;
  const rnd = mulberry32(seed);

  const r = {}; // tempered Bradley-Terry rating per team
  teams.forEach((t) => { r[t.n] = Math.pow(strengthOf(t.o), TEMPER); });
  const beats = (a, b) => rnd() < r[a] / (r[a] + r[b]);

  const groupMatches = fixtures.filter((m) => m.r <= 3);
  const koMatches = fixtures.filter((m) => m.r >= 4).sort((a, b) => a.no - b.no);
  const thirdSlots = koMatches
    .filter((m) => m.a.charAt(0) === '3')
    .map((m) => ({ no: m.no, allowed: m.a.slice(1).split('') }));
  const groups = {};
  teams.forEach((t) => { (groups[t.g] = groups[t.g] || []).push(t.n); });
  const stageKeys = ['last32', 'last16', 'last8', 'last4', 'final', 'champion'];

  const teamCount = {};
  teams.forEach((t) => { teamCount[t.n] = { last32: 0, last16: 0, last8: 0, last4: 0, final: 0, champion: 0 }; });
  const playerCount = {};
  players.forEach((p) => { playerCount[p] = { sumLast8: 0, atLeastOneLast8: 0, champion: 0 }; });

  for (let it = 0; it < iterations; it++) {
    // --- group stage ---
    const pts = {}, gd = {};
    teams.forEach((t) => { pts[t.n] = 0; gd[t.n] = 0; });
    for (const m of groupMatches) {
      if (hasScore(scores, m.no)) {
        const s = scores[m.no], h = Number(s.h), a = Number(s.a);
        gd[m.h] += h - a; gd[m.a] += a - h;
        if (h > a) pts[m.h] += 3; else if (a > h) pts[m.a] += 3; else { pts[m.h]++; pts[m.a]++; }
      } else if (rnd() < DRAW_RATE) {
        pts[m.h]++; pts[m.a]++;
      } else if (beats(m.h, m.a)) {
        pts[m.h] += 3; gd[m.h]++; gd[m.a]--;
      } else {
        pts[m.a] += 3; gd[m.a]++; gd[m.h]--;
      }
    }
    const gmap = {}; // 'A1' -> team
    const thirds = [];
    for (const g of Object.keys(groups)) {
      const order = groups[g].slice().sort((a, b) =>
        (pts[b] * 1e6 + gd[b] * 1e3 + r[b] * 10 + rnd()) - (pts[a] * 1e6 + gd[a] * 1e3 + r[a] * 10 + rnd()));
      gmap[g + '1'] = order[0]; gmap[g + '2'] = order[1];
      thirds.push({ g, t: order[2] });
    }
    thirds.sort((a, b) =>
      (pts[b.t] * 1e6 + gd[b.t] * 1e3 + r[b.t] * 10 + rnd()) - (pts[a.t] * 1e6 + gd[a.t] * 1e3 + r[a.t] * 10 + rnd()));
    const best8 = thirds.slice(0, 8);
    const slotGroup = assignThirds(thirdSlots, best8.map((x) => x.g));
    const thirdByGroup = {};
    best8.forEach((x) => { thirdByGroup[x.g] = x.t; });

    // --- knockout ---
    const winner = {}, loser = {};
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
        const s = scores[m.no];
        if (Number(s.h) > Number(s.a)) { w = home; l = away; } else { w = away; l = home; }
      } else if (beats(home, away)) { w = home; l = away; } else { w = away; l = home; }
      winner[m.no] = w; loser[m.no] = l;
      // progression: winning R32 (r=4) -> last16, R16 -> last8, QF -> last4,
      // SF -> final, Final (r=9) -> champion. 3rd-place match (r=8) ignored.
      if (m.r === 4) teamCount[w].last16++;
      else if (m.r === 5) teamCount[w].last8++;
      else if (m.r === 6) teamCount[w].last4++;
      else if (m.r === 7) teamCount[w].final++;
      else if (m.r === 9) teamCount[w].champion++;
    }
    for (const k of Object.keys(gmap)) teamCount[gmap[k]].last32++;
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
    };
  });
  return { iterations, seed, teams: simTeams, players: simPlayers };
}
