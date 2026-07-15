import type { MarketType } from '../api/types.js';

export type TradeSide = 'home' | 'away' | 'over' | 'under';
export type Moneyline1x2Side = 'yes' | 'no';
export type PlaceSide = TradeSide | Moneyline1x2Side;

export interface MarketSelection {
  key: string;
  market: MarketType;
  side: TradeSide;
  odds: number;
  number?: number;
  label: string;
  ts: number;
}
