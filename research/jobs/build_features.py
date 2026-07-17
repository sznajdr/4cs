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

With --order-events (order_events parquet root), adds per-side order-flow
splits — the fill/cancel discriminator d_depth1/d_untaken cannot express:
  {fill,cancel,amb,place}_{h,a}[_2m]   summed flow by lifecycle kind
  {fill,cancel}_best_{h,a}[_2m]        same, restricted to at-best orders
  cancel_share_{h,a}_2m                cancels / (cancels + fills)

  python jobs/build_features.py --grid data/grid_1m/grid-60000ms.parquet --out data/features.parquet
"""

from __future__ import annotations

import argparse
from pathlib import Path

import polars as pl

KEY = ["game_id", "market", "line"]

# Same sentinel eval_ic.py uses: line is null for moneyline/1x2 keys and null
# keys never match in joins.
LINE_SENTINEL = -9999.0

FILL_EVENTS = ["fill_partial", "fill_complete"]
FLOW_COLS = [f"{kind}_{side}" for kind in ("fill", "cancel", "amb", "place") for side in ("h", "a")] + [
    f"{kind}_best_{side}" for kind in ("fill", "cancel") for side in ("h", "a")
]


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


def order_flow_by_step(events: pl.LazyFrame, step_ms: int) -> pl.DataFrame:
    """Per (key, grid step, side): summed order-flow sizes by lifecycle kind.

    Events between grid points land on the NEXT point (backward-looking: at a
    grid instant every attributed event has already happened). Resync-boundary
    events (low_confidence) are excluded — a 15-min diff smeared into one step
    is noise, not flow.
    """
    side = (
        pl.when(pl.col("bucket").is_in(["homeMoneylines", "homeSpreads", "over"])).then(pl.lit("h"))
        .when(pl.col("bucket").is_in(["awayMoneylines", "awaySpreads", "under"])).then(pl.lit("a"))
        .when(pl.col("entry_side") == "yes").then(pl.lit("h"))
        .when(pl.col("entry_side") == "no").then(pl.lit("a"))
        .otherwise(pl.lit(None, dtype=pl.Utf8))
    )
    kind = (
        pl.when(pl.col("event").is_in(FILL_EVENTS)).then(pl.lit("fill"))
        .when(pl.col("event") == "cancel").then(pl.lit("cancel"))
        .when(pl.col("event") == "vanish_ambiguous").then(pl.lit("amb"))
        .when(pl.col("event").is_in(["place", "resize_up"])).then(pl.lit("place"))
        .otherwise(pl.lit(None, dtype=pl.Utf8))
    )
    # Away-spread orders quote the away line; the grid keys spreads by the home line.
    line = pl.when(pl.col("bucket") == "awaySpreads").then(-pl.col("line")).otherwise(pl.col("line"))
    flows = (
        events.filter(~pl.col("low_confidence"))
        .with_columns(
            side.alias("side"),
            kind.alias("kind"),
            line.fill_null(LINE_SENTINEL).alias("line"),
            (((pl.col("ts_ms") + step_ms - 1) // step_ms) * step_ms).alias("grid_ms"),
            pl.col("delta_size").abs().alias("size"),
            (pl.col("p_order") <= pl.col("p_best_prior") + 1e-9).fill_null(False).alias("at_best"),
        )
        .filter(pl.col("side").is_not_null() & pl.col("kind").is_not_null())
        .collect()
    )
    index = ["game_id", "market", "line", "grid_ms"]
    base = flows.with_columns((pl.col("kind") + "_" + pl.col("side")).alias("name")).pivot(
        on="name", index=index, values="size", aggregate_function="sum"
    )
    best = (
        flows.filter(pl.col("at_best") & pl.col("kind").is_in(["fill", "cancel"]))
        .with_columns((pl.col("kind") + "_best_" + pl.col("side")).alias("name"))
        .pivot(on="name", index=index, values="size", aggregate_function="sum")
    )
    merged = base.join(best, on=index, how="full", coalesce=True)
    missing = [name for name in FLOW_COLS if name not in merged.columns]
    return merged.with_columns([pl.lit(0.0).alias(name) for name in missing])


def add_order_flow(frame: pl.DataFrame, events: pl.LazyFrame, step_ms: int) -> pl.DataFrame:
    flow = order_flow_by_step(events, step_ms)
    s2 = _steps(2, step_ms)
    joined = (
        frame.with_columns(pl.col("line").fill_null(LINE_SENTINEL).alias("_line_key"))
        .join(
            flow.rename({"line": "_line_key"}),
            left_on=["game_id", "market", "_line_key", "grid_ms"],
            right_on=["game_id", "market", "_line_key", "grid_ms"],
            how="left",
        )
        .drop("_line_key")
        .with_columns([pl.col(name).fill_null(0.0) for name in FLOW_COLS])
        .sort([*KEY, "grid_ms"])
    )
    rolled = joined.with_columns(
        [pl.col(name).rolling_sum(window_size=s2, min_samples=1).over(KEY).alias(f"{name}_2m") for name in FLOW_COLS]
    )
    removals = lambda side: pl.col(f"cancel_{side}_2m") + pl.col(f"fill_{side}_2m")  # noqa: E731
    return rolled.with_columns(
        [
            pl.when(removals(side) > 0)
            .then(pl.col(f"cancel_{side}_2m") / removals(side))
            .otherwise(None)
            .alias(f"cancel_share_{side}_2m")
            for side in ("h", "a")
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--grid", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--step-ms", type=int, default=60_000)
    parser.add_argument("--order-events", help="order_events parquet root; adds fill/cancel-split flow features")
    args = parser.parse_args()

    grid = pl.read_parquet(args.grid)
    result = add_features(grid, args.step_ms)
    if args.order_events:
        events = pl.scan_parquet(str(Path(args.order_events) / "**" / "*.parquet"))
        result = add_order_flow(result, events, args.step_ms)
    result.write_parquet(args.out)
    print(f"feature rows: {len(result)}, columns: {len(result.columns)}")


if __name__ == "__main__":
    main()
