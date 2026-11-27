import { Injectable } from "@nestjs/common";
import { logger } from "../../../common/logging/logger.js";
import { writeAudit } from "../../../common/audit/audit-log.js";
import { withServiceToken } from "../../../common/arcgis/arcgis-client.js";
import { HttpError } from "../../../common/errors/http-error.js";
import type { SessionUser } from "../../../common/auth/portal-auth.js";
import type { RequestInfo } from "../../../common/http/request-info.js";
import { EditingDoneError } from "../models/editing-done.model.js";
import { LaisConfigurationError } from "../domain/gis-errors.js";
import { ChangesError, versionChanges } from "../domain/version-changes.js";
import { editingDoneEnabled, previewEditingDone, requestEditingDone, transactionsForEditors, webhookConfigured } from "../domain/editing-done.js";


/** The editor named in the notification: the signed-in user, or nobody for the API key. */
const editorName = (user: SessionUser) => (user.isApiClient ? "" : user.username);

function requireEnabled(): void {
  if (!editingDoneEnabled()) throw new HttpError(503, "Editing done is switched off on this server (LAIS_EDITING_DONE).", "feature_disabled");
}

function requireTransactionId(transactionId: string): string {
  const id = transactionId.trim();
  if (!id) throw new HttpError(400, "A Transaction_ID is required", "invalid_transaction_id");
  return id;
}

/** Answers the editor can act on; GIS internals stay in the server log. */
function editingFailure(error: unknown, transactionId: string, operation: string): HttpError {
  if (error instanceof EditingDoneError) return new HttpError(error.status, error.message, error.code, error.details);
  if (error instanceof HttpError) return error;
  if (error instanceof LaisConfigurationError) {
    logger.error({ err: error.message, transactionId }, `LAIS editing done (${operation}): GIS service is not configured as expected`);
    return new HttpError(503, "The GIS integration is not available. Contact the GIS integration administrator.", "gis_not_configured");
  }
  logger.error({ err: error, transactionId }, `LAIS editing done (${operation}): GIS operation failed`);
  return new HttpError(502, "GIS could not be read right now. Try again in a moment.", "gis_unavailable");
}

@Injectable()
export class LaisEditingService {
  async list() {
    return { enabled: editingDoneEnabled(), configured: webhookConfigured(), transactions: await transactionsForEditors() };
  }

  async changes(transactionId: string, withGeometry: boolean) {
    const id = requireTransactionId(transactionId);
    try {
      return await withServiceToken((token) => versionChanges(token, id, { geometry: withGeometry }));
    } catch (error) {
      if (error instanceof ChangesError) throw new HttpError(error.status, error.message, error.code.toLowerCase());
      throw editingFailure(error, id, "changes");
    }
  }

  /** What would be sent to LAIS, with any problems to fix first. Sends nothing. */
  async preview(transactionId: string, user: SessionUser) {
    requireEnabled();
    const id = requireTransactionId(transactionId);
    try {
      return await previewEditingDone(id, editorName(user));
    } catch (error) {
      throw editingFailure(error, id, "preview");
    }
  }

  /** The editor has finished: send the work under the record named after the version to LAIS. 200 delivered, else 202. */
  async editingDone(transactionId: string, user: SessionUser, info: RequestInfo) {
    requireEnabled();
    const id = requireTransactionId(transactionId);
    const audit = (outcome: "success" | "failure", details: Record<string, unknown>) =>
      void writeAudit({ username: user.username, appRole: user.appRole, action: "lais.editing-done", target: id, outcome, details, ip: info.ip, requestId: info.requestId }).catch(() => undefined);

    try {
      const result = await withServiceToken((token) => requestEditingDone(token, id, editorName(user)));
      const { view } = result;
      audit(view.status === "refused" || view.status === "failed" ? "failure" : "success", {
        record: view.record_name,
        parcels: view.parcels,
        status: view.status,
        event_id: view.event_id,
        ...(view.last_result ? { result: view.last_result } : {}),
      });
      return { status: view.status === "delivered" ? 200 : 202, body: { editing_done: view, warnings: result.warnings } };
    } catch (error) {
      const failure = editingFailure(error, id, "send");
      audit("failure", { code: failure.code, message: failure.message });
      throw failure;
    }
  }
}
