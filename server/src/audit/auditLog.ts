import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
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
  username?: string;
  action?: string;
  limit: number;
}

/** Read the most recent audit events (newest first) across monthly files. */
export async function readAudit(q: AuditQuery): Promise<AuditEvent[]> {
  let files: string[];
  try {
    files = (await readdir(auditDir)).filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse();
  } catch {
    return [];
  }
  const results: AuditEvent[] = [];
  for (const f of files) {
    const lines = (await readFile(path.join(auditDir, f), "utf8")).split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as AuditEvent;
        if (q.username && e.username !== q.username) continue;
        if (q.action && !e.action.startsWith(q.action)) continue;
        results.push(e);
        if (results.length >= q.limit) return results;
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return results;
}
