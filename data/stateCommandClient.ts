import type {
  CleaningMaterial,
  DailySalesHistoryEntry,
  Ingredient,
  Product,
  RecipeItem,
  SaleBasePaymentMethod,
  SaleCustomerType,
  SaleDraft,
  SaleOrigin,
  SalePaymentMethod,
  SalePaymentSplitMode,
  StockEntry,
} from '../types';
import { DEFAULT_APP_STATE, type AppState } from './appStorage';

const API_TIMEOUT_MS = 12000;
const COMMAND_MAX_ATTEMPTS = 8;
const COMMAND_RETRY_BASE_DELAY_MS = 500;
const COMMAND_RETRY_MAX_DELAY_MS = 8000;
const COMMAND_RETRY_BUDGET_MS = 35000;
const COMMAND_RETRY_JITTER_MIN = 0.75;
const COMMAND_RETRY_JITTER_MAX = 1.35;
const COMMAND_VERSION_CONFLICT_RETRY_BASE_DELAY_MS = 140;
const COMMAND_VERSION_CONFLICT_RETRY_MAX_DELAY_MS = 2200;
const DEFAULT_API_BASE_URL = 'https://xburger-backend.onrender.com';

type BaseCommand = {
  commandId?: string;
};

interface StateCommandSyncErrorOptions {
  statusCode?: number;
  retryable?: boolean;
  cause?: unknown;
}

export class StateCommandSyncError extends Error {
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(message: string, options: StateCommandSyncErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'StateCommandSyncError';
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
  }
}

export type StateCommand =
  | (BaseCommand & {
      type: 'SALE_REGISTER';
      productId: string;
      recipeOverride?: RecipeItem[];
      priceOverride?: number;
      clientSaleId?: string;
    })
  | (BaseCommand & {
      type: 'SALE_DRAFT_CREATE';
      draftId: string;
      customerType?: SaleCustomerType;
    })
  | (BaseCommand & {
      type: 'SALE_DRAFT_SET_CUSTOMER_TYPE';
      draftId: string;
      customerType?: SaleCustomerType;
    })
  | (BaseCommand & {
      type: 'SALE_DRAFT_ADD_ITEM';
      draftId: string;
      productId: string;
      quantity?: number;
      recipeOverride?: RecipeItem[];
      priceOverride?: number;
      note?: string;
    })
  | (BaseCommand & {
      type: 'SALE_DRAFT_UPDATE_ITEM';
      draftId: string;
      itemId: string;
      quantity?: number;
      note?: string;
    })
  | (BaseCommand & {
      type: 'SALE_DRAFT_REMOVE_ITEM';
      draftId: string;
      itemId: string;
    })
  | (BaseCommand & {
      type: 'SALE_DRAFT_FINALIZE';
      draftId: string;
      paymentMethod: SalePaymentMethod;
      cashReceived?: number;
      saleOrigin?: SaleOrigin;
      appOrderTotal?: number;
      splitMode?: SalePaymentSplitMode;
      splitCount?: number;
      splitPayments?: Array<{
        sequence?: number;
        label?: string;
        method: SaleBasePaymentMethod;
        amount: number;
        cashReceived?: number;
      }>;
    })
  | (BaseCommand & {
      type: 'SALE_DRAFT_CONFIRM_PAID';
      draftId: string;
    })
  | (BaseCommand & {
      type: 'SALE_DRAFT_CANCEL';
      draftId: string;
    })
  | (BaseCommand & { type: 'SALE_UNDO_LAST' })
  | (BaseCommand & { type: 'SALE_UNDO_BY_ID'; saleId: string })
  | (BaseCommand & {
      type: 'INGREDIENT_STOCK_MOVE';
      ingredientId: string;
      amount: number;
      useCashRegister?: boolean;
      purchaseDescription?: string;
    })
  | (BaseCommand & {
      type: 'CASH_EXPENSE';
      amount: number;
      purchaseDescription: string;
    })
  | (BaseCommand & {
      type: 'CASH_EXPENSE_REVERT';
      entryId: string;
    })
  | (BaseCommand & { type: 'INGREDIENT_CREATE'; ingredient: Ingredient })
  | (BaseCommand & { type: 'INGREDIENT_UPDATE'; ingredient: Ingredient })
  | (BaseCommand & { type: 'INGREDIENT_DELETE'; ingredientId: string })
  | (BaseCommand & { type: 'PRODUCT_CREATE'; product: Product })
  | (BaseCommand & { type: 'PRODUCT_UPDATE'; product: Product })
  | (BaseCommand & { type: 'PRODUCT_DELETE'; productId: string })
  | (BaseCommand & { type: 'CLEANING_MATERIAL_CREATE'; material: CleaningMaterial })
  | (BaseCommand & { type: 'CLEANING_MATERIAL_UPDATE'; material: CleaningMaterial })
  | (BaseCommand & { type: 'CLEANING_MATERIAL_DELETE'; materialId: string })
  | (BaseCommand & { type: 'CLEANING_STOCK_MOVE'; materialId: string; amount: number })
  | (BaseCommand & { type: 'SET_CASH_REGISTER'; amount: number })
  | (BaseCommand & { type: 'CLOSE_DAY' })
  | (BaseCommand & { type: 'CLEAR_HISTORY' })
  | (BaseCommand & { type: 'FACTORY_RESET' })
  | (BaseCommand & { type: 'CLEAR_OPERATIONAL_DATA' })
  | (BaseCommand & { type: 'CLEAR_ONLY_STOCK' })
  | (BaseCommand & { type: 'DELETE_ARCHIVE_SALES'; saleIds: string[] });

