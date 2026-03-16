
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CleaningMaterial,
  CleaningStockEntry,
  DailySalesHistoryEntry,
  Ingredient,
  Product,
  Sale,
  SaleOrigin,
  SalePaymentMethod,
  StockEntry,
} from '../types';
import { APP_ORIGINS, buildAppChannelSummary } from '../utils/appChannelSummary';
import { DASHBOARD_CHART_COLORS, DASHBOARD_TOOLTIP_STYLE } from '../utils/chartTheme';
import { formatIngredientStockQuantity, formatStockQuantityByUnit } from '../utils/recipe';
import AdminSalesAnalyticsTab from './AdminSalesAnalyticsTab';

interface AdminDashboardProps {
  sales: Sale[];
  cancelledSales: Sale[];
  stockEntries: StockEntry[];
  sessionStockEntries: StockEntry[];
  allProducts: Product[];
  allIngredients: Ingredient[];
  cleaningMaterials: CleaningMaterial[];
  cleaningStockEntries: CleaningStockEntry[];
  onFactoryReset: () => void;
  onClearOperationalData: () => void;
  onClearOnlyStock: () => void;
  onDeleteArchiveDate: (date: string) => void;
  onDeleteArchiveMonth: (month: string) => void;
  cashRegisterAmount: number;
  dailySalesHistory: DailySalesHistoryEntry[];
}

const paymentMethodLabels: Record<SalePaymentMethod, string> = {
  PIX: 'PIX',
  DEBITO: 'Débito',
  CREDITO: 'Crédito',
  DINHEIRO: 'Dinheiro',
  DIVIDIDO: 'Dividido',
};

const paymentMethodBadgeClasses: Record<SalePaymentMethod, string> = {
  PIX: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  DEBITO: 'bg-blue-100 text-blue-700 border-blue-200',
  CREDITO: 'bg-violet-100 text-violet-700 border-violet-200',
  DINHEIRO: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  DIVIDIDO: 'bg-orange-100 text-orange-700 border-orange-200',
};

const saleOriginLabels: Record<SaleOrigin, string> = {
  LOCAL: 'Balcão',
  IFOOD: 'iFood',
  APP99: '99',
  KEETA: 'Keeta',
};

const saleOriginBadgeClasses: Record<SaleOrigin, string> = {
  LOCAL: 'bg-slate-100 text-slate-700 border-slate-200',
  IFOOD: 'bg-red-100 text-red-700 border-red-200',
  APP99: 'bg-amber-100 text-amber-700 border-amber-200',
  KEETA: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};

const renderPaymentMethodBadge = (sale: Sale) => {
  const method = sale.payment?.method;
  if (!method) {
    return (
      <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-slate-500">
        Não informado
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${paymentMethodBadgeClasses[method]}`}
    >
      {paymentMethodLabels[method]}
    </span>
  );
};

const renderSaleOriginBadge = (sale: Sale) => {
  const origin = sale.saleOrigin || 'LOCAL';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${saleOriginBadgeClasses[origin]}`}
    >
      {saleOriginLabels[origin]}
    </span>
  );
};

const toDate = (value: Date | string): Date => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
};

const roundMoney = (value: number): number => Number(value.toFixed(2));
const LEGACY_COST_RATIO_MAX = 3.5;
const LEGACY_COST_RATIO_TARGET = 0.45;
const LEGACY_COST_DIVISORS = [1, 10, 100, 1000] as const;

const normalizeLegacySaleCost = (rawCost: number, rawRevenue: number): number => {
  if (!Number.isFinite(rawCost) || rawCost <= 0) return 0;
  const cost = roundMoney(rawCost);
  if (!Number.isFinite(rawRevenue) || rawRevenue <= 0) return cost;

  const revenue = roundMoney(rawRevenue);
  const ratio = cost / revenue;
  if (ratio <= LEGACY_COST_RATIO_MAX) return cost;

  const viableCandidates = LEGACY_COST_DIVISORS
    .map((divisor) => roundMoney(cost / divisor))
    .filter((candidate) => candidate >= 0 && candidate / revenue <= LEGACY_COST_RATIO_MAX);
  if (viableCandidates.length === 0) return cost;

  return viableCandidates.reduce((best, candidate) => {
    const bestDelta = Math.abs(best / revenue - LEGACY_COST_RATIO_TARGET);
    const candidateDelta = Math.abs(candidate / revenue - LEGACY_COST_RATIO_TARGET);
    return candidateDelta < bestDelta ? candidate : best;
  }, viableCandidates[0]);
};

const CHANNEL_ORDER: SaleOrigin[] = ['LOCAL', 'IFOOD', 'APP99', 'KEETA'];

const CHANNEL_COLORS: Record<SaleOrigin, string> = {
  LOCAL: DASHBOARD_CHART_COLORS.local,
  IFOOD: DASHBOARD_CHART_COLORS.ifood,
  APP99: DASHBOARD_CHART_COLORS.app99,
  KEETA: DASHBOARD_CHART_COLORS.keeta,
};

const pad2 = (value: number): string => value.toString().padStart(2, '0');

const toDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const toShortDayLabel = (date: Date): string =>
  date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
  });

const normalizeUnit = (value: string): string => value.trim().toLowerCase();

const hasToken = (unit: string, token: string): boolean =>
  new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(unit);

const isKgUnit = (unit: string): boolean =>
  hasToken(unit, 'kg') || unit.includes('quilo') || unit.includes('kilogram');

const isMlUnit = (unit: string): boolean =>
  hasToken(unit, 'ml') || unit.includes('mililit');

const isLiterUnit = (unit: string): boolean =>
  !isMlUnit(unit) &&
  (hasToken(unit, 'l') ||
    hasToken(unit, 'lt') ||
    hasToken(unit, 'lts') ||
    unit.includes('litro'));

const isGramUnit = (unit: string): boolean =>
  !isKgUnit(unit) && (hasToken(unit, 'g') || unit.includes('gram'));

const normalizeIngredientCostForReport = (
  ingredient: Ingredient | undefined,
  rawCost: number
): number => {
  if (!Number.isFinite(rawCost) || rawCost <= 0) return 0;
  if (!ingredient) return rawCost;

  const unit = normalizeUnit(ingredient.unit || '');
  if (!unit) return rawCost;

  if (isGramUnit(unit) || isMlUnit(unit)) {
    if (rawCost >= 1) return rawCost / 1000; // entered as per kg/l
    if (rawCost >= 0.1) return rawCost / 100; // entered as per 100g/ml
    return rawCost;
  }

  if (isKgUnit(unit) || isLiterUnit(unit)) {
    if (rawCost > 0 && rawCost <= 0.05) return rawCost * 1000; // entered as per g/ml
    if (rawCost > 0.05 && rawCost <= 0.5) return rawCost * 100; // entered as per 10g/ml
    if (rawCost > 0.5 && rawCost <= 2) return rawCost * 10; // entered as per 100g/ml
    return rawCost;
  }

  return rawCost;
};

const isLikelyInventoryAdjustment = (ingredient: Ingredient | undefined, quantity: number, impact: number): boolean => {
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  if (impact >= 500) return true;
  if (!ingredient) return quantity >= 100;

  const unit = normalizeUnit(ingredient.unit || '');
  if (isGramUnit(unit) || isMlUnit(unit)) return quantity >= 5000;
  if (isKgUnit(unit) || isLiterUnit(unit)) return quantity >= 10;
  return quantity >= 100;
};

interface ConsolidatedArchiveFinance {
  orders: number;
  revenue: number;
  cost: number;
  profit: number;
}

interface IngredientCostConsumerEntry {
  id: string;
  name: string;
  totalCost: number;
  saleCount: number;
  avgCostPerSale: number;
  share: number;
}

const isAppOrigin = (origin: SaleOrigin): boolean =>
  origin === 'IFOOD' || origin === 'APP99' || origin === 'KEETA';

const buildConsolidatedArchiveFinance = (entries: Sale[]): ConsolidatedArchiveFinance => {
  const grouped = new Map<
    string,
    {
      origin: SaleOrigin;
      fallbackRevenue: number;
      appRevenue: number | null;
      cost: number;
    }
  >();

  entries.forEach((sale) => {
    const key = sale.saleDraftId ? `draft:${sale.saleDraftId}` : `sale:${sale.id}`;
    const origin = sale.saleOrigin || 'LOCAL';
    const current = grouped.get(key) || {
      origin,
      fallbackRevenue: 0,
      appRevenue: null,
      cost: 0,
    };

    current.origin = origin;

    const fallbackRevenue = Number(sale.total);
    if (Number.isFinite(fallbackRevenue)) {
      current.fallbackRevenue = roundMoney(current.fallbackRevenue + fallbackRevenue);
    }

    const cost = Number(sale.totalCost);
    const saleRevenueReference = Math.max(0, Number(sale.total) || 0);
    if (Number.isFinite(cost)) {
      current.cost = roundMoney(current.cost + normalizeLegacySaleCost(cost, saleRevenueReference));
    }

    const appRevenue = Number(sale.appOrderTotal);
    if (isAppOrigin(origin) && Number.isFinite(appRevenue) && appRevenue > 0) {
      current.appRevenue = appRevenue;
    }

    grouped.set(key, current);
  });

  let revenue = 0;
  let cost = 0;

  grouped.forEach((group) => {
    const effectiveRevenue = roundMoney(group.appRevenue ?? group.fallbackRevenue);
    revenue = roundMoney(revenue + effectiveRevenue);
    cost = roundMoney(cost + group.cost);
  });

  const profit = roundMoney(revenue - cost);
  return {
    orders: grouped.size,
    revenue,
    cost,
    profit,
  };
};

