"""Replay tape-*.jsonl into the book_events parquet dataset.

  python jobs/build_book.py --state-dir /path/to/state --out data/book_events
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fourcs.replay import ReplayStats, replay
from fourcs.tape import iter_tape, tape_files
from fourcs.writers import write_book_events


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--out", default="data/book_events")
    parser.add_argument("--pattern", default="tape-*.jsonl", help="e.g. tape-2026-07-*.jsonl for one month")
    parser.add_argument(
        "--bootstrap-state", nargs="?", const="state.json",
        help="seed game metadata shells (participants/league/kickoff, no prices) from a state.json "
             "so pre-catalogSnapshot tape eras can route bucket events; default file: state.json in --state-dir",
    )
    args = parser.parse_args()

    paths = tape_files(args.state_dir, args.pattern)
    if not paths:
        raise SystemExit(f"no tape files matching {args.pattern} in {args.state_dir}")
    print(f"replaying {len(paths)} tape files: {paths[0].name} .. {paths[-1].name}")

    seed_games = None
    if args.bootstrap_state:
        state_path = Path(args.bootstrap_state)
        if not state_path.is_absolute():
            state_path = Path(args.state_dir) / state_path
        seed_games = json.loads(state_path.read_text(encoding="utf-8")).get("catalog", {}).get("games", [])
        print(f"bootstrap metadata from {state_path}: {len(seed_games)} games")

    stats = ReplayStats()
    total = write_book_events(replay(iter_tape(paths), stats, seed_games=seed_games), args.out)
    print(f"rows written: {total}")
    print(json.dumps({
        "events": stats.events,
        "baselines": stats.baselines,
        "book_events": stats.book_events,
        "mv_events": stats.mv_events,
        "mv_resets": stats.mv_resets,
        "skipped_unknown_game": stats.skipped_unknown_game,
        "seeded_games": stats.seeded_games,
        "rows": stats.rows,
        "counts_by_type": stats.counts_by_type,
    }, indent=2))


if __name__ == "__main__":
    main()
