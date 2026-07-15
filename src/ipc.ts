import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from './env.js';
import { getRuntimeConfig } from './env.js';

export type CommandAction =
  | 'watch'
  | 'unwatch'
  | 'place'
  | 'cancel'
  | 'cancelAll'
  | 'refresh'
  // live account reads (daemon issues a fresh REST call and returns the result)
  | 'unmatched'
  | 'matched'
  | 'graded'
  | 'liability'
  // bulk cancels & edit (writes)
  | 'editOrder'
  | 'cancelMultiple'
  | 'cancelAllForLeague'
  | 'cancelAllOrders';

export interface CommandEnvelope {
  id: string;
  action: CommandAction;
  payload: unknown;
  ts: number;
}

export interface CommandResponse {
  id: string;
  ok: boolean;
  ts: number;
  result?: unknown;
  error?: string;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function sendCommand(
  action: CommandAction,
  payload: unknown,
  args: { timeoutMs?: number; config?: RuntimeConfig } = {},
): Promise<CommandResponse> {
  const config = args.config ?? getRuntimeConfig();
  const timeoutMs = args.timeoutMs ?? 10_000;
  mkdirSync(config.commandsDir, { recursive: true });
  mkdirSync(config.responsesDir, { recursive: true });

  const id = randomUUID();
  const command: CommandEnvelope = { id, action, payload, ts: Date.now() };
  const cmdPath = join(config.commandsDir, `${id}.json`);
  const tmpPath = join(config.commandsDir, `${id}.tmp`);
  const respPath = join(config.responsesDir, `${id}.json`);

  writeFileSync(tmpPath, `${JSON.stringify(command)}\n`, 'utf8');
  renameSync(tmpPath, cmdPath);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(respPath)) {
      const response = JSON.parse(readFileSync(respPath, 'utf8')) as CommandResponse;
      safeRemove(respPath);
      safeRemove(cmdPath);
      return response;
    }
    await sleep(100);
  }

  safeRemove(cmdPath);
  throw new Error(`Daemon did not respond within ${timeoutMs}ms`);
}

export function safeRemove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}
