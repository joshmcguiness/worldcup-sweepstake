// Stage 1 — build the NRL match spine and measure our blind spot.
//
// Rebuild the SAME Elo the live engine uses (public/lib/sports.js) across every
// match 2021-2026 in date order, capturing the PRE-match Elo probability and
// the de-vigged closing market probability for each game. Then score both with
// log-loss / Brier / calibration bins. This quantifies, on real data, exactly
// how far behind the market our Elo is — the gap Mission B hopes SuperCoach can
// close. Writes analysis/cache/nrl_matches.json (the spine Stage 2 reuses).
//
//   node analysis/build-spine.js

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPORTS, updateElo } from '../public/lib/sports.js';
import { logLoss, brierScore, calibrationBins } from './lib/stats.js';
import { pullBetfair } from './pull-betfair.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 1500;

// raw two-way Elo win prob for the home side (outcomes here are binary — golden
// point resolves NRL draws; AFL draws are dropped upstream — so no draw shrink)
function eloProbHome(elo, home, away, hfa) {
  const diff = ((elo[home] ?? BASE) + hfa) - (elo[away] ?? BASE);
  return 1 / (1 + 10 ** (-diff / 400));
}

// regress every rating 25% back to the mean between seasons (rosters churn)
function regress(elo) {
  const out = {};
  for (const [t, r] of Object.entries(elo)) out[t] = BASE + 0.75 * (r - BASE);
  return out;
}

export async function buildSpine(league = 'nrl') {
  const cfg = SPORTS.find((s) => s.key === league);
  const matches = await pullBetfair(league);
  let state = { elo: {}, rated: [], eloGames: 0 };
  let season = null;
  let idx = 0;
  const spine = [];
  for (const m of matches) {
    if (season !== null && m.season !== season) state = { elo: regress(state.elo), rated: [], eloGames: 0 };
    season = m.season;
    const eloProb = Math.round(eloProbHome(state.elo, m.home, m.away, cfg.hfa) * 1000) / 1000;
    const eloDiff = Math.round((((state.elo[m.home] ?? BASE) + cfg.hfa) - (state.elo[m.away] ?? BASE)) * 10) / 10;
    spine.push({
      league, season: m.season, date: m.date, dateMs: m.dateMs,
      home: m.home, away: m.away, homeWin: m.homeWin,
      eloProb, eloDiff, marketProb: m.marketProb,
      homePrice: m.homePrice, awayPrice: m.awayPrice,
      originWindow: m.originWindow,
    });
    state = updateElo(state, [{
      MatchNumber: idx++, HomeTeam: m.home, AwayTeam: m.away,
      HomeTeamScore: m.homeScore, AwayTeamScore: m.awayScore,
    }], cfg);
  }
  await fs.writeFile(path.join(HERE, 'cache', `${league}_matches.json`), JSON.stringify(spine));
  return spine;
}

function report(rows, label) {
  const y = rows.map((r) => r.homeWin);
  const elo = rows.map((r) => r.eloProb);
  const mkt = rows.map((r) => r.marketProb);
  const homeRate = Math.round(y.reduce((s, v) => s + v, 0) / y.length * 1000) / 1000;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  console.log(`\n### ${label}  (n=${rows.length}, home win rate ${homeRate})`);
  console.log(`             log-loss    Brier`);
  console.log(`  Elo      ${r4(logLoss(y, elo)).toFixed(4)}     ${r4(brierScore(y, elo)).toFixed(4)}`);
  console.log(`  Market   ${r4(logLoss(y, mkt)).toFixed(4)}     ${r4(brierScore(y, mkt)).toFixed(4)}`);
  const gap = logLoss(y, elo) - logLoss(y, mkt);
  console.log(`  gap (Elo − Market log-loss): ${r4(gap).toFixed(4)}  ${gap > 0 ? '→ market is ahead (our blind spot)' : '→ Elo matches/beats market'}`);
  return { n: rows.length, homeRate, eloLogLoss: r4(logLoss(y, elo)), marketLogLoss: r4(logLoss(y, mkt)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const league = (process.argv[2] || 'nrl').toLowerCase();
  const spine = await buildSpine(league);
  console.log(`built ${league.toUpperCase()} spine: ${spine.length} matches, ${spine.filter((r) => r.marketProb != null).length} priced`);
  // 2021 is Elo warm-up (everyone starts 1500); judge on 2023+ once ratings settled
  report(spine, `${league.toUpperCase()} ALL 2021-2026`);
  report(spine.filter((r) => r.season >= 2023), `${league.toUpperCase()} SETTLED 2023-2026`);
  const cal = calibrationBins(
    spine.filter((r) => r.season >= 2023).map((r) => r.homeWin),
    spine.filter((r) => r.season >= 2023).map((r) => r.marketProb), 10,
  );
  console.log('\nMarket calibration 2023-26 (predicted vs observed home-win rate):');
  cal.filter((b) => b.n).forEach((b) => console.log(`  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}: pred ${b.predicted?.toFixed(2)} obs ${b.observed?.toFixed(2)} (n=${b.n})`));
}
