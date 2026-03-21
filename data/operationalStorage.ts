import {
  getItem as getIndexedDbItem,
  removeItem as removeIndexedDbItem,
  setItem as setIndexedDbItem,
} from './localDb';

interface StorageEnvelope<T> {
  schemaVersion: 1;
  updatedAt: number;
  value: T;
}

type StorageSource = 'local' | 'indexeddb';

interface NormalizedStorageRecord<T> {
  source: StorageSource;
  value: T;
  updatedAt: number | null;
  hasTimestamp: boolean;
}

export interface OperationalStorageResolvedResult<T> {
  value: T | undefined;
  winner: StorageSource | 'none';
  winnerUpdatedAt: number | null;
  localUpdatedAt: number | null;
  indexedDbUpdatedAt: number | null;
}

interface OperationalStorage {
  getLocalFallback<T>(key: string): T | undefined;
  getResolved<T>(key: string): Promise<OperationalStorageResolvedResult<T>>;
  get<T>(key: string): Promise<T | undefined>;
  setCritical<T>(key: string, value: T): Promise<void>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

const ENVELOPE_SCHEMA_VERSION = 1;
const WRITE_CHAINS_BY_KEY = new Map<string, Promise<void>>();

const rawIndexedDbStorageFlag = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_ENABLE_INDEXED_DB_OPERATIONAL_STORAGE;
const ENABLE_INDEXED_DB_OPERATIONAL_STORAGE =
  rawIndexedDbStorageFlag === undefined
    ? true
    : !['0', 'false', 'off', 'no'].includes(rawIndexedDbStorageFlag.trim().toLowerCase());

const enqueueKeyWrite = (key: string, operation: () => Promise<void>): Promise<void> => {
  const current = WRITE_CHAINS_BY_KEY.get(key) ?? Promise.resolve();
  const queued = current
    .catch(() => undefined)
    .then(operation)
    .catch(() => undefined);
  WRITE_CHAINS_BY_KEY.set(key, queued);

  return queued.finally(() => {
    if (WRITE_CHAINS_BY_KEY.get(key) === queued) {
      WRITE_CHAINS_BY_KEY.delete(key);
    }
  });
};

const readFromLocalStorage = (key: string): unknown => {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

const writeToLocalStorage = (key: string, value: unknown): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage write failures
  }
};

const removeFromLocalStorage = (key: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage write failures
  }
};

const parseUpdatedAt = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
};

const normalizeStorageRecord = <T>(
  source: StorageSource,
  raw: unknown
): NormalizedStorageRecord<T> | null => {
  if (raw === undefined) return null;

  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in (raw as Record<string, unknown>)) {
    const envelopeCandidate = raw as Partial<StorageEnvelope<T>>;
    const updatedAt = parseUpdatedAt(envelopeCandidate.updatedAt);
    return {
      source,
      value: envelopeCandidate.value as T,
      updatedAt,
      hasTimestamp: updatedAt !== null,
    };
  }

  return {
    source,
    value: raw as T,
    updatedAt: null,
    hasTimestamp: false,
  };
};

const buildEnvelope = <T>(value: T, updatedAt = Date.now()): StorageEnvelope<T> => ({
  schemaVersion: ENVELOPE_SCHEMA_VERSION,
  updatedAt,
  value,
});

const areSerializedEqual = (left: unknown, right: unknown): boolean => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const pickWinnerRecord = <T>(
  localRecord: NormalizedStorageRecord<T> | null,
  indexedDbRecord: NormalizedStorageRecord<T> | null
): NormalizedStorageRecord<T> | null => {
  if (!localRecord && !indexedDbRecord) return null;
  if (!localRecord) return indexedDbRecord;
  if (!indexedDbRecord) return localRecord;

  if (localRecord.hasTimestamp || indexedDbRecord.hasTimestamp) {
    const localUpdatedAt = localRecord.updatedAt ?? 0;
    const indexedDbUpdatedAt = indexedDbRecord.updatedAt ?? 0;
    if (localUpdatedAt > indexedDbUpdatedAt) return localRecord;
    if (indexedDbUpdatedAt > localUpdatedAt) return indexedDbRecord;

    if (localRecord.hasTimestamp && !indexedDbRecord.hasTimestamp) return localRecord;
    if (indexedDbRecord.hasTimestamp && !localRecord.hasTimestamp) return indexedDbRecord;

    // Deterministic tie-break to avoid local stale mirrors dominating after migration.
    return indexedDbRecord;
  }

  // Legacy scenario (both without metadata): preserve historical localStorage precedence.
  return localRecord;
};

const normalizeLocalFallbackValue = <T>(raw: unknown): T | undefined => {
  const normalized = normalizeStorageRecord<T>('local', raw);
  return normalized?.value as T | undefined;
};

const readIndexedDbRaw = async (key: string): Promise<unknown> => {
  try {
    return await getIndexedDbItem<unknown>(key);
  } catch {
    return undefined;
  }
};

