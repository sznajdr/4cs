import type { MarketType } from '../api/types.js';
import type { TradeSide } from '../types/trading.js';

export function isValidSideFor(market: MarketType, side: TradeSide): boolean {
  return market === 'total'
    ? side === 'over' || side === 'under'
    : side === 'home' || side === 'away';
}

export function defaultSideFor(market: MarketType): TradeSide {
  return market === 'total' ? 'over' : 'home';
}

export interface OrderInputs {
  oddsRaw: string;
  riskRaw: string;
}

export interface ValidatedInputs {
  oddsNum: number;
  riskNum: number;
  hasValidOdds: boolean;
  hasValidRisk: boolean;
}

export function parseOrderInputs(inputs: OrderInputs): ValidatedInputs {
  const oddsNum = Number.parseFloat(inputs.oddsRaw);
  const riskNum = Number.parseFloat(inputs.riskRaw);
  return {
    oddsNum,
    riskNum,
    hasValidOdds: inputs.oddsRaw !== '' && Number.isFinite(oddsNum) && oddsNum !== 0,
    hasValidRisk: inputs.riskRaw !== '' && Number.isFinite(riskNum) && riskNum > 0,
  };
}
