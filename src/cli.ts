#!/usr/bin/env node
import { readStateSync } from './state.js';
import { readActivityLog } from './activity.js';
import { sendCommand } from './ipc.js';
import { getRuntimeConfig } from './env.js';
import type { Game, MarketType, OddsLevel, OrderType, PlaceMarketType, PlaceV3Order } from './api/types.js';
import type { Moneyline1x2Side, PlaceSide, TradeSide } from './types/trading.js';
import { participantIdForSide, resolveOrderNumber, resolveWsSide } from './lib/orderFormat.js';
import { isValidSideFor, parseOrderInputs } from './lib/orderValidation.js';
import { americanToDecimal, normalizeOddsInput, roundDecimal } from './lib/odds.js';
import {
  best1x2BySide,
  bestAtLine,
  groupLevelsByLine,
  moneyline1x2Ladder,
  moneylineLadder,
  type LadderLevel,
} from './lib/marketLines.js';
import { makeFallbackReference } from './lib/orderDedupe.js';

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

const BOOLEAN_FLAGS = new Set(['--confirm', '--confirm-replace', '--dry-run', '--live-only', '--active']);
const MARKETS = new Set(['moneyline', 'spread', 'total', 'moneyline1x2']);
const SIDES = new Set(['home', 'away', 'over', 'under', 'yes', 'no']);
const ORDER_TYPES = new Set(['limit', 'post', 'postArb', 'fillAndKill']);

function parseArgv(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) {
      options[token] = true;
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options[token] = true;
      continue;
    }
    options[token] = next;
    i++;
  }

  return { command, options, positionals };
}

function opt(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === 'string' ? value : undefined;
}

function flag(args: ParsedArgs, name: string): boolean {
  return args.options[name] === true;
}

