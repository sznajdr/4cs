import type { Game, MarketType, Participant } from '../api/types.js';
import type { TradeSide } from '../types/trading.js';
import { americanToDecimal, fmtOdds, roundDecimal } from './odds.js';

/**
 * Resolve a participant ID for home/away by the vendor's `homeAway` field.
 * Participant array order is NOT reliable (tennis arrives [away, home]), so
 * positional indexing is only a last resort when no participant carries the
 * field at all (some specials/futures children). If the field is present but
 * the requested side is missing, return '' so callers fail loudly instead of
 * betting the wrong side.
 */
export function participantIdForSide(
  participants: Participant[] | undefined,
  side: 'home' | 'away',
): string {
  const match = participants?.find(p => p.homeAway === side);
  if (match) return match.id;
  const hasHomeAway = participants?.some(p => p.homeAway === 'home' || p.homeAway === 'away');
  if (hasHomeAway) return '';
  return side === 'away'
    ? (participants?.[1]?.id ?? '')
    : (participants?.[0]?.id ?? '');
}

export function orderSummary(args: {
  market: MarketType;
  side: TradeSide;
  awayLabel: string;
  homeLabel: string;
  number?: number;
  hasValidOdds: boolean;
  oddsNum: number;
}): string {
  const { market, side, awayLabel, homeLabel, number, hasValidOdds, oddsNum } = args;
  const sideText =
    market === 'total' ? side.toUpperCase() :
    side === 'away' ? awayLabel :
    homeLabel;
  const lineText = number !== undefined ? ` ${number > 0 ? '+' : ''}${number}` : '';
  const marketTag = market === 'moneyline' ? 'ML' : market === 'spread' ? 'SPR' : 'TOT';
  const oddsText = hasValidOdds
    ? ` / ${fmtOdds(oddsNum)} (${roundDecimal(americanToDecimal(oddsNum))})`
    : '';
  return `${marketTag} / ${sideText}${lineText}${oddsText}`;
}

export function resolveWsSide(args: {
  market: MarketType;
  side: TradeSide;
  game: Pick<Game, 'participants'> | undefined;
}): string {
  const { market, side, game } = args;
  if (market === 'total') {
    if (side !== 'over' && side !== 'under') return '';
    return side;
  }
  if (side !== 'away' && side !== 'home') return '';
  return participantIdForSide(game?.participants, side);
}

export function resolveOrderNumber(args: {
  market: MarketType;
  side: TradeSide;
  explicit: number | undefined;
  game: Pick<Game, 'mainHomeSpread' | 'mainAwaySpread' | 'mainTotal'> | undefined;
}): number | undefined {
  const { market, side, explicit, game } = args;
  if (market === 'moneyline') return undefined;
  if (explicit !== undefined) return explicit;
  if (!game) return undefined;
  if (market === 'spread') {
    return side === 'away'
      ? (game.mainAwaySpread ?? undefined)
      : (game.mainHomeSpread ?? undefined);
  }
  return game.mainTotal ?? undefined;
}
