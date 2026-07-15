import type { AccountPositionsSnapshot, NormalizedUnmatchedOrder } from './types.js';

export interface MatchedFillEvent {
  type: 'fill';
  stableOrderKey: string;
  linkConfidence: 'exact' | 'heuristic' | 'approximate';
  sessionID?: string;
  gameID: string;
  market: string;
  side: string;
  outcome?: string;
  line?: number;
  filledRisk: number;
  matchedTxID?: string;
  reason: 'remaining_decreased' | 'unmatched_disappeared';
}

export interface UnmatchedExitEvent {
  type: 'exit';
  stableOrderKey: string;
  sessionID?: string;
  gameID?: string;
  reason: 'manual_or_api_cancel' | 'expiry_or_closed' | 'suspension_suppressed' | 'unknown';
}

export type PositionsDelta = MatchedFillEvent | UnmatchedExitEvent;

export interface DiffResult {
  deltas: PositionsDelta[];
  shapeWarnings: string[];
}

function matchedRiskByKey(snapshot: AccountPositionsSnapshot | null): Map<string, { risk: number; txID: string }> {
  const map = new Map<string, { risk: number; txID: string }>();
  for (const pos of snapshot?.matched ?? []) {
    if (!pos.stableOrderKey) continue;
    const prev = map.get(pos.stableOrderKey);
    map.set(pos.stableOrderKey, { risk: (prev?.risk ?? 0) + pos.risk, txID: pos.txID });
  }
  return map;
}

function shapeKey(order: NormalizedUnmatchedOrder): string {
  return [order.gameID ?? '', order.market ?? '', order.side ?? '', order.outcome ?? '', order.line ?? ''].join('|');
}

/**
 * Explicit position deltas between two normalized snapshots. The signal engine
 * consumes these instead of re-implementing fill inference per rule.
 */
