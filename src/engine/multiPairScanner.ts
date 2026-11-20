/**
 * multiPairScanner.ts - Multi-Pair Market Scanner, Common Confluence Signal Engine & Risk Manager
 * Analyzes XAUUSD, EURUSD, and GBPUSD independently with:
 * - Live price, bid/ask, spread
 * - Multi-timeframe trend (M1, M5, M15, H1)
 * - Swings, BOS, CHoCH, liquidity highs/lows, FVGs, Order Blocks
 * - Premium/Discount (0-100% dealing range)
 * - 0-100 Confluence Score
 * - Small Account ($10) Risk Protection & Lot Sizing
 * - USD Correlation Exposure Safeguards
 * - Trade Opportunity Ranking
 */

import type {
  Candle,
  DealingRange,
  EconomicEvent,
  Position,
  Signal,
  StructureEvent,
  SymbolTradingSpec,
  Swing,
  TradeDirection,
  Zone,
  VolumeMetrics,
  SetupLifecycleStage,
} from '../types/smc';
import { calculateATR, detectFVGs, detectOrderBlocks, MarketStructureEngine } from './smcCore';
import { INSTRUMENTS, SupportedSymbol, getInstrumentConfig } from './instrumentConfig';
import { getGlobalSessionStatus, isSessionPreferredForPair, evaluateNewsRisk } from './sessionTimezones';
import { dispatchApproachingEntryAlert, dispatchSniperAlert } from '../utils/webhookNotifier';
import { analyzeCandlestickPatterns, CandlestickPatternMatch } from './candlestickPatterns';
import { calculateRVOL } from './volumeEngine';
import { evaluateMacroSurpriseConfluence } from './macroSurpriseEngine';
import { newsSentimentEngine } from './newsSentimentEngine';
import { intermarketEngine } from './intermarketEngine';
import { isAdaptiveMicroFloorAllowed } from './riskConfig';
import {
  normalizeRawConfluenceScore,
  SCANNER_RAW_SCORE_MAX,
  SIGNAL_SCORING_POLICY_VERSION,
  capPositiveMacroContribution,
} from './scorePolicy';

export interface LiquidityLevels {
  equalHighs: number[];
  equalLows: number[];
  buySideLiquidity: number | null;
  sellSideLiquidity: number | null;
  recentSweep: 'high' | 'low' | null;
}

export interface PairAnalysis {
  symbol: SupportedSymbol;
  displayName: string;
  price: number;
  bid: number;
  ask: number;
  spreadPoints: number;
  spreadPips: number;
  spreadAcceptable: boolean;

  // Multi-timeframe trends
  m1Trend: 'bullish' | 'bearish' | 'ranging';
  m5Trend: 'bullish' | 'bearish' | 'ranging';
  m15Trend: 'bullish' | 'bearish' | 'ranging';
  h1Trend: 'bullish' | 'bearish' | 'ranging';

  // Market structure
  swings: { high: Swing | null; low: Swing | null };
  lastBOS: StructureEvent | null;
  lastCHoCH: StructureEvent | null;
  liquidity: LiquidityLevels;

  // Zones
  orderBlocks: Zone[];
  fvgs: Zone[];
  dealingRange: DealingRange;
  premiumDiscountPct: number; // 0-100% (0-50 = discount, 50-100 = premium)

  // Technical metrics
  atr: number;
  volatility: 'low' | 'normal' | 'high';
  sessionName: string;
  isPreferredSession: boolean;
  newsStatus: string;
  volumeMetrics?: VolumeMetrics;
  macroBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sentimentBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sentimentScore?: number;

  // Signal & Score
  bias: 'BUY' | 'SELL' | 'WAITING';
  signal: Signal | null;
  rawConfluenceScore: number;
  confluenceScore: number; // 0 to 100
  scoringPolicyVersion: number;
  scoreBreakdown: {
    htfAlignment: number;      // max 20
    structureConfirm: number;  // max 16
    liquiditySweep: number;    // max 15
    bosChoch: number;          // max 5 (reduced overlap with structure confirmation)
    obFvgReaction: number;     // max 10
    momentumConfirm: number;   // max 8
    sessionConfirm: number;    // max 5
    spreadAcceptable: number;  // max 5
    candleConfirm?: number;    // max 3 (reduced overlap with displacement)
    volumeConfirm?: number;    // max 10
    macroConfirm?: number;     // max 10
  };
  candlestickPattern?: CandlestickPatternMatch;

  // Execution Readiness & Risk Sizing
  entryPrice: number;
  suggestedSL: number;
  suggestedTP: number;
  suggestedTP1?: number;
  suggestedTP2?: number;
  suggestedTP3?: number;
  slPips?: number;
  targetPips1?: number;
  targetPips2?: number;
  targetPips3?: number;
  targetPips?: number;
  expiryTimestamp?: number;
  validitySeconds?: number;
  isSniper?: boolean;
  sniperQualityIndex?: number;
  sniperGrade?: 'A+' | 'A' | 'B';
  optimalTradeEntry?: number;
  riskRewardRatio: number;
  status: 'READY' | 'WAITING' | 'BLOCKED';
  rejectionReason: string | null;
  safeLotSize: number | null;
  estimatedRiskUsd: number | null;
  symbolSpec?: SymbolTradingSpec;
  rank: number;
  spreadAdjustedRiskRewardRatio?: number;
  entryCandidates?: PairAnalysis[];
  setupLifecycleStage?: SetupLifecycleStage;
  executionTimeframe?: Signal['timeframe'];
}

export interface InstrumentAnalysisContext {
  nowMs?: number;
  mode?: 'live' | 'replay';
  executionTimeframe?: Signal['timeframe'];
  historicalEvents?: EconomicEvent[] | null;
  sendAlerts?: boolean;
  skipAccountSizing?: boolean;
}

export type PrecisionEntryCandidate = Pick<
  PairAnalysis,
  'symbol' | 'price' | 'bid' | 'ask' | 'atr' | 'spreadAcceptable' | 'confluenceScore' | 'scoreBreakdown' |
  'riskRewardRatio' | 'spreadAdjustedRiskRewardRatio' | 'expiryTimestamp' | 'status' | 'signal' |
  'setupLifecycleStage'
>;

export interface TargetPlan {
  tp: number;
  tp1: number;
  tp2: number;
  tp3: number;
}

export function buildTargetPlan(
  direction: TradeDirection,
  entry: number,
  stop: number,
  structuralLevels: number[],
  priceIncrement: number,
  digits: number,
  fallbackMultiples: number[] = [1.2, 2, 3.2]
): TargetPlan {
  const sign = direction === 'BUY' ? 1 : -1;
  const risk = Math.abs(entry - stop);
  const levels = [...new Set(structuralLevels.filter((level) =>
    Number.isFinite(level) && sign * (level - entry) > priceIncrement
  ))].sort((a, b) => sign * (a - b));
  const targets: number[] = [];

  for (let index = 0; index < fallbackMultiples.length; index += 1) {
    let target = levels[index] ?? entry + sign * risk * fallbackMultiples[index];
    const previous = targets[index - 1];
    if (previous !== undefined && sign * (target - previous) <= priceIncrement) {
      target = previous + sign * Math.max(priceIncrement, risk * 0.25);
    }
    targets.push(Number(target.toFixed(digits)));
  }

  return {
    tp: levels.length ? targets[0] : targets[1],
    tp1: targets[0],
    tp2: targets[1],
    tp3: targets[2],
  };
}

export function hasDirectionalMovement(
  candles: Candle[],
  atr: number,
  spreadDistance: number,
  direction: TradeDirection,
  lookback = 3
): boolean {
  if (candles.length <= lookback || !Number.isFinite(atr) || atr <= 0) return false;
  const displacement =
    candles[candles.length - 1].close - candles[candles.length - 1 - lookback].close;
  const threshold = Math.max(atr * 0.2, spreadDistance * 2);
  return direction === 'BUY' ? displacement >= threshold : displacement <= -threshold;
}

