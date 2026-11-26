import { logger } from "../logging/logger.js";
import { writeAudit } from "../audit/auditLog.js";
import { backoffDelay, parseRetryAfter, type BackoffOptions } from "./backoff.js";
import { signatureHeader } from "./signing.js";
import type { FileOutbox, OutboxEvent } from "./outbox.js";

/**
 * Webhook dispatcher: sends the outbox's due events, independently of whatever created them.
 *
 *   2xx                                   delivered
 *   408, 425, 429, 5xx, timeout, network  retried with exponential backoff + jitter (Retry-After honoured)
 *   3xx, other 4xx                        permanent: dead-lettered at once (redirects are not followed)
 *   last allowed attempt failed           dead-lettered
 *
 * Each event is leased in the outbox before it is sent, so two dispatch runs never send it at the same
 * time; a run that dies mid-send leaves a lease that expires and the event is sent again (at least once).
 */

export interface DispatchConfig {
  url: string;
  /** Signing keys: the current one first; during a key change also the previous one. */
  secrets: string[];
  timeoutMs: number;
  maxAttempts: number;
  backoff: BackoffOptions;
  /** Events leased per run. */
  batchSize?: number;
  userAgent?: string;
}

export interface DispatchSummary {
  claimed: number;
  delivered: number;
  retrying: number;
  dead: number;
}

const RETRYABLE = new Set([408, 425, 429]);
const MAX_ERROR_TEXT = 300;

type Outcome = { outcome: "delivered" | "retry" | "dead"; result: string; error: string | null; retryAfterMs: number | null; durationMs: number };

/** Short, safe text from the receiver's answer: its message field if JSON, otherwise the start of the body. */
function receiverMessage(raw: string): string | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { message?: unknown; error?: unknown };
    const m = j.message ?? (typeof j.error === "string" ? j.error : (j.error as { message?: unknown } | undefined)?.message);
    if (m !== undefined && m !== null) return String(m).slice(0, MAX_ERROR_TEXT);
  } catch {
    /* not JSON */
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_TEXT) || null;
}

async function send(event: OutboxEvent, cfg: DispatchConfig, attempt: number): Promise<Outcome> {
  const body = JSON.stringify(event.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": cfg.userAgent ?? "Rwanda-Parcel-Fabric-Webhook/1.0",
        "X-Webhook-Id": event.id,
        "X-Webhook-Event": event.type,
        "X-Webhook-Version": String((event.payload as { event_version?: unknown }).event_version ?? "1.0"),
        "X-Webhook-Timestamp": String(timestamp),
        "X-Webhook-Attempt": String(attempt),
        "X-Webhook-Signature": signatureHeader(cfg.secrets, timestamp, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return { outcome: "retry", result: timedOut ? "timeout" : "network error", error: timedOut ? `No answer within ${cfg.timeoutMs} ms` : (error as Error).message.slice(0, MAX_ERROR_TEXT), retryAfterMs: null, durationMs: Date.now() - started };
  }
  const raw = await res.text().catch(() => "");
  const durationMs = Date.now() - started;
  const result = `HTTP ${res.status}`;
  if (res.status >= 200 && res.status < 300) return { outcome: "delivered", result, error: null, retryAfterMs: null, durationMs };
  const message = receiverMessage(raw);
  if (res.status >= 500 || RETRYABLE.has(res.status)) {
    return { outcome: "retry", result, error: message, retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), Date.now()), durationMs };
  }
  const why = res.status >= 300 && res.status < 400 ? `the endpoint redirected (${res.headers.get("location") ?? "no location"}); redirects are not followed` : message;
  return { outcome: "dead", result, error: why, retryAfterMs: null, durationMs };
}

/** Send every due event once. `now` is injectable for tests (scheduling only; HTTP uses real time). */
export async function dispatchDue(outbox: FileOutbox, cfg: DispatchConfig, now = Date.now()): Promise<DispatchSummary> {
  const leaseMs = cfg.timeoutMs + 30_000;
  const claimed = await outbox.claimDue(now, { limit: cfg.batchSize ?? 10, leaseMs, maxAttempts: cfg.maxAttempts });
  const summary: DispatchSummary = { claimed: claimed.length, delivered: 0, retrying: 0, dead: 0 };
  for (const event of claimed) {
    const attempt = event.attempts + 1;
    const r = await send(event, cfg, attempt);
    const lastAllowed = attempt >= cfg.maxAttempts;
    const outcome = r.outcome === "retry" && lastAllowed ? "dead" : r.outcome;
    const delay = outcome === "retry" ? backoffDelay(attempt, cfg.backoff, r.retryAfterMs) : 0;
    const deadReason = outcome !== "dead" ? undefined : r.outcome === "retry" ? `Gave up after ${attempt} attempts (last: ${r.result})` : `Permanent failure: ${r.result}${r.error ? `, ${r.error}` : ""}`;
    const saved = await outbox.complete(event.id, { at: now, result: r.result, outcome, durationMs: r.durationMs, error: r.error, nextAttemptAt: now + delay, deadReason });
    summary[outcome === "retry" ? "retrying" : outcome] += 1;

    const log = { eventId: event.id, eventType: event.type, key: event.key, attempt, result: r.result, durationMs: r.durationMs };
    if (outcome === "delivered") logger.info(log, "Webhook delivered");
    else if (outcome === "retry") logger.warn({ ...log, error: r.error, nextAttemptAt: saved?.nextAttemptAt }, "Webhook not delivered; will retry");
    else logger.error({ ...log, error: r.error, reason: deadReason }, "Webhook dead-lettered");
    void writeAudit({
      username: "GIS",
      appRole: "INTEGRATION",
      action: outcome === "dead" ? "webhook.dead-letter" : "webhook.delivery",
      target: event.key,
      outcome: outcome === "delivered" ? "success" : outcome === "retry" ? "attempt" : "failure",
      details: { event_id: event.id, event_type: event.type, attempt, result: r.result, duration_ms: r.durationMs, ...(r.error ? { message: r.error } : {}), ...(deadReason ? { reason: deadReason } : {}), ...(outcome === "retry" ? { next_attempt_at: saved?.nextAttemptAt } : {}) },
    }).catch(() => undefined);
  }
  return summary;
}
