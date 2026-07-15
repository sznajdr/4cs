import type { OddsLevel } from '../api/types.js';
import { americanToDecimal, roundDecimal } from './odds.js';

/**
 * Grouped/liquidity view of an order-book ladder. The catalog `Game` carries the
 * full ladder for every market — each `OddsLevel` names its own line (`total: 3.5`,
 * `spread: -1.5`) and its untaken liquidity. The CLI's old `levels[0]` view threw
 * all of that away; this module surfaces every line with the price a taker can hit
 * and how much is available there.
 *
 * `priceMove.ts` keeps a separate private `bestAt` for the explicit-line signal
 * path — this module is the display-oriented grouped view, deliberately distinct.
 */

/** A single takeable price with its decimal payout and untaken liquidity. */
export interface LadderLevel {
  odds: number;
  oddsDecimal: number;
  liquidity: number;
}

/** A 1x2 takeable price with the yes/no book side preserved for display. */
export interface Moneyline1x2LadderLevel extends LadderLevel {
  side?: string;
}

/** All takeable prices at one line number, best (highest payout) first. */
export interface LineGroup {
  /** The line this group is for; `null` collects levels that carry no line field. */
  line: number | null;
  /** Best (max decimal payout) level at this line — do NOT trust vendor ordering. */
  best: LadderLevel;
  /** Sum of untaken liquidity across every level at this line. */
  liquidity: number;
  levels: LadderLevel[];
}

/**
 * Untaken $ a taker can hit at this level. `sumUntaken` is the vendor's own
 * remaining-offer figure; `available`/`volume` are fallbacks. Uses nullish
 * precedence so a genuine 0 (fully taken) is reported as 0 rather than skipped.
 */
export function levelLiquidity(lvl: OddsLevel): number {
  return lvl.sumUntaken ?? lvl.available ?? lvl.volume ?? 0;
}

function toLadderLevel(lvl: OddsLevel): LadderLevel {
  return {
    odds: lvl.odds,
    oddsDecimal: roundDecimal(americanToDecimal(lvl.odds)),
    liquidity: levelLiquidity(lvl),
  };
}

function byPayoutDesc(a: LadderLevel, b: LadderLevel): number {
  return b.oddsDecimal - a.oddsDecimal;
}

/**
 * Group an order-book ladder by its line number (`spread` or `total`), sorted by
 * line ascending. Levels missing the field fall into a trailing `line: null`
 * bucket (defensive — should not normally happen). Within each line, levels are
 * sorted best-first and `best` is the maximum decimal payout, not `levels[0]`.
 */
export function groupLevelsByLine(
  levels: OddsLevel[] | undefined,
  field: 'spread' | 'total',
): LineGroup[] {
  if (!levels || levels.length === 0) return [];
  const byLine = new Map<number | null, LadderLevel[]>();
  for (const lvl of levels) {
    if (!lvl || typeof lvl.odds !== 'number') continue;
    const raw = lvl[field];
    const line = typeof raw === 'number' ? raw : null;
    const bucket = byLine.get(line);
    if (bucket) bucket.push(toLadderLevel(lvl));
    else byLine.set(line, [toLadderLevel(lvl)]);
  }
  const groups: LineGroup[] = [];
  for (const [line, ladder] of byLine) {
    ladder.sort(byPayoutDesc);
    groups.push({
      line,
      best: ladder[0],
      liquidity: ladder.reduce((sum, l) => sum + l.liquidity, 0),
      levels: ladder,
    });
  }
  groups.sort((a, b) => {
    if (a.line === null) return 1;
    if (b.line === null) return -1;
    return a.line - b.line;
  });
  return groups;
}

/**
 * Best takeable level at a specific line, or null when that line has no level.
 * No silent fallback to another line — callers decide what to do on a miss.
 */
export function bestAtLine(
  levels: OddsLevel[] | undefined,
  line: number | null | undefined,
  field: 'spread' | 'total',
): LadderLevel | null {
  if (line === null || line === undefined) return null;
  const match = groupLevelsByLine(levels, field).find(g => g.line === line);
  return match ? match.best : null;
}

/**
 * Best takeable 1x2 level for one side of the yes/no book, or null when that
 * side is absent. 1x2 ladders (`draw1x2` etc.) carry BOTH `side:"yes"` and
 * `side:"no"` levels with independent liquidity; picking `levels[0]` ignores the
 * `side` field and can return the wrong side. This filters by `side`, takes the
 * maximum decimal payout, and sums untaken liquidity across every matching level.
 */
export function best1x2BySide(
  levels: OddsLevel[] | undefined,
  side: 'yes' | 'no',
): LadderLevel | null {
  if (!levels || levels.length === 0) return null;
  let best: LadderLevel | null = null;
  let liquidity = 0;
  for (const lvl of levels) {
    if (!lvl || typeof lvl.odds !== 'number' || lvl.side !== side) continue;
    const level = toLadderLevel(lvl);
    liquidity += level.liquidity;
    if (!best || level.oddsDecimal > best.oddsDecimal) best = level;
  }
  return best ? { ...best, liquidity } : null;
}

/**
 * Moneyline ladder (no line grouping) sorted best-first, capped to `depth`.
 * Same level shape as the grouped view for a uniform CLI output.
 */
export function moneylineLadder(levels: OddsLevel[] | undefined, depth?: number): LadderLevel[] {
  if (!levels || levels.length === 0) return [];
  const ladder = levels
    .filter(lvl => lvl && typeof lvl.odds === 'number')
    .map(toLadderLevel)
    .sort(byPayoutDesc);
  return depth !== undefined && depth > 0 ? ladder.slice(0, depth) : ladder;
}

/**
 * 1x2 moneyline ladder sorted best-first while preserving the yes/no `side`.
 * This keeps display output unambiguous for books that carry both sides of the
 * same outcome in one array.
 */
export function moneyline1x2Ladder(levels: OddsLevel[] | undefined, depth?: number): Moneyline1x2LadderLevel[] {
  if (!levels || levels.length === 0) return [];
  const ladder = levels
    .filter(lvl => lvl && typeof lvl.odds === 'number')
    .map(lvl => ({
      ...toLadderLevel(lvl),
      ...(typeof lvl.side === 'string' ? { side: lvl.side } : {}),
    }))
    .sort(byPayoutDesc);
  return depth !== undefined && depth > 0 ? ladder.slice(0, depth) : ladder;
}
