import { AppStateBackupKind, Prisma, SaleStatus, StockTargetType } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { FrontAppState } from '../types/frontend.js';
import type { RequestContext } from '../types/request-context.js';
import { isDatabaseUnavailableError } from '../utils/database-unavailable.js';
import { HttpError } from '../utils/http-error.js';
import type { StateCommandInput } from '../validators/state-command.validator.js';
import { AuditService } from './audit.service.js';
import {
  toFrontCleaningEntry,
  toFrontCleaningMaterial,
  toFrontIngredient,
  toFrontIngredientEntry,
  toFrontProduct,
  toFrontSale,
} from './mappers.service.js';
import { SessionService } from './session.service.js';
import { addDays, toBackupDay, toDateOnlyKey } from './state-backup.utils.js';
import { applyStateCommand, commandTouchesArchiveState } from './state-command.service.js';

const EMPTY_APP_STATE: FrontAppState = {
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
  activeBusinessDate: null,
  businessSettings: {
    infiniteStockEnabled: false,
    ignoreStockCosts: false,
  },
};

const arrayOrEmpty = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const toNonNegativeNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const BUSINESS_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const normalizeActiveBusinessDate = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!BUSINESS_DAY_KEY_PATTERN.test(trimmed)) return null;
  return trimmed;
};

const normalizeBusinessSettings = (
  value: unknown
): NonNullable<FrontAppState['businessSettings']> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      infiniteStockEnabled: false,
      ignoreStockCosts: false,
    };
  }

  const source = value as Record<string, unknown>;
  const infiniteStockEnabled = source.infiniteStockEnabled === true;
  const ignoreStockCosts = source.ignoreStockCosts === true || infiniteStockEnabled;
  return {
    infiniteStockEnabled,
    ignoreStockCosts,
  };
};

const normalizeStatePayload = (value: unknown): FrontAppState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Payload de estado inválido. Deve ser um objeto AppState.');
  }

  const payload = value as Record<string, unknown>;
  return {
    ingredients: arrayOrEmpty(payload.ingredients),
    products: arrayOrEmpty(payload.products),
    sales: arrayOrEmpty(payload.sales),
    stockEntries: arrayOrEmpty(payload.stockEntries),
    cleaningMaterials: arrayOrEmpty(payload.cleaningMaterials),
    cleaningStockEntries: arrayOrEmpty(payload.cleaningStockEntries),
    globalSales: arrayOrEmpty(payload.globalSales),
    globalCancelledSales: arrayOrEmpty(payload.globalCancelledSales),
    globalStockEntries: arrayOrEmpty(payload.globalStockEntries),
    globalCleaningStockEntries: arrayOrEmpty(payload.globalCleaningStockEntries),
    saleDrafts: arrayOrEmpty(payload.saleDrafts),
    cashRegisterAmount: toNonNegativeNumber(payload.cashRegisterAmount),
    dailySalesHistory: arrayOrEmpty(payload.dailySalesHistory),
    activeBusinessDate: normalizeActiveBusinessDate(payload.activeBusinessDate),
    businessSettings: normalizeBusinessSettings(payload.businessSettings),
  };
};

const normalizeStatePayloadSafe = (value: unknown): FrontAppState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
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
      activeBusinessDate: null,
      businessSettings: {
        infiniteStockEnabled: false,
        ignoreStockCosts: false,
      },
    };
  }
  return normalizeStatePayload(value);
};

const toVersionTag = (value: Date): string => value.toISOString();
const APPLY_COMMAND_MAX_ATTEMPTS = 3;
const APPLY_COMMAND_RETRY_BASE_DELAY_MS = 120;
const APPLY_COMMAND_RETRY_MAX_DELAY_MS = 900;
const APPLY_COMMAND_LATEST_MAX_ATTEMPTS = 8;
const APPLY_COMMAND_LATEST_RETRY_BASE_DELAY_MS = 80;
const APPLY_COMMAND_LATEST_RETRY_MAX_DELAY_MS = 1200;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

