const DEFAULT_API_BASE_URL = 'https://xburger-backend.onrender.com';
const REPORT_TIMEOUT_MS = 7000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_STACK_LENGTH = 12000;
const RECENT_EVENT_WINDOW_MS = 8000;
const MAX_RECENT_EVENTS = 500;
const MONITOR_INSTALL_KEY = '__xburger_error_monitor_installed__';
const OPERATIONAL_EVENT_SOURCE_PREFIX = 'sistema:ops:event';
const OPERATIONAL_EVENTS_ENDPOINT_PATH = '/api/v1/errors/ops/events';

type ErrorMonitorLevel = 'error' | 'warn' | 'info' | 'debug';

interface ErrorMonitorEventPayload {
  source: string;
  level: ErrorMonitorLevel;
  message: string;
  statusCode?: number;
  requestId?: string;
  path?: string;
  stack?: string;
  context?: Record<string, unknown>;
}

type OperationalPanelEventType =
  | 'OPS_HEALTH'
  | 'HEALTH_SNAPSHOT'
  | 'QUEUE_HEALTH'
  | 'FAILSAFE_ACTIVATED'
  | 'FAILSAFE_CLEARED'
  | 'BACKPRESSURE'
  | 'PAYMENT_FLOW'
  | 'COMMAND_SKIPPED_OBSOLETE'
  | 'CART_REMOVE_LOCAL_PENDING'
  | 'CART_REMOVE_REMOTE'
  | 'PENDING_ADD_CANCELLED';

export interface OperationalPanelEventPayload {
  id: string;
  type: OperationalPanelEventType;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

interface ReportOperationalPanelEventInput {
  clientId: string;
  event: OperationalPanelEventPayload;
}

export interface OperationalPanelEventFeedEntry extends OperationalPanelEventPayload {
  source: string;
  createdAt: string;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  clientId: string | null;
}

const recentEvents = new Map<string, number>();

const normalizeText = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
};

const resolveApiBaseUrl = (): string => {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  const normalized = raw ? raw.replace(/\/+$/, '') : '';
  if (normalized) return normalized;
  return DEFAULT_API_BASE_URL;
};

const resolveErrorMonitorEndpoint = (): string => `${resolveApiBaseUrl()}/api/v1/errors/events`;
const resolveOperationalEventsEndpoint = (): string =>
  `${resolveApiBaseUrl()}${OPERATIONAL_EVENTS_ENDPOINT_PATH}`;

const currentPath = (): string => {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search || ''}`;
};

const trimRecentEvents = (now: number): void => {
  if (recentEvents.size <= MAX_RECENT_EVENTS) return;
  const minAllowedTs = now - RECENT_EVENT_WINDOW_MS;
  for (const [key, timestamp] of recentEvents.entries()) {
    if (timestamp < minAllowedTs) {
      recentEvents.delete(key);
    }
    if (recentEvents.size <= MAX_RECENT_EVENTS) break;
  }
};

const shouldSkipRepeatedEvent = (payload: ErrorMonitorEventPayload): boolean => {
  const now = Date.now();
  const key = [
    payload.source,
    payload.level,
    payload.message,
    payload.path || '',
    payload.statusCode ?? '',
  ].join('|');
  const previousTimestamp = recentEvents.get(key);
  recentEvents.set(key, now);
  trimRecentEvents(now);
  return !!previousTimestamp && now - previousTimestamp < RECENT_EVENT_WINDOW_MS;
};

const shouldSkipProductionTelemetry = (payload: ErrorMonitorEventPayload): boolean => {
  if (!import.meta.env.PROD) return false;
  const level = payload.level || 'error';
  const message = payload.message || '';
  if (level === 'info' || level === 'debug') return true;
  if (message.includes('Snapshot operacional')) return true;
  if (message.includes('Fila atualizada')) return true;
  if (level !== 'error' && message.includes('Fail-safe de backend liberado')) return true;
  return false;
};

const postEvent = (payload: ErrorMonitorEventPayload): void => {
  if (typeof window === 'undefined') return;
  if (shouldSkipProductionTelemetry(payload)) return;
  if (shouldSkipRepeatedEvent(payload)) return;

  const url = resolveErrorMonitorEndpoint();
  const body = JSON.stringify(payload);

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) {
        return;
      }
    } catch {
      // fallback to fetch
    }
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  void fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
    keepalive: true,
    cache: 'no-store',
    signal: controller.signal,
  }).catch(() => undefined)
    .finally(() => {
      window.clearTimeout(timeoutId);
    });
};

const normalizeErrorLike = (value: unknown): { message: string; stack?: string } => {
  if (value instanceof Error) {
    return {
      message: value.message || value.name || 'Erro desconhecido',
      stack: normalizeText(value.stack, MAX_STACK_LENGTH),
    };
  }
  if (typeof value === 'string') {
    return { message: value };
  }
  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
};

const buildConsoleMessage = (args: unknown[]): string => {
  const parts = args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.message || arg.name || 'Error';
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
  return parts.join(' | ').trim() || 'console.error sem mensagem';
};

export const reportErrorMonitorEvent = (input: ErrorMonitorEventPayload): void => {
  const message = normalizeText(input.message, MAX_MESSAGE_LENGTH);
  if (!message) return;
  postEvent({
    source: normalizeText(input.source, 120) || 'frontend',
    level: input.level || 'error',
    message,
    statusCode: input.statusCode,
    requestId: normalizeText(input.requestId, 120),
    path: normalizeText(input.path, 500) || currentPath(),
    stack: normalizeText(input.stack, MAX_STACK_LENGTH),
    context: input.context,
  });
};

export const reportOperationalPanelEvent = (input: ReportOperationalPanelEventInput): void => {
  const clientId = normalizeText(input.clientId, 120);
  if (!clientId) return;
  const eventId = normalizeText(input.event.id, 120);
  const eventMessage = normalizeText(input.event.message, MAX_MESSAGE_LENGTH);
  const eventTimestamp = normalizeText(input.event.timestamp, 80);
  if (!eventId || !eventMessage || !eventTimestamp || Number.isNaN(Date.parse(eventTimestamp))) {
    return;
  }
  reportErrorMonitorEvent({
    source: `${OPERATIONAL_EVENT_SOURCE_PREFIX}:${clientId}`,
    level: 'info',
    message: eventMessage,
    context: {
      clientId,
      operationalPanelEvent: {
        id: eventId,
        type: input.event.type,
        message: eventMessage,
        timestamp: eventTimestamp,
        context: input.event.context,
      },
    },
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const normalizeOperationalPanelFeedEntry = (value: unknown): OperationalPanelEventFeedEntry | null => {
  if (!isRecord(value)) return null;
  const id = normalizeText(value.id, 120);
  const type = normalizeText(value.type, 60);
  const message = normalizeText(value.message, MAX_MESSAGE_LENGTH);
  const timestamp = normalizeText(value.timestamp, 80);
  const source = normalizeText(value.source, 160);
  const createdAt = normalizeText(value.createdAt, 80);
  if (
    !id ||
    !type ||
    !message ||
    !timestamp ||
    Number.isNaN(Date.parse(timestamp)) ||
    !source ||
    !createdAt ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    return null;
  }
  const context = isRecord(value.context) ? value.context : undefined;
  return {
    id,
    type: type as OperationalPanelEventType,
    message,
    timestamp,
    context,
    source,
    createdAt,
    requestId: normalizeText(value.requestId, 120) || null,
    ipAddress: normalizeText(value.ipAddress, 64) || null,
    userAgent: normalizeText(value.userAgent, 512) || null,
    clientId: normalizeText(value.clientId, 120) || null,
  };
};

export const fetchOperationalPanelEvents = async (
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<OperationalPanelEventFeedEntry[]> => {
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.min(Math.max(Math.floor(options.limit), 1), 200)
      : 60;
  const query = new URLSearchParams({
    limit: String(limit),
  });
  const response = await fetch(`${resolveOperationalEventsEndpoint()}?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
    signal: options.signal,
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) return [];
  return payload
    .map((entry) => normalizeOperationalPanelFeedEntry(entry))
    .filter((entry): entry is OperationalPanelEventFeedEntry => entry !== null);
};

