import type { Candle, ClosedTrade, JournalSignalRecord, JournalTradeRecord, Signal, TradeDirection, Zone } from '../types/smc';
import { advanceSignalValidation } from './signalValidation';
import type { SignalValidationRecord } from './signalValidation';

const CLOSED_TRADES_STORAGE_KEY = 'smc.closed-trades.v1';
const TRADE_RATIONALES_STORAGE_KEY = 'smc.trade-rationales.v1';
const TRADE_ORDER_BLOCKS_STORAGE_KEY = 'smc.trade-order-blocks.v1';
const JOURNAL_SIGNALS_STORAGE_KEY = 'smc.journal-signals.v1';
const JOURNAL_TRADES_STORAGE_KEY = 'smc.journal-trades.v1';
const SIGNAL_VALIDATION_STORAGE_KEY = 'smc.signal-validation.v1';
const ACCOUNT_LEDGER_META_PREFIX = 'smc.account-meta.v1';
const LINKED_ACCOUNTS_KEY = 'smc.linked-mt5-accounts.v1';

let activeAccountScopeKey = 'standalone';

export interface AccountLedgerMeta {
  accountKey: string;
  login: string;
  server: string;
  broker: string;
  accountMode?: 'demo' | 'live' | 'contest' | 'unknown' | null;
  initialBalance: number;
  dailyStartBalance: number;
  dailyRiskDate: string;
  lastBalance: number;
  lastEquity: number;
  lastSyncedAt: string;
}

export function buildAccountScopeKey(login?: string | number | null, server?: string | null): string {
  const cleanLogin = login !== undefined && login !== null ? String(login).trim() : '';
  const cleanServer = server ? String(server).trim() : '';
  if (!cleanLogin || cleanLogin === '0' || !cleanServer) return 'standalone';
  return `${cleanServer}::${cleanLogin}`;
}

export function getActiveJournalAccountKey(): string {
  return activeAccountScopeKey;
}

export function setActiveJournalAccount(login?: string | number | null, server?: string | null): string {
  const nextKey = buildAccountScopeKey(login, server);
  if (nextKey !== activeAccountScopeKey) {
    activeAccountScopeKey = nextKey;
    notifyJournalChanged();
  }
  return activeAccountScopeKey;
}

function scopedKey(baseKey: string, scopeKey: string = activeAccountScopeKey): string {
  return scopeKey === 'standalone' ? baseKey : `${baseKey}::${scopeKey}`;
}