const getApplyCommandRetryDelayMs = (attempt: number): number => {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = APPLY_COMMAND_RETRY_BASE_DELAY_MS * 2 ** safeAttempt;
  return Math.min(APPLY_COMMAND_RETRY_MAX_DELAY_MS, exponential);
};

const getApplyCommandLatestRetryDelayMs = (attempt: number): number => {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = APPLY_COMMAND_LATEST_RETRY_BASE_DELAY_MS * 2 ** safeAttempt;
  return Math.min(APPLY_COMMAND_LATEST_RETRY_MAX_DELAY_MS, exponential);
};

const isTerminalPaymentCommand = (command: StateCommandInput): boolean =>
  command.type === 'SALE_DRAFT_FINALIZE' ||
  command.type === 'SALE_DRAFT_CONFIRM_PAID' ||
  command.type === 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID';

const logStateServicePerf = (
  event: string,
  payload: Record<string, unknown>
): void => {
  // eslint-disable-next-line no-console
  console.info('[state-service-perf]', {
    event,
    ...payload,
  });
};

interface HotStatePatch {
  ingredients: FrontAppState['ingredients'];
  products: FrontAppState['products'];
  sales: FrontAppState['sales'];
  stockEntries: FrontAppState['stockEntries'];
  cleaningMaterials: FrontAppState['cleaningMaterials'];
  cleaningStockEntries: FrontAppState['cleaningStockEntries'];
  saleDrafts: FrontAppState['saleDrafts'];
  cashRegisterAmount: FrontAppState['cashRegisterAmount'];
  activeBusinessDate: FrontAppState['activeBusinessDate'];
  businessSettings: FrontAppState['businessSettings'];
}

// SALE_DRAFT_CONFIRM_PAID mutates only these top-level keys in AppState.
// Keeping this patch explicit avoids hot-path full JSON rewrites while preserving semantics.
interface ConfirmPaidStatePatch {
  ingredients: FrontAppState['ingredients'];
  sales: FrontAppState['sales'];
  stockEntries: FrontAppState['stockEntries'];
  saleDrafts: FrontAppState['saleDrafts'];
  globalSales: FrontAppState['globalSales'];
  globalStockEntries: FrontAppState['globalStockEntries'];
}

interface PersistedStateRow {
  stateJson: Prisma.JsonValue;
  updatedAt: Date;
}

const toHotStatePatch = (state: FrontAppState): HotStatePatch => ({
  ingredients: state.ingredients,
  products: state.products,
  sales: state.sales,
  stockEntries: state.stockEntries,
  cleaningMaterials: state.cleaningMaterials,
  cleaningStockEntries: state.cleaningStockEntries,
  saleDrafts: state.saleDrafts,
  cashRegisterAmount: state.cashRegisterAmount,
  activeBusinessDate: state.activeBusinessDate,
  businessSettings: state.businessSettings,
});

const toConfirmPaidStatePatch = (state: FrontAppState): ConfirmPaidStatePatch => ({
  ingredients: state.ingredients,
  sales: state.sales,
  stockEntries: state.stockEntries,
  saleDrafts: state.saleDrafts,
  globalSales: state.globalSales,
  globalStockEntries: state.globalStockEntries,
});

export interface AppStateSnapshot {
  state: FrontAppState;
  version: string;
}

export interface DailyBackupResult {
  backupDay: string;
  created: boolean;
  sourceVersion: string;
  prunedCount: number;
}

export class StateService {
  private readonly sessionService = new SessionService();
  private static bestEffortDailyBackupInFlight: Promise<void> | null = null;
  private static bestEffortDailyBackupLastAttemptAt = 0;
  private static bestEffortDailyBackupLastDayKey: string | null = null;

  async getAppState(): Promise<AppStateSnapshot> {
    try {
      const snapshot = await prisma.appState.findUnique({ where: { id: 1 } });
      if (snapshot) {
        return {
          state: normalizeStatePayloadSafe(snapshot.stateJson),
          version: toVersionTag(snapshot.updatedAt),
        };
      }
    } catch (error) {
      if (!this.isMissingAppStateTableError(error)) {
        throw error;
      }
      await this.bootstrapAppStateTables();
    }

    const rebuilt = await this.buildStateFromDomain();
    return this.persistSnapshot(rebuilt, 'APP_STATE_BOOTSTRAPPED');
  }

