// One-off admin tool: randomly assign one Golden Boot candidate footballer to
// each sweepstake player, seeded so the draw is reproducible, and write the
// result into config/sidepots.json.
//
//   node build/draw-goldenboot.js <seed>
//
// Candidates come from config/goldenboot-candidates.json (ordered by current
// odds, shortest first); the first N are used for N players.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mulberry32, shuffle } from '../public/lib/draw.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const seed = Number(process.argv[2]);
if (!Number.isInteger(seed)) {
  console.error('Usage: node build/draw-goldenboot.js <integer seed>');
  process.exit(1);
}

const draw = JSON.parse(readFileSync(join(ROOT, 'config', 'draw.json'), 'utf-8'));
const sidepots = JSON.parse(readFileSync(join(ROOT, 'config', 'sidepots.json'), 'utf-8'));
const { candidates } = JSON.parse(readFileSync(join(ROOT, 'config', 'goldenboot-candidates.json'), 'utf-8'));

const players = draw.players;
if (candidates.length < players.length) {
  console.error(`Need at least ${players.length} candidates, got ${candidates.length}`);
  process.exit(1);
}

const rnd = mulberry32(seed);
const pool = shuffle(candidates.slice(0, players.length), rnd);
sidepots.goldenBoot.drawSeed = seed;
sidepots.goldenBoot.assignments = {};
players.forEach((p, i) => {
  sidepots.goldenBoot.assignments[p] = { name: pool[i].name, team: pool[i].team };
});

writeFileSync(join(ROOT, 'config', 'sidepots.json'), JSON.stringify(sidepots, null, 2) + '\n');
players.forEach((p) => {
  const a = sidepots.goldenBoot.assignments[p];
  console.log(`${p.padEnd(12)} -> ${a.name} (${a.team})`);
});
