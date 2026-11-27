import { Injectable } from "@nestjs/common";
import { logger } from "../../../common/logging/logger.js";
import { writeAudit } from "../../../common/audit/audit-log.js";
import { withServiceToken } from "../../../common/arcgis/arcgis-client.js";
import { HttpError } from "../../../common/errors/http-error.js";
import { laisError, LaisFailure, laisSuccess } from "../../../common/errors/lais-failure.js";
import type { RequestInfo } from "../../../common/http/request-info.js";
import type { FieldError } from "../models/transaction.model.js";
import { LaisConfigurationError } from "../domain/gis-errors.js";
import { validateSubmission } from "../domain/submission-validator.js";
import { submitTransaction } from "../domain/submit-transaction.js";
import { listTransactions, transactionStatus } from "../domain/transaction-queries.js";
import { ChangesError, versionChanges } from "../domain/version-changes.js";
import { approveTransaction, DecisionError, rejectTransaction } from "../domain/approval.js";
import { editingDoneEnabled } from "../domain/editing-done.js";
import { parseDecisionBody, parseListQuery } from "../domain/request-validators.js";

type Outcome = "success" | "failure";

const PLOT_FIELDS_MESSAGE = {
  written: "The transaction fields are written on the parcel(s) in the Plot table, inside that version.",
  "version-only": "The transaction fields are not written on the Plot table (LAIS_WRITE_MODE is version-only).",
  "no-parcel": "No existing parcel to write the transaction fields on.",
} as const;

const validationFailed =(errors: FieldError[]) => new LaisFailure(422, "Validation failed", errors);

const flowNotEnabled = () =>
  laisError(409, "The approval flow is not switched on in GIS yet.", "request", "FLOW_NOT_ENABLED", "GIS posts LAIS transactions itself until the approval flow is switched on (LAIS_EDITING_DONE).");

/** GIS problems never leak service internals to LAIS; the details stay in the server log. */
export function gisFailure(error: unknown, transactionId: string | undefined, operation: string): HttpError {
  if (error instanceof LaisConfigurationError) {
    logger.error({ err: error.message, transactionId }, `LAIS ${operation}: GIS service is not configured as expected`);
    return new HttpError(503, "The GIS integration is not available. Contact the GIS integration administrator.", "gis_not_configured");
  }
  logger.error({ err: error, transactionId }, `LAIS ${operation}: GIS operation failed`);
  return new HttpError(502, "GIS could not process the request right now. Retry later with the same payload.", "gis_unavailable");
}

function decisionFailure(error: DecisionError): LaisFailure {
  const field = error.code.startsWith("CELL") ? "cell" : error.code === "EVENT_MISMATCH" ? "event_id" : "Transaction_ID";
  return new LaisFailure(error.status, error.message, [{ field, code: error.code, message: error.message }], error.data);
}

@Injectable()
export class LaisTransactionsService {
  private audit(info: RequestInfo, action: string, transactionId: string | undefined, outcome: Outcome, details: Record<string, unknown>): void {
    void writeAudit({ username: "LAIS", appRole: "INTEGRATION", action, target: transactionId, outcome, details, ip: info.ip, requestId: info.requestId }).catch(() => undefined);
  }

  private auditSubmit(info: RequestInfo, transactionId: string | undefined, outcome: Outcome, details: Record<string, unknown>): void {
    this.audit(info, "lais.transaction.submit", transactionId, outcome, details);
  }

  /** Validate, find the Plots, create the transaction's public version and record the fields there. */
  async submit(body: unknown, info: RequestInfo) {
    const parsed = validateSubmission(body);
    if (!parsed.ok) {
      const id = (body as { Transaction_ID?: unknown } | null)?.Transaction_ID;
      this.auditSubmit(info, typeof id === "string" ? id.slice(0, 50) : undefined, "failure", { code: "VALIDATION_FAILED", errors: parsed.errors.map((e) => e.code) });
      throw validationFailed(parsed.errors);
    }
    const input = parsed.value;
    const outcome = await withServiceToken((token) => submitTransaction(token, input, parsed.listForm)).catch((error: unknown) => {
      this.auditSubmit(info, input.Transaction_ID, "failure", { code: "GIS_ERROR" });
      throw gisFailure(error, input.Transaction_ID, "submission");
    });
    const codes = (errors: FieldError[]) => errors.map((e) => e.code);

    switch (outcome.kind) {
      case "invalid":
        this.auditSubmit(info, input.Transaction_ID, "failure", { UPIs: input.UPIs, errors: codes(outcome.errors) });
        throw validationFailed(outcome.errors);
      case "conflict":
        this.auditSubmit(info, input.Transaction_ID, "failure", { UPIs: input.UPIs, errors: codes(outcome.errors) });
        throw new LaisFailure(409, "Transaction_ID conflict", outcome.errors);
      case "busy":
        this.auditSubmit(info, input.Transaction_ID, "failure", { UPIs: input.UPIs, errors: codes(outcome.errors), heldBy: outcome.errors.map((e) => e.transactionId) });
        throw new LaisFailure(409, "A parcel is already in another transaction that GIS has not finished.", outcome.errors);
      case "duplicate":
        this.auditSubmit(info, input.Transaction_ID, "failure", { UPIs: input.UPIs, code: "ALREADY_RECORDED", version: outcome.record.version_name, stage: outcome.record.stage });
        throw this.alreadyRecorded(outcome.record);
      case "created":
        this.auditSubmit(info, input.Transaction_ID, "success", { UPIs: input.UPIs, version: outcome.record.version_name, plotFields: outcome.plotFields });
        return laisSuccess(`Transaction validated and recorded in a GIS version for review. ${PLOT_FIELDS_MESSAGE[outcome.plotFields]}`, outcome.record);
    }
  }

