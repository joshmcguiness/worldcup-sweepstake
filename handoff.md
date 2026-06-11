# Handoff — "Nathaniel's 2026 Football World Cup Bonanza" → hosted auto-refreshing site

## 1. Purpose of this document
We have a working single-file prototype (`World Cup 2026 Sweepstake.html`) that runs entirely in the browser. The goal is to turn it into a **hosted website** that:

- Auto-refreshes results, standings, prizes and predictions **3 times a day**.
- **Stops refreshing after the final** (no point burning API calls / compute once it's over).
- Is shareable via a single URL (no file passing around), and stays in sync for everyone.

This doc is written so a developer can pick it up cold. The prototype is the source of truth for business logic — when in doubt, read its `<script>` block.

---

## 2. Recommended architecture: "scheduled static rebuild"
Don't build a full backend with a live API + DB. The data changes a few times a day at most, so the cheapest, most robust pattern is:

```
[ Scheduler (cron 3x/day) ]
        │  fetch fixtures+scores (+odds)
        ▼
[ Build job (Node/TS) ]  ── runs shared logic: standings, scoring, EV draw (fixed), Monte-Carlo sim
        │  writes data.json (+ optionally pre-rendered HTML)
        ▼
[ Static host / CDN ]  ── serves index.html + data.json
        │
        ▼
[ Browser ]  ── fetches data.json on load, renders tabs
```

**Why:** no database, no server to keep alive, trivially cheap, and the "stop after the final" requirement is just a date check in the build job. State (the draw, the pot config) lives in a single committed config file.

### Suggested stack
- **Language:** Node + TypeScript (the prototype logic is already JS; porting is mechanical). Python is fine too if preferred.
- **Scheduler + host (pick one):**
  - **GitHub Actions** cron + **GitHub Pages / Cloudflare Pages** (recommended — free, simple, the build commits `data.json`).
  - **Vercel** Cron Jobs + Vercel static hosting.
  - **Cloudflare Workers** Cron Triggers + Pages + KV for state.
- **No framework needed** on the frontend — keep the prototype's vanilla JS render functions. (If you want, wrap in Svelte/React later; not required.)

---

## 3. Data sources
| Data | Source | Notes |
|---|---|---|
| Fixtures + live scores | `https://fixturedownload.com/feed/json/fifa-world-cup-2026` | Free JSON. Each match has `MatchNumber`, `RoundNumber`, `DateUtc`, `Location`, `HomeTeam`, `AwayTeam`, `Group`, `HomeTeamScore`, `AwayTeamScore`. Knockout rows use slot codes (`1A`, `2B`, `3CEFHI`, `W74`, `L101`) until teams are known. **Key by `MatchNumber`.** |
| Tournament-winner odds (optional) | The Odds API — `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup_winner/odds/?regions=us&oddsFormat=decimal&markets=outrights&apiKey=…` | Needs a free key (500 calls/mo). Store key as a **build secret**, never in the client bundle. Odds only used for seeding predictions + the "win odds" tab; a static fallback snapshot is fine. |

Fetch from the **build job** (server side) — avoids the browser CORS issues the prototype works around with proxies.

---

## 4. Business logic to port (all in the prototype's `<script>`)
Extract these into a shared `lib/` module with unit tests. They are pure functions — no DOM.

### 4.1 Teams & odds
`TEAMS = [{n: name, g: group, o: americanOdds}]` (48). `strength(o) = 1/(1+o/100)`.

### 4.2 The draw — **expected-value balanced** (already implemented, `doDrawCore`)
- Sort teams strongest-first.
- Deal each team to the player with the **lowest running total strength** who isn't yet at their team cap.
- Caps: `base = floor(48/N)`, `extra = 48 % N`; `extra` players end with `base+1`, the rest with `base`. Counts always within 1.
- Seeded RNG (`mulberry32`) so a given seed reproduces the same draw.
- **Important:** the draw is done **once** by the admin and then frozen. In the hosted version it must be stored server-side (see §6), NOT re-rolled on every rebuild.

### 4.3 Standings (`computeStandings`)
Group stage only (RoundNumber ≤ 3). 3 pts win / 1 draw. Group rank by composite = `pts*1e6 + (gd+50)*1e3 + gf*10 + strength + tiny-unique-epsilon`. Top 2 per group = "advancing".

### 4.4 Scoring / Pool (`poolRows`, `computeBonus`)
Player total = sum of their teams' group points **+ knockout bonus**. Bonus per knockout win: R32 +4, R16 +6, QF +8, SF +10, 3rd-place +12… (see `BONUS` map — confirm final values with product owner). 🥇 leader, 🥄 wooden spoon = last.

### 4.5 Bracket prediction (`predictBracket`)
Resolves the real knockout tree: `1A/2B` → group winner/runner-up from standings; `3XXXX` → best-third placeholder; `W##/L##` → winner/loser of an earlier match. For an unplayed tie, predicted winner = shorter odds; once a real score exists it takes over. Dropdown switches round (Final 32→16→8→4→2).

### 4.6 Projections / "reach the last 8" (Monte-Carlo)
The richer stat the prototype does **offline** but should move into the build job:
- Single-match model: Bradley-Terry `P(i beats j) = r_i/(r_i+r_j)`, where `r = strength^(1/3)` (tempering — title odds are too steep for single games; this lets realistic upsets happen).
- Group stage with ~24% draw rate, top 2 + 8 best thirds advance, then play the real bracket.
- Run ~30k sims; output per-team `P(reach R16/QF/SF/Final/Win)` and aggregate per player (expected count + ≥1 probability).
- Cache the sim output in `data.json` — don't run it in the browser.

### 4.7 Other tabs (pure render): Today (AEST), My Team, Wild Card (most goals for/against), Win Odds, Pot & Prizes (AUD, admin-set buy-in + % split), Change Log, Admin (tab visibility).

---

## 5. The scheduler (3×/day + auto-stop)

### Cadence
Matches are spread across the day in multiple US time zones; results settle ~2h after kickoff. Three runs a day comfortably catches them. Suggested **cron (UTC)** — tune to the fixture clusters:

```
0 6,14,22 * * *   # 06:00, 14:00, 22:00 UTC
```

### Auto-stop after the final
- Final = **MatchNumber 104, 2026-07-19**. At the top of the build job:
  ```ts
  const FINAL_OVER = Date.now() > Date.parse('2026-07-20T12:00:00Z'); // ~1 day buffer
  if (FINAL_OVER) { console.log('Tournament over — skipping refresh'); process.exit(0); }
  ```
- Belt-and-braces: also stop if **all 104 matches have scores**. Optionally have the job disable its own schedule on the last run (e.g. GitHub Actions: commit a flag file the workflow checks; or delete the cron). Leave the last-built `data.json` in place so the site keeps showing the final result forever.

### GitHub Actions sketch
```yaml
name: refresh
on:
  schedule: [{ cron: '0 6,14,22 * * *' }]
  workflow_dispatch: {}            # manual "Refresh now" button
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: node build/refresh.js     # fetch + compute + write public/data.json
        env: { ODDS_API_KEY: ${{ secrets.ODDS_API_KEY }} }
      - run: |                          # commit if data changed
          git config user.name bot && git config user.email bot@local
          git add public/data.json && git commit -m "refresh $(date -u)" || echo "no change"
          git push
```
(Keep a `workflow_dispatch` trigger so the admin can force a refresh from the Actions tab.)

---

## 6. State that must persist server-side
Stored as committed config (e.g. `config/draw.json`) — set once by the admin, read by every build:
```jsonc
{
  "players": ["Nathaniel","Josh","Andy.B", "..."],
  "drawSeed": 123456,           // reproduces the EV draw; OR store explicit owners:
  "owners": { "Spain": "Ian", "France": "Brett", "...": "..." },
  "locked": true,
  "buyIn": 20,                  // AUD
  "split": { "winner": 50, "runner": 25, "goals": 15, "spoon": 10 },
  "visibleTabs": ["today","board","summary","wild","win","pot","bracket","fixtures","log"]
}
```
Prefer storing **explicit `owners`** (not just the seed) so the draw can never drift if the algorithm or odds change. The build job reads this, never re-draws.

`data.json` (written each run) =
```jsonc
{
  "updatedAt": "2026-06-19T22:00:12Z",
  "matches": [ /* fixtures with scores */ ],
  "standings": { /* per team */ },
  "pool": [ /* ranked players, pts, bonus, gd */ ],
  "prizes": [ /* prize, %, $AUD, currentLeader */ ],
  "sim": { /* per-team P(R16/QF/SF/Final/Win), per-player expected counts */ },
  "bracket": { /* resolved/predicted rounds */ }
}
```

---

## 7. Change log / "who refreshed"
In the hosted model the refresh is automated, so log **system** entries (`{ts, source:"scheduled"|"manual", matchesUpdated}`) into `data.json` and render them on the Change Log tab. The per-device "who am I" name from the prototype is no longer needed (there's no per-user file), though you can keep a manual "force refresh" that records the triggering admin.

---

## 8. Repo structure (suggested)
```
/config/draw.json          # admin-set, committed
/lib/                      # ported pure logic (tested)
  teams.ts  draw.ts  standings.ts  scoring.ts  bracket.ts  sim.ts
/build/refresh.js          # fetch + compute + write public/data.json (the cron entrypoint)
/public/
  index.html               # frontend shell (reuse prototype markup/CSS)
  app.js                   # render functions reading data.json (reuse prototype render fns)
  data.json                # generated artifact
/.github/workflows/refresh.yml
```

---

## 9. Build steps for the developer
1. Port `lib/` from the prototype `<script>`; add unit tests (draw balance + EV equality across N=5..13; standings vs a hand-checked fixture; bracket resolves to real teams; sim sanity).
2. Write `build/refresh.js`: fetch fixtures (+odds if key present) → load `config/draw.json` → compute standings/pool/prizes/bracket/sim → write `public/data.json`. Include the `FINAL_OVER` guard.
3. Convert the prototype's render functions to read from `data.json` instead of `localStorage`. Drop the in-browser fetch/proxy code and the "Save & share" file export (no longer needed — it's a URL now). Keep all tabs and styling.
4. Wire the GitHub Actions cron + `workflow_dispatch`; add `ODDS_API_KEY` secret.
5. Deploy `public/` to Pages. Verify a manual run produces `data.json` and the site renders.
6. Test the stop condition by temporarily setting the final date in the past.

---

## 10. Open decisions for the product owner (Josh/Nathaniel)
- Confirm exact **knockout bonus point values** (§4.4).
- Confirm **prize split** and buy-in (currently 50/25/15/10, A$20).
- Should the **Admin** tab exist on the public URL, or be a separate private page / basic-auth? (Recommend moving admin off the public site.)
- Refresh times — fixed 06/14/22 UTC, or align precisely to the daily fixture clusters?
- Keep tournament-winner odds **live** (needs the API key in CI) or ship a **static snapshot** and skip the odds API entirely?

---

## 11. Reference
- Prototype: `World Cup 2026 Sweepstake.html` (all logic + UI).
- Tournament window: 11 Jun – 19 Jul 2026. Final = MatchNumber 104, 19 Jul 2026.
- Times for end users shown in **AEST** (`Australia/Brisbane`, no DST).
- Odds snapshot in prototype: BetMGM via Yahoo Sports, 9 Jun 2026.
