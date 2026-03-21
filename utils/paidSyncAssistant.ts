const ASSISTANT_RETRY_DELAY_STEPS_MS = [
  5_000,
  10_000,
  20_000,
  40_000,
  60_000,
  120_000,
  300_000,
] as const;
const ASSISTANT_RECOVER_EVERY_ATTEMPTS = 3;

const clampAttempts = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

const resolveRetryDelayByAttempt = (attempts: number): number => {
  const safeAttempts = clampAttempts(attempts);
  const index = Math.min(
    ASSISTANT_RETRY_DELAY_STEPS_MS.length - 1,
    Math.max(0, safeAttempts)
  );
  return ASSISTANT_RETRY_DELAY_STEPS_MS[index];
};

export const getPaidSyncAssistantRetryDelayMs = (attempts: number): number => {
  return resolveRetryDelayByAttempt(attempts);
};

export const getPaidSyncAssistantRecoverDelayMs = (attempts: number): number => {
  const safeAttempts = clampAttempts(attempts);
  return resolveRetryDelayByAttempt(Math.max(0, safeAttempts - 1));
};

export const shouldPaidSyncAssistantRunRecovery = (
  attempts: number,
  isRecoverableError: boolean
): boolean => {
  if (!isRecoverableError) return false;
  const safeAttempts = clampAttempts(attempts);
  if (safeAttempts <= 0) return false;
  return safeAttempts % ASSISTANT_RECOVER_EVERY_ATTEMPTS === 0;
};

export const describePaidSyncAssistantMode = (
  mode: 'retrying' | 'recovering' | 'reconciling',
  detail?: string
): string => {
  if (mode === 'recovering') {
    return detail ? `Robô reconstruindo: ${detail}` : 'Robô reconstruindo pedido automaticamente';
  }
  if (mode === 'retrying') {
    return detail ? `Robô reprocessando: ${detail}` : 'Robô reprocessando fila automaticamente';
  }
  return detail ? `Robô conciliando: ${detail}` : 'Robô conciliando estado da fila';
};
