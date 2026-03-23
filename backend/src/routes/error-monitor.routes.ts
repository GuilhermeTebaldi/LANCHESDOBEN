import { Router } from 'express';

import { errorMonitorController } from '../controllers/error-monitor.controller.js';
import { asyncHandler } from '../utils/async-handler.js';

export const errorMonitorRouter = Router();

errorMonitorRouter.get('/ops/events', asyncHandler(errorMonitorController.listOperationalEvents));
errorMonitorRouter.get('/events', asyncHandler(errorMonitorController.list));
errorMonitorRouter.post('/events', asyncHandler(errorMonitorController.report));
errorMonitorRouter.delete('/events', asyncHandler(errorMonitorController.clear));
