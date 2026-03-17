import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import { classifyDatabaseUnavailableError } from '../utils/database-unavailable.js';
import {
  StateCommandQueueService,
} from '../services/state-command-queue.service.js';

const queueService = new StateCommandQueueService();
const workerId = `state-command-worker:${process.pid}:${randomUUID().slice(0, 8)}`;

let queueWorkerHandle: NodeJS.Timeout | null = null;
let queueCycleRunning = false;
let dbUnavailableFailureStreak = 0;
let nextCycleNotBeforeMs = 0;
let dbUnavailableSinceMs: number | null = null;

const DB_OUTAGE_BACKOFF_MAX_MS = 90_000;
const DB_OUTAGE_BACKOFF_JITTER_FACTOR = 0.22;

const getDbOutageBackoffMs = (failureStreak: number): number => {
  const safeStreak = Math.max(1, Math.floor(failureStreak));
  const baseDelayMs = Math.max(env.STATE_COMMAND_QUEUE_POLL_INTERVAL_MS, 1_500);
  const exponential = baseDelayMs * 2 ** Math.max(0, safeStreak - 1);
  const capped = Math.min(DB_OUTAGE_BACKOFF_MAX_MS, exponential);
  const jitter =
    1 + (Math.random() * 2 - 1) * DB_OUTAGE_BACKOFF_JITTER_FACTOR;
  return Math.max(baseDelayMs, Math.round(capped * jitter));
};

const runQueueCycle = async (): Promise<void> => {
  if (queueCycleRunning) return;
  if (Date.now() < nextCycleNotBeforeMs) return;
  queueCycleRunning = true;
  try {
    const processed = await queueService.processPendingBatch(workerId);
    if (dbUnavailableFailureStreak > 0) {
      const downtimeMs = dbUnavailableSinceMs ? Date.now() - dbUnavailableSinceMs : 0;
      // eslint-disable-next-line no-console
      console.log(
        `[state-command-queue] database connectivity restored; resuming cycles (streak=${dbUnavailableFailureStreak}, downtimeMs=${downtimeMs})`
      );
    }
    dbUnavailableFailureStreak = 0;
    nextCycleNotBeforeMs = 0;
    dbUnavailableSinceMs = null;
    if (processed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[state-command-queue] worker=${workerId} processed=${processed}`);
    }
  } catch (error) {
    const databaseUnavailable = classifyDatabaseUnavailableError(error);
    if (databaseUnavailable) {
      dbUnavailableFailureStreak += 1;
      if (!dbUnavailableSinceMs) {
        dbUnavailableSinceMs = Date.now();
      }
      const backoffMs = getDbOutageBackoffMs(dbUnavailableFailureStreak);
      nextCycleNotBeforeMs = Date.now() + backoffMs;
      // eslint-disable-next-line no-console
      console.warn(
        `[state-command-queue] database unavailable; reason=${databaseUnavailable.reason} streak=${dbUnavailableFailureStreak} nextDelayMs=${backoffMs}`
      );
    } else {
      dbUnavailableFailureStreak = 0;
      nextCycleNotBeforeMs = 0;
      dbUnavailableSinceMs = null;
    }
    if (!databaseUnavailable) {
      // eslint-disable-next-line no-console
      console.error('[state-command-queue] cycle failed', error);
    }
  } finally {
    queueCycleRunning = false;
  }
};

export const startStateCommandQueueWorker = (): void => {
  if (!env.STATE_COMMAND_QUEUE_WORKER_ENABLED) {
    // eslint-disable-next-line no-console
    console.log('[state-command-queue] worker disabled by STATE_COMMAND_QUEUE_WORKER_ENABLED');
    return;
  }

  const intervalMs = env.STATE_COMMAND_QUEUE_POLL_INTERVAL_MS;
  queueWorkerHandle = setInterval(() => {
    void runQueueCycle();
  }, intervalMs);
  queueWorkerHandle.unref?.();

  void runQueueCycle();
  // eslint-disable-next-line no-console
  console.log(`[state-command-queue] worker started id=${workerId} poll=${intervalMs}ms`);
};

export const stopStateCommandQueueWorker = (): void => {
  if (!queueWorkerHandle) return;
  clearInterval(queueWorkerHandle);
  queueWorkerHandle = null;
};
