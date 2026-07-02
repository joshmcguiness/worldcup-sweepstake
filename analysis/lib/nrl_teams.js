// Canonical NRL team registry + a name matcher that survives the wild variety
// of strings the sources throw at us. The SuperCoach backtest joins Betfair
// (results/odds) to NRL Fantasy (player values) at the TEAM level — the two
// price systems share the 500000-range squad_id, but the human-readable names
// don't line up ("Sydney" the Roosters vs "South Sydney" the Rabbitohs;
// "St George/Illa Dragons"), so every join goes through canonicalTeam().

// One row per club: canonical key, the NRL Fantasy squad_id, and the tokens
// (already alnum-normalised) that identify it. ORDER MATTERS — the matcher
// takes the first team any of whose tokens is a substring of the input, so
// compound/ambiguous names (South Sydney, before Sydney) come first.
export const NRL_TEAMS = [
  { key: 'rabbitohs', squadId: 500005, tokens: ['southsydney', 'rabbitoh'] },
  { key: 'roosters', squadId: 500001, tokens: ['rooster', 'sydneyrooster'] },
  { key: 'dragons', squadId: 500022, tokens: ['dragon', 'stgeorge', 'illawarra', 'illa'] },
  { key: 'broncos', squadId: 500011, tokens: ['bronco', 'brisbane'] },
  { key: 'raiders', squadId: 500013, tokens: ['raider', 'canberra'] },
  { key: 'bulldogs', squadId: 500010, tokens: ['bulldog', 'canterbury', 'bankstown'] },
  { key: 'sharks', squadId: 500028, tokens: ['shark', 'cronulla'] },
  { key: 'dolphins', squadId: 500723, tokens: ['dolphin', 'redcliffe'] },
  { key: 'titans', squadId: 500004, tokens: ['titan', 'goldcoast'] },
  { key: 'seaeagles', squadId: 500002, tokens: ['seaeagle', 'manly'] },
  { key: 'storm', squadId: 500021, tokens: ['storm', 'melbourne'] },
  { key: 'warriors', squadId: 500032, tokens: ['warrior', 'newzealand', 'nzwarrior'] },
  { key: 'knights', squadId: 500003, tokens: ['knight', 'newcastle'] },
  { key: 'cowboys', squadId: 500012, tokens: ['cowboy', 'northqueensland', 'northqld'] },
  { key: 'eels', squadId: 500031, tokens: ['eel', 'parramatta'] },
  { key: 'panthers', squadId: 500014, tokens: ['panther', 'penrith'] },
  { key: 'tigers', squadId: 500023, tokens: ['tiger', 'wests'] },
  // bare "Sydney" (Roosters) is resolved LAST so "South Sydney" wins first
  { key: 'roosters', squadId: 500001, tokens: ['sydney'] },
];

export function normNrl(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

const BY_SQUAD = new Map(NRL_TEAMS.map((t) => [t.squadId, t.key]));

// Map any team string (Betfair HOME_TEAM/RUNNER_NAME, fantasy full_name) to a
// canonical key, or null if nothing matches (caller should log misses).
export function canonicalTeam(name) {
  const n = normNrl(name);
  if (!n) return null;
  for (const t of NRL_TEAMS) {
    if (t.tokens.some((tok) => n.includes(tok))) return t.key;
  }
  return null;
}

export function squadIdToKey(squadId) {
  return BY_SQUAD.get(Number(squadId)) || null;
}
