import { env } from '../env.js';

export const BASE_URL =
  env('FOURCASTER_API_BASE_URL', ['4CASTER_API_BASE_URL']) ??
  'https://api.4casters.io';

export function authHeaderValue(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return trimmed;
  if (/^(Bearer|Basic)\s+/i.test(trimmed)) return trimmed;
  const scheme = env('FOURCASTER_AUTH_SCHEME', ['4CASTER_AUTH_SCHEME']) ?? 'bearer';
  return scheme.toLowerCase() === 'raw' ? trimmed : `Bearer ${trimmed}`;
}
