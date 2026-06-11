// Side pots: Golden Boot, Dark Horse, Chaos Pot.
// All pure functions over the shared ctx {teams, fixtures, scores, owners, ...}
// plus the admin config (config/sidepots.json) and config/rankings.json.
import { computeStandings } from './standings.js';
import { predictBracket } from './bracket.js';
import { hasScore, groupsComplete } from './fixtures.js';

export { groupsComplete };

export const STAGES = ['Group', 'Last 32', 'Last 16', 'Last 8', 'Last 4', 'Final', 'Champion'];
// round number -> stage a PARTICIPANT of that round has reached
export const STAGE_OF_ROUND = { 4: 1, 5: 2, 6: 3, 7: 4, 9: 5 };

// Furthest stage each team has ACTUALLY reached (real results only, no
// prediction). Knockout credit is only handed out once all 72 group games are
// played — before that, bracket slots resolve from partial standings and a
// feed glitch could credit the wrong team. Group qualification: top 2 per
// group + the 8 best thirds (pts, gd, gf — same composite as the standings)
// are 'Last 32'. Winning a played knockout tie (including on penalties, via
// the feed's Winner field) advances a stage. The 3rd-place play-off does not
// affect progression.
export function stageReached(teams, fixtures, scores) {
  const stage = {};
  teams.forEach((t) => { stage[t.n] = 0; });
  if (!groupsComplete(fixtures, scores)) return stage;
  const st = computeStandings(teams, fixtures, scores);
  Object.values(st).forEach((x) => { if (x.rank <= 2) stage[x.n] = 1; });
  Object.values(st).filter((x) => x.rank === 3)
    .sort((a, b) => b.comp - a.comp).slice(0, 8)
    .forEach((x) => { stage[x.n] = 1; });
  const sim = predictBracket(teams, fixtures, scores);
  fixtures.filter((m) => m.r >= 4 && m.r !== 8).forEach((m) => {
    const r = sim.resolveMatch(m.no);
    if (!r.played) return;
    const reach = STAGE_OF_ROUND[m.r];
    [r.home, r.away].forEach((t) => { if (stage[t] != null) stage[t] = Math.max(stage[t], reach); });
    if (stage[r.winner] != null) stage[r.winner] = Math.max(stage[r.winner], reach + 1);
  });
  return stage;
}

/* ---------- Dark Horse ----------
 * All 48 teams are listed (worst FIFA rank first, deepest run first), but
 * only the `candidateCount` lowest-FIFA-ranked are ELIGIBLE to win — without
 * that cut the prize would degenerate to "the champion's owner". The eligible
 * team that reaches the deepest stage wins; ties go to the worse-ranked team.
 * Owners come from the main draw — no extra allocation. */
export function darkHorseStanding(ctx, ranksCfg, { candidateCount = 24 } = {}) {
  const ranks = ranksCfg.ranks || {};
  const stage = stageReached(ctx.teams, ctx.fixtures, ctx.scores);
  const gDone = groupsComplete(ctx.fixtures, ctx.scores);
  const lostKO = new Set();
  if (gDone) {
    const sim = predictBracket(ctx.teams, ctx.fixtures, ctx.scores);
    ctx.fixtures.filter((m) => m.r >= 4 && m.r !== 8).forEach((m) => {
      const r = sim.resolveMatch(m.no);
      if (r.played && r.loser) lostKO.add(r.loser);
    });
  }
  const ranked = ctx.teams
    .map((t) => ({ team: t.n, rank: ranks[t.n] ?? 999, owner: ctx.owners[t.n] || '' }))
    .sort((a, b) => b.rank - a.rank);
  const eligibleSet = new Set(ranked.slice(0, candidateCount).map((c) => c.team));
  const rows = ranked
    .map((c) => ({
      ...c,
      eligible: eligibleSet.has(c.team),
      stage: stage[c.team],
      stageLabel: STAGES[stage[c.team]],
      alive: !lostKO.has(c.team) && (!gDone || stage[c.team] >= 1),
    }))
    .sort((a, b) => b.stage - a.stage || b.rank - a.rank);
  const eligible = rows.filter((r) => r.eligible);
  const leader = eligible.length && eligible[0].stage > 0 ? eligible[0] : null;
  // Settled only once a real champion exists (a drawn final without a known
  // shootout winner must NOT settle the pot) — or when every eligible
  // candidate is out, at which point no result can change the standing.
  const haveChampion = Object.values(stage).some((s) => s === 6);
  const decided = haveChampion || (eligible.length > 0 && eligible.every((r) => !r.alive));
  return { candidateCount, rows, leader, decided };
}

