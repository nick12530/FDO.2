import type { Candle, EconomicEvent, InstrumentType, Signal, SymbolTradingSpec } from '../types/smc';
import type { HistoricalCandle, HistoricalTick } from './mt5Bridge';
import { analyzeInstrumentCandidates, isPrecisionExecutionReady } from './multiPairScanner';
import { getGlobalSessionStatus } from './sessionTimezones';
import { getInstrumentConfig, type SupportedSymbol } from './instrumentConfig';
import { evaluateTechnicalStrategies } from './technicalStrategies';

const TIMEFRAME_MS: Record<Signal['timeframe'], number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
};
const MIN_RESOLVED_SAMPLES = 20;
const MIN_OUT_OF_SAMPLE_RESOLVED_SAMPLES = 5;
export const HISTORICAL_REPLAY_POLICY_VERSION = 2;
const MAX_CONTIGUOUS_TICK_GAP_MS = 60_000;

export interface ReplayTickCoverage {
  tickCount: number;
  firstTickMs: number | null;
  lastTickMs: number | null;
  largestGapMs: number | null;
  gapsOver60Seconds: number;
}

export interface ReplayCandidate extends Signal {
  id: string;
  symbol: SupportedSymbol;
}

export interface SmcReplayDiscovery {
  candidates: ReplayCandidate[];
  rejectedForUnavailableNews: number;
  otherRejected: number;
  unavailableReason?: string;
}

export interface ReplayFill {
  signalId: string;
  symbol: SupportedSymbol;
  strategy: string;
  timeframe: Signal['timeframe'];
  direction: Signal['direction'];
  score: number;
  scoringPolicyVersion: number;
  reasons: string[];
  session: string;
  discoveredAt: number;
  submittedAt: number;
  executionMode: 'MARKET' | 'PULLBACK_LIMIT';
  entryAt: number | null;
  entryPrice: number | null;
  exitAt: number | null;
  exitPrice: number | null;
  outcome: 'TARGET' | 'STOP' | 'UNRESOLVED' | 'UNFILLED' | 'INVALID';
  grossR: number | null;
  mfeR: number | null;
  maeR: number | null;
}

export interface ReplayMetrics {
  signalCount: number;
  filledCount: number;
  fillRate: number | null;
  resolvedCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  unresolvedCount: number;
  unfilledCount: number;
  invalidCount: number;
  grossExpectancyR: number | null;
  netExpectancyR: number | null;
  grossProfitFactor: number | null;
  netProfitFactor: number | null;
  grossMaxDrawdownR: number | null;
  netMaxDrawdownR: number | null;
  averageMfeR: number | null;
  averageMaeR: number | null;
  transactionCostsKnown: boolean;
}

export interface HistoricalReplayResult {
  source: 'MetaTrader5';
  replayPolicyVersion: number;
  fills: ReplayFill[];
  metrics: ReplayMetrics;
  outOfSample: {
    cutoffTime: number | null;
    training: ReplayMetrics;
    testing: ReplayMetrics;
  };
  groups: {
    symbol: Record<string, ReplayMetrics>;
    session: Record<string, ReplayMetrics>;
    timeframe: Record<string, ReplayMetrics>;
    strategy: Record<string, ReplayMetrics>;
    scoreRange: Record<string, ReplayMetrics>;
  };
  tickCoverage: ReplayTickCoverage;
  unavailableReasons: string[];
}

function toCandle(candle: HistoricalCandle): Candle {
  return {
    time: candle.openTime,
    timeStr: new Date(candle.openTime * 1000).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.tickVolume,
  };
}

