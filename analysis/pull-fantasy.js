// Stage 2 data — NRL Fantasy player values as they stood BEFORE each match.
//
// Insight that makes this tractable and leak-free: the tspen archive commits
// fantasy.nrl.com/players.json many times a week. The snapshot taken JUST
// BEFORE a match carries, per player, `cost` = the price entering that round
// and `status` = the pre-match availability (playing / injured / suspended /
// not-playing / reserve / uncertain). So one snapshot lookup per match-week
// gives both price and who's-out, with NO round-number alignment and NO actual-
// lineup leak — we only ever read information published before kickoff.
//
// scDiff for a match = (home's best-available-17 value − away's), divided by
// the league-average team value in that same snapshot (scale-free, so the
// growing salary cap across seasons doesn't inject spurious signal).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { squadIdToKey } from './lib/nrl_teams.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSPEN = path.join(HERE, 'cache', 'tspen');
const OUT_STATUSES = new Set(['not-playing', 'injured', 'suspended']); // clearly unavailable
const SQUAD_SIZE = 17;

// commit index: [{ sha, timeMs }] ascending by commit time. Built once.
let COMMITS = null;
function commitIndex() {
  if (COMMITS) return COMMITS;
  const raw = execFileSync('git', ['log', '--format=%H|%cI', '--', 'players.json'], { cwd: TSPEN, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  COMMITS = raw.trim().split('\n').map((l) => {
    const [sha, iso] = l.split('|');
    return { sha, timeMs: Date.parse(iso) };
  }).sort((a, b) => a.timeMs - b.timeMs);
  return COMMITS;
}

// latest commit strictly before `dateMs` (binary search); null if none
export function snapshotShaBefore(dateMs) {
  const c = commitIndex();
  let lo = 0, hi = c.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (c[m].timeMs < dateMs) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans >= 0 ? c[ans].sha : null;
}

const SNAP_CACHE = new Map();
function loadSnapshot(sha) {
  if (SNAP_CACHE.has(sha)) return SNAP_CACHE.get(sha);
  let raw;
  try {
    raw = execFileSync('git', ['show', `${sha}:players.json`], { cwd: TSPEN, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { SNAP_CACHE.set(sha, null); return null; } // unreadable object -> skip
  const j = JSON.parse(raw);
  const players = Array.isArray(j) ? j : Object.values(j);
  // team key -> sorted descending cost list of AVAILABLE players
  const byTeam = new Map();
  for (const p of players) {
    if (OUT_STATUSES.has(p.status)) continue;
    const key = squadIdToKey(p.squad_id);
    if (!key || !(p.cost > 0)) continue;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(p.cost);
  }
  const teamValue = new Map();
  for (const [key, costs] of byTeam) {
    costs.sort((a, b) => b - a);
    teamValue.set(key, costs.slice(0, SQUAD_SIZE).reduce((s, c) => s + c, 0));
  }
  const vals = [...teamValue.values()];
  const leagueAvg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  const out = { teamValue, leagueAvg };
  SNAP_CACHE.set(sha, out);
  return out;
}

// Attach scDiff to each spine row that falls in a season the archive covers
// (2023+). Returns { rows, coverage }. Rows without a usable snapshot get
// scDiff = null (caller excludes them from the M2/M3 comparison).
export function attachScDiff(spine) {
  let covered = 0, attempted = 0;
  const rows = spine.map((r) => {
    if (r.season < 2023) return { ...r, scDiff: null };
    attempted++;
    const sha = snapshotShaBefore(r.dateMs);
    if (!sha) return { ...r, scDiff: null };
    const snap = loadSnapshot(sha);
    if (!snap) return { ...r, scDiff: null };
    const hv = snap.teamValue.get(r.home), av = snap.teamValue.get(r.away);
    if (!(hv > 0) || !(av > 0) || !(snap.leagueAvg > 0)) return { ...r, scDiff: null };
    covered++;
    return { ...r, scDiff: Math.round(((hv - av) / snap.leagueAvg) * 10000) / 10000 };
  });
  return { rows, coverage: { attempted, covered, pct: attempted ? Math.round(covered / attempted * 100) : 0 } };
}

/* ---------- leaky upper-bound: value the players who ACTUALLY PLAYED ----------
 * The proxy above is non-leaky (pre-match availability). This variant instead
 * values each team's PLAYED 17 — a player with a score in round R played it —
 * at their pre-round price prices[R]. Using who-actually-played leaks the small
 * amount of late team news, so it's an UPPER BOUND on the signal, the twin of
 * the AFL Footywire test. One late snapshot per season carries every round. */

const RAW_CACHE = new Map();
function loadSnapshotRaw(sha) {
  if (RAW_CACHE.has(sha)) return RAW_CACHE.get(sha);
  let players = null;
  try {
    const raw = execFileSync('git', ['show', `${sha}:players.json`], { cwd: TSPEN, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(raw);
    players = Array.isArray(j) ? j : Object.values(j);
  } catch { /* unreadable */ }
  RAW_CACHE.set(sha, players);
  return players;
}

// { round: Map<teamKey, playedValue> } from one season-complete snapshot.
function roundLineups(players) {
  const byRound = {};
  for (const p of players || []) {
    const key = squadIdToKey(p.squad_id);
    if (!key || !p.stats) continue;
    const prices = p.stats.prices || {}, scores = p.stats.scores || {};
    for (const rStr of Object.keys(scores)) {
      if (scores[rStr] == null) continue;            // didn't play that round
      const price = Number(prices[rStr]);
      if (!(price > 0)) continue;                    // no price recorded
      const R = Number(rStr);
      (byRound[R] ||= new Map());
      byRound[R].set(key, (byRound[R].get(key) || 0) + price);
    }
  }
  return byRound;
}

export function attachScDiffNrlPlayed(spine) {
  // one season-complete snapshot per season (last commit before mid-October)
  const bySeason = {};
  for (const r of spine) (bySeason[r.season] ||= []).push(r);
  const lineupsBySeason = {};
  for (const season of Object.keys(bySeason)) {
    const sha = snapshotShaBefore(Date.parse(`${season}-10-15T00:00:00Z`));
    lineupsBySeason[season] = sha ? roundLineups(loadSnapshotRaw(sha)) : {};
  }
  const scByKey = new Map();
  let attempted = 0, covered = 0;
  for (const [season, matches] of Object.entries(bySeason)) {
    if (season < 2023) continue;                     // archive starts 2023
    const rounds = lineupsBySeason[season];
    const roundNos = Object.keys(rounds).map(Number).sort((a, b) => a - b);
    const sorted = matches.slice().sort((a, b) => a.dateMs - b.dateMs);
    const groups = []; let cur = []; let last = null;
    for (const m of sorted) {
      if (last != null && m.dateMs - last > 3.5 * 86400000) { groups.push(cur); cur = []; }
      cur.push(m); last = m.dateMs;
    }
    if (cur.length) groups.push(cur);
    groups.forEach((g, i) => {
      const tv = rounds[roundNos[i]];
      const vals = tv ? [...tv.values()] : [];
      const avg = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 0;
      for (const m of g) {
        attempted++;
        if (!tv || !(avg > 0)) continue;
        const hv = tv.get(m.home), av = tv.get(m.away);
        if (!(hv > 0) || !(av > 0)) continue;
        covered++;
        scByKey.set(`${m.dateMs}|${m.home}|${m.away}`, Math.round(((hv - av) / avg) * 10000) / 10000);
      }
    });
  }
  const rows = spine.map((r) => ({ ...r, scDiff: scByKey.has(`${r.dateMs}|${r.home}|${r.away}`) ? scByKey.get(`${r.dateMs}|${r.home}|${r.away}`) : null }));
  return { rows, coverage: { attempted, covered, pct: attempted ? Math.round(covered / attempted * 100) : 0 } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const c = commitIndex();
  console.log(`tspen commit index: ${c.length} snapshots, ${new Date(c[0].timeMs).toISOString().slice(0, 10)} → ${new Date(c[c.length - 1].timeMs).toISOString().slice(0, 10)}`);
  const sha = snapshotShaBefore(Date.parse('2024-06-15T00:00:00Z'));
  const snap = loadSnapshot(sha);
  console.log(`snapshot before 2024-06-15: ${[...snap.teamValue.entries()].length} teams, league avg top-17 value ${Math.round(snap.leagueAvg).toLocaleString()}`);
  console.log('sample team values:', [...snap.teamValue.entries()].slice(0, 4).map(([k, v]) => `${k} ${Math.round(v / 1000)}k`).join(', '));
}
