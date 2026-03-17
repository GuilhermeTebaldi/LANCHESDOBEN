import { app } from './app.js';
import { env, getAuthEnv } from './config/env.js';
import { prisma } from './db/prisma.js';
import {
  startStateCommandQueueWorker,
  stopStateCommandQueueWorker,
} from './jobs/state-command-queue.worker.js';
import { startStateBackupScheduler, stopStateBackupScheduler } from './jobs/state-backup.scheduler.js';

getAuthEnv();

const server = app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${env.PORT}`);
});

startStateBackupScheduler();
startStateCommandQueueWorker();

void prisma
  .$connect()
  .then(async () => {
    await prisma.$queryRaw`SELECT 1`;
  })
  .catch(() => {
    // fallback to Prisma lazy connect on first request
  });

const shutdown = () => {
  stopStateBackupScheduler();
  stopStateCommandQueueWorker();
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
