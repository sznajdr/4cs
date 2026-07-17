"""Indicator library on a regular grid (Phase 3).

Liquidity-change features stand in for the trade prints this exchange does not
publish. All windows are expressed in minutes and converted to grid steps.

Features (per key unless noted):
  imb1, imb3            top-of-book / top-3 depth imbalance (h vs a)
  d_untaken_{2,10}m     signed liquidity add/pull per side + net
  d_depth1_{2}m         change at best level per side (pulled-at-best precursor)
  mv_rate_1m, mv_z_30m  matched-volume rate and its z-score vs trailing 30m
  mom_{1,5,15}m         trailing mid momentum
  overround, d_overround_5m
  flicker_5m            count of best-price changes in trailing 5m
  slope_asym            (depth3/depth1 - 1) difference between sides
  liq_share, is_main    liquidity share across sibling lines (spread/total)
  x_ml_mom_5m           game-level moneyline momentum joined onto other markets
  ttk_min, ttk_bucket   time-to-kickoff regime (split variable, not a predictor)

  python jobs/build_features.py --grid data/grid_1m/grid-60000ms.parquet --out data/features.parquet
"""

from __future__ import annotations

import argparse

import polars as pl

KEY = ["game_id", "market", "line"]


def _steps(minutes: int, step_ms: int) -> int:
    return max(1, (minutes * 60_000) // step_ms)


def _imbalance(h: str, a: str) -> pl.Expr:
    total = pl.col(h) + pl.col(a)
    return pl.when(total > 0).then((pl.col(h) - pl.col(a)) / total).otherwise(None)


def add_features(grid: pl.DataFrame, step_ms: int) -> pl.DataFrame:
    grid = grid.sort([*KEY, "grid_ms"])
    s1, s2, s5, s10, s15, s30 = (_steps(m, step_ms) for m in (1, 2, 5, 10, 15, 30))

    diff = lambda col, steps: (pl.col(col) - pl.col(col).shift(steps)).over(KEY)  # noqa: E731

    price_changed = (
        (pl.col("p_h") != pl.col("p_h").shift(1)) | (pl.col("p_a") != pl.col("p_a").shift(1))
    ).cast(pl.Int32)
    slope = lambda d3, d1: pl.when(pl.col(d1) > 0).then(pl.col(d3) / pl.col(d1) - 1).otherwise(None)  # noqa: E731

    mv_rate = diff("matched_volume", s1)
    frame = grid.with_columns(
        _imbalance("depth1_h", "depth1_a").alias("imb1"),
        _imbalance("depth3_h", "depth3_a").alias("imb3"),
        diff("untaken_h", s2).alias("d_untaken_h_2m"),
        diff("untaken_a", s2).alias("d_untaken_a_2m"),
        diff("untaken_h", s10).alias("d_untaken_h_10m"),
        diff("untaken_a", s10).alias("d_untaken_a_10m"),
        diff("depth1_h", s2).alias("d_depth1_h_2m"),
        diff("depth1_a", s2).alias("d_depth1_a_2m"),
        mv_rate.alias("mv_rate_1m"),
        diff("mid", s1).alias("mom_1m"),
        diff("mid", s5).alias("mom_5m"),
        diff("mid", s15).alias("mom_15m"),
        diff("overround", s5).alias("d_overround_5m"),
        price_changed.rolling_sum(window_size=s5, min_samples=1).over(KEY).alias("flicker_5m"),
        (slope("depth3_h", "depth1_h") - slope("depth3_a", "depth1_a")).alias("slope_asym"),
        ((pl.col("kickoff_ms") - pl.col("grid_ms")) / 60_000.0).alias("ttk_min"),
    )
    frame = frame.with_columns(
        (pl.col("d_untaken_h_2m") - pl.col("d_untaken_a_2m")).alias("d_untaken_net_2m"),
        ((pl.col("mv_rate_1m") - pl.col("mv_rate_1m").rolling_mean(window_size=s30, min_samples=5).over(KEY))
         / pl.col("mv_rate_1m").rolling_std(window_size=s30, min_samples=5).over(KEY)).alias("mv_z_30m"),
        pl.when(pl.col("ttk_min") > 24 * 60).then(pl.lit("gt24h"))
        .when(pl.col("ttk_min") > 6 * 60).then(pl.lit("6h-24h"))
        .when(pl.col("ttk_min") > 60).then(pl.lit("1h-6h"))
        .when(pl.col("ttk_min") > 0).then(pl.lit("lt1h"))
        .otherwise(pl.lit("live")).alias("ttk_bucket"),
    )

    # Liquidity share across sibling lines of the same market at the same instant
    # (main-line proximity / migration precursor for spreads and totals).
    line_liq = pl.col("untaken_h") + pl.col("untaken_a")
    frame = frame.with_columns(
        (line_liq / line_liq.sum().over(["game_id", "market", "grid_ms"])).alias("liq_share"),
        pl.when(pl.col("market") == "spread").then(pl.col("line") == pl.col("main_spread"))
        .when(pl.col("market") == "total").then(pl.col("line") == pl.col("main_total"))
        .otherwise(None).alias("is_main"),
    )

    # Cross-market coherence: moneyline momentum joined onto every other market
    # of the same game (does the ML book lead spreads/totals/1x2?).
    ml = (
        frame.filter(pl.col("market") == "moneyline")
        .select(["game_id", "grid_ms", pl.col("mom_5m").alias("x_ml_mom_5m"), pl.col("mid").alias("x_ml_mid")])
    )
    return frame.join(ml, on=["game_id", "grid_ms"], how="left")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--grid", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--step-ms", type=int, default=60_000)
    args = parser.parse_args()

    grid = pl.read_parquet(args.grid)
    result = add_features(grid, args.step_ms)
    result.write_parquet(args.out)
    print(f"feature rows: {len(result)}, columns: {len(result.columns)}")


if __name__ == "__main__":
    main()