  async getAppStateVersion(): Promise<string> {
    try {
      const snapshot = await prisma.appState.findUnique({
        where: { id: 1 },
        select: { updatedAt: true },
      });
      if (snapshot) {
        return toVersionTag(snapshot.updatedAt);
      }
    } catch (error) {
      if (!this.isMissingAppStateTableError(error)) {
        throw error;
      }
      await this.bootstrapAppStateTables();
    }

    const rebuilt = await this.buildStateFromDomain();
    const persisted = await this.persistSnapshot(rebuilt, 'APP_STATE_BOOTSTRAPPED');
    return persisted.version;
  }

  async saveAppState(
    state: unknown,
    expectedVersion: string,
    context?: RequestContext
  ): Promise<AppStateSnapshot> {
    const normalized = normalizeStatePayload(state);
    return this.persistSnapshot(normalized, 'APP_STATE_UPSERTED', context, expectedVersion);
  }

  async clearAppState(expectedVersion: string, context?: RequestContext): Promise<AppStateSnapshot> {
    return this.persistSnapshot(EMPTY_APP_STATE, 'APP_STATE_CLEARED', context, expectedVersion);
  }

  async applyCommand(
    command: StateCommandInput,
    expectedVersion: string,
    context?: RequestContext
  ): Promise<AppStateSnapshot> {
    for (let attempt = 0; attempt < APPLY_COMMAND_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.applyCommandSnapshot(command, expectedVersion, context);
      } catch (error) {
        if (this.isMissingAppStateTableError(error)) {
          await this.bootstrapAppStateTables();
          continue;
        }

        const isLastAttempt = attempt >= APPLY_COMMAND_MAX_ATTEMPTS - 1;
        if (!this.isRetryableApplyCommandError(error) || isLastAttempt) {
          throw error;
        }

        await wait(getApplyCommandRetryDelayMs(attempt));
      }
    }

