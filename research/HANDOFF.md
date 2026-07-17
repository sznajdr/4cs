# Handoff: order-events layer → hermes validation run

Written 2026-07-17, after commit `d9535e8` (order-lifecycle events layer).
Next session: run the layer against the full tape archive on hermes, validate
it, and run the fill/cancel decision test. Nothing below has run on real
multi-day data yet — everything was verified only on a 72-second local capture.

## Why this exists (one paragraph)

Working hypothesis: permanent vs. transitory price moves are distinguishable
by maker behavior — after a sweep, refill means the move reverts, pull-and-
requote means it sticks. That requires knowing whether resting size left the
book as a **fill** or a **cancel**. WS ladder entries carry stable per-order
`id`s, so this is recoverable — but `book_events` collapses ladders to depth
aggregates, so the current best IC feature (`d_depth1_a_2m`, t≈5.07, report
`reports/ic-20260717-0603.md`) blends fills and cancels, which should carry
opposite information. The new `order_events` dataset splits them.

## What was built (all in commit d9535e8)

| File | What |
|---|---|
| `fourcs/orders.py` | `OrderTracker` ladder differ + `replay_order_events` |
| `jobs/build_order_events.py` | tape → `order_events` parquet (same CLI as build_book, incl. `--bootstrap-state`) |
| `fourcs/verify.py` | `--orders` gate: telescoping + cross-path reconciliation |
| `jobs/build_features.py` | `--order-events` flag → fill/cancel/place/amb flow splits per side, at-best variants, `cancel_share_{h,a}_2m` |
| `jobs/eval_ic.py` | new feature names registered |
| `tests/test_orders.py` | 10 tests (29 total, all green) |

Verified locally: differ output (23 place / 16 cancel) exactly matched an
independent hand-rolled analysis of the same raw JSONL; telescoping drift
2e-13; cross-path totals 11/11. Full chain (build_book → build_grid →
build_features --order-events) ran end-to-end on the local capture.

Verified vendor semantics (documented in `orders.py` docstring):
- `bet == sumUntaken × (decimal − 1)` exactly — sumUntaken is takeable stake.
- `takenRatio` carries ~1e-8 float noise **including negative values** —
  epsilons everywhere (`SIZE_EPS = 0.01` currency, `RATIO_EPS = 1e-6`).
- Zero in-place decreases, zero same-id odds changes in the sample — so
  `fill_partial` and `reprice` paths exist but are empirically unexercised.

## Hermes run plan (in order, each step gates the next)

Live repo is `/home/ubuntu/4cs` (NOT 4castserver — legacy, don't touch).
Check disk first: it was 82% full on 2026-07-17; order_events adds another
parquet dataset. If tight, gzip or prune old tapes before starting.

```bash
cd /home/ubuntu/4cs && git pull
cd research && . .venv/bin/activate && pytest       # 29 tests, no data needed

# 1. Build order_events over the archive. Pre-2026-07-17 tape days have no
#    catalogSnapshots -> need --bootstrap-state or ~99% of events skip.
python jobs/build_order_events.py --state-dir ../state --out data/order_events --bootstrap-state

# 2. GATE — do not proceed if this fails:
python -m fourcs.verify --state-dir ../state --orders --bootstrap
#    Expect: telescoping buckets_over_eps == 0, worst_abs_drift ~ float noise;
#    cross_path matched == compared. If not, the differ is wrong — stop and debug.

# 3. Rebuild features with the splits (grid/targets unchanged, reuse existing):
python jobs/build_features.py --grid data/grid_1m/grid-60000ms.parquet \
    --out data/features.parquet --order-events data/order_events

# 4. Rerun IC:
python jobs/eval_ic.py --features data/features.parquet --targets data/targets.parquet --out reports
```

## Checks on the build stats (step 1 output, before trusting anything)

- `events_by_type`: what fraction of disappearances is `vanish_ambiguous`?
  If most vanishes coincide with mv movement, the cancel/fill split is
  weaker than hoped — consider tightening the mv window logic before
  interpreting IC.
- `fill_partial` count: first real data on in-place decreases. If ~0 across
  days, fills manifest only as full-order vanishes and `fill_complete` +
  `vanish_ambiguous` carry all fill information.
- `reprice` count: if nonzero, check whether same-id odds edits are real
  (affects whether cancel+place pairs should be linked as edits).
- `idless_resets` vs `resyncs`: tells whether catalogSnapshot ladders carry
  order ids (open question — local captures had no catalog records at all).
  If idless_resets ≈ one per bucket per 15 min, catalog ladders are id-less
  and each baseline truncates order tracking segments; fine, but know it.
- `epoch` column: check monotonicity per (game, bucket) with a quick duckdb
  query — decides if epoch can be used for dedup/ordering later.

## The decision test (this is the point of everything above)

From the new IC report, compare within-game IC and t for:

- `cancel_a_2m`, `cancel_h_2m`, `cancel_best_*` — maker pull
- `fill_a_2m`, `fill_h_2m`, `fill_best_*`, `amb_*` — consumption
- vs. the old aggregates `d_depth1_a_2m`, `d_untaken_a_2m`

Interpretation:
- **Splits separate** (different magnitude or opposite sign, e.g. cancels
  predict continuation, fills predict reversion): hypothesis has legs —
  next step is resilience/refill features (post-fill place rate at the same
  prob level) and thinking about horizon/labels net of costs.
- **Splits don't separate** (both ≈ the aggregate): the fill/cancel
  distinction carries no extra information here — the mechanistic story is
  wrong or invisible at 1m granularity; try the 10s grid before abandoning.
- Also check `cancel_share_*_2m` — it's the composition ratio, orthogonal
  to volume.

## Stress-tests of the EXISTING IC result (cheap, same session)

The t=5.07 on `d_depth1_a_2m → fwd_dmid_1m` predates these checks:

1. **Zero-mass**: what fraction of grid rows has `fwd_dmid_1m` exactly 0?
   If most, the IC may be "quiet stays quiet" — real correlation, no
   tradeable content. Check overall and among nonzero-feature rows.
2. **Staleness**: recompute IC excluding rows with `staleness_ms` > a few
   minutes; forward-fill can couple feature and target mechanically.
3. (Already fine: `eval_ic` t-stat is across per-game ICs, not pooled rows.)

## Known unknowns / parked

- Catalog-ladder ids (see idless_resets above).
- `mac` field on ladder entries: unknown meaning, currently ignored.
- mv update ordering vs orderUpdate ordering (mv may lag by an event;
  `mv_gap_delta` corroboration is backward-looking and approximate).
- 1x2 buckets: differ handles them (entry_side yes/no), but no 1x2 events
  existed in local captures — eyeball a few on hermes data.
- Out of scope, queued behind the decision test: closing-line efficiency
  baseline vs sharp reference; settlement/outcome capture for calibration;
  any strategy/backtest layer (QuantJourney-style gates apply at that stage,
  not now).
