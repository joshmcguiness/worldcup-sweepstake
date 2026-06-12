# Nathaniel's 2026 Football World Cup Bonanza — hosted edition

A static, auto-refreshing sweepstake site. A scheduled build fetches scores
3× a day, recomputes standings / pool / prizes / bracket / Monte-Carlo
projections, writes `public/data.json`, and deploys to GitHub Pages. After the
final (19 Jul 2026 + 1 day buffer) the build stops touching the data and the
site keeps showing the final result forever.

Architecture ("scheduled static rebuild") and business rules come from
`handoff.md` and the original single-file prototype
(`World Cup 2026 Sweepstake.html`).

## Layout

```
config/draw.json        admin-set state: players, FROZEN owners map, buy-in, split, visible tabs
config/sidepots.json    Golden Boot draw + fees, Dark Horse params, Chaos Pot points & manual events
config/rankings.json    FIFA rankings for the 48 qualifiers (Dark Horse)
config/goldenboot-candidates.json  bookies' Golden Boot favourites (draw pool)
public/lib/             pure business logic (ES modules, shared by build job, browser and tests)
  teams.js fixtures.js draw.js standings.js scoring.js bracket.js sim.js sidepots.js espn.js
build/refresh.js        cron entrypoint: fetch -> compute -> write public/data.json
build/draw-goldenboot.js  one-off seeded footballer draw -> config/sidepots.json
public/index.html       frontend shell
public/app.js           render functions reading data.json
public/data.json        generated artifact (committed by the workflow each refresh)
.github/workflows/refresh.yml   cron 3x/day + manual dispatch + Pages deploy
test/                   node --test unit tests
```

## Side pots (tabs: Golden Boot Pot · Dark Horse Prize · Curnow Bets)

- **Golden Boot Pot** (A$10 entry, configurable): each player drew FIVE
  strikers — the top 65 Golden Boot favourites cut into 5 odds tiers of 13,
  one striker per tier each, randomly within the tier (seeded:
  `node build/draw-goldenboot.js <seed>` — seed 2026 is the live draw;
  candidate pool in config/goldenboot-candidates.json). Most combined goals
  wins. Goals auto-update from football-data.org when the
  `FOOTBALL_DATA_KEY` secret is set; `goalsOverride` in config/sidepots.json
  always wins (manual mode works fine without any key).
- **Dark Horse Prize**: all 48 teams are listed by FIFA ranking
  (config/rankings.json, April 2026 release), but only the 24 lowest-ranked
  are ELIGIBLE (without the cut the prize would always go to the champion's
  owner — `darkHorse.candidateCount` in config/sidepots.json adjusts it).
  Whoever owns the eligible team that progresses furthest wins; ties go to
  the worse-ranked team. The sim also reports win probabilities.
- **Chaos Pot** (the Curnow Bets tab): own goal +3, red card +2, regulation
  penalty miss +2, goalkeeper goal +10 — the team with the most chaos points
  wins for its owner. Events are auto-detected from ESPN's public JSON API
  every refresh (set `CHAOS_AUTO=0` to disable); admin corrections go in
  config/sidepots.json `chaos.events` (negative `count` cancels a wrong
  auto-detection). The ESPN API is undocumented — if it drifts, the build
  keeps the previously banked events and notes the failure in the change log.

## Local development

```bash
node --test               # run the test suite
node build/refresh.js     # fetch live data, rebuild public/data.json
npm run serve             # http://localhost:8788 (any static server works;
                          # ES modules don't load over file://)
```

## Deploying (one-time setup)

1. Create a GitHub repo and push this directory to `main`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. (Optional, live odds) **Settings → Secrets → Actions**: add `ODDS_API_KEY`
   (free key from the-odds-api.com, 500 calls/mo). Without it the site uses
   the BetMGM snapshot from 9 Jun 2026 baked into `lib/teams.js` — fine too.
   Also optional: `FOOTBALL_DATA_KEY` (free key from football-data.org) for
   automatic Golden Boot goal tallies.
4. The `refresh` workflow runs on push, then on cron at 06/14/22 UTC, and from
   the Actions tab via **Run workflow** (manual "refresh now").

## Operations

- **The draw is frozen.** `config/draw.json` `owners` is the single source of
  truth; the build never re-draws. (The live draw was made with an older
  round-robin dealer, so the stored seed does *not* reproduce it under the
  current EV-balanced algorithm — only the owners map matters.)
- **Pot / split / visible tabs**: edit `config/draw.json`, commit, and the
  next refresh picks it up (or trigger a manual run).
- **Auto-stop**: `build/refresh.js` exits without writing once
  `now > 2026-07-20T12:00Z`, and also once all 104 matches have scores
  (`finished: true` in data.json). The workflow keeps firing harmlessly;
  delete the `schedule:` block after the final if you want silence.
- **Change log**: every refresh appends `{ts, source, matchesUpdated, note}`
  to `data.json` (capped at 200 entries) and the Change Log tab renders it.

## High Risk Curnow Bets

A statistical bet finder (public/lib/bets.js): every AEST day the build
generates two frozen books of five calls — 'Best bets that finalise today'
and 'Longer bets' (a dropdown switches between them) — match singles (model probability
≥50%), a multi stacking the day's bankers, anytime-scorer angles (top-26
Golden Boot candidates against ≥15-place FIFA rank gaps), and Monte-Carlo
wildcards (group crowns, quarter-final runs, qualification, outright value) —
each with a name, fair odds and a reasoning comment. With `ODDS_API_KEY` set
the build also pulls live h2h match prices and shows real market edge.
Settlement is automatic and self-correcting: results from the score feed
(shootout winners included), scorers from the banked ESPN goal events;
pts/GD/GF dead heats stay pending (FIFA breaks those by head-to-head/fair
play, which no feed provides). Every call carries a virtual $100 stake at the locked
price (market when available, fair odds otherwise); the page tracks the
running P/L and ROI across the tournament, plus day-by-day history with a
hit rate. Entertainment only — the tab carries a responsible-gambling note.

## Data sources

| Data | Source |
|---|---|
| Fixtures + scores | https://fixturedownload.com/feed/json/fifa-world-cup-2026 (keyed by `MatchNumber`) |
| Winner odds (optional) | The Odds API `soccer_fifa_world_cup_winner` outrights, averaged across books |

## Open decisions (product owner)

- Knockout bonus values are the prototype's: R32 +4, R16 +6, QF +8, SF +10,
  3rd-place +5, Final +12 (`lib/scoring.js` `BONUS`). The handoff text said
  "3rd-place +12…" — the map is what the prototype shipped; confirm.
- Buy-in A$20 and 50/25/15/10 split are set in `config/draw.json`; confirm.
- Refresh times are 06/14/22 UTC; tune to fixture clusters if wanted.
