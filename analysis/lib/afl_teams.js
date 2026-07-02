// Canonical AFL team registry + matcher, twin of nrl_teams.js. AFL has its own
// substring traps: "Port Adelaide" vs "Adelaide", "North Melbourne" vs
// "Melbourne", and "GWS / Greater Western Sydney" vs "Sydney" — so the ordered
// list resolves the compound name first. Handles Betfair short names
// ("Adelaide", "GWS", "Western Bulldogs") and Footywire full names
// ("Brisbane Lions", "Sydney Swans").
export const AFL_TEAMS = [
  { key: 'portadelaide', tokens: ['portadelaide', 'port'] },     // before adelaide
  { key: 'northmelbourne', tokens: ['northmelbourne', 'kangaroos'] }, // before melbourne
  { key: 'gws', tokens: ['greaterwesternsydney', 'gwsgiants', 'gws', 'giants'] }, // before sydney
  { key: 'westernbulldogs', tokens: ['westernbulldogs', 'bulldogs', 'footscray'] },
  { key: 'westcoast', tokens: ['westcoasteagles', 'westcoast', 'eagles'] },
  { key: 'adelaide', tokens: ['adelaidecrows', 'adelaide', 'crows'] },
  { key: 'melbourne', tokens: ['melbournedemons', 'melbourne', 'demons'] },
  { key: 'sydney', tokens: ['sydneyswans', 'sydney', 'swans'] },
  { key: 'brisbane', tokens: ['brisbanelions', 'brisbane', 'lions'] },
  { key: 'carlton', tokens: ['carlton', 'blues'] },
  { key: 'collingwood', tokens: ['collingwood', 'magpies'] },
  { key: 'essendon', tokens: ['essendon', 'bombers'] },
  { key: 'fremantle', tokens: ['fremantle', 'dockers', 'freo'] },
  { key: 'geelong', tokens: ['geelong', 'cats'] },
  { key: 'goldcoast', tokens: ['goldcoastsuns', 'goldcoast', 'suns'] },
  { key: 'hawthorn', tokens: ['hawthorn', 'hawks'] },
  { key: 'richmond', tokens: ['richmond', 'tigers'] },
  { key: 'stkilda', tokens: ['stkilda', 'saints'] },
];

export function normAfl(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

export function canonicalAflTeam(name) {
  const n = normAfl(name);
  if (!n) return null;
  for (const t of AFL_TEAMS) {
    if (t.tokens.some((tok) => n.includes(tok))) return t.key;
  }
  return null;
}
