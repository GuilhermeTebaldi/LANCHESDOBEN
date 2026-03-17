import type { NextFunction, Request, Response } from 'express';

import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { AuditService } from '../services/audit.service.js';
import { HttpError, isHttpError } from '../utils/http-error.js';

interface BackendErrorMonitorInput {
  level: 'error' | 'warn' | 'info';
  message: string;
  statusCode: number;
  details?: unknown;
  stack?: string;
}

const DATABASE_UNAVAILABLE_MESSAGE_PATTERNS = [
  "can't reach database server",
  'connection timed out',
  'server has closed the connection',
  'database system is not yet accepting connections',
  'consistent recovery state has not been yet reached',
  'connection reset by peer',
];

const isExpectedStateVersionConflict = (req: Request, statusCode: number, message: string): boolean => {
  if (statusCode !== 412) return false;
  const path = (req.originalUrl || req.url || '').toLowerCase();
  if (!path.includes('/api/v1/state/commands')) return false;
  const normalizedMessage = (message || '').toLowerCase();
  return normalizedMessage.includes('conflito de versão') || normalizedMessage.includes('token de estado');
};

const isExpectedErrorMonitorAuthFailure = (req: Request, statusCode: number, message: string): boolean => {
  if (statusCode !== 401) return false;
  const path = (req.originalUrl || req.url || '').toLowerCase();
  if (!path.includes('/api/v1/errors/events')) return false;
  const normalizedMessage = (message || '').toLowerCase();
  return normalizedMessage.includes('senha inválida para monitor de erros');
};

const isKnownDatabaseUnavailableError = (error: Prisma.PrismaClientKnownRequestError): boolean => {
  const normalizedMessage = (error.message || '').toLowerCase();
  return (
    error.code === 'P1001' ||
    error.code === 'P1002' ||
    error.code === 'P1017' ||
    DATABASE_UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) =>
      normalizedMessage.includes(pattern)
    )
  );
};

const isUnknownDatabaseUnavailableError = (
  error: Prisma.PrismaClientUnknownRequestError
): boolean => {
  const normalizedMessage = (error.message || '').toLowerCase();
  return DATABASE_UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) =>
    normalizedMessage.includes(pattern)
  );
};

const shouldSkipPersistingErrorMonitorEvent = (input: BackendErrorMonitorInput): boolean => {
  if (input.statusCode !== 503) return false;
  const normalizedMessage = (input.message || '').toLowerCase();
  return (
    normalizedMessage.includes('banco temporariamente indisponível') ||
    normalizedMessage.includes('banco temporariamente ocupado')
  );
};

const reportBackendErrorEvent = (req: Request, input: BackendErrorMonitorInput): void => {
  if (shouldSkipPersistingErrorMonitorEvent(input)) {
    return;
  }

  const requestPath = `${req.method.toUpperCase()} ${req.originalUrl || req.url || ''}`.trim();
  void new AuditService(prisma)
    .log(
      {
        entityName: 'error_monitor',
        entityId: 'backend',
        action: 'BACKEND_ERROR_REPORTED',
        metadata: {
          level: input.level,
          message: input.message,
          statusCode: input.statusCode,
          path: requestPath,
          stack: input.stack || null,
          context: {
            details: input.details ?? null,
            requestBodyKeys:
              req.body && typeof req.body === 'object' && !Array.isArray(req.body)
                ? Object.keys(req.body as Record<string, unknown>).slice(0, 30)
                : null,
          },
          reportedAt: new Date().toISOString(),
        },
      },
      req.context
    )
    .catch((auditError: unknown) => {
      if (env.NODE_ENV === 'test') return;
      // eslint-disable-next-line no-console
      console.error('[error-monitor]', {
        message: 'Falha ao gravar evento de erro no monitor.',
        requestId: req.context?.requestId,
        cause: auditError instanceof Error ? auditError.message : String(auditError),
      });
    });
};

