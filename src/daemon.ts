import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRuntimeConfig, type RuntimeConfig } from './env.js';
import { appendActivity, makeActivity } from './activity.js';
import { type CommandEnvelope, type CommandResponse } from './ipc.js';
import {
  cancelAllForGame,
  cancelAllForLeague,
  cancelAllOrders,
  cancelByReference,
  cancelMultiple,
  getAffiliateCommission,
  getAveragePrice,
  getAvailableLeagues,
  getBetById,
  getBetByWagerRequestId,
  getBetByUserReference,
  getGradedWagers,
  getGameLiability,
  getGamesIndex,
  getMatchedBets,
  getUserMessages,
  getUnmatched,
  cancelOrder,
  getGames,
  getMe,
  getOrdersForGame,
  getOrderbookForGame,
  getParticipants,
  getSingleOrderbook,
  isRateLimitError,
  lookupOrder,
  placeOrders,
  sendOrdersHeartbeat,
  setRateLimitedHandler,
  setToken,
  setUnauthorizedHandler,
} from './api/rest.js';
import { PollScheduler } from './scheduler/pollScheduler.js';
import { buildPositionsSnapshot, pruneRuntimeCaches } from './positions/normalize.js';
import { DEFAULT_LEAGUES } from './lib/leagues.js';
import type { CancelResult, PlaceMarketType, PlaceV3Order, UserProfile } from './api/types.js';
import { PriceFeed } from './api/stream/priceFeed.js';
import { ResilientFeed, type FeedStatus } from './api/stream/feed.js';
import { appendStreamTape } from './api/stream/tape.js';
import { applyPriceEvent, applyUserEvent, compareStreamID, isUserStreamMessage, type UserStreamMessage } from './api/stream/reducer.js';
import { OrderDedupe } from './lib/orderDedupe.js';
import {
  defaultState,
  readStateSync,
  writeStateAtomic,
  type AlertEntry,
  type BalanceSnapshot,
  type DaemonStatus,
  type OrderLifecycleRecord,
  type OrdersCache,
  type SettlementJournalEntry,
  type StateSnapshot,
} from './state.js';
import { log } from './log.js';

interface PlacePayload {
  order: PlaceV3Order;
  confirm?: boolean;
  request?: unknown;
}

interface WatchPayload {
  gameID: string;
}

interface CancelPayload {
  sessionID: string;
}

interface CancelAllPayload {
  gameID: string;
  type?: PlaceMarketType;
}

interface GradedPayload {
  userReference: string;
  gameID?: string;
}

interface PnlPayload { startDate?: string; endDate?: string; }
interface LookupPayload { orderID: string; }
interface BetPayload { id?: string; txID?: string; }
interface WagerRequestPayload { wagerRequestID: string; }
interface CancelReferencePayload { gameID: string; userReferences: string[]; }
interface ParticipantsPayload { active?: boolean; }
interface GamesIndexPayload { league: string; sport?: string; }
interface AveragePricePayload { leagueRequested: string; }
interface SingleOrderbookPayload { gameID: string; }
interface AffiliatePayload { fromDate?: string; toDate?: string; }

interface LiabilityPayload {
  gameID: string;
}

interface CancelMultiplePayload {
  sessionIDs: string[];
}

interface CancelLeaguePayload {
  league: string;
}

interface EditOrderPayload {
  sessionID: string;
  odds: number;
  bet: number;
  confirm?: boolean;
  confirmReplace?: boolean;
}

class FourcasterDaemon {
  private config: RuntimeConfig;
  private state: StateSnapshot;
  private timers: NodeJS.Timeout[] = [];
  private processing = new Set<string>();
  private dedupe = new OrderDedupe();
  private stopping = false;
  private scheduler: PollScheduler | null = null;
  private priceFeed: PriceFeed | null = null;
  private userFeed: ResilientFeed | null = null;

  constructor(config = getRuntimeConfig()) {
    this.config = config;
    this.state = existsSync(join(config.stateDir, 'state.json'))
      ? readStateSync(config)
      : defaultState(config);
    this.state.status = 'starting';
    this.state.startedAt = new Date().toISOString();
  }

  async start(): Promise<void> {
    this.ensureDirs();
    setToken(this.config.authToken || null);
    setUnauthorizedHandler(() => this.handleUnauthorized());
    setRateLimitedHandler(() => this.handleRateLimited());

    if (!this.config.authToken) {
      this.setStatus('token_needed');
      this.addAlert('warning', 'token_needed', 'FOURCASTER_AUTH_TOKEN is not configured; account and trading calls are disabled');
    }

    this.record(makeActivity('CONNECT', '4caster daemon starting', `LIVE=${this.config.live ? '1' : '0'} MAX_BET=${this.config.maxBet}`));
    this.persist();

    // First obtain a complete REST baseline, then attach low-latency deltas.
    if (this.config.streamingEnabled && this.hasToken()) await this.bootstrapStreamSnapshot();

    // Unified serialized scheduler: one exchange-facing task at a time, jittered
    // due times, global backoff on 429, per-task timeout releases the queue.
    this.scheduler = new PollScheduler({
      isRateLimited: isRateLimitError,
      onRateLimit: task => {
        this.addAlert('warning', 'rate_limited', `4casters rate limited during ${task}; backing off all polling`);
        this.persist();
      },
      onError: (task, err) => {
        log.warn(`poll task ${task} failed:`, err instanceof Error ? err.message : err);
      },
    });
    this.scheduler.register({ name: 'catalog', intervalMs: this.config.pollOrderbookMs, run: () => this.refreshCatalog() });
    this.scheduler.register({ name: 'balance', intervalMs: this.config.pollBalanceMs, run: () => this.refreshBalance() });
    this.scheduler.register({ name: 'orders', intervalMs: this.config.pollOrdersMs, run: () => this.refreshWatchedOrders() });
    this.scheduler.register({ name: 'positions', intervalMs: this.config.pollPositionsMs, run: () => this.refreshPositions() });
    // Settlement is account accounting, not market transport: keep it far away from the 8s book loop.
    this.scheduler.register({ name: 'settlement', intervalMs: this.config.pollSettlementMs, run: () => this.refreshSettlements() });
    if (this.config.live && this.config.heartbeatSec > 5) {
      const intervalMs = Math.max(1_000, Math.floor(this.config.heartbeatSec * 1_000 / 3));
      this.scheduler.register({ name: 'heartbeat', intervalMs, run: () => this.sendHeartbeatIfNeeded(), timeoutMs: Math.min(15_000, intervalMs) });
      this.addAlert('warning', 'heartbeat_enabled', `Orders heartbeat enabled: all account orders cancel after ${this.config.heartbeatSec}s without a heartbeat`);
    }

    if (this.config.streamingEnabled && this.hasToken()) this.startStreaming();

    // Command scanning stays frequent; exchange writes still flow through the guarded handlers.
    this.timers.push(setInterval(() => void this.scanCommands(), 250));

    log.warn(`4caster daemon ready: LIVE=${this.config.live ? '1' : '0'} MAX_BET=${this.config.maxBet}`);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.scheduler?.stop();
    this.priceFeed?.stop();
    this.userFeed?.stop();
    this.setStatus('stopped');
    this.record(makeActivity('CONNECT', '4caster daemon stopped'));
    this.persist();
  }

