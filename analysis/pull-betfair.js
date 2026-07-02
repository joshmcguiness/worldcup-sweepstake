// Pull NRL results + closing exchange odds from the free Betfair Data
// Scientists CSVs (betfair-datascientists.github.io) — the cleanest source
// that carries the match outcome AND a near-vig-free closing price in one file,
// 2021-2026. Two rows per match (one per runner); we fold them into one record.
//
//   node analysis/pull-betfair.js            # download + summarise
//   import { pullBetfairNrl } from './pull-betfair.js'
//
// Prices used: BEST_BACK / BEST_LAY at FIRST_BOUNCE = the price at kickoff =
// the exchange CLOSE. Their midpoint, de-vigged across the two runners, is our
// market probability — the honest bar the model has to beat (roadmap §3.0).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalTeam } from './lib/nrl_teams.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const NRL_SEASONS = [2021, 2022, 2023, 2024, 2025, 2026];

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

async function fetchCsv(season) {
  const file = path.join(CACHE, `nrl_bf_${season}.csv`);
  try {
    const cached = await fs.readFile(file, 'utf8');
    if (cached.length > 500) return cached;
  } catch { /* not cached yet */ }
  const url = `https://betfair-datascientists.github.io/data/assets/NRL_${season}_Match_Odds.csv`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`Betfair ${season}: HTTP ${r.status}`);
  const text = await r.text();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, text);
  return text;
}

// Betfair stamps UTC two ways across seasons: "... .000 Z" (2023+) and
// "... .000 +0000" (2021-22). Normalise both to an ISO instant.
function parseBetfairDate(s) {
  const [date, time = '00:00:00', zoneRaw = 'Z'] = String(s || '').trim().split(/\s+/);
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
function originWindow(dateMs) {
  const d = new Date(dateMs);
  const m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return (m === 5 && day >= 20) || m === 6 || (m === 7 && day <= 15);
}

export async function pullBetfairNrl(seasons = NRL_SEASONS) {
  const matches = [];
  const misses = new Set();
  for (const season of seasons) {
    let text;
    try { text = await fetchCsv(season); } catch (e) { console.error(`  skip ${season}: ${e.message}`); continue; }
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
      const home = canonicalTeam(f0[ci.home]);
      const away = canonicalTeam(f0[ci.away]);
      if (!home || !away || home === away) {
        if (!home) misses.add(f0[ci.home]);
        if (!away) misses.add(f0[ci.away]);
        continue;
      }
      const hs = Number(f0[ci.hs]), as = Number(f0[ci.as]);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      let homeWin;
      if (hs > as) homeWin = 1; else if (as > hs) homeWin = 0;
      else { // dead heat on score — defer to the settled winner flag, else drop
        const w = rows.find((r) => Number(r[ci.isWin]) === 1);
        if (!w) continue;
        homeWin = canonicalTeam(w[ci.runner]) === home ? 1 : 0;
      }
      // closing price per side, matched by runner name
      let homePrice = null, awayPrice = null;
      for (const r of rows) {
        if (String(r[ci.status]).toUpperCase() === 'REMOVED') continue;
        const side = canonicalTeam(r[ci.runner]);
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
        originWindow: originWindow(dateMs),
      });
    }
  }
  matches.sort((a, b) => a.dateMs - b.dateMs);
  if (misses.size) console.error('  unmatched team names:', [...misses].join(', '));
  return matches;
}

// run directly -> download + summarise
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const m = await pullBetfairNrl();
  const byS = {};
  m.forEach((x) => { byS[x.season] = (byS[x.season] || 0) + 1; });
  const priced = m.filter((x) => x.marketProb != null).length;
  console.log(`pulled ${m.length} NRL matches`, byS);
  console.log(`with a closing market price: ${priced}/${m.length} (${Math.round(priced / m.length * 100)}%)`);
  console.log(`origin-window matches: ${m.filter((x) => x.originWindow).length}`);
  console.log('sample:', JSON.stringify(m[0]));
}
