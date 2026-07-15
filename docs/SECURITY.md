# Security & safety

This daemon can move real money. The defaults are conservative; understand them
before setting `LIVE=1`.

## Write guarantees

1. **`LIVE=0` is the default.** With `LIVE=0`, every `place`, `cancel`,
   `cancel-all`, `cancel-multiple`, `cancel-all-league`, `cancel-all-orders`, and
   `edit-order` returns a dry-run preview object and **nothing is sent upstream**.
2. **Live `place` requires `--confirm`.** Even with `LIVE=1`, a placement without
   `--confirm` is treated as a dry run. This is a deliberate two-key check.
3. **`MAX_BET` is enforced in the daemon**, not the CLI — it caps stake before any
   live order is submitted, so it cannot be bypassed by crafting a raw command.
4. **`edit-order` is a guarded cancel-and-replace.** It requires both
   `--confirm` and `--confirm-replace`, a fresh order lookup, and a lifecycle
   record created by this daemon. Cancellation happens before placement, so a
   failed replacement leaves the original order cancelled.
5. **Order de-duplication.** A short-window dedupe guard blocks accidental
   duplicate placements with the same shape.

## Token handling

- The token is read from the environment / `.env`; it is never written to state,
  logs, activity, or command/response files.
- With no token, the daemon reports `token_needed` and disables all account and
  trading calls.
- A rejected token (HTTP 401) flips the daemon to `token_needed` and raises a
  sticky alert until the token is updated and the daemon restarts.

## Files

- `state/`, `commands/`, and `responses/` may contain order and balance data.
  They are git-ignored. Keep them on trusted storage.
- The `commands/` mailbox is a trust boundary: anything that can write a JSON
  file there can ask the daemon to act (subject to `LIVE`/`--confirm`/`MAX_BET`).
  Restrict filesystem permissions accordingly on a shared host.
