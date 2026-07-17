import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeConfig } from '../../env.js';

/** Append-only transport evidence. State is a current view; this is the audit/tape trail. */
export function appendStreamTape(source: 'price' | 'user' | 'rest', type: string, payload: unknown, config: RuntimeConfig): void {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  mkdirSync(config.stateDir, { recursive: true });
  const record = JSON.stringify({ receivedAt: now.toISOString(), source, type, payload });
  appendFileSync(join(config.stateDir, `tape-${day}.jsonl`), `${record}\n`, 'utf8');
}