  /** Apply a poll's state mutation and persist. Read-only against the exchange. */
  private commitPolledState(mutate: (draft: StateSnapshot) => void): void {
    mutate(this.state);
    this.persist();
  }

  private ensureDirs(): void {
    mkdirSync(this.config.stateDir, { recursive: true });
    mkdirSync(this.config.commandsDir, { recursive: true });
    mkdirSync(this.config.responsesDir, { recursive: true });
  }

  private setStatus(status: DaemonStatus): void {
    this.state.status = status;
  }

  private persist(): void {
    writeStateAtomic(this.state, this.config);
  }

  /** One ordered REST baseline before streams begin; failures stay visible and scheduled reconciliation retries. */
  private async bootstrapStreamSnapshot(): Promise<void> {
    for (const [name, refresh] of [
      ['catalog', () => this.refreshCatalog()],
      ['balance', () => this.refreshBalance()],
      ['orders', () => this.refreshWatchedOrders()],
      ['positions', () => this.refreshPositions()],
    ] as const) {
      try {
        await refresh();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.addAlert('warning', `stream_bootstrap_${name}`, `REST ${name} snapshot failed before streaming; scheduled reconciliation will retry`, detail);
        this.persist();
      }
    }
  }

  private startStreaming(): void {
    const token = this.config.authToken;
    this.state.streams.enabled = true;
    this.priceFeed = new PriceFeed({
      name: 'price',
      url: 'wss://streaming-api.4casters.io/price-stream',
      token,
      onMessage: message => this.applyPriceStreamMessage(message),
      onMalformed: raw => this.markMalformedStreamEvent('price', raw),
      onStatus: status => this.updateStreamStatus('price', status),
    }, this.priceSubscription());
    this.userFeed = new ResilientFeed({
      name: 'user',
      url: 'wss://streaming-api.4casters.io/v2/user',
      token,
      beforeReady: () => this.replayUserMessages(),
      onMessage: message => this.applyUserStreamMessage(message),
      onMalformed: raw => this.markMalformedStreamEvent('user', raw),
      onStatus: status => this.updateStreamStatus('user', status),
    });
    this.priceFeed.start();
    this.userFeed.start();
  }

  private priceSubscription(): { gameIDs: string[]; leagueIDs: string[] } {
    const leagueIDs = this.config.streamLeagues.length
      ? this.config.streamLeagues
      : [...new Set(this.state.catalog.games.map(game => game.league).filter(Boolean))];
    return { gameIDs: this.state.watchList, leagueIDs: leagueIDs.length ? leagueIDs : [...DEFAULT_LEAGUES] };
  }

  private refreshPriceSubscription(): void {
    this.priceFeed?.setSubscription(this.priceSubscription());
  }

  private updateStreamStatus(feed: 'price' | 'user', status: FeedStatus): void {
    const snapshot = this.state.streams[feed];
    snapshot.status = status.status;
    if (status.connectedAt) snapshot.connectedAt = status.connectedAt;
    if (status.disconnectedAt) snapshot.disconnectedAt = status.disconnectedAt;
    if (status.lastError) snapshot.lastError = status.lastError;
    if (status.reconnectCount !== undefined) snapshot.reconnectCount = status.reconnectCount;
    if (status.status === 'live') this.scheduler?.requestNow(feed === 'price' ? 'catalog' : 'positions');
    this.persist();
  }

  private markMalformedStreamEvent(feed: 'price' | 'user', raw: string): void {
    this.state.streams[feed].malformedEventCount++;
    this.state.streams[feed].lastError = 'Malformed JSON stream event';
    appendStreamTape(feed, 'malformed', raw, this.config);
    this.state.streams.tape.eventCount++;
    this.state.streams.tape.lastWrittenAt = new Date().toISOString();
    this.persist();
  }

  private async applyPriceStreamMessage(message: unknown): Promise<void> {
    if (!Array.isArray(message) || message.length !== 2 || typeof message[0] !== 'string') {
      this.markMalformedStreamEvent('price', JSON.stringify(message));
      return;
    }
    const [type, payload] = message as [string, unknown];
    const epoch = payload && typeof payload === 'object' && typeof (payload as { epoch?: unknown }).epoch === 'number'
      ? (payload as { epoch: number }).epoch
      : undefined;
    const lastEpoch = this.state.streams.price.lastEpoch;
    if (epoch !== undefined) {
      if (lastEpoch !== undefined && epoch > lastEpoch + 1) {
        this.addAlert('warning', 'price_stream_gap', `Price stream epoch jumped from ${lastEpoch} to ${epoch}; queued REST reconciliation`);
        this.scheduler?.requestNow('catalog');
      }
      if (lastEpoch === undefined || epoch > lastEpoch) this.state.streams.price.lastEpoch = epoch;
    }
    const changed = applyPriceEvent(this.state.catalog, type, payload);
    const now = new Date().toISOString();
    this.state.streams.price.eventCount++;
    this.state.streams.price.lastEventAt = now;
    if (changed) this.state.catalog.updatedAt = now;
    appendStreamTape('price', type, payload, this.config);
    this.state.streams.tape.eventCount++;
    this.state.streams.tape.lastWrittenAt = now;
    this.persist();
  }

  private async replayUserMessages(): Promise<void> {
    const afterID = this.state.streams.user.lastMessageID;
    if (!afterID) return; // First startup has just taken a REST account snapshot.
    const messages = await getUserMessages(afterID);
    for (const message of messages) await this.applyUserStreamMessage(message, true);
  }

  private async applyUserStreamMessage(message: unknown, replayed = false): Promise<void> {
    if (!isUserStreamMessage(message)) {
      this.markMalformedStreamEvent('user', JSON.stringify(message));
      return;
    }
    const messageID = typeof message.messageID === 'string' ? message.messageID : undefined;
    const lastID = this.state.streams.user.lastMessageID;
    if (messageID && lastID && compareStreamID(messageID, lastID) <= 0) return; // Replay/live overlap is expected.

    const cache = this.state.ordersByGame[message.gameID!] ?? emptyOrdersCache();
    const action = applyUserEvent(cache, message);
    const now = new Date().toISOString();
    cache.updatedAt = now;
    cache.lastOkAt = now;
    cache.stale = false;
    cache.consecutiveErrorCount = 0;
    this.state.ordersByGame[message.gameID!] = cache;
    if (messageID) this.state.streams.user.lastMessageID = messageID;
    this.state.streams.user.eventCount++;
    this.state.streams.user.lastEventAt = now;
    if (replayed) this.state.streams.user.replayedEventCount++;
    this.updateLifecycleFromUserEvent(message, action, now);
    appendStreamTape('user', action, message, this.config);
    this.state.streams.tape.eventCount++;
    this.state.streams.tape.lastWrittenAt = now;
    this.record(makeActivity(action === 'cancelled' ? 'CANCEL' : action === 'placed' ? 'ORDER' : 'FILL', `User stream ${action} for ${message.gameID}`, messageID));
    this.persist();
  }

