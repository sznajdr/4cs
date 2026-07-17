"""Explode a game's ladders into keyed two-sided books.

One vendor ladder array mixes multiple lines (each OddsLevel carries its own
`spread`/`total`); levels must be grouped by line before pairing sides — the
same rule src/lib/marketLines.ts applies ("never trust levels[0]").

Keys and side conventions (side "h" is the side whose prob space we quote):
  moneyline   line=None   h=home ladder,        a=away ladder
  spread      line=home spread (e.g. -1.5); away side pairs at -line
  total       line=total;  h=over,              a=under
  1x2_home / 1x2_away / 1x2_draw   line=None; h=side "yes", a=side "no"

Best takeable price on an exchange ladder = max decimal payout = MIN implied
prob (matches marketLines.ts best-by-decimal-payout).
"""

from __future__ import annotations

from dataclasses import dataclass

from .book import ORDERBOOK_FIELDS
from .probs import american_to_prob

BUCKET_MARKETS = {
    "homeMoneylines": ("moneyline",),
    "awayMoneylines": ("moneyline",),
    "homeSpreads": ("spread",),
    "awaySpreads": ("spread",),
    "over": ("total",),
    "under": ("total",),
    "homeMoneylines1x2": ("1x2_home",),
    "awayMoneylines1x2": ("1x2_away",),
    "draw1x2": ("1x2_draw",),
}

ONE_X_TWO_BUCKET = {
    "1x2_home": "homeMoneylines1x2",
    "1x2_away": "awayMoneylines1x2",
    "1x2_draw": "draw1x2",
}


@dataclass(frozen=True)
class SideSummary:
    p_best: float | None
    depth1: float
    depth3: float
    untaken: float
    n_levels: int


EMPTY_SIDE = SideSummary(p_best=None, depth1=0.0, depth3=0.0, untaken=0.0, n_levels=0)


def level_size(level: dict) -> float:
    for key in ("sumUntaken", "available"):
        value = level.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    return 0.0


def _line_of(level: dict, field: str) -> float | None:
    value = level.get(field)
    return round(float(value), 2) if isinstance(value, (int, float)) else None


def summarize_side(levels: list[dict]) -> SideSummary:
    """Summarize one side's ladder: best-takeable prob and depth near best."""
    priced = []
    for level in levels:
        if not isinstance(level, dict):
            continue
        p = american_to_prob(level.get("odds"))
        if p is None:
            continue
        priced.append((p, level_size(level)))
    takeable = sorted((entry for entry in priced if entry[1] > 0), key=lambda entry: entry[0])
    if not takeable:
        return SideSummary(p_best=None, depth1=0.0, depth3=0.0, untaken=0.0, n_levels=len(priced))
    return SideSummary(
        p_best=takeable[0][0],
        depth1=takeable[0][1],
        depth3=sum(size for _, size in takeable[:3]),
        untaken=sum(size for _, size in takeable),
        n_levels=len(takeable),
    )


def _ladder(game: dict, bucket: str) -> list[dict]:
    value = game.get(bucket)
    return [level for level in value if isinstance(level, dict)] if isinstance(value, list) else []


def _group_by_line(levels: list[dict], field: str) -> dict[float, list[dict]]:
    grouped: dict[float, list[dict]] = {}
    for level in levels:
        line = _line_of(level, field)
        if line is None:
            continue
        grouped.setdefault(line, []).append(level)
    return grouped


def game_key_books(game: dict, markets: set[str] | None = None) -> dict[tuple[str, float | None], tuple[SideSummary, SideSummary]]:
    """All (market, line) -> (side_h, side_a) books for a game.

    `markets` restricts output to the given market names (used to emit rows
    only for the buckets an event touched).
    """
    books: dict[tuple[str, float | None], tuple[SideSummary, SideSummary]] = {}

    def wanted(market: str) -> bool:
        return markets is None or market in markets

    if wanted("moneyline"):
        home, away = _ladder(game, "homeMoneylines"), _ladder(game, "awayMoneylines")
        if home or away:
            books[("moneyline", None)] = (summarize_side(home), summarize_side(away))

    if wanted("spread"):
        home_lines = _group_by_line(_ladder(game, "homeSpreads"), "spread")
        away_lines = _group_by_line(_ladder(game, "awaySpreads"), "spread")
        for line in sorted(set(home_lines) | {-l for l in away_lines}):
            side_h = summarize_side(home_lines.get(line, []))
            side_a = summarize_side(away_lines.get(round(-line, 2), []))
            books[("spread", line)] = (side_h, side_a)

    if wanted("total"):
        over_lines = _group_by_line(_ladder(game, "over"), "total")
        under_lines = _group_by_line(_ladder(game, "under"), "total")
        for line in sorted(set(over_lines) | set(under_lines)):
            books[("total", line)] = (
                summarize_side(over_lines.get(line, [])),
                summarize_side(under_lines.get(line, [])),
            )

    for market, bucket in ONE_X_TWO_BUCKET.items():
        if not wanted(market):
            continue
        ladder = _ladder(game, bucket)
        if not ladder:
            continue
        yes = [level for level in ladder if level.get("side") == "yes"]
        no = [level for level in ladder if level.get("side") == "no"]
        books[(market, None)] = (summarize_side(yes), summarize_side(no))

    return books


def markets_for_buckets(buckets: set[str]) -> set[str]:
    markets: set[str] = set()
    for bucket in buckets:
        if bucket in ORDERBOOK_FIELDS:
            markets.update(BUCKET_MARKETS.get(bucket, ()))
    return markets


def market_bucket_pair(market: str) -> tuple[str, str]:
    """The (h-side bucket, a-side bucket) whose ages bound a key's staleness."""
    if market == "moneyline":
        return "homeMoneylines", "awayMoneylines"
    if market == "spread":
        return "homeSpreads", "awaySpreads"
    if market == "total":
        return "over", "under"
    bucket = ONE_X_TWO_BUCKET[market]
    return bucket, bucket
