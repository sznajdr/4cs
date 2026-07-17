# 4casters line-movement research layer

Python research layer over the daemon's tape (`state/tape-*.jsonl`). Replays the
raw event tape into a probability-space book history, builds forward targets and
microstructure features, and measures which indicators predict line movement.
No strategies, no execution — measurement only.

All prices are modeled in **implied probability space** (`p = 1/decimal`).
For a two-sided book: `mid = (p_h + 1 - p_a)/2`, `overround = p_h + p_a - 1`.

## Setup (on hermes, where the tape lives)

```bash
cd research
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest                       # 15 tests, no data needed
```

## Pipeline

```bash
# 1. tape -> book_events parquet (date-partitioned)
python jobs/build_book.py --state-dir ../state --out data/book_events

# 1b. tape -> order_events parquet (per-order lifecycle: place/fill/cancel)
python jobs/build_order_events.py --state-dir ../state --out data/order_events

# gate: reconcile replayed book vs live state.json + invariants
# --orders adds the order-events gate (telescoping + cross-path totals)
python -m fourcs.verify --state-dir ../state --events data/book_events --orders

# 2. regular grids (1m for eval, 10s for microstructure deep dives)
python jobs/build_grid.py --events data/book_events --out data/grid_1m --step-ms 60000
python jobs/build_grid.py --events data/book_events --out data/grid_10s --step-ms 10000

# 3. targets + features (both on the 1m grid)
# --order-events adds fill/cancel-split flow features from step 1b
python jobs/build_targets.py --grid data/grid_1m/grid-60000ms.parquet --out data/targets.parquet
python jobs/build_features.py --grid data/grid_1m/grid-60000ms.parquet --out data/features.parquet --order-events data/order_events

# 4. IC report -> reports/ic-*.{csv,md}
python jobs/eval_ic.py --features data/features.parquet --targets data/targets.parquet --out reports
```

Ad-hoc queries with DuckDB (no DB server): `duckdb -c ".read sql/coverage.sql"`.

Sync reports back to the workstation:
`rsync -av hermes:~/4cs/research/reports/ research/reports/`

## Reading the IC report

- `within_game_ic_mean` + `t` is the honest signal number (pooled IC is inflated
  by cross-game composition). |t| >= 3 across many games is worth a deeper look.
- `decile_spread` is the per-game-demeaned forward move difference between the
  top and bottom feature decile — the economic size of the effect.
- Splits are by game and calendar week. Never split within a game.

## Data notes

- The exchange publishes **no per-trade tape**; `matchedVolumeUpdate` is a
  cumulative per-game figure. Liquidity add/pull features are the substitute.
- WS ladder entries carry a stable per-order `id` (+ `sumUntaken`, `takenRatio`,
  `createdAt`): `order_events` diffs consecutive ladders per id to recover
  place/fill/cancel lifecycle — the split the depth aggregates average away.
  `bet == sumUntaken * (decimal - 1)`; `takenRatio` has ~1e-8 float noise
  (including negative values), so sub-cent deltas are ignored (see
  `fourcs/orders.py`).
- Pre-Phase-0 tape days have no full-book baselines (WS deltas only): books
  self-heal per bucket on first event; expect a warm-up gap per game.
- Timestamps are daemon receive-time (local wall clock), not exchange time.
- Pre-match only for now: grid rows stop at kickoff; `live` rows are flagged
  in book_events and excluded by build_grid unless `--include-live`.
