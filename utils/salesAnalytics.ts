import { Sale, SaleOrigin } from '../types';

const WEEKDAY_META = [
  { index: 0, shortLabel: 'Dom', label: 'Domingo' },
  { index: 1, shortLabel: 'Seg', label: 'Segunda' },
  { index: 2, shortLabel: 'Ter', label: 'Terca' },
  { index: 3, shortLabel: 'Qua', label: 'Quarta' },
  { index: 4, shortLabel: 'Qui', label: 'Quinta' },
  { index: 5, shortLabel: 'Sex', label: 'Sexta' },
  { index: 6, shortLabel: 'Sab', label: 'Sabado' },
] as const;

const HOUR_INDICES = Array.from({ length: 24 }, (_, hour) => hour);

const MOMENT_META = [
  { key: 'madrugada', label: 'Madrugada', startHour: 0, endHour: 5 },
  { key: 'manha', label: 'Manha', startHour: 6, endHour: 11 },
  { key: 'tarde', label: 'Tarde', startHour: 12, endHour: 17 },
  { key: 'noite', label: 'Noite', startHour: 18, endHour: 23 },
] as const;

type MomentKey = (typeof MOMENT_META)[number]['key'];

export type ChannelKey = 'LOCAL' | 'IFOOD' | 'APP99' | 'KEETA';

const CHANNEL_LABELS: Record<ChannelKey, string> = {
  LOCAL: 'Balcao',
  IFOOD: 'iFood',
  APP99: '99',
  KEETA: 'Keeta',
};

const CHANNEL_ORDER: ChannelKey[] = ['LOCAL', 'IFOOD', 'APP99', 'KEETA'];

const safeNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const roundMoney = (value: number): number => Number((Number.isFinite(value) ? value : 0).toFixed(2));

const toDate = (value: Date | string): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeProductKey = (name: string): string => name.trim().toLocaleLowerCase('pt-BR');

const pad2 = (value: number): string => value.toString().padStart(2, '0');

const toDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const toDayLabel = (date: Date): string =>
  date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

const toMonthKey = (date: Date): string => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;

const toMonthLabel = (date: Date): string =>
  date.toLocaleDateString('pt-BR', {
    month: 'short',
    year: 'numeric',
  });

const toHourLabel = (hour: number): string => `${pad2(hour)}h`;

const toMomentOfDay = (hour: number): MomentKey => {
  if (hour >= 0 && hour < 6) return 'madrugada';
  if (hour < 12) return 'manha';
  if (hour < 18) return 'tarde';
  return 'noite';
};

const getSaleGroupKey = (sale: Sale): string =>
  sale.saleDraftId ? `draft:${sale.saleDraftId}` : `sale:${sale.id}`;

const normalizeOrigin = (origin: SaleOrigin | undefined): ChannelKey => {
  if (origin === 'IFOOD' || origin === 'APP99' || origin === 'KEETA') {
    return origin;
  }
  return 'LOCAL';
};

const startOfDay = (date: Date): Date => {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
};

const getWeekStart = (date: Date): Date => {
  const normalized = startOfDay(date);
  const weekday = normalized.getDay();
  const offsetFromMonday = (weekday + 6) % 7;
  normalized.setDate(normalized.getDate() - offsetFromMonday);
  return normalized;
};

const addDays = (date: Date, days: number): Date => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

const toWeekKey = (date: Date): string => toDayKey(getWeekStart(date));

const toWeekLabel = (date: Date): string => {
  const start = getWeekStart(date);
  const end = addDays(start, 6);
  const startLabel = start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const endLabel = end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return `${startLabel} a ${endLabel}`;
};

interface MutableProductStats {
  key: string;
  productId?: string;
  name: string;
  sales: number;
  revenue: number;
  byWeekday: number[];
  byHour: number[];
}

interface MutableDayStats {
  dayKey: string;
  dayLabel: string;
  date: Date;
  sales: number;
  revenue: number;
}

interface MutableOrderStats {
  key: string;
  origin: ChannelKey;
  date: Date;
  fallbackRevenue: number;
  appRevenue: number | null;
}

interface TimeBucket {
  key: string;
  label: string;
  sortDate: Date;
  orders: number;
  revenue: number;
}

export interface SalesAnalyticsChartPoint {
  key?: string;
  label: string;
  sales: number;
  revenue: number;
}

