# Testing

```bash
npm test
```

`npm test` runs `npm run build` first (so tests always exercise the freshly
compiled `dist/`) and then the Node built-in test runner over `test/*.test.mjs`.

## Coverage

| File | Covers |
| --- | --- |
| `test/libs.test.mjs` | odds/price-move math, payout & commission, hedge quote, fallback references, state migration |
| `test/marketLines.test.mjs` | per-line ladder grouping and best-at-line selection |
| `test/priceMove.test.mjs` | American/decimal price-move points |
| `test/normalize.test.mjs` | normalizing vendor order/matched payloads into positions (uses `test/fixtures/vendor/`) |
| `test/diff.test.mjs` | position snapshot diffing |

Tests are pure and offline — no token or network access is required. Vendor
fixtures under `test/fixtures/vendor/` are captured real payload shapes.

## Type check

```bash
npm run check     # tsc --noEmit
```
