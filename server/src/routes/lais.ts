import { Router, type Request, type Response } from "express";
import { requireLaisApiKey } from "../middleware/apiKey.js";
import { HttpError } from "../utils/httpError.js";
import { logger } from "../logging/logger.js";
import { writeAudit } from "../audit/auditLog.js";
import { withServiceToken } from "../lais/arcgisClient.js";
import {
  isValidTransactionDate,
  LaisConfigurationError,
  listTransactions,
  STAGES,
  submitTransaction,
  transactionStatus,
  validateSubmission,
  type FieldError,
  type Stage,
} from "../lais/laisService.js";
import { approveTransaction, CELL_PATTERN, DecisionError, rejectTransaction } from "../lais/approval.js";
import { editingDoneEnabled } from "../lais/editingDone.js";
import { ChangesError, versionChanges } from "../lais/versionChanges.js";

/**
 * LAIS server-to-server API (mounted at /api/lais).
 *
 * Every response is JSON of one shape:
 *   success: { success: true,  case: "Yes", message, data }
 *   failure: { success: false, case: "No",  message, errors: [{ field, code, message }], requestId }
 * `case` is decided by this API, never by LAIS.
 */
export const lais = Router();

export function laisFailure(req: Request, res: Response, status: number, message: string, errors: FieldError[]) {
  res.status(status).json({ success: false, case: "No", message, errors, requestId: req.id });
}

/** Dedicated LAIS authentication (X-API-Key, see requireLaisApiKey); never a browser Portal token. */
lais.use(requireLaisApiKey);

function audit(req: Request, transactionId: string | undefined, outcome: "success" | "failure", details: Record<string, unknown>) {
  void writeAudit({
    username: "LAIS",
    appRole: "INTEGRATION",
    action: "lais.transaction.submit",
    target: transactionId,
    outcome,
    details,
    ip: req.ip,
    requestId: String(req.id),
  }).catch(() => undefined); // writeAudit already logs failures loudly
}

/** GIS problems never leak service internals to LAIS; details stay in the server log. */
function gisFailure(error: unknown, transactionId: string | undefined, what: string): HttpError {
  if (error instanceof LaisConfigurationError) {
    logger.error({ err: error.message, transactionId }, `LAIS ${what}: GIS service is not configured as expected`);
    return new HttpError(503, "The GIS integration is not available. Contact the GIS integration administrator.", "gis_not_configured");
  }
  logger.error({ err: error, transactionId }, `LAIS ${what}: GIS operation failed`);
  return new HttpError(502, "GIS could not process the request right now. Retry later with the same payload.", "gis_unavailable");
}

/** Submit a transaction: validate, find the Plot, create its public version and record the fields there. */
lais.post("/transactions", async (req, res) => {
  const parsed = validateSubmission(req.body);
  if (!parsed.ok) {
    audit(req, typeof req.body?.Transaction_ID === "string" ? req.body.Transaction_ID.slice(0, 50) : undefined, "failure", { code: "VALIDATION_FAILED", errors: parsed.errors.map((e) => e.code) });
    return laisFailure(req, res, 422, "Validation failed", parsed.errors);
  }
  const input = parsed.value;

  let outcome;
  try {
    outcome = await withServiceToken((token) => submitTransaction(token, input, parsed.listForm));
  } catch (error) {
    audit(req, input.Transaction_ID, "failure", { code: "GIS_ERROR" });
    throw gisFailure(error, input.Transaction_ID, "submission");
  }

  switch (outcome.kind) {
    case "invalid":
      audit(req, input.Transaction_ID, "failure", { UPIs: input.UPIs, errors: outcome.errors.map((e) => e.code) });
      return laisFailure(req, res, 422, "Validation failed", outcome.errors);
    case "conflict":
      audit(req, input.Transaction_ID, "failure", { UPIs: input.UPIs, errors: outcome.errors.map((e) => e.code) });
      return laisFailure(req, res, 409, "Transaction_ID conflict", outcome.errors);
    case "busy":
      audit(req, input.Transaction_ID, "failure", { UPIs: input.UPIs, errors: outcome.errors.map((e) => e.code), heldBy: outcome.errors.map((e) => e.transactionId) });
      return laisFailure(req, res, 409, "A parcel is already in another transaction that GIS has not finished.", outcome.errors);
    case "duplicate": {
      // Not created again: a clear failure, with the transaction as it stands in `data`.
      audit(req, input.Transaction_ID, "failure", { UPIs: input.UPIs, code: "ALREADY_RECORDED", version: outcome.record.version_name, stage: outcome.record.stage });
      const errors: FieldError[] = [{ field: "Transaction_ID", code: "ALREADY_RECORDED", message: `This Transaction_ID was already recorded (stage ${outcome.record.stage}); nothing new was created. Its current state is in data, or GET /transactions/{Transaction_ID}.` }];
      return res.status(409).json({ success: false, case: "No", message: "This transaction was already recorded.", errors, data: outcome.record, requestId: req.id });
    }
    case "created":
      audit(req, input.Transaction_ID, "success", { UPIs: input.UPIs, version: outcome.record.version_name });
      return res.status(201).json({ success: true, case: "Yes", message: "Transaction validated and recorded in a GIS version for review.", data: outcome.record });
  }
});

