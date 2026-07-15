import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeConfig } from './env.js';
import { getRuntimeConfig } from './env.js';
import { BASE_URL } from './api/config.js';
import type { ActivityEvent, Game, MatchedBet, Order, PlaceV3Order, UserProfile } from './api/types.js';
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
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastError?: string;
  stale: boolean;
  consecutiveErrorCount: number;
}

export interface BalanceSnapshot {
  id: string;
  username: string;
  balance: number;
  displayBalance: number;
  creditLimit: number;
  oddsFormat: UserProfile['oddsFormat'];
  updatedAt: string;
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastError?: string;
  stale: boolean;
  consecutiveErrorCount: number;
}

export interface PublicRuntimeConfig {
  live: boolean;
  maxBet: number;
  pollBalanceMs: number;
  pollOrderbookMs: number;
  pollOrdersMs: number;
  heartbeatSec: number;
  pollSettlementMs: number;
  baseUrl: string;
  tokenConfigured: boolean;
}

export interface CatalogSnapshot {
  games: Game[];
  failedLeagues: string[];
  updatedAt?: string;
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastError?: string;
  stale: boolean;
  consecutiveErrorCount: number;
}

/** Bounded, exchange-sourced accounting snapshots. P&L is never inferred from balance. */
export interface SettlementJournalEntry {
  id: string;
  capturedAt: string;
  startDate: string;
  endDate: string;
  wagerCount: number;
  summary?: Record<string, unknown>;
}

export interface SettlementSnapshot {
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastError?: string;
  stale: boolean;
  consecutiveErrorCount: number;
  latest?: SettlementJournalEntry;
}

/** Optional discovery cache; participant results refresh only when requested. */
export interface ParticipantsSnapshot {
  active?: boolean;
  items: unknown[];
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastError?: string;
  stale: boolean;
  consecutiveErrorCount: number;
}

export interface DayOpenBalance {
  date: string;
  balance: number;
  capturedAt: string;
}

/** Durable correlation between a client submission and the exchange identifiers it created. */
export interface OrderLifecycleRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  gameID: string;
  userReference: string;
  order: PlaceV3Order;
  orderIDs: string[];
  wagerRequestIDs: string[];
  sessionResponse: unknown;
  status: 'submitted' | 'rejected' | 'cancelled' | 'edited' | 'replaced' | 'unknown';
  lastLookup?: unknown;
  /** Links a cancel-and-replace edit without conflating its two exchange orders. */
  parentLifecycleID?: string;
  replacementLifecycleID?: string;
  replacesOrderID?: string;
}

export interface HeartbeatSnapshot {
  enabled: boolean;
  timeoutSec: number;
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastError?: string;
}

export interface StateSnapshot {
  version: 3;
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
  lifecycle: OrderLifecycleRecord[];
  heartbeat: HeartbeatSnapshot;
  settlement: SettlementSnapshot;
  settlementJournal: SettlementJournalEntry[];
  participants: ParticipantsSnapshot;
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
    heartbeatSec: config.heartbeatSec ?? 0,
    pollSettlementMs: config.pollSettlementMs,
    baseUrl: BASE_URL,
    tokenConfigured: config.authToken.trim() !== '',
  };
}

export function defaultState(config: RuntimeConfig = getRuntimeConfig()): StateSnapshot {
  const now = new Date().toISOString();
  return {
    version: 3,
    status: 'starting',
    updatedAt: now,
    catalog: {
      games: [],
      failedLeagues: [],
      stale: true,
      consecutiveErrorCount: 0,
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
    lifecycle: [],
    heartbeat: {
      enabled: config.live && (config.heartbeatSec ?? 0) > 5,
      timeoutSec: config.heartbeatSec ?? 0,
    },
    settlement: { stale: true, consecutiveErrorCount: 0 },
    settlementJournal: [],
    participants: { items: [], stale: true, consecutiveErrorCount: 0 },
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
      version: 3,
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
      lifecycle: Array.isArray(parsed.lifecycle) ? parsed.lifecycle.slice(-1000) as OrderLifecycleRecord[] : [],
      heartbeat: {
        ...base.heartbeat,
        ...(parsed.heartbeat && typeof parsed.heartbeat === 'object' ? parsed.heartbeat : {}),
        enabled: config.live && (config.heartbeatSec ?? 0) > 5,
        timeoutSec: config.heartbeatSec ?? 0,
      },
      settlement: {
        ...base.settlement,
        ...(parsed.settlement && typeof parsed.settlement === 'object' ? parsed.settlement : {}),
      },
      settlementJournal: Array.isArray(parsed.settlementJournal)
        ? parsed.settlementJournal.slice(-1000) as SettlementJournalEntry[]
        : [],
      participants: {
        ...base.participants,
        ...(parsed.participants && typeof parsed.participants === 'object' ? parsed.participants : {}),
        items: Array.isArray(parsed.participants?.items) ? parsed.participants.items : [],
      },
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
  state.lifecycle = state.lifecycle.slice(-1000);
  state.settlementJournal = state.settlementJournal.slice(-1000);
  state.heartbeat.enabled = config.live && (config.heartbeatSec ?? 0) > 5;
  state.heartbeat.timeoutSec = config.heartbeatSec ?? 0;

  const target = stateFile(config);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}
