"""As-of grids from book_events: forward-fill each key onto a regular clock.

Each (game_id, market, line) key is sampled on a fixed step between its first
observation and min(kickoff, last observation). `staleness_ms` records how old
the underlying book event is at each grid point — downstream consumers filter
on it instead of trusting the fill blindly. Live (in-play) rows are excluded;
pre-match is the current research scope.

  python jobs/build_grid.py --events data/book_events --out data/grid_1m --step-ms 60000
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fourcs.writers import scan_dataset

KEY = ["game_id", "market", "line"]
CARRIED = [
    "league", "kickoff_ms", "p_h", "p_a", "mid", "overround",
    "depth1_h", "depth1_a", "depth3_h", "depth3_a", "untaken_h", "untaken_a",
    "matched_volume", "main_spread", "main_total", "is_open",
]


def build_key_grid(group: pl.DataFrame, step_ms: int) -> pl.DataFrame | None:
    group = group.sort("ts_ms").unique(subset=["ts_ms"], keep="last", maintain_order=True)
    first = int(group["ts_ms"][0])
    last = int(group["ts_ms"][-1])
    kickoff = group["kickoff_ms"][0]
    end = min(last, int(kickoff)) if kickoff is not None else last
    start = ((first + step_ms - 1) // step_ms) * step_ms
    if end < start:
        return None
    ticks = pl.DataFrame({"grid_ms": range(start, end + 1, step_ms)}).with_columns(
        pl.col("grid_ms").cast(pl.Int64)
    )
    joined = ticks.join_asof(group, left_on="grid_ms", right_on="ts_ms", strategy="backward")
    return joined.with_columns(
        (pl.col("grid_ms") - pl.col("ts_ms")).alias("staleness_ms"),
        pl.lit(group["game_id"][0]).alias("game_id"),
        pl.lit(group["market"][0]).alias("market"),
        pl.lit(group["line"][0], dtype=pl.Float64).alias("line"),
    ).select(["grid_ms", "staleness_ms", *KEY, *CARRIED])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events", default="data/book_events")
    parser.add_argument("--out", required=True)
    parser.add_argument("--step-ms", type=int, default=60_000)
    parser.add_argument("--include-live", action="store_true")
    args = parser.parse_args()

    events = scan_dataset(args.events)
    if not args.include_live:
        events = events.filter(~pl.col("live"))
    frame = events.select(["ts_ms", *KEY, *CARRIED]).collect()
    print(f"book_events rows: {len(frame)}")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    grids: list[pl.DataFrame] = []
    for _, group in frame.group_by(KEY):
        grid = build_key_grid(group, args.step_ms)
        if grid is not None:
            grids.append(grid)
    if not grids:
        raise SystemExit("no grid rows produced")
    result = pl.concat(grids)
    result.write_parquet(out / f"grid-{args.step_ms}ms.parquet")
    print(f"grid rows: {len(result)} -> {out / f'grid-{args.step_ms}ms.parquet'}")


if __name__ == "__main__":
    main()