interface StateWriteContext {
  version: string;
  token: string;
  expiresAtMs: number | null;
}

let writeContext: StateWriteContext | null = null;
let writeContextRefreshInFlight: Promise<void> | null = null;

const getApiBaseUrl = (): string | null => {
  const raw = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE_URL;
  const normalized = raw?.trim().replace(/\/+$/, '');
  if (normalized) return normalized;
  return DEFAULT_API_BASE_URL;
};

const getStateApiUrl = (): string => {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    throw new Error('Base URL da API não configurada.');
  }
  return `${baseUrl}/api/v1/state`;
};

const getStateCommandsApiUrl = (): string => `${getStateApiUrl()}/commands`;
const getStateCommandsAsyncApiUrl = (): string => `${getStateCommandsApiUrl()}/async`;
const getStateCommandJobApiUrl = (jobId: string): string =>
  `${getStateCommandsApiUrl()}/jobs/${encodeURIComponent(jobId)}`;

export type StateCommandAsyncJobStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'RETRY'
  | 'COMPLETED'
  | 'FAILED';

export interface StateCommandAsyncJob {
  id: string;
  commandId: string;
  commandType: string;
  status: StateCommandAsyncJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  resultVersion: string | null;
}

const isRetryableHttpStatus = (statusCode: number): boolean =>
  statusCode === 408 ||
  statusCode === 412 ||
  statusCode === 425 ||
  statusCode === 428 ||
  statusCode === 429 ||
  statusCode >= 500;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, ms));
  });

const waitBeforeRetry = async (
  startedAtMs: number,
  attempt: number,
  delayMs: number
): Promise<boolean> => {
  if (attempt >= COMMAND_MAX_ATTEMPTS - 1) return false;
  const elapsed = Date.now() - startedAtMs;
  const remainingBudgetMs = COMMAND_RETRY_BUDGET_MS - elapsed;
  if (remainingBudgetMs <= 0) return false;
  await wait(Math.min(delayMs, remainingBudgetMs));
  return true;
};

const getRetryDelayMs = (attempt: number): number => {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = COMMAND_RETRY_BASE_DELAY_MS * 2 ** safeAttempt;
  const capped = Math.min(COMMAND_RETRY_MAX_DELAY_MS, exponential);
  const jitterFactor =
    COMMAND_RETRY_JITTER_MIN +
    Math.random() * (COMMAND_RETRY_JITTER_MAX - COMMAND_RETRY_JITTER_MIN);
  return Math.max(0, Math.round(capped * jitterFactor));
};

