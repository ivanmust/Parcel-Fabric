const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call with the same key has finished (in this process). */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function clearLocksForTests(): void {
  locks.clear();
}
