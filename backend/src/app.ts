import cors, { type CorsOptions } from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env.js';
import { errorMiddleware } from './middlewares/error.middleware.js';
import { notFoundMiddleware } from './middlewares/not-found.middleware.js';
import { requestContextMiddleware } from './middlewares/request-context.middleware.js';
import { apiRouter } from './routes/index.js';

const app = express();
const localhostOriginPattern = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (localhostOriginPattern.test(origin)) {
        callback(null, true);
        return;
      }

      if (env.corsOrigins.length === 0 || env.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    }) satisfies CorsOptions['origin'],
    credentials: true,
    maxAge: 86400,
    exposedHeaders: ['ETag', 'X-State-Version', 'X-State-Token'],
  })
);
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(requestContextMiddleware);

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/api/v1', apiRouter);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export { app };
