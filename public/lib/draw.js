// Expected-value balanced draw, ported verbatim from the prototype's doDrawCore.
// NOTE: in the hosted version the draw is FROZEN — config/draw.json stores the
// explicit team -> owner map and the build job never re-draws. This module is
// kept (and tested) so the draw can be reproduced/audited from the seed.
import { strengthOf } from './teams.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rnd) {
  arr = arr.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Deal teams strongest-first to whoever has the weakest hand so far.
// Counts stay within 1 of each other; everyone ends up with roughly equal
// total win-probability regardless of how many teams they hold.
// `teams` is [{n, o}] — name + American odds.
export function doDrawCore(players, teams, seed) {
  const rnd = mulberry32(seed);
  const N = players.length, T = teams.length, owners = {};
  if (N <= 0) return owners;
  const oddsOf = {};
  teams.forEach((t) => { oddsOf[t.n] = t.o; });
  const P = shuffle(players.slice(), rnd);
  const base = Math.floor(T / N);
  let extra = T % N; // 'extra' players will end with base+1 teams
  const sorted = teams.map((t) => t.n).sort((a, b) => strengthOf(oddsOf[b]) - strengthOf(oddsOf[a]));
  const tot = {}, cnt = {};
  P.forEach((p) => { tot[p] = 0; cnt[p] = 0; });
  sorted.forEach((t) => {
    const s = strengthOf(oddsOf[t]);
    let pick = null, pk = Infinity;
    P.forEach((p) => {
      const eligible = cnt[p] < base || (cnt[p] === base && extra > 0);
      if (!eligible) return;
      const key = tot[p] + rnd() * 1e-12; // weakest hand wins, tiny jitter breaks ties
      if (key < pk) { pk = key; pick = p; }
    });
    if (pick === null) { P.forEach((p) => { if (pick === null && cnt[p] < base + 1) pick = p; }); }
    if (cnt[pick] === base) extra--; // consumed one of the base+1 slots
    owners[t] = pick; tot[pick] += s; cnt[pick]++;
  });
  return owners;
}
