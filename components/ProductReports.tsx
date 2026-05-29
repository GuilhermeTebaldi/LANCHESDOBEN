import React, { useMemo, useState } from 'react';
import { DailySalesHistoryEntry, Sale } from '../types';
import {
  groupSalesByBusinessDay,
  normalizeBusinessDayKey,
  resolveSessionBusinessDayKey,
} from '../utils/businessDay';

interface ProductReportsProps {
  sales: Sale[];
  archivedSales?: Sale[];
  dailySalesHistory?: DailySalesHistoryEntry[];
  activeBusinessDate?: string | null;
}

const ProductReports: React.FC<ProductReportsProps> = ({
  sales,
  archivedSales = [],
  dailySalesHistory = [],
  activeBusinessDate = null,
}) => {
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const normalizedBusinessDate = normalizeBusinessDayKey(activeBusinessDate);
    if (normalizedBusinessDate) return normalizedBusinessDate;
    return resolveSessionBusinessDayKey(sales, [], activeBusinessDate);
  });

  const mergedSales = useMemo(() => {
    const byId = new Map<string, Sale>();
    [...archivedSales, ...sales].forEach((sale) => {
      const key = typeof sale.id === 'string' && sale.id.trim() ? sale.id.trim() : `${sale.productId}-${sale.timestamp}`;
      if (!byId.has(key)) {
        byId.set(key, sale);
      }
    });
    return [...byId.values()];
  }, [archivedSales, sales]);

  const businessDaySalesMap = useMemo(
    () =>
      groupSalesByBusinessDay(mergedSales, dailySalesHistory, {
        activeBusinessDate,
        currentSessionSaleIds: new Set(sales.map((sale) => sale.id)),
      }),
    [activeBusinessDate, dailySalesHistory, mergedSales, sales]
  );

  const daySales = useMemo(() => businessDaySalesMap.get(selectedDate) || [], [businessDaySalesMap, selectedDate]);

  const productRows = useMemo(() => {
    const grouped = new Map<
      string,
      {
        name: string;
        qty: number;
      }
    >();

    daySales.forEach((sale) => {
      const name = (sale.productName || 'Sem nome').trim() || 'Sem nome';
      const current = grouped.get(name) || { name, qty: 0 };
      current.qty += 1;
      grouped.set(name, current);
    });

    return [...grouped.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  }, [daySales]);

  const totalItemsSold = daySales.length;
  const topProduct = productRows[0] || null;

  return (
    <div className="qb-product-reports p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="bg-white border-2 border-slate-100 rounded-3xl p-4 sm:p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h2 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-tight">RELATORIOS</h2>
            <p className="text-slate-500 font-semibold text-sm">Vendas por produto no dia selecionado.</p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Selecionar dia</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => setSelectedDate(event.target.value)}
                className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 focus:border-red-400 focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                const normalizedBusinessDate = normalizeBusinessDayKey(activeBusinessDate);
                if (normalizedBusinessDate) {
                  setSelectedDate(normalizedBusinessDate);
                  return;
                }
                setSelectedDate(resolveSessionBusinessDayKey(sales, [], activeBusinessDate));
              }}
              className="qb-btn-touch h-11 rounded-xl bg-slate-900 px-4 text-[11px] font-black uppercase tracking-widest text-white hover:bg-black transition-colors"
            >
              Hoje
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-red-600 text-white rounded-3xl p-5 shadow-lg">
          <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Total de itens vendidos</p>
          <p className="mt-1 text-4xl font-black">{totalItemsSold}</p>
        </div>
        <div className="bg-slate-900 text-white rounded-3xl p-5 shadow-lg">
          <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Produtos diferentes</p>
          <p className="mt-1 text-4xl font-black">{productRows.length}</p>
        </div>
      </div>

      <div className="bg-white border-2 border-slate-100 rounded-3xl p-4 sm:p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <h3 className="text-lg font-black uppercase tracking-tight text-slate-900">Produto mais vendido</h3>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
            Dia {selectedDate.split('-').reverse().join('/')}
          </p>
        </div>
        {topProduct ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xl font-black uppercase text-slate-900">{topProduct.name}</p>
            <p className="mt-1 text-sm font-black text-slate-700">{topProduct.qty} venda(s)</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center">
            <p className="text-xs font-black uppercase tracking-widest text-slate-400">
              Sem vendas no dia selecionado.
            </p>
          </div>
        )}
      </div>

      <div className="bg-white border-2 border-slate-100 rounded-3xl p-4 sm:p-6 shadow-sm">
        <h3 className="text-lg font-black uppercase tracking-tight text-slate-900 mb-4">Ranking de produtos</h3>
        {productRows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center">
            <p className="text-xs font-black uppercase tracking-widest text-slate-400">
              Nenhum produto vendido nesse dia.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="px-2 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400">#</th>
                  <th className="px-2 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400">Produto</th>
                  <th className="px-2 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 text-right">Qtd</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {productRows.map((row, index) => (
                  <tr key={`${row.name}-${index}`}>
                    <td className="px-2 py-3 text-xs font-black text-slate-500">{index + 1}</td>
                    <td className="px-2 py-3 text-xs font-black uppercase text-slate-800">{row.name}</td>
                    <td className="px-2 py-3 text-xs font-black text-slate-700 text-right">{row.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-between">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
            Total de todas as vendas (qtd)
          </p>
          <p className="text-lg font-black text-slate-900">{totalItemsSold}</p>
        </div>
      </div>
    </div>
  );
};

export default ProductReports;
