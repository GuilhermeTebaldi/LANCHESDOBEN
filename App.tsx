
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import Header from './components/Header';
import ProductCard from './components/ProductCard';
import InventoryManager from './components/InventoryManager';
import CleaningMaterialsManager from './components/CleaningMaterialsManager';
import SalesSummary from './components/SalesSummary';
import Notification from './components/Notification';
import SyncStatusOverlay from './components/SyncStatusOverlay';
import AddProductModal from './components/AddProductModal';
import AddIngredientModal from './components/AddIngredientModal';
import EditIngredientModal from './components/EditIngredientModal';
import EditProductModal from './components/EditProductModal';
import AdminDashboard from './components/AdminDashboard';
import AdminLogin from './components/AdminLogin';
import {
  CleaningMaterial,
  CleaningStockEntry,
  DailySalesHistoryEntry,
  Ingredient,
  Product,
  Sale,
  SaleCustomerType,
  SaleDraft,
  SalePaymentSplitEntry,
  SalePaymentSplitMode,
  SaleOrigin,
  SaleBasePaymentMethod,
  SalePaymentMethod,
  ViewMode,
  StockEntry,
  RecipeItem,
} from './types';
import { DEFAULT_APP_STATE, loadAppState, type AppState } from './data/appStorage';
import {
  enqueueStateCommandAsync,
  fetchStateSnapshot,
  getStateCommandAsyncJob,
  runStateCommand,
  StateCommandSyncError,
  warmupStateWriteContext,
  type StateCommandAsyncJobStatus,
  type StateCommand,
} from './data/stateCommandClient';
import { buildReceiptPrintRoutePath } from './utils/printRoutes';
import { clampReceiptPaperWidthMm } from './utils/receiptPaper';
import {
  aggregateRecipe,
  formatIngredientStockQuantity,
  getStockQuantityFromRecipeQuantity,
  normalizeStockMovementByUnit,
  normalizeStockQuantityByUnit,
} from './utils/recipe';
import {
  removeReceiptPrintPayload,
  saveReceiptPrintPayload,
  setReceiptPrintPayloadOnWindow,
  type ReceiptPrintPayload,
  type ReceiptPrintPayloadInput,
} from './utils/receiptPrintPayload';
import { reportErrorMonitorEvent } from './utils/errorMonitorClient';
import {
  describePaidSyncAssistantMode,
  getPaidSyncAssistantRecoverDelayMs,
  getPaidSyncAssistantRetryDelayMs,
  shouldPaidSyncAssistantRunRecovery,
} from './utils/paidSyncAssistant';

const ADMIN_GATE_KEY = 'lanchesdoben_admin_gate';
const ADMIN_SESSION_KEY = 'lanchesdoben_admin_session';
const ADMIN_SESSION_BACKUP_KEY = 'lanchesdoben_admin_session_backup';
const OFFLINE_SALE_QUEUE_KEY = 'qb_offline_sale_queue_v1';
const PENDING_DRAFT_ADDS_KEY = 'qb_pending_draft_adds_v1';
const PENDING_PAID_SYNC_QUEUE_KEY = 'qb_pending_paid_sync_queue_v1';
const FAILED_PAID_SYNC_QUEUE_KEY = 'qb_failed_paid_sync_queue_v1';
const CASH_HISTORY_LEGACY_MODE_KEY = 'qb_cash_history_legacy_mode_v1';
const LOCAL_CASH_REGISTER_KEY = 'qb_cash_register_local_v1';
const LOCAL_DAILY_HISTORY_KEY = 'qb_daily_sales_history_local_v1';
const RECEIPT_PAPER_WIDTH_KEY = 'qb_receipt_paper_width_mm';
const RECEIPT_PRINT_PRESET_STORAGE_KEY = 'qb_receipt_print_preset_v1';
const RESTAURANT_NAME_STORAGE_KEY = 'qb_restaurant_name';
const DEFAULT_RECEIPT_RESTAURANT_NAME = 'LANCHESDOBEN';
const AUTO_UPDATE_SCROLL_STATE_KEY = 'qb_auto_update_scroll_state_v1';
const AUTO_UPDATE_CHECK_INTERVAL_MS = 45_000;
const AUTO_UPDATE_FORCE_RELOAD_AFTER_MS = 10 * 60 * 1000;

type SaleRegisterCommand = Extract<StateCommand, { type: 'SALE_REGISTER' }>;
type SaleDraftAddItemCommand = Extract<StateCommand, { type: 'SALE_DRAFT_ADD_ITEM' }>;

interface OfflineQueuedSale {
  command: SaleRegisterCommand;
  queuedAt: string;
  attempts: number;
  lastError?: string;
}

interface PendingDraftAdd {
  draftId: string;
  localItemId: string;
  commandId: string;
  productId: string;
  quantity: number;
  recipeOverride?: RecipeItem[];
  priceOverride?: number;
  note?: string;
  queuedAt: string;
}

type PendingDraftAddsByDraftId = Record<string, PendingDraftAdd[]>;

type CornerSyncState =
  | { visible: false; status: 'idle'; message: string }
  | { visible: true; status: 'syncing' | 'success' | 'error'; message: string };

interface ReceiptPrintPreset {
  id: string;
  label: string;
  paperWidthMm: number | null;
}

interface RunCommandErrorSink {
  error?: unknown;
  message?: string;
  retryable?: boolean;
  statusCode?: number;
}

interface RunCommandOptions {
  skipOfflineQueue?: boolean;
  silentSuccessNotification?: boolean;
  silentErrorNotification?: boolean;
  errorSink?: RunCommandErrorSink;
  trackPendingState?: boolean;
  failFastOnVersionConflict?: boolean;
}

interface PaymentCommitSnapshot {
  draft: SaleDraft;
  paymentMethod: SalePaymentMethod;
  saleOrigin: SaleOrigin;
  appOrderTotalInput: string;
  cashReceivedInput: string;
  splitMode: SalePaymentSplitMode | null;
  splitCount: number | null;
  splitCommitted: SalePaymentSplitEntry[];
  effectivePaymentTotal: number;
}

interface PendingPaidSyncJob {
  id: string;
  draftId: string;
  snapshot: PaymentCommitSnapshot;
  finalizeCommandId: string;
  confirmCommandId: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
}

interface PendingPaidSyncDraftRecoveryResult {
  ok: boolean;
  reconciledOnServer?: boolean;
  retryable?: boolean;
  message?: string;
  statusCode?: number;
}

type PaidSyncAssistantMode = 'idle' | 'retrying' | 'recovering' | 'reconciling';

interface PaidSyncAssistantState {
  mode: PaidSyncAssistantMode;
  message: string;
  active: boolean;
  draftId: string | null;
  jobId: string | null;
  updatedAt: number;
}

interface UndoSaleGroup {
  id: string;
  saleDraftId: string | null;
  sales: Sale[];
  timestamp: Date | string;
  total: number;
  totalCost: number;
}

interface AdminSessionBarrier {
  token: string;
  issuedAt: number;
  lastHeartbeatAt: number;
}

interface StockUpdateOptions {
  useCashRegister?: boolean;
  purchaseDescription?: string;
}

const RECEIPT_PRINT_PRESETS: ReceiptPrintPreset[] = [
  { id: 'PADRAO', label: 'Padrão', paperWidthMm: null },
  { id: '48x297', label: '48 x 297 mm', paperWidthMm: 48 },
  { id: '58x297', label: '58 x 297 mm', paperWidthMm: 58 },
  { id: '72x297', label: '72 x 297 mm', paperWidthMm: 72 },
  { id: '80x297', label: '80 x 297 mm', paperWidthMm: 80 },
  { id: 'A4_210x297', label: 'A4 210 x 297 mm', paperWidthMm: 210 },
];
const DEFAULT_RECEIPT_PRINT_PRESET_ID = 'PADRAO';

const getReceiptPrintPresetById = (presetId: string): ReceiptPrintPreset =>
  RECEIPT_PRINT_PRESETS.find((preset) => preset.id === presetId) ||
  RECEIPT_PRINT_PRESETS.find((preset) => preset.id === DEFAULT_RECEIPT_PRINT_PRESET_ID) ||
  RECEIPT_PRINT_PRESETS[0];

const readReceiptPrintPresetId = (): string => {
  if (typeof window === 'undefined') return DEFAULT_RECEIPT_PRINT_PRESET_ID;
  try {
    const rawPreset = window.localStorage.getItem(RECEIPT_PRINT_PRESET_STORAGE_KEY);
    if (rawPreset) return getReceiptPrintPresetById(rawPreset).id;

    const rawWidth = Number(window.localStorage.getItem(RECEIPT_PAPER_WIDTH_KEY));
    if (Number.isFinite(rawWidth) && rawWidth > 0) {
      const normalizedWidth = clampReceiptPaperWidthMm(rawWidth);
      const matchedPreset = RECEIPT_PRINT_PRESETS.find((preset) => preset.paperWidthMm === normalizedWidth);
      if (matchedPreset) return matchedPreset.id;
    }
  } catch {
    // ignore storage read failures
  }
  return DEFAULT_RECEIPT_PRINT_PRESET_ID;
};

const writeReceiptPrintPresetId = (presetId: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECEIPT_PRINT_PRESET_STORAGE_KEY, presetId);
  } catch {
    // ignore storage write failures
  }
};

const applyReceiptPrintPreset = (presetId: string): void => {
  if (typeof window === 'undefined') return;
  const preset = getReceiptPrintPresetById(presetId);
  try {
    if (preset.paperWidthMm === null) {
      window.localStorage.removeItem(RECEIPT_PAPER_WIDTH_KEY);
      return;
    }
    window.localStorage.setItem(
      RECEIPT_PAPER_WIDTH_KEY,
      String(clampReceiptPaperWidthMm(preset.paperWidthMm))
    );
  } catch {
    // ignore storage write failures
  }
};

const roundMoney = (value: number): number => Number(value.toFixed(2));
const LEGACY_COST_RATIO_MAX = 3.5;
const LEGACY_COST_RATIO_TARGET = 0.45;
const LEGACY_COST_DIVISORS = [1, 10, 100, 1000] as const;

const normalizeLegacyHistoryCost = (rawCost: number, rawRevenue: number): number => {
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

const buildUpdateCheckIndexUrl = (): string => {
  const baseUrl = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  const prefix = baseUrl || '';
  return `${prefix}/index.html?__update_check=${Date.now()}`;
};

const normalizeEntrypointPath = (value: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.pathname;
  } catch {
    return null;
  }
};

const readCurrentEntrypointPath = (): string | null => {
  if (typeof document === 'undefined') return null;
  const scriptNodes = Array.from(document.querySelectorAll('script[type="module"][src]'));
  for (let index = scriptNodes.length - 1; index >= 0; index -= 1) {
    const rawSrc = scriptNodes[index].getAttribute('src');
    if (!rawSrc) continue;
    if (rawSrc.includes('/@vite/')) continue;
    const normalized = normalizeEntrypointPath(rawSrc);
    if (normalized) return normalized;
  }
  return null;
};

const readEntrypointPathFromHtml = (html: string): string | null => {
  const moduleScriptMatch = html.match(
    /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/i
  );
  if (!moduleScriptMatch || !moduleScriptMatch[1]) return null;
  return normalizeEntrypointPath(moduleScriptMatch[1]);
};

const normalizeIngredientStockByUnit = (ingredient: Ingredient): Ingredient => ({
  ...ingredient,
  currentStock: normalizeStockQuantityByUnit(ingredient.unit, ingredient.currentStock),
  minStock: normalizeStockQuantityByUnit(ingredient.unit, ingredient.minStock),
});

const normalizeCleaningMaterialStockByUnit = (
  material: CleaningMaterial
): CleaningMaterial => ({
  ...material,
  currentStock: normalizeStockQuantityByUnit(material.unit, material.currentStock),
  minStock: normalizeStockQuantityByUnit(material.unit, material.minStock),
});

const normalizeIngredientsStockList = (items: Ingredient[]): Ingredient[] =>
  items.map((item) => normalizeIngredientStockByUnit(item));

const normalizeCleaningMaterialsStockList = (items: CleaningMaterial[]): CleaningMaterial[] =>
  items.map((item) => normalizeCleaningMaterialStockByUnit(item));

const calculateCashRegisterExpensesFromStockEntries = (entries: StockEntry[]): number =>
  roundMoney(
    entries.reduce((sum, entry) => {
      const impact = Number(entry.cashRegisterImpact);
      if (!Number.isFinite(impact) || impact >= 0) return sum;
      return sum + Math.abs(impact);
    }, 0)
  );

const readCashHistoryLegacyMode = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CASH_HISTORY_LEGACY_MODE_KEY) === '1';
  } catch {
    return false;
  }
};

const writeCashHistoryLegacyMode = (enabled: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.localStorage.setItem(CASH_HISTORY_LEGACY_MODE_KEY, '1');
    } else {
      window.localStorage.removeItem(CASH_HISTORY_LEGACY_MODE_KEY);
    }
  } catch {
    // ignore storage write failures
  }
};

const readLocalCashRegisterAmount = (): number => {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(LOCAL_CASH_REGISTER_KEY);
    if (!raw) return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return roundMoney(parsed);
  } catch {
    return 0;
  }
};

const writeLocalCashRegisterAmount = (amount: number): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_CASH_REGISTER_KEY, String(roundMoney(Math.max(0, amount))));
  } catch {
    // ignore storage write failures
  }
};

const normalizeDailyHistoryEntry = (value: unknown): DailySalesHistoryEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const closedAtRaw = source.closedAt;
  const closedAt =
    closedAtRaw instanceof Date || typeof closedAtRaw === 'string'
      ? closedAtRaw
      : new Date().toISOString();

  const saleCountRaw = Number(source.saleCount);
  const saleCount = Number.isFinite(saleCountRaw) && saleCountRaw >= 0 ? Math.floor(saleCountRaw) : 0;
  const totalRevenue = roundMoney(Math.max(0, Number(source.totalRevenue) || 0));
  const rawTotalPurchases = Number(source.totalPurchases);
  const rawTotalProfit = Number(source.totalProfit);
  const fallbackTotalPurchases =
    Number.isFinite(rawTotalProfit) && rawTotalProfit <= totalRevenue
      ? Math.max(0, totalRevenue - rawTotalProfit)
      : 0;
  const totalPurchases = roundMoney(
    Number.isFinite(rawTotalPurchases) && rawTotalPurchases >= 0
      ? rawTotalPurchases
      : fallbackTotalPurchases
  );
  const normalizedPurchases = normalizeLegacyHistoryCost(totalPurchases, totalRevenue);
  const totalProfit = roundMoney(totalRevenue - normalizedPurchases);

  return {
    id:
      typeof source.id === 'string' && source.id.trim()
        ? source.id
        : `day-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    closedAt,
    openingCash: roundMoney(Math.max(0, Number(source.openingCash) || 0)),
    totalRevenue,
    totalPurchases: normalizedPurchases,
    totalProfit,
    saleCount,
    cashExpenses: roundMoney(Math.max(0, Number(source.cashExpenses) || 0)),
  };
};

const readLocalDailySalesHistory = (): DailySalesHistoryEntry[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_DAILY_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeDailyHistoryEntry(item))
      .filter((item): item is DailySalesHistoryEntry => item !== null);
  } catch {
    return [];
  }
};

const normalizeDailyHistoryList = (
  history: DailySalesHistoryEntry[]
): DailySalesHistoryEntry[] =>
  history
    .map((entry) => normalizeDailyHistoryEntry(entry))
    .filter((entry): entry is DailySalesHistoryEntry => entry !== null);

const writeLocalDailySalesHistory = (history: DailySalesHistoryEntry[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_DAILY_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // ignore storage write failures
  }
};

const generateAdminToken = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `admin-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

const parseAdminSessionBarrier = (raw: string | null): AdminSessionBarrier | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AdminSessionBarrier>;
    if (typeof parsed.token !== 'string' || parsed.token.trim() === '') return null;
    if (typeof parsed.issuedAt !== 'number' || !Number.isFinite(parsed.issuedAt)) return null;
    const lastHeartbeatAt =
      typeof parsed.lastHeartbeatAt === 'number' && Number.isFinite(parsed.lastHeartbeatAt)
        ? parsed.lastHeartbeatAt
        : parsed.issuedAt;
    return {
      token: parsed.token,
      issuedAt: parsed.issuedAt,
      lastHeartbeatAt,
    };
  } catch {
    return null;
  }
};

const loadAdminSessionBarrier = (): AdminSessionBarrier | null => {
  if (typeof window === 'undefined') return null;
  const fromLocal = parseAdminSessionBarrier(window.localStorage.getItem(ADMIN_SESSION_KEY));
  if (fromLocal) return fromLocal;
  return parseAdminSessionBarrier(window.sessionStorage.getItem(ADMIN_SESSION_BACKUP_KEY));
};

const persistAdminSessionBarrier = (session: AdminSessionBarrier) => {
  if (typeof window === 'undefined') return;
  const serialized = JSON.stringify(session);

  try {
    window.localStorage.setItem(ADMIN_SESSION_KEY, serialized);
  } catch {
    // ignore storage write failures
  }

  try {
    window.sessionStorage.setItem(ADMIN_SESSION_BACKUP_KEY, serialized);
  } catch {
    // ignore storage write failures
  }

  try {
    window.sessionStorage.setItem(ADMIN_GATE_KEY, 'authenticated');
  } catch {
    // ignore storage write failures
  }

  try {
    window.localStorage.setItem(ADMIN_GATE_KEY, 'authenticated');
  } catch {
    // ignore storage write failures
  }
};

const reinforceAdminSessionBarrier = (): AdminSessionBarrier => {
  const current = loadAdminSessionBarrier();
  const next: AdminSessionBarrier = {
    token: current?.token || generateAdminToken(),
    issuedAt: current?.issuedAt || Date.now(),
    lastHeartbeatAt: Date.now(),
  };
  persistAdminSessionBarrier(next);
  return next;
};

const resolveSiteRootUrl = () => {
  if (typeof window === 'undefined') return '/';
  const { protocol, hostname, port, origin } = window.location;
  if (port === '3001') {
    return `${protocol}//${hostname}:3000/`;
  }
  return `${origin}/`;
};

const createClientId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const isLocalPendingDraftItemId = (itemId: string): boolean =>
  typeof itemId === 'string' && itemId.startsWith('draft-item-local-');

const isSaleRegisterCommand = (command: StateCommand): command is SaleRegisterCommand =>
  command.type === 'SALE_REGISTER';

const ensureSaleCommandIdentifiers = (command: SaleRegisterCommand): SaleRegisterCommand => ({
  ...command,
  commandId: command.commandId?.trim() || createClientId('cmd'),
  clientSaleId: command.clientSaleId?.trim() || createClientId('sale'),
});

const toSaleDate = (timestamp: Date | string): Date | null => {
  if (timestamp instanceof Date) {
    return Number.isFinite(timestamp.getTime()) ? timestamp : null;
  }
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const formatSaleTime = (timestamp: Date | string): string => {
  const saleDate = toSaleDate(timestamp);
  if (!saleDate) return '--:--';
  return saleDate.toLocaleTimeString();
};

const formatSaleDateTime = (timestamp: Date | string): string => {
  const saleDate = toSaleDate(timestamp);
  if (!saleDate) return '--';
  return saleDate.toLocaleString('pt-BR');
};

const buildSaleOrderGroupKey = (sale: Sale, fallbackIndex: number): string => {
  const draftId = typeof sale.saleDraftId === 'string' ? sale.saleDraftId.trim() : '';
  if (draftId) return `draft:${draftId}`;
  const saleId = typeof sale.id === 'string' ? sale.id.trim() : '';
  if (saleId) return `sale:${saleId}`;
  return `fallback:${fallbackIndex}`;
};

const countSaleOrders = (sales: Sale[]): number => {
  const orderKeys = new Set<string>();
  sales.forEach((sale, index) => {
    if (!sale) return;
    orderKeys.add(buildSaleOrderGroupKey(sale, index));
  });
  return orderKeys.size;
};

const getSaleDayKey = (timestamp: Date | string): string | null => {
  const saleDate = toSaleDate(timestamp);
  if (!saleDate) return null;
  return saleDate.toLocaleDateString('pt-BR');
};

const formatMoney = (value: number): string => value.toFixed(2);

const parseMoneyInput = (raw: string): number | null => {
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const BASE_PAYMENT_METHODS: SaleBasePaymentMethod[] = ['PIX', 'DEBITO', 'CREDITO', 'DINHEIRO'];

const formatPaymentMethodLabel = (method: SalePaymentMethod): string => {
  if (method === 'DEBITO') return 'Débito';
  if (method === 'CREDITO') return 'Crédito';
  if (method === 'DIVIDIDO') return 'Dividido';
  return method;
};

const allocateSplitAmounts = (total: number, count: number): number[] => {
  const safeCount = Number.isInteger(count) && count > 0 ? count : 1;
  const totalCents = Math.max(0, Math.round(roundMoney(total) * 100));
  const base = Math.floor(totalCents / safeCount);
  const remainder = totalCents % safeCount;
  return Array.from({ length: safeCount }, (_, index) => roundMoney((base + (index < remainder ? 1 : 0)) / 100));
};

const sumSplitAmounts = (entries: SalePaymentSplitEntry[]): number =>
  roundMoney(entries.reduce((sum, entry) => sum + (Number.isFinite(entry.amount) ? entry.amount : 0), 0));

const isAppSaleOrigin = (origin: SaleOrigin): boolean =>
  origin === 'IFOOD' || origin === 'APP99' || origin === 'KEETA';

const isSameSaleOrigin = (left: SaleOrigin, right: SaleOrigin): boolean => left === right;

const getSaleOriginLabel = (origin: SaleOrigin): string => {
  if (origin === 'IFOOD') return 'iFood';
  if (origin === 'APP99') return '99';
  if (origin === 'KEETA') return 'Keeta';
  return 'Balcão';
};

const readReceiptRestaurantName = (): string => {
  if (typeof window === 'undefined') return DEFAULT_RECEIPT_RESTAURANT_NAME;
  const raw = window.localStorage.getItem(RESTAURANT_NAME_STORAGE_KEY);
  if (typeof raw !== 'string') return DEFAULT_RECEIPT_RESTAURANT_NAME;
  const trimmed = raw.trim();
  return trimmed || DEFAULT_RECEIPT_RESTAURANT_NAME;
};

const toReceiptBasePaymentLabel = (method: SaleBasePaymentMethod): string => {
  if (method === 'DEBITO') return 'DEBITO';
  if (method === 'CREDITO') return 'CREDITO';
  if (method === 'DINHEIRO') return 'DINHEIRO';
  return 'PIX';
};

const toReceiptPaymentMethodLabel = (method: SalePaymentMethod): string => {
  if (method === 'DEBITO') return 'DEBITO';
  if (method === 'CREDITO') return 'CREDITO';
  if (method === 'DINHEIRO') return 'DINHEIRO';
  if (method === 'DIVIDIDO') return 'DIVIDIDO';
  return 'PIX';
};

const toReceiptSaleOriginLabel = (origin: SaleOrigin): string | null => {
  if (origin === 'IFOOD') return 'IFOOD';
  if (origin === 'APP99') return '99';
  if (origin === 'KEETA') return 'KEETA';
  return null;
};

const toReceiptSaleOriginShortLabel = (origin: SaleOrigin): string | null => {
  if (origin === 'IFOOD') return 'IF';
  if (origin === 'APP99') return '99';
  if (origin === 'KEETA') return 'KT';
  return null;
};

const buildReceiptPrintPayloadFromSnapshot = (
  snapshot: PaymentCommitSnapshot,
  products: Product[]
): ReceiptPrintPayloadInput | null => {
  const productById = new Map(products.map((product) => [product.id, product]));
  const lines = snapshot.draft.items
    .map((item) => {
      const qtyRaw = Number(item.qty);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.max(1, Math.round(qtyRaw)) : 1;
      const product = productById.get(item.productId);
      const unitPriceRaw =
        typeof item.unitPriceSnapshot === 'number' && Number.isFinite(item.unitPriceSnapshot)
          ? item.unitPriceSnapshot
          : Number(product?.price) || 0;
      const unitPrice = roundMoney(Math.max(0, unitPriceRaw));
      const subtotal = roundMoney(unitPrice * qty);
      const note = typeof item.note === 'string' && item.note.trim() ? item.note.trim() : undefined;
      const name = item.nameSnapshot || product?.name || item.productId || 'Item';

      return {
        id: item.id || createClientId('receipt-line'),
        qty,
        name,
        unitPrice,
        subtotal,
        note,
      };
    })
    .filter((line) => line.qty > 0);

  if (lines.length === 0) return null;

  const observations = lines
    .filter((line) => Boolean(line.note))
    .map((line) => `${line.name}: ${line.note}`);

  const itemsTotal = roundMoney(lines.reduce((sum, line) => sum + line.subtotal, 0));
  const appOrderTotalParsed = isAppSaleOrigin(snapshot.saleOrigin)
    ? parseMoneyInput(snapshot.appOrderTotalInput)
    : null;
  const appOrderTotal =
    appOrderTotalParsed !== null && Number.isFinite(appOrderTotalParsed) && appOrderTotalParsed > 0
      ? roundMoney(appOrderTotalParsed)
      : null;
  const isAppSale = isAppSaleOrigin(snapshot.saleOrigin);
  const total = roundMoney(isAppSale && appOrderTotal !== null ? appOrderTotal : itemsTotal);

  const paymentSplits =
    snapshot.paymentMethod === 'DIVIDIDO'
      ? snapshot.splitCommitted
          .map((entry, index) => {
            const amount = roundMoney(Math.max(0, Number(entry.amount) || 0));
            const cashReceivedCandidate = Number(entry.cashReceived);
            const fallbackChangeCandidate = Number(entry.change);
            const cashReceived =
              entry.method === 'DINHEIRO' && Number.isFinite(cashReceivedCandidate)
                ? roundMoney(cashReceivedCandidate)
                : null;
            const change =
              entry.method === 'DINHEIRO'
                ? cashReceived !== null
                  ? roundMoney(cashReceived - amount)
                  : Number.isFinite(fallbackChangeCandidate)
                    ? roundMoney(fallbackChangeCandidate)
                    : null
                : null;
            return {
              label: entry.label || `Parcela ${index + 1}`,
              methodLabel: toReceiptBasePaymentLabel(entry.method),
              amount,
              cashReceived,
              change,
            };
          })
          .filter((entry) => entry.amount > 0)
      : [];

  const splitMethodSummary: string[] = [];
  paymentSplits.forEach((split) => {
    if (!splitMethodSummary.includes(split.methodLabel)) {
      splitMethodSummary.push(split.methodLabel);
    }
  });

  const paymentMethodLabel =
    snapshot.paymentMethod === 'DIVIDIDO'
      ? splitMethodSummary.length > 0
        ? splitMethodSummary.join(' + ')
        : 'DIVIDIDO'
      : toReceiptPaymentMethodLabel(snapshot.paymentMethod);

  const cashReceivedParsed =
    snapshot.paymentMethod === 'DINHEIRO' ? parseMoneyInput(snapshot.cashReceivedInput) : null;
  const paymentCashReceived =
    snapshot.paymentMethod === 'DINHEIRO' &&
    cashReceivedParsed !== null &&
    Number.isFinite(cashReceivedParsed) &&
    cashReceivedParsed >= 0
      ? roundMoney(cashReceivedParsed)
      : null;
  const paymentChange =
    snapshot.paymentMethod === 'DINHEIRO' && paymentCashReceived !== null
      ? roundMoney(paymentCashReceived - total)
      : null;

  return {
    receipt: {
      restaurantName: readReceiptRestaurantName(),
      orderNumber: null,
      orderId: snapshot.draft.id,
      paidAtIso: new Date().toISOString(),
      lines,
      itemsTotal,
      total,
      paymentMethodLabel,
      paymentCashReceived,
      paymentChange,
      paymentSplits,
      saleOriginLabel: toReceiptSaleOriginLabel(snapshot.saleOrigin),
      saleOriginShortLabel: toReceiptSaleOriginShortLabel(snapshot.saleOrigin),
      appOrderTotal: isAppSale ? appOrderTotal : null,
      isAppSale,
      observations,
    },
  };
};

const resolveDraftExpectedPaymentTotal = (draft: SaleDraft, origin: SaleOrigin): number => {
  if (isAppSaleOrigin(origin)) {
    const appAmount = Number(draft.appOrderTotal);
    if (Number.isFinite(appAmount) && appAmount > 0) {
      return roundMoney(appAmount);
    }
  }
  return roundMoney(draft.total);
};

const getStateSyncErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Falha ao sincronizar com o servidor. Tente novamente.';
};

const isStockRelatedErrorMessage = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('estoque') ||
    normalized.includes('insumo') ||
    normalized.includes('insuficient') ||
    normalized.includes('sem estoque') ||
    normalized.includes('falt')
  );
};

const isDraftEmptyErrorMessage = (message: string): boolean =>
  message.toLowerCase().includes('carrinho está vazio');

const isFinalizeStateConflictErrorMessage = (message: string): boolean => {
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalized.includes('nao e possivel finalizar esta venda');
};

const isDatabaseUnavailableErrorMessage = (message: string): boolean => {
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return (
    normalized.includes('banco temporariamente indisponivel') ||
    normalized.includes('banco temporariamente ocupado') ||
    normalized.includes('http 503') ||
    normalized.includes('p1001') ||
    normalized.includes('p1002') ||
    normalized.includes('p1017') ||
    normalized.includes('cant reach database server') ||
    normalized.includes('server has closed the connection') ||
    normalized.includes('connection reset by peer')
  );
};

const isAutoRecoverableFailedQueueMessage = (message: string): boolean => {
  if (isDatabaseUnavailableErrorMessage(message)) {
    return false;
  }
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return (
    normalized.includes('conflito de versao') ||
    normalized.includes('token de estado desatualizado') ||
    normalized.includes('nao e possivel finalizar esta venda') ||
    normalized.includes('venda ainda nao foi finalizada para pagamento')
  );
};

const isRetryableSyncError = (error: unknown): boolean => {
  if (error instanceof StateCommandSyncError) {
    return error.retryable;
  }
  if (error instanceof Error) {
    const normalizedMessage = error.message.toLowerCase();
    return (
      normalizedMessage.includes('network') ||
      normalizedMessage.includes('fetch') ||
      normalizedMessage.includes('timeout') ||
      normalizedMessage.includes('conex')
    );
  }
  return false;
};

const ASYNC_COMMAND_JOB_POLL_BASE_INTERVAL_MS = 1200;
const ASYNC_COMMAND_JOB_POLL_MAX_INTERVAL_MS = 5000;
const ASYNC_COMMAND_JOB_POLL_JITTER_MIN = 0.8;
const ASYNC_COMMAND_JOB_POLL_JITTER_MAX = 1.25;
const ASYNC_COMMAND_JOB_POLL_TIMEOUT_MS = 25000;

const isAsyncCommandJobTerminalStatus = (status: StateCommandAsyncJobStatus): boolean =>
  status === 'COMPLETED' || status === 'FAILED';

const getAsyncCommandJobPollDelayMs = (attempt: number): number => {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponentialDelay = ASYNC_COMMAND_JOB_POLL_BASE_INTERVAL_MS * 2 ** safeAttempt;
  const cappedDelay = Math.min(ASYNC_COMMAND_JOB_POLL_MAX_INTERVAL_MS, exponentialDelay);
  const jitterFactor =
    ASYNC_COMMAND_JOB_POLL_JITTER_MIN +
    Math.random() * (ASYNC_COMMAND_JOB_POLL_JITTER_MAX - ASYNC_COMMAND_JOB_POLL_JITTER_MIN);
  return Math.max(
    ASYNC_COMMAND_JOB_POLL_BASE_INTERVAL_MS,
    Math.round(cappedDelay * jitterFactor)
  );
};

const waitForAsyncCommandJobTerminalStatus = async (
  jobId: string
): Promise<{
  status: StateCommandAsyncJobStatus;
  lastError: string | null;
}> => {
  const startedAt = Date.now();
  let pollAttempt = 0;

  while (Date.now() - startedAt < ASYNC_COMMAND_JOB_POLL_TIMEOUT_MS) {
    const job = await getStateCommandAsyncJob(jobId);
    if (isAsyncCommandJobTerminalStatus(job.status)) {
      return {
        status: job.status,
        lastError: job.lastError,
      };
    }

    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, getAsyncCommandJobPollDelayMs(pollAttempt));
    });
    pollAttempt += 1;
  }

  throw new StateCommandSyncError('Timeout aguardando processamento assíncrono no servidor.', {
    retryable: true,
  });
};

const toCommandSyncErrorContext = (command: StateCommand): Record<string, unknown> => {
  const context: Record<string, unknown> = {
    commandType: command.type,
    commandId: command.commandId || null,
  };

  if ('draftId' in command) context.draftId = command.draftId;
  if ('productId' in command) context.productId = command.productId;
  if ('itemId' in command) context.itemId = command.itemId;
  if ('ingredientId' in command) context.ingredientId = command.ingredientId;
  if ('materialId' in command) context.materialId = command.materialId;
  if ('saleId' in command) context.saleId = command.saleId;
  if ('saleIds' in command) context.saleIdsCount = command.saleIds.length;
  if ('paymentMethod' in command) context.paymentMethod = command.paymentMethod;
  if ('splitMode' in command) context.splitMode = command.splitMode || null;

  return context;
};

