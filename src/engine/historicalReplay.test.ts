import { describe, expect, it } from 'vitest';
import type { HistoricalTick } from './mt5Bridge';
import type { ReplayCandidate } from './historicalReplay';
import {
  discoverSmcReplaySignals,
  discoverTechnicalReplaySignals,
  replayHistoricalSignals,
} from './historicalReplay';

const signal = (overrides: Partial<ReplayCandidate> = {}): ReplayCandidate => ({
  id: 'EURUSD:M1:breakout:BUY:1000',
  symbol: 'EURUSD',
  strategy: 'Volatility Breakout',
  direction: 'BUY',
  timeframe: 'M1',
  score: 72,
  scoringPolicyVersion: 3,
  generatedAt: new Date(1_060_000).toISOString(),
  availableAt: new Date(1_060_000).toISOString(),
  sourceCandleOpenTime: 1_000,
  sourceCandleCloseTime: 1_060_000,
  entry: 1.1,
  sl: 1.099,
  tp: 1.102,
  expiryTimestamp: 1_500_000,
  reasons: [],
  atr: 0.001,
  timestamp: new Date(1_000_000).toISOString(),
  executionMode: 'MARKET',
  ...overrides,
});

const tick = (timeMs: number, bid: number, ask: number): HistoricalTick => ({
  timeMs,
  bid,
  ask,
  last: null,
  volume: null,
  flags: 6,
});

function historicalBars(
  endTimeSeconds: number,
  count: number,
  intervalSeconds: number,
  breakout = false
) {
  return Array.from({ length: count }, (_, index) => {
    const time = endTimeSeconds - (count - index) * intervalSeconds;
    const isBreakout = breakout && index === count - 1;
    return {
      openTime: time,
      closeTime: time + intervalSeconds,
      open: isBreakout ? 1.1 : 1.1,
      high: isBreakout ? 1.132 : 1.102,
      low: isBreakout ? 1.099 : 1.098,
      close: isBreakout ? 1.13 : 1.1,
      tickVolume: 100,
      spreadPoints: 2,
      realVolume: 0,
    };
  });
}

