# 4cs

A small, headless **daemon + CLI** for the [4casters](https://4casters.io)
betting exchange. It streams orderbook and account events, reconciles them over REST,
discovers leagues / games / props /
futures, reads your account (balance, orders, positions), and places, cancels,
and edits orders — nothing else. No strategies, signals, or notifications: just
a clean programmatic surface over the exchange.

- **Daemon** (`dist/daemon.js`) — a long-running process that takes a REST
  snapshot, attaches price + user WebSocket feeds, and retains serialized REST
  polling as reconciliation. It keeps an atomic JSON state snapshot and an
  append-only daily event tape on disk.
- **CLI** (`4caster` / `dist/cli.js`) — reads the state snapshot for instant,
  network-free queries and sends write commands to the daemon over a
  file-based IPC mailbox.

Node **≥ 22**, TypeScript, and the small `ws` runtime dependency (needed for
authenticated raw WebSocket handshakes).

## Quick start

```bash
git clone <your-fork-url> 4cs && cd 4cs
npm install            # dev deps only (typescript, @types/node)
npm run build          # compile to dist/
cp .env.example .env   # then set FOURCASTER_AUTH_TOKEN
npm start              # launches the daemon
```

In another shell, talk to the running daemon:

```bash
node dist/cli.js status
node dist/cli.js list-games --league MLB --limit 20
node dist/cli.js balance
```

Or install the `4caster` wrapper on your PATH via `npm link` (uses `bin/4caster`).

## Configuration

All configuration is environment variables, loaded from `.env` then `.env.local`
at startup. See [`.env.example`](.env.example) for the full list with comments.
The essentials:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FOURCASTER_AUTH_TOKEN` | — | 4casters session token. Required for any account or trading call. |
| `LIVE` | `0` | `0` = every place/cancel is a dry-run preview. `1` = real API writes. |
| `MAX_BET` | `5` | Hard stake cap enforced before any live placement. |
| `POLL_ORDERBOOK_MS` / `POLL_BALANCE_MS` / `POLL_ORDERS_MS` / `POLL_POSITIONS_MS` | `8000` / `5000` / `5000` / `30000` | Poll cadences. |
| `FOURCASTER_STREAMING` | `1` | Opens authenticated price and user feeds after a REST baseline; set `0` for REST-only operation. |
| `FOURCASTER_STREAM_LEAGUES` | active cached leagues | Optional comma-separated price-feed league filter. Watched games are always added. |

## Safety model

- **`LIVE=0` by default** — no place/cancel/edit is submitted upstream; the
  command returns a dry-run preview object instead.
- **Live `place` still requires `--confirm`** — a live write needs both `LIVE=1`
  and an explicit `--confirm` flag.
- **`MAX_BET`** is enforced by the daemon before any live placement.
- **Tokens are manual.** With no token the daemon reports `token_needed` and all
  account/trading calls are disabled.
- **`edit-order` requires two confirmations** — it cancels the existing daemon-created
  order, then submits the replacement and links both lifecycle records. If the
  replacement is rejected, the original order remains cancelled. Use `cancel` +
  `place` if you prefer explicit control.

## CLI commands

Reads (served from the local state snapshot, no network):

```
status                       daemon status, balance, alerts
leagues                      leagues present in the cached catalog
list-games [--league] [--kind standard|specials|props|futures]
           [--sport] [--parent <id>] [--live-only] [--search] [--limit] [--offset]
lines --game-id <id> [--market moneyline|spread|total|moneyline1x2|all] [--depth 5]
watched                      games you are actively watching
balance                      cached balance snapshot
orders [--game-id <id>]      cached orders per watched game
positions                    normalized account positions (cached)
exposure                     open risk, day-open balance, drawdown (cached)
activity [--tail 20] [--date YYYY-MM-DD]
```

Live account reads (daemon issues a fresh REST call):

```
unmatched                    open unmatched orders
matched                      matched bets
by-reference --user-reference <ref> [--game-id <id>]
pnl [--from MM-DD-YYYY] [--to MM-DD-YYYY]
lookup --order-id <id>
bet --id <id> | --tx-id <id>
wager-request --id <wagerRequestID>
liability --game-id <id>
participants [--active]
discover-games --league <LEAGUE|upcoming> [--sport <sport>]
average-price --league <LEAGUE>
single-orderbook --game-id <id>
affiliate-commission [--from MM-DD-YYYY] [--to MM-DD-YYYY]
settlement-journal [--tail 20]
```

Writes (routed to the daemon; dry-run unless LIVE=1 [+ --confirm for place]):

```
watch   --game-id <id>       start polling a game's orders
unwatch --game-id <id>
place   --game-id <id> --market moneyline|spread|total --side home|away|over|under
        --odds <american|decimal> --bet <amount> [--number <line>]
        [--expires-in <minutes>] [--order-type limit|post|postArb|fillAndKill] [--confirm]
place   --game-id <id> --market moneyline1x2 --side yes|no --outcome draw|home|away ...
cancel  --session-id <id>
cancel-all --game-id <id> [--type moneyline|spread|total|moneyline1x2]
cancel-multiple --session-ids <id,id,id>
cancel-ref --game-id <id> --user-references <ref,ref>
cancel-all-league --league <LEAGUE>
cancel-all-orders
edit-order --session-id <id> --odds <american|decimal> --bet <amount> --confirm --confirm-replace
```

`edit-order` is deliberately two-confirmation. It uses a fresh lookup, then cancel +
place, and links both lifecycle records. The cancellation happens before the replacement;
if placement fails, the original order stays cancelled. For a partial fill, the
replacement volume is the full new stake, not the remaining volume.

The account-wide heartbeat is enabled only when `LIVE=1` and
`FOURCASTER_HEARTBEAT_SEC` is set to a value greater than five.

The market path is `REST snapshot -> subscribe stream -> apply event -> REST reconcile`.
The eight-second orderbook cadence remains the source-of-truth reconciliation interval;
it is not removed when streaming is active. Daily `state/tape-YYYY-MM-DD.jsonl` files
retain the raw market and user events, while `state.json.streams` exposes connection,
reconnect, malformed-event, replay, and tape health. Settlement accounting is a
separate hourly exchange-backed journal (`POLL_SETTLEMENT_MS`).

Run `node dist/cli.js --help` for the authoritative list. See
[`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md) for details and odds format
(`|v| >= 100` is American, `1 < v < 100` is decimal; the API is always sent
American).

## Running as a service

The daemon is a plain Node process, so any supervisor works
(`node dist/daemon.js`, pm2, Docker, systemd, …). A generic systemd unit
template is in [`systemd/4caster-daemon.service.example`](systemd/4caster-daemon.service.example) —
replace the `<INSTALL_DIR>` / `<USER>` placeholders.

## Tests

```bash
npm test     # builds, then runs the node:test suite
```

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the daemon, CLI, and IPC fit together
- [`docs/CLI_REFERENCE.md`](docs/CLI_REFERENCE.md) — every command in detail
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — all environment variables
- [`docs/SECURITY.md`](docs/SECURITY.md) — the safety guarantees
- [`docs/TESTING.md`](docs/TESTING.md) / [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
