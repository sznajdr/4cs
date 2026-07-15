import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeConfig } from './env.js';
import { getRuntimeConfig } from './env.js';
import { BASE_URL } from './api/config.js';
import type { ActivityEvent, Game, MatchedBet, Order, UserProfile } from './api/types.js';
import type { AccountPositionsSnapshot } from './positions/types.js';
import { defaultRuntimeCaches, type RuntimeCaches } from './positions/normalize.js';

export type DaemonStatus = 'starting' | 'running' | 'token_needed' | 'degraded' | 'stopped';

export interface AlertEntry {
  id: string;
  ts: number;
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  detail?: string;
}

export interface OrdersCache {
  unmatched: Order[];
  matched: MatchedBet[];
  updatedAt?: string;
  lastError?: string;
}

export interface BalanceSnapshot {
  id: string;
  username: string;
  balance: number;
  displayBalance: number;
  creditLimit: number;
  oddsFormat: UserProfile['oddsFormat'];
  updatedAt: string;
}

export interface PublicRuntimeConfig {
  live: boolean;
  maxBet: number;
  pollBalanceMs: number;
  pollOrderbookMs: number;
  pollOrdersMs: number;
  baseUrl: string;
  tokenConfigured: boolean;
}

export interface CatalogSnapshot {
  games: Game[];
  failedLeagues: string[];
  updatedAt?: string;
  lastOkAt?: string;
  lastError?: string;
}

export interface DayOpenBalance {
  date: string;
  balance: number;
  capturedAt: string;
}

export interface StateSnapshot {
  version: 1;
  status: DaemonStatus;
  startedAt?: string;
  updatedAt: string;
  catalog: CatalogSnapshot;
  watchList: string[];
  ordersByGame: Record<string, OrdersCache>;
  balance: BalanceSnapshot | null;
  activity: ActivityEvent[];
  alerts: AlertEntry[];
  config: PublicRuntimeConfig;
  positions: AccountPositionsSnapshot | null;
  runtimeCaches: RuntimeCaches;
  dayOpenBalance: DayOpenBalance | null;
}

export function stateFile(config: RuntimeConfig = getRuntimeConfig()): string {
  return join(config.stateDir, 'state.json');
}

export function activityFile(date: string, config: RuntimeConfig = getRuntimeConfig()): string {
  return join(config.stateDir, `activity-${date}.log`);
}

export function publicRuntimeConfig(config: RuntimeConfig = getRuntimeConfig()): PublicRuntimeConfig {
  return {
    live: config.live,
    maxBet: config.maxBet,
    pollBalanceMs: config.pollBalanceMs,
    pollOrderbookMs: config.pollOrderbookMs,
    pollOrdersMs: config.pollOrdersMs,
    baseUrl: BASE_URL,
    tokenConfigured: config.authToken.trim() !== '',
  };
}

export function defaultState(config: RuntimeConfig = getRuntimeConfig()): StateSnapshot {
  const now = new Date().toISOString();
  return {
    version: 1,
    status: 'starting',
    updatedAt: now,
    catalog: {
      games: [],
      failedLeagues: [],
    },
    watchList: [],
    ordersByGame: {},
    balance: null,
    activity: [],
    alerts: [],
    config: publicRuntimeConfig(config),
    positions: null,
    runtimeCaches: defaultRuntimeCaches(),
    dayOpenBalance: null,
  };
}

export function readStateSync(config: RuntimeConfig = getRuntimeConfig()): StateSnapshot {
  const path = stateFile(config);
  if (!existsSync(path)) return defaultState(config);

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateSnapshot>;
    const base = defaultState(config);
    return {
      ...base,
      ...parsed,
      version: 1,
      catalog: {
        ...base.catalog,
        ...(parsed.catalog ?? {}),
        games: parsed.catalog?.games ?? [],
        failedLeagues: parsed.catalog?.failedLeagues ?? [],
      },
      watchList: Array.isArray(parsed.watchList) ? parsed.watchList : [],
      ordersByGame: parsed.ordersByGame ?? {},
      balance: parsed.balance ?? null,
      activity: Array.isArray(parsed.activity) ? parsed.activity.slice(-100) : [],
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts.slice(-100) : [],
      config: publicRuntimeConfig(config),
      positions: parsed.positions ?? null,
      runtimeCaches: {
        ...defaultRuntimeCaches(),
        ...(parsed.runtimeCaches && typeof parsed.runtimeCaches === 'object' ? parsed.runtimeCaches : {}),
      },
      dayOpenBalance: parsed.dayOpenBalance ?? null,
    };
  } catch {
    return defaultState(config);
  }
}

export function writeStateAtomic(state: StateSnapshot, config: RuntimeConfig = getRuntimeConfig()): void {
  mkdirSync(config.stateDir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  state.config = publicRuntimeConfig(config);
  state.activity = state.activity.slice(-100);
  state.alerts = state.alerts.slice(-100);

  const target = stateFile(config);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}