const LIST_PARAMS = new Set(["updatedSince", "stage", "limit"]);

/**
 * All transactions for the LAIS dashboard, oldest change first. Poll with updatedSince = the previous
 * response's next_updated_since to get only transactions whose stage, result or warnings changed.
 */
lais.get("/transactions", async (req, res) => {
  const errors: FieldError[] = [];
  const query = req.query as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (!LIST_PARAMS.has(key)) errors.push({ field: key, code: "UNKNOWN_FIELD", message: `Unknown query parameter ${key}. Allowed: updatedSince, stage, limit.` });
  }
  const one = (key: string) => (typeof query[key] === "string" ? (query[key] as string).trim() : query[key] === undefined ? undefined : null);

  const since = one("updatedSince");
  let updatedSince: number | undefined;
  if (since !== undefined) {
    if (since && isValidTransactionDate(since)) updatedSince = Date.parse(since);
    else errors.push({ field: "updatedSince", code: "INVALID_DATE", message: "Use an ISO 8601 date-time with an explicit timezone, for example 2026-11-26T08:30:00Z." });
  }
  const stageRaw = one("stage");
  let stage: Stage | undefined;
  if (stageRaw !== undefined) {
    stage = STAGES.find((s) => s.toLowerCase() === String(stageRaw ?? "").toLowerCase());
    if (!stage) errors.push({ field: "stage", code: "INVALID_STAGE", message: `Allowed values: ${STAGES.join(", ")}.` });
  }
  const limitRaw = one("limit");
  let limit = 100;
  if (limitRaw !== undefined) {
    limit = /^\d+$/.test(String(limitRaw ?? "")) ? Number(limitRaw) : NaN;
    if (!(limit >= 1 && limit <= 200)) errors.push({ field: "limit", code: "INVALID_LIMIT", message: "limit must be a whole number from 1 to 200." });
  }
  if (errors.length) return laisFailure(req, res, 400, "Invalid query", errors);

  let outcome;
  try {
    outcome = await withServiceToken((token) => listTransactions(token, { updatedSince, stage, limit }));
  } catch (error) {
    throw gisFailure(error, undefined, "transaction list");
  }
  res.json({ success: true, case: "Yes", message: `${outcome.transactions.length} transaction(s).`, data: outcome });
});

