// Which OTHER variables actually predict results beyond Elo? We take the
// research-ranked candidates that are derivable now — interstate travel (the
// AFL literature's headline), rest/break differential, and recent-margin form —
// and test each in the pooled fixed-effects model (home-win ~ Elo + feature +
// season FE), reading off whether the feature's coefficient clears zero. Same
// method as the SuperCoach pooled test, so results are directly comparable.
//
//   node analysis/feature-tests.js

import { pullAsb } from './pull-asb.js';
import { attachElo } from './lib/elo-spine.js';
import { standardise, logisticInference } from './lib/stats.js';

// Home state per club (interstate-travel flag = home & away in different states;
// a home game is ~always in the home team's state, so this needs no venue map).
const STATE = {
  nrl: {
    broncos: 'QLD', cowboys: 'QLD', dolphins: 'QLD', titans: 'QLD',
    roosters: 'NSW', rabbitohs: 'NSW', bulldogs: 'NSW', eels: 'NSW', seaeagles: 'NSW',
    sharks: 'NSW', dragons: 'NSW', panthers: 'NSW', tigers: 'NSW', knights: 'NSW',
    raiders: 'ACT', storm: 'VIC', warriors: 'NZ',
  },
  afl: {
    adelaide: 'SA', portadelaide: 'SA', brisbane: 'QLD', goldcoast: 'QLD',
    sydney: 'NSW', gws: 'NSW', westcoast: 'WA', fremantle: 'WA',
    carlton: 'VIC', collingwood: 'VIC', essendon: 'VIC', geelong: 'VIC', hawthorn: 'VIC',
    melbourne: 'VIC', northmelbourne: 'VIC', richmond: 'VIC', stkilda: 'VIC', westernbulldogs: 'VIC',
  },
};

// derive per-match features from sorted history
function addFeatures(rows, league) {
  const lastGame = new Map();     // team -> dateMs of previous game
  const recentMargin = new Map(); // team -> [last up-to-5 margins]
  const st = STATE[league];
  const out = [];
  for (const m of rows) {
    const hg = lastGame.get(m.home), ag = lastGame.get(m.away);
    const hRest = hg ? (m.dateMs - hg) / 86400000 : null;
    const aRest = ag ? (m.dateMs - ag) / 86400000 : null;
    const hm = recentMargin.get(m.home) || [], am = recentMargin.get(m.away) || [];
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    out.push({
      ...m,
      breakDiff: (hRest != null && aRest != null) ? Math.max(-14, Math.min(14, hRest - aRest)) : 0,
      interstateAway: (st[m.home] && st[m.away] && st[m.home] !== st[m.away]) ? 1 : 0,
      marginFormDiff: avg(hm) - avg(am),
      hasRest: hRest != null && aRest != null,
    });
    // update history AFTER the row (no leak)
    lastGame.set(m.home, m.dateMs); lastGame.set(m.away, m.dateMs);
    const hMar = m.homeScore - m.awayScore;
    recentMargin.set(m.home, [...hm, hMar].slice(-5));
    recentMargin.set(m.away, [...am, -hMar].slice(-5));
  }
  return out;
}

// Fit home-win ~ eloDiff + feature + season FE; return the feature's inference.
function testFeature(rows, featureKey) {
  const elo = standardise(rows.map((r) => r.eloDiff));
  const fe = standardise(rows.map((r) => r[featureKey]));
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  const dummies = seasons.slice(1);
  const X = rows.map((r, i) => [elo.values[i], fe.values[i], ...dummies.map((s) => (r.season === s ? 1 : 0))]);
  const y = rows.map((r) => r.homeWin);
  const inf = logisticInference(X, y, { lr: 0.3, iters: 6000 });
  return inf[2]; // 0=intercept, 1=elo, 2=feature
}

const r3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3);
const FEATURES = [
  ['interstateAway', 'away team travels interstate'],
  ['breakDiff', 'rest-days advantage (home − away)'],
  ['marginFormDiff', 'recent-margin form (last 5, home − away)'],
];

for (const lg of ['nrl', 'afl']) {
  const base = (await attachElo(await pullAsb(lg), lg)).filter((m) => m.season >= 2016 && m.eloGames > 30);
  const rows = addFeatures(base, lg).filter((m) => m.hasRest);
  console.log(`\n### ${lg.toUpperCase()} feature tests (n=${rows.length}, pooled + season FE, controlling for Elo)`);
  console.log('feature'.padEnd(42), 'coef/SD'.padStart(9), '95% CI'.padStart(18), 'p'.padStart(8), '  verdict');
  for (const [key, label] of FEATURES) {
    const s = testFeature(rows, key);
    const sig = s.lo > 0 ? 'significant +' : s.hi < 0 ? 'significant −' : 'not significant';
    console.log(label.padEnd(42), r3(s.coef).padStart(9), `[${r3(s.lo)}, ${r3(s.hi)}]`.padStart(18), (s.p < 0.001 ? '<0.001' : r3(s.p)).padStart(8), '  ' + sig);
  }
}
console.log('\nInterpretation: a "significant +" feature carries information the Elo rating misses,');
console.log('and is a candidate to add to the model (small, behind the Mission-A gate). Compare');
console.log('effect sizes to the AFL SuperCoach coef (+0.29/SD) as a yardstick.');