export const installGlobalErrorMonitor = (sourcePrefix = 'frontend'): void => {
  if (typeof window === 'undefined') return;

  const markerHost = window as Window & { [MONITOR_INSTALL_KEY]?: boolean };
  if (markerHost[MONITOR_INSTALL_KEY]) return;
  markerHost[MONITOR_INSTALL_KEY] = true;

  const originalConsoleError = console.error.bind(console);

  window.addEventListener(
    'error',
    (event: Event) => {
      const errorEvent = event as ErrorEvent;
      const target = event.target as (EventTarget & {
        tagName?: string;
        src?: string;
        href?: string;
      }) | null;
      const fallbackMessage =
        target && target !== window
          ? `Falha ao carregar recurso ${target.tagName || 'desconhecido'} ${target.src || target.href || ''}`.trim()
          : 'Erro de execução sem mensagem.';
      const rawError = 'error' in errorEvent ? errorEvent.error : undefined;
      const normalized = normalizeErrorLike((rawError ?? errorEvent.message) || fallbackMessage);
      const path = normalizeText(errorEvent.filename, 500) || currentPath();
      reportErrorMonitorEvent({
        source: `${sourcePrefix}:window.error`,
        level: 'error',
        message: normalized.message,
        path,
        stack: normalized.stack,
        context: {
          line: errorEvent.lineno || undefined,
          column: errorEvent.colno || undefined,
        },
      });
    },
    true
  );

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const normalized = normalizeErrorLike(event.reason);
    reportErrorMonitorEvent({
      source: `${sourcePrefix}:unhandledrejection`,
      level: 'error',
      message: normalized.message,
      path: currentPath(),
      stack: normalized.stack,
    });
  });

  console.error = (...args: unknown[]) => {
    const fallbackMessage = buildConsoleMessage(args);
    const firstErrorArg = args.find((arg) => arg instanceof Error);
    const normalized = normalizeErrorLike(firstErrorArg ?? fallbackMessage);
    reportErrorMonitorEvent({
      source: `${sourcePrefix}:console.error`,
      level: 'error',
      message: normalized.message || fallbackMessage,
      path: currentPath(),
      stack: normalized.stack,
      context: {
        argsPreview: args.slice(0, 4).map((entry) => {
          if (entry instanceof Error) return entry.message || entry.name;
          if (typeof entry === 'string') return entry.slice(0, 500);
          try {
            return JSON.stringify(entry).slice(0, 500);
          } catch {
            return String(entry).slice(0, 500);
          }
        }),
      },
    });
    originalConsoleError(...args);
  };
};
