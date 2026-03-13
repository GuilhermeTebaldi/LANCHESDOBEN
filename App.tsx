
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
  runStateCommand,
  StateCommandSyncError,
  warmupStateWriteContext,
  type StateCommand,
} from './data/stateCommandClient';
import { buildReceiptPrintRoutePath } from './utils/printRoutes';
import { clampReceiptPaperWidthMm } from './utils/receiptPaper';

const ADMIN_GATE_KEY = 'lanchesdoben_admin_gate';
const ADMIN_SESSION_KEY = 'lanchesdoben_admin_session';
const ADMIN_SESSION_BACKUP_KEY = 'lanchesdoben_admin_session_backup';
const OFFLINE_SALE_QUEUE_KEY = 'qb_offline_sale_queue_v1';
const CASH_HISTORY_LEGACY_MODE_KEY = 'qb_cash_history_legacy_mode_v1';
const LOCAL_CASH_REGISTER_KEY = 'qb_cash_register_local_v1';
const LOCAL_DAILY_HISTORY_KEY = 'qb_daily_sales_history_local_v1';
const RECEIPT_PAPER_WIDTH_KEY = 'qb_receipt_paper_width_mm';
const RECEIPT_PRINT_PRESET_STORAGE_KEY = 'qb_receipt_print_preset_v1';

type SaleRegisterCommand = Extract<StateCommand, { type: 'SALE_REGISTER' }>;

interface OfflineQueuedSale {
  command: SaleRegisterCommand;
  queuedAt: string;
  attempts: number;
  lastError?: string;
}
interface ReceiptPrintPreset {
  id: string;
  label: string;
  paperWidthMm: number | null;
}

interface RunCommandOptions {
  skipOfflineQueue?: boolean;
  silentSuccessNotification?: boolean;
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

