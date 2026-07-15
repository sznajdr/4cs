import type { Game } from '../api/types.js';
import type {
  AccountPositionsSnapshot,
  MarketStateValue,
  NormalizedMarketState,
  NormalizedMatchedPosition,
  NormalizedUnmatchedOrder,
} from './types.js';

/**
 * Tolerant normalizers for the vendor session/matched payloads captured in
 * test/fixtures/vendor/. Field mapping (verified live 2026-07-02):
 *   sessionID=id, exchange time=createdAt, offered/filled/remaining are numbers,
 *   matched risk/win are STRINGS, userReference is echoed on both payloads.
 */

/** Minimal shape retained only so the runtime cache dedupes by recency. */
interface PendingSuggestionState {
  lastSuggestedAt: number;
}

export interface RuntimeCaches {
  firstSeenAtByStableOrderKey: Record<string, string>;
  sessionAliases: Record<string, string>;
  pendingSuggestions: Record<string, PendingSuggestionState>;
  lastSeenStableOrderKeyAt: Record<string, string>;
  recentFingerprints: Record<string, number>;
}

export function defaultRuntimeCaches(): RuntimeCaches {
  return {
    firstSeenAtByStableOrderKey: {},
    sessionAliases: {},
    pendingSuggestions: {},
    lastSeenStableOrderKeyAt: {},
    recentFingerprints: {},
  };
}

function asNum(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asStr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

interface VendorGameLite {
  id?: string;
  league?: string;
  ended?: boolean;
  isOpen?: boolean;
  messageType?: string;
  participants?: Array<{ id?: string; homeAway?: string }>;
}

function sideFromParticipant(game: VendorGameLite | undefined, participantID: string | undefined): string | undefined {
  if (!game?.participants || !participantID) return undefined;
  const participant = game.participants.find(p => p.id === participantID);
  if (participant?.homeAway === 'home' || participant?.homeAway === 'away') return participant.homeAway;
  return undefined;
}

export interface NormalizeResult<T> {
  items: T[];
  shapeWarnings: string[];
}

export function normalizeUnmatched(raw: unknown, nowIso: string, caches: RuntimeCaches): NormalizeResult<NormalizedUnmatchedOrder> {
  const warnings: string[] = [];
  const items: NormalizedUnmatchedOrder[] = [];
  const list = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw)) warnings.push('unmatched payload is not an array');

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      warnings.push('unmatched entry is not an object');
      continue;
    }
    const o = entry as Record<string, unknown>;
    const game = (o.game && typeof o.game === 'object' ? o.game : undefined) as VendorGameLite | undefined;
    const sessionID = asStr(o.id) ?? asStr(o._id);
    const odds = asNum(o.odds);
    if (!sessionID || odds === undefined) {
      warnings.push(`unmatched entry missing ${!sessionID ? 'id' : 'odds'}; skipped`);
      continue;
    }
    const userReference = asStr(o.userReference);
    const stableOrderKey = userReference ? `ref:${userReference}` : `sess:${sessionID}`;
    const exchangeCreatedAt = asStr(o.createdAt);
    const firstSeenAt =
      exchangeCreatedAt ??
      caches.firstSeenAtByStableOrderKey[stableOrderKey] ??
      nowIso;
    const market = asStr(o.type);
    const line = asNum(o.spread) ?? asNum(o.total);
    items.push({
      sessionID,
      stableOrderKey,
      gameID: asStr(game?.id) ?? asStr(o.gameID),
      league: asStr(game?.league),
      ...(market ? { market } : {}),
      ...(sideFromParticipant(game, asStr(o.participantID)) ? { side: sideFromParticipant(game, asStr(o.participantID)) } : {}),
      ...(line !== undefined ? { line } : {}),
      odds,
      ...(asNum(o.offered) !== undefined ? { offeredRisk: asNum(o.offered) } : {}),
      ...(asNum(o.filled) !== undefined ? { filledRisk: asNum(o.filled) } : {}),
      ...(asNum(o.remaining) !== undefined ? { remainingRisk: asNum(o.remaining) } : {}),
      firstSeenAt,
      firstSeenSource: exchangeCreatedAt ? 'exchange' : 'daemon',
      ...(userReference ? { userReference } : {}),
    });
  }
  return { items, shapeWarnings: warnings };
}

