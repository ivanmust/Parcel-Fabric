import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../../config/env.js";
import { logger } from "../logging/logger.js";

export type AuditOutcome = "success" | "failure" | "attempt";

export interface AuditEvent {
  id: string;
  time: string;
  username: string;
  appRole: string;
  action: string;
  target?: string;
  outcome: AuditOutcome;
  details?: Record<string, unknown>;
  ip?: string;
  requestId?: string;
}

const SENSITIVE_KEY = /token|password|secret|authorization|cookie|credential/i;
const MAX_DETAIL_BYTES = 8 * 1024;

/** Remove anything credential-like and bound the size of free-form details. */
export function sanitizeDetails(details: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || depth > 4) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = sanitizeDetails(v, depth + 1);
    else if (typeof v === "string") out[k] = v.replace(/([?&](?:token|access_token)=)[^&]*/gi, "$1[REDACTED]").slice(0, 2000);
    else out[k] = v;
  }
  const json = JSON.stringify(out);
  return json.length > MAX_DETAIL_BYTES ? { truncated: true, preview: json.slice(0, 1000) } : out;
}

const auditDir = path.resolve(config.AUDIT_DIR);
const fileFor = (d: Date) => path.join(auditDir, `audit-${d.toISOString().slice(0, 7)}.jsonl`);

export async function writeAudit(event: Omit<AuditEvent, "id" | "time">): Promise<AuditEvent> {
  const full: AuditEvent = {
    id: randomUUID(),
    time: new Date().toISOString(),
    ...event,
    details: sanitizeDetails(event.details),
  };
  try {
    await mkdir(auditDir, { recursive: true });
    await appendFile(fileFor(new Date()), `${JSON.stringify(full)}\n`, "utf8");
  } catch (err) {
    // Audit failures must be loud: they are logged at error level.
    logger.error({ err: (err as Error).message, action: event.action }, "Failed to write audit event");
    throw err;
  }
  return full;
}

export interface AuditQuery {
  /** Part of the username, any case. */
  username?: string;
  /** Start of the action name, e.g. "version." for every version operation. */
  action?: string;
  outcome?: AuditOutcome;
  /** Events at or after this time (ISO 8601). */
  from?: string;
  /** Events before this time (ISO 8601). */
  to?: string;
  /** Text anywhere in the action, user, target or details, any case. */
  q?: string;
  /** Paging: the id of the last event already shown; the next page starts after it. */
  before?: string;
  limit: number;
}

export interface AuditPage {
  events: AuditEvent[];
  /** More events match after the last one returned (pass its id as `before`). */
  hasMore: boolean;
}

/** Read the most recent audit events (newest first) across monthly files. */
export async function readAudit(q: AuditQuery): Promise<AuditPage> {
  let files: string[];
  try {
    files = (await readdir(auditDir)).filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse();
  } catch {
    return { events: [], hasMore: false };
  }
  const from = q.from ? Date.parse(q.from) : undefined;
  const to = q.to ? Date.parse(q.to) : undefined;
  // Monthly files outside the date range are not read at all.
  const month = (t: number) => new Date(t).toISOString().slice(0, 7);
  if (from !== undefined) files = files.filter((f) => f.slice(6, 13) >= month(from));
  if (to !== undefined) files = files.filter((f) => f.slice(6, 13) <= month(to));
  const user = q.username?.toLowerCase();
  const text = q.q?.toLowerCase();

  const results: AuditEvent[] = [];
  let skipping = !!q.before;
  for (const f of files) {
    const lines = (await readFile(path.join(auditDir, f), "utf8")).split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      let e: AuditEvent;
      try {
        e = JSON.parse(line) as AuditEvent;
      } catch {
        continue; // skip corrupt line
      }
      if (skipping) {
        if (e.id === q.before) skipping = false;
        continue;
      }
      const time = Date.parse(e.time);
      if (to !== undefined && time >= to) continue;
      if (from !== undefined && time < from) return { events: results, hasMore: false }; // newest first: the rest are older
      if (user && !e.username.toLowerCase().includes(user)) continue;
      if (q.action && !e.action.startsWith(q.action)) continue;
      if (q.outcome && e.outcome !== q.outcome) continue;
      if (text && !`${e.action} ${e.username} ${e.target ?? ""} ${e.details ? JSON.stringify(e.details) : ""}`.toLowerCase().includes(text)) continue;
      if (results.length === q.limit) return { events: results, hasMore: true };
      results.push(e);
    }
  }
  return { events: results, hasMore: false };
}
