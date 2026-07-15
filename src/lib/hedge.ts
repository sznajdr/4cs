import { americanToDecimal } from './odds.js';

export interface HedgeQuote {
  /** stake to place on the opposing selection */
  hedgeRisk: number;
  /** profit locked whichever side wins (equalized), net of fees for this exit variant */
  lockedProfit: number;
}

export interface HedgeInput {
  /** risk actually at stake on the entry (vendor `risk`, may include taker uplift) */
  entryRisk: number;
  /** net winnings if the entry wins (vendor `win`, already net of entry-side commission) */
  entryNetWin: number;
  /** current best American odds on the opposing selection */
  opposingAmerican: number;
  /** commission applied to the hedge fill's winnings (0 for a maker exit) */
  hedgeCommissionRate: number;
}

/**
 * Equalizing hedge for a clean two-outcome market, fee-aware.
 * Solve H such that both outcomes lock the same net profit:
 *   entry wins:  entryNetWin - H
 *   hedge wins:  H * (d_o - 1) * (1 - c) - entryRisk
 * => H = (entryNetWin + entryRisk) / (1 + (d_o - 1) * (1 - c))
 */
export function hedgeQuote(input: HedgeInput): HedgeQuote | null {
  const { entryRisk, entryNetWin, opposingAmerican, hedgeCommissionRate } = input;
  if (!Number.isFinite(entryRisk) || entryRisk <= 0) return null;
  if (!Number.isFinite(entryNetWin) || entryNetWin <= 0) return null;
  const decimal = americanToDecimal(opposingAmerican);
  if (decimal <= 1) return null;
  const netFactor = (decimal - 1) * (1 - hedgeCommissionRate);
  const hedgeRisk = (entryNetWin + entryRisk) / (1 + netFactor);
  const lockedProfit = entryNetWin - hedgeRisk;
  return {
    hedgeRisk: Math.round(hedgeRisk * 100) / 100,
    lockedProfit: Math.round(lockedProfit * 100) / 100,
  };
}