export interface SalesAnalyticsHourSlot {
  label: string;
  sales: number;
}

export interface SalesAnalyticsProductSummary {
  key: string;
  productId?: string;
  name: string;
  sales: number;
  revenue: number;
  bestWeekdayLabel: string;
  bestWeekdayShortLabel: string;
  bestWeekdaySales: number;
  bestHourLabel: string;
  bestHourSales: number;
  bestMomentLabel: string;
  bestMomentSales: number;
  topHourSlots: SalesAnalyticsHourSlot[];
}

export interface SalesAnalyticsWeekdayLeader {
  weekdayLabel: string;
  weekdayShortLabel: string;
  productName: string;
  sales: number;
}

export interface SalesAnalyticsDaySummary {
  dayKey: string;
  dayLabel: string;
  sales: number;
  revenue: number;
}

export interface SalesAnalyticsHeatmapCell {
  hour: number;
  label: string;
  sales: number;
  revenue: number;
}

export interface SalesAnalyticsHeatmapRow {
  weekdayIndex: number;
  weekdayLabel: string;
  weekdayShortLabel: string;
  cells: SalesAnalyticsHeatmapCell[];
}

export interface SalesAnalyticsCumulativePoint {
  hour: number;
  label: string;
  sales: number;
  revenue: number;
  cumulativeSales: number;
  cumulativeRevenue: number;
}

export interface SalesAnalyticsTicketPoint {
  key: string;
  label: string;
  orders: number;
  revenue: number;
  ticket: number;
}

export interface SalesAnalyticsChannelEfficiencyPoint {
  channel: ChannelKey;
  label: string;
  orders: number;
  revenue: number;
  ticket: number;
}

export interface SalesAnalyticsDayTimelinePoint {
  dayKey: string;
  dayLabel: string;
  weekdayLabel: string;
  sales: number;
  orders: number;
  revenue: number;
  ticket: number;
}

export interface SalesAnalyticsDeadHour {
  hour: number;
  label: string;
  sales: number;
  suggestion: string;
}

export interface SalesAnalyticsProductDependency {
  productName: string;
  revenue: number;
  share: number;
  isHighRisk: boolean;
}

export interface SalesAnalyticsStability {
  averageDailyRevenue: number;
  stddevDailyRevenue: number;
  variation: number;
  status: 'estavel' | 'moderada' | 'instavel';
  trend: 'crescimento' | 'queda' | 'estavel';
}

export interface SalesAnalyticsWeeklyTrend {
  currentWeekRevenue: number;
  previousWeekRevenue: number;
  change: number;
  changePercent: number;
  status: 'crescimento' | 'queda' | 'estavel';
}

export interface SalesAnalyticsIntelligence {
  deadHours: SalesAnalyticsDeadHour[];
  productDependency: SalesAnalyticsProductDependency;
  salesStability: SalesAnalyticsStability;
  weeklyTrend: SalesAnalyticsWeeklyTrend;
}

export interface SalesAnalyticsSnapshot {
  totals: {
    sales: number;
    orders: number;
    revenue: number;
    distinctProducts: number;
    activeDays: number;
  };
  peaks: {
    bestWeekdayLabel: string;
    bestWeekdayShortLabel: string;
    bestWeekdaySales: number;
    weakestWeekdayLabel: string;
    weakestWeekdayShortLabel: string;
    weakestWeekdaySales: number;
    peakHourLabel: string;
    peakHourSales: number;
    weakestHourLabel: string;
    weakestHourSales: number;
    bestDayLabel: string;
    bestDaySales: number;
    weakestDayLabel: string;
    weakestDaySales: number;
  };
  momentsOfDay: Array<{
    label: string;
    key: MomentKey;
    sales: number;
  }>;
  charts: {
    weekday: SalesAnalyticsChartPoint[];
    hourly: SalesAnalyticsChartPoint[];
    topProducts: SalesAnalyticsChartPoint[];
    heatmap: SalesAnalyticsHeatmapRow[];
    cumulativeDaily: SalesAnalyticsCumulativePoint[];
    ticketByPeriod: {
      day: SalesAnalyticsTicketPoint[];
      week: SalesAnalyticsTicketPoint[];
      month: SalesAnalyticsTicketPoint[];
    };
    channelEfficiency: SalesAnalyticsChannelEfficiencyPoint[];
  };
  topProducts: SalesAnalyticsProductSummary[];
  weekdayLeaders: SalesAnalyticsWeekdayLeader[];
  dayRanking: SalesAnalyticsDaySummary[];
  dayTimeline: SalesAnalyticsDayTimelinePoint[];
  intelligence: SalesAnalyticsIntelligence;
}

