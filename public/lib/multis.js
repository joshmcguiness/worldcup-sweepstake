// Multi Wild Card — one weekly ladder of 3 / 4 / 5-leg multis built across the
// NRL and AFL books.
//
// THE RULES (V3 principles applied to multis — encoded, not vibes):
//  1. EVERY LEG MUST EARN ITS PLACE ALONE. Legs are drawn ONLY from the codes'
//     locked weekly books — i.e. selections that already passed the full V3
//     gauntlet (favourite floor, price floor, positive edge after the Mission-A
//     diagnosis, the 50% too-good-to-be-true cap). A multi of +EV legs compounds
//     edge in OUR favour; one junk leg poisons the lot, because the book's ~5%
//     margin compounds per leg against us.
//  2. PICK BY PROBABILITY, NOT PAYOUT. Among qualifying legs we take the
//     HIGHEST-probability ones first. Chasing price in a multi is how the World
//     Cup's sub-50% claims (1 from 17) sneak back in through the side door.
//  3. JOINT-PROBABILITY FLOORS. However good the legs, the combination must
//     stay realistic: 3-leg >= 25%, 4-leg >= 15%, 5-leg >= 10% modelled chance.
//     Below the floor the multi simply isn't offered.
//  4. ONE LADDER, FROZEN. The 3/4/5-leg multis share legs by design (they are
//     one escalating ladder, not three independent bets — expect them to live
//     and die together). Generated once when the weekly books lock, then frozen:
//     never rewritten, settled automatically, archived to history.
//  5. AN EMPTY WEEK IS THE RULES WORKING. Fewer than 3 qualifying legs across
//     both codes -> no multis that week. Origin-gutted or thin weeks are exactly
//     when forcing a multi loses money.
//  6. HONEST ACCOUNTING. $10 virtual stake per multi (a tenth of a single —
//     multis are the high-variance product). A multi is LOST the moment any
//     leg loses, WON only when every leg lands. CLV is tracked per leg and
//     compounds like the price does.

export const MULTI_STAKE = 10;

export const JOINT_FLOORS = { 3: 0.25, 4: 0.15, 5: 0.10 };
export const MULTI_SIZES = [3, 4, 5];

const r3 = (x) => Math.round(x * 1000) / 1000;

// Qualifying legs this week: pending, not-yet-kicked-off selections from each
// code's locked book (they already passed every single-bet gate).
export function candidateLegs(sports, now = Date.now()) {
  const legs = [];
  for (const key of Object.keys(sports || {})) {
    const book = sports[key] && sports[key].book;
    if (!book || !book.bets) continue;
    for (const b of book.bets) {
      if (b.status !== 'pending' || Date.parse(b.kickoff) <= now) continue;
      // Aug 2026 ladder post-mortem: only CLEAN signals parlay. A steam leg is
      // one the market is actively moving against — the riskiest thing to
      // multiply. (Legacy legs without a cause are treated as clean.)
      if (b.edgeCause && b.edgeCause !== 'model-signal') continue;
      // and only straight WIN legs — draws and win-or-draw stay out of multis
      if (b.kind && b.kind !== 'win') continue;
      legs.push({
        id: b.id, sport: key, round: b.round, team: b.team, opp: b.opp,
        selection: b.selection, prob: b.prob, price: b.price, edge: b.edge,
        kickoff: b.kickoff, edgeCause: b.edgeCause || null, status: 'pending',
      });
    }
  }
  return legs.sort((a, b) => b.prob - a.prob); // rule 2: probability first
}