  private updateLifecycleFromUserEvent(message: UserStreamMessage, action: string, now: string): void {
    const unmatched = message.unmatched && typeof message.unmatched === 'object' ? message.unmatched as Record<string, unknown> : null;
    const matched = message.matched && typeof message.matched === 'object' ? message.matched as Record<string, unknown> : null;
    const orderID = typeof unmatched?.orderID === 'string' ? unmatched.orderID : typeof matched?.orderID === 'string' ? matched.orderID : undefined;
    const wagerRequestID = typeof unmatched?.wagerRequestID === 'string' ? unmatched.wagerRequestID : typeof matched?.wagerRequestID === 'string' ? matched.wagerRequestID : undefined;
    const record = this.state.lifecycle.find(item => (orderID && item.orderIDs.includes(orderID)) || (wagerRequestID && item.wagerRequestIDs.includes(wagerRequestID)));
    if (!record) return;
    record.updatedAt = now;
    if (action === 'cancelled') record.status = 'cancelled';
  }

  private record(event: ReturnType<typeof makeActivity>): void {
    this.state.activity.push(event);
    appendActivity(event, this.config);
  }

  private addAlert(level: AlertEntry['level'], code: string, message: string, detail?: string): void {
    const existing = this.state.alerts.find(alert => alert.code === code);
    const next: AlertEntry = {
      id: existing?.id ?? randomUUID(),
      ts: Date.now(),
      level,
      code,
      message,
      ...(detail ? { detail } : {}),
    };
    this.state.alerts = [
      ...this.state.alerts.filter(alert => alert.code !== code),
      next,
    ].slice(-100);
  }

  private handleUnauthorized(): void {
    setToken(null);
    this.setStatus('token_needed');
    this.addAlert('error', 'unauthorized', '4casters token was rejected; update FOURCASTER_AUTH_TOKEN and restart the daemon');
    this.persist();
  }

  private handleRateLimited(): void {
    this.scheduler?.applyBackoff();
  }

  private hasToken(): boolean {
    return this.config.authToken.trim() !== '';
  }

  private updateHealthyStatus(): void {
    if (!this.hasToken()) {
      this.setStatus('token_needed');
      return;
    }
    this.state.alerts = this.state.alerts.filter(alert => alert.code !== 'token_needed' && alert.code !== 'unauthorized');
    const hasCatalogError = this.state.catalog.stale;
    const hasBalanceError = this.state.balance?.stale === true;
    const hasOrderErrors = Object.values(this.state.ordersByGame).some(order => order.stale);
    const hasPositionError = this.state.positions?.stale === true;
    const hasSettlementError = this.state.settlement.stale && this.state.settlement.lastAttemptAt !== undefined;
    this.setStatus(hasCatalogError || hasBalanceError || hasOrderErrors || hasPositionError || hasSettlementError ? 'degraded' : 'running');
  }