  private alreadyRecorded(record: { stage: string }): LaisFailure {
    const message = `This Transaction_ID was already recorded (stage ${record.stage}); nothing new was created. Its current state is in data, or GET /transactions/{Transaction_ID}.`;
    return new LaisFailure(409, "This transaction was already recorded.", [{ field: "Transaction_ID", code: "ALREADY_RECORDED", message }], record);
  }

  /** All transactions, oldest change first; poll with updatedSince = the previous next_updated_since. */
  async list(query: Record<string, unknown>) {
    const { value: options, errors } = parseListQuery(query);
    if (errors.length) throw new LaisFailure(400, "Invalid query", errors);
    const outcome = await withServiceToken((token) => listTransactions(token, options)).catch((error: unknown) => {
      throw gisFailure(error, undefined, "transaction list");
    });
    return laisSuccess(`${outcome.transactions.length} transaction(s).`, outcome);
  }

  async findOne(transactionId: string) {
    const id = transactionId.trim();
    if (!id) throw laisError(400, "A valid Transaction_ID is required.", "Transaction_ID", "INVALID_TRANSACTION_ID", "Give the Transaction_ID in the path.");
    const outcome = await withServiceToken((token) => transactionStatus(token, id)).catch((error: unknown) => {
      throw gisFailure(error, id, "status lookup");
    });
    if (outcome.kind === "not_found") {
      throw laisError(404, "No recorded transaction has this Transaction_ID.", "Transaction_ID", "NOT_FOUND", "If the submission returned case=No, correct the errors and resubmit. If it returned 5xx, resubmit the same payload.");
    }
    if (outcome.kind === "conflict") {
      throw laisError(409, "GIS holds more than one record for this Transaction_ID.", "Transaction_ID", "DUPLICATE_TRANSACTION_ID", "Contact the GIS integration administrator.");
    }
    return laisSuccess("Transaction found.", outcome.record, outcome.record.case ?? "Yes");
  }

  /** What the version changed compared with sde.DEFAULT. */
  async changes(transactionId: string, withGeometry: boolean) {
    const id = transactionId.trim();
    try {
      const data = await withServiceToken((token) => versionChanges(token, id, { geometry: withGeometry }));
      return { success: true, message: data.warnings.length ? "Changes read; see warnings." : "Changes read.", data };
    } catch (error) {
      if (error instanceof ChangesError) throw laisError(error.status, error.message, "Transaction_ID", error.code);
      throw gisFailure(error, id, "changes");
    }
  }

  /** The registrar approved the work (event_id): GIS assigns the UPIs, posts, and answers them by parcel_ref. */
  async approve(transactionId: string, body: unknown, info: RequestInfo) {
    if (!editingDoneEnabled()) throw flowNotEnabled();
    const id = transactionId.trim();
    const { value, errors } = parseDecisionBody(body, { event_id: 36, approved_by: 100 }, { cell: 20 });
    if (errors.length) {
      this.audit(info, "lais.transaction.approve", id, "failure", { code: "VALIDATION_FAILED", errors: errors.map((e) => e.code) });
      throw validationFailed(errors);
    }
    let approval;
    try {
      approval = await withServiceToken((token) => approveTransaction(token, id, { eventId: value.event_id!, approvedBy: value.approved_by!, cell: value.cell }));
    } catch (error) {
      if (error instanceof DecisionError) {
        this.audit(info, "lais.transaction.approve", id, "failure", { code: error.code, event_id: value.event_id, approved_by: value.approved_by });
        throw decisionFailure(error);
      }
      this.audit(info, "lais.transaction.approve", id, "failure", { code: "GIS_ERROR", event_id: value.event_id });
      throw gisFailure(error, id, "approval");
    }
    this.audit(info, "lais.transaction.approve", id, "success", { event_id: approval.event_id, approved_by: approval.approved_by, UPIs: approval.upis.map((u) => u.UPI) });
    const status = await withServiceToken((token) => transactionStatus(token, id)).catch(() => null);
    const record = status?.kind === "found" ? status.record : { Transaction_ID: id };
    return laisSuccess(`Approved: GIS posted the change with ${approval.upis.length} parcel(s).`, { ...record, approval });
  }

  /** The registrar rejected the work (event_id); the editor revises it and sends it again. */
  async reject(transactionId: string, body: unknown, info: RequestInfo) {
    if (!editingDoneEnabled()) throw flowNotEnabled();
    const id = transactionId.trim();
    const { value, errors } = parseDecisionBody(body, { event_id: 36, rejected_by: 100, reason: 1000 });
    if (errors.length) {
      this.audit(info, "lais.transaction.reject", id, "failure", { code: "VALIDATION_FAILED", errors: errors.map((e) => e.code) });
      throw validationFailed(errors);
    }
    try {
      const rejection = await rejectTransaction(id, { eventId: value.event_id!, rejectedBy: value.rejected_by!, reason: value.reason! });
      this.audit(info, "lais.transaction.reject", id, "success", { event_id: rejection.event_id, rejected_by: rejection.rejected_by, reason: rejection.reason });
      return laisSuccess("Rejection recorded. The GIS editor will revise the work and send it again.", { Transaction_ID: id, rejection });
    } catch (error) {
      if (!(error instanceof DecisionError)) throw error;
      this.audit(info, "lais.transaction.reject", id, "failure", { code: error.code, event_id: value.event_id });
      throw new LaisFailure(error.status, error.message, [{ field: error.code === "EVENT_MISMATCH" ? "event_id" : "Transaction_ID", code: error.code, message: error.message }], error.data);
    }
  }
}

