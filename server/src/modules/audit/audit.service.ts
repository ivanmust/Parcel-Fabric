import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { readAudit, writeAudit } from "../../common/audit/audit-log.js";
import { logger } from "../../common/logging/logger.js";
import { HttpError } from "../../common/errors/http-error.js";
import type { SessionUser } from "../../common/auth/portal-auth.js";
import type { RequestInfo } from "../../common/http/request-info.js";

const Outcome = z.enum(["success", "failure", "attempt"]);

const AuditEventBody = z.object({
  action: z.string().min(3).max(120).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  target: z.string().max(500).optional(),
  outcome: Outcome,
  details: z.record(z.string(), z.unknown()).optional(),
});

const AuditQuery = z
  .object({
    username: z.string().trim().max(200).optional(),
    action: z.string().trim().max(120).optional(),
    outcome: Outcome.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    q: z.string().trim().max(200).optional(),
    before: z.string().trim().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();

const ClientLogBody = z.object({ level: z.enum(["error", "warn"]), message: z.string().max(2000), context: z.string().max(4000).optional() });

@Injectable()
export class AuditService {
  /** GIS operations reported by the web app (edits, version operations, validation runs, exports). */
  async record(body: unknown, user: SessionUser, info: RequestInfo) {
    const parsed = AuditEventBody.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "Invalid audit event", "invalid_audit_event", parsed.error.issues);
    const event = await writeAudit({ ...parsed.data, username: user.username, appRole: user.appRole, ip: info.ip, requestId: info.requestId });
    return { id: event.id };
  }

  async search(query: unknown) {
    const parsed = AuditQuery.safeParse(query);
    if (!parsed.success) throw new HttpError(400, "Invalid query", "invalid_query", parsed.error.issues);
    return readAudit(parsed.data);
  }

  /** Web-app errors, so production problems reach the server log. */
  clientLog(body: unknown, user: SessionUser): void {
    const parsed = ClientLogBody.safeParse(body);
    if (parsed.success) logger[parsed.data.level]({ user: user.username, context: parsed.data.context }, parsed.data.message);
  }
}
