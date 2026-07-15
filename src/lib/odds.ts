export function fmtOdds(o: number): string {
  return o >= 0 ? `+${o}` : `${o}`;
}

export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 1;
  if (american > 0) return (american + 100) / 100;
  return (Math.abs(american) + 100) / Math.abs(american);
}

export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return 0;
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

export function roundDecimal(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface NormalizedOdds {
  /** What the API is sent — the vendor's REST endpoints only speak American. */
  american: number;
  decimal: number;
  inputFormat: 'american' | 'decimal';
}

/**
 * Accept odds in either format and normalize to American for the API
 * (the profile's `oddsFormat` is a display preference, not a wire format).
 * |v| >= 100 is American; 1 < v < 100 is decimal. A true +9900 longshot is
 * decimal 100.0 — enter prices that long as American.
 */
export function normalizeOddsInput(value: number): NormalizedOdds | null {
  if (!Number.isFinite(value) || value === 0) return null;
  if (Math.abs(value) >= 100) {
    return { american: value, decimal: roundDecimal(americanToDecimal(value)), inputFormat: 'american' };
  }
  if (value > 1) {
    return { american: decimalToAmerican(value), decimal: value, inputFormat: 'decimal' };
  }
  return null;
}