const resolveStorageValue = async <T>(key: string): Promise<OperationalStorageResolvedResult<T>> => {
  const localRaw = readFromLocalStorage(key);
  const localRecord = normalizeStorageRecord<T>('local', localRaw);
  const localUpdatedAt = localRecord?.updatedAt ?? null;

  if (!ENABLE_INDEXED_DB_OPERATIONAL_STORAGE) {
    return {
      value: localRecord?.value as T | undefined,
      winner: localRecord ? 'local' : 'none',
      winnerUpdatedAt: localUpdatedAt,
      localUpdatedAt,
      indexedDbUpdatedAt: null,
    };
  }

  const inflightWrite = WRITE_CHAINS_BY_KEY.get(key);
  if (inflightWrite) {
    try {
      await inflightWrite;
    } catch {
      // swallow write failures and continue with current snapshot reads
    }
  }

  const latestLocalRaw = readFromLocalStorage(key);
  const latestLocalRecord = normalizeStorageRecord<T>('local', latestLocalRaw);
  const indexedDbRaw = await readIndexedDbRaw(key);
  const indexedDbRecord = normalizeStorageRecord<T>('indexeddb', indexedDbRaw);
  const indexedDbUpdatedAt = indexedDbRecord?.updatedAt ?? null;

  const winnerRecord = pickWinnerRecord(latestLocalRecord, indexedDbRecord);
  if (!winnerRecord) {
    return {
      value: undefined,
      winner: 'none',
      winnerUpdatedAt: null,
      localUpdatedAt: latestLocalRecord?.updatedAt ?? null,
      indexedDbUpdatedAt,
    };
  }

  const winnerUpdatedAt = winnerRecord.updatedAt ?? Date.now();
  const canonicalEnvelope = buildEnvelope(winnerRecord.value, winnerUpdatedAt);
  const latestLocalUpdatedAt = latestLocalRecord?.updatedAt ?? null;

  const localNeedsBackfill =
    !latestLocalRecord ||
    !latestLocalRecord.hasTimestamp ||
    latestLocalRecord.updatedAt !== winnerUpdatedAt ||
    !areSerializedEqual(latestLocalRecord.value, winnerRecord.value);
  if (localNeedsBackfill) {
    writeToLocalStorage(key, canonicalEnvelope);
  }

  const indexedDbNeedsBackfill =
    !indexedDbRecord ||
    !indexedDbRecord.hasTimestamp ||
    indexedDbRecord.updatedAt !== winnerUpdatedAt ||
    !areSerializedEqual(indexedDbRecord.value, winnerRecord.value);
  if (indexedDbNeedsBackfill) {
    await enqueueKeyWrite(key, async () => {
      try {
        await setIndexedDbItem<StorageEnvelope<T>>(key, canonicalEnvelope);
      } catch {
        // ignore indexedDB write failures and keep local canonical fallback
      }
    });
  }

  return {
    value: winnerRecord.value,
    winner: winnerRecord.source,
    winnerUpdatedAt,
    localUpdatedAt: latestLocalUpdatedAt,
    indexedDbUpdatedAt,
  };
};

export const operationalStorage: OperationalStorage = {
  getLocalFallback<T>(key: string): T | undefined {
    return normalizeLocalFallbackValue<T>(readFromLocalStorage(key));
  },

  async getResolved<T>(key: string): Promise<OperationalStorageResolvedResult<T>> {
    return resolveStorageValue<T>(key);
  },

  async get<T>(key: string): Promise<T | undefined> {
    const resolved = await resolveStorageValue<T>(key);
    return resolved.value;
  },

  setCritical<T>(key: string, value: T): Promise<void> {
    const envelope = buildEnvelope(value, Date.now());
    writeToLocalStorage(key, envelope);

    if (!ENABLE_INDEXED_DB_OPERATIONAL_STORAGE) {
      return Promise.resolve();
    }

    return enqueueKeyWrite(key, async () => {
      try {
        await setIndexedDbItem<StorageEnvelope<T>>(key, envelope);
      } catch {
        // keep local mirror when indexedDB is unavailable
      }
    });
  },

  set<T>(key: string, value: T): Promise<void> {
    if (!ENABLE_INDEXED_DB_OPERATIONAL_STORAGE) {
      writeToLocalStorage(key, buildEnvelope(value, Date.now()));
      return Promise.resolve();
    }

    return enqueueKeyWrite(key, async () => {
      const envelope = buildEnvelope(value, Date.now());
      let indexedDbSaved = false;
      try {
        await setIndexedDbItem<StorageEnvelope<T>>(key, envelope);
        indexedDbSaved = true;
      } catch {
        indexedDbSaved = false;
      }

      // Keep a localStorage mirror for safe rollback and backward compatibility.
      if (indexedDbSaved || typeof window !== 'undefined') {
        writeToLocalStorage(key, envelope);
      }
    });
  },

  remove(key: string): Promise<void> {
    if (!ENABLE_INDEXED_DB_OPERATIONAL_STORAGE) {
      removeFromLocalStorage(key);
      return Promise.resolve();
    }

    return enqueueKeyWrite(key, async () => {
      try {
        await removeIndexedDbItem(key);
      } catch {
        // ignore indexedDB remove failures and continue removing local fallback
      }
      removeFromLocalStorage(key);
    });
  },
};
