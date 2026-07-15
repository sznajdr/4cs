# CLI reference

Invoke as `node dist/cli.js <command>` (or `4caster <command>` via the wrapper).
Every command prints a single JSON object to stdout. Read commands are served
from the on-disk state snapshot; write and live-read commands are routed to the
running daemon over the file mailbox.

## Odds format

Wherever `--odds` is accepted, the value is interpreted as:

- **American** when `|value| >= 100` (e.g. `-110`, `150`)
- **Decimal** when `1 < value < 100` (e.g. `1.66`, `2.5`)

Odds are always converted to American before being sent to the exchange.

## Game kinds

`list-games --kind` classifies catalog games:

| Kind | Meaning |
| --- | --- |
| `standard` | normal two-way / three-way game |
| `props` | a specials game that is a child of a standard game (`parentGameID` set) |
| `futures` | a specials game with a tournament and no parent (outrights) |
| `specials` | any other specials game |

## Order types

`--order-type`: `limit` (default), `post`, `postArb`, `fillAndKill`. `post` /
`postArb` are maker types (no taker commission); `fillAndKill` is a taker.

---

## Reads (no network)

### `status`
Daemon status, last update, catalog count, watched count, balance, recent alerts.

### `leagues`
Leagues present in the cached catalog, with per-league sport and game count.

### `list-games [flags]`
Filter the cached catalog.
Flags: `--league <L>`, `--kind standard|specials|props|futures`, `--sport <s>`,
`--parent <parentGameID>`, `--live-only`, `--search <text>`, `--limit <n>` (default 50),
`--offset <n>`. Each game is summarized with best prices, main lines, and the
distinct alternate lines available.

### `lines --game-id <id> [--market ...] [--depth 5]`
Full per-line ladder with liquidity for a single game, flagging the main line.
`--market` one of `moneyline|spread|total|moneyline1x2|all` (default `all`).
`liquidity` = untaken \$ available to take at that price.

### `watched`
Games currently on the daemon's watch list, summarized.

### `balance`
Cached balance snapshot and recent alerts.

### `orders [--game-id <id>]`
Cached unmatched/matched orders, per watched game (or a single game).

### `positions`
Normalized account positions (from the positions poll) and shape warnings.

### `exposure`
Open unmatched risk, matched downside, total open risk, balance, day-open
balance, and drawdown — all from cached state.

### `activity [--tail 20] [--date YYYY-MM-DD]`
Recent daemon activity log entries.

---

## Live reads (daemon issues a fresh REST call)

### `unmatched`
Open unmatched orders straight from the exchange.

### `matched`
Matched bets straight from the exchange.

### `by-reference --user-reference <ref> [--game-id <id>]`
Look up all unmatched, matched, and graded records tied to a client reference.

### `pnl [--from MM-DD-YYYY] [--to MM-DD-YYYY]`
Return exchange-calculated settled-wager P&L and volume for the requested game-start date range.

### `settlement-journal [--tail 20]`
Read cached, exchange-backed settlement snapshots. The daemon polls the prior two
UTC game-start dates at `POLL_SETTLEMENT_MS` (one hour by default) and retains a
bounded append-only journal. It never infers realized P&L from balance changes.

### `lookup --order-id <id>` / `bet --id <id> | --tx-id <id>` / `wager-request --id <id>`
Read the current order state, one individual bet, or all resulting records from one placement request.

### `participants [--active]`, `discover-games --league <LEAGUE|upcoming>`, `average-price --league <LEAGUE>`, `single-orderbook --game-id <id>`
Direct market discovery reads. `participants` also refreshes its persisted optional
participant cache with the normal freshness metadata. None alters the cached
eight-second orderbook cadence.

### `affiliate-commission [--from MM-DD-YYYY] [--to MM-DD-YYYY]`
Read referral commission for the selected date range.

### `liability --game-id <id>`
Current liability for a game.

---

## Writes (dry-run unless `LIVE=1`; `place` also needs `--confirm`)

### `watch --game-id <id>` / `unwatch --game-id <id>`
Add/remove a game from the order-polling watch list.

### `place`
Two-way markets:
```
place --game-id <id> --market moneyline|spread|total --side home|away|over|under \
      --odds <american|decimal> --bet <amount> [--number <line>] \
      [--expires-in <minutes>] [--order-type limit|post|postArb|fillAndKill] [--confirm]
```
Three-way (1x2):
```
place --game-id <id> --market moneyline1x2 --side yes|no --outcome draw|home|away \
      --odds <american|decimal> --bet <amount> [--order-type limit|post|fillAndKill] [--confirm]
```
Props are `--market total` on a `--kind props` game; outrights are
`--market moneyline` on a `--kind futures` game. `--number`/`--line` selects an
alternate line; omit for the main line.

### `cancel --session-id <id>`
Cancel one resting order.

### `cancel-all --game-id <id> [--type moneyline|spread|total|moneyline1x2]`
Cancel all orders for a game (optionally one market type).

### `cancel-multiple --session-ids <id,id,id>`
Cancel a comma-separated list of orders.

### `cancel-ref --game-id <id> --user-references <ref,ref>`
Cancel open orders for a game using the client references assigned at placement.

### `cancel-all-league --league <LEAGUE>`
Cancel every order across a league.

### `cancel-all-orders`
Cancel every open order on the account.

### `edit-order --session-id <id> --odds <american|decimal> --bet <amount> --confirm --confirm-replace`
Replaces a daemon-created resting order through the established cancel and place
endpoints. The daemon first does a fresh lookup, then requires two confirmations before
the cancellation. Cancellation happens before placement, so a failed replacement leaves
the original order cancelled. It records both generations as linked lifecycle records;
partial-fill volume requires particular care.

---

## Exit codes

Write and live-read commands set exit code `1` when the daemon response has
`ok: false`, else `0`. Read commands print `{ ok: false, error, ... }` and exit
`1` on a usage error.
