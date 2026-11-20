/**
 * ClosedTradesModal.tsx - Minimalist Trade History, Monthly P&L Calendar & Signal Audit
 * - Scoped per connected MT5 account (server::login)
 * - Monthly interactive P&L calendar with daily win/loss totals and per-day trade drilldown
 * - Live MT5 history re-sync button, zero mock data or synthetic fallbacks
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  useClosedTrades,
  useEngine,
  useJournalSignals,
  useJournalTrades,
  usePositions,
} from '../hooks/useTradingStore';
import {
  clearJournalSignals,
  closedTradeDayKey,
  localDayKey,
} from '../engine/tradeJournal';
import { tradingEngine } from '../engine/tradingEngine';
import { mt5Bridge } from '../engine/mt5Bridge';
import { getInstrumentConfig, SupportedSymbol } from '../engine/instrumentConfig';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  RefreshCw,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { JournalTradeRecord } from '../types/smc';

interface ClosedTradesModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: 'calendar' | 'trades' | 'signals';
  onOpenDailyReport?: (dateKey: string) => void;
}

interface DaySummary {
  dateKey: string;
  netPnl: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  totalPips: number;
  trades: JournalTradeRecord[];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatTradeTimeLabel(trade: JournalTradeRecord): string {
  const isoCandidate = trade.closedAt || trade.openedAt;
  if (isoCandidate) {
    const d = new Date(isoCandidate);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }
  if (trade.closeTime && /^\d{2}:\d{2}/.test(trade.closeTime)) return trade.closeTime;
  if (trade.openTime && /^\d{2}:\d{2}/.test(trade.openTime)) return trade.openTime;
  return '—';
}

function formatCompactMoney(val: number, currency?: string): string {
  if (!currency) return 'Unavailable';
  const abs = Math.abs(val);
  const sign = val > 0 ? '+' : val < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k ${currency}`;
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : 2)} ${currency}`;
}

function formatMoney(val: number, currency?: string): string {
  if (!currency) return 'Unavailable';
  return `${val >= 0 ? '+' : '-'}${Math.abs(val).toFixed(2)} ${currency}`;
}

export const ClosedTradesModal: React.FC<ClosedTradesModalProps> = ({
  isOpen,
  onClose,
  defaultTab = 'calendar',
  onOpenDailyReport,
}) => {
  const [activeTab, setActiveTab] = useState<'calendar' | 'trades' | 'signals'>(defaultTab);
  const [tradeFilter, setTradeFilter] = useState<'all' | 'running' | 'closed'>('all');
  const [signalFilter, setSignalFilter] = useState<'all' | 'pending' | 'executed' | 'rejected'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSyncingMt5, setIsSyncingMt5] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const todayKey = useMemo(() => localDayKey(new Date()), []);
  const [selectedDayKey, setSelectedDayKey] = useState<string>(() => localDayKey(new Date()));
  const [calendarMonth, setCalendarMonth] = useState<{ year: number; month: number }>(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  const engine = useEngine();
  const closedTrades = useClosedTrades();
  const storedJournalTrades = useJournalTrades();
  const { positions: livePositions } = usePositions();
  const journalSignals = useJournalSignals();

  const mt5 = engine.mt5Account;
  const isMt5Connected = Boolean(mt5?.connected);
  const accountCurrency = isMt5Connected ? mt5?.currency : undefined;

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const allTradesTaken = useMemo<JournalTradeRecord[]>(() => {
    const map = new Map<number, JournalTradeRecord>();

    for (const trade of storedJournalTrades) {
      map.set(trade.ticket, { ...trade });
    }

    for (const trade of closedTrades) {
      const prev = map.get(trade.ticket);
      map.set(trade.ticket, {
        ...prev,
        ...trade,
        status: 'CLOSED',
      });
    }

    for (const pos of livePositions) {
      const prev = map.get(pos.ticket);
      map.set(pos.ticket, {
        ticket: pos.ticket,
        openTime: prev?.openTime || pos.time || new Date().toISOString(),
        closeTime: '',
        symbol: pos.symbol,
        type: pos.type,
        volume: pos.volume,
        openPrice: pos.price_open,
        closePrice: pos.price_open,
        sl: pos.sl,
        tp: pos.tp,
        profit: pos.profit,
        pips: pos.pips,
        reason: prev?.reason || 'Manual',
        strategyRationale: prev?.strategyRationale,
        status: 'RUNNING',
      });
    }

    for (const [ticket, trade] of map.entries()) {
      if (trade.status === 'RUNNING') {
        const matchingPos = livePositions.find((p) => p.ticket === ticket);
        if (matchingPos) {
          trade.profit = matchingPos.profit;
          trade.pips = matchingPos.pips;
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.status === 'RUNNING' && b.status !== 'RUNNING') return -1;
      if (a.status !== 'RUNNING' && b.status === 'RUNNING') return 1;
      const aTime = a.closedAt || a.openedAt || '';
      const bTime = b.closedAt || b.openedAt || '';
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return b.ticket - a.ticket;
    });
  }, [storedJournalTrades, closedTrades, livePositions]);

  const closedOnly = useMemo(
    () => allTradesTaken.filter((t) => t.status !== 'RUNNING'),
    [allTradesTaken]
  );

  // Group closed trades by local YYYY-MM-DD for the P&L Calendar
  const dailyMap = useMemo(() => {
    const map = new Map<string, DaySummary>();
    for (const trade of closedOnly) {
      const key = closedTradeDayKey(trade);
      if (!key) continue;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          dateKey: key,
          netPnl: 0,
          tradeCount: 0,
          winCount: 0,
          lossCount: 0,
          totalPips: 0,
          trades: [],
        };
        map.set(key, entry);
      }
      entry.netPnl = Number((entry.netPnl + (trade.profit || 0)).toFixed(2));
      entry.tradeCount += 1;
      if ((trade.profit || 0) > 0) entry.winCount += 1;
      else if ((trade.profit || 0) < 0) entry.lossCount += 1;
      entry.totalPips = Number((entry.totalPips + (trade.pips || 0)).toFixed(1));
      entry.trades.push(trade);
    }
    return map;
  }, [closedOnly]);

  // Build Monday-first 6-row or 5-row calendar grid for calendarMonth
  const calendarCells = useMemo(() => {
    const { year, month } = calendarMonth;
    const firstOfMonth = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // Convert Sunday=0..Saturday=6 into Monday=0..Sunday=6
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    const cells: Array<{
      dateKey: string;
      dayNum: number;
      inMonth: boolean;
      summary: DaySummary | null;
    }> = [];

    for (let i = 0; i < totalCells; i++) {
      const cellDate = new Date(year, month, 1 - startOffset + i);
      const dateKey = localDayKey(cellDate);
      cells.push({
        dateKey,
        dayNum: cellDate.getDate(),
        inMonth: cellDate.getMonth() === month,
        summary: dailyMap.get(dateKey) ?? null,
      });
    }
    return cells;
  }, [calendarMonth, dailyMap]);

  const monthPrefix = `${calendarMonth.year}-${String(calendarMonth.month + 1).padStart(2, '0')}`;
  const monthSummary = useMemo(() => {
    let netPnl = 0;
    let trades = 0;
    let wins = 0;
    let greenDays = 0;
    let redDays = 0;
    for (const [key, day] of dailyMap.entries()) {
      if (!key.startsWith(monthPrefix)) continue;
      netPnl += day.netPnl;
      trades += day.tradeCount;
      wins += day.winCount;
      if (day.netPnl > 0) greenDays += 1;
      else if (day.netPnl < 0) redDays += 1;
    }
    return {
      netPnl: Number(netPnl.toFixed(2)),
      trades,
      winRate: trades > 0 ? ((wins / trades) * 100).toFixed(1) : '—',
      greenDays,
      redDays,
    };
  }, [dailyMap, monthPrefix]);

  const selectedDaySummary = dailyMap.get(selectedDayKey) ?? null;

  const filteredTrades = useMemo(() => {
    return allTradesTaken.filter((trade) => {
      if (tradeFilter === 'running' && trade.status !== 'RUNNING') return false;
      if (tradeFilter === 'closed' && trade.status === 'RUNNING') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesSymbol = (trade.symbol || '').toLowerCase().includes(q);
        const matchesTicket = String(trade.ticket).includes(q);
        const matchesType = trade.type.toLowerCase().includes(q);
        const matchesReason = (trade.reason || '').toLowerCase().includes(q);
        if (!matchesSymbol && !matchesTicket && !matchesType && !matchesReason) return false;
      }
      return true;
    });
  }, [allTradesTaken, tradeFilter, searchQuery]);

  const filteredSignals = useMemo(() => {
    const reversed = [...journalSignals].reverse();
    return reversed.filter((sig) => {
      if (signalFilter === 'executed' && sig.status !== 'EXECUTED') return false;
      if (signalFilter === 'pending' && sig.status !== 'PENDING') return false;
      if (signalFilter === 'rejected' && sig.status !== 'REJECTED') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesSymbol = sig.symbol.toLowerCase().includes(q);
        const matchesStrat = (sig.strategy || '').toLowerCase().includes(q);
        const matchesReason = (sig.rejectionReason || '').toLowerCase().includes(q);
        const matchesTicket = sig.ticket ? String(sig.ticket).includes(q) : false;
        if (!matchesSymbol && !matchesStrat && !matchesReason && !matchesTicket) return false;
      }
      return true;
    });
  }, [journalSignals, signalFilter, searchQuery]);

  const totalTradesCount = allTradesTaken.length;
  const runningCount = livePositions.length;
  const unconfirmedCount = allTradesTaken.filter(
    (trade) => trade.status === 'RUNNING' && !livePositions.some((position) => position.ticket === trade.ticket)
  ).length;
  const closedCount = closedOnly.length;
  const wins = closedOnly.filter((t) => t.profit > 0).length;
  const winRate = closedCount > 0 ? ((wins / closedCount) * 100).toFixed(1) : '—';
  const totalNet = Number(closedOnly.reduce((sum, t) => sum + t.profit, 0).toFixed(2));

  const totalSignalsCount = journalSignals.length;
  const pendingSignalsCount = journalSignals.filter((s) => s.status === 'PENDING').length;
  const executedSignalsCount = journalSignals.filter((s) => s.status === 'EXECUTED').length;
  const rejectedSignalsCount = journalSignals.filter((s) => s.status === 'REJECTED').length;

  const handleSyncMt5History = async () => {
    if (!isMt5Connected || isSyncingMt5) return;
    setIsSyncingMt5(true);
    setSyncNotice(null);
    try {
      const trades = await mt5Bridge.refreshAccountHistory();
      setSyncNotice(`Synced ${trades.length} closed trades from MT5 #${mt5?.login}`);
    } catch (err) {
      setSyncNotice(err instanceof Error ? err.message : 'Failed to sync MT5 history');
    } finally {
      setIsSyncingMt5(false);
      setTimeout(() => setSyncNotice(null), 3500);
    }
  };

  const handleShiftMonth = (delta: number) => {
    setCalendarMonth((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const handleJumpToToday = () => {
    const now = new Date();
    setCalendarMonth({ year: now.getFullYear(), month: now.getMonth() });
    setSelectedDayKey(todayKey);
  };

  const handleExportCSV = () => {
    let csvContent = '';
    if (activeTab === 'signals') {
      csvContent = 'ID,Timestamp,Symbol,Direction,Strategy,Timeframe,Score,Entry,SL,TP,Status,Ticket,RejectionReason\n';
      for (const s of journalSignals) {
        csvContent += `"${s.id}","${s.timestamp}","${s.symbol}","${s.direction}","${s.strategy}","${s.timeframe}",${s.score},${s.entry},${s.sl},${s.tp},"${s.status}","${s.ticket || ''}","${(s.rejectionReason || '').replace(/"/g, '""')}"\n`;
      }
    } else {
      csvContent = 'Ticket,Symbol,Type,Volume,OpenPrice,ClosePrice,Profit,Pips,Status,Reason,ClosedAt\n';
      for (const t of allTradesTaken) {
        const isUnconfirmed = t.status === 'RUNNING' && !livePositions.some((position) => position.ticket === t.ticket);
        const closePrice = t.status === 'RUNNING' ? '' : t.closePrice;
        csvContent += `${t.ticket},${t.symbol || ''},${t.type},${t.volume},${t.openPrice},${closePrice},${isUnconfirmed ? '' : t.profit},${isUnconfirmed ? '' : t.pips},${isUnconfirmed ? 'AWAITING_MT5' : t.status},${t.reason},${t.closedAt || t.openTime || ''}\n`;
      }
    }
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `nifty_${activeTab}_${mt5?.login || 'ledger'}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleCloseRunningTrade = (ticket: number) => {
    if (!livePositions.some((position) => position.ticket === ticket)) return;
    tradingEngine.closePosition(ticket, 'Manual');
  };

  const handleCloseAllRunningTrades = () => {
    tradingEngine.closeAll('Manual');
  };

  const handleClearCurrent = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3500);
      return;
    }
    if (activeTab === 'signals') {
      clearJournalSignals();
    } else {
      tradingEngine.clearDailyTradesAndLogs();
    }
    setConfirmClear(false);
  };

  if (!isOpen) return null;

  const monthLabel = new Date(calendarMonth.year, calendarMonth.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-history-modal-title"
      className="fixed inset-0 z-[170] flex justify-end bg-black/60 backdrop-blur-xs text-xs select-none"
    >
      <div className="w-full max-w-4xl h-full ws-surface border-l shadow-2xl flex flex-col overflow-hidden">
        {/* Clean Minimalist Header */}
        <header className="px-5 py-3.5 ws-subtle border-b flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <History className="w-4 h-4 text-sky-500 shrink-0" />
            <div className="min-w-0">
              <h2 id="trade-history-modal-title" className="font-extrabold text-sm text-slate-900 dark:text-white tracking-tight">
                Trade History &amp; P&amp;L Calendar
              </h2>
              <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                {isMt5Connected && mt5
                  ? `MT5 #${mt5.login} · ${mt5.server}`
                  : 'No MT5 account connected'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {isMt5Connected && (
              <button
                type="button"
                onClick={handleSyncMt5History}
                disabled={isSyncingMt5}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-[#2b3b59] bg-white dark:bg-[#0b111d] text-[11px] font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1e2d48] cursor-pointer disabled:opacity-50"
                title="Fetch latest account trade history from MetaTrader 5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingMt5 ? 'animate-spin text-sky-500' : 'text-sky-500'}`} />
                <span>{isSyncingMt5 ? 'Syncing…' : 'Sync MT5'}</span>
              </button>
            )}

            {/* Mode Switcher */}
            <div className="flex items-center bg-slate-200/70 dark:bg-[#090d16] p-0.5 rounded-lg border border-slate-300 dark:border-[#2b3b59] gap-0.5">
              <button
                type="button"
                onClick={() => setActiveTab('calendar')}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'calendar'
                    ? 'bg-white text-slate-950 dark:bg-[#172238] dark:text-white shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <CalendarDays className="w-3.5 h-3.5 text-sky-500" />
                <span>Calendar</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('trades')}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'trades'
                    ? 'bg-white text-slate-950 dark:bg-[#172238] dark:text-white shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span>Trades ({totalTradesCount})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('signals')}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'signals'
                    ? 'bg-white text-slate-950 dark:bg-[#172238] dark:text-white shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span>Signals ({totalSignalsCount})</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-[#1e2d48] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {syncNotice && (
          <div className="px-5 py-2 border-b border-slate-200 dark:border-[#2b3b59] bg-sky-500/10 text-sky-700 dark:text-sky-300 font-mono text-[11px] font-semibold">
            {syncNotice}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Account Totals Strip */}
          {activeTab !== 'signals' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2.5">
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 block">Closed Trades</span>
                <strong className="text-sm font-extrabold text-slate-900 dark:text-white tabular-nums block mt-0.5">
                  {closedCount}
                </strong>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 block">Broker Positions</span>
                <strong className="text-sm font-extrabold text-sky-600 dark:text-sky-400 tabular-nums block mt-0.5">
                  {runningCount}
                </strong>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 block">Awaiting MT5</span>
                <strong className="text-sm font-extrabold text-amber-600 dark:text-amber-400 tabular-nums block mt-0.5">
                  {unconfirmedCount}
                </strong>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 block">Win Rate</span>
                <strong className="text-sm font-extrabold text-slate-900 dark:text-white tabular-nums block mt-0.5">
                  {winRate}{closedCount > 0 ? '%' : ''} ({wins}W / {closedOnly.filter((trade) => trade.profit < 0).length}L / {closedOnly.filter((trade) => trade.profit === 0).length}BE)
                </strong>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 block">Realized Net P&amp;L</span>
                <strong
                  className={`text-sm font-extrabold tabular-nums block mt-0.5 ${
                    closedCount === 0
                      ? 'text-slate-500 dark:text-slate-400'
                      : totalNet >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {closedCount > 0 ? formatMoney(totalNet, accountCurrency) : '—'}
                </strong>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2.5">
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 block">Signals Logged</span>
                <strong className="text-sm font-extrabold text-slate-900 dark:text-white tabular-nums block mt-0.5">
                  {totalSignalsCount}
                </strong>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-amber-600 dark:text-amber-400 block">Pending</span>
                <strong className="text-sm font-extrabold text-amber-600 dark:text-amber-400 tabular-nums block mt-0.5">
                  {pendingSignalsCount}
                </strong>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-emerald-600 dark:text-emerald-400 block">Executed</span>
                <strong className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums block mt-0.5">
                  {executedSignalsCount}
                </strong>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/70 dark:bg-[#141f35]">
                <span className="text-[10px] uppercase font-bold text-rose-600 dark:text-rose-400 block">Filtered</span>
                <strong className="text-sm font-extrabold text-rose-600 dark:text-rose-400 tabular-nums block mt-0.5">
                  {rejectedSignalsCount}
                </strong>
              </div>
            </div>
          )}

          {/* TAB 1: MONTHLY P&L CALENDAR */}
          {activeTab === 'calendar' && (
            <div className="space-y-4">
              {/* Month Toolbar & Monthly Net Summary */}
              <div className="flex items-center justify-between gap-3 flex-wrap p-3 rounded-xl border border-slate-200 dark:border-[#2b3b59] bg-slate-50/60 dark:bg-[#141f35]">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleShiftMonth(-1)}
                    aria-label="Previous month"
                    className="p-1.5 rounded-lg border border-slate-300 dark:border-[#2b3b59] bg-white dark:bg-[#0b111d] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1e2d48] cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="font-extrabold text-sm text-slate-900 dark:text-white min-w-[140px] text-center">
                    {monthLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleShiftMonth(1)}
                    aria-label="Next month"
                    className="p-1.5 rounded-lg border border-slate-300 dark:border-[#2b3b59] bg-white dark:bg-[#0b111d] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1e2d48] cursor-pointer"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleJumpToToday}
                    className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-[#2b3b59] bg-white dark:bg-[#0b111d] text-[11px] font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1e2d48] cursor-pointer"
                  >
                    Today
                  </button>
                </div>

                <div className="flex items-center gap-4 font-mono text-xs tabular-nums flex-wrap">
                  <span>
                    <span className="text-slate-500 dark:text-slate-400">Month P&amp;L: </span>
                    <strong className={monthSummary.netPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                      {monthSummary.trades > 0 ? formatMoney(monthSummary.netPnl, accountCurrency) : '—'}
                    </strong>
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    Days: <strong className="text-emerald-500">{monthSummary.greenDays}W</strong> /{' '}
                    <strong className="text-rose-500">{monthSummary.redDays}L</strong>
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    Trades: <strong className="text-slate-900 dark:text-white">{monthSummary.trades}</strong> ({monthSummary.winRate}{monthSummary.trades > 0 ? '%' : ''})
                  </span>
                </div>
              </div>

              {/* 7-Day Calendar Grid */}
              <div className="space-y-1.5">
                <div className="grid grid-cols-7 gap-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {WEEKDAYS.map((day) => (
                    <div key={day} className="py-1">
                      {day}
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-7 gap-1.5">
                  {calendarCells.map((cell) => {
                    const isSelected = cell.dateKey === selectedDayKey;
                    const isToday = cell.dateKey === todayKey;
                    const s = cell.summary;
                    const hasTrades = Boolean(s && s.tradeCount > 0);
                    const isGreen = Boolean(s && s.netPnl > 0);
                    const isRed = Boolean(s && s.netPnl < 0);

                    return (
                      <button
                        key={cell.dateKey}
                        type="button"
                        onClick={() => setSelectedDayKey(cell.dateKey)}
                        className={`min-h-[68px] sm:min-h-[76px] p-2 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
                          !cell.inMonth ? 'opacity-40' : ''
                        } ${
                          hasTrades
                            ? isGreen
                              ? 'bg-emerald-500/10 border-emerald-500/40 hover:border-emerald-400'
                              : isRed
                                ? 'bg-rose-500/10 border-rose-500/40 hover:border-rose-400'
                                : 'bg-slate-200/50 dark:bg-[#172238] border-slate-300 dark:border-[#374a6d]'
                            : 'bg-white dark:bg-[#0d1424] border-slate-200 dark:border-[#23314c] hover:border-slate-400 dark:hover:border-[#3b527a]'
                        } ${
                          isSelected
                            ? 'ring-2 ring-sky-500 border-sky-500'
                            : isToday
                              ? 'ring-1 ring-sky-500/50'
                              : ''
                        }`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span
                            className={`text-[11px] font-bold tabular-nums ${
                              isToday
                                ? 'text-sky-600 dark:text-sky-400'
                                : 'text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {cell.dayNum}
                          </span>
                          {hasTrades && s && (
                            <span className="text-[10px] font-mono font-semibold text-slate-500 dark:text-slate-400 tabular-nums">
                              {s.tradeCount}t
                            </span>
                          )}
                        </div>

                        {hasTrades && s ? (
                          <div className="space-y-0.5 mt-1">
                            <div
                              className={`font-mono text-xs font-extrabold tabular-nums truncate ${
                                isGreen
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : isRed
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : 'text-slate-700 dark:text-slate-200'
                              }`}
                            >
                              {formatCompactMoney(s.netPnl, accountCurrency)}
                            </div>
                            <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                              {s.winCount}W/{s.lossCount}L
                            </div>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-300 dark:text-slate-700">—</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Selected Day Drilldown Ledger */}
              <div className="rounded-xl border border-slate-200 dark:border-[#2b3b59] overflow-hidden">
                <div className="px-4 py-2.5 ws-subtle border-b flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="font-extrabold text-xs text-slate-900 dark:text-white">
                      {new Date(`${selectedDayKey}T12:00:00`).toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                    {selectedDaySummary ? (
                      <span
                        className={`font-mono font-extrabold text-xs tabular-nums ${
                          selectedDaySummary.netPnl >= 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {formatMoney(selectedDaySummary.netPnl, accountCurrency)} ·{' '}
                        {selectedDaySummary.tradeCount} trades ({selectedDaySummary.winCount}W / {selectedDaySummary.lossCount}L)
                      </span>
                    ) : (
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">
                        No closed trades on this date
                      </span>
                    )}
                  </div>

                  {onOpenDailyReport && (
                    <button
                      type="button"
                      onClick={() => onOpenDailyReport(selectedDayKey)}
                      className="text-[11px] font-bold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                    >
                      Open Daily Report →
                    </button>
                  )}
                </div>

                {selectedDaySummary && selectedDaySummary.trades.length > 0 && (
                  <div className="overflow-x-auto max-h-56">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead className="bg-slate-50 dark:bg-[#0d1424] border-b border-slate-200 dark:border-[#2b3b59] text-[10px] text-slate-500 dark:text-slate-400 uppercase">
                        <tr>
                          <th className="py-2 px-3">Ticket / Time</th>
                          <th className="py-2 px-2">Pair</th>
                          <th className="py-2 px-2">Side &amp; Lots</th>
                          <th className="py-2 px-2">Entry → Exit</th>
                          <th className="py-2 px-2">Reason</th>
                          <th className="py-2 px-3 text-right">Net P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-[#23314c] font-mono">
                        {selectedDaySummary.trades.map((t) => {
                          const sym = (t.symbol || 'XAUUSD') as SupportedSymbol;
                          const d = getInstrumentConfig(sym).digits;
                          return (
                            <tr key={`${t.ticket}_${t.closedAt || t.closeTime}`} className="hover:bg-slate-50 dark:hover:bg-[#172238]/60">
                              <td className="py-2 px-3">
                                <span className="font-bold text-slate-900 dark:text-white">#{t.ticket}</span>
                                <span className="block text-[10px] text-slate-400">{t.closeTime || formatTradeTimeLabel(t)}</span>
                              </td>
                              <td className="py-2 px-2 font-bold text-slate-800 dark:text-slate-200">{t.symbol || '—'}</td>
                              <td className="py-2 px-2">
                                <span className={`font-bold ${t.type === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                                  {t.type}
                                </span>{' '}
                                <span className="text-slate-500 dark:text-slate-400">{t.volume}L</span>
                              </td>
                              <td className="py-2 px-2 tabular-nums text-slate-700 dark:text-slate-300">
                                {t.openPrice.toFixed(d)} → {t.closePrice.toFixed(d)}
                              </td>
                              <td className="py-2 px-2 font-sans text-[11px] text-slate-500 dark:text-slate-400">
                                {t.reason}
                              </td>
                              <td className="py-2 px-3 text-right font-extrabold tabular-nums">
                                <span className={t.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                                  {formatMoney(t.profit, accountCurrency)}
                                </span>
                                <span className="block text-[10px] font-normal text-slate-400">
                                  {t.pips >= 0 ? '+' : ''}{t.pips.toFixed(1)} pips
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Sub-Filters and Search Toolbar for Trades / Signals */}
          {activeTab !== 'calendar' && (
            <div className="flex items-center justify-between gap-2.5 flex-wrap">
              <div className="flex items-center gap-1.5 flex-wrap">
                {activeTab === 'trades' ? (
                  <>
                    {(
                      [
                        { id: 'all', label: `All (${totalTradesCount})` },
                        { id: 'running', label: `Open / Awaiting (${runningCount + unconfirmedCount})` },
                        { id: 'closed', label: `Closed (${closedCount})` },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setTradeFilter(f.id)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                          tradeFilter === f.id
                            ? 'bg-slate-900 text-white dark:bg-sky-500 dark:text-slate-950'
                            : 'bg-slate-100 dark:bg-[#141f35] text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    {(
                      [
                        { id: 'all', label: `All (${totalSignalsCount})`, activeClass: 'bg-slate-900 text-white dark:bg-sky-500 dark:text-slate-950' },
                        { id: 'pending', label: `Pending (${pendingSignalsCount})`, activeClass: 'bg-amber-500 text-white' },
                        { id: 'executed', label: `Executed (${executedSignalsCount})`, activeClass: 'bg-emerald-600 text-white' },
                        { id: 'rejected', label: `Filtered (${rejectedSignalsCount})`, activeClass: 'bg-rose-600 text-white' },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setSignalFilter(f.id)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                          signalFilter === f.id
                            ? f.activeClass
                            : 'bg-slate-100 dark:bg-[#141f35] text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </>
                )}
              </div>

              <div className="relative min-w-[210px]">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search symbol, ticket, reason..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 dark:border-[#2b3b59] bg-slate-50 dark:bg-[#0d1424] text-slate-900 dark:text-white placeholder:text-slate-500 text-xs outline-none focus:border-sky-500"
                />
              </div>
            </div>
          )}

          {/* TAB 2: TRADES TABLE */}
          {activeTab === 'trades' && (
            <div className="rounded-xl border border-slate-200 dark:border-[#2b3b59] overflow-x-auto max-h-[440px]">
              {filteredTrades.length > 0 ? (
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-[#0d1424] border-b border-slate-200 dark:border-[#2b3b59] text-[10px] text-slate-500 dark:text-slate-400 uppercase z-10">
                    <tr>
                      <th className="py-2.5 px-3">Ticket / Time</th>
                      <th className="py-2.5 px-2">Instrument</th>
                      <th className="py-2.5 px-2">Side &amp; Vol</th>
                      <th className="py-2.5 px-2">Execution Prices</th>
                      <th className="py-2.5 px-2">Status / Reason</th>
                      <th className="py-2.5 px-3 text-right">Net P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#23314c]">
                    {filteredTrades.map((t) => {
                      const isRunning = t.status === 'RUNNING';
                      const hasLivePosition = livePositions.some((position) => position.ticket === t.ticket);
                      const isAwaitingBrokerSync = isRunning && !hasLivePosition;
                      const sym = (t.symbol || 'XAUUSD') as SupportedSymbol;
                      const d = getInstrumentConfig(sym).digits;
                      return (
                        <tr
                          key={`${t.ticket}_${t.closedAt || t.openTime || 'row'}`}
                          className="hover:bg-slate-50 dark:hover:bg-[#172238]/60 transition-colors"
                        >
                          <td className="py-2.5 px-3 font-mono">
                            <span className="font-bold text-slate-900 dark:text-slate-100 block">
                              #{t.ticket}
                            </span>
                            <span className="text-[10px] text-slate-400 block">
                              {formatTradeTimeLabel(t)}
                            </span>
                          </td>
                          <td className="py-2.5 px-2 font-bold text-slate-800 dark:text-slate-200">
                            {t.symbol || '—'}
                          </td>
                          <td className="py-2.5 px-2 font-mono">
                            <span className={`font-bold ${t.type === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                              {t.type}
                            </span>{' '}
                            <span className="text-slate-400">{t.volume}L</span>
                          </td>
                          <td className="py-2.5 px-2 font-mono text-slate-700 dark:text-slate-300 tabular-nums">
                            {isRunning ? (
                              <span>@ {t.openPrice.toFixed(d)}</span>
                            ) : (
                              <span>
                                {t.openPrice.toFixed(d)} → {t.closePrice.toFixed(d)}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-2">
                            {isAwaitingBrokerSync ? (
                              <span className="text-amber-600 dark:text-amber-400 text-[11px] font-semibold">
                                Awaiting MT5 confirmation
                              </span>
                            ) : isRunning ? (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-emerald-600 dark:text-emerald-400 font-bold text-[11px]">
                                  OPEN · MT5
                                </span>
                                <button
                                  type="button"
                                  aria-label={`Close position #${t.ticket}`}
                                  onClick={() => handleCloseRunningTrade(t.ticket)}
                                  className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 hover:bg-rose-500/25 text-rose-500 transition-colors cursor-pointer"
                                >
                                  Close
                                </button>
                              </div>
                            ) : (
                              <span className="text-slate-500 dark:text-slate-400 text-[11px]">
                                {t.reason || 'Closed'}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold tabular-nums">
                            {isAwaitingBrokerSync ? (
                              <span className="text-slate-400 font-normal">Unavailable</span>
                            ) : (
                              <>
                                <span className={t.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                                  {isAwaitingBrokerSync ? 'Unavailable' : formatMoney(t.profit, accountCurrency)}
                                </span>
                                <span className="text-[10px] text-slate-400 block font-normal">
                                  {t.pips >= 0 ? '+' : ''}{t.pips.toFixed(1)} pips
                                </span>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="py-12 text-center text-slate-400 space-y-1">
                  <span className="font-bold text-xs uppercase tracking-wider block">
                    {isMt5Connected ? 'No matching trade records' : 'No MT5 Account Connected'}
                  </span>
                  <span className="text-[11px] block">
                    {isMt5Connected
                      ? `No trades found for MT5 #${mt5?.login} matching the current filter.`
                      : 'Connect your MetaTrader 5 account to sync and view its actual trade history.'}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: SIGNALS AUDIT TABLE */}
          {activeTab === 'signals' && (
            <div className="rounded-xl border border-slate-200 dark:border-[#2b3b59] overflow-x-auto max-h-[440px]">
              {filteredSignals.length > 0 ? (
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-[#0d1424] border-b border-slate-200 dark:border-[#2b3b59] text-[10px] text-slate-500 dark:text-slate-400 uppercase z-10">
                    <tr>
                      <th className="py-2.5 px-3">Time / Pair</th>
                      <th className="py-2.5 px-2">Setup</th>
                      <th className="py-2.5 px-2">Levels</th>
                      <th className="py-2.5 px-2">Status</th>
                      <th className="py-2.5 px-3">Audit Outcome / Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#23314c]">
                    {filteredSignals.map((sig) => {
                      const isExecuted = sig.status === 'EXECUTED';
                      const isPending = sig.status === 'PENDING';
                      const d = getInstrumentConfig(sig.symbol as SupportedSymbol).digits;
                      return (
                        <tr
                          key={sig.id}
                          className="hover:bg-slate-50 dark:hover:bg-[#172238]/60 transition-colors"
                        >
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-slate-900 dark:text-slate-100 block">
                              {sig.symbol}
                            </span>
                            <span className="text-[10px] font-mono text-slate-400 block">
                              {new Date(sig.timestamp).toLocaleTimeString()}
                            </span>
                          </td>
                          <td className="py-2.5 px-2">
                            <span className={`font-bold ${sig.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                              {sig.direction}
                            </span>{' '}
                            <span className="text-slate-700 dark:text-slate-300 font-medium">
                              {sig.strategy}
                            </span>
                            <span className="text-[10px] text-slate-400 block font-mono">
                              Score: {sig.score} · {sig.timeframe}
                            </span>
                          </td>
                          <td className="py-2.5 px-2 font-mono tabular-nums text-slate-700 dark:text-slate-300 text-[11px]">
                            <div>E: {sig.entry.toFixed(d)}</div>
                            <div className="text-slate-400">
                              SL: {sig.sl.toFixed(d)} | TP: {sig.tp.toFixed(d)}
                            </div>
                          </td>
                          <td className="py-2.5 px-2">
                            <span className={`font-bold text-[11px] ${
                              isExecuted
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : isPending
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-rose-600 dark:text-rose-400'
                            }`}>
                              {sig.status}
                            </span>
                          </td>
                          <td className="py-2.5 px-3">
                            {isExecuted ? (
                              <div className="text-emerald-600 dark:text-emerald-400 font-medium">
                                Order #{sig.ticket || '—'} ({sig.volume || 0.01}L)
                              </div>
                            ) : isPending ? (
                              <div className="text-amber-600 dark:text-amber-400 font-medium">
                                Awaiting broker fill · Order #{sig.ticket || '—'}
                              </div>
                            ) : (
                              <div className="text-rose-600 dark:text-rose-400 font-medium">
                                {sig.rejectionReason || 'Filtered by risk guardian'}
                              </div>
                            )}
                            {sig.rationale && (
                              <span className="text-[10px] text-slate-400 line-clamp-1 mt-0.5 block">
                                {sig.rationale}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="py-12 text-center text-slate-400 space-y-1">
                  <span className="font-bold text-xs uppercase tracking-wider block">
                    No signal records
                  </span>
                  <span className="text-[11px] block">
                    Confirmed and filtered signals for the connected account appear here.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Clean Footer */}
        <footer className="px-5 py-3.5 ws-subtle border-t flex items-center justify-between gap-3 flex-wrap shrink-0">
          <button
            type="button"
            onClick={handleExportCSV}
            disabled={(activeTab === 'signals' ? journalSignals.length : allTradesTaken.length) === 0}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-[#2b3b59] bg-white dark:bg-[#0b111d] hover:bg-slate-100 dark:hover:bg-[#1e2d48] transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-40"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>

          <div className="flex items-center gap-2">
            {activeTab !== 'signals' && runningCount > 0 && (
              <button
                type="button"
                onClick={handleCloseAllRunningTrades}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500/15 hover:bg-amber-500/25 text-amber-600 dark:text-amber-400 border border-amber-500/30 transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <Zap className="w-3.5 h-3.5 fill-current" />
                <span>Close All ({runningCount})</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleClearCurrent}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                confirmClear
                  ? 'bg-rose-600 text-white'
                  : 'text-rose-600 dark:text-rose-400 hover:bg-rose-500/10'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{confirmClear ? 'Confirm Clear?' : `Clear ${activeTab === 'signals' ? 'Signals' : 'Cache'}`}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg text-xs font-bold bg-slate-900 text-white dark:bg-white dark:text-slate-950 transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

export const AuditJournalModal = ClosedTradesModal;
