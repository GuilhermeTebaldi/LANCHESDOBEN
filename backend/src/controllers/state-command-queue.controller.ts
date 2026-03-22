import type { Request, Response } from 'express';

import {
  normalizeJobStatus,
  StateCommandQueueService,
  type StateCommandJobSnapshot,
} from '../services/state-command-queue.service.js';
import { isHttpError } from '../utils/http-error.js';
import {
  buildStateCommandRequestMeta,
  commandIdentifiersFromInput,
  logStateCommandIngressEvent,
} from '../utils/state-command-observability.js';
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
    const requestMeta = buildStateCommandRequestMeta(req);
    const rawCommandIdentifiers = commandIdentifiersFromInput(req.body);
    logStateCommandIngressEvent({
      ...requestMeta,
      origin: 'async',
      phase: 'received',
      ...rawCommandIdentifiers,
    });

    try {
      const command = stateCommandSchema.parse(req.body);
      const commandIdentifiers = commandIdentifiersFromInput(command);
      const job = await queueService.enqueueCommand(command, req.context);
      logStateCommandIngressEvent({
        ...requestMeta,
        origin: 'async',
        phase: 'accepted',
        statusCode: 202,
        ...commandIdentifiers,
        jobId: job.id,
      });
      res.status(202).json({
        job: toApiJob(job),
      });
      return;
    } catch (error) {
      logStateCommandIngressEvent({
        ...requestMeta,
        origin: 'async',
        phase: 'failed',
        statusCode: isHttpError(error) ? error.statusCode : 500,
        ...rawCommandIdentifiers,
        errorMessage: error instanceof Error ? error.message : 'Falha desconhecida ao enfileirar comando.',
      });
      throw error;
    }
  },

  getById: async (req: Request, res: Response) => {
    const job = await queueService.getJobById(req.params.jobId);
    res.status(200).json({
      job: toApiJob(job),
    });
  },
};
