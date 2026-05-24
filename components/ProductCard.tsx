
import React, { useState, useRef, useEffect } from 'react';
import { Product, Ingredient, RecipeItem } from '../types';
import {
  aggregateRecipe,
  calculateRecipeCost,
  formatIngredientStockQuantity,
  getRecipeAdjustmentStep,
  getRecipeQuantityUnitLabel,
  getStockQuantityFromRecipeQuantity,
  normalizeRecipeItems,
  normalizeRecipeQuantity,
} from '../utils/recipe';

interface ProductCardProps {
  product: Product;
  onSale: (product: Product, recipeOverride?: RecipeItem[], priceOverride?: number) => void;
  allIngredients: Ingredient[];
  allProducts: Product[];
  infiniteStockEnabled?: boolean;
  resolvedRecipe?: RecipeItem[];
  onDelete?: (id: string) => void;
  onEdit?: (product: Product) => void;
}

const ProductCard: React.FC<ProductCardProps> = ({
  product,
  onSale,
  allIngredients,
  allProducts,
  infiniteStockEnabled = false,
  resolvedRecipe,
  onDelete,
  onEdit,
}) => {
  const saleBaseRecipe = React.useMemo(
    () => normalizeRecipeItems(resolvedRecipe ?? product.recipe),
    [resolvedRecipe, product.recipe]
  );
  const [isAnimating, setIsAnimating] = useState(false);
  const [showCustomizer, setShowCustomizer] = useState(false);
  const [customRecipe, setCustomRecipe] = useState<RecipeItem[]>(saleBaseRecipe);
  const [editingPrice, setEditingPrice] = useState<string>(product.price.toString());
  const [isPriceManual, setIsPriceManual] = useState(false);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  
  const timerRef = useRef<number | null>(null);
  const formatQuantity = (value: number) =>
    Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
  const formatIngredientCost = (value: number) =>
    new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 5,
    }).format(value);

  // Calcula disponibilidade baseada no ingrediente mais limitante
  const canMakeCount = React.useMemo(() => {
    if (infiniteStockEnabled) return Number.POSITIVE_INFINITY;
    if (!saleBaseRecipe || saleBaseRecipe.length === 0) return 0;
    
    const totals = aggregateRecipe(saleBaseRecipe);
    const entries = Object.entries(totals);
    if (entries.length === 0) return 0;

    const limits = entries.map(([ingredientId, quantity]) => {
      const ingredient = allIngredients.find(i => i.id === ingredientId);
      if (!ingredient) return 0;
      const requiredStockQuantity = getStockQuantityFromRecipeQuantity(ingredient, quantity);
      if (requiredStockQuantity <= 0) return 0;
      return Math.floor((ingredient.currentStock + Number.EPSILON) / requiredStockQuantity);
    });
    
    return Math.min(...limits);
  }, [allIngredients, infiniteStockEnabled, saleBaseRecipe]);

  const isAvailable = infiniteStockEnabled || canMakeCount > 0;
  const productsById = React.useMemo(
    () => new Map(allProducts.map((entry) => [entry.id, entry])),
    [allProducts]
  );
  const comboCompositionLabel = React.useMemo(() => {
    if (product.category !== 'Combo' || !product.comboItems || product.comboItems.length === 0) {
      return '';
    }

    return product.comboItems
      .filter((item) => Number.isFinite(item.quantity) && item.quantity > 0)
      .map((item) => {
        const source = productsById.get(item.productId);
        const sourceName = source?.name || 'Produto';
        return `${item.quantity}x ${sourceName}`;
      })
      .join(' + ');
  }, [product.category, product.comboItems, productsById]);

  const handleQuickSale = (e: React.MouseEvent) => {
    if (showDeleteMenu) {
        setShowDeleteMenu(false);
        return;
    }
    if (!isAvailable) return;
    setIsAnimating(true);
    onSale(product, saleBaseRecipe);
    setTimeout(() => setIsAnimating(false), 200);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowDeleteMenu(true);
  };

  // Logica de Long Press para Mobile
  const handleTouchStart = () => {
    timerRef.current = window.setTimeout(() => {
      setShowDeleteMenu(true);
    }, 800);
  };

  const handleTouchEnd = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  };

  const handleOpenCustomizer = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCustomRecipe(saleBaseRecipe);
    setIsPriceManual(false);
    setEditingPrice(product.price.toFixed(2));
    setShowCustomizer(true);
  };

  const updateCustomIngredient = (ingredientId: string, delta: number) => {
    setCustomRecipe(prev => {
      const normalizedCurrentRecipe = normalizeRecipeItems(prev);
      const totals = aggregateRecipe(normalizedCurrentRecipe);
      const ingredient = allIngredients.find(i => i.id === ingredientId);
      if (!ingredient) return normalizedCurrentRecipe;
      const currentQty = totals[ingredientId] || 0;
      const step = getRecipeAdjustmentStep(ingredient, currentQty);
      const nextDelta = delta > 0 ? step : -step;
      const nextQty = Math.max(0, normalizeRecipeQuantity(currentQty + nextDelta));
      const requiredStockQuantity = getStockQuantityFromRecipeQuantity(ingredient, nextQty);

      if (!infiniteStockEnabled && ingredient.currentStock + Number.EPSILON < requiredStockQuantity) {
        return normalizedCurrentRecipe;
      }

      if (nextQty > 0) {
        totals[ingredientId] = nextQty;
      } else {
        delete totals[ingredientId];
      }

      return Object.entries(totals)
        .map(([id, quantity]) => ({ ingredientId: id, quantity: normalizeRecipeQuantity(quantity) }))
        .filter((item) => item.quantity > 0)
        .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
    });
  };

  const handleSetCustomIngredientQuantity = (ingredientId: string, rawValue: string) => {
    const normalizedRaw = rawValue.trim().replace(',', '.');

    setCustomRecipe((prev) => {
      const normalizedCurrentRecipe = normalizeRecipeItems(prev);
      const totals = aggregateRecipe(normalizedCurrentRecipe);
      const ingredient = allIngredients.find((item) => item.id === ingredientId);
      if (!ingredient) return normalizedCurrentRecipe;

      if (!normalizedRaw) {
        delete totals[ingredientId];
        return Object.entries(totals)
          .map(([id, quantity]) => ({ ingredientId: id, quantity: normalizeRecipeQuantity(quantity) }))
          .filter((item) => item.quantity > 0)
          .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
      }

      const parsed = Number(normalizedRaw);
      if (!Number.isFinite(parsed) || parsed < 0) return normalizedCurrentRecipe;

      const nextQty = normalizeRecipeQuantity(parsed);
      const requiredStockQuantity = getStockQuantityFromRecipeQuantity(ingredient, nextQty);
      if (!infiniteStockEnabled && ingredient.currentStock + Number.EPSILON < requiredStockQuantity) {
        return normalizedCurrentRecipe;
      }

      if (nextQty > 0) {
        totals[ingredientId] = nextQty;
      } else {
        delete totals[ingredientId];
      }

      return Object.entries(totals)
        .map(([id, quantity]) => ({ ingredientId: id, quantity: normalizeRecipeQuantity(quantity) }))
        .filter((item) => item.quantity > 0)
        .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
    });
  };

  const canIncrementCustomIngredient = (ingredient: Ingredient): boolean => {
    if (infiniteStockEnabled) return true;
    const totals = aggregateRecipe(customRecipe);
    const selectedQty = totals[ingredient.id] || 0;
    const step = getRecipeAdjustmentStep(ingredient, selectedQty);
    const nextRecipeQty = normalizeRecipeQuantity((totals[ingredient.id] || 0) + step);
    const nextRequiredStock = getStockQuantityFromRecipeQuantity(ingredient, nextRecipeQty);
    return ingredient.currentStock + Number.EPSILON >= nextRequiredStock;
  };

  const handleConfirmCustomSale = () => {
    if (!canConfirmCustomSale) return;
    const finalRecipe = normalizeRecipeItems(customRecipe);
    const finalPrice = parseFloat(editingPrice);
    onSale(product, finalRecipe, isNaN(finalPrice) ? product.price : finalPrice);
    setShowCustomizer(false);
  };

  const handleEditProduct = () => {
    onEdit?.(product);
    setShowCustomizer(false);
  };

  const baseCostInfo = React.useMemo(() => {
    return calculateRecipeCost(allIngredients, saleBaseRecipe);
  }, [allIngredients, saleBaseRecipe]);

  const baseCost = baseCostInfo.totalCost;
  const markupFactor = baseCost > 0 ? product.price / baseCost : 1;

  const ingredientsById = React.useMemo(() => {
    return new Map(allIngredients.map((ing) => [ing.id, ing]));
  }, [allIngredients]);

  const autoPrice = React.useMemo(() => {
    const baseTotals = aggregateRecipe(saleBaseRecipe);
    const customTotals = aggregateRecipe(customRecipe);
    const allIds = new Set([...Object.keys(baseTotals), ...Object.keys(customTotals)]);
    let extraPrice = 0;

    allIds.forEach((id) => {
      const baseQty = baseTotals[id] || 0;
      const customQty = customTotals[id] || 0;
      const delta = customQty - baseQty;
      if (delta === 0) return;

      const ingredient = ingredientsById.get(id);
      if (!ingredient) return;
      const addonUnit = Number.isFinite(ingredient.addonPrice)
        ? (ingredient.addonPrice as number)
        : ingredient.cost * markupFactor;
      const deltaInStockUnit =
        Math.sign(delta) * getStockQuantityFromRecipeQuantity(ingredient, Math.abs(delta));
      extraPrice += deltaInStockUnit * addonUnit;
    });

    const computed = product.price + extraPrice;
    return Math.max(0, computed);
  }, [customRecipe, ingredientsById, markupFactor, product.price, saleBaseRecipe]);

  const canConfirmCustomSale = React.useMemo(() => {
    const finalRecipe = normalizeRecipeItems(customRecipe);
    const totals = aggregateRecipe(finalRecipe);
    const entries = Object.entries(totals);
    if (entries.length === 0) return false;
    if (infiniteStockEnabled) return true;

    return entries.every(([ingredientId, quantity]) => {
      const ingredient = ingredientsById.get(ingredientId);
      if (!ingredient) return false;
      const requiredStockQuantity = getStockQuantityFromRecipeQuantity(ingredient, quantity);
      return ingredient.currentStock + Number.EPSILON >= requiredStockQuantity;
    });
  }, [customRecipe, infiniteStockEnabled, ingredientsById]);

  const customTotals = React.useMemo(() => aggregateRecipe(customRecipe), [customRecipe]);

  useEffect(() => {
    if (!showCustomizer) return;
    if (isPriceManual) return;
    setEditingPrice(autoPrice.toFixed(2));
  }, [autoPrice, isPriceManual, showCustomizer]);

  return (
    <>
      <div
        className={`qb-product-card relative group bg-white rounded-3xl overflow-hidden shadow-md transition-all active:scale-95 flex flex-col items-center justify-center p-3 sm:p-4 text-left border-2 
          ${isAvailable ? 'border-transparent hover:border-yellow-400' : 'opacity-50 grayscale border-slate-100'}
          ${isAnimating ? 'animate-click' : ''}`}
        onClick={handleQuickSale}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onMouseLeave={() => setShowDeleteMenu(false)}
      >
        {/* Contador de Disponibilidade (Badge Verde) */}
        {isAvailable && !showDeleteMenu && (
          <div className="absolute top-2 right-2 z-20 bg-green-500 text-white text-[10px] font-black px-2 py-0.5 rounded-lg shadow-sm border border-green-600 flex items-center gap-1">
            <span className="opacity-70">DISP:</span>
            <span>{infiniteStockEnabled ? '∞' : canMakeCount}</span>
          </div>
        )}

        {/* Overlay de Exclusão */}
        {showDeleteMenu && (
            <div className="qb-delete-overlay absolute inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
                <button 
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete?.(product.id);
                        setShowDeleteMenu(false);
                    }}
                    className="qb-btn-touch bg-red-600 text-white px-4 py-3 rounded-2xl font-black text-xs uppercase shadow-xl hover:bg-red-700 active:scale-90 transition-all"
                >
                    Excluir Item
                </button>
            </div>
        )}

        <button
          onClick={handleOpenCustomizer}
          className="qb-btn-touch absolute top-2 left-2 z-10 bg-white/90 backdrop-blur-sm p-2 rounded-xl shadow-sm border border-slate-100 text-slate-600 hover:text-red-600 hover:scale-110 transition-all active:scale-90"
          title="Configurações desta Venda"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>

        <div className="w-full aspect-square rounded-2xl overflow-hidden mb-3 relative pointer-events-none">
          <img
            src={product.imageUrl}
            alt={product.name}
            className="w-full h-full object-cover transition-transform group-hover:scale-110"
          />
          {!isAvailable && (
            <div className="absolute inset-0 bg-slate-900/60 flex items-center justify-center">
               <span className="bg-red-600 text-white text-[10px] sm:text-xs font-black px-2 py-1 rounded-full uppercase">Indisponível</span>
            </div>
          )}
        </div>
        
        <div className="w-full pointer-events-none">
          <h3 className="text-sm sm:text-base font-extrabold text-slate-800 leading-tight mb-1 uppercase whitespace-normal break-words">
            {product.name}
          </h3>
          <p className="text-lg sm:text-xl font-black text-red-600">
            R$ {product.price.toFixed(2)}
          </p>
        </div>
      </div>

      {showCustomizer && (
        <div className="qb-sale-customizer-overlay fixed inset-0 bg-slate-900/90 backdrop-blur-md z-[200] flex items-center justify-center p-4">
          <div className="qb-sale-customizer-panel bg-white w-full max-w-lg rounded-[40px] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in duration-200">
            <div className="qb-sale-customizer-head p-6 bg-red-600 text-white flex justify-between items-center">
              <div className="qb-sale-customizer-title">
                <h3 className="text-2xl font-black tracking-tight uppercase">{product.name}</h3>
                <p className="text-xs font-bold opacity-80 uppercase tracking-widest">Ajuste apenas para esta venda</p>
              </div>
              <div className="qb-sale-customizer-head-actions flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleEditProduct}
                  className="qb-btn-touch qb-sale-customizer-edit-btn bg-white/90 text-red-700 px-3 py-2 rounded-2xl font-black text-[10px] uppercase shadow-lg hover:bg-white active:scale-95 transition-all"
                >
                  Editar Produto
                </button>
                <button 
                  onClick={() => setShowCustomizer(false)}
                  className="qb-btn-touch bg-red-700 p-2 rounded-full hover:bg-red-800 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
              </div>
            </div>

            <div className="qb-sale-customizer-content p-6 overflow-y-auto max-h-[60vh] space-y-6 bg-slate-50">
              <div className="qb-sale-customizer-price-box bg-white p-5 rounded-3xl border-2 border-slate-100 shadow-sm space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Preço para este Pedido (R$)</label>
                <div className="flex gap-2">
                  <input 
                    type="number" 
                    step="0.01"
                    value={editingPrice}
                    onChange={(e) => {
                      setEditingPrice(e.target.value);
                      setIsPriceManual(true);
                    }}
                    className="flex-1 bg-slate-100 border-none rounded-2xl px-4 py-3 font-black text-slate-800 focus:ring-2 focus:ring-red-500 text-xl"
                  />
                </div>
              </div>

              {product.category !== 'Drink' && (
                <div className="space-y-4">
                  {comboCompositionLabel && (
                    <div className="rounded-2xl bg-white border border-slate-200 px-3 py-2">
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Composição do Combo</p>
                      <p className="text-[11px] font-extrabold text-slate-700 uppercase leading-snug">
                        {comboCompositionLabel}
                      </p>
                    </div>
                  )}
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Ingredientes da Receita</p>
                  
                  {allIngredients.filter(ing => 
                    saleBaseRecipe.some(r => r.ingredientId === ing.id) || 
                    customRecipe.some(r => r.ingredientId === ing.id)
                  ).map(ing => {
                    const currentQty = customTotals[ing.id] || 0;
                    const recipeUnitLabel = getRecipeQuantityUnitLabel(ing, currentQty);
                    return (
                      <div key={ing.id} className="qb-sale-customizer-row flex items-center justify-between p-4 bg-white rounded-3xl border-2 border-slate-100 shadow-sm">
                        <div>
                          <p className="font-extrabold text-slate-800 uppercase text-sm">{ing.name}</p>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">
                            Estoque: {formatIngredientStockQuantity(ing, ing.currentStock)} {ing.unit}
                          </p>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">
                            Custo: R$ {formatIngredientCost(ing.cost)} / {ing.unit}
                          </p>
                        </div>
                        <div className="qb-sale-customizer-controls flex items-center gap-4">
                          <button 
                            onClick={() => updateCustomIngredient(ing.id, -1)}
                            className="qb-btn-touch w-10 h-10 rounded-2xl bg-slate-100 text-slate-500 flex items-center justify-center font-black text-xl active:scale-90"
                          >-</button>
                          <input
                            type="number"
                            min="0"
                            step={getRecipeAdjustmentStep(ing, currentQty)}
                            inputMode="decimal"
                            value={currentQty > 0 ? formatQuantity(currentQty) : ''}
                            onChange={(e) => handleSetCustomIngredientQuantity(ing.id, e.target.value)}
                            placeholder="0"
                            className="w-20 rounded-2xl border border-slate-200 bg-white px-2 py-1 text-center text-base font-black text-slate-800 outline-none focus:border-red-400"
                          />
                          <span className="text-[10px] font-black uppercase text-slate-400 -ml-2">
                            {recipeUnitLabel}
                          </span>
                          <button 
                            onClick={() => updateCustomIngredient(ing.id, 1)}
                            disabled={!canIncrementCustomIngredient(ing)}
                            className="qb-btn-touch w-10 h-10 rounded-2xl bg-yellow-400 text-red-800 flex items-center justify-center font-black text-xl active:scale-90"
                          >+</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="qb-sale-customizer-footer p-6 bg-white border-t">
              <button 
                onClick={handleConfirmCustomSale}
                disabled={!canConfirmCustomSale}
                className="qb-btn-touch w-full bg-green-600 hover:bg-green-700 disabled:bg-slate-300 disabled:text-slate-500 text-white py-5 rounded-3xl font-black uppercase text-lg shadow-lg active:scale-95 flex items-center justify-center gap-3"
              >
                {canConfirmCustomSale ? 'ADICIONAR AO CARRINHO' : 'ESTOQUE INSUFICIENTE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ProductCard;
