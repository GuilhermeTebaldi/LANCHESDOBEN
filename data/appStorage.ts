import {
  CleaningMaterial,
  CleaningStockEntry,
  DailySalesHistoryEntry,
  Ingredient,
  Product,
  Sale,
  SaleDraft,
  StockEntry,
} from '../types';
import { clearStore } from './localDb';

export interface AppState {
  ingredients: Ingredient[];
  products: Product[];
  sales: Sale[];
  stockEntries: StockEntry[];
  cleaningMaterials: CleaningMaterial[];
  cleaningStockEntries: CleaningStockEntry[];
  globalSales: Sale[];
  globalCancelledSales: Sale[];
  globalStockEntries: StockEntry[];
  globalCleaningStockEntries: CleaningStockEntry[];
  saleDrafts: SaleDraft[];
  cashRegisterAmount: number;
  dailySalesHistory: DailySalesHistoryEntry[];
}

interface LocalMirrorSnapshot {
  state: AppState;
  savedAtMs: number;
}

const API_TIMEOUT_MS = 12000;
const DEFAULT_API_BASE_URL = 'https://xburger-backend.onrender.com';
let hasRemoteHydratedState = false;
let remoteStateVersion: string | null = null;
let remoteStateToken: string | null = null;
let remoteSaveQueue: Promise<void> = Promise.resolve();
let isDefaultFallbackBootstrap = false;

const STORAGE_KEYS = {
  ingredients: 'qb_ingredients',
  products: 'qb_products',
  sales: 'qb_session_sales',
  stockEntries: 'qb_session_stock',
  cleaningMaterials: 'qb_cleaning_materials',
  cleaningStockEntries: 'qb_cleaning_stock',
  globalSales: 'qb_global_sales',
  globalCancelledSales: 'qb_global_cancelled',
  globalStockEntries: 'qb_global_stock_entries',
  globalCleaningStockEntries: 'qb_global_cleaning_stock_entries',
  saleDrafts: 'qb_sale_drafts',
  remoteStateMirror: 'qb_remote_state_mirror_v1',
  metaVersion: 'qb_meta_version',
};

const LEGACY_INGREDIENT_IDS = new Set([
  'i1',
  'i2',
  'i3',
  'i4',
  'i5',
  'i6',
  'i7',
  'i8',
  'i9',
  'i10',
  'i11',
]);

const LEGACY_PRODUCT_IDS = new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);

export const DEFAULT_APP_STATE: AppState = {
  ingredients: [],
  products: [],
  sales: [],
  stockEntries: [],
  cleaningMaterials: [],
  cleaningStockEntries: [],
  globalSales: [],
  globalCancelledSales: [],
  globalStockEntries: [],
  globalCleaningStockEntries: [],
  saleDrafts: [],
  cashRegisterAmount: 0,
  dailySalesHistory: [],
};

const DATA_KEYS = [
  STORAGE_KEYS.ingredients,
  STORAGE_KEYS.products,
  STORAGE_KEYS.sales,
  STORAGE_KEYS.stockEntries,
  STORAGE_KEYS.cleaningMaterials,
  STORAGE_KEYS.cleaningStockEntries,
  STORAGE_KEYS.globalSales,
  STORAGE_KEYS.globalCancelledSales,
  STORAGE_KEYS.globalStockEntries,
  STORAGE_KEYS.globalCleaningStockEntries,
  STORAGE_KEYS.saleDrafts,
];

const getApiBaseUrl = (): string | null => {
  const raw = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE_URL;
  const normalized = raw?.trim().replace(/\/+$/, '');
  if (normalized) return normalized;
  return DEFAULT_API_BASE_URL;
};

