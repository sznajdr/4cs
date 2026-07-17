"""IC evaluation harness (Phase 4).

For each feature x horizon:
  pooled Spearman IC (inflated by cross-game composition — reported for context)
  mean of within-game ICs + t-stat (the honest number; games need >= min-obs rows)
  decile table of per-game-demeaned forward move by feature decile

Splits are by game — never within a game. Output: CSV + markdown to reports/.

  python jobs/eval_ic.py --features data/features.parquet --targets data/targets.parquet --out reports
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl
from scipy import stats

KEY = ["game_id", "market", "line", "grid_ms"]

FEATURES = [
    "imb1", "imb3", "d_untaken_h_2m", "d_untaken_a_2m", "d_untaken_net_2m",
    "d_untaken_h_10m", "d_untaken_a_10m", "d_depth1_h_2m", "d_depth1_a_2m",
    "mv_rate_1m", "mv_z_30m", "mom_1m", "mom_5m", "mom_15m",
    "overround", "d_overround_5m", "flicker_5m", "slope_asym",
    "liq_share", "x_ml_mom_5m",
    # Order-flow splits (build_features --order-events): the d_depth1/d_untaken
    # deltas decomposed by lifecycle kind — fills and cancels carry opposite
    # information that the aggregate deltas average away.
    "fill_h_2m", "fill_a_2m", "cancel_h_2m", "cancel_a_2m",
    "amb_h_2m", "amb_a_2m", "place_h_2m", "place_a_2m",
    "fill_best_h_2m", "fill_best_a_2m", "cancel_best_h_2m", "cancel_best_a_2m",
    "cancel_share_h_2m", "cancel_share_a_2m",
]
TARGETS = ["fwd_dmid_1m", "fwd_dmid_5m", "fwd_dmid_15m", "fwd_dmid_30m", "fwd_dmid_60m", "fwd_dmid_ko"]


def spearman(x: np.ndarray, y: np.ndarray) -> float | None:
    if len(x) < 10 or np.std(x) == 0 or np.std(y) == 0:
        return None
    value = stats.spearmanr(x, y).statistic
    return None if np.isnan(value) else float(value)


def evaluate(frame: pl.DataFrame, feature: str, target: str, min_obs: int) -> dict | None:
    pair = frame.select(["game_id", feature, target]).drop_nulls()
    if len(pair) < 100:
        return None
    x = pair[feature].to_numpy()
    y = pair[target].to_numpy()
    pooled = spearman(x, y)

    per_game: list[float] = []
    for _, group in pair.group_by("game_id"):
        if len(group) < min_obs:
            continue
        ic = spearman(group[feature].to_numpy(), group[target].to_numpy())
        if ic is not None:
            per_game.append(ic)
    if len(per_game) < 3:
        return None
    mean_ic = float(np.mean(per_game))
    std_ic = float(np.std(per_game, ddof=1))
    t_stat = mean_ic / (std_ic / np.sqrt(len(per_game))) if std_ic > 0 else None

    demeaned = pair.with_columns((pl.col(target) - pl.col(target).mean().over("game_id")).alias("_t"))
    with_decile = demeaned.with_columns(
        (pl.col(feature).rank("ordinal") * 10 // (pl.len() + 1)).cast(pl.Int8).alias("_decile")
    )
    deciles = with_decile.group_by("_decile").agg(pl.col("_t").mean()).sort("_decile")
    spread_d10_d1 = float(deciles["_t"][-1] - deciles["_t"][0]) if len(deciles) >= 2 else None

    return {
        "feature": feature,
        "target": target,
        "n_obs": len(pair),
        "n_games": len(per_game),
        "pooled_ic": round(pooled, 4) if pooled is not None else None,
        "within_game_ic_mean": round(mean_ic, 4),
        "within_game_ic_t": round(t_stat, 2) if t_stat is not None else None,
        "decile_spread": round(spread_d10_d1, 5) if spread_d10_d1 is not None else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--features", required=True)
    parser.add_argument("--targets", required=True)
    parser.add_argument("--out", default="reports")
    parser.add_argument("--min-obs", type=int, default=30)
    parser.add_argument("--market", help="restrict to one market, e.g. moneyline")
    args = parser.parse_args()

    # line is null for moneyline/1x2 keys and null keys never match in joins;
    # fill with a sentinel no real line can take.
    line_key = pl.col("line").fill_null(-9999.0)
    features = pl.read_parquet(args.features).with_columns(line_key)
    targets = pl.read_parquet(args.targets).select(
        [*KEY, *[t for t in TARGETS if t in pl.read_parquet_schema(args.targets)]]
    ).with_columns(line_key)
    frame = features.join(targets, on=KEY, how="inner")
    if args.market:
        frame = frame.filter(pl.col("market") == args.market)
    print(f"joined rows: {len(frame)}")

    rows = []
    for target in TARGETS:
        if target not in frame.columns:
            continue
        for feature in FEATURES:
            if feature not in frame.columns:
                continue
            result = evaluate(frame, feature, target, args.min_obs)
            if result is not None:
                rows.append(result)

    if not rows:
        raise SystemExit("no evaluable feature/target pairs (not enough data yet)")
    table = pl.DataFrame(rows).sort("within_game_ic_t", descending=True, nulls_last=True)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    suffix = f"-{args.market}" if args.market else ""
    table.write_csv(out / f"ic{suffix}-{stamp}.csv")

    lines = [
        f"# IC report {stamp} {args.market or 'all markets'}",
        "",
        f"rows joined: {len(frame)}  |  min obs per game: {args.min_obs}",
        "",
        "| feature | target | n_games | pooled IC | within-game IC | t | decile spread |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for row in table.head(40).iter_rows(named=True):
        lines.append(
            f"| {row['feature']} | {row['target']} | {row['n_games']} | {row['pooled_ic']} "
            f"| {row['within_game_ic_mean']} | {row['within_game_ic_t']} | {row['decile_spread']} |"
        )
    (out / f"ic{suffix}-{stamp}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out / f'ic{suffix}-{stamp}.csv'} and .md")
    print(table.head(15))


if __name__ == "__main__":
    main()
