import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestAtLine,
  groupLevelsByLine,
  levelLiquidity,
  moneyline1x2Ladder,
  moneylineLadder,
} from '../dist/lib/marketLines.js';

// Synthetic over ladder: two prices at the main line (3), one alternate (3.5),
// and one defensive level missing its `total` field (→ null bucket).
const over = [
  { odds: 100, total: 3, sumUntaken: 10 },
  { odds: 105, total: 3, sumUntaken: 5 }, // better payout, less liquidity
  { odds: 150, total: 3.5, available: 20 },
  { odds: -120, total: null, volume: 7 },
];

test('groupLevelsByLine groups by line, sorts lines ascending, null bucket last', () => {
  const groups = groupLevelsByLine(over, 'total');
  assert.deepEqual(groups.map(g => g.line), [3, 3.5, null]);
});

test('best per line is the max decimal payout, not vendor order', () => {
  const groups = groupLevelsByLine(over, 'total');
  const line3 = groups.find(g => g.line === 3);
  // +105 (decimal 2.05) beats +100 (decimal 2.0) even though +100 came first.
  assert.equal(line3.best.odds, 105);
  assert.equal(line3.best.oddsDecimal, 2.05);
  // Levels within a line are sorted best-first.
  assert.deepEqual(line3.levels.map(l => l.odds), [105, 100]);
});

test('group liquidity sums untaken across the line', () => {
  const groups = groupLevelsByLine(over, 'total');
  assert.equal(groups.find(g => g.line === 3).liquidity, 15);
  assert.equal(groups.find(g => g.line === 3.5).liquidity, 20);
  assert.equal(groups.find(g => g.line === null).liquidity, 7);
});

test('levelLiquidity precedence: sumUntaken > available > volume, and 0 is honored', () => {
  assert.equal(levelLiquidity({ odds: 100, sumUntaken: 3, available: 99, volume: 50 }), 3);
  assert.equal(levelLiquidity({ odds: 100, available: 8, volume: 50 }), 8);
  assert.equal(levelLiquidity({ odds: 100, volume: 4 }), 4);
  assert.equal(levelLiquidity({ odds: 100, sumUntaken: 0, available: 9 }), 0);
  assert.equal(levelLiquidity({ odds: 100 }), 0);
});

test('groupLevelsByLine tolerates empty / undefined input', () => {
  assert.deepEqual(groupLevelsByLine([], 'total'), []);
  assert.deepEqual(groupLevelsByLine(undefined, 'spread'), []);
});

test('bestAtLine returns the best level at a line, null on miss', () => {
  assert.equal(bestAtLine(over, 3.5, 'total').odds, 150);
  assert.equal(bestAtLine(over, 3, 'total').odds, 105);
  assert.equal(bestAtLine(over, 9, 'total'), null);
  assert.equal(bestAtLine(over, null, 'total'), null);
  assert.equal(bestAtLine(over, undefined, 'total'), null);
});

test('moneylineLadder sorts best-first and caps depth', () => {
  const ml = [{ odds: -110 }, { odds: 120 }, { odds: 100 }];
  const full = moneylineLadder(ml);
  assert.deepEqual(full.map(l => l.odds), [120, 100, -110]);
  assert.deepEqual(moneylineLadder(ml, 2).map(l => l.odds), [120, 100]);
  assert.deepEqual(moneylineLadder(undefined), []);
  assert.deepEqual(moneylineLadder([]), []);
});

test('moneyline1x2Ladder preserves side, sorts best-first, and caps depth', () => {
  const levels = [
    { odds: 110, side: 'yes', sumUntaken: 4 },
    { odds: 180, side: 'no', sumUntaken: 6 },
    { odds: -120, side: 'yes', sumUntaken: 8 },
  ];
  const full = moneyline1x2Ladder(levels);
  assert.deepEqual(full.map(l => l.odds), [180, 110, -120]);
  assert.deepEqual(full.map(l => l.side), ['no', 'yes', 'yes']);
  assert.deepEqual(moneyline1x2Ladder(levels, 2).map(l => l.side), ['no', 'yes']);
  assert.deepEqual(moneyline1x2Ladder(undefined), []);
});

test('spread grouping keys off the spread field', () => {
  const away = [
    { odds: -105, spread: -1.5, sumUntaken: 4 },
    { odds: 120, spread: -2.5, sumUntaken: 6 },
  ];
  const groups = groupLevelsByLine(away, 'spread');
  assert.deepEqual(groups.map(g => g.line), [-2.5, -1.5]);
  assert.equal(groups.find(g => g.line === -1.5).best.odds, -105);
});