const updateRunCommandErrorSink = (
  sink: RunCommandErrorSink | undefined,
  payload: {
    error?: unknown;
    message?: string;
    retryable?: boolean;
    statusCode?: number;
  }
): void => {
  if (!sink) return;
  sink.error = payload.error;
  sink.message = payload.message;
  sink.retryable = payload.retryable;
  sink.statusCode = payload.statusCode;
};

const LEGACY_COMMAND_ERROR_HINTS = [
  'payload inválido',
  'payload invalido',
  'invalid discriminator',
  'comando',
  'unsupported',
  'not supported',
  'não suport',
  'nao suport',
];

const isUnsupportedCashHistoryCommandError = (error: unknown): boolean => {
  if (error instanceof StateCommandSyncError && error.retryable) {
    return false;
  }

  const statusCode =
    error instanceof StateCommandSyncError ? error.statusCode : undefined;
  const message =
    error instanceof Error ? error.message.toLowerCase() : '';

  const hasLegacyHint = LEGACY_COMMAND_ERROR_HINTS.some((hint) =>
    message.includes(hint)
  );

  if (hasLegacyHint) return true;
  if (statusCode === undefined) return false;
  return statusCode === 400 || statusCode === 404 || statusCode === 422;
};

const normalizeRecipeOverride = (value: unknown): RecipeItem[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const normalized = value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const candidate = item as Record<string, unknown>;
      const ingredientId =
        typeof candidate.ingredientId === 'string' ? candidate.ingredientId.trim() : '';
      const quantity = Number(candidate.quantity);

      if (!ingredientId || !Number.isFinite(quantity) || quantity <= 0) {
        return null;
      }

      return {
        ingredientId,
        quantity,
      };
    })
    .filter((item): item is RecipeItem => item !== null);

  return normalized.length > 0 ? normalized : undefined;
};

const validateDraftItemRecipe = (
  product: Product | null,
  recipeValue: unknown,
  availableIngredientIds: Set<string>
): { ok: true; recipe: RecipeItem[] } | { ok: false; message: string } => {
  if (!product) {
    return {
      ok: false,
      message: 'Produto não encontrado para o carrinho. Atualize a tela e tente novamente.',
    };
  }

  const normalizedRecipe = normalizeRecipeOverride(recipeValue ?? product.recipe);
  if (!normalizedRecipe || normalizedRecipe.length === 0) {
    return {
      ok: false,
      message: `${product.name} está sem receita válida e não pode ser vendido.`,
    };
  }

  const missingIngredientIds = normalizedRecipe
    .map((entry) => entry.ingredientId)
    .filter((ingredientId) => !availableIngredientIds.has(ingredientId));
  if (missingIngredientIds.length > 0) {
    return {
      ok: false,
      message: `${product.name} possui insumo ausente (${missingIngredientIds.join(', ')}).`,
    };
  }

  return {
    ok: true,
    recipe: normalizedRecipe,
  };
};

const normalizeQueuedSale = (value: unknown): OfflineQueuedSale | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const commandRecord =
    record.command && typeof record.command === 'object' && !Array.isArray(record.command)
      ? (record.command as Record<string, unknown>)
      : null;
  if (!commandRecord || commandRecord.type !== 'SALE_REGISTER') return null;

  const productId = typeof commandRecord.productId === 'string' ? commandRecord.productId.trim() : '';
  if (!productId) return null;

  const recipeOverride = normalizeRecipeOverride(commandRecord.recipeOverride);
  const priceOverrideRaw = Number(commandRecord.priceOverride);
  const priceOverride =
    Number.isFinite(priceOverrideRaw) && priceOverrideRaw >= 0 ? priceOverrideRaw : undefined;

  const command = ensureSaleCommandIdentifiers({
    type: 'SALE_REGISTER',
    productId,
    recipeOverride,
    priceOverride,
    commandId: typeof commandRecord.commandId === 'string' ? commandRecord.commandId : undefined,
    clientSaleId:
      typeof commandRecord.clientSaleId === 'string' ? commandRecord.clientSaleId : undefined,
  });

  const queuedAtCandidate =
    typeof record.queuedAt === 'string' && !Number.isNaN(Date.parse(record.queuedAt))
      ? record.queuedAt
      : new Date().toISOString();
  const attemptsCandidate = Number(record.attempts);
  const attempts =
    Number.isFinite(attemptsCandidate) && attemptsCandidate >= 0 ? Math.floor(attemptsCandidate) : 0;
  const lastError =
    typeof record.lastError === 'string' && record.lastError.trim() ? record.lastError : undefined;

  return {
    command,
    queuedAt: queuedAtCandidate,
    attempts,
    lastError,
  };
};

const loadOfflineSaleQueue = (): OfflineQueuedSale[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(OFFLINE_SALE_QUEUE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => normalizeQueuedSale(item))
      .filter((item): item is OfflineQueuedSale => item !== null);
  } catch {
    return [];
  }
};

const saveOfflineSaleQueue = (queue: OfflineQueuedSale[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(OFFLINE_SALE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // ignore storage write failures
  }
};

const normalizeRecipeSignature = (recipe: RecipeItem[] | undefined): string => {
  const normalized = normalizeRecipeOverride(recipe) || [];
  return normalized
    .slice()
    .sort((left, right) => left.ingredientId.localeCompare(right.ingredientId))
    .map((item) => `${item.ingredientId}:${item.quantity}`)
    .join('|');
};

const normalizePendingDraftAdd = (value: unknown): PendingDraftAdd | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  const draftId = typeof source.draftId === 'string' ? source.draftId.trim() : '';
  const productId = typeof source.productId === 'string' ? source.productId.trim() : '';
  if (!draftId || !productId) return null;

  const quantityRaw = Number(source.quantity);
  const quantity =
    Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.max(1, Math.round(quantityRaw)) : 1;
  const commandIdCandidate =
    typeof source.commandId === 'string' && source.commandId.trim()
      ? source.commandId.trim()
      : createClientId('cmd');
  const localItemIdCandidate =
    typeof source.localItemId === 'string' && source.localItemId.trim()
      ? source.localItemId.trim()
      : createClientId('draft-item-local');
  const recipeOverride = normalizeRecipeOverride(source.recipeOverride);
  const priceOverrideRaw = Number(source.priceOverride);
  const priceOverride =
    Number.isFinite(priceOverrideRaw) && priceOverrideRaw >= 0 ? roundMoney(priceOverrideRaw) : undefined;
  const noteCandidate = typeof source.note === 'string' ? source.note.trim() : '';
  const queuedAtCandidate =
    typeof source.queuedAt === 'string' && !Number.isNaN(Date.parse(source.queuedAt))
      ? source.queuedAt
      : new Date().toISOString();

  return {
    draftId,
    localItemId: localItemIdCandidate,
    commandId: commandIdCandidate,
    productId,
    quantity,
    recipeOverride,
    priceOverride,
    note: noteCandidate || undefined,
    queuedAt: queuedAtCandidate,
  };
};

const loadPendingDraftAdds = (): PendingDraftAddsByDraftId => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PENDING_DRAFT_ADDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const record = parsed as Record<string, unknown>;
    const next: PendingDraftAddsByDraftId = {};
    for (const [draftId, value] of Object.entries(record)) {
      if (!Array.isArray(value)) continue;
      const normalized = value
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          return normalizePendingDraftAdd({ ...(entry as Record<string, unknown>), draftId });
        })
        .filter((entry): entry is PendingDraftAdd => entry !== null);
      if (normalized.length > 0) {
        next[draftId] = normalized;
      }
    }
    return next;
  } catch {
    return {};
  }
};

const savePendingDraftAdds = (pendingAdds: PendingDraftAddsByDraftId): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PENDING_DRAFT_ADDS_KEY, JSON.stringify(pendingAdds));
  } catch {
    // ignore storage write failures
  }
};

const clonePaymentCommitSnapshot = (snapshot: PaymentCommitSnapshot): PaymentCommitSnapshot => ({
  draft: {
    ...snapshot.draft,
    items: (snapshot.draft.items || []).map((item) => ({
      ...item,
      recipe: (item.recipe || []).map((recipeEntry) => ({ ...recipeEntry })),
    })),
    payment: snapshot.draft.payment
      ? {
          ...snapshot.draft.payment,
          splitPayments: (snapshot.draft.payment.splitPayments || []).map((entry) => ({ ...entry })),
        }
      : {
          method: null,
          cashReceived: null,
          change: null,
          confirmedAt: null,
          splitMode: null,
          splitCount: null,
          splitPayments: [],
        },
  },
  paymentMethod: snapshot.paymentMethod || 'PIX',
  saleOrigin: snapshot.saleOrigin || 'LOCAL',
  appOrderTotalInput: typeof snapshot.appOrderTotalInput === 'string' ? snapshot.appOrderTotalInput : '',
  cashReceivedInput: typeof snapshot.cashReceivedInput === 'string' ? snapshot.cashReceivedInput : '',
  splitMode: snapshot.splitMode || null,
  splitCount:
    Number.isFinite(Number(snapshot.splitCount)) && Number(snapshot.splitCount) > 0
      ? Math.floor(Number(snapshot.splitCount))
      : null,
  splitCommitted: (snapshot.splitCommitted || []).map((entry) => ({ ...entry })),
  effectivePaymentTotal: roundMoney(
    Number.isFinite(Number(snapshot.effectivePaymentTotal))
      ? Number(snapshot.effectivePaymentTotal)
      : Number(snapshot.draft.total) || 0
  ),
});

const normalizePendingPaidSyncJob = (value: unknown): PendingPaidSyncJob | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const snapshotRaw = source.snapshot;
  if (!snapshotRaw || typeof snapshotRaw !== 'object' || Array.isArray(snapshotRaw)) return null;

  const snapshotRecord = snapshotRaw as Partial<PaymentCommitSnapshot>;
  const snapshotDraft =
    snapshotRecord.draft && typeof snapshotRecord.draft === 'object'
      ? (snapshotRecord.draft as SaleDraft)
      : null;
  if (!snapshotDraft) return null;

  const draftIdFromRecord = typeof source.draftId === 'string' ? source.draftId.trim() : '';
  const draftIdFromSnapshot = typeof snapshotDraft.id === 'string' ? snapshotDraft.id.trim() : '';
  const draftId = draftIdFromRecord || draftIdFromSnapshot;
  if (!draftId) return null;

  const id =
    typeof source.id === 'string' && source.id.trim()
      ? source.id.trim()
      : createClientId('paid-sync-job');
  const confirmCommandId =
    typeof source.confirmCommandId === 'string' && source.confirmCommandId.trim()
      ? source.confirmCommandId.trim()
      : createClientId('cmd');
  const finalizeCommandId =
    typeof source.finalizeCommandId === 'string' && source.finalizeCommandId.trim()
      ? source.finalizeCommandId.trim()
      : createClientId('cmd');
  const attemptsRaw = Number(source.attempts);
  const attempts = Number.isFinite(attemptsRaw) && attemptsRaw >= 0 ? Math.floor(attemptsRaw) : 0;
  const createdAt =
    typeof source.createdAt === 'string' && !Number.isNaN(Date.parse(source.createdAt))
      ? source.createdAt
      : new Date().toISOString();
  const nextAttemptAt =
    typeof source.nextAttemptAt === 'string' && !Number.isNaN(Date.parse(source.nextAttemptAt))
      ? source.nextAttemptAt
      : undefined;
  const lastError = typeof source.lastError === 'string' ? source.lastError : undefined;

  const snapshot: PaymentCommitSnapshot = clonePaymentCommitSnapshot({
    draft: {
      ...snapshotDraft,
      id: draftId,
    },
    paymentMethod: (snapshotRecord.paymentMethod || 'PIX') as SalePaymentMethod,
    saleOrigin: (snapshotRecord.saleOrigin || 'LOCAL') as SaleOrigin,
    appOrderTotalInput:
      typeof snapshotRecord.appOrderTotalInput === 'string' ? snapshotRecord.appOrderTotalInput : '',
    cashReceivedInput:
      typeof snapshotRecord.cashReceivedInput === 'string' ? snapshotRecord.cashReceivedInput : '',
    splitMode: (snapshotRecord.splitMode || null) as SalePaymentSplitMode | null,
    splitCount:
      Number.isFinite(Number(snapshotRecord.splitCount)) && Number(snapshotRecord.splitCount) > 0
        ? Math.floor(Number(snapshotRecord.splitCount))
        : null,
    splitCommitted: Array.isArray(snapshotRecord.splitCommitted)
      ? snapshotRecord.splitCommitted.map((entry) => ({ ...(entry as SalePaymentSplitEntry) }))
      : [],
    effectivePaymentTotal: roundMoney(
      Number.isFinite(Number(snapshotRecord.effectivePaymentTotal))
        ? Number(snapshotRecord.effectivePaymentTotal)
        : Number(snapshotDraft.total) || 0
    ),
  });

  return {
    id,
    draftId,
    snapshot,
    finalizeCommandId,
    confirmCommandId,
    createdAt,
    attempts,
    nextAttemptAt,
    lastError,
  };
};

const loadPendingPaidSyncQueue = (): PendingPaidSyncJob[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PENDING_PAID_SYNC_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizePendingPaidSyncJob(entry))
      .filter((entry): entry is PendingPaidSyncJob => entry !== null);
  } catch {
    return [];
  }
};

const savePendingPaidSyncQueue = (queue: PendingPaidSyncJob[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PENDING_PAID_SYNC_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // ignore storage write failures
  }
};

const loadFailedPaidSyncQueue = (): PendingPaidSyncJob[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FAILED_PAID_SYNC_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizePendingPaidSyncJob(entry))
      .filter((entry): entry is PendingPaidSyncJob => entry !== null);
  } catch {
    return [];
  }
};

const saveFailedPaidSyncQueue = (queue: PendingPaidSyncJob[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FAILED_PAID_SYNC_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // ignore storage write failures
  }
};

const PENDING_PAID_SYNC_RETRY_BASE_MS = 5000;
const PENDING_PAID_SYNC_RETRY_MAX_MS = 15 * 60 * 1000;
const PENDING_PAID_SYNC_RETRY_JITTER = 0.2;
const PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_DELAY_MS = 1800;
const PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_MAX_ATTEMPTS = 5;
const PAID_SYNC_ASSISTANT_STATUS_TTL_MS = 2800;
const PAID_SYNC_QUEUE_PREVIEW_LIMIT = 6;
const PENDING_DRAFT_BACKGROUND_SYNC_DEBOUNCE_MS = 650;
const PENDING_DRAFT_BACKGROUND_SYNC_SWEEP_MS = 10000;
const PENDING_DRAFT_BACKGROUND_SYNC_RETRY_BASE_MS = 1800;
const PENDING_DRAFT_BACKGROUND_SYNC_RETRY_MAX_MS = 45000;
const PENDING_DRAFT_BACKGROUND_SYNC_RETRY_JITTER = 0.2;

const getPendingPaidSyncJobNextAttemptAtMs = (job: PendingPaidSyncJob): number => {
  if (!job.nextAttemptAt) return Number.NaN;
  return Date.parse(job.nextAttemptAt);
};

const isPendingPaidSyncJobReady = (job: PendingPaidSyncJob, nowMs = Date.now()): boolean => {
  const retryAtMs = getPendingPaidSyncJobNextAttemptAtMs(job);
  return !Number.isFinite(retryAtMs) || retryAtMs <= nowMs;
};

const getPendingPaidSyncRetryDelayMs = (attempts: number): number => {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  const exponentialDelay =
    PENDING_PAID_SYNC_RETRY_BASE_MS * 2 ** Math.max(0, safeAttempts - 1);
  const cappedDelay = Math.min(PENDING_PAID_SYNC_RETRY_MAX_MS, exponentialDelay);
  const jitterFactor =
    1 + (Math.random() * 2 - 1) * PENDING_PAID_SYNC_RETRY_JITTER;
  return Math.max(
    PENDING_PAID_SYNC_RETRY_BASE_MS,
    Math.round(cappedDelay * jitterFactor)
  );
};

const getPendingDraftBackgroundSyncRetryDelayMs = (attempts: number): number => {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  const exponentialDelay =
    PENDING_DRAFT_BACKGROUND_SYNC_RETRY_BASE_MS * 2 ** Math.max(0, safeAttempts - 1);
  const cappedDelay = Math.min(PENDING_DRAFT_BACKGROUND_SYNC_RETRY_MAX_MS, exponentialDelay);
  const jitterFactor =
    1 + (Math.random() * 2 - 1) * PENDING_DRAFT_BACKGROUND_SYNC_RETRY_JITTER;
  return Math.max(
    PENDING_DRAFT_BACKGROUND_SYNC_RETRY_BASE_MS,
    Math.round(cappedDelay * jitterFactor)
  );
};

