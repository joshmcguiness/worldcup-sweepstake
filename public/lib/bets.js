// High Risk Curnow Bets — statistical bet finder + settlement engine.
//
// Every day the build job calls generateBets() once (picks freeze for that
// AEST day) and settleBets() on every refresh. All "analysis" is our own
// model: the 30k-run Monte-Carlo sim, the Bradley-Terry match model from the
// betting odds, FIFA rank gaps and the Golden Boot odds board. When live
// per-match bookmaker odds are available (The Odds API), real market edge is
// computed; otherwise bets quote the model's fair odds as the price to beat.
// Entertainment, not financial advice.
import { strengthOf, teamOdds } from './teams.js';
import { predictBracket } from './bracket.js';
import { mulberry32 } from './draw.js';
import { hasScore, groupsComplete } from './fixtures.js';
import { computeStandings, teamByGroupRank } from './standings.js';
import { stageReached } from './sidepots.js';

const TEMPER = 1 / 3;
const DRAW_RATE = 0.24;

const rating = (teams, name) => {
  const o = teamOdds(teams, name);
  return o ? Math.pow(strengthOf(o), TEMPER) : 0;
};

// Single-match probabilities under the sim's model. Group games can draw;
// knockout ties always produce a winner (extra time + pens).
export function matchProbs(teams, home, away, isGroup) {
  const rh = rating(teams, home), ra = rating(teams, away);
  if (!rh || !ra) return null;
  const pH = rh / (rh + ra);
  if (!isGroup) return { home: pH, draw: 0, away: 1 - pH };
  return { home: (1 - DRAW_RATE) * pH, draw: DRAW_RATE, away: (1 - DRAW_RATE) * (1 - pH) };
}

const fair = (p) => Math.round((1 / p) * 100) / 100;
const pctTxt = (p) => (p * 100).toFixed(0) + '%';
function surname(name) { const parts = String(name).trim().split(/\s+/); return parts[parts.length - 1]; }
function nameKey(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, ''); }

