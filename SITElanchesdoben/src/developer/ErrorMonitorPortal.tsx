import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clearErrorEvents,
  fetchErrorEvents,
  reportErrorEvent,
  type ErrorMonitorEntry,
} from '../services/errorMonitor';

const PASSWORD_STORAGE_KEY = 'lanchesdoben_error_monitor_password_v1';
const SOURCE_FILTER_ALL = '__all__';
const AUTO_REFRESH_INTERVAL_MS = 12_000;
const DEFAULT_CLEAR_OLDER_THAN_DAYS = 7;

const formatDateTime = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(parsed);
};

const sanitizeForDisplay = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const readStoredPassword = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(PASSWORD_STORAGE_KEY) || '';
  } catch {
    return '';
  }
};

const writeStoredPassword = (password: string): void => {
  if (typeof window === 'undefined') return;
  try {
    if (!password.trim()) {
      window.sessionStorage.removeItem(PASSWORD_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(PASSWORD_STORAGE_KEY, password);
  } catch {
    // ignore session storage write failures
  }
};

export default function ErrorMonitorPortal() {
  const [passwordInput, setPasswordInput] = useState(readStoredPassword);
  const [password, setPassword] = useState(readStoredPassword);
  const [events, setEvents] = useState<ErrorMonitorEntry[]>([]);
  const [newEventIds, setNewEventIds] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState(SOURCE_FILTER_ALL);
  const [isLoading, setIsLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearOlderThanDaysInput, setClearOlderThanDaysInput] = useState(
    String(DEFAULT_CLEAR_OLDER_THAN_DAYS)
  );
  const [fetchError, setFetchError] = useState('');
  const [clearMessage, setClearMessage] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const hasInitializedSeenIdsRef = useRef(false);

  const loadEvents = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!password.trim()) return;
      if (!options.silent) {
        setIsLoading(true);
      }
      try {
        const loadedEvents = await fetchErrorEvents(password, { limit: 300 });
        const loadedEventIds = loadedEvents.map((entry) => entry.id);
        if (!hasInitializedSeenIdsRef.current) {
          seenEventIdsRef.current = new Set(loadedEventIds);
          hasInitializedSeenIdsRef.current = true;
          setNewEventIds([]);
        } else {
          const justArrivedEventIds = loadedEventIds.filter(
            (entryId) => !seenEventIdsRef.current.has(entryId)
          );
          setNewEventIds(justArrivedEventIds);

          loadedEventIds.forEach((entryId) => {
            seenEventIdsRef.current.add(entryId);
          });
          if (seenEventIdsRef.current.size > 2000) {
            seenEventIdsRef.current = new Set(loadedEventIds);
          }
        }
        setEvents(loadedEvents);
        setFetchError('');
        setLastUpdatedAt(new Date().toISOString());
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Falha ao carregar eventos.';
        setFetchError(message);
        reportErrorEvent({
          source: 'site:monitor-page',
          level: 'warn',
          message: `Falha ao consultar monitor: ${message}`,
          context: {
            route: '/rede',
          },
        });
      } finally {
        if (!options.silent) {
          setIsLoading(false);
        }
      }
    },
    [password]
  );

  useEffect(() => {
    if (!password.trim()) return;
    void loadEvents();

    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadEvents({ silent: true });
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadEvents, password]);

  const sourceOptions = useMemo(() => {
    const unique = new Set<string>();
    events.forEach((event) => {
      if (event.source) unique.add(event.source);
    });
    return [SOURCE_FILTER_ALL, ...Array.from(unique.values()).sort((a, b) => a.localeCompare(b))];
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (sourceFilter === SOURCE_FILTER_ALL) return events;
    return events.filter((event) => event.source === sourceFilter);
  }, [events, sourceFilter]);

  const newEventIdSet = useMemo(() => new Set(newEventIds), [newEventIds]);

  const summary = useMemo(() => {
    let errors = 0;
    let warns = 0;
    let infos = 0;
    filteredEvents.forEach((event) => {
      const level = event.metadata?.level;
      if (level === 'warn') {
        warns += 1;
        return;
      }
      if (level === 'info') {
        infos += 1;
        return;
      }
      errors += 1;
    });
    return { errors, warns, infos };
  }, [filteredEvents]);

  const handleClearEvents = useCallback(
    async (clearAll: boolean) => {
      if (!password.trim()) return;
      const source = sourceFilter === SOURCE_FILTER_ALL ? undefined : sourceFilter;
      const parsedDays = Number(clearOlderThanDaysInput);
      const olderThanDays =
        Number.isFinite(parsedDays) && parsedDays >= 1
          ? Math.min(Math.floor(parsedDays), 3650)
          : DEFAULT_CLEAR_OLDER_THAN_DAYS;

      const confirmationMessage = clearAll
        ? 'Confirma remover todos os eventos do monitor?'
        : `Confirma remover eventos com mais de ${olderThanDays} dia(s)?`;
      if (!window.confirm(confirmationMessage)) return;

      setIsClearing(true);
      setClearMessage('');
      setFetchError('');
      try {
        const result = await clearErrorEvents(password, {
          clearAll,
          olderThanDays: clearAll ? undefined : olderThanDays,
          source,
        });
        setClearMessage(
          result.deletedCount > 0
            ? `${result.deletedCount} evento(s) removido(s) com sucesso.`
            : 'Nenhum evento removido com esse filtro.'
        );
        await loadEvents();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Falha ao limpar eventos.';
        setFetchError(message);
        reportErrorEvent({
          source: 'site:monitor-page',
          level: 'warn',
          message: `Falha ao limpar monitor: ${message}`,
          context: {
            route: '/rede',
            clearAll,
            olderThanDays: clearAll ? null : olderThanDays,
            source: source || null,
          },
        });
      } finally {
        setIsClearing(false);
      }
    },
    [clearOlderThanDaysInput, loadEvents, password, sourceFilter]
  );

  const handleLogin = (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedPassword = passwordInput.trim();
    setPassword(normalizedPassword);
    seenEventIdsRef.current = new Set();
    hasInitializedSeenIdsRef.current = false;
    setNewEventIds([]);
    setClearMessage('');
    writeStoredPassword(normalizedPassword);
    setFetchError('');
  };

  const handleLogout = () => {
    setPassword('');
    setPasswordInput('');
    setEvents([]);
    setNewEventIds([]);
    setFetchError('');
    setClearMessage('');
    seenEventIdsRef.current = new Set();
    hasInitializedSeenIdsRef.current = false;
    writeStoredPassword('');
  };

  if (!password.trim()) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-md rounded-2xl border border-white/15 bg-neutral-900 p-8 shadow-xl"
        >
          <h1 className="text-2xl font-semibold tracking-tight">Monitor de Erros</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Digite a senha para acessar os eventos registrados no backend.
          </p>
          <label className="mt-6 block text-sm text-neutral-300">Senha</label>
          <input
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            className="mt-2 w-full rounded-lg border border-white/20 bg-neutral-800 px-3 py-2 text-neutral-100 outline-none focus:border-red-400"
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />
          <button
            type="submit"
            className="mt-5 w-full rounded-lg bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-500"
          >
            Entrar
          </button>
          {fetchError ? <p className="mt-3 text-sm text-red-300">{fetchError}</p> : null}
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Rede: Monitor de Erros</h1>
              <p className="text-sm text-neutral-400">
                Atualização automática a cada {Math.floor(AUTO_REFRESH_INTERVAL_MS / 1000)}s.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="rounded-lg border border-white/20 bg-neutral-800 px-3 py-2 text-sm"
              >
                {sourceOptions.map((source) => (
                  <option key={source} value={source}>
                    {source === SOURCE_FILTER_ALL ? 'Todas as origens' : source}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void loadEvents()}
                className="rounded-lg border border-white/20 bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700"
                type="button"
              >
                Atualizar agora
              </button>
              <button
                onClick={handleLogout}
                className="rounded-lg border border-red-400/60 bg-red-950/40 px-3 py-2 text-sm text-red-100 hover:bg-red-900/50"
                type="button"
              >
                Sair
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            <span className="rounded-md bg-red-500/20 px-2 py-1 text-red-200">
              Erros: {summary.errors}
            </span>
            <span className="rounded-md bg-amber-500/20 px-2 py-1 text-amber-200">
              Avisos: {summary.warns}
            </span>
            <span className="rounded-md bg-sky-500/20 px-2 py-1 text-sky-200">
              Info: {summary.infos}
            </span>
            <span className="rounded-md bg-white/10 px-2 py-1 text-neutral-200">
              Total: {filteredEvents.length}
            </span>
            <span className="rounded-md bg-white/10 px-2 py-1 text-neutral-200">
              Última atualização: {lastUpdatedAt ? formatDateTime(lastUpdatedAt) : '-'}
            </span>
            {newEventIds.length > 0 ? (
              <span className="rounded-md bg-emerald-500/20 px-2 py-1 text-emerald-200">
                Novos: {newEventIds.length}
              </span>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <label className="text-neutral-300">Limpar eventos com mais de</label>
            <input
              type="number"
              min={1}
              max={3650}
              value={clearOlderThanDaysInput}
              onChange={(event) => setClearOlderThanDaysInput(event.target.value)}
              className="w-24 rounded-lg border border-white/20 bg-neutral-800 px-2 py-1.5 text-neutral-100"
            />
            <span className="text-neutral-300">dia(s)</span>
            <button
              type="button"
              onClick={() => void handleClearEvents(false)}
              disabled={isClearing}
              className="rounded-lg border border-amber-400/60 bg-amber-950/40 px-3 py-1.5 text-amber-100 hover:bg-amber-900/50 disabled:opacity-50"
            >
              {isClearing ? 'Limpando...' : 'Limpar antigos'}
            </button>
            <button
              type="button"
              onClick={() => void handleClearEvents(true)}
              disabled={isClearing}
              className="rounded-lg border border-red-400/70 bg-red-950/40 px-3 py-1.5 text-red-100 hover:bg-red-900/50 disabled:opacity-50"
            >
              {isClearing ? 'Limpando...' : 'Limpar tudo'}
            </button>
          </div>

          {clearMessage ? <p className="mt-3 text-sm text-emerald-300">{clearMessage}</p> : null}
          {fetchError ? <p className="mt-3 text-sm text-red-300">{fetchError}</p> : null}
          {isLoading ? <p className="mt-3 text-sm text-neutral-300">Carregando eventos...</p> : null}
        </div>

        <div className="space-y-3">
          {filteredEvents.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-neutral-900 p-6 text-neutral-400">
              Nenhum evento encontrado.
            </div>
          ) : null}

          {filteredEvents.map((entry) => {
            const level = entry.metadata?.level || 'error';
            const message = entry.metadata?.message || 'Sem mensagem';
            const path = entry.metadata?.path || '-';
            const statusCode = entry.metadata?.statusCode;
            const stack = entry.metadata?.stack;
            const context = entry.metadata?.context;
            const isNew = newEventIdSet.has(entry.id);

            const levelClass =
              level === 'warn'
                ? 'bg-amber-500/20 text-amber-200'
                : level === 'info'
                  ? 'bg-sky-500/20 text-sky-200'
                  : 'bg-red-500/20 text-red-200';

            return (
              <article
                key={entry.id}
                className={`relative rounded-2xl border bg-neutral-900 p-4 pl-5 ${
                  isNew
                    ? 'border-emerald-400/50 shadow-[0_0_0_1px_rgba(52,211,153,0.35)]'
                    : 'border-white/10'
                }`}
              >
                {isNew ? (
                  <span
                    aria-hidden
                    className="absolute left-0 top-0 h-full w-1.5 rounded-l-2xl bg-emerald-400"
                  />
                ) : null}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded px-2 py-1 uppercase ${levelClass}`}>{level}</span>
                  <span className="rounded bg-white/10 px-2 py-1 text-neutral-200">{entry.source}</span>
                  {isNew ? (
                    <span className="rounded bg-emerald-500/20 px-2 py-1 font-semibold uppercase text-emerald-200">
                      Novo
                    </span>
                  ) : null}
                  <span className="rounded bg-white/10 px-2 py-1 text-neutral-200">
                    {formatDateTime(entry.createdAt)}
                  </span>
                  {statusCode ? (
                    <span className="rounded bg-white/10 px-2 py-1 text-neutral-200">
                      HTTP {statusCode}
                    </span>
                  ) : null}
                </div>

                <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-100">{message}</p>

                <div className="mt-2 grid gap-1 text-xs text-neutral-400">
                  <span>
                    <strong className="text-neutral-300">Path:</strong> {path}
                  </span>
                  <span>
                    <strong className="text-neutral-300">Request ID:</strong> {entry.requestId || '-'}
                  </span>
                  <span>
                    <strong className="text-neutral-300">IP:</strong> {entry.ipAddress || '-'}
                  </span>
                </div>

                {stack ? (
                  <details className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
                    <summary className="cursor-pointer text-xs text-neutral-300">Stack trace</summary>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-neutral-400">
                      {sanitizeForDisplay(stack)}
                    </pre>
                  </details>
                ) : null}

                {context ? (
                  <details className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3">
                    <summary className="cursor-pointer text-xs text-neutral-300">Contexto</summary>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-neutral-400">
                      {sanitizeForDisplay(context)}
                    </pre>
                  </details>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
