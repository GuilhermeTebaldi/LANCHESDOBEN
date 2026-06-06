const RECEIPT_PRINT_PAYLOAD_KEY_PREFIX = 'qb_receipt_print_payload_v1:';
const RECEIPT_PRINT_PAYLOAD_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RECEIPT_PRINT_WINDOW_NAME_PREFIX = 'qb_receipt_print_payload_window_v1:';
const RECEIPT_PRINT_HASH_PARAM = 'rcp';

export interface ReceiptPrintPayloadLine {
  id: string;
  qty: number;
  name: string;
  unitPrice: number;
  subtotal: number;
  note?: string;
}

export interface ReceiptPrintPayloadSplit {
  label: string;
  methodLabel: string;
  amount: number;
  cashReceived: number | null;
  change: number | null;
}

export interface ReceiptPrintPayloadData {
  restaurantName: string;
  orderNumber: number | null;
  orderId: string;
  paidAtIso: string | null;
  lines: ReceiptPrintPayloadLine[];
  itemsTotal: number;
  total: number;
  paymentMethodLabel: string;
  paymentCashReceived: number | null;
  paymentChange: number | null;
  paymentSplits: ReceiptPrintPayloadSplit[];
  saleOriginLabel: string | null;
  saleOriginShortLabel: string | null;
  appOrderTotal: number | null;
  isAppSale: boolean;
  observations: string[];
}

export interface ReceiptPrintPayload {
  id: string;
  createdAt: number;
  receipt: ReceiptPrintPayloadData;
}

export interface ReceiptPrintPayloadInput {
  receipt: ReceiptPrintPayloadData;
}

const buildStorageKey = (payloadId: string): string =>
  `${RECEIPT_PRINT_PAYLOAD_KEY_PREFIX}${payloadId}`;

const createPayloadId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeMaybeText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return normalizeText(value);
};

const normalizeLine = (value: unknown): ReceiptPrintPayloadLine | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = normalizeText(source.id);
  const name = normalizeText(source.name);
  if (!id || !name) return null;

  const qtyRaw = Number(source.qty);
  const unitPriceRaw = Number(source.unitPrice);
  const subtotalRaw = Number(source.subtotal);
  if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) return null;
  if (!Number.isFinite(unitPriceRaw) || unitPriceRaw < 0) return null;
  if (!Number.isFinite(subtotalRaw) || subtotalRaw < 0) return null;

  const note = normalizeMaybeText(source.note) || undefined;

  return {
    id,
    qty: Math.max(1, Math.round(qtyRaw)),
    name,
    unitPrice: Number(unitPriceRaw.toFixed(2)),
    subtotal: Number(subtotalRaw.toFixed(2)),
    note,
  };
};

const normalizeSplit = (value: unknown): ReceiptPrintPayloadSplit | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const label = normalizeText(source.label);
  const methodLabel = normalizeText(source.methodLabel);
  if (!label || !methodLabel) return null;

  const amountRaw = Number(source.amount);
  if (!Number.isFinite(amountRaw) || amountRaw < 0) return null;

  const cashReceivedRaw =
    source.cashReceived === null || source.cashReceived === undefined
      ? null
      : Number(source.cashReceived);
  const changeRaw =
    source.change === null || source.change === undefined ? null : Number(source.change);

  const cashReceived =
    cashReceivedRaw === null
      ? null
      : Number.isFinite(cashReceivedRaw)
        ? Number(cashReceivedRaw.toFixed(2))
        : null;
  const change =
    changeRaw === null ? null : Number.isFinite(changeRaw) ? Number(changeRaw.toFixed(2)) : null;

  return {
    label,
    methodLabel,
    amount: Number(amountRaw.toFixed(2)),
    cashReceived,
    change,
  };
};

