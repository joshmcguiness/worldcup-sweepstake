// Parsers for ESPN's (undocumented, free) soccer JSON API — used to auto-feed
// the Chaos Pot. Pure functions only; fetching lives in build/refresh.js.
//
//   scoreboard: site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD
//     -> per completed match, details[] rows carry ownGoal / redCard booleans
//        and athletesInvolved[].position ("G" = goalkeeper) on scoring plays.
//   summary:    .../fifa.world/summary?event={id}
//     -> keyEvents[] is the only place regulation penalty misses appear
//        (type id 114 "Penalty - Saved" / "Penalty - Missed", shootout=false).
//
// The API is unofficial and may drift — every parser is defensive and the
// build job treats failures as "no auto events this run" (manual config
// events always still count).
import { mapName } from './teams.js';

// ESPN team display name -> our team name (mapName already handles most
// aliases: United States, South Korea, Ivory Coast, DR Congo, Czech Republic…)
export function espnTeam(name) {
  return name ? mapName(name) : null;
}

function isCompleted(event) {
  return Boolean(event?.status?.type?.completed);
}

function competitorNameById(comp) {
  const byId = {};
  (comp?.competitors || []).forEach((c) => {
    if (c?.id != null) byId[String(c.id)] = c.team?.displayName || c.team?.name || '';
  });
  return byId;
}

// Goalkeeper athlete ids from a match summary's rosters. Substitutes appear
// in scoreboard details with position 'SUB', so the lineup position alone
// misses a subbed-on keeper who scores — the roster carries the real position.
export function goalkeeperIds(summary) {
  const ids = new Set();
  for (const side of summary?.rosters || []) {
    for (const entry of side?.roster || []) {
      const pos = entry?.position?.abbreviation || entry?.position;
      if (pos === 'G' && entry?.athlete?.id != null) ids.add(String(entry.athlete.id));
    }
  }
  return ids;
}

// Own goals, red cards and goalkeeper goals from one scoreboard event.
// NOTE: an own goal's detail row is credited to the team AWARDED the goal —
// the chaos points belong to the team that scored it, i.e. the other side.
// gkIds (from goalkeeperIds) catches keepers whose lineup position is 'SUB'.
export function chaosFromScoreboardEvent(event, gkIds = new Set()) {
  const out = [];
  if (!isCompleted(event)) return out;
  const comp = (event.competitions || [])[0];
  if (!comp) return out;
  const teamName = competitorNameById(comp);
  const names = Object.values(teamName).map((n) => espnTeam(n)).filter(Boolean);
  const otherTeam = (ours) => names.find((n) => n !== ours) || null;
  for (const d of comp.details || []) {
    if (d?.shootout) continue;
    const team = espnTeam(teamName[String(d?.team?.id)]);
    if (!team) continue;
    if (d.ownGoal) {
      const scorer = (d.athletesInvolved || [])[0];
      const concedingTeam = otherTeam(team); // the team whose player scored it
      if (concedingTeam) {
        out.push({ team: concedingTeam, type: 'ownGoal', who: scorer?.displayName || '', source: 'espn', eventId: event.id });
      }
    } else if (d.redCard) {
      const who = (d.athletesInvolved || [])[0];
      out.push({ team, type: 'redCard', who: who?.displayName || '', source: 'espn', eventId: event.id });
    } else if (d.scoringPlay) {
      const scorer = (d.athletesInvolved || [])[0];
      const pos = scorer?.position?.abbreviation || scorer?.position;
      if (pos === 'G' || (scorer?.id != null && gkIds.has(String(scorer.id)))) {
        out.push({ team, type: 'gkGoal', who: scorer?.displayName || '', source: 'espn', eventId: event.id });
      }
    }
  }
  return out;
}

// Goal scorers from one scoreboard event (regulation + extra time, no
// shootout rows, no own goals) — used to settle anytime-scorer bets.
// ymd comes from the EVENT'S OWN kickoff (UTC), never the scoreboard query
// day: ESPN buckets its scoreboard pages by US-Eastern day, so a 02:00Z
// kickoff lives on the previous day's page — keying by page day would make
// settlement (which joins on the fixture's UTC date) miss every late game.
export function goalsFromScoreboardEvent(event, fallbackYmd) {
  const out = [];
  if (!isCompleted(event)) return out;
  const comp = (event.competitions || [])[0];
  if (!comp) return out;
  const ymd = (typeof event.date === 'string' && event.date.length >= 10)
    ? event.date.slice(0, 10) : fallbackYmd;
  const teamName = competitorNameById(comp);
  for (const d of comp.details || []) {
    if (!d?.scoringPlay || d.shootout || d.ownGoal) continue;
    const team = espnTeam(teamName[String(d?.team?.id)]);
    const who = (d.athletesInvolved || [])[0]?.displayName;
    if (team && who) out.push({ team, who, ymd, eventId: event.id });
  }
  return out;
}

// Regulation penalty misses from one summary payload.
export function penaltyMissesFromSummary(summary, eventId) {
  const out = [];
  for (const k of summary?.keyEvents || []) {
    if (k?.shootout) continue;
    const id = String(k?.type?.id ?? '');
    const text = String(k?.type?.text ?? '');
    if (id === '114' || /penalty\s*[-–]?\s*(saved|missed)/i.test(text)) {
      const team = espnTeam(k?.team?.displayName || k?.team?.name);
      if (team) {
        const who = (k.participants || [])[0]?.athlete || (k.athletesInvolved || [])[0];
        out.push({ team, type: 'penaltyMiss', who: who?.displayName || '', source: 'espn', eventId });
      }
    }
  }
  return out;
}

// Completed event ids worth fetching summaries for.
export function completedEventIds(scoreboard) {
  return (scoreboard?.events || []).filter(isCompleted).map((e) => e.id);
}
