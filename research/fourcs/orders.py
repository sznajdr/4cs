"""Order-lifecycle events from ladder replacements: the fill/cancel discriminator.

Every WS orderUpdate replaces one (game, bucket) ladder whose entries carry a
stable per-order `id` plus `sumUntaken`, `takenRatio`, `bet`, `odds`,
`createdAt`. Diffing consecutive ladders per id recovers order lifecycle that
BOOK_EVENTS_SCHEMA's depth aggregates destroy.

Vendor semantics (verified on captured tape, 2026-07-15):
  bet == sumUntaken * (decimal_odds - 1) exactly -> sumUntaken is the takeable
    stake, bet the corresponding win amount. Sizes are currency.
  takenRatio floats around 0 with ~1e-8 noise, including NEGATIVE values ->
    all comparisons need epsilons; sumUntaken deltas are the primary signal.
  Same-id odds changes and in-place sumUntaken decreases were absent in the
    sample; both paths are still handled (reprice / fill_partial).

Classification of a vanished id is inherently ambiguous at frame cadence: a
complete take between two frames looks like a cancel unless the last-seen
takenRatio ~ 1 or remaining ~ 0. Game-level matched-volume movement over the
same gap (`mv_gap_delta`) is recorded on every event so downstream can
re-split `cancel` vs `vanish_ambiguous`; mv is game-level, not bucket-level,
so it corroborates rather than proves.

Baselines (catalogSnapshot / full-game payloads) are state syncs, not organic
flow: events diffed across them are marked low_confidence, and ladders whose
entries lack ids reset tracking silently instead of fabricating cancels.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator

from .book import ORDERBOOK_FIELDS, BookState
from .lines import BUCKET_MARKETS
from .probs import american_to_prob
from .tape import TapeRecord, parse_ts_ms

# A cent of stake: below this a size delta is float noise, not an event.
SIZE_EPS = 0.01
RATIO_EPS = 1e-6

EVENTS = ("place", "fill_partial", "fill_complete", "cancel", "vanish_ambiguous", "resize_up", "reprice")

_BUCKET_LINE_FIELD = {
    "homeSpreads": "spread",
    "awaySpreads": "spread",
    "over": "total",
    "under": "total",
}


@dataclass
class OrderStats:
    frames: int = 0
    seeds: int = 0
    resyncs: int = 0
    idless_resets: int = 0
    epoch_regressions: int = 0
    events_by_type: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class _Seen:
    odds: Any
    sum_untaken: float
    taken_ratio: float
    created_ms: int | None
    line: float | None
    entry_side: str | None
    p_order: float | None


def _entry_line(entry: dict, bucket: str) -> float | None:
    line_field = _BUCKET_LINE_FIELD.get(bucket)
    if line_field is None:
        return None
    value = entry.get(line_field)
    return round(float(value), 2) if isinstance(value, (int, float)) else None


def _seen_from(entry: dict, bucket: str) -> _Seen:
    sum_untaken = entry.get("sumUntaken")
    taken_ratio = entry.get("takenRatio")
    side = entry.get("side")
    return _Seen(
        odds=entry.get("odds"),
        sum_untaken=float(sum_untaken) if isinstance(sum_untaken, (int, float)) else 0.0,
        taken_ratio=float(taken_ratio) if isinstance(taken_ratio, (int, float)) else 0.0,
        created_ms=parse_ts_ms(entry.get("createdAt")),
        line=_entry_line(entry, bucket),
        entry_side=side if isinstance(side, str) else None,
        p_order=american_to_prob(entry.get("odds")),
    )


def _best_prob(id_map: dict[str, _Seen]) -> float | None:
    """Best takeable prob = MIN implied prob among sized entries (lines.py rule)."""
    probs = [seen.p_order for seen in id_map.values() if seen.p_order is not None and seen.sum_untaken > SIZE_EPS]
    return min(probs) if probs else None


@dataclass
class OrderTracker:
    """Per-(game, bucket) id-map differ. Feed each ladder replacement in tape order."""

    stats: OrderStats = field(default_factory=OrderStats)
    _ladders: dict[tuple[str, str], dict[str, _Seen]] = field(default_factory=dict)
    _mv_at_frame: dict[tuple[str, str], float | None] = field(default_factory=dict)
    # Telescoping check: base total at last seed/reset + sum of emitted
    # delta_size must equal the tracked ladder total. Any drift = missed event.
    _segment_base: dict[tuple[str, str], float] = field(default_factory=dict)
    _delta_sum: dict[tuple[str, str], float] = field(default_factory=dict)

    def _event(
        self,
        event: str,
        ts_ms: int,
        game_id: str,
        bucket: str,
        order_id: str,
        seen: _Seen,
        *,
        delta_size: float,
        remaining: float,
        p_best_prior: float | None,
        mv_gap_delta: float | None,
        low_confidence: bool,
        epoch: float | None,
    ) -> dict[str, Any]:
        self.stats.events_by_type[event] = self.stats.events_by_type.get(event, 0) + 1
        return {
            "ts_ms": ts_ms,
            "game_id": game_id,
            "bucket": bucket,
            "market": BUCKET_MARKETS.get(bucket, (None,))[0],
            "line": seen.line,
            "entry_side": seen.entry_side,
            "event": event,
            "order_id": order_id,
            "odds": float(seen.odds) if isinstance(seen.odds, (int, float)) else None,
            "p_order": seen.p_order,
            "delta_size": delta_size,
            "remaining": remaining,
            "taken_ratio_last": seen.taken_ratio,
            "order_age_ms": None if seen.created_ms is None else ts_ms - seen.created_ms,
            "p_best_prior": p_best_prior,
            "mv_gap_delta": mv_gap_delta,
            "low_confidence": low_confidence,
            "epoch": epoch,
        }

    def observe_ladder(
        self,
        game_id: str,
        bucket: str,
        ladder: list[Any],
        ts_ms: int,
        *,
        mv_now: float | None = None,
        epoch: float | None = None,
        resync: bool = False,
    ) -> list[dict[str, Any]]:
        self.stats.frames += 1
        key = (game_id, bucket)
        entries = [entry for entry in ladder if isinstance(entry, dict)]
        with_ids = [entry for entry in entries if isinstance(entry.get("id"), str)]

        # Id-less ladders (REST-rendered OddsLevel has no id) cannot be diffed:
        # drop tracking silently rather than fabricate a mass cancel + mass
        # place; the next id-bearing frame re-seeds.
        if entries and len(with_ids) < len(entries):
            self._ladders.pop(key, None)
            self._mv_at_frame.pop(key, None)
            self._segment_base.pop(key, None)
            self._delta_sum.pop(key, None)
            self.stats.idless_resets += 1
            return []

        new_map = {entry["id"]: _seen_from(entry, bucket) for entry in with_ids}
        prev = self._ladders.get(key)
        prev_mv = self._mv_at_frame.get(key)
        self._ladders[key] = new_map
        self._mv_at_frame[key] = mv_now

        if prev is None:
            # First sight: these orders predate observation; placements would be fake.
            self._segment_base[key] = sum(seen.sum_untaken for seen in new_map.values())
            self._delta_sum[key] = 0.0
            self.stats.seeds += 1
            return []
        if resync:
            self.stats.resyncs += 1

        mv_gap_delta = None
        if mv_now is not None and prev_mv is not None:
            mv_gap_delta = max(0.0, mv_now - prev_mv)  # mv resets clip to 0 upstream

        p_best_prior = _best_prob(prev)
        low_confidence = resync
        events: list[dict[str, Any]] = []

        for order_id, seen in new_map.items():
            old = prev.get(order_id)
            if old is None:
                events.append(self._event(
                    "place", ts_ms, game_id, bucket, order_id, seen,
                    delta_size=seen.sum_untaken, remaining=seen.sum_untaken,
                    p_best_prior=p_best_prior, mv_gap_delta=mv_gap_delta,
                    low_confidence=low_confidence, epoch=epoch,
                ))
                continue
            if seen.odds != old.odds:
                events.append(self._event(
                    "reprice", ts_ms, game_id, bucket, order_id, seen,
                    delta_size=seen.sum_untaken - old.sum_untaken, remaining=seen.sum_untaken,
                    p_best_prior=p_best_prior, mv_gap_delta=mv_gap_delta,
                    low_confidence=low_confidence, epoch=epoch,
                ))
                continue
            delta = seen.sum_untaken - old.sum_untaken
            if delta < -SIZE_EPS:
                # In-place decrease: a take, or a maker size-down; mv_gap_delta arbitrates downstream.
                events.append(self._event(
                    "fill_partial", ts_ms, game_id, bucket, order_id, seen,
                    delta_size=delta, remaining=seen.sum_untaken,
                    p_best_prior=p_best_prior, mv_gap_delta=mv_gap_delta,
                    low_confidence=low_confidence, epoch=epoch,
                ))
            elif delta > SIZE_EPS:
                events.append(self._event(
                    "resize_up", ts_ms, game_id, bucket, order_id, seen,
                    delta_size=delta, remaining=seen.sum_untaken,
                    p_best_prior=p_best_prior, mv_gap_delta=mv_gap_delta,
                    low_confidence=low_confidence, epoch=epoch,
                ))

        for order_id, old in prev.items():
            if order_id in new_map:
                continue
            if old.taken_ratio >= 1.0 - RATIO_EPS or old.sum_untaken <= SIZE_EPS:
                event = "fill_complete"
            elif mv_gap_delta is not None and mv_gap_delta > 0.0:
                event = "vanish_ambiguous"
            else:
                event = "cancel"
            events.append(self._event(
                event, ts_ms, game_id, bucket, order_id, old,
                delta_size=-old.sum_untaken, remaining=0.0,
                p_best_prior=p_best_prior, mv_gap_delta=mv_gap_delta,
                low_confidence=low_confidence, epoch=epoch,
            ))

        self._delta_sum[key] = self._delta_sum.get(key, 0.0) + sum(row["delta_size"] for row in events)
        return events

    def bucket_total(self, game_id: str, bucket: str) -> float:
        return sum(seen.sum_untaken for seen in self._ladders.get((game_id, bucket), {}).values())

    def ladder_totals(self) -> dict[tuple[str, str], float]:
        return {key: sum(seen.sum_untaken for seen in id_map.values()) for key, id_map in self._ladders.items()}

    def drift(self, eps: float = SIZE_EPS) -> dict[str, Any]:
        """Telescoping invariant: base + sum(delta_size) == tracked total, per bucket."""
        worst = 0.0
        over_eps = 0
        for key, total in self.ladder_totals().items():
            expected = self._segment_base.get(key, 0.0) + self._delta_sum.get(key, 0.0)
            gap = abs(total - expected)
            worst = max(worst, gap)
            if gap > eps:
                over_eps += 1
        return {"buckets": len(self._ladders), "worst_abs_drift": worst, "buckets_over_eps": over_eps}


def _payload_epoch(payload: Any) -> float | None:
    epoch = payload.get("epoch") if isinstance(payload, dict) else None
    return float(epoch) if isinstance(epoch, (int, float)) else None


def replay_order_events(
    records: Iterator[TapeRecord],
    stats: OrderStats | None = None,
    seed_games: list[Any] | None = None,
    tracker: OrderTracker | None = None,
) -> Iterator[dict[str, Any]]:
    """Replay a tape into enriched order-lifecycle event rows.

    Mirrors replay.replay's event routing (BookState resolves buckets and
    discovers games) but emits per-order events instead of per-key book rows.
    Pass a `tracker` to inspect final ladders / drift after the replay.
    """
    state = BookState()
    if tracker is None:
        tracker = OrderTracker(stats=stats if stats is not None else OrderStats())
    if seed_games:
        state.seed_metadata(seed_games)

    def enrich(rows: list[dict[str, Any]], game_id: str, ts_ms: int) -> Iterator[dict[str, Any]]:
        game = state.games.get(game_id)
        if game is None:
            return
        kickoff_ms = parse_ts_ms(game.get("start"))
        league = game.get("league") if isinstance(game.get("league"), str) else None
        is_open = state.is_open(game_id)
        live = kickoff_ms is not None and ts_ms >= kickoff_ms
        for row in rows:
            row["league"] = league
            row["kickoff_ms"] = kickoff_ms
            row["is_open"] = is_open
            row["live"] = live
            yield row

    for record in records:
        if record.source == "rest" and record.type == "catalogSnapshot":
            for game_id in state.apply_catalog_snapshot(record.payload, record.ts_ms):
                game = state.games[game_id]
                mv_now = state.matched_volume.get(game_id)
                for bucket in ORDERBOOK_FIELDS:
                    # Absent arrays mean "not rendered", not "emptied": skip so
                    # WS-to-WS continuity survives metadata-only replacements.
                    if not isinstance(game.get(bucket), list):
                        continue
                    rows = tracker.observe_ladder(
                        game_id, bucket, game[bucket], record.ts_ms, mv_now=mv_now, resync=True,
                    )
                    yield from enrich(rows, game_id, record.ts_ms)
            continue

        if record.source != "price" or record.type == "malformed":
            continue

        result = state.apply_price_event(record.type, record.payload, record.ts_ms)
        if result.game_id is None:
            continue
        game = state.games[result.game_id]
        mv_now = state.matched_volume.get(result.game_id)
        epoch = _payload_epoch(record.payload)
        buckets = ORDERBOOK_FIELDS if result.full_game else sorted(result.buckets)
        for bucket in buckets:
            if not isinstance(game.get(bucket), list):
                continue  # full-game payloads may omit ladders; see catalog note
            rows = tracker.observe_ladder(
                result.game_id, bucket, game[bucket], record.ts_ms,
                mv_now=mv_now, epoch=epoch, resync=result.full_game,
            )
            yield from enrich(rows, result.game_id, record.ts_ms)
