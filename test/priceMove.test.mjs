import test from 'node:test';
import assert from 'node:assert/strict';
import { bestPriceFor } from '../dist/lib/priceMove.js';
import { makeGame } from './helpers.mjs';

test('bestPriceFor selects the requested 1x2 side instead of the best opposite-side payout', () => {
  const game = makeGame({
    draw1x2: [
      { odds: 110, side: 'yes', market: 'draw', sumUntaken: 10 },
      { odds: 250, side: 'no', market: 'draw', sumUntaken: 10 },
    ],
    homeMoneylines1x2: [
      { odds: -140, side: 'yes', market: 'part-home', sumUntaken: 10 },
      { odds: 190, side: 'no', market: 'part-home', sumUntaken: 10 },
    ],
  });

  assert.equal(bestPriceFor(game, { market: 'moneyline1x2', side: 'yes', outcome: 'draw' }).odds, 110);
  assert.equal(bestPriceFor(game, { market: 'moneyline1x2', side: 'no', outcome: 'draw' }).odds, 250);
  assert.equal(bestPriceFor(game, { market: 'moneyline1x2', side: 'yes', outcome: 'part-home' }).odds, -140);
  assert.equal(bestPriceFor(game, { market: 'moneyline1x2', side: 'no', outcome: 'part-home' }).odds, 190);
});

test('bestPriceFor falls back for legacy side-less 1x2 payloads and suppresses missing side matches', () => {
  const legacy = makeGame({ draw1x2: [{ odds: 310 }, { odds: 250 }] });
  assert.equal(bestPriceFor(legacy, { market: 'moneyline1x2', outcome: 'draw' }).odds, 310);
  assert.equal(bestPriceFor(legacy, { market: 'moneyline1x2', side: 'yes', outcome: 'draw' }).odds, 310);

  const noOnly = makeGame({ draw1x2: [{ odds: 180, side: 'no', market: 'draw' }] });
  assert.equal(bestPriceFor(noOnly, { market: 'moneyline1x2', side: 'yes', outcome: 'draw' }), null);
});
