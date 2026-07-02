// Pull NRL / AFL results + closing exchange odds from the free Betfair Data
// Scientists CSVs (betfair-datascientists.github.io) — the cleanest source
// that carries the match outcome AND a near-vig-free closing price in one file,
// 2021-2026. Two rows per match (one per runner); we fold them into one record.
//
//   node analysis/pull-betfair.js nrl        # download + summarise (default nrl)
//   node analysis/pull-betfair.js afl
//   import { pullBetfairNrl, pullBetfairAfl } from './pull-betfair.js'
//
// Prices used: BEST_BACK / BEST_LAY at FIRST_BOUNCE = the price at kickoff =
// the exchange CLOSE. Their midpoint, de-vigged across the two runners, is our
// market probability — the honest bar the model has to beat (roadmap §3.0).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalTeam } from './lib/nrl_teams.js';
import { canonicalAflTeam } from './lib/afl_teams.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const SEASONS = [2021, 2022, 2023, 2024, 2025, 2026];
export const NRL_SEASONS = SEASONS; // back-compat

// Per-code differences: the file prefix, the team matcher, and whether a
// representative window applies (Origin for NRL; nothing for AFL, which also
// allows genuine home-and-away draws).
const LEAGUES = {
  nrl: { code: 'NRL', team: canonicalTeam, origin: (ms) => nrlOriginWindow(ms) },
  afl: { code: 'AFL', team: canonicalAflTeam, origin: () => false },
};

// minimal RFC-ish CSV line splitter (handles quoted fields; our files are simple)
function splitCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function fetchCsv(code, season) {
  const file = path.join(CACHE, `${code.toLowerCase()}_bf_${season}.csv`);
  try {
    const cached = await fs.readFile(file, 'utf8');
    if (cached.length > 500) return cached;
  } catch { /* not cached yet */ }
  const url = `https://betfair-datascientists.github.io/data/assets/${code}_${season}_Match_Odds.csv`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`Betfair ${code} ${season}: HTTP ${r.status}`);
  const text = await r.text();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, text);
  return text;
}

// Betfair stamps dates several ways across codes/seasons: ISO with UTC "... .000
// Z" (NRL, AFL 2026) or "... .000 +0000" (2021-22), and Australian D/M/YYYY with
// no time (AFL 2021-25). Normalise all to an instant (day-level for D/M/YYYY,
// which is fine for chronological ordering).
function parseBetfairDate(s) {
  const str = String(s || '').trim();
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return Date.parse(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00Z`);
  }
  const [date, time = '00:00:00', zoneRaw = 'Z'] = str.split(/\s+/);
  const zone = (zoneRaw === 'Z' || zoneRaw === '+0000' || zoneRaw === '+00:00') ? 'Z' : zoneRaw;
  return Date.parse(`${date}T${time}${zone}`);
}

const mid = (b, l) => {
  const bb = Number(b), ll = Number(l);
  if (bb > 1 && ll > 1) return (bb + ll) / 2;
  if (bb > 1) return bb;
  if (ll > 1) return ll;
  return null;
};

// Is this kickoff inside the State-of-Origin representative window? (Origin is
// late May to mid-July; club sides get gutted — the roadmap's headline case.)
function nrlOriginWindow(dateMs) {
  const d = new Date(dateMs);
  const m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return (m === 5 && day >= 20) || m === 6 || (m === 7 && day <= 15);
}

// Generic puller for either code. AFL allows genuine draws (no golden point);
// a drawn match can't be a binary home-win outcome, so it is dropped.
export async function pullBetfair(leagueKey, seasons = SEASONS) {
  const L = LEAGUES[leagueKey];
  if (!L) throw new Error(`unknown league ${leagueKey}`);
  const matches = [];
  const misses = new Set();
  for (const season of seasons) {
    let text;
    try { text = await fetchCsv(L.code, season); } catch (e) { console.error(`  skip ${season}: ${e.message}`); continue; }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = splitCsv(lines[0]);
    const col = (name) => header.indexOf(name);
    const ci = {
      date: col('EVENT_DATE'), market: col('MARKET_ID'), runner: col('RUNNER_NAME'),
      status: col('RUNNER_STATUS'), isWin: col('IS_WINNER'),
      home: col('HOME_TEAM'), away: col('AWAY_TEAM'), hs: col('HOME_SCORE'), as: col('AWAY_SCORE'),
      back: col('BEST_BACK_FIRST_BOUNCE'), lay: col('BEST_LAY_FIRST_BOUNCE'),
    };
    // group the two runner rows by market id
    const byMarket = new Map();
    for (let i = 1; i < lines.length; i++) {
      const f = splitCsv(lines[i]);
      const mkt = f[ci.market];
      if (!mkt) continue;
      if (!byMarket.has(mkt)) byMarket.set(mkt, []);
      byMarket.get(mkt).push(f);
    }
    for (const [, rows] of byMarket) {
      const f0 = rows[0];
      const home = L.team(f0[ci.home]);
      const away = L.team(f0[ci.away]);
      if (!home || !away || home === away) {
        if (!home) misses.add(f0[ci.home]);
        if (!away) misses.add(f0[ci.away]);
        continue;
      }
      const hs = Number(f0[ci.hs]), as = Number(f0[ci.as]);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      let homeWin;
      if (hs > as) homeWin = 1; else if (as > hs) homeWin = 0;
      else { // dead heat on score — golden point (NRL) sets a winner; a true AFL draw has none, drop it
        const w = rows.find((r) => Number(r[ci.isWin]) === 1);
        if (!w) continue;
        homeWin = L.team(w[ci.runner]) === home ? 1 : 0;
      }
      // closing price per side, matched by runner name
      let homePrice = null, awayPrice = null;
      for (const r of rows) {
        if (String(r[ci.status]).toUpperCase() === 'REMOVED') continue;
        const side = L.team(r[ci.runner]);
        const p = mid(r[ci.back], r[ci.lay]);
        if (side === home) homePrice = p; else if (side === away) awayPrice = p;
      }
      let marketProb = null;
      if (homePrice > 1 && awayPrice > 1) {
        const ih = 1 / homePrice, ia = 1 / awayPrice;
        marketProb = Math.round((ih / (ih + ia)) * 1000) / 1000; // de-vigged home prob
      }
      const dateMs = parseBetfairDate(f0[ci.date]);
      matches.push({
        season, date: f0[ci.date], dateMs,
        home, away, homeScore: hs, awayScore: as, homeWin,
        homePrice: homePrice || null, awayPrice: awayPrice || null, marketProb,
        originWindow: L.origin(dateMs),
      });
    }
  }
  matches.sort((a, b) => a.dateMs - b.dateMs);
  if (misses.size) console.error(`  unmatched ${L.code} team names:`, [...misses].join(', '));
  return matches;
}

export const pullBetfairNrl = (seasons) => pullBetfair('nrl', seasons);
export const pullBetfairAfl = (seasons) => pullBetfair('afl', seasons);

// run directly -> download + summarise (league from argv, default nrl)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const league = (process.argv[2] || 'nrl').toLowerCase();
  const m = await pullBetfair(league);
  const byS = {};
  m.forEach((x) => { byS[x.season] = (byS[x.season] || 0) + 1; });
  const priced = m.filter((x) => x.marketProb != null).length;
  console.log(`pulled ${m.length} ${league.toUpperCase()} matches`, byS);
  console.log(`with a closing market price: ${priced}/${m.length} (${Math.round(priced / m.length * 100)}%)`);
  console.log(`origin-window matches: ${m.filter((x) => x.originWindow).length}`);
  console.log('sample:', JSON.stringify(m[0]));
}