export function diffPositions(prev: AccountPositionsSnapshot | null, next: AccountPositionsSnapshot): DiffResult {
  const deltas: PositionsDelta[] = [];
  const warnings: string[] = [];
  if (!prev) return { deltas, shapeWarnings: warnings };

  const prevByKey = new Map(prev.unmatched.map(o => [o.stableOrderKey, o]));
  const nextByKey = new Map(next.unmatched.map(o => [o.stableOrderKey, o]));
  const prevMatched = matchedRiskByKey(prev);
  const nextMatched = matchedRiskByKey(next);

  // Present in both: remaining-risk decrease is a partial-fill candidate.
  for (const [key, prevOrder] of prevByKey) {
    const nextOrder = nextByKey.get(key);
    if (!nextOrder) continue;
    const prevRemaining = prevOrder.remainingRisk;
    const nextRemaining = nextOrder.remainingRisk;
    if (prevRemaining === undefined || nextRemaining === undefined) continue;
    if (nextRemaining < prevRemaining - 1e-9) {
      const filledRisk = prevRemaining - nextRemaining;
      const matchedIncrease = (nextMatched.get(key)?.risk ?? 0) - (prevMatched.get(key)?.risk ?? 0);
      const confirmed = matchedIncrease > 1e-9;
      if (!confirmed) warnings.push(`fill for ${key} inferred from remaining decrease only (no matched-risk increase visible)`);
      deltas.push({
        type: 'fill',
        stableOrderKey: key,
        linkConfidence: confirmed ? 'exact' : 'approximate',
        sessionID: nextOrder.sessionID,
        gameID: nextOrder.gameID ?? '',
        market: nextOrder.market ?? '',
        side: nextOrder.side ?? '',
        ...(nextOrder.outcome ? { outcome: nextOrder.outcome } : {}),
        ...(nextOrder.line !== undefined ? { line: nextOrder.line } : {}),
        filledRisk,
        ...(nextMatched.get(key)?.txID ? { matchedTxID: nextMatched.get(key)?.txID } : {}),
        reason: 'remaining_decreased',
      });
    }
  }

  // Present in prev, missing in next.
  for (const [key, prevOrder] of prevByKey) {
    if (nextByKey.has(key)) continue;
    const gameID = prevOrder.gameID;
    const marketState = gameID ? next.marketStates[gameID]?.state ?? 'unknown' : 'unknown';

    if (marketState === 'suspended' || marketState === 'unknown') {
      deltas.push({
        type: 'exit',
        stableOrderKey: key,
        sessionID: prevOrder.sessionID,
        ...(gameID ? { gameID } : {}),
        reason: 'suspension_suppressed',
      });
      continue;
    }

    const matchedIncrease = (nextMatched.get(key)?.risk ?? 0) - (prevMatched.get(key)?.risk ?? 0);
    if (matchedIncrease > 1e-9) {
      deltas.push({
        type: 'fill',
        stableOrderKey: key,
        linkConfidence: 'exact',
        sessionID: prevOrder.sessionID,
        gameID: gameID ?? '',
        market: prevOrder.market ?? '',
        side: prevOrder.side ?? '',
        ...(prevOrder.outcome ? { outcome: prevOrder.outcome } : {}),
        ...(prevOrder.line !== undefined ? { line: prevOrder.line } : {}),
        filledRisk: matchedIncrease,
        ...(nextMatched.get(key)?.txID ? { matchedTxID: nextMatched.get(key)?.txID } : {}),
        reason: 'unmatched_disappeared',
      });
      continue;
    }

    if (marketState === 'closed') {
      deltas.push({
        type: 'exit',
        stableOrderKey: key,
        sessionID: prevOrder.sessionID,
        ...(gameID ? { gameID } : {}),
        reason: 'expiry_or_closed',
      });
      continue;
    }

    // No exact matched-key increase: try a unique same-shape matched-risk increase.
    const shape = shapeKey(prevOrder);
    const candidates: Array<{ key: string; increase: number; txID: string }> = [];
    const prevShapeRisk = new Map<string, number>();
    for (const pos of prev.matched) {
      const k = [pos.gameID ?? '', pos.market ?? '', pos.side ?? '', pos.outcome ?? '', pos.line ?? ''].join('|');
      prevShapeRisk.set(k, (prevShapeRisk.get(k) ?? 0) + pos.risk);
    }
    const nextShapeRisk = new Map<string, { risk: number; txID: string }>();
    for (const pos of next.matched) {
      const k = [pos.gameID ?? '', pos.market ?? '', pos.side ?? '', pos.outcome ?? '', pos.line ?? ''].join('|');
      const cur = nextShapeRisk.get(k);
      nextShapeRisk.set(k, { risk: (cur?.risk ?? 0) + pos.risk, txID: pos.txID });
    }
    const shapeIncrease = (nextShapeRisk.get(shape)?.risk ?? 0) - (prevShapeRisk.get(shape) ?? 0);
    if (shapeIncrease > 1e-9) {
      // Ambiguity check: multiple prev unmatched orders of the same shape also missing?
      const sameShapeMissing = [...prevByKey.values()].filter(
        o => shapeKey(o) === shape && !nextByKey.has(o.stableOrderKey),
      );
      if (sameShapeMissing.length > 1) {
        warnings.push(`ambiguous fill attribution for shape ${shape}: ${sameShapeMissing.length} candidate orders; no fill emitted`);
        continue;
      }
      candidates.push({ key, increase: shapeIncrease, txID: nextShapeRisk.get(shape)?.txID ?? '' });
    }
    if (candidates.length === 1) {
      deltas.push({
        type: 'fill',
        stableOrderKey: key,
        linkConfidence: 'approximate',
        sessionID: prevOrder.sessionID,
        gameID: gameID ?? '',
        market: prevOrder.market ?? '',
        side: prevOrder.side ?? '',
        ...(prevOrder.outcome ? { outcome: prevOrder.outcome } : {}),
        ...(prevOrder.line !== undefined ? { line: prevOrder.line } : {}),
        filledRisk: candidates[0].increase,
        ...(candidates[0].txID ? { matchedTxID: candidates[0].txID } : {}),
        reason: 'unmatched_disappeared',
      });
      continue;
    }

    deltas.push({
      type: 'exit',
      stableOrderKey: key,
      sessionID: prevOrder.sessionID,
      ...(gameID ? { gameID } : {}),
      reason: marketState === 'active' ? 'manual_or_api_cancel' : 'unknown',
    });
  }

  return { deltas, shapeWarnings: warnings };
}
