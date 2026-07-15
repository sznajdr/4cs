# Phase 0 — Vendor payload findings (captured live from Hermes, 2026-07-02)

Raw captures (`*-raw.json`, local only, may contain account identifiers) were taken
via `ssh hermes "node dist/cli.js unmatched|matched|orders|status"`. Sanitized
fixtures in this directory preserve the exact shapes.

## Unmatched (resting) order — session object

From `/user/getOrdersForGame` `data.unmatched[]`; account-wide `/user/getUnmatched`
returns `data.unmatched[]` with the same session-object shape (empty at capture
time — no resting orders were open).

| Automation concept | Vendor field | Notes |
|---|---|---|
| sessionID | `id` | The id `cancel --session-id` takes. `txID`/`wagerRequestID` also present. |
| exchange creation time | `createdAt` | ISO string. **Present** → order age can use exchange time. |
| offeredRisk | `offered` | number |
| filledRisk | `filled` | number |
| remainingRisk | `remaining` | number |
| userReference | `userReference` | **Echoed** → reference-based stitching is enabled, fill automation is not degraded. |
| gameID / league / market | `game.id` / `game.league` / `type` | `type` ∈ moneyline/spread/total/moneyline1x2 |
| line | `spread` / `total` | null for moneyline |
| side/outcome | `participantID` vs `game.participants[].homeAway` | `otherParticipantID` gives the opposing participant. |

## Matched bet

From `/user/getMatchedBets` → `data.matchedBets[]`.

| Automation concept | Vendor field | Notes |
|---|---|---|
| txID | `txID` | matched-fill identity; `id` also present |
| matchedAt | `matchedTime` | ISO string |
| risk | `risk` | **STRING** (e.g. `"5.05"`) — parse tolerantly |
| net win | `win` | **STRING**, already net of taker commission |
| userReference | `userReference` | echoed |
| odds | `odds` | American integer |

## Commission verification

- bet 5 @ +140 → gross win 7.00, observed `win: "6.93"` = 7.00 × **0.99**
- bet 5 @ +141 → gross win 7.05, observed `win: "6.98"` = 7.05 × **0.99**

**`COMMISSION_TAKER_RATE = 0.01` is verified** for taker (`origin: "wager"`) fills.
Observed `risk: "5.05"` = bet 5 × 1.01 — the taker's risk also carries a 1%
uplift. For hedge math we use net win = gross × (1 − rate) per the plan; the
risk uplift is documented here as an open question (single account tier tested).

## Market state evidence

Catalog games carry `isOpen` (bool), `ended` (bool), `messageType`
('marketOpen'|'marketClosed' on WS payloads). No per-order suspension flag was
observed; market state must come from the catalog snapshot.

## Not yet captured (no live opportunity at capture time)

- Partial fill with remaining unmatched stake / changed session ID → session-churn
  stitching is covered by synthetic fixtures in `test/fixtures/signals/`; treat
  `linkConfidence: 'heuristic'` results conservatively until observed live.
- Suspended market with resting orders affected.
- Manual/website position without a `4c-`/`cli-` reference (exposure math must
  include them regardless — normalizers never filter by reference).
