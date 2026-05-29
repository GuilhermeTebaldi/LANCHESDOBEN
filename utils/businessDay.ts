import { DailySalesHistoryEntry, Sale, StockEntry } from '../types';

const BUSINESS_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (value: number): string => value.toString().padStart(2, '0');

export const toDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

export const toDate = (value: Date | string): Date => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
};

export const normalizeBusinessDayKey = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!BUSINESS_DAY_KEY_PATTERN.test(trimmed)) return undefined;
  return trimmed;
};

export const formatBusinessDayLabel = (dayKey: string): string => {
  const match = BUSINESS_DAY_KEY_PATTERN.exec(dayKey);
  if (!match) return dayKey;
  const [year, month, day] = dayKey.split('-');
  return `${day}/${month}/${year}`;
};

export const getHistoryBusinessDayKey = (entry: DailySalesHistoryEntry): string =>
  normalizeBusinessDayKey(entry.businessDate) || toDayKey(toDate(entry.closedAt));

export const resolveSessionBusinessDayKey = (
  sales: Sale[],
  stockEntries: StockEntry[] = [],
  activeBusinessDate?: string | null
): string => {
  const activeDay = normalizeBusinessDayKey(activeBusinessDate);
  if (activeDay) return activeDay;

  let earliestMs = Number.POSITIVE_INFINITY;

  sales.forEach((sale) => {
    const saleMs = toDate(sale.timestamp).getTime();
    if (saleMs < earliestMs) earliestMs = saleMs;
  });

  stockEntries.forEach((entry) => {
    const entryMs = toDate(entry.timestamp).getTime();
    if (entryMs < earliestMs) earliestMs = entryMs;
  });

  if (Number.isFinite(earliestMs)) return toDayKey(new Date(earliestMs));
  return toDayKey(new Date());
};

interface BuildSaleBusinessDayKeyMapOptions {
  activeBusinessDate?: string | null;
  currentSessionSaleIds?: Set<string>;
}

const getSaleStableKey = (sale: Sale, fallbackIndex: number): string => {
  const normalizedId = typeof sale.id === 'string' ? sale.id.trim() : '';
  if (normalizedId) return normalizedId;
  return `fallback:${fallbackIndex}:${sale.productId}:${toDate(sale.timestamp).toISOString()}`;
};

export const buildSaleBusinessDayKeyMap = (
  sales: Sale[],
  dailySalesHistory: DailySalesHistoryEntry[],
  options: BuildSaleBusinessDayKeyMapOptions = {}
): Map<string, string> => {
  const map = new Map<string, string>();
  const sortedSales = [...sales]
    .map((sale, index) => ({ sale, index, key: getSaleStableKey(sale, index) }))
    .sort((a, b) => toDate(a.sale.timestamp).getTime() - toDate(b.sale.timestamp).getTime());

  const currentSessionSaleIds = options.currentSessionSaleIds || new Set<string>();
  const sessionSales = sortedSales.filter(({ sale }) => currentSessionSaleIds.has(sale.id));
  const historicalSales = sortedSales.filter(({ sale }) => !currentSessionSaleIds.has(sale.id));

  const orderedHistory = [...dailySalesHistory]
    .map((entry) => ({
      entry,
      closedAtMs: toDate(entry.closedAt).getTime(),
      explicitDayKey: normalizeBusinessDayKey(entry.businessDate),
      fallbackDayKey: toDayKey(toDate(entry.closedAt)),
    }))
    .filter((entry) => Number.isFinite(entry.closedAtMs))
    .sort((a, b) => a.closedAtMs - b.closedAtMs);

  let historySaleIndex = 0;
  let lowerBoundMs = Number.NEGATIVE_INFINITY;

  orderedHistory.forEach((historyItem) => {
    const intervalSales: Array<{ sale: Sale; index: number; key: string }> = [];

    while (historySaleIndex < historicalSales.length) {
      const saleItem = historicalSales[historySaleIndex];
      const saleMs = toDate(saleItem.sale.timestamp).getTime();

      if (saleMs <= lowerBoundMs) {
        historySaleIndex += 1;
        continue;
      }

      if (saleMs > historyItem.closedAtMs) break;

      intervalSales.push(saleItem);
      historySaleIndex += 1;
    }

    const inferredDayKey =
      intervalSales.length > 0
        ? toDayKey(toDate(intervalSales[0].sale.timestamp))
        : historyItem.fallbackDayKey;
    const resolvedDayKey = historyItem.explicitDayKey || inferredDayKey;
    intervalSales.forEach((saleItem) => {
      map.set(saleItem.key, resolvedDayKey);
    });

    lowerBoundMs = historyItem.closedAtMs;
  });

  for (let index = historySaleIndex; index < historicalSales.length; index += 1) {
    const saleItem = historicalSales[index];
    map.set(saleItem.key, toDayKey(toDate(saleItem.sale.timestamp)));
  }

  const activeBusinessDate = normalizeBusinessDayKey(options.activeBusinessDate);
  const sessionDayKey = activeBusinessDate || resolveSessionBusinessDayKey(
    sessionSales.map((item) => item.sale)
  );

  sessionSales.forEach((saleItem) => {
    map.set(saleItem.key, sessionDayKey);
  });

  return map;
};

export const groupSalesByBusinessDay = (
  sales: Sale[],
  dailySalesHistory: DailySalesHistoryEntry[],
  options: BuildSaleBusinessDayKeyMapOptions = {}
): Map<string, Sale[]> => {
  const byDay = new Map<string, Sale[]>();
  const dayBySale = buildSaleBusinessDayKeyMap(sales, dailySalesHistory, options);

  sales.forEach((sale, index) => {
    const stableKey = getSaleStableKey(sale, index);
    const dayKey = dayBySale.get(stableKey) || toDayKey(toDate(sale.timestamp));
    const current = byDay.get(dayKey);
    if (current) {
      current.push(sale);
      return;
    }
    byDay.set(dayKey, [sale]);
  });

  return byDay;
};
