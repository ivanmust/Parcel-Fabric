import { sql } from "../../../common/utils/sql.js";
import { queryPlots, type LayerSchema, type Logical } from "../repositories/plot-layer.repository.js";
import type { LedgerEntry } from "../models/ledger-entry.model.js";
import type { Attributes, FieldError, LaisRecord, LaisSubmission } from "../models/transaction.model.js";

export function toIso(value: unknown): string | null {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

/** A transaction recorded on Plots (one row per parcel; the fields are the same on each). */
export function toRecord(schema: LayerSchema, rows: Attributes[], stage: LaisRecord["stage"]): LaisRecord {
  const a = rows[0] ?? {};
  const s = (k: Logical) => (a[schema.fields[k]] === undefined || a[schema.fields[k]] === null ? null : String(a[schema.fields[k]]));
  const UPIs = [...new Set(rows.map((r) => String(r[schema.fields.upi] ?? "")).filter(Boolean))].sort();
  return {
    UPI: UPIs[0] ?? null,
    UPIs,
    Transaction_ID: s("transactionId"),
    Transaction_Type: s("transactionType"),
    Transaction_Status: s("transactionStatus"),
    Transaction_Date: toIso(a[schema.fields.transactionDate]),
    case: s("case"),
    validation_message: s("validationMessage"),
    version_name: s("versionName"),
    version_status: s("versionStatus"),
    stage,
    result: null,
    warnings: [],
    updated_at: null,
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Posted rows match the request: same type, date (and status if sent), and every requested UPI among them. */
export function samePayload(schema: LayerSchema, rows: Attributes[], input: LaisSubmission): boolean {
  const f = schema.fields;
  const a = rows[0]!;
  const upis = new Set(rows.map((r) => r[f.upi]));
  return (
    input.UPIs.every((u) => upis.has(u)) &&
    a[f.transactionType] === input.Transaction_Type &&
    Number(a[f.transactionDate]) === Date.parse(input.Transaction_Date) &&
    (input.Transaction_Status === undefined || a[f.transactionStatus] === input.Transaction_Status)
  );
}

/** The transaction's fields posted on Plots in sde.DEFAULT; rows that disagree on type or date are inconsistent. */
export async function findPosted(token: string, schema: LayerSchema, transactionId: string): Promise<{ rows: Attributes[]; inconsistent: boolean }> {
  const f = schema.fields;
  const rows = await queryPlots(token, schema, `${f.transactionId} = ${sql(transactionId)}`, undefined, undefined, 50);
  const inconsistent = rows.some((r) => r[f.transactionType] !== rows[0]![f.transactionType] || r[f.transactionDate] !== rows[0]![f.transactionDate]);
  return { rows, inconsistent };
}

export const VALIDATED = "Validated by the LAIS integration API";

export function entryMatches(e: LedgerEntry, input: LaisSubmission): boolean {
  return (
    sameSet(e.UPIs, input.UPIs) &&
    e.Transaction_Type === input.Transaction_Type &&
    Date.parse(e.Transaction_Date) === Date.parse(input.Transaction_Date) &&
    (e.Transaction_Status ?? undefined) === input.Transaction_Status
  );
}

export function entryRecord(e: LedgerEntry, stage: LaisRecord["stage"]): LaisRecord {
  return {
    UPI: e.UPIs[0] ?? null,
    UPIs: e.UPIs,
    Transaction_ID: e.Transaction_ID,
    Transaction_Type: e.Transaction_Type,
    Transaction_Status: e.Transaction_Status ?? null,
    Transaction_Date: new Date(Date.parse(e.Transaction_Date)).toISOString(),
    case: "Yes",
    validation_message: VALIDATED,
    version_name: e.versionName,
    version_status: e.versionName ? "VersionCreated" : "Pending",
    stage,
    result: null,
    warnings: [],
    updated_at: e.updatedAt,
  };
}

export const duplicateIdError = (message: string): FieldError[] => [{ field: "Transaction_ID", code: "DUPLICATE_TRANSACTION_ID", message }];
