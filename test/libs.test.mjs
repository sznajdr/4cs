import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceMovePoints, isBetterPrice, bestPriceFor } from '../dist/lib/priceMove.js';
import { netWin, isMakerOrderType, toWin } from '../dist/lib/payout.js';
import { hedgeQuote } from '../dist/lib/hedge.js';
import { makeFallbackReference } from '../dist/lib/orderDedupe.js';
import { readStateSync, defaultState } from '../dist/state.js';
import { makeGame } from './helpers.mjs';

test('priceMovePoints: positive odds are exact American points, continuous across the boundary', () => {
  assert.equal(Math.round(priceMovePoints(120, 150)), 30);
  assert.equal(Math.round(priceMovePoints(150, 120)), -30);
  // -140 -> +150: decimal 1.714 -> 2.5 = ~78.6 points better
  assert.ok(priceMovePoints(-140, 150) > 70);
  // negative odds move: -110 -> -120 is worse for the bettor
  assert.ok(priceMovePoints(-110, -120) < 0);
  assert.ok(isBetterPrice(-105, -110));
  assert.ok(isBetterPrice(150, 140));
  assert.ok(!isBetterPrice(-120, 110));
});

test('bestPriceFor resolves each market and refuses cross-line comparisons', () => {
  const game = makeGame();
  assert.equal(bestPriceFor(game, { market: 'moneyline', side: 'away' }).odds, 120);
  assert.equal(bestPriceFor(game, { market: 'total', side: 'over', number: 8.5 }).odds, -105);
  assert.equal(bestPriceFor(game, { market: 'total', side: 'over', number: 9.5 }), null);
  assert.equal(bestPriceFor(game, { market: 'spread', side: 'home', number: -1.5 }).odds, -110);
  assert.equal(bestPriceFor(game, { market: 'spread', side: 'home', number: -3.5 }), null);
  const g1x2 = makeGame({ draw1x2: [{ odds: 310 }], homeMoneylines1x2: [{ odds: -120 }] });
  assert.equal(bestPriceFor(g1x2, { market: 'moneyline1x2', outcome: 'draw' }).odds, 310);
  assert.equal(bestPriceFor(g1x2, { market: 'moneyline1x2', outcome: 'part-home' }).odds, -120);
});

test('netWin: commission only on taker order types (verified rate 0.01)', () => {
  assert.equal(toWin(5, 140), 7);
  assert.equal(Math.round(netWin(5, 140, 'fillAndKill', 0.01) * 100) / 100, 6.93);
  assert.equal(Math.round(netWin(5, 140, 'limit', 0.01) * 100) / 100, 6.93);
  assert.equal(netWin(5, 140, 'post', 0.01), 7);
  assert.equal(netWin(5, 140, 'postArb', 0.01), 7);
  assert.ok(isMakerOrderType('postArb'));
  assert.ok(!isMakerOrderType('fillAndKill'));
});

test('hedgeQuote equalizes net profit; maker beats taker; degenerate inputs return null', () => {
  const taker = hedgeQuote({ entryRisk: 5, entryNetWin: 7.43, opposingAmerican: 130, hedgeCommissionRate: 0.01 });
  const maker = hedgeQuote({ entryRisk: 5, entryNetWin: 7.43, opposingAmerican: 130, hedgeCommissionRate: 0 });
  assert.ok(taker.lockedProfit > 0);
  assert.ok(maker.lockedProfit > taker.lockedProfit);
  // equalization check (taker variant): entry wins vs hedge wins within a cent
  const profitIfEntryWins = 7.43 - taker.hedgeRisk;
  const profitIfHedgeWins = taker.hedgeRisk * 1.3 * 0.99 - 5;
  assert.ok(Math.abs(profitIfEntryWins - profitIfHedgeWins) < 0.02);
  assert.equal(hedgeQuote({ entryRisk: 0, entryNetWin: 1, opposingAmerican: 130, hedgeCommissionRate: 0 }), null);
});

test('fallback reference uses the deterministic 4c- prefix', () => {
  const ref = makeFallbackReference(1700000000000);
  assert.ok(/^4c-1700000000000-[a-z0-9]+$/.test(ref));
});

test('legacy v1 state loads with defaults for new fields (migration)', () => {
  const dir = mkdtempSync(join(tmpdir(), '4c-state-'));
  try {
    const legacy = {
      version: 1, status: 'running', updatedAt: new Date().toISOString(),
      catalog: { games: [], failedLeagues: [] }, watchList: ['g1'], ordersByGame: {},
      balance: null, activity: [], alerts: [],
      config: { live: true, maxBet: 5, pollBalanceMs: 1, pollOrderbookMs: 1, pollOrdersMs: 1, baseUrl: 'x', tokenConfigured: true },
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(legacy), 'utf8');
    const config = { ...defaultConfigForDir(dir) };
    const state = readStateSync(config);
    assert.deepEqual(state.runtimeCaches.pendingSuggestions, {});
    assert.equal(state.positions, null);
    assert.equal(state.dayOpenBalance, null);
    assert.deepEqual(state.watchList, ['g1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function defaultConfigForDir(dir) {
  const base = defaultState; // just to reference; build a minimal RuntimeConfig
  void base;
  return {
    root: dir, baseUrl: 'https://example.invalid', authToken: '', live: false, debug: false,
    maxBet: 5, pollBalanceMs: 5000, pollOrderbookMs: 8000, pollOrdersMs: 5000,
    stateDir: dir, commandsDir: join(dir, 'commands'), responsesDir: join(dir, 'responses'),
    pollPositionsMs: 30000, hedgeProfitBuffer: 0.25, commissionTakerRate: 0.01,
  };
}
