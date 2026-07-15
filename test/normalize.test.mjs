import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildPositionsSnapshot,
  defaultRuntimeCaches,
  normalizeMatched,
  normalizeUnmatched,
  pruneRuntimeCaches,
} from '../dist/positions/normalize.js';
import { makeGame } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const unmatchedFixture = JSON.parse(readFileSync(join(here, 'fixtures/vendor/unmatched.json'), 'utf8'));
const matchedFixture = JSON.parse(readFileSync(join(here, 'fixtures/vendor/matched.json'), 'utf8'));

test('normalizeUnmatched maps vendor session fields (fixture)', () => {
  const caches = defaultRuntimeCaches();
  const { items, shapeWarnings } = normalizeUnmatched(unmatchedFixture.unmatched, '2026-07-02T00:00:00.000Z', caches);
  assert.equal(shapeWarnings.length, 0);
  assert.equal(items.length, 1);
  const order = items[0];
  assert.equal(order.sessionID, 'sess-aaa111');
  assert.equal(order.stableOrderKey, 'ref:cli-1782934549272');
  assert.equal(order.gameID, 'game-mlb-1');
  assert.equal(order.market, 'moneyline');
  assert.equal(order.side, 'home');
  assert.equal(order.odds, 1500);
  assert.equal(order.offeredRisk, 1);
  assert.equal(order.remainingRisk, 1);
  assert.equal(order.firstSeenAt, '2026-07-01T19:35:49.620Z');
  assert.equal(order.firstSeenSource, 'exchange');
});

test('normalizeMatched parses string risk/win and matchedTime (fixture)', () => {
  const { items, shapeWarnings } = normalizeMatched(matchedFixture, defaultRuntimeCaches());
  assert.equal(shapeWarnings.length, 0);
  assert.equal(items.length, 2);
  const pos = items[0];
  assert.equal(pos.txID, 'tx-bbb112');
  assert.equal(pos.risk, 5.05);
  assert.equal(pos.win, 6.93);
  assert.equal(pos.odds, 140);
  assert.equal(pos.linkConfidence, 'exact');
  assert.equal(pos.matchedAt, '2026-07-02T10:44:46.916Z');
  assert.equal(pos.side, 'home');
});

test('normalizers tolerate junk shapes with warnings, never throw', () => {
  const caches = defaultRuntimeCaches();
  const un = normalizeUnmatched({ nope: true }, new Date().toISOString(), caches);
  assert.equal(un.items.length, 0);
  assert.ok(un.shapeWarnings.length > 0);
  const bad = normalizeUnmatched([{ odds: 100 }, null, 'x'], new Date().toISOString(), caches);
  assert.equal(bad.items.length, 0);
  assert.ok(bad.shapeWarnings.length >= 2);
  const mat = normalizeMatched(42, caches);
  assert.equal(mat.items.length, 0);
  assert.ok(mat.shapeWarnings.length > 0);
});

test('manual/website positions without references are kept (unlinked, account-wide)', () => {
  const { items } = normalizeMatched(
    { matchedBets: [{ txID: 'tx-manual', odds: -110, risk: '11', win: '10' }] },
    defaultRuntimeCaches(),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].linkConfidence, 'unlinked');
  assert.equal(items[0].userReference, undefined);
});

test('buildPositionsSnapshot stitches session churn by userReference and keeps earliest firstSeenAt', () => {
  const caches = defaultRuntimeCaches();
  const game = makeGame({ id: 'game-mlb-1' });
  const nowIso = new Date().toISOString();
  const rawA = [{ id: 'sess-A', userReference: 'ref-1', odds: 150, offered: 5, filled: 0, remaining: 5, createdAt: '2026-07-01T00:00:00.000Z', type: 'moneyline', game: { id: 'game-mlb-1' } }];
  const prev = buildPositionsSnapshot({ rawUnmatched: rawA, rawMatched: null, games: [game], prev: null, caches, nowIso });
  const rawB = [{ id: 'sess-B', userReference: 'ref-1', odds: 150, offered: 5, filled: 2, remaining: 3, createdAt: '2026-07-02T00:00:00.000Z', type: 'moneyline', game: { id: 'game-mlb-1' } }];
  const next = buildPositionsSnapshot({ rawUnmatched: rawB, rawMatched: null, games: [game], prev, caches, nowIso });
  assert.equal(next.unmatched[0].stableOrderKey, 'ref:ref-1');
  assert.equal(caches.sessionAliases['sess-B'], 'sess-A');
  assert.equal(next.unmatched[0].firstSeenAt, '2026-07-01T00:00:00.000Z');
});

