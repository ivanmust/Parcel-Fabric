import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../middleware/authenticate.js";
import { HttpError } from "../utils/httpError.js";
import { writeAudit } from "../audit/auditLog.js";
import { subdivisionOutbox, subdivisionWebhookEnabled } from "../webhooks/worker.js";

/**
 * Administration of the subdivision completion webhook (mounted at /api/webhooks, administrators
 * only): see what was sent, what is waiting for complete data, and replay a dead-lettered event once
 * its cause is fixed. Payloads are shown; signing keys never are.
 */
export const webhooks = Router();
webhooks.use(requireAuth, requirePermission("admin:audit"));

const Status = z.enum(["pending", "delivering", "delivered", "dead"]);

webhooks.get("/subdivision/events", async (req, res) => {
  const q = z.object({ status: Status.optional() }).strict().safeParse(req.query);
  if (!q.success) throw new HttpError(400, "Invalid query", "invalid_query", q.error.issues);
  const events = await subdivisionOutbox().events(q.data);
  res.json({ enabled: subdivisionWebhookEnabled(), events: events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) });
});

webhooks.get("/subdivision/waiting", async (_req, res) => {
  res.json({ waiting: await subdivisionOutbox().waiting() });
});

webhooks.post("/subdivision/events/:eventId/replay", async (req, res) => {
  const id = String(req.params.eventId ?? "");
  const event = await subdivisionOutbox().replay(id, Date.now());
  if (!event) throw new HttpError(409, "Only a dead-lettered event can be replayed.", "not_dead_lettered");
  void writeAudit({ username: req.user!.username, appRole: req.user!.appRole, action: "webhook.replay", target: event.key, outcome: "success", details: { event_id: id }, ip: req.ip, requestId: String(req.id) }).catch(() => undefined);
  res.json({ event });
});
