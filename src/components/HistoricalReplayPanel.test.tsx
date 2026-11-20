import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoricalReplayPanel } from './HistoricalReplayPanel';

const bridgeMocks = vi.hoisted(() => ({
  getHistoricalCandles: vi.fn(),
  getHistoricalTicks: vi.fn(),
  getHistoricalTicksChunked: vi.fn(),
}));

vi.mock('../engine/mt5Bridge', () => ({
  mt5Bridge: bridgeMocks,
}));

const response = {
  source: 'MetaTrader5' as const,
  accountLogin: 98765,
  accountServer: 'Demo-Server',
  symbol: 'EURUSD',
  requestedStart: 1,
  requestedEnd: 2,
  count: 0,
  candles: [],
  ticks: [],
};

describe('HistoricalReplayPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMocks.getHistoricalCandles.mockResolvedValue(response);
    bridgeMocks.getHistoricalTicks.mockResolvedValue(response);
    bridgeMocks.getHistoricalTicksChunked.mockResolvedValue(response);
  });

  it('loads real broker history and reports missing ticks without inventing performance', async () => {
    render(<HistoricalReplayPanel symbol="EURUSD" instrumentType="standard" />);

    fireEvent.click(screen.getByRole('button', { name: /Load broker history/i }));

    await waitFor(() => {
      expect(screen.getByText(/Source: MT5/)).toBeTruthy();
    });
    expect(bridgeMocks.getHistoricalCandles).toHaveBeenCalledTimes(4);
    expect(bridgeMocks.getHistoricalTicksChunked).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Genuine bid\/ask tick history is unavailable/)).toBeTruthy();
    expect(screen.getAllByText(/Net expectancy \/ PF/)).toHaveLength(2);
  });

  it('rejects history responses that cross an account switch', async () => {
    bridgeMocks.getHistoricalTicksChunked.mockResolvedValue({
      ...response,
      accountLogin: 123,
    });
    render(<HistoricalReplayPanel symbol="EURUSD" instrumentType="standard" />);

    fireEvent.click(screen.getByRole('button', { name: /Load broker history/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/same MT5 source, account, and broker symbol/i);
  });
});
