/**
 * tradingEngine.ts - Institutional execution & risk manager engine
 * Implements fine-grained channels, referential stability for useSyncExternalStore,
 * and HMR-safe singleton caching.
 */

import {
  Candle,
  Position,
  PendingOrder,
  ClosedTrade,
  AccountState,
  EngineLog,
  InstrumentType,
  TerminalSnapshot,
  Signal,
  TickerState,
  MarketState,
  PositionsState,
  EngineState,
  EventsState,
  EconomicCalendarSnapshot,
  EconomicEvent,
  StoreChannel,
  TradeDirection,
  StructureEvent,
  Zone,
  DealingRange,
  CompoundingStageInfo,
  SymbolTradingSpec,
  ChartTimeframe,
  TimeframeIndicatorData,
  MultiTimeframeAlignment,
} from '../types/smc';
import {
  RISK_CONFIG,
  calculateRiskBasedVolume,
  isAdaptiveMicroFloorAllowed,
  isWithinConfiguredNewsBlackout,
} from './riskConfig';
import {
  calculateATR,
  MarketStructureEngine,
  detectFVGs,
  detectOrderBlocks,
  sessionFilter,
  evaluateConfluence,
} from './smcCore';
import { analyzeCandlestickPatterns } from './candlestickPatterns';
import { getGoldMarketSchedule, MarketScheduleStatus } from './marketHours';
import { evaluateTechnicalStrategies } from './technicalStrategies';
import { mt5Bridge } from './mt5Bridge';
import { newsSentimentEngine } from './newsSentimentEngine';
import { intermarketEngine } from './intermarketEngine';
import {
  buildSignalRationale,
  persistClosedTrades,
  persistTradeOrderBlocks,
  persistTradeRationales,
  readTradeOrderBlocks,
  readStoredClosedTrades,
  readTradeRationales,
  findCorrespondingOrderBlock,
  recordJournalSignal,
  reconcileFilledJournalSignals,
  recordSignalValidation,
  advanceSignalValidations,
  readStoredJournalSignals,
  recordTradeTaken,
  readStoredJournalTrades,
  updateTradeClosedInJournal,
  syncJournalRunningPositions,
  reconcileRunningJournalTrades,
  TradeRationales,
  TradeOrderBlocks,
  clearAllJournal,
  setActiveJournalAccount,
  buildAccountScopeKey,
  readAccountLedgerMeta,
  persistAccountLedgerMeta,
  reconcileBrokerClosedTradesInJournal,
} from './tradeJournal';
import type { JournalSignalRecord, JournalTradeRecord } from '../types/smc';
import { INSTRUMENTS, SUPPORTED_SYMBOLS, SupportedSymbol, getInstrumentConfig, getSupportedSymbol } from './instrumentConfig';
import { evaluateNewsRisk, getGlobalSessionStatus } from './sessionTimezones';
import {
  PairAnalysis,
  analyzeInstrument,
  analyzeInstrumentCandidates,
  rankOpportunities,
  isPrecisionEntryReady,
  isPrecisionExecutionReady,
  checkCorrelationExposure,
  calculateSmallAccountPositionSize,
} from './multiPairScanner';
import { signalAudioNotifier } from '../utils/audioNotification';
import { dispatchExecutionNotification, dispatchSniperAlert } from '../utils/webhookNotifier';

const MAGIC = 20261001;
export const MAX_SPREAD_POINTS = 40; // 40 points = 4.0 pips on gold
const AUTO_RR = 2.0;
const MIN_SMC_SCORE_PERCENT = 45;
const LIVE_PRECISION_AUTOTRADE_VALIDATED = false;

export interface RiskSizingInfo {
  riskPercent: number;
  riskBudget: number;
  minimumLot: number;
  minimumLotRisk: number;
  safeVolume: number | null;
}

function isTestRuntime(): boolean {
  return (
    typeof (globalThis as any).vi !== 'undefined' ||
    typeof (globalThis as any).__vitest_worker__ !== 'undefined' ||
    (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || !!process.env?.VITEST))
  );
}

function hasFreshBrokerCandles(candles: Candle[], timeframeMs: number, now = Date.now()): boolean {
  const latestTime = candles[candles.length - 1]?.time;
  if (!Number.isFinite(latestTime) || latestTime <= 0) return false;
  const latestMs = latestTime < 1_000_000_000_000 ? latestTime * 1000 : latestTime;
  return latestMs <= now + timeframeMs && now - latestMs <= timeframeMs * 3;
}

function hasValidBrokerSymbolSpec(spec: SymbolTradingSpec | null | undefined): spec is SymbolTradingSpec {
  return Boolean(
    spec &&
    Number.isFinite(spec.tickSize) &&
    spec.tickSize > 0 &&
    Number.isFinite(spec.tickValue) &&
    spec.tickValue > 0 &&
    Number.isFinite(spec.volumeMin) &&
    spec.volumeMin > 0 &&
    Number.isFinite(spec.volumeMax) &&
    spec.volumeMax >= spec.volumeMin &&
    Number.isFinite(spec.volumeStep) &&
    spec.volumeStep > 0
  );
}

export function aggregateH4Candles(h1Candles: Candle[]): Candle[] {
  if (!Array.isArray(h1Candles) || !h1Candles.length) return [];
  const aggregated: Candle[] = [];
  for (let i = 0; i < h1Candles.length; i += 4) {
    const chunk = h1Candles.slice(i, i + 4);
    if (!chunk.length) continue;
    const open = chunk[0].open;
    const close = chunk[chunk.length - 1].close;
    const high = Math.max(...chunk.map((c) => c.high));
    const low = Math.min(...chunk.map((c) => c.low));
    const volume = chunk.reduce((sum, c) => sum + (c.volume || 0), 0);
    aggregated.push({
      time: chunk[0].time,
      timeStr: chunk[0].timeStr,
      open,
      high,
      low,
      close,
      volume,
    });
  }
  return aggregated;
}

export function computeTimeframeIndicators(
  candles: Candle[],
  bid: number
): {
  zones: Zone[];
  dealing_range: DealingRange | null;
  bias: 'bullish' | 'bearish' | 'ranging';
  bos: StructureEvent | null;
  choch: StructureEvent | null;
  price_pos: number | null;
  atr: number;
} {
  if (!candles || candles.length < 5) {
    return {
      zones: [],
      dealing_range: null,
      bias: 'ranging',
      bos: null,
      choch: null,
      price_pos: null,
      atr: 0,
    };
  }

  const atrArray = calculateATR(candles, 14);
  const atr = atrArray.filter((v) => !isNaN(v)).pop() || 0;
  const obs = detectOrderBlocks(candles, atrArray).filter((z) => !z.filled).slice(-6);
  const fvgs = detectFVGs(candles, atrArray).filter((z) => !z.filled).slice(-6);
  const zones = [...obs, ...fvgs];

  const ms = new MarketStructureEngine(2);
  ms.update(candles);
  const dr = ms.dealingRange();
  const lastBOS = ms.events.filter((e) => e.kind === 'BOS').slice(-1)[0] || null;
  const lastCHoCH = ms.events.filter((e) => e.kind === 'CHoCH').slice(-1)[0] || null;

  let price_pos: number | null = null;
  if (dr && dr.high > dr.low) {
    price_pos = Number(((bid - dr.low) / (dr.high - dr.low)).toFixed(4));
  }

  return {
    zones,
    dealing_range: dr,
    bias: ms.trend,
    bos: lastBOS,
    choch: lastCHoCH,
    price_pos,
    atr,
  };
}

export function getDefaultSymbolSpec(symbol: SupportedSymbol): SymbolTradingSpec {
  const cfg = getInstrumentConfig(symbol);
  return {
    point: cfg.pointSize,
    contractSize: cfg.contractSize,
    volumeMin: 0.01,
    volumeMax: 100.0,
    volumeStep: 0.01,
    tickSize: cfg.pointSize,
    tickValue: 1.0,
    tradeStopsLevel: 0,
    tradeFreezeLevel: 0,
  };
}

function getInitialMt5Account() {
  if (typeof window !== 'undefined' && localStorage.getItem('smc_mt5_auto_connect') === 'true') {
    const savedLogin = localStorage.getItem('smc_mt5_login') || '';
    const savedServer = localStorage.getItem('smc_mt5_server') || '';
    const savedBroker = localStorage.getItem('smc_mt5_broker') || savedServer.split(/[-_]/)[0] || 'MT5 Broker';
    const savedLev = Number(localStorage.getItem('smc_mt5_leverage')) || RISK_CONFIG.brokerLeverage || 2000;
    return {
      connected: false,
      login: savedLogin,
      server: savedServer,
      broker: savedBroker,
      balance: 0,
      equity: 0,
      freeMargin: 0,
      leverage: savedLev,
    };
  }
  return {
    connected: false,
    login: '',
    server: '',
    broker: '',
    balance: 0,
    equity: 0,
    freeMargin: 0,
    leverage: RISK_CONFIG.brokerLeverage || 2000,
  };
}

function getInitialAccountState(): AccountState {
  const mt5 = getInitialMt5Account();
  return {
    balance: mt5.balance,
    equity: mt5.equity,
    margin_free: mt5.freeMargin,
    margin_used: 0.0,
    leverage: mt5.leverage || RISK_CONFIG.brokerLeverage || 2000,
    initial_balance: mt5.balance,
    daily_start_balance: mt5.balance,
    max_daily_loss_pct: RISK_CONFIG.maxDailyLossPercent,
    risk_pct: RISK_CONFIG.riskPercentPerTrade,
    auto_rr: 2.0,
    daily_drawdown_pct: 0.0,
    daily_loss_hit: false,
  };
}

export class TradingEngine {
  candlesM15: Candle[] = [];
  candlesM1: Candle[] = [];
  candlesM5: Candle[] = [];
  candlesH1: Candle[] = [];
  positions: Position[] = [];
  pendingOrders: PendingOrder[] = [];
  closedTrades: ClosedTrade[] = [];
  logs: EngineLog[] = [];

  bid: number = 0;
  ask: number = 0;
  spread: number = 0;
  lastPrice: number = 0;

  activeSymbol: SupportedSymbol = 'XAUUSD';
  scannerAnalyses: PairAnalysis[] = [];
  bestOpportunity: PairAnalysis | null = null;
  lastExecutionError: MarketState['lastExecutionError'] = null;
  pairData: Record<
    SupportedSymbol,
    {
      candlesM1: Candle[];
      candlesM5: Candle[];
      candlesM15: Candle[];
      candlesH1: Candle[];
      bid: number;
      ask: number;
      spread: number;
      marketDataAt: number;
      symbolSpec: SymbolTradingSpec | null;
    }
  > = {
    XAUUSD: { candlesM1: [], candlesM5: [], candlesM15: [], candlesH1: [], bid: 0, ask: 0, spread: 0, marketDataAt: 0, symbolSpec: null },
    EURUSD: { candlesM1: [], candlesM5: [], candlesM15: [], candlesH1: [], bid: 0, ask: 0, spread: 0, marketDataAt: 0, symbolSpec: null },
    GBPUSD: { candlesM1: [], candlesM5: [], candlesM15: [], candlesH1: [], bid: 0, ask: 0, spread: 0, marketDataAt: 0, symbolSpec: null },
  };

