import type { ReceiptPrintPayloadData } from './receiptPrintPayload';

export type ReceiptPrintMode = 'BROWSER' | 'WINDOWS_AGENT';

export interface ReceiptPrintModeSettings {
  mode: ReceiptPrintMode;
  agentUrl: string;
  printerName: string;
  fallbackToBrowser: boolean;
  agentToken: string;
}

export interface LocalPrintConnectionStatus {
  ok: boolean;
  agentOnline: boolean;
  printerFound: boolean;
  printers: string[];
  agentVersion: string | null;
  message: string | null;
}

export interface LocalPrintDispatchResult {
  ok: boolean;
  printed: boolean;
  code: string;
  message: string;
}

const DEFAULT_AGENT_URL = 'http://127.0.0.1:18181';
const DEFAULT_PRINTER_NAME = 'EPSON TM-T20';
const DEFAULT_TIMEOUT_MS = 3500;

const withTimeout = async <T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const normalizeAgentUrl = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return DEFAULT_AGENT_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_AGENT_URL;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    const normalized = parsed.toString().replace(/\/+$/, '');
    return normalized || DEFAULT_AGENT_URL;
  } catch {
    return DEFAULT_AGENT_URL;
  }
};

const normalizePrinterName = (value: unknown): string => {
  if (typeof value !== 'string') return DEFAULT_PRINTER_NAME;
  const trimmed = value.trim();
  return trimmed || DEFAULT_PRINTER_NAME;
};

const normalizeToken = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const ensureArrayOfStrings = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
};

const createHeaders = (token: string): HeadersInit => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['x-local-print-token'] = token;
  }
  return headers;
};

const isAbortError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError');

export const createDefaultReceiptPrintModeSettings = (): ReceiptPrintModeSettings => ({
  mode: 'BROWSER',
  agentUrl: DEFAULT_AGENT_URL,
  printerName: DEFAULT_PRINTER_NAME,
  fallbackToBrowser: true,
  agentToken: '',
});

export const normalizeReceiptPrintModeSettings = (
  value: Partial<ReceiptPrintModeSettings> | null | undefined
): ReceiptPrintModeSettings => {
  const defaults = createDefaultReceiptPrintModeSettings();
  const mode = value?.mode === 'WINDOWS_AGENT' ? 'WINDOWS_AGENT' : 'BROWSER';
  const fallbackToBrowser = value?.fallbackToBrowser ?? defaults.fallbackToBrowser;
  return {
    mode,
    agentUrl: normalizeAgentUrl(value?.agentUrl),
    printerName: normalizePrinterName(value?.printerName),
    fallbackToBrowser: Boolean(fallbackToBrowser),
    agentToken: normalizeToken(value?.agentToken),
  };
};

const fetchAgentJson = async (
  settings: ReceiptPrintModeSettings,
  path: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null; message: string | null }> => {
  const endpoint = `${settings.agentUrl}${path}`;
  try {
    const response = await withTimeout((signal) =>
      fetch(endpoint, {
        ...init,
        signal,
        headers: {
          ...createHeaders(settings.agentToken),
          ...(init.headers || {}),
        },
      })
    );

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    const message =
      typeof parsed?.message === 'string' && parsed.message.trim()
        ? parsed.message.trim()
        : response.ok
          ? null
          : `HTTP ${response.status}`;

    return {
      ok: response.ok,
      status: response.status,
      data: parsed,
      message,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      message: isAbortError(error)
        ? 'Timeout ao conectar com o agente local.'
        : 'Agente local offline ou inacessível.',
    };
  }
};

export const testLocalPrintAgentConnection = async (
  settingsInput: ReceiptPrintModeSettings
): Promise<LocalPrintConnectionStatus> => {
  const settings = normalizeReceiptPrintModeSettings(settingsInput);
  const health = await fetchAgentJson(settings, '/health', {
    method: 'GET',
  });

  if (!health.ok) {
    return {
      ok: false,
      agentOnline: false,
      printerFound: false,
      printers: [],
      agentVersion: null,
      message: health.message || 'Agente local offline.',
    };
  }

  const printersResponse = await fetchAgentJson(settings, '/printers', {
    method: 'GET',
  });

  if (!printersResponse.ok) {
    return {
      ok: false,
      agentOnline: true,
      printerFound: false,
      printers: [],
      agentVersion:
        typeof health.data?.version === 'string' ? (health.data.version as string) : null,
      message: printersResponse.message || 'Falha ao consultar impressoras no agente local.',
    };
  }

  const printersData = ensureArrayOfStrings(printersResponse.data?.printers);
  const printerFound = printersData.some(
    (name) => name.toLocaleLowerCase() === settings.printerName.toLocaleLowerCase()
  );

  return {
    ok: true,
    agentOnline: true,
    printerFound,
    printers: printersData,
    agentVersion:
      typeof health.data?.version === 'string' ? (health.data.version as string) : null,
    message: printerFound ? null : 'Impressora configurada não foi encontrada no agente.',
  };
};

export const printReceiptViaLocalAgent = async (
  settingsInput: ReceiptPrintModeSettings,
  receipt: ReceiptPrintPayloadData
): Promise<LocalPrintDispatchResult> => {
  const settings = normalizeReceiptPrintModeSettings(settingsInput);
  const response = await fetchAgentJson(settings, '/print/receipt', {
    method: 'POST',
    body: JSON.stringify({
      printerName: settings.printerName,
      receipt,
    }),
  });

  if (!response.ok) {
    return {
      ok: false,
      printed: false,
      code: 'agent_print_failed',
      message: response.message || 'Falha ao imprimir no agente local.',
    };
  }

  return {
    ok: true,
    printed: Boolean(response.data?.printed),
    code: 'printed',
    message:
      typeof response.data?.message === 'string' && response.data.message.trim()
        ? (response.data.message as string)
        : 'Cupom enviado para a impressora local.',
  };
};

export const printTestViaLocalAgent = async (
  settingsInput: ReceiptPrintModeSettings
): Promise<LocalPrintDispatchResult> => {
  const settings = normalizeReceiptPrintModeSettings(settingsInput);
  const response = await fetchAgentJson(settings, '/print/test', {
    method: 'POST',
    body: JSON.stringify({
      printerName: settings.printerName,
    }),
  });

  if (!response.ok) {
    return {
      ok: false,
      printed: false,
      code: 'agent_test_failed',
      message: response.message || 'Falha ao imprimir teste no agente local.',
    };
  }

  return {
    ok: true,
    printed: Boolean(response.data?.printed),
    code: 'printed',
    message:
      typeof response.data?.message === 'string' && response.data.message.trim()
        ? (response.data.message as string)
        : 'Teste enviado para a impressora local.',
  };
};
