"""In-replay book state that mirrors src/api/stream/reducer.ts exactly.

Semantics (verified against reducer.ts):
- A payload carrying a full game (id + participants, possibly nested under
  "game") replaces the whole game object -> every bucket becomes known.
- A bucket event replaces ONE whole ladder: either explicit ORDERBOOK_FIELDS
  arrays on the payload, or `sideOrders` routed via bucket/marketKey/inference
  from (type, participantID, OU/side, market).
- Bucket events for games never seen are ignored (reducer returns false);
  the game self-heals on the next full-game payload or catalogSnapshot.
- `matchedVolumeUpdate` sets a CUMULATIVE per-game matchedVolume. Negative
  deltas mean a feed epoch reset: the delta is clipped and flagged.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

ORDERBOOK_FIELDS = (
    "awayMoneylines",
    "homeMoneylines",
    "awayMoneylines1x2",
    "homeMoneylines1x2",
    "draw1x2",
    "awaySpreads",
    "homeSpreads",
    "over",
    "under",
)


def _object(value: Any) -> dict | None:
    return value if isinstance(value, dict) else None


def game_from(payload: Any) -> dict | None:
    """Mirror reducer.ts gameFrom: full game payload, possibly nested under 'game'."""
    candidate = _object(payload)
    if candidate is None:
        return None
    nested = _object(candidate.get("game"))
    game = nested if nested is not None else candidate
    if isinstance(game.get("id"), str) and isinstance(game.get("participants"), list):
        return game
    return None


def participant_ids(game: dict) -> tuple[str | None, str | None]:
    home = away = None
    for participant in game.get("participants") or []:
        if not isinstance(participant, dict):
            continue
        if participant.get("homeAway") == "home":
            home = participant.get("id")
        elif participant.get("homeAway") == "away":
            away = participant.get("id")
    return home, away


def orderbook_bucket(game: dict, data: dict) -> str | None:
    """Mirror reducer.ts orderbookBucket: map orderUpdate selection fields to a ladder."""
    event_type = data.get("type")
    participant_id = data.get("participantID")
    home, away = participant_ids(game)
    if event_type == "total":
        if data.get("OU") == "over" or data.get("side") == "over":
            return "over"
        if data.get("OU") == "under" or data.get("side") == "under":
            return "under"
        return None
    if event_type == "moneyline":
        return "homeMoneylines" if participant_id == home else "awayMoneylines" if participant_id == away else None
    if event_type == "spread":
        return "homeSpreads" if participant_id == home else "awaySpreads" if participant_id == away else None
    if event_type == "moneyline1x2":
        market = data.get("market")
        if market == "draw":
            return "draw1x2"
        return "homeMoneylines1x2" if market == home else "awayMoneylines1x2" if market == away else None
    return None


@dataclass
class ApplyResult:
    game_id: str | None = None
    buckets: set[str] = field(default_factory=set)
    full_game: bool = False
    mv_delta: float | None = None
    mv_reset: bool = False
    status_change: bool = False


@dataclass
class BookState:
    games: dict[str, dict] = field(default_factory=dict)
    bucket_updated_ms: dict[tuple[str, str], int] = field(default_factory=dict)
    matched_volume: dict[str, float] = field(default_factory=dict)

    def _absorb_game(self, game: dict, ts_ms: int) -> str:
        game_id = game["id"]
        self.games[game_id] = game
        for bucket in ORDERBOOK_FIELDS:
            self.bucket_updated_ms[(game_id, bucket)] = ts_ms
        mv = game.get("matchedVolume")
        if isinstance(mv, (int, float)):
            self.matched_volume[game_id] = float(mv)
        return game_id

    def seed_metadata(self, games: list[Any]) -> int:
        """Seed game SHELLS (id/league/start/participants only) so bucket events
        for games that never got a full-game payload can still be routed.

        No ladders, no main lines, no matchedVolume are copied — price-bearing
        state stays unknown until taped events provide it, so seeding from a
        current state.json adds no price look-ahead. Buckets stay unmarked in
        bucket_updated_ms until their first taped event.
        """
        seeded = 0
        for candidate in games:
            game = game_from(candidate)
            if game is None or game["id"] in self.games:
                continue
            self.games[game["id"]] = {
                "id": game["id"],
                "league": game.get("league"),
                "start": game.get("start"),
                "participants": game.get("participants"),
            }
            seeded += 1
        return seeded

    def apply_catalog_snapshot(self, payload: Any, ts_ms: int) -> list[str]:
        data = _object(payload)
        games = data.get("games") if data else payload
        affected: list[str] = []
        if not isinstance(games, list):
            return affected
        for candidate in games:
            game = game_from(candidate)
            if game is not None:
                affected.append(self._absorb_game(game, ts_ms))
        return affected

    def apply_price_event(self, event_type: str, payload: Any, ts_ms: int) -> ApplyResult:
        result = ApplyResult()
        data = _object(payload)
        if data is None:
            return result

        full_game = game_from(payload)
        if full_game is not None:
            was_open = self.is_open(full_game["id"]) if full_game["id"] in self.games else None
            result.game_id = self._absorb_game(full_game, ts_ms)
            result.full_game = True
            result.buckets = set(ORDERBOOK_FIELDS)
            result.status_change = was_open is not None and was_open != self.is_open(result.game_id)
            return result

        game_id = data.get("gameID")
        if not isinstance(game_id, str) or game_id not in self.games:
            return result  # reducer.ts ignores deltas for undiscovered games
        game = self.games[game_id]
        result.game_id = game_id

        for bucket in ORDERBOOK_FIELDS:
            if isinstance(data.get(bucket), list):
                game[bucket] = data[bucket]
                self.bucket_updated_ms[(game_id, bucket)] = ts_ms
                result.buckets.add(bucket)

        bucket = data.get("bucket") if isinstance(data.get("bucket"), str) else (
            data.get("marketKey") if isinstance(data.get("marketKey"), str) else orderbook_bucket(game, data)
        )
        if bucket in ORDERBOOK_FIELDS and isinstance(data.get("sideOrders"), list):
            game[bucket] = data["sideOrders"]
            self.bucket_updated_ms[(game_id, bucket)] = ts_ms
            result.buckets.add(bucket)

        if event_type == "matchedVolumeUpdate" and isinstance(data.get("matchedVolume"), (int, float)):
            new_mv = float(data["matchedVolume"])
            old_mv = self.matched_volume.get(game_id)
            game["matchedVolume"] = new_mv
            self.matched_volume[game_id] = new_mv
            if old_mv is None:
                result.mv_delta = 0.0
            elif new_mv < old_mv:
                result.mv_delta = 0.0
                result.mv_reset = True
            else:
                result.mv_delta = new_mv - old_mv
        return result

    def is_open(self, game_id: str) -> bool:
        game = self.games.get(game_id)
        if game is None:
            return False
        if game.get("messageType") == "marketClosed":
            return False
        return game.get("isOpen") is not False

    def bucket_age_ms(self, game_id: str, bucket: str, now_ms: int) -> int | None:
        updated = self.bucket_updated_ms.get((game_id, bucket))
        return None if updated is None else now_ms - updated
