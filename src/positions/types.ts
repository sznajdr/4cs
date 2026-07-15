export type MarketStateValue = 'active' | 'suspended' | 'closed' | 'unknown';

export interface NormalizedMarketState {
  gameID: string;
  state: MarketStateValue;
  source: 'catalog' | 'orders' | 'inferred';
  observedAt: string;
}

export interface NormalizedUnmatchedOrder {
  sessionID: string;
  stableOrderKey: string;
  gameID?: string;
  league?: string;
  market?: string;
  side?: string;
  outcome?: string;
  line?: number;
  odds: number;
  offeredRisk?: number;
  filledRisk?: number;
  remainingRisk?: number;
  firstSeenAt: string;
  firstSeenSource: 'exchange' | 'daemon';
  userReference?: string;
}

export type LinkConfidence = 'exact' | 'heuristic' | 'ambiguous' | 'unlinked';

export interface NormalizedMatchedPosition {
  txID: string;
  stableOrderKey?: string;
  linkConfidence: LinkConfidence;
  gameID?: string;
  league?: string;
  market?: string;
  side?: string;
  outcome?: string;
  line?: number;
  odds: number;
  risk: number;
  /** Net winnings if this position wins (vendor `win`, already net of taker commission). */
  win?: number;
  userReference?: string;
  matchedAt?: string;
}

export interface AccountPositionsSnapshot {
  unmatched: NormalizedUnmatchedOrder[];
  matched: NormalizedMatchedPosition[];
  marketStates: Record<string, NormalizedMarketState>;
  updatedAt?: string;
  exchangeTime?: string;
  lastOkAt?: string;
  lastError?: string;
  shapeWarnings: string[];
}
