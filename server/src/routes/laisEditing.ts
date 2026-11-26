import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../middleware/authenticate.js";
import { HttpError } from "../utils/httpError.js";
import { logger } from "../logging/logger.js";
import { writeAudit } from "../audit/auditLog.js";
import { withServiceToken } from "../lais/arcgisClient.js";
import { LaisConfigurationError } from "../lais/laisService.js";
import { EditingDoneError, editingDoneEnabled, previewEditingDone, requestEditingDone, transactionsForEditors, webhookConfigured } from "../lais/editingDone.js";

/**
 * "Editing done" for GIS editors (mounted at /api/lais-editing): the web app's side of the GIS → LAIS
 * notification. Signed-in editors only. GIS is read with the LAIS service account, which owns the
 * transaction versions; nothing is edited.
 */
export const laisEditing = Router();
laisEditing.use(requireAuth, requirePermission("features:edit"));

const requireEnabled = () => {
  if (!editingDoneEnabled()) throw new HttpError(503, "Editing done is switched off on this server (LAIS_EDITING_DONE).", "feature_disabled");
};

const idOf = (req: Request) => {
  const id = String(req.params.transactionId ?? "").trim();
  if (!id) throw new HttpError(400, "A Transaction_ID is required", "invalid_transaction_id");
  return id;
};

/** Turn service errors into answers the editor can act on; GIS internals stay in the server log. */
function failure(error: unknown, transactionId: string, what: string): HttpError {
  if (error instanceof EditingDoneError) return new HttpError(error.status, error.message, error.code, error.details);
  if (error instanceof HttpError) return error;
  if (error instanceof LaisConfigurationError) {
    logger.error({ err: error.message, transactionId }, `LAIS editing done (${what}): GIS service is not configured as expected`);
    return new HttpError(503, "The GIS integration is not available. Contact the GIS integration administrator.", "gis_not_configured");
  }
  logger.error({ err: error, transactionId }, `LAIS editing done (${what}): GIS operation failed`);
  return new HttpError(502, "GIS could not be read right now. Try again in a moment.", "gis_unavailable");
}

const Body = z.object({ recordName: z.string().trim().max(255).optional() }).strict();

/** The LAIS transactions with a version, and where each one's notification stands. */
laisEditing.get("/transactions", async (_req, res) => {
  res.json({ enabled: editingDoneEnabled(), configured: webhookConfigured(), transactions: await transactionsForEditors() });
});

/** What would be sent to LAIS, with any problems to fix first. Sends nothing. */
laisEditing.get("/transactions/:transactionId/preview", async (req, res) => {
  requireEnabled();
  const id = idOf(req);
  const recordName = typeof req.query.recordName === "string" ? req.query.recordName.trim().slice(0, 255) : undefined;
  try {
    res.json(await withServiceToken((token) => previewEditingDone(token, id, req.user!.username, recordName)));
  } catch (error) {
    throw failure(error, id, "preview");
  }
});

/** The editor has finished: send the work to LAIS for the registrar's approval. */
laisEditing.post("/transactions/:transactionId/editing-done", async (req, res) => {
  requireEnabled();
  const id = idOf(req);
  const body = Body.safeParse(req.body ?? {});
  if (!body.success) throw new HttpError(400, "Invalid request", "invalid_body", body.error.issues);
  const audit = (outcome: "success" | "failure", details: Record<string, unknown>) =>
    void writeAudit({ username: req.user!.username, appRole: req.user!.appRole, action: "lais.editing-done", target: id, outcome, details, ip: req.ip, requestId: String(req.id) }).catch(() => undefined);
  try {
    const result = await withServiceToken((token) => requestEditingDone(token, id, req.user!.username, body.data.recordName));
    audit(result.view.status === "refused" || result.view.status === "failed" ? "failure" : "success", {
      record: result.view.record_name,
      parcels: result.view.parcels,
      status: result.view.status,
      event_id: result.view.event_id,
      ...(result.view.last_result ? { result: result.view.last_result } : {}),
    });
    res.status(result.view.status === "delivered" ? 200 : 202).json({ editing_done: result.view, warnings: result.warnings });
  } catch (error) {
    const e = failure(error, id, "send");
    audit("failure", { code: e.code, message: e.message });
    throw e;
  }
});