function hasDirectionalExecutionCandle(candles: Candle[], atr: number, direction: TradeDirection): boolean {
  const current = candles.at(-1);
  const previous = candles.at(-2);
  if (!current || !previous || !Number.isFinite(atr) || atr <= 0) return false;
  const range = current.high - current.low;
  const body = Math.abs(current.close - current.open);
  if (range <= 0 || body < atr * 0.25) return false;
  return direction === 'BUY'
    ? current.close > current.open && current.close >= previous.high && current.close >= current.low + range * 0.7
    : current.close < current.open && current.close <= previous.low && current.close <= current.high - range * 0.7;
}

export function isPrecisionEntryReady(
  analysis: PrecisionEntryCandidate,
  now = Date.now(),
  minimumConfluenceScore = 88
): boolean {
  if (!isPrecisionSetupReady(analysis, now, minimumConfluenceScore)) return false;
  const executionPrice = getPrecisionEntryPrice(analysis);
  const tolerance = getPrecisionEntryTolerance(analysis);
  const optimalTradeEntry = analysis.signal?.optimalTradeEntry;
  if (executionPrice === null || tolerance === null || !optimalTradeEntry) return false;
  return Math.abs(executionPrice - optimalTradeEntry) <= tolerance;
}

export function isPrecisionSetupReady(
  analysis: PrecisionEntryCandidate,
  now = Date.now(),
  minimumConfluenceScore = 88
): boolean {
  const signal = analysis.signal;
  if (
    !signal ||
    analysis.status !== 'READY' ||
    !analysis.spreadAcceptable ||
    analysis.confluenceScore < minimumConfluenceScore ||
    (minimumConfluenceScore >= 88 && signal.sniperGrade !== 'A+') ||
    !signal.isSniper ||
    (analysis.spreadAdjustedRiskRewardRatio ?? analysis.riskRewardRatio) < getInstrumentConfig(analysis.symbol).minRR ||
    !analysis.expiryTimestamp ||
    analysis.expiryTimestamp <= now ||
    !signal.optimalTradeEntry ||
    analysis.setupLifecycleStage !== 'CONFIRMED'
  ) {
    return false;
  }

  return hasPrecisionEntryConfirmation(analysis);
}

export function isPrecisionExecutionReady(
  analysis: PrecisionEntryCandidate,
  mode: 'MARKET' | 'PULLBACK_LIMIT' = 'MARKET',
  now = Date.now(),
  minimumConfluenceScore = 88
): boolean {
  if (isPrecisionEntryReady(analysis, now, minimumConfluenceScore)) return true;
  const signal = analysis.signal;
  if (
    !signal ||
    (signal.executionMode !== 'PULLBACK_LIMIT' && mode !== 'PULLBACK_LIMIT') ||
    !isPrecisionSetupReady(analysis, now, minimumConfluenceScore)
  ) {
    return false;
  }
  const limitPrice = signal.optimalTradeEntry;
  return signal.direction === 'BUY'
    ? Number.isFinite(limitPrice) && (limitPrice as number) < analysis.ask && (limitPrice as number) > signal.sl
    : Number.isFinite(limitPrice) && (limitPrice as number) > analysis.bid && (limitPrice as number) < signal.sl;
}

export function isPrecisionEntryImminent(analysis: PrecisionEntryCandidate, now = Date.now()): boolean {
  const signal = analysis.signal;
  const executionPrice = getPrecisionEntryPrice(analysis);
  const tolerance = getPrecisionEntryTolerance(analysis);
  if (
    !signal ||
    executionPrice === null ||
    tolerance === null ||
    analysis.status !== 'READY' ||
    !analysis.spreadAcceptable ||
    analysis.confluenceScore < 88 ||
    signal.sniperGrade !== 'A+' ||
    !signal.isSniper ||
    (analysis.spreadAdjustedRiskRewardRatio ?? analysis.riskRewardRatio) < getInstrumentConfig(analysis.symbol).minRR ||
    !analysis.expiryTimestamp ||
    analysis.expiryTimestamp <= now ||
    !signal.optimalTradeEntry ||
    analysis.setupLifecycleStage !== 'CONFIRMED' ||
    !hasPrecisionEntryConfirmation(analysis)
  ) {
    return false;
  }

  const distance = Math.abs(executionPrice - signal.optimalTradeEntry);
  const approachingFromValidSide =
    signal.direction === 'BUY'
      ? executionPrice > signal.optimalTradeEntry
      : executionPrice < signal.optimalTradeEntry;
  return approachingFromValidSide && distance > tolerance && distance <= tolerance * 2;
}

function getPrecisionEntryPrice(analysis: PrecisionEntryCandidate): number | null {
  if (!analysis.signal) return null;
  if (
    !Number.isFinite(analysis.bid) ||
    !Number.isFinite(analysis.ask) ||
    analysis.bid <= 0 ||
    analysis.ask < analysis.bid
  ) {
    return null;
  }
  const price = analysis.signal.direction === 'BUY' ? analysis.ask : analysis.bid;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function getPrecisionEntryTolerance(analysis: PrecisionEntryCandidate): number | null {
  if (!Number.isFinite(analysis.atr) || analysis.atr <= 0) return null;
  return Math.max(analysis.atr * 0.15, getInstrumentConfig(analysis.symbol).pipSize * 2);
}

function hasPrecisionEntryConfirmation(analysis: PrecisionEntryCandidate): boolean {
  const { scoreBreakdown } = analysis;
  const hasLocationConfirmation =
    scoreBreakdown.liquiditySweep >= 10 || scoreBreakdown.obFvgReaction >= 10;
  const hasTriggerConfirmation =
    scoreBreakdown.momentumConfirm >= 8 || (scoreBreakdown.candleConfirm ?? 0) >= 2;

  return (
    scoreBreakdown.structureConfirm >= 12 &&
    hasLocationConfirmation &&
    hasTriggerConfirmation &&
    scoreBreakdown.spreadAcceptable >= 5
  );
}

/**
 * Detects equal highs and equal lows within a small threshold.
 */
export function findLiquidityLevels(candles: Candle[], pipSize: number): LiquidityLevels {
  const priorCandles = candles.slice(-31, -1);
  const highs = priorCandles.map((c) => c.high);
  const lows = priorCandles.map((c) => c.low);
  const threshold = pipSize * 3; // within 3 pips is equal high/low

  const equalHighs: number[] = [];
  const equalLows: number[] = [];

  for (let i = 0; i < highs.length - 1; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[i] - highs[j]) <= threshold) {
        equalHighs.push(Number(((highs[i] + highs[j]) / 2).toFixed(5)));
      }
    }
  }

  for (let i = 0; i < lows.length - 1; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[i] - lows[j]) <= threshold) {
        equalLows.push(Number(((lows[i] + lows[j]) / 2).toFixed(5)));
      }
    }
  }

  const highest = highs.length ? Math.max(...highs) : null;
  const lowest = lows.length ? Math.min(...lows) : null;
  const latest = candles[candles.length - 1];
  let recentSweep: 'high' | 'low' | null = null;

  if (latest && highest !== null && latest.high > highest && latest.close < highest) {
    recentSweep = 'high';
  } else if (latest && lowest !== null && latest.low < lowest && latest.close > lowest) {
    recentSweep = 'low';
  }

  return {
    equalHighs: Array.from(new Set(equalHighs)).slice(-2),
    equalLows: Array.from(new Set(equalLows)).slice(-2),
    buySideLiquidity: highest ?? latest?.high ?? 0,
    sellSideLiquidity: lowest ?? latest?.low ?? 0,
    recentSweep,
  };
}

