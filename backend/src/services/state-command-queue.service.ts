import { Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { RequestContext } from '../types/request-context.js';
import { HttpError, isHttpError } from '../utils/http-error.js';
import { stateCommandSchema, type StateCommandInput } from '../validators/state-command.validator.js';
import { StateService } from './state.service.js';

export const STATE_COMMAND_JOB_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  RETRY: 'RETRY',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type StateCommandJobStatus =
  (typeof STATE_COMMAND_JOB_STATUS)[keyof typeof STATE_COMMAND_JOB_STATUS];

const RETRYABLE_HTTP_STATUS = new Set([408, 412, 425, 429, 500, 502, 503, 504]);
const DATABASE_UNAVAILABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1017']);
const DATABASE_UNAVAILABLE_MESSAGE_PATTERNS = [
  "can't reach database server",
  'database system is not yet accepting connections',
  'consistent recovery state has not been yet reached',
  'the database system is starting up',
];
const QUEUEABLE_COMMAND_TYPES = new Set<StateCommandInput['type']>(['SALE_DRAFT_CONFIRM_PAID']);
if (env.STATE_COMMAND_QUEUE_ENABLE_FINALIZE) {
  QUEUEABLE_COMMAND_TYPES.add('SALE_DRAFT_FINALIZE');
}
const MAX_CLAIM_ATTEMPTS_PER_CYCLE = 6;

export interface StateCommandJobSnapshot {
  id: string;
  commandId: string;
  commandType: string;
  status: StateCommandJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
  resultVersion: string | null;
}

const toJobSnapshot = (row: {
  id: string;
  commandId: string;
  commandType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
  resultVersion: string | null;
}): StateCommandJobSnapshot => ({
  id: row.id,
  commandId: row.commandId,
  commandType: row.commandType,
  status: normalizeJobStatus(row.status),
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  nextAttemptAt: row.nextAttemptAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  lastError: row.lastError,
  resultVersion: row.resultVersion,
});

export const isQueueableCommandType = (commandType: StateCommandInput['type']): boolean =>
  QUEUEABLE_COMMAND_TYPES.has(commandType);

export const isTerminalJobStatus = (status: StateCommandJobStatus): boolean =>
  status === STATE_COMMAND_JOB_STATUS.COMPLETED || status === STATE_COMMAND_JOB_STATUS.FAILED;

export const normalizeJobStatus = (status: string): StateCommandJobStatus => {
  if (status === STATE_COMMAND_JOB_STATUS.PENDING) return STATE_COMMAND_JOB_STATUS.PENDING;
  if (status === STATE_COMMAND_JOB_STATUS.PROCESSING) return STATE_COMMAND_JOB_STATUS.PROCESSING;
  if (status === STATE_COMMAND_JOB_STATUS.RETRY) return STATE_COMMAND_JOB_STATUS.RETRY;
  if (status === STATE_COMMAND_JOB_STATUS.COMPLETED) return STATE_COMMAND_JOB_STATUS.COMPLETED;
  if (status === STATE_COMMAND_JOB_STATUS.FAILED) return STATE_COMMAND_JOB_STATUS.FAILED;
  return STATE_COMMAND_JOB_STATUS.FAILED;
};

const normalizeCommandInput = (command: StateCommandInput): StateCommandInput => {
  const parsed = stateCommandSchema.parse(command);
  const normalizedCommandId = parsed.commandId?.trim();
  if (!normalizedCommandId) {
    throw new HttpError(400, 'commandId é obrigatório para fila assíncrona.');
  }

  return {
    ...parsed,
    commandId: normalizedCommandId,
  };
};

const normalizeErrorMessage = (error: unknown): string => {
  if (isHttpError(error)) {
    return `${error.message} (HTTP ${error.statusCode})`;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `Prisma ${error.code}: ${error.message}`;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return 'Falha não mapeada ao processar job assíncrono.';
};

const truncateErrorMessage = (message: string): string =>
  message.length <= 1200 ? message : message.slice(0, 1197).concat('...');

export const isDatabaseUnavailableQueueError = (error: unknown): boolean => {
  if (error instanceof HttpError) {
    return error.statusCode === 503;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (DATABASE_UNAVAILABLE_PRISMA_CODES.has(error.code)) return true;
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    const code =
      typeof (error as { errorCode?: unknown }).errorCode === 'string'
        ? (error as { errorCode: string }).errorCode
        : null;
    if (code && DATABASE_UNAVAILABLE_PRISMA_CODES.has(code)) return true;
  }

  if (
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Error
  ) {
    const normalized = error.message.toLowerCase();
    return DATABASE_UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) =>
      normalized.includes(pattern)
    );
  }

  return false;
};