// AEST calendar-date key for a UTC kickoff (no DST in Brisbane: fixed +10).
export function aestDate(isoOrTs) {
  const t = typeof isoOrTs === 'number' ? isoOrTs : Date.parse(isoOrTs);
  return new Date(t + 10 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ================= generation ================= */

// marketOdds: {matchNo: {home: avgDecimal, away: avgDecimal, draw: avgDecimal}} or {}
// Returns the day's top-10 bets, deterministic for a given (date, data) input.
export function generateBets(ctx, sim, {
  date, bootCandidates = [], ranks = {}, marketOdds = {}, maxBets = 10, now = Date.now(),
} = {}) {
  const { teams, fixtures, scores } = ctx;
  const rnd = mulberry32([...date].reduce((s, c) => s * 31 + c.charCodeAt(0) | 0, 7));
  const bracket = predictBracket(teams, fixtures, scores);
  const gDoneNow = groupsComplete(fixtures, scores);
  const byNo = {};
  fixtures.forEach((m) => { byNo[m.no] = m; });
  // A knockout fixture only enters the slate once its participants are
  // CONFIRMED — group stage finished and every feeder match decided. Betting
  // on a predicted line-up would be settling a different match.
  function participantsKnown(code) {
    if (/^[WL]\d+$/.test(code)) {
      const feeder = byNo[+code.slice(1)];
      return bracket.resolveMatch(feeder.no).played
        && participantsKnown(feeder.h) && participantsKnown(feeder.a);
    }
    return gDoneNow; // 1A/2B/3XXXX slots resolve from final group tables
  }
  const slate = fixtures
    // never call a match that has kicked off — a delayed cron run must not
    // produce in-play or after-the-fact picks ("picks lock each morning")
    .filter((m) => aestDate(m.d) === date && !hasScore(scores, m.no) && Date.parse(m.d) > now)
    .filter((m) => m.r <= 3 || (participantsKnown(m.h) && participantsKnown(m.a)))
    .sort((a, b) => Date.parse(a.d) - Date.parse(b.d));

  const singles = [], scorers = [];

  for (const m of slate) {
    const isGroup = m.r <= 3;
    const r = bracket.resolveMatch(m.no);
    const home = isGroup ? m.h : r.home, away = isGroup ? m.a : r.away;
    if (home.includes('Best 3rd') || away.includes('Best 3rd') || home === '?' || away === '?') continue;
    const p = matchProbs(teams, home, away, isGroup);
    if (!p) continue;
    const sides = [
      { team: home, opp: away, prob: p.home },
      { team: away, opp: home, prob: p.away },
    ].sort((a, b) => b.prob - a.prob);
    const fav = sides[0];
    // 0.50+ outright (draw included as a loser) is already a strong group-play
    // favourite — the 24% draw rate caps any side at 76%.
    if (fav.prob >= 0.5) {
      const mkt = marketOdds[m.no];
      const price = mkt ? (fav.team === home ? mkt.home : mkt.away) : null;
      const edge = price ? fav.prob * price - 1 : null;
      const drawLine = isGroup ? ` A draw lands ${pctTxt(DRAW_RATE)} of the time in group play — that's the main risk.` : ' Knockout football: someone has to win, even if it takes penalties.';
      singles.push({
        type: 'single',
        name: `The ${fav.team} Banker`,
        selection: `${fav.team} to beat ${fav.opp}${isGroup ? '' : ' (to advance)'}`,
        matchNo: m.no,
        prob: fav.prob,
        fairOdds: fair(fav.prob),
        marketOdds: price,
        edge,
        comment: `Our model rates ${fav.team} a ${pctTxt(fav.prob)} chance against ${fav.opp} off the tournament-winner odds gap (fair price ${fair(fav.prob)}).`
          + (price ? ` The market average is ${price.toFixed(2)} — ${edge >= 0.03 ? `a ${(edge * 100).toFixed(0)}% edge over the books` : edge >= 0 ? 'roughly fair' : 'shorter than fair, so only take a better price'}.` : ` Anything above ${fair(fav.prob * 0.92)} at the books beats the model with margin.`)
          + drawLine,
        settle: { kind: 'match', no: m.no, team: fav.team },
        status: 'pending',
      });
    }

    // anytime-scorer angles: elite boot candidates against far weaker defences
    const sideRank = { [home]: ranks[home] ?? 999, [away]: ranks[away] ?? 999 };
    for (const c of bootCandidates.slice(0, 26)) {
      if (c.team !== home && c.team !== away) continue;
      const opp = c.team === home ? away : home;
      const gap = (sideRank[opp] ?? 999) - (sideRank[c.team] ?? 999);
      if (gap < 15) continue;
      const tier1 = bootCandidates.indexOf(c) < 13;
      const prob = Math.min(0.62, 0.3 + 0.004 * Math.min(gap, 50) + (tier1 ? 0.08 : 0));
      scorers.push({
        type: 'scorer',
        name: `${surname(c.name)} Strikes`,
        selection: `${c.name} (${c.team}) anytime scorer v ${opp}`,
        matchNo: m.no,
        prob,
        fairOdds: fair(prob),
        marketOdds: null,
        edge: null,
        comment: `${c.name} sits in the top ${tier1 ? '13' : '26'} of the Golden Boot market (${c.odds}) and ${c.team} (FIFA #${sideRank[c.team]}) face #${sideRank[opp]} ${opp} — a ${gap}-place class gap. Heuristic estimate ~${pctTxt(prob)} to score anytime; typical anytime prices on players like this comfortably beat ${fair(prob)}.`,
        settle: { kind: 'scorer', no: m.no, team: c.team, who: c.name },
        status: 'pending',
      });
    }
  }
  scorers.sort((a, b) => b.prob - a.prob);

  // multi: combine the day's best independent singles
  const multis = [];
  const legs = singles.slice().sort((a, b) => b.prob - a.prob).slice(0, 3);
  if (legs.length >= 2) {
    const joint = legs.reduce((s, l) => s * l.prob, 1);
    const jointMkt = legs.every((l) => l.marketOdds) ? legs.reduce((s, l) => s * l.marketOdds, 1) : null;
    multis.push({
      type: 'multi',
      name: legs.length === 3 ? 'The Matchday Treble' : 'The Matchday Double',
      selection: legs.map((l) => l.selection).join('  +  '),
      matchNo: null,
      prob: joint,
      fairOdds: fair(joint),
      marketOdds: jointMkt,
      edge: jointMkt ? joint * jointMkt - 1 : null,
      comment: `Stack the day's ${legs.length} strongest favourites (${legs.map((l) => `${l.settle.team} ${pctTxt(l.prob)}`).join(', ')}). Independent results put the combo at ${pctTxt(joint)} — fair odds ${fair(joint)}${jointMkt ? `, books pay ~${jointMkt.toFixed(2)}` : ''}. One upset kills it; that's the gamble.`,
      settle: { kind: 'multi', legs: legs.map((l) => l.settle) },
      status: 'pending',
    });
  }

  // wildcards from the Monte-Carlo: group crowns, deep-run, qualify and
  // outright-value calls
  const wildcards = [];
  const gDone = groupsComplete(fixtures, scores);
  if (!gDone && sim?.teams) {
    Object.entries(sim.teams)
      .filter(([, s]) => s.winGroup >= 0.58 && s.winGroup <= 0.93)
      .sort((a, b) => b[1].winGroup - a[1].winGroup)
      .slice(0, 4)
      .forEach(([team, s]) => {
        const g = teams.find((t) => t.n === team)?.g;
        wildcards.push({
          type: 'wildcard',
          name: `${team} Group ${g} Crown`,
          selection: `${team} to win Group ${g}`,
          matchNo: null,
          prob: s.winGroup,
          fairOdds: fair(s.winGroup),
          marketOdds: null,
          edge: null,
          comment: `Across 30,000 simulated tournaments ${team} top Group ${g} ${pctTxt(s.winGroup)} of the time (and reach the knockouts ${pctTxt(s.last32)}). Fair odds ${fair(s.winGroup)} — group-winner markets are often lazier than match odds, so value hides here.`,
          settle: { kind: 'group', g, team },
          status: 'pending',
        });
      });
  }
  if (sim?.teams) {
    Object.entries(sim.teams)
      .filter(([team, s]) => s.last8 >= 0.28 && s.last8 <= 0.75 && (ranks[team] ?? 0) >= 8)
      .sort((a, b) => b[1].last8 - a[1].last8)
      .slice(0, 3)
      .forEach(([team, s]) => {
        wildcards.push({
          type: 'wildcard',
          name: `${team} Quarter Club`,
          selection: `${team} to reach the Quarter-finals (Last 8)`,
          matchNo: null,
          prob: s.last8,
          fairOdds: fair(s.last8),
          marketOdds: null,
          edge: null,
          comment: `The sim sends ${team} (FIFA #${ranks[team] ?? '—'}) to the last 8 in ${pctTxt(s.last8)} of 30,000 tournaments — fair odds ${fair(s.last8)}. Outside the top seeds the "to reach the quarters" market routinely pays better than that.`,
          settle: { kind: 'last8', team },
          status: 'pending',
        });
      });
    // mid-tier "to reach the knockouts" calls — the quiet-day bread and butter
    if (!gDone) {
      Object.entries(sim.teams)
        .filter(([team, s]) => s.last32 >= 0.5 && s.last32 <= 0.88 && (ranks[team] ?? 0) >= 25)
        .sort((a, b) => b[1].last32 - a[1].last32)
        .slice(0, 3)
        .forEach(([team, s]) => {
          wildcards.push({
            type: 'wildcard',
            name: `${team} Ticket to the Dance`,
            selection: `${team} to qualify for the knockout stage`,
            matchNo: null,
            prob: s.last32,
            fairOdds: fair(s.last32),
            marketOdds: null,
            edge: null,
            comment: `FIFA #${ranks[team]} ${team} make the last 32 in ${pctTxt(s.last32)} of simulations — top two in the group or one of the eight best thirds. Fair odds ${fair(s.last32)}; qualification markets on mid-tier sides are usually priced off name value, not the maths.`,
            settle: { kind: 'qualify', team },
            status: 'pending',
          });
        });
    }
    // outright value: where the sim's bracket-aware champion odds beat the
    // market's raw implied probability
    const totalStrength = teams.reduce((s, t) => s + strengthOf(t.o), 0);
    teams
      .map((t) => {
        const simP = sim.teams[t.n]?.champion ?? 0;
        const implied = strengthOf(t.o) / totalStrength;
        return { team: t.n, simP, implied, lift: implied > 0 ? simP / implied : 0 };
      })
      .filter((x) => x.simP >= 0.025 && x.lift >= 1.25)
      .sort((a, b) => b.lift - a.lift)
      .slice(0, 1)
      .forEach((x) => {
        wildcards.push({
          type: 'wildcard',
          name: `${x.team} Outright Steal`,
          selection: `${x.team} to win the World Cup`,
          matchNo: null,
          prob: x.simP,
          fairOdds: fair(x.simP),
          marketOdds: null,
          edge: null,
          comment: `The outright market implies ${x.team} win the cup ${pctTxt(x.implied)} of the time, but our 30,000 bracket-aware simulations make it ${pctTxt(x.simP)} — ${Math.round((x.lift - 1) * 100)}% more often, mostly thanks to a kind draw path. Long-shot, but the price is wrong.`,
          settle: { kind: 'champion', team: x.team },
          status: 'pending',
        });
      });
  }

  // assemble two books of five:
  //  'today'  — bets that FINALISE today (singles, the multi, scorers)
  //  'longer' — tournament-length wildcards (crowns, runs, outrights)
  singles.sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0) || b.prob - a.prob);
  const today = [];
  const pushUnique = (arr, b, cap) => { if (b && arr.length < cap && !arr.includes(b)) arr.push(b); };
  singles.slice(0, 3).forEach((b) => pushUnique(today, b, 5));
  pushUnique(today, multis[0], 5);
  pushUnique(today, scorers[0], 5);
  [...singles.slice(3), ...scorers.slice(1)].sort((a, b) => b.prob - a.prob)
    .forEach((b) => pushUnique(today, b, 5));

  const longer = [];
  const crowns = wildcards.filter((w) => w.settle.kind === 'group');
  const quals = wildcards.filter((w) => w.settle.kind === 'qualify');
  const quarters = wildcards.filter((w) => w.settle.kind === 'last8');
  const outrights = wildcards.filter((w) => w.settle.kind === 'champion');
  crowns.slice(0, 2).forEach((b) => pushUnique(longer, b, 5));
  pushUnique(longer, quals[0], 5);
  pushUnique(longer, quarters[0], 5);
  pushUnique(longer, outrights[0], 5);
  wildcards.slice().sort((a, b) => b.prob - a.prob)
    .forEach((b) => pushUnique(longer, b, 5));

  today.forEach((b) => { b.group = 'today'; });
  longer.forEach((b) => { b.group = 'longer'; });
  const picks = [...today, ...longer].slice(0, maxBets);
  picks.forEach((b, i) => {
    b.id = `${date}-${i + 1}`;
    // $100 flat-stake simulation, price locked at call time: real market odds
    // when we have them, otherwise the model's fair odds
    b.stake = 100;
    b.payoutOdds = b.marketOdds ?? b.fairOdds;
  });
  void rnd;
  return picks;
}