const findPeakIndex = (values: number[]): number => {
  let index = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > values[index]) {
      index = i;
    }
  }
  return index;
};

const findWeakestActiveIndex = (values: number[]): number => {
  const activeIndices = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > 0);

  if (activeIndices.length === 0) {
    return 0;
  }

  let weakest = activeIndices[0];
  for (let i = 1; i < activeIndices.length; i += 1) {
    if (activeIndices[i].value < weakest.value) {
      weakest = activeIndices[i];
    }
  }
  return weakest.index;
};

const getTopHourSlots = (hourSeries: number[], limit = 3): SalesAnalyticsHourSlot[] =>
  hourSeries
    .map((sales, hour) => ({
      hour,
      label: toHourLabel(hour),
      sales,
    }))
    .filter((entry) => entry.sales > 0)
    .sort((a, b) => {
      if (b.sales !== a.sales) return b.sales - a.sales;
      return a.hour - b.hour;
    })
    .slice(0, limit)
    .map((entry) => ({
      label: entry.label,
      sales: entry.sales,
    }));

const getMomentTotals = (hourSeries: number[]) =>
  MOMENT_META.map((moment) => {
    let sales = 0;
    for (let hour = moment.startHour; hour <= moment.endHour; hour += 1) {
      sales += hourSeries[hour] || 0;
    }
    return {
      key: moment.key,
      label: moment.label,
      sales,
    };
  });

const resolveOrderRevenue = (order: MutableOrderStats): number =>
  roundMoney(order.appRevenue ?? order.fallbackRevenue);

const buildTicketBuckets = (
  orders: MutableOrderStats[],
  period: 'day' | 'week' | 'month'
): SalesAnalyticsTicketPoint[] => {
  const grouped = new Map<string, TimeBucket>();

  orders.forEach((order) => {
    const revenue = resolveOrderRevenue(order);
    let key = '';
    let label = '';
    let sortDate = order.date;

    if (period === 'day') {
      key = toDayKey(order.date);
      label = order.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      sortDate = startOfDay(order.date);
    } else if (period === 'week') {
      key = toWeekKey(order.date);
      label = toWeekLabel(order.date);
      sortDate = getWeekStart(order.date);
    } else {
      key = toMonthKey(order.date);
      label = toMonthLabel(order.date);
      sortDate = new Date(order.date.getFullYear(), order.date.getMonth(), 1);
    }

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        label,
        sortDate,
        orders: 0,
        revenue: 0,
      });
    }

    const bucket = grouped.get(key)!;
    bucket.orders += 1;
    bucket.revenue = roundMoney(bucket.revenue + revenue);
  });

  return [...grouped.values()]
    .sort((a, b) => a.sortDate.getTime() - b.sortDate.getTime())
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      orders: bucket.orders,
      revenue: roundMoney(bucket.revenue),
      ticket: bucket.orders > 0 ? roundMoney(bucket.revenue / bucket.orders) : 0,
    }));
};

const classifyTrendByDelta = (deltaPercent: number): 'crescimento' | 'queda' | 'estavel' => {
  if (deltaPercent > 0.08) return 'crescimento';
  if (deltaPercent < -0.08) return 'queda';
  return 'estavel';
};