function required(args: ParsedArgs, name: string): string {
  const value = opt(args, name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function num(args: ParsedArgs, name: string): number | undefined {
  const value = opt(args, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function best(levels: OddsLevel[] | undefined): number | null {
  return levels?.[0]?.odds ?? null;
}

function bestDecimal(levels: OddsLevel[] | undefined): number | null {
  const odds = best(levels);
  return odds === null ? null : roundDecimal(americanToDecimal(odds));
}

function best1x2Yes(levels: OddsLevel[] | undefined): number | null {
  return best1x2BySide(levels, 'yes')?.odds ?? null;
}

function best1x2YesDecimal(levels: OddsLevel[] | undefined): number | null {
  return best1x2BySide(levels, 'yes')?.oddsDecimal ?? null;
}

/**
 * Best takeable price at the main line, falling back to `levels[0]` when no main
 * line is set (or the main line has no level). The old `levels[0]` view could
 * silently quote an alternate line whose level happened to sort first — this ties
 * the summary's over/under/spread prices to the main line the fields describe.
 */
function bestAtMainOdds(levels: OddsLevel[] | undefined, line: number | null, field: 'spread' | 'total'): number | null {
  const lvl = bestAtLine(levels, line, field);
  return lvl ? lvl.odds : best(levels);
}

function bestAtMainDecimal(levels: OddsLevel[] | undefined, line: number | null, field: 'spread' | 'total'): number | null {
  const odds = bestAtMainOdds(levels, line, field);
  return odds === null ? null : roundDecimal(americanToDecimal(odds));
}

/** Sorted distinct line numbers present in a ladder, so alternates are visible from list-games. */
function distinctLines(levels: (OddsLevel[] | undefined)[], field: 'spread' | 'total'): number[] {
  const set = new Set<number>();
  for (const arr of levels) {
    for (const lvl of arr ?? []) {
      const raw = lvl?.[field];
      if (typeof raw === 'number') set.add(raw);
    }
  }
  return [...set].sort((a, b) => a - b);
}

interface LineGroupOut {
  line: number | null;
  main: boolean;
  best: LadderLevel;
  liquidity: number;
  levels: LadderLevel[];
}

/** Annotate grouped lines with the main-line flag and cap levels-per-line to `depth`. */
function lineGroupsOut(
  levels: OddsLevel[] | undefined,
  field: 'spread' | 'total',
  mainLine: number | null,
  depth: number,
): LineGroupOut[] {
  return groupLevelsByLine(levels, field).map(g => ({
    line: g.line,
    main: mainLine !== null && g.line === mainLine,
    best: g.best,
    liquidity: g.liquidity,
    levels: depth > 0 ? g.levels.slice(0, depth) : g.levels,
  }));
}

function labels(game: Game): { home: string; away: string } {
  const home = game.participants?.find(p => p.homeAway === 'home');
  const away = game.participants?.find(p => p.homeAway === 'away');
  return {
    home: home?.longName ?? game.participants?.[0]?.longName ?? 'HOME',
    away: away?.longName ?? game.participants?.[1]?.longName ?? 'AWAY',
  };
}

function isLive(game: Game, now = Date.now()): boolean {
  if (game.ended) return false;
  const start = new Date(game.start).getTime();
  return Number.isFinite(start) && start <= now;
}

type GameKind = 'standard' | 'specials' | 'props' | 'futures';

/**
 * Classify a catalog game. Props/futures/outrights are not separate market types —
 * they are all `isSpecials` child games. See docs/CLI_REFERENCE.md.
 *   futures  = isSpecials, no parent, tournament carried on participants[].mainPitcher
 *   props    = isSpecials with a parentGameID (child of a standard game)
 *   specials = any other isSpecials game
 *   standard = a normal two-way / three-way game
 */
function deriveKind(game: Game): GameKind {
  if (!game.isSpecials) return 'standard';
  const hasTournament = Boolean(tournamentName(game));
  if (!game.parentGameID && hasTournament) return 'futures';
  if (game.parentGameID) return 'props';
  return 'specials';
}

function tournamentName(game: Game): string | null {
  const fromParticipant = game.participants?.find(p => p.mainPitcher)?.mainPitcher;
  return fromParticipant ?? game.tournamentName ?? null;
}

/** Best-effort parse of a prop `eventName` like "JUAN SOTO (HOME RUNS)(MUST START)". */
function parseProp(eventName: string | undefined): { subject: string; propType: string; note?: string } | null {
  if (!eventName) return null;
  const m = eventName.match(/^(.*?)\s*\(([^)]*)\)\s*(?:\(([^)]*)\))?\s*$/);
  if (!m) return null;
  const subject = m[1].trim();
  const propType = m[2].trim();
  if (!subject && !propType) return null;
  return { subject, propType, ...(m[3] ? { note: m[3].trim() } : {}) };
}

function summarizeGame(game: Game) {
  const names = labels(game);
  const kind = deriveKind(game);
  return {
    id: game.id,
    league: game.league,
    sport: game.sport,
    kind,
    isSpecials: game.isSpecials === true,
    isYesNo: game.isYesNo === true,
    parentGameID: game.parentGameID ?? null,
    rootGameID: game.rootGameID ?? null,
    tournament: tournamentName(game),
    ...(kind === 'props' ? { prop: parseProp(game.eventName) } : {}),
    eventName: game.eventName ?? `${names.away} vs ${names.home}`,
    start: game.start,
    ended: game.ended,
    isOpen: game.isOpen !== false,
    live: isLive(game),
    away: names.away,
    home: names.home,
    awayBest: best(game.awayMoneylines),
    homeBest: best(game.homeMoneylines),
    away1x2Best: best1x2Yes(game.awayMoneylines1x2),
    home1x2Best: best1x2Yes(game.homeMoneylines1x2),
    draw1x2Best: best1x2Yes(game.draw1x2),
    awaySpreadBest: bestAtMainOdds(game.awaySpreads, game.mainAwaySpread, 'spread'),
    homeSpreadBest: bestAtMainOdds(game.homeSpreads, game.mainHomeSpread, 'spread'),
    overBest: bestAtMainOdds(game.over, game.mainTotal, 'total'),
    underBest: bestAtMainOdds(game.under, game.mainTotal, 'total'),
    awayBestDecimal: bestDecimal(game.awayMoneylines),
    homeBestDecimal: bestDecimal(game.homeMoneylines),
    away1x2BestDecimal: best1x2YesDecimal(game.awayMoneylines1x2),
    home1x2BestDecimal: best1x2YesDecimal(game.homeMoneylines1x2),
    draw1x2BestDecimal: best1x2YesDecimal(game.draw1x2),
    awaySpreadBestDecimal: bestAtMainDecimal(game.awaySpreads, game.mainAwaySpread, 'spread'),
    homeSpreadBestDecimal: bestAtMainDecimal(game.homeSpreads, game.mainHomeSpread, 'spread'),
    overBestDecimal: bestAtMainDecimal(game.over, game.mainTotal, 'total'),
    underBestDecimal: bestAtMainDecimal(game.under, game.mainTotal, 'total'),
    mainAwaySpread: game.mainAwaySpread,
    mainHomeSpread: game.mainHomeSpread,
    mainTotal: game.mainTotal,
    // Alternate lines available on this game — see the `lines` command for prices+liquidity.
    totalLines: distinctLines([game.over, game.under], 'total'),
    awaySpreadLines: distinctLines([game.awaySpreads], 'spread'),
    homeSpreadLines: distinctLines([game.homeSpreads], 'spread'),
  };
}

function filterGames(games: Game[], args: ParsedArgs): Game[] {
  const league = opt(args, '--league')?.toLowerCase();
  const search = opt(args, '--search')?.toLowerCase();
  const liveOnly = flag(args, '--live-only');
  const kind = opt(args, '--kind')?.toLowerCase();
  const sport = opt(args, '--sport')?.toLowerCase();
  const parent = opt(args, '--parent');

  return games
    .filter(game => !league || game.league?.toLowerCase() === league)
    .filter(game => !kind || deriveKind(game) === kind)
    .filter(game => !sport || String(game.sport ?? '').toLowerCase() === sport)
    .filter(game => !parent || game.parentGameID === parent)
    .filter(game => !liveOnly || isLive(game))
    .filter(game => {
      if (!search) return true;
      const names = labels(game);
      return [
        game.id,
        game.league,
        game.eventName,
        names.home,
        names.away,
      ].some(value => String(value ?? '').toLowerCase().includes(search));
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

function findGame(gameID: string): Game | undefined {
  return readStateSync().catalog.games.find(game => game.id === gameID);
}

function parseMarket(value: string): PlaceMarketType {
  if (!MARKETS.has(value)) throw new Error('--market must be moneyline, spread, total, or moneyline1x2');
  return value as PlaceMarketType;
}

function parseSide(value: string): PlaceSide {
  if (!SIDES.has(value)) throw new Error('--side must be home, away, over, under, yes, or no');
  return value as PlaceSide;
}

function parseOrderType(value: string | undefined): OrderType {
  if (value === undefined) return 'limit';
  if (!ORDER_TYPES.has(value)) throw new Error('--order-type must be limit, post, postArb, or fillAndKill');
  return value as OrderType;
}

function buildPlacePayload(args: ParsedArgs): {
  order: PlaceV3Order;
  confirm: boolean;
  request: Record<string, unknown>;
} {
  const gameID = required(args, '--game-id');
  const market = parseMarket(required(args, '--market'));
  const side = parseSide(required(args, '--side'));
  const oddsRaw = required(args, '--odds');
  const betRaw = required(args, '--bet');
  const parsed = parseOrderInputs({ oddsRaw, riskRaw: betRaw });
  if (!parsed.hasValidOdds) throw new Error('--odds must be a non-zero number');
  if (!parsed.hasValidRisk) throw new Error('--bet must be greater than 0');
  const odds = normalizeOddsInput(parsed.oddsNum);
  if (!odds) {
    throw new Error('--odds must be American (<= -100 or >= 100) or decimal (> 1.0 and < 100, e.g. 1.66)');
  }
  if (market === 'moneyline1x2') {
    if (side !== 'yes' && side !== 'no') throw new Error('moneyline1x2 requires --side yes or --side no');
  } else if (!isValidSideFor(market, side as TradeSide)) {
    throw new Error(`Side ${side} is not valid for ${market}`);
  }

  const game = findGame(gameID);
  if (!game) {
    throw new Error(`Game ${gameID} is not in state yet; wait for catalog polling or check the game id`);
  }

  const outcome = opt(args, '--outcome') ?? opt(args, '--selection');
  const apiMarket = market === 'moneyline1x2'
    ? resolveMoneyline1x2Outcome(outcome, game)
    : undefined;
  const apiSide = market === 'moneyline1x2'
    ? (side as Moneyline1x2Side)
    : resolveWsSide({ market, side: side as TradeSide, game });
  if (!apiSide) throw new Error(`Could not resolve API side for ${market}/${side}`);

  const explicitNumber = num(args, '--number') ?? num(args, '--line');
  const lineNumber = market === 'moneyline1x2'
    ? undefined
    : resolveOrderNumber({ market, side: side as TradeSide, explicit: explicitNumber, game });
  const orderType = parseOrderType(opt(args, '--order-type'));
  const userReference = opt(args, '--user-reference') ?? makeFallbackReference(Date.now());
  const expirationMinutes = num(args, '--expires-in');
  if (expirationMinutes !== undefined && (!Number.isInteger(expirationMinutes) || expirationMinutes <= 0)) {
    throw new Error('--expires-in must be a whole number of minutes greater than 0');
  }

  return {
    confirm: flag(args, '--confirm'),
    request: {
      gameID,
      market,
      side,
      odds: odds.american,
      oddsDecimal: odds.decimal,
      oddsInputFormat: odds.inputFormat,
      bet: parsed.riskNum,
      orderType,
      confirm: flag(args, '--confirm'),
      ...(apiMarket ? { outcome: outcome ?? apiMarket } : {}),
    },
    order: {
      gameID,
      type: market,
      side: apiSide,
      ...(apiMarket ? { market: apiMarket } : {}),
      odds: odds.american,
      bet: parsed.riskNum,
      ...(lineNumber !== undefined ? { number: lineNumber } : {}),
      orderType,
      ...(expirationMinutes !== undefined ? { expirationMinutes } : {}),
      userReference,
    },
  };
}

function resolveMoneyline1x2Outcome(value: string | undefined, game: Game): string {
  if (!value) throw new Error('moneyline1x2 requires --outcome draw, home, away, or a participant id');
  const normalized = value.toLowerCase();
  if (normalized === 'draw') return 'draw';
  if (normalized === 'home' || normalized === 'away') {
    const id = participantIdForSide(game.participants, normalized);
    if (!id) throw new Error(`Could not resolve ${normalized} participant for moneyline1x2 outcome`);
    return id;
  }
  return value;
}

function usage() {
  return {
    commands: [
      'status',
      'leagues',
      'list-games [--league MLB] [--kind standard|specials|props|futures] [--sport baseball|soccer|tennis|...] [--parent <parentGameID>] [--live-only] [--search text] [--limit 50] [--offset 0]',
      'lines --game-id <id> [--market moneyline|spread|total|moneyline1x2|all] [--depth 5]   # full per-line ladder with liquidity; flags the main line',
      'watch --game-id <id>',
      'unwatch --game-id <id>',
      'watched',
      'balance',
      'orders [--game-id <id>]',
      'unmatched',
      'matched',
      'by-reference --user-reference <ref> [--game-id <id>]',
      'pnl [--from MM-DD-YYYY] [--to MM-DD-YYYY]',
      'lookup --order-id <id>',
      'bet --id <id> | --tx-id <id>',
      'wager-request --id <wagerRequestID>',
      'liability --game-id <id>',
      'participants [--active]',
      'discover-games --league <LEAGUE|upcoming> [--sport <sport>]',
      'average-price --league <LEAGUE>',
      'single-orderbook --game-id <id>',
      'affiliate-commission [--from MM-DD-YYYY] [--to MM-DD-YYYY]',
      'settlement-journal [--tail 20]   # cached exchange-backed settlement/P&L snapshots',
      'lifecycle [--tail 20]',
      'activity [--tail 20] [--date YYYY-MM-DD]',
      'place --game-id <id> --market moneyline|spread|total --side home|away|over|under --odds <american|decimal> --bet <amount> [--number <line>] [--expires-in <minutes>] [--order-type limit|post|postArb|fillAndKill] [--confirm]  # odds: |v|>=100 is American, 1<v<100 is decimal (e.g. 1.66); API is sent American',
      'place --game-id <id> --market moneyline1x2 --side yes|no --outcome draw|home|away --odds <american|decimal> --bet <amount> [--order-type limit|post|fillAndKill] [--confirm]  # props: --market total on a --kind props game; outrights: --market moneyline on a --kind futures game',
      'cancel --session-id <id>',
      'cancel-all --game-id <id> [--type moneyline|spread|total|moneyline1x2]',
      'cancel-multiple --session-ids <id,id,id>',
      'cancel-ref --game-id <id> --user-references <ref,ref>',
      'cancel-all-league --league <LEAGUE>   # returns immediately ({ordersReceived:true})',
      'cancel-all-orders',
      'edit-order --session-id <id> --odds <american|decimal> --bet <amount> --confirm --confirm-replace   # guarded cancel-and-replace',
      'positions   # normalized account positions and shape warnings (cached)',
      'exposure    # open risk, day-open balance, drawdown (cached)',
    ],
  };
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const config = getRuntimeConfig();
  const state = readStateSync(config);

  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      printJson({ ok: true, ...usage() });
      return;

    case 'status':
      printJson({
        ok: true,
        status: state.status,
        updatedAt: state.updatedAt,
        startedAt: state.startedAt,
        catalogCount: state.catalog.games.length,
        catalog: {
          updatedAt: state.catalog.updatedAt,
          lastAttemptAt: state.catalog.lastAttemptAt,
          lastOkAt: state.catalog.lastOkAt,
          stale: state.catalog.stale,
          consecutiveErrorCount: state.catalog.consecutiveErrorCount,
          ...(state.catalog.lastError ? { lastError: state.catalog.lastError } : {}),
        },
        watchedCount: state.watchList.length,
        balance: state.balance,
        config: state.config,
        streams: state.streams,
        alerts: state.alerts.slice(-10),
        heartbeat: state.heartbeat,
        settlement: state.settlement,
        participants: {
          active: state.participants.active,
          count: state.participants.items.length,
          stale: state.participants.stale,
          lastOkAt: state.participants.lastOkAt,
        },
      });
      return;

    case 'list-games': {
      const filtered = filterGames(state.catalog.games, args);
      const offset = Math.max(0, Math.trunc(num(args, '--offset') ?? 0));
      const limitRaw = num(args, '--limit');
      const limit = limitRaw === undefined ? 50 : Math.trunc(limitRaw);
      const page = limit > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
      printJson({
        ok: true,
        total: filtered.length,
        offset,
        limit,
        count: page.length,
        updatedAt: state.catalog.updatedAt,
        failedLeagues: state.catalog.failedLeagues,
        freshness: {
          lastAttemptAt: state.catalog.lastAttemptAt,
          lastOkAt: state.catalog.lastOkAt,
          stale: state.catalog.stale,
          consecutiveErrorCount: state.catalog.consecutiveErrorCount,
          ...(state.catalog.lastError ? { lastError: state.catalog.lastError } : {}),
        },
        games: page.map(summarizeGame),
      });
      return;
    }

    case 'lines': {
      const game = findGame(required(args, '--game-id'));
      if (!game) {
        throw new Error(`Game ${opt(args, '--game-id')} is not in state yet; wait for catalog polling or check the game id`);
      }
      const market = (opt(args, '--market') ?? 'all').toLowerCase();
      const LINE_MARKETS = new Set(['moneyline', 'spread', 'total', 'moneyline1x2', 'all']);
      if (!LINE_MARKETS.has(market)) {
        throw new Error('--market must be moneyline, spread, total, moneyline1x2, or all');
      }
      const depthRaw = num(args, '--depth');
      const depth = depthRaw === undefined ? 5 : Math.max(0, Math.trunc(depthRaw));
      const names = labels(game);
      const want = (m: string) => market === 'all' || market === m;
      const out: Record<string, unknown> = {
        ok: true,
        gameId: game.id,
        eventName: game.eventName ?? `${names.away} vs ${names.home}`,
        league: game.league,
        start: game.start,
        catalogUpdatedAt: state.catalog.updatedAt,
      };
      if (want('total')) {
        out.total = {
          main: game.mainTotal,
          over: lineGroupsOut(game.over, 'total', game.mainTotal, depth),
          under: lineGroupsOut(game.under, 'total', game.mainTotal, depth),
        };
      }
      if (want('spread')) {
        out.spread = {
          mainAway: game.mainAwaySpread,
          mainHome: game.mainHomeSpread,
          away: lineGroupsOut(game.awaySpreads, 'spread', game.mainAwaySpread, depth),
          home: lineGroupsOut(game.homeSpreads, 'spread', game.mainHomeSpread, depth),
        };
      }
      if (want('moneyline')) {
        out.moneyline = {
          away: moneylineLadder(game.awayMoneylines, depth),
          home: moneylineLadder(game.homeMoneylines, depth),
        };
      }
      if (want('moneyline1x2')) {
        const away = moneyline1x2Ladder(game.awayMoneylines1x2, depth);
        const home = moneyline1x2Ladder(game.homeMoneylines1x2, depth);
        const draw = moneyline1x2Ladder(game.draw1x2, depth);
        // In `all` mode only surface the 1x2 block when it actually carries prices.
        if (market === 'moneyline1x2' || away.length || home.length || draw.length) {
          out.moneyline1x2 = { away, home, draw };
        }
      }
      out.note = 'liquidity = untaken $ available to take at that price; place alternates with place --number <line>';
      printJson(out);
      return;
    }

    case 'leagues': {
      // Live discovery order (getAvailableLeagues) isn't cached, so derive the
      // league list + per-league sport/count from the catalog we already have.
      const counts = new Map<string, { sport: string; count: number }>();
      for (const game of state.catalog.games) {
        if (!game.league) continue;
        const entry = counts.get(game.league) ?? { sport: String(game.sport ?? ''), count: 0 };
        entry.count += 1;
        if (!entry.sport && game.sport != null) entry.sport = String(game.sport);
        counts.set(game.league, entry);
      }
      const leagues = [...counts.entries()]
        .map(([league, { sport, count }]) => ({ league, sport, games: count }))
        .sort((a, b) => b.games - a.games || a.league.localeCompare(b.league));
      printJson({
        ok: true,
        count: leagues.length,
        updatedAt: state.catalog.updatedAt,
        failedLeagues: state.catalog.failedLeagues,
        leagues,
      });
      return;
    }

    case 'watch': {
      const response = await sendCommand('watch', { gameID: required(args, '--game-id') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'unwatch': {
      const response = await sendCommand('unwatch', { gameID: required(args, '--game-id') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'watched': {
      const games = state.watchList
        .map(gameID => state.catalog.games.find(game => game.id === gameID))
        .filter((game): game is Game => Boolean(game))
        .map(summarizeGame);
      printJson({ ok: true, count: games.length, games });
      return;
    }

    case 'balance':
      printJson({ ok: true, balance: state.balance, alerts: state.alerts.slice(-5) });
      return;

    case 'orders': {
      const gameID = opt(args, '--game-id');
      const orders = gameID
        ? { [gameID]: state.ordersByGame[gameID] ?? { unmatched: [], matched: [] } }
        : state.ordersByGame;
      printJson({ ok: true, orders });
      return;
    }

    case 'activity': {
      const tail = Number.parseInt(opt(args, '--tail') ?? '20', 10);
      const events = readActivityLog({
        date: opt(args, '--date'),
        tail: Number.isFinite(tail) && tail > 0 ? tail : 20,
        config,
      });
      printJson({ ok: true, count: events.length, events });
      return;
    }

    case 'lifecycle': {
      const tail = Math.max(1, Math.trunc(num(args, '--tail') ?? 20));
      const records = state.lifecycle.slice(-tail).reverse();
      printJson({ ok: true, count: records.length, records });
      return;
    }

    case 'place': {
      const response = await sendCommand('place', buildPlacePayload(args), { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'cancel': {
      const response = await sendCommand('cancel', { sessionID: required(args, '--session-id') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'cancel-all': {
      const type = opt(args, '--type');
      if (type !== undefined && !MARKETS.has(type)) throw new Error('--type must be moneyline, spread, total, or moneyline1x2');
      const response = await sendCommand('cancelAll', {
        gameID: required(args, '--game-id'),
        ...(type ? { type } : {}),
      }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'unmatched': {
      const response = await sendCommand('unmatched', {}, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'matched': {
      const response = await sendCommand('matched', {}, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'graded':
    case 'by-reference': {
      const response = await sendCommand('graded', {
        userReference: required(args, '--user-reference'),
        ...(opt(args, '--game-id') ? { gameID: opt(args, '--game-id') } : {}),
      }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'pnl': {
      const response = await sendCommand('pnl', {
        ...(opt(args, '--from') ? { startDate: opt(args, '--from') } : {}),
        ...(opt(args, '--to') ? { endDate: opt(args, '--to') } : {}),
      }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'lookup': {
      const response = await sendCommand('lookup', { orderID: required(args, '--order-id') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'bet': {
      const id = opt(args, '--id');
      const txID = opt(args, '--tx-id');
      if ((id ? 1 : 0) + (txID ? 1 : 0) !== 1) throw new Error('Pass exactly one of --id or --tx-id');
      const response = await sendCommand('bet', { ...(id ? { id } : {}), ...(txID ? { txID } : {}) }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'wager-request': {
      const response = await sendCommand('wagerRequest', { wagerRequestID: required(args, '--id') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'liability': {
      const response = await sendCommand('liability', { gameID: required(args, '--game-id') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'participants': {
      const response = await sendCommand('participants', flag(args, '--active') ? { active: true } : {}, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'discover-games': {
      const response = await sendCommand('gamesIndex', {
        league: required(args, '--league'),
        ...(opt(args, '--sport') ? { sport: opt(args, '--sport') } : {}),
      }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'average-price': {
      const response = await sendCommand('averagePrice', { leagueRequested: required(args, '--league') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'single-orderbook': {
      const response = await sendCommand('singleOrderbook', { gameID: required(args, '--game-id') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'affiliate-commission': {
      const response = await sendCommand('affiliateCommission', {
        ...(opt(args, '--from') ? { fromDate: opt(args, '--from') } : {}),
        ...(opt(args, '--to') ? { toDate: opt(args, '--to') } : {}),
      }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'settlement-journal': {
      const tail = Math.max(1, Math.trunc(num(args, '--tail') ?? 20));
      printJson({ ok: true, settlement: state.settlement, entries: state.settlementJournal.slice(-tail).reverse() });
      return;
    }

    case 'cancel-multiple': {
      const raw = required(args, '--session-ids');
      const sessionIDs = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (sessionIDs.length === 0) throw new Error('--session-ids must be a comma-separated list of session ids');
      const response = await sendCommand('cancelMultiple', { sessionIDs }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'cancel-ref': {
      const userReferences = required(args, '--user-references').split(',').map(item => item.trim()).filter(Boolean);
      if (userReferences.length === 0) throw new Error('--user-references must be a comma-separated list');
      const response = await sendCommand('cancelByReference', { gameID: required(args, '--game-id'), userReferences }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'cancel-all-league': {
      const response = await sendCommand('cancelAllForLeague', { league: required(args, '--league') }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'cancel-all-orders': {
      const response = await sendCommand('cancelAllOrders', {}, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'edit-order': {
      const oddsRaw = num(args, '--odds');
      const bet = num(args, '--bet');
      if (oddsRaw === undefined) throw new Error('Missing --odds');
      if (bet === undefined) throw new Error('Missing --bet');
      const odds = normalizeOddsInput(oddsRaw);
      if (!odds) throw new Error('--odds must be American (<= -100 or >= 100) or decimal (> 1.0 and < 100, e.g. 1.66)');
      const response = await sendCommand('editOrder', {
        sessionID: required(args, '--session-id'),
        odds: odds.american,
        bet,
        confirm: flag(args, '--confirm'),
        confirmReplace: flag(args, '--confirm-replace'),
      }, { config });
      printJson(response);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'positions': {
      printJson({
        ok: true,
        positions: state.positions,
        ...(state.positions === null ? { note: 'positions poll has not completed yet' } : {}),
      });
      return;
    }

    case 'exposure': {
      let openUnmatchedRisk = 0;
      for (const order of state.positions?.unmatched ?? []) {
        const remaining = order.remainingRisk ?? Math.max(0, (order.offeredRisk ?? 0) - (order.filledRisk ?? 0));
        openUnmatchedRisk += remaining;
      }
      let matchedOpenDownside = 0;
      for (const pos of state.positions?.matched ?? []) matchedOpenDownside += pos.risk;
      const balance = state.balance?.balance ?? null;
      const dayOpen = state.dayOpenBalance;
      printJson({
        ok: true,
        openUnmatchedRisk: Math.round(openUnmatchedRisk * 100) / 100,
        matchedOpenDownside: Math.round(matchedOpenDownside * 100) / 100,
        totalOpenRisk: Math.round((openUnmatchedRisk + matchedOpenDownside) * 100) / 100,
        balance,
        dayOpenBalance: dayOpen,
        balanceDrawdown: balance !== null && dayOpen ? Math.round((dayOpen.balance - balance) * 100) / 100 : null,
        note: 'balanceDrawdown is balance movement, not pure betting PnL',
        positionsUpdatedAt: state.positions?.updatedAt ?? null,
      });
      return;
    }

    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch(err => {
  printJson({ ok: false, error: err instanceof Error ? err.message : String(err), ...usage() });
  process.exitCode = 1;
});