const isRetryableWorkerError = (error: unknown): boolean => {
  if (isDatabaseUnavailableQueueError(error)) return true;

  if (isHttpError(error)) {
    if (RETRYABLE_HTTP_STATUS.has(error.statusCode)) return true;
    return error.statusCode >= 500;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return (
      error.code === 'P2024' ||
      error.code === 'P2028' ||
      error.code === 'P2034'
    );
  }

  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return error.message.includes('Transaction API error');
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    const code =
      typeof (error as { errorCode?: unknown }).errorCode === 'string'
        ? (error as { errorCode: string }).errorCode
        : null;
    return code === 'P1001' || code === 'P1002' || code === 'P1017';
  }

  return false;
};

const getRetryDelayMs = (attempt: number): number => {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = env.STATE_COMMAND_QUEUE_RETRY_BASE_MS * 2 ** Math.max(0, safeAttempt - 1);
  const capped = Math.min(env.STATE_COMMAND_QUEUE_RETRY_MAX_MS, exponential);
  const jitter = 0.12;
  const jitterFactor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(env.STATE_COMMAND_QUEUE_RETRY_BASE_MS, Math.round(capped * jitterFactor));
};

export class StateCommandQueueService {
  private readonly stateService = new StateService();

  async enqueueCommand(
    commandInput: StateCommandInput,
    context?: RequestContext
  ): Promise<StateCommandJobSnapshot> {
    const command = normalizeCommandInput(commandInput);
    if (!isQueueableCommandType(command.type)) {
      throw new HttpError(
        422,
        `Comando ${command.type} não permitido na fila assíncrona neste rollout conservador.`
      );
    }

    const existing = await prisma.stateCommandJob.findUnique({
      where: { commandId: command.commandId! },
    });
    if (existing) {
      return toJobSnapshot(existing);
    }

    try {
      const created = await prisma.stateCommandJob.create({
        data: {
          commandId: command.commandId!,
          commandType: command.type,
          payloadJson: command as unknown as Prisma.InputJsonValue,
          status: STATE_COMMAND_JOB_STATUS.PENDING,
          attempts: 0,
          maxAttempts: env.STATE_COMMAND_QUEUE_MAX_ATTEMPTS,
          nextAttemptAt: new Date(),
          actorUserId: context?.actorUserId,
          requestId: context?.requestId,
        },
      });

      return toJobSnapshot(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const deduplicated = await prisma.stateCommandJob.findUnique({
          where: { commandId: command.commandId! },
        });
        if (deduplicated) {
          return toJobSnapshot(deduplicated);
        }
      }
      throw error;
    }
  }