  private async refreshCatalog(): Promise<void> {
    const attemptAt = new Date().toISOString();
    this.state.catalog.lastAttemptAt = attemptAt;
    if (!this.hasToken()) {
      this.state.catalog.lastError = 'token_needed';
      this.state.catalog.stale = true;
      this.state.catalog.consecutiveErrorCount++;
      this.setStatus('token_needed');
      this.persist();
      return;
    }
    try {
      let leagues: readonly string[] = DEFAULT_LEAGUES;
      try {
        const availableLeagues = await getAvailableLeagues();
        if (availableLeagues.length > 0) leagues = availableLeagues;
      } catch (err) {
        if (isRateLimitError(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        this.addAlert('warning', 'leagues_failed', 'Active league discovery failed; falling back to default leagues', message);
      }
      const result = await getGames(leagues);
      const now = new Date().toISOString();
      this.commitPolledState(draft => {
        const successfulLeagues = new Set(result.successfulLeagues);
        const retained = draft.catalog.games.filter(game => !successfulLeagues.has(game.league));
        draft.catalog = {
          games: [...retained, ...result.games],
          failedLeagues: result.failedLeagues,
          updatedAt: now,
          lastAttemptAt: attemptAt,
          lastOkAt: now,
          lastError: result.failedLeagues.length ? `Failed leagues: ${result.failedLeagues.join(', ')}` : undefined,
          stale: result.failedLeagues.length > 0,
          consecutiveErrorCount: result.failedLeagues.length ? draft.catalog.consecutiveErrorCount + 1 : 0,
        };
      });
      if (result.failedLeagues.length) {
        this.addAlert('warning', 'catalog_partial', `${result.failedLeagues.length} leagues failed during orderbook polling`, result.failedLeagues.join(', '));
      } else {
        this.state.alerts = this.state.alerts.filter(alert => alert.code !== 'catalog_partial' && alert.code !== 'catalog_failed' && alert.code !== 'leagues_failed');
      }
      this.updateHealthyStatus();
      this.persist();
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.state.catalog.lastError = message;
      this.state.catalog.stale = true;
      this.state.catalog.consecutiveErrorCount++;
      this.addAlert('error', 'catalog_failed', 'Catalog polling failed', message);
      this.setStatus('degraded');
      this.persist();
    }
  }

  private async refreshBalance(): Promise<void> {
    if (!this.hasToken()) return;
    const attemptAt = new Date().toISOString();
    try {
      const user = await getMe();
      const snapshot = this.balanceSnapshot(user);
      this.commitPolledState(draft => {
        draft.balance = { ...snapshot, lastAttemptAt: attemptAt, lastOkAt: snapshot.updatedAt, stale: false, consecutiveErrorCount: 0 };
        const today = new Date().toISOString().slice(0, 10);
        if (!draft.dayOpenBalance || draft.dayOpenBalance.date !== today) {
          draft.dayOpenBalance = { date: today, balance: snapshot.balance, capturedAt: snapshot.updatedAt };
        }
      });
      this.state.alerts = this.state.alerts.filter(alert => alert.code !== 'balance_failed' && alert.code !== 'token_needed' && alert.code !== 'unauthorized');
      this.updateHealthyStatus();
      this.persist();
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (this.state.balance) {
        this.state.balance.lastAttemptAt = attemptAt;
        this.state.balance.lastError = message;
        this.state.balance.stale = true;
        this.state.balance.consecutiveErrorCount++;
      }
      this.addAlert('error', 'balance_failed', 'Balance polling failed', message);
      this.setStatus('degraded');
      this.persist();
    }
  }

  /** Account-wide positions poll: normalize, stitch, diff, evaluate rules. Read-only. */
  private async refreshPositions(): Promise<void> {
    if (!this.hasToken()) return;
    const attemptAt = new Date().toISOString();
    try {
      const [rawUnmatched, rawMatched] = await Promise.all([getUnmatched(), getMatchedBets()]);
      const nowIso = new Date().toISOString();
      this.commitPolledState(draft => {
        draft.positions = {
          ...buildPositionsSnapshot({
          rawUnmatched,
          rawMatched,
          games: draft.catalog.games,
          prev: draft.positions,
          caches: draft.runtimeCaches,
          nowIso,
          }),
          lastAttemptAt: attemptAt,
          stale: false,
          consecutiveErrorCount: 0,
        };
        pruneRuntimeCaches(draft.runtimeCaches, Date.now());
      });
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (this.state.positions) {
        this.state.positions.lastAttemptAt = attemptAt;
        this.state.positions.lastError = message;
        this.state.positions.stale = true;
        this.state.positions.consecutiveErrorCount = (this.state.positions.consecutiveErrorCount ?? 0) + 1;
      }
      this.addAlert('warning', 'positions_failed', 'Positions polling failed', message);
      this.persist();
    }
  }

  private balanceSnapshot(user: UserProfile): BalanceSnapshot {
    return {
      id: user.id,
      username: user.username,
      balance: user.balance,
      displayBalance: user.displayBalance,
      creditLimit: user.creditLimit,
      oddsFormat: user.oddsFormat,
      updatedAt: new Date().toISOString(),
      stale: false,
      consecutiveErrorCount: 0,
    };
  }

  private async refreshWatchedOrders(): Promise<void> {
    if (!this.hasToken()) return;
    try {
      for (const gameID of this.state.watchList) {
        await this.refreshOrdersForGame(gameID);
      }
      this.updateHealthyStatus();
    } finally {
      this.persist();
    }
  }

  private async refreshOrdersForGame(gameID: string): Promise<void> {
    if (!this.hasToken()) return;
    const attemptAt = new Date().toISOString();
    try {
      const orders = await getOrdersForGame(gameID);
      this.state.ordersByGame[gameID] = {
        unmatched: orders.unmatched ?? [],
        matched: orders.matched ?? [],
        updatedAt: new Date().toISOString(),
        lastAttemptAt: attemptAt,
        lastOkAt: new Date().toISOString(),
        stale: false,
        consecutiveErrorCount: 0,
      };
      this.state.alerts = this.state.alerts.filter(alert => alert.code !== `orders_failed_${gameID}`);
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.state.ordersByGame[gameID] = {
        ...(this.state.ordersByGame[gameID] ?? { unmatched: [], matched: [] }),
        lastAttemptAt: attemptAt,
        lastError: message,
        stale: true,
        consecutiveErrorCount: (this.state.ordersByGame[gameID]?.consecutiveErrorCount ?? 0) + 1,
      };
      this.addAlert('error', `orders_failed_${gameID}`, `Order polling failed for ${gameID}`, message);
      this.setStatus('degraded');
    }
  }

  /** A write should not wait for the next eight-second catalog cycle to refresh its game. */
  private async refreshGameOrderbook(gameID: string): Promise<void> {
    if (!this.hasToken() || !gameID) return;
    try {
      const game = await getOrderbookForGame(gameID);
      if (!game) return;
      const index = this.state.catalog.games.findIndex(item => item.id === gameID);
      if (index >= 0) this.state.catalog.games[index] = game;
      else this.state.catalog.games.push(game);
      this.state.catalog.updatedAt = new Date().toISOString();
      this.state.catalog.lastOkAt = this.state.catalog.updatedAt;
      this.state.catalog.lastError = undefined;
      this.state.catalog.stale = false;
      this.state.catalog.consecutiveErrorCount = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.addAlert('warning', `targeted_orderbook_${gameID}`, `Post-write orderbook reconcile failed for ${gameID}`, message);
    }
  }

  /** Hourly exchange-backed realized P&L snapshot; never derive settlement from balance movements. */
  private async refreshSettlements(): Promise<void> {
    if (!this.hasToken()) return;
    const attemptAt = new Date().toISOString();
    this.state.settlement.lastAttemptAt = attemptAt;
    try {
      const today = new Date();
      // Include yesterday: late grading after midnight is common enough to be worth retaining.
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1_000);
      const startDate = formatExchangeDate(yesterday);
      const endDate = formatExchangeDate(today);
      const result = await getGradedWagers(startDate, endDate);
      const entry = settlementEntry(result, startDate, endDate, attemptAt);
      this.state.settlementJournal.push(entry);
      this.state.settlement.latest = entry;
      this.state.settlement.lastOkAt = attemptAt;
      this.state.settlement.lastError = undefined;
      this.state.settlement.stale = false;
      this.state.settlement.consecutiveErrorCount = 0;
      this.state.alerts = this.state.alerts.filter(alert => alert.code !== 'settlement_failed');
      this.updateHealthyStatus();
      this.persist();
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.state.settlement.lastError = message;
      this.state.settlement.stale = true;
      this.state.settlement.consecutiveErrorCount++;
      this.addAlert('warning', 'settlement_failed', 'Settlement P&L poll failed; prior exchange snapshot remains available', message);
      this.updateHealthyStatus();
      this.persist();
    }
  }

  private async scanCommands(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.config.commandsDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith('.json') || this.processing.has(file)) continue;
      this.processing.add(file);
      void this.processCommandFile(file).finally(() => this.processing.delete(file));
    }
  }

  private async processCommandFile(file: string): Promise<void> {
    const source = join(this.config.commandsDir, file);
    const processing = join(this.config.commandsDir, `${file}.processing`);
    try {
      renameSync(source, processing);
    } catch {
      return;
    }

    let command: CommandEnvelope | null = null;
    try {
      command = JSON.parse(readFileSync(processing, 'utf8')) as CommandEnvelope;
      const result = await this.handleCommand(command);
      this.writeResponse({ id: command.id, ok: true, ts: Date.now(), result });
    } catch (err) {
      const id = command?.id ?? file.replace(/\.json$/, '');
      const error = err instanceof Error ? err.message : String(err);
      this.writeResponse({ id, ok: false, ts: Date.now(), error });
      this.addAlert('error', 'command_failed', `Command failed: ${command?.action ?? file}`, error);
      this.persist();
    } finally {
      rmSync(processing, { force: true });
    }
  }

  private writeResponse(response: CommandResponse): void {
    const path = join(this.config.responsesDir, `${response.id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(response, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  }

  private async handleCommand(command: CommandEnvelope): Promise<unknown> {
    switch (command.action) {
      case 'watch':
        return this.watchGame(asWatch(command.payload).gameID);
      case 'unwatch':
        return this.unwatchGame(asWatch(command.payload).gameID);
      case 'place':
        return this.place(asPlace(command.payload));
      case 'cancel':
        return this.cancel(asCancel(command.payload));
      case 'cancelAll':
        return this.cancelAll(asCancelAll(command.payload));
      case 'unmatched':
        return this.readUnmatched();
      case 'matched':
        return this.readMatched();
      case 'graded':
        return this.readGraded(asGraded(command.payload));
      case 'pnl':
        return this.readPnl(asPnl(command.payload));
      case 'lookup':
        return this.lookup(asLookup(command.payload));
      case 'bet':
        return this.readBet(asBet(command.payload));
      case 'wagerRequest':
        return this.readWagerRequest(asWagerRequest(command.payload));
      case 'liability':
        return this.readLiability(asLiability(command.payload));
      case 'cancelMultiple':
        return this.cancelMultipleCmd(asCancelMultiple(command.payload));
      case 'cancelAllForLeague':
        return this.cancelLeagueCmd(asCancelLeague(command.payload));
      case 'cancelAllOrders':
        return this.cancelAllOrdersCmd();
      case 'cancelByReference':
        return this.cancelByReferenceCmd(asCancelReference(command.payload));
      case 'editOrder':
        return this.editOrderCmd(asEditOrder(command.payload));
      case 'participants':
        return this.readParticipants(asParticipants(command.payload));
      case 'gamesIndex':
        return this.readGamesIndex(asGamesIndex(command.payload));
      case 'averagePrice':
        return this.readAveragePrice(asAveragePrice(command.payload));
      case 'singleOrderbook':
        return this.readSingleOrderbook(asSingleOrderbook(command.payload));
      case 'affiliateCommission':
        return this.readAffiliateCommission(asAffiliate(command.payload));
      case 'settlementJournal':
        return this.readSettlementJournal();
      case 'refresh':
        // Route through the serialized scheduler so polls never overlap.
        this.scheduler?.requestNow('catalog');
        this.scheduler?.requestNow('balance');
        this.scheduler?.requestNow('orders');
        this.scheduler?.requestNow('positions');
        return { refreshed: true, queued: true, status: this.state.status };
    }
  }

  private requireToken(action: string): void {
    if (!this.hasToken()) throw new Error(`FOURCASTER_AUTH_TOKEN is required for ${action}`);
  }

  private async readUnmatched(): Promise<unknown> {
    this.requireToken('unmatched');
    return { unmatched: await getUnmatched() };
  }

  private async readMatched(): Promise<unknown> {
    this.requireToken('matched');
    return { matched: await getMatchedBets() };
  }

  private async readGraded(payload: GradedPayload): Promise<unknown> {
    this.requireToken('graded');
    return getBetByUserReference(payload.userReference, payload.gameID);
  }

  private async readPnl(payload: PnlPayload): Promise<unknown> {
    this.requireToken('pnl');
    return getGradedWagers(payload.startDate, payload.endDate);
  }

  private async lookup(payload: LookupPayload): Promise<unknown> {
    this.requireToken('lookup');
    const order = await lookupOrder(payload.orderID);
    const record = this.state.lifecycle.find(item => item.orderIDs.includes(payload.orderID));
    if (record) {
      record.lastLookup = order;
      record.updatedAt = new Date().toISOString();
      record.status = order.cancelled ? 'cancelled' : record.status;
      this.persist();
    }
    return order;
  }

  private async readBet(payload: BetPayload): Promise<unknown> {
    this.requireToken('bet');
    return getBetById(payload);
  }

  private async readWagerRequest(payload: WagerRequestPayload): Promise<unknown> {
    this.requireToken('wager-request');
    return getBetByWagerRequestId(payload.wagerRequestID);
  }

  private async readParticipants(payload: ParticipantsPayload): Promise<unknown> {
    this.requireToken('participants');
    const attemptAt = new Date().toISOString();
    this.state.participants.lastAttemptAt = attemptAt;
    try {
      const items = await getParticipants(payload.active);
      this.state.participants = {
        active: payload.active,
        items,
        lastAttemptAt: attemptAt,
        lastOkAt: new Date().toISOString(),
        stale: false,
        consecutiveErrorCount: 0,
      };
      this.persist();
      return { participants: items, freshness: this.state.participants };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.participants.lastError = message;
      this.state.participants.stale = true;
      this.state.participants.consecutiveErrorCount++;
      this.persist();
      throw err;
    }
  }

  private async readGamesIndex(payload: GamesIndexPayload): Promise<unknown> {
    this.requireToken('discover-games');
    return { games: await getGamesIndex(payload.league, payload.sport) };
  }

  private async readAveragePrice(payload: AveragePricePayload): Promise<unknown> {
    this.requireToken('average-price');
    return getAveragePrice(payload.leagueRequested);
  }

  private async readSingleOrderbook(payload: SingleOrderbookPayload): Promise<unknown> {
    this.requireToken('single-orderbook');
    return getSingleOrderbook(payload.gameID);
  }

  private async readAffiliateCommission(payload: AffiliatePayload): Promise<unknown> {
    this.requireToken('affiliate-commission');
    return getAffiliateCommission(payload.fromDate, payload.toDate);
  }

  private readSettlementJournal(): unknown {
    return { settlement: this.state.settlement, entries: this.state.settlementJournal };
  }

  private async readLiability(payload: LiabilityPayload): Promise<unknown> {
    this.requireToken('liability');
    const liability = await getGameLiability(payload.gameID);
    return { gameID: payload.gameID, liability };
  }

  private async cancelMultipleCmd(payload: CancelMultiplePayload): Promise<unknown> {
    if (payload.sessionIDs.length === 0) throw new Error('sessionIDs must be a non-empty list');
    if (!this.config.live) {
      this.record(makeActivity('CANCEL', 'Dry-run cancel-multiple preview', JSON.stringify(payload)));
      this.persist();
      return { submitted: false, dryRun: true, dryRunReason: 'LIVE=0', ...payload };
    }
    this.requireToken('cancel-multiple');
    const result = await cancelMultiple(payload.sessionIDs);
    this.record(makeActivity('CANCEL', `Cancelled ${payload.sessionIDs.length} orders`, JSON.stringify(result)));
    await Promise.allSettled([...this.state.watchList.map(id => this.refreshOrdersForGame(id)), this.refreshPositions(), this.refreshBalance()]);
    this.persist();
    return { submitted: true, dryRun: false, result };
  }

  private async cancelLeagueCmd(payload: CancelLeaguePayload): Promise<unknown> {
    if (!this.config.live) {
      this.record(makeActivity('CANCEL', 'Dry-run cancel-all-league preview', JSON.stringify(payload)));
      this.persist();
      return { submitted: false, dryRun: true, dryRunReason: 'LIVE=0', ...payload };
    }
    this.requireToken('cancel-all-league');
    const result = await cancelAllForLeague(payload.league);
    this.record(makeActivity('CANCEL', `Cancelled all orders for league ${payload.league}`, JSON.stringify(result)));
    await Promise.allSettled([...this.state.watchList.map(id => this.refreshOrdersForGame(id)), this.refreshPositions(), this.refreshBalance()]);
    this.persist();
    return { submitted: true, dryRun: false, result };
  }

  private async cancelAllOrdersCmd(): Promise<unknown> {
    if (!this.config.live) {
      this.record(makeActivity('CANCEL', 'Dry-run cancel-all-orders preview'));
      this.persist();
      return { submitted: false, dryRun: true, dryRunReason: 'LIVE=0' };
    }
    this.requireToken('cancel-all-orders');
    const result = await cancelAllOrders();
    this.record(makeActivity('CANCEL', 'Cancelled all open orders', JSON.stringify(result)));
    await Promise.allSettled([...this.state.watchList.map(id => this.refreshOrdersForGame(id)), this.refreshPositions(), this.refreshBalance()]);
    this.persist();
    return { submitted: true, dryRun: false, result };
  }

  private async cancelByReferenceCmd(payload: CancelReferencePayload): Promise<unknown> {
    if (payload.userReferences.length === 0) throw new Error('userReferences must be a non-empty list');
    if (!this.config.live) {
      this.record(makeActivity('CANCEL', 'Dry-run cancel-by-reference preview', JSON.stringify(payload)));
      this.persist();
      return { submitted: false, dryRun: true, dryRunReason: 'LIVE=0', ...payload };
    }
    this.requireToken('cancel-by-reference');
    const result = await cancelByReference(payload.gameID, payload.userReferences);
    this.markLifecycleCancelledByReference(payload.userReferences);
    this.record(makeActivity('CANCEL', `Cancelled ${payload.userReferences.length} references for ${payload.gameID}`, JSON.stringify(result)));
    await Promise.allSettled([this.refreshGameOrderbook(payload.gameID), this.refreshOrdersForGame(payload.gameID), this.refreshPositions(), this.refreshBalance()]);
    this.persist();
    return { submitted: true, dryRun: false, result };
  }

  private async editOrderCmd(payload: EditOrderPayload): Promise<unknown> {
    if (!Number.isFinite(payload.odds) || payload.odds === 0) throw new Error('odds must be a non-zero number');
    if (!Number.isFinite(payload.bet) || payload.bet <= 0) throw new Error('bet must be greater than 0');
    if (payload.bet > this.config.maxBet) throw new Error(`bet ${payload.bet} exceeds MAX_BET ${this.config.maxBet}`);

    const confirm = payload.confirm === true;
    const dryRunReason = !this.config.live ? 'LIVE=0' : !confirm ? 'missing --confirm' : !payload.confirmReplace ? 'missing --confirm-replace' : null;
    if (dryRunReason) {
      this.record(makeActivity('ORDER', 'Dry-run edit-order preview', JSON.stringify(payload)));
      this.persist();
      return {
        submitted: false,
        dryRun: true,
        dryRunReason,
        requiresConfirmReplace: true,
        note: 'edit-order is cancel-and-replace; the new volume is not the remaining volume after partial fills',
        request: { sessionID: payload.sessionID, replacementOdds: payload.odds, replacementBet: payload.bet },
      };
    }
    this.requireToken('edit-order');
    const current = await lookupOrder(payload.sessionID);
    if (current.cancelled) throw new Error('Cannot edit a cancelled order');
    const record = this.state.lifecycle.find(item => item.orderIDs.includes(payload.sessionID));
    if (!record) throw new Error('Guarded edit requires an order placed by this daemon (no lifecycle record found); use cancel + place explicitly');
    record.status = 'edited';
    record.updatedAt = new Date().toISOString();
    record.lastLookup = current;

    // Do not call the undocumented/destructive v4 endpoint. The two documented writes
    // make the cancellation and the replacement independently observable and auditable.
    const cancellation = await cancelOrder(payload.sessionID);
    if (!cancellation.success) throw new Error(`Exchange did not confirm cancellation of ${payload.sessionID}`);
    // Persist this boundary before the second write: a replacement failure must never
    // make the ledger claim that the original order is still resting.
    record.status = 'cancelled';
    record.updatedAt = new Date().toISOString();
    this.persist();
    const replacementOrder: PlaceV3Order = {
      ...record.order,
      odds: payload.odds,
      bet: payload.bet,
      userReference: makeReplacementReference(),
    };
    const sessions = await placeOrders([replacementOrder]);
    const replacement = this.addLifecycleRecord(replacementOrder, sessions, {
      parentLifecycleID: record.id,
      replacesOrderID: payload.sessionID,
    });
    record.status = 'replaced';
    record.replacementLifecycleID = replacement.id;
    record.updatedAt = new Date().toISOString();
    this.record(makeActivity('ORDER', `Replaced order ${payload.sessionID}`, JSON.stringify({ cancellation, replacementOrder, sessions })));
    const game = current.game as { id?: unknown } | undefined;
    const gameID = typeof game?.id === 'string' ? game.id : record.gameID;
    await Promise.allSettled([...(gameID ? [this.refreshGameOrderbook(gameID), this.refreshOrdersForGame(gameID)] : []), this.refreshPositions(), this.refreshBalance()]);
    this.persist();
    return { submitted: true, dryRun: false, previous: current, cancellation, replacementOrder, sessions, lifecycle: { previousID: record.id, replacementID: replacement.id } };
  }

  private async watchGame(gameID: string): Promise<unknown> {
    if (!this.state.watchList.includes(gameID)) {
      this.state.watchList.push(gameID);
    }
    await this.refreshOrdersForGame(gameID);
    this.refreshPriceSubscription();
    this.record(makeActivity('GAME', `Watching game ${gameID}`));
    this.persist();
    return { ok: true, watched: this.state.watchList };
  }

  private unwatchGame(gameID: string): unknown {
    this.state.watchList = this.state.watchList.filter(id => id !== gameID);
    delete this.state.ordersByGame[gameID];
    this.refreshPriceSubscription();
    this.record(makeActivity('GAME', `Stopped watching game ${gameID}`));
    this.persist();
    return { ok: true, watched: this.state.watchList };
  }

  private validateOrder(order: PlaceV3Order): void {
    if (!order.gameID) throw new Error('order.gameID is required');
    if (!order.side) throw new Error('order.side is required');
    if (!Number.isFinite(order.odds) || order.odds === 0) throw new Error('order.odds must be a non-zero number');
    if (!Number.isFinite(order.bet) || order.bet <= 0) throw new Error('order.bet must be greater than 0');
    if (order.bet > this.config.maxBet) {
      throw new Error(`Order bet ${order.bet} exceeds MAX_BET ${this.config.maxBet}`);
    }
  }

  private async place(payload: PlacePayload): Promise<unknown> {
    this.validateOrder(payload.order);

    const confirm = payload.confirm === true;
    const dryRunReason =
      !this.config.live ? 'LIVE=0' :
      !confirm ? 'missing --confirm' :
      null;

    if (dryRunReason) {
      this.record(makeActivity('ORDER', 'Dry-run place preview', JSON.stringify({
        reason: dryRunReason,
        order: payload.order,
        request: payload.request,
      })));
      this.persist();
      return {
        submitted: false,
        dryRun: true,
        dryRunReason,
        live: this.config.live,
        requiresConfirm: this.config.live,
        order: payload.order,
        request: payload.request,
      };
    }

    if (!this.hasToken()) throw new Error('FOURCASTER_AUTH_TOKEN is required for live order placement');

    const now = Date.now();
    const dedupeShape = {
      gameId: payload.order.gameID,
      type: payload.order.type,
      side: payload.order.side,
      odds: payload.order.odds,
      bet: payload.order.bet,
      number: payload.order.number,
      userReference: payload.order.userReference,
    };
    const dedupe = this.dedupe.check(dedupeShape, now);
    if (!dedupe.allow) throw new Error(`Duplicate order blocked: ${dedupe.reason}`);

    const order = { ...payload.order, userReference: dedupe.clientRef };
    const sessions = await placeOrders([order]);
    const rejected = sessions.some(session => session?.error);
    if (rejected) {
      this.dedupe.forget(dedupe.clientRef);
      this.record(makeActivity('ERROR', 'Order rejected', JSON.stringify({ order, sessions })));
    } else {
      this.dedupe.commit(dedupeShape, dedupe.clientRef, now);
      this.addLifecycleRecord(order, sessions);
      this.record(makeActivity('ORDER', 'Order submitted', JSON.stringify({ order, sessions })));
    }

    await Promise.allSettled([
      this.refreshGameOrderbook(order.gameID),
      this.refreshOrdersForGame(order.gameID),
      this.refreshPositions(),
      this.refreshBalance(),
    ]);
    this.persist();

    return {
      submitted: true,
      dryRun: false,
      order,
      sessions,
    };
  }

  private async cancel(payload: CancelPayload): Promise<unknown> {
    if (!payload.sessionID) throw new Error('sessionID is required');
    if (!this.config.live) {
      this.record(makeActivity('CANCEL', 'Dry-run cancel preview', JSON.stringify(payload)));
      this.persist();
      return { submitted: false, dryRun: true, dryRunReason: 'LIVE=0', ...payload };
    }
    if (!this.hasToken()) throw new Error('FOURCASTER_AUTH_TOKEN is required for cancel');

    const result = await cancelOrder(payload.sessionID);
    this.markLifecycleCancelled(payload.sessionID);
    this.record(makeActivity('CANCEL', `Cancelled order ${payload.sessionID}`, JSON.stringify(result)));
    await this.refreshAfterCancel(result);
    this.persist();
    return { submitted: true, dryRun: false, result };
  }

  private async cancelAll(payload: CancelAllPayload): Promise<unknown> {
    if (!payload.gameID) throw new Error('gameID is required');
    if (!this.config.live) {
      this.record(makeActivity('CANCEL', 'Dry-run cancel-all preview', JSON.stringify(payload)));
      this.persist();
      return { submitted: false, dryRun: true, dryRunReason: 'LIVE=0', ...payload };
    }
    if (!this.hasToken()) throw new Error('FOURCASTER_AUTH_TOKEN is required for cancel-all');

    const result = await cancelAllForGame(payload.gameID, payload.type);
    this.record(makeActivity('CANCEL', `Cancelled all orders for ${payload.gameID}`, JSON.stringify(result)));
    await Promise.allSettled([this.refreshGameOrderbook(payload.gameID), this.refreshOrdersForGame(payload.gameID), this.refreshPositions(), this.refreshBalance()]);
    this.persist();
    return { submitted: true, dryRun: false, result };
  }

  private async refreshAfterCancel(result: CancelResult): Promise<void> {
    const gameID = result.gameID;
    if (gameID) {
      await Promise.allSettled([this.refreshGameOrderbook(gameID), this.refreshOrdersForGame(gameID), this.refreshPositions(), this.refreshBalance()]);
      return;
    }
    await Promise.allSettled([
      ...this.state.watchList.map(id => this.refreshOrdersForGame(id)),
      this.refreshPositions(),
      this.refreshBalance(),
    ]);
  }

  private hasRestingOrders(): boolean {
    return (this.state.positions?.unmatched.length ?? 0) > 0 || Object.values(this.state.ordersByGame).some(orders => orders.unmatched.length > 0);
  }

  private async sendHeartbeatIfNeeded(): Promise<void> {
    if (!this.config.live || this.config.heartbeatSec <= 5 || !this.hasRestingOrders()) return;
    this.state.heartbeat.lastAttemptAt = new Date().toISOString();
    try {
      await sendOrdersHeartbeat(this.config.heartbeatSec);
      this.state.heartbeat.lastOkAt = new Date().toISOString();
      this.state.heartbeat.lastError = undefined;
      this.state.alerts = this.state.alerts.filter(alert => alert.code !== 'heartbeat_failed');
      this.persist();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.heartbeat.lastError = message;
      this.addAlert('error', 'heartbeat_failed', 'Orders heartbeat failed; all open account orders may be cancelled when its timeout expires', message);
      this.persist();
      throw err;
    }
  }

  private addLifecycleRecord(
    order: PlaceV3Order,
    sessions: unknown,
    links: Pick<OrderLifecycleRecord, 'parentLifecycleID' | 'replacesOrderID'> = {},
  ): OrderLifecycleRecord {
    const { orderIDs, wagerRequestIDs } = extractExchangeIds(sessions);
    const now = new Date().toISOString();
    const record: OrderLifecycleRecord = {
      id: randomUUID(), createdAt: now, updatedAt: now, gameID: order.gameID,
      userReference: order.userReference ?? '', order, orderIDs, wagerRequestIDs,
      sessionResponse: sessions, status: 'submitted', ...links,
    };
    this.state.lifecycle.push(record);
    return record;
  }

  private markLifecycleCancelled(orderID: string): void {
    for (const record of this.state.lifecycle) {
      if (record.orderIDs.includes(orderID)) { record.status = 'cancelled'; record.updatedAt = new Date().toISOString(); }
    }
  }

  private markLifecycleCancelledByReference(references: string[]): void {
    const wanted = new Set(references);
    for (const record of this.state.lifecycle) {
      if (wanted.has(record.userReference)) { record.status = 'cancelled'; record.updatedAt = new Date().toISOString(); }
    }
  }
}

function formatExchangeDate(value: Date): string {
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${month}-${day}-${value.getUTCFullYear()}`;
}

function settlementEntry(raw: unknown, startDate: string, endDate: string, capturedAt: string): SettlementJournalEntry {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const wagers = Array.isArray(data.wagers) ? data.wagers : [];
  const summary = data.summary && typeof data.summary === 'object' && !Array.isArray(data.summary)
    ? data.summary as Record<string, unknown>
    : undefined;
  return { id: randomUUID(), capturedAt, startDate, endDate, wagerCount: wagers.length, ...(summary ? { summary } : {}) };
}

function makeReplacementReference(): string {
  // Preserve the original reference in the lifecycle chain; exchange-facing references
  // remain unique so a later cancel-by-reference cannot cancel both generations.
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  return `4c-${Date.now()}-replace-${suffix}`;
}

function extractExchangeIds(value: unknown): { orderIDs: string[]; wagerRequestIDs: string[] } {
  const orderIDs = new Set<string>();
  const wagerRequestIDs = new Set<string>();
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(walk); return; }
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    if (typeof obj.orderID === 'string') orderIDs.add(obj.orderID);
    if (typeof obj.wagerRequestID === 'string') wagerRequestIDs.add(obj.wagerRequestID);
    Object.values(obj).forEach(walk);
  };
  walk(value);
  return { orderIDs: [...orderIDs], wagerRequestIDs: [...wagerRequestIDs] };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Command payload must be an object');
  return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

