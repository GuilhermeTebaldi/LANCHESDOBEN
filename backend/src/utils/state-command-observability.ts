import type { Request } from 'express';

import type { StateCommandInput } from '../validators/state-command.validator.js';

export type StateCommandIngressOrigin = 'sync' | 'async' | 'async-worker';
export type StateCommandIngressPhase = 'received' | 'accepted' | 'completed' | 'failed';

interface StateCommandRequestMeta {
  requestId: string | null;
  userAgent: string | null;
  actorUserId: string | null;
  ipAddress: string | null;
}

interface StateCommandIngressEvent extends StateCommandRequestMeta {
  origin: StateCommandIngressOrigin;
  phase: StateCommandIngressPhase;
  statusCode?: number | null;
  commandType?: string | null;
  commandId?: string | null;
  draftId?: string | null;
  jobId?: string | null;
  fallbackApplied?: boolean;
  errorMessage?: string | null;
}

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
};

const asCommandRecord = (command: unknown): Record<string, unknown> | null => {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  return command as Record<string, unknown>;
};

export const resolveStateCommandType = (command: unknown): string | null => {
  const record = asCommandRecord(command);
  if (!record) return null;
  return normalizeText(record.type);
};

export const resolveStateCommandId = (command: unknown): string | null => {
  const record = asCommandRecord(command);
  if (!record) return null;
  return normalizeText(record.commandId);
};

export const resolveStateCommandDraftId = (command: unknown): string | null => {
  const record = asCommandRecord(command);
  if (!record) return null;
  return normalizeText(record.draftId);
};

export const buildStateCommandRequestMeta = (req: Request): StateCommandRequestMeta => ({
  requestId: normalizeText(req.context?.requestId),
  userAgent: normalizeText(req.context?.userAgent || req.header('user-agent')),
  actorUserId: normalizeText(req.context?.actorUserId),
  ipAddress: normalizeText(req.context?.ipAddress || req.ip),
});

export const buildStateCommandJobMeta = (input: {
  requestId?: string | null;
  actorUserId?: string | null;
}): StateCommandRequestMeta => ({
  requestId: normalizeText(input.requestId),
  userAgent: null,
  actorUserId: normalizeText(input.actorUserId),
  ipAddress: null,
});

export const logStateCommandIngressEvent = (event: StateCommandIngressEvent): void => {
  // eslint-disable-next-line no-console
  console.info('[state-command-ingress]', event);
};

export const commandIdentifiersFromInput = (
  command: StateCommandInput | unknown
): { commandType: string | null; commandId: string | null; draftId: string | null } => ({
  commandType: resolveStateCommandType(command),
  commandId: resolveStateCommandId(command),
  draftId: resolveStateCommandDraftId(command),
});