const App: React.FC = () => {
  const [view, setView] = useState<ViewMode>(ViewMode.POS);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAccessVerified, setIsAccessVerified] = useState(false);
  const [isStateHydrating, setIsStateHydrating] = useState(true);
  const [pendingStateOps, setPendingStateOps] = useState(0);
  const [pendingOfflineSales, setPendingOfflineSales] = useState(0);
  const [pendingPaidSyncJobs, setPendingPaidSyncJobs] = useState(0);
  const [hasPendingVersionUpdate, setHasPendingVersionUpdate] = useState(false);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const offlineSalesQueueRef = useRef<OfflineQueuedSale[]>([]);
  const pendingPaidSyncQueueRef = useRef<PendingPaidSyncJob[]>([]);
  const failedPaidSyncQueueRef = useRef<PendingPaidSyncJob[]>([]);
  const pendingDraftAddsRef = useRef<PendingDraftAddsByDraftId>({});
  const syncingPaidDraftIdsRef = useRef<Set<string>>(new Set());
  const isPendingDraftAddsHydratedRef = useRef(false);
  const isPendingPaidSyncQueueHydratedRef = useRef(false);
  const isFailedPaidSyncQueueHydratedRef = useRef(false);
  const isPendingPaidSyncQueueRunningRef = useRef(false);
  const isFlushingOfflineSalesRef = useRef(false);
  const isOfflineQueueHydratedRef = useRef(false);
  const pendingVersionDetectedAtRef = useRef<number | null>(null);
  const isAutoReloadingRef = useRef(false);
  const pendingPaidSyncRetryTimerRef = useRef<number | null>(null);
  const failedPaidSyncAutoRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  const failedPaidSyncAutoRetryTimersRef = useRef<Map<string, number>>(new Map());
  const failedPaidSyncAutoRecoverTimersRef = useRef<Map<string, number>>(new Map());
  const paidSyncAssistantStatusTimeoutRef = useRef<number | null>(null);
  const activeDraftIdRef = useRef<string | null>(null);
  const saleDraftsRef = useRef<SaleDraft[]>(DEFAULT_APP_STATE.saleDrafts);
  const pendingDraftCreationRef = useRef<Promise<string | null> | null>(null);
  const pendingDraftFlushQueueRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const pendingDraftBackgroundSyncTimerRef = useRef<Map<string, number>>(new Map());
  const pendingDraftBackgroundSyncRunningRef = useRef<Set<string>>(new Set());
  const pendingDraftBackgroundRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  
  const [ingredients, setIngredients] = useState<Ingredient[]>(DEFAULT_APP_STATE.ingredients);
  const [products, setProducts] = useState<Product[]>(DEFAULT_APP_STATE.products);
  const [sales, setSales] = useState<Sale[]>(DEFAULT_APP_STATE.sales);
  const [stockEntries, setStockEntries] = useState<StockEntry[]>(DEFAULT_APP_STATE.stockEntries);
  const [cleaningMaterials, setCleaningMaterials] = useState<CleaningMaterial[]>(
    DEFAULT_APP_STATE.cleaningMaterials
  );
  const [cleaningStockEntries, setCleaningStockEntries] = useState<CleaningStockEntry[]>(
    DEFAULT_APP_STATE.cleaningStockEntries
  );
  
  const [globalSales, setGlobalSales] = useState<Sale[]>(DEFAULT_APP_STATE.globalSales);
  const [globalCancelledSales, setGlobalCancelledSales] = useState<Sale[]>(DEFAULT_APP_STATE.globalCancelledSales);
  const [globalStockEntries, setGlobalStockEntries] = useState<StockEntry[]>(DEFAULT_APP_STATE.globalStockEntries);
  const [globalCleaningStockEntries, setGlobalCleaningStockEntries] = useState<CleaningStockEntry[]>(
    DEFAULT_APP_STATE.globalCleaningStockEntries
  );
  const [saleDrafts, setSaleDrafts] = useState<SaleDraft[]>(DEFAULT_APP_STATE.saleDrafts);
  const [isCashHistoryLegacyMode, setIsCashHistoryLegacyMode] = useState<boolean>(() =>
    readCashHistoryLegacyMode()
  );
  const isCashHistoryLegacyModeRef = useRef<boolean>(readCashHistoryLegacyMode());
  const [cashRegisterAmount, setCashRegisterAmount] = useState<number>(DEFAULT_APP_STATE.cashRegisterAmount);
  const [dailySalesHistory, setDailySalesHistory] = useState<DailySalesHistoryEntry[]>(
    DEFAULT_APP_STATE.dailySalesHistory
  );
  const [pendingDraftAddsByDraft, setPendingDraftAddsByDraft] =
    useState<PendingDraftAddsByDraftId>({});
  const [syncingPaidDraftIds, setSyncingPaidDraftIds] = useState<string[]>([]);
  const [pendingPaidSyncQueueSnapshot, setPendingPaidSyncQueueSnapshot] = useState<PendingPaidSyncJob[]>([]);
  const [failedPaidSyncQueue, setFailedPaidSyncQueue] = useState<PendingPaidSyncJob[]>([]);
  const [failedPaidSyncAutoRetryRevision, setFailedPaidSyncAutoRetryRevision] = useState(0);
  const [paidSyncAssistantState, setPaidSyncAssistantState] = useState<PaidSyncAssistantState>({
    mode: 'idle',
    message: '',
    active: false,
    draftId: null,
    jobId: null,
    updatedAt: Date.now(),
  });
  
  const [isAddProductModalOpen, setIsAddProductModalOpen] = useState(false);
  const [isAddIngredientModalOpen, setIsAddIngredientModalOpen] = useState(false);
  const [ingredientToEdit, setIngredientToEdit] = useState<Ingredient | null>(null);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);
  const [notification, setNotification] = useState<{ isVisible: boolean; message: string }>({
    isVisible: false,
    message: '',
  });
  const [isUndoHistoryOpen, setIsUndoHistoryOpen] = useState(false);
  const [receiptPrintSettingsOpen, setReceiptPrintSettingsOpen] = useState(false);
  const [receiptPrintPresetId, setReceiptPrintPresetId] = useState<string>(() => readReceiptPrintPresetId());
  const [expandedUndoGroupId, setExpandedUndoGroupId] = useState<string | null>(null);
  const [isUndoProcessing, setIsUndoProcessing] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isCancellingDraft, setIsCancellingDraft] = useState(false);
  const [isConfirmingPaid, setIsConfirmingPaid] = useState(false);
  const [cartBumpTick, setCartBumpTick] = useState(-1);
  const [cartEntryFx, setCartEntryFx] = useState<{ id: number; label: string } | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<SalePaymentMethod>('PIX');
  const [paymentMethodBeforeSplitSetup, setPaymentMethodBeforeSplitSetup] =
    useState<SaleBasePaymentMethod>('PIX');
  const [saleOrigin, setSaleOrigin] = useState<SaleOrigin>('LOCAL');
  const [paymentOriginFxTick, setPaymentOriginFxTick] = useState(-1);
  const [appOrderTotalInput, setAppOrderTotalInput] = useState('');
  const [cashReceivedInput, setCashReceivedInput] = useState('');
  const [isSaleOriginSetupOpen, setIsSaleOriginSetupOpen] = useState(false);
  const [isSplitSetupOpen, setIsSplitSetupOpen] = useState(false);
  const [splitMode, setSplitMode] = useState<SalePaymentSplitMode | null>(null);
  const [splitCount, setSplitCount] = useState<number | null>(null);
  const [splitAutoAllocations, setSplitAutoAllocations] = useState<number[]>([]);
  const [splitCommitted, setSplitCommitted] = useState<SalePaymentSplitEntry[]>([]);
  const [splitCurrentIndex, setSplitCurrentIndex] = useState(0);
  const [splitCurrentMethod, setSplitCurrentMethod] = useState<SaleBasePaymentMethod>('PIX');
  const [splitCurrentAmountInput, setSplitCurrentAmountInput] = useState('');
  const [splitCurrentCashReceivedInput, setSplitCurrentCashReceivedInput] = useState('');
  const [cornerSyncState, setCornerSyncState] = useState<CornerSyncState>({
    visible: false,
    status: 'idle',
    message: '',
  });
  const cartEntryFxTimeoutRef = useRef<number | null>(null);
  const cornerSyncTimeoutRef = useRef<number | null>(null);
  const appOrderTotalInputRef = useRef<HTMLInputElement | null>(null);
  const splitCurrentAmountInputRef = useRef<HTMLInputElement | null>(null);
  const selectedReceiptPrintPreset = useMemo(
    () => getReceiptPrintPresetById(receiptPrintPresetId),
    [receiptPrintPresetId]
  );
  const canAutoReloadNow = useMemo(
    () =>
      isAccessVerified &&
      !isStateHydrating &&
      pendingStateOps === 0 &&
      pendingOfflineSales === 0 &&
      pendingPaidSyncJobs === 0 &&
      syncingPaidDraftIds.length === 0 &&
      !isConfirmingPaid &&
      !isUndoProcessing &&
      !isPaymentOpen &&
      !isSplitSetupOpen &&
      !isCartOpen &&
      !isCancellingDraft,
    [
      isAccessVerified,
      isCartOpen,
      isCancellingDraft,
      isConfirmingPaid,
      isPaymentOpen,
      isSplitSetupOpen,
      isStateHydrating,
      isUndoProcessing,
      pendingOfflineSales,
      pendingPaidSyncJobs,
      pendingStateOps,
      syncingPaidDraftIds,
    ]
  );

  const performSilentAutoReload = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (isAutoReloadingRef.current) return;
    isAutoReloadingRef.current = true;
    try {
      window.sessionStorage.setItem(
        AUTO_UPDATE_SCROLL_STATE_KEY,
        JSON.stringify({
          x: window.scrollX,
          y: window.scrollY,
          at: Date.now(),
        })
      );
    } catch {
      // ignore storage write failures
    }
    window.location.reload();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem(AUTO_UPDATE_SCROLL_STATE_KEY);
      if (!raw) return;
      window.sessionStorage.removeItem(AUTO_UPDATE_SCROLL_STATE_KEY);
      const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown; at?: unknown };
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      const at = Number(parsed.at);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (Number.isFinite(at) && Date.now() - at > 30_000) return;
      window.requestAnimationFrame(() => {
        window.scrollTo(x, y);
      });
    } catch {
      // ignore restore failures
    }
  }, []);

  useEffect(() => {
    if (!isAccessVerified) return;
    if (import.meta.env.DEV) return;
    if (hasPendingVersionUpdate) return;

    let cancelled = false;

    const checkForPublishedUpdate = async () => {
      if (cancelled || isAutoReloadingRef.current) return;
      const currentEntrypoint = readCurrentEntrypointPath();
      if (!currentEntrypoint) return;

      try {
        const response = await fetch(buildUpdateCheckIndexUrl(), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!response.ok) return;
        const html = await response.text();
        const latestEntrypoint = readEntrypointPathFromHtml(html);
        if (!latestEntrypoint || latestEntrypoint === currentEntrypoint) return;
        pendingVersionDetectedAtRef.current = Date.now();
        setHasPendingVersionUpdate(true);
      } catch {
        // ignore temporary network/proxy failures
      }
    };

    void checkForPublishedUpdate();
    const intervalId = window.setInterval(() => {
      void checkForPublishedUpdate();
    }, AUTO_UPDATE_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [hasPendingVersionUpdate, isAccessVerified]);

  useEffect(() => {
    if (!hasPendingVersionUpdate) return;

    const tryReloadIfSafe = () => {
      if (!canAutoReloadNow || isAutoReloadingRef.current) return;
      const detectedAt = pendingVersionDetectedAtRef.current;
      const forceReload =
        typeof detectedAt === 'number' &&
        Date.now() - detectedAt >= AUTO_UPDATE_FORCE_RELOAD_AFTER_MS;
      if (document.visibilityState === 'hidden' || forceReload) {
        performSilentAutoReload();
      }
    };

    tryReloadIfSafe();
    const intervalId = window.setInterval(tryReloadIfSafe, 10_000);
    document.addEventListener('visibilitychange', tryReloadIfSafe);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', tryReloadIfSafe);
    };
  }, [canAutoReloadNow, hasPendingVersionUpdate, performSilentAutoReload]);

  useEffect(() => {
    isCashHistoryLegacyModeRef.current = isCashHistoryLegacyMode;
  }, [isCashHistoryLegacyMode]);

  useEffect(() => {
    writeReceiptPrintPresetId(receiptPrintPresetId);
  }, [receiptPrintPresetId]);

  useEffect(() => {
    if (isUndoHistoryOpen) return;
    setReceiptPrintSettingsOpen(false);
  }, [isUndoHistoryOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setIsAccessVerified(true);
      return;
    }

    const hasSessionPortalAccess = window.sessionStorage.getItem(ADMIN_GATE_KEY) === 'authenticated';
    const hasPersistentPortalAccess = window.localStorage.getItem(ADMIN_GATE_KEY) === 'authenticated';

    if (hasPersistentPortalAccess && !hasSessionPortalAccess) {
      window.sessionStorage.setItem(ADMIN_GATE_KEY, 'authenticated');
    }

    if (hasSessionPortalAccess && !hasPersistentPortalAccess) {
      window.localStorage.setItem(ADMIN_GATE_KEY, 'authenticated');
    }

    if (!hasSessionPortalAccess && !hasPersistentPortalAccess) {
      window.location.replace(resolveSiteRootUrl());
      return;
    }

    setIsAccessVerified(true);
  }, []);

  useEffect(() => {
    if (!isAccessVerified) return;
    const session = loadAdminSessionBarrier();
    if (!session) return;
    setIsAdminAuthenticated(true);
    persistAdminSessionBarrier({
      ...session,
      lastHeartbeatAt: Date.now(),
    });
  }, [isAccessVerified]);

  useEffect(() => {
    if (!isAccessVerified) return;
    if (!isAdminAuthenticated) return;

    const reinforce = () => {
      reinforceAdminSessionBarrier();
    };

    reinforce();

    const heartbeatId = window.setInterval(reinforce, 15000);
    const handleStorage = (event: StorageEvent) => {
      if (!event.key) return;
      if (
        event.key !== ADMIN_SESSION_KEY &&
        event.key !== ADMIN_SESSION_BACKUP_KEY &&
        event.key !== ADMIN_GATE_KEY
      ) {
        return;
      }

      // Self-healing only if another context removed a barrier key.
      if (event.newValue === null) {
        reinforce();
      }
    };
    const handleVisibility = () => {
      if (!document.hidden) reinforce();
    };

    window.addEventListener('focus', reinforce);
    window.addEventListener('pageshow', reinforce);
    window.addEventListener('storage', handleStorage);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.clearInterval(heartbeatId);
      window.removeEventListener('focus', reinforce);
      window.removeEventListener('pageshow', reinforce);
      window.removeEventListener('storage', handleStorage);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isAccessVerified, isAdminAuthenticated]);

  const applyCashHistorySnapshot = useCallback(
    (state: AppState) => {
      if (isCashHistoryLegacyModeRef.current) {
        setCashRegisterAmount(readLocalCashRegisterAmount());
        setDailySalesHistory(readLocalDailySalesHistory());
        return;
      }

      const normalizedCashRegisterAmount = roundMoney(
        Math.max(0, state.cashRegisterAmount)
      );
      const normalizedHistory = normalizeDailyHistoryList(state.dailySalesHistory);

      setCashRegisterAmount(normalizedCashRegisterAmount);
      setDailySalesHistory(normalizedHistory);
      writeLocalCashRegisterAmount(normalizedCashRegisterAmount);
      writeLocalDailySalesHistory(normalizedHistory);
      writeCashHistoryLegacyMode(false);
    },
    []
  );

  useEffect(() => {
    if (!isAccessVerified) return;

    let cancelled = false;
    setIsStateHydrating(true);
    loadAppState(DEFAULT_APP_STATE)
      .then((state) => {
        if (cancelled) return;
        setIngredients(normalizeIngredientsStockList(state.ingredients));
        setProducts(state.products);
        setSales(state.sales);
        setStockEntries(state.stockEntries);
        setCleaningMaterials(normalizeCleaningMaterialsStockList(state.cleaningMaterials));
        setCleaningStockEntries(state.cleaningStockEntries);
        setGlobalSales(state.globalSales);
        setGlobalCancelledSales(state.globalCancelledSales);
        setGlobalStockEntries(state.globalStockEntries);
        setGlobalCleaningStockEntries(state.globalCleaningStockEntries);
        saleDraftsRef.current = state.saleDrafts;
        setSaleDrafts(state.saleDrafts);
        applyCashHistorySnapshot(state);
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        setIsStateHydrating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [applyCashHistorySnapshot, isAccessVerified]);

  useEffect(() => {
    if (!isAccessVerified) return;
    void warmupStateWriteContext();
  }, [isAccessVerified]);

  const showNotification = useCallback((message: string) => {
    setNotification({ isVisible: true, message });
  }, []);

  const enableCashHistoryLegacyMode = useCallback(() => {
    writeCashHistoryLegacyMode(true);
    setIsCashHistoryLegacyMode(true);
    setCashRegisterAmount(readLocalCashRegisterAmount());
    setDailySalesHistory(readLocalDailySalesHistory());
  }, []);

  const showCornerSync = useCallback(
    (
      status: 'syncing' | 'success' | 'error',
      message: string,
      autoHideMs?: number
    ): void => {
      if (cornerSyncTimeoutRef.current !== null) {
        window.clearTimeout(cornerSyncTimeoutRef.current);
        cornerSyncTimeoutRef.current = null;
      }
      setCornerSyncState({ visible: true, status, message });
      if (!autoHideMs || autoHideMs <= 0) return;
      cornerSyncTimeoutRef.current = window.setTimeout(() => {
        setCornerSyncState({ visible: false, status: 'idle', message: '' });
        cornerSyncTimeoutRef.current = null;
      }, autoHideMs);
    },
    []
  );

  const setPaidSyncAssistantActivity = useCallback(
    (
      mode: Exclude<PaidSyncAssistantMode, 'idle'>,
      message: string,
      context?: {
        draftId?: string | null;
        jobId?: string | null;
      }
    ): void => {
      if (paidSyncAssistantStatusTimeoutRef.current !== null) {
        window.clearTimeout(paidSyncAssistantStatusTimeoutRef.current);
        paidSyncAssistantStatusTimeoutRef.current = null;
      }
      setPaidSyncAssistantState({
        mode,
        message,
        active: true,
        draftId: context?.draftId ?? null,
        jobId: context?.jobId ?? null,
        updatedAt: Date.now(),
      });
      paidSyncAssistantStatusTimeoutRef.current = window.setTimeout(() => {
        setPaidSyncAssistantState((current) => ({
          ...current,
          mode: 'idle',
          active: false,
          message: '',
          updatedAt: Date.now(),
        }));
        paidSyncAssistantStatusTimeoutRef.current = null;
      }, PAID_SYNC_ASSISTANT_STATUS_TTL_MS);
    },
    []
  );

  const setDraftSyncInProgress = useCallback((draftId: string, isSyncing: boolean) => {
    const nextSet = new Set(syncingPaidDraftIdsRef.current);
    if (isSyncing) {
      nextSet.add(draftId);
    } else {
      nextSet.delete(draftId);
    }
    syncingPaidDraftIdsRef.current = nextSet;
    setSyncingPaidDraftIds(Array.from(nextSet));
  }, []);

  useEffect(() => {
    return () => {
      if (cartEntryFxTimeoutRef.current !== null) {
        window.clearTimeout(cartEntryFxTimeoutRef.current);
      }
      if (cornerSyncTimeoutRef.current !== null) {
        window.clearTimeout(cornerSyncTimeoutRef.current);
      }
      if (pendingPaidSyncRetryTimerRef.current !== null) {
        window.clearTimeout(pendingPaidSyncRetryTimerRef.current);
      }
      if (paidSyncAssistantStatusTimeoutRef.current !== null) {
        window.clearTimeout(paidSyncAssistantStatusTimeoutRef.current);
      }
      failedPaidSyncAutoRetryTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      failedPaidSyncAutoRecoverTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      failedPaidSyncAutoRetryTimersRef.current.clear();
      failedPaidSyncAutoRecoverTimersRef.current.clear();
      failedPaidSyncAutoRetryAttemptsRef.current.clear();
      pendingDraftBackgroundSyncTimerRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      pendingDraftBackgroundSyncTimerRef.current.clear();
      pendingDraftBackgroundRetryAttemptsRef.current.clear();
      pendingDraftBackgroundSyncRunningRef.current.clear();
      pendingDraftFlushQueueRef.current.clear();
    };
  }, []);

  const replacePendingDraftAdds = useCallback((nextPendingAdds: PendingDraftAddsByDraftId) => {
    const normalized: PendingDraftAddsByDraftId = {};
    Object.entries(nextPendingAdds).forEach(([draftId, entries]) => {
      if (!Array.isArray(entries) || entries.length === 0) return;
      const safeEntries = entries
        .map((entry) => normalizePendingDraftAdd(entry))
        .filter((entry): entry is PendingDraftAdd => entry !== null);
      if (safeEntries.length > 0) {
        normalized[draftId] = safeEntries;
      }
    });

    pendingDraftAddsRef.current = normalized;
    setPendingDraftAddsByDraft(normalized);
    savePendingDraftAdds(normalized);
    isPendingDraftAddsHydratedRef.current = true;
  }, []);

  const hydratePendingDraftAdds = useCallback(() => {
    if (isPendingDraftAddsHydratedRef.current) return;
    const loadedPendingAdds = loadPendingDraftAdds();
    pendingDraftAddsRef.current = loadedPendingAdds;
    setPendingDraftAddsByDraft(loadedPendingAdds);
    isPendingDraftAddsHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!isAccessVerified) return;
    hydratePendingDraftAdds();
  }, [hydratePendingDraftAdds, isAccessVerified]);

  const replacePendingPaidSyncQueue = useCallback(
    (nextQueue: PendingPaidSyncJob[]) => {
      const normalizedQueue = nextQueue
        .map((entry) => normalizePendingPaidSyncJob(entry))
        .filter((entry): entry is PendingPaidSyncJob => entry !== null);
      pendingPaidSyncQueueRef.current = normalizedQueue;
      setPendingPaidSyncJobs(normalizedQueue.length);
      setPendingPaidSyncQueueSnapshot(normalizedQueue);
      savePendingPaidSyncQueue(normalizedQueue);
      isPendingPaidSyncQueueHydratedRef.current = true;
    },
    []
  );

  const hydratePendingPaidSyncQueue = useCallback(() => {
    if (isPendingPaidSyncQueueHydratedRef.current) return;
    const loadedQueue = loadPendingPaidSyncQueue();
    pendingPaidSyncQueueRef.current = loadedQueue;
    setPendingPaidSyncJobs(loadedQueue.length);
    setPendingPaidSyncQueueSnapshot(loadedQueue);
    loadedQueue.forEach((job) => {
      setDraftSyncInProgress(job.draftId, true);
    });
    isPendingPaidSyncQueueHydratedRef.current = true;
  }, [setDraftSyncInProgress]);

  useEffect(() => {
    if (!isAccessVerified) return;
    hydratePendingPaidSyncQueue();
  }, [hydratePendingPaidSyncQueue, isAccessVerified]);

  const replaceFailedPaidSyncQueue = useCallback((nextQueue: PendingPaidSyncJob[]) => {
    const normalizedQueue = nextQueue
      .map((entry) => normalizePendingPaidSyncJob(entry))
      .filter((entry): entry is PendingPaidSyncJob => entry !== null);
    failedPaidSyncQueueRef.current = normalizedQueue;
    setFailedPaidSyncQueue(normalizedQueue);
    saveFailedPaidSyncQueue(normalizedQueue);
    isFailedPaidSyncQueueHydratedRef.current = true;
  }, []);

  const hydrateFailedPaidSyncQueue = useCallback(() => {
    if (isFailedPaidSyncQueueHydratedRef.current) return;
    const loadedQueue = loadFailedPaidSyncQueue();
    failedPaidSyncQueueRef.current = loadedQueue;
    setFailedPaidSyncQueue(loadedQueue);
    isFailedPaidSyncQueueHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!isAccessVerified) return;
    hydrateFailedPaidSyncQueue();
  }, [hydrateFailedPaidSyncQueue, isAccessVerified]);

  const replaceOfflineSalesQueue = useCallback((nextQueue: OfflineQueuedSale[]) => {
    offlineSalesQueueRef.current = nextQueue;
    setPendingOfflineSales(nextQueue.length);
    saveOfflineSaleQueue(nextQueue);
    isOfflineQueueHydratedRef.current = true;
  }, []);

  const hydrateOfflineSalesQueue = useCallback(() => {
    if (isOfflineQueueHydratedRef.current) return;
    const loadedQueue = loadOfflineSaleQueue();
    offlineSalesQueueRef.current = loadedQueue;
    setPendingOfflineSales(loadedQueue.length);
    isOfflineQueueHydratedRef.current = true;
  }, []);

  const queueOfflineSale = useCallback(
    (command: SaleRegisterCommand, errorMessage: string) => {
      hydrateOfflineSalesQueue();
      const dedupeKey = command.clientSaleId || command.commandId;
      const alreadyQueued = offlineSalesQueueRef.current.some((item) => {
        const queuedKey = item.command.clientSaleId || item.command.commandId;
        return Boolean(dedupeKey && queuedKey && dedupeKey === queuedKey);
      });

      if (!alreadyQueued) {
        replaceOfflineSalesQueue([
          ...offlineSalesQueueRef.current,
          {
            command,
            queuedAt: new Date().toISOString(),
            attempts: 0,
            lastError: errorMessage,
          },
        ]);
      }
    },
    [hydrateOfflineSalesQueue, replaceOfflineSalesQueue]
  );

  useEffect(() => {
    hydrateOfflineSalesQueue();
  }, [hydrateOfflineSalesQueue]);

  const applyStateSnapshot = useCallback((state: AppState) => {
    setIngredients(normalizeIngredientsStockList(state.ingredients));
    setProducts(state.products);
    setSales(state.sales);
    setStockEntries(state.stockEntries);
    setCleaningMaterials(normalizeCleaningMaterialsStockList(state.cleaningMaterials));
    setCleaningStockEntries(state.cleaningStockEntries);
    setGlobalSales(state.globalSales);
    setGlobalCancelledSales(state.globalCancelledSales);
    setGlobalStockEntries(state.globalStockEntries);
    setGlobalCleaningStockEntries(state.globalCleaningStockEntries);
    saleDraftsRef.current = state.saleDrafts;
    setSaleDrafts(state.saleDrafts);
    applyCashHistorySnapshot(state);
  }, [applyCashHistorySnapshot]);

  const executeSyncedCommand = useCallback(
    async (
      command: StateCommand,
      options: { trackPendingState?: boolean; failFastOnVersionConflict?: boolean } = {}
    ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
      const shouldTrackPendingState = options.trackPendingState !== false;
      if (shouldTrackPendingState) {
        setPendingStateOps((current) => current + 1);
      }

      const executeCommand = async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
        try {
          const nextState = await runStateCommand(command, {
            failFastOnVersionConflict: options.failFastOnVersionConflict,
          });
          applyStateSnapshot(nextState);
          return { ok: true };
        } catch (error) {
          return { ok: false, error };
        } finally {
          if (shouldTrackPendingState) {
            setPendingStateOps((current) => Math.max(0, current - 1));
          }
        }
      };

      const scheduledExecution = commandQueueRef.current.then(
        () => executeCommand(),
        () => executeCommand()
      );

      commandQueueRef.current = scheduledExecution.then(
        () => undefined,
        () => undefined
      );

      return scheduledExecution;
    },
    [applyStateSnapshot]
  );

  const runCommandWithSync = useCallback(
    async (
      command: StateCommand,
      successMessage?: string,
      options: RunCommandOptions = {}
    ): Promise<boolean> => {
      const normalizedCommand = isSaleRegisterCommand(command)
        ? ensureSaleCommandIdentifiers(command)
        : command;
      const result = await executeSyncedCommand(normalizedCommand, {
        trackPendingState: options.trackPendingState,
        failFastOnVersionConflict: options.failFastOnVersionConflict,
      });

      if (result.ok) {
        updateRunCommandErrorSink(options.errorSink, {
          error: undefined,
          message: undefined,
          retryable: undefined,
          statusCode: undefined,
        });
        if (successMessage && !options.silentSuccessNotification) {
          showNotification(successMessage);
        }
        return true;
      }

      const message = getStateSyncErrorMessage(result.error);
      const retryable = isRetryableSyncError(result.error);
      const statusCode =
        result.error instanceof StateCommandSyncError ? result.error.statusCode : undefined;
      updateRunCommandErrorSink(options.errorSink, {
        error: result.error,
        message,
        retryable,
        statusCode,
      });
      reportErrorMonitorEvent({
        source: 'sistema:command-sync',
        level: retryable ? 'warn' : 'error',
        message,
        statusCode,
        stack: result.error instanceof Error ? result.error.stack : undefined,
        context: toCommandSyncErrorContext(normalizedCommand),
      });
      const shouldQueueOfflineSale =
        !options.skipOfflineQueue &&
        isSaleRegisterCommand(normalizedCommand) &&
        retryable;

      if (shouldQueueOfflineSale) {
        queueOfflineSale(normalizedCommand, message);
        if (!options.silentErrorNotification) {
          showNotification(
            `Sem internet. Venda guardada no navegador (${offlineSalesQueueRef.current.length} pendente(s)).`
          );
        }
        return true;
      }

      if (!options.silentErrorNotification) {
        showNotification(message);
      }
      return false;
    },
    [executeSyncedCommand, queueOfflineSale]
  );

  const flushOfflineSalesQueue = useCallback(async (): Promise<void> => {
    hydrateOfflineSalesQueue();
    if (isStateHydrating) return;
    if (isFlushingOfflineSalesRef.current) return;
    if (offlineSalesQueueRef.current.length === 0) return;

    isFlushingOfflineSalesRef.current = true;
    let syncedCount = 0;

    try {
      while (offlineSalesQueueRef.current.length > 0) {
        const current = offlineSalesQueueRef.current[0];
        const result = await executeSyncedCommand(current.command);

        if (result.ok) {
          syncedCount += 1;
          replaceOfflineSalesQueue(offlineSalesQueueRef.current.slice(1));
          continue;
        }

        const errorMessage = getStateSyncErrorMessage(result.error);
        if (isRetryableSyncError(result.error)) {
          const updatedHead: OfflineQueuedSale = {
            ...current,
            attempts: current.attempts + 1,
            lastError: errorMessage,
          };
          replaceOfflineSalesQueue([
            updatedHead,
            ...offlineSalesQueueRef.current.slice(1),
          ]);
          break;
        }

        const failedProductName =
          products.find((product) => product.id === current.command.productId)?.name ||
          current.command.productId;
        showNotification(
          `Falha permanente ao sincronizar venda pendente (${failedProductName}). Removida da fila.`
        );
        replaceOfflineSalesQueue(offlineSalesQueueRef.current.slice(1));
      }
    } finally {
      isFlushingOfflineSalesRef.current = false;
      if (syncedCount > 0) {
        showNotification(`${syncedCount} venda(s) offline sincronizada(s).`);
      }
    }
  }, [executeSyncedCommand, hydrateOfflineSalesQueue, isStateHydrating, products, replaceOfflineSalesQueue]);

  useEffect(() => {
    if (!isAccessVerified || isStateHydrating) return;
    if (offlineSalesQueueRef.current.length === 0) return;
    void flushOfflineSalesQueue();
  }, [isAccessVerified, isStateHydrating, pendingOfflineSales, flushOfflineSalesQueue]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      void flushOfflineSalesQueue();
    };

    window.addEventListener('online', handleOnline);
    const intervalId = window.setInterval(() => {
      if (offlineSalesQueueRef.current.length === 0) return;
      void flushOfflineSalesQueue();
    }, 12000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearInterval(intervalId);
    };
  }, [flushOfflineSalesQueue]);

  const totalPendingOps = pendingStateOps + pendingOfflineSales;
  const isSyncIndicatorVisible = isStateHydrating;
  const syncIndicatorMessage = isStateHydrating
    ? 'Carregando dados do servidor...'
    : pendingStateOps > 0
      ? 'Aguardando resposta do banco/API...'
      : pendingOfflineSales > 0
        ? `Sem internet estável. ${pendingOfflineSales} venda(s) aguardando envio.`
        : 'Sistema sincronizado.';

  const handleAdminLogin = useCallback((success: boolean) => {
    if (!success) return;
    reinforceAdminSessionBarrier();
    setIsAdminAuthenticated(true);
  }, []);

  useEffect(() => {
    if (!isAccessVerified) return;
    if (isStateHydrating) return;
    if (!isPendingDraftAddsHydratedRef.current) return;
    const knownPersistedDraftIds = new Set<string>();
    [...sales, ...globalSales, ...globalCancelledSales].forEach((entry) => {
      const saleDraftId =
        typeof entry.saleDraftId === 'string' ? entry.saleDraftId.trim() : '';
      if (saleDraftId) {
        knownPersistedDraftIds.add(saleDraftId);
      }
    });
    const staleDraftIds = Object.keys(pendingDraftAddsRef.current).filter((draftId) => {
      if (knownPersistedDraftIds.has(draftId)) {
        return true;
      }
      const serverDraft = saleDrafts.find((entry) => entry.id === draftId);
      // Keep local-only pending carts until they are explicitly flushed/removed.
      if (!serverDraft) return false;
      return serverDraft.status !== 'DRAFT' && serverDraft.status !== 'PENDING_PAYMENT';
    });
    if (staleDraftIds.length === 0) return;
    const next = { ...pendingDraftAddsRef.current };
    staleDraftIds.forEach((draftId) => {
      delete next[draftId];
    });
    replacePendingDraftAdds(next);
  }, [
    globalCancelledSales,
    globalSales,
    isAccessVerified,
    isStateHydrating,
    replacePendingDraftAdds,
    saleDrafts,
    sales,
  ]);

  const saleDraftsWithPendingAdds = useMemo(() => {
    const buildPendingItems = (pendingAdds: PendingDraftAdd[]) =>
      pendingAdds.map((entry) => {
        const product = products.find((candidate) => candidate.id === entry.productId);
        const unitPrice =
          Number.isFinite(entry.priceOverride) && entry.priceOverride !== undefined
            ? entry.priceOverride
            : Number(product?.price) || 0;
        return {
          id: entry.localItemId,
          productId: entry.productId,
          nameSnapshot: product?.name || entry.productId,
          qty: entry.quantity,
          unitPriceSnapshot: unitPrice,
          note: entry.note,
          recipe: entry.recipeOverride || product?.recipe || [],
        };
      });

    const mergeDraft = (draft: SaleDraft, pendingAdds: PendingDraftAdd[]): SaleDraft => {
      if (!pendingAdds || pendingAdds.length === 0) return draft;
      const pendingItems = buildPendingItems(pendingAdds);
      const pendingTotal = roundMoney(
        pendingItems.reduce(
          (sum, item) => sum + (Number(item.unitPriceSnapshot) || 0) * (Number(item.qty) || 0),
          0
        )
      );

      return {
        ...draft,
        items: [...draft.items, ...pendingItems],
        total: roundMoney(draft.total + pendingTotal),
      };
    };

    const mergedServerDrafts = saleDrafts.map((draft) =>
      mergeDraft(draft, pendingDraftAddsByDraft[draft.id] || [])
    );

    const serverDraftIds = new Set(saleDrafts.map((draft) => draft.id));
    const knownPersistedDraftIds = new Set<string>();
    [...sales, ...globalSales, ...globalCancelledSales].forEach((entry) => {
      const saleDraftId =
        typeof entry.saleDraftId === 'string' ? entry.saleDraftId.trim() : '';
      if (saleDraftId) {
        knownPersistedDraftIds.add(saleDraftId);
      }
    });
    const pendingOnlyDrafts = (Object.entries(
      pendingDraftAddsByDraft
    ) as Array<[string, PendingDraftAdd[]]>)
      .filter(
        ([draftId, entries]) =>
          entries.length > 0 &&
          !serverDraftIds.has(draftId) &&
          !knownPersistedDraftIds.has(draftId)
      )
      .map(([draftId, entries]) => {
        const pendingItems = buildPendingItems(entries);
        const total = roundMoney(
          pendingItems.reduce(
            (sum, item) => sum + (Number(item.unitPriceSnapshot) || 0) * (Number(item.qty) || 0),
            0
          )
        );
        const firstQueuedAt = entries[0]?.queuedAt || new Date().toISOString();
        const lastQueuedAt = entries[entries.length - 1]?.queuedAt || firstQueuedAt;

        const virtualDraft: SaleDraft = {
          id: draftId,
          createdAt: firstQueuedAt,
          updatedAt: lastQueuedAt,
          items: pendingItems,
          total,
          customerType: 'BALCAO',
          saleOrigin: 'LOCAL',
          appOrderTotal: null,
          status: 'DRAFT',
          payment: {
            method: null,
            cashReceived: null,
            change: null,
            confirmedAt: null,
            splitMode: null,
            splitCount: null,
            splitPayments: [],
          },
          stockDebited: false,
        };
        return virtualDraft;
      });

    return [...mergedServerDrafts, ...pendingOnlyDrafts];
  }, [globalCancelledSales, globalSales, pendingDraftAddsByDraft, products, saleDrafts, sales]);

  const reservedDraftStockByIngredient = useMemo(() => {
    const reservedByIngredient = new Map<string, number>();
    const ingredientById = new Map<string, Ingredient>(
      ingredients.map((ingredient): [string, Ingredient] => [ingredient.id, ingredient])
    );

    saleDraftsWithPendingAdds.forEach((draft) => {
      if (draft.status !== 'DRAFT' && draft.status !== 'PENDING_PAYMENT') return;

      draft.items.forEach((item) => {
        const itemQty = Number(item.qty);
        if (!Number.isFinite(itemQty) || itemQty <= 0) return;

        const recipeTotals = aggregateRecipe(item.recipe || []);
        (Object.entries(recipeTotals) as Array<[string, number]>).forEach(
          ([ingredientId, recipeQuantity]) => {
          const ingredient = ingredientById.get(ingredientId);
          if (!ingredient) return;

          const stockPerUnit = getStockQuantityFromRecipeQuantity(ingredient, recipeQuantity);
          if (!Number.isFinite(stockPerUnit) || stockPerUnit <= 0) return;

          const stockRequired = Number((stockPerUnit * itemQty).toFixed(6));
          if (!Number.isFinite(stockRequired) || stockRequired <= 0) return;

          const currentReserved = reservedByIngredient.get(ingredientId) || 0;
          reservedByIngredient.set(
            ingredientId,
            Number((currentReserved + stockRequired).toFixed(6))
          );
        }
        );
      });
    });

    return reservedByIngredient;
  }, [ingredients, saleDraftsWithPendingAdds]);

  const ingredientsForSale = useMemo<Ingredient[]>(
    () =>
      ingredients.map((ingredient) => {
        const reservedQuantity = reservedDraftStockByIngredient.get(ingredient.id) || 0;
        if (reservedQuantity <= 0) return ingredient;

        const effectiveCurrentStock = Number(
          (Number(ingredient.currentStock || 0) - reservedQuantity).toFixed(6)
        );
        return {
          ...ingredient,
          currentStock: effectiveCurrentStock > 0 ? effectiveCurrentStock : 0,
        };
      }),
    [ingredients, reservedDraftStockByIngredient]
  );

  const saleIngredientById = useMemo(
    () =>
      new Map<string, Ingredient>(
        ingredientsForSale.map((ingredient): [string, Ingredient] => [ingredient.id, ingredient])
      ),
    [ingredientsForSale]
  );

  const resolveDraftItemStockIssue = useCallback(
    (
      recipe: RecipeItem[] | undefined,
      quantityDelta: number
    ): { ingredient: Ingredient; required: number; available: number } | null => {
      const normalizedDelta = Math.max(0, Math.round(Number(quantityDelta) || 0));
      if (normalizedDelta <= 0) return null;

      const recipeTotals = aggregateRecipe(recipe || []);
      for (const [ingredientId, recipeQuantity] of Object.entries(
        recipeTotals
      ) as Array<[string, number]>) {
        const ingredient = saleIngredientById.get(ingredientId);
        if (!ingredient) continue;

        const stockPerUnit = getStockQuantityFromRecipeQuantity(ingredient, recipeQuantity);
        if (!Number.isFinite(stockPerUnit) || stockPerUnit <= 0) continue;

        const required = Number((stockPerUnit * normalizedDelta).toFixed(6));
        const available = Number(ingredient.currentStock) || 0;
        if (available + Number.EPSILON >= required) continue;

        return {
          ingredient,
          required,
          available,
        };
      }

      return null;
    },
    [saleIngredientById]
  );

  const notifyDraftItemStockIssue = useCallback(
    (
      productName: string,
      issue: { ingredient: Ingredient; required: number; available: number }
    ): void => {
      const requiredLabel = `${formatIngredientStockQuantity(issue.ingredient, issue.required)} ${
        issue.ingredient.unit
      }`;
      const availableLabel = `${formatIngredientStockQuantity(issue.ingredient, issue.available)} ${
        issue.ingredient.unit
      }`;
      showNotification(
        `Estoque insuficiente em ${issue.ingredient.name}. ${productName} precisa ${requiredLabel} e há ${availableLabel}.`
      );
    },
    [showNotification]
  );

  const openSaleDrafts = useMemo(
    () => {
      const queuedDraftIds = new Set<string>();
      syncingPaidDraftIds.forEach((draftId) => {
        if (typeof draftId === 'string' && draftId.trim()) {
          queuedDraftIds.add(draftId.trim());
        }
      });
      pendingPaidSyncQueueSnapshot.forEach((job) => {
        if (typeof job.draftId === 'string' && job.draftId.trim()) {
          queuedDraftIds.add(job.draftId.trim());
        }
      });
      failedPaidSyncQueue.forEach((job) => {
        if (typeof job.draftId === 'string' && job.draftId.trim()) {
          queuedDraftIds.add(job.draftId.trim());
        }
      });

      return saleDraftsWithPendingAdds.filter((draft) => {
        if (queuedDraftIds.has(draft.id)) return false;
        if (draft.status !== 'DRAFT' && draft.status !== 'PENDING_PAYMENT') return false;
        const pendingLocalItemsCount = (pendingDraftAddsByDraft[draft.id] || []).length;
        return draft.items.length > 0 || pendingLocalItemsCount > 0;
      });
    },
    [
      failedPaidSyncQueue,
      pendingDraftAddsByDraft,
      pendingPaidSyncQueueSnapshot,
      saleDraftsWithPendingAdds,
      syncingPaidDraftIds,
    ]
  );
  useEffect(() => {
    activeDraftIdRef.current = activeDraftId;
  }, [activeDraftId]);
  useEffect(() => {
    saleDraftsRef.current = saleDrafts;
  }, [saleDrafts]);
  const activeDraft = useMemo(() => {
    if (activeDraftId) {
      const selected = openSaleDrafts.find((draft) => draft.id === activeDraftId);
      if (selected) return selected;
    }
    return openSaleDrafts[0] || null;
  }, [activeDraftId, openSaleDrafts]);
  const activeDraftItemCount = useMemo(
    () => activeDraft?.items.reduce((sum, item) => sum + item.qty, 0) || 0,
    [activeDraft]
  );
  const activeDraftApiLinkedItemCount = useMemo(
    () =>
      activeDraft?.items.filter((item) => !isLocalPendingDraftItemId(item.id)).length || 0,
    [activeDraft]
  );
  const activeDraftLocalPendingItemCount = useMemo(
    () =>
      activeDraft?.items.filter((item) => isLocalPendingDraftItemId(item.id)).length || 0,
    [activeDraft]
  );

  useEffect(() => {
    if (activeDraftId && activeDraft?.id === activeDraftId) return;
    const nextDraftId = activeDraft?.id || null;
    if (nextDraftId !== activeDraftId) {
      setActiveDraftId(nextDraftId);
    }
  }, [activeDraft, activeDraftId]);

  const resolveEditableDraftId = useCallback((): string | null => {
    const isDraftQueuedForPaidSync = (draftId: string): boolean => {
      if (syncingPaidDraftIdsRef.current.has(draftId)) return true;
      if (pendingPaidSyncQueueRef.current.some((job) => job.draftId === draftId)) return true;
      if (failedPaidSyncQueueRef.current.some((job) => job.draftId === draftId)) return true;
      return false;
    };

    const serverOpenDrafts = saleDraftsRef.current.filter(
      (draft) =>
        (draft.status === 'DRAFT' || draft.status === 'PENDING_PAYMENT') &&
        draft.items.length > 0 &&
        !isDraftQueuedForPaidSync(draft.id)
    );
    const pendingLocalDraftIds = Object.keys(pendingDraftAddsRef.current).filter((draftId) => {
      if (isDraftQueuedForPaidSync(draftId)) return false;
      const hasPendingEntries = (pendingDraftAddsRef.current[draftId] || []).length > 0;
      if (!hasPendingEntries) return false;
      return !serverOpenDrafts.some((draft) => draft.id === draftId);
    });

    const selectedServerDraft = activeDraftIdRef.current
      ? serverOpenDrafts.find((draft) => draft.id === activeDraftIdRef.current)
      : null;
    if (selectedServerDraft?.status === 'DRAFT') {
      return selectedServerDraft.id;
    }

    if (
      activeDraftIdRef.current &&
      pendingLocalDraftIds.includes(activeDraftIdRef.current)
    ) {
      return activeDraftIdRef.current;
    }

    const fallbackServerDraft = serverOpenDrafts.find((draft) => draft.status === 'DRAFT');
    if (fallbackServerDraft) {
      activeDraftIdRef.current = fallbackServerDraft.id;
      setActiveDraftId(fallbackServerDraft.id);
      return fallbackServerDraft.id;
    }

    const fallbackPendingLocalDraftId = pendingLocalDraftIds[0] || null;
    if (fallbackPendingLocalDraftId) {
      activeDraftIdRef.current = fallbackPendingLocalDraftId;
      setActiveDraftId(fallbackPendingLocalDraftId);
      return fallbackPendingLocalDraftId;
    }

    return null;
  }, []);

  const ensureActiveDraft = useCallback(
    async (customerType: SaleCustomerType = 'BALCAO'): Promise<string | null> => {
      const existingDraftId = resolveEditableDraftId();
      if (existingDraftId) {
        return existingDraftId;
      }

      if (pendingDraftCreationRef.current) {
        return pendingDraftCreationRef.current;
      }

      const draftId = createClientId('draft');
      const creationPromise = (async () => {
        const created = await runCommandWithSync(
          {
            type: 'SALE_DRAFT_CREATE',
            draftId,
            customerType,
          },
          undefined,
          { silentSuccessNotification: true }
        );

        if (!created) return null;
        activeDraftIdRef.current = draftId;
        setActiveDraftId(draftId);
        return draftId;
      })().finally(() => {
        pendingDraftCreationRef.current = null;
      });

      pendingDraftCreationRef.current = creationPromise;
      return creationPromise;
    },
    [resolveEditableDraftId, runCommandWithSync]
  );

  const handleCreateNewDraft = (customerType: SaleCustomerType) => {
    void (async () => {
      const draftId = createClientId('draft');
      const ok = await runCommandWithSync(
        {
          type: 'SALE_DRAFT_CREATE',
          draftId,
          customerType,
        },
        undefined,
        { silentSuccessNotification: true }
      );
      if (!ok) return;

      activeDraftIdRef.current = draftId;
      setActiveDraftId(draftId);
      setIsCartOpen(true);
      setIsPaymentOpen(false);
      setPaymentMethod('PIX');
      setPaymentMethodBeforeSplitSetup('PIX');
      setSaleOrigin('LOCAL');
      setAppOrderTotalInput('');
      setCashReceivedInput('');
      resetSplitPaymentState();
      showNotification(`Nova venda ${customerType === 'ENTREGA' ? 'de entrega' : 'de balcão'} aberta.`);
    })();
  };

  const triggerCartEntryEffect = useCallback((productName: string) => {
    const cleanName = productName.trim();
    const label = cleanName.length > 22 ? `${cleanName.slice(0, 22)}...` : cleanName || 'Item';
    const fxId = Date.now();

    setCartBumpTick((current) => current + 1);
    setCartEntryFx({ id: fxId, label });

    if (cartEntryFxTimeoutRef.current !== null) {
      window.clearTimeout(cartEntryFxTimeoutRef.current);
    }

    cartEntryFxTimeoutRef.current = window.setTimeout(() => {
      setCartEntryFx((current) => (current?.id === fxId ? null : current));
    }, 900);
  }, []);

  const updatePendingDraftAddsForDraft = useCallback(
    (
      draftId: string,
      updater: (current: PendingDraftAdd[]) => PendingDraftAdd[]
    ) => {
      hydratePendingDraftAdds();
      const currentEntries = pendingDraftAddsRef.current[draftId] || [];
      const nextEntries = updater(currentEntries);
      const nextPendingByDraft: PendingDraftAddsByDraftId = {
        ...pendingDraftAddsRef.current,
      };
      if (nextEntries.length > 0) {
        nextPendingByDraft[draftId] = nextEntries;
      } else {
        delete nextPendingByDraft[draftId];
      }
      replacePendingDraftAdds(nextPendingByDraft);
    },
    [hydratePendingDraftAdds, replacePendingDraftAdds]
  );

  const queuePendingDraftAdd = useCallback(
    (
      draftId: string,
      product: Product,
      recipeOverride?: RecipeItem[],
      priceOverride?: number
    ): boolean => {
      const ingredientIdSet = new Set<string>(
        ingredientsForSale.map((ingredient) => ingredient.id)
      );
      const recipeValidation = validateDraftItemRecipe(
        product,
        recipeOverride ?? product.recipe,
        ingredientIdSet
      );
      if (recipeValidation.ok === false) {
        showNotification(recipeValidation.message);
        return false;
      }

      const normalizedRecipe = recipeValidation.recipe;
      const stockIssue = resolveDraftItemStockIssue(normalizedRecipe, 1);
      if (stockIssue) {
        notifyDraftItemStockIssue(product.name, stockIssue);
        return false;
      }

      const normalizedPriceOverrideRaw = Number(priceOverride);
      const normalizedPriceOverride =
        Number.isFinite(normalizedPriceOverrideRaw) && normalizedPriceOverrideRaw >= 0
          ? roundMoney(normalizedPriceOverrideRaw)
          : undefined;
      const recipeSignature = normalizeRecipeSignature(normalizedRecipe);

      updatePendingDraftAddsForDraft(draftId, (current) => {
        const existingIndex = current.findIndex(
          (entry) =>
            entry.productId === product.id &&
            entry.note === undefined &&
            normalizeRecipeSignature(entry.recipeOverride) === recipeSignature &&
            entry.priceOverride === normalizedPriceOverride
        );

        if (existingIndex >= 0) {
          const next = [...current];
          const currentQty = Number(next[existingIndex].quantity) || 0;
          next[existingIndex] = {
            ...next[existingIndex],
            quantity: Math.max(1, currentQty + 1),
          };
          return next;
        }

        return [
          ...current,
          {
            draftId,
            localItemId: createClientId('draft-item-local'),
            commandId: createClientId('cmd'),
            productId: product.id,
            quantity: 1,
            recipeOverride: normalizedRecipe,
            priceOverride: normalizedPriceOverride,
            queuedAt: new Date().toISOString(),
          },
        ];
      });

      return true;
    },
    [
      ingredientsForSale,
      notifyDraftItemStockIssue,
      resolveDraftItemStockIssue,
      showNotification,
      updatePendingDraftAddsForDraft,
    ]
  );

  const updatePendingDraftAddByItemId = useCallback(
    (
      draftId: string,
      itemId: string,
      updater: (entry: PendingDraftAdd) => PendingDraftAdd | null
    ): boolean => {
      let found = false;
      updatePendingDraftAddsForDraft(draftId, (current) => {
        const index = current.findIndex((entry) => entry.localItemId === itemId);
        if (index < 0) return current;
        found = true;
        const next = [...current];
        const updated = updater(next[index]);
        if (!updated || updated.quantity <= 0) {
          next.splice(index, 1);
          return next;
        }
        next[index] = {
          ...updated,
          quantity: Math.max(1, Math.round(updated.quantity)),
        };
        return next;
      });
      return found;
    },
    [updatePendingDraftAddsForDraft]
  );

  const handleOpenCart = () => {
    const draftId = resolveEditableDraftId();
    if (draftId) {
      activeDraftIdRef.current = draftId;
      setActiveDraftId(draftId);
    }
    setIsCartOpen(true);
  };

  const handleSale = useCallback((product: Product, recipeOverride?: RecipeItem[], priceOverride?: number) => {
    void (async () => {
      let draftId = resolveEditableDraftId();
      if (!draftId) {
        draftId = createClientId('draft');
        activeDraftIdRef.current = draftId;
        setActiveDraftId(draftId);
      }

      const queued = queuePendingDraftAdd(draftId, product, recipeOverride, priceOverride);
      if (!queued) return;

      showNotification(`${product.name} adicionado ao carrinho!`);
      triggerCartEntryEffect(product.name);
    })();
  }, [queuePendingDraftAdd, resolveEditableDraftId, showNotification, triggerCartEntryEffect]);

  const handleUpdateDraftCustomerType = (customerType: SaleCustomerType) => {
    if (!activeDraft) return;
    void runCommandWithSync(
      {
        type: 'SALE_DRAFT_SET_CUSTOMER_TYPE',
        draftId: activeDraft.id,
        customerType,
      },
      undefined,
      { silentSuccessNotification: true }
    );
  };

  const handleUpdateDraftItemQuantity = (itemId: string, nextQty: number) => {
    if (!activeDraft) return;
    if (activeDraft.status !== 'DRAFT') {
      showNotification('Edite os itens apenas com a venda em DRAFT.');
      return;
    }

    const targetQty = Math.max(0, Math.round(nextQty));
    const currentItem = activeDraft.items.find((entry) => entry.id === itemId);
    if (!currentItem) return;

    if (targetQty > currentItem.qty) {
      const stockIssue = resolveDraftItemStockIssue(currentItem.recipe, targetQty - currentItem.qty);
      if (stockIssue) {
        notifyDraftItemStockIssue(currentItem.nameSnapshot || currentItem.productId, stockIssue);
        return;
      }
    }

    const handledPending = updatePendingDraftAddByItemId(activeDraft.id, itemId, (entry) => {
      if (targetQty <= 0) return null;
      return {
        ...entry,
        quantity: Math.max(1, targetQty),
      };
    });
    if (handledPending) {
      return;
    }

    if (targetQty <= 0) {
      void runCommandWithSync(
        {
          type: 'SALE_DRAFT_REMOVE_ITEM',
          draftId: activeDraft.id,
          itemId,
        },
        undefined,
        { silentSuccessNotification: true }
      );
      return;
    }

    void runCommandWithSync(
      {
        type: 'SALE_DRAFT_UPDATE_ITEM',
        draftId: activeDraft.id,
        itemId,
        quantity: targetQty,
      },
      undefined,
      { silentSuccessNotification: true }
    );
  };

  const handleUpdateDraftItemNote = (itemId: string, note: string) => {
    if (!activeDraft || activeDraft.status !== 'DRAFT') return;
    const normalizedNote = note.trim();
    const handledPending = updatePendingDraftAddByItemId(activeDraft.id, itemId, (entry) => ({
      ...entry,
      note: normalizedNote || undefined,
    }));
    if (handledPending) {
      return;
    }
    void runCommandWithSync(
      {
        type: 'SALE_DRAFT_UPDATE_ITEM',
        draftId: activeDraft.id,
        itemId,
        note: normalizedNote,
      },
      undefined,
      { silentSuccessNotification: true }
    );
  };

  const handleCancelActiveDraft = () => {
    if (!activeDraft || isCancellingDraft) return;
    if (!confirm('Cancelar esta venda antes do pagamento? Nenhum estoque será debitado.')) return;
    const draftId = activeDraft.id;
    const serverDraft = saleDraftsRef.current.find((draft) => draft.id === draftId) || null;
    const hasServerDraft = saleDraftsRef.current.some((draft) => draft.id === draftId);
    const hasPendingLocalAdds = (pendingDraftAddsRef.current[draftId] || []).length > 0;
    if (!hasServerDraft) {
      const nextPendingByDraft = { ...pendingDraftAddsRef.current };
      delete nextPendingByDraft[draftId];
      replacePendingDraftAdds(nextPendingByDraft);
      if (activeDraftIdRef.current === draftId) {
        activeDraftIdRef.current = null;
      }
      setActiveDraftId(null);
      setIsSaleOriginSetupOpen(false);
      setIsPaymentOpen(false);
      setIsCartOpen(false);
      showNotification('Venda cancelada.');
      return;
    }

    if (serverDraft && serverDraft.items.length === 0) {
      if (hasPendingLocalAdds) {
        const nextPendingByDraft = { ...pendingDraftAddsRef.current };
        delete nextPendingByDraft[draftId];
        replacePendingDraftAdds(nextPendingByDraft);
      }
      if (activeDraftIdRef.current === draftId) {
        activeDraftIdRef.current = null;
      }
      setActiveDraftId(null);
      setIsSaleOriginSetupOpen(false);
      setIsPaymentOpen(false);
      setIsCartOpen(false);
      showNotification('Venda cancelada.');
      return;
    }

    void (async () => {
      setIsCancellingDraft(true);
      try {
        const ok = await runCommandWithSync(
          {
            type: 'SALE_DRAFT_CANCEL',
            draftId,
          },
          'Venda cancelada.',
          { trackPendingState: false }
        );
        if (!ok) return;

        if (pendingDraftAddsRef.current[draftId]?.length) {
          const nextPendingByDraft = { ...pendingDraftAddsRef.current };
          delete nextPendingByDraft[draftId];
          replacePendingDraftAdds(nextPendingByDraft);
        }

        if (activeDraftIdRef.current === draftId) {
          activeDraftIdRef.current = null;
        }
        setActiveDraftId(null);
        setIsSaleOriginSetupOpen(false);
        setIsPaymentOpen(false);
        setIsCartOpen(false);
      } finally {
        setIsCancellingDraft(false);
      }
    })();
  };

  const handleClearApiLinkedDraftItems = useCallback(() => {
    if (!activeDraft) return;
    if (activeDraft.status !== 'DRAFT' && activeDraft.status !== 'PENDING_PAYMENT') {
      showNotification('Limpeza disponível apenas com a venda em DRAFT ou PENDING_PAYMENT.');
      return;
    }

    if (activeDraft.status === 'PENDING_PAYMENT') {
      const confirmed = confirm(
        'Este carrinho está em PENDING_PAYMENT. Para limpar itens do banco, a venda será cancelada. Deseja continuar?'
      );
      if (!confirmed) return;
      handleCancelActiveDraft();
      return;
    }

    const apiLinkedItems = activeDraft.items.filter(
      (item) => !isLocalPendingDraftItemId(item.id)
    );
    if (apiLinkedItems.length === 0) {
      showNotification('Nenhum item vinculado ao banco para limpar.');
      return;
    }

    const confirmed = confirm(
      apiLinkedItems.length === 1
        ? 'Limpar o item já sincronizado com o banco deste carrinho?'
        : `Limpar ${apiLinkedItems.length} item(ns) já sincronizado(s) com o banco deste carrinho?`
    );
    if (!confirmed) return;

    void (async () => {
      for (const item of apiLinkedItems) {
        const ok = await runCommandWithSync(
          {
            type: 'SALE_DRAFT_REMOVE_ITEM',
            draftId: activeDraft.id,
            itemId: item.id,
          },
          undefined,
          {
            silentSuccessNotification: true,
            trackPendingState: false,
          }
        );
        if (!ok) {
          showNotification('Falha ao limpar itens vinculados ao banco.');
          return;
        }
      }

      showNotification(
        apiLinkedItems.length === 1
          ? '1 item do banco removido do carrinho.'
          : `${apiLinkedItems.length} itens do banco removidos do carrinho.`
      );
    })();
  }, [activeDraft, handleCancelActiveDraft, runCommandWithSync, showNotification]);

  const handleClearLocalPendingDraftItems = useCallback(() => {
    if (!activeDraft) return;
    if (activeDraft.status !== 'DRAFT' && activeDraft.status !== 'PENDING_PAYMENT') {
      showNotification('Limpeza disponível apenas com a venda em DRAFT ou PENDING_PAYMENT.');
      return;
    }

    const pendingLocalItems = pendingDraftAddsRef.current[activeDraft.id] || [];
    if (pendingLocalItems.length === 0) {
      showNotification('Nenhum item pendente local para limpar.');
      return;
    }

    const confirmed = confirm(
      pendingLocalItems.length === 1
        ? 'Limpar o item pendente local deste carrinho?'
        : `Limpar ${pendingLocalItems.length} item(ns) pendente(s) local(is) deste carrinho?`
    );
    if (!confirmed) return;

    const nextPendingByDraft = { ...pendingDraftAddsRef.current };
    delete nextPendingByDraft[activeDraft.id];
    replacePendingDraftAdds(nextPendingByDraft);

    showNotification(
      pendingLocalItems.length === 1
        ? '1 item pendente local removido do carrinho.'
        : `${pendingLocalItems.length} itens pendentes locais removidos do carrinho.`
    );
  }, [activeDraft, replacePendingDraftAdds, showNotification]);

  const resetSplitPaymentState = () => {
    setIsSplitSetupOpen(false);
    setSplitMode(null);
    setSplitCount(null);
    setSplitAutoAllocations([]);
    setSplitCommitted([]);
    setSplitCurrentIndex(0);
    setSplitCurrentMethod('PIX');
    setSplitCurrentAmountInput('');
    setSplitCurrentCashReceivedInput('');
  };

  const initializeSplitPaymentFlow = (
    amountDue: number,
    committedEntries: SalePaymentSplitEntry[] = []
  ) => {
    const normalizedAmountDue = roundMoney(Math.max(0, amountDue));
    const remainingAmount = roundMoney(
      Math.max(0, normalizedAmountDue - sumSplitAmounts(committedEntries))
    );
    setSplitMode('MIXED');
    setSplitCount(1);
    setSplitAutoAllocations([]);
    setSplitCommitted(committedEntries);
    setSplitCurrentIndex(committedEntries.length);
    setSplitCurrentMethod('PIX');
    setSplitCurrentCashReceivedInput('');
    setSplitCurrentAmountInput(remainingAmount > 0 ? String(remainingAmount) : '');
  };

  const hydrateSplitPaymentFromDraft = (draft: SaleDraft, amountDue: number) => {
    const payment = draft.payment;
    if (payment.method !== 'DIVIDIDO') {
      resetSplitPaymentState();
      return;
    }

    const normalizedSplits = (payment.splitPayments || [])
      .filter((entry): entry is SalePaymentSplitEntry => BASE_PAYMENT_METHODS.includes(entry.method))
      .map((entry, index) => {
        const amount = Number(entry.amount);
        const safeAmount = Number.isFinite(amount) && amount > 0 ? roundMoney(amount) : 0;
        const cashReceived =
          entry.method === 'DINHEIRO' && Number.isFinite(Number(entry.cashReceived))
            ? roundMoney(Number(entry.cashReceived))
            : null;
        const change =
          entry.method === 'DINHEIRO' && Number.isFinite(Number(entry.change))
            ? roundMoney(Number(entry.change))
            : cashReceived !== null
              ? roundMoney(cashReceived - safeAmount)
              : null;
        return {
          sequence: index + 1,
          label: entry.label?.trim() || `Parcela ${index + 1}`,
          method: entry.method,
          amount: safeAmount,
          cashReceived,
          change,
        };
      });

    initializeSplitPaymentFlow(amountDue, normalizedSplits);
  };

  const openSplitSetupModal = () => {
    const isStartingSplitNow = paymentMethod !== 'DIVIDIDO';
    if (isStartingSplitNow) {
      setPaymentMethodBeforeSplitSetup(paymentMethod);
      initializeSplitPaymentFlow(effectivePaymentTotal, []);
    } else {
      initializeSplitPaymentFlow(effectivePaymentTotal, splitCommitted);
    }
    setPaymentMethod('DIVIDIDO');
    setIsSplitSetupOpen(true);
  };

  const handleAbortSplitMethod = () => {
    if (splitCommitted.length > 0) {
      const confirmed = confirm('Sair do dividido e limpar os pagamentos lançados?');
      if (!confirmed) return;
    }
    setPaymentMethod(paymentMethodBeforeSplitSetup);
    resetSplitPaymentState();
  };

  const handleRedoSplitFlow = () => {
    if (paymentMethod !== 'DIVIDIDO') return;
    if (splitCommitted.length > 0) {
      const confirmed = confirm('Refazer a divisão e apagar os pagamentos lançados?');
      if (!confirmed) return;
    }
    initializeSplitPaymentFlow(effectivePaymentTotal, []);
    setIsSplitSetupOpen(true);
  };

  const handleOpenPayment = () => {
    if (!activeDraft) {
      showNotification('Abra um carrinho antes de finalizar.');
      return;
    }
    if (activeDraft.items.length === 0) {
      showNotification('Carrinho vazio. Adicione itens antes de finalizar.');
      return;
    }
    if (activeDraft.status === 'CANCELLED' || activeDraft.status === 'PAID') {
      showNotification('Esta venda já está encerrada.');
      return;
    }

    const nextMethod = activeDraft.payment.method || 'PIX';
    const nextOrigin = activeDraft.saleOrigin || 'LOCAL';
    const amountDue = resolveDraftExpectedPaymentTotal(activeDraft, nextOrigin);
    setPaymentMethod(nextMethod);
    if (nextMethod !== 'DIVIDIDO') {
      setPaymentMethodBeforeSplitSetup(nextMethod);
    } else {
      const firstLegacySplitMethod = activeDraft.payment.splitPayments?.find((entry) =>
        BASE_PAYMENT_METHODS.includes(entry.method)
      )?.method;
      setPaymentMethodBeforeSplitSetup(firstLegacySplitMethod ?? 'PIX');
    }
    setPaymentOriginFxTick(-1);
    setSaleOrigin(nextOrigin);
    setAppOrderTotalInput(
      isAppSaleOrigin(nextOrigin)
        ? String(activeDraft.appOrderTotal ?? activeDraft.total)
        : ''
    );
    setCashReceivedInput(
      activeDraft.payment.cashReceived !== null && activeDraft.payment.cashReceived !== undefined
        ? String(activeDraft.payment.cashReceived)
        : ''
    );
    if (nextMethod === 'DIVIDIDO') {
      hydrateSplitPaymentFromDraft(activeDraft, amountDue);
    } else {
      resetSplitPaymentState();
    }
    setIsSaleOriginSetupOpen(false);
    setIsPaymentOpen(true);
  };

  const closeAppSaleOriginPanel = useCallback(() => {
    setSaleOrigin('LOCAL');
    setAppOrderTotalInput('');
    setPaymentOriginFxTick((tick) => tick + 1);
  }, []);

  const handleToggleAppSaleOrigin = useCallback(
    (origin: Extract<SaleOrigin, 'IFOOD' | 'APP99' | 'KEETA'>) => {
      if (!activeDraft) return;

      if (isSameSaleOrigin(saleOrigin, origin)) {
        closeAppSaleOriginPanel();
        return;
      }

      const persistedOriginValue =
        activeDraft.saleOrigin === origin && Number(activeDraft.appOrderTotal) > 0
          ? Number(activeDraft.appOrderTotal)
          : undefined;
      const typedValue = parseMoneyInput(appOrderTotalInput);
      const fallbackValue = typedValue && typedValue > 0 ? typedValue : activeDraft.total;
      setSaleOrigin(origin);
      setAppOrderTotalInput(String(persistedOriginValue ?? fallbackValue));
      setPaymentOriginFxTick((tick) => tick + 1);
    },
    [activeDraft, appOrderTotalInput, closeAppSaleOriginPanel, saleOrigin]
  );

  const handleSelectAppSaleOrigin = useCallback(
    (origin: Extract<SaleOrigin, 'IFOOD' | 'APP99' | 'KEETA'>) => {
      if (!isSameSaleOrigin(saleOrigin, origin)) {
        handleToggleAppSaleOrigin(origin);
      }
      setIsSaleOriginSetupOpen(false);
    },
    [handleToggleAppSaleOrigin, saleOrigin]
  );

  const handleResetSplitPlan = () => {
    initializeSplitPaymentFlow(effectivePaymentTotal, []);
  };

  const handleRemoveLastSplit = () => {
    if (splitCommitted.length === 0) return;
    const nextCommitted = splitCommitted.slice(0, -1);
    setSplitCommitted(nextCommitted);
    setSplitCurrentMethod('PIX');
    setSplitCurrentCashReceivedInput('');

    setSplitCurrentIndex(nextCommitted.length);
    const remaining = roundMoney(Math.max(0, effectivePaymentTotal - sumSplitAmounts(nextCommitted)));
    setSplitCurrentAmountInput(remaining > 0 ? String(remaining) : '');
  };

  const handleCommitSplitStep = () => {
    if (!splitMode || !splitCount) {
      showNotification('Abra o dividido para lançar os pagamentos.');
      return;
    }

    const sequence = splitCommitted.length + 1;
    const amount = roundMoney(parseMoneyInput(splitCurrentAmountInput) || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      showNotification('Informe um valor válido para a parcela.');
      return;
    }

    const remainingBefore = roundMoney(Math.max(0, effectivePaymentTotal - sumSplitAmounts(splitCommitted)));
    if (splitCommitted.length === 0 && amount >= remainingBefore - 0.009) {
      showNotification('No dividido, o primeiro valor deve ser menor que o total para permitir a segunda forma.');
      return;
    }

    if (amount > remainingBefore + 0.009) {
      showNotification('O valor da parcela não pode ser maior que o restante da venda.');
      return;
    }

    const cashReceived =
      splitCurrentMethod === 'DINHEIRO' ? parseMoneyInput(splitCurrentCashReceivedInput) : null;
    if (splitCurrentMethod === 'DINHEIRO' && (cashReceived === null || cashReceived < amount)) {
      showNotification('No dinheiro, o valor recebido deve ser maior ou igual ao valor da parcela.');
      return;
    }

    const nextEntry: SalePaymentSplitEntry = {
      sequence,
      label: `Parcela ${sequence}`,
      method: splitCurrentMethod,
      amount,
      cashReceived: splitCurrentMethod === 'DINHEIRO' ? roundMoney(cashReceived || 0) : null,
      change: splitCurrentMethod === 'DINHEIRO' ? roundMoney((cashReceived || 0) - amount) : null,
    };

    const nextCommitted = [...splitCommitted, nextEntry];
    setSplitCommitted(nextCommitted);
    setSplitCurrentIndex(nextCommitted.length);
    setSplitCurrentMethod('PIX');
    setSplitCurrentCashReceivedInput('');

    const remainingAfter = roundMoney(Math.max(0, effectivePaymentTotal - sumSplitAmounts(nextCommitted)));
    setSplitCurrentAmountInput(remainingAfter > 0 ? String(remainingAfter) : '');
    if (remainingAfter <= 0.009 && nextCommitted.length >= 2) {
      setIsSplitSetupOpen(false);
      showNotification('Dividido concluído. Agora confirme o pagamento.');
    }
  };

  const flushPendingDraftAddsCore = useCallback(
    async (
      draftId: string,
      customerType: SaleCustomerType = 'BALCAO',
      options: {
        silentErrorNotification?: boolean;
        errorSink?: RunCommandErrorSink;
        failFastOnVersionConflict?: boolean;
      } = {}
    ): Promise<boolean> => {
      hydratePendingDraftAdds();

      const hasServerDraft = saleDraftsRef.current.some((draft) => draft.id === draftId);
      if (!hasServerDraft) {
        const created = await runCommandWithSync(
          {
            type: 'SALE_DRAFT_CREATE',
            draftId,
            customerType,
          },
          undefined,
          {
            silentSuccessNotification: true,
            silentErrorNotification: options.silentErrorNotification,
            errorSink: options.errorSink,
            trackPendingState: false,
            failFastOnVersionConflict: options.failFastOnVersionConflict,
          }
        );
        if (!created) return false;
      }

      while (true) {
        const currentPendingAdds = pendingDraftAddsRef.current[draftId] || [];
        if (currentPendingAdds.length === 0) {
          return true;
        }

        const current = currentPendingAdds[0];
        const product = products.find((entry) => entry.id === current.productId) || null;
        const ingredientIdSet = new Set<string>(
          ingredients.map((ingredient) => ingredient.id)
        );
        const recipeValidation = validateDraftItemRecipe(
          product,
          current.recipeOverride ?? product?.recipe,
          ingredientIdSet
        );
        if (recipeValidation.ok === false) {
          updateRunCommandErrorSink(options.errorSink, {
            message: recipeValidation.message,
            retryable: false,
            statusCode: 422,
          });
          if (!options.silentErrorNotification) {
            showNotification(recipeValidation.message);
          }
          return false;
        }

        const syncCommand: SaleDraftAddItemCommand = {
          type: 'SALE_DRAFT_ADD_ITEM',
          draftId,
          productId: current.productId,
          quantity: Math.max(1, Math.round(current.quantity)),
          recipeOverride: recipeValidation.recipe,
          priceOverride: current.priceOverride,
          note: current.note,
          commandId: current.commandId,
        };
        const ok = await runCommandWithSync(syncCommand, undefined, {
          silentSuccessNotification: true,
          silentErrorNotification: options.silentErrorNotification,
          errorSink: options.errorSink,
          trackPendingState: false,
          failFastOnVersionConflict: options.failFastOnVersionConflict,
        });
        if (!ok) return false;

        const nextPendingByDraft = { ...pendingDraftAddsRef.current };
        const remaining = currentPendingAdds.slice(1);
        if (remaining.length === 0) {
          delete nextPendingByDraft[draftId];
        } else {
          nextPendingByDraft[draftId] = remaining;
        }
        replacePendingDraftAdds(nextPendingByDraft);
      }
    },
    [
      hydratePendingDraftAdds,
      ingredients,
      products,
      replacePendingDraftAdds,
      runCommandWithSync,
      showNotification,
    ]
  );

  const flushPendingDraftAdds = useCallback(
    async (
      draftId: string,
      customerType: SaleCustomerType = 'BALCAO',
      options: {
        silentErrorNotification?: boolean;
        errorSink?: RunCommandErrorSink;
        failFastOnVersionConflict?: boolean;
      } = {}
    ): Promise<boolean> => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) {
        return false;
      }

      const queue = pendingDraftFlushQueueRef.current;
      const previous = queue.get(normalizedDraftId) ?? Promise.resolve(true);
      const execute = () => flushPendingDraftAddsCore(normalizedDraftId, customerType, options);
      const next = previous.then(execute, execute);
      queue.set(normalizedDraftId, next);

      try {
        return await next;
      } finally {
        if (queue.get(normalizedDraftId) === next) {
          queue.delete(normalizedDraftId);
        }
      }
    },
    [flushPendingDraftAddsCore]
  );

  const resolveDraftCustomerType = useCallback((draftId: string): SaleCustomerType => {
    const serverDraft = saleDraftsRef.current.find((entry) => entry.id === draftId);
    return (serverDraft?.customerType || 'BALCAO') as SaleCustomerType;
  }, []);

  const runPendingDraftBackgroundSync = useCallback(
    async (draftId: string): Promise<void> => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return;
      if (!isAccessVerified || isStateHydrating) return;
      if (!isPendingDraftAddsHydratedRef.current) return;
      if (syncingPaidDraftIdsRef.current.has(normalizedDraftId)) return;

      const pendingEntries = pendingDraftAddsRef.current[normalizedDraftId] || [];
      if (pendingEntries.length === 0) {
        pendingDraftBackgroundRetryAttemptsRef.current.delete(normalizedDraftId);
        return;
      }

      const runningSet = pendingDraftBackgroundSyncRunningRef.current;
      if (runningSet.has(normalizedDraftId)) return;
      runningSet.add(normalizedDraftId);

      try {
        const errorSink: RunCommandErrorSink = {};
        const ok = await flushPendingDraftAdds(
          normalizedDraftId,
          resolveDraftCustomerType(normalizedDraftId),
          {
            silentErrorNotification: true,
            errorSink,
            failFastOnVersionConflict: true,
          }
        );
        if (ok) {
          pendingDraftBackgroundRetryAttemptsRef.current.delete(normalizedDraftId);
          return;
        }

        const retryable = errorSink.retryable ?? true;
        if (!retryable) {
          pendingDraftBackgroundRetryAttemptsRef.current.delete(normalizedDraftId);
          if (isStockRelatedErrorMessage(errorSink.message || '')) {
            showNotification(
              'Alerta de estoque: um item do carrinho não pôde ser sincronizado por falta de insumo.'
            );
          }
          reportErrorMonitorEvent({
            source: 'sistema:draft-background-sync',
            level: 'error',
            message: errorSink.message || 'Falha permanente ao sincronizar itens do carrinho.',
            statusCode: errorSink.statusCode,
            stack: errorSink.error instanceof Error ? errorSink.error.stack : undefined,
            context: {
              draftId: normalizedDraftId,
              pendingItems: pendingEntries.length,
            },
          });
          return;
        }

        const attemptsMap = pendingDraftBackgroundRetryAttemptsRef.current;
        const nextAttempts = (attemptsMap.get(normalizedDraftId) || 0) + 1;
        attemptsMap.set(normalizedDraftId, nextAttempts);

        const retryDelayMs = getPendingDraftBackgroundSyncRetryDelayMs(nextAttempts);
        const timers = pendingDraftBackgroundSyncTimerRef.current;
        const existingTimer = timers.get(normalizedDraftId);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }
        const timerId = window.setTimeout(() => {
          const activeTimer = pendingDraftBackgroundSyncTimerRef.current.get(normalizedDraftId);
          if (activeTimer !== timerId) return;
          pendingDraftBackgroundSyncTimerRef.current.delete(normalizedDraftId);
          void runPendingDraftBackgroundSync(normalizedDraftId);
        }, retryDelayMs);
        timers.set(normalizedDraftId, timerId);
      } finally {
        runningSet.delete(normalizedDraftId);
      }
    },
    [
      flushPendingDraftAdds,
      isAccessVerified,
      isStateHydrating,
      resolveDraftCustomerType,
      showNotification,
    ]
  );

  const schedulePendingDraftBackgroundSync = useCallback(
    (draftId: string, delayMs = PENDING_DRAFT_BACKGROUND_SYNC_DEBOUNCE_MS): void => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return;
      if (!isAccessVerified || isStateHydrating) return;
      if (!isPendingDraftAddsHydratedRef.current) return;
      if (syncingPaidDraftIdsRef.current.has(normalizedDraftId)) return;

      const pendingEntries = pendingDraftAddsRef.current[normalizedDraftId] || [];
      if (pendingEntries.length === 0) return;

      const timers = pendingDraftBackgroundSyncTimerRef.current;
      const existingTimer = timers.get(normalizedDraftId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }

      const safeDelayMs = Math.max(120, Math.round(delayMs));
      const timerId = window.setTimeout(() => {
        const activeTimer = pendingDraftBackgroundSyncTimerRef.current.get(normalizedDraftId);
        if (activeTimer !== timerId) return;
        pendingDraftBackgroundSyncTimerRef.current.delete(normalizedDraftId);
        void runPendingDraftBackgroundSync(normalizedDraftId);
      }, safeDelayMs);
      timers.set(normalizedDraftId, timerId);
    },
    [isAccessVerified, isStateHydrating, runPendingDraftBackgroundSync]
  );

  useEffect(() => {
    if (!isAccessVerified || isStateHydrating) return;

    const pendingDraftIds = new Set(Object.keys(pendingDraftAddsByDraft));
    pendingDraftBackgroundSyncTimerRef.current.forEach((timerId, draftId) => {
      if (pendingDraftIds.has(draftId)) return;
      window.clearTimeout(timerId);
      pendingDraftBackgroundSyncTimerRef.current.delete(draftId);
      pendingDraftBackgroundRetryAttemptsRef.current.delete(draftId);
    });

    Object.entries(pendingDraftAddsByDraft).forEach(([draftId, entries]) => {
      if (!Array.isArray(entries) || entries.length === 0) return;
      schedulePendingDraftBackgroundSync(draftId);
    });
  }, [
    isAccessVerified,
    isStateHydrating,
    pendingDraftAddsByDraft,
    schedulePendingDraftBackgroundSync,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncAllPendingDrafts = () => {
      if (!isAccessVerified || isStateHydrating) return;
      Object.entries(pendingDraftAddsRef.current).forEach(([draftId, entries]) => {
        if (!Array.isArray(entries) || entries.length === 0) return;
        schedulePendingDraftBackgroundSync(draftId, 120);
      });
    };

    const handleOnline = () => {
      syncAllPendingDrafts();
    };

    window.addEventListener('online', handleOnline);
    const intervalId = window.setInterval(
      syncAllPendingDrafts,
      PENDING_DRAFT_BACKGROUND_SYNC_SWEEP_MS
    );
    syncAllPendingDrafts();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearInterval(intervalId);
    };
  }, [isAccessVerified, isStateHydrating, schedulePendingDraftBackgroundSync]);

  const handleSavePaymentMethod = async (
    snapshot: PaymentCommitSnapshot | null,
    options: {
      trackPendingState?: boolean;
      silentSavedNotification?: boolean;
      silentErrorNotification?: boolean;
      errorSink?: RunCommandErrorSink;
      preferAsyncFinalize?: boolean;
      asyncFinalizeCommandId?: string;
      failFastOnVersionConflict?: boolean;
    } = {}
  ): Promise<boolean> => {
    const notifyError = (message: string) => {
      updateRunCommandErrorSink(options.errorSink, {
        error: undefined,
        message,
        retryable: false,
        statusCode: 422,
      });
      if (!options.silentErrorNotification) {
        showNotification(message);
      }
    };

    const fallbackSnapshot: PaymentCommitSnapshot | null = activeDraft
      ? {
          draft: activeDraft,
          paymentMethod,
          saleOrigin,
          appOrderTotalInput,
          cashReceivedInput,
          splitMode,
          splitCount,
          splitCommitted: splitCommitted.map((entry) => ({ ...entry })),
          effectivePaymentTotal,
        }
      : null;
    const activeSnapshot = snapshot || fallbackSnapshot;
    if (!activeSnapshot) return false;

    const {
      draft,
      paymentMethod: snapshotPaymentMethod,
      saleOrigin: snapshotSaleOrigin,
      appOrderTotalInput: snapshotAppOrderTotalInput,
      cashReceivedInput: snapshotCashReceivedInput,
      splitMode: snapshotSplitMode,
      splitCount: snapshotSplitCount,
      splitCommitted: snapshotSplitCommitted,
      effectivePaymentTotal: snapshotEffectivePaymentTotal,
    } = activeSnapshot;

    if (draft.items.length === 0) {
      notifyError('Carrinho vazio. Não é possível finalizar.');
      return false;
    }

    const appOrderTotalParsed = isAppSaleOrigin(snapshotSaleOrigin)
      ? parseMoneyInput(snapshotAppOrderTotalInput)
      : null;
    if (
      isAppSaleOrigin(snapshotSaleOrigin) &&
      (appOrderTotalParsed === null || appOrderTotalParsed <= 0)
    ) {
      notifyError('Informe o valor real da venda no app (iFood/99).');
      return false;
    }

    const cashReceivedParsed =
      snapshotPaymentMethod === 'DINHEIRO' ? parseMoneyInput(snapshotCashReceivedInput) : null;
    if (
      snapshotPaymentMethod === 'DINHEIRO' &&
      (cashReceivedParsed === null || cashReceivedParsed < 0)
    ) {
      notifyError('Informe um valor recebido válido em dinheiro.');
      return false;
    }

    let finalizeCommand: StateCommand;
    if (snapshotPaymentMethod === 'DIVIDIDO') {
      if (!snapshotSplitMode || !snapshotSplitCount) {
        notifyError('Finalize o dividido na janela de parcelas antes de confirmar.');
        return false;
      }

      if (snapshotSplitMode === 'PEOPLE' && snapshotSplitCommitted.length !== snapshotSplitCount) {
        notifyError('Finalize toda a divisão antes de confirmar.');
        return false;
      }

      if (snapshotSplitMode === 'MIXED' && snapshotSplitCommitted.length < 2) {
        notifyError('No dividido, informe ao menos duas parcelas (ex: PIX + dinheiro).');
        return false;
      }

      const totalDividido = sumSplitAmounts(snapshotSplitCommitted);
      if (Math.abs(totalDividido - snapshotEffectivePaymentTotal) > 0.009) {
        notifyError(
          `A divisão ainda está incompleta. Restante: R$ ${formatMoney(
            Math.abs(snapshotEffectivePaymentTotal - totalDividido)
          )}`
        );
        return false;
      }

      const splitPayload = snapshotSplitCommitted.map((entry, index) => ({
        sequence: index + 1,
        label: entry.label,
        method: entry.method,
        amount: roundMoney(entry.amount),
        cashReceived:
          entry.method === 'DINHEIRO' && entry.cashReceived !== null
            ? roundMoney(entry.cashReceived)
            : undefined,
      }));

      finalizeCommand = {
        type: 'SALE_DRAFT_FINALIZE',
        draftId: draft.id,
        paymentMethod: 'DIVIDIDO',
        splitMode: snapshotSplitMode,
        splitCount: snapshotSplitCount,
        splitPayments: splitPayload,
        saleOrigin: snapshotSaleOrigin,
        appOrderTotal: isAppSaleOrigin(snapshotSaleOrigin)
          ? (appOrderTotalParsed ?? undefined)
          : undefined,
      };
    } else {
      finalizeCommand = {
        type: 'SALE_DRAFT_FINALIZE',
        draftId: draft.id,
        paymentMethod: snapshotPaymentMethod,
        cashReceived:
          snapshotPaymentMethod === 'DINHEIRO' ? (cashReceivedParsed ?? undefined) : undefined,
        saleOrigin: snapshotSaleOrigin,
        appOrderTotal: isAppSaleOrigin(snapshotSaleOrigin)
          ? (appOrderTotalParsed ?? undefined)
          : undefined,
      };
    }

    const executeFinalizeCommand = async (): Promise<boolean> => {
      if (!options.preferAsyncFinalize) {
        return runCommandWithSync(finalizeCommand, undefined, {
          silentSuccessNotification: true,
          silentErrorNotification: options.silentErrorNotification,
          errorSink: options.errorSink,
          trackPendingState: options.trackPendingState,
          failFastOnVersionConflict: options.failFastOnVersionConflict,
        });
      }

      const asyncFinalizeCommand: StateCommand = {
        ...finalizeCommand,
        commandId:
          options.asyncFinalizeCommandId?.trim() ||
          finalizeCommand.commandId?.trim() ||
          createClientId('cmd'),
      };

      let asyncJobId: string | null = null;
      try {
        const queuedAsyncJob = await enqueueStateCommandAsync(asyncFinalizeCommand);
        asyncJobId = queuedAsyncJob.id;
      } catch (error) {
        const statusCode = error instanceof StateCommandSyncError ? error.statusCode : undefined;
        const shouldFallbackToSync =
          statusCode === 404 || statusCode === 405 || statusCode === 422 || statusCode === 501;

        if (shouldFallbackToSync) {
          return runCommandWithSync(asyncFinalizeCommand, undefined, {
            silentSuccessNotification: true,
            silentErrorNotification: options.silentErrorNotification,
            errorSink: options.errorSink,
            trackPendingState: options.trackPendingState,
            failFastOnVersionConflict: options.failFastOnVersionConflict,
          });
        }

        const message = getStateSyncErrorMessage(error);
        updateRunCommandErrorSink(options.errorSink, {
          error,
          message,
          retryable: isRetryableSyncError(error),
          statusCode,
        });
        if (!options.silentErrorNotification) {
          showNotification(message);
        }
        return false;
      }

      let terminalStatus: { status: StateCommandAsyncJobStatus; lastError: string | null } | null = null;
      try {
        terminalStatus = await waitForAsyncCommandJobTerminalStatus(asyncJobId);
      } catch (error) {
        const message = getStateSyncErrorMessage(error);
        updateRunCommandErrorSink(options.errorSink, {
          error,
          message,
          retryable: isRetryableSyncError(error),
          statusCode: error instanceof StateCommandSyncError ? error.statusCode : undefined,
        });
        if (!options.silentErrorNotification) {
          showNotification(message);
        }
        return false;
      }

      if (!terminalStatus || terminalStatus.status !== 'COMPLETED') {
        const message =
          terminalStatus?.lastError ||
          'Falha no processamento assíncrono ao salvar forma de pagamento.';
        updateRunCommandErrorSink(options.errorSink, {
          error: undefined,
          message,
          retryable: false,
          statusCode: 409,
        });
        if (!options.silentErrorNotification) {
          showNotification(message);
        }
        return false;
      }

      try {
        const refreshedState = await fetchStateSnapshot();
        applyStateSnapshot(refreshedState);
      } catch (error) {
        const message = getStateSyncErrorMessage(error);
        updateRunCommandErrorSink(options.errorSink, {
          error,
          message,
          retryable: isRetryableSyncError(error),
          statusCode: error instanceof StateCommandSyncError ? error.statusCode : undefined,
        });
        if (!options.silentErrorNotification) {
          showNotification(message);
        }
        return false;
      }

      updateRunCommandErrorSink(options.errorSink, {
        error: undefined,
        message: undefined,
        retryable: undefined,
        statusCode: undefined,
      });
      return true;
    };

    // Defensive: backend must persist app-origin and app amount before allowing confirm.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ok = await executeFinalizeCommand();
      if (!ok) return false;

      if (!isAppSaleOrigin(snapshotSaleOrigin)) {
        if (!options.silentSavedNotification) {
          showNotification('Forma de pagamento atualizada.');
        }
        return true;
      }

      const persistedDraft = saleDraftsRef.current.find((entry) => entry.id === draft.id);
      const persistedOrigin = persistedDraft?.saleOrigin || 'LOCAL';
      const persistedAppTotal = Number(persistedDraft?.appOrderTotal);
      const expectedAppTotal = Number(appOrderTotalParsed);
      const hasPersistedAppTotal =
        Number.isFinite(persistedAppTotal) &&
        persistedAppTotal > 0 &&
        Number.isFinite(expectedAppTotal) &&
        expectedAppTotal > 0 &&
        Math.abs(persistedAppTotal - expectedAppTotal) <= 0.009;

      if (isAppSaleOrigin(persistedOrigin) && hasPersistedAppTotal) {
        if (!options.silentSavedNotification) {
          showNotification('Forma de pagamento atualizada.');
        }
        return true;
      }
    }

    notifyError(
      'O servidor não confirmou o valor do app. Atualize o backend/sessão antes de confirmar o pagamento.'
    );
    return false;
  };

  const enqueuePendingPaidSyncJob = useCallback(
    (jobInput: PendingPaidSyncJob) => {
      hydratePendingPaidSyncQueue();
      const normalizedJob = normalizePendingPaidSyncJob(jobInput);
      if (!normalizedJob) return;

      const existingIndex = pendingPaidSyncQueueRef.current.findIndex(
        (entry) => entry.draftId === normalizedJob.draftId
      );

      if (existingIndex >= 0) {
        const nextQueue = [...pendingPaidSyncQueueRef.current];
        const existing = nextQueue[existingIndex];
        nextQueue[existingIndex] = {
          ...normalizedJob,
          id: existing.id,
          createdAt: existing.createdAt,
          attempts: 0,
          nextAttemptAt: undefined,
          lastError: undefined,
        };
        replacePendingPaidSyncQueue(nextQueue);
        setDraftSyncInProgress(normalizedJob.draftId, true);
        return;
      }

      replacePendingPaidSyncQueue([...pendingPaidSyncQueueRef.current, normalizedJob]);
      setDraftSyncInProgress(normalizedJob.draftId, true);
    },
    [hydratePendingPaidSyncQueue, replacePendingPaidSyncQueue, setDraftSyncInProgress]
  );

  const enqueueFailedPaidSyncJob = useCallback(
    (jobInput: PendingPaidSyncJob) => {
      hydrateFailedPaidSyncQueue();
      const normalizedJob = normalizePendingPaidSyncJob(jobInput);
      if (!normalizedJob) return;

      const existingIndex = failedPaidSyncQueueRef.current.findIndex(
        (entry) => entry.id === normalizedJob.id || entry.draftId === normalizedJob.draftId
      );

      if (existingIndex >= 0) {
        const nextQueue = [...failedPaidSyncQueueRef.current];
        nextQueue[existingIndex] = {
          ...nextQueue[existingIndex],
          ...normalizedJob,
          nextAttemptAt: undefined,
        };
        replaceFailedPaidSyncQueue(nextQueue);
        return;
      }

      replaceFailedPaidSyncQueue([normalizedJob, ...failedPaidSyncQueueRef.current]);
    },
    [hydrateFailedPaidSyncQueue, replaceFailedPaidSyncQueue]
  );

  const restorePendingDraftAddsFromSnapshot = useCallback(
    (
      job: PendingPaidSyncJob,
      options: {
        trigger?: 'queue-empty-draft' | 'failed-retry' | 'manual-recover' | 'auto-recover';
        failureMessage?: string;
        statusCode?: number;
      } = {}
    ): boolean => {
      hydratePendingDraftAdds();

      const normalizedDraftId = job.draftId.trim();
      if (!normalizedDraftId) return false;

      const snapshotItems = Array.isArray(job.snapshot.draft.items)
        ? job.snapshot.draft.items
        : [];
      if (snapshotItems.length === 0) return false;

      const serverDraft = saleDraftsRef.current.find((draft) => draft.id === normalizedDraftId);
      if (serverDraft && (serverDraft.status === 'PAID' || serverDraft.status === 'CANCELLED')) {
        return false;
      }

      const rebuiltPendingAdds = snapshotItems
        .map((item): PendingDraftAdd | null => {
          const productId = typeof item.productId === 'string' ? item.productId.trim() : '';
          if (!productId) return null;

          const quantityRaw = Number(item.qty);
          const quantity =
            Number.isFinite(quantityRaw) && quantityRaw > 0
              ? Math.max(1, Math.round(quantityRaw))
              : 0;
          if (quantity <= 0) return null;

          const recipeOverride = normalizeRecipeOverride(item.recipe);
          const unitPriceRaw = Number(item.unitPriceSnapshot);
          const priceOverride =
            Number.isFinite(unitPriceRaw) && unitPriceRaw >= 0
              ? roundMoney(unitPriceRaw)
              : undefined;
          const note = typeof item.note === 'string' && item.note.trim() ? item.note.trim() : undefined;

          const rebuiltEntry: PendingDraftAdd = {
            draftId: normalizedDraftId,
            localItemId: createClientId('draft-item-local'),
            commandId: createClientId('cmd'),
            productId,
            quantity,
            queuedAt: new Date().toISOString(),
          };
          if (recipeOverride) {
            rebuiltEntry.recipeOverride = recipeOverride;
          }
          if (priceOverride !== undefined) {
            rebuiltEntry.priceOverride = priceOverride;
          }
          if (note) {
            rebuiltEntry.note = note;
          }
          return rebuiltEntry;
        })
        .filter((entry): entry is PendingDraftAdd => entry !== null);

      if (rebuiltPendingAdds.length === 0) return false;

      const nextPendingByDraft: PendingDraftAddsByDraftId = {
        ...pendingDraftAddsRef.current,
        [normalizedDraftId]: rebuiltPendingAdds,
      };
      replacePendingDraftAdds(nextPendingByDraft);
      reportErrorMonitorEvent({
        source: 'sistema:paid-sync:cart-restored',
        level: 'warn',
        message: 'Pedido reconstruído no carrinho local para auto-recuperação da fila.',
        statusCode: options.statusCode,
        context: {
          trigger: options.trigger || 'unknown',
          draftId: normalizedDraftId,
          jobId: job.id,
          rebuiltItems: rebuiltPendingAdds.length,
          failedAttempts: job.attempts,
          lastError: options.failureMessage || job.lastError || null,
        },
      });
      return true;
    },
    [hydratePendingDraftAdds, replacePendingDraftAdds]
  );

  const recoverPendingPaidSyncDraft = useCallback(
    async (
      job: PendingPaidSyncJob,
      options: {
        trigger?: 'queue-empty-draft' | 'failed-retry' | 'manual-recover' | 'auto-recover';
        failureMessage?: string;
        statusCode?: number;
      } = {}
    ): Promise<PendingPaidSyncDraftRecoveryResult> => {
      hydratePendingDraftAdds();

      const normalizedDraftId = job.draftId.trim();
      if (!normalizedDraftId) {
        return {
          ok: false,
          retryable: false,
          message: 'Draft inválido para recuperação.',
          statusCode: 422,
        };
      }

      const localServerDraft = saleDraftsRef.current.find((draft) => draft.id === normalizedDraftId);
      if (
        localServerDraft &&
        (localServerDraft.status === 'PAID' || localServerDraft.status === 'CANCELLED')
      ) {
        return { ok: true, reconciledOnServer: true };
      }

      const localPending = pendingDraftAddsRef.current[normalizedDraftId] || [];
      if (localPending.length === 0) {
        const restored = restorePendingDraftAddsFromSnapshot(job, options);
        if (!restored) {
          return {
            ok: false,
            retryable: false,
            message: 'Não foi possível reconstruir itens pendentes a partir do snapshot.',
            statusCode: 422,
          };
        }
      }

      const customerType = (job.snapshot.draft.customerType || 'BALCAO') as SaleCustomerType;
      const flushErrorSink: RunCommandErrorSink = {};
      const flushed = await flushPendingDraftAdds(normalizedDraftId, customerType, {
        silentErrorNotification: true,
        errorSink: flushErrorSink,
        failFastOnVersionConflict: false,
      });
      if (!flushed) {
        return {
          ok: false,
          retryable: flushErrorSink.retryable ?? true,
          message:
            flushErrorSink.message || 'Falha ao sincronizar itens reconstruídos com o servidor.',
          statusCode: flushErrorSink.statusCode,
        };
      }

      let refreshedState: AppState;
      try {
        refreshedState = await fetchStateSnapshot();
      } catch (error) {
        return {
          ok: false,
          retryable: true,
          message: getStateSyncErrorMessage(error),
          statusCode: error instanceof StateCommandSyncError ? error.statusCode : undefined,
        };
      }

      applyStateSnapshot(refreshedState);
      const refreshedDraft = refreshedState.saleDrafts.find((draft) => draft.id === normalizedDraftId);
      if (!refreshedDraft) {
        return {
          ok: false,
          retryable: true,
          message: 'Draft não encontrado no servidor após recuperação.',
        };
      }

      if (refreshedDraft.status === 'PAID' || refreshedDraft.status === 'CANCELLED') {
        return { ok: true, reconciledOnServer: true };
      }

      if (!Array.isArray(refreshedDraft.items) || refreshedDraft.items.length === 0) {
        return {
          ok: false,
          retryable: true,
          message: 'Draft ainda está vazio no servidor após recuperação automática.',
          statusCode: 422,
        };
      }

      return { ok: true, reconciledOnServer: false };
    },
    [
      applyStateSnapshot,
      fetchStateSnapshot,
      flushPendingDraftAdds,
      hydratePendingDraftAdds,
      restorePendingDraftAddsFromSnapshot,
    ]
  );

  const setFailedPaidSyncAutoRetryAttempts = useCallback((jobId: string, attempts: number): void => {
    const normalizedJobId = jobId.trim();
    if (!normalizedJobId) return;
    const safeAttempts = Math.max(0, Math.floor(attempts));
    const currentAttempts = failedPaidSyncAutoRetryAttemptsRef.current.get(normalizedJobId) || 0;
    if (safeAttempts <= 0) {
      if (failedPaidSyncAutoRetryAttemptsRef.current.delete(normalizedJobId) || currentAttempts !== 0) {
        setFailedPaidSyncAutoRetryRevision((current) => current + 1);
      }
      return;
    }
    if (currentAttempts === safeAttempts) return;
    failedPaidSyncAutoRetryAttemptsRef.current.set(normalizedJobId, safeAttempts);
    setFailedPaidSyncAutoRetryRevision((current) => current + 1);
  }, []);

  const clearFailedPaidSyncAutoRetryState = useCallback((jobId: string): void => {
    const normalizedJobId = jobId.trim();
    if (!normalizedJobId) return;
    const timerId = failedPaidSyncAutoRetryTimersRef.current.get(normalizedJobId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      failedPaidSyncAutoRetryTimersRef.current.delete(normalizedJobId);
    }
    const recoveryTimerId = failedPaidSyncAutoRecoverTimersRef.current.get(normalizedJobId);
    if (recoveryTimerId !== undefined) {
      window.clearTimeout(recoveryTimerId);
      failedPaidSyncAutoRecoverTimersRef.current.delete(normalizedJobId);
    }
    setFailedPaidSyncAutoRetryAttempts(normalizedJobId, 0);
  }, [setFailedPaidSyncAutoRetryAttempts]);

  const handleRecoverFailedPaidSyncJobToCart = useCallback(
    async (
      jobId: string,
      options: {
        silentNotification?: boolean;
        openCart?: boolean;
        requeueAfterRestore?: boolean;
      } = {}
    ): Promise<boolean> => {
      hydrateFailedPaidSyncQueue();
      const normalizedJobId = jobId.trim();
      if (!normalizedJobId) return false;

      const failedJob = failedPaidSyncQueueRef.current.find((entry) => entry.id === normalizedJobId);
      if (!failedJob) {
        if (!options.silentNotification) {
          showNotification('Pedido não encontrado na fila de falhas.');
        }
        return false;
      }

      const serverDraft = saleDraftsRef.current.find((draft) => draft.id === failedJob.draftId);
      if (serverDraft && (serverDraft.status === 'PAID' || serverDraft.status === 'CANCELLED')) {
        replaceFailedPaidSyncQueue(
          failedPaidSyncQueueRef.current.filter((entry) => entry.id !== normalizedJobId)
        );
        clearFailedPaidSyncAutoRetryState(normalizedJobId);
        if (!options.silentNotification) {
          showNotification('Pedido já resolvido no servidor. Item removido da fila de falhas.');
        }
        return true;
      }

      setPaidSyncAssistantActivity(
        'recovering',
        describePaidSyncAssistantMode('recovering', `pedido ${failedJob.draftId.slice(-8).toUpperCase()}`),
        {
          draftId: failedJob.draftId,
          jobId: failedJob.id,
        }
      );
      const recoveryResult = await recoverPendingPaidSyncDraft(failedJob, {
        trigger: options.requeueAfterRestore === true ? 'auto-recover' : 'manual-recover',
      });
      if (!recoveryResult.ok) {
        reportErrorMonitorEvent({
          source: 'sistema:paid-sync:cart-restore-failed',
          level: 'error',
          message: 'Falha ao recuperar pedido da fila de falhas com reconciliação no servidor.',
          statusCode: recoveryResult.statusCode,
          context: {
            trigger: options.requeueAfterRestore === true ? 'auto-recover' : 'manual-recover',
            draftId: failedJob.draftId,
            jobId: failedJob.id,
            failedAttempts: failedJob.attempts,
            lastError: failedJob.lastError || null,
            recoveryMessage: recoveryResult.message || null,
          },
        });
        if (!options.silentNotification) {
          showNotification(recoveryResult.message || 'Não foi possível recuperar este pedido automaticamente.');
        }
        return false;
      }

      replaceFailedPaidSyncQueue(
        failedPaidSyncQueueRef.current.filter((entry) => entry.id !== normalizedJobId)
      );
      clearFailedPaidSyncAutoRetryState(normalizedJobId);
      if (recoveryResult.reconciledOnServer) {
        showCornerSync('success', 'Pedido já estava resolvido no servidor.', 1800);
        if (!options.silentNotification) {
          showNotification('Pedido já estava resolvido no servidor. Item removido da fila.');
        }
        return true;
      }

      const shouldRequeueAfterRestore = options.requeueAfterRestore !== false;
      if (shouldRequeueAfterRestore) {
        enqueuePendingPaidSyncJob({
          ...failedJob,
          finalizeCommandId: createClientId('cmd'),
          confirmCommandId: createClientId('cmd'),
          attempts: 0,
          nextAttemptAt: undefined,
          lastError: undefined,
        });
        showCornerSync('syncing', 'Pedido recuperado e reenviado automaticamente.', 2200);
        if (!options.silentNotification) {
          showNotification('Pedido recuperado e reenviado automaticamente.');
        }
        return true;
      }

      showCornerSync('error', 'Pedido recuperado, mas não foi reenfileirado.', 2600);
      if (!options.silentNotification) {
        showNotification('Pedido recuperado, mas a fila não conseguiu reenfileirar agora.');
      }
      return false;
    },
    [
      clearFailedPaidSyncAutoRetryState,
      setPaidSyncAssistantActivity,
      recoverPendingPaidSyncDraft,
      enqueuePendingPaidSyncJob,
      hydrateFailedPaidSyncQueue,
      replaceFailedPaidSyncQueue,
      showCornerSync,
      showNotification,
    ]
  );

  const processPendingPaidSyncQueue = useCallback(async (): Promise<void> => {
    hydratePendingPaidSyncQueue();
    if (isStateHydrating) return;
    if (isPendingPaidSyncQueueRunningRef.current) return;
    if (pendingPaidSyncQueueRef.current.length === 0) return;

    if (pendingPaidSyncRetryTimerRef.current !== null) {
      window.clearTimeout(pendingPaidSyncRetryTimerRef.current);
      pendingPaidSyncRetryTimerRef.current = null;
    }

    isPendingPaidSyncQueueRunningRef.current = true;

    try {
      while (pendingPaidSyncQueueRef.current.length > 0) {
        const currentJob = pendingPaidSyncQueueRef.current[0];
        if (!currentJob) return;

        const nowMs = Date.now();
        if (!isPendingPaidSyncJobReady(currentJob, nowMs)) {
          const hasReadyBehind = pendingPaidSyncQueueRef.current
            .slice(1)
            .some((job) => isPendingPaidSyncJobReady(job, nowMs));
          if (hasReadyBehind) {
            replacePendingPaidSyncQueue([
              ...pendingPaidSyncQueueRef.current.slice(1),
              currentJob,
            ]);
            continue;
          }

          const earliestRetryAtMs = pendingPaidSyncQueueRef.current.reduce((earliest, job) => {
            const retryAtMs = getPendingPaidSyncJobNextAttemptAtMs(job);
            if (!Number.isFinite(retryAtMs) || retryAtMs <= nowMs) {
              return earliest;
            }
            return Math.min(earliest, retryAtMs);
          }, Number.POSITIVE_INFINITY);
          const fallbackDelayMs = Math.max(
            250,
            getPendingPaidSyncJobNextAttemptAtMs(currentJob) - nowMs
          );
          const delayMs = Number.isFinite(earliestRetryAtMs)
            ? Math.max(250, earliestRetryAtMs - nowMs)
            : fallbackDelayMs;
          pendingPaidSyncRetryTimerRef.current = window.setTimeout(() => {
            void processPendingPaidSyncQueue();
          }, delayMs);
          return;
        }

        let currentServerDraft = saleDraftsRef.current.find(
          (draft) => draft.id === currentJob.draftId
        );
        if (
          currentServerDraft &&
          (currentServerDraft.status === 'PAID' || currentServerDraft.status === 'CANCELLED')
        ) {
          replacePendingPaidSyncQueue(pendingPaidSyncQueueRef.current.slice(1));
          setDraftSyncInProgress(currentJob.draftId, false);
          continue;
        }

        if (currentServerDraft?.status === 'PENDING_PAYMENT') {
          const nextPendingByDraft = { ...pendingDraftAddsRef.current };
          if ((nextPendingByDraft[currentJob.draftId] || []).length > 0) {
            delete nextPendingByDraft[currentJob.draftId];
            replacePendingDraftAdds(nextPendingByDraft);
          }
        }

        setDraftSyncInProgress(currentJob.draftId, true);
        setPaidSyncAssistantActivity(
          'reconciling',
          describePaidSyncAssistantMode(
            'reconciling',
            `pedido ${currentJob.draftId.slice(-8).toUpperCase()}`
          ),
          {
            draftId: currentJob.draftId,
            jobId: currentJob.id,
          }
        );
        showCornerSync('syncing', 'Sincronizando venda no banco...');

        const markJobAsFailed = async (
          fallbackMessage: string,
          errorSink?: RunCommandErrorSink
        ): Promise<void> => {
          const message = errorSink?.message || fallbackMessage;
          const retryable = errorSink?.retryable ?? true;
          const statusCode = errorSink?.statusCode;
          const isEmptyDraftFailure =
            statusCode === 422 && isDraftEmptyErrorMessage(message);

          const scheduleRecoveryRetry = (
            recoveryMessage: string,
            recoveryStatusCode?: number
          ): void => {
            const retryAt = new Date(
              Date.now() + PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_DELAY_MS
            ).toISOString();
            const recoveredJob: PendingPaidSyncJob = {
              ...currentJob,
              finalizeCommandId: createClientId('cmd'),
              confirmCommandId: createClientId('cmd'),
              attempts: currentJob.attempts + 1,
              nextAttemptAt: retryAt,
              lastError: recoveryStatusCode
                ? `RECOVERING_DRAFT: ${recoveryMessage} (HTTP ${recoveryStatusCode})`
                : `RECOVERING_DRAFT: ${recoveryMessage}`,
            };
            replacePendingPaidSyncQueue([
              recoveredJob,
              ...pendingPaidSyncQueueRef.current.slice(1),
            ]);
            setDraftSyncInProgress(currentJob.draftId, true);
            pendingPaidSyncRetryTimerRef.current = window.setTimeout(() => {
              void processPendingPaidSyncQueue();
            }, PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_DELAY_MS);
          };

          if (
            isEmptyDraftFailure &&
            currentJob.attempts < PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_MAX_ATTEMPTS
          ) {
            setPaidSyncAssistantActivity(
              'recovering',
              describePaidSyncAssistantMode(
                'recovering',
                `draft ${currentJob.draftId.slice(-8).toUpperCase()} (tentativa ${
                  currentJob.attempts + 1
                }/${PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_MAX_ATTEMPTS})`
              ),
              {
                draftId: currentJob.draftId,
                jobId: currentJob.id,
              }
            );
            const recoveryResult = await recoverPendingPaidSyncDraft(currentJob, {
              trigger: 'queue-empty-draft',
              failureMessage: message,
              statusCode,
            });

            if (recoveryResult.ok) {
              if (recoveryResult.reconciledOnServer) {
                replacePendingPaidSyncQueue(pendingPaidSyncQueueRef.current.slice(1));
                setDraftSyncInProgress(currentJob.draftId, false);
                showCornerSync('success', 'Pedido já estava resolvido no banco.', 1800);
                return;
              }
              scheduleRecoveryRetry(
                'Draft validado no servidor. Reenfileirando finalização...',
                recoveryResult.statusCode
              );
              showCornerSync(
                'syncing',
                'Draft recuperado e validado. Reenviando pedido...',
                2200
              );
              showNotification(
                'A fila entrou no modo RECOVERING_DRAFT e reenfileirou automaticamente este pedido.'
              );
              return;
            }

            if (recoveryResult.retryable ?? true) {
              scheduleRecoveryRetry(
                recoveryResult.message || message,
                recoveryResult.statusCode ?? statusCode
              );
              showCornerSync(
                'syncing',
                'Robô conciliando draft no servidor. Nova tentativa automática...',
                2400
              );
              return;
            }
          }

          if (!retryable) {
            if (isEmptyDraftFailure) {
              const nextPendingByDraft = { ...pendingDraftAddsRef.current };
              if ((nextPendingByDraft[currentJob.draftId] || []).length > 0) {
                delete nextPendingByDraft[currentJob.draftId];
                replacePendingDraftAdds(nextPendingByDraft);
              }
            }
            const failedJob: PendingPaidSyncJob = {
              ...currentJob,
              attempts: currentJob.attempts + 1,
              nextAttemptAt: undefined,
              lastError: statusCode ? `${message} (HTTP ${statusCode})` : message,
            };
            replacePendingPaidSyncQueue(pendingPaidSyncQueueRef.current.slice(1));
            enqueueFailedPaidSyncJob(failedJob);
            setDraftSyncInProgress(currentJob.draftId, false);
            const isStockFailure = isStockRelatedErrorMessage(message);
            showCornerSync(
              'error',
              isStockFailure
                ? 'Estoque insuficiente em pedido da fila.'
                : 'Falha no pedido. Use "Tentar de novo" no painel.',
              3200
            );
            if (isStockFailure) {
              showNotification('Alerta de estoque: item sem insumo suficiente para concluir pedido.');
            }
            showNotification(`Erro ao enviar pedido: ${message}`);
            window.setTimeout(() => {
              void processPendingPaidSyncQueue();
            }, 60);
            return;
          }

          const nextAttempts = currentJob.attempts + 1;
          const retryDelayMs = getPendingPaidSyncRetryDelayMs(nextAttempts);
          const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
          const failedJob: PendingPaidSyncJob = {
            ...currentJob,
            attempts: nextAttempts,
            nextAttemptAt: retryAt,
            lastError: statusCode ? `${message} (HTTP ${statusCode})` : message,
          };
          replacePendingPaidSyncQueue([...pendingPaidSyncQueueRef.current.slice(1), failedJob]);
          setDraftSyncInProgress(currentJob.draftId, false);
          showCornerSync('error', 'Banco lento. Pedido movido para o fim da fila.', 1800);
          window.setTimeout(() => {
            void processPendingPaidSyncQueue();
          }, 180);
        };

        const shouldFlushDraftAdds =
          !currentServerDraft || currentServerDraft.status === 'DRAFT';
        if (shouldFlushDraftAdds) {
          const draftAddsErrorSink: RunCommandErrorSink = {};
          const flushed = await flushPendingDraftAdds(
            currentJob.draftId,
            (currentJob.snapshot.draft.customerType || 'BALCAO') as SaleCustomerType,
            {
              silentErrorNotification: true,
              errorSink: draftAddsErrorSink,
              failFastOnVersionConflict: false,
            }
          );
          if (!flushed) {
            await markJobAsFailed('Falha ao enviar itens pendentes.', draftAddsErrorSink);
            return;
          }
          currentServerDraft = saleDraftsRef.current.find((entry) => entry.id === currentJob.draftId);
          if (
            currentServerDraft &&
            (currentServerDraft.status === 'PAID' || currentServerDraft.status === 'CANCELLED')
          ) {
            replacePendingPaidSyncQueue(pendingPaidSyncQueueRef.current.slice(1));
            setDraftSyncInProgress(currentJob.draftId, false);
            showCornerSync('success', 'Pedido já estava concluído no banco.', 1800);
            continue;
          }
        }

        // Guard rail: never call FINALIZE while server draft is still empty.
        // If server is lagging/stale, force recovery path instead of producing hard 422 finalize noise.
        if (!currentServerDraft || currentServerDraft.status === 'DRAFT') {
          if (!currentServerDraft || (currentServerDraft.items || []).length === 0) {
            try {
              const refreshedState = await fetchStateSnapshot();
              applyStateSnapshot(refreshedState);
            } catch {
              // best-effort refresh; fallback to local view below
            }
            currentServerDraft = saleDraftsRef.current.find((entry) => entry.id === currentJob.draftId);
          }

          if (
            currentServerDraft &&
            (currentServerDraft.status === 'PAID' || currentServerDraft.status === 'CANCELLED')
          ) {
            replacePendingPaidSyncQueue(pendingPaidSyncQueueRef.current.slice(1));
            setDraftSyncInProgress(currentJob.draftId, false);
            showCornerSync('success', 'Pedido já estava concluído no banco.', 1800);
            continue;
          }

          const serverItemsCount = Array.isArray(currentServerDraft?.items)
            ? currentServerDraft.items.length
            : 0;
          if (serverItemsCount === 0) {
            await markJobAsFailed('O carrinho está vazio.', {
              message: 'O carrinho está vazio.',
              statusCode: 422,
              retryable: true,
            });
            return;
          }
        }

        let finalized = currentServerDraft?.status === 'PENDING_PAYMENT';
        if (!finalized) {
          const finalizeErrorSink: RunCommandErrorSink = {};
          finalized = await handleSavePaymentMethod(currentJob.snapshot, {
            trackPendingState: false,
            silentSavedNotification: true,
            silentErrorNotification: true,
            errorSink: finalizeErrorSink,
            preferAsyncFinalize: false,
            failFastOnVersionConflict: false,
          });
          if (!finalized) {
            const finalizeMessage =
              finalizeErrorSink.message || 'Falha ao salvar forma de pagamento.';
            const isFinalizeConflict =
              finalizeErrorSink.statusCode === 409 &&
              isFinalizeStateConflictErrorMessage(finalizeMessage);
            if (isFinalizeConflict) {
              let stateRefreshed = false;
              try {
                const refreshedState = await fetchStateSnapshot();
                applyStateSnapshot(refreshedState);
                stateRefreshed = true;
              } catch {
                // best-effort: if refresh fails we still evaluate local snapshot below
              }
              const latestDraft = saleDraftsRef.current.find(
                (entry) => entry.id === currentJob.draftId
              );
              if (
                !latestDraft ||
                latestDraft.status === 'PAID' ||
                latestDraft.status === 'CANCELLED'
              ) {
                replacePendingPaidSyncQueue(pendingPaidSyncQueueRef.current.slice(1));
                setDraftSyncInProgress(currentJob.draftId, false);
                showCornerSync('success', 'Pedido já estava concluído no banco.', 1800);
                continue;
              }
              if (latestDraft.status === 'PENDING_PAYMENT') {
                finalized = true;
                showCornerSync('syncing', 'Pagamento já preparado. Confirmando...', 1600);
              } else {
                await markJobAsFailed(
                  stateRefreshed
                    ? 'Conflito ao finalizar pagamento.'
                    : 'Conflito ao finalizar pagamento. Reagendando com atualização de estado.',
                  {
                    ...finalizeErrorSink,
                    retryable: true,
                  }
                );
                return;
              }
            } else {
              await markJobAsFailed('Falha ao salvar forma de pagamento.', finalizeErrorSink);
              return;
            }
          }
        }

        const confirmCommand: StateCommand = {
          type: 'SALE_DRAFT_CONFIRM_PAID',
          draftId: currentJob.draftId,
          commandId: currentJob.confirmCommandId,
        };

        let asyncJobId: string | null = null;
        try {
          const queuedAsyncJob = await enqueueStateCommandAsync(confirmCommand);
          asyncJobId = queuedAsyncJob.id;
        } catch (error) {
          const statusCode =
            error instanceof StateCommandSyncError ? error.statusCode : undefined;
          const shouldFallbackToSync =
            statusCode === 404 ||
            statusCode === 405 ||
            statusCode === 422 ||
            statusCode === 501;

          if (shouldFallbackToSync) {
            const confirmErrorSink: RunCommandErrorSink = {};
            const confirmed = await runCommandWithSync(
              confirmCommand,
              undefined,
              {
                trackPendingState: false,
                silentSuccessNotification: true,
                silentErrorNotification: true,
                errorSink: confirmErrorSink,
                failFastOnVersionConflict: false,
              }
            );
            if (!confirmed) {
              await markJobAsFailed('Falha ao confirmar pagamento.', confirmErrorSink);
              return;
            }
          } else {
            await markJobAsFailed('Falha ao enfileirar confirmação assíncrona.', {
              error,
              message: getStateSyncErrorMessage(error),
              retryable: isRetryableSyncError(error),
              statusCode,
            });
            return;
          }
        }

        if (asyncJobId) {
          let terminalStatus: { status: StateCommandAsyncJobStatus; lastError: string | null } | null = null;
          let resolvedBySyncFallback = false;
          try {
            terminalStatus = await waitForAsyncCommandJobTerminalStatus(asyncJobId);
          } catch (error) {
            const errorMessage = getStateSyncErrorMessage(error);
            const isTimeoutWhileWaiting =
              errorMessage.toLowerCase().includes('timeout aguardando processamento assíncrono');
            if (!isTimeoutWhileWaiting) {
              await markJobAsFailed('Falha ao aguardar processamento assíncrono.', {
                error,
                message: errorMessage,
                retryable: isRetryableSyncError(error),
                statusCode: error instanceof StateCommandSyncError ? error.statusCode : undefined,
              });
              return;
            }

            const confirmErrorSink: RunCommandErrorSink = {};
            const confirmed = await runCommandWithSync(
              confirmCommand,
              undefined,
              {
                trackPendingState: false,
                silentSuccessNotification: true,
                silentErrorNotification: true,
                errorSink: confirmErrorSink,
                failFastOnVersionConflict: false,
              }
            );
            if (!confirmed) {
              await markJobAsFailed(
                'Falha ao confirmar pagamento após timeout do processamento assíncrono.',
                confirmErrorSink
              );
              return;
            }
            resolvedBySyncFallback = true;
          }

          if (!resolvedBySyncFallback && (!terminalStatus || terminalStatus.status !== 'COMPLETED')) {
            const confirmErrorSink: RunCommandErrorSink = {};
            const confirmed = await runCommandWithSync(
              confirmCommand,
              undefined,
              {
                trackPendingState: false,
                silentSuccessNotification: true,
                silentErrorNotification: true,
                errorSink: confirmErrorSink,
                failFastOnVersionConflict: false,
              }
            );
            if (!confirmed) {
              await markJobAsFailed(
                terminalStatus?.lastError || 'Falha no processamento assíncrono do pedido.',
                {
                  message:
                    terminalStatus?.lastError ||
                    confirmErrorSink.message ||
                    'Falha no processamento assíncrono do pedido.',
                  retryable: confirmErrorSink.retryable ?? false,
                  statusCode: confirmErrorSink.statusCode,
                }
              );
              return;
            }
            resolvedBySyncFallback = true;
          }

          if (!resolvedBySyncFallback) {
            try {
              const refreshedState = await fetchStateSnapshot();
              applyStateSnapshot(refreshedState);
            } catch (error) {
              await markJobAsFailed('Pedido confirmado, mas falhou ao atualizar estado local.', {
                error,
                message: getStateSyncErrorMessage(error),
                retryable: isRetryableSyncError(error),
                statusCode: error instanceof StateCommandSyncError ? error.statusCode : undefined,
              });
              return;
            }
          }
        }

        replacePendingPaidSyncQueue(pendingPaidSyncQueueRef.current.slice(1));
        setDraftSyncInProgress(currentJob.draftId, false);
        showCornerSync('success', 'Banco OK', 1400);
      }
    } finally {
      isPendingPaidSyncQueueRunningRef.current = false;
      if (pendingPaidSyncQueueRef.current.length === 0 && failedPaidSyncQueueRef.current.length === 0) {
        setPaidSyncAssistantState((current) => ({
          ...current,
          mode: 'idle',
          active: false,
          message: '',
          updatedAt: Date.now(),
        }));
      }
      if (pendingPaidSyncQueueRef.current.length > 0) {
        window.setTimeout(() => {
          void processPendingPaidSyncQueue();
        }, 120);
      }
    }
  }, [
    applyStateSnapshot,
    enqueueFailedPaidSyncJob,
    enqueueStateCommandAsync,
    fetchStateSnapshot,
    flushPendingDraftAdds,
    getStateCommandAsyncJob,
    handleSavePaymentMethod,
    hydratePendingPaidSyncQueue,
    isRetryableSyncError,
    isStateHydrating,
    replacePendingDraftAdds,
    replacePendingPaidSyncQueue,
    recoverPendingPaidSyncDraft,
    runCommandWithSync,
    setPaidSyncAssistantActivity,
    setDraftSyncInProgress,
    showCornerSync,
    waitForAsyncCommandJobTerminalStatus,
    showNotification,
  ]);

  useEffect(() => {
    if (!isAccessVerified || isStateHydrating) return;
    if (pendingPaidSyncJobs === 0) return;
    void processPendingPaidSyncQueue();
  }, [
    isAccessVerified,
    isStateHydrating,
    pendingPaidSyncJobs,
    processPendingPaidSyncQueue,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      if (pendingPaidSyncQueueRef.current.length === 0) return;
      void processPendingPaidSyncQueue();
    };

    window.addEventListener('online', handleOnline);
    const intervalId = window.setInterval(() => {
      if (pendingPaidSyncQueueRef.current.length === 0) return;
      void processPendingPaidSyncQueue();
    }, 10000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearInterval(intervalId);
    };
  }, [processPendingPaidSyncQueue]);

  const handleRetryFailedPaidSyncJob = useCallback(
    async (jobId: string, options: { autoRetry?: boolean } = {}) => {
      hydrateFailedPaidSyncQueue();
      const normalizedJobId = jobId.trim();
      if (!normalizedJobId) return;

      const isAutoRetry = options.autoRetry === true;
      if (!isAutoRetry) {
        clearFailedPaidSyncAutoRetryState(normalizedJobId);
      }

      const failedJob = failedPaidSyncQueueRef.current.find((entry) => entry.id === normalizedJobId);
      if (!failedJob) {
        if (!isAutoRetry) {
          showNotification('Pedido não encontrado na fila de falhas.');
        }
        return;
      }

      const serverDraft = saleDraftsRef.current.find((draft) => draft.id === failedJob.draftId);
      if (serverDraft && (serverDraft.status === 'PAID' || serverDraft.status === 'CANCELLED')) {
        replaceFailedPaidSyncQueue(
          failedPaidSyncQueueRef.current.filter((entry) => entry.id !== normalizedJobId)
        );
        clearFailedPaidSyncAutoRetryState(normalizedJobId);
        if (!isAutoRetry) {
          showNotification('Pedido já resolvido no servidor. Item removido da fila de falhas.');
        }
        return;
      }

      const isEmptyDraftFailure = isDraftEmptyErrorMessage(failedJob.lastError || '');
      if (isEmptyDraftFailure) {
        setPaidSyncAssistantActivity(
          'recovering',
          describePaidSyncAssistantMode('recovering', `pedido ${failedJob.draftId.slice(-8).toUpperCase()}`),
          {
            draftId: failedJob.draftId,
            jobId: failedJob.id,
          }
        );
        const recoveryResult = await recoverPendingPaidSyncDraft(failedJob, {
          trigger: 'failed-retry',
          failureMessage: failedJob.lastError,
        });
        if (!recoveryResult.ok) {
          reportErrorMonitorEvent({
            source: 'sistema:paid-sync:cart-restore-failed',
            level: 'error',
            message: 'Falha ao recuperar pedido da fila durante tentativa de reenfileirar.',
            statusCode: recoveryResult.statusCode,
            context: {
              trigger: 'failed-retry',
              draftId: failedJob.draftId,
              jobId: failedJob.id,
              failedAttempts: failedJob.attempts,
              lastError: failedJob.lastError || null,
              recoveryMessage: recoveryResult.message || null,
            },
          });
          if (!isAutoRetry) {
            showNotification(recoveryResult.message || 'Não foi possível recuperar este pedido automaticamente.');
          }
          return;
        }

        if (recoveryResult.reconciledOnServer) {
          replaceFailedPaidSyncQueue(
            failedPaidSyncQueueRef.current.filter((entry) => entry.id !== normalizedJobId)
          );
          clearFailedPaidSyncAutoRetryState(normalizedJobId);
          if (!isAutoRetry) {
            showNotification('Pedido já estava resolvido no servidor. Item removido da fila.');
          }
          return;
        }
      }

      replaceFailedPaidSyncQueue(
        failedPaidSyncQueueRef.current.filter((entry) => entry.id !== normalizedJobId)
      );
      enqueuePendingPaidSyncJob({
        ...failedJob,
        finalizeCommandId: createClientId('cmd'),
        confirmCommandId: createClientId('cmd'),
        attempts: 0,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
      const autoAttempt = failedPaidSyncAutoRetryAttemptsRef.current.get(normalizedJobId) || 0;
      setPaidSyncAssistantActivity(
        'retrying',
        describePaidSyncAssistantMode(
          'retrying',
          `pedido ${failedJob.draftId.slice(-8).toUpperCase()} (tentativa ${autoAttempt + 1})`
        ),
        {
          draftId: failedJob.draftId,
          jobId: failedJob.id,
        }
      );
      showCornerSync(
        'syncing',
        isAutoRetry
          ? `Robô tentando novamente (${autoAttempt + 1})...`
          : 'Pedido reenviado para a fila.',
        1800
      );
      if (!isAutoRetry) {
        showNotification('Pedido reenviado para sincronização.');
      }
      void processPendingPaidSyncQueue();
    },
    [
      clearFailedPaidSyncAutoRetryState,
      enqueuePendingPaidSyncJob,
      hydrateFailedPaidSyncQueue,
      processPendingPaidSyncQueue,
      recoverPendingPaidSyncDraft,
      replaceFailedPaidSyncQueue,
      setPaidSyncAssistantActivity,
      showCornerSync,
      showNotification,
    ]
  );

  useEffect(() => {
    if (!isAccessVerified) return;
    if (!isFailedPaidSyncQueueHydratedRef.current) return;

    const knownPersistedDraftIds = new Set<string>();
    [...sales, ...globalSales, ...globalCancelledSales].forEach((entry) => {
      const saleDraftId = typeof entry.saleDraftId === 'string' ? entry.saleDraftId.trim() : '';
      if (saleDraftId) {
        knownPersistedDraftIds.add(saleDraftId);
      }
    });

    const nextQueue = failedPaidSyncQueueRef.current.filter((job) => {
      if (knownPersistedDraftIds.has(job.draftId)) return false;
      const serverDraft = saleDraftsRef.current.find((draft) => draft.id === job.draftId);
      if (!serverDraft) return true;
      return serverDraft.status === 'DRAFT' || serverDraft.status === 'PENDING_PAYMENT';
    });

    if (nextQueue.length === failedPaidSyncQueueRef.current.length) return;
    replaceFailedPaidSyncQueue(nextQueue);
  }, [
    globalCancelledSales,
    globalSales,
    isAccessVerified,
    replaceFailedPaidSyncQueue,
    saleDrafts,
    sales,
  ]);

  useEffect(() => {
    if (!isAccessVerified) return;
    if (!isFailedPaidSyncQueueHydratedRef.current) return;

    const activeFailedIds = new Set(failedPaidSyncQueue.map((job) => job.id));
    let shouldRefreshAutoRetryUi = false;

    failedPaidSyncAutoRetryTimersRef.current.forEach((timerId, jobId) => {
      if (activeFailedIds.has(jobId)) return;
      window.clearTimeout(timerId);
      failedPaidSyncAutoRetryTimersRef.current.delete(jobId);
    });
    failedPaidSyncAutoRecoverTimersRef.current.forEach((timerId, jobId) => {
      if (activeFailedIds.has(jobId)) return;
      window.clearTimeout(timerId);
      failedPaidSyncAutoRecoverTimersRef.current.delete(jobId);
    });

    failedPaidSyncAutoRetryAttemptsRef.current.forEach((_attempts, jobId) => {
      if (activeFailedIds.has(jobId)) return;
      failedPaidSyncAutoRetryAttemptsRef.current.delete(jobId);
      shouldRefreshAutoRetryUi = true;
    });

    failedPaidSyncQueue.forEach((job) => {
      const autoAttempts = failedPaidSyncAutoRetryAttemptsRef.current.get(job.id) || 0;
      const recoverableError =
        isDraftEmptyErrorMessage(job.lastError || '') ||
        isAutoRecoverableFailedQueueMessage(job.lastError || '');
      const shouldRunRecovery = shouldPaidSyncAssistantRunRecovery(
        autoAttempts,
        recoverableError
      );

      if (shouldRunRecovery && !failedPaidSyncAutoRecoverTimersRef.current.has(job.id)) {
        const recoveryDelayMs = getPaidSyncAssistantRecoverDelayMs(autoAttempts);
        const recoveryTimerId = window.setTimeout(() => {
          const currentTimer = failedPaidSyncAutoRecoverTimersRef.current.get(job.id);
          if (currentTimer !== recoveryTimerId) return;
          failedPaidSyncAutoRecoverTimersRef.current.delete(job.id);

          const latestJob = failedPaidSyncQueueRef.current.find((entry) => entry.id === job.id);
          if (!latestJob) return;

          setPaidSyncAssistantActivity(
            'recovering',
            describePaidSyncAssistantMode(
              'recovering',
              `pedido ${latestJob.draftId.slice(-8).toUpperCase()}`
            ),
            {
              draftId: latestJob.draftId,
              jobId: latestJob.id,
            }
          );
          void (async () => {
            const recovered = await handleRecoverFailedPaidSyncJobToCart(latestJob.id, {
              silentNotification: true,
              openCart: false,
              requeueAfterRestore: true,
            });
            if (!recovered) {
              const currentAttempts =
                failedPaidSyncAutoRetryAttemptsRef.current.get(latestJob.id) || 0;
              failedPaidSyncAutoRetryAttemptsRef.current.set(latestJob.id, currentAttempts + 1);
              setFailedPaidSyncAutoRetryRevision((current) => current + 1);
              await handleRetryFailedPaidSyncJob(latestJob.id, { autoRetry: true });
              showCornerSync(
                'error',
                'Robô não reconstruiu agora. Vai tentar novamente sozinho.',
                2200
              );
            }
          })();
        }, recoveryDelayMs);

        failedPaidSyncAutoRecoverTimersRef.current.set(job.id, recoveryTimerId);
      }

      if (failedPaidSyncAutoRetryTimersRef.current.has(job.id)) return;

      const retryDelayMs = getPaidSyncAssistantRetryDelayMs(autoAttempts);
      const timerId = window.setTimeout(() => {
        const currentTimer = failedPaidSyncAutoRetryTimersRef.current.get(job.id);
        if (currentTimer !== timerId) return;
        failedPaidSyncAutoRetryTimersRef.current.delete(job.id);

        const currentAttempts =
          failedPaidSyncAutoRetryAttemptsRef.current.get(job.id) || 0;

        failedPaidSyncAutoRetryAttemptsRef.current.set(job.id, currentAttempts + 1);
        setFailedPaidSyncAutoRetryRevision((current) => current + 1);
        setPaidSyncAssistantActivity(
          'retrying',
          describePaidSyncAssistantMode(
            'retrying',
            `pedido ${job.draftId.slice(-8).toUpperCase()}`
          ),
          {
            draftId: job.draftId,
            jobId: job.id,
          }
        );
        void handleRetryFailedPaidSyncJob(job.id, { autoRetry: true });
      }, retryDelayMs);

      failedPaidSyncAutoRetryTimersRef.current.set(job.id, timerId);
    });

    if (shouldRefreshAutoRetryUi) {
      setFailedPaidSyncAutoRetryRevision((current) => current + 1);
    }
  }, [
    failedPaidSyncQueue,
    getPaidSyncAssistantRecoverDelayMs,
    getPaidSyncAssistantRetryDelayMs,
    handleRecoverFailedPaidSyncJobToCart,
    handleRetryFailedPaidSyncJob,
    isAccessVerified,
    setPaidSyncAssistantActivity,
    shouldPaidSyncAssistantRunRecovery,
    showCornerSync,
  ]);

  const openReceiptPrintWindow = useCallback(
    (receiptId: string): boolean => {
      if (typeof window === 'undefined') return false;
      const normalizedId = receiptId.trim();
      if (!normalizedId) return false;
      const printWindow = window.open(
        buildReceiptPrintRoutePath(normalizedId),
        '_blank',
        'noopener,noreferrer'
      );
      return Boolean(printWindow);
    },
    []
  );

  const prepareReceiptPrintWindow = (): Window | null => {
    if (typeof window === 'undefined') return null;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return null;
    try {
      printWindow.document.title = 'Gerando cupom...';
      if (printWindow.document.body) {
        printWindow.document.body.style.margin = '0';
        printWindow.document.body.style.padding = '18px';
        printWindow.document.body.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        printWindow.document.body.innerHTML = '<p>Gerando cupom...</p>';
      }
    } catch {
      // ignore cross-window write errors
    }
    return printWindow;
  };

  const closePreparedReceiptWindow = (printWindow: Window | null) => {
    if (!printWindow) return;
    try {
      if (!printWindow.closed) {
        printWindow.close();
      }
    } catch {
      // ignore close errors
    }
  };

  const navigatePreparedReceiptWindow = useCallback(
    (printWindow: Window | null, receiptId: string): boolean => {
      const normalizedId = receiptId.trim();
      if (!normalizedId) return false;
      const targetPath = buildReceiptPrintRoutePath(normalizedId);
      if (printWindow && !printWindow.closed) {
        try {
          printWindow.location.href = targetPath;
          return true;
        } catch {
          // fallback below
        }
      }
      return openReceiptPrintWindow(normalizedId);
    },
    [openReceiptPrintWindow]
  );

  const handleConfirmPaid = () => {
    if (!activeDraft) return;
    if (isConfirmingPaid) return;

    const draftId = activeDraft.id;
    const paymentSnapshot: PaymentCommitSnapshot = {
      draft: activeDraft,
      paymentMethod,
      saleOrigin,
      appOrderTotalInput,
      cashReceivedInput,
      splitMode,
      splitCount,
      splitCommitted: splitCommitted.map((entry) => ({ ...entry })),
      effectivePaymentTotal,
    };

    if (paymentSnapshot.draft.items.length === 0) {
      showNotification('Carrinho vazio. Não é possível finalizar.');
      return;
    }

    if (isAppSaleOrigin(paymentSnapshot.saleOrigin)) {
      const appOrderTotalParsed = parseMoneyInput(paymentSnapshot.appOrderTotalInput);
      if (appOrderTotalParsed === null || appOrderTotalParsed <= 0) {
        showNotification('Informe o valor real da venda no app (iFood/99).');
        return;
      }
    }

    if (paymentSnapshot.paymentMethod === 'DINHEIRO') {
      const cashReceivedParsed = parseMoneyInput(paymentSnapshot.cashReceivedInput);
      if (cashReceivedParsed === null || cashReceivedParsed < 0) {
        showNotification('Informe um valor recebido válido em dinheiro.');
        return;
      }
    }

    if (paymentSnapshot.paymentMethod === 'DIVIDIDO') {
      if (!paymentSnapshot.splitMode || !paymentSnapshot.splitCount) {
        showNotification('Finalize o dividido na janela de parcelas antes de confirmar.');
        return;
      }
      if (
        paymentSnapshot.splitMode === 'PEOPLE' &&
        paymentSnapshot.splitCommitted.length !== paymentSnapshot.splitCount
      ) {
        showNotification('Finalize toda a divisão antes de confirmar.');
        return;
      }
      if (
        paymentSnapshot.splitMode === 'MIXED' &&
        paymentSnapshot.splitCommitted.length < 2
      ) {
        showNotification('No dividido, informe ao menos duas parcelas (ex: PIX + dinheiro).');
        return;
      }
      const totalDividido = sumSplitAmounts(paymentSnapshot.splitCommitted);
      if (Math.abs(totalDividido - paymentSnapshot.effectivePaymentTotal) > 0.009) {
        showNotification(
          `A divisão ainda está incompleta. Restante: R$ ${formatMoney(
            Math.abs(paymentSnapshot.effectivePaymentTotal - totalDividido)
          )}`
        );
        return;
      }
    }

    const receiptPayloadInput = buildReceiptPrintPayloadFromSnapshot(paymentSnapshot, products);
    const receiptPayload: ReceiptPrintPayload | null = receiptPayloadInput
      ? saveReceiptPrintPayload(receiptPayloadInput)
      : null;
    const pendingItemsCount = pendingDraftAddsRef.current[draftId]?.length || 0;
    const preparedPrintWindow = prepareReceiptPrintWindow();
    if (receiptPayload && preparedPrintWindow) {
      setReceiptPrintPayloadOnWindow(preparedPrintWindow, receiptPayload);
    }
    const receiptPrintId = receiptPayload?.id || draftId;
    const openedPrintWindowEarly = navigatePreparedReceiptWindow(preparedPrintWindow, receiptPrintId);
    if (!openedPrintWindowEarly) {
      if (receiptPayload) {
        removeReceiptPrintPayload(receiptPayload.id);
      }
      closePreparedReceiptWindow(preparedPrintWindow);
      showNotification(
        'Não foi possível abrir o cupom agora. Use o Histórico para segunda via.'
      );
    }

    const queuedJob: PendingPaidSyncJob = {
      id: createClientId('paid-sync-job'),
      draftId,
      snapshot: clonePaymentCommitSnapshot(paymentSnapshot),
      finalizeCommandId: createClientId('cmd'),
      confirmCommandId: createClientId('cmd'),
      createdAt: new Date().toISOString(),
      attempts: 0,
    };

    setDraftSyncInProgress(draftId, true);
    setIsSaleOriginSetupOpen(false);
    setIsSplitSetupOpen(false);
    setIsPaymentOpen(false);
    setIsCartOpen(false);
    setIsConfirmingPaid(true);

    enqueuePendingPaidSyncJob(queuedJob);
    showCornerSync(
      'syncing',
      pendingItemsCount > 0
        ? `Pedido em fila. Enviando ${pendingItemsCount} item(ns)...`
        : 'Pedido em fila. Confirmando no banco...'
    );
    void processPendingPaidSyncQueue();
    setIsConfirmingPaid(false);
  };

  const handleUndoLastSale = () => {
    if (isUndoProcessing) return;
    if (sales.length === 0) {
      showNotification('Nenhuma venda para desfazer!');
      return;
    }

    const lastSale = sales[sales.length - 1];
    const salesFromSameDraft = lastSale.saleDraftId
      ? sales.filter((sale) => sale.saleDraftId === lastSale.saleDraftId)
      : [lastSale];
    const confirmLabel =
      salesFromSameDraft.length > 1
        ? `Desfazer o último pedido do carrinho (${salesFromSameDraft.length} itens) e devolver insumos ao estoque?`
        : `Desfazer a última venda (${lastSale.productName}) e devolver insumos ao estoque?`;

    if (!confirm(confirmLabel)) return;

    setIsUndoProcessing(true);
    showCornerSync(
      'syncing',
      salesFromSameDraft.length > 1
        ? `Desfazendo ${salesFromSameDraft.length} item(ns) no banco...`
        : 'Desfazendo última venda no banco...'
    );

    void (async () => {
      const ok = await runCommandWithSync(
        { type: 'SALE_UNDO_LAST' },
        undefined,
        { silentSuccessNotification: true, trackPendingState: false }
      );
      if (!ok) {
        showCornerSync('error', 'Falha ao desfazer no banco.', 4800);
        return;
      }
      showNotification('Venda Estornada!');
      showCornerSync('success', 'Estorno concluído', 2200);
    })().finally(() => {
      setIsUndoProcessing(false);
    });
  };

  const handleOpenUndoHistory = () => {
    if (recentUndoGroups.length === 0) {
      showNotification('Nenhuma venda para desfazer!');
      return;
    }
    setExpandedUndoGroupId(null);
    setIsUndoHistoryOpen(true);
  };

  const handleUndoSaleGroup = async (groupId: string) => {
    if (isUndoProcessing) return;
    const targetGroup = recentUndoGroups.find((group) => group.id === groupId);
    if (!targetGroup) {
      showNotification('Pedido não encontrado para desfazer.');
      return;
    }

    const confirmed = confirm(
      `Desfazer pedido completo?\nItens: ${targetGroup.sales.length}\nTotal: R$ ${targetGroup.total.toFixed(2)}`
    );
    if (!confirmed) return;

    setIsUndoProcessing(true);
    try {
      for (const sale of targetGroup.sales) {
        const ok = await runCommandWithSync(
          { type: 'SALE_UNDO_BY_ID', saleId: sale.id },
          undefined,
          { silentSuccessNotification: true }
        );
        if (!ok) return;
      }
      showNotification('Pedido estornado!');
      setIsUndoHistoryOpen(false);
    } finally {
      setIsUndoProcessing(false);
    }
  };

  const handlePrintReceiptByGroup = (groupId: string) => {
    const targetGroup = recentUndoGroups.find((group) => group.id === groupId);
    if (!targetGroup) {
      showNotification('Pedido não encontrado para impressão.');
      return;
    }

    const fallbackSaleId = targetGroup.sales[0]?.id;
    const receiptId = targetGroup.saleDraftId || fallbackSaleId;
    if (!receiptId) {
      showNotification('Pedido sem referência de impressão.');
      return;
    }

    const opened = openReceiptPrintWindow(receiptId);
    if (!opened) {
      showNotification('Não foi possível abrir a tela de impressão. Verifique o bloqueio de pop-up.');
    }
  };

  const handleUpdateStock = useCallback((id: string, amount: number, options: StockUpdateOptions = {}) => {
    const ingredient = ingredients.find((entry) => entry.id === id);
    const normalizedAmount = ingredient
      ? normalizeStockMovementByUnit(ingredient.unit, amount)
      : amount;
    if (!Number.isFinite(normalizedAmount) || normalizedAmount === 0) {
      return;
    }
    const useCashRegister = normalizedAmount > 0 && options.useCashRegister === true;
    const purchaseDescription = useCashRegister ? options.purchaseDescription?.trim() : undefined;
    void runCommandWithSync(
      {
        type: 'INGREDIENT_STOCK_MOVE',
        ingredientId: id,
        amount: normalizedAmount,
        useCashRegister,
        purchaseDescription,
      },
      normalizedAmount > 0
        ? useCashRegister
          ? 'Estoque atualizado e compra abatida do caixa!'
          : 'Estoque Atualizado!'
        : 'Gasto de Insumo Registrado!'
    );
  }, [ingredients, runCommandWithSync]);

  const handleRegisterCashPurchase = useCallback(
    async (
      ingredientId: string,
      purchaseAmount: number,
      purchaseDescription?: string
    ): Promise<boolean> => {
      const ingredient = ingredients.find((item) => item.id === ingredientId);
      if (!ingredient) {
        showNotification('Insumo não encontrado para compra.');
        return false;
      }

      if (!Number.isFinite(ingredient.cost) || ingredient.cost <= 0) {
        showNotification('Custo do insumo inválido para calcular entrada de estoque.');
        return false;
      }

      const normalizedPurchaseAmount = roundMoney(Math.max(0, purchaseAmount));
      if (normalizedPurchaseAmount <= 0) {
        showNotification('Valor de compra inválido.');
        return false;
      }

      const stockAmount = Number((normalizedPurchaseAmount / ingredient.cost).toFixed(6));
      const normalizedStockAmount = normalizeStockMovementByUnit(ingredient.unit, stockAmount);
      if (!Number.isFinite(normalizedStockAmount) || normalizedStockAmount <= 0) {
        showNotification('Não foi possível calcular a quantidade de estoque para essa compra.');
        return false;
      }

      return runCommandWithSync(
        {
          type: 'INGREDIENT_STOCK_MOVE',
          ingredientId,
          amount: normalizedStockAmount,
          useCashRegister: true,
          purchaseDescription: purchaseDescription?.trim() || undefined,
        },
        'Compra registrada no caixa e estoque atualizado!'
      );
    },
    [ingredients, runCommandWithSync, showNotification]
  );

  const handleRegisterCashExpense = useCallback(
    async (purchaseAmount: number, purchaseDescription: string): Promise<boolean> => {
      const normalizedPurchaseAmount = roundMoney(Math.max(0, purchaseAmount));
      if (normalizedPurchaseAmount <= 0) {
        showNotification('Valor de compra inválido.');
        return false;
      }

      const normalizedDescription = purchaseDescription.trim();
      if (!normalizedDescription) {
        showNotification('Informe o que foi comprado.');
        return false;
      }

      return runCommandWithSync(
        {
          type: 'CASH_EXPENSE',
          amount: normalizedPurchaseAmount,
          purchaseDescription: normalizedDescription,
        },
        'Saída do caixa registrada!'
      );
    },
    [runCommandWithSync, showNotification]
  );

  const handleRevertCashExpense = useCallback(
    async (entryId: string): Promise<boolean> => {
      const targetEntry = stockEntries.find((entry) => entry.id === entryId);
      if (!targetEntry) {
        showNotification('Retirada não encontrada para reverter.');
        return false;
      }

      const impact = Number(targetEntry.cashRegisterImpact);
      if (!Number.isFinite(impact) || impact >= 0) {
        showNotification('Movimentação selecionada não é uma retirada do caixa.');
        return false;
      }

      const amount = roundMoney(Math.abs(impact));
      const description = targetEntry.purchaseDescription || targetEntry.ingredientName || 'Movimentação';
      const confirmed = confirm(
        `Reverter esta retirada?\n${description}\nValor: R$ ${amount.toFixed(2)}`
      );
      if (!confirmed) return false;

      return runCommandWithSync(
        {
          type: 'CASH_EXPENSE_REVERT',
          entryId,
        },
        'Retirada revertida e valor devolvido ao caixa!'
      );
    },
    [runCommandWithSync, showNotification, stockEntries]
  );

  const handleAddProduct = (product: Product) => {
    void runCommandWithSync({ type: 'PRODUCT_CREATE', product }, 'Produto Adicionado!');
  };

  const handleEditProduct = (product: Product) => {
    setProductToEdit(product);
  };

  const handleSaveProduct = (updated: Product) => {
    void runCommandWithSync({ type: 'PRODUCT_UPDATE', product: updated }, 'Produto Atualizado!');
  };

  const handleDeleteProduct = (productId: string) => {
    if (confirm("Deseja realmente excluir este produto permanentemente?")) {
      void runCommandWithSync({ type: 'PRODUCT_DELETE', productId }, 'Produto Excluído');
    }
  };

  const handleDeleteIngredient = (ingredientId: string) => {
    if (confirm("ATENÇÃO: Excluir este ingrediente irá impactar as receitas que o utilizam. Tem certeza que deseja remover?")) {
      void runCommandWithSync({ type: 'INGREDIENT_DELETE', ingredientId }, 'Ingrediente Removido');
    }
  };

  const handleAddIngredient = (ingredient: Ingredient) => {
    const normalizedIngredient = normalizeIngredientStockByUnit(ingredient);
    void runCommandWithSync(
      { type: 'INGREDIENT_CREATE', ingredient: normalizedIngredient },
      'Ingrediente Adicionado!'
    );
  };

  const handleEditIngredient = (ingredient: Ingredient) => {
    setIngredientToEdit(ingredient);
  };

  const handleSaveIngredient = (updated: Ingredient) => {
    const normalizedIngredient = normalizeIngredientStockByUnit(updated);
    void runCommandWithSync(
      { type: 'INGREDIENT_UPDATE', ingredient: normalizedIngredient },
      'Ingrediente Atualizado!'
    );
  };

  const handleAddCleaningMaterial = (material: CleaningMaterial) => {
    const normalizedMaterial = normalizeCleaningMaterialStockByUnit(material);
    void runCommandWithSync(
      { type: 'CLEANING_MATERIAL_CREATE', material: normalizedMaterial },
      'Material de limpeza adicionado!'
    );
  };

  const handleUpdateCleaningMaterial = (updated: CleaningMaterial) => {
    const normalizedMaterial = normalizeCleaningMaterialStockByUnit(updated);
    void runCommandWithSync(
      { type: 'CLEANING_MATERIAL_UPDATE', material: normalizedMaterial },
      'Material de limpeza atualizado!'
    );
  };

  const handleDeleteCleaningMaterial = (materialId: string) => {
    void runCommandWithSync(
      { type: 'CLEANING_MATERIAL_DELETE', materialId },
      'Material de limpeza removido!'
    );
  };

  const handleUpdateCleaningStock = useCallback((id: string, amount: number) => {
    const material = cleaningMaterials.find((entry) => entry.id === id);
    const normalizedAmount = material
      ? normalizeStockMovementByUnit(material.unit, amount)
      : amount;
    if (!Number.isFinite(normalizedAmount) || normalizedAmount === 0) {
      return;
    }
    void runCommandWithSync(
      {
        type: 'CLEANING_STOCK_MOVE',
        materialId: id,
        amount: normalizedAmount,
      },
      normalizedAmount > 0 ? 'Estoque de material atualizado!' : 'Baixa de material registrada!'
    );
  }, [cleaningMaterials, runCommandWithSync]);

  const buildCurrentCloseDayReport = useCallback((): DailySalesHistoryEntry => {
    const totalRevenue = roundMoney(
      sales.reduce(
        (sum, sale) => sum + (Number.isFinite(sale.total) ? sale.total : 0),
        0
      )
    );
    const totalPurchases = roundMoney(
      sales.reduce(
        (sum, sale) => sum + (Number.isFinite(sale.totalCost) ? sale.totalCost : 0),
        0
      )
    );
    const cashExpenses = calculateCashRegisterExpensesFromStockEntries(stockEntries);
    const openingCash = roundMoney(Math.max(0, cashRegisterAmount));

    return {
      id: createClientId('day'),
      closedAt: new Date().toISOString(),
      openingCash,
      totalRevenue,
      totalPurchases,
      totalProfit: roundMoney(totalRevenue - totalPurchases),
      saleCount: countSaleOrders(sales),
      cashExpenses,
    };
  }, [cashRegisterAmount, sales, stockEntries]);

  const persistLocalCloseDayReport = useCallback((report: DailySalesHistoryEntry) => {
    const normalizedReport = normalizeDailyHistoryEntry(report);
    if (!normalizedReport) return;

    const nextHistory = [...readLocalDailySalesHistory(), normalizedReport];
    writeLocalDailySalesHistory(nextHistory);
    writeLocalCashRegisterAmount(0);
    setDailySalesHistory(nextHistory);
    setCashRegisterAmount(0);
  }, []);

  const closeDayWithLegacyFallback = useCallback(
    async (successMessage = 'Sessão Reiniciada!'): Promise<boolean> => {
      const report = buildCurrentCloseDayReport();
      const clearResult = await executeSyncedCommand({ type: 'CLEAR_HISTORY' });

      if (!clearResult.ok) {
        showNotification(getStateSyncErrorMessage(clearResult.error));
        return false;
      }

      persistLocalCloseDayReport(report);
      showNotification(successMessage);
      return true;
    },
    [
      buildCurrentCloseDayReport,
      executeSyncedCommand,
      persistLocalCloseDayReport,
      showNotification,
    ]
  );

  const handleSetCashRegister = useCallback(
    async (amount: number): Promise<boolean> => {
      const normalizedAmount = roundMoney(Math.max(0, amount));

      if (isCashHistoryLegacyMode) {
        writeLocalCashRegisterAmount(normalizedAmount);
        setCashRegisterAmount(normalizedAmount);
        return true;
      }

      const result = await executeSyncedCommand({
        type: 'SET_CASH_REGISTER',
        amount: normalizedAmount,
      });

      if (result.ok) {
        return true;
      }

      if (!isUnsupportedCashHistoryCommandError(result.error)) {
        showNotification(getStateSyncErrorMessage(result.error));
        return false;
      }

      enableCashHistoryLegacyMode();
      writeLocalCashRegisterAmount(normalizedAmount);
      setCashRegisterAmount(normalizedAmount);
      showNotification('Servidor antigo detectado. Caixa salvo localmente.');
      return true;
    },
    [
      enableCashHistoryLegacyMode,
      executeSyncedCommand,
      isCashHistoryLegacyMode,
      showNotification,
    ]
  );

  const handleCloseDay = useCallback(async (): Promise<boolean> => {
    if (isCashHistoryLegacyMode) {
      return closeDayWithLegacyFallback();
    }

    const closeResult = await executeSyncedCommand({ type: 'CLOSE_DAY' });

    if (closeResult.ok) {
      showNotification('Sessão Reiniciada!');
      return true;
    }

    if (!isUnsupportedCashHistoryCommandError(closeResult.error)) {
      showNotification(getStateSyncErrorMessage(closeResult.error));
      return false;
    }

    enableCashHistoryLegacyMode();
    return closeDayWithLegacyFallback(
      'Servidor antigo detectado. Fechamento salvo localmente.'
    );
  }, [
    closeDayWithLegacyFallback,
    enableCashHistoryLegacyMode,
    executeSyncedCommand,
    isCashHistoryLegacyMode,
    showNotification,
  ]);

  const handleFactoryReset = async () => {
    const ok = await runCommandWithSync({ type: 'FACTORY_RESET' }, 'Sistema Resetado com Sucesso!');
    if (ok) {
      setView(ViewMode.POS);
    }
  };

  const handleClearOperationalData = () => {
    void runCommandWithSync(
      { type: 'CLEAR_OPERATIONAL_DATA' },
      'Dados operacionais limpos. Cadastros preservados.'
    );
  };

  const handleClearOnlyStock = () => {
    void runCommandWithSync(
      { type: 'CLEAR_ONLY_STOCK' },
      'Estoque zerado. Cadastros e valores preservados.'
    );
  };

  const handleDeleteArchiveByDate = (dateString: string) => {
    const saleIds = globalSales
      .filter((sale) => sale.timestamp.toLocaleDateString('pt-BR') === dateString)
      .map((sale) => sale.id);

    if (saleIds.length === 0) {
      showNotification('Nenhum arquivo encontrado para a data selecionada.');
      return;
    }

    void runCommandWithSync(
      { type: 'DELETE_ARCHIVE_SALES', saleIds },
      `Arquivos de ${dateString} Excluídos!`
    );
  };

  const handleDeleteArchiveByMonth = (monthString: string) => {
    const saleIds = globalSales
      .filter(
        (sale) =>
          sale.timestamp.toLocaleString('pt-BR', { month: 'long', year: 'numeric' }) === monthString
      )
      .map((sale) => sale.id);

    if (saleIds.length === 0) {
      showNotification('Nenhum arquivo encontrado para o mês selecionado.');
      return;
    }

    void runCommandWithSync(
      { type: 'DELETE_ARCHIVE_SALES', saleIds },
      `Arquivos de ${monthString} Excluídos!`
    );
  };

  const dailyTotal = useMemo(() => sales.reduce((acc, sale) => acc + sale.total, 0), [sales]);
  const isDailyTotalSyncing = pendingPaidSyncJobs > 0 || syncingPaidDraftIds.length > 0;
  const todaySaleDayKey = new Date().toLocaleDateString('pt-BR');
  const recentSalesForUndo = useMemo(
    () =>
      sales
        .filter((sale) => getSaleDayKey(sale.timestamp) === todaySaleDayKey)
        .slice()
        .reverse(),
    [sales, todaySaleDayKey]
  );
  const recentUndoGroups = useMemo<UndoSaleGroup[]>(() => {
    const groupOrder: UndoSaleGroup[] = [];
    const groupsById = new Map<string, UndoSaleGroup>();

    recentSalesForUndo.forEach((sale) => {
      const key = sale.saleDraftId ? `draft-${sale.saleDraftId}` : `sale-${sale.id}`;
      const existing = groupsById.get(key);
      if (existing) {
        existing.sales.push(sale);
        existing.total += sale.total;
        existing.totalCost += sale.totalCost || 0;
        return;
      }

      const group: UndoSaleGroup = {
        id: key,
        saleDraftId: sale.saleDraftId || null,
        sales: [sale],
        timestamp: sale.timestamp,
        total: sale.total,
        totalCost: sale.totalCost || 0,
      };
      groupsById.set(key, group);
      groupOrder.push(group);
    });

    return groupOrder;
  }, [recentSalesForUndo]);
  const parsedAppOrderTotalInput = useMemo(
    () => parseMoneyInput(appOrderTotalInput),
    [appOrderTotalInput]
  );
  const paymentAppOrderTotal = useMemo(() => {
    if (!activeDraft) return null;
    if (!isAppSaleOrigin(saleOrigin)) return null;
    const parsed = parsedAppOrderTotalInput;
    if (parsed !== null && parsed > 0) return parsed;
    if (typeof activeDraft.appOrderTotal === 'number' && activeDraft.appOrderTotal > 0) {
      return activeDraft.appOrderTotal;
    }
    return activeDraft.total;
  }, [activeDraft, parsedAppOrderTotalInput, saleOrigin]);
  const effectivePaymentTotal = paymentAppOrderTotal ?? activeDraft?.total ?? 0;
  const paymentCashReceived = useMemo(() => {
    if (paymentMethod !== 'DINHEIRO') return null;
    return parseMoneyInput(cashReceivedInput);
  }, [cashReceivedInput, paymentMethod]);
  const paymentCashDelta = useMemo(() => {
    if (paymentMethod !== 'DINHEIRO' || !activeDraft) return null;
    if (paymentCashReceived === null) return null;
    return paymentCashReceived - effectivePaymentTotal;
  }, [activeDraft, effectivePaymentTotal, paymentCashReceived, paymentMethod]);
  const splitPaidAmount = useMemo(() => sumSplitAmounts(splitCommitted), [splitCommitted]);
  const splitRemainingAmount = useMemo(
    () => roundMoney(Math.max(0, effectivePaymentTotal - splitPaidAmount)),
    [effectivePaymentTotal, splitPaidAmount]
  );
  const splitCurrentFixedAmount =
    splitMode === 'PEOPLE' ? roundMoney(splitAutoAllocations[splitCurrentIndex] || 0) : null;
  const splitCurrentAmount =
    splitMode === 'PEOPLE' ? splitCurrentFixedAmount : parseMoneyInput(splitCurrentAmountInput);
  const splitCurrentCashReceived =
    splitCurrentMethod === 'DINHEIRO' ? parseMoneyInput(splitCurrentCashReceivedInput) : null;
  const splitCurrentCashDelta = useMemo(() => {
    if (splitCurrentMethod !== 'DINHEIRO') return null;
    if (splitCurrentAmount === null) return null;
    if (splitCurrentCashReceived === null) return null;
    return splitCurrentCashReceived - splitCurrentAmount;
  }, [splitCurrentAmount, splitCurrentCashReceived, splitCurrentMethod]);
  const isSplitPlanComplete = useMemo(() => {
    if (paymentMethod !== 'DIVIDIDO') return true;
    if (!splitMode || !splitCount) return false;
    if (splitMode === 'PEOPLE') {
      return splitCommitted.length === splitCount && splitRemainingAmount <= 0.009;
    }
    return splitCommitted.length >= 2 && splitRemainingAmount <= 0.009;
  }, [paymentMethod, splitMode, splitCount, splitCommitted.length, splitRemainingAmount]);
  const isSplitCurrentStepReady = useMemo(() => {
    if (!splitMode || !splitCount) return false;
    if (splitMode === 'PEOPLE') {
      if (splitCurrentIndex >= splitCount) return false;
      const stepAmount = roundMoney(splitAutoAllocations[splitCurrentIndex] || 0);
      if (stepAmount <= 0) return false;
      if (splitCurrentMethod !== 'DINHEIRO') return true;
      return splitCurrentCashReceived !== null && splitCurrentCashReceived >= stepAmount;
    }

    if (splitRemainingAmount <= 0.009) return false;
    if (splitCurrentAmount === null || splitCurrentAmount <= 0) return false;
    if (splitCurrentAmount > splitRemainingAmount + 0.009) return false;
    if (splitCommitted.length === 0 && splitCurrentAmount >= splitRemainingAmount - 0.009) return false;
    if (splitCurrentMethod !== 'DINHEIRO') return true;
    return splitCurrentCashReceived !== null && splitCurrentCashReceived >= splitCurrentAmount;
  }, [
    splitMode,
    splitCount,
    splitCurrentIndex,
    splitAutoAllocations,
    splitCurrentMethod,
    splitCurrentCashReceived,
    splitRemainingAmount,
    splitCurrentAmount,
    splitCommitted.length,
  ]);
  const isAppSaleOriginActive = isAppSaleOrigin(saleOrigin);
  const paymentOriginMorphClass =
    paymentOriginFxTick >= 0
      ? paymentOriginFxTick % 2 === 0
        ? 'qb-payment-origin-morph-a'
        : 'qb-payment-origin-morph-b'
      : '';
  const paymentOriginIconClass =
    paymentOriginFxTick >= 0
      ? paymentOriginFxTick % 2 === 0
        ? 'qb-payment-origin-icon-pop-a'
        : 'qb-payment-origin-icon-pop-b'
      : '';
  const paymentOriginShortLabel =
    saleOrigin === 'IFOOD' ? 'IF' : saleOrigin === 'APP99' ? '99' : saleOrigin === 'KEETA' ? 'KT' : 'LC';
  const paymentOriginNameLabel =
    saleOrigin === 'IFOOD'
      ? 'iFood'
      : saleOrigin === 'APP99'
        ? '99'
        : saleOrigin === 'KEETA'
          ? 'Keeta'
          : 'Balcão';
  const paymentOriginToneClass =
    saleOrigin === 'IFOOD'
      ? 'border-red-700 bg-red-600 text-white shadow-red-200'
      : saleOrigin === 'APP99'
        ? 'border-yellow-500 bg-yellow-400 text-slate-900 shadow-yellow-200'
        : 'border-emerald-600 bg-emerald-500 text-white shadow-emerald-200';
  const paymentOriginFieldClass =
    saleOrigin === 'IFOOD'
      ? 'border-red-200 bg-gradient-to-r from-red-50 via-white to-red-50 shadow-red-100'
      : saleOrigin === 'APP99'
        ? 'border-yellow-300 bg-gradient-to-r from-amber-50 via-white to-yellow-50 shadow-yellow-100'
        : 'border-emerald-300 bg-gradient-to-r from-emerald-50 via-white to-teal-50 shadow-emerald-100';
  const paymentOriginBarClass =
    saleOrigin === 'IFOOD' ? 'bg-red-500' : saleOrigin === 'APP99' ? 'bg-yellow-500' : 'bg-emerald-500';
  const isCashPaymentInsufficient =
    paymentMethod === 'DINHEIRO' &&
    (paymentCashReceived === null || (paymentCashDelta !== null && paymentCashDelta < 0));
  const isSplitPaymentIncomplete = paymentMethod === 'DIVIDIDO' && !isSplitPlanComplete;
  const isAppOrderTotalInvalid =
    isAppSaleOriginActive &&
    (parsedAppOrderTotalInput === null || parsedAppOrderTotalInput <= 0);
  const isPaymentActionBlocked =
    isConfirmingPaid || isStateHydrating || pendingStateOps > 0;
  const isConfirmPaidDisabled =
    isCashPaymentInsufficient ||
    isSplitPaymentIncomplete ||
    (isAppSaleOriginActive && isAppOrderTotalInvalid) ||
    isPaymentActionBlocked;
  const isSplitMethodSelectionLocked = paymentMethod === 'DIVIDIDO';
  const isSplitConfirmReady = paymentMethod === 'DIVIDIDO' && isSplitPlanComplete && !isConfirmPaidDisabled;
  const paidSyncQueueCards = useMemo(
    () => {
      const nowMs = Date.now();
      const syncingSet = new Set(syncingPaidDraftIds);
      const activeCards = pendingPaidSyncQueueSnapshot.map((job, index) => {
        const retryAtMs = job.nextAttemptAt ? Date.parse(job.nextAttemptAt) : Number.NaN;
        const isWaitingRetry = Number.isFinite(retryAtMs) && retryAtMs > nowMs;
        const isProcessing = syncingSet.has(job.draftId) && index === 0 && !isWaitingRetry;
        const status: 'PROCESSING' | 'QUEUED' | 'RETRY' = isProcessing
          ? 'PROCESSING'
          : isWaitingRetry
            ? 'RETRY'
            : 'QUEUED';
        const retryInSeconds =
          isWaitingRetry && Number.isFinite(retryAtMs)
            ? Math.max(1, Math.ceil((retryAtMs - nowMs) / 1000))
            : null;
        return {
          id: job.id,
          draftId: job.draftId,
          status,
          retryInSeconds,
          attempts: job.attempts,
          lastError: job.lastError || null,
          isFailed: false,
          autoRetryAttempts: 0,
          autoRetryPending: false,
          assistantLabel: null as string | null,
        };
      });

      const failedCards = failedPaidSyncQueue.map((job) => {
        const autoRetryAttempts =
          failedPaidSyncAutoRetryAttemptsRef.current.get(job.id) || 0;
        const recoverableError =
          isDraftEmptyErrorMessage(job.lastError || '') ||
          isAutoRecoverableFailedQueueMessage(job.lastError || '');
        const shouldRecoverSoon = shouldPaidSyncAssistantRunRecovery(
          autoRetryAttempts,
          recoverableError
        );
        const assistantLabel = shouldRecoverSoon
          ? 'Robô: reconstruindo snapshot'
          : 'Robô: nova tentativa automática';
        return {
          id: job.id,
          draftId: job.draftId,
          status: 'FAILED' as const,
          retryInSeconds: null,
          attempts: job.attempts,
          lastError: job.lastError || null,
          isFailed: true,
          autoRetryAttempts,
          autoRetryPending:
            failedPaidSyncAutoRetryTimersRef.current.has(job.id) ||
            failedPaidSyncAutoRecoverTimersRef.current.has(job.id),
          assistantLabel,
        };
      });

      return [...activeCards, ...failedCards].slice(0, PAID_SYNC_QUEUE_PREVIEW_LIMIT);
    },
    [
      failedPaidSyncAutoRetryRevision,
      failedPaidSyncQueue,
      pendingPaidSyncQueueSnapshot,
      shouldPaidSyncAssistantRunRecovery,
      syncingPaidDraftIds,
    ]
  );
  const hasPaidSyncQueueCards = paidSyncQueueCards.length > 0;
  const cornerSyncToneClass =
    cornerSyncState.status === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : cornerSyncState.status === 'error'
        ? 'border-red-200 bg-red-50 text-red-700'
        : 'border-slate-200 bg-white/95 text-slate-600';
  const cornerSyncDotClass =
    cornerSyncState.status === 'success'
      ? 'bg-emerald-500'
      : cornerSyncState.status === 'error'
        ? 'bg-red-500'
        : 'bg-slate-400';

  useEffect(() => {
    if (!isPaymentOpen || !isAppSaleOriginActive) return;
    const timeoutId = window.setTimeout(() => {
      appOrderTotalInputRef.current?.focus();
      appOrderTotalInputRef.current?.select();
    }, 40);
    return () => window.clearTimeout(timeoutId);
  }, [isAppSaleOriginActive, isPaymentOpen, paymentOriginFxTick, saleOrigin]);

  useEffect(() => {
    if (!isSplitSetupOpen) return;
    if (splitCommitted.length !== 0) return;
    const timeoutId = window.setTimeout(() => {
      splitCurrentAmountInputRef.current?.focus();
      splitCurrentAmountInputRef.current?.select();
    }, 40);
    return () => window.clearTimeout(timeoutId);
  }, [isSplitSetupOpen, splitCommitted.length]);

  useEffect(() => {
    if (!isUndoHistoryOpen) return;
    if (recentUndoGroups.length === 0 || view !== ViewMode.POS) {
      setIsUndoHistoryOpen(false);
    }
  }, [isUndoHistoryOpen, recentUndoGroups.length, view]);

  useEffect(() => {
    if (!isUndoHistoryOpen) {
      if (expandedUndoGroupId !== null) {
        setExpandedUndoGroupId(null);
      }
      return;
    }
    if (expandedUndoGroupId && !recentUndoGroups.some((group) => group.id === expandedUndoGroupId)) {
      setExpandedUndoGroupId(null);
    }
  }, [expandedUndoGroupId, isUndoHistoryOpen, recentUndoGroups]);

  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      const matchesCategory = activeCategory === 'All' || p.category === activeCategory;
      const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [products, activeCategory, searchQuery]);

  const categories = ['All', 'Snack', 'Drink', 'Side', 'Combo'];
  const categoryLabels: Record<string, string> = {
    'All': 'Todos',
    'Snack': 'Lanches',
    'Drink': 'Bebidas',
    'Side': 'Extras',
    'Combo': 'Combos',
  };

  if (!isAccessVerified) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <p className="font-black uppercase tracking-widest text-xs">Validando acesso...</p>
      </div>
    );
  }

  return (
    <div className="qb-app min-h-screen bg-slate-50 flex flex-col">
      <Header
        currentView={view}
        setView={setView}
        dailyTotal={dailyTotal}
        isDailyTotalSyncing={isDailyTotalSyncing}
      />
      <SyncStatusOverlay
        visible={isSyncIndicatorVisible}
        message={syncIndicatorMessage}
        pendingCount={Math.max(1, totalPendingOps)}
      />
      <div className="pointer-events-none fixed bottom-3 right-3 z-[1190] flex w-[220px] flex-col items-end gap-1.5">
        {hasPaidSyncQueueCards && (
          <div className="pointer-events-auto w-full rounded-xl border border-slate-200 bg-white/95 p-1.5 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between px-0.5 text-[9px] font-black uppercase tracking-widest text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span aria-hidden="true">🤖</span>
                Fila
              </span>
              <span>{paidSyncQueueCards.length}</span>
            </div>
            {paidSyncAssistantState.active && (
              <div className="mt-1 flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-sky-700">
                <span aria-hidden="true" className="qb-corner-sync-pulse">🤖</span>
                <span className="truncate">
                  {paidSyncAssistantState.message || 'Robô atuando'}
                </span>
              </div>
            )}
            <div className="mt-1 max-h-[170px] space-y-1 overflow-y-auto">
              {paidSyncQueueCards.map((card) => {
                const draftShort = card.draftId.replace(/^draft-/, '').slice(-8).toUpperCase() || '---';
                const statusToneClass =
                  card.status === 'FAILED'
                    ? 'border-red-200 bg-red-50 text-red-700'
                    : card.status === 'PROCESSING'
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : card.status === 'RETRY'
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-slate-200 bg-slate-50 text-slate-700';
                const statusLabel =
                  card.status === 'FAILED'
                    ? 'Falhou'
                    : card.status === 'PROCESSING'
                      ? 'Sincronizando'
                      : card.status === 'RETRY'
                        ? card.retryInSeconds
                          ? `Nova tentativa em ${card.retryInSeconds}s`
                          : 'Aguardando nova tentativa'
                        : 'Na fila';

                return (
                  <div key={card.id} className={`rounded-lg border px-1.5 py-1 text-[9px] ${statusToneClass}`}>
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate font-black uppercase tracking-wide">Pedido {draftShort}</span>
                      <span className="shrink-0 font-black uppercase tracking-wide">{statusLabel}</span>
                    </div>
                    {card.assistantLabel && (
                      <p className="mt-0.5 truncate text-[8px] font-black uppercase tracking-wide text-current/75">
                        {card.assistantLabel}
                      </p>
                    )}
                    {(card.lastError || card.attempts > 0) && (
                      <p className="mt-0.5 truncate text-[8px] font-bold uppercase tracking-wide text-current/80">
                        {card.lastError || `Tentativas: ${card.attempts}`}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div
          aria-live="polite"
          aria-hidden={!cornerSyncState.visible}
          className={`transition-all duration-300 ${
            cornerSyncState.visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
          }`}
        >
          <div
            className={`inline-flex max-w-[220px] items-center gap-2 rounded-full border px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider shadow-sm ${cornerSyncToneClass}`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                cornerSyncState.status === 'syncing' ? 'qb-corner-sync-pulse' : ''
              } ${cornerSyncDotClass}`}
            />
            <span className="truncate">{cornerSyncState.message || 'Sincronizando'}</span>
          </div>
        </div>
      </div>
      
      <main className="qb-main flex-1 pb-20">
        {view === ViewMode.POS && (
          <div className="qb-pos max-w-7xl mx-auto p-4 space-y-6 animate-in fade-in duration-500">
            <div className="qb-pos-toolbar flex flex-col md:flex-row gap-4 items-center justify-between bg-white p-4 rounded-[32px] shadow-sm border border-slate-100">
              <div className="qb-pos-categories flex bg-slate-100 p-1.5 rounded-2xl gap-1 w-full md:w-auto overflow-x-auto scrollbar-hide">
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setActiveCategory(cat)}
                    className={`qb-btn-touch px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all whitespace-nowrap ${activeCategory === cat ? 'bg-red-600 text-white shadow-lg shadow-red-200' : 'text-slate-500 hover:bg-slate-200'}`}
                  >
                    {categoryLabels[cat]}
                  </button>
                ))}
              </div>

              <div className="qb-pos-actions flex gap-2 w-full md:w-auto items-center">
                <div className="relative">
                  {cartEntryFx && (
                    <span
                      key={cartEntryFx.id}
                      className="qb-cart-entry-chip pointer-events-none absolute -top-3 right-1 z-20 inline-flex items-center rounded-full bg-yellow-300 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-red-800 shadow-lg border border-yellow-400"
                    >
                      +1 {cartEntryFx.label}
                    </span>
                  )}
                  <button
                    onClick={handleOpenCart}
                    className={`qb-btn-touch relative w-full overflow-hidden bg-gradient-to-r from-red-600 via-rose-600 to-orange-500 text-white px-4 py-3 rounded-2xl font-black text-[10px] uppercase tracking-tighter shadow-xl hover:brightness-110 active:scale-95 transition-all whitespace-nowrap border border-red-500/60 ${
                      cartBumpTick >= 0
                        ? cartBumpTick % 2 === 0
                          ? 'qb-cart-button-bump-a'
                          : 'qb-cart-button-bump-b'
                        : ''
                    }`}
                    title="Ver carrinho e finalizar pagamento"
                  >
                    <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/10 to-white/10" />
                    <span className="relative flex items-center gap-2">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="8" cy="20" r="1.5" />
                        <circle cx="18" cy="20" r="1.5" />
                        <path d="M2 3h2l2.4 11.5a2 2 0 0 0 2 1.5h9.8a2 2 0 0 0 2-1.6L22 7H7" />
                      </svg>
                      <span>Carrinho</span>
                      <span
                        className={`inline-flex min-w-6 h-6 items-center justify-center rounded-full bg-white text-red-700 px-2 text-[10px] font-black shadow-md ${
                          cartBumpTick >= 0
                            ? cartBumpTick % 2 === 0
                              ? 'qb-cart-count-pop-a'
                              : 'qb-cart-count-pop-b'
                            : ''
                        }`}
                      >
                        {activeDraftItemCount}
                      </span>
                    </span>
                  </button>
                </div>
                <button 
                  onClick={handleUndoLastSale}
                  disabled={sales.length === 0 || isUndoProcessing}
                  className="qb-btn-touch bg-slate-900 text-yellow-400 px-5 py-3 rounded-2xl font-black text-[10px] uppercase tracking-tighter shadow-xl hover:bg-black active:scale-95 transition-all disabled:opacity-30 disabled:grayscale disabled:scale-100 whitespace-nowrap flex items-center gap-2 group"
                  title={isUndoProcessing ? 'Desfazendo no banco...' : 'Desfazer o último pedido'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="group-hover:-rotate-45 transition-transform"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  {isUndoProcessing ? 'Desfazendo...' : 'Desfazer Última'}
                </button>
                <button
                  onClick={handleOpenUndoHistory}
                  disabled={recentUndoGroups.length === 0 || isUndoProcessing}
                  className="qb-btn-touch bg-white text-slate-800 px-4 py-3 rounded-2xl font-black text-[10px] uppercase tracking-tighter shadow-sm border border-slate-200 hover:border-red-400 hover:text-red-600 active:scale-95 transition-all disabled:opacity-30 disabled:grayscale disabled:scale-100 whitespace-nowrap flex items-center gap-2"
                  title="Selecionar venda no histórico para desfazer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
                  Histórico do Dia
                </button>

                <div className="qb-pos-search relative flex-1 md:w-64">
                  <input 
                    type="text"
                    placeholder="Buscar..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-100 border-none rounded-2xl px-5 py-3 pl-11 font-bold text-slate-800 focus:ring-2 focus:ring-red-500"
                  />
                  <svg className="absolute left-4 top-3.5 text-slate-400" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                </div>
              </div>
            </div>

            <div className="qb-product-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6">
              {filteredProducts.map(product => (
                <ProductCard 
                  key={product.id}
                  product={product} 
                  onSale={handleSale} 
                  allIngredients={ingredientsForSale}
                  onDelete={handleDeleteProduct}
                  onEdit={handleEditProduct}
                />
              ))}
              
              <button 
                onClick={() => setIsAddProductModalOpen(true)}
                className="qb-add-product-card qb-btn-touch group bg-white hover:bg-slate-50 border-4 border-dashed border-slate-200 rounded-[40px] flex flex-col items-center justify-center p-6 transition-all hover:scale-95 active:scale-90 aspect-square min-h-[180px]"
              >
                <div className="bg-slate-100 p-5 rounded-3xl mb-3 group-hover:bg-red-50 group-hover:scale-110 transition-all">
                   <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                </div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest group-hover:text-red-600">Novo Produto</span>
              </button>
            </div>
          </div>
        )}

        {view === ViewMode.INVENTORY && (
          <InventoryManager 
            ingredients={ingredients} 
            entries={stockEntries} 
            onUpdateStock={handleUpdateStock} 
            onOpenAddIngredient={() => setIsAddIngredientModalOpen(true)}
            onEditIngredient={handleEditIngredient}
            onDeleteIngredient={handleDeleteIngredient}
          />
        )}

        {view === ViewMode.REPORTS && (
          <SalesSummary 
            sales={sales} 
            archivedSales={globalSales}
            allIngredients={ingredients} 
            stockEntries={stockEntries}
            cashRegisterAmount={cashRegisterAmount}
            dailySalesHistory={dailySalesHistory}
            onSetCashRegister={handleSetCashRegister}
            onCloseDay={handleCloseDay}
            onRegisterCashPurchase={handleRegisterCashPurchase}
            onRegisterCashExpense={handleRegisterCashExpense}
            onRevertCashExpense={handleRevertCashExpense}
          />
        )}

        {view === ViewMode.OTHERS && (
          <CleaningMaterialsManager
            materials={cleaningMaterials}
            entries={cleaningStockEntries}
            onAddMaterial={handleAddCleaningMaterial}
            onUpdateMaterial={handleUpdateCleaningMaterial}
            onDeleteMaterial={handleDeleteCleaningMaterial}
            onUpdateStock={handleUpdateCleaningStock}
          />
        )}

        {view === ViewMode.ADMIN && (
          !isAdminAuthenticated ? (
            <AdminLogin onLogin={handleAdminLogin} />
          ) : (
            <AdminDashboard 
              sales={globalSales} 
              cancelledSales={globalCancelledSales} 
              stockEntries={globalStockEntries} 
              sessionStockEntries={stockEntries}
              allProducts={products}
              allIngredients={ingredients}
              cleaningMaterials={cleaningMaterials}
              cleaningStockEntries={globalCleaningStockEntries}
              onFactoryReset={handleFactoryReset}
              onClearOperationalData={handleClearOperationalData}
              onClearOnlyStock={handleClearOnlyStock}
              onDeleteArchiveDate={handleDeleteArchiveByDate}
              onDeleteArchiveMonth={handleDeleteArchiveByMonth}
              cashRegisterAmount={cashRegisterAmount}
              dailySalesHistory={dailySalesHistory}
            />
          )
        )}
      </main>

      {isCartOpen && (
        <div className="fixed inset-0 z-[215] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-white rounded-[36px] border-2 border-slate-100 shadow-2xl overflow-hidden">
            <div className="p-5 bg-red-600 text-white flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xl font-black uppercase tracking-tight">Carrinho</h3>
                <p className="text-[10px] uppercase tracking-widest text-red-100">
                  DRAFT reserva estoque localmente. Baixa oficial só em PAID.
                </p>
              </div>
              <button
                onClick={() => setIsCartOpen(false)}
                className="qb-btn-touch bg-red-700 hover:bg-red-800 p-2 rounded-full transition-colors"
                title="Fechar"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>

            <div className="p-4 border-b border-slate-100 bg-slate-50 flex flex-wrap items-center gap-2">
              <select
                value={activeDraft?.id || ''}
                onChange={(e) => setActiveDraftId(e.target.value || null)}
                className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-black uppercase tracking-widest text-slate-700"
              >
                {openSaleDrafts.length === 0 && <option value="">Nenhuma venda aberta</option>}
                {openSaleDrafts.map((draft) => (
                  <option key={draft.id} value={draft.id}>
                    {draft.customerType || 'BALCAO'} • {getSaleOriginLabel(draft.saleOrigin || 'LOCAL')} •{' '}
                    {draft.status} • R$ {formatMoney(draft.total)}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleCreateNewDraft('BALCAO')}
                className="qb-btn-touch bg-green-600 text-white px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-green-700 transition-colors"
              >
                Novo Balcão
              </button>
              <button
                onClick={() => handleCreateNewDraft('ENTREGA')}
                className="qb-btn-touch bg-emerald-700 text-white px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-emerald-800 transition-colors"
              >
                Nova Entrega
              </button>
            </div>

            {!activeDraft && (
              <div className="p-8 text-center text-slate-500 text-xs font-black uppercase tracking-widest">
                Sem carrinho aberto.
              </div>
            )}

            {activeDraft && (
              <>
                <div className="p-4 bg-white border-b border-slate-100 flex flex-wrap items-center gap-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Atendimento
                  </label>
                  <select
                    value={activeDraft.customerType || 'BALCAO'}
                    onChange={(e) => handleUpdateDraftCustomerType(e.target.value as SaleCustomerType)}
                    disabled={activeDraft.status === 'PAID' || activeDraft.status === 'CANCELLED'}
                    className="bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 text-xs font-black uppercase tracking-widest text-slate-700"
                  >
                    <option value="BALCAO">Balcão</option>
                    <option value="ENTREGA">Entrega</option>
                  </select>
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 px-2 py-1 rounded-lg bg-slate-100 border border-slate-200">
                    Status: {activeDraft.status}
                  </span>
                  {activeDraft.status === 'PENDING_PAYMENT' && (
                    <span className="text-[10px] font-black uppercase tracking-widest text-yellow-700 px-2 py-1 rounded-lg bg-yellow-100 border border-yellow-300">
                      Aguardando confirmação de pagamento
                    </span>
                  )}
                  <span
                    className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-lg border ${
                      activeDraft.saleOrigin === 'IFOOD'
                        ? 'text-red-700 bg-red-100 border-red-300'
                        : activeDraft.saleOrigin === 'APP99'
                          ? 'text-amber-700 bg-amber-100 border-amber-300'
                          : activeDraft.saleOrigin === 'KEETA'
                            ? 'text-emerald-700 bg-emerald-100 border-emerald-300'
                          : 'text-slate-500 bg-slate-100 border-slate-200'
                    }`}
                  >
                    Canal: {getSaleOriginLabel(activeDraft.saleOrigin || 'LOCAL')}
                  </span>
                  {isAppSaleOrigin(activeDraft.saleOrigin || 'LOCAL') && (
                    <span className="text-[10px] font-black uppercase tracking-widest text-amber-700 px-2 py-1 rounded-lg bg-amber-100 border border-amber-300">
                      Valor app: R$ {formatMoney(activeDraft.appOrderTotal ?? activeDraft.total)}
                    </span>
                  )}
                </div>

                <div className="p-4 max-h-[50vh] overflow-y-auto space-y-3 bg-slate-50">
                  {activeDraft.items.length === 0 && (
                    <div className="py-12 text-center text-xs uppercase tracking-widest font-black text-slate-400">
                      Carrinho vazio.
                    </div>
                  )}

                  {activeDraft.items.map((item) => {
                    const subtotal = (item.unitPriceSnapshot || 0) * item.qty;
                    const canEditItems = activeDraft.status === 'DRAFT';
                    const isPendingLocalItem = isLocalPendingDraftItemId(item.id);
                    const canIncreaseItemQty =
                      canEditItems && !resolveDraftItemStockIssue(item.recipe, 1);
                    return (
                      <div
                        key={item.id}
                        className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-black uppercase text-slate-800">
                              {item.nameSnapshot || item.productId}
                            </p>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                              R$ {formatMoney(item.unitPriceSnapshot || 0)} un. • Subtotal R$ {formatMoney(subtotal)}
                            </p>
                            {isPendingLocalItem && (
                              <p className="text-[9px] font-black uppercase tracking-widest text-amber-700">
                                Pendente de envio ao banco
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleUpdateDraftItemQuantity(item.id, item.qty - 1)}
                              disabled={!canEditItems}
                              className="qb-btn-touch w-9 h-9 rounded-xl bg-slate-100 text-slate-700 font-black disabled:opacity-40"
                            >
                              -
                            </button>
                            <span className="w-10 text-center font-black text-sm text-slate-800">{item.qty}</span>
                            <button
                              onClick={() => handleUpdateDraftItemQuantity(item.id, item.qty + 1)}
                              disabled={!canIncreaseItemQty}
                              className="qb-btn-touch w-9 h-9 rounded-xl bg-yellow-400 text-red-800 font-black disabled:opacity-40"
                              title={canIncreaseItemQty ? 'Aumentar quantidade' : 'Estoque insuficiente'}
                            >
                              +
                            </button>
                            <button
                              onClick={() => handleUpdateDraftItemQuantity(item.id, 0)}
                              disabled={!canEditItems}
                              className="qb-btn-touch px-2 py-2 rounded-xl bg-red-100 text-red-700 font-black text-[10px] uppercase tracking-widest disabled:opacity-40"
                            >
                              Remover
                            </button>
                          </div>
                        </div>
                        <input
                          type="text"
                          defaultValue={item.note || ''}
                          onBlur={(e) => handleUpdateDraftItemNote(item.id, e.target.value)}
                          disabled={!canEditItems}
                          placeholder="Observação do item (opcional)"
                          className="w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 disabled:opacity-60"
                        />
                      </div>
                    );
                  })}
                </div>

                <div className="p-4 bg-white border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-black uppercase text-slate-800">
                    Total: <span className="text-red-600">R$ {formatMoney(activeDraft.total)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {(activeDraft.status === 'DRAFT' ||
                      activeDraft.status === 'PENDING_PAYMENT') &&
                      activeDraftApiLinkedItemCount > 0 && (
                      <button
                        onClick={handleClearApiLinkedDraftItems}
                        disabled={isCancellingDraft || isStateHydrating || pendingStateOps > 0}
                        className="qb-btn-touch bg-amber-100 text-amber-800 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-amber-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title={
                          activeDraft.status === 'PENDING_PAYMENT'
                            ? 'Cancela a venda para remover os itens vinculados ao banco/API'
                            : 'Limpa apenas os itens já vinculados ao banco/API'
                        }
                      >
                        {activeDraft.status === 'PENDING_PAYMENT'
                          ? 'Limpar do Banco (Cancela)'
                          : `Limpar do Banco (${activeDraftApiLinkedItemCount})`}
                      </button>
                    )}
                    {(activeDraft.status === 'DRAFT' || activeDraft.status === 'PENDING_PAYMENT') &&
                      activeDraftLocalPendingItemCount > 0 && (
                      <button
                        onClick={handleClearLocalPendingDraftItems}
                        disabled={isCancellingDraft || isStateHydrating || pendingStateOps > 0}
                        className="qb-btn-touch bg-slate-100 text-slate-700 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Limpa apenas itens pendentes locais ainda não enviados ao banco/API"
                      >
                        Limpar Pendentes ({activeDraftLocalPendingItemCount})
                      </button>
                    )}
                    <button
                      onClick={handleCancelActiveDraft}
                      disabled={isCancellingDraft || isStateHydrating || pendingStateOps > 0}
                      className="qb-btn-touch bg-red-100 text-red-700 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-red-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Cancelar Venda
                    </button>
                    <button
                      onClick={() => setIsCartOpen(false)}
                      className="qb-btn-touch bg-slate-100 text-slate-700 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors"
                    >
                      Fechar
                    </button>
                    <button
                      onClick={handleOpenPayment}
                      disabled={activeDraft.items.length === 0}
                      className="qb-btn-touch bg-green-600 text-white px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-green-700 transition-colors disabled:opacity-40"
                    >
                      Finalizar
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {isPaymentOpen && activeDraft && (
        <div className="qb-payment-overlay fixed inset-0 z-[225] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="qb-payment-modal w-full max-w-lg bg-white rounded-[34px] border-2 border-slate-100 shadow-2xl overflow-hidden flex flex-col">
            <div className="qb-payment-head p-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-lg font-black uppercase tracking-tight">Pagamento</h3>
                <p className="text-[9px] uppercase tracking-widest text-slate-300">
                  Pagamento na maquininha. Confirme no sistema só após pago.
                </p>
              </div>
              <button
                onClick={() => {
                  setIsSplitSetupOpen(false);
                  setIsSaleOriginSetupOpen(false);
                  setIsPaymentOpen(false);
                }}
                className="qb-btn-touch bg-slate-800 hover:bg-slate-700 p-2 rounded-full transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>

            <div className="qb-payment-body grid grid-cols-1 gap-3 p-3 bg-slate-50 overflow-y-auto">
              <div className="qb-payment-card qb-payment-section-total bg-white border border-slate-200 rounded-2xl p-3 space-y-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Total dos itens
                </p>
                <div className="flex items-center gap-2">
                  {isAppSaleOriginActive && (
                    <button
                      type="button"
                      onClick={closeAppSaleOriginPanel}
                      className={`qb-btn-touch group relative inline-flex h-11 items-center gap-2 rounded-full border-2 px-3 shadow-lg transition-all hover:scale-[1.03] ${paymentOriginToneClass} ${paymentOriginIconClass}`}
                      title="Remover canal de app e voltar para balcão"
                    >
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/10 text-[10px] font-black uppercase tracking-widest">
                        {paymentOriginShortLabel}
                      </span>
                      <span className="text-[10px] font-black uppercase tracking-widest">
                        {paymentOriginNameLabel}
                      </span>
                      <span className="absolute -top-1 -right-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 text-[10px] font-black">
                        X
                      </span>
                    </button>
                  )}
                  <div
                    className={`relative flex-1 overflow-hidden rounded-2xl border-2 px-3 py-2 transition-all duration-300 ${
                      isAppSaleOriginActive
                        ? `shadow-lg ${paymentOriginFieldClass}`
                        : 'border-slate-200 bg-slate-50'
                    } ${paymentOriginMorphClass}`}
                  >
                    <span
                      className={`pointer-events-none absolute left-0 top-0 h-full w-1.5 rounded-full transition-all duration-300 ${
                        isAppSaleOriginActive ? paymentOriginBarClass : 'bg-slate-200'
                      }`}
                    />
                    <div className="relative h-11 pl-2.5">
                      <div
                        className={`absolute inset-0 flex items-center gap-2 transition-all duration-300 ${
                          isAppSaleOriginActive
                            ? 'translate-y-3 scale-95 opacity-0'
                            : 'translate-y-0 scale-100 opacity-100'
                        }`}
                      >
                        <span className="qb-payment-total-currency text-2xl font-black text-red-600 leading-none">R$</span>
                        <p className="qb-payment-total-value text-2xl font-black text-red-600 leading-none">
                          {formatMoney(effectivePaymentTotal)}
                        </p>
                      </div>
                      <div
                        className={`absolute inset-0 flex items-center gap-2 transition-all duration-300 ${
                          isAppSaleOriginActive
                            ? 'translate-y-0 scale-100 opacity-100'
                            : '-translate-y-3 scale-95 opacity-0 pointer-events-none'
                        }`}
                      >
                        <span className="qb-payment-total-currency text-2xl font-black text-red-600 leading-none">R$</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={appOrderTotalInput}
                          onChange={(e) => setAppOrderTotalInput(e.target.value)}
                          ref={appOrderTotalInputRef}
                          className="qb-payment-total-input w-36 bg-transparent text-2xl font-black text-red-600 leading-none focus:outline-none"
                          placeholder={formatMoney(activeDraft.total)}
                          aria-label="Valor real cobrado no app"
                        />
                      </div>
                    </div>
                  </div>
                </div>
                {isAppOrderTotalInvalid && (
                  <p className="text-[10px] font-black uppercase tracking-widest text-red-700">
                    Informe um valor válido maior que zero.
                  </p>
                )}
              </div>

              <div className="qb-payment-card qb-payment-section-methods bg-white border border-slate-200 rounded-2xl p-2">
                <div className="qb-payment-method-grid grid grid-cols-2 gap-1.5">
                {(BASE_PAYMENT_METHODS as SaleBasePaymentMethod[]).map((method) => (
                  <button
                    key={method}
                    onClick={() => {
                      if (isSplitMethodSelectionLocked) return;
                      setPaymentMethod(method);
                      setPaymentMethodBeforeSplitSetup(method);
                      resetSplitPaymentState();
                    }}
                    disabled={isSplitMethodSelectionLocked}
                    className={`qb-btn-touch qb-payment-method-btn px-2 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-wide border transition-all ${
                      isSplitMethodSelectionLocked
                        ? 'bg-white border-slate-200 text-slate-300 cursor-not-allowed'
                        : paymentMethod === method
                        ? 'bg-red-600 border-red-700 text-white'
                        : 'bg-white border-slate-200 text-slate-700 hover:border-red-300'
                    }`}
                  >
                    {formatPaymentMethodLabel(method)}
                  </button>
                ))}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      openSplitSetupModal();
                    }}
                    className={`qb-btn-touch w-full rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                      paymentMethod === 'DIVIDIDO'
                        ? 'border-amber-700 bg-amber-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-300'
                    }`}
                  >
                    {paymentMethod === 'DIVIDIDO' ? 'Dividido Ativo' : 'Dividido'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsSaleOriginSetupOpen(true)}
                    className={`qb-btn-touch w-full rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                      isAppSaleOriginActive
                        ? 'border-emerald-600 bg-emerald-500 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-300'
                    }`}
                  >
                    {isAppSaleOriginActive ? `Apps (${paymentOriginNameLabel})` : 'Apps'}
                  </button>
                </div>
                {paymentMethod === 'DIVIDIDO' && (
                  <p className={`mt-1 text-[10px] font-black uppercase tracking-widest ${isSplitPlanComplete ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {isSplitPlanComplete
                      ? 'Dividido concluído. Clique em Confirmar Pago.'
                      : `Restante para dividir: R$ ${formatMoney(splitRemainingAmount)}`}
                  </p>
                )}
              </div>

              {paymentMethod === 'DINHEIRO' ? (
                <div className="qb-payment-card qb-payment-cash-card qb-payment-section-detail qb-payment-method-detail bg-white border border-slate-200 rounded-2xl p-3 flex flex-col gap-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Valor recebido
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={cashReceivedInput}
                    onChange={(e) => setCashReceivedInput(e.target.value)}
                    className="qb-payment-cash-input w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-1.5 font-black text-sm leading-tight text-slate-800"
                    placeholder="0,00"
                  />
                  {paymentCashDelta !== null ? (
                    paymentCashDelta >= 0 ? (
                      <p className="qb-payment-cash-status text-[11px] font-black text-green-700">
                        Troco: R$ {formatMoney(paymentCashDelta)}
                      </p>
                    ) : (
                      <p className="qb-payment-cash-status text-[11px] font-black text-red-700">
                        Faltam: R$ {formatMoney(Math.abs(paymentCashDelta))}
                      </p>
                    )
                  ) : (
                    <p className="qb-payment-cash-status text-[10px] font-bold text-slate-500">
                      Informe o valor recebido para calcular troco.
                    </p>
                  )}
                </div>
              ) : paymentMethod === 'DIVIDIDO' ? (
                <div className="qb-payment-card qb-payment-section-detail qb-payment-method-detail bg-white border border-slate-200 rounded-2xl p-3 flex flex-col gap-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    Divisão registrada no painel flutuante.
                  </p>
                  <p className={`text-[11px] font-black uppercase tracking-widest ${isSplitPlanComplete ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {isSplitPlanComplete
                      ? 'Dividido concluído. Confirme o pagamento.'
                      : `Faltam R$ ${formatMoney(splitRemainingAmount)} para concluir.`}
                  </p>
                  {splitCommitted.length > 0 ? (
                    <div className="max-h-32 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5">
                      <div className="space-y-1">
                        {splitCommitted.map((entry) => (
                          <div
                            key={`split-summary-${entry.sequence}`}
                            className="flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-slate-700"
                          >
                            <span>{`${entry.sequence}. ${formatPaymentMethodLabel(entry.method)}`}</span>
                            <span>{`R$ ${formatMoney(entry.amount)}`}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                      Nenhuma parcela lançada ainda.
                    </p>
                  )}
                </div>
              ) : (
                <div className="qb-payment-card qb-payment-section-detail qb-payment-method-detail bg-white border border-slate-200 rounded-2xl p-3">
                  <p className="text-[11px] font-black uppercase tracking-widest text-slate-600">
                    Receba na maquininha e depois clique em confirmar pago.
                  </p>
                </div>
              )}
            </div>

            <div className="qb-payment-footer p-3 bg-white border-t border-slate-100 flex flex-wrap items-center justify-end gap-2 shrink-0">
              <button
                onClick={() => {
                  setIsSplitSetupOpen(false);
                  setIsSaleOriginSetupOpen(false);
                  setIsPaymentOpen(false);
                  setIsCartOpen(true);
                }}
                className="qb-btn-touch bg-slate-100 text-slate-700 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors"
              >
                Voltar
              </button>
              <button
                onClick={handleCancelActiveDraft}
                disabled={isCancellingDraft || isStateHydrating || pendingStateOps > 0}
                className="qb-btn-touch bg-red-100 text-red-700 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-red-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancelar Venda
              </button>
              {paymentMethod === 'DIVIDIDO' && (
                <button
                  onClick={handleRedoSplitFlow}
                  disabled={isPaymentActionBlocked}
                  className="qb-btn-touch bg-amber-100 text-amber-700 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-amber-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Refazer
                </button>
              )}
              <button
                onClick={handleConfirmPaid}
                disabled={isConfirmPaidDisabled}
                className={`qb-btn-touch bg-green-600 text-white px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-green-700 transition-colors disabled:opacity-40 ${
                  isSplitConfirmReady ? 'qb-payment-confirm-ready-blink' : ''
                }`}
              >
                {isConfirmingPaid ? 'Confirmando...' : 'Confirmar Pago'}
              </button>
            </div>
          </div>

          {isSaleOriginSetupOpen && (
            <div
              className="fixed inset-0 z-[231] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => setIsSaleOriginSetupOpen(false)}
            >
              <div
                className="w-full max-w-sm rounded-3xl border-2 border-slate-100 bg-white p-4 shadow-2xl space-y-3"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">
                    Canal da venda
                  </h4>
                  <button
                    type="button"
                    onClick={() => setIsSaleOriginSetupOpen(false)}
                    className="qb-btn-touch inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200"
                    aria-label="Fechar canais de venda"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>
                <div className="flex items-center justify-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => handleSelectAppSaleOrigin('IFOOD')}
                    className={`qb-btn-touch qb-payment-origin-btn qb-payment-origin-circle w-14 h-14 rounded-full border font-black text-[10px] uppercase tracking-tight transition-all ${
                      saleOrigin === 'IFOOD'
                        ? 'bg-red-600 text-white border-red-700 shadow-lg shadow-red-200'
                        : 'bg-white text-red-600 border-red-200 hover:border-red-400'
                    }`}
                    title="Venda pelo iFood"
                  >
                    iFood
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectAppSaleOrigin('APP99')}
                    className={`qb-btn-touch qb-payment-origin-btn qb-payment-origin-circle w-14 h-14 rounded-full border font-black text-xl leading-none transition-all ${
                      saleOrigin === 'APP99'
                        ? 'bg-yellow-400 text-slate-900 border-yellow-500 shadow-lg shadow-yellow-200'
                        : 'bg-white text-yellow-600 border-yellow-300 hover:border-yellow-500'
                    }`}
                    title="Venda pelo 99"
                  >
                    99
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectAppSaleOrigin('KEETA')}
                    className={`qb-btn-touch qb-payment-origin-btn qb-payment-origin-pill h-14 rounded-full border px-4 font-black text-[10px] uppercase tracking-tight transition-all ${
                      saleOrigin === 'KEETA'
                        ? 'bg-emerald-500 text-white border-emerald-600 shadow-lg shadow-emerald-200'
                        : 'bg-white text-emerald-700 border-emerald-300 hover:border-emerald-500'
                    }`}
                    title="Venda pelo Keeta"
                  >
                    Keeta
                  </button>
                </div>
              </div>
            </div>
          )}

          {isSplitSetupOpen && (
            <div className="fixed inset-0 z-[230] bg-slate-900/75 backdrop-blur-md flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded-3xl border border-white/40 bg-white/95 p-4 shadow-2xl space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">
                      Dividir pagamento
                    </h4>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                      Quanto vai pagar nesta etapa?
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAbortSplitMethod}
                    className="qb-btn-touch inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200"
                    aria-label="Fechar dividido"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Total</p>
                    <p className="text-base font-black text-slate-900">R$ {formatMoney(effectivePaymentTotal)}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Restante</p>
                    <p className={`text-base font-black ${splitRemainingAmount <= 0.009 ? 'text-emerald-700' : 'text-red-600'}`}>
                      R$ {formatMoney(splitRemainingAmount)}
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">
                    {`Parcela ${splitCommitted.length + 1} - valor`}
                  </p>
                  <input
                    ref={splitCurrentAmountInputRef}
                    type="number"
                    min="0"
                    step="0.01"
                    value={splitCurrentAmountInput}
                    onChange={(event) => setSplitCurrentAmountInput(event.target.value)}
                    className="w-full rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-base font-black text-slate-800 focus:outline-none focus:ring-2 focus:ring-red-200"
                    placeholder={formatMoney(splitRemainingAmount)}
                  />
                </div>
                {splitCurrentMethod === 'DINHEIRO' && (
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                      Valor recebido em dinheiro
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={splitCurrentCashReceivedInput}
                      onChange={(event) => setSplitCurrentCashReceivedInput(event.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-800"
                      placeholder="0,00"
                    />
                    {splitCurrentCashDelta !== null && (
                      <p className={`text-[10px] font-black uppercase tracking-widest ${splitCurrentCashDelta >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        {splitCurrentCashDelta >= 0
                          ? `Troco: R$ ${formatMoney(splitCurrentCashDelta)}`
                          : `Faltam: R$ ${formatMoney(Math.abs(splitCurrentCashDelta))}`}
                      </p>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-1.5">
                  {(BASE_PAYMENT_METHODS as SaleBasePaymentMethod[]).map((method) => (
                    <button
                      key={`split-method-${method}`}
                      type="button"
                      onClick={() => setSplitCurrentMethod(method)}
                      className={`qb-btn-touch rounded-xl border px-2 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                        splitCurrentMethod === method
                          ? 'bg-red-600 border-red-700 text-white'
                          : 'bg-white border-slate-200 text-slate-700 hover:border-red-300'
                      }`}
                    >
                      {formatPaymentMethodLabel(method)}
                    </button>
                  ))}
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">
                    Parcelas lançadas
                  </p>
                  {splitCommitted.length === 0 ? (
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                      Nenhuma parcela lançada.
                    </p>
                  ) : (
                    <div className="max-h-24 overflow-y-auto space-y-1">
                      {splitCommitted.map((entry) => (
                        <div
                          key={`split-entry-${entry.sequence}`}
                          className="flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-slate-700"
                        >
                          <span>{`${entry.sequence}. ${formatPaymentMethodLabel(entry.method)}`}</span>
                          <span>{`R$ ${formatMoney(entry.amount)}`}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleRemoveLastSplit}
                    disabled={splitCommitted.length === 0}
                    className="qb-btn-touch rounded-xl bg-slate-100 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 hover:bg-slate-200 disabled:opacity-40"
                  >
                    Voltar
                  </button>
                  <button
                    type="button"
                    onClick={handleResetSplitPlan}
                    className="qb-btn-touch rounded-xl bg-amber-100 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-amber-800 hover:bg-amber-200"
                  >
                    Reiniciar
                  </button>
                  <button
                    type="button"
                    onClick={handleCommitSplitStep}
                    disabled={!isSplitCurrentStepReady}
                    className="qb-btn-touch rounded-xl bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    {splitRemainingAmount <= 0.009 ? 'Concluído' : 'Avançar'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {isUndoHistoryOpen && (
        <div className="fixed inset-0 z-[220] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white rounded-[36px] border-2 border-slate-100 shadow-2xl overflow-hidden">
            <div className="p-5 bg-slate-900 text-white flex items-center justify-between">
              <div>
                <h3 className="text-xl font-black uppercase tracking-tight">
                  {`Histórico de Vendas ${new Date().toLocaleDateString('pt-BR')}`}
                </h3>
                <p className="text-[10px] uppercase tracking-widest text-slate-300">
                  Apenas vendas do dia atual (até Fechar Dia / Reiniciar)
                </p>
                <p className="text-[10px] uppercase tracking-widest text-slate-300">
                  Modelo do cupom: {selectedReceiptPrintPreset.label}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setReceiptPrintSettingsOpen((current) => !current)}
                  className="qb-btn-touch bg-slate-800 hover:bg-slate-700 p-2 rounded-full transition-colors"
                  title="Modelos de impressão"
                  aria-label="Abrir modelos de impressão do cupom"
                  aria-expanded={receiptPrintSettingsOpen}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.6 1.6 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.6 1.6 0 0 0-1.82-.33 1.6 1.6 0 0 0-1 1.46V21a2 2 0 0 1-4 0v-.09a1.6 1.6 0 0 0-1-1.46 1.6 1.6 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.6 1.6 0 0 0 .33-1.82 1.6 1.6 0 0 0-1.46-1H3a2 2 0 0 1 0-4h.09a1.6 1.6 0 0 0 1.46-1 1.6 1.6 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.6 1.6 0 0 0 1.82.33h.01a1.6 1.6 0 0 0 1-1.46V3a2 2 0 0 1 4 0v.09a1.6 1.6 0 0 0 1 1.46h.01a1.6 1.6 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.6 1.6 0 0 0-.33 1.82v.01a1.6 1.6 0 0 0 1.46 1H21a2 2 0 0 1 0 4h-.09a1.6 1.6 0 0 0-1.46 1z" />
                  </svg>
                </button>
                <button
                  onClick={() => setIsUndoHistoryOpen(false)}
                  className="qb-btn-touch bg-slate-800 hover:bg-slate-700 p-2 rounded-full transition-colors"
                  title="Fechar"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
              </div>
            </div>
            {receiptPrintSettingsOpen && (
              <div className="px-4 py-3 bg-slate-800 border-b border-slate-700">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-300 mb-2">
                  Modelos de impressão
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {RECEIPT_PRINT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setReceiptPrintPresetId(preset.id);
                        applyReceiptPrintPreset(preset.id);
                        setReceiptPrintSettingsOpen(false);
                      }}
                      className={`qb-btn-touch border rounded-xl px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
                        receiptPrintPresetId === preset.id
                          ? 'bg-white text-slate-900 border-white'
                          : 'bg-slate-900 text-slate-100 border-slate-600 hover:border-slate-300'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="p-4 max-h-[65vh] overflow-y-auto space-y-2 bg-slate-50">
              {recentUndoGroups.length === 0 && (
                <div className="py-12 text-center text-xs uppercase tracking-widest font-black text-slate-400">
                  Nenhuma venda disponível para desfazer.
                </div>
              )}
              {recentUndoGroups.map((group, index) => {
                const isLatest = index === 0;
                const isCommandBusy = isUndoProcessing || isStateHydrating || pendingStateOps > 0;
                const isExpanded = expandedUndoGroupId === group.id;
                const firstSale = group.sales[0];
                const title =
                  group.sales.length > 1
                    ? `Pedido (${group.sales.length} itens)`
                    : firstSale?.productName || 'Venda';
                return (
                  <div
                    key={group.id}
                    className="bg-white border border-slate-200 rounded-2xl overflow-hidden"
                  >
                    <button
                      onClick={() => {
                        setExpandedUndoGroupId((current) => (current === group.id ? null : group.id));
                      }}
                      className="qb-btn-touch w-full p-4 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0 text-left">
                        <p className="text-sm font-black uppercase text-slate-800 truncate">
                          {title}
                          {isLatest && (
                            <span className="ml-2 text-[9px] align-middle px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 border border-yellow-300">
                              Última
                            </span>
                          )}
                        </p>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                          {formatSaleDateTime(group.timestamp)}
                          {group.saleDraftId ? ` • Pedido: ${group.saleDraftId}` : ` • ID: ${firstSale?.id || '--'}`}
                        </p>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                          Total: R$ {group.total.toFixed(2)} • Custo: R$ {group.totalCost.toFixed(2)}
                        </p>
                      </div>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        className={`text-slate-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-slate-100 bg-slate-50 p-3 space-y-2">
                        {group.sales.map((sale) => (
                          <div
                            key={sale.id}
                            className="bg-white border border-slate-200 rounded-xl p-3"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-black uppercase text-slate-800 truncate">
                                {sale.productName}
                              </p>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                {formatSaleTime(sale.timestamp)} • ID: {sale.id}
                              </p>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                Total: R$ {sale.total.toFixed(2)} • Custo: R$ {(sale.totalCost || 0).toFixed(2)}
                              </p>
                            </div>
                          </div>
                        ))}

                        <div className="pt-1 flex justify-end gap-2">
                          <button
                            onClick={() => {
                              handlePrintReceiptByGroup(group.id);
                            }}
                            className="qb-btn-touch bg-blue-600 text-white px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-700 transition-all active:scale-95 whitespace-nowrap"
                            title="Imprimir cupom do pedido completo"
                          >
                            Imprimir Pedido
                          </button>
                          <button
                            onClick={() => {
                              void handleUndoSaleGroup(group.id);
                            }}
                            disabled={isCommandBusy}
                            className="qb-btn-touch bg-red-600 text-white px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-red-700 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                          >
                            Desfazer Pedido Completo
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="p-4 bg-white border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setIsUndoHistoryOpen(false)}
                className="qb-btn-touch bg-slate-100 text-slate-700 px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      <Notification 
        isVisible={notification.isVisible} 
        message={notification.message} 
        onClose={() => setNotification({ ...notification, isVisible: false })} 
      />

      <AddProductModal 
        isOpen={isAddProductModalOpen} 
        onClose={() => setIsAddProductModalOpen(false)} 
        ingredients={ingredients} 
        products={products}
        onAdd={handleAddProduct} 
      />

      <AddIngredientModal 
        isOpen={isAddIngredientModalOpen} 
        onClose={() => setIsAddIngredientModalOpen(false)} 
        onAdd={handleAddIngredient} 
      />

      <EditIngredientModal
        isOpen={Boolean(ingredientToEdit)}
        ingredient={ingredientToEdit}
        onClose={() => setIngredientToEdit(null)}
        onSave={handleSaveIngredient}
      />

      <EditProductModal
        isOpen={Boolean(productToEdit)}
        product={productToEdit}
        ingredients={ingredients}
        products={products}
        onClose={() => setProductToEdit(null)}
        onSave={handleSaveProduct}
      />
    </div>
  );
};

export default App;
