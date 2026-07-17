"""Ordered tape replay -> one BookEvent row per affected (game, market, line).

Event handling:
  rest/catalogSnapshot          -> absorb all games, emit all keys (baseline)
  price full-game (gameUpdate)  -> absorb game, emit all its keys
  price bucket replacement      -> emit keys of the touched market(s) only
  price matchedVolumeUpdate     -> emit all keys of the game (mv is game-level)
  price malformed, user/*       -> skipped (account events are not book data)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator

from .book import BookState
from .lines import game_key_books, market_bucket_pair, markets_for_buckets
from .probs import pair_mid, pair_overround
from .tape import TapeRecord, parse_ts_ms


@dataclass
class ReplayStats:
    events: int = 0
    baselines: int = 0
    book_events: int = 0
    mv_events: int = 0
    mv_resets: int = 0
    skipped_unknown_game: int = 0
    seeded_games: int = 0
    rows: int = 0
    counts_by_type: dict[str, int] = field(default_factory=dict)


def _game_number(game: dict, key: str) -> float | None:
    value = game.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def _rows_for_game(
    state: BookState,
    game_id: str,
    ts_ms: int,
    markets: set[str] | None,
    event_type: str,
    mv_delta: float | None,
    baseline: bool,
) -> Iterator[dict[str, Any]]:
    game = state.games.get(game_id)
    if game is None:
        return
    kickoff_ms = parse_ts_ms(game.get("start"))
    is_open = state.is_open(game_id)
    matched_volume = state.matched_volume.get(game_id)
    main_spread = _game_number(game, "mainHomeSpread")
    main_total = _game_number(game, "mainTotal")
    league = game.get("league") if isinstance(game.get("league"), str) else None

    for (market, line), (side_h, side_a) in game_key_books(game, markets).items():
        bucket_h, bucket_a = market_bucket_pair(market)
        yield {
            "ts_ms": ts_ms,
            "game_id": game_id,
            "league": league,
            "kickoff_ms": kickoff_ms,
            "market": market,
            "line": line,
            "p_h": side_h.p_best,
            "p_a": side_a.p_best,
            "mid": pair_mid(side_h.p_best, side_a.p_best),
            "overround": pair_overround(side_h.p_best, side_a.p_best),
            "depth1_h": side_h.depth1,
            "depth1_a": side_a.depth1,
            "depth3_h": side_h.depth3,
            "depth3_a": side_a.depth3,
            "untaken_h": side_h.untaken,
            "untaken_a": side_a.untaken,
            "n_levels_h": side_h.n_levels,
            "n_levels_a": side_a.n_levels,
            "matched_volume": matched_volume,
            "mv_delta": mv_delta,
            "main_spread": main_spread,
            "main_total": main_total,
            "is_open": is_open,
            "live": kickoff_ms is not None and ts_ms >= kickoff_ms,
            "baseline": baseline,
            "event_type": event_type,
            "age_h_ms": state.bucket_age_ms(game_id, bucket_h, ts_ms),
            "age_a_ms": state.bucket_age_ms(game_id, bucket_a, ts_ms),
        }


def replay(
    records: Iterator[TapeRecord],
    stats: ReplayStats | None = None,
    seed_games: list[Any] | None = None,
) -> Iterator[dict[str, Any]]:
    state = BookState()
    stats = stats if stats is not None else ReplayStats()
    if seed_games:
        stats.seeded_games = state.seed_metadata(seed_games)

    for record in records:
        stats.events += 1
        stats.counts_by_type[f"{record.source}/{record.type}"] = (
            stats.counts_by_type.get(f"{record.source}/{record.type}", 0) + 1
        )

        if record.source == "rest" and record.type == "catalogSnapshot":
            for game_id in state.apply_catalog_snapshot(record.payload, record.ts_ms):
                stats.baselines += 1
                for row in _rows_for_game(state, game_id, record.ts_ms, None, "baseline", None, True):
                    stats.rows += 1
                    yield row
            continue

        if record.source != "price" or record.type == "malformed":
            continue

        result = state.apply_price_event(record.type, record.payload, record.ts_ms)
        if result.game_id is None:
            stats.skipped_unknown_game += 1
            continue

        if result.mv_delta is not None:
            stats.mv_events += 1
            if result.mv_reset:
                stats.mv_resets += 1
            for row in _rows_for_game(state, result.game_id, record.ts_ms, None, "mv", result.mv_delta, False):
                stats.rows += 1
                yield row
            continue

        markets = None if result.full_game else markets_for_buckets(result.buckets)
        if markets is not None and not markets:
            continue
        event_type = "game" if result.full_game else "book"
        stats.book_events += 1
        for row in _rows_for_game(state, result.game_id, record.ts_ms, markets, event_type, None, False):
            stats.rows += 1
            yield row


def final_state(records: Iterator[TapeRecord], seed_games: list[Any] | None = None) -> BookState:
    """Replay for state only (no rows) — used by verify.reconcile."""
    state = BookState()
    if seed_games:
        state.seed_metadata(seed_games)
    for record in records:
        if record.source == "rest" and record.type == "catalogSnapshot":
            state.apply_catalog_snapshot(record.payload, record.ts_ms)
        elif record.source == "price" and record.type != "malformed":
            state.apply_price_event(record.type, record.payload, record.ts_ms)
    return state