function asWatch(value: unknown): WatchPayload {
  const obj = asObject(value);
  return { gameID: asString(obj.gameID, 'gameID') };
}

function asCancel(value: unknown): CancelPayload {
  const obj = asObject(value);
  return { sessionID: asString(obj.sessionID, 'sessionID') };
}

function asCancelAll(value: unknown): CancelAllPayload {
  const obj = asObject(value);
  const type = obj.type;
  if (type !== undefined && type !== 'moneyline' && type !== 'spread' && type !== 'total' && type !== 'moneyline1x2') {
    throw new Error('type must be moneyline, spread, total, or moneyline1x2');
  }
  return {
    gameID: asString(obj.gameID, 'gameID'),
    ...(type ? { type: type as PlaceMarketType } : {}),
  };
}

function asPlace(value: unknown): PlacePayload {
  const obj = asObject(value);
  const order = obj.order;
  if (!order || typeof order !== 'object') throw new Error('order is required');
  return {
    order: order as PlaceV3Order,
    confirm: obj.confirm === true,
    request: obj.request,
  };
}

function asGraded(value: unknown): GradedPayload {
  const obj = asObject(value);
  return {
    userReference: asString(obj.userReference, 'userReference'),
    ...(typeof obj.gameID === 'string' && obj.gameID ? { gameID: obj.gameID } : {}),
  };
}

