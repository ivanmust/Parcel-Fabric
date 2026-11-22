import { Router } from "express";
import { z } from "zod";
import { config } from "../config/env.js";
import { requireAuth, requirePermission, bearerToken } from "../middleware/authenticate.js";
import { forgetToken } from "../authentication/portalAuth.js";
import { readAudit, writeAudit } from "../audit/auditLog.js";
import { HttpError } from "../utils/httpError.js";
import { logger } from "../logging/logger.js";

export const api = Router();

/**
 * Liveness + ArcGIS Enterprise reachability (public `rest/info`, no token needed). The check is
 * cached briefly so this public endpoint can't be used to make the server hammer ArcGIS.
 */
const HEALTH_TTL_MS = 15_000;
let health: { at: number; arcgis: Record<string, unknown> } | null = null;

api.get("/health", async (_req, res) => {
  if (!health || Date.now() - health.at > HEALTH_TTL_MS) {
    const started = Date.now();
    let arcgis: Record<string, unknown>;
    try {
      const r = await fetch(`${config.ARCGIS_SERVER_URL}/rest/info?f=json`, { signal: AbortSignal.timeout(10_000) });
      const info = (await r.json()) as { fullVersion?: string; currentVersion?: number };
      arcgis = { reachable: r.ok, version: info.fullVersion ?? info.currentVersion, latencyMs: Date.now() - started };
    } catch (err) {
      // Details stay in the server log; the public response only says it's unreachable.
      logger.warn({ err: (err as Error).message }, "ArcGIS Enterprise health check failed");
      arcgis = { reachable: false };
    }
    health = { at: Date.now(), arcgis };
  }
  res.json({ status: "ok", time: new Date().toISOString(), arcgis: health.arcgis });
});

/** Public, non-secret runtime configuration consumed by the web client. */
api.get("/config", (_req, res) => {
  res.json({
    portalUrl: config.PORTAL_URL,
    serverUrl: config.ARCGIS_SERVER_URL,
    oauthAppId: config.ARCGIS_OAUTH_APP_ID || null,
    services: config.services,
    project: { name: "Kigali Parcel Fabric", dataset: "kigaliParcels" },
  });
});

/** Resolve the signed-in Portal user into an application session (role + permissions). */
api.get("/auth/session", requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

api.post("/auth/signed-in", requireAuth, async (req, res) => {
  await writeAudit({
    username: req.user!.username,
    appRole: req.user!.appRole,
    action: "auth.sign-in",
    outcome: "success",
    ip: req.ip,
    requestId: String(req.id),
  });
  res.status(204).end();
});

api.post("/auth/signed-out", async (req, res) => {
  const token = bearerToken(req);
  if (token) forgetToken(token);
  res.status(204).end();
});

const AuditBody = z.object({
  action: z.string().min(3).max(120).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  target: z.string().max(500).optional(),
  outcome: z.enum(["success", "failure", "attempt"]),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Client-reported GIS operations (edits, version ops, validation runs, exports). */
api.post("/audit", requireAuth, async (req, res) => {
  const parsed = AuditBody.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Invalid audit event", "invalid_audit_event", parsed.error.issues);
  const event = await writeAudit({
    ...parsed.data,
    username: req.user!.username,
    appRole: req.user!.appRole,
    ip: req.ip,
    requestId: String(req.id),
  });
  res.status(201).json({ id: event.id });
});

api.get("/audit", requireAuth, requirePermission("admin:audit"), async (req, res) => {
  const q = z
    .object({
      username: z.string().max(200).optional(),
      action: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    })
    .safeParse(req.query);
  if (!q.success) throw new HttpError(400, "Invalid query", "invalid_query", q.error.issues);
  res.json({ events: await readAudit(q.data) });
});

/** Client-side error reports, so production issues reach the server log. */
api.post("/client-log", requireAuth, (req, res) => {
  const body = z
    .object({ level: z.enum(["error", "warn"]), message: z.string().max(2000), context: z.string().max(4000).optional() })
    .safeParse(req.body);
  if (body.success) logger[body.data.level]({ user: req.user!.username, context: body.data.context }, body.data.message);
  res.status(204).end();
});
