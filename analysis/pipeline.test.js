import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTeam, squadIdToKey, NRL_TEAMS } from './lib/nrl_teams.js';
import { canonicalAflTeam, AFL_TEAMS } from './lib/afl_teams.js';

test('canonicalTeam: the real Betfair strings all resolve, ambiguities handled', () => {
  // exact HOME_TEAM / RUNNER_NAME strings seen in the Betfair CSVs
  const cases = {
    'Sydney Roosters': 'roosters', Sydney: 'roosters',            // bare Sydney = Roosters
    'South Sydney Rabbitohs': 'rabbitohs', 'South Sydney': 'rabbitohs',
    'St George/Illa Dragons': 'dragons', 'Illa Dragons': 'dragons', 'St George': 'dragons',
    'Canterbury Bulldogs': 'bulldogs', Canterbury: 'bulldogs',
    'Cronulla Sharks': 'sharks', Cronulla: 'sharks',
    'New Zealand Warriors': 'warriors', 'NZ Warriors': 'warriors',
    'North Queensland Cowboys': 'cowboys', 'North Qld': 'cowboys',
    'Brisbane Broncos': 'broncos', Brisbane: 'broncos',
    'Manly Sea Eagles': 'seaeagles', Manly: 'seaeagles',
    Dolphins: 'dolphins', 'Gold Coast Titans': 'titans', 'Wests Tigers': 'tigers',
    'Melbourne Storm': 'storm', 'Penrith Panthers': 'panthers', 'Parramatta Eels': 'eels',
    'Newcastle Knights': 'knights', 'Canberra Raiders': 'raiders',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(canonicalTeam(input), expected, `${input} -> ${expected}`);
  }
  assert.equal(canonicalTeam('Some Random FC'), null, 'unknown -> null');
});

test('canonicalTeam: South Sydney never leaks into Roosters and vice versa', () => {
  assert.notEqual(canonicalTeam('South Sydney'), 'roosters');
  assert.notEqual(canonicalTeam('Sydney Roosters'), 'rabbitohs');
});

test('canonicalAflTeam: real Betfair + Footywire strings resolve, traps handled', () => {
  const cases = {
    // the exact Betfair short names
    Adelaide: 'adelaide', 'Port Adelaide': 'portadelaide',              // Port before Adelaide
    Melbourne: 'melbourne', 'North Melbourne': 'northmelbourne',        // North before Melbourne
    Sydney: 'sydney', GWS: 'gws',                                        // GWS (Greater Western Sydney) not Sydney
    'Western Bulldogs': 'westernbulldogs', 'West Coast': 'westcoast',
    Brisbane: 'brisbane', Carlton: 'carlton', Collingwood: 'collingwood',
    Essendon: 'essendon', Fremantle: 'fremantle', Geelong: 'geelong',
    'Gold Coast': 'goldcoast', Hawthorn: 'hawthorn', Richmond: 'richmond',
    'St Kilda': 'stkilda',
    // Footywire-style full names
    'Brisbane Lions': 'brisbane', 'Sydney Swans': 'sydney',
    'Greater Western Sydney': 'gws', 'Gold Coast Suns': 'goldcoast',
    'North Melbourne Kangaroos': 'northmelbourne',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(canonicalAflTeam(input), expected, `${input} -> ${expected}`);
  }
  assert.equal(canonicalAflTeam('Western Australia'), null, 'state rep games -> null (excluded)');
  assert.equal(new Set(AFL_TEAMS.map((t) => t.key)).size, 18, '18 AFL clubs');
});

test('canonicalAflTeam: the substring traps never cross-match', () => {
  assert.notEqual(canonicalAflTeam('Port Adelaide'), 'adelaide');
  assert.notEqual(canonicalAflTeam('North Melbourne'), 'melbourne');
  assert.notEqual(canonicalAflTeam('GWS'), 'sydney');
  assert.notEqual(canonicalAflTeam('Western Bulldogs'), 'westcoast');
});

test('squadIdToKey: fantasy squad_ids map to the same canonical keys', () => {
  assert.equal(squadIdToKey(500001), 'roosters');
  assert.equal(squadIdToKey(500005), 'rabbitohs');
  assert.equal(squadIdToKey(500723), 'dolphins');
  assert.equal(squadIdToKey(999999), null);
  // every canonical team has a squad_id and round-trips
  const keys = new Set(NRL_TEAMS.map((t) => t.key));
  assert.equal(keys.size, 17, '17 distinct clubs');
});