function asPnl(value: unknown): PnlPayload {
  const obj = asObject(value);
  return {
    ...(typeof obj.startDate === 'string' && obj.startDate ? { startDate: obj.startDate } : {}),
    ...(typeof obj.endDate === 'string' && obj.endDate ? { endDate: obj.endDate } : {}),
  };
}

function asLookup(value: unknown): LookupPayload {
  const obj = asObject(value);
  return { orderID: asString(obj.orderID, 'orderID') };
}

function asBet(value: unknown): BetPayload {
  const obj = asObject(value);
  const id = typeof obj.id === 'string' && obj.id ? obj.id : undefined;
  const txID = typeof obj.txID === 'string' && obj.txID ? obj.txID : undefined;
  if ((id ? 1 : 0) + (txID ? 1 : 0) !== 1) throw new Error('Pass exactly one of id or txID');
  return { ...(id ? { id } : {}), ...(txID ? { txID } : {}) };
}

function asWagerRequest(value: unknown): WagerRequestPayload {
  const obj = asObject(value);
  return { wagerRequestID: asString(obj.wagerRequestID, 'wagerRequestID') };
}

function asLiability(value: unknown): LiabilityPayload {
  const obj = asObject(value);
  return { gameID: asString(obj.gameID, 'gameID') };
}

