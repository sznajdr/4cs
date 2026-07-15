/**
 * Offline fallback ONLY. The live source of truth is `getAvailableLeagues()`
 * (`/exchange/getLeagues`); the daemon falls back to this list solely when that
 * call fails. These are real, uppercase 4casters slugs (the lowercase generic
 * slugs previously here mostly resolved to 0 games). Keep this short — it exists
 * only to keep the catalog non-empty during a discovery outage.
 */
export const DEFAULT_LEAGUES: readonly string[] = [
  'MLB',
  'MLB-PROPS',
  'WORLD-CUP',
  'CHAMPIONS-LEAGUE',
  'ATP',
  'WTA',
  'UFCMMA',
  'BOXING',
  'PGA',
];