// ---------------------------------------------------------------- the registrar's decision

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body checks in the LAIS error shape: unknown fields, required text, lengths. */
function decisionBody(body: unknown, required: Record<string, number>, optional: Record<string, number> = {}): { values: Record<string, string>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const values: Record<string, string> = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { values, errors: [{ field: "body", code: "INVALID_BODY", message: "Send a JSON object." }] };
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in required) && !(key in optional)) errors.push({ field: key, code: "UNKNOWN_FIELD", message: `Unknown field ${key}. Allowed: ${[...Object.keys(required), ...Object.keys(optional)].join(", ")}.` });
  }
  for (const [key, max] of Object.entries({ ...required, ...optional })) {
    const value = input[key];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      if (key in required) errors.push({ field: key, code: "REQUIRED", message: `${key} is required.` });
      continue;
    }
    if (typeof value !== "string") errors.push({ field: key, code: "INVALID_TYPE", message: `${key} must be text.` });
    else if (value.trim().length > max) errors.push({ field: key, code: "TOO_LONG", message: `${key} must be at most ${max} characters.` });
    else values[key] = value.trim();
  }
  if (values.event_id && !UUID.test(values.event_id)) errors.push({ field: "event_id", code: "INVALID_EVENT_ID", message: "event_id is the UUID of the editing-done notification." });
  if (values.cell && !CELL_PATTERN.test(values.cell)) errors.push({ field: "cell", code: "INVALID_CELL", message: "cell is a UPI prefix province/district/sector/cell, for example 1/02/13/02." });
  return { values, errors };
}

function decisionAudit(req: Request, action: string, transactionId: string, outcome: "success" | "failure", details: Record<string, unknown>) {
  void writeAudit({ username: "LAIS", appRole: "INTEGRATION", action, target: transactionId, outcome, details, ip: req.ip, requestId: String(req.id) }).catch(() => undefined);
}

function decisionFailure(req: Request, res: Response, error: DecisionError, field = "Transaction_ID") {
  res.status(error.status).json({
    success: false,
    case: "No",
    message: error.message,
    errors: [{ field, code: error.code, message: error.message }],
    ...(error.data ? { data: error.data } : {}),
    requestId: req.id,
  });
}

const flowOff = (req: Request, res: Response) =>
  laisFailure(req, res, 409, "The approval flow is not switched on in GIS yet.", [{ field: "request", code: "FLOW_NOT_ENABLED", message: "GIS posts LAIS transactions itself until the approval flow is switched on (LAIS_EDITING_DONE)." }]);

/**
 * The registrar approved the work GIS sent (event_id): GIS assigns the new parcels' UPIs, posts the
 * version to sde.DEFAULT and answers with the UPIs by parcel_ref. Safe to repeat after a failure.
 */
lais.post("/transactions/:transactionId/approve", async (req, res) => {
  if (!editingDoneEnabled()) return flowOff(req, res);
  const id = String(req.params.transactionId ?? "").trim();
  const { values, errors } = decisionBody(req.body, { event_id: 36, approved_by: 100 }, { cell: 20 });
  if (errors.length) {
    decisionAudit(req, "lais.transaction.approve", id, "failure", { code: "VALIDATION_FAILED", errors: errors.map((e) => e.code) });
    return laisFailure(req, res, 422, "Validation failed", errors);
  }
  let approval;
  try {
    approval = await withServiceToken((token) => approveTransaction(token, id, { eventId: values.event_id!, approvedBy: values.approved_by!, cell: values.cell }));
  } catch (error) {
    if (error instanceof DecisionError) {
      decisionAudit(req, "lais.transaction.approve", id, "failure", { code: error.code, event_id: values.event_id, approved_by: values.approved_by });
      return decisionFailure(req, res, error, error.code.startsWith("CELL") ? "cell" : error.code === "EVENT_MISMATCH" ? "event_id" : "Transaction_ID");
    }
    decisionAudit(req, "lais.transaction.approve", id, "failure", { code: "GIS_ERROR", event_id: values.event_id });
    throw gisFailure(error, id, "approval");
  }
  decisionAudit(req, "lais.transaction.approve", id, "success", { event_id: approval.event_id, approved_by: approval.approved_by, UPIs: approval.upis.map((u) => u.UPI) });
  // The transaction as LAIS sees it now (stage Posted, result parcels), plus the UPIs by parcel_ref.
  const status = await withServiceToken((token) => transactionStatus(token, id)).catch(() => null);
  const record = status?.kind === "found" ? status.record : null;
  res.json({ success: true, case: "Yes", message: `Approved: GIS posted the change with ${approval.upis.length} parcel(s).`, data: { ...(record ?? { Transaction_ID: id }), approval } });
});