function asCancelMultiple(value: unknown): CancelMultiplePayload {
  const obj = asObject(value);
  if (!Array.isArray(obj.sessionIDs) || obj.sessionIDs.some(id => typeof id !== 'string' || !id)) {
    throw new Error('sessionIDs must be a non-empty array of strings');
  }
  return { sessionIDs: obj.sessionIDs as string[] };
}

function asCancelLeague(value: unknown): CancelLeaguePayload {
  const obj = asObject(value);
  return { league: asString(obj.league, 'league') };
}

function asCancelReference(value: unknown): CancelReferencePayload {
  const obj = asObject(value);
  if (!Array.isArray(obj.userReferences) || obj.userReferences.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('userReferences must be a non-empty array of strings');
  }
  return { gameID: asString(obj.gameID, 'gameID'), userReferences: obj.userReferences as string[] };
}

function asParticipants(value: unknown): ParticipantsPayload {
  const obj = asObject(value);
  if (obj.active !== undefined && typeof obj.active !== 'boolean') throw new Error('active must be a boolean');
  return obj.active === undefined ? {} : { active: obj.active };
}

function asGamesIndex(value: unknown): GamesIndexPayload {
  const obj = asObject(value);
  return {
    league: asString(obj.league, 'league'),
    ...(typeof obj.sport === 'string' && obj.sport ? { sport: obj.sport } : {}),
  };
}

