"""Stream tape-*.jsonl files in arrival order with tolerant parsing.

Tape record shape (src/api/stream/tape.ts):
  {"receivedAt": ISO-ms local wall clock, "source": "price"|"user"|"rest",
   "type": vendor event type, "payload": verbatim vendor event}

Two eras exist: pre-Phase-0 tapes carry only WebSocket deltas; post-Phase-0
tapes additionally carry throttled `catalogSnapshot` records (source "rest")
that provide full-book baselines. The replayer handles both.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


@dataclass(frozen=True)
class TapeRecord:
    ts_ms: int
    source: str
    type: str
    payload: Any


def parse_ts_ms(value: Any) -> int | None:
    """Tolerant timestamp parse: ISO string or epoch seconds/millis -> epoch ms."""
    if isinstance(value, (int, float)):
        return int(value if value > 1e12 else value * 1000)
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            return None
    return None


def tape_files(state_dir: str | Path, pattern: str = "tape-*.jsonl") -> list[Path]:
    return sorted(Path(state_dir).glob(pattern))


def iter_tape(paths: list[Path]) -> Iterator[TapeRecord]:
    """Yield records file-by-file (days sorted), line-by-line (arrival order).

    Malformed lines are skipped; the count is reported by iter_tape_stats.
    """
    for path in paths:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                ts_ms = parse_ts_ms(record.get("receivedAt"))
                source = record.get("source")
                event_type = record.get("type")
                if ts_ms is None or not isinstance(source, str) or not isinstance(event_type, str):
                    continue
                yield TapeRecord(ts_ms=ts_ms, source=source, type=event_type, payload=record.get("payload"))