test('bulk disappearance without catalog state marks market unknown (ghost-order guard)', () => {
  const caches = defaultRuntimeCaches();
  const nowIso = new Date().toISOString();
  const raw = [
    { id: 's1', userReference: 'r1', odds: 150, remaining: 5, type: 'moneyline', game: { id: 'game-x' } },
    { id: 's2', userReference: 'r2', odds: -120, remaining: 5, type: 'moneyline', game: { id: 'game-x' } },
  ];
  const prev = buildPositionsSnapshot({ rawUnmatched: raw, rawMatched: null, games: [], prev: null, caches, nowIso });
  const next = buildPositionsSnapshot({ rawUnmatched: [], rawMatched: null, games: [], prev, caches, nowIso });
  assert.equal(next.marketStates['game-x'].state, 'unknown');
  assert.ok(next.shapeWarnings.some(w => w.includes('disappeared')));
});

test('suspended catalog game yields suspended market state', () => {
  const caches = defaultRuntimeCaches();
  const nowIso = new Date().toISOString();
  const game = makeGame({ id: 'game-s', isOpen: false });
  const raw = [{ id: 's1', userReference: 'r1', odds: 150, remaining: 5, type: 'moneyline', game: { id: 'game-s' } }];
  const snapshot = buildPositionsSnapshot({ rawUnmatched: raw, rawMatched: null, games: [game], prev: null, caches, nowIso });
  assert.equal(snapshot.marketStates['game-s'].state, 'suspended');
});

test('runtime caches stay bounded after thousands of synthetic sessions', () => {
  const caches = defaultRuntimeCaches();
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  for (let i = 0; i < 5000; i++) {
    const key = `ref:syn-${i}`;
    caches.firstSeenAtByStableOrderKey[key] = old;
    caches.lastSeenStableOrderKeyAt[key] = old;
    caches.recentFingerprints[`fp-${i}`] = Date.now() - 48 * 60 * 60 * 1000;
    caches.pendingSuggestions[`rule::${key}`] = { lastSuggestedAt: Date.now() - 48 * 60 * 60 * 1000, lastOrderStateDigest: 'd', hardCooldownMs: 1000 };
  }
  pruneRuntimeCaches(caches, Date.now(), new Set(['rule']));
  assert.equal(Object.keys(caches.firstSeenAtByStableOrderKey).length, 0);
  assert.equal(Object.keys(caches.lastSeenStableOrderKeyAt).length, 0);
  assert.equal(Object.keys(caches.recentFingerprints).length, 0);
  assert.equal(Object.keys(caches.pendingSuggestions).length, 0);

  // Fresh entries beyond the cap are trimmed to the cap.
  for (let i = 0; i < 5000; i++) {
    caches.lastSeenStableOrderKeyAt[`ref:new-${i}`] = new Date(Date.now() - i * 1000).toISOString();
  }
  pruneRuntimeCaches(caches, Date.now(), new Set());
  assert.ok(Object.keys(caches.lastSeenStableOrderKeyAt).length <= 2000);
});

test('pending suggestions for removed rules are pruned', () => {
  const caches = defaultRuntimeCaches();
  caches.lastSeenStableOrderKeyAt['ref:live'] = new Date().toISOString();
  caches.pendingSuggestions['gone-rule::ref:live'] = { lastSuggestedAt: Date.now(), lastOrderStateDigest: 'd', hardCooldownMs: 1000 };
  caches.pendingSuggestions['kept-rule::ref:live'] = { lastSuggestedAt: Date.now(), lastOrderStateDigest: 'd', hardCooldownMs: 1000 };
  pruneRuntimeCaches(caches, Date.now(), new Set(['kept-rule']));
  assert.equal(caches.pendingSuggestions['gone-rule::ref:live'], undefined);
  assert.ok(caches.pendingSuggestions['kept-rule::ref:live']);
});
