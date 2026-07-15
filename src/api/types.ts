export interface UserProfile {
  id: string;
  username: string;
  balance: number;
  displayBalance: number;
  creditLimit: number;
  language: string;
  auth: string;
  oddsFormat: 'american' | 'decimal' | 'fractional';
  type: string;
  hasMarketMakerAccess: boolean;
  sportsbookDefault: boolean;
  defaultPinnyThruNumber: boolean;
  accessCode: string;
}

export interface LoginResponse {
  data: { user: UserProfile };
}

export interface Participant {
  id: string;
  longName: string;
  shortName?: string;
  abbreviation?: string;
  homeAway?: 'home' | 'away' | string;
  /** On specials/futures children the tournament or subject name is carried here. */
  mainPitcher?: string | null;
  rotationNumber?: string;
  futuresSide?: string;
}

export interface OddsLevel {
  odds: number;
  sumUntaken?: number;
  bet?: number;
  spread?: number | null;
  total?: number | null;
  OU?: 'over' | 'under';
  available?: number;
  volume?: number;
  /**
   * 1x2 ladders (`draw1x2`/`homeMoneylines1x2`/`awayMoneylines1x2`) quote both
   * takeable sides of the yes/no book, each with its own liquidity. Callers that
   * pick a 1x2 level MUST filter on this — trusting `levels[0]` can return a `no`
   * where `yes` was intended (see priceMove.ts `bestPriceFor` flag).
   */
  side?: 'yes' | 'no' | string;
  /** 1x2 ladders only: participant id, or the literal `"draw"`, naming the selection. */
  market?: string;
}

export interface Game {
  id: string;
  parentGameID?: string | null;
  rootGameID?: string | null;
  league: string;
  sport: string | number;
  start: string;
  ended: boolean;
  eventName?: string;
  isFutures?: boolean;
  /** Exotic surface: props/futures/outrights all arrive as isSpecials child games. */
  isSpecials?: boolean;
  isYesNo?: boolean;
  userCreated?: boolean;
  tournamentName?: string;
  periodName?: string;
  live?: boolean;
  featured?: boolean;
  isMarketOpen?: boolean;
  participants: Participant[];
  awayMoneylines: OddsLevel[];
  homeMoneylines: OddsLevel[];
  awayMoneylines1x2?: OddsLevel[];
  homeMoneylines1x2?: OddsLevel[];
  draw1x2?: OddsLevel[];
  awaySpreads: OddsLevel[];
  homeSpreads: OddsLevel[];
  over: OddsLevel[];
  under: OddsLevel[];
  mainHomeSpread: number | null;
  mainAwaySpread: number | null;
  mainTotal: number | null;
  messageType?: 'marketOpen' | 'marketClosed';
  isOpen?: boolean;
}

export type MarketType = 'moneyline' | 'spread' | 'total';
export type PlaceMarketType = MarketType | 'moneyline1x2';

export interface Order {
  id?: string;
  _id?: string;
  game?: Game;
  gameID?: string;
  odds: number;
  spread: number | null;
  total: number | null;
  participantID: string;
  expiry?: string;
  takenRatio?: number;
  filled: number;
  offered?: number;
  remaining?: number;
  risk?: number;
  market?: MarketType;
  status?: 'open' | 'partial' | 'filled' | 'cancelled';
}

export interface MatchedBet {
  txID: string;
  odds: number;
  filled: number;
  game?: Game;
  gameID?: string;
  participantID?: string;
  market?: MarketType;
  spread?: number | null;
  total?: number | null;
  gradedAt?: string;
  result?: 'win' | 'loss' | 'push' | null;
  payout?: number;
}

export interface OrdersForGameResponse {
  data: {
    unmatched: Order[];
    matched: MatchedBet[];
  };
}

export interface PlaceOrderRequest {
  gameID: string;
  participantID: string;
  odds: number;
  risk: number;
  market: MarketType;
  spread?: number | null;
  total?: number | null;
}

export interface PlaceOrderResponse {
  data: {
    order: Order;
  };
}

export interface CancelOrderRequest {
  orderID: string;
}

export type OrderType = 'limit' | 'post' | 'postArb' | 'fillAndKill';

export interface PlaceV3Order {
  gameID: string;
  type: PlaceMarketType;
  side: string;
  market?: string;
  odds: number;
  bet: number;
  number?: number;
  orderType?: OrderType;
  expirationMinutes?: number;
  userReference?: string;
}

export interface CreatedSession {
  matched?: unknown;
  unmatched?: unknown;
  error?: string;
  errorType?: string;
}

export interface PlaceV3Response {
  data: { createdSessions: CreatedSession[] };
}

export interface CancelResult {
  success: boolean;
  sessionID: string;
  description?: string;
  odds?: number;
  filled?: number;
  offered?: number;
  remaining?: number;
  gameID?: string;
  userReference?: string;
}

export interface CancelResponse {
  data: CancelResult;
}

// --- Read-only account endpoints (vendor JSON forwarded verbatim to the CLI) ---
// Shapes confirmed from docs/vendor curl captures; items are permissively typed
// because we forward them untouched rather than remodel the vendor payloads.

export interface UnmatchedResponse {
  data: { unmatched: unknown[] };
}

export interface MatchedBetsResponse {
  data: unknown;
}

export interface GameLiabilityResponse {
  data: { liability: number };
}

/**
 * `GET /user/getBetByUserReference` — the real "graded wagers" lookup. Returns the
 * unmatched, matched and graded arrays for every fill tied to a userReference.
 */
export interface BetByUserReferenceResponse {
  data: {
    unmatched?: unknown[];
    matched?: unknown[];
    graded?: unknown[];
  };
}

export interface GameUpdatePayload extends Omit<Game, 'isOpen'> {
  messageType: 'marketOpen' | 'marketClosed';
}

export interface PositionUpdatePayload {
  matched: {
    txID: string;
    filled: number;
    odds: number;
  };
}

export interface OrderUpdatePayload {
  type: 'orderPlaced' | 'orderCancelled' | 'orderFilled' | 'orderPartialFill';
  order: Order;
}

export interface UserFeedPayload {
  type: string;
  data: unknown;
}

export interface PriceFeedPayload {
  type: string;
  gameID?: string;
  data: unknown;
}

export type ActivityType = 'FILL' | 'ORDER' | 'CANCEL' | 'GAME' | 'PRICE' | 'CONNECT' | 'ERROR';

export interface ActivityEvent {
  id: string;
  ts: number;
  type: ActivityType;
  message: string;
  detail?: string;
}

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed';