const getStateApiUrl = (): string | null => {
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}/api/v1/state` : null;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = API_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      cache: init.cache ?? 'no-store',
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timer);
  }
};

const toArray = <T>(value: unknown, fallback: T[]): T[] => {
  if (Array.isArray(value)) return value as T[];
  return [...fallback];
};

const reviveTimestamp = <T extends { timestamp?: unknown }>(item: T): T => {
  const timestamp = item?.timestamp as unknown;
  if (timestamp && !(timestamp instanceof Date)) {
    return { ...item, timestamp: new Date(timestamp as string) };
  }
  return item;
};

const reviveListWithDates = <T extends { timestamp?: unknown }>(items: T[]): T[] =>
  items.map(reviveTimestamp);

const normalizeStockEntryMetadata = (entry: StockEntry): StockEntry => {
  if (entry.source) return entry;
  if (typeof entry.saleId === 'string' && entry.saleId.trim()) {
    return { ...entry, source: 'SALE' };
  }
  if (typeof entry.id === 'string' && entry.id.startsWith('st-sale-')) {
    return { ...entry, source: 'SALE' };
  }
  return entry;
};

const normalizeStockEntryList = (items: StockEntry[]): StockEntry[] =>
  items.map(normalizeStockEntryMetadata);

const roundMoney = (value: number): number => Number(value.toFixed(2));
const LEGACY_COST_RATIO_MAX = 3.5;
const LEGACY_COST_RATIO_TARGET = 0.45;
const LEGACY_COST_DIVISORS = [1, 10, 100, 1000] as const;
const BUSINESS_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (value: number): string => value.toString().padStart(2, '0');
const toDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const normalizeBusinessDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!BUSINESS_DAY_KEY_PATTERN.test(trimmed)) return undefined;
  return trimmed;
};

const toNonNegativeNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

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

const normalizeDailyHistoryEntry = (item: DailySalesHistoryEntry): DailySalesHistoryEntry => {
  const closedAt =
    item.closedAt && !(item.closedAt instanceof Date) ? new Date(item.closedAt as string) : item.closedAt;
  const closedAtDate = closedAt instanceof Date ? closedAt : new Date(closedAt);
  const fallbackBusinessDate = Number.isNaN(closedAtDate.getTime()) ? toDayKey(new Date()) : toDayKey(closedAtDate);
  const totalRevenue = roundMoney(toNonNegativeNumber(item.totalRevenue));
  const rawTotalPurchases = Number(item.totalPurchases);
  const rawTotalProfit = Number(item.totalProfit);
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

  return {
    ...item,
    closedAt,
    businessDate: normalizeBusinessDate(item.businessDate) || fallbackBusinessDate,
    openingCash: roundMoney(toNonNegativeNumber(item.openingCash)),
    totalRevenue,
    totalPurchases: normalizedPurchases,
    totalProfit: roundMoney(totalRevenue - normalizedPurchases),
    saleCount: Number.isFinite(Number(item.saleCount)) ? Math.max(0, Math.floor(Number(item.saleCount))) : 0,
    cashExpenses: roundMoney(toNonNegativeNumber(item.cashExpenses ?? 0)),
  };
};

const reviveDailySalesHistory = (items: DailySalesHistoryEntry[]): DailySalesHistoryEntry[] =>
  items.map(normalizeDailyHistoryEntry);

const normalizeStateRecord = (
  source: Record<string, unknown>,
  defaults: AppState
): AppState => ({
  ingredients: toArray<Ingredient>(source.ingredients, defaults.ingredients),
  products: toArray<Product>(source.products, defaults.products),
  sales: reviveListWithDates(toArray<Sale>(source.sales, defaults.sales)),
  stockEntries: normalizeStockEntryList(
    reviveListWithDates(toArray<StockEntry>(source.stockEntries, defaults.stockEntries))
  ),
  cleaningMaterials: toArray<CleaningMaterial>(source.cleaningMaterials, defaults.cleaningMaterials),
  cleaningStockEntries: reviveListWithDates(
    toArray<CleaningStockEntry>(source.cleaningStockEntries, defaults.cleaningStockEntries)
  ),
  globalSales: reviveListWithDates(toArray<Sale>(source.globalSales, defaults.globalSales)),
  globalCancelledSales: reviveListWithDates(
    toArray<Sale>(source.globalCancelledSales, defaults.globalCancelledSales)
  ),
  globalStockEntries: normalizeStockEntryList(
    reviveListWithDates(toArray<StockEntry>(source.globalStockEntries, defaults.globalStockEntries))
  ),
  globalCleaningStockEntries: reviveListWithDates(
    toArray<CleaningStockEntry>(
      source.globalCleaningStockEntries,
      defaults.globalCleaningStockEntries
    )
  ),
  saleDrafts: toArray<SaleDraft>(source.saleDrafts, defaults.saleDrafts),
  cashRegisterAmount: toNonNegativeNumber(source.cashRegisterAmount, defaults.cashRegisterAmount),
  dailySalesHistory: reviveDailySalesHistory(
    toArray<DailySalesHistoryEntry>(source.dailySalesHistory, defaults.dailySalesHistory)
  ),
});

const normalizeVersionHeader = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const unquoted = trimmed.replace(/^W\//i, '').replace(/^"(.+)"$/, '$1');
  return unquoted || null;
};

const syncStateMetaFromResponse = (response: Response): void => {
  const version =
    normalizeVersionHeader(response.headers.get('x-state-version')) ??
    normalizeVersionHeader(response.headers.get('etag'));

  if (version) {
    remoteStateVersion = version;
  }

  const token = response.headers.get('x-state-token')?.trim();
  if (token) {
    remoteStateToken = token;
  }
};

const tryLoadRemoteState = async (defaults: AppState): Promise<AppState | null> => {
  const apiUrl = getStateApiUrl();
  if (!apiUrl) return null;

  try {
    const response = await fetchWithTimeout(apiUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) return null;
    syncStateMetaFromResponse(response);

    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    const normalized = normalizeStateRecord(payload as Record<string, unknown>, defaults);
    return sanitizeLegacySeeds(normalized);
  } catch {
    return null;
  }
};

const tryLoadRemoteStateWithRetry = async (
  defaults: AppState,
  attempts = 3,
  retryDelayMs = 600
): Promise<AppState | null> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const loaded = await tryLoadRemoteState(defaults);
    if (loaded) {
      return loaded;
    }

    if (attempt < attempts - 1) {
      await delay(retryDelayMs);
    }
  }

  return null;
};

const trySaveRemoteState = async (state: AppState): Promise<boolean> => {
  const apiUrl = getStateApiUrl();
  if (!apiUrl) return false;
  if (!remoteStateVersion || !remoteStateToken) return false;

  try {
    const response = await fetchWithTimeout(apiUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"${remoteStateVersion}"`,
        'X-State-Token': remoteStateToken,
      },
      body: JSON.stringify(state),
    });
    if (response.ok) {
      syncStateMetaFromResponse(response);
      return true;
    }

    if (response.status === 401 || response.status === 412 || response.status === 428) {
      remoteStateToken = null;
      remoteStateVersion = null;
    }
    return false;
  } catch {
    return false;
  }
};

