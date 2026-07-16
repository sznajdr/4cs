import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPriceEvent, applyUserEvent, compareStreamID, isUserStreamMessage } from '../dist/api/stream/reducer.js';
import { matchesSubscription } from '../dist/api/stream/priceFeed.js';
import { makeGame } from './helpers.mjs';

function cache() {
  return { unmatched: [], matched: [], stale: false, consecutiveErrorCount: 0 };
}

test('price reducer replaces complete game snapshots and only patches explicit depth fields', () => {
  const original = makeGame({ id: 'game-stream', awayMoneylines: [{ odds: 120, bet: 2 }] });
  const catalog = { games: [original] };
  assert.equal(applyPriceEvent(catalog, 'orderUpdate', {
    gameID: 'game-stream', awayMoneylines: [{ odds: 130, bet: 4 }],
  }), true);
  assert.deepEqual(catalog.games[0].awayMoneylines, [{ odds: 130, bet: 4 }]);
  assert.deepEqual(catalog.games[0].homeMoneylines, original.homeMoneylines);

  assert.equal(applyPriceEvent(catalog, 'orderUpdate', {
    gameID: 'game-stream', type: 'total', side: 'under', total: 8.5, sideOrders: [{ odds: -101, total: 8.5 }],
  }), true);
  assert.deepEqual(catalog.games[0].under, [{ odds: -101, total: 8.5 }]);

  assert.equal(applyPriceEvent(catalog, 'matchedVolumeUpdate', { gameID: 'game-stream', matchedVolume: 42 }), true);
  assert.equal(catalog.games[0].matchedVolume, 42);
  assert.equal(applyPriceEvent(catalog, 'orderUpdate', { gameID: 'unknown', awayMoneylines: [] }), false);
});

test('user reducer handles placed, partial-fill, and cancellation transitions without duplicate fills', () => {
  const orders = cache();
  const placed = {
    messageID: '100-0', gameID: 'game-1', unmatched: {
      orderID: 'order-1', wagerRequestID: 'request-1', offered: 10, remaining: 10, filled: 0,
      type: 'moneyline', side: 'team-1', odds: -110,
    }, matched: null,
  };
  assert.ok(isUserStreamMessage(placed));
  assert.equal(applyUserEvent(orders, placed), 'placed');
  assert.equal(orders.unmatched.length, 1);

  const partial = {
    ...placed, messageID: '101-0', unmatched: { ...placed.unmatched, filled: 3, remaining: 7 },
    matched: { txID: 'tx-1', amount: 3, risk: 3, type: 'moneyline', side: 'team-1', odds: -110 },
  };
  assert.equal(applyUserEvent(orders, partial), 'partial');
  assert.equal(orders.unmatched[0].remaining, 7);
  assert.equal(orders.matched.length, 1);
  applyUserEvent(orders, partial);
  assert.equal(orders.matched.length, 1);

  const cancelled = { ...placed, messageID: '102-0', unmatched: { ...placed.unmatched, offered: 0, remaining: 0 } };
  assert.equal(applyUserEvent(orders, cancelled), 'cancelled');
  assert.equal(orders.unmatched.length, 0);
});

test('Redis stream ids compare numerically, not lexicographically', () => {
  assert.ok(compareStreamID('100-10', '100-2') > 0);
  assert.ok(compareStreamID('101-0', '100-999') > 0);
  assert.ok(compareStreamID('100-0', '100-0') === 0);
});

test('price feed rejects pre-subscription firehose frames outside its local scope', () => {
  const subscription = { gameIDs: ['parent-1'], leagueIDs: ['ATP', 'WTA'] };
  assert.equal(matchesSubscription(['orderUpdate', { gameID: 'game-1', parentGameID: 'parent-1', league: 'MLB', sport: 'baseball' }], subscription), true);
  assert.equal(matchesSubscription(['orderUpdate', { gameID: 'game-2', league: 'ATP', sport: 'tennis' }], subscription), true);
  assert.equal(matchesSubscription(['orderUpdate', { gameID: 'game-3', league: 'MLB', sport: 'baseball' }], subscription), false);
});
