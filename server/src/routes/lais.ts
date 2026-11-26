import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { config } from "../config/env.js";
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

/**
 * LAIS server-to-server API (mounted at /api/lais).
 *
 * Every response is JSON of one shape:
 *   success: { success: true,  case: "Yes", message, data }
 *   failure: { success: false, case: "No",  message, errors: [{ field, code, message }], requestId }
 * `case` is decided by this API, never by LAIS.
 */
export const lais = Router();

function sameSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function laisFailure(req: Request, res: Response, status: number, message: string, errors: FieldError[]) {
  res.status(status).json({ success: false, case: "No", message, errors, requestId: req.id });
}

/**
 * Dedicated LAIS authentication; never accepts or reuses a browser Portal token. During a key change
 * LAIS_API_KEY_PREVIOUS (the old key) is accepted too, so LAIS can switch without downtime; remove it
 * once LAIS uses the new key. Keys shorter than 32 characters are never accepted.
 */
lais.use((req, _res, next) => {
  const received = req.header("x-api-key");
  const keys = [config.LAIS_API_KEY, config.LAIS_API_KEY_PREVIOUS].filter((k) => k.length >= 32);
  // Compare against every key (constant time each), so timing doesn't reveal which one matched.
  const matches = keys.map((k) => sameSecret(received, k));
  if (config.LAIS_API_KEY.length < 32 || !matches.some(Boolean)) {
    throw new HttpError(401, "Valid LAIS API credentials are required", "unauthorized");
  }
  if (!matches[0]) logger.warn({ requestId: req.id }, "LAIS authenticated with the previous API key; finish the key change");
  next();
});

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
    case "duplicate":
      audit(req, input.Transaction_ID, "success", { UPIs: input.UPIs, duplicate: true, version: outcome.record.version_name });
      return res.status(200).json({ success: true, case: "Yes", message: "This transaction was already recorded.", data: { ...outcome.record, duplicate: true } });
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
