import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const APP_ROOT =
  process.env.FOURCASTER_HOME ??
  process.env['4CASTER_HOME'] ??
  resolve(here, '..');

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;

  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z0-9_]+$/.test(key)) return null;

  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    process.env[key] ??= value;
  }
}

export function loadEnv(): void {
  loadEnvFile(resolve(APP_ROOT, '.env'));
  loadEnvFile(resolve(APP_ROOT, '.env.local'));
}

loadEnv();

export function env(name: string, aliases: string[] = []): string | undefined {
  for (const key of [name, ...aliases]) {
    const value = process.env[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

export function envInt(name: string, fallback: number, aliases: string[] = []): number {
  const raw = env(name, aliases);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function envFloat(name: string, fallback: number, aliases: string[] = []): number {
  const raw = env(name, aliases);
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFloatMin0(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface RuntimeConfig {
  root: string;
  baseUrl: string;
  authToken: string;
  live: boolean;
  debug: boolean;
  maxBet: number;
  pollBalanceMs: number;
  pollOrderbookMs: number;
  pollOrdersMs: number;
  stateDir: string;
  commandsDir: string;
  responsesDir: string;
  pollPositionsMs: number;
  /** Settled-wager accounting is intentionally slow and separate from market polling. */
  pollSettlementMs: number;
  /** 0 disables the account-wide dead-man switch. Values must be > 5. */
  heartbeatSec: number;
  hedgeProfitBuffer: number;
  commissionTakerRate: number;
  /** Real-time market and account updates; disable explicitly with FOURCASTER_STREAMING=0. */
  streamingEnabled: boolean;
  /** Optional comma-separated price-feed filters. Empty means cached active leagues. */
  streamLeagues: string[];
}

export function getRuntimeConfig(): RuntimeConfig {
  const root = APP_ROOT;
  return {
    root,
    baseUrl: env('FOURCASTER_API_BASE_URL', ['4CASTER_API_BASE_URL']) ?? 'https://api.4casters.io',
    authToken: env('FOURCASTER_AUTH_TOKEN', ['4CASTER_AUTH_TOKEN', 'VITE_AUTH_TOKEN']) ?? '',
    live: env('LIVE') === '1',
    debug: env('DEBUG') !== undefined,
    maxBet: envFloat('MAX_BET', 5),
    pollBalanceMs: envInt('POLL_BALANCE_MS', 5_000),
    pollOrderbookMs: envInt('POLL_ORDERBOOK_MS', 8_000),
    pollOrdersMs: envInt('POLL_ORDERS_MS', 5_000),
    stateDir: env('FOURCASTER_STATE_DIR', ['4CASTER_STATE_DIR']) ?? resolve(root, 'state'),
    commandsDir: env('FOURCASTER_COMMANDS_DIR', ['4CASTER_COMMANDS_DIR']) ?? resolve(root, 'commands'),
    responsesDir: env('FOURCASTER_RESPONSES_DIR', ['4CASTER_RESPONSES_DIR']) ?? resolve(root, 'responses'),
    pollPositionsMs: envInt('POLL_POSITIONS_MS', 30_000),
    pollSettlementMs: envInt('POLL_SETTLEMENT_MS', 3_600_000),
    heartbeatSec: (() => {
      const raw = env('FOURCASTER_HEARTBEAT_SEC');
      if (raw === undefined) return 0;
      const value = Number.parseInt(raw, 10);
      return Number.isFinite(value) && value > 5 ? value : 0;
    })(),
    hedgeProfitBuffer: envFloatMin0('HEDGE_PROFIT_BUFFER', 0.25),
    commissionTakerRate: envFloatMin0('COMMISSION_TAKER_RATE', 0.01),
    streamingEnabled: env('FOURCASTER_STREAMING') !== '0',
    streamLeagues: (env('FOURCASTER_STREAM_LEAGUES') ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  };
}