const normalizeReceipt = (value: unknown): ReceiptPrintPayloadData | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  const restaurantName = normalizeText(source.restaurantName);
  const orderId = normalizeText(source.orderId);
  const paymentMethodLabel = normalizeText(source.paymentMethodLabel);
  if (!restaurantName || !orderId || !paymentMethodLabel) return null;

  const orderNumberRaw = source.orderNumber;
  const orderNumber =
    orderNumberRaw === null || orderNumberRaw === undefined
      ? null
      : Number.isFinite(Number(orderNumberRaw))
        ? Math.max(0, Math.round(Number(orderNumberRaw)))
        : null;
  const paidAtIso = normalizeMaybeText(source.paidAtIso);
  if (paidAtIso && Number.isNaN(Date.parse(paidAtIso))) return null;

  if (!Array.isArray(source.lines)) return null;
  const lines = source.lines
    .map((line) => normalizeLine(line))
    .filter((line): line is ReceiptPrintPayloadLine => line !== null);
  if (lines.length === 0) return null;

  const itemsTotalRaw = Number(source.itemsTotal);
  const totalRaw = Number(source.total);
  if (!Number.isFinite(itemsTotalRaw) || itemsTotalRaw < 0) return null;
  if (!Number.isFinite(totalRaw) || totalRaw < 0) return null;

  const paymentCashReceivedRaw =
    source.paymentCashReceived === null || source.paymentCashReceived === undefined
      ? null
      : Number(source.paymentCashReceived);
  const paymentChangeRaw =
    source.paymentChange === null || source.paymentChange === undefined
      ? null
      : Number(source.paymentChange);
  const paymentCashReceived =
    paymentCashReceivedRaw === null
      ? null
      : Number.isFinite(paymentCashReceivedRaw)
        ? Number(paymentCashReceivedRaw.toFixed(2))
        : null;
  const paymentChange =
    paymentChangeRaw === null
      ? null
      : Number.isFinite(paymentChangeRaw)
        ? Number(paymentChangeRaw.toFixed(2))
        : null;

  const paymentSplits = Array.isArray(source.paymentSplits)
    ? source.paymentSplits
        .map((split) => normalizeSplit(split))
        .filter((split): split is ReceiptPrintPayloadSplit => split !== null)
    : [];

  const saleOriginLabel = normalizeMaybeText(source.saleOriginLabel);
  const saleOriginShortLabel = normalizeMaybeText(source.saleOriginShortLabel);
  const appOrderTotalRaw =
    source.appOrderTotal === null || source.appOrderTotal === undefined
      ? null
      : Number(source.appOrderTotal);
  const appOrderTotal =
    appOrderTotalRaw === null
      ? null
      : Number.isFinite(appOrderTotalRaw)
        ? Number(appOrderTotalRaw.toFixed(2))
        : null;
  const isAppSale = Boolean(source.isAppSale);

  const observations = Array.isArray(source.observations)
    ? source.observations
        .map((entry) => normalizeText(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];

  return {
    restaurantName,
    orderNumber,
    orderId,
    paidAtIso,
    lines,
    itemsTotal: Number(itemsTotalRaw.toFixed(2)),
    total: Number(totalRaw.toFixed(2)),
    paymentMethodLabel,
    paymentCashReceived,
    paymentChange,
    paymentSplits,
    saleOriginLabel,
    saleOriginShortLabel,
    appOrderTotal,
    isAppSale,
    observations,
  };
};

const normalizePayload = (value: unknown): ReceiptPrintPayload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = normalizeText(source.id);
  const createdAt = Number(source.createdAt);
  const receipt = normalizeReceipt(source.receipt);
  if (!id || !Number.isFinite(createdAt) || !receipt) return null;
  return {
    id,
    createdAt,
    receipt,
  };
};