const getVersionConflictRetryDelayMs = (attempt: number): number => {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = COMMAND_VERSION_CONFLICT_RETRY_BASE_DELAY_MS * 2 ** safeAttempt;
  const capped = Math.min(COMMAND_VERSION_CONFLICT_RETRY_MAX_DELAY_MS, exponential);
  const jitterFactor =
    COMMAND_RETRY_JITTER_MIN +
    Math.random() * (COMMAND_RETRY_JITTER_MAX - COMMAND_RETRY_JITTER_MIN);
  return Math.max(0, Math.round(capped * jitterFactor));
};

const asRetryableNetworkError = (error: unknown): StateCommandSyncError => {
  if (error instanceof StateCommandSyncError) return error;
  const isAbortError =
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError';
  if (isAbortError) {
    return new StateCommandSyncError('Tempo limite ao comunicar com o servidor.', {
      retryable: true,
      cause: error,
    });
  }
  return new StateCommandSyncError('Falha de conexão com o servidor.', {
    retryable: true,
    cause: error,
  });
};

const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = API_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    try {
      return await fetch(input, {
        ...init,
        cache: init.cache ?? 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      throw asRetryableNetworkError(error);
    }
  } finally {
    globalThis.clearTimeout(timer);
  }
};

const normalizeVersionHeader = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^W\//i, '').replace(/^"(.+)"$/, '$1') || null;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeAsyncJobStatus = (value: unknown): StateCommandAsyncJobStatus => {
  if (value === 'PENDING') return 'PENDING';
  if (value === 'PROCESSING') return 'PROCESSING';
  if (value === 'RETRY') return 'RETRY';
  if (value === 'COMPLETED') return 'COMPLETED';
  if (value === 'FAILED') return 'FAILED';
  throw new Error('Status de job assíncrono inválido.');
};

