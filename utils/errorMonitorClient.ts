const DEFAULT_API_BASE_URL = 'https://xburger-backend.onrender.com';
const REPORT_TIMEOUT_MS = 7000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_STACK_LENGTH = 12000;
const RECENT_EVENT_WINDOW_MS = 8000;
const MAX_RECENT_EVENTS = 500;
const MONITOR_INSTALL_KEY = '__xburger_error_monitor_installed__';

type ErrorMonitorLevel = 'error' | 'warn' | 'info';

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

const postEvent = (payload: ErrorMonitorEventPayload): void => {
  if (typeof window === 'undefined') return;
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