export function readAccountLedgerMeta(scopeKey: string = activeAccountScopeKey): AccountLedgerMeta | null {
  if (scopeKey === 'standalone' || typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(scopedKey(ACCOUNT_LEDGER_META_PREFIX, scopeKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccountLedgerMeta>;
    if (!parsed || typeof parsed !== 'object' || !parsed.login || !parsed.server) return null;
    return {
      accountKey: parsed.accountKey || scopeKey,
      login: String(parsed.login),
      server: String(parsed.server),
      broker: String(parsed.broker || parsed.server),
      accountMode: parsed.accountMode ?? null,
      initialBalance: Number(parsed.initialBalance) || 0,
      dailyStartBalance: Number(parsed.dailyStartBalance) || 0,
      dailyRiskDate: String(parsed.dailyRiskDate || ''),
      lastBalance: Number(parsed.lastBalance) || 0,
      lastEquity: Number(parsed.lastEquity) || 0,
      lastSyncedAt: String(parsed.lastSyncedAt || ''),
    };
  } catch {
    return null;
  }
}

export function persistAccountLedgerMeta(meta: AccountLedgerMeta): void {
  if (meta.accountKey === 'standalone' || typeof window === 'undefined') return;
  try {
    localStorage.setItem(scopedKey(ACCOUNT_LEDGER_META_PREFIX, meta.accountKey), JSON.stringify(meta));
    const listRaw = localStorage.getItem(LINKED_ACCOUNTS_KEY);
    const list: AccountLedgerMeta[] = listRaw ? JSON.parse(listRaw) : [];
    const safeList = Array.isArray(list) ? list.filter((a) => a && a.accountKey !== meta.accountKey) : [];
    safeList.unshift(meta);
    localStorage.setItem(LINKED_ACCOUNTS_KEY, JSON.stringify(safeList.slice(0, 12)));
  } catch (error) {
    console.error('[Trade Journal] Could not persist account ledger metadata:', error);
  }
}

export function readLinkedAccountProfiles(): AccountLedgerMeta[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LINKED_ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type TradeRationales = Record<string, string>;
export type TradeOrderBlocks = Record<string, Zone>;

function isZone(value: unknown): value is Zone {
  if (!value || typeof value !== 'object') return false;
  const zone = value as Partial<Zone>;
  return (
    zone.kind === 'OB' &&
    typeof zone.top === 'number' &&
    typeof zone.bottom === 'number' &&
    typeof zone.bullish === 'boolean' &&
    typeof zone.born === 'number' &&
    typeof zone.filled === 'boolean' &&
    typeof zone.tests === 'number'
  );
}

function isClosedTrade(value: unknown): value is ClosedTrade {
  if (!value || typeof value !== 'object') return false;
  const trade = value as Partial<ClosedTrade>;
  return (
    typeof trade.ticket === 'number' &&
    typeof trade.openTime === 'string' &&
    typeof trade.closeTime === 'string' &&
    (trade.type === 'BUY' || trade.type === 'SELL') &&
    typeof trade.volume === 'number' &&
    typeof trade.openPrice === 'number' &&
    typeof trade.closePrice === 'number' &&
    typeof trade.profit === 'number' &&
    typeof trade.pips === 'number'
  );
}

const journalListeners: Set<() => void> = new Set();

export function subscribeJournal(listener: () => void): () => void {
  journalListeners.add(listener);
  return () => {
    journalListeners.delete(listener);
  };
}

export function notifyJournalChanged(): void {
  for (const listener of journalListeners) {
    try {
      listener();
    } catch (e) {
      console.error('[Trade Journal] Listener error:', e);
    }
  }
}

export function readStoredClosedTrades(): ClosedTrade[] {
  try {
    const stored = localStorage.getItem(scopedKey(CLOSED_TRADES_STORAGE_KEY));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error('Stored closed trades are not an array.');
    return parsed.filter(isClosedTrade);
  } catch (error) {
    console.error('[Trade Journal] Could not load saved closed trades:', error);
    return [];
  }
}

export function persistClosedTrades(trades: ClosedTrade[]): void {
  try {
    localStorage.setItem(scopedKey(CLOSED_TRADES_STORAGE_KEY), JSON.stringify(trades));
  } catch (error) {
    console.error('[Trade Journal] Could not save closed trades:', error);
  }
}

// -------------------------------------------------------------
// SIGNAL AUDIT JOURNAL (Recorded Signals: Executed & Rejected)
// -------------------------------------------------------------

export function readStoredJournalSignals(): JournalSignalRecord[] {
  try {
    const stored = localStorage.getItem(scopedKey(JOURNAL_SIGNALS_STORAGE_KEY));
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (error) {
    console.error('[Trade Journal] Could not load journal signals:', error);
    return [];
  }
}

export function persistJournalSignals(signals: JournalSignalRecord[]): void {
  try {
    // Keep up to 300 recent signals
    const trimmed = signals.slice(-300);
    localStorage.setItem(scopedKey(JOURNAL_SIGNALS_STORAGE_KEY), JSON.stringify(trimmed));
  } catch (error) {
    console.error('[Trade Journal] Could not persist journal signals:', error);
  }
}

export function recordJournalSignal(
  record: Omit<JournalSignalRecord, 'id' | 'timestamp'> & { id?: string; timestamp?: string }
): JournalSignalRecord {
  const fullRecord: JournalSignalRecord = {
    id: record.id || `${record.symbol}-${record.direction}-${Date.now()}`,
    timestamp: record.timestamp || new Date().toISOString(),
    symbol: record.symbol,
    direction: record.direction,
    strategy: record.strategy,
    timeframe: record.timeframe,
    score: record.score,
    entry: record.entry,
    sl: record.sl,
    tp: record.tp,
    status: record.status,
    rejectionReason: record.rejectionReason,
    ticket: record.ticket,
    volume: record.volume,
    rationale: record.rationale,
  };

  const existing = readStoredJournalSignals();
  // Avoid duplicate re-records within 2 seconds for identical signal + reason
  const isDuplicate = existing.slice(-5).some(
    (e) =>
      e.symbol === fullRecord.symbol &&
      e.direction === fullRecord.direction &&
      e.status === fullRecord.status &&
      e.rejectionReason === fullRecord.rejectionReason &&
      Math.abs(new Date(e.timestamp).getTime() - new Date(fullRecord.timestamp).getTime()) < 2000
  );

  if (!isDuplicate) {
    existing.push(fullRecord);
    persistJournalSignals(existing);
    notifyJournalChanged();
  }
  return fullRecord;
}

export function reconcileFilledJournalSignals(positionTickets: number[]): void {
  const filledTickets = new Set(positionTickets);
  const signals = readStoredJournalSignals();
  let changed = false;
  const reconciled = signals.map((signal) => {
    if (signal.status !== 'PENDING' || signal.ticket === undefined || !filledTickets.has(signal.ticket)) {
      return signal;
    }
    changed = true;
    return { ...signal, status: 'EXECUTED' as const };
  });
  if (changed) {
    persistJournalSignals(reconciled);
    notifyJournalChanged();
  }
}

export function readSignalValidations(): SignalValidationRecord[] {
  try {
    const stored = localStorage.getItem(scopedKey(SIGNAL_VALIDATION_STORAGE_KEY));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error('Stored signal validation journal is not an array.');
    return parsed.filter(isSignalValidationRecord);
  } catch (error) {
    console.error('[Trade Journal] Could not load signal validation records:', error);
    return [];
  }
}

function isSignalValidationRecord(value: unknown): value is SignalValidationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SignalValidationRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.createdAt === 'string' &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    Number.isFinite(record.sourceCandleTime) &&
    (record.generatedAt === undefined ||
      (typeof record.generatedAt === 'string' && Number.isFinite(Date.parse(record.generatedAt)))) &&
    (record.availableAt === undefined ||
      (typeof record.availableAt === 'string' && Number.isFinite(Date.parse(record.availableAt)))) &&
    (record.sourceCandleOpenTime === undefined || Number.isFinite(record.sourceCandleOpenTime)) &&
    (record.sourceCandleCloseTime === undefined || Number.isFinite(record.sourceCandleCloseTime)) &&
    (record.scoringPolicyVersion === undefined || Number.isInteger(record.scoringPolicyVersion)) &&
    (record.sourceCandleOpenTime === undefined ||
      record.sourceCandleCloseTime === undefined ||
      record.sourceCandleCloseTime >= record.sourceCandleOpenTime) &&
    Number.isFinite(record.expiresAt) &&
    typeof record.symbol === 'string' &&
    (record.direction === 'BUY' || record.direction === 'SELL') &&
    (record.timeframe === 'M1' || record.timeframe === 'M5' || record.timeframe === 'M15') &&
    Number.isFinite(record.triggerPrice) &&
    Number.isFinite(record.stopLoss) &&
    Number.isFinite(record.takeProfit) &&
    Number.isFinite(record.confluenceScore) &&
    ['WATCHING', 'TARGET_HIT', 'STOP_HIT', 'AMBIGUOUS', 'EXPIRED_UNTRIGGERED', 'EXPIRED_OPEN'].includes(
      String(record.outcome)
    )
  );
}

function persistSignalValidations(records: SignalValidationRecord[]): void {
  try {
    localStorage.setItem(scopedKey(SIGNAL_VALIDATION_STORAGE_KEY), JSON.stringify(records.slice(-300)));
  } catch (error) {
    console.error('[Trade Journal] Could not persist signal validation records:', error);
  }
}

export function recordSignalValidation(record: SignalValidationRecord): void {
  const existing = readSignalValidations();
  if (existing.some((item) => item.id === record.id)) return;
  existing.push(record);
  persistSignalValidations(existing);
  notifyJournalChanged();
}

export function advanceSignalValidations(
  symbol: string,
  oneMinuteCandles: Candle[],
  now = Date.now()
): void {
  const existing = readSignalValidations();
  let changed = false;
  const advanced = existing.map((record) => {
    if (record.symbol !== symbol || record.outcome !== 'WATCHING') return record;
    const next = advanceSignalValidation(record, oneMinuteCandles, now);
    if (next !== record) changed = true;
    return next;
  });
  if (!changed) return;
  persistSignalValidations(advanced);
  notifyJournalChanged();
}

// -------------------------------------------------------------
// TRADES TAKEN AUDIT JOURNAL (Running & Completed Positions)
// -------------------------------------------------------------

export function readStoredJournalTrades(): JournalTradeRecord[] {
  try {
    const stored = localStorage.getItem(scopedKey(JOURNAL_TRADES_STORAGE_KEY));
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[Trade Journal] Could not load journal trades:', error);
    return [];
  }
}

export function persistJournalTrades(trades: JournalTradeRecord[]): void {
  try {
    const trimmed = trades.slice(-1000);
    localStorage.setItem(scopedKey(JOURNAL_TRADES_STORAGE_KEY), JSON.stringify(trimmed));
  } catch (error) {
    console.error('[Trade Journal] Could not persist journal trades:', error);
  }
}

export function recordTradeTaken(trade: JournalTradeRecord): void {
  const existing = readStoredJournalTrades();
  const idx = existing.findIndex((t) => t.ticket === trade.ticket);
  if (idx >= 0) {
    existing[idx] = { ...existing[idx], ...trade };
  } else {
    existing.push(trade);
  }
  persistJournalTrades(existing);
  notifyJournalChanged();
}

export function updateTradeClosedInJournal(
  ticket: number,
  closePrice: number,
  profit: number,
  pips: number,
  reason: ClosedTrade['reason'],
  closedAt: string = new Date().toISOString()
): void {
  const existing = readStoredJournalTrades();
  const idx = existing.findIndex((t) => t.ticket === ticket);
  if (idx >= 0) {
    existing[idx] = {
      ...existing[idx],
      closePrice,
      profit,
      pips,
      reason,
      closedAt,
      closeTime: closedAt,
      status: 'CLOSED',
    };
    persistJournalTrades(existing);
    notifyJournalChanged();
  }
}

export function syncJournalRunningPositions(
  liveUpdates: Array<{
    ticket: number;
    profit: number;
    pips: number;
    closePrice?: number;
  }>
): void {
  if (liveUpdates.length === 0) return;
  const existing = readStoredJournalTrades();
  let changed = false;

  for (const update of liveUpdates) {
    const idx = existing.findIndex((t) => t.ticket === update.ticket);
    if (idx >= 0 && existing[idx].status === 'RUNNING') {
      if (
        Math.abs(existing[idx].profit - update.profit) > 0.01 ||
        Math.abs(existing[idx].pips - update.pips) > 0.1 ||
        (update.closePrice && existing[idx].closePrice !== update.closePrice)
      ) {
        existing[idx] = {
          ...existing[idx],
          profit: update.profit,
          pips: update.pips,
          closePrice: update.closePrice ?? existing[idx].closePrice,
        };
        changed = true;
      }
    }
  }

  if (changed) {
    persistJournalTrades(existing);
    notifyJournalChanged();
  }
}

export function reconcileRunningJournalTrades(activeTickets: number[]): void {
  const existing = readStoredJournalTrades();
  let changed = false;
  const activeSet = new Set(activeTickets);

  for (let i = 0; i < existing.length; i++) {
    if (existing[i].status === 'RUNNING' && !activeSet.has(existing[i].ticket)) {
      existing[i] = {
        ...existing[i],
        status: 'CLOSED',
        reason: existing[i].reason || 'Manual',
        closeTime: existing[i].closeTime || new Date().toISOString(),
      };
      changed = true;
    }
  }

  if (changed) {
    persistJournalTrades(existing);
    notifyJournalChanged();
  }
}

export function reconcileBrokerClosedTradesInJournal(closedTrades: ClosedTrade[]): void {
  if (!closedTrades.length) return;
  const existing = readStoredJournalTrades();
  const byTicket = new Map<number, JournalTradeRecord>(existing.map((t) => [t.ticket, t]));
  let changed = false;

  for (const trade of closedTrades) {
    const prev = byTicket.get(trade.ticket) ?? (trade.positionTicket ? byTicket.get(trade.positionTicket) : undefined);
    const nextRecord: JournalTradeRecord = {
      ...prev,
      ...trade,
      status: 'CLOSED',
    };
    if (!prev || JSON.stringify(prev) !== JSON.stringify(nextRecord)) {
      byTicket.set(trade.ticket, nextRecord);
      changed = true;
    }
  }

  if (changed) {
    const sorted = [...byTicket.values()].sort((a, b) =>
      (b.closedAt || '').localeCompare(a.closedAt || '')
    );
    persistJournalTrades(sorted);
    notifyJournalChanged();
  }
}

export function clearJournalSignals(): void {
  try {
    localStorage.removeItem(scopedKey(JOURNAL_SIGNALS_STORAGE_KEY));
    localStorage.removeItem(scopedKey(SIGNAL_VALIDATION_STORAGE_KEY));
    notifyJournalChanged();
  } catch (e) {
    console.error('[Trade Journal] Could not clear signals:', e);
  }
}

export function clearJournalTrades(): void {
  try {
    localStorage.removeItem(scopedKey(JOURNAL_TRADES_STORAGE_KEY));
    localStorage.removeItem(scopedKey(CLOSED_TRADES_STORAGE_KEY));
    notifyJournalChanged();
  } catch (e) {
    console.error('[Trade Journal] Could not clear trades:', e);
  }
}

export function clearAllJournal(): void {
  clearJournalSignals();
  clearJournalTrades();
}

export function readTradeRationales(): TradeRationales {
  try {
    const stored = localStorage.getItem(scopedKey(TRADE_RATIONALES_STORAGE_KEY));
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Stored trade rationales are not an object.');
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch (error) {
    console.error('[Trade Journal] Could not load saved trade rationales:', error);
    return {};
  }
}

export function persistTradeRationales(rationales: TradeRationales): void {
  try {
    localStorage.setItem(scopedKey(TRADE_RATIONALES_STORAGE_KEY), JSON.stringify(rationales));
  } catch (error) {
    console.error('[Trade Journal] Could not save trade rationales:', error);
  }
}

export function readTradeOrderBlocks(): TradeOrderBlocks {
  try {
    const stored = localStorage.getItem(scopedKey(TRADE_ORDER_BLOCKS_STORAGE_KEY));
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Stored trade order blocks are not an object.');
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, Zone] => isZone(entry[1])
      )
    );
  } catch (error) {
    console.error('[Trade Journal] Could not load saved trade order blocks:', error);
    return {};
  }
}

