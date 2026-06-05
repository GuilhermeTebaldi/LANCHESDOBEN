import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { AuditService } from '../services/audit.service.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';
import { z } from 'zod';

const OPERATIONAL_EVENT_SOURCE_PREFIX = 'sistema:ops:event:';
const OPERATIONAL_EVENT_TYPES = [
  'OPS_HEALTH',
  'HEALTH_SNAPSHOT',
  'QUEUE_HEALTH',
  'FAILSAFE_ACTIVATED',
  'FAILSAFE_CLEARED',
  'BACKPRESSURE',
  'PAYMENT_FLOW',
  'COMMAND_SKIPPED_OBSOLETE',
  'CART_REMOVE_LOCAL_PENDING',
  'CART_REMOVE_REMOTE',
  'PENDING_ADD_CANCELLED',
] as const;

const operationalEventTypeSchema = z.enum(OPERATIONAL_EVENT_TYPES);

const operationalEventSchema = z.object({
  id: z.string().trim().min(1).max(120),
  type: operationalEventTypeSchema,
  message: z.string().trim().min(1).max(4000),
  timestamp: z.string().trim().min(1).max(80),
  context: z.record(z.unknown()).optional(),
});

const errorMonitorEventSchema = z.object({
  source: z.string().trim().min(1).max(120).default('frontend'),
  level: z.enum(['error', 'warn', 'info', 'debug']).default('error'),
  message: z.string().trim().min(1).max(4000),
  statusCode: z.coerce.number().int().min(100).max(599).optional(),
  requestId: z.string().trim().max(120).optional(),
  path: z.string().trim().max(500).optional(),
  stack: z.string().trim().max(12000).optional(),
  context: z.record(z.unknown()).optional(),
});

const clearMonitorEventsSchema = z.object({
  source: z.string().trim().min(1).max(120).optional(),
  olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
  clearAll: z.coerce.boolean().optional(),
});

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_EVENTS = 180;
const reportRateByIp = new Map<string, { windowStartedAt: number; count: number }>();

const normalizeString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    return normalized.slice(0, maxLength);
  }
  return normalized;
};

const shouldIgnoreFrontendErrorReport = (
  payload: z.infer<typeof errorMonitorEventSchema>
): boolean => {
  if (payload.level === 'info' || payload.level === 'debug') return true;
  if (payload.message.includes('Snapshot operacional')) return true;
  if (payload.message.includes('Fila atualizada')) return true;
  if (payload.level !== 'error' && payload.message.includes('Fail-safe de backend liberado')) {
    return true;
  }
  return false;
};

const parseOperationalEventFromMetadata = (
  metadata: Prisma.JsonValue | null
): z.infer<typeof operationalEventSchema> | null => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const metadataRecord = metadata as Record<string, unknown>;
  const metadataContext = metadataRecord.context;
  if (!metadataContext || typeof metadataContext !== 'object' || Array.isArray(metadataContext)) {
    return null;
  }
  const contextRecord = metadataContext as Record<string, unknown>;
  const rawEvent = contextRecord.operationalPanelEvent;
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
    return null;
  }
  const parsed = operationalEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return null;
  }
  if (Number.isNaN(Date.parse(parsed.data.timestamp))) {
    return null;
  }
  return parsed.data;
};

const requireMonitorPassword = (req: Request): void => {
  const providedPassword = req.header('x-monitor-password')?.trim() || '';
  if (!providedPassword || providedPassword !== env.ERROR_MONITOR_PASSWORD) {
    throw new HttpError(401, 'Senha inválida para monitor de erros.');
  }
};

const isReportRateLimited = (ipAddress: string): boolean => {
  const now = Date.now();
  const previous = reportRateByIp.get(ipAddress);
  if (!previous || now - previous.windowStartedAt > RATE_LIMIT_WINDOW_MS) {
    reportRateByIp.set(ipAddress, { windowStartedAt: now, count: 1 });
    return false;
  }

  previous.count += 1;
  if (previous.count <= RATE_LIMIT_MAX_EVENTS) {
    reportRateByIp.set(ipAddress, previous);
    return false;
  }

  return true;
};

