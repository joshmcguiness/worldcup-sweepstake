// The pooled fixed-effects test — the one experiment with more power than any
// single 190-match season (RESULTS.md said this was the only way SuperCoach
// could still flip to a "yes"). Instead of asking "does scDiff improve
// out-of-sample prediction each season" (already: barely), it pools every match,
// controls for season (and code) with fixed effects, and asks the sharper
// question: is the scDiff coefficient STATISTICALLY DISTINGUISHABLE FROM ZERO?
//
//   node analysis/pooled-model.js
//
// Verdict rule: scDiff is a real (if small) signal iff its 95% CI clears zero
// in the pooled model — controlling for Elo and season. This is an association
// test, not a prediction-improvement test; a "yes" here + "no improvement"
// earlier would mean "real but too small to help", which is still honest.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpine } from './build-spine.js';
import { attachScDiffNrlPlayed } from './pull-fantasy.js';
import { attachScDiffAfl, footywireAfl } from './pull-footywire.js';
import { standardise, logisticInference } from './lib/stats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const r3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3);

async function spineFor(league) {
  const f = path.join(HERE, 'cache', `${league}_matches.json`);
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return buildSpine(league); }
}

// AFL: played-lineup scDiff (Footywire). NRL: played-17 scDiff (tspen) — the
// like-for-like comparison, both "who actually ran out".
const aflSpine = await spineFor('afl');
const aflFw = await footywireAfl([...new Set(aflSpine.map((r) => r.season))]);
const aflRows = attachScDiffAfl(aflSpine, aflFw).rows
  .filter((r) => r.scDiff != null && r.marketProb != null).map((r) => ({ ...r, code: 'afl' }));

const nrlRows = attachScDiffNrlPlayed(await spineFor('nrl')).rows
  .filter((r) => r.scDiff != null && r.marketProb != null).map((r) => ({ ...r, code: 'nrl' }));

// Fit home-win ~ eloDiff + scDiff + season dummies (+ code dummy when pooled),
// and read off the scDiff coefficient's inference. Elo & scDiff standardised so
// the scDiff coef reads as "log-odds shift per 1 SD of lineup-value advantage".
function fixedEffects(rows, withCode = false) {
  const elo = standardise(rows.map((r) => r.eloDiff));
  const sc = standardise(rows.map((r) => r.scDiff));
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  const refSeason = seasons[0];
  const dummySeasons = seasons.slice(1);
  const X = rows.map((r, i) => {
    const row = [elo.values[i], sc.values[i], ...dummySeasons.map((s) => (r.season === s ? 1 : 0))];
    if (withCode) row.push(r.code === 'afl' ? 1 : 0);
    return row;
  });
  const y = rows.map((r) => r.homeWin);
  const inf = logisticInference(X, y, { lr: 0.3, iters: 6000 });
  return { scDiff: inf[2], n: rows.length, seasons, refSeason }; // inf: 0=intercept,1=elo,2=scDiff
}

const datasets = [
  ['AFL (played 22)', fixedEffects(aflRows)],
  ['NRL (played 17)', fixedEffects(nrlRows)],
  ['BOTH pooled (+ code fixed effect)', fixedEffects([...aflRows, ...nrlRows], true)],
];

console.log('Pooled fixed-effects test — scDiff coefficient (per 1 SD), controlling for Elo + season:\n');
const lines = [];
lines.push('| Dataset | n | scDiff coef (per SD) | 95% CI | z | p | significant? |');
lines.push('|---|---|---|---|---|---|---|');
for (const [label, res] of datasets) {
  const s = res.scDiff;
  const sig = s.lo > 0 ? 'YES — positive' : (s.hi < 0 ? 'yes — negative' : 'no');
  console.log(`${label.padEnd(34)} n=${res.n}  coef ${r3(s.coef)}  CI [${r3(s.lo)}, ${r3(s.hi)}]  z=${r3(s.z)}  p=${s.p < 0.001 ? '<0.001' : r3(s.p)}  -> ${sig}`);
  lines.push(`| ${label} | ${res.n} | ${r3(s.coef)} | [${r3(s.lo)}, ${r3(s.hi)}] | ${r3(s.z)} | ${s.p < 0.001 ? '<0.001' : r3(s.p)} | ${sig} |`);
}

const anySig = datasets.some(([, r]) => r.scDiff.lo > 0);
const verdict = anySig
  ? '**At least one pooled model shows a scDiff coefficient significantly above zero.** The effect is real but small (recall it did NOT improve out-of-sample log-loss enough to bet on). Case for a tiny Elo *nudge* — see the decision note.'
  : "**No pooled model's scDiff coefficient clears zero even with the extra power.** Pooling seasons did not rescue the signal: SuperCoach lineup value is not a statistically distinguishable predictor beyond Elo. Do not wire it in. This closes the SuperCoach question.";
console.log(`\n=== POOLED VERDICT ===\n${anySig ? 'SIGNIFICANT somewhere' : 'NOT significant anywhere'}`);

// write into RESULTS.md between markers
const block = [
  `Ran 3 Jul 2026. Home-win ~ Elo + scDiff + season fixed effects (logistic, analytic SEs). scDiff standardised, so the coefficient is the log-odds shift per 1 SD of home-minus-away lineup-value advantage. "Played" lineups both codes (the like-for-like comparison).`,
  '',
  ...lines,
  '',
  verdict,
].join('\n');
const doc = await fs.readFile(path.join(HERE, 'RESULTS.md'), 'utf8');
const START = '<!-- POOLED:START -->', END = '<!-- POOLED:END -->';
if (doc.includes(START) && doc.includes(END)) {
  await fs.writeFile(path.join(HERE, 'RESULTS.md'), `${doc.slice(0, doc.indexOf(START) + START.length)}\n${block}\n${doc.slice(doc.indexOf(END))}`);
  console.log('\nwrote POOLED section to analysis/RESULTS.md');
}