// Build the week's ladder from the sorted legs. Each size takes the top-N
// probability legs; a size is only offered if its joint probability clears the
// floor (rule 3).
export function generateMultis(legs, now = Date.now()) {
  const multis = [];
  for (const size of MULTI_SIZES) {
    if (legs.length < size) continue;
    const pick = legs.slice(0, size);
    const prob = r3(pick.reduce((p, l) => p * l.prob, 1));
    if (prob < JOINT_FLOORS[size]) continue;
    const price = r3(pick.reduce((p, l) => p * l.price, 1));
    // the too-good-to-be-true law applies to the COMBINATION as much as any
    // single: a joint edge over 50% means we are compounding our own optimism
    // (the Aug ladders shipped +81/+84% rungs — never again)
    if (prob * price - 1 > 0.5) continue;
    multis.push({
      id: `multi-${size}leg-${new Date(now).toISOString().slice(0, 10)}`,
      size, legs: pick.map((l) => ({ ...l })),
      prob, price, edge: r3(prob * price - 1),
      stake: MULTI_STAKE, status: 'pending',
    });
  }
  // label the ladder: the statistically best rung (highest edge vs the market)
  // and the most likely to land (highest joint probability)
  if (multis.length) {
    const best = multis.reduce((a, b) => (b.edge > a.edge ? b : a));
    best.bestValue = true;
    const likely = multis.reduce((a, b) => (b.prob > a.prob ? b : a));
    likely.mostLikely = true;
  }
  return multis;
}

// Look up a leg's current result in the sports state (book first, then the
// archived history — books archive once every bet settles).
function legStatus(leg, sports) {
  const s = sports && sports[leg.sport];
  if (!s) return leg.status;
  const pools = [((s.book || {}).bets) || [], ...((s.history || []).map((h) => h.bets))];
  for (const pool of pools) {
    const b = pool.find((x) => x.id === leg.id && x.team === leg.team);
    if (b) return b.status;
  }
  return leg.status;
}

// Settle: refresh every leg from the sports state; a multi is lost on the
// first lost leg, won when all legs have won (rule 6). Also carries each leg's
// banked closing price through for CLV.
export function settleMultis(multis, sports) {
  return (multis || []).map((m) => {
    if (m.status !== 'pending') return m;
    const legs = m.legs.map((l) => {
      const st = legStatus(l, sports);
      // pick up the closing price the singles engine banked on the same bet
      const s = sports && sports[l.sport];
      const pools = [((s && s.book || {}).bets) || [], ...(((s && s.history) || []).map((h) => h.bets))];
      const src = pools.flat().find((x) => x.id === l.id && x.team === l.team);
      return { ...l, status: st, ...(src && src.closePrice ? { closePrice: src.closePrice } : {}) };
    });
    const status = legs.some((l) => l.status === 'lost') ? 'lost'
      : legs.every((l) => l.status === 'won') ? 'won' : 'pending';
    return { ...m, legs, status };
  });
}

// The weekly cycle (rule 4): settle the open ladder; archive it once fully
// settled; generate a fresh ladder only when there is no open one and enough
// qualifying legs exist.
export function rollMultis(prev, sports, now = Date.now()) {
  let current = prev && prev.current ? { ...prev.current, multis: settleMultis(prev.current.multis, sports) } : null;
  let history = (prev && prev.history ? prev.history : []).map((w) => ({ ...w, multis: settleMultis(w.multis, sports) }));
  // Archive only when every multi AND every LEG has settled. The multis can
  // all be "lost" the moment one shared leg fails, but the other legs are
  // still live — archiving early let the generator immediately re-parlay the
  // SAME legs into a second ladder that week (the Aug 2026 re-bet bug: the
  // Germany pile-up in multi form). One ladder per set of games, full stop.
  if (current
    && current.multis.every((m) => m.status !== 'pending')
    && current.multis.every((m) => m.legs.every((l) => l.status !== 'pending'))) {
    history = [...history, { ...current, settledAt: new Date(now).toISOString() }].slice(-30);
    current = null;
  }
  if (!current) {
    const legs = candidateLegs(sports, now);
    if (legs.length >= 3) {
      const multis = generateMultis(legs, now);
      if (multis.length) current = { generatedAt: new Date(now).toISOString(), multis };
    }
  }
  return { current, history };
}

// P/L for one settled multi at its locked combined price.
export function multiPnl(m) {
  return m.status === 'won' ? m.stake * (m.price - 1) : m.status === 'lost' ? -m.stake : 0;
}

// Compounded CLV: locked combined price vs the combined closing price (needs a
// banked close on every leg; null otherwise).
export function multiClv(m) {
  let closed = 1;
  for (const l of m.legs) {
    if (!(l.closePrice > 1)) return null;
    closed *= l.closePrice;
  }
  return r3(m.price / closed - 1);
}
