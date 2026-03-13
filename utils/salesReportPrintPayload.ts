const SALES_REPORT_PRINT_PAYLOAD_KEY_PREFIX = 'qb_sales_report_print_payload_v1:';
const SALES_REPORT_PRINT_PAYLOAD_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SALES_REPORT_PRINT_WINDOW_NAME_PREFIX = 'qb_sales_report_print_payload_window_v1:';
const SALES_REPORT_PRINT_HASH_PARAM = 'srp';

export interface SalesReportPrintPayload {
  id: string;
  createdAt: number;
  title: string;
  paperWidthMm: number;
  pageWidthMm: number;
  pageHeightMm: number | null;
  reportPadding: string;
  reportFontSizePx: number;
  reportLineHeight: number;
  reportFontWeight: number;
  reportLines: string[];
}

export interface SalesReportPrintPayloadInput {
  title: string;
  paperWidthMm: number;
  pageWidthMm: number;
  pageHeightMm: number | null;
  reportPadding: string;
  reportFontSizePx: number;
  reportLineHeight: number;
  reportFontWeight: number;
  reportLines: string[];
}

const buildStorageKey = (payloadId: string): string =>
  `${SALES_REPORT_PRINT_PAYLOAD_KEY_PREFIX}${payloadId}`;

const createPayloadId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const cleanupExpiredPayloads = (): void => {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const keysToDelete: string[] = [];

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(SALES_REPORT_PRINT_PAYLOAD_KEY_PREFIX)) continue;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      keysToDelete.push(key);
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<SalesReportPrintPayload>;
      const createdAt = isFiniteNumber(parsed.createdAt) ? parsed.createdAt : 0;
      if (now - createdAt > SALES_REPORT_PRINT_PAYLOAD_MAX_AGE_MS) {
        keysToDelete.push(key);
      }
    } catch {
      keysToDelete.push(key);
    }
  }

  keysToDelete.forEach((key) => {
    window.localStorage.removeItem(key);
  });
};

const normalizePayload = (value: unknown): SalesReportPrintPayload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  if (typeof source.id !== 'string' || !source.id.trim()) return null;
  if (!isFiniteNumber(source.createdAt)) return null;
  if (typeof source.title !== 'string') return null;
  if (!isFiniteNumber(source.paperWidthMm) || source.paperWidthMm <= 0) return null;
  if (!isFiniteNumber(source.pageWidthMm) || source.pageWidthMm <= 0) return null;
  if (
    source.pageHeightMm !== null &&
    source.pageHeightMm !== undefined &&
    (!isFiniteNumber(source.pageHeightMm) || source.pageHeightMm <= 0)
  ) {
    return null;
  }
  if (typeof source.reportPadding !== 'string') return null;
  if (!isFiniteNumber(source.reportFontSizePx) || source.reportFontSizePx <= 0) return null;
  if (!isFiniteNumber(source.reportLineHeight) || source.reportLineHeight <= 0) return null;
  if (!isFiniteNumber(source.reportFontWeight) || source.reportFontWeight <= 0) return null;
  if (!Array.isArray(source.reportLines) || source.reportLines.some((line) => typeof line !== 'string')) {
    return null;
  }

  return {
    id: source.id,
    createdAt: source.createdAt,
    title: source.title,
    paperWidthMm: source.paperWidthMm,
    pageWidthMm: source.pageWidthMm,
    pageHeightMm:
      source.pageHeightMm === null || source.pageHeightMm === undefined ? null : source.pageHeightMm,
    reportPadding: source.reportPadding,
    reportFontSizePx: source.reportFontSizePx,
    reportLineHeight: source.reportLineHeight,
    reportFontWeight: source.reportFontWeight,
    reportLines: source.reportLines,
  };
};

const encodeWindowNamePayload = (payload: SalesReportPrintPayload): string => {
  const serialized = JSON.stringify(payload);
  return `${SALES_REPORT_PRINT_WINDOW_NAME_PREFIX}${encodeURIComponent(serialized)}`;
};