/** The registrar rejected the work GIS sent (event_id): recorded; the editor revises and sends it again. */
lais.post("/transactions/:transactionId/reject", async (req, res) => {
  if (!editingDoneEnabled()) return flowOff(req, res);
  const id = String(req.params.transactionId ?? "").trim();
  const { values, errors } = decisionBody(req.body, { event_id: 36, rejected_by: 100, reason: 1000 });
  if (errors.length) {
    decisionAudit(req, "lais.transaction.reject", id, "failure", { code: "VALIDATION_FAILED", errors: errors.map((e) => e.code) });
    return laisFailure(req, res, 422, "Validation failed", errors);
  }
  try {
    const rejection = await rejectTransaction(id, { eventId: values.event_id!, rejectedBy: values.rejected_by!, reason: values.reason! });
    decisionAudit(req, "lais.transaction.reject", id, "success", { event_id: rejection.event_id, rejected_by: rejection.rejected_by, reason: rejection.reason });
    res.json({ success: true, case: "Yes", message: "Rejection recorded. The GIS editor will revise the work and send it again.", data: { Transaction_ID: id, rejection } });
  } catch (error) {
    if (!(error instanceof DecisionError)) throw error;
    decisionAudit(req, "lais.transaction.reject", id, "failure", { code: error.code, event_id: values.event_id });
    decisionFailure(req, res, error, error.code === "EVENT_MISMATCH" ? "event_id" : "Transaction_ID");
  }
});

/** Status of a submitted transaction. */
lais.get("/transactions/:transactionId", async (req, res) => {
  const id = String(req.params.transactionId ?? "").trim();
  if (!id) {
    return laisFailure(req, res, 400, "A valid Transaction_ID is required.", [{ field: "Transaction_ID", code: "INVALID_TRANSACTION_ID", message: "Give the Transaction_ID in the path." }]);
  }
  let outcome;
  try {
    outcome = await withServiceToken((token) => transactionStatus(token, id));
  } catch (error) {
    throw gisFailure(error, id, "status lookup");
  }
  if (outcome.kind === "not_found") {
    return laisFailure(req, res, 404, "No recorded transaction has this Transaction_ID.", [{ field: "Transaction_ID", code: "NOT_FOUND", message: "If the submission returned case=No, correct the errors and resubmit. If it returned 5xx, resubmit the same payload." }]);
  }
  if (outcome.kind === "conflict") {
    return laisFailure(req, res, 409, "GIS holds more than one record for this Transaction_ID.", [{ field: "Transaction_ID", code: "DUPLICATE_TRANSACTION_ID", message: "Contact the GIS integration administrator." }]);
  }
  res.json({ success: true, case: outcome.record.case ?? "Yes", message: "Transaction found.", data: outcome.record });
});

/** What the transaction's version changed compared with sde.DEFAULT (ArcGIS "differences"): the review data. */
lais.get("/transactions/:transactionId/changes", async (req, res) => {
  const id = String(req.params.transactionId ?? "").trim();
  const geometry = String(req.query.geometry ?? "false").toLowerCase() === "true";
  try {
    const data = await withServiceToken((token) => versionChanges(token, id, { geometry }));
    res.json({ success: true, message: data.warnings.length ? "Changes read; see warnings." : "Changes read.", data });
  } catch (error) {
    if (error instanceof ChangesError) return laisFailure(req, res, error.status, error.message, [{ field: "Transaction_ID", code: error.code, message: error.message }]);
    throw gisFailure(error, id, "changes");
  }
});
