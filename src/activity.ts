import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from './env.js';
import { getRuntimeConfig } from './env.js';
import { activityFile } from './state.js';
import type { ActivityEvent, ActivityType } from './api/types.js';

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function makeActivity(type: ActivityType, message: string, detail?: string): ActivityEvent {
  return {
    id: randomUUID(),
    ts: Date.now(),
    type,
    message,
    ...(detail ? { detail } : {}),
  };
}

export function appendActivity(event: ActivityEvent, config: RuntimeConfig = getRuntimeConfig()): void {
  const path = activityFile(dateKey(event.ts), config);
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
}

export function readActivityLog(args: {
  date?: string;
  tail?: number;
  config?: RuntimeConfig;
} = {}): ActivityEvent[] {
  const config = args.config ?? getRuntimeConfig();
  const date = args.date ?? dateKey(Date.now());
  const path = activityFile(date, config);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  const tail = args.tail && args.tail > 0 ? args.tail : lines.length;
  return lines.slice(-tail).flatMap(line => {
    try {
      return [JSON.parse(line) as ActivityEvent];
    } catch {
      return [];
    }
  });
}
