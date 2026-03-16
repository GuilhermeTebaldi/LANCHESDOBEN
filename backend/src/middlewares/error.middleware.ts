import type { NextFunction, Request, Response } from 'express';

import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

import { env } from '../config/env.js';
import { HttpError, isHttpError } from '../utils/http-error.js';

export const errorMiddleware = (error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'Payload inválido',
      details: error.flatten(),
      requestId: req.context?.requestId,
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      res.status(409).json({
        error: 'Conflito de unicidade no banco de dados.',
        meta: error.meta,
        requestId: req.context?.requestId,
      });
      return;
    }

    if (error.code === 'P2025') {
      res.status(404).json({
        error: 'Registro não encontrado.',
        requestId: req.context?.requestId,
      });
      return;
    }

    if (error.code === 'P2024' || error.code === 'P2034') {
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

  res.status(httpError.statusCode).json({
    error: httpError.message,
    details: httpError.details,
    requestId: req.context?.requestId,
  });
};