const cleanupExpiredPayloads = (): void => {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const keysToDelete: string[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !key.startsWith(RECEIPT_PRINT_PAYLOAD_KEY_PREFIX)) continue;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      keysToDelete.push(key);
      continue;
    }

    try {
      const parsed = normalizePayload(JSON.parse(raw));
      if (!parsed || now - parsed.createdAt > RECEIPT_PRINT_PAYLOAD_MAX_AGE_MS) {
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

const encodeWindowNamePayload = (payload: ReceiptPrintPayload): string =>
  `${RECEIPT_PRINT_WINDOW_NAME_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;

const decodeWindowNamePayload = (windowName: string): ReceiptPrintPayload | null => {
  if (!windowName.startsWith(RECEIPT_PRINT_WINDOW_NAME_PREFIX)) return null;
  const encodedPayload = windowName.slice(RECEIPT_PRINT_WINDOW_NAME_PREFIX.length);
  if (!encodedPayload) return null;
  try {
    return normalizePayload(JSON.parse(decodeURIComponent(encodedPayload)));
  } catch {
    return null;
  }
};

const encodePayload = (payload: ReceiptPrintPayload): string =>
  encodeURIComponent(JSON.stringify(payload));

const decodePayload = (encodedPayload: string): ReceiptPrintPayload | null => {
  if (!encodedPayload) return null;
  try {
    return normalizePayload(JSON.parse(decodeURIComponent(encodedPayload)));
  } catch {
    return null;
  }
};

export const saveReceiptPrintPayload = (
  input: ReceiptPrintPayloadInput
): ReceiptPrintPayload | null => {
  if (typeof window === 'undefined') return null;
  cleanupExpiredPayloads();

  const receipt = normalizeReceipt(input.receipt);
  if (!receipt) return null;

  const payload: ReceiptPrintPayload = {
    id: createPayloadId(),
    createdAt: Date.now(),
    receipt,
  };

  try {
    window.localStorage.setItem(buildStorageKey(payload.id), JSON.stringify(payload));
  } catch {
    // Keep payload usable through window.name fallback even when localStorage write fails.
  }

  return payload;
};

export const consumeReceiptPrintPayload = (receiptId: string): ReceiptPrintPayload | null => {
  if (typeof window === 'undefined') return null;
  const normalizedId = receiptId.trim();
  if (!normalizedId) return null;

  const storageRaw = window.localStorage.getItem(buildStorageKey(normalizedId));
  if (storageRaw) {
    try {
      const payload = normalizePayload(JSON.parse(storageRaw));
      if (payload?.id === normalizedId) {
        return payload;
      }
    } catch {
      // ignore malformed payload from storage and fallback to window name
    }
  }

  const fromWindowName = decodeWindowNamePayload(window.name || '');
  if (fromWindowName?.id === normalizedId) {
    return fromWindowName;
  }

  const hashRaw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashParams = new URLSearchParams(hashRaw);
  const hashPayloadEncoded = hashParams.get(RECEIPT_PRINT_HASH_PARAM);
  if (!hashPayloadEncoded) return null;
  const fromHash = decodePayload(hashPayloadEncoded);
  if (!fromHash || fromHash.id !== normalizedId) return null;
  return fromHash;
};

export const removeReceiptPrintPayload = (receiptId: string): void => {
  if (typeof window === 'undefined') return;
  const normalizedId = receiptId.trim();
  if (!normalizedId) return;

  window.localStorage.removeItem(buildStorageKey(normalizedId));

  const fromWindowName = decodeWindowNamePayload(window.name || '');
  if (fromWindowName?.id === normalizedId) {
    window.name = '';
  }
};

export const setReceiptPrintPayloadOnWindow = (
  targetWindow: Window,
  payload: ReceiptPrintPayload
): void => {
  try {
    targetWindow.name = encodeWindowNamePayload(payload);
  } catch {
    // ignore window name write failures
  }
};

export const buildReceiptPrintHashPayload = (payload: ReceiptPrintPayload): string =>
  `${RECEIPT_PRINT_HASH_PARAM}=${encodePayload(payload)}`;
