
import React, { useMemo, useRef, useState } from 'react';
import { Ingredient, StockEntry } from '../types';
import {
  allowsFractionalStockInput,
  formatIngredientStockQuantity,
  formatStockQuantityByUnit,
  getStockInputStep,
} from '../utils/recipe';

interface InventoryManagerProps {
  ingredients: Ingredient[];
  entries: StockEntry[];
  onUpdateStock: (id: string, amount: number, options?: { useCashRegister?: boolean }) => void;
  onOpenAddIngredient: () => void;
  onEditIngredient: (ingredient: Ingredient) => void;
  onDeleteIngredient?: (id: string) => void;
}

const parseStockMoveAmount = (
  rawValue: string,
  ingredient: Pick<Ingredient, 'unit'>
): number | null => {
  const normalizedValue = rawValue.trim().replace(',', '.');
  if (!normalizedValue) return null;

  const parsed = Number(normalizedValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  const allowsFractional = allowsFractionalStockInput(ingredient);
  if (!allowsFractional && !Number.isInteger(parsed)) return null;

  const normalizedInputAmount = allowsFractional ? Number(parsed.toFixed(6)) : Math.trunc(parsed);
  if (!Number.isFinite(normalizedInputAmount) || normalizedInputAmount <= 0) return null;

  // Inventory input now follows the ingredient stock unit directly (kg -> kg, g -> g, etc.).
  return Number(normalizedInputAmount.toFixed(6));
};

const InventoryManager: React.FC<InventoryManagerProps> = ({
  ingredients,
  entries,
  onUpdateStock,
  onOpenAddIngredient,
  onEditIngredient,
  onDeleteIngredient,
}) => {
  const [replenishValues, setReplenishValues] = useState<Record<string, string>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [deleteMenuId, setDeleteMenuId] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState('');
  
  const timerRef = useRef<number | null>(null);
  const normalizedSearch = searchValue.trim().toLowerCase();
  const ingredientsById = useMemo(() => {
    return new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  }, [ingredients]);

  const filteredIngredients = useMemo(() => {
    if (!normalizedSearch) return ingredients;
    return ingredients.filter((ingredient) => {
      const fields = [ingredient.name, ingredient.id, ingredient.unit];
      return fields.some((field) => field.toLowerCase().includes(normalizedSearch));
    });
  }, [ingredients, normalizedSearch]);
  const visibleHistoryEntries = useMemo(
    () => entries.filter((entry) => Math.abs(Number(entry.quantity) || 0) > 0),
    [entries]
  );

  const handleInputChange = (id: string, value: string) => {
    setReplenishValues(prev => ({ ...prev, [id]: value }));
  };

  const handleReplenish = (id: string) => {
    const ingredient = ingredients.find((item) => item.id === id);
    if (!ingredient) return;
    const amount = parseStockMoveAmount(replenishValues[id] || '', ingredient);
    if (amount === null) return;
    onUpdateStock(id, amount);
    setReplenishValues(prev => ({ ...prev, [id]: '' }));
  };

  const handleConsume = (id: string) => {
    const ingredient = ingredients.find((item) => item.id === id);
    if (!ingredient) return;
    const amount = parseStockMoveAmount(replenishValues[id] || '', ingredient);
    if (amount === null) return;
    if (ingredient.currentStock + Number.EPSILON < amount) return;
    onUpdateStock(id, -amount);
    setReplenishValues(prev => ({ ...prev, [id]: '' }));
  };

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setDeleteMenuId(id);
  };

  const handleTouchStart = (id: string) => {
    timerRef.current = window.setTimeout(() => {
      setDeleteMenuId(id);
    }, 800);
  };

  const handleTouchEnd = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  const formatCardStockValue = (ingredient: Ingredient): string => {
    const value = ingredient.currentStock;
    if (!Number.isFinite(value)) return '0';
    const isInteger = Math.abs(value - Math.trunc(value)) < Number.EPSILON;
    return new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: isInteger ? 0 : 3,
    }).format(value);
  };

  return (
    <div className="qb-inventory p-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="qb-inventory-header flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4">
        <div>
          <h2 className="text-3xl font-black text-slate-800 tracking-tight">CONTROLE DE ESTOQUE</h2>
          <p className="text-slate-500 font-semibold">Gerencie os insumos e reposições em tempo real.</p>
        </div>
        <div className="qb-inventory-actions flex gap-2">
          <button 
            onClick={() => setShowHistory(true)}
            className="qb-btn-touch bg-slate-800 text-white px-5 py-2 rounded-2xl text-sm font-bold flex items-center gap-2 hover:bg-slate-700 transition-colors shadow-lg"
          >
            HISTÓRICO
          </button>
          <button 
            onClick={onOpenAddIngredient}
            className="qb-btn-touch bg-red-600 text-white p-3 rounded-2xl shadow-lg hover:bg-red-700 active:scale-95 transition-all"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          </button>
        </div>
      </div>

      <div className="qb-inventory-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
        <div className="md:col-span-2 lg:col-span-3 2xl:col-span-4">
          <div className="bg-white border-2 border-slate-100 rounded-3xl p-4 sm:p-5 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  placeholder="Pesquisar no estoque por nome, código ou unidade..."
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 pl-10 font-bold text-slate-800 outline-none focus:border-red-400 focus:bg-white"
                />
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </div>
              {searchValue && (
                <button
                  onClick={() => setSearchValue('')}
                  className="qb-btn-touch rounded-2xl bg-slate-100 px-4 py-3 text-xs font-black uppercase text-slate-700 hover:bg-slate-200 transition-colors"
                >
                  Limpar
                </button>
              )}
            </div>
            <p className="mt-3 text-[10px] font-black uppercase tracking-widest text-slate-400">
              {filteredIngredients.length} de {ingredients.length} ingredientes exibidos
            </p>
          </div>
        </div>

        {filteredIngredients.map((ing) => {
          const isCritical = ing.currentStock <= ing.minStock * 0.5;
          const isLow = ing.currentStock <= ing.minStock;
          const inputValue = replenishValues[ing.id] || '';
          const parsedValue = parseStockMoveAmount(inputValue, ing);
          const canReplenish = parsedValue !== null;
          const canConsume =
            parsedValue !== null && ing.currentStock + Number.EPSILON >= parsedValue;
          const inputUnitLabel = ing.unit;

          return (
            <div 
              key={ing.id}
              className={`qb-inventory-card relative bg-white p-5 rounded-3xl border-2 transition-all flex flex-col ${isCritical ? 'border-red-300 bg-red-50/30' : isLow ? 'border-yellow-300' : 'border-slate-100'}`}
              onContextMenu={(e) => handleContextMenu(e, ing.id)}
              onTouchStart={() => handleTouchStart(ing.id)}
              onTouchEnd={handleTouchEnd}
              onMouseLeave={() => setDeleteMenuId(null)}
            >
              {/* Overlay de Exclusão */}
              {deleteMenuId === ing.id && (
                  <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 rounded-3xl animate-in fade-in duration-200">
                      <button 
                          onClick={(e) => {
                              e.stopPropagation();
                              onDeleteIngredient?.(ing.id);
                              setDeleteMenuId(null);
                          }}
                          className="bg-red-600 text-white px-6 py-3 rounded-2xl font-black text-xs uppercase shadow-xl active:scale-90 transition-all"
                      >
                          Excluir Ingrediente
                      </button>
                  </div>
              )}

              <div className="flex justify-between items-start mb-2 gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {ing.imageUrl ? (
                    <div className="w-12 h-12 rounded-2xl overflow-hidden border border-slate-100 shadow-sm bg-slate-50">
                      <img
                        src={ing.imageUrl}
                        alt={ing.name}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>
                  ) : (
                    <div className="w-12 h-12 rounded-2xl border border-dashed border-slate-200 flex items-center justify-center text-slate-300 text-xs font-black">
                      IMG
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{ing.id}</p>
                    <h3 className="text-lg font-extrabold text-slate-800 uppercase break-words leading-tight">{ing.name}</h3>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditIngredient(ing);
                    }}
                    className="qb-btn-touch bg-white/90 backdrop-blur-sm p-2 rounded-xl shadow-sm border border-slate-100 text-slate-500 hover:text-red-600 hover:scale-105 transition-all active:scale-95"
                    title="Editar ingrediente"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                  <div className="text-right min-w-0">
                    <span
                      className={`block text-xl xl:text-2xl font-black leading-none tracking-tight max-w-[11ch] break-all ${isCritical ? 'text-red-600' : isLow ? 'text-yellow-600' : 'text-slate-900'}`}
                    >
                      {formatCardStockValue(ing)}
                    </span>
                    <span className="block text-[11px] font-bold text-slate-400 uppercase">{ing.unit}</span>
                  </div>
                </div>
              </div>

              <div className="mb-4">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-100 px-2 py-1 rounded-lg">
                  Custo: R$ {ing.cost.toFixed(2)} / {ing.unit}
                </span>
              </div>

              <div className="w-full bg-slate-200 h-2 rounded-full mb-6 overflow-hidden">
                <div 
                  className={`h-full rounded-full transition-all duration-500 ${isCritical ? 'bg-red-600' : isLow ? 'bg-yellow-500' : 'bg-green-500'}`}
                  style={{ width: `${Math.min((ing.currentStock / (ing.minStock * 4)) * 100, 100)}%` }}
                ></div>
              </div>

              <div className="mt-auto space-y-2">
                <p className="text-[10px] font-black text-slate-400 uppercase">Reposição / Consumo</p>
                <div className="qb-stock-controls flex gap-2">
                  <input 
                    type="number"
                    min="0"
                    step={getStockInputStep(ing)}
                    inputMode="decimal"
                    value={inputValue}
                    onChange={(e) => handleInputChange(ing.id, e.target.value)}
                    placeholder={`Qtd (${inputUnitLabel})`}
                    className="w-full bg-slate-100 border-none rounded-2xl px-4 py-2 font-black text-slate-800 focus:ring-2 focus:ring-red-500 placeholder:text-slate-300"
                  />
                  <button 
                    onClick={() => handleConsume(ing.id)}
                    disabled={!canConsume}
                    className="qb-btn-touch bg-slate-700 hover:bg-slate-800 disabled:bg-slate-300 text-white p-2.5 rounded-2xl font-black transition-all flex items-center justify-center min-w-[50px] shadow-sm active:scale-90"
                    title="Dar baixa no estoque (gasto)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/></svg>
                  </button>
                  <button 
                    onClick={() => handleReplenish(ing.id)}
                    disabled={!canReplenish}
                    className="qb-btn-touch bg-red-600 hover:bg-red-700 disabled:bg-slate-300 text-white p-2.5 rounded-2xl font-black transition-all flex items-center justify-center min-w-[50px] shadow-sm active:scale-90"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {filteredIngredients.length === 0 && (
          <div className="md:col-span-2 lg:col-span-3 2xl:col-span-4">
            <div className="rounded-3xl border-2 border-dashed border-slate-200 bg-white p-10 text-center">
              <p className="text-xs font-black uppercase tracking-widest text-slate-500">
                Nenhum ingrediente encontrado para "{searchValue}"
              </p>
            </div>
          </div>
        )}
      </div>

      {showHistory && (
        <div className="qb-stock-history-overlay fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="qb-stock-history-panel bg-white w-full max-w-2xl rounded-[40px] shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            <div className="qb-stock-history-head p-6 bg-slate-50 border-b flex justify-between items-center">
              <div>
                <h3 className="text-xl font-black text-slate-800">HISTÓRICO DE MOVIMENTAÇÕES</h3>
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Registros de entrada e saída</p>
              </div>
              <button onClick={() => setShowHistory(false)} className="qb-btn-touch bg-slate-200 p-2 rounded-full hover:bg-slate-300 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>
            
            <div className="qb-stock-history-content flex-1 overflow-y-auto p-6 space-y-3">
              {visibleHistoryEntries.length === 0 ? (
                <div className="text-center py-20 opacity-30 uppercase font-bold">Nenhuma movimentação registrada</div>
              ) : (
                visibleHistoryEntries.slice().reverse().map(entry => {
                  const isOut = entry.quantity < 0;
                  const ingredient = ingredientsById.get(entry.ingredientId);
                  const unitLabel = ingredient?.unit || '';
                  const displayQty = ingredient
                    ? formatIngredientStockQuantity(ingredient, Math.abs(entry.quantity))
                    : formatStockQuantityByUnit('', Math.abs(entry.quantity));
                  return (
                    <div key={entry.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="flex items-center gap-4">
                        <div className={`${isOut ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'} p-2 rounded-xl`}>
                          {isOut ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                          ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
                          )}
                        </div>
                        <div>
                          <p className="font-black text-slate-800 uppercase">{entry.ingredientName}</p>
                          <p className="text-[10px] text-slate-400 font-bold">{entry.timestamp.toLocaleString('pt-BR')}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-lg font-black ${isOut ? 'text-red-600' : 'text-green-600'}`}>
                          {isOut ? '-' : '+'}{displayQty}{unitLabel ? ` ${unitLabel}` : ''}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="qb-stock-history-footer p-6 bg-slate-50 border-t">
              <button onClick={() => setShowHistory(false)} className="qb-btn-touch w-full bg-slate-800 text-white py-4 rounded-2xl font-black uppercase">FECHAR PAINEL</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default InventoryManager;