const tryClearRemoteState = async (): Promise<boolean> => {
  const apiUrl = getStateApiUrl();
  if (!apiUrl) return false;
  if (!remoteStateVersion || !remoteStateToken) return false;

  try {
    const response = await fetchWithTimeout(apiUrl, {
      method: 'DELETE',
      headers: {
        'If-Match': `"${remoteStateVersion}"`,
        'X-State-Token': remoteStateToken,
      },
    });
    if (response.ok) {
      syncStateMetaFromResponse(response);
      return true;
    }

    if (response.status === 401 || response.status === 412 || response.status === 428) {
      remoteStateToken = null;
      remoteStateVersion = null;
    }
    return false;
  } catch {
    return false;
  }
};

const ensureRemoteWriteContext = async (): Promise<boolean> => {
  if (isDefaultFallbackBootstrap && !hasRemoteHydratedState) {
    return false;
  }

  if (remoteStateVersion && remoteStateToken) {
    return true;
  }

  const refreshed = await tryLoadRemoteStateWithRetry(DEFAULT_APP_STATE, 2, 400);
  if (!refreshed) {
    return false;
  }

  hasRemoteHydratedState = true;
  isDefaultFallbackBootstrap = false;
  saveLocalMirrorState(refreshed);
  return Boolean(remoteStateVersion && remoteStateToken);
};

const persistRemoteStateWithRetry = async (state: AppState): Promise<boolean> => {
  const remoteSaved = await trySaveRemoteState(state);
  if (remoteSaved) return true;

  const refreshed = await tryLoadRemoteStateWithRetry(DEFAULT_APP_STATE, 2, 400);
  if (!refreshed) {
    return false;
  }

  return trySaveRemoteState(state);
};

const loadLocalMirrorState = (defaults: AppState): LocalMirrorSnapshot | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.remoteStateMirror);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const mirrorRecord = parsed as Record<string, unknown>;
    const hasWrappedState = Object.prototype.hasOwnProperty.call(mirrorRecord, 'state');
    const source = hasWrappedState ? mirrorRecord.state : mirrorRecord;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return null;
    }

    const normalized = normalizeStateRecord(source as Record<string, unknown>, defaults);
    const savedAtRaw = mirrorRecord.savedAt;
    const savedAtMs =
      typeof savedAtRaw === 'string' ? Date.parse(savedAtRaw) : Number.NaN;

    return {
      state: sanitizeLegacySeeds(normalized),
      savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : 0,
    };
  } catch {
    return null;
  }
};

