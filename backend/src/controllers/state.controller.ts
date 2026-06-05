import type { Request, Response } from 'express';

import { issueStateWriteToken } from '../services/state-auth.service.js';
import { AppStateSnapshot, StateService } from '../services/state.service.js';
import { HttpError, isHttpError } from '../utils/http-error.js';
import {
  buildStateCommandRequestMeta,
  commandIdentifiersFromInput,
  logStateCommandIngressEvent,
} from '../utils/state-command-observability.js';
import { stateCommandSchema } from '../validators/state-command.validator.js';

const stateService = new StateService();

const normalizeVersion = (raw: string): string =>
  raw.trim().replace(/^W\//i, '').replace(/^"(.+)"$/, '$1');

const readIfMatchVersion = (req: Request): string => {
  const header = req.header('if-match');
  if (!header) {
    throw new HttpError(428, 'Cabeçalho If-Match é obrigatório para escrita de estado.');
  }

  const version = normalizeVersion(header);
  if (!version) {
    throw new HttpError(400, 'Cabeçalho If-Match inválido.');
  }
  return version;
};

const setStateHeaders = (req: Request, res: Response, version: string): void => {
  const token = issueStateWriteToken({
    version,
    actorUserId: req.context.actorUserId,
  });

  res.setHeader('ETag', `"${version}"`);
  res.setHeader('X-State-Version', version);
  res.setHeader('X-State-Token', token);
};

const normalizeResponseModeQueryValue = (value: unknown): string => {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (!Array.isArray(value)) return '';
  for (const entry of value) {
    if (typeof entry === 'string') {
      return entry.trim().toLowerCase();
    }
  }
  return '';
};

const shouldReturnHeadersOnly = (req: Request): boolean => {
  const headerValue = req.header('X-State-Response-Mode')?.trim().toLowerCase() || '';
  if (headerValue === 'headers-only') return true;
  const queryValue = normalizeResponseModeQueryValue(req.query.responseMode);
  return queryValue === 'headers-only';
};

const setStateCommandDiagnosticHeaders = (
  res: Response,
  snapshot: AppStateSnapshot,
  commandType: string | null
): void => {
  const diagnostics = snapshot.diagnostics;
  res.setHeader('X-State-Read-Ms', String(diagnostics?.readStateMs ?? 0));
  res.setHeader('X-State-Apply-Ms', String(diagnostics?.applyCommandMs ?? 0));
  res.setHeader('X-State-Persist-Ms', String(diagnostics?.persistMs ?? 0));
  res.setHeader('X-State-Audit-Ms', String(diagnostics?.auditMs ?? 0));
  res.setHeader('X-State-Size-Bytes', String(diagnostics?.stateSizeBytes ?? 0));
  res.setHeader('X-State-Command-Type', diagnostics?.commandType ?? commandType ?? '');
};

export const stateController = {
  headState: async (req: Request, res: Response) => {
    const version = await stateService.getAppStateVersion();
    setStateHeaders(req, res, version);
    res.status(204).end();
  },

  getState: async (req: Request, res: Response) => {
    const snapshot = await stateService.getAppState();
    setStateHeaders(req, res, snapshot.version);
    res.status(200).json(snapshot.state);
  },

  putState: async (req: Request, res: Response) => {
    const expectedVersion = readIfMatchVersion(req);
    if (req.stateTokenVersion && req.stateTokenVersion !== expectedVersion) {
      throw new HttpError(412, 'Token de estado desatualizado para a versão informada.', {
        tokenVersion: req.stateTokenVersion,
        expectedVersion,
      });
    }

    const snapshot = await stateService.saveAppState(req.body, expectedVersion, req.context);
    setStateHeaders(req, res, snapshot.version);
    res.status(200).json(snapshot.state);
  },

  clearState: async (req: Request, res: Response) => {
    const expectedVersion = readIfMatchVersion(req);
    if (req.stateTokenVersion && req.stateTokenVersion !== expectedVersion) {
      throw new HttpError(412, 'Token de estado desatualizado para a versão informada.', {
        tokenVersion: req.stateTokenVersion,
        expectedVersion,
      });
    }

    const snapshot = await stateService.clearAppState(expectedVersion, req.context);
    setStateHeaders(req, res, snapshot.version);
    res.status(200).json(snapshot.state);
  },

  runCommand: async (req: Request, res: Response) => {
    const backendProcessingStartedAtMs = Date.now();
    const setBackendProcessingHeader = (): void => {
      const elapsedMs = Math.max(0, Date.now() - backendProcessingStartedAtMs);
      res.setHeader('X-Backend-Processing-Ms', String(elapsedMs));
    };
    const requestMeta = buildStateCommandRequestMeta(req);
    const rawCommandIdentifiers = commandIdentifiersFromInput(req.body);
    logStateCommandIngressEvent({
      ...requestMeta,
      origin: 'sync',
      phase: 'received',
      ...rawCommandIdentifiers,
    });

    let fallbackApplied = false;
    try {
      const expectedVersion = readIfMatchVersion(req);
      if (req.stateTokenVersion && req.stateTokenVersion !== expectedVersion) {
        throw new HttpError(412, 'Token de estado desatualizado para a versão informada.', {
          tokenVersion: req.stateTokenVersion,
          expectedVersion,
        });
      }

      const command = stateCommandSchema.parse(req.body);
      const commandIdentifiers = commandIdentifiersFromInput(command);
      let snapshot;
      try {
        snapshot = await stateService.applyCommand(command, expectedVersion, req.context);
      } catch (error) {
        const isVersionConflict =
          isHttpError(error) && (error.statusCode === 412 || error.statusCode === 428);
        if (!isVersionConflict) {
          throw error;
        }
        // Conservative fallback: commands are reapplied against latest snapshot to prevent
        // front-end stalls under optimistic version races between concurrent terminals.
        fallbackApplied = true;
        snapshot = await stateService.applyCommandAgainstLatest(command, req.context);
      }
      setStateHeaders(req, res, snapshot.version);
      setStateCommandDiagnosticHeaders(res, snapshot, commandIdentifiers.commandType);
      if (shouldReturnHeadersOnly(req)) {
        setBackendProcessingHeader();
        logStateCommandIngressEvent({
          ...requestMeta,
          origin: 'sync',
          phase: 'completed',
          statusCode: 204,
          fallbackApplied,
          ...commandIdentifiers,
        });
        res.status(204).end();
        return;
      }
      setBackendProcessingHeader();
      logStateCommandIngressEvent({
        ...requestMeta,
        origin: 'sync',
        phase: 'completed',
        statusCode: 200,
        fallbackApplied,
        ...commandIdentifiers,
      });
      res.status(200).json(snapshot.state);
      return;
    } catch (error) {
      logStateCommandIngressEvent({
        ...requestMeta,
        origin: 'sync',
        phase: 'failed',
        statusCode: isHttpError(error) ? error.statusCode : 500,
        fallbackApplied,
        ...rawCommandIdentifiers,
        errorMessage: error instanceof Error ? error.message : 'Falha desconhecida ao processar comando.',
      });
      throw error;
    }
  },
};
