import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { writeAudit } from "../../common/audit/audit-log.js";
import { HttpError } from "../../common/errors/http-error.js";
import type { SessionUser } from "../../common/auth/portal-auth.js";
import type { RequestInfo } from "../../common/http/request-info.js";
import { subdivisionOutbox, subdivisionWebhookEnabled } from "./domain/worker.js";

const EventsQuery = z.object({ status: z.enum(["pending", "delivering", "delivered", "dead"]).optional() }).strict();

@Injectable()
export class WebhooksService {
  async events(query: unknown) {
    const parsed = EventsQuery.safeParse(query);
    if (!parsed.success) throw new HttpError(400, "Invalid query", "invalid_query", parsed.error.issues);
    const events = await subdivisionOutbox().events(parsed.data);
    return { enabled: subdivisionWebhookEnabled(), events: events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) };
  }

  async waiting() {
    return { waiting: await subdivisionOutbox().waiting() };
  }

  async replay(eventId: string, user: SessionUser, info: RequestInfo) {
    const event = await subdivisionOutbox().replay(eventId, Date.now());
    if (!event) throw new HttpError(409, "Only a dead-lettered event can be replayed.", "not_dead_lettered");
    void writeAudit({ username: user.username, appRole: user.appRole, action: "webhook.replay", target: event.key, outcome: "success", details: { event_id: eventId }, ip: info.ip, requestId: info.requestId }).catch(() => undefined);
    return { event };
  }
}