const saveLocalMirrorState = (state: AppState): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_KEYS.remoteStateMirror,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        state,
      })
    );
  } catch {
    // ignore storage write failures
  }
};

const sanitizeLegacySeeds = (state: AppState): AppState => {
  const products = state.products.filter((product) => !LEGACY_PRODUCT_IDS.has(product.id));
  const usedIngredientIds = new Set(
    products.flatMap((product) => product.recipe.map((item) => item.ingredientId))
  );

  const ingredients = state.ingredients.filter(
    (ing) => !LEGACY_INGREDIENT_IDS.has(ing.id) || usedIngredientIds.has(ing.id)
  );

  return {
    ...state,
    ingredients,
    products,
  };
};

const clearLegacyStorage = () => {
  if (typeof localStorage === 'undefined') return;
  DATA_KEYS.forEach((key) => localStorage.removeItem(key));
  localStorage.removeItem(STORAGE_KEYS.remoteStateMirror);
  localStorage.removeItem(STORAGE_KEYS.metaVersion);
};

export const loadAppState = async (defaults: AppState = DEFAULT_APP_STATE): Promise<AppState> => {
  const remoteState = await tryLoadRemoteStateWithRetry(defaults);
  const localMirror = loadLocalMirrorState(defaults);

  if (remoteState && localMirror) {
    const remoteVersionMs = remoteStateVersion ? Date.parse(remoteStateVersion) : Number.NaN;
    const shouldPreferLocal =
      Number.isFinite(localMirror.savedAtMs) &&
      Number.isFinite(remoteVersionMs) &&
      localMirror.savedAtMs > remoteVersionMs;

    if (shouldPreferLocal) {
      hasRemoteHydratedState = true;
      isDefaultFallbackBootstrap = false;
      saveLocalMirrorState(localMirror.state);
      return localMirror.state;
    }
  }

  if (remoteState) {
    hasRemoteHydratedState = true;
    isDefaultFallbackBootstrap = false;
    saveLocalMirrorState(remoteState);
    return remoteState;
  }

  if (localMirror) {
    hasRemoteHydratedState = false;
    isDefaultFallbackBootstrap = false;
    remoteStateVersion = null;
    remoteStateToken = null;
    console.warn('[appStorage] Backend indisponível. Carregando espelho local seguro.');
    return localMirror.state;
  }

  // Sem backend e sem espelho local: usa memória local até reidratação remota.
  hasRemoteHydratedState = false;
  isDefaultFallbackBootstrap = true;
  remoteStateVersion = null;
  remoteStateToken = null;
  console.warn('[appStorage] Falha ao carregar estado remoto. Mantendo estado em memória.');
  return sanitizeLegacySeeds(defaults);
};

export const saveAppState = async (state: AppState): Promise<void> => {
  saveLocalMirrorState(state);

  if (isDefaultFallbackBootstrap && !hasRemoteHydratedState) {
    console.warn('[appStorage] Persistência remota bloqueada até primeira carga confiável do backend.');
    return;
  }

  remoteSaveQueue = remoteSaveQueue
    .catch(() => undefined)
    .then(async () => {
      const remoteReady = await ensureRemoteWriteContext();
      if (!remoteReady) {
        console.warn('[appStorage] Persistência remota indisponível no momento.');
        return;
      }

      const saved = await persistRemoteStateWithRetry(state);
      if (!saved) {
        console.warn(
          '[appStorage] Falha ao persistir no backend remoto. Tentará novamente na próxima alteração.'
        );
      }
    });

  await remoteSaveQueue;
};

export const clearAppState = async (): Promise<void> => {
  if (!remoteStateVersion || !remoteStateToken) {
    await tryLoadRemoteState(DEFAULT_APP_STATE);
  }

  const remoteCleared = await tryClearRemoteState();
  if (!remoteCleared) {
    console.warn('[appStorage] Falha ao limpar estado no backend remoto.');
  }

  try {
    await clearStore();
  } catch {
    // ignore db cleanup failures
  }
  clearLegacyStorage();
};
