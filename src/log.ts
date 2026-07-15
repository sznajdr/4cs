import { env } from './env.js';

const DEBUG = env('DEBUG') !== undefined;

export const log = {
  debug: DEBUG
    ? (...args: unknown[]) => console.log('[4caster]', ...args)
    : () => {},
  trace: DEBUG
    ? (...args: unknown[]) => console.log('[4caster:trace]', ...args)
    : () => {},
  warn: (...args: unknown[]) => console.warn('[4caster]', ...args),
  error: (...args: unknown[]) => console.error('[4caster]', ...args),
};
