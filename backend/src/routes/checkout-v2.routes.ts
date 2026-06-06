import { Router } from 'express';

import { checkoutV2Controller } from '../controllers/checkout-v2.controller.js';
import { authRequired } from '../middlewares/auth.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';

export const checkoutV2Router = Router();

checkoutV2Router.post('/v2/confirm', authRequired, asyncHandler(checkoutV2Controller.confirm));
