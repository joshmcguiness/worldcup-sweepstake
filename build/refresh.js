// Cron entrypoint: fetch fixtures (+odds) -> compute everything -> write
// public/data.json. Run by GitHub Actions 3x/day and on manual dispatch.
//
//   node build/refresh.js
//
// Env:
//   ODDS_API_KEY      optional — The Odds API key for live tournament-winner
//                     odds. Without it the static snapshot in teams.js is used.
//   REFRESH_SOURCE    'scheduled' | 'manual' (log attribution; default 'local')
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TEAMS, mapName } from '../public/lib/teams.js';
import { FIX, TOTAL_MATCHES, scoresFromFeed } from '../public/lib/fixtures.js';
import { computeStandings } from '../public/lib/standings.js';
import { bracketSnapshot } from '../public/lib/bracket.js';
import { poolRows, wildRows, winRows, prizeTable } from '../public/lib/scoring.js';
import { runSim } from '../public/lib/sim.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = join(ROOT, 'public', 'data.json');
const CONFIG_PATH = join(ROOT, 'config', 'draw.json');

const FEED = 'https://fixturedownload.com/feed/json/fifa-world-cup-2026';
// Final = MatchNumber 104, 2026-07-19. ~1 day buffer, then stop refreshing
// forever — the last-built data.json keeps showing the final result.
const TOURNAMENT_OVER_AFTER = Date.parse('2026-07-20T12:00:00Z');

function loadPrevious() {
  try { return JSON.parse(readFileSync(DATA_PATH, 'utf-8')); } catch { return null; }
}

async function fetchJson(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'worldcup-sweepstake-build' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchOddsOverride(apiKey) {
  const url = 'https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup_winner/odds/'
    + '?regions=us&oddsFormat=decimal&markets=outrights&apiKey=' + encodeURIComponent(apiKey);
  const data = await fetchJson(url);
  if (!Array.isArray(data) || !data.length) throw new Error('empty odds response');
  const agg = {};
  for (const ev of data) {
    for (const bk of ev.bookmakers || []) {
      for (const mk of bk.markets || []) {
        if (mk.key !== 'outrights') continue;
        for (const o of mk.outcomes || []) {
          if (o.price > 1) (agg[o.name] = agg[o.name] || []).push(o.price);
        }
      }
    }
  }
  const override = {};
  for (const nm of Object.keys(agg)) {
    const our = mapName(nm);
    if (!our) continue;
    const dec = agg[nm].reduce((a, b) => a + b, 0) / agg[nm].length;
    override[our] = Math.max(1, Math.round((dec - 1) * 100));
  }
  return override;
}

async function main() {
  const previous = loadPrevious();

  if (Date.now() > TOURNAMENT_OVER_AFTER && previous) {
    console.log('Tournament over — skipping refresh.');
    return;
  }
  if (previous && previous.finished) {
    console.log('All matches have scores and the build is marked finished — skipping refresh.');
    return;
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const notes = [];

  // --- fixtures + scores ---
  let scores = previous ? previous.scores || {} : {};
  const prevCount = Object.keys(scores).length;
  try {
    const feed = await fetchJson(FEED);
    scores = scoresFromFeed(feed);
    notes.push(`${Object.keys(scores).length} scores from feed`);
  } catch (e) {
    notes.push(`feed failed (${e.message}) — kept previous scores`);
  }

  // --- odds ---
  const teams = TEAMS.map((t) => ({ ...t }));
  const previousOdds = previous?.oddsOverride || {};
  let oddsOverride = previousOdds;
  if ((process.env.ODDS_API_KEY || '').trim()) {
    try {
      oddsOverride = await fetchOddsOverride(process.env.ODDS_API_KEY.trim());
      notes.push(`${Object.keys(oddsOverride).length} live odds`);
    } catch (e) {
      notes.push(`odds failed (${e.message}) — kept previous odds`);
    }
  }
  teams.forEach((t) => { if (oddsOverride[t.n] != null) t.o = oddsOverride[t.n]; });

  // --- compute ---
  const ctx = {
    teams, fixtures: FIX, scores,
    players: config.players, owners: config.owners,
    buyIn: config.buyIn, split: config.split,
  };
  const standings = computeStandings(teams, FIX, scores);
  const data = {
    updatedAt: new Date().toISOString(),
    finished: Object.keys(scores).length >= TOTAL_MATCHES,
    config: {
      players: config.players, owners: config.owners, locked: config.locked,
      buyIn: config.buyIn, split: config.split, visibleTabs: config.visibleTabs,
    },
    teams,
    oddsOverride,
    scores,
    standings,
    pool: poolRows(ctx),
    wild: wildRows(ctx),
    winOdds: winRows(ctx),
    prizes: prizeTable(ctx),
    bracket: bracketSnapshot(teams, FIX, scores),
    sim: runSim(ctx),
    log: (previous?.log || []).slice(-200),
  };

  const newScores = Object.keys(scores).length - prevCount;
  data.log.push({
    ts: Date.now(),
    source: process.env.REFRESH_SOURCE || 'local',
    matchesUpdated: Math.max(0, newScores),
    note: notes.join(' · '),
  });
  if (data.finished) data.log.push({ ts: Date.now(), source: 'system', matchesUpdated: 0, note: 'Tournament complete — refreshes stop here. 🏆' });

  writeFileSync(DATA_PATH, JSON.stringify(data, null, 1));
  console.log(`Wrote public/data.json — ${notes.join(' · ')} — finished=${data.finished}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
