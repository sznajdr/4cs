import { BASE_URL, authHeaderValue } from './config.js';
import { log } from '../log.js';
import { DEFAULT_LEAGUES } from '../lib/leagues.js';
import type {
  LoginResponse,
  UserProfile,
  OrdersForGameResponse,
  Game,
  MarketType,
  PlaceV3Order,
  CreatedSession,
  PlaceV3Response,
  CancelResult,
  CancelResponse,
  PlaceMarketType,
  UnmatchedResponse,
  MatchedBetsResponse,
  GameLiabilityResponse,
  BetByUserReferenceResponse,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const ORDERBOOK_TIMEOUT_MS = 8_000;

let _token: string | null = null;
let _onUnauthorized: (() => void) | null = null;
let _onRateLimited: (() => void) | null = null;

export function setToken(t: string | null) { _token = t; }
export function getToken() { return _token; }
export function setUnauthorizedHandler(fn: () => void) { _onUnauthorized = fn; }
export function setRateLimitedHandler(fn: () => void) { _onRateLimited = fn; }

/** Error raised on HTTP 429 so the unified scheduler can back off globally. */
export class RateLimitError extends Error {
  readonly rateLimited = true;
  constructor(path: string) {
    super(`429 rate limited: ${path}`);
  }
}

export function isRateLimitError(err: unknown): boolean {
  return err instanceof RateLimitError || (typeof err === 'object' && err !== null && (err as { rateLimited?: boolean }).rateLimited === true);
}

const _inflight = new Map<string, Promise<unknown>>();

function buildUrl(path: string, params?: Record<string, string>): string {
  let url = `${BASE_URL}${path}`;
  if (params && Object.keys(params).length > 0) {
    url += '?' + new URLSearchParams(params).toString();
  }
  return url;
}

export interface RequestOpts {
  retries?: number;
  timeoutMs?: number;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
  opts: RequestOpts = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = buildUrl(path, params);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (_token) headers.Authorization = authHeaderValue(_token);

  const attempt = async (remaining: number): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const isAbort = (e as { name?: string })?.name === 'AbortError';
      if (isAbort && remaining > 0) {
        await sleep(500 * (3 - remaining));
        return attempt(remaining - 1);
      }
      throw isAbort
        ? new Error(`Request timed out after ${timeoutMs}ms: ${method} ${path}`)
        : (e as Error);
    }
    clearTimeout(timer);

    if (res.status === 401) {
      _onUnauthorized?.();
      throw new Error('Session expired; update FOURCASTER_AUTH_TOKEN and restart the daemon');
    }

    if (res.status === 429) {
      _onRateLimited?.();
      throw new RateLimitError(path);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${res.status} ${res.statusText}: ${text}`);
      if (res.status >= 500 && remaining > 0) {
        await sleep(500 * (3 - remaining));
        return attempt(remaining - 1);
      }
      throw err;
    }

    return res.json() as Promise<T>;
  };

  if (method === 'GET') {
    const existing = _inflight.get(url) as Promise<T> | undefined;
    if (existing) return existing;
    const p = attempt(retries).finally(() => _inflight.delete(url));
    _inflight.set(url, p as Promise<unknown>);
    return p;
  }

  return attempt(retries);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUser(user: UserProfile): UserProfile {
  user.balance = user.displayBalance ?? user.balance ?? 0;
  return user;
}

export async function login(username: string, password: string): Promise<UserProfile> {
  const data = await request<LoginResponse>('POST', '/user/login', { username, password });
  const user = data.data.user;
  if (!user?.auth) throw new Error('Invalid username or password');
  setToken(user.auth);
  return normalizeUser(user);
}

export async function getMe(): Promise<UserProfile> {
  const data = await request<{ data: { user: UserProfile } }>('POST', '/user/getme');
  return normalizeUser(data.data.user);
}

export async function placeOrders(orders: PlaceV3Order[]): Promise<CreatedSession[]> {
  const data = await request<PlaceV3Response>('POST', '/session/v3/place', { orders });
  return data.data?.createdSessions ?? [];
}

export async function cancelOrder(sessionID: string): Promise<CancelResult> {
  const data = await request<CancelResponse>('POST', '/session/cancel', { sessionID });
  return data.data;
}

export async function cancelAllForGame(gameID: string, type?: PlaceMarketType): Promise<CancelResult[]> {
  const body = type ? { gameID, type } : { gameID };
  const data = await request<{ data: CancelResult[] }>('POST', '/session/cancelAllOrdersForGame', body);
  return data.data ?? [];
}

export async function getOrdersForGame(gameID: string): Promise<OrdersForGameResponse['data']> {
  const data = await request<OrdersForGameResponse>('GET', '/user/getOrdersForGame', undefined, { gameID });
  return data.data;
}

// --- Account-wide reads (contracts confirmed from docs/notes/documm.md) ---

/** All resting/unmatched orders, account-wide. */
export async function getUnmatched(): Promise<unknown[]> {
  const data = await request<UnmatchedResponse>('GET', '/user/getUnmatched');
  return data.data?.unmatched ?? [];
}

/** Open matched, ungraded positions, account-wide. Forwarded verbatim. */
export async function getMatchedBets(): Promise<unknown> {
  const data = await request<MatchedBetsResponse>('GET', '/user/getMatchedBets');
  return data.data ?? null;
}

/** Worst-case financial liability on a single game (a number <= 0). */
export async function getGameLiability(gameID: string): Promise<number | null> {
  const data = await request<GameLiabilityResponse>('GET', '/user/getGameLiability', undefined, { gameID });
  return data.data?.liability ?? null;
}

/**
 * Graded/settled bets tied to a userReference. This is the real endpoint behind
 * "graded wagers" — `/user/getGradedWagers` does not exist. Returns the unmatched,
 * matched and graded arrays for the given reference (optionally scoped to a game).
 */
export async function getBetByUserReference(
  userReference: string,
  gameID?: string,
): Promise<BetByUserReferenceResponse['data']> {
  const params: Record<string, string> = { userReference };
  if (gameID) params.gameID = gameID;
  const data = await request<BetByUserReferenceResponse>('GET', '/user/getBetByUserReference', undefined, params);
  return data.data ?? {};
}

// --- Bulk cancels & edit (writes — all guarded by LIVE/MAX_BET/confirm upstream) ---

/** Cancel a specific list of resting orders. Body contract confirmed from docs. */
export async function cancelMultiple(sessionIDs: string[]): Promise<CancelResult[]> {
  const data = await request<{ data: CancelResult[] }>('POST', '/session/cancelMultiple', { sessionIDs });
  return data.data ?? [];
}

/**
 * Cancel every resting order for one league.
 * Body `{ league }` CONFIRMED live (2026-07): returns immediately with an async ack
 * `{ ordersReceived: true }` (the cancels drain in the background), unlike the other
 * cancel endpoints which return the per-order results synchronously.
 */
export async function cancelAllForLeague(league: string): Promise<unknown> {
  const data = await request<{ data: unknown }>('POST', '/session/cancelAllForLeague', { league });
  return data.data ?? null;
}

/** Cancel every open order, account-wide. Dedicated endpoint; takes no body. */
export async function cancelAllOrders(): Promise<CancelResult[]> {
  const data = await request<{ data: CancelResult[] }>('POST', '/session/cancelAllOrders', {});
  return data.data ?? [];
}

/**
 * Re-price a resting order in place. DISABLED at the daemon layer — do not call.
 * Verified live (2026-07): `/session/editOrder` is cancel-then-replace, and the
 * `{ sessionID, odds, bet }` shape is WRONG — the endpoint cancelled the order then
 * failed the re-place with "bet must be greater than 0" (its replacement-stake field
 * is not `bet` and is undocumented), destroying the order. Kept only for reference;
 * the daemon refuses the live call and steers callers to cancel + place.
 */
export async function editOrder(args: { sessionID: string; odds: number; bet: number }): Promise<unknown> {
  const data = await request<{ data: unknown }>('POST', '/session/editOrder', {
    sessionID: args.sessionID,
    odds: args.odds,
    bet: args.bet,
  });
  return data.data ?? null;
}

export async function getAvailableLeagues(): Promise<string[]> {
  const data = await request<{ data: { availableLeagues?: string[] } }>('GET', '/exchange/getLeagues');
  return data.data?.availableLeagues ?? [];
}

export interface GetGamesResult {
  games: Game[];
  failedLeagues: string[];
}

export async function getGames(leagues: readonly string[] = DEFAULT_LEAGUES): Promise<GetGamesResult> {
  const results = await Promise.allSettled(
    leagues.map(async league => {
      const d = await request<{ data: { games: Game[] } }>(
        'GET',
        '/exchange/v2/getOrderbook',
        undefined,
        { league },
        { retries: 0, timeoutMs: ORDERBOOK_TIMEOUT_MS },
      );
      const games = d.data?.games ?? [];
      log.debug(`getGames ${league}: ${games.length}`);
      return { league, games };
    }),
  );

  const games: Game[] = [];
  const seen = new Set<string>();
  const failedLeagues: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      for (const g of r.value.games) {
        if (!seen.has(g.id)) {
          seen.add(g.id);
          games.push(g);
        }
      }
    } else {
      failedLeagues.push(leagues[i]);
      log.warn(`getGames league ${leagues[i]} failed:`, r.reason);
    }
  }
  return { games, failedLeagues };
}
