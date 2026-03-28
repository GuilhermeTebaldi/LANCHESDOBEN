
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
  type StateCommandAsyncJob,
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
  synchronizeComboProductRecipes,
} from './utils/recipe';
import {
  removeReceiptPrintPayload,
  saveReceiptPrintPayload,
  setReceiptPrintPayloadOnWindow,
  type ReceiptPrintPayload,
  type ReceiptPrintPayloadInput,
} from './utils/receiptPrintPayload';
import {
  fetchOperationalPanelEvents,
  reportErrorMonitorEvent,
  reportOperationalPanelEvent,
} from './utils/errorMonitorClient';
import {
  operationalStorage,
  type OperationalStorageResolvedResult,
} from './data/operationalStorage';
import {
  CommandSchedulerBackpressureError,
  createCommandScheduler,
  type CommandPriority,
  type CommandScheduler,
} from './data/commandScheduler';
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
const DRAFT_LIFECYCLE_STATE_KEY = 'qb_draft_lifecycle_state_v1';
const PENDING_PAID_SYNC_QUEUE_KEY = 'qb_pending_paid_sync_queue_v1';
const FAILED_PAID_SYNC_QUEUE_KEY = 'qb_failed_paid_sync_queue_v1';
const PAYMENT_FLOW_TELEMETRY_HISTORY_KEY = 'qb_payment_flow_telemetry_history_v1';
const OPERATIONS_EVENT_LOG_KEY = 'qb_operations_event_log_v1';
const CASH_HISTORY_LEGACY_MODE_KEY = 'qb_cash_history_legacy_mode_v1';
const LOCAL_CASH_REGISTER_KEY = 'qb_cash_register_local_v1';
const LOCAL_DAILY_HISTORY_KEY = 'qb_daily_sales_history_local_v1';
const RECEIPT_PAPER_WIDTH_KEY = 'qb_receipt_paper_width_mm';
const RECEIPT_PRINT_PRESET_STORAGE_KEY = 'qb_receipt_print_preset_v1';
const RESTAURANT_NAME_STORAGE_KEY = 'qb_restaurant_name';
const DEFAULT_RECEIPT_RESTAURANT_NAME = 'LANCHESDOBEN';
const AUTO_UPDATE_SCROLL_STATE_KEY = 'qb_auto_update_scroll_state_v1';
const LEGACY_PENDING_ADDS_DIAGNOSE_WINDOW_KEY = '__qbDiagnoseLegacyPendingAdds';
const AUTO_UPDATE_CHECK_INTERVAL_MS = 45_000;
const AUTO_UPDATE_FORCE_RELOAD_AFTER_MS = 10 * 60 * 1000;
const OPS_CLIENT_INSTANCE_KEY = 'qb_ops_client_instance_v1';
const OPS_REMOTE_EVENTS_POLL_INTERVAL_MS = 12_000;
const OPS_EVENT_LOG_UI_FLUSH_DEBOUNCE_MS = 350;
const PRINT_RETURN_FOCUS_GUARD_MS = 1800;

type SaleRegisterCommand = Extract<StateCommand, { type: 'SALE_REGISTER' }>;
type SaleDraftAddItemCommand = Extract<StateCommand, { type: 'SALE_DRAFT_ADD_ITEM' }>;
type PendingDraftAddStatus =
  | 'ACTIVE'
  | 'IN_FLIGHT'
  | 'CANCELLED'
  | 'APPLIED'
  | 'RECONCILED'
  | 'FAILED_TERMINAL';

type DraftLifecycleStage = 'OPEN' | 'FINALIZING' | 'PENDING_CONFIRM' | 'PAID' | 'CANCELLED';
type PendingDraftFlushPhase =
  | 'hydrate'
  | 'create_draft'
  | 'loop_read'
  | 'snapshot_prepare'
  | 'run_command'
  | 'status_persist';

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
  updatedAt: string;
  status: PendingDraftAddStatus;
  terminalReason?: string;
}

interface LegacyPendingAddDiagnosticEntry {
  source: PendingDraftAddsSource;
  draftId: string;
  localItemId: string;
  commandId: string;
  productId: string;
  productName: string;
  quantity: number;
  status: PendingDraftAddStatus;
  queuedAt: string;
  updatedAt: string;
  recipeOverrideLength: 0;
  fallbackProductRecipeLength: number;
}

interface LegacyPendingAddsDiagnosisReport {
  generatedAt: string;
  totals: {
    scannedEntries: number;
    legacyWithoutRecipeOverride: number;
    bySource: Record<PendingDraftAddsSource, number>;
    byStatus: Record<PendingDraftAddStatus, number>;
  };
  legacyEntries: LegacyPendingAddDiagnosticEntry[];
}

interface PendingDraftAddCancellationIntent {
  draftId: string;
  localItemId: string;
  commandId: string;
  productId: string;
  quantity: number;
  recipeSignature: string;
  noteNormalized: string;
  unitPriceSnapshot: number;
  cancelledAt: string;
}

type PendingDraftAddsByDraftId = Record<string, PendingDraftAdd[]>;
type PendingDraftAddsSource = 'visible' | 'recovery';

interface DraftLifecycleStateRecord {
  stage: DraftLifecycleStage;
  epoch: number;
  updatedAt: string;
}

type DraftLifecycleStateByDraftId = Record<string, DraftLifecycleStateRecord>;

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

interface OperationalEventTiming {
  applyStateMs: number;
  persistDispatchMs: number;
  reportDispatchMs: number;
  totalMs: number;
}

interface GlobalQueueWaitMeta {
  queueDepthAtEnqueue: number;
  activeCommandType: StateCommand['type'] | null;
  activeDraftId: string | null;
  activeCommandElapsedMs: number;
  lastCompletedCommandType: StateCommand['type'] | null;
  lastCompletedDraftId: string | null;
  lastCompletedDurationMs: number;
}

interface RunCommandOptions {
  skipOfflineQueue?: boolean;
  silentSuccessNotification?: boolean;
  silentErrorNotification?: boolean;
  errorSink?: RunCommandErrorSink;
  trackPendingState?: boolean;
  failFastOnVersionConflict?: boolean;
  skipObsoleteCheck?: boolean;
  skipSnapshotApply?: boolean;
  bypassGlobalCommandQueue?: boolean;
  onSnapshotAppliedMs?: (durationMs: number) => void;
  onStateCommandRoundtripTiming?: (timing: { requestMs: number; backendMs: number }) => void;
  onDraftLockWaitMs?: (durationMs: number) => void;
  onGlobalQueueWaitMs?: (durationMs: number) => void;
  onGlobalQueueMeta?: (meta: GlobalQueueWaitMeta) => void;
  onBackendSchedulerWaitMs?: (durationMs: number) => void;
}

interface BackendExecutionOptions {
  operationType: string;
  command?: StateCommand;
  commandId?: string;
  draftId?: string | null;
  retryCount?: number;
  onSchedulerWaitMs?: (durationMs: number) => void;
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

interface PaymentFlowTelemetryEntry {
  draftId: string;
  jobId: string;
  clickAtMs: number;
  localPersistedAtMs: number | null;
  processingStartedAtMs: number | null;
  flushPendingDraftAddsMs: number;
  finalizeMs: number;
  confirmMs: number;
  snapshotApplyMs: number;
  frontendReconcileMs: number;
  stateRefreshMs: number;
  recoveryMs: number;
  retryBackoffMs: number;
  // p_* fields decompose processingMs into the paid-sync critical subphases.
  pFlushMs: number;
  pPrepareMs: number;
  pRequestMs: number;
  pBackendMs: number;
  pApplySnapshotMs: number;
  pReconcileMs: number;
  pPersistMs: number;
  pOpsMs: number;
  pFinalizeMs: number;
  flushLockWaitMs: number;
  flushPendingReadMs: number;
  flushSnapshotPrepareMs: number;
  flushVisibleRunMs: number;
  flushRecoveryRunMs: number;
  flushStateRefreshMs: number;
  flushApplySnapshotMs: number;
  flushTerminalCleanupMs: number;
  flushOperationalPersistMs: number;
  flushUiReleaseMs: number;
  flushPostReturnMs: number;
  confirmCommandInvokeMs: number;
  confirmDraftLockWaitMs: number;
  confirmGlobalQueueWaitMs: number;
  confirmGlobalQueueDepthAtEnqueue: number;
  confirmSchedulerWaitMs: number;
  confirmPostCommandApplyMs: number;
  confirmOpsMs: number;
  confirmFailureHandlingMs: number;
  stateRefreshEmptyDraftCheckMs: number;
  stateRefreshAfterFlushMs: number;
  stateRefreshBeforeFinalizeMs: number;
  pOpsBackendSentMs: number;
  pOpsBackendAckMs: number;
  pOpsEventStateMs: number;
  pOpsEventPersistMs: number;
  pOpsEventReportMs: number;
  retries: number;
  hadRecovery: boolean;
  hadReconciliation: boolean;
}

interface PaymentFlowTelemetryRecord {
  draftId: string;
  jobId: string;
  clickToLocalPersistMs: number | null;
  waitInQueueMs: number | null;
  processingMs: number | null;
  totalConfMs: number | null;
  flushPendingDraftAddsMs: number | null;
  finalizeMs: number | null;
  confirmMs: number | null;
  snapshotApplyMs: number | null;
  frontendReconcileMs: number | null;
  stateRefreshMs: number | null;
  recoveryMs: number | null;
  retryBackoffMs: number | null;
  pFlushMs: number | null;
  pPrepareMs: number | null;
  pRequestMs: number | null;
  pBackendMs: number | null;
  pApplySnapshotMs: number | null;
  pReconcileMs: number | null;
  pPersistMs: number | null;
  pOpsMs: number | null;
  pFinalizeMs: number | null;
  flushLockWaitMs: number | null;
  flushPendingReadMs: number | null;
  flushSnapshotPrepareMs: number | null;
  flushVisibleRunMs: number | null;
  flushRecoveryRunMs: number | null;
  flushStateRefreshMs: number | null;
  flushApplySnapshotMs: number | null;
  flushTerminalCleanupMs: number | null;
  flushOperationalPersistMs: number | null;
  flushUiReleaseMs: number | null;
  flushPostReturnMs: number | null;
  flushOtherMs: number | null;
  confirmCommandInvokeMs: number | null;
  confirmDraftLockWaitMs: number | null;
  confirmGlobalQueueWaitMs: number | null;
  confirmGlobalQueueDepthAtEnqueue: number | null;
  confirmSchedulerWaitMs: number | null;
  confirmPostCommandApplyMs: number | null;
  confirmOpsMs: number | null;
  confirmFailureHandlingMs: number | null;
  confirmOtherMs: number | null;
  stateRefreshEmptyDraftCheckMs: number | null;
  stateRefreshAfterFlushMs: number | null;
  stateRefreshBeforeFinalizeMs: number | null;
  stateRefreshOtherMs: number | null;
  pOpsBackendSentMs: number | null;
  pOpsBackendAckMs: number | null;
  pOpsEventStateMs: number | null;
  pOpsEventPersistMs: number | null;
  pOpsEventReportMs: number | null;
  pOpsOtherMs: number | null;
  clickToBackendConfirmMs: number | null;
  retries: number;
  hadRecovery: boolean;
  hadReconciliation: boolean;
  timestamp: string;
}

interface OperationalHealthSnapshot {
  timestamp: string;
  schedulerActive: number;
  schedulerQueued: number;
  schedulerCriticalQueued: number;
  schedulerHighQueued: number;
  schedulerNormalQueued: number;
  schedulerLowQueued: number;
  schedulerBackpressureHits: number;
  schedulerDedupeHits: number;
  pendingDraftAdds: number;
  pendingPaidQueue: number;
  failedQueue: number;
  failsafeActivations: number;
  failsafeDeferredCommands: number;
  failsafeCurrentPauseMs: number;
  failsafeAccumulatedPausedMs: number;
}

interface OperationalEventLogEntry {
  id: string;
  type:
    | 'OPS_HEALTH'
    | 'HEALTH_SNAPSHOT'
    | 'QUEUE_HEALTH'
    | 'FAILSAFE_ACTIVATED'
    | 'FAILSAFE_CLEARED'
    | 'BACKPRESSURE'
    | 'PAYMENT_FLOW'
    | 'COMMAND_SKIPPED_OBSOLETE'
    | 'CART_REMOVE_LOCAL_PENDING'
    | 'CART_REMOVE_REMOTE'
    | 'PENDING_ADD_CANCELLED';
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
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

const readOrCreateOpsClientInstanceId = (): string => {
  if (typeof window === 'undefined') return createClientId('ops-client');
  try {
    const existing = window.localStorage.getItem(OPS_CLIENT_INSTANCE_KEY);
    if (existing && existing.trim()) {
      return existing.trim();
    }
  } catch {
    // ignore storage read failures
  }
  const created = createClientId('ops-client');
  try {
    window.localStorage.setItem(OPS_CLIENT_INSTANCE_KEY, created);
  } catch {
    // ignore storage write failures
  }
  return created;
};

const isLocalPendingDraftItemId = (itemId: string): boolean =>
  typeof itemId === 'string' && itemId.startsWith('draft-item-local-');

const buildPendingDraftAddRuntimeKey = (draftId: string, localItemId: string): string =>
  `${draftId.trim()}::${localItemId.trim()}`;

const PENDING_DRAFT_ADD_TERMINAL_STATUSES = new Set<PendingDraftAddStatus>([
  'CANCELLED',
  'RECONCILED',
  'FAILED_TERMINAL',
]);

const PENDING_DRAFT_ADD_RESTORE_BLOCK_STATUSES = new Set<PendingDraftAddStatus>([
  'CANCELLED',
  'RECONCILED',
  'FAILED_TERMINAL',
]);

const PENDING_DRAFT_ADD_STATUS_PRIORITY: Record<PendingDraftAddStatus, number> = {
  CANCELLED: 600,
  RECONCILED: 500,
  FAILED_TERMINAL: 400,
  APPLIED: 300,
  IN_FLIGHT: 200,
  ACTIVE: 100,
};
const PENDING_DRAFT_ADD_TERMINAL_RETENTION_MS = 12 * 60 * 60 * 1000;
const PENDING_DRAFT_ADD_APPLIED_RETENTION_MS = 2 * 60 * 60 * 1000;
const PENDING_DRAFT_ADD_IN_FLIGHT_STALE_MS = 90 * 1000;

const normalizePendingDraftAddStatus = (value: unknown): PendingDraftAddStatus => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (
    normalized === 'ACTIVE' ||
    normalized === 'IN_FLIGHT' ||
    normalized === 'CANCELLED' ||
    normalized === 'APPLIED' ||
    normalized === 'RECONCILED' ||
    normalized === 'FAILED_TERMINAL'
  ) {
    return normalized;
  }
  return 'ACTIVE';
};

const normalizeDraftLifecycleStage = (value: unknown): DraftLifecycleStage => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (
    normalized === 'OPEN' ||
    normalized === 'FINALIZING' ||
    normalized === 'PENDING_CONFIRM' ||
    normalized === 'PAID' ||
    normalized === 'CANCELLED'
  ) {
    return normalized;
  }
  return 'OPEN';
};

const isPendingDraftAddTerminalStatus = (status: PendingDraftAddStatus): boolean =>
  PENDING_DRAFT_ADD_TERMINAL_STATUSES.has(status);

const isPendingDraftAddVisible = (entry: PendingDraftAdd): boolean =>
  entry.status === 'ACTIVE' || entry.status === 'IN_FLIGHT';

const isPendingDraftAddExecutable = (entry: PendingDraftAdd): boolean =>
  entry.status === 'ACTIVE';

const shouldBlockPendingDraftAddRestore = (entry: PendingDraftAdd): boolean =>
  PENDING_DRAFT_ADD_RESTORE_BLOCK_STATUSES.has(entry.status);

const withPendingDraftAddStatus = (
  entry: PendingDraftAdd,
  status: PendingDraftAddStatus,
  terminalReason?: string
): PendingDraftAdd => {
  const normalizedReason = terminalReason?.trim();
  return {
    ...entry,
    status,
    updatedAt: new Date().toISOString(),
    terminalReason:
      normalizedReason !== undefined
        ? normalizedReason || undefined
        : isPendingDraftAddTerminalStatus(status)
          ? entry.terminalReason
          : undefined,
  };
};

const countVisiblePendingDraftAdds = (entries: PendingDraftAdd[]): number =>
  entries.reduce((total, entry) => (isPendingDraftAddVisible(entry) ? total + 1 : total), 0);

const isPendingDraftAddInFlightStale = (entry: PendingDraftAdd, nowMs = Date.now()): boolean => {
  if (entry.status !== 'IN_FLIGHT') return false;
  const updatedAtMs = Date.parse(entry.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return true;
  return nowMs - updatedAtMs >= PENDING_DRAFT_ADD_IN_FLIGHT_STALE_MS;
};

const hasPendingDraftAddBackgroundSyncWork = (
  entries: PendingDraftAdd[],
  nowMs = Date.now()
): boolean => {
  return entries.some((entry) => isPendingDraftAddExecutable(entry) || isPendingDraftAddInFlightStale(entry, nowMs));
};

const shouldRetainPendingDraftAddEntry = (
  entry: PendingDraftAdd,
  nowMs = Date.now()
): boolean => {
  const updatedAtMs = Date.parse(entry.updatedAt);
  const fallbackAgeMs = 0;
  const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : fallbackAgeMs;
  if (entry.status === 'APPLIED') {
    return ageMs <= PENDING_DRAFT_ADD_APPLIED_RETENTION_MS;
  }
  if (isPendingDraftAddTerminalStatus(entry.status)) {
    return ageMs <= PENDING_DRAFT_ADD_TERMINAL_RETENTION_MS;
  }
  return true;
};

const buildPendingDraftAddSemanticKey = (params: {
  draftId: string;
  productId: string;
  recipeSignature: string;
  noteNormalized: string;
}): string => {
  return `${params.draftId.trim()}::${params.productId.trim()}::${params.recipeSignature}::${params.noteNormalized}`;
};

const buildPendingDraftAddSemanticKeyFromEntry = (entry: PendingDraftAdd): string =>
  buildPendingDraftAddSemanticKey({
    draftId: entry.draftId,
    productId: entry.productId,
    recipeSignature: normalizeRecipeSignature(entry.recipeOverride),
    noteNormalized: normalizeDraftItemNoteForMatch(entry.note),
  });

const normalizeDraftItemNoteForMatch = (note: string | undefined): string =>
  typeof note === 'string' ? note.trim() : '';

const areDraftItemUnitPricesEquivalent = (left: number, right: number): boolean =>
  Math.abs(left - right) <= 0.009;

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

const buildSaleOrderSettlementKey = (sale: Sale): string => {
  const paymentConfirmedAtRaw = sale.payment?.confirmedAt;
  if (paymentConfirmedAtRaw instanceof Date || typeof paymentConfirmedAtRaw === 'string') {
    const paymentConfirmedAt = toSaleDate(paymentConfirmedAtRaw);
    if (paymentConfirmedAt) {
      return `confirmed:${paymentConfirmedAt.toISOString()}`;
    }
  }
  const saleTimestamp = toSaleDate(sale.timestamp);
  if (saleTimestamp) {
    return `timestamp:${saleTimestamp.toISOString()}`;
  }
  const saleId = typeof sale.id === 'string' ? sale.id.trim() : '';
  if (saleId) {
    return `id:${saleId}`;
  }
  return 'unknown';
};

const buildSaleOrderGroupKey = (sale: Sale, fallbackIndex: number): string => {
  const draftId = typeof sale.saleDraftId === 'string' ? sale.saleDraftId.trim() : '';
  if (draftId) return `draft:${draftId}:${buildSaleOrderSettlementKey(sale)}`;
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

const buildAutoRequeuePaymentSnapshot = (draft: SaleDraft): PaymentCommitSnapshot | null => {
  const paymentMethod = draft.payment.method;
  if (!paymentMethod) return null;
  if (!Array.isArray(draft.items) || draft.items.length === 0) return null;

  const saleOrigin = draft.saleOrigin || 'LOCAL';
  const appOrderTotalInput = isAppSaleOrigin(saleOrigin)
    ? String(resolveDraftExpectedPaymentTotal(draft, saleOrigin))
    : '';
  const cashReceivedInput =
    paymentMethod === 'DINHEIRO' && Number.isFinite(Number(draft.payment.cashReceived))
      ? String(roundMoney(Number(draft.payment.cashReceived)))
      : '';

  let splitCommitted: SalePaymentSplitEntry[] = [];
  let splitMode: SalePaymentSplitMode | null = null;
  let splitCount: number | null = null;
  if (paymentMethod === 'DIVIDIDO') {
    const normalizedSplits = (draft.payment.splitPayments || [])
      .filter((entry): entry is SalePaymentSplitEntry => BASE_PAYMENT_METHODS.includes(entry.method))
      .map((entry, index) => {
        const amount = Number(entry.amount);
        const safeAmount = Number.isFinite(amount) && amount > 0 ? roundMoney(amount) : 0;
        const cashReceived =
          entry.method === 'DINHEIRO' && Number.isFinite(Number(entry.cashReceived))
            ? roundMoney(Number(entry.cashReceived))
            : null;
        const change =
          entry.method === 'DINHEIRO'
            ? cashReceived !== null
              ? roundMoney(cashReceived - safeAmount)
              : null
            : null;
        return {
          sequence:
            Number.isFinite(Number(entry.sequence)) && Number(entry.sequence) > 0
              ? Math.floor(Number(entry.sequence))
              : index + 1,
          label: entry.label?.trim() || `Parcela ${index + 1}`,
          method: entry.method,
          amount: safeAmount,
          cashReceived,
          change,
        };
      })
      .filter((entry) => entry.amount > 0);

    if (normalizedSplits.length === 0) return null;
    splitCommitted = normalizedSplits;
    splitMode = draft.payment.splitMode || 'MIXED';
    const rawSplitCount = Number(draft.payment.splitCount);
    splitCount =
      Number.isFinite(rawSplitCount) && rawSplitCount > 0
        ? Math.floor(rawSplitCount)
        : splitMode === 'PEOPLE'
          ? normalizedSplits.length
          : 1;
  }

  return clonePaymentCommitSnapshot({
    draft,
    paymentMethod,
    saleOrigin,
    appOrderTotalInput,
    cashReceivedInput,
    splitMode,
    splitCount,
    splitCommitted,
    effectivePaymentTotal: resolveDraftExpectedPaymentTotal(draft, saleOrigin),
  });
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

const isConfirmBeforeFinalizeErrorMessage = (message: string): boolean => {
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalized.includes('venda ainda nao foi finalizada para pagamento');
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
  if (isConfirmBeforeFinalizeErrorMessage(message)) {
    return false;
  }
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return (
    normalized.includes('conflito de versao') ||
    normalized.includes('token de estado desatualizado') ||
    normalized.includes('nao e possivel finalizar esta venda')
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
  jobId: string,
  readJob: (jobId: string) => Promise<StateCommandAsyncJob>
): Promise<{
  status: StateCommandAsyncJobStatus;
  lastError: string | null;
}> => {
  const startedAt = Date.now();
  let pollAttempt = 0;

  while (Date.now() - startedAt < ASYNC_COMMAND_JOB_POLL_TIMEOUT_MS) {
    const job = await readJob(jobId);
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

const getCommandDraftId = (command: StateCommand): string | null => {
  if (!('draftId' in command)) return null;
  const normalizedDraftId = command.draftId.trim();
  return normalizedDraftId || null;
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
  const updatedAtCandidate =
    typeof source.updatedAt === 'string' && !Number.isNaN(Date.parse(source.updatedAt))
      ? source.updatedAt
      : queuedAtCandidate;
  const status = normalizePendingDraftAddStatus(source.status);
  const terminalReasonCandidate =
    typeof source.terminalReason === 'string' ? source.terminalReason.trim() : '';

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
    updatedAt: updatedAtCandidate,
    status,
    terminalReason:
      isPendingDraftAddTerminalStatus(status) && terminalReasonCandidate
        ? terminalReasonCandidate
        : undefined,
  };
};

const normalizePendingDraftAddsRecord = (parsed: unknown): PendingDraftAddsByDraftId => {
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
};

const loadPendingDraftAddsLocalFallback = (): PendingDraftAddsByDraftId =>
  normalizePendingDraftAddsRecord(
    operationalStorage.getLocalFallback<unknown>(PENDING_DRAFT_ADDS_KEY)
  );

const loadPendingDraftAddsResolved = async (): Promise<
  OperationalStorageResolvedResult<PendingDraftAddsByDraftId>
> => {
  const resolved = await operationalStorage.getResolved<unknown>(PENDING_DRAFT_ADDS_KEY);
  return {
    ...resolved,
    value: normalizePendingDraftAddsRecord(resolved.value),
  };
};

const savePendingDraftAdds = (pendingAdds: PendingDraftAddsByDraftId): void => {
  void operationalStorage.setCritical(PENDING_DRAFT_ADDS_KEY, pendingAdds);
};

const savePendingDraftAddsBackground = (pendingAdds: PendingDraftAddsByDraftId): void => {
  void operationalStorage.set(PENDING_DRAFT_ADDS_KEY, pendingAdds);
};

const normalizeDraftLifecycleStateRecord = (value: unknown): DraftLifecycleStateRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const stage = normalizeDraftLifecycleStage(source.stage);
  const epochRaw = Number(source.epoch);
  const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
  const updatedAt =
    typeof source.updatedAt === 'string' && !Number.isNaN(Date.parse(source.updatedAt))
      ? source.updatedAt
      : new Date().toISOString();
  return { stage, epoch, updatedAt };
};

const normalizeDraftLifecycleStateMap = (parsed: unknown): DraftLifecycleStateByDraftId => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const next: DraftLifecycleStateByDraftId = {};
  Object.entries(record).forEach(([draftId, value]) => {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) return;
    const normalized = normalizeDraftLifecycleStateRecord(value);
    if (!normalized || normalized.stage === 'OPEN') return;
    next[normalizedDraftId] = normalized;
  });
  return next;
};

const loadDraftLifecycleStateLocalFallback = (): DraftLifecycleStateByDraftId =>
  normalizeDraftLifecycleStateMap(
    operationalStorage.getLocalFallback<unknown>(DRAFT_LIFECYCLE_STATE_KEY)
  );

const saveDraftLifecycleState = (value: DraftLifecycleStateByDraftId): void => {
  void operationalStorage.setCritical(DRAFT_LIFECYCLE_STATE_KEY, value);
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

const normalizePendingPaidSyncQueueRecord = (parsed: unknown): PendingPaidSyncJob[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => normalizePendingPaidSyncJob(entry))
    .filter((entry): entry is PendingPaidSyncJob => entry !== null);
};

const loadPendingPaidSyncQueueLocalFallback = (): PendingPaidSyncJob[] =>
  normalizePendingPaidSyncQueueRecord(
    operationalStorage.getLocalFallback<unknown>(PENDING_PAID_SYNC_QUEUE_KEY)
  );

const loadPendingPaidSyncQueueResolved = async (): Promise<
  OperationalStorageResolvedResult<PendingPaidSyncJob[]>
> => {
  const resolved = await operationalStorage.getResolved<unknown>(PENDING_PAID_SYNC_QUEUE_KEY);
  return {
    ...resolved,
    value: normalizePendingPaidSyncQueueRecord(resolved.value),
  };
};

const savePendingPaidSyncQueue = (queue: PendingPaidSyncJob[]): void => {
  void operationalStorage.setCritical(PENDING_PAID_SYNC_QUEUE_KEY, queue);
};

const loadFailedPaidSyncQueueLocalFallback = (): PendingPaidSyncJob[] =>
  normalizePendingPaidSyncQueueRecord(
    operationalStorage.getLocalFallback<unknown>(FAILED_PAID_SYNC_QUEUE_KEY)
  );

const loadFailedPaidSyncQueueResolved = async (): Promise<
  OperationalStorageResolvedResult<PendingPaidSyncJob[]>
> => {
  const resolved = await operationalStorage.getResolved<unknown>(FAILED_PAID_SYNC_QUEUE_KEY);
  return {
    ...resolved,
    value: normalizePendingPaidSyncQueueRecord(resolved.value),
  };
};

const saveFailedPaidSyncQueue = (queue: PendingPaidSyncJob[]): void => {
  void operationalStorage.setCritical(FAILED_PAID_SYNC_QUEUE_KEY, queue);
};

const normalizePaymentFlowTelemetryRecord = (
  value: unknown
): PaymentFlowTelemetryRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const draftId = typeof source.draftId === 'string' ? source.draftId.trim() : '';
  const jobId = typeof source.jobId === 'string' ? source.jobId.trim() : '';
  if (!draftId || !jobId) return null;
  const clickToLocalPersistRaw = Number(source.clickToLocalPersistMs);
  const waitInQueueRaw = Number(source.waitInQueueMs);
  const processingRaw = Number(source.processingMs);
  const totalConfRaw = Number(source.totalConfMs);
  const flushPendingDraftAddsRaw = Number(source.flushPendingDraftAddsMs);
  const finalizeRaw = Number(source.finalizeMs);
  const confirmRaw = Number(source.confirmMs);
  const snapshotApplyRaw = Number(source.snapshotApplyMs);
  const frontendReconcileRaw = Number(source.frontendReconcileMs);
  const stateRefreshRaw = Number(source.stateRefreshMs);
  const recoveryRaw = Number(source.recoveryMs);
  const retryBackoffRaw = Number(source.retryBackoffMs);
  const pFlushRaw = Number(source.pFlushMs);
  const pPrepareRaw = Number(source.pPrepareMs);
  const pRequestRaw = Number(source.pRequestMs);
  const pBackendRaw = Number(source.pBackendMs);
  const pApplySnapshotRaw = Number(source.pApplySnapshotMs);
  const pReconcileRaw = Number(source.pReconcileMs);
  const pPersistRaw = Number(source.pPersistMs);
  const pOpsRaw = Number(source.pOpsMs);
  const pFinalizeRaw = Number(source.pFinalizeMs);
  const flushLockWaitRaw = Number(source.flushLockWaitMs);
  const flushPendingReadRaw = Number(source.flushPendingReadMs);
  const flushSnapshotPrepareRaw = Number(source.flushSnapshotPrepareMs);
  const flushVisibleRunRaw = Number(source.flushVisibleRunMs);
  const flushRecoveryRunRaw = Number(source.flushRecoveryRunMs);
  const flushStateRefreshRaw = Number(source.flushStateRefreshMs);
  const flushApplySnapshotRaw = Number(source.flushApplySnapshotMs);
  const flushTerminalCleanupRaw = Number(source.flushTerminalCleanupMs);
  const flushOperationalPersistRaw = Number(source.flushOperationalPersistMs);
  const flushUiReleaseRaw = Number(source.flushUiReleaseMs);
  const flushPostReturnRaw = Number(source.flushPostReturnMs);
  const flushOtherRaw = Number(source.flushOtherMs);
  const confirmCommandInvokeRaw = Number(source.confirmCommandInvokeMs);
  const confirmDraftLockWaitRaw = Number(source.confirmDraftLockWaitMs);
  const confirmGlobalQueueWaitRaw = Number(source.confirmGlobalQueueWaitMs);
  const confirmGlobalQueueDepthAtEnqueueRaw = Number(source.confirmGlobalQueueDepthAtEnqueue);
  const confirmSchedulerWaitRaw = Number(source.confirmSchedulerWaitMs);
  const confirmPostCommandApplyRaw = Number(source.confirmPostCommandApplyMs);
  const confirmOpsRaw = Number(source.confirmOpsMs);
  const confirmFailureHandlingRaw = Number(source.confirmFailureHandlingMs);
  const confirmOtherRaw = Number(source.confirmOtherMs);
  const stateRefreshEmptyDraftCheckRaw = Number(source.stateRefreshEmptyDraftCheckMs);
  const stateRefreshAfterFlushRaw = Number(source.stateRefreshAfterFlushMs);
  const stateRefreshBeforeFinalizeRaw = Number(source.stateRefreshBeforeFinalizeMs);
  const stateRefreshOtherRaw = Number(source.stateRefreshOtherMs);
  const pOpsBackendSentRaw = Number(source.pOpsBackendSentMs);
  const pOpsBackendAckRaw = Number(source.pOpsBackendAckMs);
  const pOpsEventStateRaw = Number(source.pOpsEventStateMs);
  const pOpsEventPersistRaw = Number(source.pOpsEventPersistMs);
  const pOpsEventReportRaw = Number(source.pOpsEventReportMs);
  const pOpsOtherRaw = Number(source.pOpsOtherMs);
  const clickToBackendConfirmRaw = Number(source.clickToBackendConfirmMs);
  const retriesRaw = Number(source.retries);
  const timestamp =
    typeof source.timestamp === 'string' && !Number.isNaN(Date.parse(source.timestamp))
      ? source.timestamp
      : new Date().toISOString();

  return {
    draftId,
    jobId,
    clickToLocalPersistMs:
      Number.isFinite(clickToLocalPersistRaw) && clickToLocalPersistRaw >= 0
        ? Math.floor(clickToLocalPersistRaw)
        : null,
    waitInQueueMs:
      Number.isFinite(waitInQueueRaw) && waitInQueueRaw >= 0
        ? Math.floor(waitInQueueRaw)
        : null,
    processingMs:
      Number.isFinite(processingRaw) && processingRaw >= 0
        ? Math.floor(processingRaw)
        : null,
    totalConfMs:
      Number.isFinite(totalConfRaw) && totalConfRaw >= 0
        ? Math.floor(totalConfRaw)
        : Number.isFinite(clickToBackendConfirmRaw) && clickToBackendConfirmRaw >= 0
          ? Math.floor(clickToBackendConfirmRaw)
          : null,
    flushPendingDraftAddsMs:
      Number.isFinite(flushPendingDraftAddsRaw) && flushPendingDraftAddsRaw >= 0
        ? Math.floor(flushPendingDraftAddsRaw)
        : null,
    finalizeMs:
      Number.isFinite(finalizeRaw) && finalizeRaw >= 0 ? Math.floor(finalizeRaw) : null,
    confirmMs:
      Number.isFinite(confirmRaw) && confirmRaw >= 0 ? Math.floor(confirmRaw) : null,
    snapshotApplyMs:
      Number.isFinite(snapshotApplyRaw) && snapshotApplyRaw >= 0
        ? Math.floor(snapshotApplyRaw)
        : null,
    frontendReconcileMs:
      Number.isFinite(frontendReconcileRaw) && frontendReconcileRaw >= 0
        ? Math.floor(frontendReconcileRaw)
        : null,
    stateRefreshMs:
      Number.isFinite(stateRefreshRaw) && stateRefreshRaw >= 0
        ? Math.floor(stateRefreshRaw)
        : null,
    recoveryMs:
      Number.isFinite(recoveryRaw) && recoveryRaw >= 0 ? Math.floor(recoveryRaw) : null,
    retryBackoffMs:
      Number.isFinite(retryBackoffRaw) && retryBackoffRaw >= 0
        ? Math.floor(retryBackoffRaw)
        : null,
    pFlushMs:
      Number.isFinite(pFlushRaw) && pFlushRaw >= 0 ? Math.floor(pFlushRaw) : null,
    pPrepareMs:
      Number.isFinite(pPrepareRaw) && pPrepareRaw >= 0 ? Math.floor(pPrepareRaw) : null,
    pRequestMs:
      Number.isFinite(pRequestRaw) && pRequestRaw >= 0 ? Math.floor(pRequestRaw) : null,
    pBackendMs:
      Number.isFinite(pBackendRaw) && pBackendRaw >= 0 ? Math.floor(pBackendRaw) : null,
    pApplySnapshotMs:
      Number.isFinite(pApplySnapshotRaw) && pApplySnapshotRaw >= 0
        ? Math.floor(pApplySnapshotRaw)
        : null,
    pReconcileMs:
      Number.isFinite(pReconcileRaw) && pReconcileRaw >= 0 ? Math.floor(pReconcileRaw) : null,
    pPersistMs:
      Number.isFinite(pPersistRaw) && pPersistRaw >= 0 ? Math.floor(pPersistRaw) : null,
    pOpsMs:
      Number.isFinite(pOpsRaw) && pOpsRaw >= 0 ? Math.floor(pOpsRaw) : null,
    pFinalizeMs:
      Number.isFinite(pFinalizeRaw) && pFinalizeRaw >= 0 ? Math.floor(pFinalizeRaw) : null,
    flushLockWaitMs:
      Number.isFinite(flushLockWaitRaw) && flushLockWaitRaw >= 0 ? Math.floor(flushLockWaitRaw) : null,
    flushPendingReadMs:
      Number.isFinite(flushPendingReadRaw) && flushPendingReadRaw >= 0
        ? Math.floor(flushPendingReadRaw)
        : null,
    flushSnapshotPrepareMs:
      Number.isFinite(flushSnapshotPrepareRaw) && flushSnapshotPrepareRaw >= 0
        ? Math.floor(flushSnapshotPrepareRaw)
        : null,
    flushVisibleRunMs:
      Number.isFinite(flushVisibleRunRaw) && flushVisibleRunRaw >= 0
        ? Math.floor(flushVisibleRunRaw)
        : null,
    flushRecoveryRunMs:
      Number.isFinite(flushRecoveryRunRaw) && flushRecoveryRunRaw >= 0
        ? Math.floor(flushRecoveryRunRaw)
        : null,
    flushStateRefreshMs:
      Number.isFinite(flushStateRefreshRaw) && flushStateRefreshRaw >= 0
        ? Math.floor(flushStateRefreshRaw)
        : null,
    flushApplySnapshotMs:
      Number.isFinite(flushApplySnapshotRaw) && flushApplySnapshotRaw >= 0
        ? Math.floor(flushApplySnapshotRaw)
        : null,
    flushTerminalCleanupMs:
      Number.isFinite(flushTerminalCleanupRaw) && flushTerminalCleanupRaw >= 0
        ? Math.floor(flushTerminalCleanupRaw)
        : null,
    flushOperationalPersistMs:
      Number.isFinite(flushOperationalPersistRaw) && flushOperationalPersistRaw >= 0
        ? Math.floor(flushOperationalPersistRaw)
        : null,
    flushUiReleaseMs:
      Number.isFinite(flushUiReleaseRaw) && flushUiReleaseRaw >= 0
        ? Math.floor(flushUiReleaseRaw)
        : null,
    flushPostReturnMs:
      Number.isFinite(flushPostReturnRaw) && flushPostReturnRaw >= 0
        ? Math.floor(flushPostReturnRaw)
        : null,
    flushOtherMs:
      Number.isFinite(flushOtherRaw) && flushOtherRaw >= 0 ? Math.floor(flushOtherRaw) : null,
    confirmCommandInvokeMs:
      Number.isFinite(confirmCommandInvokeRaw) && confirmCommandInvokeRaw >= 0
        ? Math.floor(confirmCommandInvokeRaw)
        : null,
    confirmDraftLockWaitMs:
      Number.isFinite(confirmDraftLockWaitRaw) && confirmDraftLockWaitRaw >= 0
        ? Math.floor(confirmDraftLockWaitRaw)
        : null,
    confirmGlobalQueueWaitMs:
      Number.isFinite(confirmGlobalQueueWaitRaw) && confirmGlobalQueueWaitRaw >= 0
        ? Math.floor(confirmGlobalQueueWaitRaw)
        : null,
    confirmGlobalQueueDepthAtEnqueue:
      Number.isFinite(confirmGlobalQueueDepthAtEnqueueRaw) &&
      confirmGlobalQueueDepthAtEnqueueRaw >= 0
        ? Math.floor(confirmGlobalQueueDepthAtEnqueueRaw)
        : null,
    confirmSchedulerWaitMs:
      Number.isFinite(confirmSchedulerWaitRaw) && confirmSchedulerWaitRaw >= 0
        ? Math.floor(confirmSchedulerWaitRaw)
        : null,
    confirmPostCommandApplyMs:
      Number.isFinite(confirmPostCommandApplyRaw) && confirmPostCommandApplyRaw >= 0
        ? Math.floor(confirmPostCommandApplyRaw)
        : null,
    confirmOpsMs:
      Number.isFinite(confirmOpsRaw) && confirmOpsRaw >= 0 ? Math.floor(confirmOpsRaw) : null,
    confirmFailureHandlingMs:
      Number.isFinite(confirmFailureHandlingRaw) && confirmFailureHandlingRaw >= 0
        ? Math.floor(confirmFailureHandlingRaw)
        : null,
    confirmOtherMs:
      Number.isFinite(confirmOtherRaw) && confirmOtherRaw >= 0 ? Math.floor(confirmOtherRaw) : null,
    stateRefreshEmptyDraftCheckMs:
      Number.isFinite(stateRefreshEmptyDraftCheckRaw) && stateRefreshEmptyDraftCheckRaw >= 0
        ? Math.floor(stateRefreshEmptyDraftCheckRaw)
        : null,
    stateRefreshAfterFlushMs:
      Number.isFinite(stateRefreshAfterFlushRaw) && stateRefreshAfterFlushRaw >= 0
        ? Math.floor(stateRefreshAfterFlushRaw)
        : null,
    stateRefreshBeforeFinalizeMs:
      Number.isFinite(stateRefreshBeforeFinalizeRaw) && stateRefreshBeforeFinalizeRaw >= 0
        ? Math.floor(stateRefreshBeforeFinalizeRaw)
        : null,
    stateRefreshOtherMs:
      Number.isFinite(stateRefreshOtherRaw) && stateRefreshOtherRaw >= 0
        ? Math.floor(stateRefreshOtherRaw)
        : null,
    pOpsBackendSentMs:
      Number.isFinite(pOpsBackendSentRaw) && pOpsBackendSentRaw >= 0
        ? Math.floor(pOpsBackendSentRaw)
        : null,
    pOpsBackendAckMs:
      Number.isFinite(pOpsBackendAckRaw) && pOpsBackendAckRaw >= 0
        ? Math.floor(pOpsBackendAckRaw)
        : null,
    pOpsEventStateMs:
      Number.isFinite(pOpsEventStateRaw) && pOpsEventStateRaw >= 0
        ? Math.floor(pOpsEventStateRaw)
        : null,
    pOpsEventPersistMs:
      Number.isFinite(pOpsEventPersistRaw) && pOpsEventPersistRaw >= 0
        ? Math.floor(pOpsEventPersistRaw)
        : null,
    pOpsEventReportMs:
      Number.isFinite(pOpsEventReportRaw) && pOpsEventReportRaw >= 0
        ? Math.floor(pOpsEventReportRaw)
        : null,
    pOpsOtherMs:
      Number.isFinite(pOpsOtherRaw) && pOpsOtherRaw >= 0 ? Math.floor(pOpsOtherRaw) : null,
    clickToBackendConfirmMs:
      Number.isFinite(clickToBackendConfirmRaw) && clickToBackendConfirmRaw >= 0
        ? Math.floor(clickToBackendConfirmRaw)
        : Number.isFinite(totalConfRaw) && totalConfRaw >= 0
          ? Math.floor(totalConfRaw)
          : null,
    retries: Number.isFinite(retriesRaw) && retriesRaw >= 0 ? Math.floor(retriesRaw) : 0,
    hadRecovery: source.hadRecovery === true,
    hadReconciliation: source.hadReconciliation === true,
    timestamp,
  };
};

const normalizePaymentFlowTelemetryHistory = (parsed: unknown): PaymentFlowTelemetryRecord[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => normalizePaymentFlowTelemetryRecord(entry))
    .filter((entry): entry is PaymentFlowTelemetryRecord => entry !== null)
    .slice(0, 50);
};

