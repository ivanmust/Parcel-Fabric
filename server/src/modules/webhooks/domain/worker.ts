import path from "node:path";
import { config } from "../../../config/env.js";
import { logger } from "../../../common/logging/logger.js";
import { withServiceToken } from "../../../common/arcgis/arcgis-client.js";
import { FileOutbox } from "./outbox.js";
import { dispatchDue, type DispatchConfig } from "./dispatcher.js";
import { acquireWorkerLock, type WorkerLock } from "./worker-lock.js";
import { reconcileSubdivisions } from "./subdivision-completion.js";

/** Reconciler (GIS → outbox) and dispatcher (outbox → App B) on background timers, run only by the lock owner. */

export const subdivisionWebhookEnabled = () => config.SUBDIVISION_WEBHOOK_ENABLED === "true";

let outbox: FileOutbox | null = null;
export function subdivisionOutbox(): FileOutbox {
  outbox ??= new FileOutbox(path.resolve(config.LAIS_DATA_DIR, "webhooks", "subdivision-outbox.json"));
  return outbox;
}
const lockFile = () => path.resolve(config.LAIS_DATA_DIR, "webhooks", "worker.lock");

export function dispatchConfig(): DispatchConfig {
  return {
    url: config.SUBDIVISION_WEBHOOK_URL,
    secrets: [config.SUBDIVISION_WEBHOOK_SECRET, config.SUBDIVISION_WEBHOOK_SECRET_PREVIOUS].filter(Boolean),
    timeoutMs: config.SUBDIVISION_WEBHOOK_TIMEOUT_MS,
    maxAttempts: config.SUBDIVISION_WEBHOOK_MAX_ATTEMPTS,
    backoff: { baseMs: config.SUBDIVISION_WEBHOOK_BACKOFF_BASE_MS, maxMs: config.SUBDIVISION_WEBHOOK_BACKOFF_MAX_MS },
  };
}

/** Starts the worker; returns a stop function, or null when the webhook is switched off. */
export function startSubdivisionWebhook(): (() => Promise<void>) | null {
  if (!subdivisionWebhookEnabled()) return null;
  const box = subdivisionOutbox();
  const staleMs = Math.max(2 * 60_000, 4 * config.SUBDIVISION_WEBHOOK_DISPATCH_INTERVAL_MS);
  let lock: WorkerLock | null = null;
  let stopped = false;
  const busy = { reconcile: false, dispatch: false };

  const owns = async (): Promise<boolean> => {
    if (lock && (await lock.heartbeat())) return true;
    if (lock) logger.error("Subdivision webhook: the worker lock was taken over by another process; this process stops sending");
    lock = await acquireWorkerLock(lockFile(), { staleMs });
    if (lock) logger.info({ outbox: box.file }, "Subdivision webhook worker started (this process owns the outbox)");
    return !!lock;
  };

  const guarded = (name: keyof typeof busy, fn: () => Promise<void>) => async () => {
    if (busy[name] || stopped) return;
    busy[name] = true;
    try {
      if (await owns()) await fn();
    } catch (error) {
      logger.error({ err: (error as Error).message }, `Subdivision webhook ${name} run failed`);
    } finally {
      busy[name] = false;
    }
  };

  const reconcile = guarded("reconcile", async () => {
    const s = await reconcileSubdivisions(box, withServiceToken);
    logger[s.created || s.errors || s.waiting ? "info" : "debug"](s, "Subdivision webhook: reconciliation run");
  });
  const dispatch = guarded("dispatch", async () => {
    const s = await dispatchDue(box, dispatchConfig());
    if (s.claimed) logger.info(s, "Subdivision webhook: dispatch run");
  });

  // First runs shortly after start-up: recovery after downtime happens here.
  const first = setTimeout(() => void reconcile().then(dispatch), 5_000);
  const r = setInterval(() => void reconcile(), config.SUBDIVISION_WEBHOOK_RECONCILE_INTERVAL_MS);
  const d = setInterval(() => void dispatch(), config.SUBDIVISION_WEBHOOK_DISPATCH_INTERVAL_MS);
  for (const t of [first, r, d]) t.unref();

  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(r);
    clearInterval(d);
    await lock?.release();
  };
}
