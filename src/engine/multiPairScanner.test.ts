import { describe, it, expect, beforeEach } from 'vitest';
import { INSTRUMENTS, SUPPORTED_SYMBOLS, getInstrumentConfig, getSupportedSymbol } from './instrumentConfig';
import {
  analyzeInstrument,
  analyzeInstrumentCandidates,
  rankOpportunities,
  checkCorrelationExposure,
  calculateSmallAccountPositionSize,
  buildTargetPlan,
  findLiquidityLevels,
  hasDirectionalMovement,
  isPrecisionEntryImminent,
  isPrecisionExecutionReady,
  isPrecisionEntryReady,
} from './multiPairScanner';
import { normalizeRawConfluenceScore, SCANNER_RAW_SCORE_MAX } from './scorePolicy';
import { generatePairCandles } from './dataFeed';
import { getGlobalSessionStatus, evaluateNewsRisk, isSessionPreferredForPair } from './sessionTimezones';
import { tradingEngine } from './tradingEngine';

describe('Multi-Pair Market Scanner & Instrument System', () => {
  it('keeps target ladders directional and aligns the fixed target with the displayed distances', () => {
    const buyStructural = buildTargetPlan('BUY', 100, 99, [105, 102, 102], 0.01, 2);
    expect(buyStructural).toEqual({ tp: 102, tp1: 102, tp2: 105, tp3: 105.25 });

    const buyFallback = buildTargetPlan('BUY', 100, 99, [], 0.01, 2, [1.2, 2, 3.2]);
    expect(buyFallback).toEqual({ tp: 102, tp1: 101.2, tp2: 102, tp3: 103.2 });

    const sellStructural = buildTargetPlan('SELL', 100, 101, [95, 98, 98], 0.01, 2);
    expect(sellStructural).toEqual({ tp: 98, tp1: 98, tp2: 95, tp3: 94.75 });

    for (const [direction, plan] of [['BUY', buyStructural], ['SELL', sellStructural]] as const) {
      expect(Math.abs(plan.tp - 100)).toBeLessThanOrEqual(Math.abs(plan.tp1 - 100));
      expect(direction === 'BUY' ? plan.tp1 < plan.tp2 && plan.tp2 < plan.tp3 : plan.tp1 > plan.tp2 && plan.tp2 > plan.tp3).toBe(true);
    }
  });

  it('requires direction-aligned movement to qualify a scanner signal', () => {
    const candles = [100, 100.01, 100.02, 100.03].map((close, index) => ({
      time: index,
      timeStr: '12:00',
      open: close - 0.01,
      high: close + 0.02,
      low: close - 0.02,
      close,
      volume: 100,
    }));

    expect(hasDirectionalMovement(candles, 0.2, 0.005, 'BUY')).toBe(false);
    expect(hasDirectionalMovement(candles, 0.01, 0.001, 'BUY')).toBe(true);
    expect(hasDirectionalMovement(candles, 0.01, 0.001, 'SELL')).toBe(false);
    expect(hasDirectionalMovement(candles.slice(0, 3), 0.01, 0, 'BUY')).toBe(false);
  });

  it('qualifies only fresh A+ setups near their technical entry trigger', () => {
    const candidate = {
      symbol: 'XAUUSD' as const,
      price: 2000.1,
      bid: 2000.0,
      ask: 2000.2,
      atr: 10,
      spreadAcceptable: true,
      confluenceScore: 90,
      scoreBreakdown: {
        htfAlignment: 20,
        structureConfirm: 16,
        liquiditySweep: 15,
        bosChoch: 5,
        obFvgReaction: 10,
        momentumConfirm: 8,
        sessionConfirm: 5,
        spreadAcceptable: 5,
        candleConfirm: 3,
      },
      riskRewardRatio: 3,
      spreadAdjustedRiskRewardRatio: 3,
      expiryTimestamp: 120_000,
      status: 'READY' as const,
      setupLifecycleStage: 'CONFIRMED' as const,
      signal: {
        direction: 'BUY' as const,
        timeframe: 'M5' as const,
        score: 45,
        scoringPolicyVersion: 3,
        entry: 2000.1,
        sl: 1990,
        tp: 2032,
        reasons: [],
        atr: 10,
        timestamp: new Date(0).toISOString(),
        isSniper: true,
        sniperGrade: 'A+' as const,
        optimalTradeEntry: 2000,
      },
    };

    expect(isPrecisionEntryReady(candidate, 60_000)).toBe(true);
    expect(isPrecisionExecutionReady(candidate, 'MARKET', 60_000)).toBe(true);
    const belowAPlus = {
      ...candidate,
      confluenceScore: 80,
      signal: { ...candidate.signal, score: 80, sniperGrade: 'A' as const },
    };
    expect(isPrecisionEntryReady(belowAPlus, 60_000)).toBe(false);
    expect(isPrecisionExecutionReady(belowAPlus, 'MARKET', 60_000, 70)).toBe(true);
    const boundaryCandidates = [99, 100, 101].map((rawScore) => ({
      ...candidate,
      confluenceScore: normalizeRawConfluenceScore(rawScore, SCANNER_RAW_SCORE_MAX),
    }));
    expect(boundaryCandidates.every((item) => isPrecisionEntryReady(item, 60_000))).toBe(true);
    expect(isPrecisionEntryReady({
      ...candidate,
      price: 2002,
      bid: 2001.9,
      ask: 2002.1,
    }, 60_000)).toBe(false);
    expect(isPrecisionEntryReady({
      ...candidate,
      price: 2001.5,
      bid: 2001.4,
      ask: 2001.6,
    }, 60_000)).toBe(false);
    expect(isPrecisionEntryReady({
      ...candidate,
      bid: 0,
    }, 60_000)).toBe(false);
    expect(isPrecisionEntryReady(candidate, 120_000)).toBe(false);
    expect(isPrecisionEntryImminent({
      ...candidate,
      price: 2002,
      bid: 2001.9,
      ask: 2002.1,
    }, 60_000)).toBe(true);
    expect(isPrecisionEntryImminent({
      ...candidate,
      price: 1999,
      bid: 1998.9,
      ask: 1999.1,
    }, 60_000)).toBe(false);
    const pullback = {
      ...candidate,
      bid: 2002.9,
      ask: 2003.1,
      signal: { ...candidate.signal, executionMode: 'PULLBACK_LIMIT' as const },
    };
    expect(isPrecisionEntryReady(pullback, 60_000)).toBe(false);
    expect(isPrecisionExecutionReady(pullback, 'MARKET', 60_000)).toBe(true);
    expect(isPrecisionExecutionReady({
      ...pullback,
      setupLifecycleStage: 'SWEEP',
    }, 'MARKET', 60_000)).toBe(false);
  });

  it('creates independent M1, M5, and M15 execution candidates', () => {
    const data = generatePairCandles('EURUSD', 80);
    const candidates = analyzeInstrumentCandidates(
      'EURUSD',
      data.candlesM1,
      data.candlesM5,
      data.candlesM15,
      data.candlesH1,
      data.currentBid,
      data.currentAsk,
      data.spreadPoints,
      100,
      1,
      [],
      null,
      undefined,
      { sendAlerts: false }
    );

    expect(candidates.map((candidate) => candidate.executionTimeframe)).toEqual(['M1', 'M5', 'M15']);
    expect(candidates.every((candidate) =>
      !candidate.signal || candidate.signal.timeframe === candidate.executionTimeframe
    )).toBe(true);
  });

  it('detects liquidity sweeps only when a wick breaches and closes back inside prior liquidity', () => {
    const candles = Array.from({ length: 30 }, (_, index) => ({
      time: Date.now() - (30 - index) * 60_000,
      timeStr: '12:00',
      open: 1.1,
      high: 1.101,
      low: 1.099,
      close: 1.1,
      volume: 100,
    }));
    candles[29] = { ...candles[29], high: 1.102, close: 1.1005 };

    expect(findLiquidityLevels(candles, 0.0001).recentSweep).toBe('high');

    candles[29] = { ...candles[29], close: 1.102 };
    expect(findLiquidityLevels(candles, 0.0001).recentSweep).toBeNull();

    candles[29] = { ...candles[29], high: 1.1005, low: 1.098, close: 1.0995 };
    expect(findLiquidityLevels(candles, 0.0001).recentSweep).toBe('low');
  });

  it('supports the configured instruments with independent specifications', () => {
    expect(SUPPORTED_SYMBOLS).toEqual(['XAUUSD', 'EURUSD', 'GBPUSD']);
    expect(getSupportedSymbol('USDJPY')).toBeNull();
    expect(getSupportedSymbol('EURUSD.pro')).toBe('EURUSD');

    const gold = getInstrumentConfig('XAUUSD');
    const eurusd = getInstrumentConfig('EURUSD');
    const gbpusd = getInstrumentConfig('GBPUSD');

    expect(gold.magicNumber).toBe(20261001);
    expect(eurusd.magicNumber).toBe(10001);
    expect(gbpusd.magicNumber).toBe(10003);

    expect(gold.digits).toBe(2);
    expect(eurusd.digits).toBe(5);
    expect(gbpusd.digits).toBe(5);

    expect(eurusd.minRR).toBe(2.0);
    expect(gbpusd.minScore).toBe(70); // Higher volatility requires stronger confirmation
  });

  it('performs confluence scoring (0 to 100) for all pairs', () => {
    for (const sym of SUPPORTED_SYMBOLS) {
      const data = generatePairCandles(sym, 80);
      const analysis = analyzeInstrument(
        sym,
        data.candlesM1,
        data.candlesM5,
        data.candlesM15,
        data.candlesH1,
        data.currentBid,
        data.currentAsk,
        data.spreadPoints,
        100.0,
        1.0,
        []
      );

      expect(analysis.symbol).toBe(sym);
      expect(analysis.confluenceScore).toBeGreaterThanOrEqual(0);
      expect(analysis.confluenceScore).toBeLessThanOrEqual(100);
      expect(['BUY', 'SELL', 'WAITING']).toContain(analysis.bias);
      expect(['READY', 'WAITING', 'BLOCKED']).toContain(analysis.status);
      expect(analysis.riskRewardRatio).toBeGreaterThanOrEqual(0);
      expect(analysis.scoreBreakdown).toBeDefined();
      expect(analysis.rawConfluenceScore).toBe(
        Object.values(analysis.scoreBreakdown).reduce((total, score) => total + (score ?? 0), 0)
      );
      const expectedEntryPrice = analysis.bias === 'BUY'
        ? data.currentAsk
        : analysis.bias === 'SELL'
          ? data.currentBid
          : analysis.price;
      expect(analysis.entryPrice).toBe(Number(expectedEntryPrice.toFixed(getInstrumentConfig(sym).digits)));
      if (analysis.signal) {
        expect(analysis.signal.entry).toBe(analysis.entryPrice);
      }
      expect(analysis.confluenceScore).toBe(
        normalizeRawConfluenceScore(analysis.rawConfluenceScore, SCANNER_RAW_SCORE_MAX)
      );
      expect(analysis.scoringPolicyVersion).toBe(3);
    }
  });

  it('uses the injected replay clock and blocks SMC candidates when historical news is unavailable', () => {
    const data = generatePairCandles('EURUSD', 80);
    const analysisTime = Date.now();
    const analysis = analyzeInstrument(
      'EURUSD',
      data.candlesM1,
      data.candlesM5,
      data.candlesM15,
      data.candlesH1,
      data.currentBid,
      data.currentAsk,
      data.spreadPoints,
      0,
      0,
      [],
      null,
      null,
      {
        mode: 'replay',
        nowMs: analysisTime,
        historicalEvents: null,
        sendAlerts: false,
        skipAccountSizing: true,
      }
    );

    expect(analysis.sessionName).toBe(
      getGlobalSessionStatus(new Date(analysisTime)).activeSessionName
    );
    expect(analysis.newsStatus).toBe('NEWS FILTER: DATA UNAVAILABLE');
    expect(analysis.status).not.toBe('READY');
  });

  it('ranks trade opportunities by score, setup quality and risk/reward', () => {
    const dataGold = generatePairCandles('XAUUSD', 60);
    const dataEur = generatePairCandles('EURUSD', 60);
    const dataGbp = generatePairCandles('GBPUSD', 60);

    const analyses = [
      analyzeInstrument('XAUUSD', dataGold.candlesM1, dataGold.candlesM5, dataGold.candlesM15, dataGold.candlesH1, dataGold.currentBid, dataGold.currentAsk, dataGold.spreadPoints, 100, 1.0, []),
      analyzeInstrument('EURUSD', dataEur.candlesM1, dataEur.candlesM5, dataEur.candlesM15, dataEur.candlesH1, dataEur.currentBid, dataEur.currentAsk, dataEur.spreadPoints, 100, 1.0, []),
      analyzeInstrument('GBPUSD', dataGbp.candlesM1, dataGbp.candlesM5, dataGbp.candlesM15, dataGbp.candlesH1, dataGbp.currentBid, dataGbp.currentAsk, dataGbp.spreadPoints, 100, 1.0, []),
    ];

    const ranked = rankOpportunities(analyses);
    expect(ranked.length).toBe(3);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
    expect(ranked[2].rank).toBe(3);
  });

  describe('Small Account ($10) Risk Protections', () => {
    const eurusdSpec = {
      tickSize: 0.00001,
      tickValue: 1,
      contractSize: 100_000,
      volumeMin: 0.01,
      volumeMax: 100,
      volumeStep: 0.01,
    };

    it('rejects trade with TRADE_REJECTED: MINIMUM_LOT_EXCEEDS_RISK when stop distance is too wide on micro account', () => {
      // On a $10 account with 1% risk ($0.10 budget), a wide 80-pip stop on EURUSD would risk $8 on 0.01 lots
      const sizing = calculateSmallAccountPositionSize(10.0, 1.0, 0.0080, 'EURUSD', 0.01, 0.01, eurusdSpec);
      expect(sizing.safeVolume).toBeNull();
      expect(sizing.rejectionReason).toContain('TRADE_REJECTED: MINIMUM_LOT_EXCEEDS_RISK');
    });

    it('calculates safe volume when within risk parameters', () => {
      // On a $100 account with 1% risk ($1.00 budget), a tight 10-pip stop on EURUSD ($1.00 risk on 0.01 lots)
      const sizing = calculateSmallAccountPositionSize(100.0, 1.0, 0.0010, 'EURUSD', 0.01, 0.01, eurusdSpec);
      expect(sizing.safeVolume).toBe(0.01);
      expect(sizing.rejectionReason).toBeUndefined();
    });

    it('marks a broker-minimum setup ready when it is within the adaptive floor cap', () => {
      const sizing = calculateSmallAccountPositionSize(
        332,
        0.5,
        2.37,
        'XAUUSD',
        0.01,
        0.01,
        { tickSize: 0.01, tickValue: 1, contractSize: 100, volumeMin: 0.01, volumeMax: 10, volumeStep: 0.01 }
      );

      expect(sizing.safeVolume).toBe(0.01);
      expect(sizing.riskAmount).toBeCloseTo(2.37);
      expect(sizing.rejectionReason).toBeUndefined();
    });

    it('rejects minimum volume when it exceeds the configured risk on larger accounts too', () => {
      const sizing = calculateSmallAccountPositionSize(100, 1, 0.0036, 'EURUSD', 0.01, 0.01, eurusdSpec);

      expect(sizing.safeVolume).toBeNull();
      expect(sizing.rejectionReason).toContain('TRADE_REJECTED: MINIMUM_LOT_EXCEEDS_RISK');
    });

    it('does not estimate a safe lot or dollar risk without broker symbol specifications', () => {
      const sizing = calculateSmallAccountPositionSize(100, 1, 0.001, 'EURUSD');
      expect(sizing).toMatchObject({
        safeVolume: null,
        riskAmount: null,
        rejectionReason: 'TRADE_REJECTED: BROKER_SYMBOL_SPEC_UNAVAILABLE',
      });
    });
  });

  describe('Correlation & USD Exposure Safeguards', () => {
    it('blocks opening multiple correlated USD trades in same direction', () => {
      const openPositions = [
        {
          ticket: 101,
          symbol: 'EURUSD',
          type: 'BUY' as const, // Short USD
          volume: 0.01,
          price_open: 1.0850,
          sl: 1.0800,
          tp: 1.0950,
          profit: 0,
          pips: 0,
          magic: 10001,
          comment: 'EURUSD:sig',
          time: '12:00:00',
        },
      ];

      // Second trade in GBPUSD BUY is also Short USD
      const check = checkCorrelationExposure('GBPUSD', 'BUY', openPositions, 1);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('TRADE_REJECTED: CORRELATION_LIMIT_EXCEEDED');

    });
  });

  describe('Session & News Risk Engine', () => {
    it('provides server time and Kenya/EAT time (UTC+3)', () => {
      const status = getGlobalSessionStatus(new Date('2026-10-08T12:00:00Z'));
      expect(status.brokerTimeStr).toContain('Server');
      expect(status.kenyaTimeStr).toContain('15:00 EAT'); // 12:00 UTC + 3 = 15:00 EAT
    });

    it('displays NEWS FILTER: DATA UNAVAILABLE when the provider is unavailable', () => {
      const risk = evaluateNewsRisk('EURUSD', null);
      expect(risk.hasNewsRisk).toBe(false);
      expect(risk.isDataUnavailable).toBe(true);
      expect(risk.reason).toBe('NEWS FILTER: DATA UNAVAILABLE');
    });

    it('treats a successfully fetched empty calendar as available with no imminent news', () => {
      expect(evaluateNewsRisk('EURUSD', [])).toEqual({
        hasNewsRisk: false,
        isDataUnavailable: false,
      });
    });

    it('blocks when the calendar reports high-impact news for a pair currency', () => {
      const risk = evaluateNewsRisk('EURUSD', [{
        id: 'usd-cpi',
        time: '2026-10-21T12:15:00.000Z',
        currency: 'USD',
        event: 'CPI',
        impact: 'high',
        forecast: '2.1',
        previous: '2.0',
        minutesRemaining: 15,
      }]);

      expect(risk.hasNewsRisk).toBe(true);
      expect(risk.isDataUnavailable).toBeUndefined();
      expect(risk.reason).toContain('HIGH IMPACT NEWS: USD CPI in 15m');
    });

    it('identifies preferred sessions per pair', () => {
      const londonSession = {
        asian: false,
        london: true,
        new_york: false,
        sydney: false,
        activeSessionName: 'London Session',
        brokerTimeStr: '09:00 Server',
        kenyaTimeStr: '12:00 EAT',
      };
      expect(isSessionPreferredForPair('EURUSD', londonSession)).toBe(true);
      expect(isSessionPreferredForPair('GBPUSD', londonSession)).toBe(true);
    });
  });

  describe('Workstation Symbol Switching', () => {
    it('switches active symbol seamlessly and updates quotes', () => {
      tradingEngine.switchSymbol('EURUSD');
      expect(tradingEngine.activeSymbol).toBe('EURUSD');

      const ticker = tradingEngine.getTickerSnapshot();
      expect(ticker.symbol).toBe('EURUSD');
      expect(ticker.displayName).toBe('Euro / US Dollar');

      tradingEngine.switchSymbol('XAUUSD');
      expect(tradingEngine.activeSymbol).toBe('XAUUSD');
    });
  });
});
