import { mapName } from './teams.js';

// All 104 matches of the 2026 World Cup. Knockout rows use slot codes
// (1A = winner of group A, 3CEFHI = a best-third from those groups,
// W74 / L101 = winner/loser of that match number) until teams are known.
// Keyed by `no` (= MatchNumber in the fixturedownload.com feed).
export const FIX = [
  {"no": 1, "r": 1, "rn": "Group", "d": "2026-06-11T19:00:00Z", "v": "Mexico City Stadium", "h": "Mexico", "a": "South Africa", "g": "A"},
  {"no": 2, "r": 1, "rn": "Group", "d": "2026-06-12T02:00:00Z", "v": "Guadalajara Stadium", "h": "Korea Republic", "a": "Czechia", "g": "A"},
  {"no": 3, "r": 1, "rn": "Group", "d": "2026-06-12T19:00:00Z", "v": "Toronto Stadium", "h": "Canada", "a": "Bosnia and Herzegovina", "g": "B"},
  {"no": 4, "r": 1, "rn": "Group", "d": "2026-06-13T01:00:00Z", "v": "Los Angeles Stadium", "h": "USA", "a": "Paraguay", "g": "D"},
  {"no": 5, "r": 1, "rn": "Group", "d": "2026-06-14T01:00:00Z", "v": "Boston Stadium", "h": "Haiti", "a": "Scotland", "g": "C"},
  {"no": 6, "r": 1, "rn": "Group", "d": "2026-06-14T04:00:00Z", "v": "BC Place Vancouver", "h": "Australia", "a": "Türkiye", "g": "D"},
  {"no": 7, "r": 1, "rn": "Group", "d": "2026-06-13T22:00:00Z", "v": "New York/New Jersey Stadium", "h": "Brazil", "a": "Morocco", "g": "C"},
  {"no": 8, "r": 1, "rn": "Group", "d": "2026-06-13T19:00:00Z", "v": "San Francisco Bay Area Stadium", "h": "Qatar", "a": "Switzerland", "g": "B"},
  {"no": 9, "r": 1, "rn": "Group", "d": "2026-06-14T23:00:00Z", "v": "Philadelphia Stadium", "h": "Côte d'Ivoire", "a": "Ecuador", "g": "E"},
  {"no": 10, "r": 1, "rn": "Group", "d": "2026-06-14T17:00:00Z", "v": "Houston Stadium", "h": "Germany", "a": "Curaçao", "g": "E"},
  {"no": 11, "r": 1, "rn": "Group", "d": "2026-06-14T20:00:00Z", "v": "Dallas Stadium", "h": "Netherlands", "a": "Japan", "g": "F"},
  {"no": 12, "r": 1, "rn": "Group", "d": "2026-06-15T02:00:00Z", "v": "Monterrey Stadium", "h": "Sweden", "a": "Tunisia", "g": "F"},
  {"no": 13, "r": 1, "rn": "Group", "d": "2026-06-15T22:00:00Z", "v": "Miami Stadium", "h": "Saudi Arabia", "a": "Uruguay", "g": "H"},
  {"no": 14, "r": 1, "rn": "Group", "d": "2026-06-15T16:00:00Z", "v": "Atlanta Stadium", "h": "Spain", "a": "Cabo Verde", "g": "H"},
  {"no": 15, "r": 1, "rn": "Group", "d": "2026-06-16T01:00:00Z", "v": "Los Angeles Stadium", "h": "IR Iran", "a": "New Zealand", "g": "G"},
  {"no": 16, "r": 1, "rn": "Group", "d": "2026-06-15T19:00:00Z", "v": "Seattle Stadium", "h": "Belgium", "a": "Egypt", "g": "G"},
  {"no": 17, "r": 1, "rn": "Group", "d": "2026-06-16T19:00:00Z", "v": "New York/New Jersey Stadium", "h": "France", "a": "Senegal", "g": "I"},
  {"no": 18, "r": 1, "rn": "Group", "d": "2026-06-16T22:00:00Z", "v": "Boston Stadium", "h": "Iraq", "a": "Norway", "g": "I"},
  {"no": 19, "r": 1, "rn": "Group", "d": "2026-06-17T01:00:00Z", "v": "Kansas City Stadium", "h": "Argentina", "a": "Algeria", "g": "J"},
  {"no": 20, "r": 1, "rn": "Group", "d": "2026-06-17T04:00:00Z", "v": "San Francisco Bay Area Stadium", "h": "Austria", "a": "Jordan", "g": "J"},
  {"no": 21, "r": 1, "rn": "Group", "d": "2026-06-17T23:00:00Z", "v": "Toronto Stadium", "h": "Ghana", "a": "Panama", "g": "L"},
  {"no": 22, "r": 1, "rn": "Group", "d": "2026-06-17T20:00:00Z", "v": "Dallas Stadium", "h": "England", "a": "Croatia", "g": "L"},
  {"no": 23, "r": 1, "rn": "Group", "d": "2026-06-17T17:00:00Z", "v": "Houston Stadium", "h": "Portugal", "a": "Congo DR", "g": "K"},
  {"no": 24, "r": 1, "rn": "Group", "d": "2026-06-18T02:00:00Z", "v": "Mexico City Stadium", "h": "Uzbekistan", "a": "Colombia", "g": "K"},
  {"no": 25, "r": 2, "rn": "Group", "d": "2026-06-18T16:00:00Z", "v": "Atlanta Stadium", "h": "Czechia", "a": "South Africa", "g": "A"},
  {"no": 26, "r": 2, "rn": "Group", "d": "2026-06-18T19:00:00Z", "v": "Los Angeles Stadium", "h": "Switzerland", "a": "Bosnia and Herzegovina", "g": "B"},
  {"no": 27, "r": 2, "rn": "Group", "d": "2026-06-18T22:00:00Z", "v": "BC Place Vancouver", "h": "Canada", "a": "Qatar", "g": "B"},
  {"no": 28, "r": 2, "rn": "Group", "d": "2026-06-19T01:00:00Z", "v": "Guadalajara Stadium", "h": "Mexico", "a": "Korea Republic", "g": "A"},
  {"no": 29, "r": 2, "rn": "Group", "d": "2026-06-20T01:00:00Z", "v": "Philadelphia Stadium", "h": "Brazil", "a": "Haiti", "g": "C"},
  {"no": 30, "r": 2, "rn": "Group", "d": "2026-06-19T22:00:00Z", "v": "Boston Stadium", "h": "Scotland", "a": "Morocco", "g": "C"},
  {"no": 31, "r": 2, "rn": "Group", "d": "2026-06-20T04:00:00Z", "v": "San Francisco Bay Area Stadium", "h": "Türkiye", "a": "Paraguay", "g": "D"},
  {"no": 32, "r": 2, "rn": "Group", "d": "2026-06-19T19:00:00Z", "v": "Seattle Stadium", "h": "USA", "a": "Australia", "g": "D"},
  {"no": 33, "r": 2, "rn": "Group", "d": "2026-06-20T20:00:00Z", "v": "Toronto Stadium", "h": "Germany", "a": "Côte d'Ivoire", "g": "E"},
  {"no": 34, "r": 2, "rn": "Group", "d": "2026-06-21T00:00:00Z", "v": "Kansas City Stadium", "h": "Ecuador", "a": "Curaçao", "g": "E"},
  {"no": 35, "r": 2, "rn": "Group", "d": "2026-06-20T17:00:00Z", "v": "Houston Stadium", "h": "Netherlands", "a": "Sweden", "g": "F"},
  {"no": 36, "r": 2, "rn": "Group", "d": "2026-06-21T04:00:00Z", "v": "Monterrey Stadium", "h": "Tunisia", "a": "Japan", "g": "F"},
  {"no": 37, "r": 2, "rn": "Group", "d": "2026-06-21T22:00:00Z", "v": "Miami Stadium", "h": "Uruguay", "a": "Cabo Verde", "g": "H"},
  {"no": 38, "r": 2, "rn": "Group", "d": "2026-06-21T16:00:00Z", "v": "Atlanta Stadium", "h": "Spain", "a": "Saudi Arabia", "g": "H"},
  {"no": 39, "r": 2, "rn": "Group", "d": "2026-06-21T19:00:00Z", "v": "Los Angeles Stadium", "h": "Belgium", "a": "IR Iran", "g": "G"},
  {"no": 40, "r": 2, "rn": "Group", "d": "2026-06-22T01:00:00Z", "v": "BC Place Vancouver", "h": "New Zealand", "a": "Egypt", "g": "G"},
  {"no": 41, "r": 2, "rn": "Group", "d": "2026-06-23T00:00:00Z", "v": "New York/New Jersey Stadium", "h": "Norway", "a": "Senegal", "g": "I"},
  {"no": 42, "r": 2, "rn": "Group", "d": "2026-06-22T21:00:00Z", "v": "Philadelphia Stadium", "h": "France", "a": "Iraq", "g": "I"},
  {"no": 43, "r": 2, "rn": "Group", "d": "2026-06-22T17:00:00Z", "v": "Dallas Stadium", "h": "Argentina", "a": "Austria", "g": "J"},
  {"no": 44, "r": 2, "rn": "Group", "d": "2026-06-23T03:00:00Z", "v": "San Francisco Bay Area Stadium", "h": "Jordan", "a": "Algeria", "g": "J"},
  {"no": 45, "r": 2, "rn": "Group", "d": "2026-06-23T20:00:00Z", "v": "Boston Stadium", "h": "England", "a": "Ghana", "g": "L"},
  {"no": 46, "r": 2, "rn": "Group", "d": "2026-06-23T23:00:00Z", "v": "Toronto Stadium", "h": "Panama", "a": "Croatia", "g": "L"},
  {"no": 47, "r": 2, "rn": "Group", "d": "2026-06-23T17:00:00Z", "v": "Houston Stadium", "h": "Portugal", "a": "Uzbekistan", "g": "K"},
  {"no": 48, "r": 2, "rn": "Group", "d": "2026-06-24T02:00:00Z", "v": "Guadalajara Stadium", "h": "Colombia", "a": "Congo DR", "g": "K"},
  {"no": 49, "r": 3, "rn": "Group", "d": "2026-06-24T22:00:00Z", "v": "Miami Stadium", "h": "Scotland", "a": "Brazil", "g": "C"},
  {"no": 50, "r": 3, "rn": "Group", "d": "2026-06-24T22:00:00Z", "v": "Atlanta Stadium", "h": "Morocco", "a": "Haiti", "g": "C"},
  {"no": 51, "r": 3, "rn": "Group", "d": "2026-06-24T19:00:00Z", "v": "BC Place Vancouver", "h": "Switzerland", "a": "Canada", "g": "B"},
  {"no": 52, "r": 3, "rn": "Group", "d": "2026-06-24T19:00:00Z", "v": "Seattle Stadium", "h": "Bosnia and Herzegovina", "a": "Qatar", "g": "B"},
  {"no": 53, "r": 3, "rn": "Group", "d": "2026-06-25T01:00:00Z", "v": "Mexico City Stadium", "h": "Czechia", "a": "Mexico", "g": "A"},
  {"no": 54, "r": 3, "rn": "Group", "d": "2026-06-25T01:00:00Z", "v": "Monterrey Stadium", "h": "South Africa", "a": "Korea Republic", "g": "A"},
  {"no": 55, "r": 3, "rn": "Group", "d": "2026-06-25T20:00:00Z", "v": "Philadelphia Stadium", "h": "Curaçao", "a": "Côte d'Ivoire", "g": "E"},
  {"no": 56, "r": 3, "rn": "Group", "d": "2026-06-25T20:00:00Z", "v": "New York/New Jersey Stadium", "h": "Ecuador", "a": "Germany", "g": "E"},
  {"no": 57, "r": 3, "rn": "Group", "d": "2026-06-25T23:00:00Z", "v": "Dallas Stadium", "h": "Japan", "a": "Sweden", "g": "F"},
  {"no": 58, "r": 3, "rn": "Group", "d": "2026-06-25T23:00:00Z", "v": "Kansas City Stadium", "h": "Tunisia", "a": "Netherlands", "g": "F"},
  {"no": 59, "r": 3, "rn": "Group", "d": "2026-06-26T02:00:00Z", "v": "Los Angeles Stadium", "h": "Türkiye", "a": "USA", "g": "D"},
  {"no": 60, "r": 3, "rn": "Group", "d": "2026-06-26T02:00:00Z", "v": "San Francisco Bay Area Stadium", "h": "Paraguay", "a": "Australia", "g": "D"},
  {"no": 61, "r": 3, "rn": "Group", "d": "2026-06-26T19:00:00Z", "v": "Boston Stadium", "h": "Norway", "a": "France", "g": "I"},
  {"no": 62, "r": 3, "rn": "Group", "d": "2026-06-26T19:00:00Z", "v": "Toronto Stadium", "h": "Senegal", "a": "Iraq", "g": "I"},
  {"no": 63, "r": 3, "rn": "Group", "d": "2026-06-27T03:00:00Z", "v": "Seattle Stadium", "h": "Egypt", "a": "IR Iran", "g": "G"},
  {"no": 64, "r": 3, "rn": "Group", "d": "2026-06-27T03:00:00Z", "v": "BC Place Vancouver", "h": "New Zealand", "a": "Belgium", "g": "G"},
  {"no": 65, "r": 3, "rn": "Group", "d": "2026-06-27T00:00:00Z", "v": "Houston Stadium", "h": "Cabo Verde", "a": "Saudi Arabia", "g": "H"},
  {"no": 66, "r": 3, "rn": "Group", "d": "2026-06-27T00:00:00Z", "v": "Guadalajara Stadium", "h": "Uruguay", "a": "Spain", "g": "H"},
  {"no": 67, "r": 3, "rn": "Group", "d": "2026-06-27T21:00:00Z", "v": "New York/New Jersey Stadium", "h": "Panama", "a": "England", "g": "L"},
  {"no": 68, "r": 3, "rn": "Group", "d": "2026-06-27T21:00:00Z", "v": "Philadelphia Stadium", "h": "Croatia", "a": "Ghana", "g": "L"},
  {"no": 69, "r": 3, "rn": "Group", "d": "2026-06-28T02:00:00Z", "v": "Kansas City Stadium", "h": "Algeria", "a": "Austria", "g": "J"},
  {"no": 70, "r": 3, "rn": "Group", "d": "2026-06-28T02:00:00Z", "v": "Dallas Stadium", "h": "Jordan", "a": "Argentina", "g": "J"},
  {"no": 71, "r": 3, "rn": "Group", "d": "2026-06-27T23:30:00Z", "v": "Miami Stadium", "h": "Colombia", "a": "Portugal", "g": "K"},
  {"no": 72, "r": 3, "rn": "Group", "d": "2026-06-27T23:30:00Z", "v": "Atlanta Stadium", "h": "Congo DR", "a": "Uzbekistan", "g": "K"},
  {"no": 73, "r": 4, "rn": "Round of 32", "d": "2026-06-28T19:00:00Z", "v": "Los Angeles Stadium", "h": "2A", "a": "2B", "g": ""},
  {"no": 74, "r": 4, "rn": "Round of 32", "d": "2026-06-29T20:30:00Z", "v": "Boston Stadium", "h": "1E", "a": "3ABCDF", "g": ""},
  {"no": 75, "r": 4, "rn": "Round of 32", "d": "2026-06-30T01:00:00Z", "v": "Monterrey Stadium", "h": "1F", "a": "2C", "g": ""},
  {"no": 76, "r": 4, "rn": "Round of 32", "d": "2026-06-29T17:00:00Z", "v": "Houston Stadium", "h": "1C", "a": "2F", "g": ""},
  {"no": 77, "r": 4, "rn": "Round of 32", "d": "2026-06-30T21:00:00Z", "v": "New York/New Jersey Stadium", "h": "1I", "a": "3CDFGH", "g": ""},
  {"no": 78, "r": 4, "rn": "Round of 32", "d": "2026-06-30T17:00:00Z", "v": "Dallas Stadium", "h": "2E", "a": "2I", "g": ""},
  {"no": 79, "r": 4, "rn": "Round of 32", "d": "2026-07-01T01:00:00Z", "v": "Mexico City Stadium", "h": "1A", "a": "3CEFHI", "g": ""},
  {"no": 80, "r": 4, "rn": "Round of 32", "d": "2026-07-01T16:00:00Z", "v": "Atlanta Stadium", "h": "1L", "a": "3EHIJK", "g": ""},
  {"no": 81, "r": 4, "rn": "Round of 32", "d": "2026-07-02T00:00:00Z", "v": "San Francisco Bay Area Stadium", "h": "1D", "a": "3BEFIJ", "g": ""},
  {"no": 82, "r": 4, "rn": "Round of 32", "d": "2026-07-01T20:00:00Z", "v": "Seattle Stadium", "h": "1G", "a": "3AEHIJ", "g": ""},
  {"no": 83, "r": 4, "rn": "Round of 32", "d": "2026-07-02T23:00:00Z", "v": "Toronto Stadium", "h": "2K", "a": "2L", "g": ""},
  {"no": 84, "r": 4, "rn": "Round of 32", "d": "2026-07-02T19:00:00Z", "v": "Los Angeles Stadium", "h": "1H", "a": "2J", "g": ""},
  {"no": 85, "r": 4, "rn": "Round of 32", "d": "2026-07-03T03:00:00Z", "v": "BC Place Vancouver", "h": "1B", "a": "3EFGIJ", "g": ""},
  {"no": 86, "r": 4, "rn": "Round of 32", "d": "2026-07-03T22:00:00Z", "v": "Miami Stadium", "h": "1J", "a": "2H", "g": ""},
  {"no": 87, "r": 4, "rn": "Round of 32", "d": "2026-07-04T01:30:00Z", "v": "Kansas City Stadium", "h": "1K", "a": "3DEIJL", "g": ""},
  {"no": 88, "r": 4, "rn": "Round of 32", "d": "2026-07-03T18:00:00Z", "v": "Dallas Stadium", "h": "2D", "a": "2G", "g": ""},
  {"no": 89, "r": 5, "rn": "Round of 16", "d": "2026-07-04T21:00:00Z", "v": "Philadelphia Stadium", "h": "W74", "a": "W77", "g": ""},
  {"no": 90, "r": 5, "rn": "Round of 16", "d": "2026-07-04T17:00:00Z", "v": "Houston Stadium", "h": "W73", "a": "W75", "g": ""},
  {"no": 91, "r": 5, "rn": "Round of 16", "d": "2026-07-05T20:00:00Z", "v": "New York/New Jersey Stadium", "h": "W76", "a": "W78", "g": ""},
  {"no": 92, "r": 5, "rn": "Round of 16", "d": "2026-07-06T00:00:00Z", "v": "Mexico City Stadium", "h": "W79", "a": "W80", "g": ""},
  {"no": 93, "r": 5, "rn": "Round of 16", "d": "2026-07-06T19:00:00Z", "v": "Dallas Stadium", "h": "W83", "a": "W84", "g": ""},
  {"no": 94, "r": 5, "rn": "Round of 16", "d": "2026-07-07T00:00:00Z", "v": "Seattle Stadium", "h": "W81", "a": "W82", "g": ""},
  {"no": 95, "r": 5, "rn": "Round of 16", "d": "2026-07-07T16:00:00Z", "v": "Atlanta Stadium", "h": "W86", "a": "W88", "g": ""},
  {"no": 96, "r": 5, "rn": "Round of 16", "d": "2026-07-07T20:00:00Z", "v": "BC Place Vancouver", "h": "W85", "a": "W87", "g": ""},
  {"no": 97, "r": 6, "rn": "Quarter-final", "d": "2026-07-09T20:00:00Z", "v": "Boston Stadium", "h": "W89", "a": "W90", "g": ""},
  {"no": 98, "r": 6, "rn": "Quarter-final", "d": "2026-07-10T19:00:00Z", "v": "Los Angeles Stadium", "h": "W93", "a": "W94", "g": ""},
  {"no": 99, "r": 6, "rn": "Quarter-final", "d": "2026-07-11T21:00:00Z", "v": "Miami Stadium", "h": "W91", "a": "W92", "g": ""},
  {"no": 100, "r": 6, "rn": "Quarter-final", "d": "2026-07-12T01:00:00Z", "v": "Kansas City Stadium", "h": "W95", "a": "W96", "g": ""},
  {"no": 101, "r": 7, "rn": "Semi-final", "d": "2026-07-14T19:00:00Z", "v": "Dallas Stadium", "h": "W97", "a": "W98", "g": ""},
  {"no": 102, "r": 7, "rn": "Semi-final", "d": "2026-07-15T19:00:00Z", "v": "Atlanta Stadium", "h": "W99", "a": "W100", "g": ""},
  {"no": 103, "r": 8, "rn": "3rd place", "d": "2026-07-18T21:00:00Z", "v": "Miami Stadium", "h": "L101", "a": "L102", "g": ""},
  {"no": 104, "r": 9, "rn": "Final", "d": "2026-07-19T19:00:00Z", "v": "New York/New Jersey Stadium", "h": "W101", "a": "W102", "g": ""},
];

