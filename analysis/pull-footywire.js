// AFL Stage 2 data — per-round SuperCoach lineup value from Footywire.
//
// Footywire's supercoach_round?year=Y&round=R page ranks every player who
// PLAYED that round, with the salary that applied to the round (the pre-round
// price you fielded them at — knowable before kickoff) and the round score.
// Summing each team's players' round-salaries gives that team's played-lineup
// value. Because AFL teams are named Thursday and late withdrawals are rare,
// "who played" ≈ "who was named", so this is a near-non-leaky lineup value
// (still an upper bound — labelled as such in RESULTS.md).
//
//   node analysis/pull-footywire.js 2024      # scrape + summarise one season
//
// Row shape parsed: [rank, name, team(nickname), prevSalary, ROUND_SALARY, score, value].

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalAflTeam } from './lib/afl_teams.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache', 'footywire');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchRound(year, round) {
  const file = path.join(CACHE, `fw_sc_${year}_${round}.html`);
  try { const c = await fs.readFile(file, 'utf8'); if (c.length > 2000) return c; } catch { /* miss */ }
  const url = `https://www.footywire.com/afl/footy/supercoach_round?year=${year}&round=${round}`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`FW ${year} r${round}: HTTP ${r.status}`);
  const text = await r.text();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, text);
  return text;
}

const SALARY = /\$([0-9]{3},[0-9]{3})/;
// Parse one salary page -> { teamKey: playedLineupValue } (sum of round salaries).
function parseRound(html) {
  const teamTotals = new Map();
  let players = 0;
  for (const chunk of html.split(/<tr[ >]/i)) {
    if (!SALARY.test(chunk)) continue;
    const cells = [...chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 6) continue;
    const key = canonicalAflTeam(cells[2]);
    const salary = Number((cells[4].match(SALARY) || [])[1]?.replace(',', ''));
    if (!key || !(salary > 0)) continue;
    teamTotals.set(key, (teamTotals.get(key) || 0) + salary);
    players++;
  }
  return { teamTotals, players };
}

// Scrape a whole season: rounds 0..30, stop after 2 straight misses. Returns
// { round: Map<teamKey, value> } for rounds that had data.
export async function footywireSeason(year) {
  const rounds = {};
  let misses = 0;
  for (let r = 0; r <= 30 && misses < 3; r++) {
    let html;
    try { html = await fetchRound(year, r); } catch { misses++; continue; }
    const { teamTotals, players } = parseRound(html);
    if (players < 50) { misses++; continue; } // a real AFL round has ~400 players
    misses = 0;
    rounds[r] = teamTotals;
  }
  return rounds;
}

// Full dataset for several seasons: { [year]: { [round]: Map<teamKey,value> } }.
export async function footywireAfl(seasons) {
  const out = {};
  for (const y of seasons) out[y] = await footywireSeason(y);
  return out;
}

// Attach AFL scDiff to a spine. Footywire salary pages carry no dates, so we
// align by ORDER: cluster each season's matches into rounds (a >3.5-day gap
// starts a new round) and map clustered round i to the i-th Footywire round.
// scDiff = (home lineup value − away) / league-average value that round.
export function attachScDiffAfl(spine, fwData) {
  const bySeason = {};
  for (const r of spine) (bySeason[r.season] ||= []).push(r);
  const scByKey = new Map();
  let attempted = 0, covered = 0;
  for (const [season, matches] of Object.entries(bySeason)) {
    const fw = fwData[season];
    if (!fw) continue;
    const fwRounds = Object.keys(fw).map(Number).sort((a, b) => a - b);
    const sorted = matches.slice().sort((a, b) => a.dateMs - b.dateMs);
    const groups = []; let cur = []; let last = null;
    for (const m of sorted) {
      if (last != null && m.dateMs - last > 3.5 * 86400000) { groups.push(cur); cur = []; }
      cur.push(m); last = m.dateMs;
    }
    if (cur.length) groups.push(cur);
    groups.forEach((g, i) => {
      const fr = fwRounds[i];
      const tv = fr != null ? fw[fr] : null;
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
  const rows = spine.map((r) => {
    const k = `${r.dateMs}|${r.home}|${r.away}`;
    return { ...r, scDiff: scByKey.has(k) ? scByKey.get(k) : null };
  });
  return { rows, coverage: { attempted, covered, pct: attempted ? Math.round(covered / attempted * 100) : 0 } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const year = Number(process.argv[2] || 2024);
  const season = await footywireSeason(year);
  const rounds = Object.keys(season).map(Number).sort((a, b) => a - b);
  console.log(`${year}: ${rounds.length} rounds scraped (${rounds[0]}..${rounds[rounds.length - 1]})`);
  const r = rounds.find((x) => season[x].size === 18) ?? rounds[0];
  const vals = [...season[r].entries()].sort((a, b) => b[1] - a[1]);
  console.log(`round ${r}: ${season[r].size} teams; richest`, vals.slice(0, 3).map(([k, v]) => `${k} ${Math.round(v / 1000)}k`).join(', '));
  console.log(`         poorest`, vals.slice(-3).map(([k, v]) => `${k} ${Math.round(v / 1000)}k`).join(', '));
}
