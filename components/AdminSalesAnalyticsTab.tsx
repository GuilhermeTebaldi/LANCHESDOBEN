import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Product, Sale } from '../types';
import { APP_ORIGINS, buildAppChannelSummary } from '../utils/appChannelSummary';
import { DASHBOARD_CHART_COLORS, DASHBOARD_TOOLTIP_STYLE } from '../utils/chartTheme';
import { buildSalesAnalytics } from '../utils/salesAnalytics';

interface AdminSalesAnalyticsTabProps {
  sales: Sale[];
  products: Product[];
}

type TicketPeriod = 'day' | 'week' | 'month';
type EfficiencyMetric = 'orders' | 'revenue' | 'ticket';

const CURRENCY_FORMATTER = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const PERCENT_FORMATTER = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const APP_ORIGIN_LABELS = {
  IFOOD: 'iFood',
  APP99: '99',
  KEETA: 'Keeta',
} as const;

const TICKET_PERIOD_OPTIONS: Array<{ key: TicketPeriod; label: string }> = [
  { key: 'day', label: 'Dia' },
  { key: 'week', label: 'Semana' },
  { key: 'month', label: 'Mes' },
];

const EFFICIENCY_METRIC_OPTIONS: Array<{ key: EfficiencyMetric; label: string }> = [
  { key: 'orders', label: 'Pedidos' },
  { key: 'revenue', label: 'Faturamento' },
  { key: 'ticket', label: 'Media por Pedido' },
];

const CHANNEL_COLORS: Record<string, string> = {
  LOCAL: DASHBOARD_CHART_COLORS.local,
  IFOOD: DASHBOARD_CHART_COLORS.ifood,
  APP99: DASHBOARD_CHART_COLORS.app99,
  KEETA: DASHBOARD_CHART_COLORS.keeta,
};

const truncateLabel = (value: string, max = 18): string =>
  value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;

const formatCurrency = (value: number): string => CURRENCY_FORMATTER.format(value || 0);

const formatInt = (value: number): string => `${Math.round(value || 0)}`;

const formatPercent = (value: number): string => PERCENT_FORMATTER.format(Number.isFinite(value) ? value : 0);

const resolveProductImage = (
  productKey: string,
  productId: string | undefined,
  productsById: Map<string, string>,
  productsByKey: Map<string, string>
): string | null => {
  if (productId && productsById.has(productId)) {
    return productsById.get(productId) || null;
  }
  if (productsByKey.has(productKey)) {
    return productsByKey.get(productKey) || null;
  }
  return null;
};

const getHeatmapColor = (value: number, max: number): string => {
  if (max <= 0 || value <= 0) return DASHBOARD_CHART_COLORS.heatLow;
  const ratio = value / max;
  if (ratio <= 0.25) return DASHBOARD_CHART_COLORS.heatSoft;
  if (ratio <= 0.5) return DASHBOARD_CHART_COLORS.heatMid;
  if (ratio <= 0.75) return '#3b82f6';
  return DASHBOARD_CHART_COLORS.heatHigh;
};