/* ---------- Golden Boot ----------
 * Each participant drew FIVE strikers (one per odds tier); most combined
 * tournament goals wins the pot. Goals come from the build job's scorer feed
 * when available, with config goalsOverride always taking precedence (manual
 * admin corrections). */

// Diacritic/punctuation-insensitive name key so "Vinicius Junior" from a feed
// matches our "Vinícius Júnior".
function nameKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
}

export function goldenBootRows(gbCfg, scorerGoals = {}) {
  const over = {}, feed = {};
  Object.entries(gbCfg.goalsOverride || {}).forEach(([n, g]) => { over[nameKey(n)] = g; });
  Object.entries(scorerGoals).forEach(([n, g]) => { feed[nameKey(n)] = g; });
  const goalsOf = (name) => {
    const k = nameKey(name);
    return over[k] != null ? over[k] : (feed[k] ?? 0);
  };
  return Object.entries(gbCfg.assignments || {})
    .map(([participant, fs]) => {
      const list = Array.isArray(fs) ? fs : [fs]; // tolerate the old single-striker shape
      const strikers = list.map((f) => ({ name: f.name, team: f.team, goals: goalsOf(f.name) }));
      return {
        participant,
        strikers,
        total: strikers.reduce((s, x) => s + x.goals, 0),
      };
    })
    .sort((a, b) => b.total - a.total || a.participant.localeCompare(b.participant));
}

export function goldenBootPot(gbCfg) {
  return (Number(gbCfg.entryFeeAUD) || 0) * Object.keys(gbCfg.assignments || {}).length;
}

/* ---------- Chaos Pot ----------
 * Events come from the ESPN auto-feed plus admin entries in
 * config/sidepots.json; points per event type are configurable. The TEAM with
 * the most chaos points wins — its owner takes the pot. */
export const CHAOS_TYPES = ['ownGoal', 'redCard', 'penaltyMiss', 'gkGoal'];
export const CHAOS_LABEL = { ownGoal: 'Own goal', redCard: 'Red card', penaltyMiss: 'Penalty miss', gkGoal: 'Goalkeeper goal' };
export const CHAOS_DEFAULT_POINTS = { ownGoal: 3, redCard: 2, penaltyMiss: 2, gkGoal: 10 };

// autoEvents (from the ESPN feed) and the manual chaosCfg.events both count;
// a manual event with a negative count cancels a wrong auto-detection.
export function chaosRows(chaosCfg, ctx, autoEvents = []) {
  const pts = chaosCfg.points || CHAOS_DEFAULT_POINTS;
  const tally = {};
  [...autoEvents, ...(chaosCfg.events || [])].forEach((e) => {
    if (!CHAOS_TYPES.includes(e.type)) return;
    if (!tally[e.team]) { tally[e.team] = { ownGoal: 0, redCard: 0, penaltyMiss: 0, gkGoal: 0 }; }
    tally[e.team][e.type] += e.count || 1;
  });
  return Object.keys(tally)
    .map((team) => {
      const t = tally[team];
      const points = CHAOS_TYPES.reduce((s, k) => s + t[k] * (pts[k] || 0), 0);
      return { team, owner: ctx.owners[team] || '', ...t, points };
    })
    .sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));
}