    throw new HttpError(503, 'Banco temporariamente indisponível para salvar estado.');
  }

  async applyCommandAgainstLatest(
    command: StateCommandInput,
    context?: RequestContext
  ): Promise<AppStateSnapshot> {
    const shouldTrackPerf = isTerminalPaymentCommand(command);
    const startedAt = shouldTrackPerf ? Date.now() : 0;
    let conflictRetries = 0;
    for (let attempt = 0; attempt < APPLY_COMMAND_LATEST_MAX_ATTEMPTS; attempt += 1) {
      const attemptStartedAt = shouldTrackPerf ? Date.now() : 0;
      const currentVersion = await this.getAppStateVersion();

      try {
        const snapshot = await this.applyCommand(command, currentVersion, context);
        if (shouldTrackPerf) {
          logStateServicePerf('apply-command-against-latest:success', {
            commandType: command.type,
            commandId: command.commandId ?? null,
            attempts: attempt + 1,
            conflictRetries,
            attemptMs: Date.now() - attemptStartedAt,
            totalMs: Date.now() - startedAt,
            resolvedVersion: snapshot.version,
          });
        }
        return snapshot;
      } catch (error) {
        const isVersionConflict =
          error instanceof HttpError &&
          (error.statusCode === 412 || error.statusCode === 428);

        const isLastAttempt = attempt >= APPLY_COMMAND_LATEST_MAX_ATTEMPTS - 1;
        if (!isVersionConflict || isLastAttempt) {
          if (shouldTrackPerf) {
            logStateServicePerf('apply-command-against-latest:failed', {
              commandType: command.type,
              commandId: command.commandId ?? null,
              attempts: attempt + 1,
              conflictRetries,
              isVersionConflict,
              totalMs: Date.now() - startedAt,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }

        conflictRetries += 1;
        await wait(getApplyCommandLatestRetryDelayMs(attempt));
      }
    }

    throw new HttpError(503, 'Não foi possível aplicar o comando devido a conflito de concorrência.');
  }

  async runDailyBackup(context?: RequestContext): Promise<DailyBackupResult> {
    const now = new Date();
    try {
      return await this.createDailyBackup(now, context);
    } catch (error) {
      if (!this.isMissingAppStateTableError(error)) {
        throw error;
      }

      await this.bootstrapAppStateTables();
      return this.createDailyBackup(now, context);
    }
  }

  private isMissingAppStateTableError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021';
  }

  private isRetryableApplyCommandError(error: unknown): boolean {
    if (isDatabaseUnavailableError(error)) {
      return true;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return (
        error.code === 'P2024' ||
        error.code === 'P2028' ||
        error.code === 'P2034'
      );
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const normalizedMessage = (error.message || '').toLowerCase();
      return normalizedMessage.includes('transaction api error');
    }

    return false;
  }

  private getStateTxOptions() {
    return {
      maxWait: env.APP_STATE_TX_MAX_WAIT_MS,
      timeout: env.APP_STATE_TX_TIMEOUT_MS,
    };
  }

  private runStateTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return prisma.$transaction((tx) => operation(tx), this.getStateTxOptions());
  }

  private queueBestEffortDailyBackup(
    stateJson: Prisma.JsonValue,
    sourceVersion: string,
    referenceDate: Date
  ): void {
    const backupDay = toBackupDay(referenceDate, env.DEFAULT_TIMEZONE);
    const backupDayKey = toDateOnlyKey(backupDay);
    const nowMs = Date.now();
    const isSameDayWithinCooldown =
      StateService.bestEffortDailyBackupLastDayKey === backupDayKey &&
      nowMs - StateService.bestEffortDailyBackupLastAttemptAt <
        env.APP_STATE_BEST_EFFORT_BACKUP_MIN_INTERVAL_MS;

    if (isSameDayWithinCooldown || StateService.bestEffortDailyBackupInFlight) {
      return;
    }

    StateService.bestEffortDailyBackupLastDayKey = backupDayKey;
    StateService.bestEffortDailyBackupLastAttemptAt = nowMs;

    StateService.bestEffortDailyBackupInFlight = (async () => {
      try {
        await prisma.appStateBackup.createMany({
          data: {
            kind: AppStateBackupKind.DAILY,
            backupDay,
            sourceVersion,
            stateJson: stateJson as unknown as Prisma.InputJsonValue,
          },
          skipDuplicates: true,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[state-backup] best-effort backup failed', error);
      } finally {
        StateService.bestEffortDailyBackupInFlight = null;
      }
    })();
  }

  private async bootstrapAppStateTables(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS app_state (
        id integer PRIMARY KEY DEFAULT 1,
        state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT app_state_singleton CHECK (id = 1)
      )
    `);

    await prisma.$executeRawUnsafe(`
      INSERT INTO app_state (id, state_json)
      VALUES (1, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);

    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        CREATE TYPE app_state_backup_kind AS ENUM ('PRE_WRITE', 'DAILY', 'MANUAL');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END
      $$;
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS app_state_backups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind app_state_backup_kind NOT NULL,
        source_version varchar(80) NOT NULL,
        backup_day date,
        state_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS app_state_backups_backup_day_kind_key
      ON app_state_backups (backup_day, kind)
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS app_state_backups_kind_created_at_idx
      ON app_state_backups (kind, created_at)
    `);

    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS app_state_backups_source_version_idx
      ON app_state_backups (source_version)
    `);
  }

  private async persistSnapshot(
    state: FrontAppState,
    action: 'APP_STATE_BOOTSTRAPPED' | 'APP_STATE_UPSERTED' | 'APP_STATE_CLEARED',
    context?: RequestContext,
    expectedVersion?: string
  ): Promise<AppStateSnapshot> {
    try {
      return await this.upsertSnapshot(state, action, context, expectedVersion);
    } catch (error) {
      if (!this.isMissingAppStateTableError(error)) {
        throw error;
      }

      await this.bootstrapAppStateTables();
      return this.upsertSnapshot(state, action, context, expectedVersion);
    }
  }

  private async upsertSnapshot(
    state: FrontAppState,
    action: 'APP_STATE_BOOTSTRAPPED' | 'APP_STATE_UPSERTED' | 'APP_STATE_CLEARED',
    context?: RequestContext,
    expectedVersion?: string
  ): Promise<AppStateSnapshot> {
    const committed = await this.runStateTransaction(async (tx: Prisma.TransactionClient) => {
      const current = await tx.appState.findUnique({ where: { id: 1 } });
      const currentVersion = current ? toVersionTag(current.updatedAt) : null;
      const operationNow = new Date();

      if (expectedVersion !== undefined) {
        if (!currentVersion) {
          throw new HttpError(412, 'Versão de estado inválida. Snapshot base não encontrado.', {
            expectedVersion,
            currentVersion: null,
          });
        }
        if (expectedVersion !== currentVersion) {
          throw new HttpError(412, 'Conflito de versão no estado. Recarregue antes de salvar.', {
            expectedVersion,
            currentVersion,
          });
        }
      }

      await this.ensurePreWriteBackupTx(tx, current);

      const saved = current
        ? await tx.appState.update({
            where: { id: 1 },
            data: {
              stateJson: state as unknown as Prisma.InputJsonValue,
            },
          })
        : await tx.appState.create({
            data: {
              id: 1,
              stateJson: state as unknown as Prisma.InputJsonValue,
            },
          });
      const savedVersion = toVersionTag(saved.updatedAt);

      await new AuditService(tx).log(
        {
          entityName: 'app_state',
          entityId: '1',
          action,
        },
        context
      );

      return {
        stateJson: saved.stateJson as Prisma.JsonValue,
        state,
        version: savedVersion,
        operationNow,
      };
    });

    this.queueBestEffortDailyBackup(
      committed.stateJson,
      committed.version,
      committed.operationNow
    );

    return {
      state: committed.state,
      version: committed.version,
    };
  }

  private assertExpectedVersion(
    expectedVersion: string | undefined,
    currentVersion: string | null
  ): void {
    if (expectedVersion === undefined) return;

    if (!currentVersion) {
      throw new HttpError(412, 'Versão de estado inválida. Snapshot base não encontrado.', {
        expectedVersion,
        currentVersion: null,
      });
    }

    if (expectedVersion !== currentVersion) {
      throw new HttpError(412, 'Conflito de versão no estado. Recarregue antes de salvar.', {
        expectedVersion,
        currentVersion,
      });
    }
  }

  private async applyCommandSnapshot(
    command: StateCommandInput,
    expectedVersion: string,
    context?: RequestContext
  ): Promise<AppStateSnapshot> {
    const shouldTrackPerf = isTerminalPaymentCommand(command);
    const startedAt = shouldTrackPerf ? Date.now() : 0;
    const committed = await this.runStateTransaction(async (tx: Prisma.TransactionClient) => {
      const readStateStartedAt = shouldTrackPerf ? Date.now() : 0;
      const current = await tx.appState.findUnique({ where: { id: 1 } });
      const readStateMs = shouldTrackPerf ? Date.now() - readStateStartedAt : 0;
      const currentVersion = current ? toVersionTag(current.updatedAt) : null;
      const operationNow = new Date();
      this.assertExpectedVersion(expectedVersion, currentVersion);

      const applyStartedAt = shouldTrackPerf ? Date.now() : 0;
      const currentState = current
        ? normalizeStatePayloadSafe(current.stateJson)
        : normalizeStatePayloadSafe({});
      const nextState = applyStateCommand(currentState, command, { mutateInPlace: true });
      const applyCommandMs = shouldTrackPerf ? Date.now() - applyStartedAt : 0;
      const nextStateSizeBytes = shouldTrackPerf
        ? JSON.stringify(nextState).length
        : 0;

      // Commands that do not touch historical/global collections update only "hot" keys.
      // This preserves full history while avoiding heavy JSON writes on frequent cart operations.
      const shouldUpdateArchive = commandTouchesArchiveState(command.type);
      const persistStartedAt = shouldTrackPerf ? Date.now() : 0;
      const shouldPersistConfirmPaidPatch =
        !!current &&
        (command.type === 'SALE_DRAFT_CONFIRM_PAID' ||
          command.type === 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID') &&
        shouldUpdateArchive;
      const shouldPersistFinalizeDraftOnly =
        !!current && command.type === 'SALE_DRAFT_FINALIZE' && !shouldUpdateArchive;
      const persistMode = !current
        ? 'create_full'
        : shouldPersistConfirmPaidPatch
          ? 'confirm_paid_patch'
          : shouldUpdateArchive
            ? 'archive_full'
            : shouldPersistFinalizeDraftOnly
            ? 'finalize_saleDrafts_only'
            : 'hot_patch';
      const saved: PersistedStateRow = current
        ? shouldPersistConfirmPaidPatch
          ? await this.updateConfirmPaidStateTx(tx, nextState)
          : shouldUpdateArchive
          ? await tx.appState.update({
              where: { id: 1 },
              data: {
                stateJson: nextState as unknown as Prisma.InputJsonValue,
              },
            })
            : shouldPersistFinalizeDraftOnly
              ? await this.updateSaleDraftsOnlyTx(tx, nextState.saleDrafts)
              : await this.updateHotStateTx(tx, nextState)
        : await tx.appState.create({
            data: {
              id: 1,
              stateJson: nextState as unknown as Prisma.InputJsonValue,
            },
          });
      const persistMs = shouldTrackPerf ? Date.now() - persistStartedAt : 0;
      const savedVersion = toVersionTag(saved.updatedAt);

      const auditStartedAt = shouldTrackPerf ? Date.now() : 0;
      await new AuditService(tx).log(
        {
          entityName: 'app_state',
          entityId: '1',
          action: 'APP_STATE_COMMAND_APPLIED',
          metadata: {
            commandType: command.type,
            commandId: command.commandId ?? null,
          },
        },
        context
      );
      const auditMs = shouldTrackPerf ? Date.now() - auditStartedAt : 0;

      if (shouldTrackPerf) {
        logStateServicePerf('apply-command-snapshot:tx', {
          commandType: command.type,
          commandId: command.commandId ?? null,
          requestId: context?.requestId || null,
          shouldUpdateArchive,
          persistMode,
          readStateMs,
          applyCommandMs,
          persistMs,
          auditMs,
          txTotalMs: readStateMs + applyCommandMs + persistMs + auditMs,
          nextStateSizeBytes,
          versionBefore: currentVersion,
          versionAfter: savedVersion,
        });
      }

      return {
        stateJson: saved.stateJson as Prisma.JsonValue,
        state: nextState,
        version: savedVersion,
        operationNow,
      };
    });

    this.queueBestEffortDailyBackup(
      committed.stateJson,
      committed.version,
      committed.operationNow
    );

    if (shouldTrackPerf) {
      logStateServicePerf('apply-command-snapshot:done', {
        commandType: command.type,
        commandId: command.commandId ?? null,
        requestId: context?.requestId || null,
        totalMs: Date.now() - startedAt,
        version: committed.version,
      });
    }

    return {
      state: committed.state,
      version: committed.version,
    };
  }

  private async updateHotStateTx(
    tx: Prisma.TransactionClient,
    state: FrontAppState
  ): Promise<PersistedStateRow> {
    const patch = JSON.stringify(toHotStatePatch(state));
    const rows = await tx.$queryRaw<Array<{ state_json: Prisma.JsonValue; updated_at: Date }>>(
      Prisma.sql`
        UPDATE app_state
        SET state_json = state_json || ${patch}::jsonb,
            updated_at = now()
        WHERE id = 1
        RETURNING state_json, updated_at
      `
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(500, 'Falha ao persistir estado operacional.');
    }

    return {
      stateJson: row.state_json,
      updatedAt: row.updated_at,
    };
  }

  private async updateConfirmPaidStateTx(
    tx: Prisma.TransactionClient,
    state: FrontAppState
  ): Promise<PersistedStateRow> {
    const patch = JSON.stringify(toConfirmPaidStatePatch(state));
    const rows = await tx.$queryRaw<Array<{ state_json: Prisma.JsonValue; updated_at: Date }>>(
      Prisma.sql`
        UPDATE app_state
        SET state_json = state_json || ${patch}::jsonb,
            updated_at = now()
        WHERE id = 1
        RETURNING state_json, updated_at
      `
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(500, 'Falha ao persistir estado de confirmação de pagamento.');
    }

    return {
      stateJson: row.state_json,
      updatedAt: row.updated_at,
    };
  }

  private async updateSaleDraftsOnlyTx(
    tx: Prisma.TransactionClient,
    saleDrafts: FrontAppState['saleDrafts']
  ): Promise<PersistedStateRow> {
    const patch = JSON.stringify(saleDrafts);
    const rows = await tx.$queryRaw<Array<{ state_json: Prisma.JsonValue; updated_at: Date }>>(
      Prisma.sql`
        UPDATE app_state
        SET state_json = jsonb_set(
              COALESCE(state_json, '{}'::jsonb),
              '{saleDrafts}',
              ${patch}::jsonb,
              true
            ),
            updated_at = now()
        WHERE id = 1
        RETURNING state_json, updated_at
      `
    );

    const row = rows[0];
    if (!row) {
      throw new HttpError(500, 'Falha ao persistir drafts de venda.');
    }

    return {
      stateJson: row.state_json,
      updatedAt: row.updated_at,
    };
  }

  private async createDailyBackup(
    referenceDate: Date,
    context?: RequestContext
  ): Promise<DailyBackupResult> {
    const snapshot = await this.getAppState();
    const backupDay = toBackupDay(referenceDate, env.DEFAULT_TIMEZONE);
    const backupDayKey = toDateOnlyKey(backupDay);

    return this.runStateTransaction(async (tx: Prisma.TransactionClient) => {
      const liveState = await tx.appState.findUnique({ where: { id: 1 } });
      const sourceVersion = liveState ? toVersionTag(liveState.updatedAt) : snapshot.version;
      const stateJson = (liveState?.stateJson ?? snapshot.state) as Prisma.JsonValue;

      const created = await this.ensureDailyBackupTx(tx, stateJson, sourceVersion, referenceDate);
      const prunedCount = await this.pruneExpiredBackupsTx(tx, referenceDate);

      await new AuditService(tx).log(
        {
          entityName: 'app_state',
          entityId: '1',
          action: 'APP_STATE_BACKUP_DAILY',
          metadata: {
            backupDay: backupDayKey,
            created,
            sourceVersion,
            prunedCount,
          },
        },
        context
      );

      return {
        backupDay: backupDayKey,
        created,
        sourceVersion,
        prunedCount,
      };
    });
  }

  private async ensurePreWriteBackupTx(
    tx: Prisma.TransactionClient,
    current: { stateJson: Prisma.JsonValue; updatedAt: Date } | null
  ): Promise<void> {
    if (!current) return;

    const sourceVersion = toVersionTag(current.updatedAt);
    const existing = await tx.appStateBackup.findFirst({
      where: {
        kind: AppStateBackupKind.PRE_WRITE,
        sourceVersion,
      },
      select: { id: true },
    });

    if (existing) return;

    await tx.appStateBackup.create({
      data: {
        kind: AppStateBackupKind.PRE_WRITE,
        sourceVersion,
        stateJson: current.stateJson as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async ensureDailyBackupTx(
    tx: Prisma.TransactionClient,
    stateJson: Prisma.JsonValue,
    sourceVersion: string,
    referenceDate: Date,
    options: { refreshExisting?: boolean } = {}
  ): Promise<boolean> {
    const shouldRefreshExisting = options.refreshExisting !== false;
    const backupDay = toBackupDay(referenceDate, env.DEFAULT_TIMEZONE);
    const created = await tx.appStateBackup.createMany({
      data: {
        kind: AppStateBackupKind.DAILY,
        backupDay,
        sourceVersion,
        stateJson: stateJson as unknown as Prisma.InputJsonValue,
      },
      skipDuplicates: true,
    });

    if (created.count > 0) {
      return true;
    }

    if (!shouldRefreshExisting) {
      return false;
    }

    await tx.appStateBackup.update({
      where: {
        backupDay_kind: {
          backupDay,
          kind: AppStateBackupKind.DAILY,
        },
      },
      data: {
        sourceVersion,
        stateJson: stateJson as unknown as Prisma.InputJsonValue,
      },
    });

    return false;
  }

  private async pruneExpiredBackupsTx(
    tx: Prisma.TransactionClient,
    referenceDate: Date
  ): Promise<number> {
    const cutoff = addDays(referenceDate, -env.APP_STATE_BACKUP_RETENTION_DAYS);
    const deleted = await tx.appStateBackup.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });
    return deleted.count;
  }

  private async buildStateFromDomain(): Promise<FrontAppState> {
    const currentSession = await this.sessionService.getCurrentSession();

    const [
      ingredients,
      products,
      sessionSales,
      sessionStockMovements,
      cleaningMaterials,
      sessionCleaningMovements,
      globalSales,
      globalCancelledSales,
      globalStockMovements,
      globalCleaningMovements,
    ] = await Promise.all([
      prisma.ingredient.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      }),
      prisma.product.findMany({
        where: { isActive: true },
        include: { recipeItems: true },
        orderBy: { name: 'asc' },
      }),
      prisma.sale.findMany({
        where: {
          sessionId: currentSession.id,
          status: { not: SaleStatus.REFUNDED },
        },
        include: {
          items: {
            include: { ingredients: true },
            orderBy: { createdAt: 'asc' },
          },
          refunds: {
            select: {
              totalCostReversed: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.stockMovement.findMany({
        where: {
          sessionId: currentSession.id,
          isManual: true,
          targetType: StockTargetType.INGREDIENT,
        },
        include: {
          ingredient: {
            select: { id: true, name: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.cleaningMaterial.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      }),
      prisma.stockMovement.findMany({
        where: {
          sessionId: currentSession.id,
          isManual: true,
          targetType: StockTargetType.CLEANING_MATERIAL,
        },
        include: {
          cleaningMaterial: {
            select: { id: true, name: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.sale.findMany({
        where: {
          status: { not: SaleStatus.REFUNDED },
        },
        include: {
          items: {
            include: { ingredients: true },
            orderBy: { createdAt: 'asc' },
          },
          refunds: {
            select: {
              totalCostReversed: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.sale.findMany({
        where: {
          status: SaleStatus.REFUNDED,
        },
        include: {
          items: {
            include: { ingredients: true },
            orderBy: { createdAt: 'asc' },
          },
          refunds: {
            select: {
              totalCostReversed: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.stockMovement.findMany({
        where: {
          isManual: true,
          targetType: StockTargetType.INGREDIENT,
        },
        include: {
          ingredient: {
            select: { id: true, name: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.stockMovement.findMany({
        where: {
          isManual: true,
          targetType: StockTargetType.CLEANING_MATERIAL,
        },
        include: {
          cleaningMaterial: {
            select: { id: true, name: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      ingredients: ingredients.map(toFrontIngredient),
      products: products.map(toFrontProduct),
      sales: sessionSales.map(toFrontSale),
      stockEntries: sessionStockMovements.map(toFrontIngredientEntry),
      cleaningMaterials: cleaningMaterials.map(toFrontCleaningMaterial),
      cleaningStockEntries: sessionCleaningMovements.map(toFrontCleaningEntry),
      globalSales: globalSales.map(toFrontSale),
      globalCancelledSales: globalCancelledSales.map(toFrontSale),
      globalStockEntries: globalStockMovements.map(toFrontIngredientEntry),
      globalCleaningStockEntries: globalCleaningMovements.map(toFrontCleaningEntry),
      saleDrafts: [],
      cashRegisterAmount: 0,
      dailySalesHistory: [],
      activeBusinessDate: null,
    };
  }
}