function detectMultiBarSweep(candles: Candle[], lookbackBars: number = 3): 'high' | 'low' | null {
  if (candles.length < 12) return null;
  const lastIdx = candles.length - 1;
  const latest = candles[lastIdx];
  const maxCheck = Math.min(Math.max(1, lookbackBars), Math.max(1, candles.length - 10));

  for (let offset = 0; offset < maxCheck; offset++) {
    const idx = lastIdx - offset;
    const sweepCandle = candles[idx];
    const prior = candles.slice(Math.max(0, idx - 30), idx);
    if (prior.length === 0) continue;

    const highest = Math.max(...prior.map((c) => c.high));
    const lowest = Math.min(...prior.map((c) => c.low));

    if (sweepCandle.high > highest && latest.close < highest && (offset === 0 || latest.close < latest.open)) {
      return 'high';
    }
    if (sweepCandle.low < lowest && latest.close > lowest && (offset === 0 || latest.close > latest.open)) {
      return 'low';
    }
  }
  return null;
}

function findRecentSweepEvent(
  candles: Candle[],
  lookbackBars: number = 12
): { kind: 'high' | 'low'; bar: number } | null {
  if (candles.length < 12) return null;
  const firstBar = Math.max(10, candles.length - lookbackBars);
  let latestSweep: { kind: 'high' | 'low'; bar: number } | null = null;
  for (let bar = firstBar; bar < candles.length; bar += 1) {
    const candle = candles[bar];
    const prior = candles.slice(Math.max(0, bar - 30), bar);
    if (prior.length < 5) continue;
    const highest = Math.max(...prior.map((item) => item.high));
    const lowest = Math.min(...prior.map((item) => item.low));
    if (candle.high > highest && candle.close < highest) latestSweep = { kind: 'high', bar };
    else if (candle.low < lowest && candle.close > lowest) latestSweep = { kind: 'low', bar };
  }
  return latestSweep;
}

function findDirectionalDisplacementBar(
  candles: Candle[],
  atrValues: number[],
  afterBar: number,
  direction: TradeDirection
): number | null {
  for (let bar = afterBar + 1; bar < candles.length; bar += 1) {
    const candle = candles[bar];
    const previous = candles[bar - 1];
    const atr = atrValues[bar];
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const body = Math.abs(candle.close - candle.open);
    const aligned = direction === 'BUY'
      ? candle.close > candle.open && candle.close > previous.high
      : candle.close < candle.open && candle.close < previous.low;
    if (aligned && body >= atr * 0.6) return bar;
  }
  return null;
}

/**
 * Checks existing positions for cumulative USD exposure.
 * EURUSD BUY = short USD
 * GBPUSD BUY = short USD
 * XAUUSD BUY = short USD
 */
export function checkCorrelationExposure(
  proposedSymbol: SupportedSymbol,
  proposedDirection: TradeDirection,
  openPositions: Position[],
  maxAllowedUsdPositions: number = 5
): { allowed: boolean; reason?: string; currentUsdExposure: number } {
  const getUsdSide = (sym: string, dir: TradeDirection): 'LONG_USD' | 'SHORT_USD' | null => {
    const s = sym.toUpperCase();
    if (s.includes('EURUSD') || s.includes('GBPUSD') || s.includes('XAUUSD')) {
      return dir === 'BUY' ? 'SHORT_USD' : 'LONG_USD';
    }
    // Include legacy USDJPY positions in exposure totals, though it is no longer tradeable here.
    if (s.includes('USDJPY')) return dir === 'BUY' ? 'LONG_USD' : 'SHORT_USD';
    return null;
  };

  const proposedUsdSide = getUsdSide(proposedSymbol, proposedDirection);
  if (!proposedUsdSide) return { allowed: true, currentUsdExposure: 0 };

  let currentSameSideCount = 0;
  for (const pos of openPositions) {
    const posSym = (pos.symbol || pos.comment || '').toUpperCase();
    const isSameInstrument = posSym.includes(proposedSymbol.toUpperCase());
    // Only count cross-pair correlation exposure from distinct instruments unless strict max (<=1)
    if (isSameInstrument && maxAllowedUsdPositions > 1) {
      continue;
    }
    const side = getUsdSide(posSym, pos.type);
    if (side === proposedUsdSide) {
      currentSameSideCount++;
    }
  }

  if (currentSameSideCount >= maxAllowedUsdPositions) {
    return {
      allowed: false,
      currentUsdExposure: currentSameSideCount,
      reason: `TRADE_REJECTED: CORRELATION_LIMIT_EXCEEDED (Already ${currentSameSideCount}x ${proposedUsdSide} positions open across correlated pairs)`,
    };
  }

  return { allowed: true, currentUsdExposure: currentSameSideCount };
}

/**
 * Calculates safe lot size for a small account ($10+).
 * If minimum broker lot exceeds the risk budget, rejects with MINIMUM_LOT_EXCEEDS_RISK.
 */
export function calculateSmallAccountPositionSize(
  equity: number,
  riskPct: number,
  stopDistancePrice: number,
  symbol: SupportedSymbol,
  minLot: number = 0.01,
  lotStep: number = 0.01,
  symbolSpec?: SymbolTradingSpec | null
): { safeVolume: number | null; riskAmount: number | null; rejectionReason?: string } {
  if (
    ![equity, riskPct, stopDistancePrice, minLot, lotStep].every(Number.isFinite) ||
    equity <= 0 ||
    riskPct <= 0 ||
    stopDistancePrice <= 0 ||
    minLot <= 0 ||
    lotStep <= 0
  ) {
    return {
      safeVolume: null,
      riskAmount: null,
      rejectionReason: 'TRADE_REJECTED: INVALID_POSITION_SIZING_INPUT',
    };
  }
  if (!symbolSpec) {
    return {
      safeVolume: null,
      riskAmount: null,
      rejectionReason: 'TRADE_REJECTED: BROKER_SYMBOL_SPEC_UNAVAILABLE',
    };
  }
  const riskBudget = equity * (riskPct / 100);
  if (
    ![
      symbolSpec.tickSize,
      symbolSpec.tickValue,
      symbolSpec.volumeMin,
      symbolSpec.volumeMax,
      symbolSpec.volumeStep,
    ].every(Number.isFinite) ||
    symbolSpec.tickSize <= 0 ||
    symbolSpec.tickValue <= 0 ||
    symbolSpec.volumeMin <= 0 ||
    symbolSpec.volumeMax < symbolSpec.volumeMin ||
    symbolSpec.volumeStep <= 0
  ) {
    return {
      safeVolume: null,
      riskAmount: null,
      rejectionReason: 'TRADE_REJECTED: BROKER_SYMBOL_SPEC_UNAVAILABLE',
    };
  }
  minLot = symbolSpec.volumeMin;
  lotStep = symbolSpec.volumeStep;
  const riskPerStandardLot = (stopDistancePrice / symbolSpec.tickSize) * symbolSpec.tickValue;
  const riskPerMinLot = riskPerStandardLot * minLot;

  if (riskPerMinLot > riskBudget && !isAdaptiveMicroFloorAllowed(equity, riskPerMinLot)) {
    return {
      safeVolume: null,
      riskAmount: riskPerMinLot,
      rejectionReason: `TRADE_REJECTED: MINIMUM_LOT_EXCEEDS_RISK (${minLot}L risks $${riskPerMinLot.toFixed(2)}, budget: $${riskBudget.toFixed(2)})`,
    };
  }

  // Calculate volume
  const rawVolume = riskPerStandardLot > 0 ? riskBudget / riskPerStandardLot : minLot;
  const steps = Math.floor((rawVolume - minLot) / lotStep + 1e-9);
  const precision = Math.min(8, (String(lotStep).split('.')[1] || '').length);
  const finalVolume = Number(
    Math.min(5.0, symbolSpec.volumeMax, minLot + Math.max(0, steps) * lotStep).toFixed(precision)
  );
  if (finalVolume < minLot) {
    return {
      safeVolume: null,
      riskAmount: riskPerMinLot,
      rejectionReason: `TRADE_REJECTED: MINIMUM_LOT_EXCEEDS_RISK (${minLot}L risks $${riskPerMinLot.toFixed(2)}, budget: $${riskBudget.toFixed(2)})`,
    };
  }
  const finalRisk = Number((finalVolume * riskPerStandardLot).toFixed(2));

  return {
    safeVolume: finalVolume,
    riskAmount: finalRisk,
  };
}

