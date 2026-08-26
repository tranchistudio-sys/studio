export type KeyedDebouncedQueue<T> = {
  enqueue(key: string, item: T): Promise<void>;
  pendingCount(key: string): number;
};

type Pending<T> = {
  items: T[];
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  timer: ReturnType<typeof setTimeout>;
};

/** Debounce each key and serialize later batches for that same key. */
export function createKeyedDebouncedQueue<T>(
  delayMs: number,
  worker: (key: string, items: T[]) => Promise<void>,
): KeyedDebouncedQueue<T> {
  const pending = new Map<string, Pending<T>>();
  const chains = new Map<string, Promise<void>>();

  const flush = (key: string) => {
    const batch = pending.get(key);
    if (!batch) return;
    pending.delete(key);

    const previous = chains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => worker(key, batch.items));
    chains.set(key, run);
    run.then(
      () => batch.waiters.forEach((w) => w.resolve()),
      (error) => batch.waiters.forEach((w) => w.reject(error)),
    ).finally(() => {
      if (chains.get(key) === run) chains.delete(key);
    });
  };

  return {
    enqueue(key, item) {
      return new Promise<void>((resolve, reject) => {
        const current = pending.get(key);
        if (current) {
          clearTimeout(current.timer);
          current.items.push(item);
          current.waiters.push({ resolve, reject });
          current.timer = setTimeout(() => flush(key), delayMs);
          return;
        }
        pending.set(key, {
          items: [item],
          waiters: [{ resolve, reject }],
          timer: setTimeout(() => flush(key), delayMs),
        });
      });
    },
    pendingCount(key) {
      return pending.get(key)?.items.length ?? 0;
    },
  };
}
