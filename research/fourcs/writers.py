"""Parquet writing: hive-partitioned by date=YYYY-MM-DD under a dataset root."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import polars as pl

BOOK_EVENTS_SCHEMA: dict[str, pl.DataType] = {
    "ts_ms": pl.Int64,
    "game_id": pl.Utf8,
    "league": pl.Utf8,
    "kickoff_ms": pl.Int64,
    "market": pl.Utf8,
    "line": pl.Float64,
    "p_h": pl.Float64,
    "p_a": pl.Float64,
    "mid": pl.Float64,
    "overround": pl.Float64,
    "depth1_h": pl.Float64,
    "depth1_a": pl.Float64,
    "depth3_h": pl.Float64,
    "depth3_a": pl.Float64,
    "untaken_h": pl.Float64,
    "untaken_a": pl.Float64,
    "n_levels_h": pl.Int32,
    "n_levels_a": pl.Int32,
    "matched_volume": pl.Float64,
    "mv_delta": pl.Float64,
    "main_spread": pl.Float64,
    "main_total": pl.Float64,
    "is_open": pl.Boolean,
    "live": pl.Boolean,
    "baseline": pl.Boolean,
    "event_type": pl.Utf8,
    "age_h_ms": pl.Int64,
    "age_a_ms": pl.Int64,
}


def _date_of(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def write_book_events(rows: Iterator[dict[str, Any]], out_root: str | Path, chunk_rows: int = 250_000) -> int:
    """Stream rows to date-partitioned parquet; returns total rows written."""
    out_root = Path(out_root)
    buffer: list[dict[str, Any]] = []
    total = 0

    def flush() -> None:
        nonlocal total
        if not buffer:
            return
        frame = pl.DataFrame(buffer, schema=BOOK_EVENTS_SCHEMA, strict=False)
        frame = frame.with_columns(pl.col("ts_ms").map_elements(_date_of, return_dtype=pl.Utf8).alias("date"))
        for (date,), part in frame.partition_by("date", as_dict=True).items():
            part_dir = out_root / f"date={date}"
            part_dir.mkdir(parents=True, exist_ok=True)
            part.drop("date").write_parquet(part_dir / f"part-{uuid.uuid4().hex[:12]}.parquet")
        total += len(frame)
        buffer.clear()

    for row in rows:
        buffer.append(row)
        if len(buffer) >= chunk_rows:
            flush()
    flush()
    return total


def scan_dataset(root: str | Path) -> pl.LazyFrame:
    return pl.scan_parquet(str(Path(root) / "**" / "*.parquet"))