export function analyzeInstrumentCandidates(
  symbol: SupportedSymbol,
  candlesM1: Candle[],
  candlesM5: Candle[],
  candlesM15: Candle[],
  candlesH1: Candle[],
  liveBid: number,
  liveAsk: number,
  spreadPoints: number,
  equity: number,
  riskPct: number,
  openPositions: Position[],
  economicEvents: EconomicEvent[] | null = null,
  symbolSpec?: SymbolTradingSpec | null,
  context: InstrumentAnalysisContext = {}
): PairAnalysis[] {
  return (['M1', 'M5', 'M15'] as const).map((executionTimeframe) =>
    analyzeInstrument(
      symbol,
      candlesM1,
      candlesM5,
      candlesM15,
      candlesH1,
      liveBid,
      liveAsk,
      spreadPoints,
      equity,
      riskPct,
      openPositions,
      economicEvents,
      symbolSpec,
      { ...context, executionTimeframe, sendAlerts: false }
    )
  );
}

/**
 * Scans and performs end-to-end multi-pair SMC confluence analysis on an instrument.
 */
export function analyzeInstrument(
  symbol: SupportedSymbol,
  candlesM1: Candle[],
  candlesM5: Candle[],
  candlesM15: Candle[],
  candlesH1: Candle[],
  liveBid: number,
  liveAsk: number,
  spreadPoints: number,
  equity: number,
  riskPct: number,
  openPositions: Position[],
  economicEvents: EconomicEvent[] | null = null,
  symbolSpec?: SymbolTradingSpec | null,
  context: InstrumentAnalysisContext = {}
): PairAnalysis {
  const analysisTime = context.nowMs ?? Date.now();
  const isReplay = context.mode === 'replay';
  const config = getInstrumentConfig(symbol);
  const price = (liveBid + liveAsk) / 2;
  const spreadPips = Number((spreadPoints / (config.pipSize / config.pointSize)).toFixed(1));
  const spreadAcceptable = spreadPoints <= config.maxSpreadPoints;

  // 1. Structure engines
  const msM1 = new MarketStructureEngine(2);
  const msM5 = new MarketStructureEngine(3);
  const msM15 = new MarketStructureEngine(3);
  const msH1 = new MarketStructureEngine(3);

  if (candlesM1.length > 5) msM1.update(candlesM1);
  if (candlesM5.length > 5) msM5.update(candlesM5);
  if (candlesM15.length > 5) msM15.update(candlesM15);
  if (candlesH1.length > 5) msH1.update(candlesH1);

  const m1Trend = msM1.trend;
  const m5Trend = msM5.trend;
  const m15Trend = msM15.trend;
  const h1Trend = msH1.trend;

  // 2. ATR
  const atrValues = calculateATR(candlesM15.length > 0 ? candlesM15 : candlesM5, config.atrPeriod);
  const atr = atrValues.length > 0 && !isNaN(atrValues[atrValues.length - 1])
    ? atrValues[atrValues.length - 1]
    : config.pipSize * 15;

  const volatility: 'low' | 'normal' | 'high' =
    atr > config.pipSize * 25 ? 'high' : atr < config.pipSize * 8 ? 'low' : 'normal';
  const atrM1 = calculateATR(candlesM1, config.atrPeriod).at(-1) ?? Number.NaN;
  const atrM5 = calculateATR(candlesM5, config.atrPeriod).at(-1) ?? Number.NaN;

  // 3. Liquidity & Zones
  const liquidity = findLiquidityLevels(candlesM15.length > 0 ? candlesM15 : candlesM5, config.pipSize);
  const obs = detectOrderBlocks(candlesM15, atrValues).filter((z) => !z.filled).slice(-3);
  const fvgs = detectFVGs(candlesM15, atrValues).filter((z) => !z.filled).slice(-3);

  // 4. Dealing Range & Premium/Discount
  const dr = msM15.dealingRange() || msH1.dealingRange() || {
    low: price - atr * 2,
    high: price + atr * 2,
    equilibrium: price,
  };

  const rangeSpan = Math.max(0.00001, dr.high - dr.low);
  const premiumDiscountPct = Math.min(100, Math.max(0, Math.round(((price - dr.low) / rangeSpan) * 100)));

  // 5. Session Status
  const sessions = getGlobalSessionStatus(new Date(analysisTime));
  const isPreferredSession = isSessionPreferredForPair(symbol, sessions);

  // 6. News Risk
  const eventsForAnalysis = isReplay
    ? context.historicalEvents?.map((event) => ({
        ...event,
        minutesRemaining: (Date.parse(event.time) - analysisTime) / 60_000,
      })) ?? null
    : economicEvents;
  const newsRisk = evaluateNewsRisk(symbol, eventsForAnalysis);

  // 7. Structural events
  const lastBOS = msM15.events.filter((e) => e.kind === 'BOS').slice(-1)[0] || null;
  const lastCHoCH = msM15.events.filter((e) => e.kind === 'CHoCH').slice(-1)[0] || null;

  // 8. CONFLUENCE SCORING (0 to 100)
  let scoreHtf = 0;
  let scoreStructure = 0;
  let scoreLiquidity = 0;
  let scoreBosChoch = 0;
  let scoreObFvg = 0;
  let scoreMomentum = 0;
  let scoreSession = 0;
  let scoreSpread = 0;

  let tentativeBias: 'BUY' | 'SELL' | 'WAITING' = 'WAITING';

  // Avoid assigning a trend-following bias when H1 and M15 directly conflict.
  if (h1Trend === m15Trend && h1Trend !== 'ranging') {
    tentativeBias = h1Trend === 'bullish' ? 'BUY' : 'SELL';
  } else if (h1Trend === 'ranging' && m15Trend !== 'ranging') {
    tentativeBias = m15Trend === 'bullish' ? 'BUY' : 'SELL';
  } else if (m15Trend === 'ranging' && h1Trend !== 'ranging') {
    tentativeBias = h1Trend === 'bullish' ? 'BUY' : 'SELL';
  }

  // +20 Higher-timeframe alignment
  if (h1Trend === 'bullish' && m15Trend === 'bullish') {
    scoreHtf = 20;
    tentativeBias = 'BUY';
  } else if (h1Trend === 'bearish' && m15Trend === 'bearish') {
    scoreHtf = 20;
    tentativeBias = 'SELL';
  } else if (h1Trend !== 'ranging' && m15Trend !== 'ranging') {
    scoreHtf = 10;
  }

  const isM15Setup =
    ((tentativeBias === 'BUY' && m15Trend === 'bullish') ||
      (tentativeBias === 'SELL' && m15Trend === 'bearish')) &&
    h1Trend === m15Trend;
  const lastM1Event = msM1.events.at(-1);
  const m1EventAge = lastM1Event ? Math.max(0, candlesM1.length - 1 - lastM1Event.bar) : 999;
  const isM1ScalpSetup =
    !isM15Setup &&
    ((tentativeBias === 'BUY' && m1Trend === 'bullish') ||
      (tentativeBias === 'SELL' && m1Trend === 'bearish')) &&
    m1EventAge <= 6 &&
    spreadAcceptable &&
    spreadPoints <= config.maxSpreadPoints * 0.75;
  const signalTimeframe: Signal['timeframe'] =
    context.executionTimeframe ?? (isM15Setup ? 'M15' : isM1ScalpSetup ? 'M1' : 'M5');
  const executionCandles =
    signalTimeframe === 'M1' ? candlesM1 : signalTimeframe === 'M5' ? candlesM5 : candlesM15;
  const executionStructure =
    signalTimeframe === 'M1' ? msM1 : signalTimeframe === 'M5' ? msM5 : msM15;
  const executionTrend =
    signalTimeframe === 'M1' ? m1Trend : signalTimeframe === 'M5' ? m5Trend : m15Trend;
  const execAtr =
    signalTimeframe === 'M1' && Number.isFinite(atrM1) && atrM1 > 0
      ? atrM1
      : signalTimeframe === 'M5' && Number.isFinite(atrM5) && atrM5 > 0
        ? atrM5
        : atr;
  const executionAtrValues = calculateATR(executionCandles, config.atrPeriod);
  const executionObs = detectOrderBlocks(executionCandles, executionAtrValues)
    .filter((zone) => !zone.filled && zone.born >= executionCandles.length - 20)
    .slice(-6);
  const executionFvgs = detectFVGs(executionCandles, executionAtrValues)
    .filter((zone) => !zone.filled && zone.born >= executionCandles.length - 20)
    .slice(-6);
  const executionLiquidity = findLiquidityLevels(executionCandles, config.pipSize);
  const sweepEvent = findRecentSweepEvent(executionCandles);
  const alignedSweep = sweepEvent &&
    ((tentativeBias === 'BUY' && sweepEvent.kind === 'low') ||
      (tentativeBias === 'SELL' && sweepEvent.kind === 'high'))
    ? sweepEvent
    : null;
  let setupLifecycleStage: SetupLifecycleStage = alignedSweep ? 'SWEEP' : 'NO_SWEEP';
  const displacementBar = alignedSweep
    ? findDirectionalDisplacementBar(
        executionCandles,
        executionAtrValues,
        alignedSweep.bar,
        tentativeBias === 'BUY' ? 'BUY' : 'SELL'
      )
    : null;
  if (displacementBar !== null) setupLifecycleStage = 'DISPLACEMENT';
  const structureEvent = displacementBar === null
    ? null
    : executionStructure.events.find((event) =>
        event.bar >= displacementBar &&
        ((tentativeBias === 'BUY' && event.direction === 'bullish') ||
          (tentativeBias === 'SELL' && event.direction === 'bearish'))
      ) ?? null;
  if (structureEvent) setupLifecycleStage = 'STRUCTURE_BREAK';
  const directionalZones = [...executionFvgs, ...executionObs].filter((zone) =>
    tentativeBias === 'BUY' ? zone.bullish : !zone.bullish
  );
  const poiRetest = structureEvent
    ? directionalZones
        .filter((zone) =>
          zone.born >= structureEvent.bar - 1 &&
          zone.born < executionCandles.length - 1 &&
          !zone.filled
        )
        .map((zone) => ({
          zone,
          retestBar: executionCandles.findIndex((candle, index) =>
            index > zone.born &&
            index > structureEvent.bar &&
            index < executionCandles.length - 1 &&
            candle.low <= zone.top &&
            candle.high >= zone.bottom
          ),
        }))
        .filter(({ zone, retestBar }) =>
          retestBar > structureEvent.bar &&
          price >= zone.bottom - execAtr * 0.15 &&
          price <= zone.top + execAtr * 0.15
        )
        .sort((a, b) => b.zone.born - a.zone.born)[0] ?? null
    : null;
  if (poiRetest) setupLifecycleStage = 'POI_RETEST';
  const hasExecutionConfirmation = Boolean(
    poiRetest &&
    executionCandles.length - 1 > poiRetest.retestBar &&
    hasDirectionalExecutionCandle(
      executionCandles,
      execAtr,
      tentativeBias === 'BUY' ? 'BUY' : 'SELL'
    )
  );
  if (hasExecutionConfirmation) setupLifecycleStage = 'CONFIRMED';

  const hasMovement = tentativeBias !== 'WAITING' && hasDirectionalMovement(
    executionCandles,
    execAtr,
    spreadPoints * config.pointSize,
    tentativeBias
  );

  // +20 Market structure confirmation
  if (
    (tentativeBias === 'BUY' && executionTrend === 'bullish') ||
    (tentativeBias === 'SELL' && executionTrend === 'bearish')
  ) {
    scoreStructure = 16;
  } else if (executionTrend !== 'ranging') {
    scoreStructure = 8;
  }

  // Evaluate liquidity independently on each candidate's execution timeframe.
  const executionMultiSweep = detectMultiBarSweep(executionCandles, 3);
  const effectiveSweep = alignedSweep?.kind ?? executionLiquidity.recentSweep ?? executionMultiSweep;

  if (tentativeBias === 'BUY' && effectiveSweep === 'low') {
    scoreLiquidity = 15;
  } else if (tentativeBias === 'SELL' && effectiveSweep === 'high') {
    scoreLiquidity = 15;
  } else if (
    (tentativeBias === 'BUY' && executionLiquidity.equalLows.length > 0) ||
    (tentativeBias === 'SELL' && executionLiquidity.equalHighs.length > 0)
  ) {
    scoreLiquidity = 5;
  }

  // BOS/CHoCH is related to the structure score, so its independent contribution is capped at 5.
  const lastExecutionEvent = executionStructure.events.at(-1) || null;
  const eventAgeBars = lastExecutionEvent
    ? Math.max(0, executionCandles.length - 1 - lastExecutionEvent.bar)
    : Number.POSITIVE_INFINITY;
  const eventMatchesBias =
    (tentativeBias === 'BUY' && lastExecutionEvent?.direction === 'bullish') ||
    (tentativeBias === 'SELL' && lastExecutionEvent?.direction === 'bearish');
  if (eventMatchesBias && eventAgeBars < 20) {
    scoreBosChoch = Math.round(5 * (1 - eventAgeBars / 20));
  }

  // +10 Order Block / FVG reaction in discount/premium
  const isRelevantZone = (zone: Zone) => price >= zone.bottom && price <= zone.top;
  const matchedObs = executionObs.filter(
    (ob) => (tentativeBias === 'BUY' ? ob.bullish : !ob.bullish) && isRelevantZone(ob)
  );
  const matchedFvgs = executionFvgs.filter(
    (fvg) => (tentativeBias === 'BUY' ? fvg.bullish : !fvg.bullish) && isRelevantZone(fvg)
  );
  const hasMatchingOb = matchedObs.length > 0;
  const hasMatchingFvg = matchedFvgs.length > 0;
  const isPricedRight = tentativeBias === 'BUY' ? premiumDiscountPct <= 55 : premiumDiscountPct >= 45;

  if (tentativeBias !== 'WAITING') {
    if ((hasMatchingOb || hasMatchingFvg) && isPricedRight) {
      scoreObFvg = 10;
    } else if (hasMatchingOb || hasMatchingFvg) {
      scoreObFvg = 5;
    }
  }

  // Momentum overlaps the structure/candle evidence; retain a smaller independent contribution.
  if (
    hasMovement &&
    hasDirectionalExecutionCandle(executionCandles, execAtr, tentativeBias === 'BUY' ? 'BUY' : 'SELL')
  ) {
    scoreMomentum = 8;
  }

  // +5 Session confirmation
  if (isPreferredSession) {
    scoreSession = 5;
  }

  // +5 Acceptable spread
  if (spreadAcceptable && spreadPoints <= config.minSpread * 2) {
    scoreSpread = 5;
  } else if (spreadAcceptable) {
    scoreSpread = 2;
  }

  // +5 heuristic candle-pattern confirmation; it is not a win-probability estimate.
  const candleAnalysis = analyzeCandlestickPatterns(
    executionCandles.length >= 4 ? executionCandles : candlesM15,
    config.pipSize,
    symbol
  );
  const candlePattern = candleAnalysis.activePattern;
  let scoreCandle = 0;
  if (
    candlePattern.type !== 'NEUTRAL_DOJI' &&
    ((tentativeBias === 'BUY' && candlePattern.bias === 'BULLISH') ||
      (tentativeBias === 'SELL' && candlePattern.bias === 'BEARISH')) &&
    candlePattern.reliability >= 60
  ) {
    scoreCandle = Math.round((candlePattern.reliability / 100) * 3);
  }

  // 8b. Broker tick-volume proxy; it does not identify participant type or trade direction.
  const volumeCandles = executionCandles.length >= 6 ? executionCandles : candlesM15;
  const volMetrics = calculateRVOL(volumeCandles, 20, config.digits);
  let scoreVolume = 0;
  if (volMetrics.available) {
    if (volMetrics.rvol >= 2.0) scoreVolume = 10;
    else if (volMetrics.rvol >= 1.4) scoreVolume = 6;
    else if (volMetrics.rvol >= 1.0) scoreVolume = 3;
  }

  // 8c. Macroeconomic Surprise & Headline Sentiment Analysis
  const macroConfluence = tentativeBias !== 'WAITING'
    ? evaluateMacroSurpriseConfluence(symbol, tentativeBias, eventsForAnalysis)
    : { scoreBonus: 0, macroBias: 'NEUTRAL' as const, postNewsDriftActive: false, reasons: [] };

  const sentiment = isReplay
    ? { sentimentBias: 'NEUTRAL' as const, sentimentScore: 0 }
    : newsSentimentEngine.evaluatePairSentiment(symbol);
  let scoreMacro = 0;
  if (macroConfluence.scoreBonus > 0) scoreMacro += 6;
  else if (macroConfluence.scoreBonus < 0) scoreMacro -= 8;

  if (
    (tentativeBias === 'BUY' && sentiment.sentimentBias === 'BULLISH') ||
    (tentativeBias === 'SELL' && sentiment.sentimentBias === 'BEARISH')
  ) {
    scoreMacro += 4;
  }
  scoreMacro = capPositiveMacroContribution(scoreMacro);

  const rawConfluenceScore =
    scoreHtf + scoreStructure + scoreLiquidity + scoreBosChoch + scoreObFvg +
    scoreMomentum + scoreSession + scoreSpread + scoreCandle + scoreVolume + scoreMacro;
  const confluenceScore = normalizeRawConfluenceScore(rawConfluenceScore, SCANNER_RAW_SCORE_MAX);

  const dirMatchObs = executionObs.filter((ob) => tentativeBias === 'BUY' ? ob.bullish : !ob.bullish);
  const dirMatchFvgs = executionFvgs.filter((fvg) => tentativeBias === 'BUY' ? fvg.bullish : !fvg.bullish);
  const nearestPoi = [...matchedFvgs, ...matchedObs, ...dirMatchFvgs, ...dirMatchObs]
    .filter((zone) => Math.abs((zone.top + zone.bottom) / 2 - price) <= execAtr * 2)
    .sort((a, b) => {
      const aRetested = price >= a.bottom && price <= a.top ? 0 : 1;
      const bRetested = price >= b.bottom && price <= b.top ? 0 : 1;
      if (aRetested !== bRetested) return aRetested - bRetested;
      const aAge = executionCandles.length - 1 - a.born;
      const bAge = executionCandles.length - 1 - b.born;
      if (aAge !== bAge) return aAge - bAge;
      const aMidpointBias = a.kind === 'FVG' ? 0 : 1;
      const bMidpointBias = b.kind === 'FVG' ? 0 : 1;
      return aMidpointBias - bMidpointBias;
    })[0];
  const poiAnchorPrice = nearestPoi
    ? nearestPoi.kind === 'FVG'
      ? (nearestPoi.bottom + nearestPoi.top) / 2
      : nearestPoi.bullish
        ? nearestPoi.top
        : nearestPoi.bottom
    : null;
  const swingLow = executionStructure.lastSwingLow?.price || dr.low;
  const swingHigh = executionStructure.lastSwingHigh?.price || dr.high;
  const legSpan = Math.max(config.pipSize * 10, swingHigh - swingLow);
  const oteBuy = swingLow + 0.382 * legSpan;
  const oteSell = swingLow + 0.618 * legSpan;
  const rawOptimalTradeEntry =
    poiAnchorPrice !== null && Math.abs(price - poiAnchorPrice) <= atr * 2
      ? poiAnchorPrice
      : tentativeBias === 'BUY'
        ? oteBuy
        : oteSell;
  const optimalTradeEntry = Number(rawOptimalTradeEntry.toFixed(config.digits));

  // 9. Stop Loss & Multi-Target Take Profit (Timeframe-calibrated for M1/M5 scalping & M15 swings)
  const slBuffer = execAtr * 0.3;
  const slFloorPips = signalTimeframe === 'M1' ? 4 : 5;
  const mult1 = signalTimeframe === 'M1' ? 1.2 : signalTimeframe === 'M5' ? 1.5 : 1.8;
  const mult2 = signalTimeframe === 'M1' ? 2.0 : signalTimeframe === 'M5' ? 2.5 : Math.max(3.2, config.minRR * 1.5);
  const mult3 = signalTimeframe === 'M1' ? 3.2 : signalTimeframe === 'M5' ? 4.0 : Math.max(5.5, config.minRR * 2.8);
  const executionPrice = tentativeBias === 'BUY' ? liveAsk : tentativeBias === 'SELL' ? liveBid : price;
  let suggestedSL = price;
  if (tentativeBias === 'BUY') {
    const swingLowPrice = executionStructure.lastSwingLow?.price || dr.low;
    suggestedSL = Number(Math.min(
      price - execAtr * config.atrSlMultiplier,
      swingLowPrice - slBuffer
    ).toFixed(config.digits));
  } else if (tentativeBias === 'SELL') {
    const swingHighPrice = executionStructure.lastSwingHigh?.price || dr.high;
    suggestedSL = Number(Math.max(
      price + execAtr * config.atrSlMultiplier,
      swingHighPrice + slBuffer
    ).toFixed(config.digits));
  }

  const marketEntryTolerance = Math.max(execAtr * 0.15, config.pipSize * 2);
  const isMarketEntryConfirmed = Math.abs(executionPrice - optimalTradeEntry) <= marketEntryTolerance;
  const hasBrokerValidPullback =
    tentativeBias === 'BUY'
      ? optimalTradeEntry < executionPrice && optimalTradeEntry > suggestedSL
      : tentativeBias === 'SELL'
        ? optimalTradeEntry > executionPrice && optimalTradeEntry < suggestedSL
        : false;
  const plannedEntryPrice = !isMarketEntryConfirmed && hasBrokerValidPullback
    ? optimalTradeEntry
    : executionPrice;
  const stopDistance = Math.abs(plannedEntryPrice - suggestedSL);
  const structuralTargets = tentativeBias === 'BUY'
    ? [
        executionStructure.lastSwingHigh?.price,
        ...executionLiquidity.equalHighs,
        executionLiquidity.buySideLiquidity,
        dr.high,
      ]
    : [
        executionStructure.lastSwingLow?.price,
        ...executionLiquidity.equalLows,
        executionLiquidity.sellSideLiquidity,
        dr.low,
      ];
  const targetPlan = buildTargetPlan(
    tentativeBias === 'BUY' ? 'BUY' : 'SELL',
    plannedEntryPrice,
    suggestedSL,
    structuralTargets.filter((target): target is number => typeof target === 'number'),
    config.pointSize,
    config.digits,
    [mult1, mult2, mult3]
  );
  const suggestedTP = targetPlan.tp;
  const suggestedTP1 = targetPlan.tp1;
  const suggestedTP2 = targetPlan.tp2;
  const suggestedTP3 = targetPlan.tp3;
  const targetDistance = Math.abs(suggestedTP - plannedEntryPrice);
  const riskRewardRatio = Number((targetDistance / Math.max(0.00001, stopDistance)).toFixed(2));
  // Entry uses ask for BUY and bid for SELL; spread is already represented in executable prices.
  const spreadAdjustedRiskRewardRatio = riskRewardRatio;
  const slPips = Number((stopDistance / config.pipSize).toFixed(1));
  const targetPips1 = Number((Math.abs(suggestedTP1 - plannedEntryPrice) / config.pipSize).toFixed(1));
  const targetPips2 = Number((Math.abs(suggestedTP2 - plannedEntryPrice) / config.pipSize).toFixed(1));
  const targetPips3 = Number((Math.abs(suggestedTP3 - plannedEntryPrice) / config.pipSize).toFixed(1));
  const targetPips = Number((targetDistance / config.pipSize).toFixed(1));

  // 10. Position sizing & Correlation checks
  const sizingResult = context.skipAccountSizing
    ? { safeVolume: null, riskAmount: null, rejectionReason: null }
    : calculateSmallAccountPositionSize(
        equity,
        riskPct,
        stopDistance,
        symbol,
        symbolSpec?.volumeMin ?? 0.01,
        symbolSpec?.volumeStep ?? 0.01,
        symbolSpec
      );
  const correlationResult = checkCorrelationExposure(symbol, tentativeBias === 'BUY' ? 'BUY' : 'SELL', openPositions);

  let status: 'READY' | 'WAITING' | 'BLOCKED' = 'WAITING';
  let rejectionReason: string | null = null;
  if (tentativeBias !== 'WAITING' && !hasMovement) {
    rejectionReason = 'WAITING: INSUFFICIENT_DIRECTIONAL_MOVEMENT';
  }

  if (confluenceScore >= config.minScore && tentativeBias !== 'WAITING') {
    if (!hasMovement) {
      status = 'WAITING';
    } else if (!spreadAcceptable) {
      status = 'BLOCKED';
      rejectionReason = `TRADE_REJECTED: SPREAD_TOO_WIDE (${spreadPoints} pts > ${config.maxSpreadPoints} max)`;
    } else if (newsRisk.isDataUnavailable) {
      status = 'BLOCKED';
      rejectionReason = 'TRADE_REJECTED: NEWS_DATA_UNAVAILABLE';
    } else if (newsRisk.hasNewsRisk) {
      status = 'BLOCKED';
      rejectionReason = `TRADE_REJECTED: ${newsRisk.reason}`;
    } else if (!correlationResult.allowed) {
      status = 'BLOCKED';
      rejectionReason = correlationResult.reason || 'TRADE_REJECTED: CORRELATION_LIMIT_EXCEEDED';
    } else if (!context.skipAccountSizing && sizingResult.rejectionReason) {
      status = 'BLOCKED';
      rejectionReason = sizingResult.rejectionReason;
    } else {
      status = 'READY';
    }
  }

  if (status === 'READY' && spreadAdjustedRiskRewardRatio < config.minRR) {
    status = 'BLOCKED';
    rejectionReason =
      `TRADE_REJECTED: SPREAD_ADJUSTED_RR_BELOW_MINIMUM (${spreadAdjustedRiskRewardRatio}:1 < ${config.minRR}:1)`;
  }

  // 11. Expiry and POI-anchored OTE
  const validityDurationMs = signalTimeframe === 'M15' ? 15 * 60_000 : signalTimeframe === 'M5' ? 5 * 60_000 : 90_000;
  const signalCandle = signalTimeframe === 'M15'
    ? candlesM15[candlesM15.length - 1]
    : signalTimeframe === 'M1'
    ? candlesM1[candlesM1.length - 1]
    : candlesM5[candlesM5.length - 1];
  const rawCandleTime = signalCandle?.time ?? analysisTime;
  const signalCandleTime = rawCandleTime < 1_000_000_000_000 ? rawCandleTime * 1000 : rawCandleTime;
  const signalCandleDurationMs =
    signalTimeframe === 'M15' ? 15 * 60_000 : signalTimeframe === 'M5' ? 5 * 60_000 : 60_000;
  const signalGeneratedAt = new Date(analysisTime).toISOString();
  const expiryTimestamp = signalCandleTime + validityDurationMs * 2;
  if (status === 'READY' && expiryTimestamp <= analysisTime) {
    status = 'BLOCKED';
    rejectionReason = 'TRADE_REJECTED: SIGNAL_EXPIRED';
  }
  const validitySeconds = Math.max(0, Math.round((expiryTimestamp - analysisTime) / 1000));
  const isSniper = confluenceScore >= 70 && (scoreLiquidity >= 10 || scoreObFvg >= 5);
  const sniperQualityIndex = confluenceScore;
  const sniperGrade: 'A+' | 'A' | 'B' = confluenceScore >= 88 ? 'A+' : confluenceScore >= 75 ? 'A' : 'B';

  const mitigationType = scoreLiquidity >= 10 ? 'Liquidity Pool Sweep (SFP)' : scoreObFvg >= 5 ? 'Order Block Mitigation' : 'Structural POI Retest';
  const entryDistance = Math.abs(executionPrice - optimalTradeEntry);
  if (status === 'READY' && setupLifecycleStage !== 'CONFIRMED') {
    status = 'WAITING';
    rejectionReason = `WAITING: SETUP_LIFECYCLE_${setupLifecycleStage}`;
  } else if (status === 'READY' && !isMarketEntryConfirmed && !hasBrokerValidPullback) {
    status = 'WAITING';
    rejectionReason = 'WAITING: PULLBACK_PRICE_NOT_BROKER_VALID';
  }

  // 12. Create Signal object if ready
  let signalObj: Signal | null = null;
  if (tentativeBias !== 'WAITING' && hasMovement && confluenceScore >= 50) {
    const reasons: string[] = [];
    if (scoreHtf >= 15) reasons.push(`HTF ${h1Trend.toUpperCase()} Trend Alignment (+${scoreHtf})`);
    if (isM15Setup) reasons.push(`M15 Swing Entry Alignment (+15)`);
    else if (isM1ScalpSetup) reasons.push(`M1 Precision Scalp Displacement (+15)`);
    if (scoreStructure >= 12) reasons.push(`M5 Structure Confirmation (+${scoreStructure})`);
    if (scoreLiquidity >= 10) reasons.push(`Liquidity Pool Sweep (+${scoreLiquidity})`);
    if (scoreBosChoch >= 3) reasons.push(`Recent aligned BOS/CHoCH (+${scoreBosChoch})`);
    if (scoreObFvg >= 5) reasons.push(`Discount/Premium POI Retest (+${scoreObFvg})`);
    if (scoreSession >= 5) reasons.push(`${sessions.activeSessionName} (+${scoreSession})`);
    if (scoreCandle >= 2) reasons.push(`${candlePattern.name} (${candlePattern.bias}) (+${scoreCandle})`);

    signalObj = {
      direction: tentativeBias,
      timeframe: signalTimeframe,
      score: confluenceScore,
      scoringPolicyVersion: SIGNAL_SCORING_POLICY_VERSION,
      generatedAt: signalGeneratedAt,
      availableAt: signalGeneratedAt,
      sourceCandleOpenTime: signalCandleTime,
      sourceCandleCloseTime: signalCandleTime + signalCandleDurationMs,
      entry: Number(plannedEntryPrice.toFixed(config.digits)),
      sl: suggestedSL,
      tp: suggestedTP,
      tp1: suggestedTP1,
      tp2: suggestedTP2,
      tp3: suggestedTP3,
      slPips,
      targetPips1,
      targetPips2,
      targetPips3,
      targetPips,
      expiryTimestamp,
      validitySeconds,
      isSniper,
      sniperQualityIndex,
      sniperGrade,
      optimalTradeEntry,
      executionMode: isMarketEntryConfirmed ? 'MARKET' : 'PULLBACK_LIMIT',
      mitigationType,
      setupLifecycleStage,
      recommendedLot: sizingResult.safeVolume || undefined,
      reasons,
      atr: execAtr,
      timestamp: new Date(Math.min(signalCandleTime, analysisTime)).toISOString(),
      actionReason: `${symbol} ${tentativeBias} (${confluenceScore}/100 Confluence) - 1:${riskRewardRatio} RR · Targets: TP1 (${targetPips1}p), TP2 (${targetPips2}p), TP3 (${targetPips3}p)`,
      perfectEntryReason: `SMC ${signalTimeframe} ${tentativeBias} confluence with ${reasons.slice(0, 2).join(' + ')}`,
      strategy: 'SMC POI Retest',
      candlestickPattern: candlePattern,
      volumeMetrics: volMetrics,
    };

  }

  const analysis: PairAnalysis = {
    symbol,
    displayName: config.displayName,
    price: Number(price.toFixed(config.digits)),
    bid: liveBid,
    ask: liveAsk,
    spreadPoints,
    spreadPips,
    spreadAcceptable,
    m1Trend,
    m5Trend,
    m15Trend,
    h1Trend,
    swings: { high: msM15.lastSwingHigh, low: msM15.lastSwingLow },
    lastBOS,
    lastCHoCH,
    liquidity,
    orderBlocks: executionObs,
    fvgs: executionFvgs,
    dealingRange: dr,
    premiumDiscountPct,
    atr,
    volatility,
    sessionName: sessions.activeSessionName,
    isPreferredSession,
    newsStatus: newsRisk.reason || (newsRisk.isDataUnavailable ? 'NEWS FILTER: DATA UNAVAILABLE' : 'Normal Conditions'),
    volumeMetrics: volMetrics,
    macroBias: macroConfluence.macroBias,
    sentimentBias: sentiment.sentimentBias,
    sentimentScore: sentiment.sentimentScore,
    bias: tentativeBias,
    signal: signalObj,
    rawConfluenceScore,
    confluenceScore,
    scoringPolicyVersion: SIGNAL_SCORING_POLICY_VERSION,
    scoreBreakdown: {
      htfAlignment: scoreHtf,
      structureConfirm: scoreStructure,
      liquiditySweep: scoreLiquidity,
      bosChoch: scoreBosChoch,
      obFvgReaction: scoreObFvg,
      momentumConfirm: scoreMomentum,
      sessionConfirm: scoreSession,
      spreadAcceptable: scoreSpread,
      candleConfirm: scoreCandle,
      volumeConfirm: scoreVolume,
      macroConfirm: scoreMacro,
    },
    candlestickPattern: candlePattern,
    entryPrice: Number(executionPrice.toFixed(config.digits)),
    suggestedSL,
    suggestedTP,
    suggestedTP1,
    suggestedTP2,
    suggestedTP3,
    slPips,
    targetPips1,
    targetPips2,
    targetPips3,
    targetPips,
    expiryTimestamp,
    validitySeconds,
    isSniper,
    sniperQualityIndex,
    sniperGrade,
    optimalTradeEntry,
    riskRewardRatio,
    spreadAdjustedRiskRewardRatio,
    setupLifecycleStage,
    executionTimeframe: signalTimeframe,
    status,
    rejectionReason,
    safeLotSize: sizingResult.safeVolume,
    estimatedRiskUsd: sizingResult.riskAmount,
    symbolSpec: symbolSpec ?? undefined,
    rank: 4, // assigned below in rankOpportunities
  };

  if (
    context.sendAlerts !== false &&
    analysis.signal &&
    (isPrecisionEntryReady(analysis, analysisTime) ||
      (analysis.status === 'READY' && analysis.spreadAcceptable))
  ) {
    void dispatchSniperAlert({
      symbol,
      direction: analysis.signal.direction,
      timeframe: signalTimeframe,
      strategy: analysis.signal.strategy || 'SMC POI Retest',
      entry: Number(price.toFixed(config.digits)),
      sl: suggestedSL,
      tp1: suggestedTP1,
      tp2: suggestedTP2,
      tp3: suggestedTP3,
      slPips,
      tp1Pips: targetPips1,
      tp2Pips: targetPips2,
      tp3Pips: targetPips3,
      confluenceScore,
      recommendedLot: sizingResult.safeVolume || undefined,
      isSniper,
      sniperGrade,
      optimalTradeEntry: optimalTradeEntry || Number(price.toFixed(config.digits)),
      triggerPattern: candlePattern.name !== 'Neutral Price Action' ? candlePattern.name : undefined,
      validUntil: expiryTimestamp,
    });
  }
  if (context.sendAlerts !== false && analysis.signal && isPrecisionEntryImminent(analysis, analysisTime)) {
    void dispatchApproachingEntryAlert({
      symbol,
      direction: analysis.signal.direction,
      timeframe: signalTimeframe,
      entry: Number(price.toFixed(config.digits)),
      optimalTradeEntry,
      sl: suggestedSL,
      tp: suggestedTP,
      confluenceScore,
      validUntil: expiryTimestamp,
    });
  }

  return analysis;
}