const getPaymentFlowProcessingBreakdown = (
  telemetry: PaymentFlowTelemetryRecord | null | undefined
): {
  flushPendingDraftAddsMs: number;
  finalizeMs: number;
  confirmMs: number;
  snapshotApplyMs: number;
  frontendReconcileMs: number;
  stateRefreshMs: number;
  recoveryMs: number;
  retryBackoffMs: number;
  measuredExclusiveMs: number;
  residualMs: number;
} | null => {
  if (!telemetry) return null;
  const processingMs =
    typeof telemetry.processingMs === 'number' && Number.isFinite(telemetry.processingMs)
      ? Math.max(0, telemetry.processingMs)
      : 0;
  const flushPendingDraftAddsMs =
    typeof telemetry.flushPendingDraftAddsMs === 'number' &&
    Number.isFinite(telemetry.flushPendingDraftAddsMs)
      ? Math.max(0, telemetry.flushPendingDraftAddsMs)
      : 0;
  const finalizeMs =
    typeof telemetry.finalizeMs === 'number' && Number.isFinite(telemetry.finalizeMs)
      ? Math.max(0, telemetry.finalizeMs)
      : 0;
  const confirmMs =
    typeof telemetry.confirmMs === 'number' && Number.isFinite(telemetry.confirmMs)
      ? Math.max(0, telemetry.confirmMs)
      : 0;
  const snapshotApplyMs =
    typeof telemetry.snapshotApplyMs === 'number' && Number.isFinite(telemetry.snapshotApplyMs)
      ? Math.max(0, telemetry.snapshotApplyMs)
      : 0;
  const frontendReconcileMs =
    typeof telemetry.frontendReconcileMs === 'number' &&
    Number.isFinite(telemetry.frontendReconcileMs)
      ? Math.max(0, telemetry.frontendReconcileMs)
      : 0;
  const stateRefreshMs =
    typeof telemetry.stateRefreshMs === 'number' && Number.isFinite(telemetry.stateRefreshMs)
      ? Math.max(0, telemetry.stateRefreshMs)
      : 0;
  const recoveryMs =
    typeof telemetry.recoveryMs === 'number' && Number.isFinite(telemetry.recoveryMs)
      ? Math.max(0, telemetry.recoveryMs)
      : 0;
  const retryBackoffMs =
    typeof telemetry.retryBackoffMs === 'number' && Number.isFinite(telemetry.retryBackoffMs)
      ? Math.max(0, telemetry.retryBackoffMs)
      : 0;

  // snapshotApplyMs is cross-cutting and already included inside finalize/confirm timings.
  // Keep the residual based on exclusive sequential stages only.
  const measuredExclusiveMs =
    flushPendingDraftAddsMs +
    finalizeMs +
    confirmMs +
    frontendReconcileMs +
    stateRefreshMs +
    recoveryMs +
    retryBackoffMs;
  const residualMs = Math.max(0, processingMs - measuredExclusiveMs);

  return {
    flushPendingDraftAddsMs: Math.round(flushPendingDraftAddsMs),
    finalizeMs: Math.round(finalizeMs),
    confirmMs: Math.round(confirmMs),
    snapshotApplyMs: Math.round(snapshotApplyMs),
    frontendReconcileMs: Math.round(frontendReconcileMs),
    stateRefreshMs: Math.round(stateRefreshMs),
    recoveryMs: Math.round(recoveryMs),
    retryBackoffMs: Math.round(retryBackoffMs),
    measuredExclusiveMs: Math.round(measuredExclusiveMs),
    residualMs: Math.round(residualMs),
  };
};

const loadPaymentFlowTelemetryHistoryLocalFallback = (): PaymentFlowTelemetryRecord[] =>
  normalizePaymentFlowTelemetryHistory(
    operationalStorage.getLocalFallback<unknown>(PAYMENT_FLOW_TELEMETRY_HISTORY_KEY)
  );

const loadPaymentFlowTelemetryHistoryResolved = async (): Promise<
  OperationalStorageResolvedResult<PaymentFlowTelemetryRecord[]>
> => {
  const resolved = await operationalStorage.getResolved<unknown>(
    PAYMENT_FLOW_TELEMETRY_HISTORY_KEY
  );
  return {
    ...resolved,
    value: normalizePaymentFlowTelemetryHistory(resolved.value),
  };
};

const savePaymentFlowTelemetryHistory = (history: PaymentFlowTelemetryRecord[]): void => {
  void operationalStorage.set(PAYMENT_FLOW_TELEMETRY_HISTORY_KEY, history);
};

const normalizeOperationalEventLogEntry = (value: unknown): OperationalEventLogEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : createClientId('ops');
  const typeCandidate = typeof source.type === 'string' ? source.type : '';
  const isSupportedType =
    typeCandidate === 'OPS_HEALTH' ||
    typeCandidate === 'HEALTH_SNAPSHOT' ||
    typeCandidate === 'QUEUE_HEALTH' ||
    typeCandidate === 'FAILSAFE_ACTIVATED' ||
    typeCandidate === 'FAILSAFE_CLEARED' ||
    typeCandidate === 'BACKPRESSURE' ||
    typeCandidate === 'PAYMENT_FLOW' ||
    typeCandidate === 'COMMAND_SKIPPED_OBSOLETE' ||
    typeCandidate === 'CART_REMOVE_LOCAL_PENDING' ||
    typeCandidate === 'CART_REMOVE_REMOTE' ||
    typeCandidate === 'PENDING_ADD_CANCELLED';
  if (!isSupportedType) return null;
  const message = typeof source.message === 'string' ? source.message.trim() : '';
  if (!message) return null;
  const timestamp =
    typeof source.timestamp === 'string' && !Number.isNaN(Date.parse(source.timestamp))
      ? source.timestamp
      : new Date().toISOString();
  const context =
    source.context && typeof source.context === 'object' && !Array.isArray(source.context)
      ? (source.context as Record<string, unknown>)
      : undefined;

  return {
    id,
    type: typeCandidate as OperationalEventLogEntry['type'],
    message,
    timestamp,
    context,
  };
};

const normalizeOperationalEventLog = (parsed: unknown): OperationalEventLogEntry[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => normalizeOperationalEventLogEntry(entry))
    .filter((entry): entry is OperationalEventLogEntry => entry !== null)
    .slice(0, 20);
};

const mergeOperationalEventLogs = (
  localEvents: OperationalEventLogEntry[],
  remoteEvents: OperationalEventLogEntry[]
): OperationalEventLogEntry[] => {
  const byId = new Map<string, OperationalEventLogEntry>();

  [...localEvents, ...remoteEvents].forEach((entry) => {
    const current = byId.get(entry.id);
    if (!current) {
      byId.set(entry.id, entry);
      return;
    }
    const currentTs = Date.parse(current.timestamp);
    const nextTs = Date.parse(entry.timestamp);
    const currentMs = Number.isFinite(currentTs) ? currentTs : 0;
    const nextMs = Number.isFinite(nextTs) ? nextTs : 0;
    if (nextMs >= currentMs) {
      byId.set(entry.id, entry);
    }
  });

  return Array.from(byId.values())
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 20);
};

const loadOperationalEventLogLocalFallback = (): OperationalEventLogEntry[] =>
  normalizeOperationalEventLog(
    operationalStorage.getLocalFallback<unknown>(OPERATIONS_EVENT_LOG_KEY)
  );

const loadOperationalEventLogResolved = async (): Promise<
  OperationalStorageResolvedResult<OperationalEventLogEntry[]>
> => {
  const resolved = await operationalStorage.getResolved<unknown>(OPERATIONS_EVENT_LOG_KEY);
  return {
    ...resolved,
    value: normalizeOperationalEventLog(resolved.value),
  };
};

const saveOperationalEventLog = (events: OperationalEventLogEntry[]): void => {
  void operationalStorage.set(OPERATIONS_EVENT_LOG_KEY, events);
};

const countPendingDraftAdds = (value: PendingDraftAddsByDraftId): number =>
  Object.values(value).reduce((total, entries) => total + countVisiblePendingDraftAdds(entries), 0);

const mergePendingDraftAdds = (
  current: PendingDraftAddsByDraftId,
  recovered: PendingDraftAddsByDraftId
): PendingDraftAddsByDraftId => {
  const merged: PendingDraftAddsByDraftId = {};
  const draftIds = new Set<string>([
    ...Object.keys(current),
    ...Object.keys(recovered),
  ]);

  draftIds.forEach((draftId) => {
    const currentEntries = current[draftId] || [];
    const recoveredEntries = recovered[draftId] || [];
    const mergedByKey = new Map<string, PendingDraftAdd>();

    [...currentEntries, ...recoveredEntries].forEach((entry) => {
      const normalized = normalizePendingDraftAdd({ ...entry, draftId });
      if (!normalized) return;
      const dedupeKey = `${normalized.commandId}::${normalized.localItemId}`;
      const previous = mergedByKey.get(dedupeKey);
      if (!previous) {
        mergedByKey.set(dedupeKey, normalized);
        return;
      }

      const previousPriority = PENDING_DRAFT_ADD_STATUS_PRIORITY[previous.status];
      const currentPriority = PENDING_DRAFT_ADD_STATUS_PRIORITY[normalized.status];
      if (currentPriority > previousPriority) {
        mergedByKey.set(dedupeKey, normalized);
        return;
      }
      if (currentPriority < previousPriority) {
        return;
      }

      const previousUpdatedAt = Date.parse(previous.updatedAt);
      const currentUpdatedAt = Date.parse(normalized.updatedAt);
      const previousUpdatedAtMs = Number.isFinite(previousUpdatedAt) ? previousUpdatedAt : 0;
      const currentUpdatedAtMs = Number.isFinite(currentUpdatedAt) ? currentUpdatedAt : 0;
      if (currentUpdatedAtMs >= previousUpdatedAtMs) {
        mergedByKey.set(dedupeKey, normalized);
      }
    });

    const nextEntries = Array.from(mergedByKey.values()).sort((left, right) =>
      left.queuedAt.localeCompare(right.queuedAt)
    );
    if (nextEntries.length > 0) {
      merged[draftId] = nextEntries;
    }
  });

  return merged;
};

const mergePendingPaidSyncQueue = (
  current: PendingPaidSyncJob[],
  recovered: PendingPaidSyncJob[]
): PendingPaidSyncJob[] => {
  const mergedByDraftId = new Map<string, PendingPaidSyncJob>();
  [...current, ...recovered].forEach((job) => {
    const normalized = normalizePendingPaidSyncJob(job);
    if (!normalized) return;
    if (!mergedByDraftId.has(normalized.draftId)) {
      mergedByDraftId.set(normalized.draftId, normalized);
    }
  });
  return Array.from(mergedByDraftId.values());
};

const mergeFailedPaidSyncQueue = (
  current: PendingPaidSyncJob[],
  recovered: PendingPaidSyncJob[]
): PendingPaidSyncJob[] => {
  const mergedByIdentity = new Map<string, PendingPaidSyncJob>();
  [...current, ...recovered].forEach((job) => {
    const normalized = normalizePendingPaidSyncJob(job);
    if (!normalized) return;
    const identity = `${normalized.id}::${normalized.draftId}`;
    if (!mergedByIdentity.has(identity)) {
      mergedByIdentity.set(identity, normalized);
    }
  });
  return Array.from(mergedByIdentity.values());
};

const PENDING_PAID_SYNC_RETRY_STEPS_MS = [
  5_000,
  10_000,
  20_000,
  40_000,
  60_000,
  120_000,
  300_000,
] as const;
const PENDING_PAID_SYNC_ORDER_SETTLE_RETRY_STEPS_MS = [1_200, 1_800, 2_600, 3_800, 5_500, 8_000] as const;
const PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_DELAY_MS = 1800;
const PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_MAX_ATTEMPTS = 5;
const PENDING_PAID_SYNC_QUEUE_EMPTY_DRAFT_MAX_RECOVERY_ATTEMPTS = 2;
const PAID_SYNC_UI_LOCK_MAX_MS = 15_000;
const PAID_SYNC_ASSISTANT_STATUS_TTL_MS = 2800;
const DRAFT_PAYMENT_TRANSITION_GRACE_MS = 12_000;
const DRAFT_REOPEN_CONFIRMATION_MS = 2_500;
const DRAFT_TERMINAL_VISUAL_LOCK_MS = 45_000;
const PAID_SYNC_QUEUE_PREVIEW_LIMIT = 6;
const PENDING_DRAFT_BACKGROUND_SYNC_DEBOUNCE_MS = 650;
const PENDING_DRAFT_BACKGROUND_SYNC_SWEEP_MS = 10000;
const PENDING_DRAFT_BACKGROUND_SYNC_RETRY_BASE_MS = 1800;
const PENDING_DRAFT_BACKGROUND_SYNC_RETRY_MAX_MS = 45000;
const PENDING_DRAFT_BACKGROUND_SYNC_RETRY_JITTER = 0.2;
const MAX_CONCURRENT_COMMANDS = 2;
const PENDING_PAID_SYNC_MAX_WORKERS = 2;
const BACKEND_OPERATION_TIMEOUT_MS = 25_000;
const PENDING_PAID_SYNC_QUEUE_MAX_SIZE = 50;
const PENDING_DRAFT_ADDS_MAX_SIZE = 100;
const BACKEND_FAILSAFE_MIN_PAUSE_MS = 10_000;
const BACKEND_FAILSAFE_MAX_PAUSE_MS = 30_000;
const QUEUE_BACKPRESSURE_PAUSE_MS = 15_000;
const BACKEND_COMMAND_SCHEDULER_MAX_QUEUE_SIZE = 220;
const rawCommandSchedulerFlag = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_ENABLE_COMMAND_SCHEDULER;
const ENABLE_COMMAND_SCHEDULER =
  rawCommandSchedulerFlag === undefined
    ? true
    : !['0', 'false', 'off', 'no'].includes(rawCommandSchedulerFlag.trim().toLowerCase());
const rawAutoReenqueuePendingPaymentFlag = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_ENABLE_AUTO_REENQUEUE_PENDING_PAYMENT;
const ENABLE_AUTO_REENQUEUE_PENDING_PAYMENT =
  rawAutoReenqueuePendingPaymentFlag === undefined
    ? true
    : !['0', 'false', 'off', 'no'].includes(
        rawAutoReenqueuePendingPaymentFlag.trim().toLowerCase()
      );
const rawPendingPaidSyncIntervalWakeupFlag = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_ENABLE_PENDING_PAID_SYNC_INTERVAL_WAKEUP;
const ENABLE_PENDING_PAID_SYNC_INTERVAL_WAKEUP =
  rawPendingPaidSyncIntervalWakeupFlag === undefined
    ? false
    : !['0', 'false', 'off', 'no'].includes(
        rawPendingPaidSyncIntervalWakeupFlag.trim().toLowerCase()
      );
const rawAsyncConfirmPaidFlag = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_ENABLE_ASYNC_CONFIRM_PAID;
const ENABLE_ASYNC_CONFIRM_PAID = false;
const ASYNC_CONFIRM_PAID_FLAG_WAS_ENABLED =
  rawAsyncConfirmPaidFlag !== undefined &&
  !['0', 'false', 'off', 'no'].includes(rawAsyncConfirmPaidFlag.trim().toLowerCase());

const getLowerPriority = (priority: CommandPriority): CommandPriority => {
  if (priority === 'CRITICAL') return 'CRITICAL';
  if (priority === 'HIGH') return 'NORMAL';
  if (priority === 'NORMAL') return 'LOW';
  return 'LOW';
};

const getCommandExecutionPriority = (command: StateCommand): CommandPriority => {
  if (
    command.type === 'SALE_DRAFT_CONFIRM_PAID' ||
    command.type === 'SALE_DRAFT_FINALIZE' ||
    command.type === 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID'
  ) {
    return 'CRITICAL';
  }
  if (
    command.type === 'SALE_DRAFT_ADD_ITEM' ||
    command.type === 'SALE_DRAFT_UPDATE_ITEM' ||
    command.type === 'SALE_DRAFT_REMOVE_ITEM'
  ) {
    return 'HIGH';
  }
  if (
    command.type === 'SALE_DRAFT_CREATE' ||
    command.type === 'SALE_DRAFT_SET_CUSTOMER_TYPE' ||
    command.type === 'SALE_DRAFT_CANCEL'
  ) {
    return 'HIGH';
  }
  if (command.type === 'SALE_REGISTER') {
    return 'NORMAL';
  }
  return 'NORMAL';
};

const isTerminalPaidSyncCommand = (command: Pick<StateCommand, 'type'>): boolean =>
  command.type === 'SALE_DRAFT_FINALIZE' ||
  command.type === 'SALE_DRAFT_CONFIRM_PAID' ||
  command.type === 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID';

const isSafeCommandTypeForFallbackDedupe = (commandType: StateCommand['type']): boolean =>
  commandType === 'SALE_DRAFT_FINALIZE' ||
  commandType === 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID' ||
  commandType === 'SALE_DRAFT_CONFIRM_PAID' ||
  commandType === 'SALE_DRAFT_REMOVE_ITEM' ||
  commandType === 'SALE_DRAFT_CANCEL';

const resolveBackendExecutionPriority = (options: BackendExecutionOptions): CommandPriority => {
  let priority: CommandPriority = 'NORMAL';
  if (options.command) {
    priority = getCommandExecutionPriority(options.command);
  } else if (options.operationType === 'ENQUEUE_STATE_COMMAND_ASYNC') {
    priority = 'HIGH';
  } else if (options.operationType === 'GET_STATE_COMMAND_ASYNC_JOB') {
    priority = 'LOW';
  } else if (options.operationType === 'FETCH_STATE_SNAPSHOT') {
    priority = 'NORMAL';
  }

  const retryCount = Math.max(0, Math.floor(options.retryCount ?? 0));
  if (retryCount > 0) {
    priority = getLowerPriority(priority);
    if (retryCount >= 3) {
      priority = getLowerPriority(priority);
    }
  }
  return priority;
};

const resolveBackendExecutionDedupeKey = (
  options: BackendExecutionOptions
): string | undefined => {
  const normalizedDraftId =
    typeof options.draftId === 'string' && options.draftId.trim() ? options.draftId.trim() : null;

  if (options.operationType === 'FETCH_STATE_SNAPSHOT') {
    return normalizedDraftId
      ? `FETCH_STATE_SNAPSHOT::${normalizedDraftId}`
      : 'FETCH_STATE_SNAPSHOT::global';
  }

  if (options.operationType === 'GET_STATE_COMMAND_ASYNC_JOB' && options.commandId) {
    return `GET_STATE_COMMAND_ASYNC_JOB::${options.commandId}`;
  }

  if (options.command) {
    const commandId = options.command.commandId?.trim();
    if (commandId) {
      return `RUN_STATE_COMMAND::${normalizedDraftId || 'global'}::${options.command.type}::${commandId}`;
    }
    if (normalizedDraftId && isSafeCommandTypeForFallbackDedupe(options.command.type)) {
      return `RUN_STATE_COMMAND::${normalizedDraftId}::${options.command.type}`;
    }
  }

  return undefined;
};

const resolveBackendExecutionGroupKey = (
  options: BackendExecutionOptions
): string | undefined => {
  const fromOptions = options.draftId?.trim();
  if (fromOptions) return fromOptions;
  const fromCommand = options.command ? getCommandDraftId(options.command) : null;
  return fromCommand || undefined;
};

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
  const index = Math.min(
    PENDING_PAID_SYNC_RETRY_STEPS_MS.length - 1,
    Math.max(0, safeAttempts - 1)
  );
  return PENDING_PAID_SYNC_RETRY_STEPS_MS[index];
};

const isPendingPaidSyncOrderSettleRetryMessage = (message: string): boolean => {
  if (isConfirmBeforeFinalizeErrorMessage(message)) return true;
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return (
    normalized.includes('draft ainda nao visivel no estado mais recente antes de confirmar pagamento') ||
    normalized.includes('draft nao encontrado no snapshot mais recente antes de confirmar pagamento')
  );
};

