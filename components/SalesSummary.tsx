
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DailySalesHistoryEntry, Ingredient, Sale, SaleOrigin, StockEntry } from '../types';
import { APP_ORIGINS, AppOrigin, buildAppChannelSummary } from '../utils/appChannelSummary';
import { getReceiptPaperWidthMm } from '../utils/receiptPaper';
import { formatStockQuantityByUnit, getRecipeQuantityUnitLabel } from '../utils/recipe';

interface SalesSummaryProps {
  sales: Sale[];
  archivedSales?: Sale[];
  allIngredients: Ingredient[];
  stockEntries: StockEntry[];
  cashRegisterAmount: number;
  dailySalesHistory: DailySalesHistoryEntry[];
  onSetCashRegister?: (amount: number) => Promise<boolean> | boolean;
  onCloseDay?: () => Promise<boolean> | boolean;
  onRegisterCashPurchase?: (
    ingredientId: string,
    purchaseAmount: number,
    purchaseDescription?: string
  ) => Promise<boolean> | boolean;
  onRegisterCashExpense?: (
    purchaseAmount: number,
    purchaseDescription: string
  ) => Promise<boolean> | boolean;
  onRevertCashExpense?: (entryId: string) => Promise<boolean> | boolean;
}

type SummaryTab = 'REPORT' | 'CASH';
type CashPurchaseType = 'INGREDIENT' | 'OTHER';
type ReportPrintMode = 'FULL' | 'SUMMARY';

interface HistoryDrawerEntry {
  entry: DailySalesHistoryEntry;
  dayKey: string;
  sales: Sale[];
  inferred: boolean;
}

type PaymentMethodSummaryKey = 'PIX' | 'DEBITO' | 'CREDITO' | 'DINHEIRO' | 'DIVIDIDO';
interface HistoryPrintPreset {
  id: string;
  label: string;
  paperWidthMm: number;
  pageHeightMm: number;
}
interface CashPrintPreset {
  id: string;
  label: string;
  bodyWidthMm: number;
  pageWidthMm: number;
  pageHeightMm: number | null;
}

const COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#6366f1', '#ec4899'];
const PAYMENT_METHOD_ORDER: PaymentMethodSummaryKey[] = ['DEBITO', 'PIX', 'DINHEIRO', 'CREDITO', 'DIVIDIDO'];
const PAYMENT_METHOD_LABELS: Record<PaymentMethodSummaryKey, string> = {
  PIX: 'Pix',
  DEBITO: 'Débito',
  CREDITO: 'Crédito',
  DINHEIRO: 'Dinheiro',
  DIVIDIDO: 'Dividido',
};
const APP_ORIGIN_STYLE: Record<AppOrigin, { card: string }> = {
  IFOOD: {
    card: 'bg-red-600 text-white',
  },
  APP99: {
    card: 'bg-amber-600 text-white',
  },
  KEETA: {
    card: 'bg-emerald-600 text-white',
  },
};
const HISTORY_PRINT_PRESET_STORAGE_KEY = 'qb_history_print_preset_v1';
const CASH_PRINT_PRESET_STORAGE_KEY = 'qb_cash_print_preset_v1';
const CASH_PRINT_DEFAULT_BODY_WIDTH_MM = 72;
const CASH_PRINT_DEFAULT_PAGE_WIDTH_MM = 80;
const HISTORY_PRINT_PRESETS: HistoryPrintPreset[] = [
  { id: '48x297', label: '48 x 297 mm', paperWidthMm: 48, pageHeightMm: 297 },
  { id: '58x297', label: '58 x 297 mm', paperWidthMm: 58, pageHeightMm: 297 },
  { id: '72x297', label: '72 x 297 mm', paperWidthMm: 72, pageHeightMm: 297 },
  { id: '80x297', label: '80 x 297 mm', paperWidthMm: 80, pageHeightMm: 297 },
  { id: 'A4_210x297', label: 'A4 210 x 297 mm', paperWidthMm: 210, pageHeightMm: 297 },
];
const DEFAULT_HISTORY_PRINT_PRESET_ID = '80x297';
const CASH_PRINT_PRESETS: CashPrintPreset[] = [
  {
    id: 'DEFAULT',
    label: 'Padrão',
    bodyWidthMm: CASH_PRINT_DEFAULT_BODY_WIDTH_MM,
    pageWidthMm: CASH_PRINT_DEFAULT_PAGE_WIDTH_MM,
    pageHeightMm: null,
  },
  { id: '48x297', label: '48 x 297 mm', bodyWidthMm: 48, pageWidthMm: 48, pageHeightMm: 297 },
  { id: '58x297', label: '58 x 297 mm', bodyWidthMm: 58, pageWidthMm: 58, pageHeightMm: 297 },
  { id: '72x297', label: '72 x 297 mm', bodyWidthMm: 72, pageWidthMm: 72, pageHeightMm: 297 },
  { id: '80x297', label: '80 x 297 mm', bodyWidthMm: 80, pageWidthMm: 80, pageHeightMm: 297 },
  { id: 'A4_210x297', label: 'A4 210 x 297 mm', bodyWidthMm: 210, pageWidthMm: 210, pageHeightMm: 297 },
];
const DEFAULT_CASH_PRINT_PRESET_ID = 'DEFAULT';

const getHistoryPrintPresetById = (presetId: string): HistoryPrintPreset =>
  HISTORY_PRINT_PRESETS.find((preset) => preset.id === presetId) ||
  HISTORY_PRINT_PRESETS.find((preset) => preset.id === DEFAULT_HISTORY_PRINT_PRESET_ID) ||
  HISTORY_PRINT_PRESETS[0];

const getCashPrintPresetById = (presetId: string): CashPrintPreset =>
  CASH_PRINT_PRESETS.find((preset) => preset.id === presetId) ||
  CASH_PRINT_PRESETS.find((preset) => preset.id === DEFAULT_CASH_PRINT_PRESET_ID) ||
  CASH_PRINT_PRESETS[0];

const readHistoryPrintPresetId = (): string => {
  if (typeof window === 'undefined') return DEFAULT_HISTORY_PRINT_PRESET_ID;
  try {
    const raw = window.localStorage.getItem(HISTORY_PRINT_PRESET_STORAGE_KEY);
    if (!raw) return DEFAULT_HISTORY_PRINT_PRESET_ID;
    return getHistoryPrintPresetById(raw).id;
  } catch {
    return DEFAULT_HISTORY_PRINT_PRESET_ID;
  }
};

const writeHistoryPrintPresetId = (presetId: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HISTORY_PRINT_PRESET_STORAGE_KEY, presetId);
  } catch {
    // ignore storage write failures
  }
};

const readCashPrintPresetId = (): string => {
  if (typeof window === 'undefined') return DEFAULT_CASH_PRINT_PRESET_ID;
  try {
    const raw = window.localStorage.getItem(CASH_PRINT_PRESET_STORAGE_KEY);
    if (!raw) return DEFAULT_CASH_PRINT_PRESET_ID;
    return getCashPrintPresetById(raw).id;
  } catch {
    return DEFAULT_CASH_PRINT_PRESET_ID;
  }
};

const writeCashPrintPresetId = (presetId: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CASH_PRINT_PRESET_STORAGE_KEY, presetId);
  } catch {
    // ignore storage write failures
  }
};

const getSaleOriginLabel = (origin: SaleOrigin | null | undefined): string => {
  if (origin === 'IFOOD') return 'iFood';
  if (origin === 'APP99') return '99';
  if (origin === 'KEETA') return 'Keeta';
  return 'Balcão';
};

const isAppSaleOrigin = (origin: SaleOrigin | null | undefined): boolean =>
  origin === 'IFOOD' || origin === 'APP99' || origin === 'KEETA';

const formatCurrency = (value: number): string => `R$ ${value.toFixed(2)}`;

const parseMoneyInput = (raw: string): number | null => {
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const toDate = (value: Date | string): Date => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
};

const getDayKey = (value: Date | string): string => toDate(value).toLocaleDateString('pt-BR');

const roundMoney = (value: number): number => Number(value.toFixed(2));
const LOCAL_DAILY_HISTORY_KEY = 'qb_daily_sales_history_local_v1';

