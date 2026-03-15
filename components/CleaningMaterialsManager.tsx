import React, { useMemo, useRef, useState } from 'react';
import { CleaningMaterial, CleaningStockEntry } from '../types';
import {
  allowsFractionalStockUnit,
  formatStockQuantityByUnit,
  normalizeStockMovementByUnit,
  normalizeStockQuantityByUnit,
} from '../utils/recipe';

interface CleaningMaterialsManagerProps {
  materials: CleaningMaterial[];
  entries: CleaningStockEntry[];
  onAddMaterial: (material: CleaningMaterial) => void;
  onUpdateMaterial: (material: CleaningMaterial) => void;
  onDeleteMaterial: (materialId: string) => void;
  onUpdateStock: (materialId: string, amount: number) => void;
}

type CleaningTab = 'materiais' | 'estoque';

interface MaterialFormState {
  name: string;
  unit: string;
  currentStock: string;
  minStock: string;
  cost: string;
  imageUrl: string;
}

const INITIAL_FORM: MaterialFormState = {
  name: '',
  unit: 'un',
  currentStock: '',
  minStock: '',
  cost: '',
  imageUrl: '',
};

const CleaningMaterialsManager: React.FC<CleaningMaterialsManagerProps> = ({
  materials,
  entries,
  onAddMaterial,
  onUpdateMaterial,
  onDeleteMaterial,
  onUpdateStock,
}) => {
  const [activeTab, setActiveTab] = useState<CleaningTab>('materiais');
  const [form, setForm] = useState<MaterialFormState>(INITIAL_FORM);
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(null);
  const [stockValues, setStockValues] = useState<Record<string, string>>({});
  const [isMaterialFormOpen, setIsMaterialFormOpen] = useState(false);
  const [deleteMenuId, setDeleteMenuId] = useState<string | null>(null);
  const [isPhotoOptionsOpen, setIsPhotoOptionsOpen] = useState(false);
  const [photoSourceMode, setPhotoSourceMode] = useState<'GALLERY' | 'LINK'>('LINK');

  const timerRef = useRef<number | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const sortedEntries = useMemo(
    () => entries.slice().sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()),
    [entries]
  );
  const materialsById = useMemo(
    () => new Map(materials.map((material) => [material.id, material])),
    [materials]
  );

  const handleFormChange = (field: keyof MaterialFormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const resetForm = () => {
    setForm(INITIAL_FORM);
    setEditingMaterialId(null);
    setIsPhotoOptionsOpen(false);
    setPhotoSourceMode('LINK');
    if (galleryInputRef.current) {
      galleryInputRef.current.value = '';
    }
  };

  const closeMaterialForm = () => {
    setIsMaterialFormOpen(false);
    resetForm();
  };

  const openCreateMaterialForm = () => {
    resetForm();
    setIsMaterialFormOpen(true);
  };

  const isLocalGalleryImage = form.imageUrl.trim().startsWith('data:image/');

  const handleGalleryFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        handleFormChange('imageUrl', reader.result);
      }
    };
    reader.readAsDataURL(selectedFile);
    e.target.value = '';
  };

  const handleSubmitMaterial = (e: React.FormEvent) => {
    e.preventDefault();

    const name = form.name.trim();
    const currentStock = Number(form.currentStock);
    const minStock = Number(form.minStock);
    const cost = Number(form.cost);

    if (!name || !Number.isFinite(currentStock) || !Number.isFinite(minStock) || !Number.isFinite(cost)) {
      alert('Preencha nome, estoque atual, estoque minimo e custo.');
      return;
    }

    if (currentStock < 0 || minStock < 0 || cost < 0) {
      alert('Os valores numericos devem ser maiores ou iguais a zero.');
      return;
    }

    const materialPayload = {
      name,
      unit: form.unit.trim(),
      currentStock: normalizeStockQuantityByUnit(form.unit, currentStock),
      minStock: normalizeStockQuantityByUnit(form.unit, minStock),
      cost,
      imageUrl: form.imageUrl.trim() ? form.imageUrl.trim() : undefined,
    };

    if (editingMaterialId) {
      const current = materials.find((m) => m.id === editingMaterialId);
      if (!current) {
        alert('Material nao encontrado para edicao.');
        closeMaterialForm();
        return;
      }
      onUpdateMaterial({ ...current, ...materialPayload });
    } else {
      onAddMaterial({
        id: `cm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ...materialPayload,
      });
    }

    closeMaterialForm();
  };

  const handleEditMaterial = (material: CleaningMaterial) => {
    setEditingMaterialId(material.id);
    setForm({
      name: material.name,
      unit: material.unit,
      currentStock: String(material.currentStock),
      minStock: String(material.minStock),
      cost: String(material.cost),
      imageUrl: material.imageUrl ?? '',
    });
    setIsPhotoOptionsOpen(Boolean(material.imageUrl));
    setPhotoSourceMode(material.imageUrl?.trim().startsWith('data:image/') ? 'GALLERY' : 'LINK');
    setActiveTab('estoque');
    setIsMaterialFormOpen(true);
  };

  const handleDeleteMaterial = (material: CleaningMaterial) => {
    if (confirm(`Excluir o material "${material.name}"?`)) {
      onDeleteMaterial(material.id);
      if (editingMaterialId === material.id) {
        closeMaterialForm();
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent, materialId: string) => {
    e.preventDefault();
    setDeleteMenuId(materialId);
  };

  const handleTouchStart = (materialId: string) => {
    timerRef.current = window.setTimeout(() => {
      setDeleteMenuId(materialId);
    }, 800);
  };

  const handleTouchEnd = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleStockInput = (materialId: string, value: string) => {
    setStockValues((prev) => ({ ...prev, [materialId]: value }));
  };

  const handleStockMove = (material: CleaningMaterial, direction: 'in' | 'out') => {
    const amountRaw = Number(stockValues[material.id]);
    if (!Number.isFinite(amountRaw) || amountRaw <= 0) return;
    if (!allowsFractionalStockUnit(material.unit) && !Number.isInteger(amountRaw)) return;
    const normalizedAmount = normalizeStockMovementByUnit(material.unit, amountRaw);
    if (normalizedAmount <= 0) return;
    if (direction === 'out' && material.currentStock + Number.EPSILON < normalizedAmount) return;

    onUpdateStock(material.id, direction === 'out' ? -normalizedAmount : normalizedAmount);
    setStockValues((prev) => ({ ...prev, [material.id]: '' }));
  };

  return (
    <div className="qb-cleaning p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div className="qb-cleaning-header flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight">OUTROS - MATERIAIS DE LIMPEZA</h2>
          <p className="text-slate-500 font-semibold">Mini controle separado do estoque de alimentos.</p>
        </div>

        <div className="qb-cleaning-tabs flex bg-slate-200 p-1 rounded-2xl gap-1">
          <button
            onClick={() => setActiveTab('materiais')}
            className={`qb-btn-touch px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all ${
              activeTab === 'materiais' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:bg-slate-300'
            }`}
          >
            MATERIAIS
          </button>
          <button
            onClick={() => setActiveTab('estoque')}
            className={`qb-btn-touch px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all ${
              activeTab === 'estoque' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:bg-slate-300'
            }`}
          >
            ESTOQUE
          </button>
        </div>
      </div>

      {activeTab === 'materiais' && (
        <div className="qb-cleaning-materials-panel bg-white rounded-[32px] p-6 border-2 border-slate-100 shadow-sm">
          <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Materiais Cadastrados</h3>
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mt-1">
            Controle isolado do estoque principal
          </p>

          {materials.length === 0 ? (
            <div className="py-20 text-center text-slate-300 font-black uppercase text-xs">Nenhum material cadastrado.</div>
          ) : (
            <div className="qb-cleaning-material-grid mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {materials.map((material) => {
                const isLow = material.currentStock <= material.minStock;
                return (
                  <div
                    key={material.id}
                    className={`qb-cleaning-material-card rounded-3xl p-4 flex flex-col gap-3 border ${
                      isLow ? 'border-yellow-300 bg-yellow-50/40' : 'border-slate-200 bg-slate-50'
                    } relative`}
                    onContextMenu={(e) => handleContextMenu(e, material.id)}
                    onTouchStart={() => handleTouchStart(material.id)}
                    onTouchEnd={handleTouchEnd}
                    onTouchCancel={handleTouchEnd}
                    onMouseLeave={() => setDeleteMenuId(null)}
                  >
                    {deleteMenuId === material.id && (
                      <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm z-20 rounded-3xl flex items-center justify-center p-4">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteMaterial(material);
                            setDeleteMenuId(null);
                          }}
                          className="qb-btn-touch bg-red-600 text-white px-6 py-3 rounded-2xl font-black text-xs uppercase shadow-xl active:scale-95 transition-all"
                        >
                          Excluir Material
                        </button>
                      </div>
                    )}

                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        {material.imageUrl ? (
                          <img
                            src={material.imageUrl}
                            alt={material.name}
                            className="w-12 h-12 rounded-xl object-cover border border-slate-200"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-xl border border-dashed border-slate-300 flex items-center justify-center text-[10px] font-black text-slate-300">
                            IMG
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-[10px] font-black uppercase text-slate-400">{material.id}</p>
                          <p className="font-black text-slate-900 uppercase truncate">{material.name}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <button
                          onClick={() => {
                            setDeleteMenuId(null);
                            handleEditMaterial(material);
                          }}
                          className="qb-btn-touch bg-white/90 backdrop-blur-sm p-2 rounded-xl shadow-sm border border-slate-100 text-slate-500 hover:text-red-600 hover:scale-105 transition-all active:scale-95"
                          title="Editar material"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                        </button>
                        <div className="text-right">
                          <p className={`text-xl font-black ${isLow ? 'text-yellow-600' : 'text-slate-900'}`}>
                            {formatStockQuantityByUnit(material.unit, material.currentStock)}
                          </p>
                          <p className="text-[10px] font-black text-slate-400 uppercase">{material.unit}</p>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[11px] font-bold text-slate-500">
                      <span>Minimo: {formatStockQuantityByUnit(material.unit, material.minStock)}</span>
                      <span>Custos: R$ {material.cost.toFixed(2)}</span>

                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === 'estoque' && (
        <div className="space-y-6">
          <div className="qb-cleaning-stock-panel bg-white rounded-[32px] p-6 border-2 border-slate-100 shadow-sm">
            <div className="qb-cleaning-stock-head flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Movimentar Estoque de Materiais</h3>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mt-1">
                  Entradas e saidas independentes do estoque de alimentos
                </p>
              </div>
              <button
                onClick={openCreateMaterialForm}
                className="qb-btn-touch bg-red-600 hover:bg-red-700 text-white p-3 rounded-2xl shadow-lg transition-all active:scale-95"
                title="Cadastrar material"
                aria-label="Cadastrar material"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
              </button>
            </div>

            {materials.length === 0 ? (
              <div className="py-16 text-center text-slate-300 font-black uppercase text-xs">Cadastre materiais para movimentar estoque.</div>
            ) : (
              <div className="qb-cleaning-stock-grid mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {materials.map((material) => {
                  const inputValue = stockValues[material.id] || '';
                  const parsed = Number(inputValue);
                  const allowsFractional = allowsFractionalStockUnit(material.unit);
                  const isValidTypedValue =
                    Number.isFinite(parsed) &&
                    parsed > 0 &&
                    (allowsFractional || Number.isInteger(parsed));
                  const normalizedTypedValue = isValidTypedValue
                    ? normalizeStockMovementByUnit(material.unit, parsed)
                    : 0;
                  const hasValidValue = normalizedTypedValue > 0;
                  const canConsume =
                    hasValidValue &&
                    material.currentStock + Number.EPSILON >= normalizedTypedValue;

                  return (
                    <div key={material.id} className="qb-cleaning-stock-card bg-slate-50 border border-slate-200 rounded-3xl p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          {material.imageUrl ? (
                            <img
                              src={material.imageUrl}
                              alt={material.name}
                              className="w-11 h-11 rounded-xl object-cover border border-slate-200"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-11 h-11 rounded-xl border border-dashed border-slate-300 flex items-center justify-center text-[10px] font-black text-slate-300">
                              IMG
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="text-[10px] font-black text-slate-400 uppercase">{material.id}</p>
                            <p className="font-black text-slate-900 uppercase truncate">{material.name}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-xl font-black text-slate-900">
                            {formatStockQuantityByUnit(material.unit, material.currentStock)}
                          </p>
                          <p className="text-[10px] font-black text-slate-400 uppercase">{material.unit}</p>
                        </div>
                      </div>

                      <input
                        type="number"
                        min="0"
                        step={allowsFractional ? '0.001' : '1'}
                        value={inputValue}
                        onChange={(e) => handleStockInput(material.id, e.target.value)}
                        placeholder="Quantidade"
                        className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-2.5 font-black text-slate-800 focus:ring-2 focus:ring-red-500"
                      />

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => handleStockMove(material, 'out')}
                          disabled={!canConsume}
                          className="qb-btn-touch bg-slate-700 disabled:bg-slate-300 text-white py-2.5 rounded-xl text-[11px] font-black uppercase"
                        >
                          Dar Baixa
                        </button>
                        <button
                          onClick={() => handleStockMove(material, 'in')}
                          disabled={!hasValidValue}
                          className="qb-btn-touch bg-red-600 disabled:bg-slate-300 text-white py-2.5 rounded-xl text-[11px] font-black uppercase"
                        >
                          Repor
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="qb-cleaning-history-panel bg-white rounded-[32px] p-6 border-2 border-slate-100 shadow-sm">
            <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">Historico de Materiais</h3>
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mt-1">
              Registros permanentes por data e horario
            </p>

            {sortedEntries.length === 0 ? (
              <div className="py-16 text-center text-slate-300 font-black uppercase text-xs">Nenhuma movimentacao registrada.</div>
            ) : (
              <div className="qb-cleaning-history-table mt-6 overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="px-3 py-2 text-[10px] font-black uppercase text-slate-400">Data</th>
                      <th className="px-3 py-2 text-[10px] font-black uppercase text-slate-400">Material</th>
                      <th className="px-3 py-2 text-[10px] font-black uppercase text-slate-400 text-right">Quantidade</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {sortedEntries.map((entry) => {
                      const isOut = entry.quantity < 0;
                      return (
                        <tr key={entry.id}>
                          <td className="px-3 py-3 text-xs font-bold text-slate-500">{entry.timestamp.toLocaleString('pt-BR')}</td>
                          <td className="px-3 py-3 text-xs font-black uppercase text-slate-800">{entry.materialName}</td>
                          <td className={`px-3 py-3 text-xs font-black text-right ${isOut ? 'text-red-600' : 'text-green-600'}`}>
                            {isOut ? '-' : '+'}
                            {formatStockQuantityByUnit(
                              materialsById.get(entry.materialId)?.unit || '',
                              Math.abs(entry.quantity)
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {isMaterialFormOpen && (
        <div className="qb-cleaning-form-overlay fixed inset-0 z-[140] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="qb-cleaning-form-panel bg-white w-full max-w-xl rounded-[32px] shadow-2xl border border-slate-200 overflow-hidden">
            <div className="qb-cleaning-form-head px-6 py-5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight">
                  {editingMaterialId ? 'Editar Material' : 'Cadastrar Material'}
                </h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                  Inclui foto por link ou galeria
                </p>
              </div>
              <button
                type="button"
                onClick={closeMaterialForm}
                className="qb-btn-touch bg-slate-200 hover:bg-slate-300 p-2 rounded-xl"
                aria-label="Fechar cadastro"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>

            <form onSubmit={handleSubmitMaterial} className="qb-cleaning-form-body p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Nome</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => handleFormChange('name', e.target.value)}
                  placeholder="Ex: Desinfetante"
                  className="mt-1 w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Unidade</label>
                  <select
                    value={form.unit}
                    onChange={(e) => handleFormChange('unit', e.target.value)}
                    className="mt-1 w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  >
                    <option value="un">Unidade (un)</option>
                    <option value="l">Litro (L)</option>
                    <option value="ml">Mililitro (ml)</option>
                    <option value="kg">Quilo (kg)</option>
                    <option value="g">Grama (g)</option>
                    <option value="pct">Pacote (pct)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Custo (R$)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.cost}
                    onChange={(e) => handleFormChange('cost', e.target.value)}
                    placeholder="0,00"
                    className="mt-1 w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Estoque Atual</label>
                  <input
                    type="number"
                    min="0"
                    step={allowsFractionalStockUnit(form.unit) ? '0.001' : '1'}
                    value={form.currentStock}
                    onChange={(e) => handleFormChange('currentStock', e.target.value)}
                    placeholder="0"
                    className="mt-1 w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Estoque Minimo</label>
                  <input
                    type="number"
                    min="0"
                    step={allowsFractionalStockUnit(form.unit) ? '0.001' : '1'}
                    value={form.minStock}
                    onChange={(e) => handleFormChange('minStock', e.target.value)}
                    placeholder="0"
                    className="mt-1 w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Foto (opcional)</label>
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
                        value={form.imageUrl}
                        onChange={(e) => handleFormChange('imageUrl', e.target.value)}
                        placeholder="https://res.cloudinary.com/.../image/upload/..."
                        className="w-full bg-slate-100 border-none rounded-2xl px-4 py-3 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                      />
                    )}
                  </>
                )}
              </div>

              <div className="qb-cleaning-form-actions flex gap-3 pt-2">
                <button
                  type="submit"
                  className="qb-btn-touch flex-1 bg-red-600 hover:bg-red-700 text-white py-3 rounded-2xl font-black uppercase tracking-tight"
                >
                  {editingMaterialId ? 'Salvar Material' : 'Adicionar Material'}
                </button>
                <button
                  type="button"
                  onClick={closeMaterialForm}
                  className="qb-btn-touch bg-slate-200 hover:bg-slate-300 text-slate-700 px-5 py-3 rounded-2xl font-black uppercase text-[11px]"
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default CleaningMaterialsManager;
