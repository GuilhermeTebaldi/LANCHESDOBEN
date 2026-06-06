import 'dotenv/config';

import { z } from 'zod';

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default(''),
  DEFAULT_TIMEZONE: z.string().default('America/Sao_Paulo'),
  APP_STATE_TX_MAX_WAIT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
  APP_STATE_TX_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300000).default(20000),
  APP_STATE_BEST_EFFORT_BACKUP_MIN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60000)
    .default(2500),
  APP_STATE_BACKUP_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(35),
  APP_STATE_BACKUP_SCHEDULER_ENABLED: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return true;
      const normalized = value.trim().toLowerCase();
      return !['0', 'false', 'off', 'no'].includes(normalized);
    }),
  APP_STATE_BACKUP_CHECK_INTERVAL_MS: z.coerce.number().int().min(60000).max(86400000).default(3600000),
  STATE_COMMAND_QUEUE_WORKER_ENABLED: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return true;
      const normalized = value.trim().toLowerCase();
      return !['0', 'false', 'off', 'no'].includes(normalized);
    }),
  STATE_COMMAND_QUEUE_ENABLE_FINALIZE: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return false;
      const normalized = value.trim().toLowerCase();
      return ['1', 'true', 'on', 'yes'].includes(normalized);
    }),
  STATE_COMMAND_QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(1000),
  STATE_COMMAND_QUEUE_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(6),
  STATE_COMMAND_QUEUE_STALE_LOCK_MS: z.coerce.number().int().min(60000).max(86400000).default(300000),
  STATE_COMMAND_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
  STATE_COMMAND_QUEUE_RETRY_BASE_MS: z.coerce.number().int().min(500).max(600000).default(3000),
  STATE_COMMAND_QUEUE_RETRY_MAX_MS: z.coerce.number().int().min(5000).max(86400000).default(300000),
  FAST_CHECKOUT_V2_ENABLED: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return false;
      const normalized = value.trim().toLowerCase();
      return ['1', 'true', 'on', 'yes'].includes(normalized);
    }),
  ERROR_MONITOR_PASSWORD: z.string().min(4).default('admin1234'),
});

const authEnvSchema = z.object({
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('12h'),
});

const parseOrThrow = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  scope?: string
): z.infer<TSchema> => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const scopeSuffix = scope ? ` (${scope})` : '';
    console.error(`Variáveis de ambiente inválidas${scopeSuffix}:`, parsed.error.flatten().fieldErrors);
    throw new Error(`Falha ao validar variáveis de ambiente${scopeSuffix}`);
  }
  return parsed.data;
};

const parsedBase = parseOrThrow(baseEnvSchema, 'base');

const corsOrigins = parsedBase.CORS_ORIGINS.split(',')
  .map((origin: string) => origin.trim())
  .filter(Boolean);

export const env = {
  ...parsedBase,
  corsOrigins,
};

let cachedAuthEnv: z.infer<typeof authEnvSchema> | null = null;

export const getAuthEnv = () => {
  if (cachedAuthEnv) {
    return cachedAuthEnv;
  }

  cachedAuthEnv = parseOrThrow(authEnvSchema, 'auth');
  return cachedAuthEnv;
};
