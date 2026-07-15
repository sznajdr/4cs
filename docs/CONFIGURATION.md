# Configuration

All configuration is via environment variables, loaded at startup from `.env`
then `.env.local` in the project root (existing process env always wins). See
[`.env.example`](../.env.example) for a ready-to-copy template.

## Authentication

| Variable | Aliases | Default | Meaning |
| --- | --- | --- | --- |
| `FOURCASTER_AUTH_TOKEN` | `4CASTER_AUTH_TOKEN`, `VITE_AUTH_TOKEN` | `""` | 4casters session token. Required for account reads, catalog polling, and trading. The daemon reports `token_needed` until it is set. |
| `FOURCASTER_AUTH_SCHEME` | — | `bearer` | Authorization scheme. |
| `FOURCASTER_API_BASE_URL` | `4CASTER_API_BASE_URL` | `https://api.4casters.io` | Exchange base URL. |

## Safety

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIVE` | `0` | `0` = place/cancel/edit return a dry-run preview and never hit the exchange. `1` = real writes. |
| `MAX_BET` | `5` | Hard stake cap enforced before any live placement. |
| `DEBUG` | unset | Set to any value for verbose logging. |
| `FOURCASTER_HEARTBEAT_SEC` | `0` | Opt-in account-wide dead-man switch. Must be >5 and requires `LIVE=1`; if daemon heartbeats stop before the timeout expires, the exchange cancels every open order on the account. |

## Runtime directories

Relative paths resolve against the project root.

| Variable | Aliases | Default |
| --- | --- | --- |
| `FOURCASTER_STATE_DIR` | `4CASTER_STATE_DIR` | `./state` |
| `FOURCASTER_COMMANDS_DIR` | `4CASTER_COMMANDS_DIR` | `./commands` |
| `FOURCASTER_RESPONSES_DIR` | `4CASTER_RESPONSES_DIR` | `./responses` |

## Poll intervals (milliseconds)

| Variable | Default |
| --- | --- |
| `POLL_ORDERBOOK_MS` | `8000` |
| `POLL_BALANCE_MS` | `5000` |
| `POLL_ORDERS_MS` | `5000` |
| `POLL_POSITIONS_MS` | `30000` |
| `POLL_SETTLEMENT_MS` | `3600000` | Exchange-backed settled-wager/P&L snapshot interval (one hour); separate from orderbook polling. |

## Fees (optional, local math only)

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMISSION_TAKER_RATE` | `0.01` | Taker commission as a fraction of winnings, used by `exposure` math. Maker/post orders pay none. Does not change what is sent to the exchange. |
| `HEDGE_PROFIT_BUFFER` | `0.25` | Reserved buffer used by the hedge-quote helper. |

Changing `.env` requires a daemon restart to take effect.
