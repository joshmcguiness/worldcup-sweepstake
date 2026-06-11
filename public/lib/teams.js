// 48 qualified teams with American tournament-winner odds.
// Snapshot: BetMGM via Yahoo Sports, 9 Jun 2026. The build job overrides these
// with live odds from The Odds API when ODDS_API_KEY is configured.
export const TEAMS = [
  {"n": "Czechia", "g": "A", "o": 25000},
  {"n": "Korea Republic", "g": "A", "o": 25000},
  {"n": "Mexico", "g": "A", "o": 6600},
  {"n": "South Africa", "g": "A", "o": 100000},
  {"n": "Bosnia and Herzegovina", "g": "B", "o": 25000},
  {"n": "Canada", "g": "B", "o": 15000},
  {"n": "Qatar", "g": "B", "o": 100000},
  {"n": "Switzerland", "g": "B", "o": 6600},
  {"n": "Brazil", "g": "C", "o": 900},
  {"n": "Haiti", "g": "C", "o": 250000},
  {"n": "Morocco", "g": "C", "o": 4000},
  {"n": "Scotland", "g": "C", "o": 25000},
  {"n": "Australia", "g": "D", "o": 50000},
  {"n": "Paraguay", "g": "D", "o": 25000},
  {"n": "Türkiye", "g": "D", "o": 6600},
  {"n": "USA", "g": "D", "o": 5000},
  {"n": "Curaçao", "g": "E", "o": 250000},
  {"n": "Côte d'Ivoire", "g": "E", "o": 20000},
  {"n": "Ecuador", "g": "E", "o": 8000},
  {"n": "Germany", "g": "E", "o": 1400},
  {"n": "Japan", "g": "F", "o": 5000},
  {"n": "Netherlands", "g": "F", "o": 2000},
  {"n": "Sweden", "g": "F", "o": 10000},
  {"n": "Tunisia", "g": "F", "o": 50000},
  {"n": "Belgium", "g": "G", "o": 3300},
  {"n": "Egypt", "g": "G", "o": 25000},
  {"n": "IR Iran", "g": "G", "o": 50000},
  {"n": "New Zealand", "g": "G", "o": 100000},
  {"n": "Cabo Verde", "g": "H", "o": 100000},
  {"n": "Saudi Arabia", "g": "H", "o": 100000},
  {"n": "Spain", "g": "H", "o": 450},
  {"n": "Uruguay", "g": "H", "o": 6600},
  {"n": "France", "g": "I", "o": 500},
  {"n": "Iraq", "g": "I", "o": 100000},
  {"n": "Norway", "g": "I", "o": 3300},
  {"n": "Senegal", "g": "I", "o": 6600},
  {"n": "Algeria", "g": "J", "o": 25000},
  {"n": "Argentina", "g": "J", "o": 900},
  {"n": "Austria", "g": "J", "o": 15000},
  {"n": "Jordan", "g": "J", "o": 100000},
  {"n": "Colombia", "g": "K", "o": 4000},
  {"n": "Congo DR", "g": "K", "o": 75000},
  {"n": "Portugal", "g": "K", "o": 800},
  {"n": "Uzbekistan", "g": "K", "o": 100000},
  {"n": "Croatia", "g": "L", "o": 8000},
  {"n": "England", "g": "L", "o": 700},
  {"n": "Ghana", "g": "L", "o": 50000},
  {"n": "Panama", "g": "L", "o": 100000},
];

export function strengthOf(o) { return 1 / (1 + o / 100); }
export function decOdds(o) { return 1 + o / 100; }

export function teamOdds(teams, name) {
  const f = teams.find((x) => x.n === name);
  return f ? f.o : 0;
}

function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[^a-z]/g, ''); }

// Bookmaker name -> our team name (The Odds API uses different spellings)
const ODDS_ALIAS = {
  unitedstates: 'USA', usa: 'USA', us: 'USA',
  southkorea: 'Korea Republic', korea: 'Korea Republic', korearepublic: 'Korea Republic',
  turkey: 'Türkiye', turkiye: 'Türkiye',
  iran: 'IR Iran', iriran: 'IR Iran',
  ivorycoast: "Côte d'Ivoire", cotedivoire: "Côte d'Ivoire",
  drcongo: 'Congo DR', democraticrepublicofthecongo: 'Congo DR',
  democraticrepublicofcongo: 'Congo DR', congodr: 'Congo DR',
  caboverde: 'Cabo Verde', capeverde: 'Cabo Verde',
  czechrepublic: 'Czechia', czechia: 'Czechia',
  bosnia: 'Bosnia and Herzegovina', bosniaherzegovina: 'Bosnia and Herzegovina',
  bosniaandherzegovina: 'Bosnia and Herzegovina',
  curacao: 'Curaçao',
};

let NAMEMAP = null;
export function mapName(nm) {
  if (!NAMEMAP) {
    NAMEMAP = {};
    TEAMS.forEach((t) => { NAMEMAP[norm(t.n)] = t.n; });
    for (const k in ODDS_ALIAS) NAMEMAP[k] = ODDS_ALIAS[k];
  }
  return NAMEMAP[norm(nm)] || null;
}
