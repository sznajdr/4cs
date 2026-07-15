import type { Game, OddsLevel } from '../api/types.js';
import { best1x2BySide } from './marketLines.js';
import { americanToDecimal } from './odds.js';

/**
 * Continuous price-move measure in American price points.
 * Defined as (decimal(to) - decimal(from)) * 100: at plus odds one American
 * point equals exactly one unit; at minus odds the measure stays monotonic and
 * continuous across the +/-100 boundary. Positive = `to` pays better than `from`.
 */
export function priceMovePoints(fromAmerican: number, toAmerican: number): number {
  return (americanToDecimal(toAmerican) - americanToDecimal(fromAmerican)) * 100;
}

/** True when `candidate` pays the bettor better than `reference`. */
export function isBetterPrice(candidate: number, reference: number): boolean {
  return americanToDecimal(candidate) > americanToDecimal(reference);
}

export interface SelectionQuery {
  market: string;
  side?: string;
  outcome?: string;
  /** spread/total line; when omitted the current main line is used. */
  number?: number;
}

export interface SelectionPrice {
  odds: number;
  line?: number;
  /** true when a requested line did not match and the main line was used instead */
  usedMainLine: boolean;
}

function bestAt(levels: OddsLevel[] | undefined, line: number | undefined, lineField: 'spread' | 'total'): number | null {
  if (!levels || levels.length === 0) return null;
  if (line === undefined) return levels[0]?.odds ?? null;
  const match = levels.find(level => level[lineField] === line);
  return match?.odds ?? null;
}

function participantSide(game: Game, outcome: string): 'home' | 'away' | null {
  const normalized = outcome.toLowerCase();
  if (normalized === 'home' || normalized === 'away') return normalized;
  const participant = game.participants?.find(p => p.id === outcome);
  if (participant?.homeAway === 'home' || participant?.homeAway === 'away') return participant.homeAway;
  return null;
}

function best1x2Odds(levels: OddsLevel[] | undefined, side: string | undefined): number | null {
  if (!levels || levels.length === 0) return null;
  if (levels.some(level => typeof level?.side === 'string')) {
    if (side !== 'yes' && side !== 'no') return null;
    return best1x2BySide(levels, side)?.odds ?? null;
  }
  return levels[0]?.odds ?? null;
}

/**
 * Best currently-takeable price for a selection, from the catalog game.
 * Returns null when the selection cannot be resolved or has no liquidity —
 * callers must suppress rather than invent a price. Spread/total prices are
 * only compared at the same line: when an explicit line has no level, we do
 * NOT silently fall back to another line.
 */
export function bestPriceFor(game: Game, query: SelectionQuery): SelectionPrice | null {
  const { market, side, outcome } = query;
  if (market === 'moneyline') {
    const levels = side === 'home' ? game.homeMoneylines : side === 'away' ? game.awayMoneylines : undefined;
    const odds = levels?.[0]?.odds;
    return odds === undefined || odds === null ? null : { odds, usedMainLine: false };
  }
  if (market === 'moneyline1x2') {
    if (!outcome) return null;
    let levels: OddsLevel[] | undefined;
    if (outcome.toLowerCase() === 'draw') {
      levels = game.draw1x2;
    } else {
      const resolved = participantSide(game, outcome);
      if (!resolved) return null;
      levels = resolved === 'home' ? game.homeMoneylines1x2 : game.awayMoneylines1x2;
    }
    const odds = best1x2Odds(levels, side);
    return odds === undefined || odds === null ? null : { odds, usedMainLine: false };
  }
  if (market === 'spread') {
    const levels = side === 'home' ? game.homeSpreads : side === 'away' ? game.awaySpreads : undefined;
    const mainLine = side === 'home' ? game.mainHomeSpread : game.mainAwaySpread;
    const line = query.number ?? mainLine ?? undefined;
    if (query.number !== undefined) {
      const odds = bestAt(levels, query.number, 'spread');
      return odds === null ? null : { odds, line: query.number, usedMainLine: false };
    }
    const odds = bestAt(levels, line, 'spread') ?? bestAt(levels, undefined, 'spread');
    return odds === null ? null : { odds, ...(line !== undefined ? { line } : {}), usedMainLine: true };
  }
  if (market === 'total') {
    const levels = side === 'over' ? game.over : side === 'under' ? game.under : undefined;
    const line = query.number ?? game.mainTotal ?? undefined;
    if (query.number !== undefined) {
      const odds = bestAt(levels, query.number, 'total');
      return odds === null ? null : { odds, line: query.number, usedMainLine: false };
    }
    const odds = bestAt(levels, line, 'total') ?? bestAt(levels, undefined, 'total');
    return odds === null ? null : { odds, ...(line !== undefined ? { line } : {}), usedMainLine: true };
  }
  return null;
}
