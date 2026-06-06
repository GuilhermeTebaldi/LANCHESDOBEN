import { Router } from 'express';

import { appStateRouter } from './state.routes.js';
import { authRouter } from './auth.routes.js';
import { ingredientRouter } from './ingredient.routes.js';
import { productRouter } from './product.routes.js';
import { cleaningMaterialRouter } from './cleaning-material.routes.js';
import { sessionRouter } from './session.routes.js';
import { saleRouter } from './sale.routes.js';
import { reportRouter } from './report.routes.js';
import { auditRouter } from './audit.routes.js';
import { errorMonitorRouter } from './error-monitor.routes.js';
import { checkoutV2Router } from './checkout-v2.routes.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/state', appStateRouter);
apiRouter.use('/ingredients', ingredientRouter);
apiRouter.use('/products', productRouter);
apiRouter.use('/cleaning-materials', cleaningMaterialRouter);
apiRouter.use('/sessions', sessionRouter);
apiRouter.use('/sales', saleRouter);
apiRouter.use('/reports', reportRouter);
apiRouter.use('/audit', auditRouter);
apiRouter.use('/errors', errorMonitorRouter);
apiRouter.use('/checkout', checkoutV2Router);