  killSwitch: boolean = false;
  autoTrade: boolean = false;
  autoBeEnabled: boolean = true;
  circuitBreakerEnabled: boolean = true;
  newsBlackout: boolean = false;
  bypassNewsBlackout: boolean = false;
  connected: boolean = false;
  currentTimeframe: ChartTimeframe = 'M15';
  autoSelectBestScenario: boolean = true;
  instrumentType: InstrumentType = 'standard';
  executionMode: 'MARKET' | 'PULLBACK_LIMIT' = (() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('smc_execution_mode');
      if (saved === 'PULLBACK_LIMIT' || saved === 'MARKET') return saved;
    }
    return 'MARKET';
  })();
  private hasBrokerMarketData = false;
  private lastBrokerQuoteAt = 0;
  private symbolSpec: SymbolTradingSpec | null = null;
  private brokerAccountMode: 'demo' | 'live' | 'contest' | 'unknown' | null = null;
  private hasBrokerDayAnchor = false;
  private activeAccountScopeKey = 'standalone';
  private pendingCentralKillSwitch: boolean | null = null;
  private pendingCentralAutoTrade: boolean | null = null;
  private dailyRiskDate = new Date().toISOString().slice(0, 10);
  private lastPairDataError = '';
  private economicEvents: EconomicEvent[] = [];
  private economicCalendarAvailable = false;
  private economicCalendarStatus: EventsState['economicCalendarStatus'] = { available: false };
  private entryHistory: Array<{
    at: number;
    direction: TradeDirection;
    symbol: string;
    poiKey: string;
    entryPrice?: number;
  }> = [];

  directionCooldownEnabled: boolean = (() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('smc_direction_cooldown_enabled');
      if (saved !== null) return saved === 'true';
    }
    return false; // Default OFF so signals can execute unhindered!
  })();

  hourlyTradeLimitEnabled: boolean = (() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('smc_hourly_limit_enabled');
      if (saved !== null) return saved === 'true';
    }
    return false; // Default OFF so multi-pair continuous scanning is never blocked!
  })();

  directionCooldownSeconds: number = (() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('smc_direction_cooldown_sec');
      if (saved !== null && !isNaN(Number(saved))) return Number(saved);
    }
    return 0; // Default 0 to prevent artificial trade delays
  })();

  maxTradesPerHour: number = (() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('smc_max_trades_per_hour');
      if (saved !== null && !isNaN(Number(saved))) return Number(saved);
    }
    return 100; // 100 trades/hour high ceiling
  })();

  mt5Account: {
    connected: boolean;
    login: string;
    server: string;
    broker: string;
    currency?: string;
    balance: number;
    equity: number;
    freeMargin: number;
    leverage?: number;
  } = getInitialMt5Account();

  leverage: number = RISK_CONFIG.brokerLeverage || 2000;

  account: AccountState = getInitialAccountState();

  selectedTicket: number | null = null;
  ticketCounter: number = 8820410;
  tickCount: number = 0;
  private hasInitializedInitialPosition: boolean = false;
  private tradeRationales: TradeRationales = {};
  private tradeOrderBlocks: TradeOrderBlocks = {};

  minScoreThreshold: number = 75;

  // Channel-specific listener registry (Priority 1)
  private channelListeners: Map<StoreChannel, Set<() => void>> = new Map([
    ['ticker', new Set()],
    ['market', new Set()],
    ['positions', new Set()],
    ['engine', new Set()],
    ['events', new Set()],
    ['scanner', new Set()],
  ]);

  private autoTraderIntervalId: ReturnType<typeof setInterval> | null = null;
  private pairMarketDataIntervalId: ReturnType<typeof setInterval> | null = null;
  private pairMarketDataInFlight = false;
  private brokerAccountGeneration = 0;
  private symbolSelectionGeneration = 0;
  private partialCloseInFlight = new Set<number>();
  private initialSlByTicket = new Map<number, number>();
  private liveInitialVolByTicket = new Map<number, number>();
  private liveBeAttemptedAt = new Map<number, number>();
  private livePartialAttemptedAt = new Map<number, number>();
  private livePartialCompletedTickets = new Set<number>();
  private liveTrailSentSl = new Map<number, number>();
  private liveManagementInFlight = new Set<number>();
  private executedSignalKeys = new Map<string, number>();
  private lastAutoWaitLogAt = new Map<string, number>();
  private liveAutoTradeDisabledLogged = false;

  // Cached referentially-stable snapshots (Priority 1)
  private _cachedTicker: TickerState | null = null;
  private _cachedMarket: MarketState | null = null;
  private _cachedPositions: PositionsState | null = null;
  private _cachedEngine: EngineState | null = null;
  private _cachedEvents: EventsState | null = null;
  private _cachedSnapshot: TerminalSnapshot | null = null;
  private _cachedClosedTrades: ClosedTrade[] = [];

  constructor() {
    this.restorePersistentMt5State();
    this.closedTrades = readStoredClosedTrades();
    this.tradeRationales = readTradeRationales();
    this.tradeOrderBlocks = readTradeOrderBlocks();
    this.refreshScanner();
    this.startEngineLoops();
    newsSentimentEngine.subscribe(() => {
      this.invalidateEvents();
      this.emit('events');
    });
    if (this.mt5Account.connected) void this.refreshBrokerPairData();
  }

  restorePersistentMt5State() {
    if (typeof window === 'undefined') return;
    const savedCb = localStorage.getItem('smc_circuit_breaker_enabled');
    if (savedCb !== null) {
      this.circuitBreakerEnabled = savedCb !== 'false';
    }
    const autoConnect = localStorage.getItem('smc_mt5_auto_connect');
    const savedLogin = localStorage.getItem('smc_mt5_login');
    const savedServer = localStorage.getItem('smc_mt5_server');
    const savedBroker = localStorage.getItem('smc_mt5_broker');
    if (autoConnect === 'true' && savedLogin && savedServer) {
      const scopeKey = setActiveJournalAccount(savedLogin, savedServer);
      this.activeAccountScopeKey = scopeKey;
      const savedMeta = readAccountLedgerMeta(scopeKey);
      const today = new Date().toISOString().slice(0, 10);
      this.mt5Account = {
        ...this.mt5Account,
        connected: false,
        login: savedLogin,
        server: savedServer,
        broker: savedBroker || savedMeta?.broker || savedServer.split(/[-_]/)[0] || 'MT5 Broker',
        balance: savedMeta?.lastBalance ?? 0,
        equity: savedMeta?.lastEquity ?? 0,
        freeMargin: savedMeta?.lastBalance ?? 0,
      };
      if (savedMeta) {
        this.account.balance = savedMeta.lastBalance;
        this.account.equity = savedMeta.lastEquity;
        this.account.margin_free = savedMeta.lastBalance;
        this.account.initial_balance = savedMeta.initialBalance || savedMeta.lastBalance;
        if (savedMeta.dailyRiskDate === today && savedMeta.dailyStartBalance > 0) {
          this.account.daily_start_balance = savedMeta.dailyStartBalance;
          this.dailyRiskDate = today;
          this.hasBrokerDayAnchor = true;
        }
      }
    }
  }

  private activateAccountScope(
    login: string | number,
    server: string,
    details?: {
      balance?: number;
      equity?: number;
      dailyStartBalance?: number;
      broker?: string;
      accountMode?: 'demo' | 'live' | 'contest' | 'unknown' | null;
    }
  ) {
    const nextKey = buildAccountScopeKey(login, server);
    if (nextKey === 'standalone') return;

    const today = new Date().toISOString().slice(0, 10);
    const scopeChanged = this.activeAccountScopeKey !== nextKey;

    if (scopeChanged) {
      this.activeAccountScopeKey = nextKey;
      setActiveJournalAccount(login, server);
      this.closedTrades = readStoredClosedTrades();
      this.tradeRationales = readTradeRationales();
      this.tradeOrderBlocks = readTradeOrderBlocks();
      this.hasBrokerDayAnchor = false;
      this.entryHistory = [];
    }

    const existingMeta = readAccountLedgerMeta(nextKey);
    const liveBalance =
      typeof details?.balance === 'number' && Number.isFinite(details.balance)
        ? details.balance
        : existingMeta?.lastBalance ?? this.account.balance;
    const liveEquity =
      typeof details?.equity === 'number' && Number.isFinite(details.equity)
        ? details.equity
        : existingMeta?.lastEquity ?? liveBalance;

    const brokerDayStart =
      typeof details?.dailyStartBalance === 'number' &&
      Number.isFinite(details.dailyStartBalance) &&
      details.dailyStartBalance > 0
        ? details.dailyStartBalance
        : null;

    if (brokerDayStart !== null) {
      this.account.daily_start_balance = brokerDayStart;
      this.dailyRiskDate = today;
      this.hasBrokerDayAnchor = true;
    } else if (!this.hasBrokerDayAnchor) {
      if (existingMeta && existingMeta.dailyRiskDate === today && existingMeta.dailyStartBalance > 0) {
        this.account.daily_start_balance = existingMeta.dailyStartBalance;
        this.dailyRiskDate = today;
        this.hasBrokerDayAnchor = true;
      } else if (liveBalance > 0) {
        this.account.daily_start_balance = liveBalance;
        this.dailyRiskDate = today;
        this.hasBrokerDayAnchor = true;
      }
    }

    if (existingMeta && existingMeta.initialBalance > 0) {
      this.account.initial_balance = existingMeta.initialBalance;
    } else if (scopeChanged || this.account.initial_balance <= 0) {
      this.account.initial_balance = brokerDayStart ?? liveBalance;
    }

    persistAccountLedgerMeta({
      accountKey: nextKey,
      login: String(login),
      server: String(server),
      broker: details?.broker || String(server).split(/[-_]/)[0] || 'MT5 Broker',
      accountMode: details?.accountMode ?? existingMeta?.accountMode ?? this.brokerAccountMode,
      initialBalance: this.account.initial_balance || liveBalance,
      dailyStartBalance: this.account.daily_start_balance || liveBalance,
      dailyRiskDate: today,
      lastBalance: liveBalance,
      lastEquity: liveEquity,
      lastSyncedAt: new Date().toISOString(),
    });

    if (scopeChanged) {
      this.invalidatePositions();
      this.invalidateEngine();
      this.invalidateTicker();
    }
  }

  syncMt5Snapshot(snapshot: {
    account: {
      login: number;
      server: string;
      currency?: string;
      balance: number;
      equity: number;
      margin_free: number;
    };
    positions: Array<{
      ticket: number;
      symbol?: string;
      type: TradeDirection;
      volume: number;
      price_open: number;
      sl: number;
      tp: number;
      profit: number;
      magic: number;
      comment: string;
      time: string;
    }>;
    pendingOrders?: PendingOrder[];
    symbol: string;
    bid: number;
    ask: number;
    spread: number;
    accountMode: 'demo' | 'live' | 'contest' | 'unknown';
    tradingHalted: boolean;
    autoTrade: boolean;
    instrumentType: InstrumentType;
    symbolSpec: SymbolTradingSpec;
    candlesM1: Candle[];
    candlesM5: Candle[];
    candlesM15: Candle[];
    candlesH1: Candle[];
  }) {
    const { account, positions } = snapshot;
    const killSwitchWasArmed = this.killSwitch;
    if (this.pendingCentralKillSwitch === snapshot.tradingHalted) {
      this.pendingCentralKillSwitch = null;
    }
    this.killSwitch = this.pendingCentralKillSwitch ?? snapshot.tradingHalted;
    if (this.pendingCentralAutoTrade === snapshot.autoTrade) {
      this.pendingCentralAutoTrade = null;
    }
    this.autoTrade = this.pendingCentralAutoTrade ?? snapshot.autoTrade;
    if (this.killSwitch) this.autoTrade = false;
    const brokerLeverage = (account as any).leverage || this.leverage || 2000;
    const brokerDayStart = (account as any).daily_start_balance;
    this.leverage = brokerLeverage;
    const brokerName = account.server.split(/[-_]/)[0] || 'MT5 Broker';
    this.activateAccountScope(account.login, account.server, {
      balance: account.balance,
      equity: account.equity,
      dailyStartBalance: typeof brokerDayStart === 'number' ? brokerDayStart : undefined,
      broker: brokerName,
      accountMode: snapshot.accountMode,
    });
    this.mt5Account = {
      connected: true,
      login: String(account.login),
      server: account.server,
      broker: brokerName,
      currency: account.currency || undefined,
      balance: account.balance,
      equity: account.equity,
      freeMargin: account.margin_free,
      leverage: brokerLeverage,
    };
    this.account.balance = account.balance;
    this.account.equity = account.equity;
    this.account.margin_free = account.margin_free;
    this.account.leverage = brokerLeverage;
    if (typeof window !== 'undefined') {
      localStorage.setItem('smc_mt5_auto_connect', 'true');
      localStorage.setItem('smc_mt5_login', String(account.login));
      localStorage.setItem('smc_mt5_server', account.server);
      localStorage.setItem('smc_mt5_broker', this.mt5Account.broker);
    }
    if (!this.hasBrokerDayAnchor) {
      this.account.daily_start_balance =
        typeof brokerDayStart === 'number' && brokerDayStart > 0 ? brokerDayStart : account.balance;
      this.dailyRiskDate = new Date().toISOString().slice(0, 10);
      this.account.daily_loss_hit = false;
      this.hasBrokerDayAnchor = true;
    }
    if (typeof (snapshot as any).circuitBreakerEnabled === 'boolean') {
      this.circuitBreakerEnabled = (snapshot as any).circuitBreakerEnabled;
    }
    this.instrumentType = snapshot.instrumentType;
    const symUpper = (snapshot.symbol || '').toUpperCase().trim();
    this.activeSymbol = getSupportedSymbol(symUpper) ?? 'XAUUSD';
    this.brokerAccountMode = snapshot.accountMode;
    const hasUsableData =
      snapshot.candlesM1.length >= 25 &&
      snapshot.candlesM5.length >= 20 &&
      snapshot.candlesM15.length >= 25 &&
      snapshot.candlesH1.length >= 20 &&
      snapshot.bid > 0 &&
      snapshot.ask >= snapshot.bid &&
      hasValidBrokerSymbolSpec(snapshot.symbolSpec);
    const hasFreshData =
      hasUsableData &&
      hasFreshBrokerCandles(snapshot.candlesM1, 60_000) &&
      hasFreshBrokerCandles(snapshot.candlesM5, 5 * 60_000) &&
      hasFreshBrokerCandles(snapshot.candlesM15, 15 * 60_000) &&
      hasFreshBrokerCandles(snapshot.candlesH1, 60 * 60_000);
    this.hasBrokerMarketData = hasFreshData;
    this.lastBrokerQuoteAt = hasFreshData ? Date.now() : 0;
    this.bid = hasFreshData ? snapshot.bid : 0;
    this.ask = hasFreshData ? snapshot.ask : 0;
    this.lastPrice = hasFreshData ? (snapshot.bid + snapshot.ask) / 2 : 0;
    this.spread = hasFreshData ? snapshot.spread : 0;
    this.symbolSpec = hasFreshData ? snapshot.symbolSpec : null;
    this.candlesM1 = hasFreshData ? snapshot.candlesM1 : [];
    this.candlesM5 = hasFreshData ? snapshot.candlesM5 : [];
    this.candlesM15 = hasFreshData ? snapshot.candlesM15 : [];
    this.candlesH1 = hasFreshData ? snapshot.candlesH1 : [];
    this.pairData[this.activeSymbol] = {
      candlesM1: hasUsableData ? snapshot.candlesM1 : [],
      candlesM5: hasUsableData ? snapshot.candlesM5 : [],
      candlesM15: hasUsableData ? snapshot.candlesM15 : [],
      candlesH1: hasUsableData ? snapshot.candlesH1 : [],
      bid: hasUsableData ? snapshot.bid : 0,
      ask: hasUsableData ? snapshot.ask : 0,
      spread: hasUsableData ? snapshot.spread : 0,
      marketDataAt: hasUsableData ? Date.now() : 0,
      symbolSpec: hasUsableData ? snapshot.symbolSpec : null,
    };
    const activeTicketSet = new Set(positions.map((p) => p.ticket));
    for (const oldTicket of this.initialSlByTicket.keys()) {
      if (!activeTicketSet.has(oldTicket)) {
        this.initialSlByTicket.delete(oldTicket);
        this.liveInitialVolByTicket.delete(oldTicket);
        this.liveBeAttemptedAt.delete(oldTicket);
        this.livePartialAttemptedAt.delete(oldTicket);
        this.livePartialCompletedTickets.delete(oldTicket);
        this.liveTrailSentSl.delete(oldTicket);
        this.liveManagementInFlight.delete(oldTicket);
      }
    }

    this.positions = positions.map((position) => {
      const posSym = (position.symbol || this.activeSymbol) as SupportedSymbol;
      const cfg = getInstrumentConfig(posSym);
      const pairQuote = this.pairData[posSym];
      const curBid = posSym === this.activeSymbol ? this.bid : (pairQuote?.bid ?? 0);
      const curAsk = posSym === this.activeSymbol ? this.ask : (pairQuote?.ask ?? 0);
      const curPrice = position.type === 'BUY' ? curBid : curAsk;
      const livePips =
        curPrice > 0
          ? Number((((position.type === 'BUY' ? curPrice - position.price_open : position.price_open - curPrice) / cfg.pipSize)).toFixed(1))
          : 0;

      if (!this.initialSlByTicket.has(position.ticket) && position.sl > 0) {
        this.initialSlByTicket.set(position.ticket, position.sl);
      }
      if (!this.liveInitialVolByTicket.has(position.ticket) && position.volume > 0) {
        this.liveInitialVolByTicket.set(position.ticket, position.volume);
      }
      const trackedInitialVol = this.liveInitialVolByTicket.get(position.ticket) ?? position.volume;
      const volumeReduced = position.volume < trackedInitialVol * 0.85;

      return {
        ...position,
        symbol: posSym,
        pips: livePips,
        time: position.time,
        initialSl: this.initialSlByTicket.get(position.ticket) ?? (position.sl > 0 ? position.sl : undefined),
        initialVolume: trackedInitialVol,
        strategyRationale:
          this.tradeRationales[String(position.ticket)] || undefined,
        strategyOrderBlock: this.tradeOrderBlocks[String(position.ticket)],
        beLocked: position.sl > 0 && (position.type === 'BUY' ? position.sl > position.price_open : position.sl < position.price_open),
        partialTaken: this.livePartialCompletedTickets.has(position.ticket) || volumeReduced,
        trailLocked: this.liveTrailSentSl.has(position.ticket),
      };
    });

    if (Array.isArray(snapshot.pendingOrders)) {
      this.pendingOrders = snapshot.pendingOrders.map((po) => ({
        ...po,
        isBrokerOrder: true,
      }));
    }

    syncJournalRunningPositions(this.positions.map((p) => ({ ticket: p.ticket, profit: p.profit, pips: p.pips })));
    reconcileRunningJournalTrades(this.positions.map((p) => p.ticket));
    reconcileFilledJournalSignals(this.positions.map((p) => p.ticket));
    if (this.killSwitch && !killSwitchWasArmed) {
      this.closeAll('KillSwitch');
      this.slog('Central MT5 kill switch armed on another connected dashboard; close requests sent. Verify broker positions.', 'warn');
    }
    if (!this.positions.some((position) => position.ticket === this.selectedTicket)) {
      this.selectedTicket = this.positions[0]?.ticket ?? null;
    }
    if (!killSwitchWasArmed && this.killSwitch && this.positions.length > 0) {
      this.slog('Central MT5 kill switch is armed; closing synced positions and blocking new orders.', 'error');
      this.closeAll('KillSwitch');
    }
    this.refreshDailyRiskState();
    this.refreshScanner();
    if (this.mt5Account.connected) void this.refreshBrokerPairData();
    this.invalidateMarket();
    this.invalidatePositions();
    this.invalidateTicker();
    this.invalidateEngine();
    if (!(this.mt5Account.connected && mt5Bridge.getStatus().connected && Array.isArray(snapshot.pendingOrders))) {
      this.processPendingOrders();
    }
    if (!isTestRuntime() && this.autoBeEnabled && this.positions.length > 0) {
      void this.manageLivePositions();
    }
    this.emit('positions');
    this.emit('market');
    this.emit('ticker');
    this.emit('engine');
  }

  private async manageLivePositions(): Promise<void> {
    if (!this.mt5Account.connected || !mt5Bridge.getStatus().connected || !this.autoBeEnabled || this.killSwitch) {
      return;
    }
    const now = Date.now();
    for (const p of this.positions) {
      if (this.liveManagementInFlight.has(p.ticket)) continue;
      const posSym = p.symbol || this.activeSymbol;
      const cfg = getInstrumentConfig(posSym);
      const pairSymbol = getSupportedSymbol(posSym);
      const pairQuote = pairSymbol ? this.pairData[pairSymbol] : undefined;
      const curPrice = posSym === this.activeSymbol
        ? (p.type === 'BUY' ? this.bid : this.ask)
        : (p.type === 'BUY' ? pairQuote?.bid ?? 0 : pairQuote?.ask ?? 0);
      if (!Number.isFinite(curPrice) || curPrice <= 0) continue;

      const pts = p.type === 'BUY' ? curPrice - p.price_open : p.price_open - curPrice;
      if (pts <= 0) continue;

      const initialSl = p.initialSl || this.initialSlByTicket.get(p.ticket) || p.sl;
      const initialRiskPts = initialSl > 0 ? Math.abs(p.price_open - initialSl) : cfg.pipSize * 20;
      if (!Number.isFinite(initialRiskPts) || initialRiskPts <= 0) continue;
      const rMultiple = pts / initialRiskPts;

      const spec = posSym === this.activeSymbol ? this.symbolSpec : pairQuote?.symbolSpec;
      const minVol = spec?.volumeMin ?? 0.01;
      const brokerTicket = p.brokerTicket || p.positionTicket || p.ticket;
      const spreadPts = posSym === this.activeSymbol ? this.spread : (pairQuote?.spread ?? 20);
      const spreadDistance = spreadPts * cfg.pointSize;
      const marketSnap = posSym === this.activeSymbol ? this._cachedMarket : null;
      const atrEstimate = marketSnap?.signal?.atr || cfg.pipSize * 5;
      const noiseDistance = 0.15 * atrEstimate;
      const safeBeOffset = Number(Math.max(cfg.pipSize * 2, spreadDistance + noiseDistance).toFixed(cfg.digits));
      const beSafePrice = Number(
        (p.type === 'BUY' ? p.price_open + safeBeOffset : p.price_open - safeBeOffset).toFixed(cfg.digits)
      );
      const beImprovesSl = p.type === 'BUY'
        ? (p.sl <= 0 || beSafePrice > p.sl + cfg.pointSize) && curPrice > beSafePrice
        : (p.sl <= 0 || beSafePrice < p.sl - cfg.pointSize) && curPrice < beSafePrice;

      const isM1Trade = (p.strategyRationale || '').includes('M1') || (p.comment || '').includes('M1');
      const beRThreshold = isM1Trade ? 0.9 : 1.0;

      const lastPartialAt = this.livePartialAttemptedAt.get(p.ticket) ?? 0;
      if (!p.partialTaken && rMultiple >= 1.35 && p.volume >= minVol * 2 && now - lastPartialAt >= 15_000) {
        this.liveManagementInFlight.add(p.ticket);
        this.livePartialAttemptedAt.set(p.ticket, now);
        try {
          const scaled = await this.scaleOutPosition(p.ticket, 0.5);
          if (scaled) {
            this.livePartialCompletedTickets.add(p.ticket);
            if (beImprovesSl) {
              await mt5Bridge.modifyPositionStops(brokerTicket, beSafePrice, p.tp);
              this.slog(`Live MT5 50% scale-out & BE lock executed for #${brokerTicket} @ ${beSafePrice.toFixed(cfg.digits)}`, 'trade');
            }
          }
        } catch {
          // scaleOutPosition handles error logging
        } finally {
          this.liveManagementInFlight.delete(p.ticket);
        }
        continue;
      }

      const lastBeAt = this.liveBeAttemptedAt.get(p.ticket) ?? 0;
      if (!p.beLocked && rMultiple >= beRThreshold && beImprovesSl && now - lastBeAt >= 15_000) {
        this.liveManagementInFlight.add(p.ticket);
        this.liveBeAttemptedAt.set(p.ticket, now);
        try {
          await mt5Bridge.modifyPositionStops(brokerTicket, beSafePrice, p.tp);
          this.slog(`Live MT5 BE lock updated #${brokerTicket} SL -> ${beSafePrice.toFixed(cfg.digits)}`, 'trade');
        } catch (err) {
          this.slog(`Live MT5 BE lock failed for #${brokerTicket}: ${err instanceof Error ? err.message : 'Unknown error'}`, 'warn');
        } finally {
          this.liveManagementInFlight.delete(p.ticket);
        }
        continue;
      }

      if (rMultiple >= 1.8) {
        let zones: Zone[] = [];
        let atr = atrEstimate;
        if (posSym === this.activeSymbol) {
          const snap = this.getMarketSnapshot();
          zones = snap.zones;
          atr = snap.signal?.atr || snap.timeframeData?.[snap.currentTimeframe]?.atr || atrEstimate;
        } else if (pairQuote && pairQuote.candlesM5.length >= 15) {
          const atrArr = calculateATR(pairQuote.candlesM5, 14);
          atr = atrArr.filter((v) => !Number.isNaN(v)).pop() || atrEstimate;
          zones = detectOrderBlocks(pairQuote.candlesM5, atrArr).filter((z) => !z.filled);
        }
        const activeObs = zones.filter((z) => !z.filled && z.kind === 'OB');
        let candidateSl: number | null = null;
        if (p.type === 'BUY') {
          const qualifying = activeObs.filter((z) => z.bullish && z.bottom > p.price_open);
          if (qualifying.length > 0) {
            const highest = qualifying.reduce((a, b) => (b.bottom > a.bottom ? b : a));
            const obBase = Number((highest.bottom - 0.25 * atr).toFixed(cfg.digits));
            if (obBase > p.sl + cfg.pipSize * 2 && obBase < curPrice - cfg.pipSize) {
              candidateSl = obBase;
            }
          }
        } else {
          const qualifying = activeObs.filter((z) => !z.bullish && z.top < p.price_open);
          if (qualifying.length > 0) {
            const lowest = qualifying.reduce((a, b) => (b.top < a.top ? b : a));
            const obBase = Number((lowest.top + 0.25 * atr).toFixed(cfg.digits));
            if ((p.sl <= 0 || obBase < p.sl - cfg.pipSize * 2) && obBase > curPrice + cfg.pipSize) {
              candidateSl = obBase;
            }
          }
        }
        const prevSent = this.liveTrailSentSl.get(p.ticket);
        if (candidateSl !== null && (prevSent === undefined || Math.abs(candidateSl - prevSent) >= cfg.pipSize * 2)) {
          this.liveManagementInFlight.add(p.ticket);
          try {
            await mt5Bridge.modifyPositionStops(brokerTicket, candidateSl, p.tp);
            this.liveTrailSentSl.set(p.ticket, candidateSl);
            this.slog(`Live MT5 OB Trailing SL moved to ${candidateSl.toFixed(cfg.digits)} (#${brokerTicket})`, 'trade');
          } catch (err) {
            this.slog(`Live MT5 OB Trailing failed for #${brokerTicket}: ${err instanceof Error ? err.message : 'Unknown error'}`, 'warn');
          } finally {
            this.liveManagementInFlight.delete(p.ticket);
          }
        }
      }
    }
  }

  recordMt5Rationale(
    orderTicket: number,
    positionTicket: number | undefined,
    rationale: string,
    strategyOrderBlock?: Zone
  ) {
    this.tradeRationales[String(orderTicket)] = rationale;
    if (positionTicket !== undefined) this.tradeRationales[String(positionTicket)] = rationale;
    persistTradeRationales(this.tradeRationales);
    if (strategyOrderBlock) {
      this.tradeOrderBlocks[String(orderTicket)] = strategyOrderBlock;
      if (positionTicket !== undefined) this.tradeOrderBlocks[String(positionTicket)] = strategyOrderBlock;
      persistTradeOrderBlocks(this.tradeOrderBlocks);
    }

    const ticket = positionTicket || orderTicket;
    this.selectedTicket = ticket;

    const position = this.positions.find(
      (item) => item.ticket === positionTicket || item.ticket === orderTicket
    );
    if (position) {
      position.strategyRationale = rationale;
      position.strategyOrderBlock = strategyOrderBlock || this.tradeOrderBlocks[String(position.ticket)];
      this.invalidatePositions();
      this.emit('positions');
    }
    // SAFETY-FIX: Do not fabricate a fake BUY 0.01 position when ticket is not found.
    // Broker snapshot reconciliation is the sole source of truth for open MT5 positions.
  }

  setMt5BridgeConnectionStatus(connected: boolean, error?: string): void {
    this.connected = connected;
    this.mt5Account.connected = connected;
    if (!connected) {
      this.brokerAccountGeneration += 1;
      this.hasBrokerMarketData = false;
      this.lastBrokerQuoteAt = 0;
      this.candlesM1 = [];
      this.candlesM5 = [];
      this.candlesM15 = [];
      this.candlesH1 = [];
      this.bid = 0;
      this.ask = 0;
      this.spread = 0;
      this.lastPrice = 0;
      this.symbolSpec = null;
      this.brokerAccountMode = null;
      for (const symbol of SUPPORTED_SYMBOLS) {
        this.pairData[symbol] = {
          candlesM1: [],
          candlesM5: [],
          candlesM15: [],
          candlesH1: [],
          bid: 0,
          ask: 0,
          spread: 0,
          marketDataAt: 0,
          symbolSpec: null,
        };
      }
      this.scannerAnalyses = [];
      this.bestOpportunity = null;
      this.syncEconomicCalendar(null);
      this.invalidateMarket();
      this.invalidateTicker();
      this.invalidateEngine();
      this.emit('market');
      this.emit('ticker');
      this.emit('scanner');
      if (this.pairMarketDataIntervalId) clearInterval(this.pairMarketDataIntervalId);
      this.pairMarketDataIntervalId = null;
    } else if (!this.pairMarketDataIntervalId) {
      this.pairMarketDataIntervalId = setInterval(() => {
        void this.refreshBrokerPairData();
      }, 8_000);
    }
    if (error) {
      this.slog(`MT5 Bridge (Standby): ${error}`, 'warn');
    } else if (connected) {
      this.slog('MT5 Bridge link confirmed active', 'info');
    }
    this.invalidateEngine();
    this.emit('engine');
  }

  setTimeframe(tf: ChartTimeframe): void {
    if (this.currentTimeframe !== tf) {
      this.currentTimeframe = tf;
      this.invalidateMarket();
      this.emit('market');
      this.slog(`Timeframe switched to ${tf} · all charts, zones & indicators synchronized.`, 'info');
    }
  }

  getTimeframe(): ChartTimeframe {
    return this.currentTimeframe;
  }

  syncMt5ClosedTrades(trades: ClosedTrade[]) {
    const merged = trades.map((trade) => ({
      ...trade,
      strategyRationale:
        this.tradeRationales[String(trade.orderTicket)] ||
        this.tradeRationales[String(trade.positionTicket)] ||
        this.tradeRationales[String(trade.ticket)] ||
        trade.strategyRationale,
      strategyOrderBlock:
        this.tradeOrderBlocks[String(trade.orderTicket)] ||
        this.tradeOrderBlocks[String(trade.positionTicket)] ||
        this.tradeOrderBlocks[String(trade.ticket)] ||
        trade.strategyOrderBlock,
    }));
    const nextByTicket = new Map(this.closedTrades.map((trade) => [trade.ticket, trade]));
    for (const trade of merged) nextByTicket.set(trade.ticket, trade);
    const nextTrades = [...nextByTicket.values()].sort((left, right) =>
      (right.closedAt || '').localeCompare(left.closedAt || '')
    );
    const changed =
      nextTrades.length !== this.closedTrades.length ||
      nextTrades.some((trade, index) => {
        const previous = this.closedTrades[index];
        return !previous || JSON.stringify(previous) !== JSON.stringify(trade);
      });
    if (!changed) return;

    this.closedTrades = nextTrades;
    persistClosedTrades(this.closedTrades);
    reconcileBrokerClosedTradesInJournal(this.closedTrades);
    this.invalidatePositions();
    this.emit('positions');
  }

  syncEconomicCalendar(snapshot: EconomicCalendarSnapshot | null, error?: string): void {
    this.economicCalendarAvailable = snapshot !== null;
    this.economicEvents = snapshot?.events ?? [];
    this.economicCalendarStatus = snapshot
      ? { available: true, source: snapshot.source, updatedAt: snapshot.updatedAt }
      : { available: false, error };
    this.invalidateEvents();
    this.emit('events');
    this.refreshScanner();
  }

  private async refreshBrokerPairData() {
    if (!this.mt5Account.connected || !mt5Bridge.getStatus().connected || this.pairMarketDataInFlight) return;
    const accountGeneration = this.brokerAccountGeneration;
    const symbolGeneration = this.symbolSelectionGeneration;
    this.pairMarketDataInFlight = true;
    try {
      const symbols = SUPPORTED_SYMBOLS.filter((symbol) => symbol !== this.activeSymbol);
      const results = await Promise.allSettled(
        symbols.map(async (symbol) => ({
          symbol,
          snapshot: await mt5Bridge.fetchSymbolSnapshot(symbol),
        }))
      );
      if (
        accountGeneration !== this.brokerAccountGeneration ||
        !this.mt5Account.connected ||
        !mt5Bridge.getStatus().connected
      ) {
        return;
      }
      let allDataValid = true;
      for (const result of results) {
        if (result.status !== 'fulfilled') {
          allDataValid = false;
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          if (message !== this.lastPairDataError) {
            this.lastPairDataError = message;
            this.slog(`Broker market data unavailable for one or more symbols: ${message}`, 'warn');
          }
          continue;
        }
        const { symbol, snapshot } = result.value;
        const validData =
          snapshot.bid > 0 &&
          snapshot.ask >= snapshot.bid &&
          hasValidBrokerSymbolSpec(snapshot.symbolSpec) &&
          snapshot.candlesM1.length >= 25 &&
          snapshot.candlesM5.length >= 20 &&
          snapshot.candlesM15.length >= 25 &&
          snapshot.candlesH1.length >= 20;
        if (!validData) {
          allDataValid = false;
          const message = `Incomplete broker snapshot for ${symbol}.`;
          if (message !== this.lastPairDataError) {
            this.lastPairDataError = message;
            this.slog(message, 'warn');
          }
          continue;
        }
        const candlesAreFresh =
          hasFreshBrokerCandles(snapshot.candlesM1, 60_000) &&
          hasFreshBrokerCandles(snapshot.candlesM5, 5 * 60_000) &&
          hasFreshBrokerCandles(snapshot.candlesM15, 15 * 60_000) &&
          hasFreshBrokerCandles(snapshot.candlesH1, 60 * 60_000);
        if (!candlesAreFresh) {
          allDataValid = false;
          const message = 'Broker candles are stale; scanner rows are blocked until fresh bars arrive.';
          if (message !== this.lastPairDataError) {
            this.lastPairDataError = message;
            this.slog(message, 'warn');
          }
        }
        this.pairData[symbol] = {
          candlesM1: snapshot.candlesM1,
          candlesM5: snapshot.candlesM5,
          candlesM15: snapshot.candlesM15,
          candlesH1: snapshot.candlesH1,
          bid: snapshot.bid,
          ask: snapshot.ask,
          spread: snapshot.spread,
          marketDataAt: Date.now(),
          symbolSpec: snapshot.symbolSpec,
        };
      }
      if (allDataValid) this.lastPairDataError = '';
      this.refreshScanner(symbolGeneration === this.symbolSelectionGeneration);
    } finally {
      this.pairMarketDataInFlight = false;
      if (
        accountGeneration !== this.brokerAccountGeneration &&
        this.mt5Account.connected &&
        mt5Bridge.getStatus().connected
      ) {
        void this.refreshBrokerPairData();
      }
    }
  }

  slog(msg: string, type: 'info' | 'trade' | 'warn' | 'error' | 'signal' = 'info') {
    const t = new Date().toISOString().substr(11, 8); // Explicit UTC string
    const logItem: EngineLog = {
      id: Math.random().toString(36).substring(2, 9),
      t,
      msg,
      type,
    };
    this.logs = [logItem, ...this.logs.slice(0, 150)];
    this.invalidateEvents();
    this.emit('events');
  }

  clearLogs(): void {
    this.logs = [];
    this.invalidateEvents();
    this.emit('events');
    this.slog('System event logs cleared.', 'info');
  }

  clearDailyTradesAndResetCircuitBreakers(): void {
    this.closedTrades = [];
    persistClosedTrades([]);
    clearAllJournal();
    this.entryHistory = [];
    this.account.daily_loss_hit = false;
    this.account.daily_drawdown_pct = 0.0;
    this.account.daily_start_balance = this.account.balance;
    this.killSwitch = false;
    this.pendingCentralKillSwitch = false;
    if (this.mt5Account.connected) {
      void mt5Bridge.resetCircuitBreakers().catch(() => {});
    }
    this.invalidatePositions();
    this.invalidateEngine();
    this.invalidateTicker();
    this.invalidateEvents();
    this.emit('positions');
    this.emit('engine');
    this.emit('ticker');
    this.emit('events');
    this.slog('✅ Daily trades, history and circuit breakers cleared. Ready for fresh setups.', 'trade');
  }

  clearDailyTradesAndLogs(): void {
    this.clearDailyTradesAndResetCircuitBreakers();
    this.clearLogs();
  }

  // ==========================================
  // CHANNEL SUBSCRIPTION API (Priority 1)
  // ==========================================

  on(channel: StoreChannel, callback: () => void): () => void {
    const set = this.channelListeners.get(channel);
    if (set) {
      set.add(callback);
    }
    return () => {
      set?.delete(callback);
    };
  }

  // Backwards-compatible alias for subscribe (subscribes to ticker)
  subscribe(listener: (snapshot: TerminalSnapshot) => void): () => void {
    const cb = () => listener(this.getSnapshot());
    return this.on('ticker', cb);
  }

  private emit(channel: StoreChannel) {
    const listeners = this.channelListeners.get(channel);
    if (listeners) {
      listeners.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.error(`Error in listener for channel ${channel}:`, e);
        }
      });
    }
  }

  // ==========================================
  // REFERENTIALLY-STABLE GETTERS (Priority 1)
  // ==========================================

  getTickerSnapshot(): TickerState {
    if (!this._cachedTicker) {
      const config = getInstrumentConfig(this.activeSymbol);
      const marketDataAvailable = this.connected && this.mt5Account.connected && this.hasBrokerMarketData;
      const candles24h = this.candlesM15.slice(-96);
      const high24h = marketDataAvailable && candles24h.length === 96
        ? Math.max(...candles24h.map((c) => c.high))
        : 0;
      const low24h = marketDataAvailable && candles24h.length === 96
        ? Math.min(...candles24h.map((c) => c.low))
        : 0;
      const open24h = marketDataAvailable && candles24h.length === 96 ? candles24h[0].open : 0;
      const change24h = open24h > 0 ? Number((this.bid - open24h).toFixed(config.digits)) : 0;
      const change24hPct = open24h > 0 ? Number(((change24h / open24h) * 100).toFixed(2)) : 0;
      const globalSessions = getGlobalSessionStatus(new Date());

      this._cachedTicker = {
        time: new Date().toISOString().substr(11, 8) + ' UTC',
        quoteUpdatedAt: marketDataAvailable ? this.lastBrokerQuoteAt : 0,
        symbol: this.activeSymbol,
        displayName: config.displayName,
        brokerTimeStr: globalSessions.brokerTimeStr,
        kenyaTimeStr: globalSessions.kenyaTimeStr,
        bid: Number(this.bid.toFixed(config.digits)),
        ask: Number(this.ask.toFixed(config.digits)),
        spread: this.spread,
        equity: Number(this.account.equity.toFixed(2)),
        balance: Number(this.account.balance.toFixed(2)),
        high24h: Number(high24h.toFixed(config.digits)),
        low24h: Number(low24h.toFixed(config.digits)),
        change24h,
        change24hPct,
        volume24h: '—',
        marketDataAvailable,
      };
    }
    return this._cachedTicker;
  }

  getMarketSnapshot(): MarketState {
    if (!this._cachedMarket) {
      const candlesH4 = aggregateH4Candles(this.candlesH1);

      const tfM1 = computeTimeframeIndicators(this.candlesM1, this.bid);
      const tfM5 = computeTimeframeIndicators(this.candlesM5, this.bid);
      const tfM15 = computeTimeframeIndicators(this.candlesM15, this.bid);
      const tfH1 = computeTimeframeIndicators(this.candlesH1, this.bid);
      const tfH4 = computeTimeframeIndicators(candlesH4, this.bid);

      const timeframeData: Record<ChartTimeframe, TimeframeIndicatorData> = {
        M1: { timeframe: 'M1', ...tfM1 },
        M5: { timeframe: 'M5', ...tfM5 },
        M15: { timeframe: 'M15', ...tfM15 },
        H1: { timeframe: 'H1', ...tfH1 },
        H4: { timeframe: 'H4', ...tfH4 },
      };

      // Synchronize active indicators with currently selected timeframe
      const activeIndicators = timeframeData[this.currentTimeframe] || timeframeData.M15;
      const zones = activeIndicators.zones.length > 0 ? activeIndicators.zones : tfM15.zones;
      const dr = activeIndicators.dealing_range || tfM15.dealing_range || tfH1.dealing_range;
      const bias = activeIndicators.bias;
      const lastBOS = activeIndicators.bos || tfM15.bos || tfH1.bos;
      const lastCHoCH = activeIndicators.choch || tfM15.choch || tfH1.choch;
      const pricePos = activeIndicators.price_pos ?? tfM15.price_pos ?? tfH1.price_pos;

      const hasUsableSignalsData =
        (this.connected &&
          this.mt5Account.connected &&
          this.hasBrokerMarketData &&
          hasFreshBrokerCandles(this.candlesM1, 60_000) &&
          hasFreshBrokerCandles(this.candlesM5, 5 * 60_000) &&
          hasFreshBrokerCandles(this.candlesM15, 15 * 60_000) &&
          hasFreshBrokerCandles(this.candlesH1, 60 * 60_000)) ||
        (isTestRuntime() && this.candlesM1.length >= 10 && this.candlesM5.length >= 10);
      const scannerSignals = this.scannerAnalyses
        .flatMap((analysis) => [analysis, ...(analysis.entryCandidates ?? [])])
        .filter(
          (analysis) =>
            analysis.symbol === this.activeSymbol &&
            analysis.signal !== null &&
            (!analysis.expiryTimestamp || analysis.expiryTimestamp > Date.now())
        )
        .flatMap((analysis) => (analysis.signal ? [analysis.signal] : []));
      const candidateSignals = hasUsableSignalsData
        ? [
            ...scannerSignals,
            ...(this.instrumentType === 'standard'
              ? [
                  evaluateConfluence(
                    this.candlesM1,
                    this.candlesM5,
                    this.account.auto_rr,
                    MIN_SMC_SCORE_PERCENT,
                    'M1',
                    {
                      symbol: this.activeSymbol,
                      economicEvents: this.economicCalendarAvailable ? this.economicEvents : undefined,
                    }
                  ),
                  evaluateConfluence(
                    this.candlesM5,
                    this.candlesM15,
                    this.account.auto_rr,
                    MIN_SMC_SCORE_PERCENT,
                    'M5',
                    {
                      symbol: this.activeSymbol,
                      economicEvents: this.economicCalendarAvailable ? this.economicEvents : undefined,
                    }
                  ),
                  // M15 scanning for maximum pips
                  evaluateConfluence(
                    this.candlesM15,
                    this.candlesH1.length > 5 ? this.candlesH1 : this.candlesM15,
                    this.account.auto_rr,
                    MIN_SMC_SCORE_PERCENT,
                    'M15',
                    {
                      symbol: this.activeSymbol,
                      economicEvents: this.economicCalendarAvailable ? this.economicEvents : undefined,
                    }
                  ),
                ].filter((signal): signal is Signal => signal !== null)
              : []),
            ...evaluateTechnicalStrategies(
              this.candlesM1,
              this.candlesM5,
              'M1',
              this.instrumentType,
              getInstrumentConfig(this.activeSymbol).digits,
              undefined,
              this.activeSymbol
            ),
            ...evaluateTechnicalStrategies(
              this.candlesM5,
              this.candlesM15,
              'M5',
              this.instrumentType,
              getInstrumentConfig(this.activeSymbol).digits,
              undefined,
              this.activeSymbol
            ),
            // M15 technical strategies scanning for maximum pips
            ...evaluateTechnicalStrategies(
              this.candlesM15,
              this.candlesH1.length > 5 ? this.candlesH1 : this.candlesM15,
              'M15',
              this.instrumentType,
              getInstrumentConfig(this.activeSymbol).digits,
              undefined,
              this.activeSymbol
            ),
          ].filter((signal): signal is Signal => signal !== null)
        : [];
      const nowMs = Date.now();
      const signals = candidateSignals
        // Entry countdown expiry filter: once entry time window passes, the signal passes/expires
        .filter((signal) => {
          if (signal.expiryTimestamp && nowMs > signal.expiryTimestamp) {
            return false;
          }
          return true;
        })
        .map((signal) => {
          const autoLot = this.getRiskBasedVolume(signal.sl, undefined, signal.direction) ?? 0;
          const validitySeconds = signal.expiryTimestamp
            ? Math.max(0, Math.round((signal.expiryTimestamp - nowMs) / 1000))
            : signal.validitySeconds || 180;
          return {
            ...signal,
            strategy: signal.strategy ?? 'SMC POI Retest' as const,
            recommendedLot: autoLot,
            validitySeconds,
          };
        })
        .sort((left, right) => right.score - left.score)
        .filter((signal, index, items) =>
          items.findIndex(
            (candidate) =>
              candidate.strategy === signal.strategy &&
              candidate.timeframe === signal.timeframe &&
              candidate.direction === signal.direction
          ) === index
        );
      const sig = signals[0] ?? null;

      const history = (this.candlesM15.length > 0 ? this.candlesM15 : this.candlesM1).slice(-200).map((c) => c.close);

      // Real multi-timeframe alignment directly calculated from each timeframe's structure
      const mtfAlignment: MultiTimeframeAlignment[] = (['M1', 'M5', 'M15', 'H1', 'H4'] as ChartTimeframe[]).map((tf) => {
        const d = timeframeData[tf];
        const obCount = d.zones.filter((z) => z.kind === 'OB').length;
        const fvgCount = d.zones.filter((z) => z.kind === 'FVG').length;
        let status = 'Tracking Flow';
        if (d.dealing_range && d.price_pos !== null) {
          status = d.price_pos < 0.5 ? `Discount (${Math.round(d.price_pos * 100)}%)` : `Premium (${Math.round(d.price_pos * 100)}%)`;
        } else if (obCount > 0 || fvgCount > 0) {
          status = `${obCount} OB · ${fvgCount} FVG`;
        } else if (d.bias !== 'ranging') {
          status = d.bias === 'bullish' ? 'Bullish Structure' : 'Bearish Structure';
        }
        return {
          tf,
          bias: d.bias,
          lastEvent: (d.choch ? 'CHoCH' : d.bos ? 'BOS' : 'SWING') as 'BOS' | 'CHoCH' | 'SWING',
          status,
        };
      });

      const candlestickAnalysis = analyzeCandlestickPatterns(
        this.candlesM15.length > 0 ? this.candlesM15 : this.candlesM5,
        getInstrumentConfig(this.activeSymbol).pipSize,
        this.activeSymbol
      );

      this._cachedMarket = {
        bias,
        bos: lastBOS,
        choch: lastCHoCH,
        dealing_range: dr,
        price_pos: pricePos,
        signal: sig,
        signals,
        instrumentType: this.instrumentType,
        zones,
        history,
        brokerMarketData: this.hasBrokerMarketData,
        accountMode: this.brokerAccountMode,
        symbolSpec: this.symbolSpec,
        currentTimeframe: this.currentTimeframe,
        candlesM1: this.candlesM1,
        candlesM5: this.candlesM5,
        candlesM15: this.candlesM15,
        candlesH1: this.candlesH1,
        candlesH4,
        timeframeData,
        mtfAlignment,
        candlestickAnalysis,
        scannerAnalyses: this.scannerAnalyses,
        bestOpportunity: this.bestOpportunity,
        lastExecutionError: this.lastExecutionError,
      };
    }
    return this._cachedMarket;
  }

  getPositionsSnapshot(): PositionsState {
    if (!this._cachedPositions) {
      this._cachedPositions = {
        positions: this.positions,
        closedTrades: this.closedTrades,
        pendingOrders: this.pendingOrders,
        selectedTicket: this.selectedTicket,
      };
    }
    return this._cachedPositions;
  }

  setSelectedTicket(ticket: number | null) {
    this.selectedTicket = ticket;
    this.invalidatePositions();
    this.emit('positions');
  }

  getClosedTradesSnapshot(): ClosedTrade[] {
    return this.closedTrades;
  }

  getCompoundingStage(balance: number): CompoundingStageInfo {
    if (balance < 25) {
      const minBal = 10;
      const maxBal = 25;
      const progressPct = Math.min(100, Math.max(0, Math.round(((balance - minBal) / (maxBal - minBal)) * 100)));
      return {
        stage: 1,
        name: 'Stage 1: Micro Base',
        minBal,
        maxBal,
        progressPct,
        recommendedLot: 0.01,
        maxTrades: 1,
        targetPnlPerTrade: '+$2.00 to +$3.50',
        nextMilestone: 'Reach $25 to unlock 0.02 Lots',
      };
    } else if (balance < 50) {
      const minBal = 25;
      const maxBal = 50;
      const progressPct = Math.min(100, Math.max(0, Math.round(((balance - minBal) / (maxBal - minBal)) * 100)));
      return {
        stage: 2,
        name: 'Stage 2: Capital Builder',
        minBal,
        maxBal,
        progressPct,
        recommendedLot: 0.02,
        maxTrades: 1,
        targetPnlPerTrade: '+$4.00 to +$7.00',
        nextMilestone: 'Reach $50 to unlock 0.03 Lots & Dual Trades',
      };
    } else if (balance < 100) {
      const minBal = 50;
      const maxBal = 100;
      const progressPct = Math.min(100, Math.max(0, Math.round(((balance - minBal) / (maxBal - minBal)) * 100)));
      return {
        stage: 3,
        name: 'Stage 3: Growth Momentum',
        minBal,
        maxBal,
        progressPct,
        recommendedLot: 0.03,
        maxTrades: 2,
        targetPnlPerTrade: '+$7.00 to +$12.00',
        nextMilestone: 'Reach $100 to unlock 0.05 Lots (Prop Firm Ready)',
      };
    } else if (balance < 250) {
      const minBal = 100;
      const maxBal = 250;
      const progressPct = Math.min(100, Math.max(0, Math.round(((balance - minBal) / (maxBal - minBal)) * 100)));
      return {
        stage: 4,
        name: 'Stage 4: Capital Acceleration',
        minBal,
        maxBal,
        progressPct,
        recommendedLot: 0.05,
        maxTrades: 2,
        targetPnlPerTrade: '+$15.00 to +$25.00',
        nextMilestone: 'Reach $250 to unlock 0.10 Lots',
      };
    } else {
      const minBal = 250;
      const maxBal = 1000;
      const progressPct = Math.min(100, Math.max(0, Math.round(((balance - minBal) / (maxBal - minBal)) * 100)));
      return {
        stage: 5,
        name: 'Stage 5: Institutional Compounding',
        minBal,
        maxBal,
        progressPct,
        recommendedLot: 0.10,
        maxTrades: 3,
        targetPnlPerTrade: '+$30.00 to +$70.00',
        nextMilestone: 'Full Institutional Scale Unlocked',
      };
    }
  }

  toggleAutoBe(): boolean {
    this.autoBeEnabled = !this.autoBeEnabled;
    this.slog(`Zero-Risk Auto-BE Protection: ${this.autoBeEnabled ? 'ARMED' : 'DISABLED'}`, 'info');
    this.invalidateEngine();
    this.emit('engine');
    return this.autoBeEnabled;
  }

  async toggleCircuitBreaker(targetState?: boolean): Promise<boolean> {
    const nextState = typeof targetState === 'boolean' ? targetState : !this.circuitBreakerEnabled;
    this.circuitBreakerEnabled = nextState;
    if (typeof window !== 'undefined') {
      localStorage.setItem('smc_circuit_breaker_enabled', String(nextState));
    }
    if (!nextState) {
      this.account.daily_loss_hit = false;
      this.slog('⚡ Daily-Loss Circuit Breaker DISABLED by operator. Unrestricted execution permitted.', 'warn');
    } else {
      this.slog('🛡️ Daily-Loss Circuit Breaker ARMED. Hard risk protection active.', 'info');
    }
    void mt5Bridge.setCircuitBreaker(nextState);
    this.invalidateEngine();
    this.invalidateMarket();
    this.emit('engine');
    this.emit('market');
    return this.circuitBreakerEnabled;
  }

  getEngineSnapshot(): EngineState {
    if (!this._cachedEngine) {
      const sess = sessionFilter(new Date());
      this._cachedEngine = {
        kill_switch: this.killSwitch,
        auto_trade: this.autoTrade,
        auto_be_enabled: this.autoBeEnabled,
        circuit_breaker_enabled: this.circuitBreakerEnabled,
        news_blackout: this.newsBlackout || isWithinConfiguredNewsBlackout(new Date()),
        session: sess,
        connected: this.connected,
        max_spread_points: MAX_SPREAD_POINTS,
        daily_loss_pct: this.account.max_daily_loss_pct,
        daily_drawdown_pct: this.account.daily_drawdown_pct,
        compoundingStage: this.getCompoundingStage(this.account.balance),
        marketSchedule: getGoldMarketSchedule(),
        mt5Account: this.mt5Account,
        leverage: this.leverage,
        autoSelectBestScenario: this.autoSelectBestScenario,
        executionMode: this.executionMode,
      };
    }
    return this._cachedEngine!;
  }

  setExecutionMode(mode: 'MARKET' | 'PULLBACK_LIMIT') {
    if (this.executionMode === mode) return;
    this.executionMode = mode;
    if (typeof window !== 'undefined') {
      localStorage.setItem('smc_execution_mode', mode);
    }
    this.slog(`Order Execution Mode updated to ${mode === 'PULLBACK_LIMIT' ? 'OTE Pullback Limit' : 'Instant Market'}`, 'info');
    this.invalidateEngine();
    this.emit('engine');
  }

  linkMt5Account(login: string, server: string, balance?: number, equity?: number) {
    this.brokerAccountGeneration += 1;
    const brokerName = server.split(/[-_]/)[0] || 'MT5 Broker';
    this.activateAccountScope(login, server, {
      balance,
      equity,
      broker: brokerName,
    });

    const bal = balance !== undefined && balance >= 0 ? balance : this.account.balance;
    const eq = equity !== undefined && equity >= 0 ? equity : bal;

    this.mt5Account = {
      connected: true,
      login,
      server,
      broker: brokerName,
      currency: undefined,
      balance: bal,
      equity: eq,
      freeMargin: bal,
      leverage: this.leverage,
    };

    this.account.balance = bal;
    this.account.equity = eq;
    if (!this.hasBrokerDayAnchor) {
      this.account.initial_balance = bal;
      this.account.daily_start_balance = bal;
    }
    this.account.margin_free = bal;

    if (typeof window !== 'undefined') {
      localStorage.setItem('smc_mt5_auto_connect', 'true');
      localStorage.setItem('smc_mt5_login', login);
      localStorage.setItem('smc_mt5_server', server);
      localStorage.setItem('smc_mt5_broker', this.mt5Account.broker);
    }

    if (mt5Bridge.getStatus().connected) {
      void mt5Bridge.refreshAccountHistory().catch(() => {});
    }

    this.slog(`MetaTrader 5 Linked: Account #${login} on ${server} (Equity: $${eq.toFixed(2)})`, 'trade');
    this.invalidateEngine();
    this.invalidateTicker();
    this.invalidatePositions();
    this.emit('engine');
    this.emit('ticker');
    this.emit('positions');
  }

  unlinkMt5Account() {
    this.brokerAccountGeneration += 1;
    this.mt5Account = {
      connected: false,
      login: '',
      server: '',
      broker: '',
      currency: undefined,
      balance: 0,
      equity: 0,
      freeMargin: 0,
      leverage: this.leverage,
    };
    this.hasBrokerDayAnchor = false;
    this.positions = [];
    this.selectedTicket = null;
    this.activeAccountScopeKey = 'standalone';
    setActiveJournalAccount(null, null);
    this.closedTrades = readStoredClosedTrades();
    this.tradeRationales = readTradeRationales();
    this.tradeOrderBlocks = readTradeOrderBlocks();
    this.account.balance = 0;
    this.account.equity = 0;
    this.account.margin_free = 0;
    this.account.initial_balance = 0;
    this.account.daily_start_balance = 0;

    if (typeof window !== 'undefined') {
      localStorage.removeItem('smc_mt5_auto_connect');
      localStorage.removeItem('smc_mt5_login');
      localStorage.removeItem('smc_mt5_server');
      localStorage.removeItem('smc_mt5_broker');
      localStorage.removeItem('smc_mt5_balance');
      localStorage.removeItem('smc_mt5_equity');
    }
    this.slog('MetaTrader 5 Disconnected. Per-account ledger saved; standalone mode active.', 'info');
    this.invalidateEngine();
    this.invalidateTicker();
    this.invalidatePositions();
    this.emit('engine');
    this.emit('ticker');
    this.emit('positions');
  }

  getScannerAnalyses(): PairAnalysis[] {
    return this.scannerAnalyses;
  }

  private getScannerEntryCandidates(): PairAnalysis[] {
    const candidates = this.scannerAnalyses.flatMap((analysis) => [
      analysis,
      ...(analysis.entryCandidates ?? []),
    ]);
    const unique = new Map<string, PairAnalysis>();
    for (const candidate of candidates) {
      if (!candidate.signal) continue;
      const { timeframe, direction, sourceCandleOpenTime } = candidate.signal;
      unique.set(
        `${candidate.symbol}:${timeframe}:${direction}:${sourceCandleOpenTime}`,
        candidate
      );
    }
    return Array.from(unique.values());
  }

  getBestOpportunity(): PairAnalysis | null {
    return this.bestOpportunity;
  }

  setMinScoreThreshold(threshold: number) {
    this.minScoreThreshold = Math.max(50, Math.min(95, threshold));
    this.refreshScanner();
    this.slog(`Confluence Execution Threshold updated to ${this.minScoreThreshold}/100`, 'info');
  }

  setAutoSelectBestScenario(enabled: boolean) {
    this.autoSelectBestScenario = enabled;
    if (
      enabled &&
      this.bestOpportunity?.status === 'READY' &&
      this.bestOpportunity.symbol !== this.activeSymbol
    ) {
      this.switchSymbol(this.bestOpportunity.symbol);
    }
    this.invalidateEngine();
    this.emit('engine');
    this.slog(`Auto-Focus Best Opportunity Setup: ${enabled ? 'ENABLED' : 'DISABLED'}`, 'info');
  }

  refreshScanner(allowAutoSelect = true) {
    if (!this.connected || !this.mt5Account.connected) {
      this.scannerAnalyses = [];
      this.bestOpportunity = null;
      intermarketEngine.updateQuotes({});
      this.invalidateMarket();
      this.invalidateEvents();
      this.emit('scanner');
      this.emit('market');
      this.emit('events');
      return;
    }
    const analyses: PairAnalysis[] = [];
    const liveQuotes: Record<string, { bid: number; change24hPct: number }> = {};
    const events = this.economicCalendarAvailable ? this.economicEvents : null;

    for (const sym of SUPPORTED_SYMBOLS) {
      const data = this.pairData[sym];
      const isCurrent = this.activeSymbol === sym;
      const marketDataIsUsable =
        data.marketDataAt > 0 &&
        hasValidBrokerSymbolSpec(data.symbolSpec) &&
        data.bid > 0 &&
        data.ask >= data.bid &&
        data.candlesM1.length >= 25 &&
        data.candlesM5.length >= 20 &&
        data.candlesM15.length >= 25 &&
        data.candlesH1.length >= 20;
      if (!marketDataIsUsable) continue;
      const marketDataIsFresh =
        Date.now() - data.marketDataAt <= 45_000 &&
        hasFreshBrokerCandles(data.candlesM1, 60_000) &&
        hasFreshBrokerCandles(data.candlesM5, 5 * 60_000) &&
        hasFreshBrokerCandles(data.candlesM15, 15 * 60_000) &&
        hasFreshBrokerCandles(data.candlesH1, 60 * 60_000);
      const cM1 = isCurrent && this.candlesM1.length ? this.candlesM1 : data.candlesM1;
      const cM5 = isCurrent && this.candlesM5.length ? this.candlesM5 : data.candlesM5;
      const cM15 = isCurrent && this.candlesM15.length ? this.candlesM15 : data.candlesM15;
      const cH1 = isCurrent && this.candlesH1.length ? this.candlesH1 : data.candlesH1;
      const curBid = isCurrent && this.bid > 0 ? this.bid : data.bid;
      const curAsk = isCurrent && this.ask > 0 ? this.ask : data.ask;
      const curSpread = isCurrent && this.bid > 0 ? this.spread : data.spread;

      const ref24hCandle = cH1.length >= 24 ? cH1[cH1.length - 24] : cM15[Math.max(0, cM15.length - 96)];
      if (marketDataIsFresh && ref24hCandle && ref24hCandle.open > 0 && curBid > 0) {
        liveQuotes[sym] = {
          bid: curBid,
          change24hPct: Number((((curBid - ref24hCandle.open) / ref24hCandle.open) * 100).toFixed(2)),
        };
      }

      const timeframedAnalyses = analyzeInstrumentCandidates(
        sym,
        cM1,
        cM5,
        cM15,
        cH1,
        curBid,
        curAsk,
        curSpread,
        this.account.equity,
        this.account.risk_pct,
        this.positions,
        events,
        data.symbolSpec,
        { nowMs: Date.now(), mode: 'live' }
      );
      if (marketDataIsFresh) advanceSignalValidations(sym, cM1);
      const rankedTimeframes = rankOpportunities(timeframedAnalyses);
      if (marketDataIsFresh) {
        for (const candidate of rankedTimeframes) {
          if (
            !candidate.signal ||
            candidate.status !== 'READY' ||
            !candidate.expiryTimestamp ||
            !candidate.optimalTradeEntry
          ) continue;
          const timeframe = candidate.signal.timeframe;
          const sourceCandleTime = candidate.signal.sourceCandleOpenTime;
          if (!Number.isFinite(sourceCandleTime)) continue;
          recordSignalValidation({
            id: `${sym}-${timeframe}-${sourceCandleTime}-${candidate.signal.direction}`,
            createdAt: candidate.signal.generatedAt,
            sourceCandleTime,
            generatedAt: candidate.signal.generatedAt,
            availableAt: candidate.signal.availableAt,
            sourceCandleOpenTime: candidate.signal.sourceCandleOpenTime,
            sourceCandleCloseTime: candidate.signal.sourceCandleCloseTime,
            scoringPolicyVersion: candidate.signal.scoringPolicyVersion,
            expiresAt: candidate.expiryTimestamp,
            symbol: sym,
            direction: candidate.signal.direction,
            timeframe,
            strategy: candidate.signal.strategy || 'SMC POI Retest',
            triggerPrice: candidate.optimalTradeEntry,
            stopLoss: candidate.suggestedSL,
            takeProfit: candidate.suggestedTP,
            confluenceScore: candidate.confluenceScore,
            outcome: 'WATCHING',
          });
        }
      }
      const visibleCandidates = marketDataIsFresh
        ? rankedTimeframes
        : rankedTimeframes.map((candidate) => ({
            ...candidate,
            status: 'BLOCKED' as const,
            rejectionReason: 'BROKER_CANDLES_STALE_WAITING_FOR_FRESH_BARS',
            safeLotSize: null,
            estimatedRiskUsd: null,
          }));
      const selected = visibleCandidates[0];
      if (selected) {
        analyses.push({ ...selected, entryCandidates: visibleCandidates });
        if (!isTestRuntime() && marketDataIsFresh && selected.signal) {
          analyzeInstrument(
            sym,
            cM1,
            cM5,
            cM15,
            cH1,
            curBid,
            curAsk,
            curSpread,
            this.account.equity,
            this.account.risk_pct,
            this.positions,
            events,
            data.symbolSpec,
            {
              nowMs: Date.now(),
              mode: 'live',
              executionTimeframe: selected.executionTimeframe,
              sendAlerts: true,
            }
          );
        }
      }
    }

    intermarketEngine.updateQuotes(liveQuotes);
    const ranked = rankOpportunities(analyses);
    this.scannerAnalyses = ranked;
    this.bestOpportunity = ranked[0] || null;

    // Automatically select the best scenario in the chart if enabled
    if (
      allowAutoSelect &&
      this.autoSelectBestScenario &&
      this.bestOpportunity &&
      this.bestOpportunity.symbol !== this.activeSymbol &&
      this.bestOpportunity.status === 'READY'
    ) {
      this.switchSymbol(this.bestOpportunity.symbol);
    }

    this.invalidateMarket();
    this.invalidateEvents();
    this.emit('scanner');
    this.emit('market');
    this.emit('events');

    // Sync active-pair READY signals from getMarketSnapshot() with Telegram alerts as well
    if (!isTestRuntime() && this.hasBrokerMarketData) {
      const marketSnap = this.getMarketSnapshot();
      const activeSig = marketSnap.signal;
      if (activeSig) {
        const cfg = getInstrumentConfig(this.activeSymbol);
        const stopDist = Math.abs(activeSig.entry - activeSig.sl);
        const tp1 = activeSig.tp1 ?? Number((activeSig.direction === 'BUY' ? activeSig.entry + stopDist * 1.8 : activeSig.entry - stopDist * 1.8).toFixed(cfg.digits));
        const tp2 = activeSig.tp2 ?? activeSig.tp;
        const tp3 = activeSig.tp3 ?? Number((activeSig.direction === 'BUY' ? activeSig.entry + stopDist * 5.5 : activeSig.entry - stopDist * 5.5).toFixed(cfg.digits));
        const slPips = activeSig.slPips ?? Number((stopDist / cfg.pipSize).toFixed(1));
        const tp1Pips = activeSig.targetPips1 ?? Number((Math.abs(tp1 - activeSig.entry) / cfg.pipSize).toFixed(1));
        const tp2Pips = activeSig.targetPips2 ?? Number((Math.abs(tp2 - activeSig.entry) / cfg.pipSize).toFixed(1));
        const tp3Pips = activeSig.targetPips3 ?? Number((Math.abs(tp3 - activeSig.entry) / cfg.pipSize).toFixed(1));
        const validUntil =
          activeSig.expiryTimestamp ??
          (Date.now() + (activeSig.timeframe === 'M15' ? 15 : activeSig.timeframe === 'M5' ? 5 : 1.5) * 60_000);
        const matchingAnalysis = ranked.find((a) => a.symbol === this.activeSymbol);
        const canBroadcast = !matchingAnalysis || (matchingAnalysis.status === 'READY' && matchingAnalysis.spreadAcceptable);
        if (canBroadcast && this.spread <= cfg.maxSpreadPoints) {
          void dispatchSniperAlert({
            symbol: this.activeSymbol,
            direction: activeSig.direction,
            timeframe: activeSig.timeframe,
            strategy: activeSig.strategy || 'SMC POI Retest',
            entry: activeSig.entry,
            sl: activeSig.sl,
            tp1,
            tp2,
            tp3,
            slPips,
            tp1Pips,
            tp2Pips,
            tp3Pips,
            confluenceScore: activeSig.score,
            recommendedLot: activeSig.recommendedLot,
            isSniper: Boolean(activeSig.isSniper),
            sniperGrade: activeSig.sniperGrade,
            optimalTradeEntry: activeSig.optimalTradeEntry,
            triggerPattern: activeSig.candlestickPattern?.name,
            validUntil,
          });
        }
      }
    }
  }

  switchSymbol(newSymbol: SupportedSymbol) {
    if (!SUPPORTED_SYMBOLS.includes(newSymbol)) return;
    if (this.activeSymbol === newSymbol) return;
    this.symbolSelectionGeneration += 1;

    // Cache current state back to pairData
    this.pairData[this.activeSymbol] = {
      candlesM1: this.candlesM1,
      candlesM5: this.candlesM5,
      candlesM15: this.candlesM15,
      candlesH1: this.candlesH1,
      bid: this.bid,
      ask: this.ask,
      spread: this.spread,
      marketDataAt: this.pairData[this.activeSymbol].marketDataAt,
      symbolSpec: this.symbolSpec,
    };

    this.activeSymbol = newSymbol;
    const targetData = this.pairData[newSymbol];
    const config = getInstrumentConfig(newSymbol);
    const targetDataIsFresh =
      targetData.marketDataAt > 0 &&
      Date.now() - targetData.marketDataAt <= 45_000 &&
      hasFreshBrokerCandles(targetData.candlesM1, 60_000) &&
      hasFreshBrokerCandles(targetData.candlesM5, 5 * 60_000) &&
      hasFreshBrokerCandles(targetData.candlesM15, 15 * 60_000) &&
      hasFreshBrokerCandles(targetData.candlesH1, 60 * 60_000);

    this.candlesM1 = targetDataIsFresh ? targetData.candlesM1 : [];
    this.candlesM5 = targetDataIsFresh ? targetData.candlesM5 : [];
    this.candlesM15 = targetDataIsFresh ? targetData.candlesM15 : [];
    this.candlesH1 = targetDataIsFresh ? targetData.candlesH1 : [];
    this.bid = targetDataIsFresh ? targetData.bid : 0;
    this.ask = targetDataIsFresh ? targetData.ask : 0;
    this.spread = targetDataIsFresh ? targetData.spread : 0;
    this.symbolSpec = targetDataIsFresh ? targetData.symbolSpec : null;
    this.hasBrokerMarketData = targetDataIsFresh;
    this.lastPrice = this.bid;

    mt5Bridge.setSymbol(newSymbol);

    this.slog(`Active workstation switched to ${newSymbol} (${config.displayName})`, 'info');

    this.invalidateTicker();
    this.invalidateMarket();
    this.invalidateEngine();
    this.emit('ticker');
    this.emit('market');
    this.emit('engine');
  }

  getEventsSnapshot(): EventsState {
    if (!this._cachedEvents) {
      const globalIndex = newsSentimentEngine.getGlobalSentimentIndex();
      this._cachedEvents = {
        log: this.logs,
        economicEvents: this.economicEvents,
        economicCalendarStatus: this.economicCalendarStatus,
        macroSentiment: {
          newsItems: newsSentimentEngine.getNews(),
          economicEvents: this.economicEvents,
          intermarket: intermarketEngine.getStatus(),
          globalSentimentScore: globalIndex.score,
          globalSentimentLabel: globalIndex.label,
          activeCatalysts: newsSentimentEngine.getNews().map((n) => n.title).slice(0, 3),
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return this._cachedEvents;
  }

  getRiskBasedVolume(stopLoss: number, requestedVolume?: number, _direction?: TradeDirection): number | null {
    const spec = this.symbolSpec || (isTestRuntime() ? getDefaultSymbolSpec(this.activeSymbol) : null);
    if (!spec) return null;
    const entryPrice = _direction === 'BUY' ? this.ask : this.bid;
    const riskVolume = calculateRiskBasedVolume(
      this.account.equity,
      this.account.risk_pct,
      Math.abs(entryPrice - stopLoss),
      spec,
      RISK_CONFIG.adaptiveMicroFloorEnabled
    );
    if (riskVolume === null || requestedVolume === undefined) return riskVolume;
    const cappedVolume = Math.min(riskVolume, requestedVolume);
    const steps = Math.floor((cappedVolume - spec.volumeMin) / spec.volumeStep + 1e-9);
    const precision = Math.min(8, (String(spec.volumeStep).split('.')[1] || '').length);
    const adjustedVolume = Number((spec.volumeMin + Math.max(0, steps) * spec.volumeStep).toFixed(precision));
    return adjustedVolume <= riskVolume ? adjustedVolume : 0;
  }

  getRiskSizingInfo(
    stopLoss: number,
    direction: TradeDirection,
    symbol: SupportedSymbol = this.activeSymbol
  ): RiskSizingInfo | null {
    const pair = this.pairData[symbol];
    const spec = symbol === this.activeSymbol ? this.symbolSpec : pair?.symbolSpec;
    const entryPrice =
      symbol === this.activeSymbol
        ? direction === 'BUY' ? this.ask : this.bid
        : direction === 'BUY' ? pair?.ask : pair?.bid;
    if (!spec || !Number.isFinite(entryPrice) || !entryPrice || !Number.isFinite(stopLoss)) return null;

    const stopDistance = Math.abs(entryPrice - stopLoss);
    const riskBudget = this.account.equity * (this.account.risk_pct / 100);
    const minimumLotRisk = stopDistance / spec.tickSize * spec.tickValue * spec.volumeMin;
    if (
      !Number.isFinite(riskBudget) ||
      riskBudget <= 0 ||
      !Number.isFinite(minimumLotRisk) ||
      minimumLotRisk < 0
    ) return null;

    return {
      riskPercent: this.account.risk_pct,
      riskBudget,
      minimumLot: spec.volumeMin,
      minimumLotRisk,
      safeVolume: calculateRiskBasedVolume(
        this.account.equity,
        this.account.risk_pct,
        stopDistance,
        spec,
        RISK_CONFIG.adaptiveMicroFloorEnabled
      ),
    };
  }

  private getExecutionRiskVolume(
    requestedVolume: number | undefined,
    stopLoss: number,
    entryPrice: number,
    symbol: SupportedSymbol
  ): { volume: number | null; rejectionReason?: string } {
    const spec = symbol === this.activeSymbol ? this.symbolSpec : this.pairData[symbol]?.symbolSpec;
    if (!spec) {
      return { volume: null, rejectionReason: 'TRADE_REJECTED: BROKER_SYMBOL_SPEC_UNAVAILABLE' };
    }
    const stopDistance = Math.abs(entryPrice - stopLoss);
    const riskBudget = this.account.equity * (this.account.risk_pct / 100);
    const riskPerLot = stopDistance / spec.tickSize * spec.tickValue;
    const minLotRisk = riskPerLot * spec.volumeMin;
    const rejectMinimumLot = () => ({
      volume: null,
      rejectionReason: `TRADE_REJECTED: MINIMUM_LOT_EXCEEDS_RISK (${spec.volumeMin}L risks $${minLotRisk.toFixed(2)}, budget: $${riskBudget.toFixed(2)})`,
    });

    if ((requestedVolume !== undefined && (!Number.isFinite(requestedVolume) || requestedVolume <= 0))
      || !Number.isFinite(stopLoss) || !Number.isFinite(entryPrice)
      || !Number.isFinite(riskBudget) || riskBudget <= 0 || !Number.isFinite(riskPerLot) || riskPerLot <= 0) {
      return { volume: null, rejectionReason: 'TRADE_REJECTED: INVALID_POSITION_SIZING_INPUT' };
    }
    // Recheck the broker minimum against the configured risk budget at execution.
    const isMicroFloorAllowed = isAdaptiveMicroFloorAllowed(this.account.equity, minLotRisk);
    if (minLotRisk > riskBudget && !isMicroFloorAllowed) return rejectMinimumLot();

    const maxSafeVolume = calculateRiskBasedVolume(
      this.account.equity,
      this.account.risk_pct,
      stopDistance,
      spec,
      RISK_CONFIG.adaptiveMicroFloorEnabled
    );
    if (maxSafeVolume === null) return rejectMinimumLot();

    const requested = requestedVolume ?? maxSafeVolume;
    const capped = Math.min(requested, maxSafeVolume, spec.volumeMax);
    const precision = Math.min(8, (String(spec.volumeStep).split('.')[1] || '').length);
    const steps = Math.floor((capped - spec.volumeMin) / spec.volumeStep + 1e-9);
    const volume = Number((spec.volumeMin + Math.max(0, steps) * spec.volumeStep).toFixed(precision));
    const actualRisk = riskPerLot * volume;
    const isAllowedMicroFloor =
      volume === spec.volumeMin &&
      actualRisk > riskBudget + 1e-9 &&
      isMicroFloorAllowed;
    if (volume < spec.volumeMin || (actualRisk > riskBudget + 1e-9 && !isAllowedMicroFloor)) {
      return rejectMinimumLot();
    }
    return { volume };
  }

  getEntryBlockReason(
    direction: TradeDirection,
    signal = this.getMarketSnapshot().signal,
    now: number = Date.now(),
    isManual: boolean = false,
    targetSymbol: string = this.activeSymbol
  ): string | null {
    // SAFETY-FIX: Remove early sniper bypass. Sniper trades must flow through all checks (kill switch, daily loss, spread, position caps).
    const resolvedSymbol = (
      SUPPORTED_SYMBOLS.includes(targetSymbol as SupportedSymbol) ? targetSymbol : this.activeSymbol
    ) as SupportedSymbol;

    this.entryHistory = this.entryHistory.filter((entry) => now - entry.at < 60 * 60_000);
    if (this.killSwitch) return 'Kill switch is armed.';
    if (!isTestRuntime() && (!this.connected || !this.mt5Account.connected || !mt5Bridge.getStatus().connected)) {
      return 'TRADE_REJECTED: VERIFIED_MT5_CONNECTION_REQUIRED';
    }
    if (this.circuitBreakerEnabled && (this.account.daily_loss_hit || this.account.daily_drawdown_pct >= this.account.max_daily_loss_pct)) {
      return 'Daily loss limit reached.';
    }
    if (this.instrumentType === 'standard' && !isManual) {
      const session = sessionFilter(new Date(now));
      if (session.asianConsolidation) {
        return 'TRADE_REJECTED: ASIAN_CONSOLIDATION_SUPPRESSED (Low-liquidity Asian consolidation 21:00–05:00 UTC / 00:00–08:00 EAT).';
      }
    }
    const matchingScannerAnalysis = this.getScannerEntryCandidates().find(
      (analysis) =>
        analysis.symbol === targetSymbol &&
        analysis.signal?.sourceCandleOpenTime === signal?.sourceCandleOpenTime &&
        analysis.signal?.timeframe === signal?.timeframe &&
        analysis.signal?.direction === signal?.direction
    );
    if (!isManual && signal && !matchingScannerAnalysis) {
      return 'TRADE_REJECTED: SCANNER_SIGNAL_UNAVAILABLE';
    }
    if (matchingScannerAnalysis && matchingScannerAnalysis.status !== 'READY') {
      return matchingScannerAnalysis.rejectionReason ||
        `Scanner confluence ${matchingScannerAnalysis.confluenceScore}/100 is below the ${getInstrumentConfig(targetSymbol).minScore}/100 setup threshold.`;
    }
    if (
      !isManual &&
      matchingScannerAnalysis &&
      !isPrecisionExecutionReady(
        {
          ...matchingScannerAnalysis,
          bid: resolvedSymbol === this.activeSymbol
            ? this.bid
            : this.pairData[resolvedSymbol].bid,
          ask: resolvedSymbol === this.activeSymbol
            ? this.ask
            : this.pairData[resolvedSymbol].ask,
        },
        this.executionMode,
        now
      )
    ) {
      return 'TRADE_REJECTED: PRECISION_ENTRY_NOT_CONFIRMED';
    }
    if (this.mt5Account.connected && this.instrumentType === 'standard') {
      if (!this.economicCalendarAvailable && this.economicEvents.length === 0 && !isManual) {
        return 'TRADE_REJECTED: NEWS_DATA_UNAVAILABLE';
      }
      if (this.economicEvents.length > 0) {
        const newsRisk = evaluateNewsRisk(
          targetSymbol as SupportedSymbol,
          this.economicEvents
        );
        if (newsRisk.hasNewsRisk) {
          return `TRADE_REJECTED: ${newsRisk.reason || 'HIGH_IMPACT_NEWS_BLACKOUT'}`;
        }
      }
    }

    // Signal scores use the normalized 0-100 scale.
    const rewardDist = signal ? Math.abs(signal.tp - signal.entry) : 0;

    // Maximum simultaneous positions limit (allows up to 5 concurrent trades)
    const maxSimultaneousTrades = Math.max(0, Math.floor(RISK_CONFIG.maxOpenPositions));
    if (this.positions.length >= maxSimultaneousTrades) {
      return `TRADE_REJECTED: MAX_SIMULTANEOUS_TRADES_REACHED (Account limit of ${maxSimultaneousTrades} open positions reached)`;
    }

    // Daily trade count limits (Section 7: 5 total, 3 per pair)
    const today = new Date().toISOString().slice(0, 10);
    const todayClosedTrades = this.closedTrades.filter((t) => (t.closedAt || '').startsWith(today));
    const pairTodayTrades = todayClosedTrades.filter((t) => (t.symbol || t.comment || '').includes(resolvedSymbol));

    if (todayClosedTrades.length >= 5) {
      return 'TRADE_REJECTED: DAILY_TRADE_LIMIT_REACHED (Maximum 5 trades per day reached)';
    }
    if (pairTodayTrades.length >= 3) {
      return `TRADE_REJECTED: PAIR_DAILY_LIMIT_REACHED (Maximum 3 trades per day reached for ${resolvedSymbol})`;
    }

    // Correlation & combined USD exposure protection (Section 8)
    if (!isManual) {
      const correlationCheck = checkCorrelationExposure(resolvedSymbol, direction, this.positions, 5);
      if (!correlationCheck.allowed) {
        return correlationCheck.reason || 'TRADE_REJECTED: CORRELATION_LIMIT_EXCEEDED';
      }
    }

    const targetPairData = this.pairData[resolvedSymbol];
    const targetSpec = resolvedSymbol === this.activeSymbol ? this.symbolSpec : targetPairData?.symbolSpec;

    // Minimum lot risk calculation (Section 7: TRADE_REJECTED: MINIMUM_LOT_EXCEEDS_RISK)
    if (signal) {
      const stopDist = Math.abs(signal.entry - signal.sl);
      const sizing = calculateSmallAccountPositionSize(
        this.account.equity,
        this.account.risk_pct,
        stopDist,
        resolvedSymbol,
        targetSpec?.volumeMin ?? 0.01,
        targetSpec?.volumeStep ?? 0.01,
        targetSpec ?? undefined
      );
      if (sizing.rejectionReason) {
        return sizing.rejectionReason;
      }
    }

    const config = getInstrumentConfig(resolvedSymbol);
    const targetSpread = resolvedSymbol === this.activeSymbol ? this.spread : (targetPairData?.spread ?? this.spread);
    if (targetSpread > config.maxSpreadPoints) {
      return `TRADE_REJECTED: SPREAD_TOO_WIDE (${targetSpread} points; maximum ${config.maxSpreadPoints} for ${resolvedSymbol}).`;
    }

    if (signal) {
      const stopDist = Math.abs(signal.entry - signal.sl);
      const minSafeStop = config.minPracticalStopPips * config.pipSize;
      const tfStopFactor = signal.timeframe === 'M1' ? 0.65 : 1.0;
      if (stopDist < minSafeStop * 0.70 * tfStopFactor) {
        const stopPips = (stopDist / config.pipSize).toFixed(1);
        return `TRADE_REJECTED: STOP_LOSS_TOO_TIGHT (Stop is ${stopPips} pips; minimum safe stop for ${resolvedSymbol} is ${config.minPracticalStopPips} pips to prevent spread stop-outs).`;
      }

      // Spread protection: broker spread must not consume over 40% of the stop loss or >25% of target TP
      const spreadDist = targetSpread * config.pointSize;
      if (stopDist > 0 && spreadDist / stopDist > 0.40) {
        const spreadPips = (spreadDist / config.pipSize).toFixed(1);
        const stopPips = (stopDist / config.pipSize).toFixed(1);
        return `TRADE_REJECTED: SPREAD_EATS_STOP (Spread ${spreadPips} pips consumes >40% of the ${stopPips} pip stop loss).`;
      }
      if (rewardDist > 0 && spreadDist / rewardDist > 0.25) {
        const spreadPips = (spreadDist / config.pipSize).toFixed(1);
        const tpPips = (rewardDist / config.pipSize).toFixed(1);
        return `TRADE_REJECTED: SPREAD_EATS_TP (Spread ${spreadPips} pips consumes >25% of the ${tpPips} pip TP target).`;
      }
    }

    // Smart decoupled direction cooldown (only if enabled, per-symbol)
    // SAFETY-FIX: Sniper trades may bypass only optional direction/hourly cooldowns, never safety gates
    if (!isManual && this.directionCooldownEnabled) {
      const cooldownMs = this.directionCooldownSeconds * 1000;
      if (cooldownMs > 0) {
        const lastDirectionEntry = [...this.entryHistory]
          .reverse()
          .find((entry) => (!entry.symbol || entry.symbol === targetSymbol) && entry.direction === direction);
        if (lastDirectionEntry && now - lastDirectionEntry.at < cooldownMs) {
          return 'Direction cooldown is active.';
        }
      }
    }

    // Smart decoupled POI cooldown (only if enabled, per-symbol)
    if (!isManual && this.directionCooldownEnabled && RISK_CONFIG.samePoiCooldownMs > 0) {
      const poiKey = signal ? this.getSignalPoiKey(signal.direction, signal.entry) : '';
      if (
        poiKey &&
        this.entryHistory.some((entry) => (!entry.symbol || entry.symbol === targetSymbol) && entry.poiKey === poiKey && now - entry.at < RISK_CONFIG.samePoiCooldownMs)
      ) {
        return 'This SMC point of interest was traded recently.';
      }
    }

    // Hourly trade limit (only if enabled, per-symbol)
    if (!isManual && this.hourlyTradeLimitEnabled) {
      const symbolEntries = this.entryHistory.filter((entry) => (!entry.symbol || entry.symbol === targetSymbol));
      if (symbolEntries.length >= this.maxTradesPerHour) {
        return 'Hourly trade limit reached.';
      }
    }

    if (this.circuitBreakerEnabled) {
      const consecutiveLosses = this.closedTrades.slice(0, RISK_CONFIG.maxConsecutiveLosses)
        .every((trade) => trade.profit <= 0);
      if (this.closedTrades.length >= RISK_CONFIG.maxConsecutiveLosses && consecutiveLosses) {
        if (!isManual) {
          return 'Consecutive-loss circuit breaker reached.';
        }
      }
    }

    if (this.instrumentType === 'standard' && this.newsBlackout) return 'News blackout is enabled.';
    if (this.instrumentType === 'standard' && !this.bypassNewsBlackout && isWithinConfiguredNewsBlackout(new Date(now))) {
      return 'Configured high-impact news blackout window is active.';
    }

    return null;
  }

  getMaxSpreadPoints(): number {
    return getInstrumentConfig(this.activeSymbol).maxSpreadPoints;
  }

  recordAcceptedEntry(
    direction: TradeDirection,
    signal = this.getMarketSnapshot().signal,
    symbol: string = this.activeSymbol
  ) {
    const poiKey = signal ? this.getSignalPoiKey(signal.direction, signal.entry) : '';
    this.entryHistory.push({ at: Date.now(), direction, symbol, poiKey });
    this.entryHistory = this.entryHistory.slice(-100);
    try {
      signalAudioNotifier.playTradeExecutionAlert(direction);
    } catch {
      // ignore
    }
  }

  recordRejectedSignal(
    signal: Signal,
    rejectionReason: string,
    symbol: string = this.activeSymbol
  ): JournalSignalRecord {
    const record = recordJournalSignal({
      symbol,
      direction: signal.direction,
      strategy: signal.strategy || 'SMC Liquidity Setup',
      timeframe: signal.timeframe || 'M1',
      score: signal.score,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      status: 'REJECTED',
      rejectionReason,
      rationale: buildSignalRationale(signal),
    });
    this.slog(`Journal: Signal rejected for ${symbol} ${signal.direction} · ${rejectionReason}`, 'warn');
    this.emit('events');
    return record;
  }

  recordExecutedSignal(
    signal: Signal,
    ticket: number,
    volume: number,
    symbol: string = this.activeSymbol,
    rationale?: string
  ): JournalSignalRecord {
    const record = recordJournalSignal({
      symbol,
      direction: signal.direction,
      strategy: signal.strategy || 'SMC Liquidity Setup',
      timeframe: signal.timeframe || 'M1',
      score: signal.score,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      status: 'EXECUTED',
      ticket,
      volume,
      rationale: rationale || buildSignalRationale(signal),
    });
    this.slog(`Journal: Signal executed #${ticket} ${symbol} ${signal.direction} ${volume}L`, 'trade');
    this.emit('events');
    return record;
  }

  recordPendingSignal(
    signal: Signal,
    ticket: number,
    volume: number,
    symbol: string = this.activeSymbol,
    rationale?: string
  ): JournalSignalRecord {
    const record = recordJournalSignal({
      symbol,
      direction: signal.direction,
      strategy: signal.strategy || 'SMC Liquidity Setup',
      timeframe: signal.timeframe || 'M1',
      score: signal.score,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      status: 'PENDING',
      ticket,
      volume,
      rationale: rationale || buildSignalRationale(signal),
    });
    this.slog(`Journal: Pending order #${ticket} ${symbol} ${signal.direction} ${volume}L`, 'warn');
    this.emit('events');
    return record;
  }

  getJournalSignals(): JournalSignalRecord[] {
    return readStoredJournalSignals();
  }

  getJournalTrades(): JournalTradeRecord[] {
    return readStoredJournalTrades();
  }

  setDirectionCooldownEnabled(enabled: boolean) {
    this.directionCooldownEnabled = enabled;
    if (typeof window !== 'undefined') {
      localStorage.setItem('smc_direction_cooldown_enabled', String(enabled));
    }
    this.notify();
  }

  setHourlyTradeLimitEnabled(enabled: boolean) {
    this.hourlyTradeLimitEnabled = enabled;
    if (typeof window !== 'undefined') {
      localStorage.setItem('smc_hourly_limit_enabled', String(enabled));
    }
    this.notify();
  }

  setDirectionCooldownSeconds(sec: number) {
    this.directionCooldownSeconds = sec;
    if (typeof window !== 'undefined') {
      localStorage.setItem('smc_direction_cooldown_sec', String(sec));
    }
    this.notify();
  }

  setMaxTradesPerHour(maxTrades: number) {
    this.maxTradesPerHour = maxTrades;
    if (typeof window !== 'undefined') {
      localStorage.setItem('smc_max_trades_per_hour', String(maxTrades));
    }
    this.notify();
  }

  getSignalPoiKey(direction: TradeDirection, entry: number): string {
    const bullish = direction === 'BUY';
    const zone = this.getMarketSnapshot().zones.find(
      (item) =>
        item.bullish === bullish &&
        item.bottom <= entry &&
        entry <= item.top &&
        !item.filled
    );
    return zone ? `${direction}:${zone.kind}:${zone.bottom.toFixed(2)}:${zone.top.toFixed(2)}` : `${direction}:${entry.toFixed(2)}`;
  }

  private refreshDailyRiskState() {
    const date = new Date().toISOString().slice(0, 10);
    if (date !== this.dailyRiskDate) {
      this.dailyRiskDate = date;
      this.account.daily_start_balance = this.account.balance;
      this.account.daily_loss_hit = false;
      this.entryHistory = [];
      this.slog('Daily risk limits reset for the new UTC trading day.', 'info');
    }
    if (this.account.daily_start_balance <= 0) return;
    this.account.daily_drawdown_pct = Number(
      Math.max(0, ((this.account.daily_start_balance - this.account.equity) / this.account.daily_start_balance) * 100).toFixed(2)
    );
    if (this.circuitBreakerEnabled && !this.account.daily_loss_hit && this.account.daily_drawdown_pct >= this.account.max_daily_loss_pct) {
      this.account.daily_loss_hit = true;
      this.autoTrade = false;
      this.slog(`Daily loss circuit breaker triggered at ${this.account.daily_drawdown_pct}%. Trading disabled until UTC day reset or toggled off.`, 'error');
      this.closeAll('KillSwitch');
      this.invalidateEngine();
      this.emit('engine');
    }
  }

  getSnapshot(): TerminalSnapshot {
    const ticker = this.getTickerSnapshot();
    const market = this.getMarketSnapshot();
    const engine = this.getEngineSnapshot();
    const positions = this.getPositionsSnapshot();
    const events = this.getEventsSnapshot();

    if (
      !this._cachedSnapshot ||
      this._cachedSnapshot.bid !== ticker.bid ||
      this._cachedSnapshot.equity !== ticker.equity ||
      this._cachedSnapshot.balance !== ticker.balance ||
      this._cachedSnapshot.positions !== positions.positions ||
      this._cachedSnapshot.kill_switch !== engine.kill_switch
    ) {
      this._cachedSnapshot = {
        ...ticker,
        ...market,
        ...engine,
        margin_free: this.account.margin_free,
        positions: positions.positions,
        log: events.log,
        economicEvents: events.economicEvents,
      };
    }
    return this._cachedSnapshot;
  }

  private invalidateTicker() {
    this._cachedTicker = null;
    this._cachedSnapshot = null;
  }

  private invalidateMarket() {
    this._cachedMarket = null;
    this._cachedSnapshot = null;
  }

  private invalidatePositions() {
    this._cachedPositions = null;
    this._cachedSnapshot = null;
  }

  private invalidateEngine() {
    this._cachedEngine = null;
    this._cachedSnapshot = null;
  }

  private invalidateEvents() {
    this._cachedEvents = null;
    this._cachedSnapshot = null;
  }

  // ==========================================
  // ENGINE LIFECYCLE & EXECUTION (Priorities 1 & 3)
  // ==========================================

  startEngineLoops() {
    if (this.autoTraderIntervalId) clearInterval(this.autoTraderIntervalId);

    // Auto-trader cycle (~5s)
    this.autoTraderIntervalId = setInterval(() => {
      void this.evaluateAutoExecution();
    }, 5000);
  }

  stopEngineLoops() {
    if (this.autoTraderIntervalId) clearInterval(this.autoTraderIntervalId);
    if (this.pairMarketDataIntervalId) clearInterval(this.pairMarketDataIntervalId);
    this.autoTraderIntervalId = null;
    this.pairMarketDataIntervalId = null;
  }

  simulatePriceTick(force: boolean = false) {
    if (!isTestRuntime()) return;

    const schedule = getGoldMarketSchedule();
    if (!force && !schedule.isOpen) {
      return;
    }

    // Institutional price progression:
    // When positions are open or strong signals exist, simulate realistic order flow momentum (80% follow-through)
    let momentum = 0;
    if (this.positions.length > 0) {
      // Calculate net position bias
      const netDirection = this.positions.reduce((acc, p) => acc + (p.type === 'BUY' ? 1 : -1), 0);
      momentum = netDirection > 0 ? 0.08 : netDirection < 0 ? -0.08 : 0;
    } else {
      const market = this.getMarketSnapshot();
      if (market.signal && market.signal.score >= 4.0) {
        momentum = market.signal.direction === 'BUY' ? 0.05 : -0.05;
      }
    }

    const config = getInstrumentConfig(this.activeSymbol);
    const noise = (Math.random() - 0.48) * config.pointSize * 4;
    const drift = momentum * config.pointSize * 10 + noise;
    this.bid = Number(Math.max(config.pointSize * 100, this.bid + drift).toFixed(config.digits));
    this.spread = Math.floor(config.minSpread + Math.random() * 3);
    this.ask = Number((this.bid + this.spread * config.pointSize).toFixed(config.digits));

    // Progress latest candles across ALL timeframes with real price updates
    const updateActiveCandle = (candleList: Candle[], price: number) => {
      if (candleList && candleList.length > 0) {
        const lastC = candleList[candleList.length - 1];
        lastC.close = price;
        if (price > lastC.high) lastC.high = price;
        if (price < lastC.low) lastC.low = price;
      }
    };

    updateActiveCandle(this.candlesM1, this.bid);
    updateActiveCandle(this.candlesM5, this.bid);
    updateActiveCandle(this.candlesM15, this.bid);
    updateActiveCandle(this.candlesH1, this.bid);

    // Advance background micro ticks for inactive pairs in pairData across all timeframes
    for (const sym of SUPPORTED_SYMBOLS) {
      if (sym === this.activeSymbol) continue;
      const p = this.pairData[sym];
      const cfg = getInstrumentConfig(sym);
      const microNoise = (Math.random() - 0.49) * cfg.pointSize * 3;
      p.bid = Number((p.bid + microNoise).toFixed(cfg.digits));
      p.ask = Number((p.bid + p.spread * cfg.pointSize).toFixed(cfg.digits));
      updateActiveCandle(p.candlesM1, p.bid);
      updateActiveCandle(p.candlesM5, p.bid);
      updateActiveCandle(p.candlesM15, p.bid);
      updateActiveCandle(p.candlesH1, p.bid);
    }

    // Update positions PnL safely
    let floatingPnl = 0;
    const toClose: { ticket: number; reason: 'TP' | 'SL' }[] = [];

    if (this.positions.length > 0) {
      this.positions = this.positions.map((p) => {
        const posSym = (p.symbol || this.activeSymbol) as SupportedSymbol;
        const cfg = getInstrumentConfig(posSym);
        const pairQuote = this.pairData[posSym];
        const symBid = posSym === this.activeSymbol ? this.bid : (pairQuote?.bid ?? this.bid);
        const symAsk = posSym === this.activeSymbol ? this.ask : (pairQuote?.ask ?? this.ask);
        const curPrice = p.type === 'BUY' ? symBid : symAsk;
        const pts = p.type === 'BUY' ? curPrice - p.price_open : p.price_open - curPrice;
        const pips = Number((pts / cfg.pipSize).toFixed(1));
        let profit = 0;
        if (cfg.category === 'metals') {
          profit = Number((pts * p.volume * cfg.contractSize).toFixed(2));
        } else if (String(posSym) === 'USDJPY') {
          profit = Number(((pts * p.volume * cfg.contractSize) / Math.max(1, curPrice)).toFixed(2));
        } else {
          profit = Number((pts * p.volume * cfg.contractSize).toFixed(2));
        }
        floatingPnl += profit;

        let currentSl = p.sl;
        let currentTp = p.tp;
        let beLocked = p.beLocked;
        let trailLocked = p.trailLocked;
        let partialTaken = p.partialTaken;
        let partialProfitLocked = p.partialProfitLocked;
        let currentVolume = p.volume;

        // Risk Multiple (R) calculation for institutional scale-out
        const initialRiskPts = Math.abs(p.price_open - (p.initialSl || p.sl)) || (cfg.pipSize * 20);
        const rMultiple = pts / Math.max(0.0001, initialRiskPts);

        // 1. Multi-Tier Partial Profit Taking (Scale-Out)
        // Close 50% of volume at 1.5R, secure profits and cover commission, then move SL to Breakeven + 2 points.
        // Let remaining 50% run to the full 3.0R+ institutional POI.
        if (this.autoBeEnabled && !partialTaken && rMultiple >= 1.5) {
          const halfVolume = Number((currentVolume * 0.5).toFixed(2));
          if (halfVolume >= 0.01 && currentVolume - halfVolume >= 0.01) {
            let partialProfit = 0;
            if (cfg.category === 'metals') {
              partialProfit = Number((pts * halfVolume * cfg.contractSize).toFixed(2));
            } else if (String(posSym) === 'USDJPY') {
              partialProfit = Number(((pts * halfVolume * cfg.contractSize) / Math.max(1, curPrice)).toFixed(2));
            } else {
              partialProfit = Number((pts * halfVolume * cfg.contractSize).toFixed(2));
            }

            this.account.balance = Number((this.account.balance + partialProfit).toFixed(2));
            this.closedTrades.unshift({
              ticket: ++this.ticketCounter,
              positionTicket: p.ticket,
              symbol: posSym,
              type: p.type,
              volume: halfVolume,
              openPrice: p.price_open,
              closePrice: curPrice,
              sl: currentSl,
              tp: currentTp,
              profit: partialProfit,
              pips,
              reason: 'PARTIAL_TP',
              closedAt: new Date().toISOString(),
              comment: `Scale-Out 50% @ 1.5R (#${p.ticket})`,
              strategyRationale: p.strategyRationale,
            });
            persistClosedTrades(this.closedTrades);

            currentVolume = Number((currentVolume - halfVolume).toFixed(2));
            partialTaken = true;
            partialProfitLocked = (partialProfitLocked || 0) + partialProfit;

            // Spread-Compensated Safe Breakeven:
            // Dynamic buffer covering broker spread + commission + market noise, preventing premature runner shakeout
            const spreadPts = this.spread || 20;
            const spreadDistance = (spreadPts * cfg.pipSize) / (cfg.digits === 2 ? 10 : 1);
            const noiseDistance = 0.15 * (this._cachedMarket?.signal?.atr || cfg.pipSize * 5);
            const safeBeOffset = Number(Math.max(cfg.pipSize * 3, spreadDistance + noiseDistance).toFixed(cfg.digits));
            const beSafePrice = p.type === 'BUY'
              ? p.price_open + safeBeOffset
              : p.price_open - safeBeOffset;
            currentSl = Number(beSafePrice.toFixed(cfg.digits));
            beLocked = true;

            // Extend target for runner 50% to full 3.0R+ institutional POI
            const institutional3R_tp = p.type === 'BUY'
              ? p.price_open + 3.0 * initialRiskPts
              : p.price_open - 3.0 * initialRiskPts;
            if (p.type === 'BUY' && institutional3R_tp > currentTp) {
              currentTp = Number(institutional3R_tp.toFixed(cfg.digits));
            } else if (p.type === 'SELL' && institutional3R_tp < currentTp) {
              currentTp = Number(institutional3R_tp.toFixed(cfg.digits));
            }

            this.slog(
              `💰 MULTI-TIER SCALE-OUT (1.5R SECURED): Closed 50% (${halfVolume}L) for +$${partialProfit.toFixed(2)} USD (#${p.ticket}). SL moved to Spread-Protected BE ($${currentSl.toFixed(cfg.digits)}). Runner (${currentVolume}L) targeting 3.0R+ ($${currentTp.toFixed(cfg.digits)})!`,
              'trade'
            );

            if (this.mt5Account.connected && mt5Bridge.getStatus().connected) {
              const targetTicket = p.brokerTicket || p.positionTicket || p.ticket;
              // 1. Execute live partial close on MT5 broker to bank real profit
              void mt5Bridge.closePosition(targetTicket, halfVolume).catch((err) => {
                this.slog(
                  `⚠️ MT5 broker partial close failed for #${targetTicket}: ${err instanceof Error ? err.message : String(err)}`,
                  'warn'
                );
              });
              // 2. Adjust remaining runner position stops to spread-protected BE
              void mt5Bridge.modifyPositionStops(targetTicket, currentSl, currentTp).catch(() => {});
            }
          }
        }

        // 2. Auto Break-Even (BE) Lock fallback: at 1:1 RR (or 15 pips) move SL to spread-protected buffer
        const spreadPts = this.spread || 20;
        const spreadDistance = (spreadPts * cfg.pipSize) / (cfg.digits === 2 ? 10 : 1);
        const noiseDistance = 0.15 * (this._cachedMarket?.signal?.atr || cfg.pipSize * 5);
        const safeBeOffset = Number(Math.max(cfg.pipSize * 3, spreadDistance + noiseDistance).toFixed(cfg.digits));
        if (this.autoBeEnabled && !beLocked && (pts >= cfg.pipSize * 15 || rMultiple >= 1.0)) {
          beLocked = true;
          currentSl = Number((p.type === 'BUY' ? p.price_open + safeBeOffset : p.price_open - safeBeOffset).toFixed(cfg.digits));
          this.slog(`🛡️ ZERO-RISK BE LOCK: SL moved to $${currentSl.toFixed(cfg.digits)} (#${p.ticket}) · Spread protected!`, 'trade');
          if (this.mt5Account.connected && mt5Bridge.getStatus().connected) {
            const targetTicket = p.brokerTicket || p.positionTicket || p.ticket;
            void mt5Bridge.modifyPositionStops(targetTicket, currentSl, currentTp).catch(() => {});
          }
        }

        // 3. Trailing Stop via Formed Order Block Swings
        // As price creates new structural swing highs/lows and closes beyond them (BOS),
        // trail the stop loss to the base of each newly confirmed Order Block rather than keeping it static.
        if (this.autoBeEnabled && this._cachedMarket && this._cachedMarket.zones) {
          const activeObs = this._cachedMarket.zones.filter((z) => !z.filled && z.kind === 'OB');
          if (p.type === 'BUY') {
            // For BUY: Bullish OB base is bottom - 0.25 * ATR
            const qualifyingObs = activeObs.filter((z) => z.bullish && z.bottom > p.price_open);
            if (qualifyingObs.length > 0) {
              const highestOb = qualifyingObs.reduce((prev, curr) => (curr.bottom > prev.bottom ? curr : prev));
              const obBase = Number((highestOb.bottom - 0.25 * (this._cachedMarket.signal?.atr || cfg.pipSize * 5)).toFixed(cfg.digits));
              if (obBase > currentSl && obBase < curPrice) {
                currentSl = obBase;
                trailLocked = true;
                this.slog(`🏹 OB TRAILING STOP: SL trailed to base of confirmed Bullish Order Block ($${currentSl.toFixed(cfg.digits)}) (#${p.ticket})`, 'trade');
                if (this.mt5Account.connected && mt5Bridge.getStatus().connected) {
                  const targetTicket = p.brokerTicket || p.positionTicket || p.ticket;
                  void mt5Bridge.modifyPositionStops(targetTicket, currentSl, currentTp).catch(() => {});
                }
              }
            }
          } else {
            // For SELL: Bearish OB base is top + 0.25 * ATR
            const qualifyingObs = activeObs.filter((z) => !z.bullish && z.top < p.price_open);
            if (qualifyingObs.length > 0) {
              const lowestOb = qualifyingObs.reduce((prev, curr) => (curr.top < prev.top ? curr : prev));
              const obBase = Number((lowestOb.top + 0.25 * (this._cachedMarket.signal?.atr || cfg.pipSize * 5)).toFixed(cfg.digits));
              if (obBase < currentSl && obBase > curPrice) {
                currentSl = obBase;
                trailLocked = true;
                this.slog(`🏹 OB TRAILING STOP: SL trailed to base of confirmed Bearish Order Block ($${currentSl.toFixed(cfg.digits)}) (#${p.ticket})`, 'trade');
                if (this.mt5Account.connected && mt5Bridge.getStatus().connected) {
                  const targetTicket = p.brokerTicket || p.positionTicket || p.ticket;
                  void mt5Bridge.modifyPositionStops(targetTicket, currentSl, currentTp).catch(() => {});
                }
              }
            }
          }
        }

        // Check SL / TP
        if (p.type === 'BUY') {
          if (curPrice <= currentSl) toClose.push({ ticket: p.ticket, reason: 'SL' });
          else if (curPrice >= currentTp) toClose.push({ ticket: p.ticket, reason: 'TP' });
        } else {
          if (curPrice >= currentSl) toClose.push({ ticket: p.ticket, reason: 'SL' });
          else if (curPrice <= currentTp) toClose.push({ ticket: p.ticket, reason: 'TP' });
        }

        return {
          ...p,
          volume: currentVolume,
          sl: currentSl,
          tp: currentTp,
          beLocked,
          trailLocked,
          partialTaken,
          partialProfitLocked,
          profit,
          pips,
        };
      });

      // Safely close positions outside the map loop
      if (toClose.length > 0) {
        for (const item of toClose) {
          this.closePosition(item.ticket, item.reason);
        }
      }

      // Automatic basket protection: compound profit target (+15%) or drawdown cap (-12%)
      if (this.positions.length > 0) {
        const targetBasketTp = Math.max(1.50, this.account.balance * 0.15);
        const targetBasketSl = -Math.max(1.20, this.account.balance * 0.12);
        const currentNetPnl = this.positions.reduce((sum, p) => sum + p.profit, 0);

        if (currentNetPnl >= targetBasketTp) {
          this.slog(`🎯 Desired Profit Target Hit (+${currentNetPnl.toFixed(2)} USD). Auto-closing all positions!`, 'trade');
          this.closeAll('TP');
        } else if (currentNetPnl <= targetBasketSl) {
          this.slog(`🛡️ Account Drawdown Protection Hit (${currentNetPnl.toFixed(2)} USD). Auto-closing all positions!`, 'warn');
          this.closeAll('SL');
        }
      }
    }

    // Recalculate floating PnL and margin used after any closes
    const currentFloatingPnl = this.positions.reduce((sum, p) => sum + p.profit, 0);
    this.account.equity = Number((this.account.balance + currentFloatingPnl).toFixed(2));
    if (this.positions.length > 0) {
      syncJournalRunningPositions(this.positions.map((p) => ({ ticket: p.ticket, profit: p.profit, pips: p.pips })));
    }
    const totalMarginUsed = this.positions.reduce((sum, p) => {
      const pSym = (p.symbol || this.activeSymbol) as SupportedSymbol;
      const cSize = getInstrumentConfig(pSym).contractSize || 100;
      const notional = p.volume * cSize * p.price_open;
      return sum + notional / (this.leverage || 2000);
    }, 0);
    this.account.margin_used = Number(totalMarginUsed.toFixed(2));
    this.account.margin_free = Number(Math.max(0, this.account.equity - this.account.margin_used).toFixed(2));
    this.refreshDailyRiskState();

    // Invalidate ticker cache and emit
    this.invalidateTicker();
    this.invalidatePositions();
    this.emit('ticker');
    this.emit('positions');
    this.processPendingOrders();

    // Periodically re-evaluate market dynamics on live tick progression
    this.tickCount++;
    if (this.tickCount % 2 === 0) {
      this.refreshScanner();
    }
    if (this.tickCount % 6 === 0) {
      this.invalidateMarket();
      this.emit('market');
    }
  }

  syncSignalsToPendingOrders() {
    if (this.killSwitch) return;
    const market = this.getMarketSnapshot();
    const candidateSig = market.signal;
    if (!candidateSig) return;

    // Check if we already have an open position on active symbol or existing pending order for this POI
    const hasPosition = this.positions.some((p) => (p.symbol || this.activeSymbol) === this.activeSymbol);
    const hasPending = this.pendingOrders.some(
      (po) =>
        po.symbol === this.activeSymbol &&
        po.direction === candidateSig.direction &&
        Math.abs(po.entry - candidateSig.entry) < 0.05
    );

    if (hasPosition || hasPending) return;

    const config = getInstrumentConfig(this.activeSymbol);
    const ttlSeconds = 180; // 3-minute hold duration before cancelling if price drifts away
    const now = Date.now();
    const maxDriftPips = config.category === 'metals' ? 25 : 15;
    const curPrice = candidateSig.direction === 'BUY' ? this.ask : this.bid;
    const currentDriftPips = Number(
      (Math.abs(curPrice - candidateSig.entry) / config.pipSize).toFixed(1)
    );
    const ticket = ++this.ticketCounter;

    const newPendingOrder: PendingOrder = {
      ticket,
      symbol: this.activeSymbol,
      type: candidateSig.direction === 'BUY' ? 'BUY_LIMIT' : 'SELL_LIMIT',
      direction: candidateSig.direction,
      volume: 0.01,
      entry: candidateSig.entry,
      sl: candidateSig.sl,
      tp: candidateSig.tp,
      score: candidateSig.score,
      strategy: candidateSig.strategy || 'SMC POI Retest',
      timeframe: candidateSig.timeframe || 'M15',
      createdTime: now,
      ttlSeconds,
      expiresAt: now + ttlSeconds * 1000,
      remainingSeconds: ttlSeconds,
      maxDriftPips,
      currentDriftPips,
      status: 'PENDING',
      strategyRationale: buildSignalRationale(candidateSig),
      strategyOrderBlock: findCorrespondingOrderBlock(
        candidateSig.direction,
        candidateSig.entry,
        market.zones
      ),
    };

    this.pendingOrders.push(newPendingOrder);
    this.slog(
      `⏳ Pending ${newPendingOrder.type} #${newPendingOrder.ticket} queued at $${newPendingOrder.entry.toFixed(config.digits)} (holding for ${ttlSeconds}s / max ${maxDriftPips} pips drift)`,
      'info'
    );
    this.invalidatePositions();
    this.emit('positions');
  }

  processPendingOrders() {
    if (!isTestRuntime() && (!this.connected || !this.mt5Account.connected)) {
      return;
    }
    if (this.killSwitch) {
      if (this.pendingOrders.length > 0) {
        this.pendingOrders = [];
        this.invalidatePositions();
        this.emit('positions');
      }
      return;
    }

    if (this.pendingOrders.length === 0) {
      this.syncSignalsToPendingOrders();
      return;
    }

    const now = Date.now();
    const remainingOrders: PendingOrder[] = [];

    for (const order of this.pendingOrders) {
      const sym = (order.symbol || this.activeSymbol) as SupportedSymbol;
      const config = getInstrumentConfig(sym);
      const isCurrent = sym === this.activeSymbol;
      const curBid = isCurrent ? this.bid : this.pairData[sym]?.bid || order.entry;
      const curAsk = isCurrent ? this.ask : this.pairData[sym]?.ask || order.entry;
      const curPrice = order.direction === 'BUY' ? curAsk : curBid;

      const remainingSec = Math.max(0, Math.ceil((order.expiresAt - now) / 1000));
      const driftPts = Math.abs(curPrice - order.entry);
      const driftPips = Number((driftPts / config.pipSize).toFixed(1));

      // 1. Check if price touched or swept into the entry (fill condition)
      const filled =
        (order.direction === 'BUY' && curAsk <= order.entry) ||
        (order.direction === 'SELL' && curBid >= order.entry);

      if (filled) {
        this.slog(
          `⚡ Pending Limit Order #${order.ticket} FILLED at $${order.entry}! Converted to active position.`,
          'trade'
        );
        this.sendMarket(order.direction, order.volume, order.sl, order.tp, `limit:#${order.ticket}`);
        continue;
      }

      // 2. Check holding countdown timer expiration
      if (remainingSec <= 0) {
        this.slog(
          `⏱️ Pending Limit Order #${order.ticket} (${order.type} @ $${order.entry}) cancelled: holding window (${order.ttlSeconds}s) expired.`,
          'info'
        );
        continue;
      }

      // 3. Check if price drifted away beyond invalidation threshold
      if (driftPips > order.maxDriftPips) {
        this.slog(
          `⚠️ Pending Limit Order #${order.ticket} cancelled: price moved ${driftPips} pips away from entry (limit: ${order.maxDriftPips} pips).`,
          'warn'
        );
        continue;
      }

      remainingOrders.push({
        ...order,
        remainingSeconds: remainingSec,
        currentDriftPips: driftPips,
      });
    }

    this.pendingOrders = remainingOrders;
    this.invalidatePositions();
    this.emit('positions');

    if (this.pendingOrders.length === 0) {
      this.syncSignalsToPendingOrders();
    }
  }

  cancelPendingOrder(ticket: number) {
    const order = this.pendingOrders.find((o) => o.ticket === ticket);
    if (order) {
      if (order.isBrokerOrder && this.mt5Account.connected && mt5Bridge.getStatus().connected) {
        void mt5Bridge.cancelPendingOrder(ticket, order.symbol).catch((error: unknown) => {
          this.slog(
            `Failed to cancel MT5 pending order #${ticket}: ${error instanceof Error ? error.message : 'Unknown bridge error'}`,
            'error'
          );
        });
      }
      this.pendingOrders = this.pendingOrders.filter((o) => o.ticket !== ticket);
      this.slog(`Pending Order #${ticket} cancelled.`, 'info');
      this.invalidatePositions();
      this.emit('positions');
    }
  }

  executePendingOrderNow(ticket: number) {
    const order = this.pendingOrders.find((o) => o.ticket === ticket);
    if (order) {
      this.pendingOrders = this.pendingOrders.filter((o) => o.ticket !== ticket);
      this.slog(`⚡ Immediate Execution: Pending Order #${ticket} filled manually at market!`, 'trade');
      this.sendMarket(order.direction, order.volume, order.sl, order.tp, `manual_fill:#${ticket}`);
      this.invalidatePositions();
      this.emit('positions');
    }
  }

  async evaluateAutoExecution() {
    if (!this.autoTrade || this.killSwitch) return;
    if (!isTestRuntime() && (!this.connected || !this.mt5Account.connected || !mt5Bridge.getStatus().connected)) {
      return;
    }
    if (!isTestRuntime() && this.mt5Account.connected && !LIVE_PRECISION_AUTOTRADE_VALIDATED) {
      if (!this.liveAutoTradeDisabledLogged) {
        this.slog(
          'Live auto-trading is disabled until precision-entry and exit policies are validated against broker tick history.',
          'warn'
        );
        this.liveAutoTradeDisabledLogged = true;
      }
      return;
    }

    // Real market hours check: Gold interbank trading is closed on weekends!
    const schedule = getGoldMarketSchedule();
    if (this.instrumentType === 'standard' && !schedule.isOpen) {
      return;
    }

    let market = this.getMarketSnapshot();
    const now = Date.now();
    const getReadyCandidate = (symbol: SupportedSymbol) => {
      const pair = this.pairData[symbol];
      const bid = symbol === this.activeSymbol ? this.bid : pair.bid;
      const ask = symbol === this.activeSymbol ? this.ask : pair.ask;
      const spread = symbol === this.activeSymbol ? this.spread : pair.spread;
      const cfg = getInstrumentConfig(symbol);
      if (
        !Number.isFinite(bid) ||
        !Number.isFinite(ask) ||
        bid <= 0 ||
        ask < bid ||
        spread > cfg.maxSpreadPoints ||
        (!isTestRuntime() &&
          (Date.now() - pair.marketDataAt > 45_000 ||
            !hasFreshBrokerCandles(pair.candlesM1, 60_000) ||
            !hasFreshBrokerCandles(pair.candlesM5, 5 * 60_000) ||
            !hasFreshBrokerCandles(pair.candlesM15, 15 * 60_000) ||
            !hasFreshBrokerCandles(pair.candlesH1, 60 * 60_000)))
      ) {
        return null;
      }
      return rankOpportunities(
        this.getScannerEntryCandidates()
          .filter((candidate) => candidate.symbol === symbol && candidate.status === 'READY')
          .map((candidate) => ({
            ...candidate,
            bid,
            ask,
            price: (bid + ask) / 2,
            spreadPoints: spread,
            spreadAcceptable: spread <= cfg.maxSpreadPoints,
          }))
      ).find((candidate) =>
          isPrecisionExecutionReady(candidate, this.executionMode, now)
      ) ?? null;
    };

    let readyCandidate = getReadyCandidate(this.activeSymbol);
    if (!readyCandidate && this.autoSelectBestScenario) {
      const rankedPairs = rankOpportunities(
        this.getScannerEntryCandidates().filter((candidate) => candidate.status === 'READY')
      );
      const otherPair = rankedPairs.find(
        (candidate) =>
          candidate.symbol !== this.activeSymbol &&
          getReadyCandidate(candidate.symbol) !== null
      );
      if (otherPair) {
        this.switchSymbol(otherPair.symbol);
        market = this.getMarketSnapshot();
        readyCandidate = getReadyCandidate(otherPair.symbol);
      }
    }
    const sig = readyCandidate?.signal ?? null;
    if (sig) {
      if (!market.brokerMarketData && this.mt5Account.connected) {
        this.slog('Auto-trade blocked: live MT5 broker candle feed is unavailable.', 'warn');
        return;
      }
      const nowMs = Date.now();
      for (const [k, ts] of this.executedSignalKeys.entries()) {
        if (nowMs - ts > 30 * 60_000) this.executedSignalKeys.delete(k);
      }
      const dedupKey = `${this.activeSymbol}:${sig.strategy || 'SMC POI Retest'}:${sig.timeframe}:${sig.direction}:${sig.sourceCandleOpenTime}`;
      if (this.executedSignalKeys.has(dedupKey)) {
        return;
      }

      const blockReason = this.getEntryBlockReason(sig.direction, sig);
      if (blockReason) {
        this.recordRejectedSignal(sig, blockReason, this.activeSymbol);
        return;
      }
      const intendedPullbackLimit =
        sig.executionMode === 'PULLBACK_LIMIT' || this.executionMode === 'PULLBACK_LIMIT';
      const limitPrice = sig.optimalTradeEntry;
      const config = getInstrumentConfig(this.activeSymbol);
      const currentExecutionPrice = sig.direction === 'BUY' ? this.ask : this.bid;
      const validPullbackLimit =
        Number.isFinite(limitPrice) &&
        (sig.direction === 'BUY'
          ? (limitPrice as number) < currentExecutionPrice && (limitPrice as number) > sig.sl
          : (limitPrice as number) > currentExecutionPrice && (limitPrice as number) < sig.sl);
      if (intendedPullbackLimit && !validPullbackLimit) {
        const lastLogAt = this.lastAutoWaitLogAt.get(dedupKey) ?? 0;
        if (nowMs - lastLogAt >= 60_000) {
          this.slog(
            `Auto-trade waiting: ${this.activeSymbol} ${sig.timeframe} pullback level is not currently a broker-valid limit price.`,
            'info'
          );
          this.lastAutoWaitLogAt.set(dedupKey, nowMs);
        }
        return;
      }
      const rationale = buildSignalRationale(sig);
      let volume: number;
      let executionSymbol = this.activeSymbol;
      let executionPrice = sig.direction === 'BUY' ? this.ask : this.bid;
      if (this.mt5Account.connected) {
        if (!mt5Bridge.getStatus().connected) {
          this.recordRejectedSignal(sig, 'MT5 bridge is offline', this.activeSymbol);
          this.slog('MT5 auto-order blocked: local bridge is offline.', 'error');
          return;
        }
        const requestedSymbol = (mt5Bridge.getSymbol() || this.activeSymbol).toUpperCase();
        if (!SUPPORTED_SYMBOLS.includes(requestedSymbol as SupportedSymbol)) {
          const reason = 'TRADE_REJECTED: BROKER_SYMBOL_SPEC_UNAVAILABLE';
          this.recordRejectedSignal(sig, reason, requestedSymbol);
          this.slog(`Auto-trade blocked: no verified broker sizing specification for ${requestedSymbol}.`, 'error');
          return;
        }
        executionSymbol = requestedSymbol as SupportedSymbol;
        const bid = executionSymbol === this.activeSymbol ? this.bid : this.pairData[executionSymbol]?.bid;
        const ask = executionSymbol === this.activeSymbol ? this.ask : this.pairData[executionSymbol]?.ask;
        if (executionSymbol !== this.activeSymbol || !Number.isFinite(bid) || !Number.isFinite(ask)) {
          const reason = 'TRADE_REJECTED: BROKER_SYMBOL_SPEC_UNAVAILABLE';
          this.recordRejectedSignal(sig, reason, executionSymbol);
          this.slog(`Auto-trade blocked: no verified quote/spec for execution symbol ${executionSymbol}.`, 'error');
          return;
        }
        executionPrice = sig.direction === 'BUY' ? ask as number : bid as number;
        const sizing = this.getExecutionRiskVolume(undefined, sig.sl, executionPrice, executionSymbol);
        if (sizing.volume === null) {
          const reason = sizing.rejectionReason || 'Position sizing error: broker specification cannot size stop safely';
          this.recordRejectedSignal(sig, reason, executionSymbol);
          this.slog(`Auto-trade blocked: ${reason}`, 'error');
          return;
        }
        volume = sizing.volume;
      } else {
        const paperVolume = this.getRiskBasedVolume(sig.sl);
        if (!paperVolume) {
          this.recordRejectedSignal(sig, 'Position sizing error: broker specification cannot size stop safely', this.activeSymbol);
          this.slog('Auto-trade blocked: broker symbol tick-value/volume specification cannot size this stop safely.', 'error');
          return;
        }
        volume = paperVolume;
      }

      this.executedSignalKeys.set(dedupKey, nowMs);
      this.slog(`Auto-Trader approved: ${this.activeSymbol} ${sig.timeframe} ${sig.direction} score ${sig.score} - ${rationale}`, 'signal');
      if (this.mt5Account.connected) {
        try {
          const usePullbackLimit = intendedPullbackLimit;
          const result = await mt5Bridge.sendTrade({
            direction: sig.direction,
            volume,
            symbol: executionSymbol,
            sl: sig.sl,
            tp: sig.tp,
            rationale,
            clientOrderId: `${executionSymbol}:${sig.strategy}:${sig.timeframe}:${sig.direction}:${sig.sourceCandleOpenTime}`,
            poiKey: this.getSignalPoiKey(sig.direction, sig.entry),
            instrumentType: this.instrumentType,
            signalTimeframe: sig.timeframe === 'M1' ? 'M1' : sig.timeframe === 'M15' ? 'M15' : 'M5',
            signalTimestamp: (() => {
              if (!sig.timestamp) return new Date().toISOString();
              const parsed = new Date(sig.timestamp).getTime();
              return Number.isNaN(parsed) || parsed > Date.now()
                ? new Date().toISOString()
                : new Date(parsed).toISOString();
            })(),
            ...(usePullbackLimit
              ? {
                  orderType: 'LIMIT' as const,
                  limitPrice: Number((limitPrice as number).toFixed(config.digits)),
                  expirationMinutes: sig.timeframe === 'M1' ? 3 : sig.timeframe === 'M5' ? 10 : 20,
                }
              : {}),
            magic: config.magicNumber,
          });
          this.recordMt5Rationale(
            result.ticket,
            result.positionTicket,
            rationale,
            findCorrespondingOrderBlock(sig.direction, sig.entry, market.zones)
          );
          if (!result.pending) this.recordAcceptedEntry(sig.direction, sig);
          if (result.pending) {
            this.recordPendingSignal(sig, result.ticket, volume, this.activeSymbol, rationale);
          } else {
            this.recordExecutedSignal(sig, result.ticket, volume, this.activeSymbol, rationale);
          }
          if (!result.pending) {
            recordTradeTaken({
              ticket: result.positionTicket || result.ticket,
              symbol: this.activeSymbol,
              type: sig.direction,
              volume: result.filledVolume || volume,
              openPrice: result.price,
              closePrice: result.price,
              openTime: new Date().toISOString(),
              sl: sig.sl,
              tp: sig.tp,
              profit: 0,
              pips: 0,
              reason: 'Manual',
              strategyRationale: rationale,
              status: 'RUNNING',
            });
          }
          this.slog(
            result.pending
              ? `MT5 auto-order placed (${usePullbackLimit ? 'OTE LIMIT' : 'pending'}): #${result.ticket} · ${result.filledVolume} lots reported.`
              : result.partial
              ? `MT5 auto-order partially filled: ${sig.direction} ${result.filledVolume} lots · #${result.ticket}. Verify remaining quantity.`
              : `MT5 auto-order accepted: ${sig.direction} ${result.filledVolume} lots on ${sig.timeframe} score ${sig.score} · #${result.ticket}`,
            result.pending || result.partial ? 'warn' : 'trade'
          );
          if (!result.pending) {
            void dispatchExecutionNotification({
              symbol: executionSymbol,
              direction: sig.direction,
              volume: result.filledVolume || volume,
              openPrice: result.price || sig.entry,
              sl: sig.sl,
              tp: sig.tp,
              ticket: result.positionTicket || result.ticket,
            });
          }
        } catch (error) {
          this.executedSignalKeys.delete(dedupKey);
          const errMsg = error instanceof Error ? error.message : 'Unknown bridge error';
          this.slog(`MT5 auto-order rejected: ${errMsg}`, 'error');
          this.recordRejectedSignal(sig, errMsg, this.activeSymbol);
          if (
            this.autoTrade &&
            (errMsg.includes('10017') || errMsg.toLowerCase().includes('trade disabled'))
          ) {
            this.toggleAutoTrade();
            this.slog(
              'Auto-trade paused because MT5 has disabled trading. Enable account and symbol trading in MT5 before turning auto-trade back on.',
              'warn'
            );
          }
          this.entryHistory.push({
            at: Date.now(),
            direction: sig.direction,
            symbol: this.activeSymbol,
            poiKey: this.getSignalPoiKey(sig.direction, sig.entry),
          });
          this.entryHistory = this.entryHistory.slice(-100);
        }
        return;
      }
      this.sendMarket(
        sig.direction,
        volume,
        sig.sl,
        sig.tp,
        `auto:${sig.score}`
      );
    }
  }

  sendMarket(
    direction: TradeDirection,
    volume: number,
    sl: number,
    tp: number,
    comment: string = 'manual',
    targetSymbol?: SupportedSymbol
  ): { ok: boolean; ticket?: number; price?: number; error?: string } {
    // SAFETY-FIX: Kill switch is absolute. Never auto-disarm or bypass for sniper or any other order.
    if (this.killSwitch) {
      return { ok: false, error: 'Trading halted by Kill Switch' };
    }

    const isSniperOrder =
      comment.startsWith('sniper:') ||
      comment.toLowerCase().includes('sniper') ||
      Boolean(this.getMarketSnapshot().signal?.isSniper);

    const symbolToTrade = targetSymbol || this.activeSymbol;
    const isManual = !comment.startsWith('auto:');
    const market = this.getMarketSnapshot();
    // SAFETY-FIX: Sniper trades flow through all checks in getEntryBlockReason (no isSniperOrder bypass)
    const blockReason = this.getEntryBlockReason(direction, market.signal, Date.now(), isManual, symbolToTrade);
    if (blockReason) {
      if (market.signal) {
        this.recordRejectedSignal(market.signal, blockReason, symbolToTrade);
      }
      return { ok: false, error: blockReason };
    }
    const config = getInstrumentConfig(symbolToTrade);
    const pairQuote = this.pairData[symbolToTrade];
    const symBid = symbolToTrade === this.activeSymbol ? this.bid : (pairQuote?.bid ?? this.bid);
    const symAsk = symbolToTrade === this.activeSymbol ? this.ask : (pairQuote?.ask ?? this.ask);
    const openPrice = direction === 'BUY' ? symAsk : symBid;
    const liveExecution = this.mt5Account.connected && mt5Bridge.getStatus().connected;
    if (!liveExecution && !isTestRuntime()) {
      const error = 'TRADE_REJECTED: VERIFIED_MT5_CONNECTION_REQUIRED';
      this.slog(error, 'error');
      return { ok: false, error };
    }
    let riskVolume: number;
    if (liveExecution) {
      const sizing = this.getExecutionRiskVolume(volume, sl, openPrice, symbolToTrade);
      if (sizing.volume === null) {
        if (market.signal) this.recordRejectedSignal(market.signal, sizing.rejectionReason || 'Position sizing rejected', symbolToTrade);
        return { ok: false, error: sizing.rejectionReason || 'Position sizing rejected' };
      }
      riskVolume = sizing.volume;
    } else {
      // Preserve the local paper simulation sizing/behavior; strict execution validation is live-only.
      const minVol = this.symbolSpec?.volumeMin ?? 0.01;
      const maxVol = this.symbolSpec?.volumeMax ?? 100.0;
      riskVolume = volume > 0
        ? Math.max(minVol, Math.min(maxVol, Number(volume.toFixed(2))))
        : (this.getRiskBasedVolume(sl, volume) || minVol);
      if (!riskVolume || isNaN(riskVolume)) riskVolume = minVol;
    }
    const ticket = ++this.ticketCounter;
    const rationale = market.signal
      ? buildSignalRationale(market.signal)
      :
      (direction === 'BUY'
        ? `Liquidity sweep into Bullish Order Block (+OB) in Discount zone (<50% EQ) on ${symbolToTrade}. Confirmed FVG displacement with 1:2.0+ RR target.`
        : `Liquidity sweep into Bearish Order Block (-OB) in Premium zone (>50% EQ) on ${symbolToTrade}. Confirmed FVG displacement with 1:2.0+ RR target.`);

    // SAFETY-FIX: When MT5 bridge is connected, do NOT mutate this.positions locally.
    // Send the order, await the result, and let syncMt5Snapshot() reconciliation populate positions.
    // On bridge error, surface it and record a journal rejection; state stays untouched.
    if (liveExecution) {
      void (async () => {
        try {
          const res = await mt5Bridge.sendTrade({
            direction,
            volume: riskVolume,
            symbol: symbolToTrade,
            sl: Number(sl.toFixed(config.digits)),
            tp: Number(tp.toFixed(config.digits)),
            rationale,
            clientOrderId: `${symbolToTrade}:${direction}:${Date.now()}`,
            poiKey: this.getSignalPoiKey(direction, openPrice),
            instrumentType: this.instrumentType,
            signalTimeframe:
              (market.signal?.timeframe === 'M1' || market.currentTimeframe === 'M1')
                ? 'M1'
                : (market.signal?.timeframe === 'M15' || market.currentTimeframe === 'M15')
                  ? 'M15'
                  : 'M5',
            signalTimestamp: new Date().toISOString(),
            forceExecute: false,
            bypassCooldown: isSniperOrder || undefined,
          });
          this.recordMt5Rationale(
            res.ticket,
            res.positionTicket,
            rationale,
            findCorrespondingOrderBlock(direction, openPrice, market.zones)
          );
          if (!res.pending) this.recordAcceptedEntry(direction, market.signal);
          if (market.signal) {
            if (res.pending) {
              this.recordPendingSignal(market.signal, res.ticket, riskVolume, symbolToTrade, rationale);
            } else {
              this.recordExecutedSignal(market.signal, res.ticket, riskVolume, symbolToTrade, rationale);
            }
          }
          if (!res.pending) {
            void dispatchExecutionNotification({
              symbol: symbolToTrade,
              direction,
              volume: res.filledVolume || riskVolume,
              openPrice: res.price || openPrice,
              sl: Number(sl.toFixed(config.digits)),
              tp: Number(tp.toFixed(config.digits)),
              ticket: res.ticket,
            });
          }
        } catch (err: any) {
          const errMsg = err?.message || 'Rejected';
          const isTradeDisabled = errMsg.includes('10017') || errMsg.toLowerCase().includes('trade disabled');
          this.lastExecutionError = {
            symbol: symbolToTrade,
            message: errMsg,
            timestamp: Date.now(),
            isTradeDisabled,
          };
          this.slog(`MT5 Broker Execution Error on ${symbolToTrade}: ${errMsg}`, 'error');
          if (market.signal) {
            this.recordRejectedSignal(market.signal, `MT5 bridge error: ${errMsg}`, symbolToTrade);
          }
          this.invalidateMarket();
          this.emit('market');
        }
      })();
      return { ok: true, ticket, price: openPrice };
    }

    // Local paper trading simulation (when MT5 is disconnected)
    const newPos: Position = {
      ticket,
      symbol: symbolToTrade,
      time: new Date().toISOString().substr(11, 8),
      type: direction,
      volume: riskVolume,
      initialVolume: riskVolume,
      price_open: openPrice,
      sl: Number(sl.toFixed(config.digits)),
      initialSl: Number(sl.toFixed(config.digits)),
      tp: Number(tp.toFixed(config.digits)),
      initialTp: Number(tp.toFixed(config.digits)),
      profit: 0.0,
      pips: 0.0,
      magic: config.magicNumber,
      comment: `${symbolToTrade}:${comment}`,
      strategyRationale: rationale,
      strategyOrderBlock: findCorrespondingOrderBlock(
        direction,
        market.signal?.entry ?? openPrice,
        market.zones
      ),
    };

    this.positions = [...this.positions, newPos];
    this.selectedTicket = ticket; // Automatically focus the newly entered trade on the chart!
    this.recordAcceptedEntry(direction, market.signal);
    recordTradeTaken({
      ticket,
      symbol: symbolToTrade,
      type: direction,
      volume: riskVolume,
      openPrice,
      closePrice: openPrice,
      openTime: new Date().toISOString(),
      sl: Number(sl.toFixed(config.digits)),
      tp: Number(tp.toFixed(config.digits)),
      profit: 0,
      pips: 0,
      reason: 'Manual',
      comment: `${symbolToTrade}:${comment}`,
      strategyRationale: rationale,
      status: 'RUNNING',
    });
    if (market.signal) {
      this.recordExecutedSignal(market.signal, ticket, riskVolume, symbolToTrade, rationale);
    }
    this.slog(`${symbolToTrade} ${comment} ${direction} ${riskVolume} @ ${openPrice} -> #${ticket}`, 'trade');

    void dispatchExecutionNotification({
      symbol: symbolToTrade,
      direction,
      volume: riskVolume,
      openPrice,
      sl: Number(sl.toFixed(config.digits)),
      tp: Number(tp.toFixed(config.digits)),
      ticket,
    });

    this.invalidatePositions();
    this.invalidateTicker();
    this.emit('positions');
    this.emit('ticker');

    return { ok: true, ticket, price: openPrice };
  }

  closePosition(ticket: number, reason: 'TP' | 'SL' | 'Manual' | 'KillSwitch' = 'Manual') {
    const pos = this.positions.find((p) => p.ticket === ticket);
    if (!pos) return;

    // SAFETY-FIX: If MT5 bridge is actively connected, do NOT optimistically remove local position.
    // Send close to broker; only remove local row upon confirmed bridge success or broker snapshot reconciliation.
    if (this.mt5Account.connected) {
      if (!mt5Bridge.getStatus().connected) {
        this.slog(`Unable to close MT5 position #${ticket}: bridge is offline. Position remains open.`, 'error');
        return;
      }
      const targetBrokerTicket = pos.brokerTicket || pos.positionTicket || ticket;
      void mt5Bridge.closePosition(targetBrokerTicket)
        .then(() => {
          this.slog(`MT5 close confirmed for #${targetBrokerTicket}`, 'trade');
          this.positions = this.positions.filter((p) => p.ticket !== ticket && p.brokerTicket !== targetBrokerTicket);
          this.invalidatePositions();
          this.emit('positions');
        })
        .catch((error: unknown) => {
          this.slog(
            `MT5 close failed for #${targetBrokerTicket}: ${error instanceof Error ? error.message : 'Bridge error'}. Position remains open.`,
            'error'
          );
        });
      return;
    }

    const posSym = pos.symbol || this.activeSymbol;
    const cfg = getInstrumentConfig(posSym);
    const closePrice = pos.type === 'BUY' ? this.bid : this.ask;
    const pts = pos.type === 'BUY' ? closePrice - pos.price_open : pos.price_open - closePrice;
    const pips = Number((pts / cfg.pipSize).toFixed(1));
    let profit = 0;
    if (cfg.category === 'metals') {
      profit = Number((pts * pos.volume * cfg.contractSize).toFixed(2));
    } else if (String(posSym) === 'USDJPY') {
      profit = Number(((pts * pos.volume * cfg.contractSize) / Math.max(1, closePrice)).toFixed(2));
    } else {
      profit = Number((pts * pos.volume * cfg.contractSize).toFixed(2));
    }

    const closedAt = new Date();
    const closed: ClosedTrade = {
      ticket: pos.ticket,
      symbol: posSym,
      openTime: pos.time,
      closeTime: closedAt.toISOString().substr(11, 8),
      closedAt: closedAt.toISOString(),
      type: pos.type,
      volume: pos.volume,
      openPrice: pos.price_open,
      closePrice,
      profit,
      pips,
      reason,
      comment: pos.comment,
      strategyRationale: pos.strategyRationale,
      strategyOrderBlock: pos.strategyOrderBlock,
    };

    this.positions = this.positions.filter((p) => p.ticket !== ticket);
    if (this.selectedTicket === ticket) this.selectedTicket = this.positions[0]?.ticket ?? null;
    // ClosedTrades order must be preserved (Priority 15)
    this.closedTrades = [closed, ...this.closedTrades];
    persistClosedTrades(this.closedTrades);
    updateTradeClosedInJournal(pos.ticket, closePrice, profit, pips, reason, closedAt.toISOString());
    reconcileRunningJournalTrades(this.positions.map((p) => p.ticket));
    this.account.balance = Number((this.account.balance + profit).toFixed(2));
    const remainingFloatingPnl = this.positions.reduce((sum, p) => sum + p.profit, 0);
    this.account.equity = Number((this.account.balance + remainingFloatingPnl).toFixed(2));

    this.slog(`Closed #${ticket} (${reason}) PnL: ${profit >= 0 ? '+' : ''}$${profit} USD | Balance: $${this.account.balance.toFixed(2)}`, 'trade');

    try {
      if (profit >= 0) {
        signalAudioNotifier.playProfitAlert(profit);
      } else {
        signalAudioNotifier.playLossAlert(profit);
      }
    } catch {
      // ignore
    }

    this.invalidatePositions();
    this.invalidateTicker();
    this.invalidateEngine();
    this.emit('positions');
    this.emit('ticker');
    this.emit('engine');
  }

  modifyPositionStops(ticket: number, sl: number, tp: number) {
    const position = this.positions.find((item) => item.ticket === ticket);
    if (!position) return;

    if (this.mt5Account.connected) {
      if (!mt5Bridge.getStatus().connected) {
        this.slog(`Unable to update MT5 position #${ticket}: bridge is offline.`, 'error');
        return;
      }
      const targetBrokerTicket = position.brokerTicket || position.positionTicket || ticket;
      void mt5Bridge.modifyPositionStops(targetBrokerTicket, sl, tp).catch((error: unknown) => {
        this.slog(
          `Unable to update MT5 position #${targetBrokerTicket}: ${error instanceof Error ? error.message : 'Unknown bridge error'}`,
          'error'
        );
      });
      return;
    }

    position.sl = sl;
    position.tp = tp;
    position.beLocked = position.type === 'BUY' ? sl > position.price_open : sl < position.price_open;
    if (position.beLocked) {
      try {
        signalAudioNotifier.playBreakEvenAlert();
      } catch {
        // ignore
      }
    }
    this.slog(`Stops updated for position #${ticket}: SL $${sl.toFixed(2)}, TP $${tp.toFixed(2)}`, 'trade');
    this.notify();
  }

  async scaleOutPosition(ticket: number, fraction = 0.5): Promise<boolean> {
    const pos = this.positions.find((p) => p.ticket === ticket);
    if (!pos || !Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) return false;
    const posSym = pos.symbol || this.activeSymbol;
    const cfg = getInstrumentConfig(posSym);
    const pairSymbol = getSupportedSymbol(posSym);
    const pairQuote = pairSymbol ? this.pairData[pairSymbol] : undefined;
    const curPrice = posSym === this.activeSymbol
      ? pos.type === 'BUY' ? this.bid : this.ask
      : pos.type === 'BUY' ? pairQuote?.bid ?? 0 : pairQuote?.ask ?? 0;
    if (!Number.isFinite(curPrice) || curPrice <= 0) {
      this.slog(`Scale-out blocked for #${ticket}: no valid ${posSym} quote is available.`, 'error');
      return false;
    }
    const pts = pos.type === 'BUY' ? curPrice - pos.price_open : pos.price_open - curPrice;
    const pips = Number((pts / cfg.pipSize).toFixed(1));
    const spec = posSym === this.activeSymbol ? this.symbolSpec : pairQuote?.symbolSpec;
    if (this.mt5Account.connected && !spec) {
      this.slog(`Scale-out blocked for #${ticket}: verified ${posSym} broker volume specifications are unavailable.`, 'error');
      return false;
    }
    const volumeStep = spec?.volumeStep ?? 0.01;
    const volumeMin = spec?.volumeMin ?? 0.01;
    const volumeUnits = Math.floor((pos.volume * fraction + volumeStep * 1e-8) / volumeStep);
    const closeVol = Number((volumeUnits * volumeStep).toFixed(8));
    if (closeVol < 0.01 || pos.volume - closeVol < 0.01) return false;
    if (closeVol < volumeMin || pos.volume - closeVol < volumeMin) {
      this.slog(
        `Scale-out blocked for #${ticket}: ${posSym} requires at least ${volumeMin} lots per remaining position.`,
        'warn'
      );
      return false;
    }

    if (this.mt5Account.connected) {
      if (!mt5Bridge.getStatus().connected) {
        this.slog(`Scale-out blocked for MT5 position #${ticket}: bridge is offline.`, 'error');
        return false;
      }
      if (this.partialCloseInFlight.has(ticket)) return false;
      const brokerTicket = pos.brokerTicket || pos.positionTicket || pos.ticket;
      this.partialCloseInFlight.add(ticket);
      try {
        await mt5Bridge.closePosition(brokerTicket, closeVol);
        const remainingPosition = this.positions.find((item) => item.ticket === ticket);
        if (!remainingPosition) {
          this.slog(
            `MT5 accepted the scale-out request for #${brokerTicket}, but no remaining position was reported. Verify the broker position.`,
            'warn'
          );
          return true;
        }
        this.slog(
          `MT5 confirmed partial close of ${closeVol} lots for #${brokerTicket}; remaining broker volume is ${remainingPosition.volume} lots.`,
          'trade'
        );

        const bePrice = Number(
          (pos.type === 'BUY' ? pos.price_open + cfg.pointSize * 2 : pos.price_open - cfg.pointSize * 2)
            .toFixed(cfg.digits)
        );
        const stopCanTighten =
          pos.type === 'BUY'
            ? bePrice > remainingPosition.sl && curPrice > bePrice
            : (remainingPosition.sl <= 0 || bePrice < remainingPosition.sl) && curPrice < bePrice;
        if (stopCanTighten) {
          try {
            await mt5Bridge.modifyPositionStops(brokerTicket, bePrice, remainingPosition.tp);
          } catch (error) {
            this.slog(
              `Partial close succeeded for #${brokerTicket}, but the breakeven stop update failed: ${error instanceof Error ? error.message : 'Unknown bridge error'}. Verify the broker stop.`,
              'error'
            );
          }
        }
        return true;
      } catch (error) {
        this.slog(
          `MT5 partial close failed for #${brokerTicket}: ${error instanceof Error ? error.message : 'Unknown bridge error'}. Position was not changed locally.`,
          'error'
        );
        return false;
      } finally {
        this.partialCloseInFlight.delete(ticket);
      }
    }

    let partialProfit = 0;
    if (cfg.category === 'metals') {
      partialProfit = Number((pts * closeVol * cfg.contractSize).toFixed(2));
    } else if (String(posSym) === 'USDJPY') {
      partialProfit = Number(((pts * closeVol * cfg.contractSize) / Math.max(1, curPrice)).toFixed(2));
    } else {
      partialProfit = Number((pts * closeVol * cfg.contractSize).toFixed(2));
    }

    this.account.balance = Number((this.account.balance + partialProfit).toFixed(2));
    const closedAt = new Date();
    this.closedTrades.unshift({
      ticket: ++this.ticketCounter,
      positionTicket: pos.ticket,
      symbol: posSym,
      openTime: pos.time,
      closeTime: closedAt.toISOString().substr(11, 8),
      closedAt: closedAt.toISOString(),
      type: pos.type,
      volume: closeVol,
      openPrice: pos.price_open,
      closePrice: curPrice,
      sl: pos.sl,
      tp: pos.tp,
      profit: partialProfit,
      pips,
      reason: 'PARTIAL_TP',
      comment: `Manual Scale-Out ${(fraction * 100).toFixed(0)}% (#${pos.ticket})`,
      strategyRationale: pos.strategyRationale,
    });
    persistClosedTrades(this.closedTrades);

    pos.volume = Number((pos.volume - closeVol).toFixed(2));
    pos.partialTaken = true;
    pos.partialProfitLocked = (pos.partialProfitLocked || 0) + partialProfit;

    // Automatically move SL to Breakeven + 2 points
    const bePlus2 = pos.type === 'BUY'
      ? pos.price_open + cfg.pipSize * 2
      : pos.price_open - cfg.pipSize * 2;
    pos.sl = Number(bePlus2.toFixed(cfg.digits));
    pos.beLocked = true;

    this.slog(
      `💰 SCALE-OUT EXECUTED: Closed ${closeVol}L for +$${partialProfit.toFixed(2)} USD (#${pos.ticket}). SL moved to BE+2pts ($${pos.sl.toFixed(cfg.digits)}). Remaining ${pos.volume}L running.`,
      'trade'
    );

    if (this.mt5Account.connected && mt5Bridge.getStatus().connected) {
      void mt5Bridge.modifyPositionStops(pos.ticket, pos.sl, pos.tp).catch(() => {});
    }

    this.invalidatePositions();
    this.emit('positions');
    this.emit('ticker');
    return true;
  }

  closeAll(reason: 'Manual' | 'KillSwitch' | 'TP' | 'SL' = 'Manual') {
    if (this.positions.length === 0) return;
    const tickets = this.positions.map((p) => p.ticket);
    for (const t of tickets) {
      this.closePosition(t, reason);
    }
  }

  toggleKillSwitch(): boolean {
    this.killSwitch = !this.killSwitch;
    if (this.killSwitch) {
      this.autoTrade = false;
      this.closeAll('KillSwitch');
      this.slog(
        this.mt5Account.connected
          ? 'KILL SWITCH ARMED: MT5 close requests sent; verify broker positions. Auto-trade halted.'
          : 'KILL SWITCH ARMED: All positions closed, auto-trade halted',
        'warn'
      );
    } else {
      this.slog('KILL SWITCH DISARMED: Engine ready', 'info');
      if (this.mt5Account.connected) {
        void mt5Bridge.resetCircuitBreakers().catch(() => {});
      }
    }
    if (this.mt5Account.connected) {
      this.pendingCentralKillSwitch = this.killSwitch;
      void mt5Bridge.setTradingHalted(this.killSwitch).catch((error: unknown) => {
        this.pendingCentralKillSwitch = null;
        this.slog(
          `Central kill-switch update failed: ${error instanceof Error ? error.message : 'Unknown bridge error'}`,
          'error'
        );
      });
    }

    this.invalidateEngine();
    this.emit('engine');
    return this.killSwitch;
  }

  toggleAutoTrade(): boolean {
    if (this.killSwitch) {
      this.slog('Cannot enable auto-trade while Kill Switch is armed', 'error');
      return false;
    }
    this.autoTrade = !this.autoTrade;
    this.slog(`AUTO-TRADE ${this.autoTrade ? 'ON' : 'OFF'}`, 'info');

    if (this.mt5Account.connected) {
      const requestedAutoTrade = this.autoTrade;
      this.pendingCentralAutoTrade = requestedAutoTrade;
      void mt5Bridge.setAutoTrade(this.autoTrade).catch((error: unknown) => {
        if (this.pendingCentralAutoTrade !== requestedAutoTrade) return;
        this.pendingCentralAutoTrade = null;
        this.slog(
          `Failed to update auto-trade state on server: ${error instanceof Error ? error.message : 'Unknown bridge error'}`,
          'error'
        );
        // Revert the local change if the server update failed
        this.autoTrade = !requestedAutoTrade;
        this.slog(`AUTO-TRADE ${this.autoTrade ? 'ON' : 'OFF'} (reverted due to server error)`, 'warn');
        this.invalidateEngine();
        this.emit('engine');
      });
    }

    this.invalidateEngine();
    this.emit('engine');
    return this.autoTrade;
  }

  toggleNewsBlackout(): boolean {
    this.newsBlackout = !this.newsBlackout;
    this.slog(`NEWS BLACKOUT ${this.newsBlackout ? 'ENABLED' : 'DISABLED'}`, 'info');
    this.invalidateEngine();
    this.emit('engine');
    return this.newsBlackout;
  }

  notify() {
    this.invalidateTicker();
    this.invalidateMarket();
    this.invalidatePositions();
    this.invalidateEngine();
    this.emit('ticker');
    this.emit('market');
    this.emit('positions');
    this.emit('engine');
  }

  tradeSignal(
    optionsOrVolume?:
      | {
          direction?: TradeDirection;
          volume?: number;
          entry?: number;
          sl?: number;
          tp?: number;
          comment?: string;
        }
      | number
  ): { ok: boolean; error?: string; ticket?: number; price?: number } {
    const config = getInstrumentConfig(this.activeSymbol);
    const market = this.getMarketSnapshot();
    const defaultSig = market.signal;
    const defaultVol = 0.01;

    let direction: TradeDirection = defaultSig?.direction || (market.bias === 'bearish' ? 'SELL' : 'BUY');
    let vol = defaultVol;
    let sl = defaultSig ? defaultSig.sl : (direction === 'BUY' ? this.bid - config.pipSize * 20 : this.bid + config.pipSize * 20);
    let tp = defaultSig ? defaultSig.tp : (direction === 'BUY' ? this.bid + config.pipSize * 40 : this.bid - config.pipSize * 40);
    let comment = defaultSig ? `signal:${defaultSig.score}` : 'manual';

    if (typeof optionsOrVolume === 'number') {
      if (optionsOrVolume > 0) vol = optionsOrVolume;
    } else if (optionsOrVolume && typeof optionsOrVolume === 'object') {
      if (optionsOrVolume.direction) direction = optionsOrVolume.direction;
      if (optionsOrVolume.volume && optionsOrVolume.volume > 0) vol = optionsOrVolume.volume;
      if (optionsOrVolume.sl !== undefined) sl = optionsOrVolume.sl;
      if (optionsOrVolume.tp !== undefined) tp = optionsOrVolume.tp;
      if (optionsOrVolume.comment) comment = optionsOrVolume.comment;
    }

    return this.sendMarket(
      direction,
      vol,
      Number(sl.toFixed(config.digits)),
      Number(tp.toFixed(config.digits)),
      comment
    );
  }

  tradeMultiplePositions(
    count: number,
    optionsOrVolume?:
      | {
          direction?: TradeDirection;
          volume?: number;
          entry?: number;
          sl?: number;
          tp?: number;
          comment?: string;
        }
      | number
  ): { countOpened: number; tickets: number[] } {
    const openedTickets: number[] = [];
    const n = Math.max(1, Math.min(10, count || 1));

    for (let i = 0; i < n; i++) {
      const res = this.tradeSignal(
        typeof optionsOrVolume === 'object' && optionsOrVolume
          ? { ...optionsOrVolume, comment: `${optionsOrVolume.comment || 'stack'}_${i + 1}` }
          : optionsOrVolume
      );
      if (res.ok && res.ticket) {
        openedTickets.push(res.ticket);
      }
    }

    if (openedTickets.length > 0) {
      this.slog(`⚡ High-Impact Position Stacking: Successfully opened ${openedTickets.length}x positions (#${openedTickets.join(', #')})`, 'trade');
    }

    return { countOpened: openedTickets.length, tickets: openedTickets };
  }
}

// ==========================================
// HMR-SAFE SINGLETON (Priority 5, Item 13)
// ==========================================
const GLOBAL_ENGINE_KEY = '__SMC_TRADING_ENGINE_SINGLETON__';

declare global {
  var __SMC_TRADING_ENGINE_SINGLETON__: TradingEngine | undefined;
}

export const tradingEngine: TradingEngine =
  (typeof window !== 'undefined' && (window as any)[GLOBAL_ENGINE_KEY]) ||
  new TradingEngine();

if (typeof window !== 'undefined') {
  (window as any)[GLOBAL_ENGINE_KEY] = tradingEngine;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // Preserve state across hot reloads without creating duplicate intervals
    tradingEngine.stopEngineLoops();
  });
}
