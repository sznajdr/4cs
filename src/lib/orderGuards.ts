import type { Game, MarketType } from '../api/types.js';
import type { TradeSide } from '../types/trading.js';
import { isValidSideFor } from './orderValidation.js';

export interface PlaceGuardInputs {
  game: Pick<Game, 'id'> | undefined | null;
  market: MarketType;
  side: TradeSide;
  hasValidOdds: boolean;
  hasValidRisk: boolean;
  isAuthenticated: boolean;
}

export interface PlaceGuardResult {
  ok: boolean;
  reason: string | null;
}

export function placeGuard(inputs: PlaceGuardInputs): PlaceGuardResult {
  const { game, market, side, hasValidOdds, hasValidRisk, isAuthenticated } = inputs;
  if (!game) return { ok: false, reason: 'Select a game' };
  if (!isValidSideFor(market, side)) return { ok: false, reason: 'Pick a side for this market' };
  if (!hasValidOdds) return { ok: false, reason: 'Enter valid odds' };
  if (!hasValidRisk) return { ok: false, reason: 'Enter risk amount > 0' };
  if (!isAuthenticated) return { ok: false, reason: 'Not connected; update FOURCASTER_AUTH_TOKEN' };
  return { ok: true, reason: null };
}