const SectionHeader = ({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) => (
  <div className="mb-4">
    <h4 className="text-sm font-black text-slate-900 uppercase tracking-widest">{title}</h4>
    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mt-1">{subtitle}</p>
  </div>
);

const StatCard = ({
  title,
  value,
  helper,
  tone = 'slate',
}: {
  title: string;
  value: string;
  helper?: string;
  tone?: 'blue' | 'green' | 'amber' | 'slate';
}) => {
  const toneByStyle = {
    blue: 'bg-blue-50 border-blue-100 text-blue-700',
    green: 'bg-green-50 border-green-100 text-green-700',
    amber: 'bg-amber-50 border-amber-100 text-amber-700',
    slate: 'bg-slate-50 border-slate-100 text-slate-700',
  }[tone];

  return (
    <div className={`rounded-3xl border p-5 ${toneByStyle}`}>
      <p className="text-[10px] font-black uppercase tracking-widest opacity-75">{title}</p>
      <p className="mt-1 text-3xl font-black">{value}</p>
      {helper ? <p className="mt-1 text-[10px] font-bold uppercase tracking-wider opacity-70">{helper}</p> : null}
    </div>
  );
};

const AdminSalesAnalyticsTab: React.FC<AdminSalesAnalyticsTabProps> = ({ sales, products }) => {
  const analytics = useMemo(() => buildSalesAnalytics(sales), [sales]);
  const appChannelSummary = useMemo(() => buildAppChannelSummary(sales), [sales]);

  const [selectedProductKey, setSelectedProductKey] = useState<string | null>(null);
  const [ticketPeriod, setTicketPeriod] = useState<TicketPeriod>('day');
  const [efficiencyMetric, setEfficiencyMetric] = useState<EfficiencyMetric>('orders');

  const productsById = useMemo(() => {
    const map = new Map<string, string>();
    products.forEach((product) => {
      if (!product.imageUrl) return;
      map.set(product.id, product.imageUrl);
    });
    return map;
  }, [products]);

  const productsByKey = useMemo(() => {
    const map = new Map<string, string>();
    products.forEach((product) => {
      if (!product.imageUrl) return;
      map.set(product.name.trim().toLocaleLowerCase('pt-BR'), product.imageUrl);
    });
    return map;
  }, [products]);

  useEffect(() => {
    if (analytics.topProducts.length === 0) {
      if (selectedProductKey !== null) {
        setSelectedProductKey(null);
      }
      return;
    }

    const stillExists = selectedProductKey
      ? analytics.topProducts.some((product) => product.key === selectedProductKey)
      : false;

    if (!stillExists) {
      setSelectedProductKey(analytics.topProducts[0].key);
    }
  }, [analytics.topProducts, selectedProductKey]);

  const selectedProduct =
    analytics.topProducts.find((product) => product.key === selectedProductKey) ||
    analytics.topProducts[0];

  const selectedProductImage = selectedProduct
    ? resolveProductImage(selectedProduct.key, selectedProduct.productId, productsById, productsByKey)
    : null;

  const heatmapMax = useMemo(
    () =>
      analytics.charts.heatmap.reduce((maxRow, row) => {
        const rowMax = row.cells.reduce((maxCell, cell) => Math.max(maxCell, cell.sales), 0);
        return Math.max(maxRow, rowMax);
      }, 0),
    [analytics.charts.heatmap]
  );

  const ticketSeries = analytics.charts.ticketByPeriod[ticketPeriod];

  const efficiencySeries = useMemo(
    () =>
      analytics.charts.channelEfficiency.map((entry) => ({
        ...entry,
        value:
          efficiencyMetric === 'orders'
            ? entry.orders
            : efficiencyMetric === 'revenue'
              ? entry.revenue
              : entry.ticket,
      })),
    [analytics.charts.channelEfficiency, efficiencyMetric]
  );

  const topTimeline = useMemo(
    () =>
      [...analytics.dayTimeline]
        .sort((a, b) => {
          if (b.revenue !== a.revenue) return b.revenue - a.revenue;
          return a.dayKey.localeCompare(b.dayKey);
        })
        .slice(0, 10),
    [analytics.dayTimeline]
  );

  const stabilityToneClass =
    analytics.intelligence.salesStability.status === 'estavel'
      ? 'text-emerald-700'
      : analytics.intelligence.salesStability.status === 'moderada'
        ? 'text-amber-700'
        : 'text-red-700';

  const weeklyTrendToneClass =
    analytics.intelligence.weeklyTrend.status === 'crescimento'
      ? 'text-emerald-700'
      : analytics.intelligence.weeklyTrend.status === 'queda'
        ? 'text-red-700'
        : 'text-slate-700';

  const appDeltaDirectionLabel =
    appChannelSummary.totalDelta > 0
      ? 'Acima do balcao'
      : appChannelSummary.totalDelta < 0
        ? 'Abaixo do balcao'
        : 'Mesmo valor do balcao';

  if (analytics.totals.sales === 0) {
    return (
      <div className="qb-admin-panel qb-admin-analytics bg-slate-100 p-8 rounded-[40px] border-2 border-slate-200 min-h-[600px]">
        <div className="qb-admin-panel-head flex items-center gap-3 mb-8">
          <div className="bg-emerald-600 p-3 rounded-2xl shadow-lg">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
            >
              <path d="M3 3v18h18" />
              <path d="m7 15 3-3 3 3 5-5" />
            </svg>
          </div>
          <div>
            <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">
              Inteligencia de Vendas
            </h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
              Aguardando dados de vendas para gerar os indicadores.
            </p>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 py-24 text-center">
          <p className="text-xs font-black uppercase tracking-widest text-slate-400">
            Sem vendas historicas para analisar.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="qb-admin-panel qb-admin-analytics bg-slate-100 p-8 rounded-[40px] border-2 border-slate-200 min-h-[600px] space-y-6">
      <div className="qb-admin-panel-head flex items-center gap-3">
        <div className="bg-emerald-600 p-3 rounded-2xl shadow-lg">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
          >
            <path d="M3 3v18h18" />
            <path d="m7 15 3-3 3 3 5-5" />
          </svg>
        </div>
        <div>
          <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tighter">
            Inteligencia de Vendas
          </h3>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
            Painel analitico com comportamento comercial, canais e inteligencia de operacao.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <SectionHeader
          title="Bloco 1 · Indicadores Rapidos"
          subtitle="Vendas analisadas, faturamento, melhor/pior dia e horarios de pico"
        />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <StatCard
            title="Vendas Analisadas"
            value={formatInt(analytics.totals.sales)}
            helper={`${analytics.totals.activeDays} dias ativos`}
            tone="blue"
          />
          <StatCard
            title="Faturamento Historico"
            value={formatCurrency(analytics.totals.revenue)}
            helper={`${analytics.totals.orders} pedidos agrupados`}
            tone="green"
          />
          <StatCard
            title="Dia Mais Forte"
            value={analytics.peaks.bestWeekdayLabel}
            helper={`${formatInt(analytics.peaks.bestWeekdaySales)} vendas`}
            tone="amber"
          />
          <StatCard
            title="Dia Mais Fraco"
            value={analytics.peaks.weakestWeekdayLabel}
            helper={`${formatInt(analytics.peaks.weakestWeekdaySales)} vendas`}
            tone="slate"
          />
          <StatCard
            title="Horario Pico"
            value={analytics.peaks.peakHourLabel}
            helper={`${formatInt(analytics.peaks.peakHourSales)} vendas`}
            tone="blue"
          />
          <StatCard
            title="Horario Menor"
            value={analytics.peaks.weakestHourLabel}
            helper={`${formatInt(analytics.peaks.weakestHourSales)} vendas`}
            tone="slate"
          />
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <SectionHeader
          title="Bloco 2 · Comportamento de Vendas"
          subtitle="Dia da semana, hora, mapa de calor, curva acumulada, media por pedido e momentos do dia"
        />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">
              Vendas por Dia da Semana
            </h5>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.charts.weekday}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                  <XAxis dataKey="label" tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 11, fontWeight: 700 }} />
                  <YAxis allowDecimals={false} tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }} />
                  <Tooltip
                    contentStyle={DASHBOARD_TOOLTIP_STYLE}
                    formatter={(value: number, key: string) =>
                      key === 'revenue' ? formatCurrency(value) : formatInt(value)
                    }
                    labelFormatter={(label) => `Dia: ${label}`}
                  />
                  <Bar dataKey="sales" name="vendas" radius={[8, 8, 0, 0]} fill={DASHBOARD_CHART_COLORS.sales} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">Vendas por Hora</h5>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={analytics.charts.hourly}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                  <XAxis
                    dataKey="label"
                    interval={1}
                    tickFormatter={(value: string) => value.slice(0, 2)}
                    tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 10, fontWeight: 700 }}
                  />
                  <YAxis allowDecimals={false} tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }} />
                  <Tooltip
                    contentStyle={DASHBOARD_TOOLTIP_STYLE}
                    formatter={(value: number, key: string) =>
                      key === 'revenue' ? formatCurrency(value) : formatInt(value)
                    }
                    labelFormatter={(label) => `Hora: ${label}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="sales"
                    name="vendas"
                    stroke={DASHBOARD_CHART_COLORS.profit}
                    strokeWidth={3}
                    dot={false}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">
              Heatmap Dia x Hora
            </h5>
            <div className="overflow-x-auto">
              <table className="min-w-[900px] w-full border-separate border-spacing-1">
                <thead>
                  <tr>
                    <th className="text-left text-[10px] font-black uppercase tracking-widest text-slate-400 px-1 py-1">
                      Dia
                    </th>
                    {analytics.charts.cumulativeDaily.map((point) => (
                      <th
                        key={point.hour}
                        className="text-center text-[10px] font-black uppercase tracking-widest text-slate-400 px-1 py-1"
                      >
                        {point.label.replace('h', '')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {analytics.charts.heatmap.map((row) => (
                    <tr key={row.weekdayIndex}>
                      <td className="text-[10px] font-black uppercase tracking-widest text-slate-600 px-1 py-1">
                        {row.weekdayShortLabel}
                      </td>
                      {row.cells.map((cell) => (
                        <td key={`${row.weekdayIndex}-${cell.hour}`} className="px-1 py-1">
                          <div
                            className="h-6 rounded-md flex items-center justify-center text-[9px] font-black text-slate-700"
                            style={{ backgroundColor: getHeatmapColor(cell.sales, heatmapMax) }}
                            title={`${row.weekdayLabel} ${cell.label}: ${cell.sales} vendas | ${formatCurrency(cell.revenue)}`}
                          >
                            {cell.sales > 0 ? cell.sales : ''}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">
              Curva Acumulada do Dia
            </h5>
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={analytics.charts.cumulativeDaily}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                  <XAxis
                    dataKey="label"
                    interval={1}
                    tickFormatter={(value: string) => value.slice(0, 2)}
                    tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 10, fontWeight: 700 }}
                  />
                  <YAxis
                    yAxisId="left"
                    allowDecimals={false}
                    tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                    tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }}
                  />
                  <Tooltip
                    contentStyle={DASHBOARD_TOOLTIP_STYLE}
                    formatter={(value: number, key: string) =>
                      key === 'cumulativeRevenue' ? formatCurrency(value) : formatInt(value)
                    }
                    labelFormatter={(label) => `Hora: ${label}`}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="cumulativeSales"
                    name="vendas acumuladas"
                    stroke={DASHBOARD_CHART_COLORS.sales}
                    strokeWidth={3}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cumulativeRevenue"
                    name="faturamento acumulado"
                    stroke={DASHBOARD_CHART_COLORS.ticket}
                    strokeWidth={3}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-slate-100 p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700">Media por Pedido por Periodo</h5>
              <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
                {TICKET_PERIOD_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    onClick={() => setTicketPeriod(option.key)}
                    className={`qb-btn-touch px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${
                      ticketPeriod === option.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:bg-slate-200'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ticketSeries}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                  <XAxis dataKey="label" tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 10, fontWeight: 700 }} />
                  <YAxis tickFormatter={(value: number) => `${Math.round(value)}`} tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }} />
                  <Tooltip
                    contentStyle={DASHBOARD_TOOLTIP_STYLE}
                    formatter={(value: number, key: string, entry: any) => {
                      if (key === 'ticket') return formatCurrency(value);
                      if (key === 'orders') return formatInt(value);
                      if (key === 'revenue') return formatCurrency(value);
                      return String(value);
                    }}
                    labelFormatter={(label) => `Periodo: ${label}`}
                  />
                  <Bar dataKey="ticket" name="media por pedido" radius={[8, 8, 0, 0]} fill={DASHBOARD_CHART_COLORS.ticket} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">Momentos do Dia</h5>
            <div className="grid grid-cols-2 gap-3">
              {analytics.momentsOfDay.map((moment) => (
                <div key={moment.key} className="bg-slate-50 border border-slate-100 rounded-2xl p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{moment.label}</p>
                  <p className="text-2xl font-black text-slate-900">{moment.sales}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-1">vendas</p>
                </div>
              ))}
            </div>
            <div className="mt-4 bg-blue-50 border border-blue-100 rounded-2xl p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-blue-700">Media Atual por Pedido ({ticketPeriod})</p>
              <p className="text-sm font-black text-blue-900 mt-1">
                {ticketSeries.length > 0
                  ? formatCurrency(ticketSeries[ticketSeries.length - 1].ticket)
                  : formatCurrency(0)}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <SectionHeader
          title="Bloco 3 · Produtos"
          subtitle="Ranking por quantidade, liderancas por dia e historico do produto selecionado"
        />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">
              Ranking de Produtos (Quantidade)
            </h5>
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={analytics.charts.topProducts}
                  layout="vertical"
                  margin={{ top: 4, right: 12, bottom: 4, left: 10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={140}
                    tickFormatter={(value) => truncateLabel(value)}
                    tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 11, fontWeight: 700 }}
                  />
                  <Tooltip
                    contentStyle={DASHBOARD_TOOLTIP_STYLE}
                    formatter={(value: number, key: string) =>
                      key === 'revenue' ? formatCurrency(value) : formatInt(value)
                    }
                    labelFormatter={(label) => `Produto: ${label}`}
                  />
                  <Bar dataKey="sales" name="vendas" radius={[0, 8, 8, 0]}>
                    {analytics.charts.topProducts.map((entry, index) => (
                      <Cell
                        key={entry.key || entry.label}
                        fill={index % 2 === 0 ? DASHBOARD_CHART_COLORS.sales : '#38bdf8'}
                        fillOpacity={!selectedProduct || selectedProduct.key === entry.key ? 1 : 0.35}
                        stroke={selectedProduct?.key === entry.key ? '#0f172a' : 'transparent'}
                        strokeWidth={selectedProduct?.key === entry.key ? 1.5 : 0}
                        className="cursor-pointer"
                        onClick={() => {
                          if (entry.key) {
                            setSelectedProductKey(entry.key);
                          }
                        }}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">
              Produto Selecionado
            </h5>
            {selectedProduct ? (
              <div className="grid grid-cols-1 md:grid-cols-[130px_1fr] gap-4">
                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-3 flex items-center justify-center">
                  {selectedProductImage ? (
                    <img
                      src={selectedProductImage}
                      alt={selectedProduct.name}
                      className="w-full h-[120px] object-cover rounded-xl"
                    />
                  ) : (
                    <div className="w-full h-[120px] rounded-xl bg-slate-200 text-slate-500 flex items-center justify-center text-[10px] font-black uppercase tracking-widest">
                      Sem imagem
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-black text-slate-800 uppercase">{selectedProduct.name}</p>
                    <p className="text-[10px] font-bold text-slate-500 uppercase">
                      {selectedProduct.sales} vendas | {formatCurrency(selectedProduct.revenue)}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-blue-50 border border-blue-100 rounded-xl px-3 py-2">
                      <p className="text-[10px] font-black uppercase tracking-wider text-blue-700">Melhor Dia</p>
                      <p className="text-xs font-black text-blue-900">{selectedProduct.bestWeekdayLabel}</p>
                    </div>
                    <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2">
                      <p className="text-[10px] font-black uppercase tracking-wider text-emerald-700">Melhor Momento</p>
                      <p className="text-xs font-black text-emerald-900">{selectedProduct.bestMomentLabel}</p>
                    </div>
                  </div>
                  <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
                    <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">Melhor Horario</p>
                    <p className="text-xs font-black text-amber-900">
                      {selectedProduct.bestHourLabel} ({selectedProduct.bestHourSales} vendas)
                    </p>
                  </div>
                  <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">
                      Horarios de maior venda
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {selectedProduct.topHourSlots.length > 0 ? (
                        selectedProduct.topHourSlots.map((slot) => (
                          <div
                            key={`${selectedProduct.key}-${slot.label}`}
                            className="bg-white border border-slate-200 rounded-xl px-3 py-2"
                          >
                            <p className="text-[10px] font-black text-slate-700">{slot.label}</p>
                            <p className="text-[10px] font-bold text-slate-500 uppercase">{slot.sales} vendas</p>
                          </div>
                        ))
                      ) : (
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Sem horario dominante
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-12 text-center text-[10px] font-black uppercase tracking-widest text-slate-400">
                Sem produto selecionado
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">
              Produto Lider por Dia da Semana
            </h5>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400">Dia</th>
                    <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400">Produto Lider</th>
                    <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Qtd</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {analytics.weekdayLeaders.map((entry) => (
                    <tr key={entry.weekdayLabel}>
                      <td className="px-2 py-3 text-xs font-black text-slate-700">{entry.weekdayLabel}</td>
                      <td className="px-2 py-3 text-xs font-bold text-slate-800 uppercase">{entry.productName}</td>
                      <td className="px-2 py-3 text-xs font-black text-slate-700 text-right">{entry.sales}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">
              Melhores e Piores Dias
            </h5>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-green-50 border border-green-100 rounded-2xl p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-green-600">Melhor Dia</p>
                <p className="text-lg font-black text-green-700 mt-1">{analytics.peaks.bestDayLabel}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-green-700">
                  {analytics.peaks.bestDaySales} vendas
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-100 rounded-2xl p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">Dia Menor</p>
                <p className="text-lg font-black text-slate-800 mt-1">{analytics.peaks.weakestDayLabel}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-700">
                  {analytics.peaks.weakestDaySales} vendas
                </p>
              </div>
            </div>
            <div className="space-y-2 max-h-[190px] overflow-y-auto pr-2 scrollbar-hide">
              {analytics.topProducts.slice(0, 10).map((product) => (
                <div
                  key={product.key}
                  className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-100 rounded-2xl px-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-black text-slate-800 uppercase truncate">{product.name}</p>
                    <p className="text-[10px] font-bold text-slate-500 uppercase">
                      Melhor dia: {product.bestWeekdayLabel} ({product.bestWeekdaySales})
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs font-black text-slate-900">{product.sales} vendas</p>
                    <p className="text-[10px] font-bold text-green-700">{formatCurrency(product.revenue)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <SectionHeader
          title="Bloco 4 · Aplicativos"
          subtitle="Comparativo por canal com pedidos, faturamento e media por pedido"
        />

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div className="bg-slate-100 border border-slate-200 rounded-2xl p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Pedidos App</p>
            <p className="text-xl font-black text-slate-900">{appChannelSummary.totalOrders}</p>
          </div>
          <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">Faturamento Apps</p>
            <p className="text-xl font-black text-amber-800">{formatCurrency(appChannelSummary.totalRevenue)}</p>
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-600">Valor no Balcao</p>
            <p className="text-xl font-black text-slate-900">{formatCurrency(appChannelSummary.totalReference)}</p>
          </div>
          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-blue-700">Diferenca de Preco</p>
            <p className={`text-xl font-black ${appChannelSummary.totalDelta >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
              {formatCurrency(appChannelSummary.totalDelta)}
            </p>
            <p className="text-[10px] font-black uppercase tracking-wider text-blue-700 mt-1">
              Valor nos apps - valor no balcao
            </p>
            <p className="text-[10px] font-black uppercase tracking-wider text-blue-700 mt-1">
              {appDeltaDirectionLabel}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          {APP_ORIGINS.map((origin) => {
            const originSummary = appChannelSummary.byOrigin[origin];
            return (
              <div key={origin} className="bg-slate-50 border border-slate-200 rounded-2xl p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-black uppercase text-slate-800">{APP_ORIGIN_LABELS[origin]}</p>
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                    Pedidos: {originSummary.orders}
                  </p>
                </div>
                <p className="text-xs font-black text-slate-700 mt-2">Faturamento: {formatCurrency(originSummary.revenue)}</p>
                <p className={`text-[10px] font-black uppercase tracking-wider mt-1 ${originSummary.delta >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  Diferenca de preco: {formatCurrency(originSummary.delta)}
                </p>
              </div>
            );
          })}
        </div>

        <div className="rounded-2xl border border-slate-100 p-4 mb-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700">Desempenho por Canal</h5>
            <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
              {EFFICIENCY_METRIC_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  onClick={() => setEfficiencyMetric(option.key)}
                  className={`qb-btn-touch px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${
                    efficiencyMetric === option.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="h-[270px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={efficiencySeries}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={DASHBOARD_CHART_COLORS.grid} />
                <XAxis dataKey="label" tick={{ fill: DASHBOARD_CHART_COLORS.axis, fontSize: 11, fontWeight: 700 }} />
                <YAxis
                  allowDecimals={efficiencyMetric !== 'orders'}
                  tickFormatter={(value: number) =>
                    efficiencyMetric === 'orders'
                      ? formatInt(value)
                      : efficiencyMetric === 'revenue'
                        ? `${Math.round(value / 1000)}k`
                        : `${Math.round(value)}`
                  }
                  tick={{ fill: DASHBOARD_CHART_COLORS.mutedAxis, fontSize: 11, fontWeight: 700 }}
                />
                <Tooltip
                  contentStyle={DASHBOARD_TOOLTIP_STYLE}
                  formatter={(value: number) =>
                    efficiencyMetric === 'orders' ? formatInt(value) : formatCurrency(value)
                  }
                  labelFormatter={(label) => `Canal: ${label}`}
                />
                <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                  {efficiencySeries.map((entry) => (
                    <Cell key={entry.channel} fill={CHANNEL_COLORS[entry.channel] || DASHBOARD_CHART_COLORS.sales} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400">Canal</th>
                <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Pedidos</th>
                <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Faturamento</th>
                <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Media por Pedido</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {analytics.charts.channelEfficiency.map((entry) => (
                <tr key={entry.channel}>
                  <td className="px-2 py-3 text-xs font-black text-slate-700">{entry.label}</td>
                  <td className="px-2 py-3 text-xs font-black text-slate-700 text-right">{entry.orders}</td>
                  <td className="px-2 py-3 text-xs font-black text-slate-900 text-right">{formatCurrency(entry.revenue)}</td>
                  <td className="px-2 py-3 text-xs font-black text-blue-700 text-right">{formatCurrency(entry.ticket)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <SectionHeader
          title="Bloco 5 · Inteligencia Comercial"
          subtitle="Horas mortas, dependencia de produto, estabilidade e tendencia semanal"
        />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">Horas Mortas</h5>
            <div className="space-y-2">
              {analytics.intelligence.deadHours.length > 0 ? (
                analytics.intelligence.deadHours.map((hour) => (
                  <div key={hour.hour} className="bg-amber-50 border border-amber-100 rounded-xl p-3">
                    <p className="text-xs font-black text-amber-800 uppercase">{hour.label}</p>
                    <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 mt-1">
                      {hour.sales} vendas
                    </p>
                    <p className="text-[10px] font-bold text-slate-600 mt-1">{hour.suggestion}</p>
                  </div>
                ))
              ) : (
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                  Sem horas mortas suficientes para analise.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">Dependencia de Produto</h5>
            <div className={`rounded-2xl border p-4 ${analytics.intelligence.productDependency.isHighRisk ? 'bg-red-50 border-red-100' : 'bg-emerald-50 border-emerald-100'}`}>
              <p className="text-xs font-black uppercase text-slate-800">{analytics.intelligence.productDependency.productName}</p>
              <p className="text-xl font-black text-slate-900 mt-1">{formatCurrency(analytics.intelligence.productDependency.revenue)}</p>
              <p className={`text-[10px] font-black uppercase tracking-widest mt-2 ${analytics.intelligence.productDependency.isHighRisk ? 'text-red-700' : 'text-emerald-700'}`}>
                Participacao: {formatPercent(analytics.intelligence.productDependency.share)}
              </p>
              <p className={`text-[10px] font-bold mt-1 ${analytics.intelligence.productDependency.isHighRisk ? 'text-red-700' : 'text-emerald-700'}`}>
                {analytics.intelligence.productDependency.isHighRisk
                  ? 'Alerta: negocio dependente de um unico item.'
                  : 'Dependencia distribuida entre produtos.'}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">Estabilidade de Vendas</h5>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Media diaria</p>
                <p className="text-sm font-black text-slate-900 mt-1">
                  {formatCurrency(analytics.intelligence.salesStability.averageDailyRevenue)}
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Desvio padrao</p>
                <p className="text-sm font-black text-slate-900 mt-1">
                  {formatCurrency(analytics.intelligence.salesStability.stddevDailyRevenue)}
                </p>
              </div>
            </div>
            <p className={`text-xs font-black uppercase mt-3 ${stabilityToneClass}`}>
              Status: {analytics.intelligence.salesStability.status}
            </p>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mt-1">
              Variacao: {formatPercent(analytics.intelligence.salesStability.variation)}
            </p>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mt-1">
              Tendencia curta: {analytics.intelligence.salesStability.trend}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-100 p-4">
            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">Tendencia Semanal</h5>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Semana Atual</p>
                <p className="text-sm font-black text-slate-900 mt-1">
                  {formatCurrency(analytics.intelligence.weeklyTrend.currentWeekRevenue)}
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-100 rounded-xl p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Semana Anterior</p>
                <p className="text-sm font-black text-slate-900 mt-1">
                  {formatCurrency(analytics.intelligence.weeklyTrend.previousWeekRevenue)}
                </p>
              </div>
            </div>
            <p className={`text-sm font-black uppercase ${weeklyTrendToneClass}`}>
              {analytics.intelligence.weeklyTrend.status}
            </p>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mt-1">
              Variacao: {formatPercent(analytics.intelligence.weeklyTrend.changePercent)}
            </p>
            <p className={`text-[10px] font-black uppercase tracking-widest mt-1 ${analytics.intelligence.weeklyTrend.change >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              Variacao em Reais: {formatCurrency(analytics.intelligence.weeklyTrend.change)}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-100 p-4">
          <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-700 mb-3">
            Historico Diario (10 Maiores Faturamentos)
          </h5>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-left">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400">Dia</th>
                  <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Vendas</th>
                  <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Pedidos</th>
                  <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Faturamento</th>
                  <th className="px-2 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Media por Pedido</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {topTimeline.map((entry) => (
                  <tr key={entry.dayKey}>
                    <td className="px-2 py-3 text-xs font-black text-slate-700">
                      {entry.dayLabel} <span className="text-slate-400">({entry.weekdayLabel})</span>
                    </td>
                    <td className="px-2 py-3 text-xs font-black text-slate-700 text-right">{entry.sales}</td>
                    <td className="px-2 py-3 text-xs font-black text-slate-700 text-right">{entry.orders}</td>
                    <td className="px-2 py-3 text-xs font-black text-slate-900 text-right">{formatCurrency(entry.revenue)}</td>
                    <td className="px-2 py-3 text-xs font-black text-blue-700 text-right">{formatCurrency(entry.ticket)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminSalesAnalyticsTab;