const AdminDashboard: React.FC<AdminDashboardProps> = ({ 
  sales, 
  cancelledSales, 
  stockEntries, 
  sessionStockEntries,
  allProducts,
  allIngredients,
  cleaningMaterials,
  cleaningStockEntries,
  onFactoryReset,
  onClearOperationalData,
  onClearOnlyStock,
  onDeleteArchiveDate,
  onDeleteArchiveMonth,
  cashRegisterAmount,
  dailySalesHistory,
}) => {
  const [activeTab, setActiveTab] = useState<
    'geral' | 'analytics' | 'vendas' | 'estornos' | 'estoque' | 'materiais' | 'arquivos' | 'configuracao'
  >('geral');
  const [selectedArchiveDay, setSelectedArchiveDay] = useState<string | null>(null);
  const [selectedArchiveMonth, setSelectedArchiveMonth] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ type: 'month' | 'day'; label: string } | null>(null);
  const [configPass, setConfigPass] = useState('');
  const [showConfigPass, setShowConfigPass] = useState(false);
  const [showDangerZone, setShowDangerZone] = useState(false);
  const [expandedMonths, setExpandedMonths] = useState<Record<string, boolean>>({});
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});
  const [selectedVendasYear, setSelectedVendasYear] = useState<string | null>(null);
  const [selectedEstornosYear, setSelectedEstornosYear] = useState<string | null>(null);
  const [selectedEstoqueYear, setSelectedEstoqueYear] = useState<string | null>(null);
  const [selectedMateriaisYear, setSelectedMateriaisYear] = useState<string | null>(null);
  const [isStockCostPopoverOpen, setIsStockCostPopoverOpen] = useState(false);
  const stockCostPopoverRef = useRef<HTMLDivElement | null>(null);
  const stockCostPopoverButtonRef = useRef<HTMLButtonElement | null>(null);

  const consolidatedSalesFinance = useMemo(
    () => buildConsolidatedArchiveFinance(sales),
    [sales]
  );
  const totalRevenue = consolidatedSalesFinance.revenue;
  const salesCost = consolidatedSalesFinance.cost;
  const salesProfit = consolidatedSalesFinance.profit;
  const cancelledRevenue = cancelledSales.reduce((sum, s) => sum + s.total, 0);
  const stockOutCostBreakdown = useMemo(() => {
    const saleOutByIngredient = new Map<string, number>();
    const byDay = new Map<string, number>();

    stockEntries.forEach((entry) => {
      const quantity = Number(entry.quantity);
      if (!Number.isFinite(quantity) || quantity >= 0) return;

      const isSaleEntry =
        entry.source === 'SALE' ||
        (typeof entry.saleId === 'string' && entry.saleId.trim()) ||
        (typeof entry.id === 'string' && entry.id.startsWith('st-sale-'));
      if (!isSaleEntry) return;

      const ingredientId = entry.ingredientId || '';
      if (!ingredientId) return;
      saleOutByIngredient.set(
        ingredientId,
        (saleOutByIngredient.get(ingredientId) || 0) + Math.abs(quantity)
      );
    });

    const total = stockEntries.reduce((sum, entry) => {
      const quantity = Number(entry.quantity);
      if (!Number.isFinite(quantity) || quantity >= 0) return sum;

      // Legacy safety: some old records may miss `source` but still carry `saleId`.
      const isSaleEntry =
        entry.source === 'SALE' ||
        (typeof entry.saleId === 'string' && entry.saleId.trim()) ||
        (typeof entry.id === 'string' && entry.id.startsWith('st-sale-'));
      if (isSaleEntry) {
        return sum;
      }

      const ingredient = allIngredients.find((i) => i.id === entry.ingredientId);
      const rawUnitCost = Number(entry.unitCost ?? ingredient?.cost ?? 0);
      if (!Number.isFinite(rawUnitCost) || rawUnitCost <= 0) return sum;

      const normalizedUnitCost = normalizeIngredientCostForReport(ingredient, rawUnitCost);
      const absoluteQuantity = Math.abs(quantity);
      const normalizedImpact = absoluteQuantity * normalizedUnitCost;
      if (isLikelyInventoryAdjustment(ingredient, absoluteQuantity, normalizedImpact)) {
        return sum;
      }

      const relatedSaleOut = saleOutByIngredient.get(entry.ingredientId) || 0;
      if (relatedSaleOut <= 0) {
        return sum;
      }
      if (absoluteQuantity > relatedSaleOut * 2) {
        return sum;
      }

      const date = toDate(entry.timestamp);
      const dayKey = toDayKey(date);
      byDay.set(dayKey, roundMoney((byDay.get(dayKey) || 0) + normalizedImpact));

      return sum + normalizedImpact;
    }, 0);

    return {
      total: roundMoney(total),
      byDay,
    };
  }, [stockEntries, allIngredients]);
  const cleaningStockCostBreakdown = useMemo(() => {
    const byDay = new Map<string, number>();
    const total = cleaningStockEntries.reduce((sum, entry) => {
      if (entry.quantity >= 0) return sum;
      const unitCost =
        entry.unitCost ?? cleaningMaterials.find(material => material.id === entry.materialId)?.cost ?? 0;
      const impact = Math.abs(entry.quantity) * unitCost;
      const date = toDate(entry.timestamp);
      const dayKey = toDayKey(date);
      byDay.set(dayKey, roundMoney((byDay.get(dayKey) || 0) + impact));
      return sum + impact;
    }, 0);
    return {
      total: roundMoney(total),
      byDay,
    };
  }, [cleaningStockEntries, cleaningMaterials]);
  const stockOutCost = stockOutCostBreakdown.total;
  const cleaningStockOutCost = cleaningStockCostBreakdown.total;
  const operationalExtraCost = roundMoney(stockOutCost + cleaningStockOutCost);
  const ingredientCostConsumerBreakdown = useMemo(() => {
    const grouped = new Map<
      string,
      { id: string; name: string; totalCost: number; saleCount: number; saleIds: Set<string> }
    >();
    let total = 0;

    stockEntries.forEach((entry) => {
      const quantity = Number(entry.quantity);
      if (!Number.isFinite(quantity) || quantity >= 0) return;

      const isSaleEntry =
        entry.source === 'SALE' ||
        (typeof entry.saleId === 'string' && entry.saleId.trim()) ||
        (typeof entry.id === 'string' && entry.id.startsWith('st-sale-'));
      if (!isSaleEntry) return;

      const ingredient = allIngredients.find((item) => item.id === entry.ingredientId);
      const rawUnitCost = Number(entry.unitCost ?? ingredient?.cost ?? 0);
      if (!Number.isFinite(rawUnitCost) || rawUnitCost <= 0) return;

      const normalizedUnitCost = normalizeIngredientCostForReport(ingredient, rawUnitCost);
      const impact = roundMoney(Math.abs(quantity) * normalizedUnitCost);
      if (!Number.isFinite(impact) || impact <= 0) return;

      const ingredientId = entry.ingredientId || `unknown-${entry.ingredientName || entry.id}`;
      const ingredientName = ingredient?.name || entry.ingredientName || 'Insumo sem nome';
      const current = grouped.get(ingredientId) || {
        id: ingredientId,
        name: ingredientName,
        totalCost: 0,
        saleCount: 0,
        saleIds: new Set<string>(),
      };
      current.totalCost = roundMoney(current.totalCost + impact);
      current.saleCount += 1;

      const saleId = typeof entry.saleId === 'string' ? entry.saleId.trim() : '';
      if (saleId) {
        current.saleIds.add(saleId);
      }

      grouped.set(ingredientId, current);
      total = roundMoney(total + impact);
    });

    const entries: IngredientCostConsumerEntry[] = [...grouped.values()]
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 5)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        totalCost: entry.totalCost,
        saleCount: entry.saleIds.size > 0 ? entry.saleIds.size : entry.saleCount,
        avgCostPerSale:
          (entry.saleIds.size > 0 ? entry.saleIds.size : entry.saleCount) > 0
            ? roundMoney(entry.totalCost / (entry.saleIds.size > 0 ? entry.saleIds.size : entry.saleCount))
            : 0,
        share: total > 0 ? entry.totalCost / total : 0,
      }));

    return {
      totalCost: total,
      entries,
    };
  }, [stockEntries, allIngredients]);
  const appChannelSummary = useMemo(() => buildAppChannelSummary(sales), [sales]);
  // KPI principal da aba GERAL: custo e lucro das vendas (COGS), sem misturar saídas operacionais.
  const totalCost = salesCost;
  const totalProfit = salesProfit;
  // Resultado operacional inclui baixas não relacionadas diretamente ao custo das vendas.
  const operationalNetProfit = roundMoney(totalProfit - operationalExtraCost);
  const generalFinanceSeries = useMemo(() => {
    const dailyMap = new Map<
      string,
      {
        dayKey: string;
        label: string;
        date: Date;
        revenue: number;
        salesCost: number;
      }
    >();

    const ensureDay = (dayKey: string, date: Date) => {
      if (!dailyMap.has(dayKey)) {
        dailyMap.set(dayKey, {
          dayKey,
          label: toShortDayLabel(date),
          date,
          revenue: 0,
          salesCost: 0,
        });
      }
      return dailyMap.get(dayKey)!;
    };

    sales.forEach((sale) => {
      const date = toDate(sale.timestamp);
      const dayKey = toDayKey(date);
      const day = ensureDay(dayKey, new Date(date.getFullYear(), date.getMonth(), date.getDate()));
      day.revenue = roundMoney(day.revenue + (Number(sale.total) || 0));
      day.salesCost = roundMoney(
        day.salesCost +
          normalizeLegacySaleCost(Number(sale.totalCost) || 0, Math.max(0, Number(sale.total) || 0))
      );
    });

    return [...dailyMap.values()]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((entry) => {
        const cost = roundMoney(entry.salesCost);
        return {
          ...entry,
          cost,
          profit: roundMoney(entry.revenue - cost),
        };
      });
  }, [sales]);
  const revenueDistributionData = useMemo(() => {
    const grouped = new Map<
      string,
      {
        origin: SaleOrigin;
        fallbackRevenue: number;
        appRevenue: number | null;
      }
    >();

    sales.forEach((sale) => {
      const key = sale.saleDraftId ? `draft:${sale.saleDraftId}` : `sale:${sale.id}`;
      const origin = sale.saleOrigin || 'LOCAL';
      const current = grouped.get(key) || {
        origin,
        fallbackRevenue: 0,
        appRevenue: null,
      };

      current.origin = origin;
      current.fallbackRevenue += Number(sale.total) || 0;
      const appTotal = Number(sale.appOrderTotal);
      if (Number.isFinite(appTotal) && appTotal > 0) {
        current.appRevenue = appTotal;
      }

      grouped.set(key, current);
    });

    const totals: Record<SaleOrigin, number> = {
      LOCAL: 0,
      IFOOD: 0,
      APP99: 0,
      KEETA: 0,
    };

    grouped.forEach((entry) => {
      const revenue = roundMoney(entry.appRevenue ?? entry.fallbackRevenue);
      totals[entry.origin] = roundMoney(totals[entry.origin] + revenue);
    });

    const total = CHANNEL_ORDER.reduce((sum, key) => sum + totals[key], 0);

    return CHANNEL_ORDER.map((origin) => ({
      origin,
      label: saleOriginLabels[origin],
      revenue: roundMoney(totals[origin]),
      share: total > 0 ? totals[origin] / total : 0,
      color: CHANNEL_COLORS[origin],
    }));
  }, [sales]);
  const flowFinanceData = useMemo(
    () => [
      { label: 'Entradas', value: roundMoney(totalRevenue), color: DASHBOARD_CHART_COLORS.revenue },
      { label: 'Custos', value: roundMoney(totalCost), color: DASHBOARD_CHART_COLORS.cost },
      { label: 'Lucro', value: roundMoney(totalProfit), color: DASHBOARD_CHART_COLORS.profit },
    ],
    [totalRevenue, totalCost, totalProfit]
  );

  useEffect(() => {
    if (!isStockCostPopoverOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (stockCostPopoverRef.current?.contains(target)) return;
      if (stockCostPopoverButtonRef.current?.contains(target)) return;
      setIsStockCostPopoverOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsStockCostPopoverOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isStockCostPopoverOpen]);
  const totalCleaningStockValue = useMemo(
    () => cleaningMaterials.reduce((sum, material) => sum + material.currentStock * material.cost, 0),
    [cleaningMaterials]
  );
  const ingredientsById = useMemo(
    () => new Map(allIngredients.map((ingredient) => [ingredient.id, ingredient])),
    [allIngredients]
  );
  const cleaningMaterialsById = useMemo(
    () => new Map(cleaningMaterials.map((material) => [material.id, material])),
    [cleaningMaterials]
  );

  const archives = useMemo(() => {
    const groups: Record<string, Record<string, Sale[]>> = {};
    sales.forEach(sale => {
      const month = sale.timestamp.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
      const day = sale.timestamp.toLocaleDateString('pt-BR');
      if (!groups[month]) groups[month] = {};
      if (!groups[month][day]) groups[month][day] = [];
      groups[month][day].push(sale);
    });
    return groups;
  }, [sales]);
  const orderedDailySalesHistory = useMemo(
    () =>
      [...dailySalesHistory].sort(
        (a, b) => toDate(b.closedAt).getTime() - toDate(a.closedAt).getTime()
      ),
    [dailySalesHistory]
  );
  const latestDailyClose = orderedDailySalesHistory[0];
  const cashEvolutionSeries = useMemo(() => {
    return [...orderedDailySalesHistory]
      .sort((a, b) => toDate(a.closedAt).getTime() - toDate(b.closedAt).getTime())
      .map((entry) => {
        const closedDate = toDate(entry.closedAt);
        const cashExpenses = Number(entry.cashExpenses) > 0 ? Number(entry.cashExpenses) : 0;
        const estimated = roundMoney(
          entry.openingCash + entry.totalRevenue - entry.totalPurchases - cashExpenses
        );
        const informed = roundMoney(entry.openingCash);
        const difference = roundMoney(informed - estimated);

        return {
          id: entry.id,
          date: closedDate,
          label: toShortDayLabel(closedDate),
          estimated,
          informed,
          difference,
        };
      });
  }, [orderedDailySalesHistory]);
  const cashDifferenceStatus = useMemo(() => {
    if (cashEvolutionSeries.length === 0) {
      return {
        value: 0,
        label: 'Sem dados',
        tone: 'text-slate-600',
      };
    }

    const latestPoint = cashEvolutionSeries[cashEvolutionSeries.length - 1];
    if (latestPoint.difference > 0) {
      return {
        value: latestPoint.difference,
        label: 'Acima do estimado',
        tone: 'text-emerald-700',
      };
    }
    if (latestPoint.difference < 0) {
      return {
        value: latestPoint.difference,
        label: 'Abaixo do estimado',
        tone: 'text-red-700',
      };
    }

    return {
      value: latestPoint.difference,
      label: 'Alinhado',
      tone: 'text-slate-700',
    };
  }, [cashEvolutionSeries]);
  const currentSessionCashExpenses = useMemo(
    () =>
      sessionStockEntries.reduce((sum, entry) => {
        const impact = Number(entry.cashRegisterImpact);
        if (!Number.isFinite(impact) || impact >= 0) return sum;
        return sum + Math.abs(impact);
      }, 0),
    [sessionStockEntries]
  );
  const currentSessionCashExpenseEntries = useMemo(
    () =>
      sessionStockEntries
        .filter((entry) => {
          const impact = Number(entry.cashRegisterImpact);
          return Number.isFinite(impact) && impact < 0;
        })
        .slice()
        .sort((a, b) => toDate(b.timestamp).getTime() - toDate(a.timestamp).getTime()),
    [sessionStockEntries]
  );

  const handleUnlockConfig = (e: React.FormEvent) => {
    e.preventDefault();
    if (configPass === 'admin123') {
      setShowDangerZone(true);
      setConfigPass('');
      setShowConfigPass(false);
    } else {
      alert('Senha incorreta!');
    }
  };

  const handleFactoryResetConfirm = () => {
    if (confirm("ATENÇÃO: Isso apagará TODOS os dados permanentemente (Estoque, Materiais, Produtos, Vendas e Arquivos). Deseja continuar?")) {
      const secondCheck = prompt("Digite 'APAGAR TUDO' para confirmar:");
      if (secondCheck === 'APAGAR TUDO') {
        onFactoryReset();
      }
    }
  };

  const handleOperationalResetConfirm = () => {
    if (
      confirm(
        'Isso vai limpar apenas vendas, estornos e movimentações de estoque, mantendo produtos, insumos e materiais cadastrados. Deseja continuar?'
      )
    ) {
      const secondCheck = prompt("Digite 'LIMPAR OPERACIONAL' para confirmar:");
      if (secondCheck === 'LIMPAR OPERACIONAL') {
        onClearOperationalData();
      }
    }
  };

  const handleClearStockConfirm = () => {
    if (
      confirm(
        'Isso vai zerar apenas as quantidades de estoque atuais, mantendo produtos, insumos, materiais e valores cadastrados. Deseja continuar?'
      )
    ) {
      const secondCheck = prompt("Digite 'ZERAR ESTOQUE' para confirmar:");
      if (secondCheck === 'ZERAR ESTOQUE') {
        onClearOnlyStock();
      }
    }
  };

  const handleDeleteMonth = (e: React.MouseEvent, month: string) => {
    e.stopPropagation();
    setPendingDelete({ type: 'month', label: month });
  };

  const handleDeleteDay = (e: React.MouseEvent, day: string) => {
    e.stopPropagation();
    setPendingDelete({ type: 'day', label: day });
  };

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.type === 'month') {
      onDeleteArchiveMonth(pendingDelete.label);
      if (selectedArchiveMonth === pendingDelete.label) {
        setSelectedArchiveMonth(null);
        setSelectedArchiveDay(null);
      }
    } else {
      onDeleteArchiveDate(pendingDelete.label);
      setSelectedArchiveDay(null);
    }
    setPendingDelete(null);
  };

  const StatCard = ({ title, value, color, icon }: any) => (
    <div className="qb-admin-stat-card bg-white p-6 rounded-[32px] border-2 border-slate-100 shadow-sm animate-in fade-in zoom-in duration-300">
      <div className="flex justify-between items-start mb-2">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{title}</p>
        <div className={`${color} p-2 rounded-xl text-white shadow-lg`}>{icon}</div>
      </div>
      <h4 className="text-3xl font-black text-slate-800 tracking-tighter">{value}</h4>
    </div>
  );

  return (
    <div className="qb-admin p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="qb-admin-header flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-3xl sm:text-4xl font-black text-slate-900 tracking-tighter uppercase leading-none">ADMINISTRAÇÃO</h2>
          <p className="text-slate-500 font-bold mt-1">Controle total e arquivos permanentes.</p>
        </div>
        
        <div className="qb-admin-tabs flex bg-slate-200 p-1 rounded-2xl gap-1 overflow-x-auto scrollbar-hide w-full md:w-auto">
          {[
            'geral',
            'analytics',
            'vendas',
            'estornos',
            'estoque',
            'materiais',
            'arquivos',
            'configuracao',
          ].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`qb-btn-touch px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all whitespace-nowrap flex items-center gap-2 ${activeTab === tab ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:bg-slate-300'}`}
            >
              {tab === 'configuracao' && <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>}
              {tab === 'configuracao' ? 'CONFIG' : tab === 'analytics' ? 'ANALISE' : tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'geral' && (
        <div className="qb-admin-general space-y-4">
          <div className="qb-admin-general-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard title="Faturamento Total" value={`R$ ${totalRevenue.toFixed(2)}`} color="bg-blue-600" icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 2v20"/><path d="m17 5-5-3-5 3"/><path d="m17 19-5 3-5-3"/><path d="M2 12h20"/><path d="m5 7 3 5-3 5"/><path d="m19 7-3 5 3 5"/></svg>} />
            <StatCard title="Custo de Insumos" value={`R$ ${totalCost.toFixed(2)}`} color="bg-slate-800" icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 22V12"/></svg>} />
            <StatCard title="Lucro de Vendas" value={`R$ ${totalProfit.toFixed(2)}`} color="bg-green-600" icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m5 12 7-7 7 7"/></svg>} />
            <StatCard title="Vendas Estornadas" value={cancelledSales.length} color="bg-orange-500" icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>} />
            <StatCard title="Materiais de Limpeza" value={`${cleaningMaterials.length} itens`} color="bg-indigo-600" icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M3 7h18"/><path d="M7 7v13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V7"/><path d="M10 11h4"/><path d="M10 15h4"/><path d="M9 3h6l1 4H8l1-4Z"/></svg>} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-white p-6 rounded-[32px] border-2 border-slate-100 shadow-sm">
              <div className="mb-4">
                <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Evolucao Financeira</h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                  Faturamento, custos e lucro por dia
                </p>
              </div>
              {generalFinanceSeries.length === 0 ? (
                <div className="h-[280px] rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center text-[10px] font-black uppercase tracking-widest text-slate-400">
                  Sem dados diarios para exibir
                </div>
              ) : (
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={generalFinanceSeries}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                      <XAxis dataKey="label" tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 11, fontWeight: 700 }} />
                      <YAxis
                        tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                        tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }}
                      />
                      <Tooltip
                        contentStyle={DASHBOARD_TOOLTIP_STYLE}
                        formatter={(value: number) => `R$ ${value.toFixed(2)}`}
                        labelFormatter={(label) => `Dia: ${label}`}
                      />
                      <Line
                        type="monotone"
                        dataKey="revenue"
                        name="faturamento"
                        stroke={DASHBOARD_CHART_COLORS.revenue}
                        strokeWidth={3}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="cost"
                        name="custos"
                        stroke={DASHBOARD_CHART_COLORS.cost}
                        strokeWidth={3}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="profit"
                        name="lucro"
                        stroke={DASHBOARD_CHART_COLORS.profit}
                        strokeWidth={3}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="bg-white p-6 rounded-[32px] border-2 border-slate-100 shadow-sm">
              <div className="mb-4">
                <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Distribuicao de Receita</h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                  Participacao por canal: Balcao, iFood, 99 e Keeta
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 items-center">
                <div className="h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={revenueDistributionData}
                        dataKey="revenue"
                        nameKey="label"
                        innerRadius={55}
                        outerRadius={92}
                        paddingAngle={2}
                      >
                        {revenueDistributionData.map((entry) => (
                          <Cell key={entry.origin} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={DASHBOARD_TOOLTIP_STYLE}
                        formatter={(value: number) => `R$ ${value.toFixed(2)}`}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2">
                  {revenueDistributionData.map((entry) => (
                    <div key={entry.origin} className="bg-slate-50 border border-slate-200 rounded-2xl p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full"
                            style={{ backgroundColor: entry.color }}
                          />
                          <p className="text-xs font-black text-slate-800 uppercase">{entry.label}</p>
                        </div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                          {(entry.share * 100).toFixed(1)}%
                        </p>
                      </div>
                      <p className="text-sm font-black text-slate-900 mt-1">R$ {entry.revenue.toFixed(2)}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-white p-6 rounded-[32px] border-2 border-slate-100 shadow-sm">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Fluxo Financeiro</h3>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                    Comparativo entre entradas, custos e lucro
                  </p>
                </div>
                <button
                  type="button"
                  ref={stockCostPopoverButtonRef}
                  onClick={() => setIsStockCostPopoverOpen((current) => !current)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 hover:bg-slate-100 active:scale-[0.98] transition"
                >
                  Top custos
                </button>
              </div>
              <div className="h-[280px] relative">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={flowFinanceData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                    <XAxis dataKey="label" tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 11, fontWeight: 700 }} />
                    <YAxis
                      tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                      tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }}
                    />
                    <Tooltip
                      contentStyle={DASHBOARD_TOOLTIP_STYLE}
                      formatter={(value: number) => `R$ ${value.toFixed(2)}`}
                    />
                    <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                      {flowFinanceData.map((entry) => (
                        <Cell key={entry.label} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                {isStockCostPopoverOpen && (
                  <div
                    ref={stockCostPopoverRef}
                    className="absolute bottom-2 right-2 w-[260px] max-w-[calc(100%-16px)] rounded-2xl border border-slate-200 bg-white/95 backdrop-blur px-3 py-3 shadow-xl"
                  >
                    <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
                      Ingredientes que mais consomem custo
                    </p>
                    <p className="text-[10px] font-black text-slate-700 uppercase mt-1">
                      Top ingredientes de venda • R$ {ingredientCostConsumerBreakdown.totalCost.toFixed(2)}
                    </p>
                    <p className="text-[9px] font-black text-slate-500 uppercase mt-1">
                      Custo total e media por venda
                    </p>
                  {ingredientCostConsumerBreakdown.entries.length === 0 ? (
                      <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                        Sem vendas registradas
                      </p>
                    ) : (
                      <div className="mt-2 space-y-2">
                      {ingredientCostConsumerBreakdown.entries.map((item, index) => (
                          <div key={item.id}>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[10px] font-black text-slate-700 truncate">
                                {index + 1}. {item.name}
                              </p>
                              <p className="text-[10px] font-black text-red-600 whitespace-nowrap">
                                R$ {item.totalCost.toFixed(2)}
                              </p>
                            </div>
                            <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">
                              Media/venda: R$ {item.avgCostPerSale.toFixed(2)} • {item.saleCount} vendas
                            </p>
                            <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden mt-1">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-red-500 via-orange-500 to-amber-400"
                                style={{ width: `${Math.max(8, Math.min(100, item.share * 100))}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white p-6 rounded-[32px] border-2 border-slate-100 shadow-sm">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Evolucao do Caixa Diario</h3>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                    Caixa estimado x informado e diferenca
                  </p>
                </div>
                <div className="bg-slate-100 rounded-xl px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Ultima diferenca</p>
                  <p className={`text-sm font-black ${cashDifferenceStatus.tone}`}>
                    R$ {cashDifferenceStatus.value.toFixed(2)}
                  </p>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mt-1">
                    {cashDifferenceStatus.label}
                  </p>
                </div>
              </div>
              {cashEvolutionSeries.length === 0 ? (
                <div className="h-[280px] rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center text-[10px] font-black uppercase tracking-widest text-slate-400">
                  Sem historico de fechamento diario
                </div>
              ) : (
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={cashEvolutionSeries}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                      <XAxis dataKey="label" tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 11, fontWeight: 700 }} />
                      <YAxis
                        tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                        tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }}
                      />
                      <Tooltip
                        contentStyle={DASHBOARD_TOOLTIP_STYLE}
                        formatter={(value: number) => `R$ ${value.toFixed(2)}`}
                        labelFormatter={(label) => `Dia: ${label}`}
                      />
                      <Line
                        type="monotone"
                        dataKey="estimated"
                        name="caixa estimado"
                        stroke={DASHBOARD_CHART_COLORS.estimatedCash}
                        strokeWidth={3}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="informed"
                        name="caixa informado"
                        stroke={DASHBOARD_CHART_COLORS.informedCash}
                        strokeWidth={3}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="difference"
                        name="diferenca"
                        stroke={DASHBOARD_CHART_COLORS.difference}
                        strokeWidth={2}
                        strokeDasharray="5 5"
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          <div className="qb-admin-cash bg-white p-6 rounded-[32px] border-2 border-slate-100 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-5">
              <div>
                <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Controle de Caixa</h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                  Dados da aba Caixa e histórico de fechamento diário
                </p>
              </div>
              <div className="bg-slate-100 px-4 py-3 rounded-2xl">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Caixa Atual</p>
                <p className="text-2xl font-black text-slate-900">R$ {cashRegisterAmount.toFixed(2)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="bg-emerald-50 rounded-2xl border border-emerald-100 p-4">
                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-1">Caixa Informado</p>
                <p className="text-2xl font-black text-emerald-700">R$ {cashRegisterAmount.toFixed(2)}</p>
                <p className="text-[10px] font-bold text-emerald-600 uppercase mt-2">Valor da sessão em aberto</p>
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 mt-2">
                  Retiradas no caixa: -R$ {currentSessionCashExpenses.toFixed(2)}
                </p>
              </div>

              <div className="bg-blue-50 rounded-2xl border border-blue-100 p-4">
                <p className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-1">Último Fechamento</p>
                {latestDailyClose ? (
                  <>
                    <p className="text-lg font-black text-blue-700">
                      {toDate(latestDailyClose.closedAt).toLocaleDateString('pt-BR')}
                    </p>
                    <p className="text-[11px] font-black text-slate-700">
                      Lucro: R$ {latestDailyClose.totalProfit.toFixed(2)}
                    </p>
                  </>
                ) : (
                  <p className="text-sm font-black text-slate-400">Sem fechamento registrado</p>
                )}
              </div>

              <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Fechamentos</p>
                <p className="text-2xl font-black text-slate-900">{orderedDailySalesHistory.length}</p>
                <p className="text-[10px] font-bold text-slate-500 uppercase mt-2">Registros permanentes</p>
              </div>
            </div>

            <div className="mt-5">
              {currentSessionCashExpenseEntries.length > 0 && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-2xl p-4">
                  <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-2">
                    Retiradas do caixa (sessão atual)
                  </p>
                  <div className="space-y-2 max-h-[140px] overflow-y-auto pr-1 scrollbar-hide">
                    {currentSessionCashExpenseEntries.map((entry) => (
                      <div
                        key={entry.id}
                        className="bg-white border border-amber-100 rounded-xl px-3 py-2 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-black uppercase text-slate-800 truncate">
                            {entry.purchaseDescription || entry.ingredientName}
                          </p>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 truncate">
                            {entry.ingredientId === 'cash-expense' || entry.quantity === 0
                              ? 'Tipo: Outros'
                              : `Insumo: ${entry.ingredientName}`}
                          </p>
                        </div>
                        <p className="text-xs font-black text-amber-700">
                          -R$ {Math.abs(Number(entry.cashRegisterImpact) || 0).toFixed(2)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Histórico Diário</p>
              {orderedDailySalesHistory.length === 0 ? (
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 text-xs font-black uppercase tracking-widest text-slate-400">
                  Nenhum fechamento de caixa registrado.
                </div>
              ) : (
                <div className="space-y-2 max-h-[280px] overflow-y-auto pr-1 scrollbar-hide">
                  {orderedDailySalesHistory.map((entry) => {
                    const closedAt = toDate(entry.closedAt);
                    const cashExpenses = Number(entry.cashExpenses) > 0 ? Number(entry.cashExpenses) : 0;
                    const closingEstimate =
                      entry.openingCash + entry.totalRevenue - entry.totalPurchases - cashExpenses;
                    return (
                      <div key={entry.id} className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                          <div>
                            <p className="text-xs font-black uppercase text-slate-800">
                              {closedAt.toLocaleDateString('pt-BR')}
                            </p>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                              Fechado em {closedAt.toLocaleString('pt-BR')}
                            </p>
                          </div>
                          <p className="text-xs font-black text-slate-700">
                            Pedidos: {entry.saleCount}
                          </p>
                        </div>
                        <div className="mt-2 text-[11px] font-bold text-slate-700">
                          Caixa: R$ {entry.openingCash.toFixed(2)} | Faturamento: R$ {entry.totalRevenue.toFixed(2)} | Compras: R$ {entry.totalPurchases.toFixed(2)} | Compra no caixa: R$ {cashExpenses.toFixed(2)} | Lucro: R$ {entry.totalProfit.toFixed(2)} | Caixa estimado: R$ {closingEstimate.toFixed(2)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="qb-admin-summary bg-white p-6 rounded-[32px] border-2 border-slate-100 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-5">
              <div>
                <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Demonstrativo Geral</h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                  Entrou x saiu = lucro liquido
                </p>
              </div>
              <div className="bg-slate-100 px-3 py-2 rounded-xl">
                <p className="text-[10px] font-black text-slate-400 uppercase">Resultado Operacional</p>
                <p className={`text-xl font-black ${operationalNetProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  R$ {operationalNetProfit.toFixed(2)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="bg-blue-50 rounded-2xl border border-blue-100 p-4">
                <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-2">Entrou</p>
                <div className="flex items-center justify-between py-2 border-b border-blue-100">
                  <span className="text-xs font-black text-slate-700 uppercase">Vendas Liquidas</span>
                  <span className="text-sm font-black text-blue-700">R$ {totalRevenue.toFixed(2)}</span>
                </div>
                <p className="mt-3 text-[10px] font-bold text-blue-600 uppercase">Base de entrada do periodo</p>
              </div>

              <div className="bg-red-50 rounded-2xl border border-red-100 p-4">
                <p className="text-[10px] font-black text-red-500 uppercase tracking-widest mb-2">Saiu</p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-black text-slate-700 uppercase">
                    <span>Custo das vendas</span>
                    <span className="text-red-600">R$ {salesCost.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-black text-slate-700 uppercase">
                    <span>Baixa estoque alimentos</span>
                    <span className="text-red-600">R$ {stockOutCost.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-black text-slate-700 uppercase">
                    <span>Baixa materiais limpeza</span>
                    <span className="text-red-600">R$ {cleaningStockOutCost.toFixed(2)}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-3 mt-3 border-t border-red-100">
                  <span className="text-[10px] font-black text-red-500 uppercase tracking-widest">Total saiu</span>
                  <span className="text-sm font-black text-red-700">R$ {(totalCost + operationalExtraCost).toFixed(2)}</span>
                </div>
              </div>

              <div className="bg-emerald-50 rounded-2xl border border-emerald-100 p-4">
                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-2">Resultado</p>
                <div className="flex items-center justify-between py-2 border-b border-emerald-100">
                  <span className="text-xs font-black text-slate-700 uppercase">Lucro das vendas</span>
                  <span className={`text-sm font-black ${totalProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    R$ {totalProfit.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-3">
                  <span className="text-[10px] font-black text-slate-500 uppercase">Estornos (info)</span>
                  <span className="text-xs font-black text-orange-600">R$ {cancelledRevenue.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between pt-2">
                  <span className="text-[10px] font-black text-slate-500 uppercase">Resultado operacional</span>
                  <span className={`text-xs font-black ${operationalNetProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    R$ {operationalNetProfit.toFixed(2)}
                  </span>
                </div>
                <p className="mt-2 text-[10px] font-bold text-slate-500 uppercase">
                  Custo de vendas separado das baixas operacionais.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-[32px] border-2 border-slate-100 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-5">
              <div>
                <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">
                  Canais de App
                </h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                  iFood, 99 e Keeta consolidados por pedido
                </p>
              </div>
              <div className="bg-slate-100 px-3 py-2 rounded-xl">
                <p className="text-[10px] font-black text-slate-400 uppercase">Pedidos App</p>
                <p className="text-xl font-black text-slate-900">{appChannelSummary.totalOrders}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
              <div className="bg-amber-50 rounded-2xl border border-amber-100 p-4">
                <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-1">
                  Faturamento Apps
                </p>
                <p className="text-2xl font-black text-amber-700">R$ {appChannelSummary.totalRevenue.toFixed(2)}</p>
              </div>
              <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">
                  Valor no Balcão
                </p>
                <p className="text-2xl font-black text-slate-900">
                  R$ {appChannelSummary.totalReference.toFixed(2)}
                </p>
              </div>
              <div className="bg-blue-50 rounded-2xl border border-blue-100 p-4">
                <p className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-1">
                  Diferença de Preço
                </p>
                <p
                  className={`text-2xl font-black ${
                    appChannelSummary.totalDelta >= 0 ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  R$ {appChannelSummary.totalDelta.toFixed(2)}
                </p>
                <p className="text-[10px] font-black text-blue-700 uppercase tracking-widest mt-2">
                  Valor apps - valor no balcão
                </p>
                <p className="text-[10px] font-black text-blue-700 uppercase tracking-widest mt-1">
                  {appChannelSummary.totalDelta > 0
                    ? 'Acima do balcão'
                    : appChannelSummary.totalDelta < 0
                      ? 'Abaixo do balcão'
                      : 'Mesmo valor do balcão'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {APP_ORIGINS.map((origin) => {
                const originSummary = appChannelSummary.byOrigin[origin];
                const originName = saleOriginLabels[origin];
                return (
                  <div key={origin} className="bg-white rounded-2xl border border-slate-200 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${saleOriginBadgeClasses[origin]}`}
                      >
                        {originName}
                      </span>
                      <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                        Pedidos: {originSummary.orders}
                      </span>
                    </div>
                    <p className="mt-3 text-sm font-black text-slate-700 uppercase">
                      Faturamento: R$ {originSummary.revenue.toFixed(2)}
                    </p>
                    <p
                      className={`mt-1 text-xs font-black uppercase ${
                        originSummary.delta >= 0 ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      Diferença de preço: R$ {originSummary.delta.toFixed(2)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      )}

      {activeTab === 'analytics' && <AdminSalesAnalyticsTab sales={sales} products={allProducts} />}

      {activeTab === 'estornos' && (
        <div className="qb-admin-panel qb-admin-estornos bg-slate-100 p-4 sm:p-8 rounded-[28px] sm:rounded-[40px] border-2 border-slate-200 min-h-[600px]">
          <div className="qb-admin-panel-head flex items-center gap-3 mb-8">
             <div className="bg-orange-500 p-3 rounded-2xl shadow-lg">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
             </div>
             <div>
               <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">Estornos Realizados</h3>
               <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Organizado por período, Erros de cliques no processo.</p>
             </div>
          </div>
          {cancelledSales.length === 0 ? <div className="py-24 text-center opacity-30 font-black uppercase text-xs">Sem estornos.</div> : (
            (() => {
              const estornoGroups: Record<string, Record<string, typeof cancelledSales>> = {};
              cancelledSales.forEach(sale => {
                const month = sale.timestamp.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
                const day = sale.timestamp.toLocaleDateString('pt-BR');
                if (!estornoGroups[month]) estornoGroups[month] = {};
                if (!estornoGroups[month][day]) estornoGroups[month][day] = [];
                estornoGroups[month][day].push(sale);
              });
              
              // Extrair anos disponíveis
              const yearsSet = new Set<string>();
              Object.keys(estornoGroups).forEach(month => {
                const year = month.split(' ').pop();
                if (year) yearsSet.add(year);
              });
              const years = Array.from(yearsSet).sort((a, b) => parseInt(b) - parseInt(a));
              const currentYear = years[0] || new Date().getFullYear().toString();
              const selectedYear = selectedEstornosYear || currentYear;
              
              // Filtrar meses por ano
              const filteredMonths = Object.keys(estornoGroups)
                .filter(month => month.endsWith(selectedYear))
                .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
              
              return (
                <div className="space-y-6">
                  {years.length > 1 && (
                    <div className="flex gap-2 flex-wrap mb-6">
                      {years.map(year => (
                        <button
                          key={year}
                          onClick={() => setSelectedEstornosYear(year)}
                          className={`qb-btn-touch px-5 py-2 rounded-2xl font-black text-[10px] uppercase transition-all ${
                            selectedYear === year
                              ? 'bg-orange-500 text-white shadow-lg shadow-orange-200'
                              : 'bg-white text-slate-600 border border-slate-200 hover:border-orange-400'
                          }`}
                        >
                          {year}
                        </button>
                      ))}
                    </div>
                  )}
                  {filteredMonths.map(month => (
                    <div key={month} className="bg-white rounded-[32px] overflow-hidden border border-slate-200 shadow-sm">
                      <button 
                        className="qb-admin-month-toggle qb-btn-touch w-full p-6 flex items-center justify-between hover:bg-slate-50 transition-colors"
                        onClick={() => setExpandedMonths({...expandedMonths, [`estorno_${month}`]: !expandedMonths[`estorno_${month}`]})}
                      >
                        <span className="font-black text-base sm:text-lg text-slate-800 uppercase">{month}</span>
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${expandedMonths[`estorno_${month}`] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                      </button>
                      {expandedMonths[`estorno_${month}`] && (
                        <div className="px-6 pb-6 border-t border-slate-100 space-y-4">
                          {Object.keys(estornoGroups[month]).reverse().map(day => (
                            <div key={day} className="bg-slate-50 rounded-2xl overflow-hidden border border-slate-200">
                              <button 
                                className="qb-admin-day-toggle qb-btn-touch w-full p-4 flex items-center justify-between hover:bg-slate-100 transition-colors"
                                onClick={() => setExpandedDays({...expandedDays, [`estorno_${day}`]: !expandedDays[`estorno_${day}`]})}
                              >
                                <span className="font-black text-slate-700 text-xs sm:text-sm uppercase">{day}</span>
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${expandedDays[`estorno_${day}`] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                              </button>
                              {expandedDays[`estorno_${day}`] && (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-left bg-white">
                                    <thead>
                                      <tr className="border-b border-slate-100">
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Horário</th>
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Item</th>
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400 text-right">Valor</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-50">
                                      {estornoGroups[month][day].slice().reverse().map((sale, i) => (
                                        <tr key={sale.id + i}>
                                          <td className="px-4 py-3 text-xs font-bold text-slate-500">{sale.timestamp.toLocaleTimeString()}</td>
                                          <td className="px-4 py-3 font-black text-slate-800 uppercase text-xs">{sale.productName}</td>
                                          <td className="px-4 py-3 text-xs font-black text-orange-600 text-right">- R$ {sale.total.toFixed(2)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })()
          )}
        </div>
      )}

      {activeTab === 'arquivos' && (
        <div className="qb-admin-panel qb-admin-arquivos bg-slate-100 p-4 sm:p-8 rounded-[28px] sm:rounded-[40px] border-2 border-slate-200 min-h-[600px] animate-in slide-in-from-bottom-4 relative">
          <div className="qb-admin-panel-head flex items-center gap-3 mb-8">
             <div className="bg-slate-900 p-3 rounded-2xl shadow-lg">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
             </div>
             <div>
                <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter leading-none">Arquivo Digital</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Clique para ver ou apagar.</p>
             </div>
          </div>

          {!selectedArchiveMonth ? (
            <div className="qb-archive-month-grid grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
              {Object.keys(archives).map(month => {
                const monthSales = Object.values(archives[month]).flat() as Sale[];
                const monthFinance = buildConsolidatedArchiveFinance(monthSales);
                const monthAppSummary = buildAppChannelSummary(monthSales);
                return (
                <div key={month} className="relative group">
                  <button 
                    onClick={() => setSelectedArchiveMonth(month)}
                    className="qb-archive-tile qb-btn-touch w-full flex flex-col items-center p-6 bg-white rounded-3xl border-2 border-transparent hover:border-blue-500 hover:shadow-xl transition-all"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.5" className="group-hover:stroke-blue-500 transition-colors"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
                    <span className="font-black text-[10px] uppercase text-slate-600 text-center group-hover:text-slate-900 mt-2 mb-2">{month}</span>
                    <span className="font-black text-sm text-green-600">R$ {monthFinance.profit.toFixed(2)}</span>
                    <span className="text-[9px] font-black uppercase tracking-widest text-amber-700 mt-2">
                      Apps: {monthAppSummary.totalOrders} • R$ {monthAppSummary.totalRevenue.toFixed(2)}
                    </span>
                  </button>
                  <button 
                    onClick={(e) => handleDeleteMonth(e, month)}
                    className="qb-btn-touch absolute top-2 right-2 bg-red-100 text-red-600 p-1.5 rounded-xl opacity-0 group-hover:opacity-100 transition-all hover:bg-red-600 hover:text-white"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                  </button>
                </div>
                );
              })}
            </div>
          ) : !selectedArchiveDay ? (
            <div className="space-y-6">
              <button onClick={() => setSelectedArchiveMonth(null)} className="qb-btn-touch flex items-center gap-2 text-blue-600 font-black text-xs uppercase underline underline-offset-4">
                 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m15 18-6-6 6-6"/></svg> Voltar
              </button>
              <div className="qb-archive-day-grid grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {Object.keys(archives[selectedArchiveMonth]).map(day => {
                  const daySales = archives[selectedArchiveMonth][day] as Sale[];
                  const dayFinance = buildConsolidatedArchiveFinance(daySales);
                  const dayAppSummary = buildAppChannelSummary(daySales);
                  return (
                  <div key={day} className="relative group">
                    <button 
                      onClick={() => setSelectedArchiveDay(day)}
                      className="qb-archive-tile qb-btn-touch w-full flex flex-col items-center p-6 bg-white rounded-3xl border border-slate-200 hover:border-blue-500 transition-all shadow-sm"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" className="mb-2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                      <span className="font-black text-xs text-slate-800 mb-2">{day}</span>
                      <span className="font-black text-sm text-green-600">R$ {dayFinance.profit.toFixed(2)}</span>
                      <span className="text-[9px] font-black uppercase tracking-widest text-amber-700 mt-2">
                        Apps: {dayAppSummary.totalOrders} • R$ {dayAppSummary.totalRevenue.toFixed(2)}
                      </span>
                    </button>
                    <button 
                      onClick={(e) => handleDeleteDay(e, day)}
                      className="qb-btn-touch absolute top-2 right-2 bg-red-100 text-red-600 p-1.5 rounded-xl opacity-0 group-hover:opacity-100 transition-all hover:bg-red-600 hover:text-white"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <button onClick={() => setSelectedArchiveDay(null)} className="qb-btn-touch flex items-center gap-2 text-blue-600 font-black text-xs uppercase">
                 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m15 18-6-6 6-6"/></svg> Voltar
              </button>
              <div className="qb-archive-detail bg-white p-4 sm:p-8 rounded-[28px] sm:rounded-[40px] shadow-xl border border-slate-200 relative">
                <button 
                  onClick={(e) => handleDeleteDay(e, selectedArchiveDay)}
                  className="qb-archive-delete-day-btn qb-btn-touch absolute top-8 right-8 bg-red-600 text-white px-4 py-2 rounded-2xl font-black text-[10px] uppercase shadow-lg shadow-red-200 hover:scale-105 active:scale-95 transition-all"
                >
                  Excluir este Dia
                </button>
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h4 className="text-xl sm:text-2xl font-black text-slate-800 uppercase mb-4 sm:mb-8">Fechamento: {selectedArchiveDay}</h4>
                    <div className="flex flex-col gap-2">
                      <p className="text-2xl sm:text-4xl font-black text-slate-900">{selectedArchiveDay}</p>
                      {(() => {
                        const selectedSales = archives[selectedArchiveMonth!][selectedArchiveDay] as Sale[];
                        const selectedFinance = buildConsolidatedArchiveFinance(selectedSales);
                        return (
                          <>
                            <p className="text-2xl sm:text-3xl font-black text-green-600">R$ {selectedFinance.profit.toFixed(2)}</p>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>
                <div className="qb-archive-detail-grid grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                   {(() => {
                     const selectedSales = archives[selectedArchiveMonth!][selectedArchiveDay] as Sale[];
                     const selectedFinance = buildConsolidatedArchiveFinance(selectedSales);
                     const selectedAppSummary = buildAppChannelSummary(selectedSales);
                     return (
                       <>
                         <div className="bg-slate-50 p-6 rounded-3xl"><p className="text-[10px] font-bold text-slate-400 uppercase">Receita</p><p className="text-2xl font-black">R$ {selectedFinance.revenue.toFixed(2)}</p></div>
                         <div className="bg-slate-50 p-6 rounded-3xl"><p className="text-[10px] font-bold text-slate-400 uppercase">Lucro</p><p className="text-2xl font-black text-green-600">R$ {selectedFinance.profit.toFixed(2)}</p></div>
                         <div className="bg-slate-50 p-6 rounded-3xl">
                           <p className="text-[10px] font-bold text-slate-400 uppercase">Apps no dia</p>
                           <p className="text-2xl font-black text-amber-700">R$ {selectedAppSummary.totalRevenue.toFixed(2)}</p>
                           <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mt-2">
                             Pedidos: {selectedAppSummary.totalOrders}
                           </p>
                         </div>
                       </>
                     );
                   })()}
                </div>
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                   {archives[selectedArchiveMonth!][selectedArchiveDay].map((s, i) => (
                     <div key={s.id + i} className="flex justify-between p-3 border-b border-slate-50 text-xs">
                        <span className="font-bold text-slate-500">{s.timestamp.toLocaleTimeString()}</span>
                        <span className="font-black text-slate-800 uppercase">
                          {s.productName}
                          <span className="ml-2 text-[9px] text-slate-500">
                            {saleOriginLabels[s.saleOrigin || 'LOCAL']}
                          </span>
                        </span>
                        <span className="font-black text-slate-900">R$ {s.total.toFixed(2)}</span>
                     </div>
                   ))}
                </div>
              </div>
            </div>
          )}

          {pendingDelete && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm rounded-[40px]" />
              <div className="qb-archive-confirm relative bg-white rounded-[36px] p-6 shadow-2xl border-2 border-slate-100 w-full max-w-lg mx-6 animate-in fade-in zoom-in duration-200">
                <div className="flex items-center gap-3 mb-4">
                  <div className="bg-red-600 p-2 rounded-xl text-white shadow-lg">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Confirmação</p>
                    <p className="text-lg font-black text-slate-900">
                      {pendingDelete.type === 'month'
                        ? `Excluir todos os arquivos de ${pendingDelete.label}?`
                        : `Excluir permanentemente os registros de ${pendingDelete.label}?`}
                    </p>
                  </div>
                </div>
                <p className="text-xs font-bold text-slate-500 mb-6">Essa ação é definitiva e não pode ser desfeita.</p>
                <div className="flex items-center justify-end gap-3">
                  <button
                    onClick={() => setPendingDelete(null)}
                    className="qb-btn-touch bg-slate-200 text-slate-700 px-5 py-3 rounded-2xl font-black text-[10px] uppercase hover:bg-slate-300 transition-all"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleConfirmDelete}
                    className="qb-btn-touch bg-red-600 text-white px-5 py-3 rounded-2xl font-black text-[10px] uppercase shadow-lg shadow-red-200 hover:bg-red-700 transition-all"
                  >
                    Excluir
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'configuracao' && (
        <div className="qb-admin-config bg-white p-4 sm:p-8 rounded-[28px] sm:rounded-[40px] border-2 border-slate-100 shadow-sm min-h-[500px] flex flex-col items-center justify-center text-center">
          {!showDangerZone ? (
            <div className="max-w-md w-full animate-in zoom-in duration-300">
               <div className="bg-slate-900 w-20 h-20 rounded-[32px] flex items-center justify-center mx-auto mb-6 shadow-2xl">
                  <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
               </div>
               <h3 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tighter uppercase mb-2">Área Crítica</h3>
               <p className="text-slate-400 font-bold mb-8">Redigite sua senha administrativa para liberar funções de reset.</p>
               <form onSubmit={handleUnlockConfig} className="space-y-4">
                  <div className="relative">
                    <input 
                      type={showConfigPass ? 'text' : 'password'}
                      value={configPass}
                      onChange={e => setConfigPass(e.target.value)}
                      placeholder="SENHA ADMIN"
                      className="w-full bg-slate-100 border-none rounded-3xl px-6 py-4 pr-28 font-black text-center text-xl text-slate-800 focus:ring-4 focus:ring-red-500/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfigPass(prev => !prev)}
                      className="qb-btn-touch absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:text-slate-800 transition-colors"
                      aria-label={showConfigPass ? 'Ocultar senha' : 'Ver senha'}
                    >
                      {showConfigPass ? 'Ocultar' : 'Ver senha'}
                    </button>
                  </div>
                  <button type="submit" className="qb-btn-touch w-full bg-slate-900 text-yellow-400 py-5 rounded-3xl font-black uppercase tracking-tighter shadow-xl hover:scale-105 active:scale-95 transition-all">
                     DESBLOQUEAR CONFIGURAÇÕES
                  </button>
               </form>
            </div>
          ) : (
            <div className="max-w-2xl w-full space-y-8 animate-in slide-in-from-bottom-4">
               <div className="bg-amber-50 border-2 border-amber-100 p-4 sm:p-8 rounded-[28px] sm:rounded-[40px]">
                  <h3 className="text-2xl font-black text-amber-700 uppercase tracking-tighter mb-4">Zerar Estoque</h3>
                  <p className="text-slate-600 font-bold text-sm mb-8">Zera somente as quantidades atuais de estoque (insumos e materiais), sem apagar cadastros nem valores.</p>
                  <button 
                    onClick={handleClearStockConfirm}
                    className="qb-btn-touch bg-amber-600 text-white w-full sm:w-auto px-5 sm:px-10 py-4 sm:py-5 rounded-[24px] font-black uppercase tracking-tighter text-xs sm:text-sm shadow-2xl shadow-amber-200 hover:bg-amber-700 active:scale-95 transition-all flex items-center justify-center gap-3 mx-auto"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="M3 7h18"/><path d="M4 12h16"/><path d="M5 17h14"/></svg>
                    ZERAR SOMENTE O ESTOQUE
                  </button>
               </div>

               <div className="bg-blue-50 border-2 border-blue-100 p-4 sm:p-8 rounded-[28px] sm:rounded-[40px]">
                  <h3 className="text-2xl font-black text-blue-700 uppercase tracking-tighter mb-4">Limpeza Operacional</h3>
                  <p className="text-slate-600 font-bold text-sm mb-8">Remove cálculos e histórico operacional (vendas, estornos e movimentações), preservando produtos, insumos e materiais já cadastrados.</p>
                  <button 
                    onClick={handleOperationalResetConfirm}
                    className="qb-btn-touch bg-blue-600 text-white w-full sm:w-auto px-5 sm:px-10 py-4 sm:py-5 rounded-[24px] font-black uppercase tracking-tighter text-xs sm:text-sm shadow-2xl shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all flex items-center justify-center gap-3 mx-auto"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>
                    LIMPAR APENAS DADOS OPERACIONAIS
                  </button>
               </div>

               <div className="bg-red-50 border-2 border-red-100 p-4 sm:p-8 rounded-[28px] sm:rounded-[40px]">
                  <h3 className="text-2xl font-black text-red-600 uppercase tracking-tighter mb-4">Reset Geral de Fábrica</h3>
                  <p className="text-slate-600 font-bold text-sm mb-8">Essa ação é IRREVERSÍVEL. O sistema voltará ao estado original, apagando todos os produtos criados, estoque, vendas e arquivos históricos.</p>
                  <button 
                    onClick={handleFactoryResetConfirm}
                    className="qb-btn-touch bg-red-600 text-white w-full sm:w-auto px-5 sm:px-10 py-4 sm:py-5 rounded-[24px] font-black uppercase tracking-tighter text-xs sm:text-sm shadow-2xl shadow-red-200 hover:bg-red-700 active:scale-95 transition-all flex items-center justify-center gap-3 mx-auto"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    LIMPAR TUDO (PADRÃO DE FÁBRICA)
                  </button>
               </div>
               
               <button 
                 onClick={() => setShowDangerZone(false)}
                 className="qb-btn-touch text-slate-400 font-black text-xs uppercase underline underline-offset-4 hover:text-slate-800 transition-colors"
               >
                 Sair do Modo de Segurança
               </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'vendas' && (
        <div className="qb-admin-panel qb-admin-vendas bg-slate-100 p-4 sm:p-8 rounded-[28px] sm:rounded-[40px] border-2 border-slate-200 min-h-[600px]">
          <div className="qb-admin-panel-head flex items-center gap-3 mb-8">
            <div className="bg-blue-600 p-3 rounded-2xl shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m0 18h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4m0 18v-7a2 2 0 0 0-2-2H3m4-7h10"/></svg>
            </div>
            <div>
              <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">Histórico de Vendas</h3>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Organizado por período.</p>
            </div>
          </div>

          {(() => {
            const vendaGroups: Record<string, Record<string, typeof sales>> = {};
            sales.forEach(sale => {
              const month = sale.timestamp.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
              const day = sale.timestamp.toLocaleDateString('pt-BR');
              if (!vendaGroups[month]) vendaGroups[month] = {};
              if (!vendaGroups[month][day]) vendaGroups[month][day] = [];
              vendaGroups[month][day].push(sale);
            });
            
            // Extrair anos disponíveis
            const yearsSet = new Set<string>();
            Object.keys(vendaGroups).forEach(month => {
              const year = month.split(' ').pop();
              if (year) yearsSet.add(year);
            });
            const years = Array.from(yearsSet).sort((a, b) => parseInt(b) - parseInt(a));
            const currentYear = years[0] || new Date().getFullYear().toString();
            const selectedYear = selectedVendasYear || currentYear;
            
            // Filtrar meses por ano
            const filteredMonths = Object.keys(vendaGroups)
              .filter(month => month.endsWith(selectedYear))
              .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
            const filteredYearSales = filteredMonths.flatMap((month) =>
              Object.values(vendaGroups[month]).flat()
            ) as Sale[];
            const selectedYearAppSummary = buildAppChannelSummary(filteredYearSales);
            
            return (
              <div className="space-y-6">
                {years.length > 1 && (
                  <div className="flex gap-2 flex-wrap mb-6">
                    {years.map(year => (
                      <button
                        key={year}
                        onClick={() => setSelectedVendasYear(year)}
                        className={`qb-btn-touch px-5 py-2 rounded-2xl font-black text-[10px] uppercase transition-all ${
                          selectedYear === year
                            ? 'bg-blue-600 text-white shadow-lg shadow-blue-200'
                            : 'bg-white text-slate-600 border border-slate-200 hover:border-blue-400'
                        }`}
                      >
                        {year}
                      </button>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-white rounded-2xl border border-slate-200 p-4">
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Pedidos App</p>
                    <p className="text-2xl font-black text-slate-900 mt-1">{selectedYearAppSummary.totalOrders}</p>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-2">
                      Ano {selectedYear}
                    </p>
                  </div>
                  <div className="bg-amber-50 rounded-2xl border border-amber-100 p-4">
                    <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest">
                      Faturamento Apps
                    </p>
                    <p className="text-2xl font-black text-amber-800 mt-1">
                      R$ {selectedYearAppSummary.totalRevenue.toFixed(2)}
                    </p>
                  </div>
                  <div className="bg-blue-50 rounded-2xl border border-blue-100 p-4">
                    <p className="text-[10px] font-black text-blue-700 uppercase tracking-widest">Diferença de Preço</p>
                    <p
                      className={`text-2xl font-black mt-1 ${
                        selectedYearAppSummary.totalDelta >= 0 ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      R$ {selectedYearAppSummary.totalDelta.toFixed(2)}
                    </p>
                    <p className="text-[10px] font-black text-blue-700 uppercase tracking-widest mt-2">
                      Valor apps - valor no balcão
                    </p>
                  </div>
                </div>
                {filteredMonths.map(month => (
                  <div key={month} className="bg-white rounded-[32px] overflow-hidden border border-slate-200 shadow-sm">
                    {(() => {
                      const monthSales = Object.values(vendaGroups[month]).flat() as Sale[];
                      const monthAppSummary = buildAppChannelSummary(monthSales);
                      return (
                        <>
                    <button 
                      className="qb-admin-month-toggle qb-btn-touch w-full p-6 flex items-center justify-between hover:bg-slate-50 transition-colors"
                      onClick={() => setExpandedMonths({...expandedMonths, [month]: !expandedMonths[month]})}
                    >
                      <div className="text-left">
                        <span className="font-black text-base sm:text-lg text-slate-800 uppercase block">{month}</span>
                        <span className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                          Apps: {monthAppSummary.totalOrders} pedidos • R$ {monthAppSummary.totalRevenue.toFixed(2)}
                        </span>
                      </div>
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${expandedMonths[month] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    {expandedMonths[month] && (
                      <div className="px-6 pb-6 border-t border-slate-100 space-y-4">
                        {Object.keys(vendaGroups[month]).reverse().map(day => (
                          <div key={day} className="bg-slate-50 rounded-2xl overflow-hidden border border-slate-200">
                            {(() => {
                              const daySales = vendaGroups[month][day] as Sale[];
                              const dayAppSummary = buildAppChannelSummary(daySales);
                              return (
                                <>
                            <button 
                              className="qb-admin-day-toggle qb-btn-touch w-full p-4 flex items-center justify-between hover:bg-slate-100 transition-colors"
                              onClick={() => setExpandedDays({...expandedDays, [`vendas_${day}`]: !expandedDays[`vendas_${day}`]})}
                            >
                              <div className="text-left">
                                <span className="font-black text-slate-700 text-xs sm:text-sm uppercase block">{day}</span>
                                <span className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                                  Apps: {dayAppSummary.totalOrders} pedidos • R$ {dayAppSummary.totalRevenue.toFixed(2)}
                                </span>
                              </div>
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${expandedDays[`vendas_${day}`] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                            {expandedDays[`vendas_${day}`] && (
                              <div className="overflow-x-auto">
                                <table className="w-full text-left bg-white">
                                  <thead>
                                      <tr className="border-b border-slate-100">
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Horário</th>
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Produto</th>
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Pagamento</th>
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Canal</th>
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400 text-right">Ajuste</th>
                                        <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400 text-right">Valor</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-50">
                                    {vendaGroups[month][day].slice().reverse().map(sale => (
                                      <tr key={sale.id}>
                                        <td className="px-4 py-3 text-xs font-bold text-slate-500">{sale.timestamp.toLocaleTimeString()}</td>
                                        <td className="px-4 py-3 font-black text-slate-800 uppercase text-xs">{sale.productName}</td>
                                        <td className="px-4 py-3 text-xs font-black text-slate-800">{renderPaymentMethodBadge(sale)}</td>
                                        <td className="px-4 py-3 text-xs font-black text-slate-800">
                                          <div className="space-y-1">
                                            {renderSaleOriginBadge(sale)}
                                            {(sale.saleOrigin === 'IFOOD' ||
                                              sale.saleOrigin === 'APP99' ||
                                              sale.saleOrigin === 'KEETA') &&
                                              Number.isFinite(Number(sale.appOrderTotal)) && (
                                                <p className="text-[9px] font-black uppercase tracking-widest text-amber-700">
                                                  App: R$ {(Number(sale.appOrderTotal) || 0).toFixed(2)}
                                                </p>
                                              )}
                                          </div>
                                        </td>
                                        <td className="px-4 py-3 text-xs font-black text-right">
                                          {sale.priceAdjustment !== undefined ? (
                                            <span className={`${sale.priceAdjustment >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                              {sale.priceAdjustment >= 0 ? '+' : '-'}R$ {Math.abs(sale.priceAdjustment).toFixed(2)}
                                            </span>
                                          ) : (
                                            <span className="text-slate-300">—</span>
                                          )}
                                        </td>
                                        <td className="px-4 py-3 text-xs font-black text-slate-800 text-right">R$ {sale.total.toFixed(2)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                                </>
                              );
                            })()}
                          </div>
                        ))}
                      </div>
                    )}
                        </>
                      );
                    })()}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {activeTab === 'materiais' && (
        <div className="qb-admin-panel qb-admin-materiais bg-slate-100 p-4 sm:p-8 rounded-[28px] sm:rounded-[40px] border-2 border-slate-200 min-h-[600px]">
          <div className="qb-admin-panel-head flex items-center gap-3 mb-8">
            <div className="bg-indigo-600 p-3 rounded-2xl shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M3 7h18"/><path d="M7 7v13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V7"/><path d="M10 11h4"/><path d="M10 15h4"/><path d="M9 3h6l1 4H8l1-4Z"/></svg>
            </div>
            <div>
              <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">Materiais de Limpeza</h3>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Registro permanente por ano, mês e dia.</p>
            </div>
          </div>

          <div className="qb-admin-material-stats grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <div className="bg-white rounded-3xl p-5 border border-slate-200">
              <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Total Cadastrado</p>
              <p className="text-3xl font-black text-slate-900 mt-1">{cleaningMaterials.length}</p>
            </div>
            <div className="bg-white rounded-3xl p-5 border border-slate-200">
              <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Valor em Estoque</p>
              <p className="text-3xl font-black text-slate-900 mt-1">R$ {totalCleaningStockValue.toFixed(2)}</p>
            </div>
            <div className="bg-white rounded-3xl p-5 border border-slate-200">
              <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Movimentações</p>
              <p className="text-3xl font-black text-slate-900 mt-1">{cleaningStockEntries.length}</p>
            </div>
          </div>

          {(() => {
            const materialsGroups: Record<string, Record<string, typeof cleaningStockEntries>> = {};
            cleaningStockEntries.forEach(entry => {
              const month = entry.timestamp.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
              const day = entry.timestamp.toLocaleDateString('pt-BR');
              if (!materialsGroups[month]) materialsGroups[month] = {};
              if (!materialsGroups[month][day]) materialsGroups[month][day] = [];
              materialsGroups[month][day].push(entry);
            });

            const yearsSet = new Set<string>();
            Object.keys(materialsGroups).forEach(month => {
              const year = month.split(' ').pop();
              if (year) yearsSet.add(year);
            });
            const years = Array.from(yearsSet).sort((a, b) => parseInt(b) - parseInt(a));
            const currentYear = years[0] || new Date().getFullYear().toString();
            const selectedYear = selectedMateriaisYear || currentYear;

            const filteredMonths = Object.keys(materialsGroups)
              .filter(month => month.endsWith(selectedYear))
              .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

            if (cleaningStockEntries.length === 0) {
              return (
                <div className="bg-white rounded-3xl border border-slate-200 py-24 text-center opacity-40 font-black uppercase text-xs">
                  Ainda sem movimentações de materiais.
                </div>
              );
            }

            return (
              <div className="space-y-6">
                {years.length > 1 && (
                  <div className="flex gap-2 flex-wrap mb-6">
                    {years.map(year => (
                      <button
                        key={year}
                        onClick={() => setSelectedMateriaisYear(year)}
                        className={`qb-btn-touch px-5 py-2 rounded-2xl font-black text-[10px] uppercase transition-all ${
                          selectedYear === year
                            ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                            : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-400'
                        }`}
                      >
                        {year}
                      </button>
                    ))}
                  </div>
                )}

                {filteredMonths.map(month => (
                  <div key={month} className="bg-white rounded-[32px] overflow-hidden border border-slate-200 shadow-sm">
                    <button
                      className="qb-admin-month-toggle qb-btn-touch w-full p-6 flex items-center justify-between hover:bg-slate-50 transition-colors"
                      onClick={() => setExpandedMonths({...expandedMonths, [`materiais_${month}`]: !expandedMonths[`materiais_${month}`]})}
                    >
                      <span className="font-black text-base sm:text-lg text-slate-800 uppercase">{month}</span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${expandedMonths[`materiais_${month}`] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    {expandedMonths[`materiais_${month}`] && (
                      <div className="px-6 pb-6 border-t border-slate-100 space-y-4">
                        {Object.keys(materialsGroups[month]).reverse().map(day => (
                          <div key={day} className="bg-slate-50 rounded-2xl overflow-hidden border border-slate-200">
                            <button
                              className="qb-admin-day-toggle qb-btn-touch w-full p-4 flex items-center justify-between hover:bg-slate-100 transition-colors"
                              onClick={() => setExpandedDays({...expandedDays, [`materiais_${day}`]: !expandedDays[`materiais_${day}`]})}
                            >
                              <span className="font-black text-slate-700 text-xs sm:text-sm uppercase">{day}</span>
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${expandedDays[`materiais_${day}`] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                            {expandedDays[`materiais_${day}`] && (
                              <div className="overflow-x-auto">
                                <table className="w-full text-left bg-white">
                                  <thead>
                                    <tr className="border-b border-slate-100">
                                      <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Horário</th>
                                      <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Material</th>
                                      <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400 text-right">Tipo</th>
                                      <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400 text-right">Quantidade</th>
                                      <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400 text-right">Custo</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-50">
                                    {materialsGroups[month][day].slice().reverse().map(entry => {
                                      const isOut = entry.quantity < 0;
                                      const material = cleaningMaterialsById.get(entry.materialId);
                                      const quantityLabel = material
                                        ? formatStockQuantityByUnit(material.unit, Math.abs(entry.quantity))
                                        : formatStockQuantityByUnit('', Math.abs(entry.quantity));
                                      const totalCost = Math.abs(entry.quantity) * (entry.unitCost ?? 0);
                                      return (
                                        <tr key={entry.id}>
                                          <td className="px-4 py-3 text-xs font-bold text-slate-500">{entry.timestamp.toLocaleTimeString()}</td>
                                          <td className="px-4 py-3 font-black text-slate-800 uppercase text-xs">{entry.materialName}</td>
                                          <td className={`px-4 py-3 text-xs font-black text-right ${isOut ? 'text-red-600' : 'text-blue-600'}`}>
                                            {isOut ? 'Saída' : 'Entrada'}
                                          </td>
                                          <td className={`px-4 py-3 text-xs font-black text-right ${isOut ? 'text-red-600' : 'text-blue-600'}`}>
                                            {isOut ? '-' : '+'}{quantityLabel}
                                            {material?.unit ? ` ${material.unit}` : ''}
                                          </td>
                                          <td className="px-4 py-3 text-xs font-black text-slate-800 text-right">R$ {totalCost.toFixed(2)}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {activeTab === 'estoque' && (
        <div className="qb-admin-panel qb-admin-estoque bg-slate-100 p-4 sm:p-8 rounded-[28px] sm:rounded-[40px] border-2 border-slate-200 min-h-[600px]">
          <div className="qb-admin-panel-head flex items-center gap-3 mb-8">
            <div className="bg-slate-900 p-3 rounded-2xl shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><polyline points="12 22.08 12 12"/></svg>
            </div>
            <div>
              <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">Movimentações de Estoque</h3>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Organizado por período.</p>
            </div>
          </div>

          {(() => {
            const stockGroups: Record<string, Record<string, typeof stockEntries>> = {};
            stockEntries.forEach(entry => {
              const month = entry.timestamp.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
              const day = entry.timestamp.toLocaleDateString('pt-BR');
              if (!stockGroups[month]) stockGroups[month] = {};
              if (!stockGroups[month][day]) stockGroups[month][day] = [];
              stockGroups[month][day].push(entry);
            });
            
            // Extrair anos disponíveis
            const yearsSet = new Set<string>();
            Object.keys(stockGroups).forEach(month => {
              const year = month.split(' ').pop();
              if (year) yearsSet.add(year);
            });
            const years = Array.from(yearsSet).sort((a, b) => parseInt(b) - parseInt(a));
            const currentYear = years[0] || new Date().getFullYear().toString();
            const selectedYear = selectedEstoqueYear || currentYear;
            
            // Filtrar meses por ano
            const filteredMonths = Object.keys(stockGroups)
              .filter(month => month.endsWith(selectedYear))
              .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
            
            return (
              <div className="space-y-6">
                {years.length > 1 && (
                  <div className="flex gap-2 flex-wrap mb-6">
                    {years.map(year => (
                      <button
                        key={year}
                        onClick={() => setSelectedEstoqueYear(year)}
                        className={`qb-btn-touch px-5 py-2 rounded-2xl font-black text-[10px] uppercase transition-all ${
                          selectedYear === year
                            ? 'bg-slate-900 text-white shadow-lg shadow-slate-400'
                            : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-400'
                        }`}
                      >
                        {year}
                      </button>
                    ))}
                  </div>
                )}
                {filteredMonths.map(month => (
                  <div key={month} className="bg-white rounded-[32px] overflow-hidden border border-slate-200 shadow-sm">
                    <button 
                      className="qb-admin-month-toggle qb-btn-touch w-full p-6 flex items-center justify-between hover:bg-slate-50 transition-colors"
                      onClick={() => setExpandedMonths({...expandedMonths, [`estoque_${month}`]: !expandedMonths[`estoque_${month}`]})}
                    >
                      <span className="font-black text-base sm:text-lg text-slate-800 uppercase">{month}</span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${expandedMonths[`estoque_${month}`] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    {expandedMonths[`estoque_${month}`] && (
                      <div className="px-6 pb-6 border-t border-slate-100 space-y-4">
                        {Object.keys(stockGroups[month]).reverse().map(day => (
                          <div key={day} className="bg-slate-50 rounded-2xl overflow-hidden border border-slate-200">
                            <button 
                              className="qb-admin-day-toggle qb-btn-touch w-full p-4 flex items-center justify-between hover:bg-slate-100 transition-colors"
                              onClick={() => setExpandedDays({...expandedDays, [`estoque_${day}`]: !expandedDays[`estoque_${day}`]})}
                            >
                              <span className="font-black text-slate-700 text-xs sm:text-sm uppercase">{day}</span>
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${expandedDays[`estoque_${day}`] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                            {expandedDays[`estoque_${day}`] && (
                              <div className="overflow-x-auto">
                                <table className="w-full text-left bg-white">
                                  <thead>
                                    <tr className="border-b border-slate-100">
                                      <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Horário</th>
                                      <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400">Insumo</th>
                                      <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-400 text-right">Quantidade</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-50">
                                    {stockGroups[month][day].slice().reverse().map(entry => {
                                      const isOut = entry.quantity < 0;
                                      const ingredient = ingredientsById.get(entry.ingredientId);
                                      const displayQty = ingredient
                                        ? formatIngredientStockQuantity(ingredient, Math.abs(entry.quantity))
                                        : formatStockQuantityByUnit('', Math.abs(entry.quantity));
                                      return (
                                        <tr key={entry.id}>
                                          <td className="px-4 py-3 text-xs font-bold text-slate-500">{entry.timestamp.toLocaleTimeString()}</td>
                                          <td className="px-4 py-3 font-black text-slate-800 uppercase text-xs">{entry.ingredientName}</td>
                                          <td className={`px-4 py-3 text-xs font-black text-right ${isOut ? 'text-red-600' : 'text-blue-600'}`}>
                                            {isOut ? '-' : '+'}{displayQty}
                                            {ingredient?.unit ? ` ${ingredient.unit}` : ''}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

export default AdminDashboard;
