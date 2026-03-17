const ASSISTANT_RETRY_BASE_DELAY_MS = 1400;
const ASSISTANT_RETRY_MAX_DELAY_MS = 90000;
const ASSISTANT_RECOVER_BASE_DELAY_MS = 1800;
const ASSISTANT_RECOVER_MAX_DELAY_MS = 45000;
const ASSISTANT_RECOVER_EVERY_ATTEMPTS = 3;
const ASSISTANT_DELAY_JITTER = 0.16;

const clampAttempts = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

const withJitter = (value: number): number => {
  const jitterFactor = 1 + (Math.random() * 2 - 1) * ASSISTANT_DELAY_JITTER;
  return Math.max(250, Math.round(value * jitterFactor));
};

export const getPaidSyncAssistantRetryDelayMs = (attempts: number): number => {
  const safeAttempts = clampAttempts(attempts);
  const exponential = ASSISTANT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, safeAttempts);
  const capped = Math.min(ASSISTANT_RETRY_MAX_DELAY_MS, exponential);
  return withJitter(capped);
};

export const getPaidSyncAssistantRecoverDelayMs = (attempts: number): number => {
  const safeAttempts = clampAttempts(attempts);
  const exponential = ASSISTANT_RECOVER_BASE_DELAY_MS * 2 ** Math.max(0, safeAttempts - 1);
  const capped = Math.min(ASSISTANT_RECOVER_MAX_DELAY_MS, exponential);
  return withJitter(capped);
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
