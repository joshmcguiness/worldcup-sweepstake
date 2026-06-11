// Best-third resolution, shared by the bracket (real results), the dark-horse
// standing and the Monte-Carlo sim.
import { computeStandings } from './standings.js';
import { groupsComplete } from './fixtures.js';

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

export function thirdSlotsOf(fixtures) {
  return fixtures
    .filter((m) => m.r >= 4 && m.a.charAt(0) === '3')
    .map((m) => ({ no: m.no, allowed: m.a.slice(1).split('') }));
}

// Once all 72 group games are real, resolve which actual third-placed team
// fills each '3XXXX' slot: best 8 thirds by the standings composite
// (pts, gd, gf, strength), matched to slots by allowed group.
// Returns {matchNo: teamName} or null while the group stage is incomplete.
export function resolveThirdTeams(teams, fixtures, scores) {
  if (!groupsComplete(fixtures, scores)) return null;
  const st = computeStandings(teams, fixtures, scores);
  const best8 = Object.values(st)
    .filter((x) => x.rank === 3)
    .sort((a, b) => b.comp - a.comp)
    .slice(0, 8);
  const slotGroup = assignThirds(thirdSlotsOf(fixtures), best8.map((x) => x.g));
  const teamByGroup = {};
  best8.forEach((x) => { teamByGroup[x.g] = x.n; });
  const out = {};
  Object.entries(slotGroup).forEach(([no, g]) => { out[no] = teamByGroup[g]; });
  return out;
}
