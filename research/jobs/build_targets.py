"""Forward targets on a regular grid (Phase 2).

Per key and horizon h (minutes):
  fwd_dmid_{h}m   = mid(t+h) - mid(t) in prob space; null when either end is
                    stale (> max-staleness) or the market is closed at either end
  fwd_dir_{h}m    = sign with dead-zone eps (-1/0/+1)
  fwd_dline_{h}m  = main_spread (spread keys) / main_total (total keys) change
                    over h — "the line moved" in the bettor's sense
  fwd_dmid_ko     = last fresh mid before kickoff minus mid(t)

  python jobs/build_targets.py --grid data/grid_1m/grid-60000ms.parquet --out data/targets.parquet
"""

from __future__ import annotations

import argparse

import polars as pl

HORIZONS_MIN = (1, 5, 15, 30, 60)
EPS = 0.002
KEY = ["game_id", "market", "line"]


def add_targets(grid: pl.DataFrame, step_ms: int, max_staleness_ms: int) -> pl.DataFrame:
    grid = grid.sort([*KEY, "grid_ms"])
    fresh = (pl.col("staleness_ms") <= max_staleness_ms) & pl.col("is_open")
    valid_mid = pl.when(fresh).then(pl.col("mid")).otherwise(None)
    main_line = (
        pl.when(pl.col("market") == "spread").then(pl.col("main_spread"))
        .when(pl.col("market") == "total").then(pl.col("main_total"))
        .otherwise(None)
    )
    grid = grid.with_columns(valid_mid.alias("_mid_ok"), main_line.alias("_main_line"))

    expressions: list[pl.Expr] = []
    for horizon in HORIZONS_MIN:
        steps = (horizon * 60_000) // step_ms
        if steps < 1:
            continue
        dmid = (pl.col("_mid_ok").shift(-steps) - pl.col("_mid_ok")).over(KEY)
        expressions.append(dmid.alias(f"fwd_dmid_{horizon}m"))
        expressions.append(
            pl.when(dmid > EPS).then(1).when(dmid < -EPS).then(-1)
            .when(dmid.is_not_null()).then(0).otherwise(None)
            .cast(pl.Int8).alias(f"fwd_dir_{horizon}m")
        )
        expressions.append(
            (pl.col("_main_line").shift(-steps) - pl.col("_main_line")).over(KEY).alias(f"fwd_dline_{horizon}m")
        )

    closing = pl.col("_mid_ok").last().over(KEY)
    expressions.append((closing - pl.col("_mid_ok")).alias("fwd_dmid_ko"))
    return grid.with_columns(expressions).drop(["_mid_ok", "_main_line"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--grid", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--step-ms", type=int, default=60_000)
    parser.add_argument("--max-staleness-ms", type=int, default=180_000)
    args = parser.parse_args()

    grid = pl.read_parquet(args.grid)
    result = add_targets(grid, args.step_ms, args.max_staleness_ms)
    result.write_parquet(args.out)
    coverage = result.select(
        rows=pl.len(),
        **{f"nonnull_fwd_dmid_{h}m": pl.col(f"fwd_dmid_{h}m").is_not_null().sum() for h in HORIZONS_MIN},
    )
    print(coverage)


if __name__ == "__main__":
    main()
