// Shared builders for automation tests (run against built dist/ output).

export function makeGame(overrides = {}) {
  return {
    id: 'game-1',
    league: 'MLB',
    sport: 'baseball',
    start: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    ended: false,
    isOpen: true,
    participants: [
      { id: 'part-away', longName: 'AWAY TEAM', homeAway: 'away' },
      { id: 'part-home', longName: 'HOME TEAM', homeAway: 'home' },
    ],
    awayMoneylines: [{ odds: 120 }],
    homeMoneylines: [{ odds: -140 }],
    awaySpreads: [{ odds: -110, spread: 1.5 }],
    homeSpreads: [{ odds: -110, spread: -1.5 }],
    over: [{ odds: -105, total: 8.5 }],
    under: [{ odds: -115, total: 8.5 }],
    mainHomeSpread: -1.5,
    mainAwaySpread: 1.5,
    mainTotal: 8.5,
    ...overrides,
  };
}

export function makeUnmatched(overrides = {}) {
  return {
    sessionID: 'sess-1',
    stableOrderKey: 'ref:4c-100-abc',
    gameID: 'game-1',
    league: 'MLB',
    market: 'moneyline',
    side: 'home',
    odds: 150,
    offeredRisk: 5,
    filledRisk: 0,
    remainingRisk: 5,
    firstSeenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    firstSeenSource: 'exchange',
    userReference: '4c-100-abc',
    ...overrides,
  };
}

export function makeMatched(overrides = {}) {
  return {
    txID: 'tx-1',
    stableOrderKey: 'ref:4c-100-abc',
    linkConfidence: 'exact',
    gameID: 'game-1',
    league: 'MLB',
    market: 'moneyline',
    side: 'home',
    odds: 150,
    risk: 5,
    win: 7.43,
    userReference: '4c-100-abc',
    matchedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeSnapshot(overrides = {}) {
  return {
    unmatched: [],
    matched: [],
    marketStates: {},
    updatedAt: new Date().toISOString(),
    shapeWarnings: [],
    ...overrides,
  };
}

export function activeMarket(gameID = 'game-1') {
  return { [gameID]: { gameID, state: 'active', source: 'catalog', observedAt: new Date().toISOString() } };
}

export function engineInput(overrides = {}) {
  return {
    now: Date.now(),
    prevPositions: null,
    positions: null,
    deltas: [],
    games: [],
    balance: null,
    dayOpenBalance: null,
    rules: [],
    ruleState: {},
    pendingSuggestions: {},
    recentFingerprints: {},
    maxBet: 5,
    commissionTakerRate: 0.01,
    hedgeProfitBuffer: 0.25,
    cmdPrefix: 'ssh hermes "node /home/ubuntu/4castserver/dist/cli.js ',
    cmdSuffix: '"',
    ...overrides,
  };
}