const getPendingPaidSyncRetryDelayForMessage = (attempts: number, message: string): number => {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  if (!isPendingPaidSyncOrderSettleRetryMessage(message)) {
    return getPendingPaidSyncRetryDelayMs(safeAttempts);
  }
  const index = Math.min(
    PENDING_PAID_SYNC_ORDER_SETTLE_RETRY_STEPS_MS.length - 1,
    Math.max(0, safeAttempts - 1)
  );
  return PENDING_PAID_SYNC_ORDER_SETTLE_RETRY_STEPS_MS[index];
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
  const [pendingPaidSyncJobs, setPendingPaidSyncJobs] = useState(
    () => loadPendingPaidSyncQueueLocalFallback().length
  );
  const [hasPendingVersionUpdate, setHasPendingVersionUpdate] = useState(false);
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const globalCommandQueueDepthRef = useRef(0);
  const globalCommandQueueActiveRef = useRef<{
    token: string;
    commandType: StateCommand['type'];
    draftId: string | null;
    startedAtMs: number;
  } | null>(null);
  const globalCommandQueueLastCompletedRef = useRef<{
    commandType: StateCommand['type'];
    draftId: string | null;
    durationMs: number;
  } | null>(null);
  const offlineSalesQueueRef = useRef<OfflineQueuedSale[]>([]);
  const pendingPaidSyncQueueRef = useRef<PendingPaidSyncJob[]>(
    loadPendingPaidSyncQueueLocalFallback()
  );
  const failedPaidSyncQueueRef = useRef<PendingPaidSyncJob[]>(
    loadFailedPaidSyncQueueLocalFallback()
  );
  const pendingDraftAddsRef = useRef<PendingDraftAddsByDraftId>({});
  const pendingDraftAddCancellationIntentsRef = useRef<
    Map<string, PendingDraftAddCancellationIntent>
  >(new Map());
  const pendingDraftAddsInFlightRef = useRef<Map<string, PendingDraftAdd>>(new Map());
  const recoveryPendingDraftAddsRef = useRef<PendingDraftAddsByDraftId>({});
  const syncingPaidDraftIdsRef = useRef<Set<string>>(new Set());
  const isPendingDraftAddsHydratedRef = useRef(false);
  const isPendingPaidSyncQueueHydratedRef = useRef(false);
  const isFailedPaidSyncQueueHydratedRef = useRef(false);
  const pendingDraftAddsRecoveryLoadRef = useRef<Promise<void> | null>(null);
  const pendingPaidSyncQueueRecoveryLoadRef = useRef<Promise<void> | null>(null);
  const failedPaidSyncQueueRecoveryLoadRef = useRef<Promise<void> | null>(null);
  const pendingDraftAddsRevisionRef = useRef(0);
  const pendingPaidSyncQueueRevisionRef = useRef(0);
  const failedPaidSyncQueueRevisionRef = useRef(0);
  const backendCommandSchedulerRef = useRef<CommandScheduler | null>(null);
  const backendFailsafeBlockedUntilRef = useRef(0);
  const backendFailsafeStreakRef = useRef(0);
  const backendFailsafeActivationCountRef = useRef(0);
  const backendFailsafeDeferredCommandsRef = useRef(0);
  const backendFailsafeAccumulatedPauseMsRef = useRef(0);
  const backendFailsafeLastStartedAtRef = useRef<number | null>(null);
  const retryDispatchQueueRef = useRef<Array<{ key: string; run: () => Promise<void> }>>([]);
  const retryDispatchQueuedKeysRef = useRef<Set<string>>(new Set());
  const retryDispatchRunningRef = useRef(false);
  const retryDispatchTimersRef = useRef<Map<string, number>>(new Map());
  const commandDraftLocksRef = useRef<Map<string, Promise<void>>>(new Map());
  const pendingPaidSyncIngressBlockedUntilRef = useRef(0);
  const pendingDraftAddsIngressBlockedUntilRef = useRef(0);
  const pendingPaidSyncActiveWorkersRef = useRef(0);
  const pendingPaidSyncRunningDraftIdsRef = useRef<Set<string>>(new Set());
  const paidSyncUiLockStartedAtRef = useRef<number | null>(null);
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
  const paymentFlowTelemetryByDraftRef = useRef<Map<string, PaymentFlowTelemetryEntry>>(new Map());
  const paymentFlowTelemetryRecentRef = useRef<PaymentFlowTelemetryRecord[]>([]);
  const operationalEventLogRef = useRef<OperationalEventLogEntry[]>([]);
  const operationalEventUiFlushTimerRef = useRef<number | null>(null);
  const isTechnicalPanelOpenRef = useRef(false);
  const operationalRemoteEventLogRef = useRef<OperationalEventLogEntry[]>([]);
  const opsClientInstanceIdRef = useRef<string>(readOrCreateOpsClientInstanceId());
  const optimisticRemovedDraftItemsRef = useRef<Map<string, Set<string>>>(new Map());
  const draftItemRemoteMutationRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  const draftLifecycleStageRef = useRef<Map<string, DraftLifecycleStage>>(new Map());
  const draftOperationEpochRef = useRef<Map<string, number>>(new Map());
  const draftPaymentTransitionGraceUntilRef = useRef<Map<string, number>>(new Map());
  const draftTerminalVisualLockUntilRef = useRef<Map<string, number>>(new Map());
  const retiredEditableDraftIdsRef = useRef<Set<string>>(new Set());
  const draftReopenObservedAtRef = useRef<Map<string, number>>(new Map());
  const isDraftLifecycleHydratedRef = useRef(false);
  const lastOperationalHealthReportAtRef = useRef(0);

  if (!backendCommandSchedulerRef.current) {
    backendCommandSchedulerRef.current = createCommandScheduler({
      maxConcurrent: MAX_CONCURRENT_COMMANDS,
      maxQueueSize: BACKEND_COMMAND_SCHEDULER_MAX_QUEUE_SIZE,
      onBackpressure: (payload) => {
        const currentSnapshot = backendCommandSchedulerRef.current?.getSnapshot();
        const backpressureHits = currentSnapshot?.backpressureHits ?? 0;
        reportErrorMonitorEvent({
          source: 'sistema:command-scheduler:backpressure',
          level: 'warn',
          message: 'Scheduler global de comandos atingiu o limite de fila.',
          context: {
            ...payload,
            backpressureHits,
          },
        });
      },
    });
  }
  
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
  const [pendingPaidSyncQueueSnapshot, setPendingPaidSyncQueueSnapshot] = useState<
    PendingPaidSyncJob[]
  >(() => loadPendingPaidSyncQueueLocalFallback());
  const [failedPaidSyncQueue, setFailedPaidSyncQueue] = useState<PendingPaidSyncJob[]>(
    () => loadFailedPaidSyncQueueLocalFallback()
  );
  const [failedPaidSyncAutoRetryRevision, setFailedPaidSyncAutoRetryRevision] = useState(0);
  const [paidSyncAssistantState, setPaidSyncAssistantState] = useState<PaidSyncAssistantState>({
    mode: 'idle',
    message: '',
    active: false,
    draftId: null,
    jobId: null,
    updatedAt: Date.now(),
  });
  const [operationalHealthSnapshot, setOperationalHealthSnapshot] =
    useState<OperationalHealthSnapshot>({
      timestamp: new Date().toISOString(),
      schedulerActive: 0,
      schedulerQueued: 0,
      schedulerCriticalQueued: 0,
      schedulerHighQueued: 0,
      schedulerNormalQueued: 0,
      schedulerLowQueued: 0,
      schedulerBackpressureHits: 0,
      schedulerDedupeHits: 0,
      pendingDraftAdds: 0,
      pendingPaidQueue: 0,
      failedQueue: 0,
      failsafeActivations: 0,
      failsafeDeferredCommands: 0,
      failsafeCurrentPauseMs: 0,
      failsafeAccumulatedPausedMs: 0,
    });
  const [paymentFlowTelemetryHistory, setPaymentFlowTelemetryHistory] =
    useState<PaymentFlowTelemetryRecord[]>([]);
  const [operationalEventLog, setOperationalEventLog] = useState<OperationalEventLogEntry[]>([]);
  const [optimisticRemovedDraftItemsRevision, setOptimisticRemovedDraftItemsRevision] = useState(0);
  const [draftLifecycleRevision, setDraftLifecycleRevision] = useState(0);
  const [isTechnicalPanelOpen, setIsTechnicalPanelOpen] = useState(false);

  useEffect(() => {
    isTechnicalPanelOpenRef.current = isTechnicalPanelOpen;
  }, [isTechnicalPanelOpen]);
  
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
  const printReturnFocusGuardUntilRef = useRef(0);
  const armPrintReturnFocusGuard = useCallback((guardMs = PRINT_RETURN_FOCUS_GUARD_MS): void => {
    const normalizedGuardMs = Math.max(250, Math.round(guardMs));
    printReturnFocusGuardUntilRef.current = Date.now() + normalizedGuardMs;
  }, []);
  const isPrintReturnFocusGuardActive = useCallback(
    (): boolean => Date.now() < printReturnFocusGuardUntilRef.current,
    []
  );
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

  const diagnoseLegacyPendingAdds = useCallback((): LegacyPendingAddsDiagnosisReport => {
    const productById = new Map<string, Product>(
      products.map((product): [string, Product] => [product.id, product])
    );
    const byStatus: Record<PendingDraftAddStatus, number> = {
      ACTIVE: 0,
      IN_FLIGHT: 0,
      CANCELLED: 0,
      APPLIED: 0,
      RECONCILED: 0,
      FAILED_TERMINAL: 0,
    };
    const bySource: Record<PendingDraftAddsSource, number> = {
      visible: 0,
      recovery: 0,
    };
    const legacyEntries: LegacyPendingAddDiagnosticEntry[] = [];
    let scannedEntries = 0;

    const scanRecord = (
      source: PendingDraftAddsSource,
      record: PendingDraftAddsByDraftId
    ): void => {
      Object.entries(record).forEach(([draftId, entries]) => {
        entries.forEach((entry) => {
          scannedEntries += 1;
          bySource[source] += 1;
          byStatus[entry.status] += 1;

          const normalizedOverride = normalizeRecipeOverride(entry.recipeOverride);
          if (normalizedOverride && normalizedOverride.length > 0) {
            return;
          }

          const sourceProduct = productById.get(entry.productId);
          legacyEntries.push({
            source,
            draftId,
            localItemId: entry.localItemId,
            commandId: entry.commandId,
            productId: entry.productId,
            productName: sourceProduct?.name || entry.productId,
            quantity: Math.max(1, Math.round(Number(entry.quantity) || 1)),
            status: entry.status,
            queuedAt: entry.queuedAt,
            updatedAt: entry.updatedAt,
            recipeOverrideLength: 0,
            fallbackProductRecipeLength: sourceProduct?.recipe?.length || 0,
          });
        });
      });
    };

    scanRecord('visible', pendingDraftAddsRef.current);
    scanRecord('recovery', recoveryPendingDraftAddsRef.current);

    const report: LegacyPendingAddsDiagnosisReport = {
      generatedAt: new Date().toISOString(),
      totals: {
        scannedEntries,
        legacyWithoutRecipeOverride: legacyEntries.length,
        bySource,
        byStatus,
      },
      legacyEntries,
    };

    return report;
  }, [products]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const target = window as Window & Record<string, unknown>;
    const runDiagnosis = () => {
      const report = diagnoseLegacyPendingAdds();
      console.groupCollapsed(
        `[diagnostic] legacy pending adds sem recipeOverride: ${report.totals.legacyWithoutRecipeOverride}`
      );
      console.log(report);
      if (report.legacyEntries.length > 0) {
        console.table(report.legacyEntries);
      }
      console.groupEnd();
      return report;
    };

    target[LEGACY_PENDING_ADDS_DIAGNOSE_WINDOW_KEY] = runDiagnosis;

    return () => {
      if (target[LEGACY_PENDING_ADDS_DIAGNOSE_WINDOW_KEY] === runDiagnosis) {
        delete target[LEGACY_PENDING_ADDS_DIAGNOSE_WINDOW_KEY];
      }
    };
  }, [diagnoseLegacyPendingAdds]);

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
      if (isPrintReturnFocusGuardActive()) return;
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
  }, [isAccessVerified, isAdminAuthenticated, isPrintReturnFocusGuardActive]);

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

  const applyOperationalEventLogState = useCallback((localEvents: OperationalEventLogEntry[]): void => {
    const merged = mergeOperationalEventLogs(localEvents, operationalRemoteEventLogRef.current);
    setOperationalEventLog(merged);
  }, []);

  const scheduleOperationalEventLogUiFlush = useCallback(
    (delayMs = OPS_EVENT_LOG_UI_FLUSH_DEBOUNCE_MS): void => {
      if (operationalEventUiFlushTimerRef.current !== null) return;
      operationalEventUiFlushTimerRef.current = window.setTimeout(() => {
        operationalEventUiFlushTimerRef.current = null;
        applyOperationalEventLogState(operationalEventLogRef.current);
      }, Math.max(0, delayMs));
    },
    [applyOperationalEventLogState]
  );

  const pushOperationalEvent = useCallback(
    (
      type: OperationalEventLogEntry['type'],
      message: string,
      context?: Record<string, unknown>
    ): OperationalEventTiming => {
      const startedAt = performance.now();
      const next: OperationalEventLogEntry = {
        id: createClientId('ops'),
        type,
        message,
        timestamp: new Date().toISOString(),
        context,
      };
      const nextList = [next, ...operationalEventLogRef.current].slice(0, 20);
      operationalEventLogRef.current = nextList;
      const applyStateStartedAt = performance.now();
      if (isTechnicalPanelOpenRef.current) {
        applyOperationalEventLogState(nextList);
      } else {
        scheduleOperationalEventLogUiFlush();
      }
      const applyStateMs = performance.now() - applyStateStartedAt;
      const persistStartedAt = performance.now();
      saveOperationalEventLog(nextList);
      const persistDispatchMs = performance.now() - persistStartedAt;
      const reportStartedAt = performance.now();
      reportOperationalPanelEvent({
        clientId: opsClientInstanceIdRef.current,
        event: next,
      });
      const reportDispatchMs = performance.now() - reportStartedAt;
      return {
        applyStateMs,
        persistDispatchMs,
        reportDispatchMs,
        totalMs: performance.now() - startedAt,
      };
    },
    [applyOperationalEventLogState, scheduleOperationalEventLogUiFlush]
  );

  useEffect(() => {
    if (!ASYNC_CONFIRM_PAID_FLAG_WAS_ENABLED) return;
    pushOperationalEvent(
      'OPS_HEALTH',
      'Flag VITE_ENABLE_ASYNC_CONFIRM_PAID detectada e ignorada: CONFIRM_PAID forçado em modo síncrono.',
      {
        forcedSyncConfirmPaid: true,
      }
    );
  }, [pushOperationalEvent]);

  const persistDraftLifecycleState = useCallback((): void => {
    const next: DraftLifecycleStateByDraftId = {};
    draftLifecycleStageRef.current.forEach((stage, draftId) => {
      if (stage === 'OPEN') return;
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return;
      next[normalizedDraftId] = {
        stage,
        epoch: draftOperationEpochRef.current.get(normalizedDraftId) || 0,
        updatedAt: new Date().toISOString(),
      };
    });
    saveDraftLifecycleState(next);
  }, []);

  const hydrateDraftLifecycleState = useCallback((): void => {
    if (isDraftLifecycleHydratedRef.current) return;
    const loaded = loadDraftLifecycleStateLocalFallback();
    const nextStages = new Map<string, DraftLifecycleStage>();
    const nextEpochs = new Map<string, number>();
    Object.entries(loaded).forEach(([draftId, value]) => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return;
      const stage = normalizeDraftLifecycleStage(value.stage);
      const epochRaw = Number(value.epoch);
      const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
      if (stage !== 'OPEN') {
        nextStages.set(normalizedDraftId, stage);
      }
      nextEpochs.set(normalizedDraftId, epoch);
    });
    draftLifecycleStageRef.current = nextStages;
    draftOperationEpochRef.current = nextEpochs;
    isDraftLifecycleHydratedRef.current = true;
    if (nextStages.size > 0 || nextEpochs.size > 0) {
      setDraftLifecycleRevision((current) => current + 1);
    }
  }, []);

  const getDraftOperationEpoch = useCallback((draftId: string): number => {
    hydrateDraftLifecycleState();
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) return 0;
    return draftOperationEpochRef.current.get(normalizedDraftId) || 0;
  }, [hydrateDraftLifecycleState]);

  const isDraftTerminalVisualLocked = useCallback(
    (draftId: string, nowMs = Date.now()): boolean => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return false;
      const lockedUntilMs = draftTerminalVisualLockUntilRef.current.get(normalizedDraftId) || 0;
      if (lockedUntilMs > nowMs) return true;
      if (lockedUntilMs > 0) {
        draftTerminalVisualLockUntilRef.current.delete(normalizedDraftId);
      }
      return false;
    },
    []
  );

  const isDraftRetiredFromEditableFlow = useCallback((draftId: string): boolean => {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) return false;
    return retiredEditableDraftIdsRef.current.has(normalizedDraftId);
  }, []);

  const resolveDraftLifecycleStage = useCallback((draftId: string): DraftLifecycleStage => {
    hydrateDraftLifecycleState();
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) return 'OPEN';

    const explicitStage = draftLifecycleStageRef.current.get(normalizedDraftId);
    if (explicitStage) {
      return explicitStage;
    }
    if (retiredEditableDraftIdsRef.current.has(normalizedDraftId)) {
      const retiredServerDraft = saleDraftsRef.current.find((entry) => entry.id === normalizedDraftId);
      if (retiredServerDraft?.status === 'PAID') return 'PAID';
      if (retiredServerDraft?.status === 'CANCELLED') return 'CANCELLED';
      return 'PENDING_CONFIRM';
    }
    if (syncingPaidDraftIdsRef.current.has(normalizedDraftId)) {
      return 'PENDING_CONFIRM';
    }
    if (pendingPaidSyncQueueRef.current.some((job) => job.draftId === normalizedDraftId)) {
      return 'PENDING_CONFIRM';
    }
    if (pendingPaidSyncRunningDraftIdsRef.current.has(normalizedDraftId)) {
      return 'PENDING_CONFIRM';
    }
    if (failedPaidSyncQueueRef.current.some((job) => job.draftId === normalizedDraftId)) {
      return 'PENDING_CONFIRM';
    }

    const nowMs = Date.now();
    const transitionGraceUntilMs = draftPaymentTransitionGraceUntilRef.current.get(normalizedDraftId) || 0;
    const hasTransitionGrace = transitionGraceUntilMs > nowMs;
    const hasTerminalVisualLock = isDraftTerminalVisualLocked(normalizedDraftId, nowMs);
    if (transitionGraceUntilMs > 0 && !hasTransitionGrace) {
      draftPaymentTransitionGraceUntilRef.current.delete(normalizedDraftId);
    }

    const serverDraft = saleDraftsRef.current.find((entry) => entry.id === normalizedDraftId);
    if (!serverDraft) {
      return hasTransitionGrace || hasTerminalVisualLock ? 'PENDING_CONFIRM' : 'OPEN';
    }
    if (serverDraft.status === 'PAID') return 'PAID';
    if (serverDraft.status === 'CANCELLED') return 'CANCELLED';
    if (serverDraft.status === 'PENDING_PAYMENT') return 'PENDING_CONFIRM';
    if (serverDraft.status === 'DRAFT' && (hasTransitionGrace || hasTerminalVisualLock)) {
      return 'PENDING_CONFIRM';
    }
    return 'OPEN';
  }, [hydrateDraftLifecycleState, isDraftTerminalVisualLocked]);

  const isDraftLifecycleLocked = useCallback(
    (draftId: string): boolean => resolveDraftLifecycleStage(draftId) !== 'OPEN',
    [resolveDraftLifecycleStage]
  );

  const setDraftLifecycleStage = useCallback(
    (
      draftId: string,
      stage: DraftLifecycleStage,
      options: { reason?: string; bumpEpoch?: boolean } = {}
    ): number => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return 0;

      const previousStage = draftLifecycleStageRef.current.get(normalizedDraftId) || null;
      const previousEpoch = draftOperationEpochRef.current.get(normalizedDraftId) || 0;
      const shouldBumpEpoch = options.bumpEpoch ?? previousStage !== stage;
      const nextEpoch = shouldBumpEpoch ? previousEpoch + 1 : previousEpoch;
      const nowMs = Date.now();

      if (stage === 'OPEN') {
        draftLifecycleStageRef.current.delete(normalizedDraftId);
      } else {
        draftLifecycleStageRef.current.set(normalizedDraftId, stage);
        draftReopenObservedAtRef.current.delete(normalizedDraftId);
      }
      if (stage === 'FINALIZING' || stage === 'PENDING_CONFIRM') {
        retiredEditableDraftIdsRef.current.add(normalizedDraftId);
        draftPaymentTransitionGraceUntilRef.current.set(
          normalizedDraftId,
          nowMs + DRAFT_PAYMENT_TRANSITION_GRACE_MS
        );
        draftTerminalVisualLockUntilRef.current.set(
          normalizedDraftId,
          Math.max(
            nowMs + DRAFT_TERMINAL_VISUAL_LOCK_MS,
            draftTerminalVisualLockUntilRef.current.get(normalizedDraftId) || 0
          )
        );
      } else if (stage === 'PAID' || stage === 'CANCELLED') {
        retiredEditableDraftIdsRef.current.add(normalizedDraftId);
        draftPaymentTransitionGraceUntilRef.current.delete(normalizedDraftId);
        draftReopenObservedAtRef.current.delete(normalizedDraftId);
        draftTerminalVisualLockUntilRef.current.set(
          normalizedDraftId,
          Math.max(
            nowMs + DRAFT_TERMINAL_VISUAL_LOCK_MS,
            draftTerminalVisualLockUntilRef.current.get(normalizedDraftId) || 0
          )
        );
      } else if (stage === 'OPEN') {
        retiredEditableDraftIdsRef.current.delete(normalizedDraftId);
        draftTerminalVisualLockUntilRef.current.delete(normalizedDraftId);
        if (options.reason !== 'server_reopened_draft') {
          draftPaymentTransitionGraceUntilRef.current.delete(normalizedDraftId);
          draftReopenObservedAtRef.current.delete(normalizedDraftId);
        }
      }
      if (shouldBumpEpoch) {
        draftOperationEpochRef.current.set(normalizedDraftId, nextEpoch);
      } else if (!draftOperationEpochRef.current.has(normalizedDraftId)) {
        draftOperationEpochRef.current.set(normalizedDraftId, 0);
      }

      if (previousStage !== stage || shouldBumpEpoch) {
        setDraftLifecycleRevision((current) => current + 1);
      }

      if (previousStage !== stage) {
        pushOperationalEvent(
          'QUEUE_HEALTH',
          stage === 'OPEN'
            ? 'Draft voltou para estado editável.'
            : `Draft travado em ${stage}.`,
          {
            draftId: normalizedDraftId,
            previousStage,
            stage,
            reason: options.reason || null,
            epoch: shouldBumpEpoch ? nextEpoch : previousEpoch,
          }
        );
      }

      persistDraftLifecycleState();
      return shouldBumpEpoch ? nextEpoch : previousEpoch;
    },
    [persistDraftLifecycleState, pushOperationalEvent]
  );

  useEffect(() => {
    hydrateDraftLifecycleState();
  }, [hydrateDraftLifecycleState]);

  const isDraftEpochCurrent = useCallback(
    (draftId: string, expectedEpoch: number | null | undefined): boolean => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return true;
      if (expectedEpoch === null || expectedEpoch === undefined) return true;
      return getDraftOperationEpoch(normalizedDraftId) === expectedEpoch;
    },
    [getDraftOperationEpoch]
  );

  const registerPaymentFlowTelemetryStart = useCallback(
    (draftId: string, jobId: string, clickAtMs: number): void => {
      const normalizedDraftId = draftId.trim();
      const normalizedJobId = jobId.trim();
      if (!normalizedDraftId || !normalizedJobId) return;

      paymentFlowTelemetryByDraftRef.current.set(normalizedDraftId, {
        draftId: normalizedDraftId,
        jobId: normalizedJobId,
        clickAtMs,
        localPersistedAtMs: null,
        processingStartedAtMs: null,
        flushPendingDraftAddsMs: 0,
        finalizeMs: 0,
        confirmMs: 0,
        snapshotApplyMs: 0,
        frontendReconcileMs: 0,
        stateRefreshMs: 0,
        recoveryMs: 0,
        retryBackoffMs: 0,
        pFlushMs: 0,
        pPrepareMs: 0,
        pRequestMs: 0,
        pBackendMs: 0,
        pApplySnapshotMs: 0,
        pReconcileMs: 0,
        pPersistMs: 0,
        pOpsMs: 0,
        pFinalizeMs: 0,
        flushLockWaitMs: 0,
        flushPendingReadMs: 0,
        flushSnapshotPrepareMs: 0,
        flushVisibleRunMs: 0,
        flushRecoveryRunMs: 0,
        flushStateRefreshMs: 0,
        flushApplySnapshotMs: 0,
        flushTerminalCleanupMs: 0,
        flushOperationalPersistMs: 0,
        flushUiReleaseMs: 0,
        flushPostReturnMs: 0,
        confirmCommandInvokeMs: 0,
        confirmDraftLockWaitMs: 0,
        confirmGlobalQueueWaitMs: 0,
        confirmGlobalQueueDepthAtEnqueue: 0,
        confirmSchedulerWaitMs: 0,
        confirmPostCommandApplyMs: 0,
        confirmOpsMs: 0,
        confirmFailureHandlingMs: 0,
        stateRefreshEmptyDraftCheckMs: 0,
        stateRefreshAfterFlushMs: 0,
        stateRefreshBeforeFinalizeMs: 0,
        pOpsBackendSentMs: 0,
        pOpsBackendAckMs: 0,
        pOpsEventStateMs: 0,
        pOpsEventPersistMs: 0,
        pOpsEventReportMs: 0,
        retries: 0,
        hadRecovery: false,
        hadReconciliation: false,
      });
    },
    []
  );

  const markPaymentFlowTelemetryLocalPersisted = useCallback(
    (draftId: string, jobId: string): void => {
      const normalizedDraftId = draftId.trim();
      const normalizedJobId = jobId.trim();
      if (!normalizedDraftId || !normalizedJobId) return;

      const current = paymentFlowTelemetryByDraftRef.current.get(normalizedDraftId);
      if (!current) return;
      if (current.jobId !== normalizedJobId) return;
      if (current.localPersistedAtMs !== null) return;
      paymentFlowTelemetryByDraftRef.current.set(normalizedDraftId, {
        ...current,
        localPersistedAtMs: Date.now(),
      });
    },
    []
  );

  const markPaymentFlowTelemetryProcessingStarted = useCallback(
    (draftId: string, jobId: string): void => {
      const normalizedDraftId = draftId.trim();
      const normalizedJobId = jobId.trim();
      if (!normalizedDraftId || !normalizedJobId) return;

      const current = paymentFlowTelemetryByDraftRef.current.get(normalizedDraftId);
      if (!current) return;
      if (current.jobId !== normalizedJobId) return;
      if (current.processingStartedAtMs !== null) return;

      paymentFlowTelemetryByDraftRef.current.set(normalizedDraftId, {
        ...current,
        processingStartedAtMs: Date.now(),
      });
    },
    []
  );

  const markPaymentFlowTelemetryStageDuration = useCallback(
    (
      draftId: string,
      jobId: string,
      stage:
        | 'flushPendingDraftAddsMs'
        | 'finalizeMs'
        | 'confirmMs'
        | 'snapshotApplyMs'
        | 'frontendReconcileMs'
        | 'stateRefreshMs'
        | 'recoveryMs'
        | 'retryBackoffMs'
        | 'pFlushMs'
        | 'pPrepareMs'
        | 'pRequestMs'
        | 'pBackendMs'
        | 'pApplySnapshotMs'
        | 'pReconcileMs'
        | 'pPersistMs'
        | 'pOpsMs'
        | 'pFinalizeMs'
        | 'flushLockWaitMs'
        | 'flushPendingReadMs'
        | 'flushSnapshotPrepareMs'
        | 'flushVisibleRunMs'
        | 'flushRecoveryRunMs'
        | 'flushStateRefreshMs'
        | 'flushApplySnapshotMs'
        | 'flushTerminalCleanupMs'
        | 'flushOperationalPersistMs'
        | 'flushUiReleaseMs'
        | 'flushPostReturnMs'
        | 'confirmCommandInvokeMs'
        | 'confirmDraftLockWaitMs'
        | 'confirmGlobalQueueWaitMs'
        | 'confirmGlobalQueueDepthAtEnqueue'
        | 'confirmSchedulerWaitMs'
        | 'confirmPostCommandApplyMs'
        | 'confirmOpsMs'
        | 'confirmFailureHandlingMs'
        | 'stateRefreshEmptyDraftCheckMs'
        | 'stateRefreshAfterFlushMs'
        | 'stateRefreshBeforeFinalizeMs'
        | 'pOpsBackendSentMs'
        | 'pOpsBackendAckMs'
        | 'pOpsEventStateMs'
        | 'pOpsEventPersistMs'
        | 'pOpsEventReportMs',
      durationMs: number
    ): void => {
      const normalizedDraftId = draftId.trim();
      const normalizedJobId = jobId.trim();
      if (!normalizedDraftId || !normalizedJobId) return;
      if (!Number.isFinite(durationMs) || durationMs <= 0) return;

      const current = paymentFlowTelemetryByDraftRef.current.get(normalizedDraftId);
      if (!current) return;
      if (current.jobId !== normalizedJobId) return;

      paymentFlowTelemetryByDraftRef.current.set(normalizedDraftId, {
        ...current,
        [stage]: Math.max(0, current[stage]) + Math.max(0, Math.round(durationMs)),
      });
    },
    []
  );

  const markPaymentFlowTelemetryProgress = useCallback(
    (
      draftId: string,
      updates: { retries?: number; hadRecovery?: boolean; hadReconciliation?: boolean }
    ): void => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return;
      const current = paymentFlowTelemetryByDraftRef.current.get(normalizedDraftId);
      if (!current) return;
      paymentFlowTelemetryByDraftRef.current.set(normalizedDraftId, {
        ...current,
        retries:
          updates.retries !== undefined
            ? Math.max(current.retries, Math.max(0, Math.floor(updates.retries)))
            : current.retries,
        hadRecovery:
          updates.hadRecovery !== undefined
            ? current.hadRecovery || updates.hadRecovery
            : current.hadRecovery,
        hadReconciliation:
          updates.hadReconciliation !== undefined
            ? current.hadReconciliation || updates.hadReconciliation
            : current.hadReconciliation,
      });
    },
    []
  );

  const completePaymentFlowTelemetry = useCallback(
    (
      draftId: string,
      options: { retries?: number; hadRecovery?: boolean; hadReconciliation?: boolean } = {}
    ): void => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return;
      const current = paymentFlowTelemetryByDraftRef.current.get(normalizedDraftId);
      if (!current) return;

      const nowMs = Date.now();
      const normalizedRetries =
        options.retries !== undefined
          ? Math.max(current.retries, Math.max(0, Math.floor(options.retries)))
          : current.retries;
      const hadRecovery =
        options.hadRecovery !== undefined ? current.hadRecovery || options.hadRecovery : current.hadRecovery;
      const hadReconciliation =
        options.hadReconciliation !== undefined
          ? current.hadReconciliation || options.hadReconciliation
          : current.hadReconciliation;

      const clickToLocalPersistMs =
        current.localPersistedAtMs !== null
          ? Math.max(0, current.localPersistedAtMs - current.clickAtMs)
          : null;
      const waitInQueueMs =
        current.processingStartedAtMs !== null
          ? Math.max(0, current.processingStartedAtMs - current.clickAtMs)
          : null;
      const processingMs =
        current.processingStartedAtMs !== null
          ? Math.max(0, nowMs - current.processingStartedAtMs)
          : null;
      const totalConfMs = Math.max(0, nowMs - current.clickAtMs);
      const flushLockWaitMs = Math.max(0, Math.round(current.flushLockWaitMs));
      const flushPendingReadMs = Math.max(0, Math.round(current.flushPendingReadMs));
      const flushSnapshotPrepareMs = Math.max(0, Math.round(current.flushSnapshotPrepareMs));
      const flushVisibleRunMs = Math.max(0, Math.round(current.flushVisibleRunMs));
      const flushRecoveryRunMs = Math.max(0, Math.round(current.flushRecoveryRunMs));
      const flushStateRefreshMs = Math.max(0, Math.round(current.flushStateRefreshMs));
      const flushApplySnapshotMs = Math.max(0, Math.round(current.flushApplySnapshotMs));
      const flushTerminalCleanupMs = Math.max(0, Math.round(current.flushTerminalCleanupMs));
      const flushOperationalPersistMs = Math.max(0, Math.round(current.flushOperationalPersistMs));
      const flushUiReleaseMs = Math.max(0, Math.round(current.flushUiReleaseMs));
      const flushPostReturnMs = Math.max(0, Math.round(current.flushPostReturnMs));
      const flushMeasuredMs =
        flushLockWaitMs +
        flushPendingReadMs +
        flushSnapshotPrepareMs +
        flushVisibleRunMs +
        flushRecoveryRunMs +
        flushStateRefreshMs +
        flushApplySnapshotMs +
        flushTerminalCleanupMs +
        flushOperationalPersistMs +
        flushUiReleaseMs +
        flushPostReturnMs;
      const flushOtherMs = Math.max(0, Math.round(Math.max(0, current.pFlushMs) - flushMeasuredMs));
      const confirmCommandInvokeMs = Math.max(0, Math.round(current.confirmCommandInvokeMs));
      const confirmDraftLockWaitMs = Math.max(0, Math.round(current.confirmDraftLockWaitMs));
      const confirmGlobalQueueWaitMs = Math.max(0, Math.round(current.confirmGlobalQueueWaitMs));
      const confirmGlobalQueueDepthAtEnqueue = Math.max(
        0,
        Math.round(current.confirmGlobalQueueDepthAtEnqueue)
      );
      const confirmSchedulerWaitMs = Math.max(0, Math.round(current.confirmSchedulerWaitMs));
      const confirmPostCommandApplyMs = Math.max(0, Math.round(current.confirmPostCommandApplyMs));
      const confirmOpsMs = Math.max(0, Math.round(current.confirmOpsMs));
      const confirmFailureHandlingMs = Math.max(0, Math.round(current.confirmFailureHandlingMs));
      const stateRefreshEmptyDraftCheckMs = Math.max(
        0,
        Math.round(current.stateRefreshEmptyDraftCheckMs)
      );
      const stateRefreshAfterFlushMs = Math.max(0, Math.round(current.stateRefreshAfterFlushMs));
      const stateRefreshBeforeFinalizeMs = Math.max(
        0,
        Math.round(current.stateRefreshBeforeFinalizeMs)
      );
      const stateRefreshMeasuredMs =
        stateRefreshEmptyDraftCheckMs + stateRefreshAfterFlushMs + stateRefreshBeforeFinalizeMs;
      const stateRefreshOtherMs = Math.max(
        0,
        Math.round(Math.max(0, current.stateRefreshMs) - stateRefreshMeasuredMs)
      );
      const pOpsBackendSentMs = Math.max(0, Math.round(current.pOpsBackendSentMs));
      const pOpsBackendAckMs = Math.max(0, Math.round(current.pOpsBackendAckMs));
      const pOpsEventStateMs = Math.max(0, Math.round(current.pOpsEventStateMs));
      const pOpsEventPersistMs = Math.max(0, Math.round(current.pOpsEventPersistMs));
      const pOpsEventReportMs = Math.max(0, Math.round(current.pOpsEventReportMs));
      const pOpsMeasuredMs = pOpsBackendSentMs + pOpsBackendAckMs;
      const pOpsOtherMs = Math.max(0, Math.round(Math.max(0, current.pOpsMs) - pOpsMeasuredMs));
      const confirmMeasuredExclusiveMs =
        confirmCommandInvokeMs +
        confirmDraftLockWaitMs +
        confirmGlobalQueueWaitMs +
        confirmSchedulerWaitMs +
        confirmPostCommandApplyMs +
        confirmOpsMs +
        confirmFailureHandlingMs;
      const confirmOtherMs = Math.max(
        0,
        Math.round(Math.max(0, current.confirmMs) - confirmMeasuredExclusiveMs)
      );

      const record: PaymentFlowTelemetryRecord = {
        draftId: current.draftId,
        jobId: current.jobId,
        clickToLocalPersistMs,
        waitInQueueMs,
        processingMs,
        totalConfMs,
        flushPendingDraftAddsMs: Math.max(0, Math.round(current.flushPendingDraftAddsMs)),
        finalizeMs: Math.max(0, Math.round(current.finalizeMs)),
        confirmMs: Math.max(0, Math.round(current.confirmMs)),
        snapshotApplyMs: Math.max(0, Math.round(current.snapshotApplyMs)),
        frontendReconcileMs: Math.max(0, Math.round(current.frontendReconcileMs)),
        stateRefreshMs: Math.max(0, Math.round(current.stateRefreshMs)),
        recoveryMs: Math.max(0, Math.round(current.recoveryMs)),
        retryBackoffMs: Math.max(0, Math.round(current.retryBackoffMs)),
        pFlushMs: Math.max(0, Math.round(current.pFlushMs)),
        pPrepareMs: Math.max(0, Math.round(current.pPrepareMs)),
        pRequestMs: Math.max(0, Math.round(current.pRequestMs)),
        pBackendMs: Math.max(0, Math.round(current.pBackendMs)),
        pApplySnapshotMs: Math.max(0, Math.round(current.pApplySnapshotMs)),
        pReconcileMs: Math.max(0, Math.round(current.pReconcileMs)),
        pPersistMs: Math.max(0, Math.round(current.pPersistMs)),
        pOpsMs: Math.max(0, Math.round(current.pOpsMs)),
        pFinalizeMs: Math.max(0, Math.round(current.pFinalizeMs)),
        flushLockWaitMs,
        flushPendingReadMs,
        flushSnapshotPrepareMs,
        flushVisibleRunMs,
        flushRecoveryRunMs,
        flushStateRefreshMs,
        flushApplySnapshotMs,
        flushTerminalCleanupMs,
        flushOperationalPersistMs,
        flushUiReleaseMs,
        flushPostReturnMs,
        flushOtherMs,
        confirmCommandInvokeMs,
        confirmDraftLockWaitMs,
        confirmGlobalQueueWaitMs,
        confirmGlobalQueueDepthAtEnqueue,
        confirmSchedulerWaitMs,
        confirmPostCommandApplyMs,
        confirmOpsMs,
        confirmFailureHandlingMs,
        confirmOtherMs,
        stateRefreshEmptyDraftCheckMs,
        stateRefreshAfterFlushMs,
        stateRefreshBeforeFinalizeMs,
        stateRefreshOtherMs,
        pOpsBackendSentMs,
        pOpsBackendAckMs,
        pOpsEventStateMs,
        pOpsEventPersistMs,
        pOpsEventReportMs,
        pOpsOtherMs,
        clickToBackendConfirmMs: totalConfMs,
        retries: normalizedRetries,
        hadRecovery,
        hadReconciliation,
        timestamp: new Date(nowMs).toISOString(),
      };

      paymentFlowTelemetryByDraftRef.current.delete(normalizedDraftId);
      const nextRecent = [record, ...paymentFlowTelemetryRecentRef.current].slice(0, 50);
      paymentFlowTelemetryRecentRef.current = nextRecent;
      setPaymentFlowTelemetryHistory(nextRecent);
      savePaymentFlowTelemetryHistory(nextRecent);
      pushOperationalEvent('PAYMENT_FLOW', 'Fluxo de pagamento concluído.', {
        draftId: record.draftId,
        jobId: record.jobId,
        waitInQueueMs: record.waitInQueueMs,
        processingMs: record.processingMs,
        totalConfMs: record.totalConfMs,
        flushPendingDraftAddsMs: record.flushPendingDraftAddsMs,
        finalizeMs: record.finalizeMs,
        confirmMs: record.confirmMs,
        snapshotApplyMs: record.snapshotApplyMs,
        frontendReconcileMs: record.frontendReconcileMs,
        stateRefreshMs: record.stateRefreshMs,
        recoveryMs: record.recoveryMs,
        retryBackoffMs: record.retryBackoffMs,
        p_flush: record.pFlushMs,
        p_prepare: record.pPrepareMs,
        p_request: record.pRequestMs,
        p_backend: record.pBackendMs,
        p_apply_snapshot: record.pApplySnapshotMs,
        p_reconcile: record.pReconcileMs,
        p_persist: record.pPersistMs,
        p_ops: record.pOpsMs,
        p_finalize: record.pFinalizeMs,
        flush_lock_wait_ms: record.flushLockWaitMs,
        flush_pending_read_ms: record.flushPendingReadMs,
        flush_snapshot_prepare_ms: record.flushSnapshotPrepareMs,
        flush_visible_run_ms: record.flushVisibleRunMs,
        flush_recovery_run_ms: record.flushRecoveryRunMs,
        flush_state_refresh_ms: record.flushStateRefreshMs,
        flush_apply_snapshot_ms: record.flushApplySnapshotMs,
        flush_terminal_cleanup_ms: record.flushTerminalCleanupMs,
        flush_operational_persist_ms: record.flushOperationalPersistMs,
        flush_ui_release_ms: record.flushUiReleaseMs,
        flush_post_return_ms: record.flushPostReturnMs,
        flush_other_ms: record.flushOtherMs,
        confirm_command_invoke_ms: record.confirmCommandInvokeMs,
        confirm_draft_lock_wait_ms: record.confirmDraftLockWaitMs,
        confirm_global_queue_wait_ms: record.confirmGlobalQueueWaitMs,
        confirm_global_queue_depth_at_enqueue: record.confirmGlobalQueueDepthAtEnqueue,
        confirm_scheduler_wait_ms: record.confirmSchedulerWaitMs,
        confirm_post_command_apply_ms: record.confirmPostCommandApplyMs,
        confirm_ops_ms: record.confirmOpsMs,
        confirm_failure_handling_ms: record.confirmFailureHandlingMs,
        confirm_other_ms: record.confirmOtherMs,
        state_refresh_empty_draft_check_ms: record.stateRefreshEmptyDraftCheckMs,
        state_refresh_after_flush_ms: record.stateRefreshAfterFlushMs,
        state_refresh_before_finalize_ms: record.stateRefreshBeforeFinalizeMs,
        state_refresh_other_ms: record.stateRefreshOtherMs,
        p_ops_backend_sent_ms: record.pOpsBackendSentMs,
        p_ops_backend_ack_ms: record.pOpsBackendAckMs,
        p_ops_event_state_ms: record.pOpsEventStateMs,
        p_ops_event_persist_ms: record.pOpsEventPersistMs,
        p_ops_event_report_ms: record.pOpsEventReportMs,
        p_ops_other_ms: record.pOpsOtherMs,
        clickToBackendConfirmMs: record.clickToBackendConfirmMs,
        retries: record.retries,
        hadRecovery: record.hadRecovery,
        hadReconciliation: record.hadReconciliation,
      });

      reportErrorMonitorEvent({
        source: 'sistema:payment-flow:completed',
        level: 'info',
        message: 'Fluxo de pagamento concluído e telemetria registrada.',
        context: {
          draftId: record.draftId,
          jobId: record.jobId,
          clickToLocalPersistMs: record.clickToLocalPersistMs,
          waitInQueueMs: record.waitInQueueMs,
          processingMs: record.processingMs,
          totalConfMs: record.totalConfMs,
          flushPendingDraftAddsMs: record.flushPendingDraftAddsMs,
          finalizeMs: record.finalizeMs,
          confirmMs: record.confirmMs,
          snapshotApplyMs: record.snapshotApplyMs,
          frontendReconcileMs: record.frontendReconcileMs,
          stateRefreshMs: record.stateRefreshMs,
          recoveryMs: record.recoveryMs,
          retryBackoffMs: record.retryBackoffMs,
          p_flush: record.pFlushMs,
          p_prepare: record.pPrepareMs,
          p_request: record.pRequestMs,
          p_backend: record.pBackendMs,
          p_apply_snapshot: record.pApplySnapshotMs,
          p_reconcile: record.pReconcileMs,
          p_persist: record.pPersistMs,
          p_ops: record.pOpsMs,
          p_finalize: record.pFinalizeMs,
          flush_lock_wait_ms: record.flushLockWaitMs,
          flush_pending_read_ms: record.flushPendingReadMs,
          flush_snapshot_prepare_ms: record.flushSnapshotPrepareMs,
          flush_visible_run_ms: record.flushVisibleRunMs,
          flush_recovery_run_ms: record.flushRecoveryRunMs,
          flush_state_refresh_ms: record.flushStateRefreshMs,
          flush_apply_snapshot_ms: record.flushApplySnapshotMs,
          flush_terminal_cleanup_ms: record.flushTerminalCleanupMs,
          flush_operational_persist_ms: record.flushOperationalPersistMs,
          flush_ui_release_ms: record.flushUiReleaseMs,
          flush_post_return_ms: record.flushPostReturnMs,
          flush_other_ms: record.flushOtherMs,
          confirm_command_invoke_ms: record.confirmCommandInvokeMs,
          confirm_draft_lock_wait_ms: record.confirmDraftLockWaitMs,
          confirm_global_queue_wait_ms: record.confirmGlobalQueueWaitMs,
          confirm_global_queue_depth_at_enqueue: record.confirmGlobalQueueDepthAtEnqueue,
          confirm_scheduler_wait_ms: record.confirmSchedulerWaitMs,
          confirm_post_command_apply_ms: record.confirmPostCommandApplyMs,
          confirm_ops_ms: record.confirmOpsMs,
          confirm_failure_handling_ms: record.confirmFailureHandlingMs,
          confirm_other_ms: record.confirmOtherMs,
          state_refresh_empty_draft_check_ms: record.stateRefreshEmptyDraftCheckMs,
          state_refresh_after_flush_ms: record.stateRefreshAfterFlushMs,
          state_refresh_before_finalize_ms: record.stateRefreshBeforeFinalizeMs,
          state_refresh_other_ms: record.stateRefreshOtherMs,
          p_ops_backend_sent_ms: record.pOpsBackendSentMs,
          p_ops_backend_ack_ms: record.pOpsBackendAckMs,
          p_ops_event_state_ms: record.pOpsEventStateMs,
          p_ops_event_persist_ms: record.pOpsEventPersistMs,
          p_ops_event_report_ms: record.pOpsEventReportMs,
          p_ops_other_ms: record.pOpsOtherMs,
          clickToBackendConfirmMs: record.clickToBackendConfirmMs,
          retries: record.retries,
          hadRecovery: record.hadRecovery,
          hadReconciliation: record.hadReconciliation,
        },
      });
    },
    [pushOperationalEvent]
  );

  const buildOperationalHealthSnapshot = useCallback((): OperationalHealthSnapshot => {
    const schedulerSnapshot = backendCommandSchedulerRef.current?.getSnapshot();
    const failsafeCurrentPauseMs = Math.max(
      0,
      backendFailsafeBlockedUntilRef.current - Date.now()
    );
    return {
      timestamp: new Date().toISOString(),
      schedulerActive: schedulerSnapshot?.active ?? 0,
      schedulerQueued: schedulerSnapshot?.queued ?? 0,
      schedulerCriticalQueued: schedulerSnapshot?.queuedByPriority.CRITICAL ?? 0,
      schedulerHighQueued: schedulerSnapshot?.queuedByPriority.HIGH ?? 0,
      schedulerNormalQueued: schedulerSnapshot?.queuedByPriority.NORMAL ?? 0,
      schedulerLowQueued: schedulerSnapshot?.queuedByPriority.LOW ?? 0,
      schedulerBackpressureHits: schedulerSnapshot?.backpressureHits ?? 0,
      schedulerDedupeHits: schedulerSnapshot?.dedupeHits ?? 0,
      pendingDraftAdds: countPendingDraftAdds(pendingDraftAddsRef.current),
      pendingPaidQueue: pendingPaidSyncQueueRef.current.length,
      failedQueue: failedPaidSyncQueueRef.current.length,
      failsafeActivations: backendFailsafeActivationCountRef.current,
      failsafeDeferredCommands: backendFailsafeDeferredCommandsRef.current,
      failsafeCurrentPauseMs,
      failsafeAccumulatedPausedMs:
        backendFailsafeAccumulatedPauseMsRef.current +
        (backendFailsafeLastStartedAtRef.current !== null
          ? Math.max(0, Date.now() - backendFailsafeLastStartedAtRef.current)
          : 0),
    };
  }, []);

  const publishOperationalHealthSnapshot = useCallback(
    (source: string, options: { forceReport?: boolean } = {}): void => {
      const snapshot = buildOperationalHealthSnapshot();
      setOperationalHealthSnapshot(snapshot);
      console.info('[OPS_HEALTH]', {
        type: 'OPS_HEALTH',
        source,
        ...snapshot,
      });
      pushOperationalEvent('HEALTH_SNAPSHOT', `Snapshot operacional (${source}).`, {
        schedulerQueued: snapshot.schedulerQueued,
        pendingPaidQueue: snapshot.pendingPaidQueue,
        failedQueue: snapshot.failedQueue,
        failsafeCurrentPauseMs: snapshot.failsafeCurrentPauseMs,
      });

      const nowMs = Date.now();
      const shouldReport =
        options.forceReport === true || nowMs - lastOperationalHealthReportAtRef.current >= 30_000;
      if (!shouldReport) return;
      lastOperationalHealthReportAtRef.current = nowMs;

      reportErrorMonitorEvent({
        source: 'sistema:ops-health:snapshot',
        level: 'info',
        message: 'Snapshot operacional do frontend.',
        context: {
          source,
          ...snapshot,
        },
      });
    },
    [buildOperationalHealthSnapshot, pushOperationalEvent]
  );

  const logQueueHealth = useCallback((source: string): void => {
    const snapshot = buildOperationalHealthSnapshot();
    console.info('[QUEUE_HEALTH]', {
      type: 'QUEUE_HEALTH',
      source,
      ...snapshot,
    });
    pushOperationalEvent('QUEUE_HEALTH', `Fila atualizada (${source}).`, {
      pendingDraftAdds: snapshot.pendingDraftAdds,
      pendingPaidQueue: snapshot.pendingPaidQueue,
      failedQueue: snapshot.failedQueue,
      schedulerQueued: snapshot.schedulerQueued,
    });
    publishOperationalHealthSnapshot(`queue:${source}`);
  }, [buildOperationalHealthSnapshot, publishOperationalHealthSnapshot, pushOperationalEvent]);

  useEffect(() => {
    publishOperationalHealthSnapshot('interval:init', { forceReport: true });
    const intervalId = window.setInterval(() => {
      publishOperationalHealthSnapshot('interval');
    }, 15000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [publishOperationalHealthSnapshot]);

  useEffect(() => {
    if (!isAccessVerified) return;
    const fallbackHistory = loadPaymentFlowTelemetryHistoryLocalFallback();
    paymentFlowTelemetryRecentRef.current = fallbackHistory;
    setPaymentFlowTelemetryHistory(fallbackHistory);

    let cancelled = false;
    void (async () => {
      const resolved = await loadPaymentFlowTelemetryHistoryResolved();
      if (cancelled) return;
      const resolvedHistory = resolved.value || [];
      paymentFlowTelemetryRecentRef.current = resolvedHistory;
      setPaymentFlowTelemetryHistory(resolvedHistory);
      savePaymentFlowTelemetryHistory(resolvedHistory);
    })();

    return () => {
      cancelled = true;
    };
  }, [isAccessVerified]);

  useEffect(() => {
    if (!isAccessVerified) return;
    const fallbackEvents = loadOperationalEventLogLocalFallback();
    operationalEventLogRef.current = fallbackEvents;
    applyOperationalEventLogState(fallbackEvents);

    let cancelled = false;
    void (async () => {
      const resolved = await loadOperationalEventLogResolved();
      if (cancelled) return;
      const events = resolved.value || [];
      operationalEventLogRef.current = events;
      applyOperationalEventLogState(events);
      saveOperationalEventLog(events);
    })();

    return () => {
      cancelled = true;
    };
  }, [applyOperationalEventLogState, isAccessVerified]);

  useEffect(() => {
    if (!isAccessVerified) return;
    let cancelled = false;
    let inFlight = false;

    const syncRemoteOperationalEvents = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const remoteEvents = await fetchOperationalPanelEvents({ limit: 120 });
        if (cancelled) return;
        const normalizedRemote = normalizeOperationalEventLog(remoteEvents);
        operationalRemoteEventLogRef.current = normalizedRemote;
        if (isTechnicalPanelOpen) {
          applyOperationalEventLogState(operationalEventLogRef.current);
        } else {
          scheduleOperationalEventLogUiFlush();
        }
      } catch {
        // keep local-only view when remote feed is unavailable
      } finally {
        inFlight = false;
      }
    };

    void syncRemoteOperationalEvents();
    const intervalId = window.setInterval(() => {
      void syncRemoteOperationalEvents();
    }, OPS_REMOTE_EVENTS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    applyOperationalEventLogState,
    isAccessVerified,
    isTechnicalPanelOpen,
    scheduleOperationalEventLogUiFlush,
  ]);

  useEffect(() => {
    if (!isTechnicalPanelOpen) return;
    if (operationalEventUiFlushTimerRef.current !== null) {
      window.clearTimeout(operationalEventUiFlushTimerRef.current);
      operationalEventUiFlushTimerRef.current = null;
    }
    applyOperationalEventLogState(operationalEventLogRef.current);
  }, [applyOperationalEventLogState, isTechnicalPanelOpen]);

  useEffect(() => {
    return () => {
      if (operationalEventUiFlushTimerRef.current !== null) {
        window.clearTimeout(operationalEventUiFlushTimerRef.current);
        operationalEventUiFlushTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleTogglePanel = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'o')) return;
      event.preventDefault();
      setIsTechnicalPanelOpen((current) => !current);
    };

    window.addEventListener('keydown', handleTogglePanel);
    return () => {
      window.removeEventListener('keydown', handleTogglePanel);
    };
  }, []);

  const getBackendFailsafeRemainingMs = useCallback((): number => {
    return Math.max(0, backendFailsafeBlockedUntilRef.current - Date.now());
  }, []);

  const activateBackendFailsafe = useCallback((reason: string): void => {
    const nextStreak = Math.min(6, backendFailsafeStreakRef.current + 1);
    backendFailsafeStreakRef.current = nextStreak;
    backendFailsafeActivationCountRef.current += 1;
    const delayMs = Math.min(
      BACKEND_FAILSAFE_MAX_PAUSE_MS,
      BACKEND_FAILSAFE_MIN_PAUSE_MS * 2 ** Math.max(0, nextStreak - 1)
    );
    const nextBlockedUntil = Date.now() + delayMs;
    backendFailsafeBlockedUntilRef.current = Math.max(
      backendFailsafeBlockedUntilRef.current,
      nextBlockedUntil
    );
    if (backendFailsafeLastStartedAtRef.current === null) {
      backendFailsafeLastStartedAtRef.current = Date.now();
    }

    reportErrorMonitorEvent({
      source: 'sistema:backend-failsafe:activated',
      level: 'warn',
      message: reason || 'Banco indisponível. Fail-safe acionado.',
      context: {
        streak: nextStreak,
        delayMs,
        blockedUntil: new Date(backendFailsafeBlockedUntilRef.current).toISOString(),
      },
    });
    pushOperationalEvent('FAILSAFE_ACTIVATED', 'Fail-safe de backend ativado.', {
      streak: nextStreak,
      delayMs,
      reason,
      blockedUntil: new Date(backendFailsafeBlockedUntilRef.current).toISOString(),
    });
    publishOperationalHealthSnapshot('failsafe:activated', { forceReport: true });
  }, [publishOperationalHealthSnapshot, pushOperationalEvent]);

  const clearBackendFailsafe = useCallback((): void => {
    if (backendFailsafeLastStartedAtRef.current !== null) {
      backendFailsafeAccumulatedPauseMsRef.current += Math.max(
        0,
        Date.now() - backendFailsafeLastStartedAtRef.current
      );
      backendFailsafeLastStartedAtRef.current = null;
    }
    backendFailsafeStreakRef.current = 0;
    backendFailsafeBlockedUntilRef.current = 0;
    pushOperationalEvent('FAILSAFE_CLEARED', 'Fail-safe de backend liberado.', {
      accumulatedPauseMs: backendFailsafeAccumulatedPauseMsRef.current,
    });
    publishOperationalHealthSnapshot('failsafe:cleared');
  }, [publishOperationalHealthSnapshot, pushOperationalEvent]);

  const runBackendExecution = useCallback(
    async <T,>(
      options: BackendExecutionOptions,
      task: () => Promise<T>
    ): Promise<T> => {
      const blockedMs = getBackendFailsafeRemainingMs();
      if (blockedMs > 0) {
        backendFailsafeDeferredCommandsRef.current += 1;
        publishOperationalHealthSnapshot('failsafe:deferred-command');
        throw new StateCommandSyncError(
          'Banco temporariamente indisponível. Tentando novamente...',
          {
            statusCode: 503,
            retryable: true,
          }
        );
      }

      const startedAt = Date.now();
      const commandDraftId = options.command ? getCommandDraftId(options.command) : null;
      const effectiveDraftId = options.draftId || commandDraftId || null;
      const priority = resolveBackendExecutionPriority(options);
      const dedupeKey = resolveBackendExecutionDedupeKey(options);
      const groupKey = resolveBackendExecutionGroupKey(options);
      const executeWithTimeout = async (): Promise<T> => {
        let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
          return await Promise.race([
            task(),
            new Promise<T>((_resolve, reject) => {
              timeoutId = globalThis.setTimeout(() => {
                reject(
                  new StateCommandSyncError('Timeout aguardando resposta do backend.', {
                    statusCode: 408,
                    retryable: true,
                  })
                );
              }, BACKEND_OPERATION_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timeoutId !== null) {
            globalThis.clearTimeout(timeoutId);
          }
        }
      };

      try {
        const scheduler = backendCommandSchedulerRef.current;
        if (ENABLE_COMMAND_SCHEDULER && !scheduler) {
          throw new StateCommandSyncError('Scheduler de comandos não inicializado.', {
            statusCode: 500,
            retryable: true,
          });
        }

        const schedulerQueuedAt = performance.now();
        const result = ENABLE_COMMAND_SCHEDULER
          ? await scheduler!.enqueue({
              key: dedupeKey,
              priority,
              groupKey,
              run: async () => {
                options.onSchedulerWaitMs?.(Math.max(0, performance.now() - schedulerQueuedAt));
                return executeWithTimeout();
              },
            })
          : await executeWithTimeout();

        console.info('[COMMAND_EXECUTION]', {
          type: 'COMMAND_EXECUTION',
          commandId: options.command?.commandId || options.commandId || null,
          draftId: effectiveDraftId,
          commandType: options.command?.type || options.operationType,
          duration: Date.now() - startedAt,
          success: true,
          retryCount: options.retryCount ?? 0,
        });
        clearBackendFailsafe();
        return result;
      } catch (error) {
        if (error instanceof CommandSchedulerBackpressureError) {
          console.info('[COMMAND_EXECUTION]', {
            type: 'COMMAND_EXECUTION',
            commandId: options.command?.commandId || options.commandId || null,
            draftId: effectiveDraftId,
            commandType: options.command?.type || options.operationType,
            duration: Date.now() - startedAt,
            success: false,
            retryCount: options.retryCount ?? 0,
            backpressure: true,
          });
          pushOperationalEvent('BACKPRESSURE', 'Backpressure no scheduler global de comandos.', {
            queueSize: error.queueSize,
            maxQueueSize: error.maxQueueSize,
            commandType: options.command?.type || options.operationType,
            draftId: effectiveDraftId,
          });
          throw new StateCommandSyncError(
            'Fila operacional ocupada. Aguarde alguns segundos e tente novamente.',
            {
              statusCode: 429,
              retryable: true,
            }
          );
        }
        const message = getStateSyncErrorMessage(error);
        if (isDatabaseUnavailableErrorMessage(message)) {
          activateBackendFailsafe(message);
        }
        console.info('[COMMAND_EXECUTION]', {
          type: 'COMMAND_EXECUTION',
          commandId: options.command?.commandId || options.commandId || null,
          draftId: effectiveDraftId,
          commandType: options.command?.type || options.operationType,
          duration: Date.now() - startedAt,
          success: false,
          retryCount: options.retryCount ?? 0,
        });
        throw error;
      }
    },
    [
      activateBackendFailsafe,
      clearBackendFailsafe,
      getBackendFailsafeRemainingMs,
      publishOperationalHealthSnapshot,
      pushOperationalEvent,
    ]
  );

  const runWithDraftLock = useCallback(
    async <T,>(
      draftId: string | null | undefined,
      task: () => Promise<T>,
      options: { onLockWaitMs?: (durationMs: number) => void } = {}
    ): Promise<T> => {
      const normalizedDraftId = (draftId || '').trim();
      if (!normalizedDraftId) {
        return task();
      }

      const queue = commandDraftLocksRef.current;
      const previous = queue.get(normalizedDraftId) ?? Promise.resolve();
      const queuedAt = performance.now();
      const executeTask = () => {
        options.onLockWaitMs?.(Math.max(0, performance.now() - queuedAt));
        return task();
      };
      const next = previous.then(executeTask, executeTask);
      const settled = next.then(
        () => undefined,
        () => undefined
      );
      queue.set(normalizedDraftId, settled);

      try {
        return await next;
      } finally {
        if (queue.get(normalizedDraftId) === settled) {
          queue.delete(normalizedDraftId);
        }
      }
    },
    []
  );

  const runRetryDispatchLoop = useCallback(async (): Promise<void> => {
    if (retryDispatchRunningRef.current) return;
    retryDispatchRunningRef.current = true;

    try {
      while (retryDispatchQueueRef.current.length > 0) {
        const nextTask = retryDispatchQueueRef.current.shift();
        if (!nextTask) continue;
        retryDispatchQueuedKeysRef.current.delete(nextTask.key);
        try {
          await nextTask.run();
        } catch (error) {
          reportErrorMonitorEvent({
            source: 'sistema:retry-dispatch',
            level: 'warn',
            message: getStateSyncErrorMessage(error),
            stack: error instanceof Error ? error.stack : undefined,
            context: {
              key: nextTask.key,
            },
          });
        }
      }
    } finally {
      retryDispatchRunningRef.current = false;
    }
  }, []);

  const enqueueRetryDispatchTask = useCallback(
    (key: string, run: () => Promise<void> | void): void => {
      const normalizedKey = key.trim();
      if (!normalizedKey) return;
      if (retryDispatchQueuedKeysRef.current.has(normalizedKey)) return;
      retryDispatchQueuedKeysRef.current.add(normalizedKey);
      retryDispatchQueueRef.current.push({
        key: normalizedKey,
        run: async () => {
          await Promise.resolve(run());
        },
      });
      void runRetryDispatchLoop();
    },
    [runRetryDispatchLoop]
  );

  const scheduleRetryDispatchTask = useCallback(
    (
      key: string,
      delayMs: number,
      run: () => Promise<void> | void,
      options: { allowImmediate?: boolean } = {}
    ): void => {
      const normalizedKey = key.trim();
      if (!normalizedKey) return;
      const timers = retryDispatchTimersRef.current;
      const existingTimer = timers.get(normalizedKey);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
      const roundedDelayMs = Math.max(0, Math.round(delayMs));
      const safeDelayMs = options.allowImmediate ? roundedDelayMs : Math.max(250, roundedDelayMs);
      const timerId = window.setTimeout(() => {
        const activeTimer = retryDispatchTimersRef.current.get(normalizedKey);
        if (activeTimer !== timerId) return;
        retryDispatchTimersRef.current.delete(normalizedKey);
        enqueueRetryDispatchTask(normalizedKey, run);
      }, safeDelayMs);
      timers.set(normalizedKey, timerId);
    },
    [enqueueRetryDispatchTask]
  );

  const getObsoleteCommandReason = useCallback((command: StateCommand): string | null => {
    const commandDraftId = getCommandDraftId(command);
    if (!commandDraftId) return null;
    const draft = saleDraftsRef.current.find((entry) => entry.id === commandDraftId);
    if (!draft) return null;

    if (command.type === 'SALE_DRAFT_REMOVE_ITEM') {
      const hasItem = Array.isArray(draft.items)
        ? draft.items.some((entry) => entry.id === command.itemId)
        : false;
      return hasItem ? null : 'item_not_found_locally';
    }

    if (command.type === 'SALE_DRAFT_FINALIZE') {
      if (
        draft.status === 'PENDING_PAYMENT' ||
        draft.status === 'PAID' ||
        draft.status === 'CANCELLED'
      ) {
        return `draft_status_${draft.status.toLowerCase()}`;
      }
      return null;
    }

    if (command.type === 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID') {
      return draft.status === 'PAID' || draft.status === 'CANCELLED'
        ? `draft_status_${draft.status.toLowerCase()}`
        : null;
    }

    if (command.type === 'SALE_DRAFT_CONFIRM_PAID') {
      return draft.status === 'PAID' || draft.status === 'CANCELLED'
        ? `draft_status_${draft.status.toLowerCase()}`
        : null;
    }

    if (command.type === 'SALE_DRAFT_ADD_ITEM') {
      if (draft.status !== 'DRAFT') {
        return `draft_not_open_${draft.status.toLowerCase()}`;
      }
      return null;
    }

    if (command.type === 'SALE_DRAFT_UPDATE_ITEM') {
      if (draft.status !== 'DRAFT') {
        return `draft_not_open_${draft.status.toLowerCase()}`;
      }
      const hasItem = Array.isArray(draft.items)
        ? draft.items.some((entry) => entry.id === command.itemId)
        : false;
      return hasItem ? null : 'item_not_found_locally';
    }

    if (command.type === 'SALE_DRAFT_SET_CUSTOMER_TYPE') {
      return draft.status === 'DRAFT' ? null : `draft_not_open_${draft.status.toLowerCase()}`;
    }

    if (command.type === 'SALE_DRAFT_CANCEL') {
      return draft.status === 'PAID' || draft.status === 'CANCELLED'
        ? `draft_status_${draft.status.toLowerCase()}`
        : null;
    }

    return null;
  }, []);

  const activatePendingPaidSyncIngressBackpressure = useCallback((queueSize: number): void => {
    pendingPaidSyncIngressBlockedUntilRef.current = Date.now() + QUEUE_BACKPRESSURE_PAUSE_MS;
    pushOperationalEvent('BACKPRESSURE', 'Backpressure na fila de pagamento.', {
      queueSize,
      maxSize: PENDING_PAID_SYNC_QUEUE_MAX_SIZE,
      blockedUntil: new Date(pendingPaidSyncIngressBlockedUntilRef.current).toISOString(),
    });
    reportErrorMonitorEvent({
      source: 'sistema:queue-backpressure:pending-paid',
      level: 'warn',
      message: 'Fila de sincronização de pagamento acima do limite seguro.',
      context: {
        queueSize,
        maxSize: PENDING_PAID_SYNC_QUEUE_MAX_SIZE,
      },
    });
  }, [pushOperationalEvent]);

  const activatePendingDraftAddsIngressBackpressure = useCallback((queueSize: number): void => {
    pendingDraftAddsIngressBlockedUntilRef.current = Date.now() + QUEUE_BACKPRESSURE_PAUSE_MS;
    pushOperationalEvent('BACKPRESSURE', 'Backpressure na fila de itens pendentes.', {
      queueSize,
      maxSize: PENDING_DRAFT_ADDS_MAX_SIZE,
      blockedUntil: new Date(pendingDraftAddsIngressBlockedUntilRef.current).toISOString(),
    });
    reportErrorMonitorEvent({
      source: 'sistema:queue-backpressure:pending-draft-adds',
      level: 'warn',
      message: 'Fila de itens pendentes do carrinho acima do limite seguro.',
      context: {
        queueSize,
        maxSize: PENDING_DRAFT_ADDS_MAX_SIZE,
      },
    });
  }, [pushOperationalEvent]);

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
      pendingDraftAddCancellationIntentsRef.current.clear();
      pendingDraftAddsInFlightRef.current.clear();
      optimisticRemovedDraftItemsRef.current.clear();
      draftItemRemoteMutationRetryAttemptsRef.current.clear();
      pendingDraftFlushQueueRef.current.clear();
      retryDispatchTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      retryDispatchTimersRef.current.clear();
      retryDispatchQueueRef.current = [];
      retryDispatchQueuedKeysRef.current.clear();
      backendCommandSchedulerRef.current?.clear();
      commandDraftLocksRef.current.clear();
      draftLifecycleStageRef.current.clear();
      draftOperationEpochRef.current.clear();
      isDraftLifecycleHydratedRef.current = false;
    };
  }, []);

  const replacePendingDraftAdds = useCallback((nextPendingAdds: PendingDraftAddsByDraftId) => {
    const normalized: PendingDraftAddsByDraftId = {};
    const nowMs = Date.now();
    let discardedTerminalEntries = 0;
    Object.entries(nextPendingAdds).forEach(([draftId, entries]) => {
      if (!Array.isArray(entries) || entries.length === 0) return;
      const safeEntries = entries
        .map((entry) => normalizePendingDraftAdd(entry))
        .filter((entry): entry is PendingDraftAdd => entry !== null)
        .filter((entry) => {
          const keep = shouldRetainPendingDraftAddEntry(entry, nowMs);
          if (!keep && isPendingDraftAddTerminalStatus(entry.status)) {
            discardedTerminalEntries += 1;
          }
          return keep;
        });
      if (safeEntries.length > 0) {
        normalized[draftId] = safeEntries;
      }
    });

    pendingDraftAddsRef.current = normalized;
    setPendingDraftAddsByDraft(normalized);
    savePendingDraftAdds(normalized);
    pendingDraftAddsRevisionRef.current += 1;
    logQueueHealth('pending-draft-adds');
    if (discardedTerminalEntries > 0) {
      pushOperationalEvent(
        'COMMAND_SKIPPED_OBSOLETE',
        'Pending adds terminais antigos descartados durante compactação segura.',
        {
          discardedTerminalEntries,
        }
      );
    }
    isPendingDraftAddsHydratedRef.current = true;
  }, [logQueueHealth, pushOperationalEvent]);

  const hydratePendingDraftAdds = useCallback(() => {
    if (isPendingDraftAddsHydratedRef.current) return;

    const fallbackPendingAdds = loadPendingDraftAddsLocalFallback();
    replacePendingDraftAdds(fallbackPendingAdds);

    if (pendingDraftAddsRecoveryLoadRef.current) return;
    const hydrationRevision = pendingDraftAddsRevisionRef.current;
    pendingDraftAddsRecoveryLoadRef.current = (async () => {
      const resolved = await loadPendingDraftAddsResolved();
      const recoveredPendingAdds = resolved.value || {};

      if (pendingDraftAddsRevisionRef.current === hydrationRevision) {
        replacePendingDraftAdds(recoveredPendingAdds);
        return;
      }

      const mergedPendingAdds = mergePendingDraftAdds(
        pendingDraftAddsRef.current,
        recoveredPendingAdds
      );
      try {
        const currentSerialized = JSON.stringify(pendingDraftAddsRef.current);
        const mergedSerialized = JSON.stringify(mergedPendingAdds);
        if (currentSerialized === mergedSerialized) return;
      } catch {
        if (countPendingDraftAdds(mergedPendingAdds) <= countPendingDraftAdds(pendingDraftAddsRef.current)) {
          return;
        }
      }

      replacePendingDraftAdds(mergedPendingAdds);
    })().finally(() => {
      pendingDraftAddsRecoveryLoadRef.current = null;
    });
  }, [replacePendingDraftAdds]);

  const clearRecoveryPendingDraftAddsForDraft = useCallback((draftId: string): void => {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) return;
    if (!recoveryPendingDraftAddsRef.current[normalizedDraftId]) return;
    const nextRecoveryByDraft = { ...recoveryPendingDraftAddsRef.current };
    delete nextRecoveryByDraft[normalizedDraftId];
    recoveryPendingDraftAddsRef.current = nextRecoveryByDraft;
  }, []);

  const cleanupDraftOperationalArtifacts = useCallback((draftId: string): void => {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) return;

    const timerMap = pendingDraftBackgroundSyncTimerRef.current;
    const activeTimer = timerMap.get(normalizedDraftId);
    if (activeTimer !== undefined) {
      window.clearTimeout(activeTimer);
      timerMap.delete(normalizedDraftId);
    }
    pendingDraftBackgroundRetryAttemptsRef.current.delete(normalizedDraftId);

    const optimisticMap = optimisticRemovedDraftItemsRef.current;
    if (optimisticMap.has(normalizedDraftId)) {
      const nextMap = new Map(optimisticMap);
      nextMap.delete(normalizedDraftId);
      optimisticRemovedDraftItemsRef.current = nextMap;
      setOptimisticRemovedDraftItemsRevision((current) => current + 1);
    }
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
      pendingPaidSyncQueueRevisionRef.current += 1;
      logQueueHealth('pending-paid-sync');
      isPendingPaidSyncQueueHydratedRef.current = true;
    },
    [logQueueHealth]
  );

  const hydratePendingPaidSyncQueue = useCallback(() => {
    if (isPendingPaidSyncQueueHydratedRef.current) return;

    const fallbackQueue = loadPendingPaidSyncQueueLocalFallback();
    pendingPaidSyncQueueRef.current = fallbackQueue;
    setPendingPaidSyncJobs(fallbackQueue.length);
    setPendingPaidSyncQueueSnapshot(fallbackQueue);
    pendingPaidSyncQueueRevisionRef.current += 1;
    fallbackQueue.forEach((job) => {
      setDraftSyncInProgress(job.draftId, true);
    });
    isPendingPaidSyncQueueHydratedRef.current = true;

    if (pendingPaidSyncQueueRecoveryLoadRef.current) return;
    const hydrationRevision = pendingPaidSyncQueueRevisionRef.current;
    pendingPaidSyncQueueRecoveryLoadRef.current = (async () => {
      const resolved = await loadPendingPaidSyncQueueResolved();
      const recoveredQueue = resolved.value || [];

      if (pendingPaidSyncQueueRevisionRef.current === hydrationRevision) {
        const previousDraftIds = new Set<string>(
          pendingPaidSyncQueueRef.current.map((job) => String(job.draftId))
        );
        const nextDraftIds = new Set<string>(
          recoveredQueue.map((job) => String(job.draftId))
        );
        previousDraftIds.forEach((draftId) => {
          if (!nextDraftIds.has(draftId)) {
            setDraftSyncInProgress(draftId, false);
          }
        });
        nextDraftIds.forEach((draftId) => {
          setDraftSyncInProgress(draftId, true);
        });

        pendingPaidSyncQueueRef.current = recoveredQueue;
        setPendingPaidSyncJobs(recoveredQueue.length);
        setPendingPaidSyncQueueSnapshot(recoveredQueue);
        savePendingPaidSyncQueue(recoveredQueue);
        pendingPaidSyncQueueRevisionRef.current += 1;
        return;
      }

      const beforeLength = pendingPaidSyncQueueRef.current.length;
      const mergedQueue = mergePendingPaidSyncQueue(
        pendingPaidSyncQueueRef.current,
        recoveredQueue
      );
      if (mergedQueue.length <= beforeLength) return;

      pendingPaidSyncQueueRef.current = mergedQueue;
      setPendingPaidSyncJobs(mergedQueue.length);
      setPendingPaidSyncQueueSnapshot(mergedQueue);
      mergedQueue.forEach((job) => {
        setDraftSyncInProgress(job.draftId, true);
      });
      savePendingPaidSyncQueue(mergedQueue);
      pendingPaidSyncQueueRevisionRef.current += 1;
    })().finally(() => {
      pendingPaidSyncQueueRecoveryLoadRef.current = null;
    });
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
    failedPaidSyncQueueRevisionRef.current += 1;
    logQueueHealth('failed-paid-sync');
    isFailedPaidSyncQueueHydratedRef.current = true;
  }, [logQueueHealth]);

  const hydrateFailedPaidSyncQueue = useCallback(() => {
    if (isFailedPaidSyncQueueHydratedRef.current) return;

    const fallbackQueue = loadFailedPaidSyncQueueLocalFallback();
    failedPaidSyncQueueRef.current = fallbackQueue;
    setFailedPaidSyncQueue(fallbackQueue);
    failedPaidSyncQueueRevisionRef.current += 1;
    isFailedPaidSyncQueueHydratedRef.current = true;

    if (failedPaidSyncQueueRecoveryLoadRef.current) return;
    const hydrationRevision = failedPaidSyncQueueRevisionRef.current;
    failedPaidSyncQueueRecoveryLoadRef.current = (async () => {
      const resolved = await loadFailedPaidSyncQueueResolved();
      const recoveredQueue = resolved.value || [];

      if (failedPaidSyncQueueRevisionRef.current === hydrationRevision) {
        failedPaidSyncQueueRef.current = recoveredQueue;
        setFailedPaidSyncQueue(recoveredQueue);
        saveFailedPaidSyncQueue(recoveredQueue);
        failedPaidSyncQueueRevisionRef.current += 1;
        return;
      }

      const beforeLength = failedPaidSyncQueueRef.current.length;
      const mergedQueue = mergeFailedPaidSyncQueue(
        failedPaidSyncQueueRef.current,
        recoveredQueue
      );
      if (mergedQueue.length <= beforeLength) return;

      failedPaidSyncQueueRef.current = mergedQueue;
      setFailedPaidSyncQueue(mergedQueue);
      saveFailedPaidSyncQueue(mergedQueue);
      failedPaidSyncQueueRevisionRef.current += 1;
    })().finally(() => {
      failedPaidSyncQueueRecoveryLoadRef.current = null;
    });
  }, []);

  useEffect(() => {
    if (!isAccessVerified) return;
    hydrateFailedPaidSyncQueue();
  }, [hydrateFailedPaidSyncQueue, isAccessVerified]);

  useEffect(() => {
    if (!isAccessVerified) return;
    if (!isPendingDraftAddsHydratedRef.current) return;
    if (!isPendingPaidSyncQueueHydratedRef.current) return;
    if (!isFailedPaidSyncQueueHydratedRef.current) return;

    const terminalDraftIds = new Set<string>(
      saleDraftsRef.current
        .filter((draft) => draft.status === 'PAID' || draft.status === 'CANCELLED')
        .map((draft) => draft.id)
    );
    if (terminalDraftIds.size === 0) return;

    let removedFromVisiblePending = 0;
    const nextPendingDraftAdds: PendingDraftAddsByDraftId = {};
    Object.entries(
      pendingDraftAddsRef.current as Record<string, PendingDraftAdd[]>
    ).forEach(([draftId, entries]) => {
      if (terminalDraftIds.has(draftId)) {
        removedFromVisiblePending += entries.length;
        return;
      }
      nextPendingDraftAdds[draftId] = entries;
    });
    if (removedFromVisiblePending > 0) {
      replacePendingDraftAdds(nextPendingDraftAdds);
    }

    let removedFromRecovery = 0;
    const nextRecoveryPendingDraftAdds: PendingDraftAddsByDraftId = {};
    Object.entries(
      recoveryPendingDraftAddsRef.current as Record<string, PendingDraftAdd[]>
    ).forEach(([draftId, entries]) => {
      if (terminalDraftIds.has(draftId)) {
        removedFromRecovery += entries.length;
        return;
      }
      nextRecoveryPendingDraftAdds[draftId] = entries;
    });
    if (removedFromRecovery > 0) {
      recoveryPendingDraftAddsRef.current = nextRecoveryPendingDraftAdds;
    }

    const removedPendingPaidJobs = pendingPaidSyncQueueRef.current.filter((job) =>
      terminalDraftIds.has(job.draftId)
    );
    if (removedPendingPaidJobs.length > 0) {
      removedPendingPaidJobs.forEach((job) => {
        completePaymentFlowTelemetry(job.draftId, {
          retries: job.attempts,
          hadReconciliation: true,
        });
      });
      replacePendingPaidSyncQueue(
        pendingPaidSyncQueueRef.current.filter((job) => !terminalDraftIds.has(job.draftId))
      );
    }

    const removedFailedJobs = failedPaidSyncQueueRef.current.filter((job) =>
      terminalDraftIds.has(job.draftId)
    );
    if (removedFailedJobs.length > 0) {
      removedFailedJobs.forEach((job) => {
        completePaymentFlowTelemetry(job.draftId, {
          retries: job.attempts,
          hadReconciliation: true,
        });
      });
      replaceFailedPaidSyncQueue(
        failedPaidSyncQueueRef.current.filter((job) => !terminalDraftIds.has(job.draftId))
      );
    }

    if (
      removedFromVisiblePending > 0 ||
      removedFromRecovery > 0 ||
      removedPendingPaidJobs.length > 0 ||
      removedFailedJobs.length > 0
    ) {
      terminalDraftIds.forEach((draftId) => {
        setDraftSyncInProgress(draftId, false);
      });
      pushOperationalEvent(
        'QUEUE_HEALTH',
        'Filas de draft terminal foram descartadas automaticamente.',
        {
          terminalDrafts: Array.from(terminalDraftIds),
          removedVisiblePending: removedFromVisiblePending,
          removedRecoveryPending: removedFromRecovery,
          removedPendingPaidJobs: removedPendingPaidJobs.length,
          removedFailedJobs: removedFailedJobs.length,
        }
      );
    }
  }, [
    completePaymentFlowTelemetry,
    failedPaidSyncQueue,
    isAccessVerified,
    pendingDraftAddsByDraft,
    pendingPaidSyncJobs,
    pushOperationalEvent,
    replaceFailedPaidSyncQueue,
    replacePendingDraftAdds,
    replacePendingPaidSyncQueue,
    saleDrafts,
    setDraftSyncInProgress,
  ]);

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

  const applyStateSnapshotIfDraftEpochCurrent = useCallback(
    (
      state: AppState,
      draftId: string | null | undefined,
      expectedEpoch: number | null | undefined,
      source: string
    ): boolean => {
      const normalizedDraftId = (draftId || '').trim();
      if (!normalizedDraftId) {
        applyStateSnapshot(state);
        return true;
      }

      if (!isDraftEpochCurrent(normalizedDraftId, expectedEpoch)) {
        const currentEpoch = getDraftOperationEpoch(normalizedDraftId);
        pushOperationalEvent(
          'COMMAND_SKIPPED_OBSOLETE',
          'Resultado assíncrono obsoleto ignorado por mismatch de epoch.',
          {
            draftId: normalizedDraftId,
            source,
            expectedEpoch: expectedEpoch ?? null,
            currentEpoch,
          }
        );
        console.info('[COMMAND_EXECUTION]', {
          type: 'COMMAND_EXECUTION',
          commandId: null,
          draftId: normalizedDraftId,
          commandType: source,
          duration: 0,
          success: true,
          retryCount: 0,
          result: 'ignored_as_obsolete',
          obsoleteReason: 'draft_epoch_mismatch',
          expectedEpoch: expectedEpoch ?? null,
          currentEpoch,
        });
        return false;
      }

      applyStateSnapshot(state);
      return true;
    },
    [applyStateSnapshot, getDraftOperationEpoch, isDraftEpochCurrent, pushOperationalEvent]
  );

  const executeSyncedCommand = useCallback(
    async (
      command: StateCommand,
      options: {
        trackPendingState?: boolean;
        failFastOnVersionConflict?: boolean;
        skipObsoleteCheck?: boolean;
        skipSnapshotApply?: boolean;
        bypassGlobalCommandQueue?: boolean;
        onSnapshotAppliedMs?: (durationMs: number) => void;
        onStateCommandRoundtripTiming?: (timing: { requestMs: number; backendMs: number }) => void;
        onGlobalQueueWaitMs?: (durationMs: number) => void;
        onGlobalQueueMeta?: (meta: GlobalQueueWaitMeta) => void;
        onBackendSchedulerWaitMs?: (durationMs: number) => void;
      } = {}
    ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
      const shouldTrackPendingState = options.trackPendingState !== false;
      if (shouldTrackPendingState) {
        setPendingStateOps((current) => current + 1);
      }

      const executeCommand = async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
        try {
          const commandDraftId = getCommandDraftId(command);
          const expectedDraftEpoch = commandDraftId
            ? getDraftOperationEpoch(commandDraftId)
            : null;
          const obsoleteReason = options.skipObsoleteCheck
            ? null
            : getObsoleteCommandReason(command);
          if (obsoleteReason) {
            console.info('[COMMAND_EXECUTION]', {
              type: 'COMMAND_EXECUTION',
              commandId: command.commandId || null,
              draftId: getCommandDraftId(command),
              commandType: command.type,
              duration: 0,
              success: true,
              retryCount: 0,
              result: 'ignored_as_obsolete',
              obsoleteReason,
              stage: 'pre-backend',
            });
            pushOperationalEvent('COMMAND_SKIPPED_OBSOLETE', 'Comando obsoleto ignorado antes de executar.', {
              draftId: getCommandDraftId(command),
              commandType: command.type,
              commandId: command.commandId || null,
              obsoleteReason,
            });
            return { ok: true };
          }
          const nextState = await runBackendExecution(
            {
              operationType: 'RUN_STATE_COMMAND',
              command,
              draftId: commandDraftId,
              retryCount: 0,
              onSchedulerWaitMs: options.onBackendSchedulerWaitMs,
            },
            () =>
              runStateCommand(command, {
                failFastOnVersionConflict: options.failFastOnVersionConflict,
                responseMode: options.skipSnapshotApply ? 'headers-only' : 'snapshot',
                onRoundtripTiming: options.onStateCommandRoundtripTiming,
              })
          );
          if (!options.skipSnapshotApply) {
            if (!nextState) {
              throw new StateCommandSyncError(
                'Servidor não retornou snapshot para aplicar no estado local.',
                {
                  statusCode: 503,
                  retryable: true,
                }
              );
            }
            const snapshotApplyStartedAt = performance.now();
            const appliedSnapshot = applyStateSnapshotIfDraftEpochCurrent(
              nextState,
              commandDraftId,
              expectedDraftEpoch,
              'run_state_command'
            );
            if (
              !appliedSnapshot &&
              commandDraftId &&
              isTerminalPaidSyncCommand(command)
            ) {
              pushOperationalEvent(
                'COMMAND_SKIPPED_OBSOLETE',
                'Snapshot terminal obsoleto detectado. Forçando reconciliação imediata.',
                {
                  draftId: commandDraftId,
                  commandType: command.type,
                  commandId: command.commandId || null,
                }
              );
              try {
                const reconciledState = await runBackendExecution(
                  {
                    operationType: 'FETCH_STATE_SNAPSHOT',
                    draftId: commandDraftId,
                    retryCount: 0,
                  },
                  () => fetchStateSnapshot()
                );
                const reconcileEpoch = getDraftOperationEpoch(commandDraftId);
                applyStateSnapshotIfDraftEpochCurrent(
                  reconciledState,
                  commandDraftId,
                  reconcileEpoch,
                  'run_state_command_reconcile_refresh'
                );
              } catch (reconcileError) {
                reportErrorMonitorEvent({
                  source: 'sistema:state-command:reconcile-refresh-failed',
                  level: 'warn',
                  message:
                    'Falha ao reconciliar snapshot após mismatch de epoch em comando terminal.',
                  stack: reconcileError instanceof Error ? reconcileError.stack : undefined,
                  context: {
                    draftId: commandDraftId,
                    commandType: command.type,
                    commandId: command.commandId || null,
                  },
                });
              }
            }
            options.onSnapshotAppliedMs?.(performance.now() - snapshotApplyStartedAt);
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error };
        } finally {
          if (shouldTrackPendingState) {
            setPendingStateOps((current) => Math.max(0, current - 1));
          }
        }
      };

      if (options.bypassGlobalCommandQueue) {
        return executeCommand();
      }

      const queueDepthAtEnqueue = Math.max(0, Math.floor(globalCommandQueueDepthRef.current));
      const activeCommandAtEnqueue = globalCommandQueueActiveRef.current;
      const lastCompletedAtEnqueue = globalCommandQueueLastCompletedRef.current;
      globalCommandQueueDepthRef.current += 1;
      const queuedAt = performance.now();
      const runQueuedExecution = () => {
        globalCommandQueueDepthRef.current = Math.max(0, globalCommandQueueDepthRef.current - 1);
        const runStartedAt = performance.now();
        const commandDraftId = getCommandDraftId(command);
        options.onGlobalQueueWaitMs?.(Math.max(0, runStartedAt - queuedAt));
        options.onGlobalQueueMeta?.({
          queueDepthAtEnqueue,
          activeCommandType: activeCommandAtEnqueue?.commandType ?? null,
          activeDraftId: activeCommandAtEnqueue?.draftId ?? null,
          activeCommandElapsedMs: activeCommandAtEnqueue
            ? Math.max(0, runStartedAt - activeCommandAtEnqueue.startedAtMs)
            : 0,
          lastCompletedCommandType: lastCompletedAtEnqueue?.commandType ?? null,
          lastCompletedDraftId: lastCompletedAtEnqueue?.draftId ?? null,
          lastCompletedDurationMs: Math.max(0, lastCompletedAtEnqueue?.durationMs ?? 0),
        });
        const token = createClientId('gq');
        globalCommandQueueActiveRef.current = {
          token,
          commandType: command.type,
          draftId: commandDraftId,
          startedAtMs: runStartedAt,
        };
        return executeCommand().finally(() => {
          const finishedAt = performance.now();
          globalCommandQueueLastCompletedRef.current = {
            commandType: command.type,
            draftId: commandDraftId,
            durationMs: Math.max(0, finishedAt - runStartedAt),
          };
          if (globalCommandQueueActiveRef.current?.token === token) {
            globalCommandQueueActiveRef.current = null;
          }
        });
      };
      const scheduledExecution = commandQueueRef.current.then(
        () => runQueuedExecution(),
        () => runQueuedExecution()
      );

      commandQueueRef.current = scheduledExecution.then(
        () => undefined,
        () => undefined
      );

      return scheduledExecution;
    },
    [
      applyStateSnapshotIfDraftEpochCurrent,
      getDraftOperationEpoch,
      getObsoleteCommandReason,
      pushOperationalEvent,
      runBackendExecution,
    ]
  );

  const fetchStateSnapshotControlled = useCallback(
    async (draftId?: string, retryCount = 0): Promise<AppState> => {
      return runBackendExecution(
        {
          operationType: 'FETCH_STATE_SNAPSHOT',
          draftId: draftId || null,
          retryCount,
        },
        () => fetchStateSnapshot()
      );
    },
    [runBackendExecution]
  );

  const enqueueStateCommandAsyncControlled = useCallback(
    async (command: StateCommand, retryCount = 0) => {
      const commandDraftId = getCommandDraftId(command);
      return runWithDraftLock(commandDraftId, () =>
        runBackendExecution(
          {
            operationType: 'ENQUEUE_STATE_COMMAND_ASYNC',
            command,
            draftId: commandDraftId,
            retryCount,
          },
          () => enqueueStateCommandAsync(command)
        )
      );
    },
    [runBackendExecution, runWithDraftLock]
  );

  const getStateCommandAsyncJobControlled = useCallback(
    async (jobId: string, draftId?: string, retryCount = 0) => {
      return runBackendExecution(
        {
          operationType: 'GET_STATE_COMMAND_ASYNC_JOB',
          commandId: jobId,
          draftId: draftId || null,
          retryCount,
        },
        () => getStateCommandAsyncJob(jobId)
      );
    },
    [runBackendExecution]
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
      const obsoleteReason = options.skipObsoleteCheck
        ? null
        : getObsoleteCommandReason(normalizedCommand);
      if (obsoleteReason) {
        updateRunCommandErrorSink(options.errorSink, {
          error: undefined,
          message: undefined,
          retryable: undefined,
          statusCode: undefined,
        });
        console.info('[COMMAND_EXECUTION]', {
          type: 'COMMAND_EXECUTION',
          commandId: normalizedCommand.commandId || null,
          draftId: getCommandDraftId(normalizedCommand),
          commandType: normalizedCommand.type,
          duration: 0,
          success: true,
          retryCount: 0,
          result: 'ignored_as_obsolete',
          obsoleteReason,
        });
        pushOperationalEvent('COMMAND_SKIPPED_OBSOLETE', 'Comando obsoleto ignorado.', {
          draftId: getCommandDraftId(normalizedCommand),
          commandType: normalizedCommand.type,
          commandId: normalizedCommand.commandId || null,
          obsoleteReason,
        });
        if (successMessage && !options.silentSuccessNotification) {
          showNotification(successMessage);
        }
        return true;
      }

      const result = await runWithDraftLock(getCommandDraftId(normalizedCommand), async () => {
        return executeSyncedCommand(normalizedCommand, {
          trackPendingState: options.trackPendingState,
          failFastOnVersionConflict: options.failFastOnVersionConflict,
          skipObsoleteCheck: options.skipObsoleteCheck,
          skipSnapshotApply: options.skipSnapshotApply,
          bypassGlobalCommandQueue: options.bypassGlobalCommandQueue,
          onSnapshotAppliedMs: options.onSnapshotAppliedMs,
          onStateCommandRoundtripTiming: options.onStateCommandRoundtripTiming,
          onGlobalQueueWaitMs: options.onGlobalQueueWaitMs,
          onGlobalQueueMeta: options.onGlobalQueueMeta,
          onBackendSchedulerWaitMs: options.onBackendSchedulerWaitMs,
        });
      }, {
        onLockWaitMs: options.onDraftLockWaitMs,
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
    [executeSyncedCommand, getObsoleteCommandReason, pushOperationalEvent, queueOfflineSale, runWithDraftLock]
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
      pendingAdds
        .filter((entry) => isPendingDraftAddVisible(entry))
        .map((entry) => {
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
      const optimisticRemovedItems = optimisticRemovedDraftItemsRef.current.get(draft.id);
      const baseItems =
        optimisticRemovedItems && optimisticRemovedItems.size > 0
          ? draft.items.filter((item) => !optimisticRemovedItems.has(item.id))
          : draft.items;

      const pendingItems = buildPendingItems(pendingAdds);
      if (pendingItems.length === 0 && baseItems === draft.items) return draft;
      const serverTotal = roundMoney(
        baseItems.reduce(
          (sum, item) => sum + (Number(item.unitPriceSnapshot) || 0) * (Number(item.qty) || 0),
          0
        )
      );
      const pendingTotal = roundMoney(
        pendingItems.reduce(
          (sum, item) => sum + (Number(item.unitPriceSnapshot) || 0) * (Number(item.qty) || 0),
          0
        )
      );

      return {
        ...draft,
        items: [...baseItems, ...pendingItems],
        total: roundMoney(serverTotal + pendingTotal),
      };
    };

    const mergedServerDrafts = saleDrafts.map((draft) =>
      mergeDraft(
        draft,
        isDraftLifecycleLocked(draft.id) ||
          isDraftTerminalVisualLocked(draft.id) ||
          isDraftRetiredFromEditableFlow(draft.id)
          ? []
          : pendingDraftAddsByDraft[draft.id] || []
      )
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
          countVisiblePendingDraftAdds(entries) > 0 &&
          !isDraftLifecycleLocked(draftId) &&
          !isDraftTerminalVisualLocked(draftId) &&
          !isDraftRetiredFromEditableFlow(draftId) &&
          !serverDraftIds.has(draftId) &&
          !knownPersistedDraftIds.has(draftId)
      )
      .map(([draftId, entries]) => {
        const visibleEntries = entries.filter((entry) => isPendingDraftAddVisible(entry));
        const pendingItems = buildPendingItems(visibleEntries);
        const total = roundMoney(
          pendingItems.reduce(
            (sum, item) => sum + (Number(item.unitPriceSnapshot) || 0) * (Number(item.qty) || 0),
            0
          )
        );
        const firstQueuedAt = visibleEntries[0]?.queuedAt || new Date().toISOString();
        const lastQueuedAt = visibleEntries[visibleEntries.length - 1]?.queuedAt || firstQueuedAt;

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
  }, [
    globalCancelledSales,
    globalSales,
    optimisticRemovedDraftItemsRevision,
    draftLifecycleRevision,
    isDraftLifecycleLocked,
    isDraftRetiredFromEditableFlow,
    isDraftTerminalVisualLocked,
    pendingDraftAddsByDraft,
    products,
    saleDrafts,
    sales,
  ]);

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
        if (isDraftLifecycleLocked(draft.id)) return false;
        if (isDraftTerminalVisualLocked(draft.id)) return false;
        if (isDraftRetiredFromEditableFlow(draft.id)) return false;
        if (draft.status !== 'DRAFT' && draft.status !== 'PENDING_PAYMENT') return false;
        const pendingLocalItemsCount = countVisiblePendingDraftAdds(
          pendingDraftAddsByDraft[draft.id] || []
        );
        return draft.items.length > 0 || pendingLocalItemsCount > 0;
      });
    },
    [
      draftLifecycleRevision,
      failedPaidSyncQueue,
      isDraftLifecycleLocked,
      isDraftRetiredFromEditableFlow,
      isDraftTerminalVisualLocked,
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
  useEffect(() => {
    const syncingDraftIds = new Set<string>();
    syncingPaidDraftIdsRef.current.forEach((draftId) => {
      const normalizedDraftId = draftId.trim();
      if (normalizedDraftId) {
        syncingDraftIds.add(normalizedDraftId);
      }
    });
    const runningDraftIds = new Set<string>();
    pendingPaidSyncRunningDraftIdsRef.current.forEach((draftId) => {
      const normalizedDraftId = draftId.trim();
      if (normalizedDraftId) {
        runningDraftIds.add(normalizedDraftId);
      }
    });
    const queuedDraftIds = new Set<string>();
    pendingPaidSyncQueueRef.current.forEach((job) => {
      const normalizedDraftId = job.draftId.trim();
      if (normalizedDraftId) {
        queuedDraftIds.add(normalizedDraftId);
      }
    });
    failedPaidSyncQueueRef.current.forEach((job) => {
      const normalizedDraftId = job.draftId.trim();
      if (normalizedDraftId) {
        queuedDraftIds.add(normalizedDraftId);
      }
    });
    const nowMs = Date.now();
    const draftReopenObservedAt = draftReopenObservedAtRef.current;
    const knownDraftIds = new Set<string>();
    const knownPersistedDraftIds = new Set<string>();
    [...sales, ...globalSales, ...globalCancelledSales].forEach((entry) => {
      const saleDraftId = typeof entry.saleDraftId === 'string' ? entry.saleDraftId.trim() : '';
      if (saleDraftId) {
        knownPersistedDraftIds.add(saleDraftId);
      }
    });

    saleDrafts.forEach((draft) => {
      const normalizedDraftId = draft.id.trim();
      if (normalizedDraftId) {
        knownDraftIds.add(normalizedDraftId);
      }
      if (draft.status === 'PAID' || draft.status === 'CANCELLED') {
        draftReopenObservedAt.delete(normalizedDraftId);
        setDraftLifecycleStage(draft.id, draft.status === 'PAID' ? 'PAID' : 'CANCELLED', {
          reason: 'server_terminal_state',
          bumpEpoch: false,
        });
      } else if (draft.status === 'PENDING_PAYMENT') {
        draftReopenObservedAt.delete(normalizedDraftId);
        setDraftLifecycleStage(draft.id, 'PENDING_CONFIRM', {
          reason: 'server_pending_payment_state',
          bumpEpoch: false,
        });
      } else if (draft.status === 'DRAFT') {
        if (!normalizedDraftId) return;
        const hasPersistedTerminalEvidence = knownPersistedDraftIds.has(normalizedDraftId);
        const transitionGraceUntilMs =
          draftPaymentTransitionGraceUntilRef.current.get(normalizedDraftId) || 0;
        const hasRecentTransitionGrace = transitionGraceUntilMs > nowMs;
        if (transitionGraceUntilMs > 0 && !hasRecentTransitionGrace) {
          draftPaymentTransitionGraceUntilRef.current.delete(normalizedDraftId);
        }
        const hasTerminalVisualLock = isDraftTerminalVisualLocked(normalizedDraftId, nowMs);
        const isRetiredFromEditableFlow = isDraftRetiredFromEditableFlow(normalizedDraftId);
        const hasTerminalProcessingInFlight =
          syncingDraftIds.has(normalizedDraftId) ||
          queuedDraftIds.has(normalizedDraftId) ||
          runningDraftIds.has(normalizedDraftId);
        const hasServerDraftItems = Array.isArray(draft.items) && draft.items.length > 0;
        if (
          hasRecentTransitionGrace ||
          hasTerminalProcessingInFlight ||
          hasTerminalVisualLock ||
          hasPersistedTerminalEvidence ||
          !hasServerDraftItems
        ) {
          draftReopenObservedAt.delete(normalizedDraftId);
          return;
        }
        if (!isRetiredFromEditableFlow && resolveDraftLifecycleStage(normalizedDraftId) === 'OPEN') {
          draftReopenObservedAt.delete(normalizedDraftId);
          return;
        }
        const observedAtMs = draftReopenObservedAt.get(normalizedDraftId);
        if (observedAtMs === undefined) {
          draftReopenObservedAt.set(normalizedDraftId, nowMs);
          return;
        }
        if (nowMs - observedAtMs < DRAFT_REOPEN_CONFIRMATION_MS) return;
        draftReopenObservedAt.delete(normalizedDraftId);
        setDraftLifecycleStage(normalizedDraftId, 'OPEN', {
          reason: 'server_reopened_draft',
          bumpEpoch: false,
        });
      }
    });

    draftReopenObservedAt.forEach((_observedAt, draftId) => {
      if (!knownDraftIds.has(draftId)) {
        draftReopenObservedAt.delete(draftId);
      }
    });
    retiredEditableDraftIdsRef.current.forEach((draftId) => {
      const hasVisibleLocalPending =
        countVisiblePendingDraftAdds(pendingDraftAddsRef.current[draftId] || []) > 0;
      const hasVisibleRecoveryPending =
        countVisiblePendingDraftAdds(recoveryPendingDraftAddsRef.current[draftId] || []) > 0;
      const isKnownOrInFlight =
        knownDraftIds.has(draftId) ||
        knownPersistedDraftIds.has(draftId) ||
        syncingDraftIds.has(draftId) ||
        queuedDraftIds.has(draftId) ||
        runningDraftIds.has(draftId) ||
        hasVisibleLocalPending ||
        hasVisibleRecoveryPending;
      if (!isKnownOrInFlight) {
        retiredEditableDraftIdsRef.current.delete(draftId);
      }
    });
    draftTerminalVisualLockUntilRef.current.forEach((lockUntilMs, draftId) => {
      const isKnownOrInFlight =
        knownDraftIds.has(draftId) ||
        syncingDraftIds.has(draftId) ||
        queuedDraftIds.has(draftId) ||
        runningDraftIds.has(draftId);
      if (!isKnownOrInFlight || lockUntilMs <= nowMs) {
        draftTerminalVisualLockUntilRef.current.delete(draftId);
      }
    });
  }, [
    globalCancelledSales,
    globalSales,
    failedPaidSyncQueue,
    isDraftRetiredFromEditableFlow,
    pendingPaidSyncQueueSnapshot,
    resolveDraftLifecycleStage,
    saleDrafts,
    sales,
    setDraftLifecycleStage,
    isDraftTerminalVisualLocked,
    syncingPaidDraftIds,
  ]);
  useEffect(() => {
    const currentMap = optimisticRemovedDraftItemsRef.current;
    if (currentMap.size === 0) return;

    let changed = false;
    const nextMap = new Map<string, Set<string>>();
    currentMap.forEach((itemIds, draftId) => {
      const draft = saleDrafts.find((entry) => entry.id === draftId) || null;
      if (!draft) {
        changed = true;
        return;
      }
      const existingItemIds = new Set(draft.items.map((item) => item.id));
      const nextSet = new Set<string>();
      itemIds.forEach((itemId) => {
        if (existingItemIds.has(itemId)) {
          nextSet.add(itemId);
          return;
        }
        changed = true;
      });
      if (nextSet.size > 0) {
        nextMap.set(draftId, nextSet);
      } else if (itemIds.size > 0) {
        changed = true;
      }
    });

    if (!changed) return;
    optimisticRemovedDraftItemsRef.current = nextMap;
    setOptimisticRemovedDraftItemsRevision((current) => current + 1);
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
      if (isDraftLifecycleLocked(draftId)) return true;
      if (isDraftTerminalVisualLocked(draftId)) return true;
      if (isDraftRetiredFromEditableFlow(draftId)) return true;
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
      const hasPendingEntries =
        countVisiblePendingDraftAdds(pendingDraftAddsRef.current[draftId] || []) > 0;
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
  }, [isDraftLifecycleLocked, isDraftRetiredFromEditableFlow, isDraftTerminalVisualLocked]);

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
      if (isDraftLifecycleLocked(draftId)) {
        showNotification('Esta venda está em processamento e não aceita novos itens.');
        return false;
      }
      const ingressBlockedMs = Math.max(
        0,
        pendingDraftAddsIngressBlockedUntilRef.current - Date.now()
      );
      if (ingressBlockedMs > 0) {
        showNotification(
          `Carrinho em sincronização intensa. Aguarde ${Math.ceil(ingressBlockedMs / 1000)}s.`
        );
        return false;
      }

      const currentPendingCount = countPendingDraftAdds(pendingDraftAddsRef.current);
      if (currentPendingCount >= PENDING_DRAFT_ADDS_MAX_SIZE) {
        activatePendingDraftAddsIngressBackpressure(currentPendingCount);
        showNotification(
          'Limite de itens pendentes atingido. Aguarde a sincronização para continuar.'
        );
        return false;
      }

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
            entry.status === 'ACTIVE' &&
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
            updatedAt: new Date().toISOString(),
          };
          return next;
        }

        const nowIso = new Date().toISOString();
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
            queuedAt: nowIso,
            updatedAt: nowIso,
            status: 'ACTIVE',
          },
        ];
      });

      return true;
    },
    [
      activatePendingDraftAddsIngressBackpressure,
      ingredientsForSale,
      notifyDraftItemStockIssue,
      resolveDraftItemStockIssue,
      showNotification,
      isDraftLifecycleLocked,
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
        const index = current.findIndex(
          (entry) =>
            entry.localItemId === itemId &&
            !isPendingDraftAddTerminalStatus(entry.status)
        );
        if (index < 0) return current;
        found = true;
        const next = [...current];
        const updated = updater(next[index]);
        if (!updated || updated.quantity <= 0) {
          next.splice(index, 1);
          return next;
        }
        const normalizedStatus = normalizePendingDraftAddStatus(updated.status);
        const normalizedUpdatedAt =
          typeof updated.updatedAt === 'string' && !Number.isNaN(Date.parse(updated.updatedAt))
            ? updated.updatedAt
            : new Date().toISOString();
        next[index] = {
          ...updated,
          quantity: Math.max(1, Math.round(updated.quantity)),
          status: normalizedStatus,
          updatedAt: normalizedUpdatedAt,
          terminalReason:
            isPendingDraftAddTerminalStatus(normalizedStatus) && updated.terminalReason
              ? updated.terminalReason
              : undefined,
        };
        return next;
      });
      return found;
    },
    [updatePendingDraftAddsForDraft]
  );

  const setDraftItemOptimisticRemoval = useCallback(
    (draftId: string, itemId: string, isActive: boolean): void => {
      const normalizedDraftId = draftId.trim();
      const normalizedItemId = itemId.trim();
      if (!normalizedDraftId || !normalizedItemId) return;

      const currentMap = optimisticRemovedDraftItemsRef.current;
      const currentSet = currentMap.get(normalizedDraftId);

      if (isActive) {
        if (currentSet?.has(normalizedItemId)) return;
        const nextMap = new Map(currentMap);
        const nextSet = new Set(currentSet || []);
        nextSet.add(normalizedItemId);
        nextMap.set(normalizedDraftId, nextSet);
        optimisticRemovedDraftItemsRef.current = nextMap;
        setOptimisticRemovedDraftItemsRevision((current) => current + 1);
        return;
      }

      if (!currentSet?.has(normalizedItemId)) return;
      const nextMap = new Map(currentMap);
      const nextSet = new Set(currentSet);
      nextSet.delete(normalizedItemId);
      if (nextSet.size === 0) {
        nextMap.delete(normalizedDraftId);
      } else {
        nextMap.set(normalizedDraftId, nextSet);
      }
      optimisticRemovedDraftItemsRef.current = nextMap;
      setOptimisticRemovedDraftItemsRevision((current) => current + 1);
    },
    []
  );

  const findServerDraftItemMatchingPendingIntent = useCallback(
    (intent: PendingDraftAddCancellationIntent): SaleDraft['items'][number] | null => {
      const draft = saleDraftsRef.current.find((entry) => entry.id === intent.draftId) || null;
      if (!draft || !Array.isArray(draft.items) || draft.items.length === 0) return null;
      const recipeSignature = intent.recipeSignature;
      const noteNormalized = intent.noteNormalized;
      const candidates = draft.items.filter((item) => {
        if (item.productId !== intent.productId) return false;
        if (normalizeDraftItemNoteForMatch(item.note) !== noteNormalized) return false;
        return normalizeRecipeSignature(item.recipe) === recipeSignature;
      });
      if (candidates.length === 0) return null;
      const exactByPrice = candidates.find((item) => {
        const priceRaw = Number(item.unitPriceSnapshot);
        const itemPrice = Number.isFinite(priceRaw) ? roundMoney(priceRaw) : 0;
        return areDraftItemUnitPricesEquivalent(itemPrice, intent.unitPriceSnapshot);
      });
      return exactByPrice || candidates[0];
    },
    []
  );

  const runDraftItemRemoteMutation = useCallback(
    async (params: {
      draftId: string;
      itemId: string;
      targetQty: number;
      source: 'manual' | 'cancelled_pending_add';
      optimisticHide?: boolean;
      silentTerminalErrorNotification?: boolean;
    }): Promise<boolean> => {
      const normalizedDraftId = params.draftId.trim();
      const normalizedItemId = params.itemId.trim();
      if (!normalizedDraftId || !normalizedItemId) return false;

      const normalizedTargetQty = Math.max(0, Math.round(params.targetQty));
      const mutationType =
        normalizedTargetQty <= 0 ? 'SALE_DRAFT_REMOVE_ITEM' : 'SALE_DRAFT_UPDATE_ITEM';
      const retryKey =
        normalizedTargetQty <= 0
          ? `draft-item-remove:${normalizedDraftId}:${normalizedItemId}`
          : `draft-item-update:${normalizedDraftId}:${normalizedItemId}:${normalizedTargetQty}`;
      const shouldHideOptimistically =
        params.optimisticHide === true && normalizedTargetQty <= 0;

      if (shouldHideOptimistically) {
        setDraftItemOptimisticRemoval(normalizedDraftId, normalizedItemId, true);
      }

      const executeAttempt = async (): Promise<{
        ok: boolean;
        retryable: boolean;
        message?: string;
        statusCode?: number;
      }> => {
        const command: StateCommand =
          normalizedTargetQty <= 0
            ? {
                type: 'SALE_DRAFT_REMOVE_ITEM',
                draftId: normalizedDraftId,
                itemId: normalizedItemId,
              }
            : {
                type: 'SALE_DRAFT_UPDATE_ITEM',
                draftId: normalizedDraftId,
                itemId: normalizedItemId,
                quantity: normalizedTargetQty,
              };
        const errorSink: RunCommandErrorSink = {};
        const ok = await runCommandWithSync(command, undefined, {
          silentSuccessNotification: true,
          silentErrorNotification: true,
          trackPendingState: false,
          errorSink,
        });
        return {
          ok,
          retryable: errorSink.retryable ?? true,
          message: errorSink.message,
          statusCode: errorSink.statusCode,
        };
      };

      const settleSuccess = (stage: string): void => {
        draftItemRemoteMutationRetryAttemptsRef.current.delete(retryKey);
        setDraftItemOptimisticRemoval(normalizedDraftId, normalizedItemId, false);
        pushOperationalEvent('CART_REMOVE_REMOTE', 'Remoção remota concluída.', {
          draftId: normalizedDraftId,
          itemId: normalizedItemId,
          commandType: mutationType,
          source: params.source,
          stage,
        });
      };

      const settleTerminalFailure = (
        outcome: { message?: string; statusCode?: number },
        stage: string
      ): void => {
        draftItemRemoteMutationRetryAttemptsRef.current.delete(retryKey);
        setDraftItemOptimisticRemoval(normalizedDraftId, normalizedItemId, false);
        pushOperationalEvent('CART_REMOVE_REMOTE', 'Remoção remota falhou de forma terminal.', {
          draftId: normalizedDraftId,
          itemId: normalizedItemId,
          commandType: mutationType,
          source: params.source,
          stage,
          message: outcome.message,
          statusCode: outcome.statusCode,
        });
        if (!params.silentTerminalErrorNotification && outcome.message) {
          showNotification(outcome.message);
        }
      };

      const firstOutcome = await executeAttempt();
      if (firstOutcome.ok) {
        settleSuccess('immediate');
        return true;
      }

      if (!firstOutcome.retryable) {
        settleTerminalFailure(firstOutcome, 'immediate');
        return false;
      }

      const scheduleNextRetry = (attempt: number): void => {
        const safeAttempt = Math.max(1, Math.floor(attempt));
        draftItemRemoteMutationRetryAttemptsRef.current.set(retryKey, safeAttempt);
        const delayMs = getPendingDraftBackgroundSyncRetryDelayMs(safeAttempt);
        scheduleRetryDispatchTask(retryKey, delayMs, async () => {
          const retryOutcome = await executeAttempt();
          if (retryOutcome.ok) {
            settleSuccess(`retry_${safeAttempt}`);
            return;
          }
          if (!retryOutcome.retryable) {
            settleTerminalFailure(retryOutcome, `retry_${safeAttempt}`);
            return;
          }
          scheduleNextRetry(safeAttempt + 1);
        });
      };

      pushOperationalEvent('CART_REMOVE_REMOTE', 'Remoção remota reagendada para retry.', {
        draftId: normalizedDraftId,
        itemId: normalizedItemId,
        commandType: mutationType,
        source: params.source,
        message: firstOutcome.message,
        statusCode: firstOutcome.statusCode,
      });
      const nextAttempt = (draftItemRemoteMutationRetryAttemptsRef.current.get(retryKey) || 0) + 1;
      scheduleNextRetry(nextAttempt);
      return true;
    },
    [runCommandWithSync, scheduleRetryDispatchTask, setDraftItemOptimisticRemoval, showNotification, pushOperationalEvent]
  );

  const handleRemoveDraftItem = useCallback(
    (itemId: string) => {
      if (!activeDraft) return;
      if (activeDraft.status !== 'DRAFT') {
        showNotification('Remova os itens apenas com a venda em DRAFT.');
        return;
      }
      if (isDraftLifecycleLocked(activeDraft.id)) {
        showNotification('Esta venda está em processamento e não pode mais ser editada.');
        return;
      }

      const normalizedItemId = itemId.trim();
      if (!normalizedItemId) return;
      const currentItem = activeDraft.items.find((entry) => entry.id === normalizedItemId);
      if (!currentItem) return;

      const draftId = activeDraft.id;
      const pendingEntry =
        (pendingDraftAddsRef.current[draftId] || []).find(
          (entry) =>
            entry.localItemId === normalizedItemId &&
            !isPendingDraftAddTerminalStatus(entry.status)
        ) || null;

      if (pendingEntry) {
        const pendingRuntimeKey = buildPendingDraftAddRuntimeKey(draftId, pendingEntry.localItemId);
        const product = products.find((entry) => entry.id === pendingEntry.productId) || null;
        const unitPriceRaw =
          pendingEntry.priceOverride !== undefined
            ? Number(pendingEntry.priceOverride)
            : Number(product?.price);
        const unitPriceSnapshot = Number.isFinite(unitPriceRaw) ? roundMoney(unitPriceRaw) : 0;

        const cancelledAt = new Date().toISOString();
        pendingDraftAddCancellationIntentsRef.current.set(pendingRuntimeKey, {
          draftId,
          localItemId: pendingEntry.localItemId,
          commandId: pendingEntry.commandId,
          productId: pendingEntry.productId,
          quantity: Math.max(1, Math.round(pendingEntry.quantity)),
          recipeSignature: normalizeRecipeSignature(pendingEntry.recipeOverride),
          noteNormalized: normalizeDraftItemNoteForMatch(pendingEntry.note),
          unitPriceSnapshot,
          cancelledAt,
        });

        const cancelledVisiblePending = updatePendingDraftAddByItemId(
          draftId,
          normalizedItemId,
          (entry) =>
            withPendingDraftAddStatus(
              {
                ...entry,
                terminalReason: 'manual_remove',
              },
              'CANCELLED',
              'manual_remove'
            )
        );

        const recoveryEntries = recoveryPendingDraftAddsRef.current[draftId] || [];
        if (recoveryEntries.length > 0) {
          let changedRecovery = false;
          const nextRecoveryEntries = recoveryEntries.map((entry) => {
            if (entry.localItemId !== normalizedItemId) return entry;
            if (isPendingDraftAddTerminalStatus(entry.status)) return entry;
            changedRecovery = true;
            return withPendingDraftAddStatus(
              {
                ...entry,
                terminalReason: 'manual_remove',
              },
              'CANCELLED',
              'manual_remove'
            );
          });
          if (changedRecovery) {
            const nextRecoveryByDraft = { ...recoveryPendingDraftAddsRef.current };
            nextRecoveryByDraft[draftId] = nextRecoveryEntries;
            recoveryPendingDraftAddsRef.current = nextRecoveryByDraft;
          }
        }

        const wasInFlight = pendingDraftAddsInFlightRef.current.has(pendingRuntimeKey);
        pushOperationalEvent('CART_REMOVE_LOCAL_PENDING', 'Remoção local de item pendente aplicada.', {
          draftId,
          localItemId: normalizedItemId,
          commandId: pendingEntry.commandId,
          removedVisiblePending: cancelledVisiblePending,
          wasInFlight,
        });
        pushOperationalEvent('PENDING_ADD_CANCELLED', 'Pending add cancelado para evitar reaplicação.', {
          draftId,
          localItemId: normalizedItemId,
          commandId: pendingEntry.commandId,
          transition: wasInFlight,
        });
        console.info('[CART_REMOVE]', {
          type: 'CART_REMOVE_LOCAL_PENDING',
          draftId,
          localItemId: normalizedItemId,
          commandId: pendingEntry.commandId,
          transition: wasInFlight,
        });

        if (typeof window !== 'undefined') {
          window.setTimeout(() => {
            const currentIntent = pendingDraftAddCancellationIntentsRef.current.get(
              pendingRuntimeKey
            );
            if (!currentIntent || currentIntent.cancelledAt !== cancelledAt) return;
            if (pendingDraftAddsInFlightRef.current.has(pendingRuntimeKey)) return;
            pendingDraftAddCancellationIntentsRef.current.delete(pendingRuntimeKey);
          }, 20_000);
        }
        return;
      }

      if (isLocalPendingDraftItemId(normalizedItemId)) {
        pushOperationalEvent('COMMAND_SKIPPED_OBSOLETE', 'Remoção local ignorada: item pendente já obsoleto.', {
          draftId,
          localItemId: normalizedItemId,
        });
        return;
      }

      void runDraftItemRemoteMutation({
        draftId,
        itemId: normalizedItemId,
        targetQty: 0,
        source: 'manual',
        optimisticHide: true,
      });
    },
    [
      activeDraft,
      products,
      pushOperationalEvent,
      runDraftItemRemoteMutation,
      showNotification,
      updatePendingDraftAddByItemId,
      isDraftLifecycleLocked,
    ]
  );

  const hasPendingDraftAddCancellationIntentForDraft = useCallback((draftId: string): boolean => {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) return false;
    for (const intent of pendingDraftAddCancellationIntentsRef.current.values()) {
      if (intent.draftId === normalizedDraftId) {
        return true;
      }
    }
    const nowMs = Date.now();
    const cancellationGuardWindowMs = 2 * 60 * 1000;
    const isRecentCancellation = (entry: PendingDraftAdd): boolean => {
      if (entry.status !== 'CANCELLED') return false;
      const updatedAtMs = Date.parse(entry.updatedAt);
      if (!Number.isFinite(updatedAtMs)) return true;
      return nowMs - updatedAtMs <= cancellationGuardWindowMs;
    };
    const visibleEntries = pendingDraftAddsRef.current[normalizedDraftId] || [];
    if (visibleEntries.some((entry) => isRecentCancellation(entry))) {
      return true;
    }
    const recoveryEntries = recoveryPendingDraftAddsRef.current[normalizedDraftId] || [];
    if (recoveryEntries.some((entry) => isRecentCancellation(entry))) {
      return true;
    }
    return false;
  }, []);

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

      if (isDraftLifecycleLocked(draftId)) {
        showNotification('Esta venda já entrou em processamento e não pode mais ser editada.');
        return;
      }

      const queued = queuePendingDraftAdd(draftId, product, recipeOverride, priceOverride);
      if (!queued) return;

      showNotification(`${product.name} adicionado ao carrinho!`);
      triggerCartEntryEffect(product.name);
    })();
  }, [
    isDraftLifecycleLocked,
    queuePendingDraftAdd,
    resolveEditableDraftId,
    showNotification,
    triggerCartEntryEffect,
  ]);

  const handleUpdateDraftCustomerType = (customerType: SaleCustomerType) => {
    if (!activeDraft) return;
    if (isDraftLifecycleLocked(activeDraft.id)) {
      showNotification('Esta venda está em processamento e não pode mais ser editada.');
      return;
    }
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
    if (isDraftLifecycleLocked(activeDraft.id)) {
      showNotification('Esta venda está em processamento e não pode mais ser editada.');
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

    if (targetQty <= 0) {
      handleRemoveDraftItem(itemId);
      return;
    }

    const handledPending = updatePendingDraftAddByItemId(activeDraft.id, itemId, (entry) => {
      return {
        ...entry,
        quantity: Math.max(1, targetQty),
      };
    });
    if (handledPending) {
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
    if (isDraftLifecycleLocked(activeDraft.id)) {
      showNotification('Esta venda está em processamento e não pode mais ser editada.');
      return;
    }
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
    const hasPendingLocalAdds =
      countVisiblePendingDraftAdds(pendingDraftAddsRef.current[draftId] || []) > 0;
    if (!hasServerDraft) {
      const nextPendingByDraft = { ...pendingDraftAddsRef.current };
      delete nextPendingByDraft[draftId];
      replacePendingDraftAdds(nextPendingByDraft);
      clearRecoveryPendingDraftAddsForDraft(draftId);
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
      clearRecoveryPendingDraftAddsForDraft(draftId);
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

        if (countVisiblePendingDraftAdds(pendingDraftAddsRef.current[draftId] || []) > 0) {
          const nextPendingByDraft = { ...pendingDraftAddsRef.current };
          delete nextPendingByDraft[draftId];
          replacePendingDraftAdds(nextPendingByDraft);
        }
        clearRecoveryPendingDraftAddsForDraft(draftId);

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

    const pendingLocalItems = (pendingDraftAddsRef.current[activeDraft.id] || []).filter((entry) =>
      isPendingDraftAddVisible(entry)
    );
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

  const updatePendingDraftAddInSource = useCallback(
    (
      draftId: string,
      source: PendingDraftAddsSource,
      matcher: (entry: PendingDraftAdd) => boolean,
      updater: (entry: PendingDraftAdd) => PendingDraftAdd,
      options: {
        deferVisiblePersistence?: boolean;
        skipVisibleStateSync?: boolean;
        skipVisibleQueueHealthLog?: boolean;
      } = {}
    ): boolean => {
      if (source === 'recovery') {
        const currentEntries = recoveryPendingDraftAddsRef.current[draftId] || [];
        let changed = false;
        const nextEntries = currentEntries.map((entry) => {
          if (!matcher(entry)) return entry;
          changed = true;
          return updater(entry);
        });
        if (!changed) return false;
        const nextRecoveryByDraft = { ...recoveryPendingDraftAddsRef.current };
        nextRecoveryByDraft[draftId] = nextEntries;
        recoveryPendingDraftAddsRef.current = nextRecoveryByDraft;
        return true;
      }

      const currentEntries = pendingDraftAddsRef.current[draftId] || [];
      let changed = false;
      const nextEntries = currentEntries.map((entry) => {
        if (!matcher(entry)) return entry;
        changed = true;
        return updater(entry);
      });
      if (!changed) return false;
      const nextPendingByDraft = { ...pendingDraftAddsRef.current };
      nextPendingByDraft[draftId] = nextEntries;
      if (options.deferVisiblePersistence) {
        pendingDraftAddsRef.current = nextPendingByDraft;
        if (!options.skipVisibleStateSync) {
          setPendingDraftAddsByDraft(nextPendingByDraft);
        }
        pendingDraftAddsRevisionRef.current += 1;
        if (!options.skipVisibleQueueHealthLog) {
          logQueueHealth('pending-draft-adds');
        }
        isPendingDraftAddsHydratedRef.current = true;
        return true;
      }
      replacePendingDraftAdds(nextPendingByDraft);
      return true;
    },
    [logQueueHealth, replacePendingDraftAdds]
  );

  const collectRestoreBlockedPendingSemanticKeysForDraft = useCallback((draftId: string): Set<string> => {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) return new Set<string>();

    const keys = new Set<string>();
    const collectFrom = (entries: PendingDraftAdd[]) => {
      entries.forEach((entry) => {
        if (!shouldBlockPendingDraftAddRestore(entry)) return;
        keys.add(buildPendingDraftAddSemanticKeyFromEntry(entry));
      });
    };
    collectFrom(pendingDraftAddsRef.current[normalizedDraftId] || []);
    collectFrom(recoveryPendingDraftAddsRef.current[normalizedDraftId] || []);
    return keys;
  }, []);

  const reconcileCancelledPendingDraftAddIntent = useCallback(
    async (intent: PendingDraftAddCancellationIntent): Promise<boolean> => {
      const matchedItem = findServerDraftItemMatchingPendingIntent(intent);
      if (!matchedItem) {
        pushOperationalEvent(
          'COMMAND_SKIPPED_OBSOLETE',
          'Pending add cancelado não exigiu remoção remota complementar.',
          {
            draftId: intent.draftId,
            localItemId: intent.localItemId,
            commandId: intent.commandId,
            reason: 'no_matching_server_item',
          }
        );
        return true;
      }

      const currentQty = Math.max(1, Math.round(Number(matchedItem.qty) || 0));
      const nextQty = Math.max(0, currentQty - Math.max(1, Math.round(intent.quantity)));
      pushOperationalEvent('PENDING_ADD_CANCELLED', 'Aplicando remoção complementar após corrida do pending add.', {
        draftId: intent.draftId,
        localItemId: intent.localItemId,
        commandId: intent.commandId,
        backendItemId: matchedItem.id,
        previousQty: currentQty,
        targetQty: nextQty,
      });

      return runDraftItemRemoteMutation({
        draftId: intent.draftId,
        itemId: matchedItem.id,
        targetQty: nextQty,
        source: 'cancelled_pending_add',
        optimisticHide: nextQty <= 0,
        silentTerminalErrorNotification: true,
      });
    },
    [findServerDraftItemMatchingPendingIntent, pushOperationalEvent, runDraftItemRemoteMutation]
  );

  const flushPendingDraftAddsCore = useCallback(
    async (
      draftId: string,
      customerType: SaleCustomerType = 'BALCAO',
      options: {
        silentErrorNotification?: boolean;
        errorSink?: RunCommandErrorSink;
        failFastOnVersionConflict?: boolean;
        source?: PendingDraftAddsSource;
        skipSnapshotApply?: boolean;
        onLockWaitMs?: (durationMs: number) => void;
        onPhaseTiming?: (phase: PendingDraftFlushPhase, durationMs: number) => void;
        suppressOperationalEvents?: boolean;
        deferVisiblePersistence?: boolean;
        skipVisibleStateSync?: boolean;
        skipVisibleQueueHealthLog?: boolean;
      } = {}
    ): Promise<boolean> => {
      const emitFlushOperationalEvent = (
        type: OperationalEventLogEntry['type'],
        message: string,
        context?: Record<string, unknown>
      ): void => {
        if (options.suppressOperationalEvents) return;
        pushOperationalEvent(type, message, context);
      };
      const source: PendingDraftAddsSource = options.source === 'recovery' ? 'recovery' : 'visible';
      const shouldDeferVisiblePersistence =
        source === 'visible' && options.deferVisiblePersistence === true;
      let hasDeferredVisiblePersistence = false;
      const runPendingStatusUpdate = (
        matcher: (entry: PendingDraftAdd) => boolean,
        updater: (entry: PendingDraftAdd) => PendingDraftAdd
      ): boolean => {
        const persistStartedAt = performance.now();
        const changed = updatePendingDraftAddInSource(draftId, source, matcher, updater, {
          deferVisiblePersistence: shouldDeferVisiblePersistence,
          skipVisibleStateSync: options.skipVisibleStateSync,
          skipVisibleQueueHealthLog: options.skipVisibleQueueHealthLog,
        });
        if (changed && shouldDeferVisiblePersistence) {
          hasDeferredVisiblePersistence = true;
        }
        options.onPhaseTiming?.('status_persist', performance.now() - persistStartedAt);
        return changed;
      };
      const hydrateStartedAt = performance.now();
      hydratePendingDraftAdds();
      options.onPhaseTiming?.('hydrate', performance.now() - hydrateStartedAt);
      const snapshotPrepareStartedAt = performance.now();
      const productById = new Map<string, Product>(
        products.map((entry): [string, Product] => [entry.id, entry])
      );
      const ingredientIdSet = new Set<string>(ingredients.map((ingredient) => ingredient.id));
      options.onPhaseTiming?.('snapshot_prepare', performance.now() - snapshotPrepareStartedAt);
      try {
        const hasServerDraft = saleDraftsRef.current.some((draft) => draft.id === draftId);
        if (!hasServerDraft) {
          const createDraftStartedAt = performance.now();
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
          options.onPhaseTiming?.('create_draft', performance.now() - createDraftStartedAt);
          if (!created) return false;
        }

        while (true) {
        const loopReadStartedAt = performance.now();
        const currentPendingAdds =
          source === 'recovery'
            ? recoveryPendingDraftAddsRef.current[draftId] || []
            : pendingDraftAddsRef.current[draftId] || [];
        if (currentPendingAdds.length === 0) {
          options.onPhaseTiming?.('loop_read', performance.now() - loopReadStartedAt);
          return true;
        }

        const current = currentPendingAdds.find((entry) => isPendingDraftAddExecutable(entry));
        options.onPhaseTiming?.('loop_read', performance.now() - loopReadStartedAt);
        if (!current) {
          const staleInFlight = currentPendingAdds.find((entry) =>
            isPendingDraftAddInFlightStale(entry)
          );
          if (staleInFlight) {
            const staleRuntimeKey = buildPendingDraftAddRuntimeKey(
              draftId,
              staleInFlight.localItemId
            );
            const staleCancelIntent = pendingDraftAddCancellationIntentsRef.current.get(staleRuntimeKey);
            emitFlushOperationalEvent(
              'QUEUE_HEALTH',
              'Pending add IN_FLIGHT stale detectado; reexecução automática bloqueada.',
              {
                draftId,
                localItemId: staleInFlight.localItemId,
                commandId: staleInFlight.commandId,
                source,
                staleTimeoutMs: PENDING_DRAFT_ADD_IN_FLIGHT_STALE_MS,
                blockedReexecution: true,
              }
            );

            if (staleCancelIntent && staleCancelIntent.commandId === staleInFlight.commandId) {
              const reconciled = await reconcileCancelledPendingDraftAddIntent(staleCancelIntent);
              pendingDraftAddCancellationIntentsRef.current.delete(staleRuntimeKey);
              runPendingStatusUpdate(
                (entry) =>
                  entry.localItemId === staleInFlight.localItemId &&
                  entry.commandId === staleInFlight.commandId,
                (entry) =>
                  withPendingDraftAddStatus(
                    {
                      ...entry,
                      terminalReason: reconciled
                        ? 'stale_in_flight_cancelled_reconciled'
                        : 'stale_in_flight_cancelled_reconcile_failed',
                    },
                    reconciled ? 'RECONCILED' : 'FAILED_TERMINAL',
                    reconciled
                      ? 'stale_in_flight_cancelled_reconciled'
                      : 'stale_in_flight_cancelled_reconcile_failed'
                  )
              );
              emitFlushOperationalEvent(
                reconciled ? 'PENDING_ADD_CANCELLED' : 'COMMAND_SKIPPED_OBSOLETE',
                reconciled
                  ? 'Pending add IN_FLIGHT stale reconciliado sem reexecução.'
                  : 'Pending add IN_FLIGHT stale falhou na reconciliação e foi terminalizado.',
                {
                  draftId,
                  localItemId: staleInFlight.localItemId,
                  commandId: staleInFlight.commandId,
                  source,
                }
              );
              continue;
            }

            runPendingStatusUpdate(
              (entry) =>
                entry.localItemId === staleInFlight.localItemId &&
                entry.commandId === staleInFlight.commandId,
              (entry) =>
                withPendingDraftAddStatus(
                  {
                    ...entry,
                    terminalReason: 'stale_in_flight_without_cancel_intent',
                  },
                  'FAILED_TERMINAL',
                  'stale_in_flight_without_cancel_intent'
                )
            );
            emitFlushOperationalEvent(
              'COMMAND_SKIPPED_OBSOLETE',
              'Pending add IN_FLIGHT stale descartado sem retorno a ACTIVE.',
              {
                draftId,
                localItemId: staleInFlight.localItemId,
                commandId: staleInFlight.commandId,
                source,
              }
            );
            continue;
          }
          return true;
        }

        const currentRuntimeKey = buildPendingDraftAddRuntimeKey(draftId, current.localItemId);
        const cancelledBeforeSend = pendingDraftAddCancellationIntentsRef.current.get(
          currentRuntimeKey
        );
        if (cancelledBeforeSend && cancelledBeforeSend.commandId === current.commandId) {
          runPendingStatusUpdate(
            (entry) =>
              entry.localItemId === current.localItemId && entry.commandId === current.commandId,
            (entry) => withPendingDraftAddStatus(entry, 'CANCELLED', 'cancelled_before_send')
          );
          pendingDraftAddCancellationIntentsRef.current.delete(currentRuntimeKey);
          emitFlushOperationalEvent(
            'COMMAND_SKIPPED_OBSOLETE',
            'Pending add descartado antes do envio por remoção local.',
            {
              draftId,
              localItemId: current.localItemId,
              commandId: current.commandId,
              source,
            }
          );
          continue;
        }

        const product = productById.get(current.productId) || null;
        const recipePrepareStartedAt = performance.now();
        const recipeValidation = validateDraftItemRecipe(
          product,
          current.recipeOverride ?? product?.recipe,
          ingredientIdSet
        );
        options.onPhaseTiming?.('snapshot_prepare', performance.now() - recipePrepareStartedAt);
        if (recipeValidation.ok === false) {
          runPendingStatusUpdate(
            (entry) =>
              entry.localItemId === current.localItemId && entry.commandId === current.commandId,
            (entry) =>
              withPendingDraftAddStatus(
                {
                  ...entry,
                  terminalReason: 'invalid_recipe',
                },
                'FAILED_TERMINAL',
                'invalid_recipe'
              )
          );
          emitFlushOperationalEvent(
            'COMMAND_SKIPPED_OBSOLETE',
            'Pending add marcado como terminal por receita inválida.',
            {
              draftId,
              localItemId: current.localItemId,
              commandId: current.commandId,
              source,
              reason: 'invalid_recipe',
            }
          );
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

        runPendingStatusUpdate(
          (entry) =>
            entry.localItemId === current.localItemId && entry.commandId === current.commandId,
          (entry) => withPendingDraftAddStatus(entry, 'IN_FLIGHT')
        );
        emitFlushOperationalEvent('QUEUE_HEALTH', 'Pending add entrou em execução (IN_FLIGHT).', {
          draftId,
          localItemId: current.localItemId,
          commandId: current.commandId,
          source,
        });

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

        pendingDraftAddsInFlightRef.current.set(currentRuntimeKey, current);
        let ok = false;
        const runCommandStartedAt = performance.now();
        try {
          ok = await runCommandWithSync(syncCommand, undefined, {
            silentSuccessNotification: true,
            silentErrorNotification: options.silentErrorNotification,
            errorSink: options.errorSink,
            trackPendingState: false,
            failFastOnVersionConflict: options.failFastOnVersionConflict,
            skipSnapshotApply: options.skipSnapshotApply,
            bypassGlobalCommandQueue: options.skipSnapshotApply === true,
          });
        } finally {
          options.onPhaseTiming?.('run_command', performance.now() - runCommandStartedAt);
          const inFlight = pendingDraftAddsInFlightRef.current.get(currentRuntimeKey);
          if (
            inFlight &&
            inFlight.commandId === current.commandId &&
            inFlight.localItemId === current.localItemId
          ) {
            pendingDraftAddsInFlightRef.current.delete(currentRuntimeKey);
          }
        }
        if (!ok) {
          const shouldReturnToActive = !isDraftLifecycleLocked(draftId);
          runPendingStatusUpdate(
            (entry) =>
              entry.localItemId === current.localItemId && entry.commandId === current.commandId,
            (entry) =>
              shouldReturnToActive
                ? withPendingDraftAddStatus(entry, 'ACTIVE')
                : withPendingDraftAddStatus(
                    {
                      ...entry,
                      terminalReason: 'failed_while_draft_locked',
                    },
                    'FAILED_TERMINAL',
                    'failed_while_draft_locked'
                  )
          );
          if (!shouldReturnToActive) {
            emitFlushOperationalEvent(
              'COMMAND_SKIPPED_OBSOLETE',
              'Pending add falhou com draft travado e foi terminalizado sem reexecução.',
              {
                draftId,
                localItemId: current.localItemId,
                commandId: current.commandId,
                source,
              }
            );
          }
          return false;
        }

        const cancelledDuringSync = pendingDraftAddCancellationIntentsRef.current.get(
          currentRuntimeKey
        );
        if (cancelledDuringSync && cancelledDuringSync.commandId === current.commandId) {
          const reconciled = await reconcileCancelledPendingDraftAddIntent(cancelledDuringSync);
          pendingDraftAddCancellationIntentsRef.current.delete(currentRuntimeKey);
          runPendingStatusUpdate(
            (entry) =>
              entry.localItemId === current.localItemId && entry.commandId === current.commandId,
            (entry) =>
              withPendingDraftAddStatus(
                {
                  ...entry,
                  terminalReason: reconciled
                    ? 'cancelled_reconciled'
                    : 'cancelled_reconcile_failed',
                },
                reconciled ? 'RECONCILED' : 'FAILED_TERMINAL',
                reconciled ? 'cancelled_reconciled' : 'cancelled_reconcile_failed'
              )
          );
          emitFlushOperationalEvent(
            reconciled ? 'PENDING_ADD_CANCELLED' : 'COMMAND_SKIPPED_OBSOLETE',
            reconciled
              ? 'Pending add reconciliado e finalizado.'
              : 'Pending add falhou ao reconciliar e foi terminalizado.',
            {
              draftId,
              localItemId: current.localItemId,
              commandId: current.commandId,
              source,
            }
          );
          continue;
        }

        runPendingStatusUpdate(
          (entry) =>
            entry.localItemId === current.localItemId && entry.commandId === current.commandId,
          (entry) => withPendingDraftAddStatus(entry, 'APPLIED')
        );
          emitFlushOperationalEvent('QUEUE_HEALTH', 'Pending add aplicado com sucesso.', {
            draftId,
            localItemId: current.localItemId,
            commandId: current.commandId,
            source,
          });
        }
      } finally {
        if (hasDeferredVisiblePersistence) {
          const persistStartedAt = performance.now();
          replacePendingDraftAdds(pendingDraftAddsRef.current);
          options.onPhaseTiming?.('status_persist', performance.now() - persistStartedAt);
        }
      }
    },
    [
      findServerDraftItemMatchingPendingIntent,
      hydratePendingDraftAdds,
      ingredients,
      isDraftLifecycleLocked,
      products,
      reconcileCancelledPendingDraftAddIntent,
      updatePendingDraftAddInSource,
      runCommandWithSync,
      showNotification,
      pushOperationalEvent,
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
        source?: PendingDraftAddsSource;
        skipSnapshotApply?: boolean;
        onLockWaitMs?: (durationMs: number) => void;
        onPhaseTiming?: (phase: PendingDraftFlushPhase, durationMs: number) => void;
        suppressOperationalEvents?: boolean;
        deferVisiblePersistence?: boolean;
        skipVisibleStateSync?: boolean;
        skipVisibleQueueHealthLog?: boolean;
      } = {}
    ): Promise<boolean> => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) {
        return false;
      }

      const queue = pendingDraftFlushQueueRef.current;
      const previous = queue.get(normalizedDraftId) ?? Promise.resolve(true);
      const queuedAt = performance.now();
      const execute = () => {
        options.onLockWaitMs?.(Math.max(0, performance.now() - queuedAt));
        return flushPendingDraftAddsCore(normalizedDraftId, customerType, options);
      };
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
      if (isDraftLifecycleLocked(normalizedDraftId)) {
        pushOperationalEvent(
          'COMMAND_SKIPPED_OBSOLETE',
          'Background sync ignorado porque o draft está em lock terminal.',
          {
            draftId: normalizedDraftId,
            stage: resolveDraftLifecycleStage(normalizedDraftId),
          }
        );
        return;
      }

      const draftEntries = pendingDraftAddsRef.current[normalizedDraftId] || [];
      if (!hasPendingDraftAddBackgroundSyncWork(draftEntries)) {
        pendingDraftBackgroundRetryAttemptsRef.current.delete(normalizedDraftId);
        return;
      }
      const pendingEntries = draftEntries.filter((entry) => isPendingDraftAddExecutable(entry));

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
      isDraftLifecycleLocked,
      isAccessVerified,
      isStateHydrating,
      pushOperationalEvent,
      resolveDraftLifecycleStage,
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
      if (!hasPendingDraftAddBackgroundSyncWork(pendingEntries)) return;

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
    [isAccessVerified, isDraftLifecycleLocked, isStateHydrating, runPendingDraftBackgroundSync]
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
      if (!Array.isArray(entries) || countVisiblePendingDraftAdds(entries) === 0) return;
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
        if (!Array.isArray(entries) || countVisiblePendingDraftAdds(entries) === 0) return;
        if (isDraftLifecycleLocked(draftId)) return;
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
  }, [isAccessVerified, isDraftLifecycleLocked, isStateHydrating, schedulePendingDraftBackgroundSync]);

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
      skipSnapshotApplyOnTerminalFlow?: boolean;
      onSnapshotAppliedMs?: (durationMs: number) => void;
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
    const shouldSkipFinalizeSnapshotApply =
      options.skipSnapshotApplyOnTerminalFlow === true && !isAppSaleOrigin(snapshotSaleOrigin);
    const shouldBypassFinalizeGlobalQueue = options.skipSnapshotApplyOnTerminalFlow === true;
    const draftEpochAtFinalizeStart = getDraftOperationEpoch(draft.id);

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
          skipOfflineQueue: shouldBypassFinalizeGlobalQueue,
          silentSuccessNotification: true,
          silentErrorNotification: options.silentErrorNotification,
          errorSink: options.errorSink,
          trackPendingState: options.trackPendingState,
          failFastOnVersionConflict: options.failFastOnVersionConflict,
          skipObsoleteCheck: shouldBypassFinalizeGlobalQueue,
          skipSnapshotApply: shouldSkipFinalizeSnapshotApply,
          bypassGlobalCommandQueue: shouldBypassFinalizeGlobalQueue,
          onSnapshotAppliedMs: options.onSnapshotAppliedMs,
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
        const queuedAsyncJob = await enqueueStateCommandAsyncControlled(asyncFinalizeCommand);
        asyncJobId = queuedAsyncJob.id;
      } catch (error) {
        const statusCode = error instanceof StateCommandSyncError ? error.statusCode : undefined;
        const shouldFallbackToSync =
          statusCode === 404 || statusCode === 405 || statusCode === 422 || statusCode === 501;

        if (shouldFallbackToSync) {
          return runCommandWithSync(asyncFinalizeCommand, undefined, {
            skipOfflineQueue: shouldBypassFinalizeGlobalQueue,
            silentSuccessNotification: true,
            silentErrorNotification: options.silentErrorNotification,
            errorSink: options.errorSink,
            trackPendingState: options.trackPendingState,
            failFastOnVersionConflict: options.failFastOnVersionConflict,
            skipObsoleteCheck: shouldBypassFinalizeGlobalQueue,
            skipSnapshotApply: shouldSkipFinalizeSnapshotApply,
            bypassGlobalCommandQueue: shouldBypassFinalizeGlobalQueue,
            onSnapshotAppliedMs: options.onSnapshotAppliedMs,
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
        terminalStatus = await waitForAsyncCommandJobTerminalStatus(
          asyncJobId,
          (queuedJobId) => getStateCommandAsyncJobControlled(queuedJobId, draft.id)
        );
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
        const refreshedState = await fetchStateSnapshotControlled(draft.id);
        applyStateSnapshotIfDraftEpochCurrent(
          refreshedState,
          draft.id,
          draftEpochAtFinalizeStart,
          'finalize_async_refresh'
        );
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
      if (!normalizedJob) return false;

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
        setDraftLifecycleStage(normalizedJob.draftId, 'FINALIZING', {
          reason: 'pending_paid_job_replaced',
          bumpEpoch: false,
        });
        setDraftSyncInProgress(normalizedJob.draftId, true);
        return true;
      }

      const ingressBlockedMs = Math.max(
        0,
        pendingPaidSyncIngressBlockedUntilRef.current - Date.now()
      );
      if (ingressBlockedMs > 0) {
        showNotification(
          `Fila de sincronização ocupada. Aguarde ${Math.ceil(ingressBlockedMs / 1000)}s e tente novamente.`
        );
        return false;
      }

      if (pendingPaidSyncQueueRef.current.length >= PENDING_PAID_SYNC_QUEUE_MAX_SIZE) {
        activatePendingPaidSyncIngressBackpressure(pendingPaidSyncQueueRef.current.length);
        showNotification(
          'Fila de sincronização no limite. Novos envios foram pausados temporariamente.'
        );
        return false;
      }

      replacePendingPaidSyncQueue([...pendingPaidSyncQueueRef.current, normalizedJob]);
      setDraftLifecycleStage(normalizedJob.draftId, 'FINALIZING', {
        reason: 'pending_paid_job_enqueued',
        bumpEpoch: false,
      });
      setDraftSyncInProgress(normalizedJob.draftId, true);
      return true;
    },
    [
      activatePendingPaidSyncIngressBackpressure,
      hydratePendingPaidSyncQueue,
      replacePendingPaidSyncQueue,
      setDraftLifecycleStage,
      setDraftSyncInProgress,
      showNotification,
    ]
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
        target?: PendingDraftAddsSource;
      } = {}
    ): boolean => {
      hydratePendingDraftAdds();

      const normalizedDraftId = job.draftId.trim();
      if (!normalizedDraftId) return false;

      const snapshotItems = Array.isArray(job.snapshot.draft.items)
        ? job.snapshot.draft.items
        : [];
      if (snapshotItems.length === 0) return false;

      const restoreBlockedKeys = collectRestoreBlockedPendingSemanticKeysForDraft(normalizedDraftId);

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
          const semanticKey = buildPendingDraftAddSemanticKey({
            draftId: normalizedDraftId,
            productId,
            recipeSignature: normalizeRecipeSignature(recipeOverride),
            noteNormalized: normalizeDraftItemNoteForMatch(
              typeof item.note === 'string' ? item.note : undefined
            ),
          });
          if (restoreBlockedKeys.has(semanticKey)) {
            pushOperationalEvent(
              'COMMAND_SKIPPED_OBSOLETE',
              'Restore de pending add bloqueado por terminalidade prévia.',
              {
                draftId: normalizedDraftId,
                productId,
                semanticKey,
                trigger: options.trigger || 'unknown',
              }
            );
            return null;
          }
          const unitPriceRaw = Number(item.unitPriceSnapshot);
          const priceOverride =
            Number.isFinite(unitPriceRaw) && unitPriceRaw >= 0
              ? roundMoney(unitPriceRaw)
              : undefined;
          const note = typeof item.note === 'string' && item.note.trim() ? item.note.trim() : undefined;
          const nowIso = new Date().toISOString();

          const rebuiltEntry: PendingDraftAdd = {
            draftId: normalizedDraftId,
            localItemId: createClientId('draft-item-local'),
            commandId: createClientId('cmd'),
            productId,
            quantity,
            queuedAt: nowIso,
            updatedAt: nowIso,
            status: 'ACTIVE',
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

      const target: PendingDraftAddsSource = 'recovery';
      const nextRecoveryByDraft: PendingDraftAddsByDraftId = {
        ...recoveryPendingDraftAddsRef.current,
        [normalizedDraftId]: rebuiltPendingAdds,
      };
      recoveryPendingDraftAddsRef.current = nextRecoveryByDraft;
      reportErrorMonitorEvent({
        source: 'sistema:paid-sync:recovery-buffer-restored',
        level: 'warn',
        message: 'Pedido reconstruído em buffer interno para auto-recuperação da fila.',
        statusCode: options.statusCode,
        context: {
          trigger: options.trigger || 'unknown',
          target,
          draftId: normalizedDraftId,
          jobId: job.id,
          rebuiltItems: rebuiltPendingAdds.length,
          failedAttempts: job.attempts,
          lastError: options.failureMessage || job.lastError || null,
        },
      });
      return true;
    },
    [
      collectRestoreBlockedPendingSemanticKeysForDraft,
      hydratePendingDraftAdds,
      pushOperationalEvent,
    ]
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
      const recoveryEpoch = getDraftOperationEpoch(normalizedDraftId);

      const localServerDraft = saleDraftsRef.current.find((draft) => draft.id === normalizedDraftId);
      const recoverySource: PendingDraftAddsSource = 'recovery';
      if (
        localServerDraft &&
        (localServerDraft.status === 'PAID' || localServerDraft.status === 'CANCELLED')
      ) {
        clearRecoveryPendingDraftAddsForDraft(normalizedDraftId);
        return { ok: true, reconciledOnServer: true };
      }

      const localPending = recoveryPendingDraftAddsRef.current[normalizedDraftId] || [];
      const hasExecutableLocalPending = localPending.some((entry) => isPendingDraftAddExecutable(entry));
      if (localPending.length > 0 && !hasExecutableLocalPending) {
        clearRecoveryPendingDraftAddsForDraft(normalizedDraftId);
        pushOperationalEvent(
          'QUEUE_HEALTH',
          'Buffer de recovery sem itens executáveis foi limpo antes de nova reconstrução.',
          {
            draftId: normalizedDraftId,
            jobId: job.id,
            trigger: options.trigger || 'unknown',
            attempts: job.attempts,
          }
        );
      }

      const recoveryPendingAfterCleanup = recoveryPendingDraftAddsRef.current[normalizedDraftId] || [];
      if (recoveryPendingAfterCleanup.length === 0) {
        const restored = restorePendingDraftAddsFromSnapshot(job, {
          ...options,
          target: recoverySource,
        });
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
        source: recoverySource,
        skipSnapshotApply: true,
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
        refreshedState = await fetchStateSnapshotControlled(normalizedDraftId);
      } catch (error) {
        return {
          ok: false,
          retryable: true,
          message: getStateSyncErrorMessage(error),
          statusCode: error instanceof StateCommandSyncError ? error.statusCode : undefined,
        };
      }

      const appliedRecoveredSnapshot = applyStateSnapshotIfDraftEpochCurrent(
        refreshedState,
        normalizedDraftId,
        recoveryEpoch,
        'recover_pending_paid_sync_draft'
      );
      if (!appliedRecoveredSnapshot) {
        return {
          ok: false,
          retryable: true,
          message: 'Resultado de recovery obsoleto; aguardando operação mais nova.',
          statusCode: 409,
        };
      }
      const refreshedDraft = refreshedState.saleDrafts.find((draft) => draft.id === normalizedDraftId);
      if (!refreshedDraft) {
        return {
          ok: false,
          retryable: true,
          message: 'Draft não encontrado no servidor após recuperação.',
        };
      }

      if (refreshedDraft.status === 'PAID' || refreshedDraft.status === 'CANCELLED') {
        clearRecoveryPendingDraftAddsForDraft(normalizedDraftId);
        return { ok: true, reconciledOnServer: true };
      }

      if (!Array.isArray(refreshedDraft.items) || refreshedDraft.items.length === 0) {
        const remainingRecoveryEntries = recoveryPendingDraftAddsRef.current[normalizedDraftId] || [];
        const hasExecutableRecoveryEntries = remainingRecoveryEntries.some((entry) =>
          isPendingDraftAddExecutable(entry)
        );
        const recoveryAttempt = job.attempts + 1;
        const reachedQueueEmptyRecoveryAttemptsLimit =
          options.trigger === 'queue-empty-draft' &&
          recoveryAttempt >= PENDING_PAID_SYNC_QUEUE_EMPTY_DRAFT_MAX_RECOVERY_ATTEMPTS;
        const reachedRecoveryAttemptsLimit =
          recoveryAttempt >= PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_MAX_ATTEMPTS;
        if (
          !hasExecutableRecoveryEntries ||
          reachedQueueEmptyRecoveryAttemptsLimit ||
          reachedRecoveryAttemptsLimit
        ) {
          clearRecoveryPendingDraftAddsForDraft(normalizedDraftId);
          return {
            ok: false,
            retryable: false,
            message: reachedRecoveryAttemptsLimit
              ? 'Draft permaneceu vazio após limite de recuperação automática.'
              : reachedQueueEmptyRecoveryAttemptsLimit
                ? 'Draft permaneceu vazio após duas tentativas automáticas no fluxo principal.'
                : 'Draft vazio sem itens executáveis para recuperação automática.',
            statusCode: 422,
          };
        }
        return {
          ok: false,
          retryable: true,
          message: 'Draft ainda está vazio no servidor após recuperação automática.',
          statusCode: 422,
        };
      }

      clearRecoveryPendingDraftAddsForDraft(normalizedDraftId);
      return { ok: true, reconciledOnServer: false };
    },
    [
      applyStateSnapshotIfDraftEpochCurrent,
      clearRecoveryPendingDraftAddsForDraft,
      fetchStateSnapshotControlled,
      flushPendingDraftAdds,
      getDraftOperationEpoch,
      hydratePendingDraftAdds,
      pushOperationalEvent,
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
        completePaymentFlowTelemetry(failedJob.draftId, {
          retries: failedJob.attempts,
          hadReconciliation: true,
        });
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
        completePaymentFlowTelemetry(failedJob.draftId, {
          retries: failedJob.attempts,
          hadRecovery: true,
          hadReconciliation: true,
        });
        showCornerSync('success', 'Pedido já estava resolvido no servidor.', 1800);
        if (!options.silentNotification) {
          showNotification('Pedido já estava resolvido no servidor. Item removido da fila.');
        }
        return true;
      }

      const shouldRequeueAfterRestore = options.requeueAfterRestore !== false;
      if (shouldRequeueAfterRestore) {
        markPaymentFlowTelemetryProgress(failedJob.draftId, {
          retries: failedJob.attempts,
          hadRecovery: true,
        });
        const requeued = enqueuePendingPaidSyncJob({
          ...failedJob,
          finalizeCommandId: createClientId('cmd'),
          confirmCommandId: createClientId('cmd'),
          attempts: 0,
          nextAttemptAt: undefined,
          lastError: undefined,
        });
        if (!requeued) {
          replaceFailedPaidSyncQueue([failedJob, ...failedPaidSyncQueueRef.current]);
          showCornerSync('error', 'Pedido recuperado, mas falhou ao reenfileirar agora.', 2600);
          if (!options.silentNotification) {
            showNotification('Pedido recuperado, mas o reenvio falhou. Ele voltou para a fila de falhas.');
          }
          return false;
        }
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
      completePaymentFlowTelemetry,
      markPaymentFlowTelemetryProgress,
      replaceFailedPaidSyncQueue,
      showCornerSync,
      showNotification,
    ]
  );

  const processPendingPaidSyncQueue = useCallback(async (): Promise<void> => {
    hydratePendingPaidSyncQueue();
    if (isStateHydrating) return;
    if (pendingPaidSyncActiveWorkersRef.current >= PENDING_PAID_SYNC_MAX_WORKERS) return;
    if (pendingPaidSyncQueueRef.current.length === 0) return;

    const backendBlockedMs = getBackendFailsafeRemainingMs();
    if (backendBlockedMs > 0) {
      scheduleRetryDispatchTask('pending-paid-sync-main', backendBlockedMs, () =>
        processPendingPaidSyncQueue()
      );
      return;
    }

    if (pendingPaidSyncRetryTimerRef.current !== null) {
      window.clearTimeout(pendingPaidSyncRetryTimerRef.current);
      pendingPaidSyncRetryTimerRef.current = null;
    }

    pendingPaidSyncActiveWorkersRef.current += 1;
    let currentJob: PendingPaidSyncJob | null = null;

    try {
      const nowMs = Date.now();
      const runningDraftIds = pendingPaidSyncRunningDraftIdsRef.current;
      const queueSnapshot = pendingPaidSyncQueueRef.current;
      let selectedIndex = -1;
      for (let index = 0; index < queueSnapshot.length; index += 1) {
        const candidate = queueSnapshot[index];
        if (!candidate) continue;
        if (runningDraftIds.has(candidate.draftId)) continue;
        if (!isPendingPaidSyncJobReady(candidate, nowMs)) continue;
        selectedIndex = index;
        break;
      }

      if (selectedIndex < 0) {
        const earliestRetryAtMs = queueSnapshot.reduce((earliest, job) => {
          if (runningDraftIds.has(job.draftId)) return earliest;
          const retryAtMs = getPendingPaidSyncJobNextAttemptAtMs(job);
          if (!Number.isFinite(retryAtMs) || retryAtMs <= nowMs) return earliest;
          return Math.min(earliest, retryAtMs);
        }, Number.POSITIVE_INFINITY);
        if (Number.isFinite(earliestRetryAtMs)) {
          const delayMs = Math.max(250, earliestRetryAtMs - nowMs);
          pendingPaidSyncRetryTimerRef.current = window.setTimeout(() => {
            enqueueRetryDispatchTask('pending-paid-sync-main', () => processPendingPaidSyncQueue());
          }, delayMs);
        }
        return;
      }

      currentJob = queueSnapshot[selectedIndex];
      if (!currentJob) return;
      pendingPaidSyncRunningDraftIdsRef.current.add(currentJob.draftId);
      const dequeuePersistStartedAt = performance.now();
      replacePendingPaidSyncQueue([
        ...queueSnapshot.slice(0, selectedIndex),
        ...queueSnapshot.slice(selectedIndex + 1),
      ]);
      const dequeuePersistMs = performance.now() - dequeuePersistStartedAt;
      if (
        pendingPaidSyncActiveWorkersRef.current < PENDING_PAID_SYNC_MAX_WORKERS &&
        pendingPaidSyncQueueRef.current.length > 0
      ) {
        void processPendingPaidSyncQueue();
      }

      markPaymentFlowTelemetryProcessingStarted(currentJob.draftId, currentJob.id);
      markPaymentFlowTelemetryStageDuration(
        currentJob.draftId,
        currentJob.id,
        'pPersistMs',
        dequeuePersistMs
      );
      const recordSnapshotApplyMs = (durationMs: number): void => {
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'snapshotApplyMs',
          durationMs
        );
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'pApplySnapshotMs',
          durationMs
        );
      };
      const recordStateRefreshMs = (durationMs: number): void => {
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'stateRefreshMs',
          durationMs
        );
      };
      const recordStateRefreshPhaseDuration = (
        stage:
          | 'stateRefreshEmptyDraftCheckMs'
          | 'stateRefreshAfterFlushMs'
          | 'stateRefreshBeforeFinalizeMs',
        durationMs: number
      ): void => {
        markPaymentFlowTelemetryStageDuration(currentJob.draftId, currentJob.id, stage, durationMs);
      };
      const recordRecoveryMs = (durationMs: number): void => {
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'recoveryMs',
          durationMs
        );
      };
      const recordRetryBackoffMs = (durationMs: number): void => {
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'retryBackoffMs',
          durationMs
        );
      };
      const applySnapshotForCurrentJob = (state: AppState, source: string): boolean => {
        const snapshotApplyStartedAt = performance.now();
        const applied = applyStateSnapshotIfDraftEpochCurrent(
          state,
          currentJob.draftId,
          draftProcessingEpoch,
          source
        );
        recordSnapshotApplyMs(performance.now() - snapshotApplyStartedAt);
        return applied;
      };

        let currentServerDraft = saleDraftsRef.current.find(
          (draft) => draft.id === currentJob.draftId
        );
        let hasSuccessfulStateRefreshAfterFlush = false;
        if (
          currentServerDraft &&
          (currentServerDraft.status === 'PAID' || currentServerDraft.status === 'CANCELLED')
        ) {
          setDraftLifecycleStage(
            currentJob.draftId,
            currentServerDraft.status === 'PAID' ? 'PAID' : 'CANCELLED',
            {
              reason: 'queue_head_already_terminal',
              bumpEpoch: false,
            }
          );
          completePaymentFlowTelemetry(currentJob.draftId, {
            retries: currentJob.attempts,
            hadReconciliation: true,
          });
          setDraftSyncInProgress(currentJob.draftId, false);
          cleanupDraftOperationalArtifacts(currentJob.draftId);
          clearRecoveryPendingDraftAddsForDraft(currentJob.draftId);
          return;
        }

        setDraftSyncInProgress(currentJob.draftId, true);
        setDraftLifecycleStage(currentJob.draftId, 'FINALIZING', {
          reason: 'pending_paid_processing',
          bumpEpoch: false,
        });
        const draftProcessingEpoch = getDraftOperationEpoch(currentJob.draftId);
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
          const isEmptyDraftFailure = isDraftEmptyErrorMessage(message);

          if (isEmptyDraftFailure) {
            try {
              const stateRefreshStartedAt = performance.now();
              const refreshedState = await fetchStateSnapshotControlled(currentJob.draftId);
              applySnapshotForCurrentJob(
                refreshedState,
                'pending_paid_refresh_empty_draft_terminal_check'
              );
              const stateRefreshDurationMs = performance.now() - stateRefreshStartedAt;
              recordStateRefreshMs(stateRefreshDurationMs);
              recordStateRefreshPhaseDuration(
                'stateRefreshEmptyDraftCheckMs',
                stateRefreshDurationMs
              );
            } catch {
              // best-effort refresh before deciding terminal outcome
            }

            const latestDraft = saleDraftsRef.current.find(
              (entry) => entry.id === currentJob.draftId
            );
            const isServerTerminal =
              !latestDraft || latestDraft.status === 'PAID' || latestDraft.status === 'CANCELLED';

            if (isServerTerminal) {
              setDraftLifecycleStage(
                currentJob.draftId,
                latestDraft?.status === 'CANCELLED' ? 'CANCELLED' : 'PAID',
                {
                  reason: 'queue_empty_draft_reconciled_terminal',
                  bumpEpoch: false,
                }
              );
              completePaymentFlowTelemetry(currentJob.draftId, {
                retries: currentJob.attempts,
                hadReconciliation: true,
              });
              setDraftSyncInProgress(currentJob.draftId, false);
              cleanupDraftOperationalArtifacts(currentJob.draftId);
              clearRecoveryPendingDraftAddsForDraft(currentJob.draftId);
              showCornerSync('success', 'Pedido já estava resolvido no banco.', 1800);
              return;
            }
          }

          const scheduleRecoveryRetry = (
            recoveryMessage: string,
            recoveryStatusCode?: number
          ): void => {
            recordRetryBackoffMs(PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_DELAY_MS);
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
              ...pendingPaidSyncQueueRef.current,
            ]);
            setDraftSyncInProgress(currentJob.draftId, true);
            pendingPaidSyncRetryTimerRef.current = window.setTimeout(() => {
              enqueueRetryDispatchTask('pending-paid-sync-main', () =>
                processPendingPaidSyncQueue()
              );
            }, PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_DELAY_MS);
          };

          if (isEmptyDraftFailure) {
            const recoveryAttemptNumber = currentJob.attempts + 1;
            const recoveryAttemptDisplay = Math.min(
              recoveryAttemptNumber,
              PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_MAX_ATTEMPTS
            );
            setPaidSyncAssistantActivity(
              'recovering',
              describePaidSyncAssistantMode(
                'recovering',
                `draft ${currentJob.draftId.slice(-8).toUpperCase()} (tentativa ${
                  recoveryAttemptDisplay
                }/${PENDING_PAID_SYNC_EMPTY_DRAFT_RECOVERY_MAX_ATTEMPTS})`
              ),
              {
                draftId: currentJob.draftId,
                jobId: currentJob.id,
              }
            );
            let recoveryResult: Awaited<ReturnType<typeof recoverPendingPaidSyncDraft>>;
            const recoveryStartedAt = performance.now();
            try {
              recoveryResult = await recoverPendingPaidSyncDraft(currentJob, {
                trigger: 'queue-empty-draft',
                failureMessage: message,
                statusCode,
              });
            } finally {
              recordRecoveryMs(performance.now() - recoveryStartedAt);
            }

            if (recoveryResult.ok) {
              if (recoveryResult.reconciledOnServer) {
                const recoveredServerDraft = saleDraftsRef.current.find(
                  (entry) => entry.id === currentJob.draftId
                );
                setDraftLifecycleStage(
                  currentJob.draftId,
                  recoveredServerDraft?.status === 'CANCELLED' ? 'CANCELLED' : 'PAID',
                  {
                    reason: 'recovery_reconciled_on_server',
                    bumpEpoch: false,
                  }
                );
                markPaymentFlowTelemetryProgress(currentJob.draftId, {
                  retries: currentJob.attempts + 1,
                  hadRecovery: true,
                  hadReconciliation: true,
                });
                completePaymentFlowTelemetry(currentJob.draftId, {
                  retries: currentJob.attempts + 1,
                  hadRecovery: true,
                  hadReconciliation: true,
                });
                setDraftSyncInProgress(currentJob.draftId, false);
                cleanupDraftOperationalArtifacts(currentJob.draftId);
                clearRecoveryPendingDraftAddsForDraft(currentJob.draftId);
                showCornerSync('success', 'Pedido já estava resolvido no banco.', 1800);
                return;
              }
              markPaymentFlowTelemetryProgress(currentJob.draftId, {
                retries: currentJob.attempts + 1,
                hadRecovery: true,
              });
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
              markPaymentFlowTelemetryProgress(currentJob.draftId, {
                retries: currentJob.attempts + 1,
                hadRecovery: true,
              });
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

            clearRecoveryPendingDraftAddsForDraft(currentJob.draftId);
            setDraftSyncInProgress(currentJob.draftId, false);
            cleanupDraftOperationalArtifacts(currentJob.draftId);
            setDraftLifecycleStage(currentJob.draftId, 'OPEN', {
              reason: 'queue_empty_draft_non_retryable_cleared',
              bumpEpoch: false,
            });
            pushOperationalEvent(
              'QUEUE_HEALTH',
              'Pedido órfão com carrinho vazio foi descartado automaticamente.',
              {
                draftId: currentJob.draftId,
                jobId: currentJob.id,
                attempts: currentJob.attempts,
                reason: recoveryResult.message || message,
              }
            );
            showCornerSync('success', 'Pedido inválido removido automaticamente da fila.', 2400);
            scheduleRetryDispatchTask('pending-paid-sync-main', 60, () =>
              processPendingPaidSyncQueue()
            );
            return;
          }

          if (!retryable && !isEmptyDraftFailure) {
            const failedJob: PendingPaidSyncJob = {
              ...currentJob,
              attempts: currentJob.attempts + 1,
              nextAttemptAt: undefined,
              lastError: statusCode ? `${message} (HTTP ${statusCode})` : message,
            };
            markPaymentFlowTelemetryProgress(currentJob.draftId, {
              retries: failedJob.attempts,
            });
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
            scheduleRetryDispatchTask('pending-paid-sync-main', 60, () =>
              processPendingPaidSyncQueue()
            );
            return;
          }

          const nextAttempts = currentJob.attempts + 1;
          const retryDelayMs = getPendingPaidSyncRetryDelayForMessage(nextAttempts, message);
          recordRetryBackoffMs(retryDelayMs);
          const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
          const nextFinalizeCommandId = createClientId('cmd');
          const nextConfirmCommandId = createClientId('cmd');
          const retryPolicy = isPendingPaidSyncOrderSettleRetryMessage(message)
            ? 'order_settle_short'
            : 'default';
          const failedJob: PendingPaidSyncJob = {
            ...currentJob,
            finalizeCommandId: nextFinalizeCommandId,
            confirmCommandId: nextConfirmCommandId,
            attempts: nextAttempts,
            nextAttemptAt: retryAt,
            lastError: statusCode ? `${message} (HTTP ${statusCode})` : message,
          };
          markPaymentFlowTelemetryProgress(currentJob.draftId, {
            retries: failedJob.attempts,
          });
          pushOperationalEvent(
            'QUEUE_HEALTH',
            'Pedido reagendado com novos commandIds para evitar retry preso por dedupe.',
            {
              draftId: currentJob.draftId,
              previousFinalizeCommandId: currentJob.finalizeCommandId,
              previousConfirmCommandId: currentJob.confirmCommandId,
              nextFinalizeCommandId,
              nextConfirmCommandId,
              attempts: failedJob.attempts,
              retryAt,
              retryPolicy,
            }
          );
          replacePendingPaidSyncQueue([...pendingPaidSyncQueueRef.current, failedJob]);
          setDraftSyncInProgress(currentJob.draftId, false);
          showCornerSync('syncing', 'Pedido reagendado automaticamente para nova tentativa.', 1800);
          scheduleRetryDispatchTask('pending-paid-sync-main', 180, () =>
            processPendingPaidSyncQueue()
          );
        };

        const recordFlushPhaseDuration = (
          stage:
            | 'flushLockWaitMs'
            | 'flushPendingReadMs'
            | 'flushSnapshotPrepareMs'
            | 'flushVisibleRunMs'
            | 'flushRecoveryRunMs'
            | 'flushStateRefreshMs'
            | 'flushApplySnapshotMs'
            | 'flushTerminalCleanupMs'
            | 'flushOperationalPersistMs'
            | 'flushUiReleaseMs'
            | 'flushPostReturnMs',
          durationMs: number
        ): void => {
          markPaymentFlowTelemetryStageDuration(currentJob.draftId, currentJob.id, stage, durationMs);
        };
        const recordFlushInternalPhase = (phase: PendingDraftFlushPhase, durationMs: number): void => {
          if (phase === 'loop_read') {
            recordFlushPhaseDuration('flushPendingReadMs', durationMs);
            return;
          }
          if (phase === 'status_persist') {
            recordFlushPhaseDuration('flushOperationalPersistMs', durationMs);
            return;
          }
          if (phase === 'snapshot_prepare' || phase === 'hydrate' || phase === 'create_draft') {
            recordFlushPhaseDuration('flushSnapshotPrepareMs', durationMs);
            return;
          }
        };
        const recordConfirmPhaseDuration = (
          stage:
            | 'confirmCommandInvokeMs'
            | 'confirmDraftLockWaitMs'
            | 'confirmGlobalQueueWaitMs'
            | 'confirmSchedulerWaitMs'
            | 'confirmPostCommandApplyMs'
            | 'confirmOpsMs'
            | 'confirmFailureHandlingMs',
          durationMs: number
        ): void => {
          markPaymentFlowTelemetryStageDuration(currentJob.draftId, currentJob.id, stage, durationMs);
        };
        const recordOpsEventTiming = (timing: OperationalEventTiming): void => {
          markPaymentFlowTelemetryStageDuration(
            currentJob.draftId,
            currentJob.id,
            'pOpsEventStateMs',
            timing.applyStateMs
          );
          markPaymentFlowTelemetryStageDuration(
            currentJob.draftId,
            currentJob.id,
            'pOpsEventPersistMs',
            timing.persistDispatchMs
          );
          markPaymentFlowTelemetryStageDuration(
            currentJob.draftId,
            currentJob.id,
            'pOpsEventReportMs',
            timing.reportDispatchMs
          );
        };
        const flushPendingReadStartedAt = performance.now();
        const visiblePendingEntries = pendingDraftAddsRef.current[currentJob.draftId] || [];
        const recoveryPendingEntries = recoveryPendingDraftAddsRef.current[currentJob.draftId] || [];
        const visiblePendingCount = countVisiblePendingDraftAdds(visiblePendingEntries);
        const recoveryPendingCount = countVisiblePendingDraftAdds(recoveryPendingEntries);
        recordFlushPhaseDuration('flushPendingReadMs', performance.now() - flushPendingReadStartedAt);
        const shouldFlushDraftAdds =
          !currentServerDraft ||
          currentServerDraft.status === 'DRAFT' ||
          visiblePendingCount > 0 ||
          recoveryPendingCount > 0;
        if (shouldFlushDraftAdds) {
          const flushPendingDraftAddsStartedAt = performance.now();
          try {
            const shouldFlushVisibleDraftAdds =
              !currentServerDraft || currentServerDraft.status === 'DRAFT' || visiblePendingCount > 0;
            if (shouldFlushVisibleDraftAdds) {
              const draftAddsErrorSink: RunCommandErrorSink = {};
              const flushVisibleStartedAt = performance.now();
              const flushedVisible = await flushPendingDraftAdds(
                currentJob.draftId,
                (currentJob.snapshot.draft.customerType || 'BALCAO') as SaleCustomerType,
                {
                  silentErrorNotification: true,
                  errorSink: draftAddsErrorSink,
                  failFastOnVersionConflict: false,
                  source: 'visible',
                  skipSnapshotApply: true,
                  suppressOperationalEvents: true,
                  deferVisiblePersistence: true,
                  skipVisibleStateSync: true,
                  skipVisibleQueueHealthLog: true,
                  onLockWaitMs: (durationMs) => {
                    recordFlushPhaseDuration('flushLockWaitMs', durationMs);
                  },
                  onPhaseTiming: recordFlushInternalPhase,
                }
              );
              recordFlushPhaseDuration('flushVisibleRunMs', performance.now() - flushVisibleStartedAt);
              if (!flushedVisible) {
                await markJobAsFailed('Falha ao enviar itens pendentes.', draftAddsErrorSink);
                return;
              }
            }

            if (recoveryPendingCount > 0) {
              const recoveryAddsErrorSink: RunCommandErrorSink = {};
              const flushRecoveryStartedAt = performance.now();
              const flushedRecovery = await flushPendingDraftAdds(
                currentJob.draftId,
                (currentJob.snapshot.draft.customerType || 'BALCAO') as SaleCustomerType,
                {
                  silentErrorNotification: true,
                  errorSink: recoveryAddsErrorSink,
                  failFastOnVersionConflict: false,
                  source: 'recovery',
                  skipSnapshotApply: true,
                  suppressOperationalEvents: true,
                  onLockWaitMs: (durationMs) => {
                    recordFlushPhaseDuration('flushLockWaitMs', durationMs);
                  },
                  onPhaseTiming: recordFlushInternalPhase,
                }
              );
              recordFlushPhaseDuration('flushRecoveryRunMs', performance.now() - flushRecoveryStartedAt);
              if (!flushedRecovery) {
                await markJobAsFailed('Falha ao enviar itens pendentes da recuperação.', recoveryAddsErrorSink);
                return;
              }
            }
            try {
              const stateRefreshStartedAt = performance.now();
              const refreshedStateAfterFlush = await fetchStateSnapshotControlled(currentJob.draftId);
              const flushApplySnapshotStartedAt = performance.now();
              applySnapshotForCurrentJob(
                refreshedStateAfterFlush,
                'pending_paid_refresh_after_flush'
              );
              const flushApplySnapshotDurationMs = performance.now() - flushApplySnapshotStartedAt;
              const flushStateRefreshDurationMs = performance.now() - stateRefreshStartedAt;
              recordStateRefreshMs(flushStateRefreshDurationMs);
              recordStateRefreshPhaseDuration('stateRefreshAfterFlushMs', flushStateRefreshDurationMs);
              hasSuccessfulStateRefreshAfterFlush = true;
              recordFlushPhaseDuration(
                'flushStateRefreshMs',
                Math.max(0, flushStateRefreshDurationMs - flushApplySnapshotDurationMs)
              );
              recordFlushPhaseDuration('flushApplySnapshotMs', flushApplySnapshotDurationMs);
            } catch {
              // best-effort refresh; fallback to local state below
            }
            const flushPostReturnStartedAt = performance.now();
            currentServerDraft = saleDraftsRef.current.find((entry) => entry.id === currentJob.draftId);
            if (
              currentServerDraft &&
              (currentServerDraft.status === 'PAID' || currentServerDraft.status === 'CANCELLED')
            ) {
              recordFlushPhaseDuration('flushPostReturnMs', performance.now() - flushPostReturnStartedAt);
              const flushTerminalCleanupStartedAt = performance.now();
              setDraftLifecycleStage(
                currentJob.draftId,
                currentServerDraft.status === 'PAID' ? 'PAID' : 'CANCELLED',
                {
                  reason: 'queue_after_flush_terminal',
                  bumpEpoch: false,
                }
              );
              const flushOperationalPersistStartedAt = performance.now();
              setDraftSyncInProgress(currentJob.draftId, false);
              cleanupDraftOperationalArtifacts(currentJob.draftId);
              clearRecoveryPendingDraftAddsForDraft(currentJob.draftId);
              recordFlushPhaseDuration(
                'flushOperationalPersistMs',
                performance.now() - flushOperationalPersistStartedAt
              );
              const flushUiReleaseStartedAt = performance.now();
              showCornerSync('success', 'Pedido já estava concluído no banco.', 1800);
              recordFlushPhaseDuration('flushUiReleaseMs', performance.now() - flushUiReleaseStartedAt);
              recordFlushPhaseDuration(
                'flushTerminalCleanupMs',
                performance.now() - flushTerminalCleanupStartedAt
              );
              completePaymentFlowTelemetry(currentJob.draftId, {
                retries: currentJob.attempts,
                hadReconciliation: true,
              });
              return;
            }
            recordFlushPhaseDuration('flushPostReturnMs', performance.now() - flushPostReturnStartedAt);
          } finally {
            const flushDurationMs = performance.now() - flushPendingDraftAddsStartedAt;
            markPaymentFlowTelemetryStageDuration(
              currentJob.draftId,
              currentJob.id,
              'flushPendingDraftAddsMs',
              flushDurationMs
            );
            markPaymentFlowTelemetryStageDuration(
              currentJob.draftId,
              currentJob.id,
              'pFlushMs',
              flushDurationMs
            );
          }
        }

        // Guard rail: never call FINALIZE while server draft is still empty.
        // If server is lagging/stale, force recovery path instead of producing hard 422 finalize noise.
        if (!currentServerDraft || currentServerDraft.status === 'DRAFT') {
          if (!currentServerDraft || (currentServerDraft.items || []).length === 0) {
            const shouldRunPreFinalizeStateRefresh =
              !hasSuccessfulStateRefreshAfterFlush || !currentServerDraft;
            if (shouldRunPreFinalizeStateRefresh) {
              try {
                const stateRefreshStartedAt = performance.now();
                const refreshedState = await fetchStateSnapshotControlled(currentJob.draftId);
                applySnapshotForCurrentJob(
                  refreshedState,
                  'pending_paid_refresh_before_finalize'
                );
                const stateRefreshDurationMs = performance.now() - stateRefreshStartedAt;
                recordStateRefreshMs(stateRefreshDurationMs);
                recordStateRefreshPhaseDuration(
                  'stateRefreshBeforeFinalizeMs',
                  stateRefreshDurationMs
                );
              } catch {
                // best-effort refresh; fallback to local view below
              }
            }
            currentServerDraft = saleDraftsRef.current.find((entry) => entry.id === currentJob.draftId);
          }

          if (
            currentServerDraft &&
            (currentServerDraft.status === 'PAID' || currentServerDraft.status === 'CANCELLED')
          ) {
            setDraftLifecycleStage(
              currentJob.draftId,
              currentServerDraft.status === 'PAID' ? 'PAID' : 'CANCELLED',
              {
                reason: 'queue_after_refresh_terminal',
                bumpEpoch: false,
              }
            );
            completePaymentFlowTelemetry(currentJob.draftId, {
              retries: currentJob.attempts,
              hadReconciliation: true,
            });
            setDraftSyncInProgress(currentJob.draftId, false);
            cleanupDraftOperationalArtifacts(currentJob.draftId);
            clearRecoveryPendingDraftAddsForDraft(currentJob.draftId);
            showCornerSync('success', 'Pedido já estava concluído no banco.', 1800);
            return;
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

        const buildAtomicFinalizeAndConfirmCommand = (): StateCommand => {
          const paymentSnapshot = currentJob.snapshot;
          const appOrderTotalParsed = isAppSaleOrigin(paymentSnapshot.saleOrigin)
            ? parseMoneyInput(paymentSnapshot.appOrderTotalInput)
            : null;
          const cashReceivedParsed =
            paymentSnapshot.paymentMethod === 'DINHEIRO'
              ? parseMoneyInput(paymentSnapshot.cashReceivedInput)
              : null;
          const splitPayments =
            paymentSnapshot.paymentMethod === 'DIVIDIDO'
              ? paymentSnapshot.splitCommitted
                  .map((entry, index) => ({
                    sequence:
                      Number.isFinite(Number(entry.sequence)) && Number(entry.sequence) > 0
                        ? Math.floor(Number(entry.sequence))
                        : index + 1,
                    label: entry.label?.trim() || `Parcela ${index + 1}`,
                    method: entry.method,
                    amount: roundMoney(Math.max(0, Number(entry.amount) || 0)),
                    cashReceived:
                      entry.method === 'DINHEIRO' && Number.isFinite(Number(entry.cashReceived))
                        ? roundMoney(Number(entry.cashReceived))
                        : undefined,
                  }))
                  .filter((entry) => entry.amount > 0)
              : undefined;

          return {
            type: 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID',
            draftId: currentJob.draftId,
            commandId: currentJob.finalizeCommandId || createClientId('cmd'),
            paymentMethod: paymentSnapshot.paymentMethod,
            cashReceived:
              paymentSnapshot.paymentMethod === 'DINHEIRO'
                ? (cashReceivedParsed ?? undefined)
                : undefined,
            saleOrigin: paymentSnapshot.saleOrigin,
            appOrderTotal: isAppSaleOrigin(paymentSnapshot.saleOrigin)
              ? (appOrderTotalParsed ?? undefined)
              : undefined,
            splitMode:
              paymentSnapshot.paymentMethod === 'DIVIDIDO'
                ? (paymentSnapshot.splitMode ?? undefined)
                : undefined,
            splitCount:
              paymentSnapshot.paymentMethod === 'DIVIDIDO'
                ? (paymentSnapshot.splitCount ?? undefined)
                : undefined,
            splitPayments:
              paymentSnapshot.paymentMethod === 'DIVIDIDO' ? splitPayments : undefined,
          };
        };
        const prepareAtomicCommandStartedAt = performance.now();
        if (resolveDraftLifecycleStage(currentJob.draftId) !== 'PENDING_CONFIRM') {
          setDraftLifecycleStage(currentJob.draftId, 'PENDING_CONFIRM', {
            reason: 'atomic_finalize_confirm_dispatch',
            bumpEpoch: false,
          });
        }
        const atomicFinalizeAndConfirmCommand = buildAtomicFinalizeAndConfirmCommand();
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'pPrepareMs',
          performance.now() - prepareAtomicCommandStartedAt
        );
        const backendSentOpsStartedAt = performance.now();
        const backendSentEventTiming = pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_BACKEND_SENT', {
          draftId: currentJob.draftId,
          jobId: currentJob.id,
          commandType: atomicFinalizeAndConfirmCommand.type,
          commandId: atomicFinalizeAndConfirmCommand.commandId || null,
        });
        recordOpsEventTiming(backendSentEventTiming);
        const backendSentOpsDurationMs = performance.now() - backendSentOpsStartedAt;
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'pOpsMs',
          backendSentOpsDurationMs
        );
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'pOpsBackendSentMs',
          backendSentOpsDurationMs
        );
        const atomicStartedAt = performance.now();
        try {
          const atomicErrorSink: RunCommandErrorSink = {};
          let confirmGlobalQueueMeta: GlobalQueueWaitMeta | null = null;
          const confirmCommandStartedAt = performance.now();
          const atomicallyConfirmed = await runCommandWithSync(
            atomicFinalizeAndConfirmCommand,
            undefined,
            {
              skipOfflineQueue: true,
              trackPendingState: false,
              silentSuccessNotification: true,
              silentErrorNotification: true,
              errorSink: atomicErrorSink,
              failFastOnVersionConflict: false,
              onDraftLockWaitMs: (durationMs) => {
                recordConfirmPhaseDuration('confirmDraftLockWaitMs', durationMs);
              },
              onGlobalQueueWaitMs: (durationMs) => {
                recordConfirmPhaseDuration('confirmGlobalQueueWaitMs', durationMs);
                if (durationMs >= 1200) {
                  pushOperationalEvent('BACKPRESSURE', 'Comando terminal aguardou fila global de comandos.', {
                    draftId: currentJob.draftId,
                    jobId: currentJob.id,
                    commandType: atomicFinalizeAndConfirmCommand.type,
                    commandId: atomicFinalizeAndConfirmCommand.commandId || null,
                    waitMs: Math.round(durationMs),
                    queueDepthAtEnqueue: confirmGlobalQueueMeta?.queueDepthAtEnqueue ?? null,
                    blockedByCommandType: confirmGlobalQueueMeta?.activeCommandType ?? null,
                    blockedByDraftId: confirmGlobalQueueMeta?.activeDraftId ?? null,
                    blockedByElapsedMs: confirmGlobalQueueMeta?.activeCommandElapsedMs ?? null,
                    previousCommandType:
                      confirmGlobalQueueMeta?.lastCompletedCommandType ?? null,
                    previousCommandDraftId:
                      confirmGlobalQueueMeta?.lastCompletedDraftId ?? null,
                    previousCommandDurationMs:
                      confirmGlobalQueueMeta?.lastCompletedDurationMs ?? null,
                  });
                }
              },
              onGlobalQueueMeta: (meta) => {
                confirmGlobalQueueMeta = meta;
                markPaymentFlowTelemetryStageDuration(
                  currentJob.draftId,
                  currentJob.id,
                  'confirmGlobalQueueDepthAtEnqueue',
                  meta.queueDepthAtEnqueue
                );
              },
              onBackendSchedulerWaitMs: (durationMs) => {
                recordConfirmPhaseDuration('confirmSchedulerWaitMs', durationMs);
              },
              onSnapshotAppliedMs: (durationMs) => {
                recordSnapshotApplyMs(durationMs);
                recordConfirmPhaseDuration('confirmPostCommandApplyMs', durationMs);
              },
              onStateCommandRoundtripTiming: (timing) => {
                markPaymentFlowTelemetryStageDuration(
                  currentJob.draftId,
                  currentJob.id,
                  'pRequestMs',
                  timing.requestMs
                );
                markPaymentFlowTelemetryStageDuration(
                  currentJob.draftId,
                  currentJob.id,
                  'pBackendMs',
                  timing.backendMs
                );
              },
            }
          );
          recordConfirmPhaseDuration(
            'confirmCommandInvokeMs',
            performance.now() - confirmCommandStartedAt
          );
          if (!atomicallyConfirmed) {
            const confirmFailureHandlingStartedAt = performance.now();
            try {
              await markJobAsFailed('Falha ao finalizar e confirmar pagamento.', atomicErrorSink);
            } finally {
              recordConfirmPhaseDuration(
                'confirmFailureHandlingMs',
                performance.now() - confirmFailureHandlingStartedAt
              );
            }
            return;
          }
          const backendAckOpsStartedAt = performance.now();
          const backendAckQueueHealthTiming = pushOperationalEvent(
            'QUEUE_HEALTH',
            'Fluxo principal de paid-sync executou comando atômico FINALIZE+CONFIRM.',
            {
              draftId: currentJob.draftId,
              commandId: atomicFinalizeAndConfirmCommand.commandId || null,
            }
          );
          const backendAckFlowTiming = pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_BACKEND_ACK', {
            draftId: currentJob.draftId,
            jobId: currentJob.id,
            commandType: atomicFinalizeAndConfirmCommand.type,
            commandId: atomicFinalizeAndConfirmCommand.commandId || null,
          });
          recordOpsEventTiming(backendAckQueueHealthTiming);
          recordOpsEventTiming(backendAckFlowTiming);
          const backendAckOpsDurationMs = performance.now() - backendAckOpsStartedAt;
          recordConfirmPhaseDuration('confirmOpsMs', backendAckOpsDurationMs);
          markPaymentFlowTelemetryStageDuration(
            currentJob.draftId,
            currentJob.id,
            'pOpsMs',
            backendAckOpsDurationMs
          );
          markPaymentFlowTelemetryStageDuration(
            currentJob.draftId,
            currentJob.id,
            'pOpsBackendAckMs',
            backendAckOpsDurationMs
          );
        } finally {
          markPaymentFlowTelemetryStageDuration(
            currentJob.draftId,
            currentJob.id,
            'confirmMs',
            performance.now() - atomicStartedAt
          );
        }

        const frontendReconcileStartedAt = performance.now();
        const latestDraftAfterConfirm = saleDraftsRef.current.find(
          (entry) => entry.id === currentJob.draftId
        );
        if (latestDraftAfterConfirm?.status === 'PAID' || latestDraftAfterConfirm?.status === 'CANCELLED') {
          setDraftLifecycleStage(
            currentJob.draftId,
            latestDraftAfterConfirm.status === 'PAID' ? 'PAID' : 'CANCELLED',
            {
              reason: 'confirm_completed_terminal',
              bumpEpoch: false,
            }
          );
        } else {
          if (resolveDraftLifecycleStage(currentJob.draftId) !== 'PENDING_CONFIRM') {
            setDraftLifecycleStage(currentJob.draftId, 'PENDING_CONFIRM', {
              reason: 'confirm_completed_waiting_terminal_snapshot',
              bumpEpoch: false,
            });
          }
        }
        const persistAfterConfirmStartedAt = performance.now();
        setDraftSyncInProgress(currentJob.draftId, false);
        cleanupDraftOperationalArtifacts(currentJob.draftId);
        clearRecoveryPendingDraftAddsForDraft(currentJob.draftId);
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'pPersistMs',
          performance.now() - persistAfterConfirmStartedAt
        );
        showCornerSync('success', 'Banco OK', 1400);
        const reconcileDurationMs = performance.now() - frontendReconcileStartedAt;
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'frontendReconcileMs',
          reconcileDurationMs
        );
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'pReconcileMs',
          reconcileDurationMs
        );
        markPaymentFlowTelemetryStageDuration(
          currentJob.draftId,
          currentJob.id,
          'pFinalizeMs',
          performance.now() - persistAfterConfirmStartedAt
        );
        completePaymentFlowTelemetry(currentJob.draftId, {
          retries: currentJob.attempts,
        });
    } finally {
      if (currentJob) {
        pendingPaidSyncRunningDraftIdsRef.current.delete(currentJob.draftId);
      }
      pendingPaidSyncActiveWorkersRef.current = Math.max(
        0,
        pendingPaidSyncActiveWorkersRef.current - 1
      );
      if (
        pendingPaidSyncActiveWorkersRef.current === 0 &&
        pendingPaidSyncQueueRef.current.length === 0 &&
        failedPaidSyncQueueRef.current.length === 0
      ) {
        setPaidSyncAssistantState((current) => ({
          ...current,
          mode: 'idle',
          active: false,
          message: '',
          updatedAt: Date.now(),
        }));
      }
      if (pendingPaidSyncQueueRef.current.length > 0) {
        const nowMs = Date.now();
        const hasReadyUnlockedJob = pendingPaidSyncQueueRef.current.some(
          (job) =>
            !pendingPaidSyncRunningDraftIdsRef.current.has(job.draftId) &&
            isPendingPaidSyncJobReady(job, nowMs)
        );
        if (
          hasReadyUnlockedJob &&
          pendingPaidSyncActiveWorkersRef.current < PENDING_PAID_SYNC_MAX_WORKERS
        ) {
          void processPendingPaidSyncQueue();
        } else {
          scheduleRetryDispatchTask('pending-paid-sync-main', 120, () =>
            processPendingPaidSyncQueue()
          );
        }
      }
    }
  }, [
    applyStateSnapshotIfDraftEpochCurrent,
    cleanupDraftOperationalArtifacts,
    enqueueFailedPaidSyncJob,
    enqueueRetryDispatchTask,
    fetchStateSnapshotControlled,
    flushPendingDraftAdds,
    getBackendFailsafeRemainingMs,
    getDraftOperationEpoch,
    hydratePendingPaidSyncQueue,
    isRetryableSyncError,
    isStateHydrating,
    clearRecoveryPendingDraftAddsForDraft,
    replacePendingDraftAdds,
    replacePendingPaidSyncQueue,
    recoverPendingPaidSyncDraft,
    completePaymentFlowTelemetry,
    markPaymentFlowTelemetryProcessingStarted,
    markPaymentFlowTelemetryStageDuration,
    markPaymentFlowTelemetryProgress,
    resolveDraftLifecycleStage,
    runCommandWithSync,
    setDraftLifecycleStage,
    setPaidSyncAssistantActivity,
    setDraftSyncInProgress,
    scheduleRetryDispatchTask,
    showCornerSync,
    showNotification,
  ]);

  const requestPendingPaidSyncProcessing = useCallback(
    (source: string, delayMs = 0): void => {
      const safeDelayMs = Math.max(0, Math.round(delayMs));
      if (safeDelayMs === 0) {
        void processPendingPaidSyncQueue();
        enqueueRetryDispatchTask('pending-paid-sync-main', () => processPendingPaidSyncQueue());
        return;
      }
      scheduleRetryDispatchTask(
        'pending-paid-sync-main',
        safeDelayMs,
        () => processPendingPaidSyncQueue()
      );
    },
    [enqueueRetryDispatchTask, processPendingPaidSyncQueue, scheduleRetryDispatchTask]
  );

  useEffect(() => {
    if (!isAccessVerified || isStateHydrating) return;
    if (pendingPaidSyncJobs === 0) return;
    requestPendingPaidSyncProcessing('pending-paid-jobs-effect');
  }, [
    isAccessVerified,
    isStateHydrating,
    pendingPaidSyncJobs,
    requestPendingPaidSyncProcessing,
  ]);

  useEffect(() => {
    if (!isAccessVerified || isStateHydrating) return;
    if (!isPendingPaidSyncQueueHydratedRef.current) return;
    if (!ENABLE_AUTO_REENQUEUE_PENDING_PAYMENT) return;

    const knownPersistedDraftIds = new Set<string>();
    [...sales, ...globalSales, ...globalCancelledSales].forEach((entry) => {
      const saleDraftId = typeof entry.saleDraftId === 'string' ? entry.saleDraftId.trim() : '';
      if (saleDraftId) {
        knownPersistedDraftIds.add(saleDraftId);
      }
    });

    const blockedByCancellationIntentDraftIds: string[] = [];
    const draftsToAutoRequeue = saleDraftsRef.current.filter((draft) => {
      if (draft.status !== 'PENDING_PAYMENT') return false;
      if (!Array.isArray(draft.items) || draft.items.length === 0) return false;
      if (knownPersistedDraftIds.has(draft.id)) return false;
      if (syncingPaidDraftIdsRef.current.has(draft.id)) return false;
      if (pendingPaidSyncQueueRef.current.some((job) => job.draftId === draft.id)) return false;
      if (failedPaidSyncQueueRef.current.some((job) => job.draftId === draft.id)) return false;
      if (hasPendingDraftAddCancellationIntentForDraft(draft.id)) {
        blockedByCancellationIntentDraftIds.push(draft.id);
        return false;
      }
      return true;
    });

    if (blockedByCancellationIntentDraftIds.length > 0) {
      pushOperationalEvent(
        'COMMAND_SKIPPED_OBSOLETE',
        'Auto-reenqueue bloqueado por intenção de remoção pendente no draft.',
        {
          draftIds: blockedByCancellationIntentDraftIds,
        }
      );
    }

    if (draftsToAutoRequeue.length === 0) return;

    draftsToAutoRequeue.forEach((draft) => {
      const snapshot = buildAutoRequeuePaymentSnapshot(draft);
      if (!snapshot) {
        reportErrorMonitorEvent({
          source: 'sistema:paid-sync:auto-requeue-invalid-snapshot',
          level: 'warn',
          message: 'Draft voltou como PENDING_PAYMENT, mas snapshot inválido para reenfileirar.',
          context: {
            draftId: draft.id,
            paymentMethod: draft.payment.method || null,
            items: draft.items.length,
          },
        });
        return;
      }

      const requeued = enqueuePendingPaidSyncJob({
        id: createClientId('paid-sync-job'),
        draftId: draft.id,
        snapshot,
        finalizeCommandId: createClientId('cmd'),
        confirmCommandId: createClientId('cmd'),
        createdAt: new Date().toISOString(),
        attempts: 0,
      });
      if (!requeued) {
        pushOperationalEvent(
          'BACKPRESSURE',
          'Auto-reenqueue não conseguiu reenfileirar o draft por limitação de fila.',
          {
            draftId: draft.id,
          }
        );
        return;
      }
      setPaidSyncAssistantActivity(
        'retrying',
        describePaidSyncAssistantMode('retrying', `pedido ${draft.id.slice(-8).toUpperCase()} (auto)`),
        {
          draftId: draft.id,
          jobId: null,
        }
      );
      showCornerSync('syncing', 'Robô recolocou pedido que voltou do banco na fila.', 2200);
      reportErrorMonitorEvent({
        source: 'sistema:paid-sync:auto-requeue-returned-draft',
        level: 'warn',
        message: 'Draft PENDING_PAYMENT fora da fila foi reenfileirado automaticamente.',
        context: {
          draftId: draft.id,
          items: draft.items.length,
          paymentMethod: draft.payment.method,
        },
      });
    });

    requestPendingPaidSyncProcessing('auto-reenqueue');
  }, [
    hasPendingDraftAddCancellationIntentForDraft,
    enqueuePendingPaidSyncJob,
    globalCancelledSales,
    globalSales,
    isAccessVerified,
    isStateHydrating,
    pushOperationalEvent,
    requestPendingPaidSyncProcessing,
    saleDrafts,
    sales,
    setPaidSyncAssistantActivity,
    showCornerSync,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      if (pendingPaidSyncQueueRef.current.length === 0) return;
      requestPendingPaidSyncProcessing('online-event');
    };

    window.addEventListener('online', handleOnline);
    const intervalId = ENABLE_PENDING_PAID_SYNC_INTERVAL_WAKEUP
      ? window.setInterval(() => {
          if (pendingPaidSyncQueueRef.current.length === 0) return;
          requestPendingPaidSyncProcessing('interval-wakeup');
        }, 10000)
      : null;

    return () => {
      window.removeEventListener('online', handleOnline);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [requestPendingPaidSyncProcessing]);

  useEffect(() => {
    if (!isAccessVerified) return;
    if (!isConfirmingPaid) {
      paidSyncUiLockStartedAtRef.current = null;
      return;
    }
    paidSyncUiLockStartedAtRef.current = Date.now();
    const timerId = window.setTimeout(() => {
      if (!isConfirmingPaid) return;
      setIsConfirmingPaid(false);
      pushOperationalEvent(
        'PAYMENT_FLOW',
        'PAID_SYNC_UI_LOCK_RELEASED_BY_RECOVERY',
        {
          lockDurationMs: PAID_SYNC_UI_LOCK_MAX_MS,
          pendingQueue: pendingPaidSyncQueueRef.current.length,
          failedQueue: failedPaidSyncQueueRef.current.length,
          syncingDrafts: Array.from(syncingPaidDraftIdsRef.current),
        }
      );
      reportErrorMonitorEvent({
        source: 'sistema:paid-sync:ui-lock-recovery',
        level: 'warn',
        message: 'UI lock de confirmação pago liberado automaticamente por watchdog.',
        context: {
          lockDurationMs: PAID_SYNC_UI_LOCK_MAX_MS,
          pendingQueue: pendingPaidSyncQueueRef.current.length,
          failedQueue: failedPaidSyncQueueRef.current.length,
          syncingDrafts: Array.from(syncingPaidDraftIdsRef.current),
        },
      });
      showCornerSync('error', 'Tela destravada automaticamente. Continuando sincronização...', 2600);
    }, PAID_SYNC_UI_LOCK_MAX_MS);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [isAccessVerified, isConfirmingPaid, pushOperationalEvent, showCornerSync]);

  useEffect(() => {
    if (!isAccessVerified) return;
    if (typeof window === 'undefined') return;

    const emitReturnEvent = (source: 'focus' | 'visibilitychange') => {
      if (isPrintReturnFocusGuardActive()) return;
      if (document.visibilityState === 'hidden') return;
      const hasPendingMainQueue = pendingPaidSyncQueueRef.current.length > 0;
      const hasFailedQueue = failedPaidSyncQueueRef.current.length > 0;
      const hasSyncingDrafts = syncingPaidDraftIdsRef.current.size > 0;
      if (!hasPendingMainQueue && !hasFailedQueue && !hasSyncingDrafts && !isConfirmingPaid) {
        return;
      }
      pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_RETURNED_TO_MAIN', {
        source,
        pendingQueue: pendingPaidSyncQueueRef.current.length,
        failedQueue: failedPaidSyncQueueRef.current.length,
        syncingDrafts: Array.from(syncingPaidDraftIdsRef.current),
      });
      if (hasPendingMainQueue) {
        requestPendingPaidSyncProcessing('returned-to-main');
      }
    };

    const handleFocus = () => emitReturnEvent('focus');
    const handleVisibility = () => {
      if (!document.hidden) {
        emitReturnEvent('visibilitychange');
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [
    isAccessVerified,
    isConfirmingPaid,
    isPrintReturnFocusGuardActive,
    pushOperationalEvent,
    requestPendingPaidSyncProcessing,
  ]);

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
        completePaymentFlowTelemetry(failedJob.draftId, {
          retries: failedJob.attempts,
          hadReconciliation: true,
        });
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
          completePaymentFlowTelemetry(failedJob.draftId, {
            retries: failedJob.attempts,
            hadRecovery: true,
            hadReconciliation: true,
          });
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
      markPaymentFlowTelemetryProgress(failedJob.draftId, {
        retries: failedJob.attempts,
        hadRecovery: isEmptyDraftFailure,
      });
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
      requestPendingPaidSyncProcessing('failed-job-requeued');
    },
    [
      clearFailedPaidSyncAutoRetryState,
      completePaymentFlowTelemetry,
      enqueuePendingPaidSyncJob,
      hydrateFailedPaidSyncQueue,
      markPaymentFlowTelemetryProgress,
      requestPendingPaidSyncProcessing,
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
    if (failedPaidSyncQueueRef.current.length === 0) return;

    const emptyDraftFailedJobs = failedPaidSyncQueueRef.current.filter((job) =>
      isDraftEmptyErrorMessage(job.lastError || '')
    );
    if (emptyDraftFailedJobs.length === 0) return;

    let nextFailedQueue = [...failedPaidSyncQueueRef.current];
    let movedToPending = 0;
    let reconciledTerminal = 0;
    let droppedOrphan = 0;

    emptyDraftFailedJobs.forEach((job) => {
      clearFailedPaidSyncAutoRetryState(job.id);
      nextFailedQueue = nextFailedQueue.filter((entry) => entry.id !== job.id);

      const serverDraft = saleDraftsRef.current.find((draft) => draft.id === job.draftId);
      if (serverDraft && (serverDraft.status === 'PAID' || serverDraft.status === 'CANCELLED')) {
        completePaymentFlowTelemetry(job.draftId, {
          retries: job.attempts,
          hadReconciliation: true,
        });
        setDraftSyncInProgress(job.draftId, false);
        cleanupDraftOperationalArtifacts(job.draftId);
        clearRecoveryPendingDraftAddsForDraft(job.draftId);
        reconciledTerminal += 1;
        return;
      }

      const serverHasItems = Array.isArray(serverDraft?.items) && serverDraft.items.length > 0;
      const snapshotHasItems =
        Array.isArray(job.snapshot?.draft?.items) && job.snapshot.draft.items.length > 0;

      if (!snapshotHasItems && !serverHasItems) {
        setDraftSyncInProgress(job.draftId, false);
        setDraftLifecycleStage(job.draftId, 'OPEN', {
          reason: 'failed_empty_draft_orphan_cleared',
          bumpEpoch: false,
        });
        clearRecoveryPendingDraftAddsForDraft(job.draftId);
        droppedOrphan += 1;
        return;
      }

      const safeSnapshot = serverHasItems
        ? buildAutoRequeuePaymentSnapshot(serverDraft!)
        : clonePaymentCommitSnapshot(job.snapshot);
      if (!safeSnapshot) {
        setDraftSyncInProgress(job.draftId, false);
        setDraftLifecycleStage(job.draftId, 'OPEN', {
          reason: 'failed_empty_draft_invalid_snapshot_cleared',
          bumpEpoch: false,
        });
        clearRecoveryPendingDraftAddsForDraft(job.draftId);
        droppedOrphan += 1;
        return;
      }

      enqueuePendingPaidSyncJob({
        ...job,
        snapshot: safeSnapshot,
        finalizeCommandId: createClientId('cmd'),
        confirmCommandId: createClientId('cmd'),
        attempts: 0,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
      movedToPending += 1;
    });

    replaceFailedPaidSyncQueue(nextFailedQueue);

    if (movedToPending > 0) {
      requestPendingPaidSyncProcessing('failed-empty-draft-migration');
    }

    if (movedToPending > 0 || reconciledTerminal > 0 || droppedOrphan > 0) {
      pushOperationalEvent(
        'QUEUE_HEALTH',
        'Falhas antigas de carrinho vazio foram reconciliadas automaticamente.',
        {
          migratedJobs: emptyDraftFailedJobs.map((job) => ({
            id: job.id,
            draftId: job.draftId,
          })),
          movedToPending,
          reconciledTerminal,
          droppedOrphan,
        }
      );
    }
  }, [
    clearFailedPaidSyncAutoRetryState,
    clearRecoveryPendingDraftAddsForDraft,
    cleanupDraftOperationalArtifacts,
    completePaymentFlowTelemetry,
    enqueuePendingPaidSyncJob,
    failedPaidSyncQueue,
    isAccessVerified,
    pushOperationalEvent,
    replaceFailedPaidSyncQueue,
    requestPendingPaidSyncProcessing,
    saleDrafts,
    setDraftLifecycleStage,
    setDraftSyncInProgress,
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
      const isEmptyDraftFailure = isDraftEmptyErrorMessage(job.lastError || '');

      const isConfirmBeforeFinalizeFailure = isConfirmBeforeFinalizeErrorMessage(job.lastError || '');
      if (isConfirmBeforeFinalizeFailure) {
        const recoverTimer = failedPaidSyncAutoRecoverTimersRef.current.get(job.id);
        if (recoverTimer !== undefined) {
          window.clearTimeout(recoverTimer);
          failedPaidSyncAutoRecoverTimersRef.current.delete(job.id);
        }
        if (failedPaidSyncAutoRetryTimersRef.current.has(job.id)) return;

        const autoAttempts = failedPaidSyncAutoRetryAttemptsRef.current.get(job.id) || 0;
        const retryDelayMs = getPaidSyncAssistantRetryDelayMs(autoAttempts);
        const timerId = window.setTimeout(() => {
          const currentTimer = failedPaidSyncAutoRetryTimersRef.current.get(job.id);
          if (currentTimer !== timerId) return;
          failedPaidSyncAutoRetryTimersRef.current.delete(job.id);

          enqueueRetryDispatchTask(`failed-retry-confirm-before-finalize-${job.id}`, async () => {
            const latestJob = failedPaidSyncQueueRef.current.find((entry) => entry.id === job.id);
            if (!latestJob) return;

            const currentAttempts =
              failedPaidSyncAutoRetryAttemptsRef.current.get(latestJob.id) || 0;
            failedPaidSyncAutoRetryAttemptsRef.current.set(latestJob.id, currentAttempts + 1);
            setFailedPaidSyncAutoRetryRevision((current) => current + 1);
            setPaidSyncAssistantActivity(
              'retrying',
              describePaidSyncAssistantMode(
                'retrying',
                `pedido ${latestJob.draftId.slice(-8).toUpperCase()} (aguardando ordem)`
              ),
              {
                draftId: latestJob.draftId,
                jobId: latestJob.id,
              }
            );
            await handleRetryFailedPaidSyncJob(latestJob.id, { autoRetry: true });
          });
        }, retryDelayMs);
        failedPaidSyncAutoRetryTimersRef.current.set(job.id, timerId);
        return;
      }

      const autoAttempts = failedPaidSyncAutoRetryAttemptsRef.current.get(job.id) || 0;
      const recoverableError = isAutoRecoverableFailedQueueMessage(job.lastError || '');
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

          enqueueRetryDispatchTask(`failed-recover-${job.id}`, async () => {
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
          });
        }, recoveryDelayMs);

        failedPaidSyncAutoRecoverTimersRef.current.set(job.id, recoveryTimerId);
      }

      if (failedPaidSyncAutoRetryTimersRef.current.has(job.id)) return;

      const retryDelayMs = getPaidSyncAssistantRetryDelayMs(autoAttempts);
      const timerId = window.setTimeout(() => {
        const currentTimer = failedPaidSyncAutoRetryTimersRef.current.get(job.id);
        if (currentTimer !== timerId) return;
        failedPaidSyncAutoRetryTimersRef.current.delete(job.id);

        enqueueRetryDispatchTask(`failed-retry-${job.id}`, async () => {
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
          await handleRetryFailedPaidSyncJob(job.id, { autoRetry: true });
        });
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
        '_blank'
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

  const moveVisiblePendingDraftAddsToRecovery = useCallback(
    async (
      draftId: string,
      options: {
        skipCriticalPersist?: boolean;
      } = {}
    ): Promise<number> => {
      const normalizedDraftId = draftId.trim();
      if (!normalizedDraftId) return 0;

      const queue = pendingDraftFlushQueueRef.current;
      const previous = queue.get(normalizedDraftId) ?? Promise.resolve(true);
      let movedEntriesCount = 0;

      // Serialize transfer with the same per-draft queue used by flush.
      // This avoids reintroducing visible pending items from stale in-flight flush snapshots.
      const execute = async (): Promise<boolean> => {
        hydratePendingDraftAdds();

        const allEntries = pendingDraftAddsRef.current[normalizedDraftId] || [];
        const visibleEntries = allEntries.filter((entry) => isPendingDraftAddVisible(entry));
        movedEntriesCount = visibleEntries.length;
        if (visibleEntries.length === 0) return true;

        const nextRecoveryByDraft: PendingDraftAddsByDraftId = {
          ...recoveryPendingDraftAddsRef.current,
        };
        const existingRecoveryEntries = nextRecoveryByDraft[normalizedDraftId] || [];
        const mergedEntries = [...existingRecoveryEntries, ...visibleEntries];
        const dedupedEntriesByKey = new Map<string, PendingDraftAdd>();
        mergedEntries.forEach((entry) => {
          const dedupeKey = `${entry.commandId}:${entry.localItemId}`;
          dedupedEntriesByKey.set(dedupeKey, entry);
        });
        nextRecoveryByDraft[normalizedDraftId] = Array.from(dedupedEntriesByKey.values());
        recoveryPendingDraftAddsRef.current = nextRecoveryByDraft;

        const retainedLocalEntries = allEntries.filter((entry) => !isPendingDraftAddVisible(entry));
        const nextVisibleByDraft = { ...pendingDraftAddsRef.current };
        if (retainedLocalEntries.length > 0) {
          nextVisibleByDraft[normalizedDraftId] = retainedLocalEntries;
        } else {
          delete nextVisibleByDraft[normalizedDraftId];
        }
        if (options.skipCriticalPersist) {
          pendingDraftAddsRef.current = nextVisibleByDraft;
          pendingDraftAddsRevisionRef.current += 1;
          setPendingDraftAddsByDraft(nextVisibleByDraft);
          isPendingDraftAddsHydratedRef.current = true;
          void savePendingDraftAddsBackground(nextVisibleByDraft);
          logQueueHealth('pending-draft-adds');
        } else {
          replacePendingDraftAdds(nextVisibleByDraft);
        }

        return true;
      };

      const next = previous.then(execute, execute);
      queue.set(normalizedDraftId, next);

      try {
        await next;
        return movedEntriesCount;
      } finally {
        if (queue.get(normalizedDraftId) === next) {
          queue.delete(normalizedDraftId);
        }
      }
    },
    [hydratePendingDraftAdds, logQueueHealth, replacePendingDraftAdds]
  );

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
    if (isDraftLifecycleLocked(draftId)) {
      showNotification('Esta venda já está em processamento de pagamento.');
      return;
    }
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
    let preparedPrintWindow: Window | null = null;

    const pendingItemsCount = countVisiblePendingDraftAdds(pendingDraftAddsRef.current[draftId] || []);
    const paymentClickAtMs = Date.now();
    setIsConfirmingPaid(true);
    const uiLockStartedAt = Date.now();
    paidSyncUiLockStartedAtRef.current = uiLockStartedAt;
    pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_START', {
      draftId,
      paymentMethod: paymentSnapshot.paymentMethod,
      saleOrigin: paymentSnapshot.saleOrigin,
      pendingVisibleItems: pendingItemsCount,
      clickAt: new Date(paymentClickAtMs).toISOString(),
    });
    let syncQueued = false;
    try {
      setDraftSyncInProgress(draftId, true);
      const pendingBackgroundSyncTimer = pendingDraftBackgroundSyncTimerRef.current.get(draftId);
      if (pendingBackgroundSyncTimer !== undefined) {
        window.clearTimeout(pendingBackgroundSyncTimer);
        pendingDraftBackgroundSyncTimerRef.current.delete(draftId);
      }
      pendingDraftBackgroundRetryAttemptsRef.current.delete(draftId);

      const queuedJob: PendingPaidSyncJob = {
        id: createClientId('paid-sync-job'),
        draftId,
        snapshot: clonePaymentCommitSnapshot(paymentSnapshot),
        finalizeCommandId: createClientId('cmd'),
        confirmCommandId: createClientId('cmd'),
        createdAt: new Date().toISOString(),
        attempts: 0,
      };
      registerPaymentFlowTelemetryStart(draftId, queuedJob.id, paymentClickAtMs);
      pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_COMMAND_CREATED', {
        draftId,
        jobId: queuedJob.id,
        finalizeCommandId: queuedJob.finalizeCommandId,
        confirmCommandId: queuedJob.confirmCommandId,
      });

      setIsSaleOriginSetupOpen(false);
      setIsSplitSetupOpen(false);
      setIsPaymentOpen(false);
      setIsCartOpen(false);

      if (activeDraftIdRef.current === draftId) {
        activeDraftIdRef.current = null;
      }
      setActiveDraftId(null);

      const queued = enqueuePendingPaidSyncJob(queuedJob);
      if (!queued) {
        setDraftSyncInProgress(draftId, false);
        setDraftLifecycleStage(draftId, 'OPEN', {
          reason: 'pending_paid_enqueue_rejected',
          bumpEpoch: false,
        });
        if (receiptPayload) {
          removeReceiptPrintPayload(receiptPayload.id);
        }
        closePreparedReceiptWindow(preparedPrintWindow);
        return;
      }
      syncQueued = true;
      markPaymentFlowTelemetryLocalPersisted(draftId, queuedJob.id);
      showCornerSync(
        'syncing',
        pendingItemsCount > 0
          ? `Pedido em fila. Enviando ${pendingItemsCount} item(ns)...`
          : 'Pedido em fila. Confirmando no banco...'
      );
      requestPendingPaidSyncProcessing('confirm-paid-enqueued');
      // Kick off immediately in the current tab before any print navigation can block timers/event-loop.
      void processPendingPaidSyncQueue();
      if (pendingItemsCount > 0) {
        window.setTimeout(() => {
          void moveVisiblePendingDraftAddsToRecovery(draftId, { skipCriticalPersist: true }).catch((error) => {
            reportErrorMonitorEvent({
              source: 'sistema:paid-sync:move-visible-to-recovery',
              level: 'warn',
              message: 'Falha ao transferir pendencias visiveis para buffer de recovery.',
              stack: error instanceof Error ? error.stack : undefined,
              context: {
                draftId,
              },
            });
          });
        }, 0);
      }
      pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_SYNC_TRIGGERED', {
        draftId,
        jobId: queuedJob.id,
        pendingQueue: pendingPaidSyncQueueRef.current.length,
      });

      const receiptPrintId = receiptPayload?.id || draftId;
      preparedPrintWindow = prepareReceiptPrintWindow();
      if (receiptPayload && preparedPrintWindow) {
        setReceiptPrintPayloadOnWindow(preparedPrintWindow, receiptPayload);
      }
      armPrintReturnFocusGuard();
      window.setTimeout(() => {
        const openedPrintWindow = navigatePreparedReceiptWindow(preparedPrintWindow, receiptPrintId);
        if (!openedPrintWindow) {
          if (receiptPayload) {
            removeReceiptPrintPayload(receiptPayload.id);
          }
          closePreparedReceiptWindow(preparedPrintWindow);
          showNotification(
            'Não foi possível abrir o cupom agora. Use o Histórico para segunda via.'
          );
          pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_PRINT_OPEN_FAILED', {
            draftId,
            receiptPrintId,
            jobId: queuedJob.id,
          });
          return;
        }
        pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_PRINT_OPENED', {
          draftId,
          receiptPrintId,
          jobId: queuedJob.id,
        });
      }, 0);
    } catch (error) {
      reportErrorMonitorEvent({
        source: 'sistema:paid-sync:confirm-paid-unexpected-error',
        level: 'error',
        message: 'Falha inesperada ao iniciar sincronização de pagamento.',
        stack: error instanceof Error ? error.stack : undefined,
        context: {
          draftId,
          paymentMethod: paymentSnapshot.paymentMethod,
          saleOrigin: paymentSnapshot.saleOrigin,
          syncQueued,
        },
      });
      if (!syncQueued) {
        setDraftSyncInProgress(draftId, false);
        setDraftLifecycleStage(draftId, 'OPEN', {
          reason: 'pending_paid_unexpected_error',
          bumpEpoch: false,
        });
        if (receiptPayload) {
          removeReceiptPrintPayload(receiptPayload.id);
        }
        closePreparedReceiptWindow(preparedPrintWindow);
      }
      showCornerSync('error', 'Falha ao iniciar envio da venda.', 2600);
      showNotification('Erro inesperado ao confirmar pagamento. Tente novamente.');
    } finally {
      setIsConfirmingPaid(false);
      const unlockedAtMs = Date.now();
      const lockDurationMs = Math.max(0, unlockedAtMs - uiLockStartedAt);
      paidSyncUiLockStartedAtRef.current = null;
      pushOperationalEvent('PAYMENT_FLOW', 'PAID_SYNC_UI_UNLOCKED', {
        draftId,
        lockDurationMs,
        syncQueued,
        pendingQueue: pendingPaidSyncQueueRef.current.length,
        failedQueue: failedPaidSyncQueueRef.current.length,
      });
    }
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

    armPrintReturnFocusGuard();
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

    recentSalesForUndo.forEach((sale, index) => {
      const key = buildSaleOrderGroupKey(sale, index);
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
        const isEmptyDraftFailure = isDraftEmptyErrorMessage(job.lastError || '');
        const isConfirmBeforeFinalizeFailure = isConfirmBeforeFinalizeErrorMessage(
          job.lastError || ''
        );
        const recoverableError =
          !isEmptyDraftFailure &&
          !isConfirmBeforeFinalizeFailure &&
          isAutoRecoverableFailedQueueMessage(job.lastError || '');
        const shouldRecoverSoon = shouldPaidSyncAssistantRunRecovery(
          autoRetryAttempts,
          recoverableError
        );
        const assistantLabel = isEmptyDraftFailure
          ? 'Robô: recuperação automática do carrinho'
          : isConfirmBeforeFinalizeFailure
            ? 'Robô: aguardando ordem de estado'
            : shouldRecoverSoon
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
  const latestPaymentFlowTelemetry = paymentFlowTelemetryHistory[0] || null;
  const latestPaymentFlowBreakdown =
    getPaymentFlowProcessingBreakdown(latestPaymentFlowTelemetry);
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
  const resolvedRecipeByProductId = useMemo(() => {
    const synchronizedProducts = synchronizeComboProductRecipes(products);
    return new Map(synchronizedProducts.map((entry) => [entry.id, entry.recipe]));
  }, [products]);

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
            <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[8px] font-black uppercase tracking-wide text-slate-600">
              <p className="truncate">
                Sch {operationalHealthSnapshot.schedulerActive}/{operationalHealthSnapshot.schedulerQueued}{' '}
                C:{operationalHealthSnapshot.schedulerCriticalQueued} H:{operationalHealthSnapshot.schedulerHighQueued}{' '}
                N:{operationalHealthSnapshot.schedulerNormalQueued} L:{operationalHealthSnapshot.schedulerLowQueued}
              </p>
              <p className="truncate">
                D:{operationalHealthSnapshot.pendingDraftAdds} P:{operationalHealthSnapshot.pendingPaidQueue} F:{operationalHealthSnapshot.failedQueue}
              </p>
              <p className="truncate">
                BP:{operationalHealthSnapshot.schedulerBackpressureHits} DD:{operationalHealthSnapshot.schedulerDedupeHits}{' '}
                FS:{operationalHealthSnapshot.failsafeActivations} def:{operationalHealthSnapshot.failsafeDeferredCommands}
              </p>
              {latestPaymentFlowTelemetry && (
                <p className="truncate">
                  pgto local:{latestPaymentFlowTelemetry.clickToLocalPersistMs ?? '-'}ms w:{latestPaymentFlowTelemetry.waitInQueueMs ?? '-'}ms p:{latestPaymentFlowTelemetry.processingMs ?? '-'}ms conf:{latestPaymentFlowTelemetry.totalConfMs ?? latestPaymentFlowTelemetry.clickToBackendConfirmMs ?? '-'}ms r:{latestPaymentFlowTelemetry.retries}
                </p>
              )}
              {latestPaymentFlowTelemetry && (
                <p className="truncate">
                  p_flush:{latestPaymentFlowTelemetry.pFlushMs ?? '-'} p_prepare:{latestPaymentFlowTelemetry.pPrepareMs ?? '-'} p_request:{latestPaymentFlowTelemetry.pRequestMs ?? '-'} p_backend:{latestPaymentFlowTelemetry.pBackendMs ?? '-'} p_apply_snapshot:{latestPaymentFlowTelemetry.pApplySnapshotMs ?? '-'} p_reconcile:{latestPaymentFlowTelemetry.pReconcileMs ?? '-'} p_persist:{latestPaymentFlowTelemetry.pPersistMs ?? '-'} p_ops:{latestPaymentFlowTelemetry.pOpsMs ?? '-'} p_finalize:{latestPaymentFlowTelemetry.pFinalizeMs ?? '-'}
                </p>
              )}
              {latestPaymentFlowBreakdown && (
                <p className="truncate">
                  f:{latestPaymentFlowBreakdown.flushPendingDraftAddsMs} fi:{latestPaymentFlowBreakdown.finalizeMs} cf:{latestPaymentFlowBreakdown.confirmMs} sn:{latestPaymentFlowBreakdown.snapshotApplyMs} sr:{latestPaymentFlowBreakdown.stateRefreshMs} rv:{latestPaymentFlowBreakdown.recoveryMs} rb:{latestPaymentFlowBreakdown.retryBackoffMs} fr:{latestPaymentFlowBreakdown.frontendReconcileMs} oth:{latestPaymentFlowBreakdown.residualMs}
                </p>
              )}
              {latestPaymentFlowTelemetry && (
                <p className="truncate">
                  f_lock:{latestPaymentFlowTelemetry.flushLockWaitMs ?? '-'} f_read:{latestPaymentFlowTelemetry.flushPendingReadMs ?? '-'} f_snap:{latestPaymentFlowTelemetry.flushSnapshotPrepareMs ?? '-'} f_vis:{latestPaymentFlowTelemetry.flushVisibleRunMs ?? '-'} f_rec:{latestPaymentFlowTelemetry.flushRecoveryRunMs ?? '-'} f_sr:{latestPaymentFlowTelemetry.flushStateRefreshMs ?? '-'} f_sn:{latestPaymentFlowTelemetry.flushApplySnapshotMs ?? '-'} f_ps:{latestPaymentFlowTelemetry.flushOperationalPersistMs ?? '-'} f_cl:{latestPaymentFlowTelemetry.flushTerminalCleanupMs ?? '-'} f_ui:{latestPaymentFlowTelemetry.flushUiReleaseMs ?? '-'} f_post:{latestPaymentFlowTelemetry.flushPostReturnMs ?? '-'} f_oth:{latestPaymentFlowTelemetry.flushOtherMs ?? '-'}
                </p>
              )}
              {latestPaymentFlowTelemetry && (
                <p className="truncate">
                  c_cmd:{latestPaymentFlowTelemetry.confirmCommandInvokeMs ?? '-'} c_lock:{latestPaymentFlowTelemetry.confirmDraftLockWaitMs ?? '-'} c_gq:{latestPaymentFlowTelemetry.confirmGlobalQueueWaitMs ?? '-'} c_gqd:{latestPaymentFlowTelemetry.confirmGlobalQueueDepthAtEnqueue ?? '-'} c_sched:{latestPaymentFlowTelemetry.confirmSchedulerWaitMs ?? '-'} c_apply:{latestPaymentFlowTelemetry.confirmPostCommandApplyMs ?? '-'} c_ops:{latestPaymentFlowTelemetry.confirmOpsMs ?? '-'} c_fail:{latestPaymentFlowTelemetry.confirmFailureHandlingMs ?? '-'} c_oth:{latestPaymentFlowTelemetry.confirmOtherMs ?? '-'}
                </p>
              )}
              {latestPaymentFlowTelemetry && (
                <p className="truncate">
                  sr_empty:{latestPaymentFlowTelemetry.stateRefreshEmptyDraftCheckMs ?? '-'} sr_flush:{latestPaymentFlowTelemetry.stateRefreshAfterFlushMs ?? '-'} sr_final:{latestPaymentFlowTelemetry.stateRefreshBeforeFinalizeMs ?? '-'} sr_oth:{latestPaymentFlowTelemetry.stateRefreshOtherMs ?? '-'}
                </p>
              )}
              {latestPaymentFlowTelemetry && (
                <p className="truncate">
                  ops_send:{latestPaymentFlowTelemetry.pOpsBackendSentMs ?? '-'} ops_ack:{latestPaymentFlowTelemetry.pOpsBackendAckMs ?? '-'} ops_ui:{latestPaymentFlowTelemetry.pOpsEventStateMs ?? '-'} ops_persist:{latestPaymentFlowTelemetry.pOpsEventPersistMs ?? '-'} ops_report:{latestPaymentFlowTelemetry.pOpsEventReportMs ?? '-'} ops_oth:{latestPaymentFlowTelemetry.pOpsOtherMs ?? '-'}
                </p>
              )}
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
      <div className="fixed bottom-3 left-3 z-[1190] pointer-events-auto">
        <button
          type="button"
          onClick={() => setIsTechnicalPanelOpen((current) => !current)}
          className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-[9px] font-black uppercase tracking-widest text-white shadow-lg"
          title="Painel técnico (atalho: Ctrl+Shift+O)"
        >
          OPS
        </button>
        {isTechnicalPanelOpen && (
          <div className="mt-2 w-[350px] max-w-[92vw] rounded-xl border border-slate-700 bg-slate-950/95 p-2 text-[10px] text-slate-100 shadow-2xl backdrop-blur">
            <p className="font-black uppercase tracking-widest text-slate-300">Painel Técnico</p>
            <p className="mt-1 font-bold uppercase tracking-wide text-slate-400">
              Sch {operationalHealthSnapshot.schedulerActive}/{operationalHealthSnapshot.schedulerQueued} | C:{operationalHealthSnapshot.schedulerCriticalQueued} H:{operationalHealthSnapshot.schedulerHighQueued} N:{operationalHealthSnapshot.schedulerNormalQueued} L:{operationalHealthSnapshot.schedulerLowQueued}
            </p>
            <p className="font-bold uppercase tracking-wide text-slate-400">
              Draft:{operationalHealthSnapshot.pendingDraftAdds} Paid:{operationalHealthSnapshot.pendingPaidQueue} Failed:{operationalHealthSnapshot.failedQueue}
            </p>
            <p className="font-bold uppercase tracking-wide text-slate-400">
              BP:{operationalHealthSnapshot.schedulerBackpressureHits} DD:{operationalHealthSnapshot.schedulerDedupeHits} FS:{operationalHealthSnapshot.failsafeActivations} DEF:{operationalHealthSnapshot.failsafeDeferredCommands}
            </p>
            <p className="font-bold uppercase tracking-wide text-slate-400">
              Pause:{Math.ceil(operationalHealthSnapshot.failsafeCurrentPauseMs / 1000)}s Acumulada:{Math.ceil(operationalHealthSnapshot.failsafeAccumulatedPausedMs / 1000)}s
            </p>

            <div className="mt-2 rounded-md border border-slate-800 bg-slate-900 p-1.5">
              <p className="font-black uppercase tracking-wide text-slate-300">Pagamentos (últimos 10)</p>
              <div className="mt-1 max-h-[120px] space-y-1 overflow-y-auto">
                {paymentFlowTelemetryHistory.slice(0, 10).map((entry) => (
                  <p key={entry.jobId} className="truncate font-mono text-[9px] text-slate-200">
                    {(() => {
                      const breakdown = getPaymentFlowProcessingBreakdown(entry);
                      return `${entry.draftId.slice(-8).toUpperCase()} local:${entry.clickToLocalPersistMs ?? '-'}ms w:${entry.waitInQueueMs ?? '-'}ms p:${entry.processingMs ?? '-'}ms conf:${entry.totalConfMs ?? entry.clickToBackendConfirmMs ?? '-'}ms p_flush:${entry.pFlushMs ?? '-'} p_prepare:${entry.pPrepareMs ?? '-'} p_request:${entry.pRequestMs ?? '-'} p_backend:${entry.pBackendMs ?? '-'} p_apply_snapshot:${entry.pApplySnapshotMs ?? '-'} p_reconcile:${entry.pReconcileMs ?? '-'} p_persist:${entry.pPersistMs ?? '-'} p_ops:${entry.pOpsMs ?? '-'} p_finalize:${entry.pFinalizeMs ?? '-'} f:${breakdown?.flushPendingDraftAddsMs ?? '-'} fi:${breakdown?.finalizeMs ?? '-'} cf:${breakdown?.confirmMs ?? '-'} sn:${breakdown?.snapshotApplyMs ?? '-'} sr:${breakdown?.stateRefreshMs ?? '-'} rv:${breakdown?.recoveryMs ?? '-'} rb:${breakdown?.retryBackoffMs ?? '-'} fr:${breakdown?.frontendReconcileMs ?? '-'} oth:${breakdown?.residualMs ?? '-'} c_cmd:${entry.confirmCommandInvokeMs ?? '-'} c_lock:${entry.confirmDraftLockWaitMs ?? '-'} c_gq:${entry.confirmGlobalQueueWaitMs ?? '-'} c_gqd:${entry.confirmGlobalQueueDepthAtEnqueue ?? '-'} c_sched:${entry.confirmSchedulerWaitMs ?? '-'} c_apply:${entry.confirmPostCommandApplyMs ?? '-'} c_ops:${entry.confirmOpsMs ?? '-'} c_fail:${entry.confirmFailureHandlingMs ?? '-'} c_oth:${entry.confirmOtherMs ?? '-'} sr_empty:${entry.stateRefreshEmptyDraftCheckMs ?? '-'} sr_flush:${entry.stateRefreshAfterFlushMs ?? '-'} sr_final:${entry.stateRefreshBeforeFinalizeMs ?? '-'} sr_oth:${entry.stateRefreshOtherMs ?? '-'} f_lock:${entry.flushLockWaitMs ?? '-'} f_read:${entry.flushPendingReadMs ?? '-'} f_snap:${entry.flushSnapshotPrepareMs ?? '-'} f_vis:${entry.flushVisibleRunMs ?? '-'} f_rec:${entry.flushRecoveryRunMs ?? '-'} f_sr:${entry.flushStateRefreshMs ?? '-'} f_sn:${entry.flushApplySnapshotMs ?? '-'} f_ps:${entry.flushOperationalPersistMs ?? '-'} f_cl:${entry.flushTerminalCleanupMs ?? '-'} f_ui:${entry.flushUiReleaseMs ?? '-'} f_post:${entry.flushPostReturnMs ?? '-'} f_oth:${entry.flushOtherMs ?? '-'} ops_send:${entry.pOpsBackendSentMs ?? '-'} ops_ack:${entry.pOpsBackendAckMs ?? '-'} ops_ui:${entry.pOpsEventStateMs ?? '-'} ops_ps:${entry.pOpsEventPersistMs ?? '-'} ops_rp:${entry.pOpsEventReportMs ?? '-'} ops_oth:${entry.pOpsOtherMs ?? '-'} r:${entry.retries} rec:${entry.hadRecovery ? '1' : '0'} rc:${entry.hadReconciliation ? '1' : '0'}`;
                    })()}
                  </p>
                ))}
                {paymentFlowTelemetryHistory.length === 0 && (
                  <p className="text-[9px] text-slate-500">Sem registros.</p>
                )}
              </div>
            </div>

            <div className="mt-2 rounded-md border border-slate-800 bg-slate-900 p-1.5">
              <p className="font-black uppercase tracking-wide text-slate-300">Eventos (últimos 20)</p>
              <div className="mt-1 max-h-[140px] space-y-1 overflow-y-auto">
                {operationalEventLog.map((entry) => (
                  <p key={entry.id} className="truncate font-mono text-[9px] text-slate-200">
                    {entry.timestamp.slice(11, 19)} [{entry.type}] {entry.message}
                  </p>
                ))}
                {operationalEventLog.length === 0 && (
                  <p className="text-[9px] text-slate-500">Sem eventos.</p>
                )}
              </div>
            </div>
          </div>
        )}
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
                  allProducts={products}
                  resolvedRecipe={resolvedRecipeByProductId.get(product.id)}
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
                              onClick={() => handleRemoveDraftItem(item.id)}
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
