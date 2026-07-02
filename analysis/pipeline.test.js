import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTeam, squadIdToKey, NRL_TEAMS } from './lib/nrl_teams.js';

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

test('squadIdToKey: fantasy squad_ids map to the same canonical keys', () => {
  assert.equal(squadIdToKey(500001), 'roosters');
  assert.equal(squadIdToKey(500005), 'rabbitohs');
  assert.equal(squadIdToKey(500723), 'dolphins');
  assert.equal(squadIdToKey(999999), null);
  // every canonical team has a squad_id and round-trips
  const keys = new Set(NRL_TEAMS.map((t) => t.key));
  assert.equal(keys.size, 17, '17 distinct clubs');
});