/**
 * Ranks opportunities across all 4 instruments (Section 14).
 * Sorts by confluence score, setup quality, RR, session, spread, and exposure.
 */
export function rankOpportunities(analyses: PairAnalysis[]): PairAnalysis[] {
  const sorted = [...analyses].sort((a, b) => {
    if (a.status === 'READY' && b.status !== 'READY') return -1;
    if (b.status === 'READY' && a.status !== 'READY') return 1;

    const aPrecisionReady = isPrecisionEntryReady(a);
    const bPrecisionReady = isPrecisionEntryReady(b);
    if (aPrecisionReady !== bPrecisionReady) return aPrecisionReady ? -1 : 1;

    const structuralQuality = (item: PairAnalysis) =>
      item.scoreBreakdown.structureConfirm +
      item.scoreBreakdown.liquiditySweep +
      item.scoreBreakdown.bosChoch +
      item.scoreBreakdown.obFvgReaction;
    const structuralDifference = structuralQuality(b) - structuralQuality(a);
    if (structuralDifference !== 0) return structuralDifference;

    const entryDistance = (item: PairAnalysis) =>
      item.signal?.optimalTradeEntry && item.atr > 0
        ? Math.abs(item.price - item.signal.optimalTradeEntry) / item.atr
        : Number.POSITIVE_INFINITY;
    const entryDistanceDifference = entryDistance(a) - entryDistance(b);
    if (entryDistanceDifference !== 0) return entryDistanceDifference;

    if (b.spreadAdjustedRiskRewardRatio !== a.spreadAdjustedRiskRewardRatio) {
      return (b.spreadAdjustedRiskRewardRatio ?? 0) - (a.spreadAdjustedRiskRewardRatio ?? 0);
    }

    const spreadLoad = (item: PairAnalysis) =>
      item.atr > 0 ? (item.spreadPoints * getInstrumentConfig(item.symbol).pointSize) / item.atr : Infinity;
    const spreadLoadDifference = spreadLoad(a) - spreadLoad(b);
    if (spreadLoadDifference !== 0) return spreadLoadDifference;

    if (b.confluenceScore !== a.confluenceScore) {
      return b.confluenceScore - a.confluenceScore;
    }

    if (b.riskRewardRatio !== a.riskRewardRatio) {
      return b.riskRewardRatio - a.riskRewardRatio;
    }

    if (a.isPreferredSession && !b.isPreferredSession) return -1;
    if (b.isPreferredSession && !a.isPreferredSession) return 1;

    return a.spreadPoints - b.spreadPoints;
  });

  return sorted.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}
