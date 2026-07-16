# Architecture

`4cs` has one authoritative market-state model, fed by two complementary transports.

```text
REST snapshot -> state.json <- price stream (orderbook/game/volume deltas)
      |              |
      |              +- user stream (order/fill/cancel deltas)
      |              +- tape-YYYY-MM-DD.jsonl (raw accepted events)
      |
      +- REST reconcile every 8s (catalog), plus account/positions/settlement polls

cli.js <- file IPC -> daemon.js <- guarded REST writes -> 4casters
```

## State ownership

- REST creates the initial complete catalog, orders, balance, and positions view
  before either socket opens. It remains the reconciliation authority.
- The price feed provides low-latency `orderUpdate`, `gameUpdate`, and
  `matchedVolumeUpdate` deltas. A reducer changes only fields explicitly present in
  an event, so a partial message cannot erase a REST snapshot.
- The user feed provides account-scoped order and fill events. Its `messageID` is
  persisted; reconnect replay is applied before buffered live frames to prevent a
  disconnect gap.
- `state.json` is the compact current view. The daily JSONL tape is the
  forensic/event source for diagnosing unexpected market or account transitions.

## Transport failure behaviour

Both feeds use authenticated raw WebSockets, 10-second ping / 30-second pong expiry,
and capped exponential reconnect. Malformed messages are counted, recorded on the
tape, and never mutate domain state. A stream outage is visible in `state.json.streams`;
the existing serialized, rate-limit-aware REST scheduler continues independently.

## Process boundary

The daemon atomically rewrites `state/state.json` and scans `commands/` every 250 ms.
The CLI reads local state without a network round-trip and uses command/response JSON
files for daemon-backed reads and guarded writes. All exchange HTTP access remains in
`src/api/rest.ts`; stream transport is isolated under `src/api/stream/`.
