import { TRANSACTION_STATUSES, TRANSACTION_TYPES, type FieldError, type LaisSubmission, type TransactionType } from "../models/transaction.model.js";

export const UPI_PATTERN = /^\d\/\d{2}\/\d{2}\/\d{2}\/\d+$/;
export const MAX_UPIS = 20;

const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/;
const ALLOWED_FIELDS = new Set(["UPI", "UPIs", "Transaction_ID", "Transaction_Type", "Transaction_Date", "Transaction_Status"]);
// Transaction_ID has no maximum length (agreed with LAIS); the 256 KB body limit still applies.
const MAX_LENGTH = { UPI: 100, Transaction_ID: Number.POSITIVE_INFINITY, Transaction_Type: 25, Transaction_Date: 64, Transaction_Status: 25 } as const;
type TextField = keyof typeof MAX_LENGTH;

const PARCEL_COUNT: Record<TransactionType, [min: number, max: number]> = {
  Merge: [2, MAX_UPIS],
  Subdivision: [1, 1],
  CorrectBoundaries: [1, MAX_UPIS],
  CreatePlot: [0, MAX_UPIS],
};

export type ValidationResult = { ok: true; value: LaisSubmission; listForm: boolean } | { ok: false; errors: FieldError[] };

export function isValidTransactionDate(value: string): boolean {
  const match = ISO_WITH_ZONE.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, y, mo, d, h, mi, sec = "0", , zone, zh = "0", zm = "0"] = match;
  const [year, month, day] = [Number(y), Number(mo), Number(d)];
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (calendarDay.getUTCFullYear() !== year || calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return false;
  if (zone !== "Z" && (Number(zh) > 14 || Number(zm) > 59 || (Number(zh) === 14 && Number(zm) !== 0))) return false;
  return true;
}

const matchCode = <T extends string>(value: string, codes: readonly T[]) => codes.find((c) => c.toLowerCase() === value.toLowerCase());

const badUpiFormat = (field: string): FieldError => ({
  field,
  code: "INVALID_UPI_FORMAT",
  message: "UPI must follow province/district/sector/cell/number, for example 1/02/13/02/1001.",
});

class SubmissionReader {
  readonly errors: FieldError[] = [];

  constructor(private readonly input: Record<string, unknown>) {}

  rejectUnknownFields(): void {
    for (const key of Object.keys(this.input)) {
      if (ALLOWED_FIELDS.has(key)) continue;
      this.errors.push({ field: key, code: "UNKNOWN_FIELD", message: key === "case" ? "case is decided by the GIS API and must not be sent." : `Unknown field ${key}.` });
    }
  }

  text(field: TextField, required: boolean): string | undefined {
    const raw = this.input[field];
    if (raw === undefined || raw === null) {
      if (required) this.errors.push({ field, code: "REQUIRED_FIELD", message: `${field} is required.` });
      return undefined;
    }
    if (typeof raw !== "string") {
      this.errors.push({ field, code: "INVALID_TYPE", message: `${field} must be a string.` });
      return undefined;
    }
    const value = raw.trim();
    if (!value) {
      if (required) this.errors.push({ field, code: "REQUIRED_FIELD", message: `${field} must not be empty.` });
      return undefined;
    }
    if (value.length > MAX_LENGTH[field]) {
      this.errors.push({ field, code: "TOO_LONG", message: `${field} must be at most ${MAX_LENGTH[field]} characters.` });
      return undefined;
    }
    return value;
  }

  get sendsList(): boolean {
    return this.input.UPIs !== undefined && this.input.UPIs !== null;
  }

  /** The parcels from `UPI` (one) or `UPIs` (a list). undefined when they are invalid. */
  parcels(): string[] | undefined {
    const sendsOne = this.input.UPI !== undefined && this.input.UPI !== null;
    if (sendsOne && this.sendsList) {
      this.errors.push({ field: "UPIs", code: "CONFLICTING_FIELDS", message: "Send either UPI (one parcel) or UPIs (a list of parcels), not both." });
      return undefined;
    }
    if (this.sendsList) return this.upiList(this.input.UPIs);
    if (sendsOne) return this.singleUpi();
    return [];
  }

  private singleUpi(): string[] | undefined {
    const upi = this.text("UPI", true);
    if (!upi) return undefined;
    if (UPI_PATTERN.test(upi)) return [upi];
    this.errors.push(badUpiFormat("UPI"));
    return undefined;
  }

