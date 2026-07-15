# Troubleshooting

### `status` shows `token_needed`
`FOURCASTER_AUTH_TOKEN` is empty or was rejected. Set it in `.env` and restart
the daemon. Account reads, catalog polling, and trading stay disabled until a
valid token is configured.

### CLI hangs or times out on a write command
Writes (`place`, `cancel`, `watch`, …) are answered by the **daemon**. If the
daemon is not running, the CLI writes a `commands/*.json` envelope that is never
processed. Start the daemon (`npm start`) in another shell first. Read commands
(`status`, `list-games`, `balance`, …) work without the daemon because they read
`state/state.json` directly.

### `Game <id> is not in state yet`
`place`/`lines` look the game up in the cached catalog. Wait for the first
`catalog` poll to complete (a few seconds after the daemon starts with a valid
token), or check the game id with `list-games`.

### A `place` returned `dryRun: true`
Expected unless `LIVE=1` **and** `--confirm` are both set. The `dryRunReason`
field says which is missing (`LIVE=0` or `missing --confirm`).

### `catalogCount` stays 0
The daemon needs a valid token to poll the public catalog. Confirm the token and
watch for `catalog_failed` / `leagues_failed` alerts in `status`.

### HTTP 429 / rate limited
The scheduler backs off all polling automatically and raises a `rate_limited`
alert. Increase the `POLL_*_MS` intervals if it persists.

### Changes to `.env` had no effect
`.env` is read once at startup. Restart the daemon after editing it.

### Stale `commands/` or `responses/` files
These are a transient mailbox. It is safe to delete leftover `*.json` files there
when the daemon is stopped.
