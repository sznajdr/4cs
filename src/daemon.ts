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
  cancelMultiple,
  getAvailableLeagues,
  getBetByUserReference,
  getGameLiability,
  getMatchedBets,
  getUnmatched,
  cancelOrder,
  getGames,
  getMe,
  getOrdersForGame,
  isRateLimitError,
  placeOrders,
  setRateLimitedHandler,
  setToken,
  setUnauthorizedHandler,
} from './api/rest.js';
import { PollScheduler } from './scheduler/pollScheduler.js';
import { buildPositionsSnapshot } from './positions/normalize.js';
import { DEFAULT_LEAGUES } from './lib/leagues.js';
import type { CancelResult, PlaceMarketType, PlaceV3Order, UserProfile } from './api/types.js';
import { OrderDedupe } from './lib/orderDedupe.js';
import {
  defaultState,
  readStateSync,
  writeStateAtomic,
  type AlertEntry,
  type BalanceSnapshot,
  type DaemonStatus,
  type StateSnapshot,
} from './state.js';
import { log } from './log.js';

const EDIT_ORDER_DISABLED =
  'edit-order is disabled: /session/editOrder cancels-then-replaces and its replacement-stake ' +
  'field is undocumented — a wrong payload cancels your order without replacing it. Use `cancel` then `place`.';

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
}

class FourcasterDaemon {
  private config: RuntimeConfig;
  private state: StateSnapshot;
  private timers: NodeJS.Timeout[] = [];
  private processing = new Set<string>();
  private dedupe = new OrderDedupe();
  private stopping = false;
  private scheduler: PollScheduler | null = null;

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

    // Command scanning stays frequent; exchange writes still flow through the guarded handlers.
    this.timers.push(setInterval(() => void this.scanCommands(), 250));

