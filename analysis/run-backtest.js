// Stage 2 — run the SuperCoach hypothesis on real data and write the verdict
// into RESULTS.md. M1 (Elo) vs M2 (Elo+scDiff) vs M3 (market+scDiff), held-out
// season by season, per docs/OPUS-ROADMAP.md §2.
//
//   node analysis/run-backtest.js nrl     # NRL Fantasy snapshots (default)
//   node analysis/run-backtest.js afl     # Footywire SuperCoach salaries

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpine } from './build-spine.js';
import { attachScDiff, attachScDiffNrlPlayed } from './pull-fantasy.js';
import { attachScDiffAfl, footywireAfl } from './pull-footywire.js';
import { runExperiment, verdict } from './lib/backtest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const league = (process.argv[2] || 'nrl').toLowerCase(); // nrl | nrl-played | afl
const baseLeague = league === 'nrl-played' ? 'nrl' : league;
const r3 = (x) => (x == null ? '—' : (Math.round(x * 1000) / 1000).toFixed(3));

async function loadSpine() {
  const f = path.join(HERE, 'cache', `${baseLeague}_matches.json`);
  try { return JSON.parse(await fs.readFile(f, 'utf8')); }
  catch { return buildSpine(baseLeague); }
}

const spine = await loadSpine();
let attached;
if (league === 'afl') {
  const seasons = [...new Set(spine.map((r) => r.season))];
  const fw = await footywireAfl(seasons);
  attached = attachScDiffAfl(spine, fw);
} else if (league === 'nrl-played') {
  attached = attachScDiffNrlPlayed(spine);
} else {
  attached = attachScDiff(spine);
}
const { rows, coverage } = attached;
const usable = rows.filter((r) => r.scDiff != null && r.marketProb != null);
const bySeason = {};
usable.forEach((r) => { bySeason[r.season] = (bySeason[r.season] || 0) + 1; });

console.log(`${league.toUpperCase()} spine ${spine.length} matches; scDiff coverage ${coverage.covered}/${coverage.attempted} (${coverage.pct}%)`);
console.log('usable per season:', bySeason);

const seasons = [...new Set(usable.map((r) => r.season))].sort();
const testSeasons = seasons.filter((s) => seasons.some((p) => p < s));
const experiments = testSeasons.map((s) => runExperiment(usable, s)).filter((e) => e.ok);

for (const e of experiments) {
  console.log(`\n── held-out ${e.testSeason} (train ${e.trainSeasons.join('/')}, n_test=${e.n.test}) ──`);
  console.log(`  log-loss  M1 Elo ${r3(e.scored.M1.logLoss)} | M2 Elo+SC ${r3(e.scored.M2.logLoss)} | M3 Mkt+SC ${r3(e.scored.M3.logLoss)}`);
  console.log(`  scDiff coef (M2): ${r3(e.scDiffCoef.M2)}  | M2−M1 loss gain CI [${r3(e.lossImprovementM2overM1.lo)}, ${r3(e.lossImprovementM2overM1.hi)}]`);
  console.log(`  profit M2: ${e.profit.M2.bets} bets, ROI ${r3(e.profit.M2.roi)}${e.profit.M2.roiCI ? ` CI[${r3(e.profit.M2.roiCI.lo)},${r3(e.profit.M2.roiCI.hi)}]` : ''}`);
  console.log(`  origin/rep subset: ${e.origin.n} matches${e.origin.note ? ' — ' + e.origin.note : ` (M1 ${r3(e.origin.M1logLoss)} vs M2 ${r3(e.origin.M2logLoss)})`}`);
}

const v = verdict(experiments);
console.log(`\n=== ${league.toUpperCase()} VERDICT: ${v.answer.toUpperCase()} ===`);
console.log(v.reason);

// ---- write the code's Stage-2 section into RESULTS.md (idempotent markers) ----
const feed = league === 'afl'
  ? 'Footywire per-round SuperCoach salaries (played-lineup value — a near-non-leaky upper bound: AFL teams are named Thursday, late outs are rare)'
  : league === 'nrl-played'
    ? 'NRL Fantasy played-lineup value (the 17 who actually took the field, valued at their pre-round price) — a LEAKY UPPER BOUND, the twin of the AFL test'
    : 'pre-match NRL Fantasy snapshots (non-leaky best-available-17 proxy)';
const lines = [];
lines.push(`Ran on 3 Jul 2026 from ${feed}. scDiff coverage: **${coverage.covered}/${coverage.attempted} (${coverage.pct}%)**. Usable matches/season: ${Object.entries(bySeason).map(([s, n]) => `${s}=${n}`).join(', ')}.`);
lines.push('');
lines.push('| Held-out season | n | M1 Elo | M2 Elo+SC | M3 Mkt+SC | scDiff coef | M2−M1 loss-gain 95% CI | M2 ROI |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const e of experiments) {
  lines.push(`| ${e.testSeason} | ${e.n.test} | ${r3(e.scored.M1.logLoss)} | ${r3(e.scored.M2.logLoss)} | ${r3(e.scored.M3.logLoss)} | ${r3(e.scDiffCoef.M2)} | [${r3(e.lossImprovementM2overM1.lo)}, ${r3(e.lossImprovementM2overM1.hi)}] | ${r3(e.profit.M2.roi)} |`);
}
lines.push('');
lines.push(`**Verdict: ${v.answer}.** ${v.reason}`);

const MARK = { afl: 'AFL-STAGE2', 'nrl-played': 'NRL-PLAYED-STAGE2', nrl: 'STAGE2' }[league] || 'STAGE2';
const START = `<!-- ${MARK}:START -->`, END = `<!-- ${MARK}:END -->`;
const doc = await fs.readFile(path.join(HERE, 'RESULTS.md'), 'utf8');
if (doc.includes(START) && doc.includes(END)) {
  const before = doc.slice(0, doc.indexOf(START) + START.length);
  const after = doc.slice(doc.indexOf(END));
  await fs.writeFile(path.join(HERE, 'RESULTS.md'), `${before}\n${lines.join('\n')}\n${after}`);
  console.log(`\nwrote ${league.toUpperCase()} Stage 2 section to analysis/RESULTS.md`);
} else {
  console.log(`\n(${START} markers not found in RESULTS.md — printing only)`);
}
