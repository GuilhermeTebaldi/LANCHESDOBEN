import 'dotenv/config';

import { z } from 'zod';

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default(''),
  DEFAULT_TIMEZONE: z.string().default('America/Sao_Paulo'),
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
