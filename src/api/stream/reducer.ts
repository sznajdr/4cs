import type { Game, MatchedBet, Order } from '../types.js';
import type { CatalogSnapshot, OrdersCache } from '../../state.js';

const ORDERBOOK_FIELDS = ['awayMoneylines', 'homeMoneylines', 'awayMoneylines1x2', 'homeMoneylines1x2', 'draw1x2', 'awaySpreads', 'homeSpreads', 'over', 'under'] as const;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function gameFrom(value: unknown): Game | null {
  const candidate = object(value);
  if (!candidate) return null;
  const nested = object(candidate.game);
  const game = nested ?? candidate;
  return typeof game.id === 'string' && Array.isArray(game.participants) ? game as unknown as Game : null;
}

/** Applies only explicit stream fields; missing fields never erase a REST snapshot. */
export function applyPriceEvent(catalog: CatalogSnapshot, type: string, payload: unknown): boolean {
  const data = object(payload);
  if (!data) return false;
  const fullGame = gameFrom(payload);
  if (fullGame) {
    const index = catalog.games.findIndex(game => game.id === fullGame.id);
    if (index >= 0) catalog.games[index] = fullGame;
    else catalog.games.push(fullGame);
    return true;
  }

  const gameID = typeof data.gameID === 'string' ? data.gameID : undefined;
  if (!gameID) return false;
  const index = catalog.games.findIndex(game => game.id === gameID);
  if (index < 0) return false; // REST reconciliation discovers games outside the current filter.
  const game = { ...catalog.games[index] } as Game & Record<string, unknown>;
  let changed = false;
  for (const field of ORDERBOOK_FIELDS) {
    if (Array.isArray(data[field])) {
      game[field] = data[field];
      changed = true;
    }
  }
  const bucket = typeof data.bucket === 'string'
    ? data.bucket
    : typeof data.marketKey === 'string'
      ? data.marketKey
      : orderbookBucket(game, data);
  if (bucket && (ORDERBOOK_FIELDS as readonly string[]).includes(bucket) && Array.isArray(data.sideOrders)) {
    game[bucket] = data.sideOrders;
    changed = true;
  }
  if (type === 'matchedVolumeUpdate' && typeof data.matchedVolume === 'number') {
    game.matchedVolume = data.matchedVolume;
    changed = true;
  }
  if (changed) catalog.games[index] = game;
  return changed;
}

/** Map the documented orderUpdate `type` + selection fields to a rendered-game ladder. */
function orderbookBucket(game: Game, data: Record<string, unknown>): string | undefined {
  const type = data.type;
  const participantID = data.participantID;
  const home = game.participants.find(participant => participant.homeAway === 'home')?.id;
  const away = game.participants.find(participant => participant.homeAway === 'away')?.id;
  if (type === 'total') return data.OU === 'over' || data.side === 'over' ? 'over' : data.OU === 'under' || data.side === 'under' ? 'under' : undefined;
  if (type === 'moneyline') return participantID === home ? 'homeMoneylines' : participantID === away ? 'awayMoneylines' : undefined;
  if (type === 'spread') return participantID === home ? 'homeSpreads' : participantID === away ? 'awaySpreads' : undefined;
  if (type === 'moneyline1x2') {
    const market = data.market;
    return market === 'draw' ? 'draw1x2' : market === home ? 'homeMoneylines1x2' : market === away ? 'awayMoneylines1x2' : undefined;
  }
  return undefined;
}

export interface UserStreamMessage {
  messageID?: string;
  gameID?: string;
  unmatched?: Record<string, unknown> | null;
  matched?: Record<string, unknown> | null;
  origin?: string;
  [key: string]: unknown;
}

export function isUserStreamMessage(value: unknown): value is UserStreamMessage {
  const data = object(value);
  return !!data && typeof data.gameID === 'string' && ('unmatched' in data || 'matched' in data);
}

export function compareStreamID(left: string, right: string): number {
  const [leftMs, leftSeq = '0'] = left.split('-');
  const [rightMs, rightSeq = '0'] = right.split('-');
  try {
    const a = BigInt(leftMs); const b = BigInt(rightMs);
    if (a !== b) return a > b ? 1 : -1;
    const sa = BigInt(leftSeq); const sb = BigInt(rightSeq);
    return sa === sb ? 0 : sa > sb ? 1 : -1;
  } catch {
    return left.localeCompare(right);
  }
}

function asOrder(data: Record<string, unknown>, gameID: string): Order {
  return {
    ...data,
    id: typeof data.orderID === 'string' ? data.orderID : typeof data.id === 'string' ? data.id : undefined,
    gameID,
    odds: Number(data.odds ?? 0),
    filled: Number(data.filled ?? 0),
    offered: Number(data.offered ?? 0),
    remaining: Number(data.remaining ?? 0),
    market: typeof data.type === 'string' ? data.type as Order['market'] : undefined,
    participantID: typeof data.side === 'string' ? data.side : '',
    spread: typeof data.number === 'number' && data.type === 'spread' ? data.number : null,
    total: typeof data.number === 'number' && data.type === 'total' ? data.number : null,
  };
}

function asMatched(data: Record<string, unknown>, gameID: string): MatchedBet {
  return {
    ...data,
    txID: typeof data.txID === 'string' ? data.txID : '',
    gameID,
    odds: Number(data.odds ?? 0),
    filled: Number(data.amount ?? data.risk ?? 0),
    market: typeof data.type === 'string' ? data.type as MatchedBet['market'] : undefined,
    participantID: typeof data.side === 'string' ? data.side : undefined,
    spread: typeof data.number === 'number' && data.type === 'spread' ? data.number : null,
    total: typeof data.number === 'number' && data.type === 'total' ? data.number : null,
  };
}

/** Fold a user-feed event into the per-game fast view; REST positions remain the accounting authority. */
export function applyUserEvent(cache: OrdersCache, message: UserStreamMessage): 'placed' | 'cancelled' | 'matched' | 'partial' | 'unknown' {
  const unmatched = object(message.unmatched);
  const matched = object(message.matched);
  if (unmatched) {
    const order = asOrder(unmatched, message.gameID!);
    const id = order.id;
    const offered = Number(unmatched.offered ?? 0);
    if (offered === 0) {
      cache.unmatched = cache.unmatched.filter(item => item.id !== id && item._id !== id);
      if (matched) cache.matched = appendMatched(cache.matched, asMatched(matched, message.gameID!));
      return matched ? 'partial' : 'cancelled';
    }
    const index = cache.unmatched.findIndex(item => item.id === id || item._id === id);
    if (index >= 0) cache.unmatched[index] = order;
    else cache.unmatched.push(order);
    if (matched) {
      cache.matched = appendMatched(cache.matched, asMatched(matched, message.gameID!));
      return 'partial';
    }
    return 'placed';
  }
  if (matched) {
    cache.matched = appendMatched(cache.matched, asMatched(matched, message.gameID!));
    return 'matched';
  }
  return 'unknown';
}

function appendMatched(items: MatchedBet[], item: MatchedBet): MatchedBet[] {
  return item.txID && !items.some(existing => existing.txID === item.txID) ? [...items, item] : items;
}
