// One-off admin tool: deal FIVE Golden Boot candidate strikers to each
// sweepstake player — evenly but randomly. The candidate list (ordered by
// odds, shortest first) is cut into 5 tiers of N players each; every player
// gets exactly one striker from each tier, randomly within the tier, so every
// hand has the same spread of favourites and longshots. Seeded, so the draw
// is reproducible. Writes the result into config/sidepots.json.
//
//   node build/draw-goldenboot.js <seed>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mulberry32, shuffle } from '../public/lib/draw.js';

const PER_PLAYER = 5;

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
const N = players.length;
if (candidates.length < N * PER_PLAYER) {
  console.error(`Need at least ${N * PER_PLAYER} candidates for ${N} players × ${PER_PLAYER}, got ${candidates.length}`);
  process.exit(1);
}

const rnd = mulberry32(seed);
const assignments = {};
players.forEach((p) => { assignments[p] = []; });
for (let tier = 0; tier < PER_PLAYER; tier++) {
  const pool = shuffle(candidates.slice(tier * N, (tier + 1) * N), rnd);
  players.forEach((p, i) => {
    assignments[p].push({ name: pool[i].name, team: pool[i].team });
  });
}

sidepots.goldenBoot.drawSeed = seed;
sidepots.goldenBoot.perPlayer = PER_PLAYER;
sidepots.goldenBoot.assignments = assignments;

writeFileSync(join(ROOT, 'config', 'sidepots.json'), JSON.stringify(sidepots, null, 2) + '\n');
players.forEach((p) => {
  console.log(p.padEnd(12) + ' -> ' + assignments[p].map((a) => `${a.name} (${a.team})`).join(', '));
});