export const buildSalesAnalytics = (sales: Sale[]): SalesAnalyticsSnapshot => {
  const productMap = new Map<string, MutableProductStats>();
  const dayMap = new Map<string, MutableDayStats>();
  const orderMap = new Map<string, MutableOrderStats>();

  const weekdaySales = Array<number>(7).fill(0);
  const weekdayRevenue = Array<number>(7).fill(0);
  const hourSales = Array<number>(24).fill(0);
  const hourRevenue = Array<number>(24).fill(0);
  const heatmapSales = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const heatmapRevenue = Array.from({ length: 7 }, () => Array<number>(24).fill(0));

  const moments = {
    madrugada: 0,
    manha: 0,
    tarde: 0,
    noite: 0,
  };

  let totalRevenue = 0;
  let validSalesCount = 0;

  sales.forEach((sale) => {
    const date = toDate(sale.timestamp);
    if (!date) return;

    const productName = sale.productName?.trim() || 'Produto sem nome';
    const productKey = normalizeProductKey(productName);
    const productId = typeof sale.productId === 'string' ? sale.productId.trim() : '';
    const saleTotal = safeNumber(sale.total);
    const weekdayIndex = date.getDay();
    const hour = date.getHours();
    const dayKey = toDayKey(date);

    validSalesCount += 1;
    totalRevenue = roundMoney(totalRevenue + saleTotal);

    if (!productMap.has(productKey)) {
      productMap.set(productKey, {
        key: productKey,
        productId: productId || undefined,
        name: productName,
        sales: 0,
        revenue: 0,
        byWeekday: Array<number>(7).fill(0),
        byHour: Array<number>(24).fill(0),
      });
    }

    const product = productMap.get(productKey)!;
    product.sales += 1;
    product.revenue = roundMoney(product.revenue + saleTotal);
    product.byWeekday[weekdayIndex] += 1;
    product.byHour[hour] += 1;
    if (!product.productId && productId) {
      product.productId = productId;
    }

    weekdaySales[weekdayIndex] += 1;
    weekdayRevenue[weekdayIndex] = roundMoney(weekdayRevenue[weekdayIndex] + saleTotal);
    hourSales[hour] += 1;
    hourRevenue[hour] = roundMoney(hourRevenue[hour] + saleTotal);

    heatmapSales[weekdayIndex][hour] += 1;
    heatmapRevenue[weekdayIndex][hour] = roundMoney(heatmapRevenue[weekdayIndex][hour] + saleTotal);

    const momentKey = toMomentOfDay(hour);
    moments[momentKey] += 1;

    if (!dayMap.has(dayKey)) {
      dayMap.set(dayKey, {
        dayKey,
        dayLabel: toDayLabel(date),
        date: startOfDay(date),
        sales: 0,
        revenue: 0,
      });
    }

    const dayStats = dayMap.get(dayKey)!;
    dayStats.sales += 1;
    dayStats.revenue = roundMoney(dayStats.revenue + saleTotal);

    const orderKey = getSaleGroupKey(sale);
    const existingOrder = orderMap.get(orderKey);

    if (!existingOrder) {
      orderMap.set(orderKey, {
        key: orderKey,
        origin: normalizeOrigin(sale.saleOrigin),
        date,
        fallbackRevenue: saleTotal,
        appRevenue:
          Number.isFinite(Number(sale.appOrderTotal)) && Number(sale.appOrderTotal) > 0
            ? Number(sale.appOrderTotal)
            : null,
      });
    } else {
      existingOrder.origin = normalizeOrigin(sale.saleOrigin);
      existingOrder.fallbackRevenue = roundMoney(existingOrder.fallbackRevenue + saleTotal);
      if (
        Number.isFinite(Number(sale.appOrderTotal)) &&
        Number(sale.appOrderTotal) > 0
      ) {
        existingOrder.appRevenue = Number(sale.appOrderTotal);
      }
      if (date.getTime() > existingOrder.date.getTime()) {
        existingOrder.date = date;
      }
    }
  });

  const topProducts = [...productMap.values()]
    .sort((a, b) => {
      if (b.sales !== a.sales) return b.sales - a.sales;
      if (b.revenue !== a.revenue) return b.revenue - a.revenue;
      return a.name.localeCompare(b.name);
    })
    .map<SalesAnalyticsProductSummary>((product) => {
      const bestWeekdayIndex = findPeakIndex(product.byWeekday);
      const weekdayMeta = WEEKDAY_META[bestWeekdayIndex];
      const bestHourIndex = findPeakIndex(product.byHour);
      const momentTotals = getMomentTotals(product.byHour);
      const bestMoment = momentTotals.reduce((currentBest, entry) =>
        entry.sales > currentBest.sales ? entry : currentBest
      );

      return {
        key: product.key,
        productId: product.productId,
        name: product.name,
        sales: product.sales,
        revenue: roundMoney(product.revenue),
        bestWeekdayLabel: weekdayMeta.label,
        bestWeekdayShortLabel: weekdayMeta.shortLabel,
        bestWeekdaySales: product.byWeekday[bestWeekdayIndex],
        bestHourLabel: toHourLabel(bestHourIndex),
        bestHourSales: product.byHour[bestHourIndex],
        bestMomentLabel: bestMoment.label,
        bestMomentSales: bestMoment.sales,
        topHourSlots: getTopHourSlots(product.byHour),
      };
    });

  const dayRanking = [...dayMap.values()]
    .sort((a, b) => {
      if (b.sales !== a.sales) return b.sales - a.sales;
      if (b.revenue !== a.revenue) return b.revenue - a.revenue;
      return a.dayKey.localeCompare(b.dayKey);
    })
    .map<SalesAnalyticsDaySummary>((entry) => ({
      dayKey: entry.dayKey,
      dayLabel: entry.dayLabel,
      sales: entry.sales,
      revenue: roundMoney(entry.revenue),
    }));

  const bestDay = dayRanking[0] || {
    dayLabel: '-',
    sales: 0,
  };

  const weakestDay = dayRanking.length > 0 ? dayRanking[dayRanking.length - 1] : bestDay;

  const bestWeekdayIndex = findPeakIndex(weekdaySales);
  const weakestWeekdayIndex = findWeakestActiveIndex(weekdaySales);
  const peakHourIndex = findPeakIndex(hourSales);
  const weakestHourIndex = findWeakestActiveIndex(hourSales);

  const weekdayLeaders = WEEKDAY_META.map((weekdayMeta): SalesAnalyticsWeekdayLeader => {
    let leaderName = 'Sem vendas';
    let leaderSales = 0;

    productMap.forEach((product) => {
      const qty = product.byWeekday[weekdayMeta.index];
      if (qty > leaderSales) {
        leaderSales = qty;
        leaderName = product.name;
      }
    });

    return {
      weekdayLabel: weekdayMeta.label,
      weekdayShortLabel: weekdayMeta.shortLabel,
      productName: leaderName,
      sales: leaderSales,
    };
  });

  const heatmap = WEEKDAY_META.map((weekdayMeta): SalesAnalyticsHeatmapRow => ({
    weekdayIndex: weekdayMeta.index,
    weekdayLabel: weekdayMeta.label,
    weekdayShortLabel: weekdayMeta.shortLabel,
    cells: HOUR_INDICES.map((hour) => ({
      hour,
      label: toHourLabel(hour),
      sales: heatmapSales[weekdayMeta.index][hour],
      revenue: roundMoney(heatmapRevenue[weekdayMeta.index][hour]),
    })),
  }));

  let cumulativeSales = 0;
  let cumulativeRevenue = 0;
  const cumulativeDaily = HOUR_INDICES.map((hour): SalesAnalyticsCumulativePoint => {
    const hourSalesCount = hourSales[hour];
    const hourRevenueValue = hourRevenue[hour];
    cumulativeSales += hourSalesCount;
    cumulativeRevenue = roundMoney(cumulativeRevenue + hourRevenueValue);

    return {
      hour,
      label: toHourLabel(hour),
      sales: hourSalesCount,
      revenue: roundMoney(hourRevenueValue),
      cumulativeSales,
      cumulativeRevenue,
    };
  });

  const orderList = [...orderMap.values()].sort((a, b) => a.date.getTime() - b.date.getTime());

  const ticketByPeriod = {
    day: buildTicketBuckets(orderList, 'day'),
    week: buildTicketBuckets(orderList, 'week'),
    month: buildTicketBuckets(orderList, 'month'),
  };

  const channelAccumulator = new Map<ChannelKey, SalesAnalyticsChannelEfficiencyPoint>();
  CHANNEL_ORDER.forEach((channel) => {
    channelAccumulator.set(channel, {
      channel,
      label: CHANNEL_LABELS[channel],
      orders: 0,
      revenue: 0,
      ticket: 0,
    });
  });

  const dayOrderStats = new Map<string, { orders: number; revenue: number }>();

  orderList.forEach((order) => {
    const revenue = resolveOrderRevenue(order);
    const channel = channelAccumulator.get(order.origin)!;
    channel.orders += 1;
    channel.revenue = roundMoney(channel.revenue + revenue);

    const dayKey = toDayKey(order.date);
    if (!dayOrderStats.has(dayKey)) {
      dayOrderStats.set(dayKey, { orders: 0, revenue: 0 });
    }
    const stats = dayOrderStats.get(dayKey)!;
    stats.orders += 1;
    stats.revenue = roundMoney(stats.revenue + revenue);
  });

  const channelEfficiency = CHANNEL_ORDER.map((channelKey) => {
    const entry = channelAccumulator.get(channelKey)!;
    return {
      ...entry,
      ticket: entry.orders > 0 ? roundMoney(entry.revenue / entry.orders) : 0,
    };
  });

  const dayTimeline = [...dayMap.values()]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map<SalesAnalyticsDayTimelinePoint>((day) => {
      const weekdayLabel = WEEKDAY_META[day.date.getDay()].label;
      const orderStats = dayOrderStats.get(day.dayKey);
      const orders = orderStats?.orders ?? 0;
      const ticket = orders > 0 ? roundMoney((orderStats?.revenue ?? day.revenue) / orders) : 0;

      return {
        dayKey: day.dayKey,
        dayLabel: day.dayLabel,
        weekdayLabel,
        sales: day.sales,
        orders,
        revenue: roundMoney(day.revenue),
        ticket,
      };
    });

  const deadHourSource = HOUR_INDICES.map((hour) => ({
    hour,
    sales: hourSales[hour],
  }));

  const deadHours = deadHourSource
    .filter((entry) => entry.sales > 0)
    .sort((a, b) => {
      if (a.sales !== b.sales) return a.sales - b.sales;
      return a.hour - b.hour;
    })
    .slice(0, 3)
    .map<SalesAnalyticsDeadHour>((entry) => {
      const nextHour = (entry.hour + 1) % 24;
      return {
        hour: entry.hour,
        label: toHourLabel(entry.hour),
        sales: entry.sales,
        suggestion: `Promocao sugerida entre ${toHourLabel(entry.hour)} e ${toHourLabel(nextHour)}.`,
      };
    });

  const revenueLeader = [...topProducts]
    .sort((a, b) => {
      if (b.revenue !== a.revenue) return b.revenue - a.revenue;
      return b.sales - a.sales;
    })[0];

  const productDependency: SalesAnalyticsProductDependency = {
    productName: revenueLeader?.name || 'Sem produto dominante',
    revenue: revenueLeader ? roundMoney(revenueLeader.revenue) : 0,
    share: revenueLeader && totalRevenue > 0 ? revenueLeader.revenue / totalRevenue : 0,
    isHighRisk: revenueLeader ? revenueLeader.revenue / Math.max(totalRevenue, 1) >= 0.5 : false,
  };

  const dailyRevenues = dayTimeline.map((entry) => entry.revenue);
  const averageDailyRevenue =
    dailyRevenues.length > 0
      ? dailyRevenues.reduce((sum, value) => sum + value, 0) / dailyRevenues.length
      : 0;

  const variance =
    dailyRevenues.length > 0
      ? dailyRevenues.reduce((sum, value) => sum + (value - averageDailyRevenue) ** 2, 0) /
        dailyRevenues.length
      : 0;

  const stddevDailyRevenue = Math.sqrt(Math.max(variance, 0));
  const variation = averageDailyRevenue > 0 ? stddevDailyRevenue / averageDailyRevenue : 0;

  let stabilityStatus: SalesAnalyticsStability['status'] = 'estavel';
  if (variation > 0.35) {
    stabilityStatus = 'instavel';
  } else if (variation > 0.18) {
    stabilityStatus = 'moderada';
  }

  const recentWindow = dayTimeline.slice(-3);
  const previousWindow = dayTimeline.slice(-6, -3);
  const recentAvg =
    recentWindow.length > 0
      ? recentWindow.reduce((sum, entry) => sum + entry.revenue, 0) / recentWindow.length
      : 0;
  const previousAvg =
    previousWindow.length > 0
      ? previousWindow.reduce((sum, entry) => sum + entry.revenue, 0) / previousWindow.length
      : 0;

  const shortTrendDelta = previousAvg > 0 ? (recentAvg - previousAvg) / previousAvg : 0;
  const stabilityTrend =
    previousWindow.length === 0 && recentWindow.length > 0 && recentAvg > 0
      ? 'crescimento'
      : classifyTrendByDelta(shortTrendDelta);

  const latestOrderDate = orderList.length > 0 ? orderList[orderList.length - 1].date : null;
  const currentWeekStart = latestOrderDate ? getWeekStart(latestOrderDate) : null;

  let currentWeekRevenue = 0;
  let previousWeekRevenue = 0;

  if (currentWeekStart) {
    const currentWeekEnd = addDays(currentWeekStart, 7);
    const previousWeekStart = addDays(currentWeekStart, -7);

    orderList.forEach((order) => {
      const revenue = resolveOrderRevenue(order);
      if (order.date >= currentWeekStart && order.date < currentWeekEnd) {
        currentWeekRevenue = roundMoney(currentWeekRevenue + revenue);
      } else if (order.date >= previousWeekStart && order.date < currentWeekStart) {
        previousWeekRevenue = roundMoney(previousWeekRevenue + revenue);
      }
    });
  }

  const weeklyChange = roundMoney(currentWeekRevenue - previousWeekRevenue);
  const weeklyChangePercent =
    previousWeekRevenue > 0
      ? (currentWeekRevenue - previousWeekRevenue) / previousWeekRevenue
      : currentWeekRevenue > 0
        ? 1
        : 0;

  const weeklyTrendStatus: SalesAnalyticsWeeklyTrend['status'] =
    previousWeekRevenue === 0 && currentWeekRevenue === 0
      ? 'estavel'
      : classifyTrendByDelta(weeklyChangePercent);

  const intelligence: SalesAnalyticsIntelligence = {
    deadHours,
    productDependency,
    salesStability: {
      averageDailyRevenue: roundMoney(averageDailyRevenue),
      stddevDailyRevenue: roundMoney(stddevDailyRevenue),
      variation,
      status: stabilityStatus,
      trend: stabilityTrend,
    },
    weeklyTrend: {
      currentWeekRevenue,
      previousWeekRevenue,
      change: weeklyChange,
      changePercent: weeklyChangePercent,
      status: weeklyTrendStatus,
    },
  };

  const snapshot: SalesAnalyticsSnapshot = {
    totals: {
      sales: validSalesCount,
      orders: orderList.length,
      revenue: roundMoney(totalRevenue),
      distinctProducts: productMap.size,
      activeDays: dayMap.size,
    },
    peaks: {
      bestWeekdayLabel: WEEKDAY_META[bestWeekdayIndex].label,
      bestWeekdayShortLabel: WEEKDAY_META[bestWeekdayIndex].shortLabel,
      bestWeekdaySales: weekdaySales[bestWeekdayIndex],
      weakestWeekdayLabel: WEEKDAY_META[weakestWeekdayIndex].label,
      weakestWeekdayShortLabel: WEEKDAY_META[weakestWeekdayIndex].shortLabel,
      weakestWeekdaySales: weekdaySales[weakestWeekdayIndex],
      peakHourLabel: toHourLabel(peakHourIndex),
      peakHourSales: hourSales[peakHourIndex],
      weakestHourLabel: toHourLabel(weakestHourIndex),
      weakestHourSales: hourSales[weakestHourIndex],
      bestDayLabel: bestDay.dayLabel,
      bestDaySales: bestDay.sales,
      weakestDayLabel: weakestDay.dayLabel,
      weakestDaySales: weakestDay.sales,
    },
    momentsOfDay: [
      { key: 'madrugada', label: 'Madrugada', sales: moments.madrugada },
      { key: 'manha', label: 'Manha', sales: moments.manha },
      { key: 'tarde', label: 'Tarde', sales: moments.tarde },
      { key: 'noite', label: 'Noite', sales: moments.noite },
    ],
    charts: {
      weekday: WEEKDAY_META.map((weekdayMeta) => ({
        label: weekdayMeta.shortLabel,
        sales: weekdaySales[weekdayMeta.index],
        revenue: roundMoney(weekdayRevenue[weekdayMeta.index]),
      })),
      hourly: HOUR_INDICES.map((hour) => ({
        label: toHourLabel(hour),
        sales: hourSales[hour],
        revenue: roundMoney(hourRevenue[hour]),
      })),
      topProducts: topProducts.slice(0, 10).map((product) => ({
        key: product.key,
        label: product.name,
        sales: product.sales,
        revenue: roundMoney(product.revenue),
      })),
      heatmap,
      cumulativeDaily,
      ticketByPeriod,
      channelEfficiency,
    },
    topProducts,
    weekdayLeaders,
    dayRanking,
    dayTimeline,
    intelligence,
  };

  return snapshot;
};
