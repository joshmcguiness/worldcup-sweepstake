# NRL model backtest — results

*Live-data backtest built 2 Jul 2026 (Opus 4.8). All numbers reproducible:
`node analysis/build-spine.js` (Stage 1) and `node analysis/run-backtest.js`
(Stage 2). Data pulled fresh from free public sources into `analysis/cache/`
(gitignored) — nothing is committed to the repo.*

## Data

- **Results + closing odds:** Betfair Data Scientists CSVs, NRL 2021–2026 —
  **1,160 matches, 100% with a de-vigged closing exchange price.** Home win
  rate 56.6% (home advantage is real and large in the NRL).
- **Player values (Stage 2):** NRL Fantasy `players.json` — per-round prices +
  pre-round availability status. Live feed for 2026, `tspen/nrl-fantasy-player-data`
  git snapshots for 2023–2025.
- Teams join across sources on the canonical registry in `lib/nrl_teams.js`
  (the 500000-range `squad_id` is shared; only the display names differ).

## Stage 1 — how far behind the market is our Elo?

The same Elo the live site uses, rebuilt match-by-match in date order (25%
regression to the mean between seasons), scored against the closing market.

| Set | n | Elo log-loss | Market log-loss | gap |
|---|---|---|---|---|
| All 2021–2026 | 1,160 | 0.6352 | 0.6084 | **+0.027** |
| Settled 2023–2026 (Elo warmed up) | 773 | 0.6560 | 0.6460 | **+0.010** |

**Read:** the market is meaningfully ahead of our Elo (lower log-loss = better).
Once the ratings have two seasons to settle, the gap narrows to ~0.010 log-loss —
small but real, and exactly the gap Mission B asks whether SuperCoach lineup
value can close. The market's calibration is good through the 0.3–0.8 range and
only wobbles in the sparse tails (n<30 per bin). This is the honest baseline:
**our job is not to beat some naive line, it's to claw back that 0.01–0.027.**

## Stage 2 — does SuperCoach lineup value help?

*(written by `run-backtest.js` — see below)*

<!-- STAGE2 -->