    log.warn(`4caster daemon ready: LIVE=${this.config.live ? '1' : '0'} MAX_BET=${this.config.maxBet}`);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.scheduler?.stop();
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
    const hasCatalogError = Boolean(this.state.catalog.lastError);
    const hasOrderErrors = Object.values(this.state.ordersByGame).some(order => Boolean(order.lastError));
    this.setStatus(hasCatalogError || hasOrderErrors ? 'degraded' : 'running');
  }

  private async refreshCatalog(): Promise<void> {
    if (!this.hasToken()) {
      this.state.catalog.lastError = 'token_needed';
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
        draft.catalog = {
          games: result.games,
          failedLeagues: result.failedLeagues,
          updatedAt: now,
          lastOkAt: now,
          ...(result.failedLeagues.length ? { lastError: `Failed leagues: ${result.failedLeagues.join(', ')}` } : {}),
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
      this.addAlert('error', 'catalog_failed', 'Catalog polling failed', message);
      this.setStatus('degraded');
      this.persist();
    }
  }

  private async refreshBalance(): Promise<void> {
    if (!this.hasToken()) return;
    try {
      const user = await getMe();
      const snapshot = this.balanceSnapshot(user);
      this.commitPolledState(draft => {
        draft.balance = snapshot;
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
      this.addAlert('error', 'balance_failed', 'Balance polling failed', message);
      this.setStatus('degraded');
      this.persist();
    }
  }

  /** Account-wide positions poll: normalize, stitch, diff, evaluate rules. Read-only. */
  private async refreshPositions(): Promise<void> {
    if (!this.hasToken()) return;
    try {
      const [rawUnmatched, rawMatched] = await Promise.all([getUnmatched(), getMatchedBets()]);
      const nowIso = new Date().toISOString();
      this.commitPolledState(draft => {
        draft.positions = buildPositionsSnapshot({
          rawUnmatched,
          rawMatched,
          games: draft.catalog.games,
          prev: draft.positions,
          caches: draft.runtimeCaches,
          nowIso,
        });
      });
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (this.state.positions) {
        this.state.positions.lastError = message;
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
    try {
      const orders = await getOrdersForGame(gameID);
      this.state.ordersByGame[gameID] = {
        unmatched: orders.unmatched ?? [],
        matched: orders.matched ?? [],
        updatedAt: new Date().toISOString(),
      };
      this.state.alerts = this.state.alerts.filter(alert => alert.code !== `orders_failed_${gameID}`);
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.state.ordersByGame[gameID] = {
        ...(this.state.ordersByGame[gameID] ?? { unmatched: [], matched: [] }),
        lastError: message,
      };
      this.addAlert('error', `orders_failed_${gameID}`, `Order polling failed for ${gameID}`, message);
      this.setStatus('degraded');
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
      case 'liability':
        return this.readLiability(asLiability(command.payload));
      case 'cancelMultiple':
        return this.cancelMultipleCmd(asCancelMultiple(command.payload));
      case 'cancelAllForLeague':
        return this.cancelLeagueCmd(asCancelLeague(command.payload));
      case 'cancelAllOrders':
        return this.cancelAllOrdersCmd();
      case 'editOrder':
        return this.editOrderCmd(asEditOrder(command.payload));
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
    await Promise.allSettled([...this.state.watchList.map(id => this.refreshOrdersForGame(id)), this.refreshBalance()]);
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
    await Promise.allSettled([...this.state.watchList.map(id => this.refreshOrdersForGame(id)), this.refreshBalance()]);
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
    await Promise.allSettled([...this.state.watchList.map(id => this.refreshOrdersForGame(id)), this.refreshBalance()]);
    this.persist();
    return { submitted: true, dryRun: false, result };
  }

  private async editOrderCmd(payload: EditOrderPayload): Promise<unknown> {
    if (!Number.isFinite(payload.odds) || payload.odds === 0) throw new Error('odds must be a non-zero number');
    if (!Number.isFinite(payload.bet) || payload.bet <= 0) throw new Error('bet must be greater than 0');
    if (payload.bet > this.config.maxBet) throw new Error(`bet ${payload.bet} exceeds MAX_BET ${this.config.maxBet}`);

    const confirm = payload.confirm === true;
    const dryRunReason = !this.config.live ? 'LIVE=0' : !confirm ? 'missing --confirm' : null;
    if (dryRunReason) {
      this.record(makeActivity('ORDER', 'Dry-run edit-order preview', JSON.stringify(payload)));
      this.persist();
      return {
        submitted: false,
        dryRun: true,
        dryRunReason,
        disabledLive: true,
        note: EDIT_ORDER_DISABLED,
        request: { sessionID: payload.sessionID, odds: payload.odds, bet: payload.bet },
      };
    }
    // Live edit-order is intentionally disabled. Verified live (2026-07): /session/editOrder
    // is cancel-then-replace, and its replacement-stake field is NOT `bet` — a wrong guess
    // cancels the resting order and fails the re-place, destroying the order. Until the real
    // payload is documented, refuse the live call rather than risk a user's order.
    throw new Error(EDIT_ORDER_DISABLED);
  }

  private async watchGame(gameID: string): Promise<unknown> {
    if (!this.state.watchList.includes(gameID)) {
      this.state.watchList.push(gameID);
    }
    await this.refreshOrdersForGame(gameID);
    this.record(makeActivity('GAME', `Watching game ${gameID}`));
    this.persist();
    return { ok: true, watched: this.state.watchList };
  }

  private unwatchGame(gameID: string): unknown {
    this.state.watchList = this.state.watchList.filter(id => id !== gameID);
    delete this.state.ordersByGame[gameID];
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
      this.record(makeActivity('ORDER', 'Order submitted', JSON.stringify({ order, sessions })));
    }

    await Promise.allSettled([
      this.refreshOrdersForGame(order.gameID),
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
    await Promise.allSettled([
      this.refreshOrdersForGame(payload.gameID),
      this.refreshBalance(),
    ]);
    this.persist();
    return { submitted: true, dryRun: false, result };
  }

  private async refreshAfterCancel(result: CancelResult): Promise<void> {
    const gameID = result.gameID;
    if (gameID) {
      await Promise.allSettled([this.refreshOrdersForGame(gameID), this.refreshBalance()]);
      return;
    }
    await Promise.allSettled([
      ...this.state.watchList.map(id => this.refreshOrdersForGame(id)),
      this.refreshBalance(),
    ]);
  }
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

function asEditOrder(value: unknown): EditOrderPayload {
  const obj = asObject(value);
  if (typeof obj.odds !== 'number') throw new Error('odds must be a number');
  if (typeof obj.bet !== 'number') throw new Error('bet must be a number');
  return {
    sessionID: asString(obj.sessionID, 'sessionID'),
    odds: obj.odds,
    bet: obj.bet,
    confirm: obj.confirm === true,
  };
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
