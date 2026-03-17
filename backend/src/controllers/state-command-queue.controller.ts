import type { Request, Response } from 'express';

import {
  normalizeJobStatus,
  StateCommandQueueService,
  type StateCommandJobSnapshot,
} from '../services/state-command-queue.service.js';
import { stateCommandSchema } from '../validators/state-command.validator.js';

const queueService = new StateCommandQueueService();

const toApiJob = (job: StateCommandJobSnapshot) => ({
  id: job.id,
  commandId: job.commandId,
  commandType: job.commandType,
  status: normalizeJobStatus(job.status),
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  nextAttemptAt: job.nextAttemptAt,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  lastError: job.lastError,
  resultVersion: job.resultVersion,
});

export const stateCommandQueueController = {
  enqueue: async (req: Request, res: Response) => {
    const command = stateCommandSchema.parse(req.body);
    const job = await queueService.enqueueCommand(command, req.context);
    res.status(202).json({
      job: toApiJob(job),
    });
  },

  getById: async (req: Request, res: Response) => {
    const job = await queueService.getJobById(req.params.jobId);
    res.status(200).json({
      job: toApiJob(job),
    });
  },
};