export function persistTradeOrderBlocks(orderBlocks: TradeOrderBlocks): void {
  try {
    localStorage.setItem(scopedKey(TRADE_ORDER_BLOCKS_STORAGE_KEY), JSON.stringify(orderBlocks));
  } catch (error) {
    console.error('[Trade Journal] Could not save trade order blocks:', error);
  }
}

export function findCorrespondingOrderBlock(
  direction: TradeDirection,
  entry: number,
  zones: Zone[]
): Zone | undefined {
  const matchingZones = zones.filter(
    (zone) => zone.kind === 'OB' && !zone.filled && zone.bullish === (direction === 'BUY')
  );
  return matchingZones
    .slice()
    .sort((left, right) => {
      const gap = (zone: Zone) =>
        entry < zone.bottom ? zone.bottom - entry : entry > zone.top ? entry - zone.top : 0;
      return gap(left) - gap(right);
    })[0];
}

export function buildSignalRationale(signal: Signal): string {
  const explanation = signal.humanExplanation?.tradeRationale || signal.actionReason;
  const reasons = (signal.reasons || []).filter(Boolean);
  const details = explanation ? [explanation, ...reasons] : reasons;
  const uniqueDetails = [...new Set(details)];
  const rationale = `${signal.direction} ${signal.timeframe} signal (score ${signal.score}): ${
    uniqueDetails.join(' · ') || 'Qualified by the SMC confluence filters.'
  }`;
  return rationale.length > 950 ? `${rationale.slice(0, 947)}...` : rationale;
}

export function localDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function closedTradeDayKey(trade: ClosedTrade): string {
  return trade.closedAt ? localDayKey(trade.closedAt) : '';
}