export const errorMiddleware = (error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    reportBackendErrorEvent(req, {
      level: 'warn',
      message: 'Payload inválido',
      statusCode: 400,
      details: error.flatten(),
    });
    res.status(400).json({
      error: 'Payload inválido',
      details: error.flatten(),
      requestId: req.context?.requestId,
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (isKnownDatabaseUnavailableError(error)) {
      reportBackendErrorEvent(req, {
        level: 'error',
        message: 'Banco temporariamente indisponível. Tente novamente em instantes.',
        statusCode: 503,
        details: { prismaCode: error.code || null },
      });
      res.status(503).json({
        error: 'Banco temporariamente indisponível. Tente novamente em instantes.',
        requestId: req.context?.requestId,
      });
      return;
    }

    if (error.code === 'P2002') {
      reportBackendErrorEvent(req, {
        level: 'warn',
        message: 'Conflito de unicidade no banco de dados.',
        statusCode: 409,
        details: error.meta,
      });
      res.status(409).json({
        error: 'Conflito de unicidade no banco de dados.',
        meta: error.meta,
        requestId: req.context?.requestId,
      });
      return;
    }

    if (error.code === 'P2025') {
      reportBackendErrorEvent(req, {
        level: 'warn',
        message: 'Registro não encontrado.',
        statusCode: 404,
      });
      res.status(404).json({
        error: 'Registro não encontrado.',
        requestId: req.context?.requestId,
      });
      return;
    }

    if (error.code === 'P2024' || error.code === 'P2034') {
      reportBackendErrorEvent(req, {
        level: 'error',
        message: 'Banco temporariamente ocupado. Tente novamente em instantes.',
        statusCode: 503,
        details: { prismaCode: error.code },
      });
      res.status(503).json({
        error: 'Banco temporariamente ocupado. Tente novamente em instantes.',
        requestId: req.context?.requestId,
      });
      return;
    }
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    const errorCode =
      typeof (error as { errorCode?: unknown }).errorCode === 'string'
        ? (error as { errorCode: string }).errorCode
        : null;
    if (errorCode === 'P1001' || errorCode === 'P1002' || errorCode === 'P1017') {
      reportBackendErrorEvent(req, {
        level: 'error',
        message: 'Banco temporariamente indisponível. Tente novamente em instantes.',
        statusCode: 503,
        details: { prismaCode: errorCode },
        stack: error.stack,
      });
      res.status(503).json({
        error: 'Banco temporariamente indisponível. Tente novamente em instantes.',
        requestId: req.context?.requestId,
      });
      return;
    }
  }

  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    if (isUnknownDatabaseUnavailableError(error)) {
      reportBackendErrorEvent(req, {
        level: 'error',
        message: 'Banco temporariamente indisponível. Tente novamente em instantes.',
        statusCode: 503,
      });
      res.status(503).json({
        error: 'Banco temporariamente indisponível. Tente novamente em instantes.',
        requestId: req.context?.requestId,
      });
      return;
    }
  }

  const httpError = isHttpError(error) ? error : new HttpError(500, 'Erro interno do servidor.');

  if (env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.error('[error]', {
      message: httpError.message,
      statusCode: httpError.statusCode,
      details: httpError.details,
      requestId: req.context?.requestId,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  reportBackendErrorEvent(req, {
    level:
      isExpectedErrorMonitorAuthFailure(req, httpError.statusCode, httpError.message) ||
      isExpectedStateVersionConflict(req, httpError.statusCode, httpError.message)
      ? 'info'
      : httpError.statusCode >= 500
        ? 'error'
        : 'warn',
    message: httpError.message,
    statusCode: httpError.statusCode,
    details: httpError.details,
    stack: error instanceof Error ? error.stack : undefined,
  });

  res.status(httpError.statusCode).json({
    error: httpError.message,
    details: httpError.details,
    requestId: req.context?.requestId,
  });
};
