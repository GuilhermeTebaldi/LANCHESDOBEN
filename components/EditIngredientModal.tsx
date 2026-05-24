import React, { useEffect, useRef, useState } from 'react';
import { Ingredient } from '../types';
import { allowsFractionalStockUnit, normalizeStockQuantityByUnit } from '../utils/recipe';

interface EditIngredientModalProps {
  isOpen: boolean;
  ingredient: Ingredient | null;
  onClose: () => void;
  onSave: (ingredient: Ingredient) => void;
  infiniteStockEnabled?: boolean;
}

const EditIngredientModal: React.FC<EditIngredientModalProps> = ({
  isOpen,
  ingredient,
  onClose,
  onSave,
  infiniteStockEnabled = false,
}) => {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('un');
  const [minStock, setMinStock] = useState('');
  const [cost, setCost] = useState('');
  const [addonPrice, setAddonPrice] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [isPhotoOptionsOpen, setIsPhotoOptionsOpen] = useState(false);
  const [photoSourceMode, setPhotoSourceMode] = useState<'GALLERY' | 'LINK'>('LINK');
  const [isCostHelpOpen, setIsCostHelpOpen] = useState(false);
  const [calcBagPrice, setCalcBagPrice] = useState('');
  const [calcBagKg, setCalcBagKg] = useState('');
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const normalizeUnit = (value: string): string => value.trim().toLowerCase();
  const parseDecimalInput = (value: string): number | null => {
    const normalized = value.trim().replace(',', '.');
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  };
  const formatCurrency = (value: number, precision = 2): string =>
    value.toLocaleString('pt-BR', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    });
  const isKgUnit = (value: string): boolean => {
    const normalized = normalizeUnit(value);
    return normalized === 'kg' || normalized.includes('quilo') || normalized.includes('kilogram');
  };
  const isMlUnit = (value: string): boolean => {
    const normalized = normalizeUnit(value);
    return normalized === 'ml' || normalized.includes('mililit');
  };
  const isGramUnit = (value: string): boolean => {
    const normalized = normalizeUnit(value);
    return normalized === 'g' || normalized.includes('gram');
  };

  useEffect(() => {
    if (!ingredient) return;
    setName(ingredient.name);
    setUnit(ingredient.unit);
    setMinStock(String(ingredient.minStock));
    setCost(String(ingredient.cost));
    setAddonPrice(ingredient.addonPrice !== undefined ? String(ingredient.addonPrice) : '');
    setImageUrl(ingredient.imageUrl ?? '');
    setPhotoSourceMode((ingredient.imageUrl ?? '').trim().startsWith('data:image/') ? 'GALLERY' : 'LINK');
    setIsPhotoOptionsOpen(false);
    setIsCostHelpOpen(false);
    setCalcBagKg('');
    setCalcBagPrice('');
  }, [ingredient]);

  const isKgSelected = isKgUnit(unit);
  const isSmallUnit = isGramUnit(unit) || isMlUnit(unit);
  const stockStep = allowsFractionalStockUnit(unit) ? '0.001' : '1';
  const calcPrice = parseDecimalInput(calcBagPrice);
  const calcKg = parseDecimalInput(calcBagKg);
  const isCalcValid = calcPrice !== null && calcPrice >= 0 && calcKg !== null && calcKg > 0;
  const calcPerKg = isCalcValid ? calcPrice / calcKg : null;
  const calcPer100g = calcPerKg !== null ? calcPerKg / 10 : null;
  const isLocalGalleryImage = imageUrl.trim().startsWith('data:image/');

  if (!isOpen || !ingredient) return null;

  const handleGalleryFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImageUrl(reader.result);
      }
    };
    reader.readAsDataURL(selectedFile);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedName = name.trim();
    const normalizedMinStockRaw = minStock.trim().replace(',', '.');
    const normalizedCostRaw = cost.trim().replace(',', '.');
    const normalizedAddonRaw = addonPrice.trim().replace(',', '.');
    if (!normalizedName) {
      alert('Informe o nome do ingrediente.');
      return;
    }

    const parsedMinStock = infiniteStockEnabled ? ingredient.minStock : Number(normalizedMinStockRaw);
    const parsedCost = infiniteStockEnabled ? ingredient.cost : Number(normalizedCostRaw);
    let parsedAddonPrice: number | undefined = infiniteStockEnabled
      ? ingredient.addonPrice
      : undefined;

    if (!infiniteStockEnabled) {
      if (!normalizedMinStockRaw || !normalizedCostRaw) {
        alert('Por favor, preencha todos os campos!');
        return;
      }
      if (!Number.isFinite(parsedMinStock) || parsedMinStock < 0) {
        alert('Estoque mínimo inválido. Informe um número maior ou igual a zero.');
        return;
      }
      if (!Number.isFinite(parsedCost) || parsedCost < 0) {
        alert('Preço de custo inválido. Informe um número maior ou igual a zero.');
        return;
      }

      if (normalizedAddonRaw) {
        const addonCandidate = Number(normalizedAddonRaw);
        if (!Number.isFinite(addonCandidate) || addonCandidate < 0) {
          alert('Preço adicional inválido. Informe um número maior ou igual a zero.');
          return;
        }
        parsedAddonPrice = addonCandidate;
      }
    }

    const unitToPersist = infiniteStockEnabled ? ingredient.unit : unit.trim();
    const currentStockToPersist = infiniteStockEnabled
      ? ingredient.currentStock
      : normalizeStockQuantityByUnit(unitToPersist, ingredient.currentStock);
    const minStockToPersist = infiniteStockEnabled
      ? ingredient.minStock
      : normalizeStockQuantityByUnit(unitToPersist, parsedMinStock);

    const updated: Ingredient = {
      ...ingredient,
      name: normalizedName,
      unit: unitToPersist,
      currentStock: currentStockToPersist,
      minStock: minStockToPersist,
      cost: parsedCost,
      addonPrice: parsedAddonPrice,
      imageUrl: imageUrl.trim() ? imageUrl.trim() : undefined,
    };

    onSave(updated);
    onClose();
  };

  return (
    <div className="qb-modal-overlay fixed inset-0 bg-slate-900/90 backdrop-blur-md z-[250] flex items-center justify-center p-4">
      <div className="qb-ingredient-modal relative bg-white w-full max-w-lg rounded-[40px] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in duration-200">
        <div className="qb-modal-head p-6 bg-slate-800 text-white flex justify-between items-center">
          <div>
            <h3 className="text-2xl font-black tracking-tight uppercase">Editar Ingrediente</h3>
            <p className="text-xs font-bold opacity-60 uppercase tracking-widest">Atualize os dados do estoque</p>
          </div>
          <button 
            onClick={onClose}
            className="qb-btn-touch bg-slate-700 p-2 rounded-full hover:bg-slate-600 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="qb-ingredient-form p-8 space-y-6">
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Nome do Ingrediente</label>
            <input 
              type="text" 
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Ex: Queijo Cheddar"
              className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
            />
          </div>

          {!infiniteStockEnabled && (
            <>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Unidade de Medida</label>
                <select
                  value={unit}
                  onChange={(e) => {
                    const nextUnit = e.target.value;
                    setUnit(nextUnit);
                    if (!isKgUnit(nextUnit)) {
                      setIsCostHelpOpen(false);
                    }
                  }}
                  className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500 appearance-none cursor-pointer"
                >
                  <option value="un">Unidade (un)</option>
                  <option value="kg">Quilo (kg)</option>
                  <option value="l">Litro (L)</option>
                  <option value="g">Grama (g)</option>
                  <option value="fatias">Fatias</option>
                  <option value="porções">Porções</option>
                  <option value="lata">Lata</option>
                  <option value="ml">Mililitros (ml)</option>
                </select>
              </div>

              <div className="qb-ingredient-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      {isKgSelected ? (
                        <>
                          Preço de Custo por <span className="text-green-600">kg</span> (R$)
                        </>
                      ) : (
                        'Preço de Custo (R$)'
                      )}
                    </label>
                    {isKgSelected && (
                      <button
                        type="button"
                        onClick={() => {
                          const shouldOpen = !isCostHelpOpen;
                          if (shouldOpen) {
                            setCalcBagPrice('');
                            setCalcBagKg('');
                          }
                          setIsCostHelpOpen(shouldOpen);
                        }}
                        className="qb-btn-touch w-5 h-5 rounded-full bg-slate-200 text-slate-700 text-[11px] font-black hover:bg-slate-300 transition-colors"
                        title="Abrir calculadora de custo por gramas"
                      >
                        ?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-black text-xs">
                      R$
                    </span>
                    <input 
                      type="number" 
                      step="0.00001"
                      value={cost}
                      onChange={e => setCost(e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-slate-100 border-none rounded-2xl pl-12 pr-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                  {isSmallUnit && (
                    <p className="text-[10px] font-bold uppercase tracking-widest text-amber-700">
                      Em g/ml, custo deve ser por grama/ml (ex.: R$ 20/kg = R$ 0.0200/g).
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Estoque Mínimo</label>
                  <input 
                    type="number" 
                    step={stockStep}
                    value={minStock}
                    onChange={e => setMinStock(e.target.value)}
                    placeholder="Ex: 10"
                    className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Preço de Adicional (R$) por Unidade (opcional)</label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-black text-xs">
                    R$
                  </span>
                  <input 
                    type="number" 
                    step="0.01"
                    value={addonPrice}
                    onChange={e => setAddonPrice(e.target.value)}
                    placeholder="Ex: 2.00"
                    className="w-full bg-slate-100 border-none rounded-2xl pl-12 pr-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  />
                </div>
              </div>
            </>
          )}

          {infiniteStockEnabled && (
            <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[11px] font-black uppercase tracking-wide text-emerald-700">
              Estoque infinito ativo: unidade, custo, estoque mínimo e adicional ficam ocultos nesta edição.
            </p>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Link da Foto (opcional)</label>
              <button
                type="button"
                onClick={() => setIsPhotoOptionsOpen((current) => !current)}
                className="qb-btn-touch bg-slate-100 text-slate-700 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors"
              >
                Foto
              </button>
            </div>

            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              onChange={handleGalleryFileChange}
              className="hidden"
            />

            {isPhotoOptionsOpen && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPhotoSourceMode('GALLERY');
                      galleryInputRef.current?.click();
                    }}
                    className={`qb-btn-touch px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest border transition-colors ${
                      photoSourceMode === 'GALLERY'
                        ? 'bg-green-600 text-white border-green-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-green-300'
                    }`}
                  >
                    Galeria
                  </button>
                  <button
                    type="button"
                    onClick={() => setPhotoSourceMode('LINK')}
                    className={`qb-btn-touch px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest border transition-colors ${
                      photoSourceMode === 'LINK'
                        ? 'bg-green-600 text-white border-green-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-green-300'
                    }`}
                  >
                    Link
                  </button>
                </div>

                {photoSourceMode === 'GALLERY' ? (
                  <button
                    type="button"
                    onClick={() => galleryInputRef.current?.click()}
                    className="qb-btn-touch w-full bg-slate-100 text-slate-700 px-4 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors text-left"
                  >
                    {isLocalGalleryImage ? 'Trocar imagem da galeria' : 'Selecionar imagem da galeria'}
                  </button>
                ) : (
                  <input
                    type="text"
                    value={imageUrl}
                    onChange={e => setImageUrl(e.target.value)}
                    placeholder="https://res.cloudinary.com/.../image/upload/..."
                    className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  />
                )}
              </>
            )}
          </div>

          <div className="pt-4">
            <button 
              type="submit"
              className="qb-btn-touch w-full bg-green-600 hover:bg-green-700 text-white py-5 rounded-3xl font-black uppercase tracking-tighter text-xl shadow-xl shadow-green-200 transition-all active:scale-95 flex items-center justify-center gap-3"
            >
              SALVAR ALTERAÇÕES
            </button>
          </div>
        </form>
      </div>
      {isKgSelected && isCostHelpOpen && (
        <div
          className="fixed inset-0 z-[270] bg-slate-900/55 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setIsCostHelpOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 space-y-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">
                Calculadora kg para gramas
              </p>
              <button
                type="button"
                onClick={() => setIsCostHelpOpen(false)}
                className="qb-btn-touch text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-700"
              >
                Fechar
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-black text-xs">
                  R$
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={calcBagPrice}
                  onChange={(e) => setCalcBagPrice(e.target.value)}
                  placeholder="Preço do saco"
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                />
              </div>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-black text-xs">
                  kg
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={calcBagKg}
                  onChange={(e) => setCalcBagKg(e.target.value)}
                  placeholder="Peso do saco"
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-center">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">1kg</p>
                <p className="text-xs font-black text-slate-800">
                  {calcPerKg !== null ? `R$ ${formatCurrency(calcPerKg)}` : '-'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-center">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">100g</p>
                <p className="text-xs font-black text-slate-800">
                  {calcPer100g !== null ? `R$ ${formatCurrency(calcPer100g)}` : '-'}
                </p>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={calcPerKg === null}
                onClick={() => {
                  if (calcPerKg === null) return;
                  setCost(String(Number(calcPerKg.toFixed(6))));
                }}
                className="qb-btn-touch bg-slate-900 text-white px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-black disabled:opacity-40"
              >
                Usar custo por kg
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EditIngredientModal;
