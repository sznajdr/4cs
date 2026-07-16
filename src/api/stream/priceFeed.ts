import { ResilientFeed, type ResilientFeedOptions } from './feed.js';

export interface PriceSubscription {
  gameIDs?: string[];
  leagueIDs?: string[];
  sportIDs?: string[];
}

/** 4casters price events are tuples; subscription commands are JSON objects. */
export class PriceFeed extends ResilientFeed {
  private subscription: PriceSubscription;

  constructor(options: ResilientFeedOptions, subscription: PriceSubscription) {
    super({
      ...options,
      // A socket can deliver broadcast frames before its subscribe command has
      // taken effect. Keep the local state/tape in scope even during that race.
      onMessage: message => matchesSubscription(message, this.subscription) ? options.onMessage(message) : undefined,
      onReady: () => { this.publishSubscription(); options.onReady?.(); },
    });
    this.subscription = subscription;
  }

  setSubscription(subscription: PriceSubscription): void {
    this.subscription = subscription;
    this.publishSubscription();
  }

  private publishSubscription(): void {
    this.send({ type: 'subscribe',
      replace: true,
      gameIDs: this.subscription.gameIDs ?? [],
      leagueIDs: this.subscription.leagueIDs ?? [],
      sportIDs: this.subscription.sportIDs ?? [],
    });
  }
}

export function matchesSubscription(message: unknown, subscription: PriceSubscription): boolean {
  if (!Array.isArray(message) || message.length !== 2) return true; // Delegate malformed frames to the daemon counter.
  const payload = message[1];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true;
  const event = payload as Record<string, unknown>;
  const gameIDs = subscription.gameIDs ?? [];
  const leagueIDs = subscription.leagueIDs ?? [];
  const sportIDs = subscription.sportIDs ?? [];
  if (gameIDs.length + leagueIDs.length + sportIDs.length === 0) return true;
  const equalsIgnoreCase = (values: string[], value: unknown) => typeof value === 'string' && values.some(item => item.toLowerCase() === value.toLowerCase());
  return equalsIgnoreCase(gameIDs, event.gameID)
    || equalsIgnoreCase(gameIDs, event.parentGameID)
    || equalsIgnoreCase(leagueIDs, event.league)
    || equalsIgnoreCase(sportIDs, event.sport);
}
