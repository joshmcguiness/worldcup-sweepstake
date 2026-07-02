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

> **STATUS — HARNESS SHIPPED (2 Jul 2026), AWAITING DATA.** The full experiment
> machinery is built and tested in [`analysis/lib/`](../analysis/lib/):
> `stats.js` (seeded logistic regression, log-loss/Brier, calibration bins,
> seeded bootstrap) and `backtest.js` (`runExperiment` = the nested M1/M2/M3
> models with time-ordered season splits, leakage-guarded standardisation,
> `profitSim`, the Origin sub-analysis, and `verdict()` applying the §2.3 rules).
> `analysis/backtest.test.js` proves it on synthetic leagues: it detects a real
> SuperCoach edge when one is injected **and returns an honest "no" on pure
> noise** — so a future "yes" on real data will mean something. What remains is
> feeding it real match records (§3 sources → the puller in §4 Phase 1–2).

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

*(Filled in from the research sweep — every `✅` URL was fetched live on 2 Jul 2026;
treat `⚠️ unverified` entries as leads to re-verify, not facts.)*

<!-- CATALOGUE -->

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
