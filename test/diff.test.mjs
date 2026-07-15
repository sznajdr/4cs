import test from 'node:test';
import assert from 'node:assert/strict';
import { diffPositions } from '../dist/positions/diff.js';
import { makeMatched, makeSnapshot, makeUnmatched, activeMarket } from './helpers.mjs';

test('remaining-risk decrease with matched increase emits exact partial fill', () => {
  const prev = makeSnapshot({ unmatched: [makeUnmatched({ remainingRisk: 5 })], marketStates: activeMarket() });
  const next = makeSnapshot({
    unmatched: [makeUnmatched({ remainingRisk: 3 })],
    matched: [makeMatched({ risk: 2 })],
    marketStates: activeMarket(),
  });
  const { deltas } = diffPositions(prev, next);
  const fill = deltas.find(d => d.type === 'fill');
  assert.ok(fill);
  assert.equal(fill.linkConfidence, 'exact');
  assert.equal(Math.round(fill.filledRisk * 100) / 100, 2);
  assert.equal(fill.reason, 'remaining_decreased');
});

test('remaining decrease without matched confirmation is approximate with warning', () => {
  const prev = makeSnapshot({ unmatched: [makeUnmatched({ remainingRisk: 5 })], marketStates: activeMarket() });
  const next = makeSnapshot({ unmatched: [makeUnmatched({ remainingRisk: 4 })], marketStates: activeMarket() });
  const { deltas, shapeWarnings } = diffPositions(prev, next);
  assert.equal(deltas[0].linkConfidence, 'approximate');
  assert.ok(shapeWarnings.length > 0);
});

test('disappearance with exact matched-key increase is an exact full fill', () => {
  const prev = makeSnapshot({ unmatched: [makeUnmatched()], marketStates: activeMarket() });
  const next = makeSnapshot({ matched: [makeMatched({ risk: 5 })], marketStates: activeMarket() });
  const { deltas } = diffPositions(prev, next);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].type, 'fill');
  assert.equal(deltas[0].linkConfidence, 'exact');
  assert.equal(deltas[0].reason, 'unmatched_disappeared');
});

test('disappearance during suspended market only emits suspension_suppressed', () => {
  const suspended = { 'game-1': { gameID: 'game-1', state: 'suspended', source: 'catalog', observedAt: new Date().toISOString() } };
  const prev = makeSnapshot({ unmatched: [makeUnmatched()], marketStates: suspended });
  const next = makeSnapshot({ matched: [makeMatched({ risk: 5 })], marketStates: suspended });
  const { deltas } = diffPositions(prev, next);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].type, 'exit');
  assert.equal(deltas[0].reason, 'suspension_suppressed');
});

test('disappearance during unknown market state is suppressed too', () => {
  const prev = makeSnapshot({ unmatched: [makeUnmatched({ gameID: 'game-nocat' })], marketStates: {} });
  const next = makeSnapshot({ marketStates: {} });
  const { deltas } = diffPositions(prev, next);
  assert.equal(deltas[0].reason, 'suspension_suppressed');
});

test('closed market without matched increase classifies expiry_or_closed', () => {
  const closed = { 'game-1': { gameID: 'game-1', state: 'closed', source: 'catalog', observedAt: new Date().toISOString() } };
  const prev = makeSnapshot({ unmatched: [makeUnmatched()], marketStates: closed });
  const next = makeSnapshot({ marketStates: closed });
  const { deltas } = diffPositions(prev, next);
  assert.equal(deltas[0].type, 'exit');
  assert.equal(deltas[0].reason, 'expiry_or_closed');
});

test('no-reference order matched by unique same-shape risk increase is approximate (heuristic path)', () => {
  const prev = makeSnapshot({
    unmatched: [makeUnmatched({ stableOrderKey: 'sess:s-1', sessionID: 's-1', userReference: undefined })],
    marketStates: activeMarket(),
  });
  const next = makeSnapshot({
    matched: [makeMatched({ stableOrderKey: undefined, userReference: undefined, linkConfidence: 'unlinked', risk: 5 })],
    marketStates: activeMarket(),
  });
  const { deltas } = diffPositions(prev, next);
  assert.equal(deltas[0].type, 'fill');
  assert.equal(deltas[0].linkConfidence, 'approximate');
});

test('ambiguous multi-order attribution emits no fill and a shape warning', () => {
  const prev = makeSnapshot({
    unmatched: [
      makeUnmatched({ stableOrderKey: 'sess:s-1', sessionID: 's-1', userReference: undefined }),
      makeUnmatched({ stableOrderKey: 'sess:s-2', sessionID: 's-2', userReference: undefined }),
    ],
    marketStates: activeMarket(),
  });
  const next = makeSnapshot({
    matched: [makeMatched({ stableOrderKey: undefined, userReference: undefined, linkConfidence: 'unlinked', risk: 5 })],
    marketStates: activeMarket(),
  });
  const { deltas, shapeWarnings } = diffPositions(prev, next);
  assert.equal(deltas.filter(d => d.type === 'fill').length, 0);
  assert.ok(shapeWarnings.some(w => w.includes('ambiguous')));
});

test('active-market disappearance with no matched change is manual_or_api_cancel', () => {
  const prev = makeSnapshot({ unmatched: [makeUnmatched()], marketStates: activeMarket() });
  const next = makeSnapshot({ marketStates: activeMarket() });
  const { deltas } = diffPositions(prev, next);
  assert.equal(deltas[0].type, 'exit');
  assert.equal(deltas[0].reason, 'manual_or_api_cancel');
});
