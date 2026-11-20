import { describe, expect, it } from 'vitest';
import { calculateRiskBasedVolume, isAdaptiveMicroFloorAllowed, RISK_CONFIG } from './riskConfig';
import riskParityCases from '../../risk-parity-cases.json';

const spec = {
  tickSize: 0.01,
  tickValue: 1,
  contractSize: 100,
  volumeMin: 0.01,
  volumeMax: 2,
  volumeStep: 0.01,
};

describe('broker risk-based position sizing', () => {
  it('can disable the adaptive minimum-lot allowance for strict risk-budget sizing', () => {
    expect(calculateRiskBasedVolume(100, 0.1, 0.2, spec, false)).toBeNull();
  });

  it('requires minimum-lot risk to remain within both adaptive allowance caps', () => {
    expect(calculateRiskBasedVolume(10, 1, 0.36, spec)).toBeNull();
  });

  it('rounds down to the broker volume step without exceeding risk', () => {
    expect(calculateRiskBasedVolume(97, 1, 0.1, spec)).toBe(0.09);
  });

  it('caps a risk-sized position at the broker maximum volume', () => {
    expect(calculateRiskBasedVolume(100_000, 1, 0.1, spec)).toBe(2);
  });

  it('allows the broker minimum for the previously blocked small-account EURUSD risk estimate', () => {
    const eurUsdSpec = { ...spec, tickSize: 1, tickValue: 94 };
    expect(calculateRiskBasedVolume(89.92, RISK_CONFIG.riskPercentPerTrade, 1, eurUsdSpec)).toBe(0.01);
  });

  it('limits adaptive minimum-lot risk to both configured dollar and equity caps', () => {
    expect(isAdaptiveMicroFloorAllowed(332, 2.37)).toBe(true);
    expect(isAdaptiveMicroFloorAllowed(1_000, 16)).toBe(false);
    expect(isAdaptiveMicroFloorAllowed(100, 4)).toBe(false);
    expect(isAdaptiveMicroFloorAllowed(100, 15.01)).toBe(false);
    expect(isAdaptiveMicroFloorAllowed(100, 3.5)).toBe(true);
    expect(isAdaptiveMicroFloorAllowed(100, 3.51)).toBe(false);
  });

  it('matches Python sizing results from shared parity cases', () => {
    for (const testCase of riskParityCases) {
      const spec = {
        tickSize: 1,
        tickValue: testCase.riskPerLot,
        contractSize: 1,
        volumeMin: testCase.volumeMin,
        volumeMax: testCase.volumeMax,
        volumeStep: testCase.volumeStep,
      };
      expect(
        calculateRiskBasedVolume(
          testCase.equity,
          (testCase.riskBudget / testCase.equity) * 100,
          1,
          spec
        ),
        testCase.name
      ).toBe(testCase.expectedVolume);
    }
  });
});
