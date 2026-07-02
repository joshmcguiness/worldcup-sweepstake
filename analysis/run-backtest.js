// Stage 2 — run the SuperCoach hypothesis on real NRL data and write the
// verdict into RESULTS.md. M1 (Elo) vs M2 (Elo+scDiff) vs M3 (market+scDiff),
// held-out season by season, per docs/OPUS-ROADMAP.md §2.
//
//   node analysis/run-backtest.js

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpine } from './build-spine.js';
import { attachScDiff } from './pull-fantasy.js';
import { runExperiment, verdict } from './lib/backtest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const r3 = (x) => (x == null ? '—' : (Math.round(x * 1000) / 1000).toFixed(3));

async function loadSpine() {
  const f = path.join(HERE, 'cache', 'nrl_matches.json');
  try { return JSON.parse(await fs.readFile(f, 'utf8')); }
  catch { return buildSpine(); }
}

const spine = await loadSpine();
const { rows, coverage } = attachScDiff(spine);
const usable = rows.filter((r) => r.scDiff != null && r.marketProb != null);
const bySeason = {};
usable.forEach((r) => { bySeason[r.season] = (bySeason[r.season] || 0) + 1; });

console.log(`spine ${spine.length} matches; scDiff coverage ${coverage.covered}/${coverage.attempted} (${coverage.pct}%) of 2023+`);
console.log('usable per season:', bySeason);

// held-out seasons = every covered season that has at least one prior covered season
const seasons = [...new Set(usable.map((r) => r.season))].sort();
const testSeasons = seasons.filter((s) => seasons.some((p) => p < s));
const experiments = testSeasons.map((s) => runExperiment(usable, s)).filter((e) => e.ok);

for (const e of experiments) {
  console.log(`\n── held-out ${e.testSeason} (train ${e.trainSeasons.join('/')}, n_test=${e.n.test}) ──`);
  console.log(`  log-loss  M1 Elo ${r3(e.scored.M1.logLoss)} | M2 Elo+SC ${r3(e.scored.M2.logLoss)} | M3 Mkt+SC ${r3(e.scored.M3.logLoss)}`);
  console.log(`  scDiff coef (M2): ${r3(e.scDiffCoef.M2)}  | M2−M1 loss gain CI [${r3(e.lossImprovementM2overM1.lo)}, ${r3(e.lossImprovementM2overM1.hi)}]`);
  console.log(`  profit M2: ${e.profit.M2.bets} bets, ROI ${r3(e.profit.M2.roi)}${e.profit.M2.roiCI ? ` CI[${r3(e.profit.M2.roiCI.lo)},${r3(e.profit.M2.roiCI.hi)}]` : ''}`);
  console.log(`  origin subset: ${e.origin.n} matches${e.origin.note ? ' — ' + e.origin.note : ` (M1 ${r3(e.origin.M1logLoss)} vs M2 ${r3(e.origin.M2logLoss)})`}`);
}

const v = verdict(experiments);
console.log(`\n=== VERDICT: ${v.answer.toUpperCase()} ===`);
console.log(v.reason);

// ---- write the STAGE2 section into RESULTS.md ----
const lines = [];
lines.push(`Ran ${new Date(spine[spine.length - 1].dateMs).getUTCFullYear()}-vintage data on 2 Jul 2026. scDiff coverage: **${coverage.covered}/${coverage.attempted} (${coverage.pct}%)** of 2023+ matches (rest lack a usable pre-match fantasy snapshot). Usable matches/season: ${Object.entries(bySeason).map(([s, n]) => `${s}=${n}`).join(', ')}.`);
lines.push('');
lines.push('| Held-out season | n | M1 Elo | M2 Elo+SC | M3 Mkt+SC | scDiff coef | M2−M1 loss-gain 95% CI | M2 ROI |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const e of experiments) {
  lines.push(`| ${e.testSeason} | ${e.n.test} | ${r3(e.scored.M1.logLoss)} | ${r3(e.scored.M2.logLoss)} | ${r3(e.scored.M3.logLoss)} | ${r3(e.scDiffCoef.M2)} | [${r3(e.lossImprovementM2overM1.lo)}, ${r3(e.lossImprovementM2overM1.hi)}] | ${r3(e.profit.M2.roi)} |`);
}
lines.push('');
lines.push(`**Verdict: ${v.answer}.** ${v.reason}`);
lines.push('');
lines.push('Reminder on reading this (roadmap §3.0): a lower log-loss is better; the M2−M1 loss-gain CI must sit entirely above 0 in every season for a "yes"; and because closing markets are ~perfectly calibrated, an apparent market-beating result (M3 < M1) should be treated as a leakage suspect, not a win, until re-checked.');

const doc = await fs.readFile(path.join(HERE, 'RESULTS.md'), 'utf8');
const START = '<!-- STAGE2:START -->', END = '<!-- STAGE2:END -->';
if (doc.includes(START) && doc.includes(END)) {
  const before = doc.slice(0, doc.indexOf(START) + START.length);
  const after = doc.slice(doc.indexOf(END));
  await fs.writeFile(path.join(HERE, 'RESULTS.md'), `${before}\n${lines.join('\n')}\n${after}`);
  console.log('\nwrote Stage 2 section to analysis/RESULTS.md');
} else {
  console.log('\n(STAGE2 markers not found in RESULTS.md — left unchanged)');
}
