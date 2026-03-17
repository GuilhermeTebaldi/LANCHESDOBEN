import { Prisma } from '@prisma/client';

import { isHttpError } from './http-error.js';

const DATABASE_UNAVAILABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1017']);
const DATABASE_UNAVAILABLE_MESSAGE_PATTERNS = [
  "can't reach database server",
  'connection timed out',
  'database system is not yet accepting connections',
  'consistent recovery state has not been yet reached',
  'the database system is starting up',
  'server has closed the connection',
  'connection terminated unexpectedly',
  'connection reset by peer',
  'connection refused',
];

export interface DatabaseUnavailableInfo {
  reason: string;
  prismaCode: string | null;
}

const normalizeMessage = (error: unknown): string =>
  error instanceof Error ? (error.message || '').toLowerCase() : '';

const matchDatabaseUnavailableMessage = (message: string): string | null => {
  for (const pattern of DATABASE_UNAVAILABLE_MESSAGE_PATTERNS) {
    if (message.includes(pattern)) {
      return pattern;
    }
  }
  return null;
};

export const classifyDatabaseUnavailableError = (
  error: unknown
): DatabaseUnavailableInfo | null => {
  if (isHttpError(error) && error.statusCode === 503) {
    const normalizedMessage = normalizeMessage(error);
    const matchedPattern = matchDatabaseUnavailableMessage(normalizedMessage);
    if (matchedPattern || normalizedMessage.includes('banco temporariamente indisponível')) {
      return {
        reason: matchedPattern ? `http-503:${matchedPattern}` : 'http-503:database-unavailable',
        prismaCode: null,
      };
    }
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (DATABASE_UNAVAILABLE_PRISMA_CODES.has(error.code)) {
      return { reason: `prisma-known:${error.code}`, prismaCode: error.code };
    }
    const matchedPattern = matchDatabaseUnavailableMessage(normalizeMessage(error));
    if (matchedPattern) {
      return { reason: `prisma-known:${matchedPattern}`, prismaCode: error.code ?? null };
    }
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    const errorCode =
      typeof (error as { errorCode?: unknown }).errorCode === 'string'
        ? (error as { errorCode: string }).errorCode
        : null;
    if (errorCode && DATABASE_UNAVAILABLE_PRISMA_CODES.has(errorCode)) {
      return { reason: `prisma-init:${errorCode}`, prismaCode: errorCode };
    }
    const matchedPattern = matchDatabaseUnavailableMessage(normalizeMessage(error));
    if (matchedPattern) {
      return { reason: `prisma-init:${matchedPattern}`, prismaCode: errorCode };
    }
  }

  if (
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Error
  ) {
    const matchedPattern = matchDatabaseUnavailableMessage(normalizeMessage(error));
    if (matchedPattern) {
      return { reason: `message:${matchedPattern}`, prismaCode: null };
    }
  }

  return null;
};

export const isDatabaseUnavailableError = (error: unknown): boolean =>
  classifyDatabaseUnavailableError(error) !== null;
