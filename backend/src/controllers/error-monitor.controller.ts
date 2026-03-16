import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { AuditService } from '../services/audit.service.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';
import { z } from 'zod';

const errorMonitorEventSchema = z.object({
  source: z.string().trim().min(1).max(120).default('frontend'),
  level: z.enum(['error', 'warn', 'info']).default('error'),
  message: z.string().trim().min(1).max(4000),
  statusCode: z.coerce.number().int().min(100).max(599).optional(),
  requestId: z.string().trim().max(120).optional(),
  path: z.string().trim().max(500).optional(),
  stack: z.string().trim().max(12000).optional(),
  context: z.record(z.unknown()).optional(),
});

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_EVENTS = 180;
const reportRateByIp = new Map<string, { windowStartedAt: number; count: number }>();

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
    const requestIp =
      req.context?.ipAddress?.trim() ||
      req.ip?.trim() ||
      (typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress.trim() : '') ||
      'unknown';
    if (isReportRateLimited(requestIp)) {
      throw new HttpError(429, 'Muitos eventos de erro enviados. Aguarde alguns segundos.');
    }

    const payload = errorMonitorEventSchema.parse(req.body);

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
};
