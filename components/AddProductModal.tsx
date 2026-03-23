
import React, { useMemo, useRef, useState } from 'react';

import { ComboItem, Ingredient, Product, RecipeItem } from '../types';
import {
  buildRecipeFromComboItems,
  getRecipeAdjustmentStep,
  getRecipeQuantityUnitLabel,
  normalizeRecipeItems,
  normalizeRecipeQuantity,
  synchronizeComboProductRecipes,
} from '../utils/recipe';
import {
  convertImageFileToDataUrl,
  isCloudinaryUploadConfigured,
  uploadImageToCloudinary,
} from '../utils/cloudinaryUpload';
import ComboItemsBuilder from './ComboItemsBuilder';

interface AddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  ingredients: Ingredient[];
  products: Product[];
  onAdd: (product: Product) => void;
}

const MAX_PRODUCT_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_URL_LENGTH = 200_000;

const AddProductModal: React.FC<AddProductModalProps> = ({
  isOpen,
  onClose,
  ingredients,
  products,
  onAdd,
}) => {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState<'Snack' | 'Drink' | 'Side' | 'Combo'>('Snack');
  const [imageUrl, setImageUrl] = useState('');
  const [isImageUrlVisible, setIsImageUrlVisible] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [uploadErrorMessage, setUploadErrorMessage] = useState('');
  const [recipe, setRecipe] = useState<RecipeItem[]>([]);
  const [comboItems, setComboItems] = useState<ComboItem[]>([]);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const isCloudinaryConfigured = isCloudinaryUploadConfigured();
  const normalizedProducts = useMemo(
    () => synchronizeComboProductRecipes(products),
    [products]
  );

  const comboRecipe = useMemo(() => {
    return buildRecipeFromComboItems(normalizedProducts, comboItems);
  }, [normalizedProducts, comboItems]);

  const isCombo = category === 'Combo';
  const recipeToPersist = normalizeRecipeItems(isCombo ? comboRecipe : recipe);
  const normalizedImageUrl = imageUrl.trim();
  const hasImageSelected = normalizedImageUrl.length > 0;
  const isLocalImagePreview = normalizedImageUrl.startsWith('data:image/');

  if (!isOpen) return null;

  const handleUpdateRecipe = (ingredientId: string, delta: number) => {
    setRecipe(prev => {
      const ingredient = ingredients.find((item) => item.id === ingredientId);
      if (!ingredient) return prev;
      const existing = prev.find(item => item.ingredientId === ingredientId);
      const currentQty = existing?.quantity || 0;
      const step = getRecipeAdjustmentStep(ingredient, currentQty);
      const nextDelta = delta > 0 ? step : -step;
      if (existing) {
        const newQty = Math.max(0, normalizeRecipeQuantity(existing.quantity + nextDelta));
        if (newQty === 0) {
          return prev.filter(item => item.ingredientId !== ingredientId);
        }
        return prev.map(item => item.ingredientId === ingredientId ? { ...item, quantity: newQty } : item);
      } else if (delta > 0 && nextDelta > 0) {
        return [...prev, { ingredientId, quantity: nextDelta }];
      }
      return prev;
    });
  };

  const handleSetRecipeQuantity = (ingredientId: string, rawValue: string) => {
    const normalizedRaw = rawValue.trim().replace(',', '.');
    if (!normalizedRaw) {
      setRecipe((prev) => prev.filter((item) => item.ingredientId !== ingredientId));
      return;
    }

    const parsed = Number(normalizedRaw);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const nextQty = normalizeRecipeQuantity(parsed);

    setRecipe((prev) => {
      const exists = prev.some((item) => item.ingredientId === ingredientId);
      if (nextQty <= 0) {
        return prev.filter((item) => item.ingredientId !== ingredientId);
      }
      if (exists) {
        return prev.map((item) =>
          item.ingredientId === ingredientId ? { ...item, quantity: nextQty } : item
        );
      }
      return [...prev, { ingredientId, quantity: nextQty }];
    });
  };

  const handleGalleryFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (!selectedFile.type.startsWith('image/')) {
      alert('Selecione um arquivo de imagem válido.');
      if (galleryInputRef.current) galleryInputRef.current.value = '';
      return;
    }

    if (selectedFile.size > MAX_PRODUCT_IMAGE_BYTES) {
      alert('A imagem deve ter no máximo 6MB.');
      if (galleryInputRef.current) galleryInputRef.current.value = '';
      return;
    }

    setUploadErrorMessage('');
    setIsUploadingImage(true);

    try {
      const uploadedImageUrl = isCloudinaryConfigured
        ? await uploadImageToCloudinary(selectedFile)
        : await convertImageFileToDataUrl(selectedFile);
      setImageUrl(uploadedImageUrl);
      setIsImageUrlVisible(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao processar imagem.';
      setUploadErrorMessage(message);
      alert(message);
    } finally {
      setIsUploadingImage(false);
      if (galleryInputRef.current) {
        galleryInputRef.current.value = '';
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedName = name.trim();
    const normalizedPriceRaw = price.trim().replace(',', '.');
    const parsedPrice = Number(normalizedPriceRaw);

    if (isUploadingImage) {
      alert('Aguarde o envio da imagem para finalizar o cadastro.');
      return;
    }

    if (!normalizedName || !normalizedImageUrl || recipeToPersist.length === 0) {
      alert("Preencha todos os campos e adicione pelo menos um ingrediente à receita!");
      return;
    }
    if (normalizedImageUrl.length > MAX_PRODUCT_IMAGE_URL_LENGTH) {
      alert('A imagem selecionada ficou muito grande. Use uma imagem menor.');
      return;
    }
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      alert('Preço de venda inválido. Informe um número maior ou igual a zero.');
      return;
    }

    const nextComboItems = isCombo
      ? comboItems.filter((item) => {
          const qty = Number(item.quantity);
          return item.productId.trim() !== '' && Number.isInteger(qty) && qty > 0;
        })
      : undefined;

    const newProduct: Product = {
      id: 'p-' + Math.random().toString(36).substr(2, 9),
      name: normalizedName,
      price: parsedPrice,
      category,
      imageUrl: normalizedImageUrl,
      recipe: recipeToPersist,
      comboItems: nextComboItems,
    };

    onAdd(newProduct);
    // Reset state
    setName('');
    setPrice('');
    setCategory('Snack');
    setImageUrl('');
    setIsImageUrlVisible(false);
    setUploadErrorMessage('');
    setRecipe([]);
    setComboItems([]);
    if (galleryInputRef.current) {
      galleryInputRef.current.value = '';
    }
    onClose();
  };

  const formatQuantity = (value: number) =>
    Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');

  return (
    <div className="qb-modal-overlay fixed inset-0 bg-slate-900/90 backdrop-blur-md z-[250] flex items-center justify-center p-4">
      <div className="qb-product-modal bg-white w-full max-w-2xl rounded-[40px] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in duration-200 max-h-[90vh]">
        <div className="qb-modal-head p-6 bg-slate-900 text-white flex justify-between items-center">
          <div>
            <h3 className="text-2xl font-black tracking-tight uppercase">Novo Produto</h3>
            <p className="text-xs font-bold opacity-60 uppercase tracking-widest">Adicionar item ao cardápio</p>
          </div>
          <button 
            onClick={onClose}
            className="qb-btn-touch bg-slate-800 p-2 rounded-full hover:bg-slate-700 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="qb-product-form flex-1 overflow-y-auto p-8 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Nome do Produto</label>
              <input 
                type="text" 
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Ex: X-Mega Bacon"
                className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Preço de Venda (R$)</label>
              <input 
                type="number" 
                step="0.01"
                value={price}
                onChange={e => setPrice(e.target.value)}
                placeholder="0.00"
                className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Categoria</label>
              <select 
                value={category}
                onChange={e => setCategory(e.target.value as any)}
                className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500 appearance-none cursor-pointer"
              >
                <option value="Snack">Lanche (Burguer)</option>
                <option value="Drink">Bebida</option>
                <option value="Side">Acompanhamento</option>
                <option value="Combo">Combo</option>
              </select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Foto do Produto</label>
                <button
                  type="button"
                  onClick={() => setIsImageUrlVisible((current) => !current)}
                  className="qb-btn-touch bg-slate-100 text-slate-700 px-2.5 py-1.5 rounded-lg font-black text-[9px] uppercase tracking-widest hover:bg-slate-200 transition-colors"
                >
                  URL
                </button>
              </div>

              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                onChange={handleGalleryFileChange}
                className="hidden"
              />

              <button
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                disabled={isUploadingImage}
                className="qb-btn-touch w-full bg-slate-100 text-slate-700 px-4 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors text-left disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isUploadingImage
                  ? 'Enviando para Cloudinary...'
                  : hasImageSelected
                    ? 'Trocar imagem da galeria'
                    : 'Selecionar imagem da galeria'}
              </button>

              {isImageUrlVisible && (
                <input
                  type="text"
                  value={imageUrl}
                  onChange={(e) => {
                    setImageUrl(e.target.value);
                    setUploadErrorMessage('');
                  }}
                  placeholder="https://res.cloudinary.com/.../image/upload/..."
                  className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                />
              )}

              {!isCloudinaryConfigured && (
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                  Cloudinary não configurado: usando preview local ao escolher da galeria.
                </p>
              )}

              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                {isUploadingImage
                  ? 'Upload em andamento...'
                  : hasImageSelected
                    ? isLocalImagePreview
                      ? 'Imagem local carregada.'
                      : 'Imagem pronta para salvar.'
                    : 'Nenhuma imagem selecionada.'}
              </p>

              {uploadErrorMessage && (
                <p className="text-[10px] font-black uppercase tracking-widest text-red-600">
                  {uploadErrorMessage}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                {isCombo ? 'Montagem do Combo (Produtos)' : 'Montagem da Receita (Ingredientes)'}
              </label>
              <span className="text-[10px] font-black text-red-500 uppercase">
                {isCombo ? `${comboItems.length} Produtos Selecionados` : `${recipe.length} Itens Selecionados`}
              </span>
            </div>

            {isCombo ? (
              <>
                <ComboItemsBuilder products={products} comboItems={comboItems} onChange={setComboItems} />
                <div className="rounded-2xl bg-slate-100 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Receita gerada automaticamente: {comboRecipe.length} insumos
                </div>
              </>
            ) : (
              <div className="qb-recipe-grid grid grid-cols-1 sm:grid-cols-2 gap-3">
                {ingredients.map((ing) => {
                  const qty = recipe.find((r) => r.ingredientId === ing.id)?.quantity || 0;
                  const recipeUnitLabel = getRecipeQuantityUnitLabel(ing, qty);
                  return (
                    <div
                      key={ing.id}
                      className={`qb-recipe-item p-3 rounded-2xl border-2 transition-all flex items-center justify-between ${
                        qty > 0 ? 'border-red-500 bg-red-50/30' : 'border-slate-100 bg-white'
                      }`}
                    >
                      <div className="flex-1 min-w-0 pr-2">
                        <p className="font-extrabold text-slate-800 text-sm truncate uppercase">{ing.name}</p>
                        <p className="text-[9px] font-bold text-slate-400 uppercase">{recipeUnitLabel}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => handleUpdateRecipe(ing.id, -1)}
                          className="qb-btn-touch w-8 h-8 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center font-black"
                        >
                          -
                        </button>
                        <input
                          type="number"
                          min="0"
                          step={getRecipeAdjustmentStep(ing, qty)}
                          inputMode="decimal"
                          value={qty > 0 ? formatQuantity(qty) : ''}
                          onChange={(e) => handleSetRecipeQuantity(ing.id, e.target.value)}
                          placeholder="0"
                          className="w-20 rounded-xl border border-slate-200 bg-white px-2 py-1 text-center text-sm font-black text-slate-800 outline-none focus:border-red-400"
                        />
                        <button
                          type="button"
                          onClick={() => handleUpdateRecipe(ing.id, 1)}
                          className="qb-btn-touch w-8 h-8 rounded-xl bg-red-600 text-white flex items-center justify-center font-black"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="pt-4">
            <button 
              type="submit"
              className="qb-btn-touch w-full bg-red-600 hover:bg-red-700 text-white py-5 rounded-3xl font-black uppercase tracking-tighter text-xl shadow-xl shadow-red-200 transition-all active:scale-95 flex items-center justify-center gap-3"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
              SALVAR PRODUTO NO CAIXA
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddProductModal;