export function normalizeMatched(raw: unknown, caches: RuntimeCaches): NormalizeResult<NormalizedMatchedPosition> {
  const warnings: string[] = [];
  const items: NormalizedMatchedPosition[] = [];

  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    const container = raw as Record<string, unknown>;
    if (Array.isArray(container.matchedBets)) list = container.matchedBets;
    else if (Array.isArray(container.matched)) list = container.matched;
    else warnings.push('matched payload has no matchedBets array');
  } else if (raw != null) {
    warnings.push('matched payload is neither array nor object');
  }

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      warnings.push('matched entry is not an object');
      continue;
    }
    const m = entry as Record<string, unknown>;
    const game = (m.game && typeof m.game === 'object' ? m.game : undefined) as VendorGameLite | undefined;
    const txID = asStr(m.txID) ?? asStr(m.id);
    const odds = asNum(m.odds);
    const risk = asNum(m.risk) ?? asNum(m.bet);
    if (!txID || odds === undefined || risk === undefined) {
      warnings.push(`matched entry missing ${!txID ? 'txID' : odds === undefined ? 'odds' : 'risk'}; skipped`);
      continue;
    }
    const userReference = asStr(m.userReference);
    const stableOrderKey = userReference ? `ref:${userReference}` : undefined;
    const market = asStr(m.type);
    const line = asNum(m.spread) ?? asNum(m.total);
    const win = asNum(m.win);
    items.push({
      txID,
      ...(stableOrderKey ? { stableOrderKey } : {}),
      linkConfidence: stableOrderKey ? 'exact' : 'unlinked',
      gameID: asStr(game?.id) ?? asStr(m.gameID),
      league: asStr(game?.league),
      ...(market ? { market } : {}),
      ...(sideFromParticipant(game, asStr(m.participantID)) ? { side: sideFromParticipant(game, asStr(m.participantID)) } : {}),
      ...(line !== undefined ? { line } : {}),
      odds,
      risk,
      ...(win !== undefined ? { win } : {}),
      ...(userReference ? { userReference } : {}),
      ...(asStr(m.matchedTime) ? { matchedAt: asStr(m.matchedTime) } : {}),
    });
  }
  return { items, shapeWarnings: warnings };
}

export function marketStateForGame(game: Game | undefined, observedAt: string): NormalizedMarketState | null {
  if (!game) return null;
  let state: MarketStateValue;
  if (game.ended || game.messageType === 'marketClosed') state = 'closed';
  else if (game.isOpen === false) state = 'suspended';
  else state = 'active';
  return { gameID: game.id, state, source: 'catalog', observedAt };
}

/**
 * Build the full positions snapshot: normalize both payloads, stitch session
 * churn to stable keys, resolve market states from the catalog, and update
 * first-seen/last-seen caches (mutates `caches` in place).
 */
export function buildPositionsSnapshot(args: {
  rawUnmatched: unknown;
  rawMatched: unknown;
  games: Game[];
  prev: AccountPositionsSnapshot | null;
  caches: RuntimeCaches;
  nowIso: string;
}): AccountPositionsSnapshot {
  const { rawUnmatched, rawMatched, games, prev, caches, nowIso } = args;
  const un = normalizeUnmatched(rawUnmatched, nowIso, caches);
  const mat = normalizeMatched(rawMatched, caches);
  const warnings = [...un.shapeWarnings, ...mat.shapeWarnings];

  // Stitch: if a previous session disappeared and a new session appeared with the
  // same stable key (userReference), record the alias so diffing sees continuity.
  const prevBySession = new Map((prev?.unmatched ?? []).map(o => [o.sessionID, o]));
  for (const order of un.items) {
    const prevSame = (prev?.unmatched ?? []).find(
      p => p.stableOrderKey === order.stableOrderKey && p.sessionID !== order.sessionID,
    );
    if (prevSame && !prevBySession.has(order.sessionID)) {
      caches.sessionAliases[order.sessionID] = prevSame.sessionID;
    }
    // Preserve the earliest first-seen time we know for the stable key.
    const cached = caches.firstSeenAtByStableOrderKey[order.stableOrderKey];
    if (!cached || order.firstSeenAt < cached) {
      caches.firstSeenAtByStableOrderKey[order.stableOrderKey] = order.firstSeenAt;
    } else {
      order.firstSeenAt = cached;
    }
    caches.lastSeenStableOrderKeyAt[order.stableOrderKey] = nowIso;
  }
  for (const pos of mat.items) {
    if (pos.stableOrderKey) caches.lastSeenStableOrderKeyAt[pos.stableOrderKey] = nowIso;
  }

  // Market states for every game referenced by a position; catalog is the source.
  const gameIndex = new Map(games.map(g => [g.id, g]));
  const marketStates: Record<string, NormalizedMarketState> = {};
  const referenced = new Set<string>();
  for (const order of un.items) if (order.gameID) referenced.add(order.gameID);
  for (const pos of mat.items) if (pos.gameID) referenced.add(pos.gameID);
  for (const prevOrder of prev?.unmatched ?? []) if (prevOrder.gameID) referenced.add(prevOrder.gameID);
  for (const gameID of referenced) {
    const fromCatalog = marketStateForGame(gameIndex.get(gameID), nowIso);
    marketStates[gameID] = fromCatalog ?? { gameID, state: 'unknown', source: 'inferred', observedAt: nowIso };
  }

  // Bulk-disappearance guard: if a game's entire order set vanished at once and
  // the catalog does not clearly say active, mark the state unknown for a cycle.
  const prevByGame = new Map<string, number>();
  for (const prevOrder of prev?.unmatched ?? []) {
    if (prevOrder.gameID) prevByGame.set(prevOrder.gameID, (prevByGame.get(prevOrder.gameID) ?? 0) + 1);
  }
  const nextGameIds = new Set(un.items.map(o => o.gameID).filter(Boolean));
  for (const [gameID, count] of prevByGame) {
    if (count >= 2 && !nextGameIds.has(gameID) && marketStates[gameID]?.source !== 'catalog') {
      marketStates[gameID] = { gameID, state: 'unknown', source: 'inferred', observedAt: nowIso };
      warnings.push(`game ${gameID}: entire order set disappeared with no catalog state; treating as unknown for one cycle`);
    }
  }

  return {
    unmatched: un.items,
    matched: mat.items,
    marketStates,
    updatedAt: nowIso,
    lastOkAt: nowIso,
    shapeWarnings: warnings,
  };
}

const CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;

/** Drop cache entries not seen for 24h and hard-cap map sizes. Mutates in place. */
export function pruneRuntimeCaches(caches: RuntimeCaches, now: number, activeRuleIds?: Set<string>): void {
  const cutoffIso = new Date(now - CACHE_RETENTION_MS).toISOString();

  const lastSeen = caches.lastSeenStableOrderKeyAt;
  for (const [key, seenAt] of Object.entries(lastSeen)) {
    if (seenAt < cutoffIso) {
      delete lastSeen[key];
      delete caches.firstSeenAtByStableOrderKey[key];
    }
  }
  for (const key of Object.keys(caches.firstSeenAtByStableOrderKey)) {
    if (!(key in lastSeen)) delete caches.firstSeenAtByStableOrderKey[key];
  }
  for (const [alias, target] of Object.entries(caches.sessionAliases)) {
    // Aliases are only useful while the stitched stable key is still tracked.
    if (!(target in lastSeen)) delete caches.sessionAliases[alias];
  }
  for (const [key, pending] of Object.entries(caches.pendingSuggestions)) {
    const ruleId = key.split('::')[0];
    const expired = now - pending.lastSuggestedAt > CACHE_RETENTION_MS;
    const ruleGone = activeRuleIds !== undefined && !activeRuleIds.has(ruleId);
    const stableKey = key.split('::')[1];
    const orderGone = stableKey !== undefined && !(stableKey in lastSeen);
    if (expired || ruleGone || orderGone) delete caches.pendingSuggestions[key];
  }
  for (const [fp, ts] of Object.entries(caches.recentFingerprints)) {
    if (now - ts > CACHE_RETENTION_MS) delete caches.recentFingerprints[fp];
  }

  capMap(caches.firstSeenAtByStableOrderKey);
  capMap(caches.sessionAliases);
  capMap(caches.lastSeenStableOrderKeyAt);
  capMapByNumber(caches.recentFingerprints);
  capPending(caches.pendingSuggestions);
}

function capMap(map: Record<string, string>): void {
  const keys = Object.keys(map);
  if (keys.length <= CACHE_MAX_ENTRIES) return;
  const sorted = keys.sort((a, b) => (map[a] < map[b] ? -1 : 1));
  for (const key of sorted.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete map[key];
}

function capMapByNumber(map: Record<string, number>): void {
  const keys = Object.keys(map);
  if (keys.length <= CACHE_MAX_ENTRIES) return;
  const sorted = keys.sort((a, b) => map[a] - map[b]);
  for (const key of sorted.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete map[key];
}

function capPending(map: Record<string, PendingSuggestionState>): void {
  const keys = Object.keys(map);
  if (keys.length <= CACHE_MAX_ENTRIES) return;
  const sorted = keys.sort((a, b) => map[a].lastSuggestedAt - map[b].lastSuggestedAt);
  for (const key of sorted.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete map[key];
}