const normalizeDailyHistoryEntry = (value: unknown): DailySalesHistoryEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const closedAtRaw = source.closedAt;
  const closedAt =
    closedAtRaw instanceof Date || typeof closedAtRaw === 'string'
      ? closedAtRaw
      : new Date().toISOString();

  const saleCountRaw = Number(source.saleCount);
  const saleCount = Number.isFinite(saleCountRaw) && saleCountRaw >= 0 ? Math.floor(saleCountRaw) : 0;

  return {
    id:
      typeof source.id === 'string' && source.id.trim()
        ? source.id
        : `day-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    closedAt,
    openingCash: roundMoney(Math.max(0, Number(source.openingCash) || 0)),
    totalRevenue: roundMoney(Math.max(0, Number(source.totalRevenue) || 0)),
    totalPurchases: roundMoney(Math.max(0, Number(source.totalPurchases) || 0)),
    totalProfit: roundMoney(Number(source.totalProfit) || 0),
    saleCount,
    cashExpenses: roundMoney(Math.max(0, Number(source.cashExpenses) || 0)),
  };
};

const readLocalDailySalesHistory = (): DailySalesHistoryEntry[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_DAILY_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeDailyHistoryEntry(entry))
      .filter((entry): entry is DailySalesHistoryEntry => entry !== null);
  } catch {
    return [];
  }
};

const getHistoryEntryFingerprint = (entry: DailySalesHistoryEntry): string => {
  const closedAtIso = toDate(entry.closedAt).toISOString();
  const totalRevenue = roundMoney(Number(entry.totalRevenue) || 0);
  const totalPurchases = roundMoney(Number(entry.totalPurchases) || 0);
  const saleCount = Math.max(0, Math.floor(Number(entry.saleCount) || 0));
  const cashExpenses = roundMoney(Math.max(0, Number(entry.cashExpenses) || 0));
  return `${closedAtIso}|${totalRevenue}|${totalPurchases}|${saleCount}|${cashExpenses}`;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const THERMAL_DEFAULT_COLUMNS = 40;
const THERMAL_MIN_COLUMNS = 20;
const THERMAL_MAX_COLUMNS = 120;
const THERMAL_COLUMNS_PER_MM = 0.55;
const THERMAL_COLUMN_SAFETY_OFFSET = 1;
const THERMAL_SUMMARY_LEFT_INSET_CHARS = 2;
const THERMAL_FULL_REPORT_COLUMNS = 48;
const THERMAL_FULL_BODY_WIDTH_MM = CASH_PRINT_DEFAULT_BODY_WIDTH_MM;
const THERMAL_FULL_PAGE_WIDTH_MM = CASH_PRINT_DEFAULT_PAGE_WIDTH_MM;

const normalizeThermalText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const formatThermalCurrency = (value: number): string =>
  `R$ ${(Number.isFinite(value) ? value : 0).toFixed(2).replace('.', ',')}`;

const getThermalColumnsForPaperWidth = (paperWidthMm: number): number => {
  if (!Number.isFinite(paperWidthMm) || paperWidthMm <= 0) return THERMAL_DEFAULT_COLUMNS;
  const estimated = Math.round(paperWidthMm * THERMAL_COLUMNS_PER_MM) - THERMAL_COLUMN_SAFETY_OFFSET;
  return Math.min(THERMAL_MAX_COLUMNS, Math.max(THERMAL_MIN_COLUMNS, estimated));
};

const fitThermalText = (value: string, width: number): string => {
  const normalized = normalizeThermalText(value);
  if (normalized.length <= width) return normalized;
  if (width <= 1) return normalized.slice(0, width);
  return normalized.slice(0, width);
};

const alignThermalPair = (left: string, right: string, width = THERMAL_DEFAULT_COLUMNS): string => {
  const leftText = normalizeThermalText(left);
  const rightText = normalizeThermalText(right);
  if (!rightText) return fitThermalText(leftText, width);

  const maxLeft = width - rightText.length - 1;
  if (maxLeft <= 0) return fitThermalText(rightText, width);

  const fittedLeft = fitThermalText(leftText, maxLeft);
  const spaces = Math.max(1, width - fittedLeft.length - rightText.length);
  return `${fittedLeft}${' '.repeat(spaces)}${rightText}`;
};

const centerThermalText = (value: string, width = THERMAL_DEFAULT_COLUMNS): string => {
  const fitted = fitThermalText(value, width);
  const remaining = width - fitted.length;
  if (remaining <= 0) return fitted;
  const leftPad = Math.floor(remaining / 2);
  const rightPad = remaining - leftPad;
  return `${' '.repeat(leftPad)}${fitted}${' '.repeat(rightPad)}`;
};

const wrapThermalText = (value: string, width = THERMAL_DEFAULT_COLUMNS): string[] => {
  const normalized = normalizeThermalText(value);
  if (!normalized) return [''];

  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  words.forEach((word) => {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      return;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      return;
    }

    if (current) lines.push(current);
    current = word;
  });

  if (current) lines.push(current);
  return lines;
};

const summarizePaymentMethods = (
  reportSales: Sale[]
): {
  rows: { label: string; value: number }[];
  unclassifiedValue: number;
} => {
  const totals: Record<PaymentMethodSummaryKey, number> = {
    PIX: 0,
    DEBITO: 0,
    CREDITO: 0,
    DINHEIRO: 0,
    DIVIDIDO: 0,
  };
  let unclassifiedValue = 0;

  reportSales.forEach((sale) => {
    const total = Number(sale.total);
    if (!Number.isFinite(total) || total <= 0) return;

    const method = sale.payment?.method;
    if (method && method in totals) {
      totals[method as PaymentMethodSummaryKey] += total;
      return;
    }

    unclassifiedValue += total;
  });

  return {
    rows: PAYMENT_METHOD_ORDER.map((method) => ({
      label: PAYMENT_METHOD_LABELS[method],
      value: roundMoney(totals[method]),
    })),
    unclassifiedValue: roundMoney(unclassifiedValue),
  };
};

const SalesSummary: React.FC<SalesSummaryProps> = ({
  sales,
  archivedSales = [],
  allIngredients,
  stockEntries,
  cashRegisterAmount,
  dailySalesHistory,
  onSetCashRegister,
  onCloseDay,
  onRegisterCashPurchase,
  onRegisterCashExpense,
  onRevertCashExpense,
}) => {
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const [isClosing, setIsClosing] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyPrintSettingsOpen, setHistoryPrintSettingsOpen] = useState(false);
  const [historyPrintPresetId, setHistoryPrintPresetId] = useState<string>(() => readHistoryPrintPresetId());
  const [cashPrintSettingsOpen, setCashPrintSettingsOpen] = useState(false);
  const [cashPrintPresetId, setCashPrintPresetId] = useState<string>(() => readCashPrintPresetId());
  const [activeTab, setActiveTab] = useState<SummaryTab>('REPORT');
  const [cashInput, setCashInput] = useState(cashRegisterAmount.toFixed(2));
  const [cashPurchaseType, setCashPurchaseType] = useState<CashPurchaseType>('INGREDIENT');
  const [cashPurchaseIngredientId, setCashPurchaseIngredientId] = useState('');
  const [cashPurchaseAmountInput, setCashPurchaseAmountInput] = useState('');
  const [cashPurchaseDescription, setCashPurchaseDescription] = useState('');
  const [revertingEntryId, setRevertingEntryId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCashInput(cashRegisterAmount.toFixed(2));
  }, [cashRegisterAmount]);

  useEffect(() => {
    if (cashPurchaseType !== 'INGREDIENT') return;
    if (cashPurchaseIngredientId) return;
    const firstIngredientId = allIngredients[0]?.id;
    if (firstIngredientId) {
      setCashPurchaseIngredientId(firstIngredientId);
    }
  }, [allIngredients, cashPurchaseIngredientId, cashPurchaseType]);

  useEffect(() => {
    writeHistoryPrintPresetId(historyPrintPresetId);
  }, [historyPrintPresetId]);

  useEffect(() => {
    writeCashPrintPresetId(cashPrintPresetId);
  }, [cashPrintPresetId]);

  useEffect(() => {
    if (historyVisible) return;
    setHistoryPrintSettingsOpen(false);
  }, [historyVisible]);

  useEffect(() => {
    if (activeTab === 'CASH') return;
    setCashPrintSettingsOpen(false);
  }, [activeTab]);

  const selectedHistoryPrintPreset = useMemo(
    () => getHistoryPrintPresetById(historyPrintPresetId),
    [historyPrintPresetId]
  );
  const selectedCashPrintPreset = useMemo(
    () => getCashPrintPresetById(cashPrintPresetId),
    [cashPrintPresetId]
  );

  const productSalesMap = useMemo(
    () =>
      sales.reduce((acc: Record<string, number>, sale: Sale) => {
        acc[sale.productName] = (acc[sale.productName] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    [sales]
  );

  const chartData = useMemo(
    () =>
      Object.entries(productSalesMap)
        .map(([name, value]): { name: string; vendas: number } => ({
          name,
          vendas: value as number,
        }))
        .sort((a, b) => b.vendas - a.vendas),
    [productSalesMap]
  );

  const totalRevenue = useMemo(() => sales.reduce((sum, s) => sum + s.total, 0), [sales]);
  const totalCost = useMemo(() => sales.reduce((sum, s) => sum + (s.totalCost || 0), 0), [sales]);
  const cashRegisterExpenses = useMemo(
    () =>
      roundMoney(
        stockEntries.reduce((sum, entry) => {
          const impact = Number(entry.cashRegisterImpact);
          if (!Number.isFinite(impact) || impact >= 0) return sum;
          return sum + Math.abs(impact);
        }, 0)
      ),
    [stockEntries]
  );
  const cashRegisterExpenseEntries = useMemo(
    () =>
      stockEntries
        .filter((entry) => {
          const impact = Number(entry.cashRegisterImpact);
          return Number.isFinite(impact) && impact < 0;
        })
        .slice()
        .sort((a, b) => toDate(b.timestamp).getTime() - toDate(a.timestamp).getTime()),
    [stockEntries]
  );
  const totalProfit = useMemo(() => totalRevenue - totalCost, [totalRevenue, totalCost]);
  const appChannelSummary = useMemo(() => buildAppChannelSummary(sales), [sales]);
  const reportRevenueExcludingApps = useMemo(
    () => roundMoney(Math.max(0, totalRevenue - appChannelSummary.totalRevenue)),
    [appChannelSummary.totalRevenue, totalRevenue]
  );
  const appOriginRows = useMemo(
    () =>
      APP_ORIGINS.map((origin) => {
        const summary = appChannelSummary.byOrigin[origin];
        return {
          origin,
          label: getSaleOriginLabel(origin),
          orders: summary.orders,
          revenue: summary.revenue,
        };
      }).filter((row) => row.orders > 0),
    [appChannelSummary]
  );
  const selectedCashPurchaseIngredient = useMemo(
    () =>
      cashPurchaseType !== 'INGREDIENT'
        ? null
        : allIngredients.find((ingredient) => ingredient.id === cashPurchaseIngredientId) || null,
    [allIngredients, cashPurchaseIngredientId, cashPurchaseType]
  );
  const estimatedCashPurchaseStockIncrease = useMemo(() => {
    if (cashPurchaseType !== 'INGREDIENT') return null;
    if (!selectedCashPurchaseIngredient) return null;
    const parsedAmount = parseMoneyInput(cashPurchaseAmountInput);
    if (parsedAmount === null || parsedAmount <= 0) return null;
    if (!Number.isFinite(selectedCashPurchaseIngredient.cost) || selectedCashPurchaseIngredient.cost <= 0) {
      return null;
    }
    return Number((parsedAmount / selectedCashPurchaseIngredient.cost).toFixed(6));
  }, [cashPurchaseAmountInput, cashPurchaseType, selectedCashPurchaseIngredient]);
  const estimatedClosingCash = useMemo(
    () => cashRegisterAmount + totalRevenue - totalCost - cashRegisterExpenses,
    [cashRegisterAmount, totalRevenue, totalCost, cashRegisterExpenses]
  );

  const currentDayReport = useMemo<DailySalesHistoryEntry>(
    () => ({
      id: 'current-day',
      closedAt: new Date(),
      openingCash: cashRegisterAmount,
      totalRevenue,
      totalPurchases: totalCost,
      totalProfit,
      saleCount: sales.length,
      cashExpenses: cashRegisterExpenses,
    }),
    [cashRegisterAmount, cashRegisterExpenses, totalCost, totalProfit, totalRevenue, sales.length]
  );

  const archiveSalesByDay = useMemo(() => {
    const map = new Map<string, Sale[]>();
    archivedSales.forEach((sale) => {
      const dayKey = getDayKey(sale.timestamp);
      const current = map.get(dayKey);
      if (current) {
        current.push(sale);
        return;
      }
      map.set(dayKey, [sale]);
    });
    return map;
  }, [archivedSales]);

  const mergedDailySalesHistory = useMemo<DailySalesHistoryEntry[]>(() => {
    const normalizedPropEntries = dailySalesHistory
      .map((entry) => normalizeDailyHistoryEntry(entry))
      .filter((entry): entry is DailySalesHistoryEntry => entry !== null);

    const localEntries = readLocalDailySalesHistory();
    if (localEntries.length === 0) {
      return normalizedPropEntries.sort(
        (a, b) => toDate(b.closedAt).getTime() - toDate(a.closedAt).getTime()
      );
    }

    const merged = [...normalizedPropEntries, ...localEntries].sort(
      (a, b) => toDate(b.closedAt).getTime() - toDate(a.closedAt).getTime()
    );

    const seenIds = new Set<string>();
    const seenFingerprints = new Set<string>();
    const deduped: DailySalesHistoryEntry[] = [];

    merged.forEach((entry) => {
      if (seenIds.has(entry.id)) return;
      const fingerprint = getHistoryEntryFingerprint(entry);
      if (seenFingerprints.has(fingerprint)) return;
      seenIds.add(entry.id);
      seenFingerprints.add(fingerprint);
      deduped.push(entry);
    });

    return deduped;
  }, [dailySalesHistory]);

  const orderedHistory = useMemo<HistoryDrawerEntry[]>(() => {
    const historySalesByEntryId = new Map<string, Sale[]>();

    if (mergedDailySalesHistory.length > 0 && archivedSales.length > 0) {
      const sortedHistoryByClosedAt = [...mergedDailySalesHistory].sort(
        (a, b) => toDate(a.closedAt).getTime() - toDate(b.closedAt).getTime()
      );
      const sortedArchivedSales = [...archivedSales].sort(
        (a, b) => toDate(a.timestamp).getTime() - toDate(b.timestamp).getTime()
      );

      let saleIndex = 0;
      let lowerBoundMs = Number.NEGATIVE_INFINITY;

      sortedHistoryByClosedAt.forEach((entry) => {
        const upperBoundMs = toDate(entry.closedAt).getTime();
        const bucket: Sale[] = [];

        while (saleIndex < sortedArchivedSales.length) {
          const sale = sortedArchivedSales[saleIndex];
          const saleTimestampMs = toDate(sale.timestamp).getTime();

          if (saleTimestampMs <= lowerBoundMs) {
            saleIndex += 1;
            continue;
          }

          if (saleTimestampMs > upperBoundMs) break;

          bucket.push(sale);
          saleIndex += 1;
        }

        historySalesByEntryId.set(entry.id, bucket);
        lowerBoundMs = upperBoundMs;
      });
    }

    const explicitEntries: HistoryDrawerEntry[] = mergedDailySalesHistory.map((entry) => {
      const dayKey = getDayKey(entry.closedAt);
      const dayMappedSales = archiveSalesByDay.get(dayKey) || [];
      const timeMappedSales = historySalesByEntryId.get(entry.id) || [];
      return {
        entry,
        dayKey,
        sales: timeMappedSales.length > 0 ? timeMappedSales : dayMappedSales,
        inferred: false,
      };
    });

    const consumedSaleIds = new Set(
      explicitEntries.flatMap((item) => item.sales.map((sale) => sale.id))
    );
    const todayKey = getDayKey(new Date());
    const inferredEntries: HistoryDrawerEntry[] = [];

    archiveSalesByDay.forEach((daySales, dayKey) => {
      if (dayKey === todayKey) return;
      const unassignedDaySales = daySales.filter((sale) => !consumedSaleIds.has(sale.id));
      if (unassignedDaySales.length === 0) return;

      const totals = unassignedDaySales.reduce(
        (acc, sale) => ({
          totalRevenue: acc.totalRevenue + (Number.isFinite(sale.total) ? sale.total : 0),
          totalPurchases:
            acc.totalPurchases + (Number.isFinite(sale.totalCost) ? sale.totalCost : 0),
        }),
        { totalRevenue: 0, totalPurchases: 0 }
      );
      const latestTimestamp = unassignedDaySales.reduce(
        (latest: Date, sale) => {
          const saleDate = toDate(sale.timestamp);
          return saleDate.getTime() > latest.getTime() ? saleDate : latest;
        },
        toDate(unassignedDaySales[0]?.timestamp ?? new Date())
      );
      const totalRevenue = roundMoney(totals.totalRevenue);
      const totalPurchases = roundMoney(totals.totalPurchases);

      inferredEntries.push({
        dayKey,
        sales: unassignedDaySales,
        inferred: true,
        entry: {
          id: `legacy-history-${dayKey.replace(/[^0-9]/g, '')}`,
          closedAt: latestTimestamp,
          openingCash: 0,
          totalRevenue,
          totalPurchases,
          totalProfit: roundMoney(totalRevenue - totalPurchases),
          saleCount: unassignedDaySales.length,
          cashExpenses: 0,
        },
      });
    });

    return [...explicitEntries, ...inferredEntries].sort(
      (a, b) => toDate(b.entry.closedAt).getTime() - toDate(a.entry.closedAt).getTime()
    );
  }, [archiveSalesByDay, archivedSales, mergedDailySalesHistory]);

  const printReport = useCallback(
    (
      report: DailySalesHistoryEntry,
      reportSales: Sale[] = [],
      existingWindow?: Window | null,
      mode: ReportPrintMode = 'FULL'
    ) => {
      const printWindow =
        existingWindow && !existingWindow.closed
          ? existingWindow
          : window.open('', '_blank', 'width=420,height=980');
      if (!printWindow) return false;

      const isSummaryMode = mode === 'SUMMARY';
      const summaryPaperWidthMm = selectedHistoryPrintPreset.paperWidthMm || getReceiptPaperWidthMm();
      const summaryPageHeightMm = selectedHistoryPrintPreset.pageHeightMm;
      const fullPaperWidthMm = selectedCashPrintPreset.bodyWidthMm;
      const fullPageWidthMm = selectedCashPrintPreset.pageWidthMm;
      const fullPageHeightMm = selectedCashPrintPreset.pageHeightMm;
      const paperWidthMm = isSummaryMode ? summaryPaperWidthMm : fullPaperWidthMm;
      const pageWidthMm = isSummaryMode ? summaryPaperWidthMm : fullPageWidthMm;
      const pageHeightMm = isSummaryMode ? summaryPageHeightMm : fullPageHeightMm;
      const reportHorizontalPaddingMm = 2;
      const reportVerticalPaddingMm = isSummaryMode ? 2.5 : 2;
      const reportPadding = `${reportVerticalPaddingMm}mm ${reportHorizontalPaddingMm}mm`;
      // Use only the printable inner area so thermal text columns do not clip on paper edges.
      const reportContentWidthMm = Math.max(1, paperWidthMm - reportHorizontalPaddingMm * 2);
      const thermalColumns = isSummaryMode
        ? getThermalColumnsForPaperWidth(reportContentWidthMm)
        : selectedCashPrintPreset.id === DEFAULT_CASH_PRINT_PRESET_ID
          ? THERMAL_FULL_REPORT_COLUMNS
          : getThermalColumnsForPaperWidth(reportContentWidthMm);
      const reportFontSizePx = isSummaryMode ? 10 : 12;
      const reportLineHeight = isSummaryMode ? 1.25 : 1.35;
      const reportFontWeight = isSummaryMode ? 700 : 800;
      const leftInsetChars = isSummaryMode ? THERMAL_SUMMARY_LEFT_INSET_CHARS : 0;
      const contentColumns = Math.max(1, thermalColumns - leftInsetChars);
      const leftInset = ' '.repeat(leftInsetChars);
      const withLeftInset = (value: string): string =>
        `${leftInset}${fitThermalText(value, contentColumns)}`;
      const thermalSeparator = withLeftInset('-'.repeat(contentColumns));
      const align = (left: string, right = '') =>
        withLeftInset(alignThermalPair(left, right, contentColumns));
      const center = (value: string) => withLeftInset(centerThermalText(value, contentColumns));
      const wrap = (value: string) => wrapThermalText(value, contentColumns).map(withLeftInset);
      const closedAt = toDate(report.closedAt);
      const cashExpenses = roundMoney(Math.max(0, Number(report.cashExpenses) || 0));
      const estimatedCash = roundMoney(report.openingCash + report.totalRevenue - report.totalPurchases - cashExpenses);
      const orderedSales = [...reportSales].sort(
        (a, b) => toDate(a.timestamp).getTime() - toDate(b.timestamp).getTime()
      );
      const paymentSummarySales = isSummaryMode
        ? orderedSales.filter((sale) => !isAppSaleOrigin(sale.saleOrigin))
        : orderedSales;
      const paymentSummary = summarizePaymentMethods(paymentSummarySales);
      const paymentSummaryRows = [
        ...paymentSummary.rows,
        ...(paymentSummary.unclassifiedValue > 0
          ? [{ label: 'Nao informado', value: paymentSummary.unclassifiedValue }]
          : []),
      ].filter((row) => row.value > 0);
      const paymentTotal = roundMoney(
        paymentSummaryRows.reduce((sum, row) => sum + row.value, 0)
      );
      const appChannels = buildAppChannelSummary(orderedSales);
      const localRevenue = roundMoney(Math.max(0, report.totalRevenue - appChannels.totalRevenue));

      const productSummary = orderedSales.reduce<Record<string, { qty: number; revenue: number; cost: number }>>(
        (acc, sale) => {
          const key = sale.productName || 'Sem nome';
          if (!acc[key]) {
            acc[key] = { qty: 0, revenue: 0, cost: 0 };
          }
          acc[key].qty += 1;
          acc[key].revenue += Number(sale.total) || 0;
          acc[key].cost += Number(sale.totalCost) || 0;
          return acc;
        },
        {}
      );

      const reportLines: string[] = [];
      const pushWrappedLine = (value: string) => {
        wrap(value).forEach((line) => {
          reportLines.push(line);
        });
      };
      const closedDate = closedAt.toLocaleDateString('pt-BR');
      const closedTime = closedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

      if (mode === 'SUMMARY') {
        reportLines.push(center('VALORES DE FECHAMENTO'));
        reportLines.push(center('FECHAMENTO DE CAIXA'));
        reportLines.push(align(`Data: ${closedDate}`, `Hora: ${closedTime}`));
        reportLines.push(thermalSeparator);
        reportLines.push(align('Caixa inicial:', formatThermalCurrency(report.openingCash)));
        reportLines.push(align('Faturamento bruto:', formatThermalCurrency(report.totalRevenue)));
        reportLines.push(align('Compras (insumos):', formatThermalCurrency(report.totalPurchases)));
        reportLines.push(align('Saida de caixa:', formatThermalCurrency(cashExpenses)));
        reportLines.push(align('Resultado operacional:', formatThermalCurrency(report.totalProfit)));
        reportLines.push(align('Caixa estimado:', formatThermalCurrency(estimatedCash)));
        reportLines.push(align('Total de vendas:', String(report.saleCount)));
        reportLines.push(thermalSeparator);
        reportLines.push(center('VALORES INFORMADOS'));
        reportLines.push(thermalSeparator);

        if (paymentSummaryRows.length > 0) {
          paymentSummaryRows.forEach((row) => {
            reportLines.push(align(row.label, formatThermalCurrency(row.value)));
          });
          reportLines.push(thermalSeparator);
          reportLines.push(align('Total informado:', formatThermalCurrency(paymentTotal)));
        } else {
          pushWrappedLine('Sem valores por forma de pagamento neste fechamento.');
        }

        if (orderedSales.length > 0) {
          reportLines.push(thermalSeparator);
          reportLines.push(center('CANAIS DE VENDA'));
          reportLines.push(thermalSeparator);
          reportLines.push(align('Balcao', formatThermalCurrency(localRevenue)));
          APP_ORIGINS.forEach((origin) => {
            const row = appChannels.byOrigin[origin];
            if (row.revenue <= 0) return;
            reportLines.push(
              align(getSaleOriginLabel(origin), formatThermalCurrency(row.revenue))
            );
          });
        }
      } else {
        reportLines.push(center('RELATORIO DIARIO DE VENDAS'));
        reportLines.push(align(`Data: ${closedDate}`, `Hora: ${closedTime}`));
        reportLines.push(thermalSeparator);
        reportLines.push(align('Caixa Inicial:', formatThermalCurrency(report.openingCash)));
        reportLines.push(align('Faturamento:', formatThermalCurrency(report.totalRevenue)));
        reportLines.push(align('Compras (Insumos):', formatThermalCurrency(report.totalPurchases)));
        reportLines.push(align('Lucro:', formatThermalCurrency(report.totalProfit)));
        reportLines.push(align('Pedidos:', String(report.saleCount)));
        reportLines.push(align('Saida de Caixa:', formatThermalCurrency(cashExpenses)));
        reportLines.push(align('Caixa Estimado:', formatThermalCurrency(estimatedCash)));
        reportLines.push(thermalSeparator);
        reportLines.push(center('FORMA PAGAMENTO'));

        if (orderedSales.length > 0) {
          paymentSummary.rows.forEach((row) => {
            reportLines.push(align(row.label, formatThermalCurrency(row.value)));
          });
          if (paymentSummary.unclassifiedValue > 0) {
            reportLines.push(
              align('Nao informado', formatThermalCurrency(paymentSummary.unclassifiedValue))
            );
          }
        } else {
          pushWrappedLine('Sem detalhamento de vendas para pagamento.');
        }

        reportLines.push(thermalSeparator);

        if (orderedSales.length > 0) {
          reportLines.push(center('RESUMO POR PRODUTO'));
          reportLines.push(thermalSeparator);
          Object.entries(productSummary)
            .sort((a, b) => b[1].qty - a[1].qty || b[1].revenue - a[1].revenue)
            .forEach(([productName, row]) => {
              const profit = row.revenue - row.cost;
              wrap(productName).forEach((line) => {
                reportLines.push(line);
              });
              reportLines.push(align(`Qtd: ${row.qty}`, `Fat: ${formatThermalCurrency(row.revenue)}`));
              reportLines.push(align(`Cmp: ${formatThermalCurrency(row.cost)}`, `Luc: ${formatThermalCurrency(profit)}`));
              reportLines.push(thermalSeparator);
            });

          reportLines.push(center('VENDAS REGISTRADAS'));
          reportLines.push(thermalSeparator);

          orderedSales.forEach((sale, index) => {
            const saleDate = toDate(sale.timestamp);
            const saleHour = saleDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            const saleTotal = Number(sale.total) || 0;
            const saleCost = Number(sale.totalCost) || 0;
            const saleProfit = saleTotal - saleCost;
            const paymentMethod = (sale.payment?.method || 'NAO INFORMADO').toUpperCase();
            const saleOrigin = getSaleOriginLabel(sale.saleOrigin).toUpperCase();
            const appOrderValue = Number(sale.appOrderTotal);
            const appOrderLabel =
              isAppSaleOrigin(sale.saleOrigin) && Number.isFinite(appOrderValue) && appOrderValue > 0
                ? formatThermalCurrency(appOrderValue)
                : '';

            reportLines.push(align(`#${String(index + 1).padStart(3, '0')} ${saleHour}`, paymentMethod));
            wrap(sale.productName || 'Sem nome').forEach((line) => {
              reportLines.push(line);
            });
            reportLines.push(align(`Canal: ${saleOrigin}`, appOrderLabel ? `App: ${appOrderLabel}` : ''));
            reportLines.push(align(`Fat: ${formatThermalCurrency(saleTotal)}`, `Cmp: ${formatThermalCurrency(saleCost)}`));
            reportLines.push(align('Lucro:', formatThermalCurrency(saleProfit)));
            reportLines.push(thermalSeparator);
          });
        } else {
          reportLines.push(center('DETALHAMENTO DE VENDAS'));
          reportLines.push(thermalSeparator);
          pushWrappedLine('Este relatorio nao possui vendas detalhadas.');
          reportLines.push(thermalSeparator);
        }
      }

      reportLines.push('');
      reportLines.push(center('FIM DO RELATORIO'));
      reportLines.push('');

      const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Relatório Diário</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #fff;
    }
    body {
      width: ${paperWidthMm}mm;
      max-width: ${paperWidthMm}mm;
      font-family: 'Courier New', Courier, monospace;
      font-size: ${reportFontSizePx}px;
      line-height: ${reportLineHeight};
      font-weight: ${reportFontWeight};
      color: #000;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .report {
      width: ${paperWidthMm}mm;
      max-width: ${paperWidthMm}mm;
      padding: ${reportPadding};
    }
    pre {
      margin: 0;
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      font-weight: inherit;
      white-space: pre;
      letter-spacing: 0;
    }
    @page {
      size: ${pageWidthMm}mm ${pageHeightMm ? `${pageHeightMm}mm` : 'auto'};
      margin: 0;
    }
    @media screen {
      body {
        margin: 10px auto;
        box-shadow: 0 0 0 1px #e2e8f0;
      }
    }
    @media print {
      html, body {
        width: ${paperWidthMm}mm;
        max-width: ${paperWidthMm}mm;
      }
    }
  </style>
