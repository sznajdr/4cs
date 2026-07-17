"""Phase 1 gate: invariants over book_events + reconciliation vs live state.json.

Run on hermes:
  python -m fourcs.verify --state-dir /path/to/state --events data/book_events

Reconciliation: replay today's tape to now and diff every reconstructed ladder
against state.json's catalog per (game, bucket). Exact match is expected for
any bucket with at least one taped event since the last daemon restart.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import polars as pl

from .book import ORDERBOOK_FIELDS, BookState
from .replay import final_state
from .tape import iter_tape, tape_files
from .writers import scan_dataset


def invariants(events: pl.LazyFrame) -> dict[str, int]:
    """Violation counts; all zeros = pass (see plan's verification gate)."""
    frame = events.select(
        prob_h_bad=((pl.col("p_h") <= 0) | (pl.col("p_h") >= 1)).sum(),
        prob_a_bad=((pl.col("p_a") <= 0) | (pl.col("p_a") >= 1)).sum(),
        # Measured on the live book (2026-07): median overround ~2.2-2.5%, brief
        # crossed books to -1.6%, thin props to ~0.81. Bounds catch replay bugs
        # (wrong side pairing), not market reality.
        overround_out_of_range=((pl.col("overround") < -0.05) | (pl.col("overround") > 0.90)).sum(),
        # Only meaningful when the book is not crossed (overround >= 0); a crossed
        # book legitimately puts the mid outside [bid, ask].
        mid_outside_bests=(
            (pl.col("overround") >= 0)
            & ((pl.col("mid") > pl.col("p_h")) | (pl.col("mid") < 1 - pl.col("p_a")))
        ).sum(),
        negative_depth=((pl.col("depth1_h") < 0) | (pl.col("depth1_a") < 0)).sum(),
        mv_delta_negative=(pl.col("mv_delta") < 0).sum(),
        ts_null=pl.col("ts_ms").is_null().sum(),
    ).collect()
    return {name: int(frame[name][0] or 0) for name in frame.columns}


def _canonical_ladder(value: Any) -> str:
    if not isinstance(value, list):
        return "[]"
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def reconcile(state: BookState, state_json_path: str | Path) -> dict[str, Any]:
    """Compare replayed ladders vs live state.json per (game, bucket)."""
    snapshot = json.loads(Path(state_json_path).read_text(encoding="utf-8"))
    live_games = {game["id"]: game for game in snapshot.get("catalog", {}).get("games", []) if isinstance(game, dict)}

    compared = matched = 0
    mismatches: list[str] = []
    for game_id, game in state.games.items():
        live = live_games.get(game_id)
        if live is None:
            continue
        for bucket in ORDERBOOK_FIELDS:
            if (game_id, bucket) not in state.bucket_updated_ms:
                continue  # never taped -> unknowable, not a failure
            compared += 1
            if _canonical_ladder(game.get(bucket)) == _canonical_ladder(live.get(bucket)):
                matched += 1
            elif len(mismatches) < 20:
                mismatches.append(f"{game_id}/{bucket}")
    return {
        "replayed_games": len(state.games),
        "live_games": len(live_games),
        "buckets_compared": compared,
        "buckets_matched": matched,
        "match_rate": round(matched / compared, 4) if compared else None,
        "sample_mismatches": mismatches,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True, help="daemon state dir (tape-*.jsonl + state.json)")
    parser.add_argument("--events", help="book_events parquet root for invariant checks")
    parser.add_argument("--pattern", default="tape-*.jsonl")
    parser.add_argument("--bootstrap", action="store_true", help="seed metadata shells from state.json before replay")
    args = parser.parse_args()

    paths = tape_files(args.state_dir, args.pattern)
    print(f"tape files: {[p.name for p in paths]}")
    seed_games = None
    if args.bootstrap:
        snapshot = json.loads((Path(args.state_dir) / "state.json").read_text(encoding="utf-8"))
        seed_games = snapshot.get("catalog", {}).get("games", [])
    state = final_state(iter_tape(paths), seed_games=seed_games)
    report = reconcile(state, Path(args.state_dir) / "state.json")
    print("reconciliation:", json.dumps(report, indent=2))

    if args.events:
        print("invariants:", json.dumps(invariants(scan_dataset(args.events)), indent=2))


if __name__ == "__main__":
    main()
