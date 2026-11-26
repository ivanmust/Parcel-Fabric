import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";

/**
 * Single-owner lock for the webhook worker (a lock file next to the outbox).
 *
 * Only the owner reconciles and dispatches, so the outbox has one writer even if a second API
 * process is started on the same data directory by mistake. The file is created exclusively
 * (O_EXCL); the owner refreshes a heartbeat. A lock is taken over only when it is stale: its
 * heartbeat is older than `staleMs`, or its process no longer exists on this host.
 * This is a safety net for one host/disk, not a distributed lock.
 */
interface LockInfo {
  owner: string;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface WorkerLock {
  readonly owner: string;
  /** Refresh the heartbeat; false if the lock was lost (taken over as stale). */
  heartbeat(): Promise<boolean>;
  release(): Promise<void>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as LockInfo;
  } catch {
    return null; // missing, or half-written by a crashed owner: treated as stale
  }
}

async function createExclusive(file: string, info: LockInfo): Promise<boolean> {
  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(JSON.stringify(info), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function acquireWorkerLock(file: string, opts: { staleMs: number; now?: () => number }): Promise<WorkerLock | null> {
  const now = opts.now ?? Date.now;
  await mkdir(path.dirname(file), { recursive: true });
  const owner = randomUUID();
  const info = (): LockInfo => ({ owner, pid: process.pid, host: hostname(), startedAt: started, heartbeatAt: new Date(now()).toISOString() });
  const started = new Date(now()).toISOString();

  if (!(await createExclusive(file, info()))) {
    const current = await readLock(file);
    const stale =
      !current ||
      now() - Date.parse(current.heartbeatAt) > opts.staleMs ||
      (current.host === hostname() && current.pid !== process.pid && !processAlive(current.pid));
    if (!stale) return null;
    await rm(file, { force: true });
    if (!(await createExclusive(file, info()))) return null; // another process took it over first
  }

  return {
    owner,
    async heartbeat() {
      const current = await readLock(file);
      if (current?.owner !== owner) return false;
      await writeFile(file, JSON.stringify(info()), "utf8");
      return true;
    },
    async release() {
      const current = await readLock(file);
      if (current?.owner === owner) await rm(file, { force: true });
    },
  };
}