describe('historical tick replay', () => {
  it('withholds SMC replay when historical news coverage is unavailable', () => {
    const result = discoverSmcReplaySignals('EURUSD', {
      M1: [], M5: [], M15: [], H1: [],
    }, []);

    expect(result.candidates).toEqual([]);
    expect(result.unavailableReason).toMatch(/historical news/i);
  });

  it('does not let later candles change a previously discovered technical signal', () => {
    const endTime = 1_700_000_000 - (1_700_000_000 % 3600);
    const market = {
      M1: historicalBars(endTime, 500, 60, true),
      M5: historicalBars(endTime, 100, 300),
      M15: historicalBars(endTime, 100, 900),
      H1: historicalBars(endTime, 100, 3600),
    };
    const discovered = discoverTechnicalReplaySignals('EURUSD', market).filter(
      (candidate) => candidate.sourceCandleOpenTime === (endTime - 60) * 1000
    );
    const withFuture = {
      M1: [...market.M1, ...historicalBars(endTime + 60, 1, 60)],
      M5: [...market.M5, ...historicalBars(endTime + 300, 1, 300)],
      M15: [...market.M15, ...historicalBars(endTime + 900, 1, 900)],
      H1: [...market.H1, ...historicalBars(endTime + 3600, 1, 3600)],
    };
    const afterFuture = discoverTechnicalReplaySignals('EURUSD', withFuture).filter(
      (candidate) => candidate.sourceCandleOpenTime === (endTime - 60) * 1000
    );

    expect(discovered.length).toBeGreaterThan(0);
    expect(afterFuture).toEqual(discovered);
    expect(discovered.every((candidate) => Date.parse(candidate.availableAt) === endTime * 1000)).toBe(true);
  });

  it('does not fill before discovery and enters on the executable ask', () => {
    const result = replayHistoricalSignals(
      [signal()],
      [
        tick(1_050_000, 1.1000, 1.1002),
        tick(1_060_000, 1.1000, 1.1002),
        tick(1_070_000, 1.1020, 1.1022),
      ],
      { ticksAvailable: true, roundTurnCostR: 0.1, slippageR: 0.02 }
    );

    expect(result.fills[0]).toMatchObject({
      entryAt: 1_060_000,
      entryPrice: 1.1002,
      exitAt: 1_070_000,
      outcome: 'TARGET',
    });
    expect(result.fills[0].grossR).toBeCloseTo(1.5);
    expect(result.fills[0].mfeR).toBeCloseTo(1.5);
    expect(result.fills[0].maeR).toBeCloseTo(1 / 6);
    expect(result.metrics.netExpectancyR).toBeCloseTo(1.38);
    expect(result.metrics.fillRate).toBe(1);
  });

  it('marks trades unresolved across gaps in broker tick coverage', () => {
    const result = replayHistoricalSignals(
      [signal()],
      [
        tick(1_060_000, 1.1, 1.1002),
        tick(1_121_000, 1.102, 1.1022),
      ],
      { ticksAvailable: true }
    );

    expect(result.fills[0].outcome).toBe('UNRESOLVED');
    expect(result.tickCoverage.gapsOver60Seconds).toBe(1);
    expect(result.unavailableReasons.join(' ')).toMatch(/gaps exceeded 60 seconds/i);
  });

  it('keeps protective targets active after the signal entry window expires', () => {
    const result = replayHistoricalSignals(
      [signal({ expiryTimestamp: 1_070_000 })],
      [
        tick(1_060_000, 1.1, 1.1002),
        tick(1_080_000, 1.102, 1.1022),
      ],
      { ticksAvailable: true }
    );

    expect(result.fills[0].outcome).toBe('TARGET');
    expect(result.fills[0].exitAt).toBe(1_080_000);
  });

  it('uses the executable bid for a long stop and leaves net metrics unavailable without costs', () => {
    const result = replayHistoricalSignals(
      [signal()],
      [
        tick(1_060_000, 1.1, 1.1002),
        tick(1_070_000, 1.0988, 1.0990),
      ],
      { ticksAvailable: true }
    );

    expect(result.fills[0].outcome).toBe('STOP');
    expect(result.fills[0].grossR).toBeLessThan(-1);
    expect(result.metrics.netExpectancyR).toBeNull();
    expect(result.metrics.netProfitFactor).toBeNull();
    expect(result.metrics.grossMaxDrawdownR).not.toBeNull();
    expect(result.unavailableReasons).toContain(
      'Broker round-turn commission schedule was not provided; net expectancy, profit factor, and net drawdown are unavailable.'
    );
    expect(result.unavailableReasons).toContain(
      'A slippage estimate was not provided; net performance is unavailable.'
    );
  });

  it('recognizes a protective stop already crossed by the entry quote', () => {
    const result = replayHistoricalSignals(
      [signal()],
      [tick(1_060_000, 1.0989, 1.0991)],
      { ticksAvailable: true }
    );

    expect(result.fills[0]).toMatchObject({
      entryAt: 1_060_000,
      exitAt: 1_060_000,
      outcome: 'STOP',
    });
    expect(result.fills[0].grossR).toBeLessThan(0);
  });

  it('keeps same-millisecond stop and target ticks unresolved', () => {
    const result = replayHistoricalSignals(
      [signal()],
      [
        tick(1_060_000, 1.1, 1.1002),
        tick(1_070_000, 1.102, 1.1022),
        tick(1_070_000, 1.0988, 1.099),
      ],
      { ticksAvailable: true }
    );

    expect(result.fills[0].outcome).toBe('UNRESOLVED');
    expect(result.metrics.resolvedCount).toBe(0);
  });

  it('does not impose an arbitrary order on stop and target ticks during the fill millisecond', () => {
    const result = replayHistoricalSignals(
      [signal()],
      [
        tick(1_060_000, 1.1, 1.1002),
        tick(1_060_000, 1.102, 1.1022),
        tick(1_060_000, 1.0988, 1.099),
      ],
      { ticksAvailable: true }
    );

    expect(result.fills[0].outcome).toBe('UNRESOLVED');
  });

  it('does not invent a fill when genuine ticks are missing', () => {
    const result = replayHistoricalSignals([signal()], [], { ticksAvailable: false });

    expect(result.fills[0].outcome).toBe('UNFILLED');
    expect(result.metrics.resolvedCount).toBe(0);
    expect(result.unavailableReasons[0]).toContain('Genuine bid/ask tick history is unavailable');
  });

  it('compares the unchanged fixed-target baseline with partial and structure-trailing policies', () => {
    const candidate = signal({
      tp3: 1.104,
      structureTrailEvents: [{ confirmedAt: 1_080_000, stopPrice: 1.102 }],
    });
    const result = replayHistoricalSignals(
      [candidate],
      [
        tick(1_060_000, 1.1, 1.1002),
        tick(1_070_000, 1.1019, 1.1021),
        tick(1_080_000, 1.103, 1.1032),
        tick(1_090_000, 1.1019, 1.1021),
      ],
      { ticksAvailable: true, roundTurnCostR: 0.05, slippageR: 0.02 }
    );

    expect(result.exitPolicyComparison.CURRENT_BASELINE.metrics.resolvedCount).toBe(1);
    expect(result.exitPolicyComparison.FIXED_STRUCTURAL_TP.metrics.resolvedCount).toBe(1);
    expect(result.exitPolicyComparison.PARTIAL_TRAILING.metrics.resolvedCount).toBe(1);
    expect(result.exitPolicyComparison.STRUCTURE_TRAILING.metrics.resolvedCount).toBe(1);
    expect(result.exitPolicyComparison.PARTIAL_TRAILING.metrics.grossExpectancyR).toBeCloseTo(1.38, 2);
    expect(result.exitPolicyComparison.FIXED_STRUCTURAL_TP.metrics.grossExpectancyR).toBeCloseTo(2.33, 2);
    expect(result.exitPolicyComparison.PARTIAL_TRAILING.metrics.averageWinnerR).toBeCloseTo(1.38, 2);
    expect(result.exitPolicyComparison.PARTIAL_TRAILING.metrics.transactionCostsKnown).toBe(true);
    expect(result.exitPolicyComparison.PARTIAL_TRAILING.outOfSample.testing.resolvedCount).toBe(1);
  });

  it('applies a swing trail only after its chronological confirmation time', () => {
    const result = replayHistoricalSignals(
      [signal({
        tp3: 1.104,
        structureTrailEvents: [{ confirmedAt: 1_090_000, stopPrice: 1.101 }],
      })],
      [
        tick(1_060_000, 1.1, 1.1002),
        tick(1_070_000, 1.1025, 1.1027),
        tick(1_075_000, 1.1008, 1.1010),
        tick(1_080_000, 1.103, 1.1032),
        tick(1_080_000, 1.1008, 1.1010),
        tick(1_090_000, 1.1008, 1.1010),
      ],
      { ticksAvailable: true }
    );

    const trail = result.exitPolicyComparison.STRUCTURE_TRAILING;
    expect(trail.metrics.resolvedCount).toBe(1);
    expect(trail.fills[0].exitAt).toBe(1_090_000);
    expect(trail.fills[0].grossR).toBeCloseTo(0.5);
    expect(trail.metrics.averageLoserR).toBeNull();
  });
});
