# Roadmap for Opus 4.8 — Lineup-Aware NRL/AFL Betting Models (v3)

*Handoff written 2 July 2026 by the Fable session that built everything below. Josh is
running low on Fable tokens; you (Opus 4.8) are picking this up. Read this whole file
before touching code.*

---

## 0. What already exists (do not rebuild)

This repo hosts **Nathaniel's 2026 Football World Cup Bonanza** (live at
https://joshmcguiness.github.io/worldcup-sweepstake/) plus a multi-sport betting-model
platform. Everything is a **virtual $100-stake simulation** — no real money, ever.

- **Engine**: `public/lib/sports.js` — team-level Elo (bootstrapped from prior season,
  regressed 25% to mean), weekly books of ≤5 calls, market prices from The Odds API
  (`ODDS_API_KEY` repo secret, free tier, ~1 credit/sport/week — guard this budget).
- **v2 laws** (from a 189-bet World Cup post-mortem, all test-enforced): positive edge
  ≥3% only, payout ≥$1.20, prob ≥0.45, one bet per match, no re-taking open positions,
  team exposure caps, **frozen historical books are never rewritten**.
- **Origin-aware rules** (shipped 2 Jul 2026): books lock **3 days** before a round
  (after NRL Tuesday / AFL Thursday team lists), NRL has a `repWindows` config
  (Origin period) inside which the minimum edge **doubles to 6%** and surviving bets
  carry a `warning` field rendered as an amber line.
- **Rebuild loop**: GitHub Actions cron (4×/day) runs `build/refresh.js` → writes
  `public/data.json` → deploys `public/` to GitHub Pages. State lives in
  `data.json.sports.{afl|nrl|nfl|epl}`.
- **Tests**: `node --test` — 98 passing. Every engine change needs a test.
- **Git quirk**: plain `git push` fails (stale credential helper). Use:
  `git -c credential.helper= -c credential.helper='!/opt/homebrew/bin/gh auth git-credential' push`
- **fixturedownload.com feeds need a browser User-Agent** (403 otherwise) — see
  `BROWSER_UA` in `build/refresh.js`.

### The known blind spot (your reason for existing)

Elo rates the jersey, not the 17 players wearing it. During State of Origin, the
market prices the missing players and our model can't — the first live NRL book was
locked on **Round 18, the Origin Game 3 round**, and is our live calibration lesson.
Josh's directive: *make the model understand why the odds look different from what we
predict — if it looks too good to be true, understand why before betting.*

---

## 1. Mission A — the "Why is this price different?" layer

> **STATUS — SHIPPED (2 Jul 2026).** The edge-diagnosis decision tree below is
> live in [`public/lib/sports.js`](../public/lib/sports.js) (`diagnoseEdge`,
> `EDGE_CAUSES`, `lineupDelta`), wired into `generateSportBook`, surfaced in the
> UI as per-bet cause tags + a "screened out this round" footnote, and covered
> by tests in `test/sports.test.js`. What is **not** yet wired: the T-6d opening
> odds snapshot (steam needs it — `opts.openingOdds`) and the named-lineup value
> feed (`opts.lineups`). Both are accepted as optional inputs today and degrade
> gracefully to the coarse rep-window proxy; turning them on is a data-puller
> job (§3/§4) once the catalogue confirms the sources.

**Principle: every edge must be explained before it is bet.** The closing market
price is the best public forecast of a match. When our number disagrees with it,
there are exactly two possibilities: we know something the market doesn't (almost
never true for a public Elo), or the market knows something we don't (usually team
news). The job of this layer is to classify each apparent edge into a *cause*, and
only bet the causes that historically favour the model.

### 1.1 The edge-diagnosis decision tree

For every candidate bet (edge ≥3% after v2 gates), run these checks **in order**
and attach the first matching `edgeCause` to the bet:

1. **`lineup`** — Has either side's named team list changed materially vs the side
   the Elo was built on? (Origin window, late withdrawals, stars rested, mass
   changes after a blowout.) → *Market is right, we are wrong.* **Do not bet**
   unless the edge survives the doubled bar AND the missing players are on the
   *opponent's* side of our bet.
2. **`steam`** — Has the price shortened ≥5% since market open in the direction
   *against* us? Sharp money disagrees with us. → Demand double edge; log it.
3. **`stale-elo`** — Early season (<6 rated games), post-bye, or heavy roster churn
   since the rating was earned? → Our number is low-confidence. Skip.
