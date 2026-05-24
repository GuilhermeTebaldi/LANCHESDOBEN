
import React, { useRef, useState } from 'react';
import { Ingredient } from '../types';
import { allowsFractionalStockUnit, normalizeStockQuantityByUnit } from '../utils/recipe';

interface AddIngredientModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (ingredient: Ingredient) => void;
  infiniteStockEnabled?: boolean;
}

const AddIngredientModal: React.FC<AddIngredientModalProps> = ({
  isOpen,
  onClose,
  onAdd,
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
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const normalizedUnit = unit.trim().toLowerCase();
  const isBulkUnit =
    normalizedUnit === 'kg' ||
    normalizedUnit === 'l' ||
    normalizedUnit.includes('quilo') ||
    normalizedUnit.includes('litro');
  const isSmallUnit = normalizedUnit === 'g' || normalizedUnit === 'ml';
  const stockStep = allowsFractionalStockUnit(unit) ? '0.001' : '1';

  if (!isOpen) return null;

  const isLocalGalleryImage = imageUrl.trim().startsWith('data:image/');
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
    if (!normalizedName) {
      alert('Informe o nome do ingrediente.');
      return;
    }

    const normalizedMinStockRaw = minStock.trim().replace(',', '.');
    const normalizedCostRaw = cost.trim().replace(',', '.');
    const normalizedAddonRaw = addonPrice.trim().replace(',', '.');
    const parsedMinStock = infiniteStockEnabled ? 0 : Number(normalizedMinStockRaw);
    const parsedCost = infiniteStockEnabled ? 0 : Number(normalizedCostRaw);
    let parsedAddonPrice: number | undefined;

    if (!infiniteStockEnabled) {
      if (!normalizedMinStockRaw || !normalizedCostRaw) {
        alert("Por favor, preencha todos os campos!");
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

    const normalizedUnit = infiniteStockEnabled ? 'un' : unit.trim();

    const newIng: Ingredient = {
      id: 'i-' + Math.random().toString(36).substr(2, 9),
      name: normalizedName,
      unit: normalizedUnit,
      currentStock: normalizeStockQuantityByUnit(normalizedUnit, 0),
      minStock: normalizeStockQuantityByUnit(normalizedUnit, parsedMinStock),
      cost: parsedCost,
      addonPrice: parsedAddonPrice,
      imageUrl: imageUrl.trim() ? imageUrl.trim() : undefined,
    };

    onAdd(newIng);
    
    // Reset state
    setName('');
    setUnit('un');
    setMinStock('');
    setCost('');
    setAddonPrice('');
    setImageUrl('');
    setIsPhotoOptionsOpen(false);
    setPhotoSourceMode('LINK');
    if (galleryInputRef.current) {
      galleryInputRef.current.value = '';
    }
    onClose();
  };

  return (
    <div className="qb-modal-overlay fixed inset-0 bg-slate-900/90 backdrop-blur-md z-[250] flex items-center justify-center p-4">
      <div className="qb-ingredient-modal bg-white w-full max-w-lg rounded-[40px] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in duration-200">
        <div className="qb-modal-head p-6 bg-slate-800 text-white flex justify-between items-center">
          <div>
            <h3 className="text-2xl font-black tracking-tight uppercase">Novo Ingrediente</h3>
            <p className="text-xs font-bold opacity-60 uppercase tracking-widest">Adicionar insumo ao estoque</p>
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
                  onChange={e => setUnit(e.target.value)}
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
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    {isBulkUnit ? 'Preço de Custo por kg/litro (R$)' : 'Preço de Custo (R$)'}
                  </label>
                  <input 
                    type="number" 
                    step="0.01"
                    value={cost}
                    onChange={e => setCost(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  />
                  {isSmallUnit && (
                    <p className="text-[10px] font-bold uppercase tracking-widest text-amber-700">
                      Em g/ml, informe custo por grama/ml (ex.: R$ 20/kg = R$ 0.0200/g).
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
                <input 
                  type="number" 
                  step="0.01"
                  value={addonPrice}
                  onChange={e => setAddonPrice(e.target.value)}
                  placeholder="Ex: 2.00"
                  className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                />
              </div>
            </>
          )}

          {infiniteStockEnabled && (
            <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[11px] font-black uppercase tracking-wide text-emerald-700">
              Estoque infinito ativo: unidade, custo, estoque mínimo e adicional ficam ocultos neste cadastro.
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
                        ? 'bg-red-600 text-white border-red-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-red-300'
                    }`}
                  >
                    Galeria
                  </button>
                  <button
                    type="button"
                    onClick={() => setPhotoSourceMode('LINK')}
                    className={`qb-btn-touch px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest border transition-colors ${
                      photoSourceMode === 'LINK'
                        ? 'bg-red-600 text-white border-red-600'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-red-300'
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
                    onChange={(e) => setImageUrl(e.target.value)}
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
              className="qb-btn-touch w-full bg-red-600 hover:bg-red-700 text-white py-5 rounded-3xl font-black uppercase tracking-tighter text-xl shadow-xl shadow-red-200 transition-all active:scale-95 flex items-center justify-center gap-3"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
              SALVAR INGREDIENTE
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddIngredientModal;