export function discoverTechnicalReplaySignals(
  symbol: SupportedSymbol,
  market: Record<'M1' | 'M5' | 'M15' | 'H1', HistoricalCandle[]>,
  options: {
    instrumentType?: InstrumentType;
    tickSize?: number;
    digits?: number;
    minimumScore?: number;
  } = {}
): ReplayCandidate[] {
  const config = getInstrumentConfig(symbol);
  const frames = {
    M1: market.M1.map(toCandle),
    M5: market.M5.map(toCandle),
    M15: market.M15.map(toCandle),
    H1: market.H1.map(toCandle),
  };
  const candidates = new Map<string, ReplayCandidate>();
  const pairs: Array<{
    timeframe: Signal['timeframe'];
    execution: Candle[];
    higher: Candle[];
  }> = [
    { timeframe: 'M1', execution: frames.M1, higher: frames.M5 },
    { timeframe: 'M5', execution: frames.M5, higher: frames.M15 },
    { timeframe: 'M15', execution: frames.M15, higher: frames.H1 },
  ];

  for (const pair of pairs) {
    const intervalMs = TIMEFRAME_MS[pair.timeframe];
    let higherIndex = 0;
    for (let executionIndex = 0; executionIndex < pair.execution.length; executionIndex += 1) {
      const executionBar = pair.execution[executionIndex];
      const decisionTime = executionBar.time * 1000 + intervalMs;
      const execution = pair.execution
        .slice(0, executionIndex + 1)
        .slice(-100);
      const higherInterval = pair.timeframe === 'M1' ? TIMEFRAME_MS.M5
        : pair.timeframe === 'M5' ? TIMEFRAME_MS.M15
          : 60 * 60_000;
      while (
        higherIndex < pair.higher.length &&
        pair.higher[higherIndex].time * 1000 + higherInterval <= decisionTime
      ) higherIndex += 1;
      const higher = pair.higher.slice(Math.max(0, higherIndex - 100), higherIndex);
      const signals = evaluateTechnicalStrategies(
        execution,
        higher,
        pair.timeframe,
        options.instrumentType ?? 'standard',
        options.digits ?? config.digits,
        options.tickSize,
        symbol,
        decisionTime
      );
      for (const signal of signals) {
        if (signal.score < (options.minimumScore ?? 0)) continue;
        const id = [
          symbol,
          signal.timeframe,
          signal.strategy ?? 'unknown',
          signal.direction,
          signal.sourceCandleOpenTime,
        ].join(':');
        candidates.set(id, { ...signal, id, symbol });
      }
    }
  }
  return Array.from(candidates.values()).sort(
    (a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt)
  );
}

export function discoverSmcReplaySignals(
  symbol: SupportedSymbol,
  market: Record<'M1' | 'M5' | 'M15' | 'H1', HistoricalCandle[]>,
  historicalTicks: HistoricalTick[],
  options: {
    symbolSpec?: SymbolTradingSpec | null;
    historicalEvents?: EconomicEvent[] | null;
  } = {}
): SmcReplayDiscovery {
  if (options.historicalEvents === null || options.historicalEvents === undefined) {
    return {
      candidates: [],
      rejectedForUnavailableNews: 0,
      otherRejected: 0,
      unavailableReason: 'Historical SMC, liquidity-reversal, and news-dependent signals are unavailable because archived historical news was not supplied.',
    };
  }
  const config = getInstrumentConfig(symbol);
  const frames = {
    M1: market.M1.map(toCandle),
    M5: market.M5.map(toCandle),
    M15: market.M15.map(toCandle),
    H1: market.H1.map(toCandle),
  };
  const ticks = historicalTicks.filter(isValidQuote).sort((a, b) => a.timeMs - b.timeMs);
  const unique = new Map<string, ReplayCandidate>();
  const cursors = { M1: 0, M5: 0, M15: 0, H1: 0 };
  const intervals = { M1: TIMEFRAME_MS.M1, M5: TIMEFRAME_MS.M5, M15: TIMEFRAME_MS.M15, H1: 60 * 60_000 };
  let tickCursor = 0;
  let rejectedForUnavailableNews = 0;
  let otherRejected = 0;
  for (const bar of frames.M1) {
    const decisionTime = bar.time * 1000 + TIMEFRAME_MS.M1;
    for (const timeframe of ['M1', 'M5', 'M15', 'H1'] as const) {
      while (
        cursors[timeframe] < frames[timeframe].length &&
        frames[timeframe][cursors[timeframe]].time * 1000 + intervals[timeframe] <= decisionTime
      ) cursors[timeframe] += 1;
    }
    if (cursors.M1 < 20 || cursors.M15 < 20 || cursors.H1 < 20) continue;
    while (tickCursor < ticks.length && ticks[tickCursor].timeMs < decisionTime) tickCursor += 1;
    const quote = ticks[tickCursor];
    if (!quote || !isValidQuote(quote) || !options.symbolSpec?.point || options.symbolSpec.point <= 0) continue;

    const closed = <T extends Candle>(candles: T[], count: number) =>
      candles.slice(Math.max(0, count - 100), count);
    const analyses = analyzeInstrumentCandidates(
      symbol,
      closed(frames.M1, cursors.M1),
      closed(frames.M5, cursors.M5),
      closed(frames.M15, cursors.M15),
      closed(frames.H1, cursors.H1),
      quote.bid!,
      quote.ask!,
      (quote.ask! - quote.bid!) / options.symbolSpec.point,
      0,
      0,
      [],
      null,
      null,
      {
        mode: 'replay',
        nowMs: quote.timeMs,
        historicalEvents: options.historicalEvents,
        sendAlerts: false,
        skipAccountSizing: true,
      }
    );
    for (const analysis of analyses) {
      if (!analysis.signal) continue;
      if (analysis.newsStatus === 'NEWS FILTER: DATA UNAVAILABLE') {
        rejectedForUnavailableNews += 1;
        continue;
      }
      if (
        analysis.status !== 'READY' ||
        !isPrecisionExecutionReady(analysis, 'PULLBACK_LIMIT', quote.timeMs)
      ) {
        otherRejected += 1;
        continue;
      }
      const id = [
        symbol,
        analysis.signal.timeframe,
        analysis.signal.strategy ?? 'SMC POI Retest',
        analysis.signal.direction,
        analysis.signal.sourceCandleOpenTime,
      ].join(':');
      unique.set(id, { ...analysis.signal, id, symbol });
    }
  }
  return {
    candidates: Array.from(unique.values()).sort(
      (a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt)
    ),
    rejectedForUnavailableNews,
    otherRejected,
  };
}

