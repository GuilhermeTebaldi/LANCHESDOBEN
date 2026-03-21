export type CommandPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

const PRIORITY_ORDER: Record<CommandPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

export interface CommandSchedulerSnapshot {
  active: number;
  queued: number;
  queuedByPriority: Record<CommandPriority, number>;
  totalEnqueued: number;
  totalCompleted: number;
  totalFailed: number;
  dedupeHits: number;
  backpressureHits: number;
  lastBackpressureAt: number | null;
}

export class CommandSchedulerBackpressureError extends Error {
  readonly queueSize: number;
  readonly maxQueueSize: number;

  constructor(queueSize: number, maxQueueSize: number) {
    super('Command scheduler queue limit reached.');
    this.name = 'CommandSchedulerBackpressureError';
    this.queueSize = queueSize;
    this.maxQueueSize = maxQueueSize;
  }
}

interface CommandSchedulerEnqueueInput<T> {
  key?: string;
  priority: CommandPriority;
  groupKey?: string;
  run: () => Promise<T>;
}

interface CommandSchedulerOptions {
  maxConcurrent: number;
  maxQueueSize: number;
  onBackpressure?: (payload: {
    queueSize: number;
    maxQueueSize: number;
    key?: string;
    priority: CommandPriority;
    groupKey?: string;
  }) => void;
}

interface ScheduledTask<T> {
  id: number;
  key?: string;
  priority: CommandPriority;
  groupKey?: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const normalizeOptionalKey = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
};

const sortScheduledTasks = (left: ScheduledTask<unknown>, right: ScheduledTask<unknown>): number => {
  const leftPriority = PRIORITY_ORDER[left.priority];
  const rightPriority = PRIORITY_ORDER[right.priority];
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.id - right.id;
};

export interface CommandScheduler {
  enqueue<T>(input: CommandSchedulerEnqueueInput<T>): Promise<T>;
  clear(): void;
  getSnapshot(): CommandSchedulerSnapshot;
}

export const createCommandScheduler = (options: CommandSchedulerOptions): CommandScheduler => {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  const maxQueueSize = Math.max(maxConcurrent, Math.floor(options.maxQueueSize));
  const queued: Array<ScheduledTask<unknown>> = [];
  const pendingByKey = new Map<string, Promise<unknown>>();
  const runningGroups = new Map<string, boolean>();
  let nextTaskId = 0;
  let active = 0;
  let totalEnqueued = 0;
  let totalCompleted = 0;
  let totalFailed = 0;
  let dedupeHits = 0;
  let backpressureHits = 0;
  let lastBackpressureAt: number | null = null;

  const dequeueNextTask = (): ScheduledTask<unknown> | null => {
    if (queued.length === 0) return null;
    queued.sort(sortScheduledTasks);
    const nextTaskIndex = queued.findIndex((task) => {
      if (!task.groupKey) return true;
      return !runningGroups.has(task.groupKey);
    });
    if (nextTaskIndex < 0) return null;
    const [task] = queued.splice(nextTaskIndex, 1);
    return task ?? null;
  };

  const updateKeyRegistryOnFinish = (key: string | undefined, promise: Promise<unknown>): void => {
    if (!key) return;
    const current = pendingByKey.get(key);
    if (current === promise) {
      pendingByKey.delete(key);
    }
  };

  const runLoop = (): void => {
    while (active < maxConcurrent) {
      const nextTask = dequeueNextTask();
      if (!nextTask) break;

      if (nextTask.groupKey) {
        runningGroups.set(nextTask.groupKey, true);
      }
      active += 1;
      const taskPromise = Promise.resolve()
        .then(nextTask.run)
        .then(
          (value) => {
            totalCompleted += 1;
            nextTask.resolve(value);
          },
          (error) => {
            totalFailed += 1;
            nextTask.reject(error);
          }
        )
        .finally(() => {
          active = Math.max(0, active - 1);
          if (nextTask.groupKey) {
            runningGroups.delete(nextTask.groupKey);
          }
          updateKeyRegistryOnFinish(nextTask.key, taskPromise);
          runLoop();
        });
    }
  };

  const enqueue = <T,>(input: CommandSchedulerEnqueueInput<T>): Promise<T> => {
    const priority = input.priority;
    const key = normalizeOptionalKey(input.key);
    const groupKey = normalizeOptionalKey(input.groupKey);

    if (key) {
      const existing = pendingByKey.get(key);
      if (existing) {
        dedupeHits += 1;
        return existing as Promise<T>;
      }
    }

    if (queued.length >= maxQueueSize) {
      backpressureHits += 1;
      lastBackpressureAt = Date.now();
      options.onBackpressure?.({
        queueSize: queued.length,
        maxQueueSize,
        key,
        priority,
        groupKey,
      });
      return Promise.reject(new CommandSchedulerBackpressureError(queued.length, maxQueueSize));
    }

    let resolvePromise: (value: T) => void = () => undefined;
    let rejectPromise: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const scheduledTask: ScheduledTask<T> = {
      id: ++nextTaskId,
      key,
      priority,
      groupKey,
      run: input.run,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    totalEnqueued += 1;
    queued.push(scheduledTask as ScheduledTask<unknown>);

    if (key) {
      pendingByKey.set(key, promise as Promise<unknown>);
    }

    runLoop();
    return promise;
  };

  const clear = (): void => {
    const pendingTasks = queued.splice(0, queued.length);
    pendingByKey.clear();
    runningGroups.clear();
    pendingTasks.forEach((task) => {
      task.reject(new Error('Command scheduler cleared.'));
    });
  };

  const getSnapshot = (): CommandSchedulerSnapshot => {
    const queuedByPriority: Record<CommandPriority, number> = {
      CRITICAL: 0,
      HIGH: 0,
      NORMAL: 0,
      LOW: 0,
    };
    queued.forEach((task) => {
      queuedByPriority[task.priority] += 1;
    });
    return {
      active,
      queued: queued.length,
      queuedByPriority,
      totalEnqueued,
      totalCompleted,
      totalFailed,
      dedupeHits,
      backpressureHits,
      lastBackpressureAt,
    };
  };

  return {
    enqueue,
    clear,
    getSnapshot,
  };
};
