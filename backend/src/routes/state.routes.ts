import { Router } from 'express';

import { stateController } from '../controllers/state.controller.js';
import { stateCommandQueueController } from '../controllers/state-command-queue.controller.js';
import { stateReadAuth, stateWriteAuth } from '../middlewares/state-auth.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';

export const appStateRouter = Router();

appStateRouter.head('/', stateReadAuth, asyncHandler(stateController.headState));
appStateRouter.get('/', stateReadAuth, asyncHandler(stateController.getState));
appStateRouter.get('/drafts/:draftId/status', stateReadAuth, asyncHandler(stateController.getDraftStatus));
appStateRouter.put('/', stateWriteAuth, asyncHandler(stateController.putState));
appStateRouter.delete('/', stateWriteAuth, asyncHandler(stateController.clearState));
appStateRouter.post('/commands', stateWriteAuth, asyncHandler(stateController.runCommand));
appStateRouter.post('/commands/async', stateWriteAuth, asyncHandler(stateCommandQueueController.enqueue));
appStateRouter.get(
  '/commands/jobs/:jobId',
  stateWriteAuth,
  asyncHandler(stateCommandQueueController.getById)
);
