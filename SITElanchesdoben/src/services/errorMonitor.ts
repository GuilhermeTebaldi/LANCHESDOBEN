const DEFAULT_API_BASE_URL = 'https://xburger-backend.onrender.com';
const REPORT_TIMEOUT_MS = 7000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_STACK_LENGTH = 12000;
const RECENT_EVENT_WINDOW_MS = 8000;
const MONITOR_INSTALL_KEY = '__xburger_site_error_monitor_installed__';

export interface ErrorMonitorEntry {
  id: string;
  createdAt: string;
  source: string;
  action: string;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: {
    level?: 'error' | 'warn' | 'info';
    message?: string;
    statusCode?: number | null;
    path?: string | null;
    stack?: string | null;
    context?: Record<string, unknown> | null;
    reportedAt?: string | null;
  } | null;
}

export interface ClearErrorEventsResult {
  ok: boolean;
  deletedCount: number;
  clearAll: boolean;
  olderThanDays: number | null;
  olderThanDate: string | null;
  source: string | null;
}

interface ReportErrorInput {
  source: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  statusCode?: number;
  requestId?: string;
  path?: string;
  stack?: string;
  context?: Record<string, unknown>;
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

const resolveEventsUrl = (): string => `${resolveApiBaseUrl()}/api/v1/errors/events`;

const currentPath = (): string => {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search || ''}`;
};

const shouldSkipRepeatedEvent = (payload: ReportErrorInput): boolean => {
  const now = Date.now();
  const key = [
    payload.source,
    payload.level,
    payload.message,
    payload.path || '',
    payload.statusCode ?? '',
  ].join('|');

  const previous = recentEvents.get(key);
  recentEvents.set(key, now);

  if (recentEvents.size > 500) {
    const minAllowed = now - RECENT_EVENT_WINDOW_MS;
    for (const [entryKey, entryTime] of recentEvents.entries()) {
      if (entryTime < minAllowed) {
        recentEvents.delete(entryKey);
      }
      if (recentEvents.size <= 500) break;
    }
  }

  return !!previous && now - previous < RECENT_EVENT_WINDOW_MS;
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

const postErrorEvent = (payload: ReportErrorInput): void => {
  if (typeof window === 'undefined') return;
  if (shouldSkipRepeatedEvent(payload)) return;

  const body = JSON.stringify(payload);
  const url = resolveEventsUrl();

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

export const reportErrorEvent = (input: ReportErrorInput): void => {
  const message = normalizeText(input.message, MAX_MESSAGE_LENGTH);
  if (!message) return;

  postErrorEvent({
    source: normalizeText(input.source, 120) || 'site',
    level: input.level || 'error',
    message,
    statusCode: input.statusCode,
    requestId: normalizeText(input.requestId, 120),
    path: normalizeText(input.path, 500) || currentPath(),
    stack: normalizeText(input.stack, MAX_STACK_LENGTH),
    context: input.context,
  });
};

export const installGlobalErrorMonitor = (sourcePrefix = 'site'): void => {
  if (typeof window === 'undefined') return;

  const host = window as Window & { [MONITOR_INSTALL_KEY]?: boolean };
  if (host[MONITOR_INSTALL_KEY]) return;
  host[MONITOR_INSTALL_KEY] = true;

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
      const normalized = normalizeErrorLike(
        (errorEvent.error ?? errorEvent.message) || fallbackMessage
      );
      reportErrorEvent({
        source: `${sourcePrefix}:window.error`,
        level: 'error',
        message: normalized.message,
        path: normalizeText(errorEvent.filename, 500) || currentPath(),
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
    reportErrorEvent({
      source: `${sourcePrefix}:unhandledrejection`,
      level: 'error',
      message: normalized.message,
      stack: normalized.stack,
      path: currentPath(),
    });
  });

  console.error = (...args: unknown[]) => {
    const firstErrorArg = args.find((arg) => arg instanceof Error);
    const normalized = normalizeErrorLike(firstErrorArg ?? args[0] ?? 'console.error sem mensagem');
    reportErrorEvent({
      source: `${sourcePrefix}:console.error`,
      level: 'error',
      message: normalized.message,
      stack: normalized.stack,
      path: currentPath(),
      context: {
        argsPreview: args.slice(0, 4).map((entry) => {
          if (typeof entry === 'string') return entry.slice(0, 500);
          if (entry instanceof Error) return entry.message || entry.name;
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

export const fetchErrorEvents = async (
  password: string,
  options: { limit?: number; source?: string } = {}
): Promise<ErrorMonitorEntry[]> => {
  const normalizedPassword = password.trim();
  if (!normalizedPassword) {
    throw new Error('Senha obrigatória.');
  }

  const query = new URLSearchParams();
  query.set('limit', String(Math.min(Math.max(options.limit ?? 250, 1), 500)));
  if (options.source?.trim()) {
    query.set('source', options.source.trim());
  }

  const response = await fetch(`${resolveEventsUrl()}?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'x-monitor-password': normalizedPassword,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Senha inválida.');
    }
    throw new Error(`Falha ao carregar eventos (${response.status}).`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.filter((entry): entry is ErrorMonitorEntry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.createdAt === 'string' &&
      typeof candidate.source === 'string' &&
      typeof candidate.action === 'string'
    );
  });
};

export const clearErrorEvents = async (
  password: string,
  options: { olderThanDays?: number; source?: string; clearAll?: boolean } = {}
): Promise<ClearErrorEventsResult> => {
  const normalizedPassword = password.trim();
  if (!normalizedPassword) {
    throw new Error('Senha obrigatória.');
  }

  const response = await fetch(resolveEventsUrl(), {
    method: 'DELETE',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-monitor-password': normalizedPassword,
    },
    body: JSON.stringify({
      olderThanDays:
        typeof options.olderThanDays === 'number' && Number.isFinite(options.olderThanDays)
          ? Math.min(Math.max(Math.floor(options.olderThanDays), 1), 3650)
          : undefined,
      source: options.source?.trim() || undefined,
      clearAll: options.clearAll === true,
    }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Senha inválida.');
    }
    throw new Error(`Falha ao limpar eventos (${response.status}).`);
  }

  const payload = (await response.json()) as Partial<ClearErrorEventsResult>;
  return {
    ok: payload.ok === true,
    deletedCount:
      typeof payload.deletedCount === 'number' && Number.isFinite(payload.deletedCount)
        ? Math.max(0, Math.floor(payload.deletedCount))
        : 0,
    clearAll: payload.clearAll === true,
    olderThanDays:
      typeof payload.olderThanDays === 'number' && Number.isFinite(payload.olderThanDays)
        ? payload.olderThanDays
        : null,
    olderThanDate: typeof payload.olderThanDate === 'string' ? payload.olderThanDate : null,
    source: typeof payload.source === 'string' ? payload.source : null,
  };
};