function isValidQuote(tick: HistoricalTick): boolean {
  return Number.isFinite(tick.timeMs) &&
    typeof tick.bid === 'number' &&
    typeof tick.ask === 'number' &&
    tick.bid > 0 &&
    tick.ask >= tick.bid;
}

function discoveryTime(signal: ReplayCandidate): number {
  const availableAt = Date.parse(signal.availableAt || signal.generatedAt);
  return Math.max(
    Number.isFinite(availableAt) ? availableAt : 0,
    signal.sourceCandleCloseTime
  );
}

function lowerBoundTick(ticks: HistoricalTick[], timeMs: number): number {
  let low = 0;
  let high = ticks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ticks[middle].timeMs < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function replayOne(
  signal: ReplayCandidate,
  ticks: HistoricalTick[]
): ReplayFill {
  const discoveredAt = discoveryTime(signal);
  const expiry = signal.expiryTimestamp ?? discoveredAt + TIMEFRAME_MS[signal.timeframe];
  const session = getGlobalSessionStatus(new Date(discoveredAt)).activeSessionName;
  const base = {
    signalId: signal.id,
    symbol: signal.symbol,
    strategy: signal.strategy ?? 'Unspecified',
    timeframe: signal.timeframe,
    direction: signal.direction,
    score: signal.score,
    scoringPolicyVersion: signal.scoringPolicyVersion,
    reasons: [...signal.reasons],
    session,
    discoveredAt,
    submittedAt: discoveredAt,
    executionMode: signal.executionMode ?? 'MARKET',
  };
  if (
    !Number.isFinite(signal.entry) ||
    !Number.isFinite(signal.sl) ||
    !Number.isFinite(signal.tp) ||
    (signal.direction === 'BUY'
      ? !(signal.sl < signal.entry && signal.entry < signal.tp)
      : !(signal.tp < signal.entry && signal.entry < signal.sl))
  ) {
    return {
      ...base, entryAt: null, entryPrice: null, exitAt: null, exitPrice: null,
      outcome: 'INVALID', grossR: null, mfeR: null, maeR: null,
    };
  }

  let entryIndex = -1;
  let entryAt = 0;
  let entryPrice = 0;
  const isLimit = signal.executionMode === 'PULLBACK_LIMIT';
  const limitPrice = signal.optimalTradeEntry ?? signal.entry;
  for (let index = lowerBoundTick(ticks, discoveredAt); index < ticks.length; index += 1) {
    const tick = ticks[index];
    if (tick.timeMs > expiry) break;
    const executablePrice = signal.direction === 'BUY' ? tick.ask! : tick.bid!;
    if (isLimit) {
      const touched = signal.direction === 'BUY'
        ? tick.ask! <= limitPrice
        : tick.bid! >= limitPrice;
      if (!touched) continue;
      entryPrice = limitPrice;
    } else {
      entryPrice = executablePrice;
    }
    entryAt = tick.timeMs;
    entryIndex = index;
    break;
  }
  if (entryIndex < 0) {
    return {
      ...base, entryAt: null, entryPrice: null, exitAt: null, exitPrice: null,
      outcome: 'UNFILLED', grossR: null, mfeR: null, maeR: null,
    };
  }
  if (entryAt - discoveredAt > MAX_CONTIGUOUS_TICK_GAP_MS) {
    return {
      ...base, entryAt: null, entryPrice: null, exitAt: null, exitPrice: null,
      outcome: 'UNRESOLVED', grossR: null, mfeR: null, maeR: null,
    };
  }
  if (
    signal.direction === 'BUY'
      ? !(signal.sl < entryPrice && entryPrice < signal.tp)
      : !(signal.tp < entryPrice && entryPrice < signal.sl)
  ) {
    return {
      ...base, entryAt, entryPrice, exitAt: null, exitPrice: null,
      outcome: 'INVALID', grossR: null, mfeR: null, maeR: null,
    };
  }

  const risk = Math.abs(entryPrice - signal.sl);
  if (!Number.isFinite(risk) || risk <= 0) {
    return {
      ...base, entryAt, entryPrice, exitAt: null, exitPrice: null,
      outcome: 'INVALID', grossR: null, mfeR: null, maeR: null,
    };
  }
  let mfe = 0;
  let mae = 0;
  const evaluateTick = (tick: HistoricalTick) => {
    const exitSide = signal.direction === 'BUY' ? tick.bid! : tick.ask!;
    const favorable = signal.direction === 'BUY' ? exitSide - entryPrice : entryPrice - exitSide;
    const stopHit = signal.direction === 'BUY'
      ? tick.bid! <= signal.sl
      : tick.ask! >= signal.sl;
    const targetHit = signal.direction === 'BUY'
      ? tick.bid! >= signal.tp
      : tick.ask! <= signal.tp;
    return { exitSide, stopHit, targetHit, favorableR: favorable / risk };
  };
  const evaluateQuoteGroup = (group: HistoricalTick[]) => {
    const observations = group.filter(isValidQuote).map(evaluateTick);
    const stopResults = observations.filter((item) => item.stopHit);
    const targetResults = observations.filter((item) => item.targetHit);
    if (stopResults.length > 0 && targetResults.length > 0) return { ambiguous: true as const };

    const firstExitIndex = observations.findIndex((item) => item.stopHit || item.targetHit);
    const measured = firstExitIndex >= 0 ? observations.slice(0, firstExitIndex + 1) : observations;
    for (const item of measured) {
      mfe = Math.max(mfe, item.favorableR);
      mae = Math.max(mae, -item.favorableR);
    }
    return {
      ambiguous: false as const,
      exit: firstExitIndex >= 0 ? observations[firstExitIndex] : null,
    };
  };
  let entryGroupEnd = entryIndex + 1;
  while (entryGroupEnd < ticks.length && ticks[entryGroupEnd].timeMs === entryAt) entryGroupEnd += 1;
  const entryGroupResult = evaluateQuoteGroup(ticks.slice(entryIndex, entryGroupEnd));
  if (entryGroupResult.ambiguous) {
    return {
      ...base, entryAt, entryPrice, exitAt: null, exitPrice: null,
      outcome: 'UNRESOLVED', grossR: null, mfeR: null, maeR: null,
    };
  }
  if (entryGroupResult.exit) {
    const { exitSide, stopHit } = entryGroupResult.exit;
    const grossR = (signal.direction === 'BUY'
      ? exitSide - entryPrice
      : entryPrice - exitSide) / risk;
    return {
      ...base,
      entryAt,
      entryPrice,
      exitAt: entryAt,
      exitPrice: exitSide,
      outcome: stopHit ? 'STOP' : 'TARGET',
      grossR,
      mfeR: mfe,
      maeR: mae,
    };
  }
  for (let index = entryGroupEnd; index < ticks.length;) {
    const timeMs = ticks[index].timeMs;
    if (timeMs - ticks[index - 1].timeMs > MAX_CONTIGUOUS_TICK_GAP_MS) {
      return {
        ...base, entryAt, entryPrice, exitAt: null, exitPrice: null,
        outcome: 'UNRESOLVED', grossR: null, mfeR: mfe, maeR: mae,
      };
    }
    let groupEnd = index + 1;
    while (groupEnd < ticks.length && ticks[groupEnd].timeMs === timeMs) groupEnd += 1;
    const groupResult = evaluateQuoteGroup(ticks.slice(index, groupEnd));
    if (groupResult.ambiguous) {
      return {
        ...base, entryAt, entryPrice, exitAt: null, exitPrice: null,
        outcome: 'UNRESOLVED', grossR: null, mfeR: null, maeR: null,
      };
    }
    if (groupResult.exit) {
      const { exitSide, stopHit } = groupResult.exit;
      const exitPrice = exitSide;
      const grossR = (signal.direction === 'BUY'
        ? exitPrice - entryPrice
        : entryPrice - exitPrice) / risk;
      return {
        ...base,
        entryAt,
        entryPrice,
        exitAt: timeMs,
        exitPrice,
        outcome: stopHit ? 'STOP' : 'TARGET',
        grossR,
        mfeR: mfe,
        maeR: mae,
      };
    }
    index = groupEnd;
  }
  return {
    ...base, entryAt, entryPrice, exitAt: null, exitPrice: null,
    outcome: 'UNRESOLVED', grossR: null, mfeR: mfe, maeR: mae,
  };
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function summarizeReplayFills(
  fills: ReplayFill[],
  roundTurnCostR: number | null = null,
  slippageR: number | null = null
): ReplayMetrics {
  const resolved = fills.filter((fill) => fill.grossR !== null);
  const grossValues = resolved.map((fill) => fill.grossR!);
  const costsKnown =
    Number.isFinite(roundTurnCostR) &&
    roundTurnCostR! >= 0 &&
    Number.isFinite(slippageR) &&
    slippageR! >= 0;
  const totalNonSpreadCostR = costsKnown ? roundTurnCostR! + slippageR! : 0;
  const netValues = costsKnown ? grossValues.map((value) => value - totalNonSpreadCostR) : [];
  const winners = grossValues.filter((value) => value > 0).length;
  const grossWins = grossValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLosses = Math.abs(grossValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const netWins = netValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const netLosses = Math.abs(netValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  let grossPeak = 0;
  let grossEquity = 0;
  let grossDrawdown = 0;
  let netPeak = 0;
  let netEquity = 0;
  let netDrawdown = 0;
  for (const value of grossValues) {
    grossEquity += value;
    grossPeak = Math.max(grossPeak, grossEquity);
    grossDrawdown = Math.max(grossDrawdown, grossPeak - grossEquity);
  }
  for (const value of netValues) {
    netEquity += value;
    netPeak = Math.max(netPeak, netEquity);
    netDrawdown = Math.max(netDrawdown, netPeak - netEquity);
  }
  return {
    signalCount: fills.length,
    filledCount: fills.filter((fill) => fill.entryAt !== null).length,
    fillRate: fills.length
      ? fills.filter((fill) => fill.entryAt !== null).length / fills.length
      : null,
    resolvedCount: resolved.length,
    wins: winners,
    losses: grossValues.filter((value) => value < 0).length,
    breakevens: grossValues.filter((value) => value === 0).length,
    winRate: resolved.length ? winners / resolved.length : null,
    unresolvedCount: fills.filter((fill) => fill.outcome === 'UNRESOLVED').length,
    unfilledCount: fills.filter((fill) => fill.outcome === 'UNFILLED').length,
    invalidCount: fills.filter((fill) => fill.outcome === 'INVALID').length,
    grossExpectancyR: mean(grossValues),
    netExpectancyR: costsKnown ? mean(netValues) : null,
    grossProfitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : null,
    netProfitFactor: costsKnown
      ? netLosses > 0 ? netWins / netLosses : netWins > 0 ? Infinity : null
      : null,
    grossMaxDrawdownR: grossValues.length ? grossDrawdown : null,
    netMaxDrawdownR: costsKnown && netValues.length ? netDrawdown : null,
    averageMfeR: mean(resolved.map((fill) => fill.mfeR).filter((value): value is number => value !== null)),
    averageMaeR: mean(resolved.map((fill) => fill.maeR).filter((value): value is number => value !== null)),
    transactionCostsKnown: costsKnown,
  };
}

function groupMetrics(
  fills: ReplayFill[],
  key: (fill: ReplayFill) => string,
  roundTurnCostR: number | null,
  slippageR: number | null
): Record<string, ReplayMetrics> {
  const groups = new Map<string, ReplayFill[]>();
  for (const fill of fills) {
    const value = key(fill);
    groups.set(value, [...(groups.get(value) ?? []), fill]);
  }
  return Object.fromEntries(
    Array.from(groups, ([name, rows]) => [
      name,
      summarizeReplayFills(rows, roundTurnCostR, slippageR),
    ])
  );
}

export function replayHistoricalSignals(
  signals: ReplayCandidate[],
  historicalTicks: HistoricalTick[],
  options: {
    roundTurnCostR?: number;
    slippageR?: number;
    ticksAvailable?: boolean;
  } = {}
): HistoricalReplayResult {
  const ticks = historicalTicks.filter(isValidQuote).sort((a, b) => a.timeMs - b.timeMs);
  const fills = signals.map((signal) => replayOne(signal, ticks));
  let largestGapMs: number | null = null;
  let gapsOver60Seconds = 0;
  for (let index = 1; index < ticks.length; index += 1) {
    const gap = ticks[index].timeMs - ticks[index - 1].timeMs;
    largestGapMs = largestGapMs === null ? gap : Math.max(largestGapMs, gap);
    if (gap > MAX_CONTIGUOUS_TICK_GAP_MS) gapsOver60Seconds += 1;
  }
  const sortedSignals = [...signals].sort(
    (a, b) => discoveryTime(a) - discoveryTime(b)
  );
  const cutoffIndex = Math.floor(sortedSignals.length * 0.7);
  const cutoffTime = sortedSignals[cutoffIndex]?.availableAt
    ? Date.parse(sortedSignals[cutoffIndex].availableAt)
    : null;
  const training = fills.filter(
    (fill) =>
      cutoffTime !== null &&
      fill.discoveredAt < cutoffTime &&
      (fill.exitAt === null || fill.exitAt < cutoffTime)
  );
  const testing = fills.filter((fill) => cutoffTime !== null && fill.discoveredAt >= cutoffTime);
  const roundTurnCostR = options.roundTurnCostR ?? null;
  const slippageR = options.slippageR ?? null;
  const resultMetrics = summarizeReplayFills(fills, roundTurnCostR, slippageR);
  const unavailableReasons: string[] = [];
  if (!options.ticksAvailable || ticks.length === 0) {
    unavailableReasons.push('Genuine bid/ask tick history is unavailable; fills and performance are not established.');
  }
  if (gapsOver60Seconds > 0) {
    unavailableReasons.push(
      `${gapsOver60Seconds} tick-data gaps exceeded 60 seconds; any replay position crossing such a gap is unresolved.`
    );
  }
  if (!Number.isFinite(roundTurnCostR) || roundTurnCostR! < 0) {
    unavailableReasons.push('Broker round-turn commission schedule was not provided; net expectancy, profit factor, and net drawdown are unavailable.');
  }
  if (!Number.isFinite(slippageR) || slippageR! < 0) {
    unavailableReasons.push('A slippage estimate was not provided; net performance is unavailable.');
  }
  if (fills.filter((fill) => fill.grossR !== null).length < MIN_RESOLVED_SAMPLES) {
    unavailableReasons.push(`Fewer than ${MIN_RESOLVED_SAMPLES} resolved broker-tick samples; performance is insufficient.`);
  }
  if (testing.filter((fill) => fill.grossR !== null).length < MIN_OUT_OF_SAMPLE_RESOLVED_SAMPLES) {
    unavailableReasons.push(
      `Fewer than ${MIN_OUT_OF_SAMPLE_RESOLVED_SAMPLES} resolved out-of-sample broker-tick samples; test performance is insufficient.`
    );
  }

  return {
    source: 'MetaTrader5',
    replayPolicyVersion: HISTORICAL_REPLAY_POLICY_VERSION,
    fills,
    metrics: resultMetrics,
    outOfSample: {
      cutoffTime,
      training: summarizeReplayFills(training, roundTurnCostR, slippageR),
      testing: summarizeReplayFills(testing, roundTurnCostR, slippageR),
    },
    groups: {
      symbol: groupMetrics(fills, (fill) => fill.symbol, roundTurnCostR, slippageR),
      session: groupMetrics(fills, (fill) => fill.session, roundTurnCostR, slippageR),
      timeframe: groupMetrics(fills, (fill) => fill.timeframe, roundTurnCostR, slippageR),
      strategy: groupMetrics(fills, (fill) => fill.strategy, roundTurnCostR, slippageR),
      scoreRange: groupMetrics(fills, (fill) => {
        const lower = Math.floor(fill.score / 10) * 10;
        return `${lower}-${lower + 9}`;
      }, roundTurnCostR, slippageR),
    },
    tickCoverage: {
      tickCount: ticks.length,
      firstTickMs: ticks[0]?.timeMs ?? null,
      lastTickMs: ticks[ticks.length - 1]?.timeMs ?? null,
      largestGapMs,
      gapsOver60Seconds,
    },
    unavailableReasons,
  };
}