function asAveragePrice(value: unknown): AveragePricePayload {
  const obj = asObject(value);
  return { leagueRequested: asString(obj.leagueRequested, 'leagueRequested') };
}

function asSingleOrderbook(value: unknown): SingleOrderbookPayload {
  const obj = asObject(value);
  return { gameID: asString(obj.gameID, 'gameID') };
}

function asAffiliate(value: unknown): AffiliatePayload {
  const obj = asObject(value);
  return {
    ...(typeof obj.fromDate === 'string' && obj.fromDate ? { fromDate: obj.fromDate } : {}),
    ...(typeof obj.toDate === 'string' && obj.toDate ? { toDate: obj.toDate } : {}),
  };
}

function asEditOrder(value: unknown): EditOrderPayload {
  const obj = asObject(value);
  if (typeof obj.odds !== 'number') throw new Error('odds must be a number');
  if (typeof obj.bet !== 'number') throw new Error('bet must be a number');
  return {
    sessionID: asString(obj.sessionID, 'sessionID'),
    odds: obj.odds,
    bet: obj.bet,
    confirm: obj.confirm === true,
    confirmReplace: obj.confirmReplace === true,
  };
}

function emptyOrdersCache(): OrdersCache {
  return { unmatched: [], matched: [], stale: false, consecutiveErrorCount: 0 };
}

async function main(): Promise<void> {
  const daemon = new FourcasterDaemon();
  await daemon.start();

  const stop = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(err => {
  log.error(err);
  process.exitCode = 1;
});