export const FINAL_MATCH_NO = 104;
export const TOTAL_MATCHES = 104;

// Convert fixturedownload.com feed rows into a scores map
// {matchNo: {h, a, w?}}. We only trust scores from the feed; team names for
// knockout rounds are derived from our own bracket resolution.
// `w` is the feed's Winner field (normalised to our team names) — crucial for
// knockout ties decided on penalties, which the feed stores as LEVEL scores
// (verified against the 2022 feed: the 3-3 final only reveals Argentina via
// Winner). Without it a shootout would look like an unplayed draw.
export function scoresFromFeed(rows) {
  const scores = {};
  for (const m of rows || []) {
    if (m && m.MatchNumber != null && m.HomeTeamScore != null && m.AwayTeamScore != null) {
      const s = { h: Number(m.HomeTeamScore), a: Number(m.AwayTeamScore) };
      if (m.Winner) s.w = mapName(m.Winner) || m.Winner;
      scores[m.MatchNumber] = s;
    }
  }
  return scores;
}

export function hasScore(scores, no) {
  const s = scores[no];
  return Boolean(s) && s.h !== '' && s.a !== '' && s.h != null && s.a != null;
}

// Once the group stage finishes, the feed replaces knockout slot codes
// (1E, 3ABCDF, W74…) with the REAL qualified teams — and FIFA's official
// best-third allocation differs from any home-grown matcher, so the feed is
// authoritative. Extract {matchNo: {home?, away?}} for knockout rows whose
// names resolve to real teams (skipping slot codes and "To be announced").
export function feedKnockoutTeams(rows) {
  const ko = {};
  for (const m of rows || []) {
    if (!m || m.MatchNumber == null || m.MatchNumber < 73) continue;
    const home = mapName(m.HomeTeam), away = mapName(m.AwayTeam);
    if (home || away) {
      ko[m.MatchNumber] = {};
      if (home) ko[m.MatchNumber].home = home;
      if (away) ko[m.MatchNumber].away = away;
    }
  }
  return ko;
}

// Return fixtures with knockout slot codes replaced by the real teams the feed
// has confirmed (koTeams from feedKnockoutTeams). Undecided slots keep their
// code so our own prediction still fills them. Group rows are untouched.
// NOTE: do NOT feed the result to sim.js — its bracket walker expects slot
// codes; this is for predictBracket / standings / bets consumers only.
export function resolveFixtures(fixtures, koTeams = {}) {
  if (!koTeams || !Object.keys(koTeams).length) return fixtures;
  return fixtures.map((m) => {
    const real = koTeams[m.no];
    if (m.r < 4 || !real) return m;
    return { ...m, h: real.home || m.h, a: real.away || m.a };
  });
}

export function groupsComplete(fixtures, scores) {
  return fixtures.filter((m) => m.r <= 3).every((m) => hasScore(scores, m.no));
}
