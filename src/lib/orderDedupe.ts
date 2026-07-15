export interface OrderShape {
  gameId: string;
  type: string;
  side: string;
  odds: number;
  bet: number;
  number?: number;
  userReference?: string;
}

export interface SubmitDedupeResult {
  allow: boolean;
  reason?: 'duplicate-clientRef' | 'duplicate-fingerprint';
  clientRef: string;
}

export class OrderDedupe {
  private clientRefs: Map<string, number> = new Map();
  private fingerprints: Map<string, number> = new Map();
  private ttlMs: number;

  constructor(ttlMs = 5_000) {
    this.ttlMs = ttlMs;
  }

  check(order: OrderShape, now: number): SubmitDedupeResult {
    this.gc(now);
    const clientRef = order.userReference && order.userReference.trim() !== ''
      ? order.userReference
      : makeFallbackReference(now);

    if (this.clientRefs.has(clientRef)) {
      return { allow: false, reason: 'duplicate-clientRef', clientRef };
    }
    const fp = fingerprint(order);
    if (this.fingerprints.has(fp)) {
      return { allow: false, reason: 'duplicate-fingerprint', clientRef };
    }
    return { allow: true, clientRef };
  }

  commit(order: OrderShape, clientRef: string, now: number): void {
    this.clientRefs.set(clientRef, now);
    this.fingerprints.set(fingerprint(order), now);
  }

  forget(clientRef: string): void {
    this.clientRefs.delete(clientRef);
  }

  size(): number {
    return this.clientRefs.size;
  }

  private gc(now: number) {
    for (const [k, t] of this.clientRefs) if (now - t > this.ttlMs) this.clientRefs.delete(k);
    for (const [k, t] of this.fingerprints) if (now - t > this.ttlMs) this.fingerprints.delete(k);
  }
}

function fingerprint(o: OrderShape): string {
  return [o.gameId, o.type, o.side, o.odds, o.bet, o.number ?? ''].join('|');
}

/**
 * Deterministic-prefix fallback reference for reporting/attribution:
 * `4c-<epochMs>-<shortid>`. Replaces the old `auto-...` fallback so daily
 * reports can distinguish daemon-placed bets from manual/website activity.
 */
export function makeFallbackReference(now: number): string {
  return `4c-${now}-${Math.random().toString(36).slice(2, 8)}`;
}