4. **`longshot-bias`** — Are we backing an underdog above $3.50? Favourite-longshot
   bias means books shade longshots; apparent edges there are systematically fake.
   → Raise the bar or skip (the World Cup post-mortem's sub-50% claims went 1/17).
5. **`vig-artifact`** — Is the "edge" smaller than the overround spread between
   bookmakers? Averaging books already helps, but a 3% edge inside a 6% vig band
   is noise. → Skip.
6. **`model-signal`** — None of the above: lineups are as-rated, the line has moved
   *toward* us or not at all, mid-season, moderate price. → This is the only class
   we bet at the normal 3% bar.

Persist `edgeCause` on every candidate (including rejected ones) in `data.json` so
the Results & Learnings tab can eventually show ROI *by cause* — that table is the
whole point: it will tell us empirically which disagreements are real.

### 1.2 Implementation notes

- Price-movement tracking needs **two odds snapshots per round** minimum: one at
  T-3 days (book lock, already fetched) and one near kickoff (CLV close, pattern
  already exists in the World Cup engine's `updateClosingOdds`). Opening prices
  need a third fetch at ~T-6 days **or** a source that publishes open/close pairs
  (see catalogue §3). Budget check: 3 fetches × 2 sports × ~26 rounds ≈ 156
  credits/season on the free 500/month tier — fine.
- Team-list change detection = diff this week's named 17/22 (or 23) against the
  players who featured in the games that earned the current Elo (last ~5 rounds).
  A "materiality" score = sum of missing players' fantasy values (Mission B feeds
  this) over team total.
- Do **not** try to model weather/travel in v3. Note it, don't build it.

---

## 2. Mission B — the SuperCoach hypothesis

> **STATUS — RUN ON REAL DATA, THREE WAYS (2–3 Jul 2026). Verdict: NO (clean).**
> The harness (`analysis/lib/stats.js` + `backtest.js`) was fed real NRL and AFL
> 2021–2026 data via `pull-betfair.js` (results+closing odds), `pull-fantasy.js`
> (NRL fantasy value), `pull-footywire.js` (AFL SuperCoach salaries) and
> `run-backtest.js`. **Three independent tests — NRL non-leaky proxy, NRL played
> 17 (leaky upper bound), AFL played 22 — all return NO.** The decisive one is
> NRL-played: with the *actual* 17, the effect collapses to ~zero, showing the
> NRL proxy's small positive lean was squad quality Elo already has. AFL keeps a
> tiny consistent lean but never clears significance. **scDiff is NOT wired into
> either engine.** Full three-test synthesis in [`analysis/RESULTS.md`](../analysis/RESULTS.md)
> (`node run-backtest.js nrl|nrl-played|afl`). Only remaining SuperCoach
> experiment worth running: a pooled multi-season fixed-effects model on AFL.
>
> **Also shipped live (both codes):** a per-game **value board** (`slate` in
> `generateSportBook` → "every game: model vs market", value rows highlighted,
> ✅ = picked) and **CLV tracking** (`priceForTeam`/`sportNeedsClosingOdds`/
> `updateSportClosingOdds`/`betClv` — banks the closing price near kickoff, shows
> per-bet + average CLV, the skill metric that matters at hobby scale). Slates
> populate from the next round-lock onward (frozen books aren't rewritten).

**Josh's question:** does the team with the stronger SuperCoach-valued lineup
(based on stats and forecasted stats) have a statistical advantage in winning bets?

Formally — **H1:** pre-round fantasy-value differential between the two named
lineups adds predictive power for match winners *beyond* (a) team Elo and (b) the
market price. If H1 holds only vs Elo but not vs market, it is still useful (it
fixes our blind spot); if it beats the market it is gold (and suspicious — check
for leakage before believing it).

### 2.1 The experiment (backtest before any live use)

1. **Assemble per-match records** for 2+ historical seasons (2024–2025, both codes):
   `date, teams, venue, named lineups, per-player fantasy value AT THAT DATE,
   closing odds, result`.
2. **Compute** `scDiff` = (sum of home lineup's player values) − (away sum),
   normalised by league-average team value that season.
3. **Fit three nested logistic models** on season N, test on season N+1 (never
   random splits — time-ordered only):
   - M1: home-win ~ Elo diff (the current engine, the baseline)
   - M2: home-win ~ Elo diff + scDiff
   - M3: home-win ~ market-implied prob + scDiff
4. **Score** with log-loss and Brier on the held-out season. H1 needs M2 > M1
   *and* the scDiff coefficient stable across seasons. Market test: M3 beating
   market-only means scDiff carries information the close hasn't absorbed.
5. **Profit simulation**: flat $100 stakes on held-out season wherever the blended
   model finds ≥3% edge vs the *closing* price, with the v2 gates applied. Report
   ROI with a bootstrap confidence interval (resample match outcomes 10,000×) —
   a single season's ROI without an interval is noise.
6. **Sub-analysis that motivated all this**: repeat scoring on *Origin-window
   rounds only* (NRL). The hypothesis predicts scDiff earns most of its keep there.

### 2.2 Data-leakage traps (the ways this experiment silently lies)

- **Never use round-N SuperCoach scores to predict round N** — scores are outputs
  of the match. Use *price* or *season-average-to-date entering the round*, i.e.
  a value that was knowable on the Tuesday/Thursday before kickoff.
- **Price snapshots must be pre-round.** End-of-season player prices embed the
  whole season. If only final prices are obtainable, reconstruct pre-round averages
  from per-round score archives (cumulative mean of rounds < N) — that is knowable
  information and is the fallback methodology.
- **Named lineups, not actual lineups.** Late changes after team-list day are
  information the market gets and we should model as noise, not truth — using
  post-game actual 17s would leak.
- **Closing odds for evaluation, lock-time odds for simulation.** Beating a stale
  price proves nothing.
- **Survivorship in name-matching**: dropping every player who fails to match
  between the lineup source and the fantasy source biases scDiff toward zero for
  teams with messy names. Build the name-key table first; measure match rate;
  require ≥95% before trusting results.

### 2.3 Verdict rules

- If M2 ≤ M1 on held-out data for both codes → **write the negative result into
  Results & Learnings and stop.** A clean "no" is a successful experiment; do not
  torture the data until it confesses.
- If it works: `scDiff` becomes an Elo *adjustment* at book-lock time (named-lineup
  materiality from §1.2), not a replacement. The v2 gates stay.

---

## 3. Verified data catalogue

*Filled in from a 10-agent research sweep on 2 Jul 2026. `✅` = the agent
WebFetched/curled the URL that session and the content matched; `⚠️` = strong
lead it could not fully confirm (re-verify before relying on it). No data was
downloaded — these are pointers. All of it is proprietary at the source (News
Corp / NRL / Champion Data / bookmakers); keep use private, hobby-scale, no
redistribution.*

### 3.0 READ THIS FIRST — the research changed the premise

The market-efficiency sweep returned findings that **reshape Mission A's whole
motivation**, so lead with them:

- **Closing markets are almost perfectly calibrated.** 52,411 Betfair prices
  showed r=0.995 between market-implied and actual probability. Practical rule:
  when our Elo number differs sharply from the close, the base-rate-correct
  diagnosis is *our model is missing information*, not that we found value. This
  is exactly the posture `diagnoseEdge` already takes — the data validates it.
- **Favourite-longshot bias is effectively absent in AFL h2h** (2,375 games
  2013–24, logit k=0.98 ≈ 1; possible bias only above 20/1, <2% of games). So
  our `longshot-bias` bar is defensible but will rarely be the true story — AFL
  mispricing historically lives in **venue/travel**, not longshot shading
  (Schnytzer & Weinberg found a modest exploitable home-ground effect in
  non-Victorian games — a *better* v3 feature than SuperCoach may be travel).
- **The Origin-depletion edge appears to be ≈ zero and already priced.** Pythago
  found R²≈0.05 between Origin call-ups and club win% in the inter-Origin window
  (0.11 post-Origin), and *positive* 0.22 season-wide (Origin players proxy for
  squad quality). Translation: *"fade the Origin-depleted side" has no documented
  statistical edge.* Our rep-window rule is still right to **widen the bar / warn**
  (protect against our own blindness), but Opus should **not** build a feature
  that actively bets against Origin-depleted teams expecting profit. If the
  Mission B backtest shows scDiff "working" mostly in Origin rounds, be extra
  suspicious — the literature says that edge shouldn't exist.
- **CLV is the metric that matters at hobby scale.** Beating the no-vig close
  detects skill in ~50 bets; raw $100 P/L needs thousands. Whatever we build,
  **log model price vs the Betfair/Pinnacle close and track CLV** — a model with
  consistent positive CLV is working even while P/L is still noise. (This is the
  natural next build after the data pullers: a CLV column for the sports books,
  mirroring what the World Cup engine already does.)

Refs (all ✅): [CLV — Buchdahl/Pinnacle](https://www.pinnacleoddsdropper.com/blog/closing-line-value--clv-demystified-by-expert-joseph-buchdahl),
[AFL favourite-longshot — Matter of Stats](https://www.matterofstats.com),
Schnytzer & Weinberg 2008 (RePEc), Brailsford/Gray/Easton/Gray 1995 (the canonical
both-codes study), Pythago NRL Origin analysis, [steam signatures — OddsIndex].

### 3.1 Results spine (feeds Elo — already partly wired)

| Source | Sport | What | Access | Depth |
|---|---|---|---|---|
| ✅ **fixturedownload.com** (in use) | both | fixtures + scores + Winner | JSON, needs browser UA | current season |
| ✅ [aussportsbetting.com xlsx](https://www.aussportsbetting.com/historical_data/nrl.xlsx) | both | every match 2009+ **plus odds** | XLSX, 403s non-browser UA | 2009+ (odds open/close from **2013**) |
| ✅ [nrlR](https://github.com/DanielTomaro13/nrlR) (CRAN) | NRL | fixtures/results/ladders/player stats | R package | NRL from 1998 |
| ✅ [uselessnrlstats CSVs](https://github.com/uselessnrlstats/uselessnrlstats) | NRL | cleaned match + player_match CSVs | git clone | 1908+ |
| ✅ [fitzRoy](https://jimmyday12.github.io/fitzRoy/) (CRAN) | AFL | the canonical AFL wrapper (AFLTables/footywire/fryzigg/AFL API) | R package | 1897+ |
| ✅ [AFLTables](https://afltables.com/afl/afl_index.html) | AFL | deepest match/player archive | HTML scrape / pyAFL | 1897+ |

**Recommendation:** for the Mission-B backtest spine use **aussportsbetting.com
xlsx** — it uniquely carries results *and* open/min/max/close odds in one file
from 2013, so one download gives both the outcome and the market baseline the
model must beat.

### 3.2 Market odds + line movement (feeds CLV + the `steam` cause)

| Source | Sport | What | Access | Cost |
|---|---|---|---|---|
| ✅ [Betfair AU datascientists CSVs](https://betfair-datascientists.github.io/data/dataListing/) | both | back/lay price + volume at **60/30/1 min pre-off** | direct CSV, no account | free, 2021–26 |
| ✅ [Betfair Historical Data](https://historicdata.betfair.com/) | both | full-lifetime exchange price streams | portal (any Betfair login) | BASIC free, AU from Oct 2016 |
| ✅ [Betfair API-NG](https://www.betfair.com.au/hub/automation/betting-api/) | both | live market books (log your own open→close) | REST, app key | delayed key free |
| ✅ [The Odds API](https://the-odds-api.com/) (in use) | both | live h2h/spreads/totals; historical snapshots | REST | free live 500/mo; **historical is paid** |
| ✅ [OddsPortal](https://www.oddsportal.com/rugby-league/australia/nrl/results/) | both | per-book opening→closing archive | JS scrape | free, 2009+ |

**Recommendation:** the free **Betfair datascientists CSVs** are the single best
line-movement source — they already contain the 60/30/1-minute-before-off prices
that make `steam` detection real without paying The Odds API's historical credits
or running your own logger. For the live `opts.openingOdds` snapshot, the cheapest
path is a second The-Odds-API fetch at T-6d (budget: ~+150 credits/season, fine).

### 3.3 Fantasy player values — the SuperCoach feature (Mission B)

Two separate price currencies exist; **never mix them** in one model input:

**AFL (the easy case):**
- ✅ [Footywire SuperCoach round archive](https://www.footywire.com/afl/footy/supercoach_round) — per-round SuperCoach **salary** (the pre-round price you need) + score, `?year=&round=`, **2010+**. AFL Fantasy twin at `dream_team_round` (2011+).
- ✅ Wrapped by `fitzRoy::fetch_supercoach_scores()` / `fetch_fantasy_scores()`.
- ✅ [AFL Fantasy players.json](https://fantasy.afl.com.au/data/afl/players.json) — live, embeds per-round `stats.prices` for the current season.
- ✅ [DFS Australia](https://dfsaustralia.com/downloads/) — free xlsx, AFL Fantasy 2023+, SuperCoach 2024+.

**NRL (the hard case — the gap the follow-up agents cracked):**
- ✅ [nrlsupercoachstats.com grid JSON](https://www.nrlsupercoachstats.com/2015stats.php?grid_id=list1) — **per-round** SuperCoach Price + Score per player. **Verified year-by-year:** genuine per-round *prices* only **2015–2022** (2013 price=0, 2014 = non-moving placeholder; *scores* exist 2013+). Scrape page-by-page (jqGrid, `rows=27`, `X-Requested-With: XMLHttpRequest`; ~258 pages/season; serves HTML not JSON if the request signature is wrong).
- ✅ [tspen/nrl-fantasy-player-data](https://github.com/tspen/nrl-fantasy-player-data) — bot snapshots of NRL **Fantasy** players.json since Sep 2022 → per-round prices **2023–2026**. Each file embeds the whole season's `stats.prices`.
- ✅ [fantasy.nrl.com players.json](https://fantasy.nrl.com/data/nrl/players.json) — live NRL Fantasy, current season, gzip; also carries `proj_avg` (**forecast** — Josh explicitly wanted forecasted stats) and a `status` field (not-playing/reserve) = a free lineup signal.
- ⚠️ News Corp SuperCoach API (dailytelegraph) — authoritative but **login-gated**, prior seasons decommissioned (500). Not viable for history.

**Coverage verdict:** honest backtest depth is **NRL SuperCoach price 2015–2022 +
NRL Fantasy price 2023–2026** (a structural break at 2023 — model them separately
or normalise), or push to **2013** if a trailing-average *score* is an acceptable
value proxy. AFL is clean **2010+** via Footywire. Match this against the
aussportsbetting odds (2013+) → ~2015–2024 is the sweet spot for both codes.

### 3.4 Team lists AS ANNOUNCED — the leakage-critical feed

This is the hardest and most important input: the backtest thesis is "bet at
team-list time," so we need *who was named*, **not** who actually played (using
the final XVII leaks late-withdrawal info the market had and we wouldn't have).

- ✅ **Live NRL:** [NRL.com match-centre `/data`](https://www.nrl.com/draw/nrl-premiership/2026/round-1/knights-v-cowboys/data) (browser UA → JSON, 19 named players) and [`/draw/data`](https://www.nrl.com/draw/data?competition=111&season=2026&round=18). Team List Tuesday 4pm AEST. Republishers: ✅ [Legz](https://www.legz.com.au/nrl/team-lists), ✅ [Zero Tackle](https://www.zerotackle.com/nrl/team-lists/).
- ✅ **Historical NRL as-announced:** only via **Wayback** snapshots of `nrl.com/news/{yyyy}/{mm}/{dd}/nrl-team-lists-round-{n}/` — CDX-verified back to **2021 R1** (live URLs now 302 to login, so Wayback is the only path). ✅ ESPN `rugby-league/3/summary?event=` gives the *actual* 17 (leaks — fallback only).
- ✅ **Live AFL:** [Footywire team selections](https://www.footywire.com/afl/footy/afl_team_selections) (positional 22 + labelled emergencies + ins/outs, current round) and `fitzRoy::fetch_lineup()` via the AFL API. AFL announces Wed/Thu 6:20pm AEST.
- ⚠️ **Historical AFL as-announced:** `aflapi.afl.com.au → cfs/afl/matchRoster` exposes matches to 2012 and its JSON *does* carry ins/outs arrays — but `fetch_lineup` is documented reliable only in the announced-but-not-yet-played window; **no GitHub/Kaggle archive of announced AFL selections exists**. This is the biggest data risk in Mission B; budget time to build a Wayback/Footywire scraper or accept AFL starts later than NRL.
- ✅ **Injuries:** [AFL official injury list](https://www.afl.com.au/matches/injury-list) (server-rendered, scrapeable), [Zero Tackle NRL casualty ward](https://www.zerotackle.com/nrl/injuries-suspensions/) (via `nrlR::fetch_injuries_suspensions()`).

### 3.5 Player/team ID crosswalks — the join that makes scDiff possible

"Sum the SuperCoach value of the named 17/22" is impossible without joining
disjoint ID keyspaces. Proven by spot-check (Payne Haas 2026): Fantasy
`id=504300` ≠ NRL match-centre/Champion-Data `playerId=1010991` ≠ RugbyLeagueProject
slug `25859`. **There is no shared key — plan for fuzzy name+team(+DOB) joins.**

- **NRL team IDs align:** Fantasy `squad_id` == NRL.com `teamId` (500000-range, e.g. Brisbane 500011) — teams join cleanly; only *players* are the problem.
- ✅ NRL DOB for disambiguation: [RugbyLeagueProject player pages](https://www.rugbyleagueproject.org/players/payne-haas/summary.html). NRL match-centre = ✅ [Champion Data feed](https://mc.championdata.com/data/12999/129990105.json) (`playerInfo[]` names).
- **AFL has a ready anchor:** ✅ `fitzRoy::fetch_player_details(source='AFL')` returns both an internal `id` **and** the Champion-Data `providerId` (CD_I…) on one row — but there is **no** free join from **fryzigg** or **Footywire** IDs to that providerId (see [fitzRoy #81](https://github.com/jimmyday12/fitzRoy/issues/81) — the known footywire↔afltables name-match problem). AFL Fantasy players.json uses yet another keyspace (Gawn `id=290528`).

**Phase-0 deliverable is therefore a name-key table per code** (feed ↔ odds ↔
fantasy ↔ lineup), built once, with a measured match rate (≥95% before trusting
scDiff — §2.2). This is the single most underestimated task; do it first.

### 3.6 Tooling shortcuts

- **AFL:** do almost everything through **`fitzRoy`** (R) — results, lineups,
  per-round SuperCoach/Fantasy salaries, player-detail crosswalk. If staying in
  JS/Node, replicate its endpoints (it's the reference for what works).
- **NRL:** **`nrlR`** (R) covers results/ladders/injuries; there is no fitzRoy-grade
  NRL fantasy wrapper, so the nrlsupercoachstats scraper is bespoke.
- ⚠️ Squiggle/Betfair-API/Champion-Data official are noted but not needed for v3.

---

## 4. Phased build plan

**Phase 0 — scaffolding (half a day).** New `analysis/` directory (Node, same
zero-dependency style). Data pullers with polite rate limits + on-disk caching
(`analysis/cache/`, gitignored). Name-matching key tables in `config/`
(feed-name ↔ odds-name ↔ fantasy-name ↔ lineup-name per code). Unit tests for the
matchers — name matching is where every AU sports project dies; budget real time.

**Phase 1 — historical spine (1–2 days).** Pull 2024–2026 results + closing odds
(catalogue §3) for both codes. Rebuild the Elo over that spine and confirm it
reproduces current live ratings (regression test). Deliverable: one match-level
CSV per code with Elo probs and market probs attached, plus a calibration plot
(reliability curve) of Elo vs market — this quantifies today's blind spot before
any new signal is added.

**Phase 2 — lineup + fantasy layer (2–3 days).** Historical team lists and
pre-round player values per catalogue §3. Compute scDiff per match. Match-rate
report (≥95% or fix the keys). Deliverable: the experiment of §2.1 run end-to-end,
with the Origin-window sub-analysis, written up in `analysis/RESULTS.md`.

**Phase 3 — wire the winner (1 day, only if Phase 2 says yes).** `edgeCause`
classifier (§1.1) into `generateSportBook`; scDiff materiality adjustment at book
lock; ROI-by-cause table into Results & Learnings tab. Tests for every gate.
Frozen books stay frozen.

**Phase 4 — live monitoring (ongoing).** Every locked book stores: model prob,
market prob, scDiff, edgeCause, and (later) closing price. After ~8 rounds, the
by-cause ROI table is read; causes with negative ROI get their bar raised
automatically. This is the post-mortem loop, made continuous.

### Acceptance criteria

- No real-money integration of any kind; $100 virtual stakes throughout.
- The Odds API stays within free-tier budget (≤500 credits/month, logged).
- `node --test` green before every push; new logic ships with tests.
- Historical/frozen books untouched; negative results published, not buried.
- Scraping only where ToS-tolerable and rate-limited; prefer APIs and archives.

---

## 5. How Josh works (read before your first reply)

- He wants **honest models, not confident ones** — the post-mortem culture here is
  the product. When a result is bad, lead with it.
- He spots flaws in the outputs (he caught the repeated-Germany-bets problem and
  the Origin blind spot). Show him the reasoning, not just the picks.
- Ask before changing scope; never regenerate `config/draw.json` (the frozen
  World Cup draw); prize amounts in `config/sidepots.json` are Nathaniel's to set.
- Explanations on bets are capped at ≤50 words, honest about weaknesses
  (`betComment` in `sports.js` is the house style).
- Memory file: `~/.claude/projects/-Users-joshuamcguiness-Documents-Claude-Data-Files--Pure-Earth-Marketing-Database/memory/worldcup-sweepstake-site.md`
  — keep it updated as you ship.
