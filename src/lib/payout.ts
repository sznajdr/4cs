import type { MatchedBet, OrderType } from '../api/types.js';

export function toWin(risk: number, odds: number): number {
  if (!Number.isFinite(risk) || !Number.isFinite(odds)) return 0;
  if (odds > 0) return (risk * odds) / 100;
  if (odds < 0) return (risk * 100) / Math.abs(odds);
  return 0;
}

/** Maker order types pay no commission; takers pay COMMISSION_TAKER_RATE x winnings. */
export function isMakerOrderType(orderType: OrderType | undefined): boolean {
  return orderType === 'post' || orderType === 'postArb';
}

/**
 * Net winnings for a fill, fee side derived from the order type (there is no
 * separate fee field anywhere in payloads or rules). Verified live 2026-07-02:
 * taker win = gross x (1 - rate) with rate 0.01.
 */
export function netWin(risk: number, americanOdds: number, orderType: OrderType | undefined, commissionTakerRate: number): number {
  const gross = toWin(risk, americanOdds);
  if (isMakerOrderType(orderType)) return gross;
  return gross * (1 - commissionTakerRate);
}

export function computePnL(bet: MatchedBet): number | null {
  if (bet.payout === undefined) return null;
  if (!bet.result) return null;
  if (bet.result === 'win') return bet.payout;
  if (bet.result === 'push') return 0;
  return -bet.filled;
}