  private upiList(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) {
      this.errors.push({ field: "UPIs", code: "INVALID_TYPE", message: "UPIs must be a list of UPI strings." });
      return undefined;
    }
    if (raw.length > MAX_UPIS) {
      this.errors.push({ field: "UPIs", code: "TOO_LONG", message: `UPIs may list at most ${MAX_UPIS} parcels.` });
      return undefined;
    }
    const list: string[] = [];
    raw.forEach((item, i) => {
      const upi = this.listItem(item, `UPIs[${i}]`, list);
      if (upi) list.push(upi);
    });
    return list.length === raw.length ? list : undefined;
  }

  private listItem(item: unknown, field: string, seen: string[]): string | undefined {
    if (typeof item !== "string") return this.fail({ field, code: "INVALID_TYPE", message: `${field} must be a string.` });
    const upi = item.trim();
    if (!upi) return this.fail({ field, code: "REQUIRED_FIELD", message: `${field} must not be empty.` });
    if (upi.length > MAX_LENGTH.UPI) return this.fail({ field, code: "TOO_LONG", message: `${field} must be at most ${MAX_LENGTH.UPI} characters.` });
    if (!UPI_PATTERN.test(upi)) return this.fail(badUpiFormat(field));
    if (seen.includes(upi)) return this.fail({ field, code: "DUPLICATE_UPI", message: `${upi} is listed more than once.` });
    return upi;
  }

  private fail(error: FieldError): undefined {
    this.errors.push(error);
    return undefined;
  }

  checkParcelCount(type: TransactionType, upis: string[]): void {
    const [min, max] = PARCEL_COUNT[type];
    if (upis.length >= min && upis.length <= max) return;
    const field = this.sendsList ? "UPIs" : "UPI";
    if (type === "Merge") {
      this.errors.push({ field: "UPIs", code: "MERGE_NEEDS_TWO_UPIS", message: 'A Merge lists the UPIs of all parcels being merged, at least two: "UPIs": ["…", "…"].' });
    } else if (type === "Subdivision") {
      this.errors.push({ field, code: "SUBDIVISION_NEEDS_ONE_UPI", message: "A Subdivision names exactly one parcel: the parcel being subdivided." });
    } else {
      this.errors.push({ field, code: "REQUIRED_FIELD", message: `A ${type} names at least one parcel in UPI or UPIs.` });
    }
  }
}

/** Validate a LAIS submission field by field. Errors on list items name `UPIs[i]`, else `UPI`. */
export function validateSubmission(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", code: "INVALID_BODY", message: "Send a JSON object with Content-Type: application/json." }] };
  }
  const reader = new SubmissionReader(body as Record<string, unknown>);
  const { errors } = reader;
  reader.rejectUnknownFields();

  const UPIs = reader.parcels();
  const Transaction_ID = reader.text("Transaction_ID", true);
  const typeText = reader.text("Transaction_Type", true);
  const Transaction_Date = reader.text("Transaction_Date", true);
  const statusText = reader.text("Transaction_Status", false);

  if (Transaction_ID && !TRANSACTION_ID_PATTERN.test(Transaction_ID)) {
    errors.push({ field: "Transaction_ID", code: "INVALID_FORMAT", message: "Transaction_ID may contain letters, digits and . _ - : / and must start with a letter or digit." });
  }
  const Transaction_Type = typeText ? matchCode(typeText, TRANSACTION_TYPES) : undefined;
  if (typeText && !Transaction_Type) {
    errors.push({ field: "Transaction_Type", code: "INVALID_TRANSACTION_TYPE", message: `Allowed values: ${TRANSACTION_TYPES.join(", ")}.` });
  }
  const Transaction_Status = statusText ? matchCode(statusText, TRANSACTION_STATUSES) : undefined;
  if (statusText && !Transaction_Status) {
    errors.push({ field: "Transaction_Status", code: "INVALID_TRANSACTION_STATUS", message: `Allowed values: ${TRANSACTION_STATUSES.join(", ")}.` });
  }
  if (Transaction_Date && !isValidTransactionDate(Transaction_Date)) {
    errors.push({ field: "Transaction_Date", code: "INVALID_DATE", message: "Use an ISO 8601 date-time with an explicit timezone, for example 2026-11-24T08:30:00+02:00." });
  }
  if (Transaction_Type && UPIs) reader.checkParcelCount(Transaction_Type, UPIs);

  if (errors.length || !UPIs || !Transaction_ID || !Transaction_Type || !Transaction_Date) return { ok: false, errors };
  return {
    ok: true,
    listForm: reader.sendsList,
    value: { UPIs, Transaction_ID, Transaction_Type, Transaction_Date, ...(Transaction_Status ? { Transaction_Status } : {}) },
  };
}