  return {
    id:
      typeof source.id === 'string' && source.id.trim()
        ? source.id
        : `day-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    closedAt,
    openingCash: roundMoney(Math.max(0, Number(source.openingCash) || 0)),
    totalRevenue: roundMoney(Math.max(0, Number(source.totalRevenue) || 0)),
    totalPurchases: roundMoney(Math.max(0, Number(source.totalPurchases) || 0)),
    totalProfit: roundMoney(Number(source.totalProfit) || 0),
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

const App: React.FC = () => {
  const [view, setView] = useState<ViewMode>(ViewMode.POS);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAccessVerified, setIsAccessVerified] = useState(false);
  const [isStateHydrating, setIsStateHydrating] = useState(true);
  const [pendingStateOps, setPendingStateOps] = useState(0);
  const [pendingOfflineSales, setPendingOfflineSales] = useState(0);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const offlineSalesQueueRef = useRef<OfflineQueuedSale[]>([]);
  const isFlushingOfflineSalesRef = useRef(false);
  const isOfflineQueueHydratedRef = useRef(false);
  const activeDraftIdRef = useRef<string | null>(null);
  const saleDraftsRef = useRef<SaleDraft[]>(DEFAULT_APP_STATE.saleDrafts);
  const pendingDraftCreationRef = useRef<Promise<string | null> | null>(null);
  
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
  const [splitPeopleInput, setSplitPeopleInput] = useState('2');
  const [splitMode, setSplitMode] = useState<SalePaymentSplitMode | null>(null);
  const [splitCount, setSplitCount] = useState<number | null>(null);
  const [splitAutoAllocations, setSplitAutoAllocations] = useState<number[]>([]);
  const [splitCommitted, setSplitCommitted] = useState<SalePaymentSplitEntry[]>([]);
  const [splitCurrentIndex, setSplitCurrentIndex] = useState(0);
  const [splitCurrentMethod, setSplitCurrentMethod] = useState<SaleBasePaymentMethod>('PIX');
  const [splitCurrentAmountInput, setSplitCurrentAmountInput] = useState('');
  const [splitCurrentCashReceivedInput, setSplitCurrentCashReceivedInput] = useState('');
  const cartEntryFxTimeoutRef = useRef<number | null>(null);
  const appOrderTotalInputRef = useRef<HTMLInputElement | null>(null);
  const selectedReceiptPrintPreset = useMemo(
    () => getReceiptPrintPresetById(receiptPrintPresetId),
    [receiptPrintPresetId]
  );

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
        setIngredients(state.ingredients);
        setProducts(state.products);
        setSales(state.sales);
        setStockEntries(state.stockEntries);
        setCleaningMaterials(state.cleaningMaterials);
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

  useEffect(() => {
    return () => {
      if (cartEntryFxTimeoutRef.current !== null) {
        window.clearTimeout(cartEntryFxTimeoutRef.current);
      }
    };
  }, []);

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
    setIngredients(state.ingredients);
    setProducts(state.products);
    setSales(state.sales);
    setStockEntries(state.stockEntries);
    setCleaningMaterials(state.cleaningMaterials);
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
    async (command: StateCommand): Promise<{ ok: true } | { ok: false; error: unknown }> => {
      setPendingStateOps((current) => current + 1);

      const executeCommand = async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
        try {
          const nextState = await runStateCommand(command);
          applyStateSnapshot(nextState);
          return { ok: true };
        } catch (error) {
          return { ok: false, error };
        } finally {
          setPendingStateOps((current) => Math.max(0, current - 1));
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
      const result = await executeSyncedCommand(normalizedCommand);

      if (result.ok) {
        if (successMessage && !options.silentSuccessNotification) {
          showNotification(successMessage);
        }
        return true;
      }

      const message = getStateSyncErrorMessage(result.error);
      const shouldQueueOfflineSale =
        !options.skipOfflineQueue &&
        isSaleRegisterCommand(normalizedCommand) &&
        isRetryableSyncError(result.error);

      if (shouldQueueOfflineSale) {
        queueOfflineSale(normalizedCommand, message);
        showNotification(
          `Sem internet. Venda guardada no navegador (${offlineSalesQueueRef.current.length} pendente(s)).`
        );
        return true;
      }

      showNotification(message);
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
  const isSyncIndicatorVisible = isStateHydrating || totalPendingOps > 0;
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

  const openSaleDrafts = useMemo(
    () => saleDrafts.filter((draft) => draft.status === 'DRAFT' || draft.status === 'PENDING_PAYMENT'),
    [saleDrafts]
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

  useEffect(() => {
    if (activeDraftId && activeDraft?.id === activeDraftId) return;
    const nextDraftId = activeDraft?.id || null;
    if (nextDraftId !== activeDraftId) {
      setActiveDraftId(nextDraftId);
    }
  }, [activeDraft, activeDraftId]);

  const resolveEditableDraftId = useCallback((): string | null => {
    const currentOpenDrafts = saleDraftsRef.current.filter(
      (draft) => draft.status === 'DRAFT' || draft.status === 'PENDING_PAYMENT'
    );
    const selected = activeDraftIdRef.current
      ? currentOpenDrafts.find((draft) => draft.id === activeDraftIdRef.current)
      : null;
    if (selected?.status === 'DRAFT') {
      return selected.id;
    }

    const fallback = currentOpenDrafts.find((draft) => draft.status === 'DRAFT');
    if (!fallback) {
      return null;
    }

    activeDraftIdRef.current = fallback.id;
    setActiveDraftId(fallback.id);
    return fallback.id;
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

  const handleOpenCart = () => {
    void (async () => {
      const draftId = await ensureActiveDraft('BALCAO');
      if (!draftId) return;
      activeDraftIdRef.current = draftId;
      setActiveDraftId(draftId);
      setIsCartOpen(true);
    })();
  };

  const handleSale = useCallback((product: Product, recipeOverride?: RecipeItem[], priceOverride?: number) => {
    void (async () => {
      let draftId = resolveEditableDraftId();
      let shouldSetActiveDraft = false;
      if (!draftId) {
        draftId = createClientId('draft');
        shouldSetActiveDraft = true;
      }

      const ok = await runCommandWithSync(
        {
          type: 'SALE_DRAFT_ADD_ITEM',
          draftId,
          productId: product.id,
          quantity: 1,
          recipeOverride,
          priceOverride,
        },
        `${product.name} adicionado ao carrinho!`,
        { silentSuccessNotification: false }
      );
      if (!ok) return;

      if (shouldSetActiveDraft) {
        activeDraftIdRef.current = draftId;
        setActiveDraftId(draftId);
      }

      triggerCartEntryEffect(product.name);
    })();
  }, [resolveEditableDraftId, runCommandWithSync, triggerCartEntryEffect]);

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

    if (nextQty <= 0) {
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
        quantity: nextQty,
      },
      undefined,
      { silentSuccessNotification: true }
    );
  };

  const handleUpdateDraftItemNote = (itemId: string, note: string) => {
    if (!activeDraft || activeDraft.status !== 'DRAFT') return;
    void runCommandWithSync(
      {
        type: 'SALE_DRAFT_UPDATE_ITEM',
        draftId: activeDraft.id,
        itemId,
        note,
      },
      undefined,
      { silentSuccessNotification: true }
    );
  };

  const handleCancelActiveDraft = () => {
    if (!activeDraft || isCancellingDraft) return;
    if (!confirm('Cancelar esta venda antes do pagamento? Nenhum estoque será debitado.')) return;
    const draftId = activeDraft.id;
    void (async () => {
      setIsCancellingDraft(true);
      try {
        const ok = await runCommandWithSync(
          {
            type: 'SALE_DRAFT_CANCEL',
            draftId,
          },
          'Venda cancelada.'
        );
        if (!ok) return;

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

  const resetSplitPaymentState = () => {
    setIsSplitSetupOpen(false);
    setSplitPeopleInput('2');
    setSplitMode(null);
    setSplitCount(null);
    setSplitAutoAllocations([]);
    setSplitCommitted([]);
    setSplitCurrentIndex(0);
    setSplitCurrentMethod('PIX');
    setSplitCurrentAmountInput('');
    setSplitCurrentCashReceivedInput('');
  };

  const hydrateSplitPaymentFromDraft = (draft: SaleDraft, amountDue: number) => {
    const payment = draft.payment;
    if (payment.method !== 'DIVIDIDO') {
      resetSplitPaymentState();
      return;
    }

    const mode: SalePaymentSplitMode =
      payment.splitMode === 'PEOPLE' || payment.splitMode === 'MIXED'
        ? payment.splitMode
        : Number(payment.splitCount) > 1
          ? 'PEOPLE'
          : 'MIXED';
    const parsedCount = Number(payment.splitCount);
    const fallbackCount = mode === 'PEOPLE' ? Math.max(1, (payment.splitPayments || []).length) : 1;
    const count =
      Number.isFinite(parsedCount) && Number.isInteger(parsedCount) && parsedCount > 0
        ? parsedCount
        : fallbackCount;

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
          label: entry.label?.trim() || (mode === 'PEOPLE' ? `Pessoa ${index + 1}` : `Parcela ${index + 1}`),
          method: entry.method,
          amount: safeAmount,
          cashReceived,
          change,
        };
      });

    const allocations = mode === 'PEOPLE' ? allocateSplitAmounts(amountDue, count) : [];
    const nextIndex = normalizedSplits.length;
    setSplitMode(mode);
    setSplitCount(count);
    setSplitPeopleInput(String(count));
    setSplitAutoAllocations(allocations);
    setSplitCommitted(normalizedSplits);
    setSplitCurrentIndex(nextIndex);
    setSplitCurrentMethod('PIX');
    setSplitCurrentCashReceivedInput('');
    if (mode === 'PEOPLE' && nextIndex < allocations.length) {
      setSplitCurrentAmountInput(String(allocations[nextIndex]));
    } else if (mode === 'MIXED') {
      const remaining = roundMoney(Math.max(0, amountDue - sumSplitAmounts(normalizedSplits)));
      setSplitCurrentAmountInput(remaining > 0 ? String(remaining) : '');
    } else {
      setSplitCurrentAmountInput('');
    }
  };

  const openSplitSetupModal = () => {
    if (paymentMethod !== 'DIVIDIDO') {
      setPaymentMethodBeforeSplitSetup(paymentMethod);
    }
    setPaymentMethod('DIVIDIDO');
    if (splitCount && splitCount > 0) {
      setSplitPeopleInput(String(splitCount));
    }
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

  const handleConfirmSplitSetup = () => {
    const parsedPeople = Number(splitPeopleInput);
    if (!Number.isFinite(parsedPeople) || !Number.isInteger(parsedPeople) || parsedPeople < 1 || parsedPeople > 30) {
      showNotification('Informe um número de pessoas entre 1 e 30.');
      return;
    }

    const nextMode: SalePaymentSplitMode = parsedPeople > 1 ? 'PEOPLE' : 'MIXED';
    const nextAllocations = nextMode === 'PEOPLE' ? allocateSplitAmounts(effectivePaymentTotal, parsedPeople) : [];

    setSplitMode(nextMode);
    setSplitCount(parsedPeople);
    setSplitAutoAllocations(nextAllocations);
    setSplitCommitted([]);
    setSplitCurrentIndex(0);
    setSplitCurrentMethod('PIX');
    setSplitCurrentCashReceivedInput('');
    setSplitCurrentAmountInput(nextMode === 'PEOPLE' ? String(nextAllocations[0] || 0) : '');
    setIsSplitSetupOpen(false);
  };

  const handleResetSplitPlan = () => {
    if (!splitMode || !splitCount) return;
    setSplitCommitted([]);
    setSplitCurrentIndex(0);
    setSplitCurrentMethod('PIX');
    setSplitCurrentCashReceivedInput('');
    if (splitMode === 'PEOPLE') {
      const allocations = splitAutoAllocations.length > 0 ? splitAutoAllocations : allocateSplitAmounts(effectivePaymentTotal, splitCount);
      setSplitAutoAllocations(allocations);
      setSplitCurrentAmountInput(String(allocations[0] || 0));
      return;
    }
    setSplitCurrentAmountInput('');
  };

  const handleRemoveLastSplit = () => {
    if (splitCommitted.length === 0) return;
    const nextCommitted = splitCommitted.slice(0, -1);
    setSplitCommitted(nextCommitted);
    setSplitCurrentMethod('PIX');
    setSplitCurrentCashReceivedInput('');

    if (splitMode === 'PEOPLE') {
      const nextIndex = nextCommitted.length;
      setSplitCurrentIndex(nextIndex);
      if (nextIndex < splitAutoAllocations.length) {
        setSplitCurrentAmountInput(String(splitAutoAllocations[nextIndex] || 0));
      } else {
        setSplitCurrentAmountInput('');
      }
      return;
    }

    const remaining = roundMoney(Math.max(0, effectivePaymentTotal - sumSplitAmounts(nextCommitted)));
    setSplitCurrentAmountInput(remaining > 0 ? String(remaining) : '');
  };

  const handleCommitSplitStep = () => {
    if (!splitMode || !splitCount) {
      showNotification('Configure o pagamento dividido antes de avançar.');
      return;
    }

    const sequence = splitCommitted.length + 1;
    const amount =
      splitMode === 'PEOPLE'
        ? roundMoney(splitAutoAllocations[splitCurrentIndex] || 0)
        : roundMoney(parseMoneyInput(splitCurrentAmountInput) || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      showNotification('Informe um valor válido para a parcela.');
      return;
    }

    const remainingBefore = roundMoney(Math.max(0, effectivePaymentTotal - sumSplitAmounts(splitCommitted)));
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
      label: splitMode === 'PEOPLE' ? `Pessoa ${sequence}` : `Parcela ${sequence}`,
      method: splitCurrentMethod,
      amount,
      cashReceived: splitCurrentMethod === 'DINHEIRO' ? roundMoney(cashReceived || 0) : null,
      change: splitCurrentMethod === 'DINHEIRO' ? roundMoney((cashReceived || 0) - amount) : null,
    };

    const nextCommitted = [...splitCommitted, nextEntry];
    setSplitCommitted(nextCommitted);
    setSplitCurrentMethod('PIX');
    setSplitCurrentCashReceivedInput('');

    if (splitMode === 'PEOPLE') {
      const nextIndex = splitCurrentIndex + 1;
      setSplitCurrentIndex(nextIndex);
      if (nextIndex < splitAutoAllocations.length) {
        setSplitCurrentAmountInput(String(splitAutoAllocations[nextIndex] || 0));
      } else {
        setSplitCurrentAmountInput('');
      }
      return;
    }

    const remainingAfter = roundMoney(Math.max(0, effectivePaymentTotal - sumSplitAmounts(nextCommitted)));
    setSplitCurrentAmountInput(remainingAfter > 0 ? String(remainingAfter) : '');
  };

  const handleSavePaymentMethod = async (): Promise<boolean> => {
    if (!activeDraft) return false;
    if (activeDraft.items.length === 0) {
      showNotification('Carrinho vazio. Não é possível finalizar.');
      return false;
    }

    const appOrderTotalParsed = isAppSaleOrigin(saleOrigin) ? parseMoneyInput(appOrderTotalInput) : null;
    if (isAppSaleOrigin(saleOrigin) && (appOrderTotalParsed === null || appOrderTotalParsed <= 0)) {
      showNotification('Informe o valor real da venda no app (iFood/99).');
      return false;
    }

    const cashReceivedParsed = paymentMethod === 'DINHEIRO' ? parseMoneyInput(cashReceivedInput) : null;
    if (paymentMethod === 'DINHEIRO' && (cashReceivedParsed === null || cashReceivedParsed < 0)) {
      showNotification('Informe um valor recebido válido em dinheiro.');
      return false;
    }

    let finalizeCommand: StateCommand;
    if (paymentMethod === 'DIVIDIDO') {
      if (!splitMode || !splitCount) {
        showNotification('Configure para quantas pessoas/parcela será o pagamento dividido.');
        return false;
      }

      if (splitMode === 'PEOPLE' && splitCommitted.length !== splitCount) {
        showNotification('Finalize o pagamento de todas as pessoas antes de confirmar.');
        return false;
      }

      if (splitMode === 'MIXED' && splitCommitted.length < 2) {
        showNotification('No modo 1 pessoa, informe ao menos duas parcelas (ex: PIX + dinheiro).');
        return false;
      }

      const totalDividido = sumSplitAmounts(splitCommitted);
      if (Math.abs(totalDividido - effectivePaymentTotal) > 0.009) {
        showNotification(`A divisão ainda está incompleta. Restante: R$ ${formatMoney(Math.abs(effectivePaymentTotal - totalDividido))}`);
        return false;
      }

      const splitPayload = splitCommitted.map((entry, index) => ({
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
        draftId: activeDraft.id,
        paymentMethod: 'DIVIDIDO',
        splitMode,
        splitCount,
        splitPayments: splitPayload,
        saleOrigin,
        appOrderTotal: isAppSaleOrigin(saleOrigin) ? (appOrderTotalParsed ?? undefined) : undefined,
      };
    } else {
      finalizeCommand = {
        type: 'SALE_DRAFT_FINALIZE',
        draftId: activeDraft.id,
        paymentMethod,
        cashReceived: paymentMethod === 'DINHEIRO' ? (cashReceivedParsed ?? undefined) : undefined,
        saleOrigin,
        appOrderTotal: isAppSaleOrigin(saleOrigin) ? (appOrderTotalParsed ?? undefined) : undefined,
      };
    }

    // Defensive: backend must persist app-origin and app amount before allowing confirm.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ok = await runCommandWithSync(finalizeCommand, undefined, {
        silentSuccessNotification: true,
      });
      if (!ok) return false;

      if (!isAppSaleOrigin(saleOrigin)) {
        showNotification('Forma de pagamento atualizada.');
        return true;
      }

      const persistedDraft = saleDraftsRef.current.find((draft) => draft.id === activeDraft.id);
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
        showNotification('Forma de pagamento atualizada.');
        return true;
      }
    }

    showNotification(
      'O servidor não confirmou o valor do app. Atualize o backend/sessão antes de confirmar o pagamento.'
    );
    return false;
  };

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

  const handleConfirmPaid = () => {
    if (!activeDraft) return;
    if (isConfirmingPaid) return;
    const draftId = activeDraft.id;
    setIsConfirmingPaid(true);
    void (async () => {
      const finalized = await handleSavePaymentMethod();
      if (!finalized) return;

      const ok = await runCommandWithSync(
        {
          type: 'SALE_DRAFT_CONFIRM_PAID',
          draftId,
        },
        'Pagamento confirmado. Estoque debitado.'
      );
      if (!ok) return;

      const opened = openReceiptPrintWindow(draftId);
      if (!opened) {
        showNotification(
          'Pagamento confirmado, mas o navegador bloqueou o cupom. Use o Histórico para segunda via.'
        );
      }

      setIsSaleOriginSetupOpen(false);
      setIsPaymentOpen(false);
      setIsCartOpen(false);
    })().finally(() => {
      setIsConfirmingPaid(false);
    });
  };

  const handleUndoLastSale = () => {
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

    if (confirm(confirmLabel)) {
      void runCommandWithSync({ type: 'SALE_UNDO_LAST' }, 'Venda Estornada!');
    }
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
    const useCashRegister = amount > 0 && options.useCashRegister === true;
    const purchaseDescription = useCashRegister ? options.purchaseDescription?.trim() : undefined;
    void runCommandWithSync(
      {
        type: 'INGREDIENT_STOCK_MOVE',
        ingredientId: id,
        amount,
        useCashRegister,
        purchaseDescription,
      },
      amount > 0
        ? useCashRegister
          ? 'Estoque atualizado e compra abatida do caixa!'
          : 'Estoque Atualizado!'
        : 'Gasto de Insumo Registrado!'
    );
  }, [runCommandWithSync]);

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
      if (!Number.isFinite(stockAmount) || stockAmount <= 0) {
        showNotification('Não foi possível calcular a quantidade de estoque para essa compra.');
        return false;
      }

      return runCommandWithSync(
        {
          type: 'INGREDIENT_STOCK_MOVE',
          ingredientId,
          amount: stockAmount,
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
    void runCommandWithSync({ type: 'INGREDIENT_CREATE', ingredient }, 'Ingrediente Adicionado!');
  };

  const handleEditIngredient = (ingredient: Ingredient) => {
    setIngredientToEdit(ingredient);
  };

  const handleSaveIngredient = (updated: Ingredient) => {
    void runCommandWithSync({ type: 'INGREDIENT_UPDATE', ingredient: updated }, 'Ingrediente Atualizado!');
  };

  const handleAddCleaningMaterial = (material: CleaningMaterial) => {
    void runCommandWithSync(
      { type: 'CLEANING_MATERIAL_CREATE', material },
      'Material de limpeza adicionado!'
    );
  };

  const handleUpdateCleaningMaterial = (updated: CleaningMaterial) => {
    void runCommandWithSync(
      { type: 'CLEANING_MATERIAL_UPDATE', material: updated },
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
    void runCommandWithSync(
      {
        type: 'CLEANING_STOCK_MOVE',
        materialId: id,
        amount,
      },
      amount > 0 ? 'Estoque de material atualizado!' : 'Baixa de material registrada!'
    );
  }, [runCommandWithSync]);

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
      saleCount: sales.length,
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

  useEffect(() => {
    if (!isPaymentOpen || !isAppSaleOriginActive) return;
    const timeoutId = window.setTimeout(() => {
      appOrderTotalInputRef.current?.focus();
      appOrderTotalInputRef.current?.select();
    }, 40);
    return () => window.clearTimeout(timeoutId);
  }, [isAppSaleOriginActive, isPaymentOpen, paymentOriginFxTick, saleOrigin]);

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
      <Header currentView={view} setView={setView} dailyTotal={dailyTotal} />
      <SyncStatusOverlay
        visible={isSyncIndicatorVisible}
        message={syncIndicatorMessage}
        pendingCount={Math.max(1, totalPendingOps)}
      />
      
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
                  disabled={sales.length === 0}
                  className="qb-btn-touch bg-slate-900 text-yellow-400 px-5 py-3 rounded-2xl font-black text-[10px] uppercase tracking-tighter shadow-xl hover:bg-black active:scale-95 transition-all disabled:opacity-30 disabled:grayscale disabled:scale-100 whitespace-nowrap flex items-center gap-2 group"
                  title="Desfazer o último pedido"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="group-hover:-rotate-45 transition-transform"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  Desfazer Última
                </button>
                <button
                  onClick={handleOpenUndoHistory}
                  disabled={recentUndoGroups.length === 0}
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
                  allIngredients={ingredients}
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
                  DRAFT não baixa estoque. Baixa só em PAID.
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
                              disabled={!canEditItems}
                              className="qb-btn-touch w-9 h-9 rounded-xl bg-yellow-400 text-red-800 font-black disabled:opacity-40"
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
                      if (paymentMethod === 'DIVIDIDO') {
                        setSplitCurrentMethod(method);
                        return;
                      }
                      setPaymentMethod(method);
                      setPaymentMethodBeforeSplitSetup(method);
                      resetSplitPaymentState();
                    }}
                    className={`qb-btn-touch qb-payment-method-btn px-2 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-wide border transition-all ${
                      (paymentMethod === 'DIVIDIDO' ? splitCurrentMethod === method : paymentMethod === method)
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
                    if (paymentMethod === 'DIVIDIDO') {
                      setPaymentMethod(paymentMethodBeforeSplitSetup);
                      resetSplitPaymentState();
                      return;
                    }
                    openSplitSetupModal();
                    }}
                    className={`qb-btn-touch w-full rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                      paymentMethod === 'DIVIDIDO'
                        ? 'border-amber-700 bg-amber-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-300'
                    }`}
                  >
                    {paymentMethod === 'DIVIDIDO' ? 'Cancelar Dividido' : 'Dividido'}
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
                {paymentMethod === 'DIVIDIDO' && splitMode && splitCount && (
                  <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-emerald-700">
                    {splitMode === 'PEOPLE'
                      ? `Pessoa ${Math.min(splitCurrentIndex + 1, splitCount)} de ${splitCount} • restante R$ ${formatMoney(splitRemainingAmount)}`
                      : `Parcela ${splitCommitted.length + 1} • restante R$ ${formatMoney(splitRemainingAmount)}`}
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
                  {!splitMode || !splitCount ? (
                    <p className="text-[11px] font-black uppercase tracking-widest text-slate-600">
                      Clique em Dividido e informe para quantas pessoas vai dividir.
                    </p>
                  ) : (
                    <>
                      {splitMode === 'PEOPLE' ? (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                          <p className="text-sm font-black text-slate-700">
                            {`Pessoa ${Math.min(splitCurrentIndex + 1, splitCount)} de ${splitCount}`}
                          </p>
                          <p className="mt-1 text-base font-black text-slate-900">
                            Valor desta pessoa:{' '}
                            <span className="text-red-600">R$ {formatMoney(splitCurrentFixedAmount || 0)}</span>
                          </p>
                        </div>
                      ) : (
                        <>
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                            {`Parcela ${splitCommitted.length + 1} • restante R$ ${formatMoney(splitRemainingAmount)}`}
                          </p>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={splitCurrentAmountInput}
                          onChange={(e) => setSplitCurrentAmountInput(e.target.value)}
                          className="w-full rounded-xl border border-slate-200 bg-slate-100 px-3 py-1.5 font-black text-sm leading-tight text-slate-800"
                          placeholder={formatMoney(splitRemainingAmount)}
                        />
                        </>
                      )}
                      {splitCurrentMethod === 'DINHEIRO' && (
                        <>
                          <label className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                            Valor recebido
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={splitCurrentCashReceivedInput}
                            onChange={(e) => setSplitCurrentCashReceivedInput(e.target.value)}
                            className="qb-payment-cash-input w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-1.5 font-black text-sm leading-tight text-slate-800"
                            placeholder="0,00"
                          />
                          {splitCurrentCashDelta !== null && (
                            <p className={`qb-payment-cash-status text-[11px] font-black ${splitCurrentCashDelta >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                              {splitCurrentCashDelta >= 0
                                ? `Troco: R$ ${formatMoney(splitCurrentCashDelta)}`
                                : `Faltam: R$ ${formatMoney(Math.abs(splitCurrentCashDelta))}`}
                            </p>
                          )}
                        </>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handleRemoveLastSplit}
                          disabled={splitCommitted.length === 0}
                          className="qb-btn-touch bg-slate-100 text-slate-700 px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors disabled:opacity-40"
                        >
                          Voltar
                        </button>
                        <button
                          type="button"
                          onClick={handleResetSplitPlan}
                          disabled={splitCommitted.length === 0}
                          className="qb-btn-touch bg-amber-100 text-amber-800 px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-amber-200 transition-colors disabled:opacity-40"
                        >
                          Reiniciar
                        </button>
                        <button
                          type="button"
                          onClick={handleCommitSplitStep}
                          disabled={!isSplitCurrentStepReady}
                          className="qb-btn-touch bg-emerald-600 text-white px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-emerald-700 transition-colors disabled:opacity-40"
                        >
                          {splitMode === 'PEOPLE' && splitCurrentIndex + 1 >= splitCount ? 'Concluir' : 'Próximo'}
                        </button>
                      </div>
                      {isSplitPlanComplete && (
                        <p className="text-[10px] font-black uppercase tracking-widest text-green-700">
                          Divisão concluída.
                        </p>
                      )}
                    </>
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
              <button
                onClick={handleConfirmPaid}
                disabled={isConfirmPaidDisabled}
                className="qb-btn-touch bg-green-600 text-white px-4 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-green-700 transition-colors disabled:opacity-40"
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
            <div className="fixed inset-0 z-[230] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded-3xl border-2 border-slate-100 bg-white p-4 shadow-2xl space-y-3">
                <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">
                  Dividir pagamento
                </h4>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Informe para quantas pessoas vai dividir. Se for 1, o sistema entende parcelas por forma de pagamento.
                </p>
                <input
                  type="number"
                  min="1"
                  max="30"
                  step="1"
                  value={splitPeopleInput}
                  onChange={(e) => setSplitPeopleInput(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-800"
                  placeholder="2"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMethod(paymentMethodBeforeSplitSetup);
                      resetSplitPaymentState();
                    }}
                    className="qb-btn-touch rounded-xl bg-slate-100 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 hover:bg-slate-200"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmSplitSetup}
                    className="qb-btn-touch rounded-xl bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white hover:bg-emerald-700"
                  >
                    Confirmar
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