export const errorMonitorController = {
  report: async (req: Request, res: Response) => {
    const payload = errorMonitorEventSchema.parse(req.body);

    if (shouldIgnoreFrontendErrorReport(payload)) {
      res.status(202).json({ ok: true, skipped: true });
      return;
    }

    const requestIp =
      req.context?.ipAddress?.trim() ||
      req.ip?.trim() ||
      (typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress.trim() : '') ||
      'unknown';
    if (isReportRateLimited(requestIp)) {
      throw new HttpError(429, 'Muitos eventos de erro enviados. Aguarde alguns segundos.');
    }

    await new AuditService(prisma).log(
      {
        entityName: 'error_monitor',
        entityId: payload.source,
        action: 'FRONTEND_ERROR_REPORTED',
        metadata: {
          level: payload.level,
          message: payload.message,
          statusCode: payload.statusCode ?? null,
          requestId: payload.requestId ?? null,
          path: payload.path ?? null,
          stack: payload.stack ?? null,
          context: payload.context ? (payload.context as Prisma.InputJsonValue) : null,
          reportedAt: new Date().toISOString(),
        },
      },
      req.context
    );

    res.status(201).json({ ok: true });
  },

  list: async (req: Request, res: Response) => {
    requireMonitorPassword(req);

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 200;
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';

    const rows = await prisma.auditLog.findMany({
      where: {
        entityName: 'error_monitor',
        entityId: source || undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.status(200).json(
      rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        source: row.entityId,
        action: row.action,
        requestId: row.requestId,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        metadata: row.metadata,
      }))
    );
  },

  listOperationalEvents: async (req: Request, res: Response) => {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 200) : 60;
    const queryTake = Math.min(limit * 5, 1000);

    const rows = await prisma.auditLog.findMany({
      where: {
        entityName: 'error_monitor',
        entityId: {
          startsWith: OPERATIONAL_EVENT_SOURCE_PREFIX,
        },
        action: 'FRONTEND_ERROR_REPORTED',
      },
      orderBy: { createdAt: 'desc' },
      take: queryTake,
    });

    const items = rows
      .map((row) => {
        const event = parseOperationalEventFromMetadata(row.metadata);
        if (!event) return null;
        const sourceClientId = normalizeString(
          row.entityId.slice(OPERATIONAL_EVENT_SOURCE_PREFIX.length),
          120
        );
        const metadataRecord =
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : null;
        const metadataContext =
          metadataRecord &&
          metadataRecord.context &&
          typeof metadataRecord.context === 'object' &&
          !Array.isArray(metadataRecord.context)
            ? (metadataRecord.context as Record<string, unknown>)
            : null;
        const contextClientId = metadataContext ? normalizeString(metadataContext.clientId, 120) : null;
        const clientId = contextClientId || sourceClientId;

        return {
          id: event.id,
          type: event.type,
          message: event.message,
          timestamp: event.timestamp,
          context: event.context ?? null,
          source: row.entityId,
          createdAt: row.createdAt,
          requestId: row.requestId,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          clientId,
        };
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> =>
          entry !== null
      )
      .slice(0, limit);

    res.status(200).json(items);
  },

  clear: async (req: Request, res: Response) => {
    requireMonitorPassword(req);

    const payload = clearMonitorEventsSchema.parse(req.body ?? {});
    const shouldClearAll = payload.clearAll === true;
    const olderThanDays = payload.olderThanDays ?? 30;

    const where: Prisma.AuditLogWhereInput = {
      entityName: 'error_monitor',
    };

    if (payload.source) {
      where.entityId = payload.source;
    }

    let olderThanDate: Date | null = null;
    if (!shouldClearAll) {
      olderThanDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
      where.createdAt = { lt: olderThanDate };
    }

    const deleted = await prisma.auditLog.deleteMany({ where });

    res.status(200).json({
      ok: true,
      deletedCount: deleted.count,
      clearAll: shouldClearAll,
      olderThanDays: shouldClearAll ? null : olderThanDays,
      olderThanDate: shouldClearAll ? null : olderThanDate?.toISOString() ?? null,
      source: payload.source ?? null,
    });
  },
};
