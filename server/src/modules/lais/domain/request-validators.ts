import { STAGES, type FieldError, type ListOptions, type Stage } from "../models/transaction.model.js";
import { isValidTransactionDate } from "./submission-validator.js";
import { CELL_PATTERN } from "./approval.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_PARAMS = ["updatedSince", "stage", "limit"];
const DEFAULT_LIMIT = 100;

type Validated<T> = { value: T; errors: FieldError[] };

/** GET /transactions?updatedSince=&stage=&limit= */
export function parseListQuery(query: Record<string, unknown>): Validated<ListOptions> {
  const errors: FieldError[] = [];
  for (const key of Object.keys(query)) {
    if (!LIST_PARAMS.includes(key)) errors.push({ field: key, code: "UNKNOWN_FIELD", message: `Unknown query parameter ${key}. Allowed: updatedSince, stage, limit.` });
  }
  // undefined = not sent, null = sent more than once
  const single = (key: string) => (typeof query[key] === "string" ? (query[key] as string).trim() : query[key] === undefined ? undefined : null);

  let updatedSince: number | undefined;
  const since = single("updatedSince");
  if (since !== undefined) {
    if (since && isValidTransactionDate(since)) updatedSince = Date.parse(since);
    else errors.push({ field: "updatedSince", code: "INVALID_DATE", message: "Use an ISO 8601 date-time with an explicit timezone, for example 2026-11-26T08:30:00Z." });
  }

  let stage: Stage | undefined;
  const stageText = single("stage");
  if (stageText !== undefined) {
    stage = STAGES.find((s) => s.toLowerCase() === String(stageText ?? "").toLowerCase());
    if (!stage) errors.push({ field: "stage", code: "INVALID_STAGE", message: `Allowed values: ${STAGES.join(", ")}.` });
  }

  let limit = DEFAULT_LIMIT;
  const limitText = single("limit");
  if (limitText !== undefined) {
    limit = /^\d+$/.test(String(limitText ?? "")) ? Number(limitText) : NaN;
    if (!(limit >= 1 && limit <= 200)) errors.push({ field: "limit", code: "INVALID_LIMIT", message: "limit must be a whole number from 1 to 200." });
  }
  return { value: { updatedSince, stage, limit }, errors };
}

/** Body of approve / reject: known text fields only, each within its maximum length. */
export function parseDecisionBody(body: unknown, required: Record<string, number>, optional: Record<string, number> = {}): Validated<Record<string, string>> {
  const values: Record<string, string> = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { value: values, errors: [{ field: "body", code: "INVALID_BODY", message: "Send a JSON object." }] };
  }
  const input = body as Record<string, unknown>;
  const allowed = { ...required, ...optional };
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!(key in allowed)) errors.push({ field: key, code: "UNKNOWN_FIELD", message: `Unknown field ${key}. Allowed: ${Object.keys(allowed).join(", ")}.` });
  }
  for (const [key, max] of Object.entries(allowed)) {
    const value = input[key];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      if (key in required) errors.push({ field: key, code: "REQUIRED", message: `${key} is required.` });
    } else if (typeof value !== "string") {
      errors.push({ field: key, code: "INVALID_TYPE", message: `${key} must be text.` });
    } else if (value.trim().length > max) {
      errors.push({ field: key, code: "TOO_LONG", message: `${key} must be at most ${max} characters.` });
    } else {
      values[key] = value.trim();
    }
  }
  if (values.event_id && !UUID.test(values.event_id)) errors.push({ field: "event_id", code: "INVALID_EVENT_ID", message: "event_id is the UUID of the editing-done notification." });
  if (values.cell && !CELL_PATTERN.test(values.cell)) errors.push({ field: "cell", code: "INVALID_CELL", message: "cell is a UPI prefix province/district/sector/cell, for example 1/02/13/02." });
  return { value: values, errors };
}