const normalizeIsoDateString = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`Campo ${fieldName} ausente no job assíncrono.`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Campo ${fieldName} inválido no job assíncrono.`);
  }
  return new Date(parsed).toISOString();
};

const normalizeOptionalIsoDateString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
};

const normalizeAsyncJobPayload = (payload: unknown): StateCommandAsyncJob => {
  if (!isObjectRecord(payload)) {
    throw new Error('Resposta inválida ao enfileirar comando assíncrono.');
  }

  const jobRaw = isObjectRecord(payload.job) ? payload.job : null;
  if (!jobRaw) {
    throw new Error('Payload de job assíncrono ausente.');
  }

  const id = typeof jobRaw.id === 'string' ? jobRaw.id.trim() : '';
  const commandId = typeof jobRaw.commandId === 'string' ? jobRaw.commandId.trim() : '';
  const commandType = typeof jobRaw.commandType === 'string' ? jobRaw.commandType.trim() : '';
  if (!id || !commandId || !commandType) {
    throw new Error('Identificadores inválidos no job assíncrono.');
  }

  const attempts = Number(jobRaw.attempts);
  const maxAttempts = Number(jobRaw.maxAttempts);
  if (!Number.isFinite(attempts) || attempts < 0 || !Number.isFinite(maxAttempts) || maxAttempts <= 0) {
    throw new Error('Tentativas inválidas no job assíncrono.');
  }

  return {
    id,
    commandId,
    commandType,
    status: normalizeAsyncJobStatus(jobRaw.status),
    attempts: Math.floor(attempts),
    maxAttempts: Math.floor(maxAttempts),
    nextAttemptAt: normalizeIsoDateString(jobRaw.nextAttemptAt, 'nextAttemptAt'),
    createdAt: normalizeIsoDateString(jobRaw.createdAt, 'createdAt'),
    updatedAt: normalizeIsoDateString(jobRaw.updatedAt, 'updatedAt'),
    startedAt: normalizeOptionalIsoDateString(jobRaw.startedAt),
    finishedAt: normalizeOptionalIsoDateString(jobRaw.finishedAt),
    lastError: typeof jobRaw.lastError === 'string' ? jobRaw.lastError : null,
    resultVersion: typeof jobRaw.resultVersion === 'string' ? jobRaw.resultVersion : null,
  };
};

const decodeBase64Url = (value: string): string | null => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = `${normalized}${'='.repeat(padLength)}`;
  try {
    if (typeof atob === 'function') {
      return atob(padded);
    }
    return null;
  } catch {
    return null;
  }
};

const readJwtExpirationMs = (token: string): number | null => {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payloadRaw = decodeBase64Url(parts[1]);
  if (!payloadRaw) return null;
  try {
    const payload = JSON.parse(payloadRaw) as { exp?: unknown };
    const expSeconds = Number(payload.exp);
    if (!Number.isFinite(expSeconds) || expSeconds <= 0) return null;
    return expSeconds * 1000;
  } catch {
    return null;
  }
};

const isWriteContextExpiringSoon = (context: StateWriteContext, safetyWindowMs = 45000): boolean => {
  if (context.expiresAtMs === null) return false;
  return Date.now() + safetyWindowMs >= context.expiresAtMs;
};

const readContextFromResponse = (response: Response): StateWriteContext => {
  const version =
    normalizeVersionHeader(response.headers.get('x-state-version')) ??
    normalizeVersionHeader(response.headers.get('etag'));
  const token = response.headers.get('x-state-token')?.trim() ?? null;

  if (!version || !token) {
    throw new Error('Falha ao obter contexto seguro de escrita de estado.');
  }

  return { version, token, expiresAtMs: readJwtExpirationMs(token) };
};

const tryReadContextFromResponse = (response: Response): StateWriteContext | null => {
  try {
    return readContextFromResponse(response);
  } catch {
    return null;
  }
};

const toArray = <T>(value: unknown, fallback: T[]): T[] => (Array.isArray(value) ? (value as T[]) : [...fallback]);

const reviveTimestamp = <T extends { timestamp?: unknown }>(item: T): T => {
  const timestamp = item?.timestamp as unknown;
  if (timestamp && !(timestamp instanceof Date)) {
    return {
      ...item,
      timestamp: new Date(timestamp as string),
    };
  }
  return item;
};

const reviveTimestampList = <T extends { timestamp?: unknown }>(items: T[]): T[] =>
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
    closedAt: item.closedAt && !(item.closedAt instanceof Date) ? new Date(item.closedAt as string) : item.closedAt,
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

const normalizeAppState = (payload: unknown): AppState => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Resposta inválida de estado da API.');
  }

  const source = payload as Record<string, unknown>;
  return {
    ingredients: toArray(source.ingredients, DEFAULT_APP_STATE.ingredients),
    products: toArray(source.products, DEFAULT_APP_STATE.products),
    sales: reviveTimestampList(toArray(source.sales, DEFAULT_APP_STATE.sales)),
    stockEntries: normalizeStockEntryList(
      reviveTimestampList(toArray(source.stockEntries, DEFAULT_APP_STATE.stockEntries))
    ),
    cleaningMaterials: toArray(source.cleaningMaterials, DEFAULT_APP_STATE.cleaningMaterials),
    cleaningStockEntries: reviveTimestampList(
      toArray(source.cleaningStockEntries, DEFAULT_APP_STATE.cleaningStockEntries)
    ),
    globalSales: reviveTimestampList(toArray(source.globalSales, DEFAULT_APP_STATE.globalSales)),
    globalCancelledSales: reviveTimestampList(
      toArray(source.globalCancelledSales, DEFAULT_APP_STATE.globalCancelledSales)
    ),
    globalStockEntries: normalizeStockEntryList(
      reviveTimestampList(toArray(source.globalStockEntries, DEFAULT_APP_STATE.globalStockEntries))
    ),
    globalCleaningStockEntries: reviveTimestampList(
      toArray(source.globalCleaningStockEntries, DEFAULT_APP_STATE.globalCleaningStockEntries)
    ),
    saleDrafts: toArray<SaleDraft>(source.saleDrafts, DEFAULT_APP_STATE.saleDrafts),
    cashRegisterAmount: toNonNegativeNumber(
      source.cashRegisterAmount,
      DEFAULT_APP_STATE.cashRegisterAmount
    ),
    dailySalesHistory: reviveDailySalesHistory(
      toArray<DailySalesHistoryEntry>(source.dailySalesHistory, DEFAULT_APP_STATE.dailySalesHistory)
    ),
  };
};

interface ApiErrorPayload {
  error?: string;
  message?: string;
  requestId?: string;
  details?: {
    fieldErrors?: Record<string, string[] | undefined>;
    formErrors?: string[];
  };
}

const extractValidationDetail = (payload: ApiErrorPayload): string | null => {
  const formError = payload.details?.formErrors?.find((entry) => typeof entry === 'string' && entry.trim());
  if (formError) return formError.trim();

  const fieldErrors = payload.details?.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== 'object') return null;

  for (const [field, errors] of Object.entries(fieldErrors)) {
    if (!Array.isArray(errors) || errors.length === 0) continue;
    const firstError = errors.find((entry) => typeof entry === 'string' && entry.trim());
    if (firstError) return `${field}: ${firstError.trim()}`;
  }

  return null;
};

const readApiErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    const base = payload.error || payload.message || `Falha na API (${response.status}).`;
    const requestIdSuffix =
      typeof payload.requestId === 'string' && payload.requestId.trim()
        ? ` [req:${payload.requestId.trim()}]`
        : '';
    if (base === 'Payload inválido') {
      const detail = extractValidationDetail(payload);
      if (detail) return `${base}: ${detail}${requestIdSuffix}`;
    }
    return `${base}${requestIdSuffix}`;
  } catch {
    return `Falha na API (${response.status}).`;
  }
};

const toApiError = async (response: Response): Promise<StateCommandSyncError> => {
  const message = await readApiErrorMessage(response);
  return new StateCommandSyncError(message, {
    statusCode: response.status,
    retryable: isRetryableHttpStatus(response.status),
  });
};

const withCommandId = (command: StateCommand): StateCommand => {
  if (command.commandId && command.commandId.trim()) {
    return command;
  }
  return {
    ...command,
    commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
};

const refreshWriteContext = async (): Promise<void> => {
  const headResponse = await fetchWithTimeout(getStateApiUrl(), {
    method: 'HEAD',
  });

  if (headResponse.ok) {
    const headContext = tryReadContextFromResponse(headResponse);
    if (headContext) {
      writeContext = headContext;
      return;
    }
  } else if (headResponse.status !== 404 && headResponse.status !== 405) {
    throw await toApiError(headResponse);
  }

  const getResponse = await fetchWithTimeout(getStateApiUrl(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!getResponse.ok) {
    throw await toApiError(getResponse);
  }

  writeContext = readContextFromResponse(getResponse);
};

const ensureWriteContext = async (): Promise<void> => {
  if (writeContext && !isWriteContextExpiringSoon(writeContext)) {
    return;
  }

  if (!writeContextRefreshInFlight) {
    writeContextRefreshInFlight = refreshWriteContext().finally(() => {
      writeContextRefreshInFlight = null;
    });
  }

  await writeContextRefreshInFlight;
};

export const warmupStateWriteContext = async (): Promise<void> => {
  try {
    await ensureWriteContext();
  } catch {
    // Non-blocking warm-up: command execution path still retries with full error handling.
  }
};

export const runStateCommand = async (command: StateCommand): Promise<AppState> => {
  const payloadCommand = withCommandId(command);
  const startedAtMs = Date.now();

  for (let attempt = 0; attempt < COMMAND_MAX_ATTEMPTS; attempt += 1) {
    await ensureWriteContext();

    const context = writeContext;
    if (!context) {
      throw new StateCommandSyncError('Contexto de escrita indisponível.', {
        retryable: true,
      });
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(getStateCommandsApiUrl(), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'If-Match': `"${context.version}"`,
          'X-State-Token': context.token,
        },
        body: JSON.stringify(payloadCommand),
      });
    } catch (error) {
      const syncError = asRetryableNetworkError(error);
      if (
        syncError.retryable &&
        (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt)))
      ) {
        continue;
      }
      throw syncError;
    }

    if (response.ok) {
      writeContext = readContextFromResponse(response);
      const payload = (await response.json()) as unknown;
      return normalizeAppState(payload);
    }

    const isVersionConflictStatus = response.status === 412 || response.status === 428;
    if (response.status === 401 || isVersionConflictStatus) {
      writeContext = null;
      if (
        await waitBeforeRetry(
          startedAtMs,
          attempt,
          isVersionConflictStatus
            ? getVersionConflictRetryDelayMs(attempt)
            : getRetryDelayMs(attempt)
        )
      ) {
        continue;
      }
    }

    const apiError = await toApiError(response);
    if (
      apiError.retryable &&
      (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt)))
    ) {
      continue;
    }
    throw apiError;
  }

  throw new StateCommandSyncError('Não foi possível sincronizar o comando de estado.', {
    retryable: true,
  });
};

export const enqueueStateCommandAsync = async (
  command: StateCommand
): Promise<StateCommandAsyncJob> => {
  const payloadCommand = withCommandId(command);
  const startedAtMs = Date.now();

  for (let attempt = 0; attempt < COMMAND_MAX_ATTEMPTS; attempt += 1) {
    await ensureWriteContext();
    const context = writeContext;
    if (!context) {
      throw new StateCommandSyncError('Contexto de escrita indisponível.', {
        retryable: true,
      });
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(getStateCommandsAsyncApiUrl(), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-State-Token': context.token,
        },
        body: JSON.stringify(payloadCommand),
      });
    } catch (error) {
      const syncError = asRetryableNetworkError(error);
      if (
        syncError.retryable &&
        (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt)))
      ) {
        continue;
      }
      throw syncError;
    }

    if (response.ok) {
      const refreshedContext = tryReadContextFromResponse(response);
      if (refreshedContext) {
        writeContext = refreshedContext;
      }
      const payload = (await response.json()) as unknown;
      return normalizeAsyncJobPayload(payload);
    }

    if (response.status === 401) {
      writeContext = null;
      if (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt))) {
        continue;
      }
    }

    const apiError = await toApiError(response);
    if (
      apiError.retryable &&
      (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt)))
    ) {
      continue;
    }
    throw apiError;
  }

  throw new StateCommandSyncError('Não foi possível enfileirar o comando assíncrono.', {
    retryable: true,
  });
};

export const getStateCommandAsyncJob = async (jobId: string): Promise<StateCommandAsyncJob> => {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    throw new StateCommandSyncError('Job assíncrono inválido para consulta.', {
      retryable: false,
    });
  }
  const startedAtMs = Date.now();

  for (let attempt = 0; attempt < COMMAND_MAX_ATTEMPTS; attempt += 1) {
    await ensureWriteContext();
    const context = writeContext;
    if (!context) {
      throw new StateCommandSyncError('Contexto de escrita indisponível.', {
        retryable: true,
      });
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(getStateCommandJobApiUrl(normalizedJobId), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-State-Token': context.token,
        },
      });
    } catch (error) {
      const syncError = asRetryableNetworkError(error);
      if (
        syncError.retryable &&
        (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt)))
      ) {
        continue;
      }
      throw syncError;
    }

    if (response.ok) {
      const refreshedContext = tryReadContextFromResponse(response);
      if (refreshedContext) {
        writeContext = refreshedContext;
      }
      const payload = (await response.json()) as unknown;
      return normalizeAsyncJobPayload(payload);
    }

    if (response.status === 401) {
      writeContext = null;
      if (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt))) {
        continue;
      }
    }

    const apiError = await toApiError(response);
    if (
      apiError.retryable &&
      (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt)))
    ) {
      continue;
    }
    throw apiError;
  }

  throw new StateCommandSyncError('Não foi possível consultar o job assíncrono.', {
    retryable: true,
  });
};

export const fetchStateSnapshot = async (): Promise<AppState> => {
  const startedAtMs = Date.now();
  for (let attempt = 0; attempt < COMMAND_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(getStateApiUrl(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });
    } catch (error) {
      const syncError = asRetryableNetworkError(error);
      if (
        syncError.retryable &&
        (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt)))
      ) {
        continue;
      }
      throw syncError;
    }

    if (response.ok) {
      writeContext = readContextFromResponse(response);
      const payload = (await response.json()) as unknown;
      return normalizeAppState(payload);
    }

    const apiError = await toApiError(response);
    if (
      apiError.retryable &&
      (await waitBeforeRetry(startedAtMs, attempt, getRetryDelayMs(attempt)))
    ) {
      continue;
    }
    throw apiError;
  }

  throw new StateCommandSyncError('Não foi possível carregar o estado atualizado.', {
    retryable: true,
  });
};
