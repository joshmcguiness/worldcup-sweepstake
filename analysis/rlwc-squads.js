// Rugby League World Cup 2026 — squad strength from NRL Fantasy season averages.
//
// Josh (15 Oct 2026): "analyse the teams and look at the players to see how
// they match up". Squads from Wikipedia (config/rlwc-squads-raw.json),
// player quality from the end-of-2026 NRL Fantasy averages in the tspen
// archive (analysis/cache/tspen/players.json, round 27). Non-NRL players get
// a league discount (Super League / Championship ~0.75 of an NRL starter,
// state cup / local ~0.55) — an assumption, stated, not measured.
//
// Writes config/rlwc-squads.json: per nation the matched players, average
// quality, a squad-strength index (sum of the best 17), and an Elo prior
// (1500 + 120 × z-score), which the build blends 50/50 with the 2021-based
// Elo until real tournament results take over.
//
//   node analysis/rlwc-squads.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const squads = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config', 'rlwc-squads-raw.json'), 'utf8'));
const players = JSON.parse(fs.readFileSync(path.join(HERE, 'cache', 'tspen', 'players.json'), 'utf8'));

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const byName = new Map();
for (const p of players) {
  const st = p.stats || {};
  if (!(st.games_played >= 1)) continue;
  byName.set(norm(`${p.first_name} ${p.last_name}`), { avg: st.avg_points, games: st.games_played, last3: st.last_3_avg });
}
// a few fantasy-site spellings
const FIX = { 'tino faasuamaleaui': 'tino faasuamaleaui', 'jeremy marshallking': 'jeremy marshall king' };
const NRL_CLUBS = /Broncos|Raiders|Bulldogs|Sharks|Dolphins|Titans|Sea Eagles|Storm|Knights|Warriors|Cowboys|Eels|Panthers|Rabbitohs|Dragons|Roosters|Wests Tigers/;
const SL_CLUBS = /Wigan|St Helens|Leeds|Warrington|Hull|Catalans|Huddersfield|Castleford|Wakefield|Leigh|Salford|Toulouse|Bradford|York|Featherstone|Widnes|London Broncos|Oldham|Sheffield/;
const NRL_STARTER = 42; // median fantasy average of a regular NRL starter (2026, 10+ games)

const out = {};
const rows = [];
for (const [nation, list] of Object.entries(squads)) {
  const seen = new Set();
  const squad = [];
  for (const pl of list) {
    const n = norm(pl.name);
    if (seen.has(n)) continue; seen.add(n);
    if (squad.length >= 24) break;
    const f = byName.get(FIX[n] || n) || byName.get(n.split(' ').slice(0, 1).concat(n.split(' ').slice(-1)).join(' '));
    let quality, source;
    if (f && f.games >= 3) { quality = f.avg; source = 'nrl'; }
    else if (NRL_CLUBS.test(pl.club)) { quality = NRL_STARTER * 0.7; source = 'nrl-fringe'; }
    else if (SL_CLUBS.test(pl.club)) { quality = NRL_STARTER * 0.75; source = 'super-league'; }
    else { quality = NRL_STARTER * 0.55; source = 'local'; }
    squad.push({ name: pl.name, club: pl.club, quality: Math.round(quality * 10) / 10, source, games: f ? f.games : null });
  }
  squad.sort((a, b) => b.quality - a.quality);
  const best17 = squad.slice(0, 17);
  const strength = best17.reduce((s, p) => s + p.quality, 0);
  const nrl = squad.filter((p) => p.source === 'nrl');
  out[nation] = { strength: Math.round(strength), best17Avg: Math.round(strength / 17 * 10) / 10, nrlMatched: nrl.length, nrlAvg: nrl.length ? Math.round(nrl.reduce((s, p) => s + p.quality, 0) / nrl.length * 10) / 10 : null, squad };
  rows.push([nation, out[nation]]);
}
const strengths = rows.map(([, v]) => v.strength);
const mean = strengths.reduce((a, b) => a + b, 0) / strengths.length;
const sd = Math.sqrt(strengths.reduce((a, b) => a + (b - mean) ** 2, 0) / strengths.length);
for (const [nation, v] of rows) { v.z = Math.round((v.strength - mean) / sd * 100) / 100; v.eloPrior = Math.round(1500 + 120 * v.z); }
rows.sort((a, b) => b[1].strength - a[1].strength);
console.log('nation              strength  best17avg  NRL-matched  NRL avg   z     Elo prior   top 3');
for (const [n, v] of rows) console.log(n.padEnd(20), String(v.strength).padEnd(9), String(v.best17Avg).padEnd(10), String(v.nrlMatched).padEnd(12), String(v.nrlAvg).padEnd(9), String(v.z).padEnd(6), String(v.eloPrior).padEnd(11), v.squad.slice(0, 3).map((p) => `${p.name} ${p.quality}`).join(', '));
const cfg = { generatedAt: new Date().toISOString(), source: 'Wikipedia squads + NRL Fantasy 2026 averages (tspen, round 27)', assumptions: { nrlStarter: NRL_STARTER, superLeague: 0.75, nrlFringe: 0.7, local: 0.55, eloPerSd: 120, blendWithHistory: 0.5 }, nations: Object.fromEntries(rows.map(([n, v]) => [n, { strength: v.strength, best17Avg: v.best17Avg, nrlMatched: v.nrlMatched, nrlAvg: v.nrlAvg, z: v.z, eloPrior: v.eloPrior, top: v.squad.slice(0, 6) }])) };
fs.writeFileSync(path.join(HERE, '..', 'config', 'rlwc-squads.json'), JSON.stringify(cfg, null, 1));
console.log('\nwrote config/rlwc-squads.json');