const decodeWindowNamePayload = (windowName: string): SalesReportPrintPayload | null => {
  if (!windowName.startsWith(SALES_REPORT_PRINT_WINDOW_NAME_PREFIX)) return null;
  const encodedPayload = windowName.slice(SALES_REPORT_PRINT_WINDOW_NAME_PREFIX.length);
  if (!encodedPayload) return null;
  try {
    return normalizePayload(JSON.parse(decodeURIComponent(encodedPayload)));
  } catch {
    return null;
  }
};

const encodePayload = (payload: SalesReportPrintPayload): string =>
  encodeURIComponent(JSON.stringify(payload));

const decodePayload = (encodedPayload: string): SalesReportPrintPayload | null => {
  if (!encodedPayload) return null;
  try {
    return normalizePayload(JSON.parse(decodeURIComponent(encodedPayload)));
  } catch {
    return null;
  }
};

export const saveSalesReportPrintPayload = (
  input: SalesReportPrintPayloadInput
): SalesReportPrintPayload | null => {
  if (typeof window === 'undefined') return null;
  cleanupExpiredPayloads();

  const payload: SalesReportPrintPayload = {
    id: createPayloadId(),
    createdAt: Date.now(),
    title: input.title,
    paperWidthMm: input.paperWidthMm,
    pageWidthMm: input.pageWidthMm,
    pageHeightMm: input.pageHeightMm,
    reportPadding: input.reportPadding,
    reportFontSizePx: input.reportFontSizePx,
    reportLineHeight: input.reportLineHeight,
    reportFontWeight: input.reportFontWeight,
    reportLines: input.reportLines,
  };

  try {
    window.localStorage.setItem(buildStorageKey(payload.id), JSON.stringify(payload));
    return payload;
  } catch {
    return null;
  }
};

export const consumeSalesReportPrintPayload = (payloadId: string): SalesReportPrintPayload | null => {
  if (typeof window === 'undefined') return null;
  const normalizedId = payloadId.trim();
  if (!normalizedId) return null;

  const storageKey = buildStorageKey(normalizedId);
  const raw = window.localStorage.getItem(storageKey);
  if (raw) {
    try {
      const parsed = normalizePayload(JSON.parse(raw));
      if (parsed?.id === normalizedId) return parsed;
    } catch {
      // ignore malformed storage payload and fallback to window name payload
    }
  }

  const fromWindowName = decodeWindowNamePayload(window.name || '');
  if (fromWindowName?.id === normalizedId) return fromWindowName;

  const hashRaw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashParams = new URLSearchParams(hashRaw);
  const hashPayloadEncoded = hashParams.get(SALES_REPORT_PRINT_HASH_PARAM);
  if (!hashPayloadEncoded) return null;
  const fromHash = decodePayload(hashPayloadEncoded);
  if (!fromHash || fromHash.id !== normalizedId) return null;
  return fromHash;
};

export const removeSalesReportPrintPayload = (payloadId: string): void => {
  if (typeof window === 'undefined') return;
  const normalizedId = payloadId.trim();
  if (!normalizedId) return;
  window.localStorage.removeItem(buildStorageKey(normalizedId));

  const fromWindowName = decodeWindowNamePayload(window.name || '');
  if (fromWindowName?.id === normalizedId) {
    window.name = '';
  }
};

export const setSalesReportPrintPayloadOnWindow = (
  targetWindow: Window,
  payload: SalesReportPrintPayload
): void => {
  try {
    targetWindow.name = encodeWindowNamePayload(payload);
  } catch {
    // ignore window name write failures
  }
};

export const buildSalesReportPrintHashPayload = (payload: SalesReportPrintPayload): string =>
  `${SALES_REPORT_PRINT_HASH_PARAM}=${encodePayload(payload)}`;