// $100-simulation profit/loss for one bet: stake × (odds − 1) when it lands,
// −stake when it busts, 0 while pending.
export function betPnl(b) {
  const stake = b.stake ?? 100;
  const odds = b.payoutOdds ?? b.marketOdds ?? b.fairOdds;
  if (b.status === 'won') return Math.round(stake * (odds - 1) * 100) / 100;
  if (b.status === 'lost') return -stake;
  return 0;
}

/* ================= settlement ================= */

// goalEvents: [{team, who, ymd, eventId}] banked from ESPN.
// fetchedDays: ESPN days fully harvested (so a missing scorer means "didn't score").
export function settleBets(bets, ctx, { goalEvents = [], fetchedDays = [] } = {}) {
  const { teams, fixtures, scores } = ctx;
  const bracket = predictBracket(teams, fixtures, scores);
  const gDone = groupsComplete(fixtures, scores);
  const stage = gDone ? stageReached(teams, fixtures, scores) : null;
  const st = gDone ? computeStandings(teams, fixtures, scores) : null;
  const gmap = gDone ? teamByGroupRank(st) : null;
  const byNo = {};
  fixtures.forEach((m) => { byNo[m.no] = m; });
  const fetched = new Set(fetchedDays);

  // FIFA breaks pts/GD/GF dead heats by head-to-head, fair play, then lots —
  // none of which our composite models (it falls back to betting strength).
  // When the deciding boundary is a genuine dead heat we must NOT hand out a
  // permanent won/lost off the wrong tiebreaker: stay pending for the admin.
  const tupleEq = (a, b) => a.pts === b.pts && a.gd === b.gd && a.gf === b.gf;
  const groupArr = (g) => Object.values(st).filter((x) => x.g === g).sort((a, b) => a.rank - b.rank);
  const thirdsArr = () => Object.values(st).filter((x) => x.rank === 3).sort((a, b) => b.comp - a.comp);

  function settleOne(spec) {
    switch (spec.kind) {
      case 'match': {
        if (!hasScore(scores, spec.no)) return 'pending';
        const m = byNo[spec.no], s = scores[spec.no];
        // a drawn group game busts any side pick; a level knockout score
        // stays pending until the feed names the shootout winner
        if (m.r <= 3 && Number(s.h) === Number(s.a)) return 'lost';
        const r = bracket.resolveMatch(spec.no);
        if (!r.played) return 'pending';
        return r.winner === spec.team ? 'won' : 'lost';
      }
      case 'multi': {
        const legs = spec.legs.map(settleOne);
        if (legs.includes('lost')) return 'lost';
        if (legs.every((s) => s === 'won')) return 'won';
        return 'pending';
      }
      case 'scorer': {
        if (!hasScore(scores, spec.no)) return 'pending';
        const m = byNo[spec.no], s = scores[spec.no];
        // resolve sides through the bracket so knockout slot codes map to teams
        const r = bracket.resolveMatch(spec.no);
        const teamGoals = r.home === spec.team ? Number(s.h) : r.away === spec.team ? Number(s.a) : null;
        if (teamGoals == null) return 'pending'; // team not in this match (should not happen)
        if (teamGoals === 0) return 'lost'; // nobody on that side scored
        const ymd = String(m.d).slice(0, 10);
        const k = nameKey(spec.who), sn = nameKey(surname(spec.who));
        const scored = goalEvents.some((g) => {
          if (g.team !== spec.team || g.ymd !== ymd) return false;
          const gk = nameKey(g.who);
          if (gk === k) return true;
          // Surname fallback ONLY for feed names abbreviated to an initial
          // ("L. Martínez"): a full different given name must never match —
          // Lisandro Martínez's goal is not Lautaro Martínez's bet.
          if (nameKey(surname(g.who)) !== sn) return false;
          const given = nameKey(String(g.who).trim().split(/\s+/).slice(0, -1).join(' '));
          return given.length <= 1 && (given === '' || given[0] === k[0]);
        });
        if (scored) return 'won';
        return fetched.has(ymd.replace(/-/g, '')) ? 'lost' : 'pending';
      }
      case 'group': {
        if (!gDone) return 'pending';
        const arr = groupArr(spec.g);
        if (tupleEq(arr[0], arr[1])) return 'pending'; // dead heat for top spot
        return gmap[spec.g + '1'] === spec.team ? 'won' : 'lost';
      }
      case 'qualify': {
        if (!gDone || !stage) return 'pending';
        const x = st[spec.team];
        if (x) {
          const arr = groupArr(x.g);
          // dead heat across the runner-up / third-place boundary
          if ((x.rank === 2 || x.rank === 3) && tupleEq(arr[1], arr[2])) return 'pending';
          // dead heat across the 8th / 9th best-third cut
          if (x.rank === 3) {
            const t = thirdsArr();
            const i = t.findIndex((y) => y.n === spec.team);
            if ((i <= 7 && t[8] && tupleEq(t[i], t[8])) || (i >= 8 && t[7] && tupleEq(t[i], t[7]))) return 'pending';
          }
        }
        return stage[spec.team] >= 1 ? 'won' : 'lost';
      }
      case 'champion': {
        if (stage && stage[spec.team] === 6) return 'won';
        const out = fixtures.filter((m) => m.r >= 4 && m.r !== 8).some((m) => {
          const r = bracket.resolveMatch(m.no);
          return r.played && r.loser === spec.team;
        });
        if (out) return 'lost';
        if (gDone && stage && stage[spec.team] === 0) return 'lost';
        return 'pending';
      }
      case 'last8': {
        if (stage && stage[spec.team] >= 3) return 'won';
        // lost once eliminated before the quarters
        if (!gDone) return 'pending';
        if (stage[spec.team] === 0) return 'lost'; // out at the group stage
        // in the knockouts: lost if beaten before reaching stage 3
        const lostBefore = fixtures.filter((m) => (m.r === 4 || m.r === 5)).some((m) => {
          const r = bracket.resolveMatch(m.no);
          return r.played && r.loser === spec.team;
        });
        return lostBefore ? 'lost' : 'pending';
      }
      default:
        return 'pending';
    }
  }

  // Re-derive every status each run so a corrected feed score self-heals a
  // settlement (everything settleOne reads is banked and deterministic). An
  // already-settled status only survives when the fresh derivation says
  // 'pending' — i.e. the feed momentarily dropped data.
  return bets.map((b) => {
    const fresh = settleOne(b.settle);
    const status = fresh === 'pending' && b.status !== 'pending' ? b.status : fresh;
    return status === b.status ? b : { ...b, status };
  });
}

// Roll the daily book forward: settle everything, archive yesterday, freeze
// today's picks (generate only once per AEST date).
export function rollBets(previousBets, ctx, sim, opts) {
  const { date } = opts;
  const prev = previousBets || { current: null, history: [] };
  const settleOpts = { goalEvents: opts.goalEvents, fetchedDays: opts.fetchedDays };
  let history = (prev.history || []).map((day) => ({
    ...day,
    bets: settleBets(day.bets, ctx, settleOpts),
  }));
  let current = prev.current ? { ...prev.current, bets: settleBets(prev.current.bets, ctx, settleOpts) } : null;
  if (current && current.date !== date) {
    history = [...history, current].slice(-45);
    current = null;
  }
  if (!current) {
    current = { date, bets: settleBets(generateBets(ctx, sim, opts), ctx, settleOpts) };
  }
  return { current, history };
}
