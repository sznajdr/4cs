"""Odds conversions and probability-space book math.

Wire odds are American (see src/lib/odds.ts). All modeling happens in implied
probability space: p = 1/decimal. American odds are discontinuous at +/-100 and
decimal odds are payout-nonlinear, so neither is a usable coordinate for
measuring movement.

Two-sided book convention (home-prob space):
  backing home at prob p_h  = buying home-prob at p_h            -> ask = p_h
  backing away at prob p_a  = selling home-prob at 1 - p_a       -> bid = 1 - p_a
  mid       = (p_h + 1 - p_a) / 2
  overround = p_h + p_a - 1        (two-sided spread == vig; >0 in a sane book)
"""

from __future__ import annotations

import math


def american_to_decimal(odds: float) -> float | None:
    """Mirror of src/lib/odds.ts americanToDecimal. None for invalid values."""
    if odds is None or not isinstance(odds, (int, float)) or math.isnan(odds):
        return None
    if odds >= 100:
        return 1.0 + odds / 100.0
    if odds <= -100:
        return 1.0 + 100.0 / -odds
    return None


def american_to_prob(odds: float) -> float | None:
    decimal = american_to_decimal(odds)
    return None if decimal is None else 1.0 / decimal


def pair_mid(p_h: float | None, p_a: float | None) -> float | None:
    if p_h is None or p_a is None:
        return None
    return (p_h + 1.0 - p_a) / 2.0


def pair_overround(p_h: float | None, p_a: float | None) -> float | None:
    if p_h is None or p_a is None:
        return None
    return p_h + p_a - 1.0


def devig_proportional(probs: list[float]) -> list[float]:
    total = sum(probs)
    if total <= 0:
        return probs
    return [p / total for p in probs]


def devig_power(probs: list[float], tol: float = 1e-10, max_iter: int = 200) -> list[float]:
    """Power method: find k such that sum(p_i^k) == 1; favourite-longshot aware."""
    if any(p <= 0 or p >= 1 for p in probs):
        return devig_proportional(probs)
    lo, hi = 1e-3, 1e3
    for _ in range(max_iter):
        k = (lo + hi) / 2.0
        total = sum(p**k for p in probs)
        if abs(total - 1.0) < tol:
            break
        # sum(p^k) is decreasing in k for p in (0,1)
        if total > 1.0:
            lo = k
        else:
            hi = k
    k = (lo + hi) / 2.0
    return [p**k for p in probs]