</head>
<body>
  <div class="report">
    <pre>${escapeHtml(reportLines.join('\n'))}</pre>
  </div>
</body>
</html>`;

      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      window.setTimeout(() => {
        if (printWindow.closed) return;
        printWindow.focus();
        printWindow.print();
      }, 120);
      return true;
    },
    [selectedCashPrintPreset, selectedHistoryPrintPreset]
  );

  const handleSaleClick = (e: React.MouseEvent<HTMLButtonElement>, saleId: string) => {
    if (selectedSaleId === saleId) {
      setSelectedSaleId(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const isMobile = window.innerWidth < 1024;
    if (isMobile) {
      setPopoverStyle({
        position: 'fixed',
        top: `${rect.bottom + 8}px`,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'calc(100% - 2rem)',
        maxWidth: '400px',
      });
    } else {
      setPopoverStyle({ position: 'fixed', top: `${rect.top}px`, left: `${rect.left - 300}px`, width: '280px' });
    }
    setSelectedSaleId(saleId);
  };

  const commitCashRegister = useCallback(async () => {
    const parsed = parseMoneyInput(cashInput);
    if (parsed === null) {
      setCashInput(cashRegisterAmount.toFixed(2));
      return;
    }

    const normalized = Math.max(0, Number(parsed.toFixed(2)));
    setCashInput(normalized.toFixed(2));

    if (Math.abs(normalized - cashRegisterAmount) < 0.009) return;
    await onSetCashRegister?.(normalized);
  }, [cashInput, cashRegisterAmount, onSetCashRegister]);

  const registerCashPurchase = useCallback(async () => {
    const parsedAmount = parseMoneyInput(cashPurchaseAmountInput);
    if (parsedAmount === null || parsedAmount <= 0) {
      alert('Informe o valor retirado do caixa.');
      return;
    }

    const normalizedAmount = Number(parsedAmount.toFixed(2));
    let ok: boolean | undefined = false;
    if (cashPurchaseType === 'OTHER') {
      if (!onRegisterCashExpense) return;
      const purchaseDescription = cashPurchaseDescription.trim();
      if (!purchaseDescription) {
        alert('Escreva o que foi comprado.');
        return;
      }
      ok = await onRegisterCashExpense(normalizedAmount, purchaseDescription);
    } else {
      if (!onRegisterCashPurchase) return;
      if (!cashPurchaseIngredientId) {
        alert('Selecione o insumo comprado.');
        return;
      }
      ok = await onRegisterCashPurchase(cashPurchaseIngredientId, normalizedAmount);
    }

    if (ok === false) return;
    setCashPurchaseAmountInput('');
    setCashPurchaseDescription('');
  }, [
    cashPurchaseAmountInput,
    cashPurchaseDescription,
    cashPurchaseIngredientId,
    cashPurchaseType,
    onRegisterCashExpense,
    onRegisterCashPurchase,
  ]);

  const revertCashExpenseEntry = useCallback(
    async (entryId: string) => {
      if (!onRevertCashExpense) return;
      if (revertingEntryId) return;

      setRevertingEntryId(entryId);
      try {
        await onRevertCashExpense(entryId);
      } finally {
        setRevertingEntryId(null);
      }
    },
    [onRevertCashExpense, revertingEntryId]
  );

  const handleRestart = async () => {
    if (isClosing) return;
    if (!confirm('Deseja realmente encerrar o dia? O caixa será zerado para uma nova sessão.')) return;
    const reportSnapshot: DailySalesHistoryEntry = {
      ...currentDayReport,
      closedAt: new Date(),
    };
    const salesSnapshot = [...sales];
    const deferredPrintWindow = window.open('', '_blank', 'width=420,height=980');

    setIsClosing(true);
    try {
      const closed = await onCloseDay?.();
      if (closed === false) {
        if (deferredPrintWindow && !deferredPrintWindow.closed) {
          deferredPrintWindow.close();
        }
        return;
      }
      setSelectedSaleId(null);
      printReport(reportSnapshot, salesSnapshot, deferredPrintWindow);
    } finally {
      setIsClosing(false);
    }
  };

  useEffect(() => {
    const handleClose = () => setSelectedSaleId(null);
    window.addEventListener('resize', handleClose);
    const listElement = listRef.current;
    if (listElement) listElement.addEventListener('scroll', handleClose);
    return () => {
      window.removeEventListener('resize', handleClose);
      if (listElement) listElement.removeEventListener('scroll', handleClose);
    };
  }, [selectedSaleId]);

  const selectedSale = sales.find((s) => s.id === selectedSaleId);
  const stockOutEntries = stockEntries.filter((entry) => entry.quantity < 0);
  const ingredientsById = new Map<string, Ingredient>(
    allIngredients.map((ingredient): [string, Ingredient] => [ingredient.id, ingredient])
  );
  const formatQuantity = (value: number) =>
    Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
  const selectedAdjustment =
    selectedSale?.priceAdjustment ??
    (selectedSale?.basePrice !== undefined ? selectedSale.total - selectedSale.basePrice : 0);
  const hasPriceAdjustment = selectedSale !== undefined && Math.abs(selectedAdjustment) > 0.009;
  const basePrice = selectedSale?.basePrice;
  const baseCost = selectedSale?.baseCost;
  const costAdjustment =
    selectedSale && baseCost !== undefined ? selectedSale.totalCost - baseCost : undefined;

  return (
    <div
      className={`qb-sales p-4 sm:p-6 max-w-5xl mx-auto space-y-6 relative transition-all duration-700 ease-in-out ${
        isClosing ? 'scale-95 opacity-0 blur-xl grayscale pointer-events-none' : 'opacity-100 scale-100'
      }`}
    >
      <div className="qb-sales-header flex flex-col gap-4 lg:flex-row lg:justify-between lg:items-center">
        <div>
          <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">RELATÓRIO DO DIA</h2>
          <p className="text-xs font-bold text-slate-400">Resumo operacional da sessão atual.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setHistoryVisible((current) => !current)}
            className="qb-btn-touch bg-white text-slate-800 px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest shadow-sm border border-slate-200 hover:border-red-400 hover:text-red-600 transition-all active:scale-95"
          >
            {historyVisible ? 'Fechar Histórico' : 'Histórico de Fechamentos'}
          </button>
          <button
            onClick={handleRestart}
            disabled={isClosing}
            className={`qb-btn-touch qb-sales-restart bg-slate-900 text-yellow-400 px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl transition-all active:scale-95 flex items-center gap-2 group ${
              isClosing ? 'opacity-50' : 'hover:bg-black'
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`${isClosing ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`}
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {isClosing ? 'ENCERRANDO...' : 'Fechar Dia / Reiniciar'}
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-2 inline-flex gap-2 w-full sm:w-auto">
        <button
          onClick={() => setActiveTab('REPORT')}
          className={`qb-btn-touch px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all ${
            activeTab === 'REPORT'
              ? 'bg-red-600 text-white shadow-lg shadow-red-200'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Relatório
        </button>
        <button
          onClick={() => setActiveTab('CASH')}
          className={`qb-btn-touch px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all ${
            activeTab === 'CASH'
              ? 'bg-red-600 text-white shadow-lg shadow-red-200'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Caixa
        </button>
      </div>

      {historyVisible && (
        <>
          <button
            type="button"
            aria-label="Fechar histórico"
            onClick={() => setHistoryVisible(false)}
            className="fixed inset-0 z-[240] bg-transparent"
          />
          <aside className="fixed inset-y-0 right-0 z-[250] w-full sm:max-w-[500px] h-screen max-h-screen overflow-hidden bg-white border-l-2 border-slate-200 shadow-2xl p-5 sm:p-6 flex flex-col min-h-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-black uppercase tracking-tight text-slate-800">Histórico de Fechamentos</h3>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  {orderedHistory.length} registro(s)
                </p>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Modelo: {selectedHistoryPrintPreset.label}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setHistoryPrintSettingsOpen((current) => !current)}
                  className="qb-btn-touch bg-slate-100 text-slate-700 p-2 rounded-xl hover:bg-slate-200 transition-colors"
                  title="Modelos de impressão"
                  aria-label="Abrir modelos de impressão"
                  aria-expanded={historyPrintSettingsOpen}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.6 1.6 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.6 1.6 0 0 0-1.82-.33 1.6 1.6 0 0 0-1 1.46V21a2 2 0 0 1-4 0v-.09a1.6 1.6 0 0 0-1-1.46 1.6 1.6 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.6 1.6 0 0 0 .33-1.82 1.6 1.6 0 0 0-1.46-1H3a2 2 0 0 1 0-4h.09a1.6 1.6 0 0 0 1.46-1 1.6 1.6 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.6 1.6 0 0 0 1.82.33h.01a1.6 1.6 0 0 0 1-1.46V3a2 2 0 0 1 4 0v.09a1.6 1.6 0 0 0 1 1.46h.01a1.6 1.6 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.6 1.6 0 0 0-.33 1.82v.01a1.6 1.6 0 0 0 1.46 1H21a2 2 0 0 1 0 4h-.09a1.6 1.6 0 0 0-1.46 1z" />
                  </svg>
                </button>
                <button
                  onClick={() => setHistoryVisible(false)}
                  className="qb-btn-touch bg-slate-100 text-slate-700 p-2 rounded-xl hover:bg-slate-200 transition-colors"
                  title="Fechar histórico"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              </div>
            </div>
            {historyPrintSettingsOpen && (
              <div className="mt-4 bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Modelos de impressão
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {HISTORY_PRINT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setHistoryPrintPresetId(preset.id);
                        setHistoryPrintSettingsOpen(false);
                      }}
                      className={`qb-btn-touch border rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
                        historyPrintPresetId === preset.id
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-5 flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 scrollbar-hide space-y-3">
              {orderedHistory.length === 0 ? (
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Nenhum fechamento registrado ainda.
                </p>
              ) : (
                orderedHistory.map(({ entry, sales: historySales, inferred }) => {
                  const entryDate = toDate(entry.closedAt);
                  const entryCashExpenses = roundMoney(Math.max(0, Number(entry.cashExpenses) || 0));
                  const entryEstimatedCash =
                    entry.openingCash + entry.totalRevenue - entry.totalPurchases - entryCashExpenses;
                  return (
                    <div
                      key={entry.id}
                      className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col gap-3"
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-black uppercase text-slate-800">
                          {entryDate.toLocaleDateString('pt-BR')}
                        </p>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                          Fechado em {entryDate.toLocaleString('pt-BR')}
                        </p>
                        {inferred && (
                          <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                            Histórico antigo (recuperado das vendas arquivadas)
                          </p>
                        )}
                        <p className="text-[11px] font-bold text-slate-700">
                          Faturamento: {formatCurrency(entry.totalRevenue)} | Compras: {formatCurrency(entry.totalPurchases)} | Caixa: {formatCurrency(entryEstimatedCash)}
                        </p>
                        {entryCashExpenses > 0 && (
                          <p className="text-[11px] font-black text-amber-700 uppercase tracking-widest">
                            Saída no caixa do dia: {formatCurrency(entryCashExpenses)}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          printReport(entry, historySales, undefined, 'SUMMARY');
                        }}
                        className="qb-btn-touch bg-slate-900 text-white px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-black transition-colors w-full sm:w-auto sm:self-end"
                      >
                        Imprimir
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        </>
      )}

      {activeTab === 'CASH' && (
        <div className="bg-white border-2 border-slate-100 rounded-3xl shadow-sm p-6 space-y-5">
          <div className="space-y-1">
            <h3 className="text-lg font-black uppercase tracking-tight text-slate-800">Aba Caixa</h3>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">
              Informe o valor atual de caixa para o fechamento diário.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">Valor do Caixa</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashInput}
                onChange={(e) => setCashInput(e.target.value)}
                onBlur={() => {
                  void commitCashRegister();
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void commitCashRegister();
                }}
                className="w-full bg-white border border-slate-300 rounded-xl px-3 py-3 font-black text-slate-800"
              />
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Esse valor será usado no relatório ao fechar o dia.
              </p>
            </div>
            <div className="bg-slate-900 text-white rounded-2xl p-4 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Prévia do dia</p>
              <p className="text-sm font-black">Faturamento: {formatCurrency(totalRevenue)}</p>
              <p className="text-sm font-black">Compras: {formatCurrency(totalCost)}</p>
              <p className="text-sm font-black">Lucro: {formatCurrency(totalProfit)}</p>
              <p className="text-sm font-black text-amber-300">
                Retiradas do caixa: -{formatCurrency(cashRegisterExpenses)}
              </p>
              <p className="text-sm font-black text-yellow-300">
                Caixa estimado: {formatCurrency(estimatedClosingCash)}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-300">
                  Modelo: {selectedCashPrintPreset.label}
                </p>
                <button
                  type="button"
                  onClick={() => setCashPrintSettingsOpen((current) => !current)}
                  className="qb-btn-touch bg-slate-800 text-slate-100 p-2 rounded-xl hover:bg-slate-700 transition-colors"
                  title="Modelos de impressão"
                  aria-label="Abrir modelos de impressão do caixa"
                  aria-expanded={cashPrintSettingsOpen}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.6 1.6 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.6 1.6 0 0 0-1.82-.33 1.6 1.6 0 0 0-1 1.46V21a2 2 0 0 1-4 0v-.09a1.6 1.6 0 0 0-1-1.46 1.6 1.6 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.6 1.6 0 0 0 .33-1.82 1.6 1.6 0 0 0-1.46-1H3a2 2 0 0 1 0-4h.09a1.6 1.6 0 0 0 1.46-1 1.6 1.6 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.6 1.6 0 0 0 1.82.33h.01a1.6 1.6 0 0 0 1-1.46V3a2 2 0 0 1 4 0v.09a1.6 1.6 0 0 0 1 1.46h.01a1.6 1.6 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.6 1.6 0 0 0-.33 1.82v.01a1.6 1.6 0 0 0 1.46 1H21a2 2 0 0 1 0 4h-.09a1.6 1.6 0 0 0-1.46 1z" />
                  </svg>
                </button>
              </div>
              {cashPrintSettingsOpen && (
                <div className="mt-2 bg-slate-800 border border-slate-700 rounded-2xl p-3 space-y-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-300">
                    Modelos de impressão
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {CASH_PRINT_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setCashPrintPresetId(preset.id);
                          setCashPrintSettingsOpen(false);
                        }}
                        className={`qb-btn-touch border rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
                          cashPrintPresetId === preset.id
                            ? 'bg-white text-slate-900 border-white'
                            : 'bg-slate-900 text-slate-100 border-slate-600 hover:border-slate-300'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={() => {
                  printReport(currentDayReport, sales);
                }}
                className="qb-btn-touch mt-3 bg-white text-slate-900 px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest"
              >
                Imprimir Relatório do Dia
              </button>
            </div>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">
              Registrar retirada do caixa
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-2">
              <select
                value={cashPurchaseType}
                onChange={(e) => setCashPurchaseType(e.target.value as CashPurchaseType)}
                className="bg-white border border-amber-200 rounded-xl px-3 py-2 text-xs font-black text-slate-800"
              >
                <option value="INGREDIENT">Insumo</option>
                <option value="OTHER">Outros</option>
              </select>
              {cashPurchaseType === 'INGREDIENT' ? (
                <select
                  value={cashPurchaseIngredientId}
                  onChange={(e) => setCashPurchaseIngredientId(e.target.value)}
                  className="bg-white border border-amber-200 rounded-xl px-3 py-2 text-xs font-black text-slate-800"
                >
                  <option value="">Selecione o insumo</option>
                  {allIngredients.map((ingredient) => (
                    <option key={ingredient.id} value={ingredient.id}>
                      {ingredient.name} ({ingredient.unit})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="bg-white border border-amber-200 rounded-xl px-3 py-2 text-xs font-black text-slate-500 uppercase tracking-widest flex items-center">
                  Tipo: Outros
                </div>
              )}
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashPurchaseAmountInput}
                onChange={(e) => setCashPurchaseAmountInput(e.target.value)}
                placeholder="Valor retirado (R$)"
                className="bg-white border border-amber-200 rounded-xl px-3 py-2 text-xs font-black text-slate-800"
              />
              <button
                onClick={() => {
                  void registerCashPurchase();
                }}
                className="qb-btn-touch bg-amber-600 text-white px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-amber-700"
              >
                Registrar Compra
              </button>
            </div>
            {cashPurchaseType === 'OTHER' && (
              <input
                type="text"
                value={cashPurchaseDescription}
                onChange={(e) => setCashPurchaseDescription(e.target.value)}
                placeholder="O que foi comprado"
                className="w-full bg-white border border-amber-200 rounded-xl px-3 py-2 text-xs font-black text-slate-800"
              />
            )}
            {cashPurchaseType === 'INGREDIENT' &&
              selectedCashPurchaseIngredient &&
              estimatedCashPurchaseStockIncrease !== null && (
              <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                Estoque estimado de entrada: {estimatedCashPurchaseStockIncrease.toFixed(3)} {selectedCashPurchaseIngredient.unit}
              </p>
            )}
          </div>
          {cashRegisterExpenseEntries.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                Retiradas pagas com caixa (sessão)
              </p>
              <div className="max-h-48 overflow-y-auto pr-1 space-y-2">
                {cashRegisterExpenseEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="bg-white border border-amber-100 rounded-xl px-3 py-2 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-black uppercase text-slate-800 truncate">
                        {entry.purchaseDescription || entry.ingredientName}
                      </p>
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 truncate">
                        {entry.ingredientId === 'cash-expense' || entry.quantity === 0
                          ? 'Tipo: Outros'
                          : `Insumo: ${entry.ingredientName}`}
                      </p>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        {toDate(entry.timestamp).toLocaleString('pt-BR')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <p className="text-xs font-black text-amber-700">
                        -{formatCurrency(Math.abs(Number(entry.cashRegisterImpact) || 0))}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          void revertCashExpenseEntry(entry.id);
                        }}
                        disabled={revertingEntryId !== null}
                        className="qb-btn-touch bg-emerald-100 text-emerald-800 border border-emerald-200 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-emerald-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Reverter retirada e devolver valor ao caixa"
                      >
                        {revertingEntryId === entry.id ? 'Revertendo...' : 'Reverter'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'REPORT' && (
        <>
          <div className="qb-sales-stats flex flex-nowrap gap-4 overflow-x-auto pb-1">
            <div className="qb-sales-stat-card bg-red-600 text-white p-6 rounded-3xl shadow-lg">
              <p className="text-[10px] font-bold uppercase tracking-widest opacity-80 mb-1">Faturamento (sem Apps)</p>
              <h4 className="text-3xl font-black">{formatCurrency(reportRevenueExcludingApps)}</h4>
            </div>
            <div className="qb-sales-stat-card bg-slate-800 text-white p-6 rounded-3xl shadow-lg">
              <p className="text-[10px] font-bold uppercase tracking-widest opacity-80 mb-1">Compras (Insumos)</p>
              <h4 className="text-3xl font-black">{formatCurrency(totalCost)}</h4>
            </div>
            <div className="qb-sales-stat-card bg-green-600 text-white p-6 rounded-3xl shadow-lg">
              <p className="text-[10px] font-bold uppercase tracking-widest opacity-80 mb-1">Lucro</p>
              <h4 className="text-3xl font-black">{formatCurrency(totalProfit)}</h4>
            </div>
            <div className="qb-sales-stat-card bg-white p-6 rounded-3xl border-2 border-slate-100 shadow-sm">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Pedidos</p>
              <h4 className="text-3xl font-black text-slate-800">{sales.length}</h4>
            </div>
          </div>
          {appOriginRows.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                Canais de App com venda
              </p>
              <div className="qb-sales-stats qb-sales-app-stats flex flex-nowrap gap-4 overflow-x-auto pb-1">
                {appOriginRows.map((row) => {
                  const style = APP_ORIGIN_STYLE[row.origin];
                  return (
                    <div
                      key={row.origin}
                      className={`qb-sales-stat-card qb-sales-app-card ${
                        appOriginRows.length === 1 ? 'qb-sales-app-card-single' : ''
                      } p-6 rounded-3xl shadow-lg ${style.card}`}
                    >
                      <p className="text-[10px] font-bold uppercase tracking-widest opacity-80 mb-1">{row.label}</p>
                      <h4 className="text-3xl font-black">{formatCurrency(row.revenue)}</h4>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="qb-sales-main grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <div className="qb-sales-chart-card bg-white p-6 rounded-3xl border-2 border-slate-100 shadow-sm">
              <h3 className="text-lg font-black text-slate-800 mb-6 uppercase tracking-tight">Vendas por Produto</h3>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                    <XAxis type="number" hide />
                    <YAxis
                      dataKey="name"
                      type="category"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12, fontWeight: 700, fill: '#475569' }}
                      width={100}
                    />
                    <Tooltip
                      cursor={{ fill: '#f8fafc' }}
                      contentStyle={{
                        borderRadius: '12px',
                        border: 'none',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                      }}
                    />
                    <Bar dataKey="vendas" radius={[0, 4, 4, 0]}>
                      {chartData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="qb-sales-side space-y-6">
              <div className="qb-sales-list-card bg-white p-6 rounded-3xl border-2 border-slate-100 shadow-sm flex flex-col h-[450px]">
                <h3 className="text-lg font-black text-slate-800 mb-6 uppercase tracking-tight">Últimos Lançamentos</h3>
                <div ref={listRef} className="qb-sales-list-content flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-hide">
                  {sales.slice().reverse().map((sale) => (
                    <button
                      key={sale.id}
                      onClick={(e) => handleSaleClick(e, sale.id)}
                      className={`qb-btn-touch qb-sales-list-item w-full text-left flex items-center justify-between p-4 rounded-2xl border transition-all active:scale-[0.98] ${
                        selectedSaleId === sale.id
                          ? 'bg-red-600 border-red-700 shadow-lg text-white ring-4 ring-red-100'
                          : 'bg-slate-50 border-slate-100 hover:border-red-400 hover:bg-white'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center font-black ${
                            selectedSaleId === sale.id
                              ? 'bg-white text-red-600'
                              : 'bg-white text-red-600 shadow-sm border border-slate-100'
                          }`}
                        >
                          {sale.productName.charAt(0)}
                        </div>
                        <div>
                          <p
                            className={`font-black text-sm truncate max-w-[120px] uppercase tracking-tighter ${
                              selectedSaleId === sale.id ? 'text-white' : 'text-slate-800'
                            }`}
                          >
                            {sale.productName}
                          </p>
                          <p
                            className={`text-[10px] font-bold uppercase tracking-widest ${
                              selectedSaleId === sale.id ? 'text-red-200' : 'text-slate-400'
                            }`}
                          >
                            {toDate(sale.timestamp).toLocaleTimeString()}
                          </p>
                          <p
                            className={`text-[9px] font-black uppercase tracking-widest ${
                              selectedSaleId === sale.id ? 'text-blue-100' : 'text-blue-500'
                            }`}
                          >
                            {getSaleOriginLabel(sale.saleOrigin)}
                            {isAppSaleOrigin(sale.saleOrigin) &&
                              Number.isFinite(Number(sale.appOrderTotal)) &&
                              ` • App R$ ${(Number(sale.appOrderTotal) || 0).toFixed(2)}`}
                          </p>
                          {sale.priceAdjustment !== undefined && Math.abs(sale.priceAdjustment) > 0.009 && (
                            <p
                              className={`text-[9px] font-black uppercase tracking-widest ${
                                selectedSaleId === sale.id ? 'text-yellow-200' : 'text-yellow-500'
                              }`}
                            >
                              Ajuste {sale.priceAdjustment > 0 ? '+' : '-'}R$ {Math.abs(sale.priceAdjustment).toFixed(2)}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`font-black text-sm ${selectedSaleId === sale.id ? 'text-white' : 'text-slate-900'}`}>
                          {formatCurrency(sale.total)}
                        </p>
                      </div>
                    </button>
                  ))}
                  {sales.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full py-24 text-slate-300">
                      <p className="font-black uppercase tracking-widest text-xs">Caixa Aberto / Sem Vendas</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="qb-sales-stock-card bg-white p-6 rounded-3xl border-2 border-slate-100 shadow-sm flex flex-col h-[320px]">
                <h3 className="text-lg font-black text-slate-800 mb-6 uppercase tracking-tight">Saídas de Estoque</h3>
                <div className="qb-sales-stock-content flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-hide">
                  {stockOutEntries.slice().reverse().map((entry) => {
                    const ingredient = ingredientsById.get(entry.ingredientId);
                    const unit = ingredient?.unit || '';
                    const quantityLabel = formatStockQuantityByUnit(unit, Math.abs(entry.quantity));

                    return (
                      <div key={entry.id} className="w-full flex items-center justify-between p-4 rounded-2xl border border-slate-100 bg-slate-50">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl flex items-center justify-center font-black bg-red-100 text-red-600">
                            -
                          </div>
                          <div>
                            <p className="font-black text-sm uppercase tracking-tighter text-slate-800">
                              {entry.ingredientName}
                            </p>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                              {toDate(entry.timestamp).toLocaleTimeString()}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="font-black text-sm text-red-600">
                            -{quantityLabel}
                            {unit ? ` ${unit}` : ''}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                  {stockOutEntries.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full py-16 text-slate-300">
                      <p className="font-black uppercase tracking-widest text-xs">Sem Baixas no Estoque</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {selectedSale && (
            <div style={popoverStyle} className="qb-sales-popover bg-slate-900 text-white p-5 rounded-[32px] shadow-[0_30px_60px_rgba(0,0,0,0.6)] z-[9999] animate-in fade-in zoom-in-95 slide-in-from-right-4 duration-200 border border-slate-700 border-t-red-600 border-t-4 pointer-events-auto">
              <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <div className="bg-red-600 p-1 rounded-lg">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v10" /><path d="M18.4 6.9 12 12" /><path d="m5.6 6.9 6.4 5.1" /></svg>
                  </div>
                  <h4 className="text-[10px] font-black uppercase text-red-400 tracking-widest">Insumos</h4>
                </div>
                <button onClick={() => setSelectedSaleId(null)} className="text-slate-500 hover:text-white transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              </div>
              <div className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1 scrollbar-hide">
                {selectedSale.recipe?.map((item) => {
                  const ing = allIngredients.find((i) => i.id === item.ingredientId);
                  const recipeUnitLabel = ing ? getRecipeQuantityUnitLabel(ing, item.quantity) : '';
                  return (
                    <div key={item.ingredientId} className="flex justify-between items-center p-2.5 bg-slate-800/80 rounded-xl border border-slate-700/30 text-[10px]">
                      <span className="font-bold text-slate-100 uppercase truncate max-w-[140px]">{ing ? ing.name : 'Insumo'}</span>
                      <span className="font-black text-yellow-400">{formatQuantity(item.quantity)} {recipeUnitLabel}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 pt-3 border-t border-slate-800 space-y-1 text-[10px] font-black uppercase tracking-widest">
                <div className="flex items-center justify-between text-slate-300">
                  <span>Pagamento</span>
                  <span>{selectedSale.payment?.method || '--'}</span>
                </div>
                <div className="flex items-center justify-between text-blue-300">
                  <span>Canal</span>
                  <span>{getSaleOriginLabel(selectedSale.saleOrigin)}</span>
                </div>
                {isAppSaleOrigin(selectedSale.saleOrigin) &&
                  Number.isFinite(Number(selectedSale.appOrderTotal)) && (
                    <div className="flex items-center justify-between text-amber-300">
                      <span>Valor app</span>
                      <span>R$ {(Number(selectedSale.appOrderTotal) || 0).toFixed(2)}</span>
                    </div>
                  )}
              </div>
              <div className="mt-5 pt-3 border-t border-slate-800 flex justify-between items-center">
                <div><p className="text-[8px] font-bold text-slate-500 uppercase">Custo</p><p className="text-sm font-black text-slate-100">{formatCurrency(selectedSale.totalCost)}</p></div>
                <div className="text-right"><p className="text-[8px] font-bold text-green-500 uppercase">Lucro</p><p className="text-sm font-black text-green-500">{formatCurrency(selectedSale.total - selectedSale.totalCost)}</p></div>
              </div>
              {(basePrice !== undefined || baseCost !== undefined || hasPriceAdjustment) && (
                <div className="mt-3 pt-3 border-t border-slate-800 space-y-1.5 text-[10px] uppercase font-bold">
                  {basePrice !== undefined && (
                    <div className="flex justify-between text-slate-300">
                      <span>Preço Base</span>
                      <span>{formatCurrency(basePrice)}</span>
                    </div>
                  )}
                  {hasPriceAdjustment && (
                    <div className="flex justify-between text-yellow-400">
                      <span>Ajuste no Preço</span>
                      <span>{selectedAdjustment > 0 ? '+' : '-'}R$ {Math.abs(selectedAdjustment).toFixed(2)}</span>
                    </div>
                  )}
                  {costAdjustment !== undefined && Math.abs(costAdjustment) > 0.009 && (
                    <div className="flex justify-between text-slate-400">
                      <span>Ajuste de Custo</span>
                      <span>{costAdjustment > 0 ? '+' : '-'}R$ {Math.abs(costAdjustment).toFixed(2)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default SalesSummary;
