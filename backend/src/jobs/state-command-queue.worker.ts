import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import { StateCommandQueueService } from '../services/state-command-queue.service.js';

const queueService = new StateCommandQueueService();
const workerId = `state-command-worker:${process.pid}:${randomUUID().slice(0, 8)}`;

let queueWorkerHandle: NodeJS.Timeout | null = null;
let queueCycleRunning = false;

const runQueueCycle = async (): Promise<void> => {
  if (queueCycleRunning) return;
  queueCycleRunning = true;
  try {
    const processed = await queueService.processPendingBatch(workerId);
    if (processed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[state-command-queue] worker=${workerId} processed=${processed}`);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[state-command-queue] cycle failed', error);
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
