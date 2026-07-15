# Architecture

Two processes and a file-based mailbox.

```
          ┌────────────────────────────┐        REST         ┌──────────────┐
          │        daemon.js           │  ───────────────▶   │  4casters    │
          │  PollScheduler (serialized)│  ◀───────────────   │  exchange    │
          │   catalog / balance /      │                     └──────────────┘
          │   orders / positions       │
          │                            │
          │  state/state.json  ◀───────┼── atomic snapshot every poll
          └─────────▲──────────┬───────┘
                    │          │
   commands/*.json  │          │  responses/*.json
                    │          ▼
          ┌────────────────────────────┐
          │          cli.js            │  reads state.json directly for
          │  (4caster wrapper)         │  instant, network-free queries
          └────────────────────────────┘
```

## Daemon (`src/daemon.ts`)

A single class, `FourcasterDaemon`, that:

- **Polls** the exchange through a `PollScheduler` (`src/scheduler/pollScheduler.ts`)
  that runs one exchange-facing task at a time with jittered due-times, a global
  back-off on HTTP 429, and a per-task timeout that releases the queue. Four
  tasks are registered: `catalog`, `balance`, `orders`, `positions`.
- **Persists** an atomic JSON snapshot (`state/state.json`) after every poll via
  `writeStateAtomic` (`src/state.ts`).
- **Scans** `commands/` every 250 ms for CLI-written command envelopes, executes
  them through guarded handlers, and writes a result to `responses/`.

All exchange access goes through `src/api/rest.ts` (the typed HTTP client) and
`src/api/types.ts` (the wire shapes).

## CLI (`src/cli.ts`)

- **Reads** are answered from `state/state.json` with no network round-trip
  (`status`, `list-games`, `lines`, `balance`, `orders`, `positions`, …).
- **Writes and live reads** are sent to the daemon: the CLI writes a
  `commands/<id>.json` envelope and polls `responses/<id>.json` for the result
  (`src/ipc.ts`).

## Modules

| Path | Role |
| --- | --- |
| `src/api/` | Typed 4casters REST client and wire types |
| `src/lib/` | Pure helpers: odds conversion, order formatting/validation, dedupe, market-line ladders, payout/commission math |
| `src/positions/` | Normalize vendor order/matched payloads into account positions; diff snapshots |
| `src/scheduler/` | Serialized, rate-limit-aware poll scheduler |
| `src/state.ts` | On-disk state snapshot shape + atomic read/write |
| `src/ipc.ts` | File-based command/response protocol |
| `src/env.ts` | Environment/config loading |

State is a single JSON file, rewritten atomically each poll. Restart = cold
start; the daemon rebuilds its caches from the next few polls.