  async getJobById(jobId: string): Promise<StateCommandJobSnapshot> {
    const job = await prisma.stateCommandJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new HttpError(404, 'Job assíncrono não encontrado.');
    }
    return toJobSnapshot(job);
  }

  async processPendingBatch(workerId: string): Promise<number> {
    await this.requeueStaleProcessingJobs();
    let processed = 0;

    for (let index = 0; index < env.STATE_COMMAND_QUEUE_BATCH_SIZE; index += 1) {
      const claimed = await this.claimNextJob(workerId);
      if (!claimed) break;
      processed += 1;
      await this.processClaimedJob(claimed, workerId);
    }

    return processed;
  }

  private async requeueStaleProcessingJobs(): Promise<void> {
    const staleBefore = new Date(Date.now() - env.STATE_COMMAND_QUEUE_STALE_LOCK_MS);
    await prisma.stateCommandJob.updateMany({
      where: {
        status: STATE_COMMAND_JOB_STATUS.PROCESSING,
        lockedAt: { lt: staleBefore },
      },
      data: {
        status: STATE_COMMAND_JOB_STATUS.RETRY,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: 'Job reencaminhado após timeout de worker.',
      },
    });
  }

  private async claimNextJob(workerId: string) {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS_PER_CYCLE; attempt += 1) {
      const now = new Date();
      const candidate = await prisma.stateCommandJob.findFirst({
        where: {
          status: {
            in: [STATE_COMMAND_JOB_STATUS.PENDING, STATE_COMMAND_JOB_STATUS.RETRY],
          },
          nextAttemptAt: { lte: now },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      if (!candidate) return null;

      const claimed = await prisma.stateCommandJob.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attempts: candidate.attempts,
          nextAttemptAt: candidate.nextAttemptAt,
        },
        data: {
          status: STATE_COMMAND_JOB_STATUS.PROCESSING,
          attempts: { increment: 1 },
          lockedAt: now,
          lockedBy: workerId,
          startedAt: candidate.startedAt ?? now,
          lastError: null,
        },
      });

      if (claimed.count !== 1) {
        continue;
      }

      const locked = await prisma.stateCommandJob.findUnique({
        where: { id: candidate.id },
      });
      if (!locked) return null;
      return locked;
    }

    return null;
  }

  private async processClaimedJob(
    job: {
      id: string;
      commandId: string;
      commandType: string;
      payloadJson: Prisma.JsonValue;
      status: string;
      attempts: number;
      maxAttempts: number;
      actorUserId: string | null;
      requestId: string | null;
    },
    workerId: string
  ): Promise<void> {
    try {
      const parsedCommand = stateCommandSchema.parse(job.payloadJson);
      if (!parsedCommand.commandId || parsedCommand.commandId !== job.commandId) {
        throw new HttpError(409, 'Payload do job assíncrono está inconsistente com commandId.');
      }
      if (!isQueueableCommandType(parsedCommand.type)) {
        throw new HttpError(422, `Comando ${parsedCommand.type} não suportado pelo worker.`);
      }

      const snapshot = await this.stateService.applyCommandAgainstLatest(parsedCommand, {
        requestId: job.requestId || `queue-job:${job.id}`,
        origin: 'SYSTEM',
        actorUserId: job.actorUserId || undefined,
      });

      await prisma.stateCommandJob.update({
        where: { id: job.id },
        data: {
          status: STATE_COMMAND_JOB_STATUS.COMPLETED,
          lockedAt: null,
          lockedBy: null,
          finishedAt: new Date(),
          lastError: null,
          resultVersion: snapshot.version,
        },
      });
    } catch (error) {
      const retryable = isRetryableWorkerError(error);
      const errorMessage = truncateErrorMessage(normalizeErrorMessage(error));
      const canRetry = retryable && job.attempts < job.maxAttempts;

      if (canRetry) {
        const retryAt = new Date(Date.now() + getRetryDelayMs(job.attempts));
        await prisma.stateCommandJob.update({
          where: { id: job.id },
          data: {
            status: STATE_COMMAND_JOB_STATUS.RETRY,
            nextAttemptAt: retryAt,
            lockedAt: null,
            lockedBy: null,
            lastError: errorMessage,
          },
        });
        return;
      }

      await prisma.stateCommandJob.update({
        where: { id: job.id },
        data: {
          status: STATE_COMMAND_JOB_STATUS.FAILED,
          lockedAt: null,
          lockedBy: null,
          finishedAt: new Date(),
          lastError: errorMessage,
        },
      });
    } finally {
      await prisma.stateCommandJob.updateMany({
        where: {
          id: job.id,
          status: STATE_COMMAND_JOB_STATUS.PROCESSING,
          lockedBy: workerId,
        },
        data: {
          status: STATE_COMMAND_JOB_STATUS.RETRY,
          nextAttemptAt: new Date(Date.now() + getRetryDelayMs(Math.max(1, job.attempts))),
          lockedAt: null,
          lockedBy: null,
          lastError: 'Job retornou ao estado de retry por finalização incompleta do worker.',
        },
      });
    }
  }
}
